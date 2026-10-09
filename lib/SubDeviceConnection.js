'use strict';

const { EventEmitter } = require('events');

// Wie oft nach dem Gateway gesucht wird, solange es in Homey nicht zu finden ist. Beim
// App-Start ist das fuer ein paar Sekunden der Normalfall: Homey richtet die Geraete
// Treiber fuer Treiber ein, und ein Thermostat kann vor seinem Gateway an der Reihe sein.
const SUCHE_MS = 10000;

/** Kennungen stehen im Protokoll gekuerzt, wie im Support-Bericht. */
const kurz = (id) => (String(id).length > 6 ? `${String(id).slice(0, 6)}…` : String(id));

/**
 * Die Verbindung eines Untergeraets hinter einem Gateway - eines Zigbee- oder
 * Bluetooth-Thermostats hinter einer Tuya-Bridge etwa.
 *
 * Ein solches Geraet hat keine Adresse, an die man sich verbinden koennte. Das Gateway
 * spricht fuer es: es reicht dessen Werte ueber seine eigene Verbindung weiter, von den
 * eigenen nur durch ein Feld cid im Paket unterschieden, und es nimmt Befehle mit
 * derselben cid entgegen. Und es nimmt genau eine lokale Verbindung an - die hat das
 * Gateway-Geraet in Homey schon. Eine zweite fuer das Thermostat wuerde mit ihr um den
 * einen Platz kaempfen.
 *
 * Also haengt sich diese Verbindung an das Gateway-Geraet. Pakete mit ihrer cid bekommt
 * sie von dort weitergereicht, Befehle schickt sie ueber dessen Verbindung mit ihrer
 * cid, und verbunden ist sie, solange das Gateway es ist. Nach aussen verhaelt sie sich
 * wie TuyaConnection, damit der Geraete-Code unveraendert darueber laeuft.
 *
 * Gefragt wird ueber das Netz nie. Eine Statusabfrage fuer ein Untergeraet ginge ueber
 * die Verbindung des Gateways und belegte dort die eine offene Abfrage, und ein
 * Gateway, das nicht einmal fuer sich selbst antwortet - das gemeldete tut es nicht -,
 * hielte sie bis zur Zeitgrenze fest. get() antwortet darum mit dem, was das Gateway
 * zuletzt von diesem Untergeraet weitergereicht hat. Das Gateway fuehrt es ohnehin, und
 * es uebersteht einen Neustart.
 *
 * Events wie TuyaConnection: 'connected', 'disconnected' (reason), 'connect-failed'
 * (reason), 'data' (dps, raw), 'log' ({message, level}).
 */
class SubDeviceConnection extends EventEmitter {
  /**
   * @param {Object} o
   * @param {Object} o.homey      Um das Gateway unter allen Geraeten zu finden.
   * @param {string} o.cid        Die Kennung des Untergeraets im Gateway.
   * @param {string} o.gatewayId  Die Device ID des Gateways.
   */
  constructor({ homey, cid, gatewayId }) {
    super();
    this._homey         = homey;
    this._cid           = String(cid);
    this._gatewayId     = String(gatewayId);
    this._gateway       = null;   // das Gateway-Geraet, solange hier angemeldet
    this._verbunden     = false;  // 'connected' gemeldet und seither kein 'disconnected'
    this._verbundenSeit = 0;
    this._abfrage       = false;  // waehrend get() Gemerktes ausliefert
    this._stopped       = false;
    this._suchTimer     = null;
    this._gesagt        = null;   // zuletzt ins Protokoll geschriebener Grund
    this._stats         = { connects: 0, upMs: 0, longestMs: 0, packets: 0 };
  }

  /** Verbunden ist, was das Gateway ist - eine eigene Leitung gibt es nicht. */
  get connected() { return this._gateway?._conn?.connected === true; }

  /** Wahr, solange get() Gemerktes ausliefert: das ist eine Antwort, kein Push. */
  get isPollInFlight() { return this._abfrage; }

  /** Fuer den Support-Bericht: ueber welches Geraet dieses hier laeuft. */
  get gatewayName() {
    try { return this._gateway ? this._gateway.getName() : null; } catch (e) { return null; }
  }

  /** Wie TuyaConnection.stats; gezaehlt wird, was das Gateway weitergereicht hat. */
  get stats() {
    const laufend = this._verbunden && this._verbundenSeit ? Date.now() - this._verbundenSeit : 0;
    const upMs    = this._stats.upMs + laufend;
    const packets = this._stats.packets;
    return {
      connects:  this._stats.connects,
      upMs,
      longestMs: Math.max(this._stats.longestMs, laufend),
      avgMs:     this._stats.connects ? Math.round(upMs / this._stats.connects) : 0,
      packets,
      perSecond: upMs > 1000 ? packets / (upMs / 1000) : 0,
      everData:  packets > 0,
    };
  }

  async connect() {
    if (this._stopped) return;
    clearTimeout(this._suchTimer);
    this._suchTimer = null;

    const gateway = this._findeGateway();
    if (!gateway) {
      this._nichtDa(`Gateway ${kurz(this._gatewayId)} is not set up in Homey. This device is `
        + 'reached through it: add the gateway first (any driver will do, Generic for '
        + 'instance), and this device attaches to it by itself.');
      this._suchTimer = setTimeout(() => this.connect(), SUCHE_MS);
      return;
    }

    if (this._gateway !== gateway) {
      this._gateway?._untergeraetAbmelden?.(this._cid, this);
      this._gateway = gateway;
      gateway._untergeraetAnmelden(this._cid, this);
      this._log(`Attached to gateway "${this.gatewayName}": reports with cid ${this._cid} `
        + 'arrive through its connection, and commands go out over it.', 'info');
    }

    if (this.connected) this._gatewayVerbunden();
    else this._nichtDa(`Gateway "${this.gatewayName}" is not connected`);
  }

  /**
   * Das Gateway-Geraet unter allen Geraeten der App: das mit dieser Device ID, das
   * nicht selbst ein Untergeraet ist. Ist es versehentlich zweimal angelegt, traegt nur
   * eines die Verbindung - das wird genommen.
   */
  _findeGateway() {
    let treiber = {};
    try { treiber = this._homey?.drivers?.getDrivers() || {}; } catch (e) { return null; }
    const kandidaten = [];
    for (const driver of Object.values(treiber)) {
      let geraete = [];
      try { geraete = driver.getDevices() || []; } catch (e) { continue; }
      for (const g of geraete) {
        if (typeof g?._untergeraetAnmelden !== 'function') continue;
        let id = '';
        let cid = '';
        try { id = String(g.getSetting('device_id') ?? ''); } catch (e) {}
        try { cid = String(g.getSetting('sub_device_cid') ?? ''); } catch (e) {}
        if (id === this._gatewayId && cid === '') kandidaten.push(g);
      }
    }
    return kandidaten.find((g) => g._conn?.connected === true) || kandidaten[0] || null;
  }

  // ── Vom Gateway ───────────────────────────────────────────────────────────

  /** Seine Verbindung steht. */
  _gatewayVerbunden() {
    if (this._stopped || this._verbunden) return;
    this._verbunden     = true;
    this._verbundenSeit = Date.now();
    this._gesagt        = null;
    this._stats.connects++;
    this.emit('connected');
  }

  /** Seine Verbindung ist abgerissen. */
  _gatewayGetrennt(grund) {
    if (this._stopped || !this._verbunden) return;
    this._abgemeldet();
    this.emit('disconnected', `Gateway "${this.gatewayName}": ${grund || 'disconnected'}`);
  }

  /**
   * Ein Verbindungsversuch des Gateways kam nicht zustande. Ins Protokoll dieses
   * Geraets nur einmal: der Grund wechselt von Versuch zu Versuch, und das Gateway
   * schreibt ihn ohnehin in sein eigenes.
   */
  _gatewayGescheitert(grund) {
    if (this._stopped) return;
    const text = `Gateway "${this.gatewayName}" unreachable: ${grund || 'connection failed'}`;
    if (this._verbunden) {
      this._abgemeldet();
      this.emit('disconnected', text);
      return;
    }
    this._nichtDa(text, `Gateway "${this.gatewayName}" is not connected`);
  }

  /** Das Gateway wurde aus Homey entfernt. Gesucht wird weiter - es kann wiederkommen. */
  _gatewayEntfernt() {
    if (this._stopped) return;
    const text = `Gateway "${this.gatewayName}" was removed from Homey`;
    const war  = this._verbunden;
    if (war) this._abgemeldet();
    this._gateway = null;
    if (war) this.emit('disconnected', text);
    else this._nichtDa(text);
    clearTimeout(this._suchTimer);
    this._suchTimer = setTimeout(() => this.connect(), SUCHE_MS);
  }

  /** Ein Paket mit dieser cid. */
  _eingang(dps, raw) {
    if (this._stopped) return;
    this._stats.packets++;
    this.emit('data', { ...(dps || {}) }, raw);
  }

  // ── Wie TuyaConnection ────────────────────────────────────────────────────

  /**
   * Liefert, was das Gateway zuletzt von diesem Untergeraet weitergereicht hat - siehe
   * oben, warum nicht ueber das Netz gefragt wird.
   */
  async get() {
    if (!this.connected) return;
    const gemerkt = this._gateway?._cidSeen?.[this._cid]?.dps;
    if (!gemerkt || typeof gemerkt !== 'object' || Object.keys(gemerkt).length === 0) return;
    this._abfrage = true;
    try {
      this.emit('data', { ...gemerkt }, { dps: { ...gemerkt }, cid: this._cid });
    } finally {
      this._abfrage = false;
    }
  }

  async refresh() { return this.get(); }

  async set(dp, value, opts = {}) {
    if (!this.connected) throw new Error('Device not connected');
    return this._gateway._sendeFuerUntergeraet(this._cid, dp, value, opts);
  }

  async setMultiple(dpsObj) {
    if (!this.connected) throw new Error('Device not connected');
    return this._gateway._sendeMehrereFuerUntergeraet(this._cid, dpsObj);
  }

  // Was die Geraete-Schicht bei jedem Verbindungsaufbau einstellt, betrifft die Leitung,
  // und die gehoert dem Gateway - mit seinen eigenen Einstellungen.
  setProtocolLocked() {}
  setTrace() {}
  setControlUid() {}
  setCommandGap() {}
  setDataTimeout() {}

  disconnect() {
    clearTimeout(this._suchTimer);
    this._suchTimer = null;
    if (this._verbunden) this._abgemeldet();
    this._gateway?._untergeraetAbmelden?.(this._cid, this);
    this._gateway = null;
  }

  destroy() {
    this._stopped = true;
    this.disconnect();
  }

  // ── Intern ────────────────────────────────────────────────────────────────

  _abgemeldet() {
    const dauer = this._verbundenSeit ? Date.now() - this._verbundenSeit : 0;
    this._stats.upMs     += dauer;
    this._stats.longestMs = Math.max(this._stats.longestMs, dauer);
    this._verbunden       = false;
    this._verbundenSeit   = 0;
  }

  /**
   * Nicht verbunden, und warum. Ins Protokoll nur, wenn sich der Text aendert.
   *
   * @param {string} grund   Was das Geraet als Grund zeigt, wenn es unerreichbar wird.
   * @param {string} [text]  Was ins Protokoll kommt, falls kuerzer als der Grund.
   */
  _nichtDa(grund, text = grund) {
    if (this._gesagt !== text) {
      this._gesagt = text;
      this._log(text, 'warn');
    }
    this.emit('connect-failed', grund);
  }

  _log(message, level = 'info') {
    this.emit('log', { message, level });
  }
}

module.exports = SubDeviceConnection;
