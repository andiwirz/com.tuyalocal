'use strict';

const BaseTuyaDevice = require('../../lib/BaseTuyaDevice');
const { lesePulse, beschreibePulse } = require('../../lib/irPulses');

// ── Tuya IR blaster (category wnykq) DP map ─────────────────────────────────
//
//   DP 201  string  ir_send        — commands go here, as a JSON string
//   DP 202  raw     ir_study_code  — a code the blaster just learned
//   DP 101  int     temp_current   — these boxes usually carry a sensor
//   DP 102  int     humidity_value
//
// Everything this driver does goes through DP 201, and it is one of three
// commands:
//
//   {"control":"study"}                       enter learning mode
//   {"control":"study_exit"}                  leave it again
//   {"control":"send_ir","type":0,"head":"",
//    "key1":"1<base64>"}                      blast a learned code
//
// The learned code itself needs no decoding. It is a base64 container of
// little-endian 16-bit microsecond durations, pulse first — but the blaster
// replays exactly what it recorded, so the app only has to hand the same string
// back. That is why this driver has no codec: it would be a second place to get
// the timings wrong, and it would buy nothing.
//
// The leading "1" on key1 is not part of the code. It is a one-character format
// marker the firmware expects in front of a learned code; codes from Tuya's own
// library use "0" and carry a hex "head" instead. Learned codes are stored here
// without it, and it is put back on the way out.

const SENSOR_PROFILE = [
  { settingKey: 'dp_temperature', capability: 'measure_temperature', teiler: 'temp_scale'     },
  { settingKey: 'dp_humidity',    capability: 'measure_humidity',    teiler: 'humidity_scale' },
];

const OPTIONAL_CAPABILITIES = SENSOR_PROFILE.map(({ settingKey, capability }) => ({
  setting: settingKey, capability,
}));

// Eine Grenze, damit ein Geraet, das sich verschluckt, nicht den Geraetespeicher
// vollschreibt. Wer hundert Tasten angelernt hat, hat eine Fernbedienung
// nachgebaut; wer mehr braucht, legt ein zweites Geraet an.
const MAX_CODES = 100;

// Wie oft und wie dicht eine Taste hoechstens wiederholt werden darf. Die Grenzen
// stehen nicht da, weil mehr schaedlich waere, sondern weil eine Flow-Karte
// zurueckkehren muss: zehn Sendungen mit je einer Sekunde Abstand sind zehn
// Sekunden, in denen der Flow steht, und das ist das Aeusserste, was vertretbar ist.
const MAX_WIEDERHOLUNGEN = 10;
const MAX_ABSTAND_MS     = 1000;

class IrBlasterDevice extends BaseTuyaDevice {
  async onInit() {
    this.log('IR blaster initialized:', this.getName());

    this._lernName  = null;
    this._lernTimer = null;

    await this._baseInit();
    await this._syncOptionalCapabilities(OPTIONAL_CAPABILITIES);

    this._triggerDeviceConnected    = this.homey.flow.getDeviceTriggerCard('ir_device_connected');
    this._triggerDeviceDisconnected = this.homey.flow.getDeviceTriggerCard('ir_device_disconnected');
    this._triggerDpChanged          = this.homey.flow.getDeviceTriggerCard('ir_dp_changed');
    this._triggerCodeLearned        = this.homey.flow.getDeviceTriggerCard('ir_code_learned');

    await this._connect();
  }

  // ── The stored codes ──────────────────────────────────────────────────────

  /** @returns {Object<string,string>} name -> base64 code */
  _codes() {
    const gespeichert = this.getStoreValue('irCodes');
    return (gespeichert && typeof gespeichert === 'object') ? gespeichert : {};
  }

  /** The names a flow card can offer, newest last so the list stays stable. */
  codeNames() {
    return Object.keys(this._codes()).sort((a, b) => a.localeCompare(b));
  }

  /**
   * Die Liste fuer die Auswahlfelder in den Flow-Karten.
   *
   * @param {string} query
   * @returns {Array<{name: string}>}
   */
  codeAutocomplete(query) {
    const suche = String(query || '').trim().toLowerCase();
    return this.codeNames()
      .filter((name) => !suche || name.toLowerCase().includes(suche))
      .map((name) => ({ name }));
  }

  async _speichereCode(name, code) {
    const codes = this._codes();
    if (!(name in codes) && Object.keys(codes).length >= MAX_CODES) {
      throw new Error(`This blaster already holds ${MAX_CODES} codes. `
        + 'Delete one with "Forget an IR code" before learning another.');
    }
    codes[name] = code;
    await this.setStoreValue('irCodes', codes);
  }

  /** Loescht einen gespeicherten Code. Gibt zurueck, ob es ihn gab. */
  async forgetCode(name) {
    const codes = this._codes();
    if (!(name in codes)) return false;
    delete codes[name];
    await this.setStoreValue('irCodes', codes);
    this._appLog(`Forgot IR code "${name}"`, 'info');
    return true;
  }

  // ── Sending ───────────────────────────────────────────────────────────────

  /** Die Nummer des Befehlsdatenpunkts, oder ein Fehler mit dem Grund. */
  _sendeDp() {
    const dp = this.getSetting('dp_ir_send');
    if (!dp || dp <= 0) {
      throw new Error('This blaster has no command data point configured. '
        + 'Set DP IR Send in its advanced settings — it is 201 on most of them.');
    }
    return dp;
  }

  /**
   * Das Paket, mit dem ein angelernter Code losgeschickt wird.
   *
   * @param {string} code  Der Code, wie er angelernt wurde - ohne Formatzeichen.
   * @returns {string}
   */
  static sendePaket(code) {
    return JSON.stringify({ control: 'send_ir', type: 0, head: '', key1: `1${code}` });
  }

  /**
   * Sends a code that was learned earlier and saved under a name.
   *
   * @param {string} name
   * @param {{wiederholungen?: number, abstandMs?: number}} [opts]
   */
  async sendSavedCode(name, opts = {}) {
    const code = this._codes()[name];
    if (!code) {
      throw new Error(`No IR code saved as "${name}" on this blaster. `
        + `Saved codes: ${this.codeNames().join(', ') || 'none yet'}.`);
    }
    await this.sendRawCode(code, opts);
  }

  /**
   * Sends a code verbatim — for a code pasted in from somewhere else.
   *
   * @param {string} code
   * @param {{wiederholungen?: number, abstandMs?: number}} [opts]
   */
  async sendRawCode(code, opts = {}) {
    const sauber = String(code || '').trim();
    if (!sauber) throw new Error('No IR code given.');

    // Geprueft, bevor es hinausgeht. Ein Code, der sich nicht als Aufnahme lesen
    // laesst, kann auch der Blaster nicht senden - er verwirft ihn wortlos, und der
    // Flow meldet Erfolg. Lieber hier ein Fehler mit dem Grund.
    const { fehler } = lesePulse(sauber);
    if (fehler) throw new Error(`That is not a usable IR code: ${fehler}.`);

    const dp   = this._sendeDp();
    const paket = IrBlasterDevice.sendePaket(sauber);
    const wdh  = Math.max(1, Math.min(MAX_WIEDERHOLUNGEN,
      Math.round(Number(opts.wiederholungen) || 1)));
    const gap  = Math.max(0, Math.min(MAX_ABSTAND_MS,
      Math.round(Number(opts.abstandMs) || 0)));

    for (let i = 0; i < wdh; i++) {
      await this._set(dp, paket);
      if (i < wdh - 1 && gap > 0) await new Promise((r) => setTimeout(r, gap));
    }
  }

  // ── Learning ──────────────────────────────────────────────────────────────

  /**
   * Bringt den Blaster in den Lernmodus und legt fest, wie der naechste Code heisst.
   *
   * Die Karte wartet nicht auf den Code. Eine Flow-Karte, die stehen bleibt, bis
   * jemand eine Fernbedienung gefunden und darauf gedrueckt hat, laeuft in Homeys
   * Zeitgrenze - der Code kommt darum als Ausloeser zurueck, nicht als Rueckgabe.
   *
   * @param {string} [name]
   */
  async startLearning(name) {
    const dp = this._sendeDp();
    // Zuerst hinaus, dann hinein. Ein Blaster, den ein abgebrochener Versuch im
    // Lernmodus zurueckgelassen hat, nimmt ein zweites "study" nicht an - er ist ja
    // schon drin -, und dann wartet der Benutzer auf einen Code, der nie kommt.
    await this._set(dp, JSON.stringify({ control: 'study_exit' }));
    await new Promise((r) => setTimeout(r, 300));
    await this._set(dp, JSON.stringify({ control: 'study' }));

    this._lernName = String(name || '').trim() || null;
    clearTimeout(this._lernTimer);
    const frist = Math.max(5, Number(this.getSetting('learn_timeout') ?? 30));
    this._lernTimer = setTimeout(() => {
      this._lernTimer = null;
      this._lernName  = null;
      this._appLog(`No IR code arrived within ${frist} seconds — learning mode switched off `
        + 'again. Point the remote at the blaster from close up and try once more.', 'warn');
      this.stopLearning().catch(() => {});
    }, frist * 1000);

    this._appLog(this._lernName
      ? `Learning mode on — the next code will be saved as "${this._lernName}"`
      : 'Learning mode on', 'info');
  }

  /** Leaves learning mode, whether or not a code arrived. */
  async stopLearning() {
    clearTimeout(this._lernTimer);
    this._lernTimer = null;
    this._lernName  = null;
    await this._set(this._sendeDp(), JSON.stringify({ control: 'study_exit' }));
  }

  /**
   * Ein Code ist angekommen.
   *
   * @param {string} code
   */
  async _codeAngekommen(code) {
    const { pulse, fehler, warnung } = lesePulse(code);

    // Eine kaputte Aufnahme wird nicht gespeichert — und der Lernmodus bleibt an.
    // Wer zu schwach gedrueckt hat, drueckt einfach nochmal, statt den Flow erneut
    // auszuloesen; die Frist laeuft ja weiter und holt den Blaster notfalls heraus.
    if (fehler) {
      this._appLog(`The IR code that arrived is unusable — ${fehler}. Still listening: `
        + 'press the button again, holding the remote closer and pressing firmly. If it '
        + "keeps arriving damaged, the remote's batteries are the usual cause.", 'warn');
      return;
    }

    const lief = this._lernTimer !== null;
    const name = this._lernName
      || `code_${Object.keys(this._codes()).length + 1}`;

    clearTimeout(this._lernTimer);
    this._lernTimer = null;
    this._lernName  = null;

    let gespeichert = true;
    try {
      await this._speichereCode(name, code);
    } catch (err) {
      gespeichert = false;
      this._appLog(`IR code received but not saved: ${err.message}`, 'warn');
    }

    // Immer ausgeschrieben. Wer den Code anderswo braucht - in einem zweiten Flow,
    // in einer anderen App -, findet ihn so im Protokoll, ohne dass ein Auslöser
    // laufen musste. Dazu die Gestalt der Aufnahme: sie sagt ohne Decoder, was fuer
    // eine Fernbedienung das war, und steht damit in jedem Fehlerbericht.
    this._appLog(`IR code received${gespeichert ? ` and saved as "${name}"` : ''} — `
      + `${beschreibePulse(pulse)}${warnung ? `. Careful: ${warnung}` : ''}: ${code}`,
    'info', true);

    this._triggerCodeLearned.trigger(this, { name, code }).catch(() => {});

    // Nur wenn wir selbst den Lernmodus eingeschaltet haben, schalten wir ihn auch
    // wieder aus. Hat jemand am Geraet gelernt, gehoert der Modus ihm.
    if (lief) await this.stopLearning().catch(() => {});
  }

  // ── DPS handling ───────────────────────────────────────────────────────────

  async _handleDps(dps) {
    const settings = this.getSettings();
    let changed = false;

    for (const [dpStr, rawValue] of Object.entries(dps)) {
      const dp = parseInt(dpStr, 10);

      // Der Lerndatenpunkt vor der Gleichheitspruefung: wer dieselbe Taste zweimal
      // anlernt, schickt zweimal denselben Code, und die Pruefung auf "hat sich
      // geaendert" wuerde den zweiten verschlucken - also genau den Fall, in dem
      // jemand gerade wartet.
      if (settings.dp_ir_study > 0 && dp === settings.dp_ir_study) {
        const code = String(rawValue || '').trim();
        if (code) {
          this._lastDps[dpStr] = rawValue;
          changed = true;
          await this._codeAngekommen(code);
        }
        continue;
      }

      if (this._lastDps[dpStr] === rawValue) continue;
      this._lastDps[dpStr] = rawValue;
      changed = true;

      this._triggerDpChanged
        .trigger(this, { dp: dpStr, value: String(rawValue) })
        .catch(() => {});

      // Der Befehlsdatenpunkt spiegelt zurueck, was zuletzt hingeschickt wurde. Das
      // ist kein Zustand, sondern ein Echo.
      if (settings.dp_ir_send > 0 && dp === settings.dp_ir_send) {
        this.log(`Command echo on DP ${dp}:`, rawValue);
        continue;
      }

      const entry = SENSOR_PROFILE.find((e) => settings[e.settingKey] > 0
        && dp === settings[e.settingKey]);
      if (!entry) {
        this.log(`Unmapped DP ${dp}:`, rawValue);
        continue;
      }
      if (!this.hasCapability(entry.capability)) continue;
      const roh = Number(rawValue);
      if (!Number.isFinite(roh)) continue;
      await this.setCapabilityValue(entry.capability, roh / this._teiler(entry.teiler, roh))
        .catch(() => {});
    }

    if (changed) {
      this._scheduleStoreSave();
      this._writeDpSnapshot();
    }
  }

  /**
   * Der Teiler fuer Temperatur und Feuchte.
   *
   * Dieselbe Frage wie beim Luftguetemonitor, und dieselbe Antwort: das gemeldete
   * Geraet schickt 238 fuer 23,8 Grad und 63 fuer 63 %, also im selben Paket einmal
   * Zehntel und einmal nicht. Ein fester Teiler fuer beide waere bei einem der
   * beiden falsch.
   *
   * @param {string} key
   * @param {number} roh
   * @returns {number}
   */
  _teiler(key, roh) {
    const gesetzt = String(this.getSetting(key) ?? 'auto');
    if (gesetzt !== 'auto') {
      const n = Number(gesetzt);
      return Number.isFinite(n) && n !== 0 ? n : 1;
    }
    if (key === 'temp_scale')     return (roh > 80 || roh < -40) ? 10 : 1;
    if (key === 'humidity_scale') return roh > 100 ? 10 : 1;
    return 1;
  }

  // ── Settings ──────────────────────────────────────────────────────────────

  async onSettings({ changedKeys }) {
    const connectionKeys = ['ip', 'device_id', 'local_key', 'version'];
    if (changedKeys.some((k) => connectionKeys.includes(k))) {
      await this._connect();
      return;
    }
    if (changedKeys.includes('polling_interval'))   this._startPolling();
    if (changedKeys.includes('reconnect_interval')) this._startAutoReconnect();
    if (changedKeys.some((k) => OPTIONAL_CAPABILITIES.map((o) => o.setting).includes(k))) {
      await this._syncOptionalCapabilities(OPTIONAL_CAPABILITIES);
    }
  }

  async _onDeleted() {
    clearTimeout(this._lernTimer);
    this._lernTimer = null;
  }
}

module.exports = IrBlasterDevice;
