'use strict';

const BaseTuyaDevice = require('../../lib/BaseTuyaDevice');

const DEBOUNCE_MS = 300;

// ── Tuya EV charger (category "qccdz") DP map ────────────────────────────────
// Verified against all 37 EV-charger configs in make-all/tuya-local, covering
// Vevor, Nine, Tera, Emini, Aimiler, Ecopoint, Dowell, Feyree, AfyeEV, Junsun,
// Zencar, iPengen, Suntree, Immax, Voldt, Wadapower and others.
//
//   DP 1   value  forward_energy_total ×0.01 kWh — lifetime total. Real on many
//                 chargers, but silent over LAN on some (notably several Vevor
//                 portables). Configurable: when dp_energy_total = 0 the total
//                 is accumulated from DP 25 session deltas instead.
//   DP 3   enum   work_state
//   DP 4   value  charge_cur_set (A) — writable. Hardware ranges seen in the
//                 wild span 0–48 A, hence the configurable current_min/max.
//   DP 5   value  single-phase power (W) — 7 configs
//   DP 6   raw    phase A: 2B voltage ×0.1 V, 3B current ×0.001 A, then power.
//                 Buffer is 8 bytes (3B power) on most units but 7 bytes
//                 (2B power) on Nine / Amperepoint / Noeifevo — handled below.
//   DP 7   raw    phase B — 3-phase chargers
//   DP 8   raw    phase C — 3-phase chargers
//   DP 9   value  total power (W) — preferred over phase A when present
//   DP 10  bitmap fault (16 bits)
//   DP 13  enum   connection_state (CP pilot)
//   DP 14  enum   work_mode — enum range overpromises on most units; DP 33
//                 (mode_set bitmask) is the authoritative capability list.
//   DP 16  bool   clear-energy button (write-only pulse)
//   DP 18  bool   switch
//   DP 24  value  temp_current (°C)
//   DP 25  value  charge_energy_once ×0.01 kWh — current/last session
//   DP 27  enum   online|offline — "live updates". Several chargers only stream
//                 live measurements while this is set to "online".
//   DP 28  value  timer_on (h) — delayed start

const WORK_STATES = [
  'charger_free', 'charger_insert', 'charger_free_fault', 'charger_wait',
  'charger_charging', 'charger_pause', 'charger_end', 'charger_fault',
  // Reported by some models (Emini, Zencar) in addition to the eight above.
  'charger_start_wait', 'charger_stop_wait',
  // Ein Lader mit durchweg eigenen Datenpunkten (gxrtu5vljdthtd3g) schreibt statt
  // der Tuya-Namen diese Grosskuerzel aus.
  'IDLE', 'IDLEINS', 'WORKING', 'PAUSE', 'SLEEP',
];

// Tuya's 8 work_state values → Homey's 5 standard evcharger_charging_state
// values. Tuya is more granular (it separates "waiting" from "finished" from
// "just plugged in"), so the raw value is additionally exposed through the
// ev_state_changed trigger and ev_state_is condition.
// Homey offers five values; Tuya reports up to ten. The collapse below matches
// how tuya-local reads the same firmware, which labels charger_free as
// "available" and charger_free_fault as "fault_unplugged" — so the "free" prefix
// reliably means nothing is connected. Because the firmware distinguishes
// charger_free_fault from plain charger_fault, the latter is taken to mean a
// fault while something *is* connected. Either way the fault itself is reported
// through alarm_generic and fault_code, not through this capability.
// plugged_in_discharging is unused: none of these chargers are bidirectional.
const STATE_MAP = {
  charger_free:       'plugged_out',
  charger_free_fault: 'plugged_out',
  charger_insert:     'plugged_in',
  charger_wait:       'plugged_in',
  charger_start_wait: 'plugged_in',
  charger_end:        'plugged_in',
  charger_fault:      'plugged_in',
  charger_charging:   'plugged_in_charging',
  charger_pause:      'plugged_in_paused',
  charger_stop_wait:  'plugged_in_paused',

  // Dieselben fuenf Zustaende in der Schreibweise des oben genannten Laders. Dass
  // IDLEINS das eingesteckte Ruhen meint, steht in keiner Beschreibung — es steht
  // im Geraet selbst: derselbe Lader schreibt seine Wechsel auf einen Textdatenpunkt
  // aus, und dort stand "state: WORKING → IDLEINS", waehrend das Auto angesteckt
  // blieb und die Leistung auf null fiel. IDLE ohne Anhaengsel ist der leere Zustand.
  IDLE:     'plugged_out',
  SLEEP:    'plugged_out',
  IDLEINS:  'plugged_in',
  WORKING:  'plugged_in_charging',
  PAUSE:    'plugged_in_paused',
};

// Welche zugeordneten Zustaende einen freigegebenen und welche einen abgeschalteten
// Lader bedeuten. Nur fuer den Fall, dass der Schalt-Datenpunkt selbst nichts meldet —
// siehe _schalterAusZustand. Ausgesteckt sagt nichts ueber die Freigabe und steht
// deshalb in keiner der beiden Mengen.
const AN_ZUSTAENDE  = new Set(['plugged_in_charging', 'plugged_in']);
const AUS_ZUSTAENDE = new Set(['plugged_in_paused']);

// Control-pilot states that mean the charger is actively supplying current.
// Per the CP standard, 9 V = vehicle connected and 6 V = vehicle ready, while the
// PWM suffix means the charger is signalling an available current — i.e. a charge
// is under way. Used to correct work_state on chargers that leave it at
// "charger_end" for the whole session (observed on SS_V1.x firmware).
const CP_CHARGING = new Set(['controlpi_9v_pwm', 'controlpi_6v_pwm']);

// Die Eintraege, die nicht schon im Manifest stehen, werden in dieser Reihenfolge
// angehaengt — und das ist die Reihenfolge der Kacheln.
//
// Darum stehen die Phasen B und C hier oben: auf einer Dreiphasenanlage folgen sie
// damit unmittelbar auf Phase A statt hinter sechs Diagnosewerten. Und alle drei
// Phasen stehen in derselben Folge — Leistung, Spannung, Strom, wie Phase A es im
// Manifest tut. Vorher las sich B und C andersherum als A, dieselben drei Werte in
// zweierlei Ordnung untereinander.
const OPTIONAL_CAPABILITIES = [
  { setting: 'dp_charge_current',   capability: 'target_power'          },
  // Voltage and current arrive one of two ways, and either justifies the capability:
  // the packed phase DP, or a plain numeric DP per quantity. The array form of
  // `setting` is what _syncOptionalCapabilities takes for exactly this case.
  //
  // measure_power is deliberately not optional — the SDK expects it on an EV charger,
  // and the "estimate" energy source can populate it without a power DP.
  { setting: ['dp_phase_a', 'dp_voltage_a', 'dp_phase_json'], capability: 'measure_voltage'   },
  { setting: ['dp_phase_a', 'dp_current_a', 'dp_phase_json'], capability: 'measure_current'   },
  // Phase B / C — only present on three-phase chargers.
  // Per-phase power stays tied to the packed DP: a charger that reports voltage and
  // current separately gives no per-phase power to show, only a total.
  { setting: ['dp_phase_b', 'dp_phase_json'], capability: 'measure_power.b' },
  { setting: ['dp_phase_b', 'dp_voltage_b', 'dp_phase_json'], capability: 'measure_voltage.b' },
  { setting: ['dp_phase_b', 'dp_current_b', 'dp_phase_json'], capability: 'measure_current.b' },
  { setting: ['dp_phase_c', 'dp_phase_json'], capability: 'measure_power.c' },
  { setting: ['dp_phase_c', 'dp_voltage_c', 'dp_phase_json'], capability: 'measure_voltage.c' },
  { setting: ['dp_phase_c', 'dp_current_c', 'dp_phase_json'], capability: 'measure_current.c' },
  { setting: ['dp_temperature', 'dp_phase_json'], capability: 'measure_temperature' },
  { setting: ['dp_session_energy', 'dp_phase_json', 'dp_charge_history'],
    capability: 'charge_session_energy' },
  { setting: 'dp_connection_state', capability: 'ev_connection_state'   },
  { setting: 'dp_work_mode',        capability: 'ev_work_mode'          },
  { setting: 'dp_timer_on',         capability: 'charge_delay_hours'    },
  { setting: 'dp_fault',            capability: 'alarm_generic'         },
  { setting: 'dp_fault',            capability: 'fault_code'            },
];

class EvChargerDevice extends BaseTuyaDevice {
  async onInit() {
    this.log('Device initialized:', this.getName());

    await this._baseInit();

    // Driver-specific state
    this._faultAlarmTimer      = null;
    this._faultAlarmConfirmed  = false;
    this._currentDebounceTimer = null;
    this._delayDebounceTimer   = null;
    // Raw Tuya work_state of the previous update — drives the detailed
    // state-changed trigger, which is finer-grained than Homey's 5-value
    // evcharger_charging_state. Seeded from the restored DPS cache so a restart
    // mid-session doesn't fire a spurious "session finished".
    this._prevWorkState = null;

    // Accumulated lifetime energy. Which source feeds it is chosen by the
    // total_energy_source setting — see _handleSessionEnergy and _onPollTick.
    this._energyAccum    = 0;
    this._lastSessionKwh = null;
    this._letzteLadung   = null;
    // Deliberately not persisted: after a restart the elapsed time is unknown, so
    // the first reading re-establishes the baseline rather than being judged.
    this._lastSessionTime = null;
    try {
      const stored = this.getStoreValue('energyAccum');
      if (typeof stored === 'number' && stored > 0) this._energyAccum = stored;
      const storedSession = this.getStoreValue('lastSessionKwh');
      if (typeof storedSession === 'number') this._lastSessionKwh = storedSession;
      // Welcher abgeschlossene Ladevorgang zuletzt aufaddiert wurde. Ohne dieses
      // Merkmal zaehlt jede Neuverbindung dieselbe Ladung noch einmal dazu: das
      // Geraet schickt seinen Verlaufsdatensatz unveraendert erneut.
      this._letzteLadung = this.getStoreValue('lastHistoryId') ?? null;
    } catch (e) {}

    // Power integration state (total_energy_source = power | estimate)
    this._lastPowerTime      = null; // timestamp of the previous integration step
    this._lastPowerWatts     = 0;    // most recent power reading or estimate
    this._prevTickPowerWatts = 0;    // power at the previous step, for trapezoidal averaging

    await this._migrateCapabilities([]);
    await this._syncOptionalCapabilities(OPTIONAL_CAPABILITIES);
    await this._applyCurrentLimitRange();

    // Seed the previous raw state from the DPS cache restored by _baseInit, so a
    // restart during a charge doesn't look like a fresh state transition.
    const wsDp = this.getSetting('dp_work_state');
    if (wsDp > 0 && this._lastDps[String(wsDp)] !== undefined) {
      const cached = String(this._lastDps[String(wsDp)]);
      if (STATE_MAP[cached]) this._prevWorkState = cached;
    }

    if (this.getSetting('dp_energy_total') <= 0 && this._energyAccum > 0) {
      this.setCapabilityValue('meter_power.charged', Math.round(this._energyAccum * 100) / 100).catch(() => {});
    }

    this._raeumeTeilerAuf();

    // ── Flow trigger cards ──────────────────────────────────────────────────
    this._triggerDeviceConnected    = this.homey.flow.getDeviceTriggerCard('ev_device_connected');
    this._triggerDeviceDisconnected = this.homey.flow.getDeviceTriggerCard('ev_device_disconnected');
    this._triggerDpChanged          = this.homey.flow.getDeviceTriggerCard('ev_dp_changed');
    this._triggerChargingEnded      = this.homey.flow.getDeviceTriggerCard('ev_charging_ended');
    this._triggerStateChanged       = this.homey.flow.getDeviceTriggerCard('ev_state_changed');
    this._triggerFaultOn            = this.homey.flow.getDeviceTriggerCard('ev_fault_alarm_on');
    this._triggerWorkModeChanged    = this.homey.flow.getDeviceTriggerCard('ev_work_mode_changed');

    // ── Capability listeners ─────────────────────────────────────────────────
    this._registeredCaps = new Set();
    this._registerListeners();

    await this._connect();
  }

  /**
   * Register capability listeners for all currently present capabilities.
   * Safe to call repeatedly (from onSettings after _syncOptionalCapabilities).
   */
  _registerListeners() {
    const register = (capability, listener) => {
      if (!this.hasCapability(capability)) return;
      if (this._registeredCaps.has(capability)) return;
      this._registeredCaps.add(capability);
      this.registerCapabilityListener(capability, listener);
    };

    // evcharger_charging is Homey's standard charge on/off switch. Homey
    // generates the "Start/Stop charging" actions and "Is charging" condition
    // from it automatically — no custom flow cards needed for those.
    register('evcharger_charging', async (value) => {
      await this._set(this.getSetting('dp_switch'), Boolean(value));
    });

    // target_power is Homey's standard charge-power control (watts) and is what
    // its energy management steers — e.g. solar-surplus charging. The charger
    // itself only accepts a current limit in amps, so watts are converted here.
    //
    // Homey clamps to min/max and snaps values inside the exclude range to 0
    // before the listener runs, so 0 here genuinely means "idle". These chargers
    // have no 0 A setting: idling is done by stopping the charge instead.
    // Debounced because Homey may adjust target_power frequently.
    register('target_power', (value) => {
      clearTimeout(this._currentDebounceTimer);
      return new Promise((resolve) => {
        this._currentDebounceTimer = setTimeout(async () => {
          const dp = this.getSetting('dp_charge_current');
          if (dp > 0) {
            const watts = Number(value) || 0;
            if (watts <= 0) {
              // Idle request — stop charging rather than writing an invalid 0 A.
              await this._set(this.getSetting('dp_switch'), false).catch(() => {});
            } else {
              await this._set(dp, this._wattsToRawCurrent(watts)).catch(() => {});
            }
          }
          resolve();
        }, DEBOUNCE_MS);
      });
    });

    register('ev_work_mode', async (value) => {
      await this._set(this.getSetting('dp_work_mode'), String(value));
    });

    register('charge_delay_hours', (value) => {
      clearTimeout(this._delayDebounceTimer);
      return new Promise((resolve) => {
        this._delayDebounceTimer = setTimeout(async () => {
          const dp = this.getSetting('dp_timer_on');
          if (dp > 0) await this._set(dp, Math.round(value)).catch(() => {});
          resolve();
        }, DEBOUNCE_MS);
      });
    });
  }

  // ── Power ⇄ current conversion ──────────────────────────────────────────────
  // The charger speaks amps (DP 4); Homey's target_power speaks watts.
  //   W = A × V × phases

  /** Watts per amp for this installation (voltage × phase count). */
  _wattsPerAmp() {
    const volts  = this.getSetting('nominal_voltage') ?? 230;
    const phases = parseInt(this.getSetting('phase_count') ?? '1', 10) || 1;
    return volts * phases;
  }

  /**
   * Multiplier turning a raw DP value into its real-world unit. Chargers are not
   * consistent here: most report the current limit as plain amps and energy in
   * hundredths of a kWh, but some scale the current by ten, and the session and
   * lifetime counters can even use different scales on the same unit — hence one
   * setting per DP rather than one shared assumption.
   */
  _scaleOf(settingKey, fallback) {
    const v = parseFloat(this.getSetting(settingKey));
    return Number.isFinite(v) && v > 0 ? v : fallback;
  }

  /** Convert a target power in watts to the raw value the charger expects on its current DP. */
  _wattsToRawCurrent(watts) {
    const min  = this.getSetting('current_min') ?? 6;
    const max  = this.getSetting('current_max') ?? 16;
    const amps = Math.max(min, Math.min(max, Math.round(watts / this._wattsPerAmp())));
    return Math.round(amps / this._scaleOf('current_scale', 1));
  }

  /**
   * Keep target_power's slider range in step with the configured hardware limits.
   *
   * min is 0 so the device can always idle (required by the SDK), and the
   * exclude range covers everything below the charger's minimum current — Homey
   * snaps requests inside it to 0 instead of asking for an impossible current.
   */
  async _applyCurrentLimitRange() {
    if (!this.hasCapability('target_power')) return;
    const wPerA = this._wattsPerAmp();
    const min   = this.getSetting('current_min') ?? 6;
    const max   = this.getSetting('current_max') ?? 16;
    if (max <= min) return;
    await this._setCapabilityOptionsIfChanged('target_power', {
      min:        0,
      max:        max * wPerA,
      step:       wPerA, // one amp
      excludeMin: 0,
      excludeMax: min * wPerA,
    }).catch(() => {});
  }

  // ── Hook overrides ─────────────────────────────────────────────────────────

  _onConnected() {
    clearTimeout(this._faultAlarmTimer);
    this._faultAlarmTimer     = null;
    this._faultAlarmConfirmed = false;
    // Drop the integration baseline: time spent offline must not be counted as
    // charging time on the next tick.
    this._lastPowerTime       = null;
    this._prevTickPowerWatts  = 0;

    // Several chargers only stream live voltage/current/power while DP 27 is
    // set to "online". Re-assert it on every connect when the user enabled it.
    const dp = this.getSetting('dp_live_updates');
    if (dp > 0) {
      setTimeout(() => { this._set(dp, 'online').catch(() => {}); }, 2000);
    }
  }

  async _onDeleted() {
    clearTimeout(this._faultAlarmTimer);
    clearTimeout(this._currentDebounceTimer);
    clearTimeout(this._delayDebounceTimer);
    await this.setStoreValue('energyAccum', this._energyAccum).catch(() => {});
  }

  // ── Phase raw parsing ───────────────────────────────────────────────────────

  /**
   * Parses a phase DP (6 / 7 / 8), delivered by TuyAPI as a base64 string.
   *
   *   bytes 0-1  voltage ×0.1 V
   *   bytes 2-4  current ×0.001 A
   *   bytes 5+   power in W (3 bytes on most chargers, 2 bytes on the 7-byte
   *              variant used by Nine / Amperepoint / Noeifevo)
   *
   * Returns { voltage, current, power } or null when unparseable.
   */
  _parsePhase(rawValue) {
    try {
      const buf = Buffer.from(String(rawValue), 'base64');
      if (buf.length < 7) return null;

      const voltage = buf.readUInt16BE(0) * 0.1;
      const current = ((buf[2] << 16) | (buf[3] << 8) | buf[4]) * 0.001;
      // Power occupies whatever remains: 3 bytes (8-byte buffer) or 2 (7-byte).
      const power = buf.length >= 8
        ? ((buf[5] << 16) | (buf[6] << 8) | buf[7])
        : ((buf[5] << 8) | buf[6]);

      return { voltage, current, power };
    } catch (e) {
      return null;
    }
  }

  /** Writes a parsed phase to the given capability suffix ('' | '.b' | '.c'). */
  /**
   * Ein einzelner Messwert einer Phase.
   *
   * Der gepackte Phasen-DP bringt Spannung, Strom und Leistung in einem Paket; Lader,
   * die sie getrennt melden, liefern je DP nur eine Groesse. Beide Wege enden hier,
   * damit Rundung und Faehigkeitsnamen an einer Stelle stehen und nicht auseinander
   * laufen koennen.
   *
   * @param {'voltage'|'current'} art
   * @param {string} suffix  '' fuer Phase A, '.b' / '.c' fuer die uebrigen
   */
  async _applyPhaseField(art, suffix, wert) {
    const name = art === 'voltage' ? `measure_voltage${suffix}` : `measure_current${suffix}`;
    if (!this.hasCapability(name)) return;
    // Spannung auf ein Zehntel, Strom auf ein Hundertstel - wie bisher im gepackten Weg.
    const genau = art === 'voltage' ? 10 : 100;
    await this.setCapabilityValue(name, Math.round(wert * genau) / genau).catch(() => {});
  }

  async _applyPhase(parsed, suffix) {
    const p = `measure_power${suffix}`;
    await this._applyPhaseField('voltage', suffix, parsed.voltage);
    await this._applyPhaseField('current', suffix, parsed.current);
    // Total power (DP 9) wins over per-phase power for the main measure_power
    // tile, so only write it here when no total-power DP is configured.
    if (this.hasCapability(p) && (suffix !== '' || this.getSetting('dp_power_total') <= 0)) {
      await this.setCapabilityValue(p, Math.round(parsed.power)).catch(() => {});
    }
  }

  // ── Alle drei Phasen in einem JSON-Datenpunkt ───────────────────────────────

  /**
   * Liest den JSON-Block, in dem manche Lader saemtliche Messwerte auf einmal
   * schicken, statt drei gepackte Phasenpakete zu senden.
   *
   *   {"L1":[2320,55,12],"L2":[2320,58,13],"L3":[2320,56,13],
   *    "t":370,"p":39,"d":54150,"e":113}
   *
   * Jede Phase ist ein Dreier: Spannung, Strom, Leistung, alle in Zehnteln ihrer
   * Einheit — 2320 sind 232,0 V, 55 sind 5,5 A, 12 sind 1,2 kW. Das laesst sich
   * nachrechnen statt glauben: 232,0 × 5,5 ergibt 1,28 kW, und die Summe der drei
   * Phasenleistungen trifft mit 3,8 kW das p von 3,9 kW. t sind 37,0 °C, was der
   * Meldende an seinem Geraet ablas.
   *
   * e ist die Sitzungsenergie, in Zehnteln einer Kilowattstunde. Das steht hier zum
   * dritten Mal, und diesmal gemessen statt geschlossen: der Meldende hat den Block
   * gegen die Hersteller-App gehalten, im selben Augenblick, dreimal — e=28 gegen
   * 2,8 kWh, e=12 gegen 1,2, e=14 gegen 1,4.
   *
   * Der Umweg dazwischen war mein Fehler, und es lohnt, ihn aufzuschreiben. Ich hatte
   * auf d umgestellt, weil 9010 und 11410 als Wattstunden auf eine Ladung zuliefen,
   * die bei 12,1 kWh endete — und e mit 1,4 und 2,1 "laengst darueber hinaus" war.
   * Dass die Sitzung zu diesem Zeitpunkt schon fast fertig war, wusste ich aber nur
   * aus d selbst. Ich habe die Annahme, die ich pruefen wollte, in die Pruefung
   * eingesetzt. Fruh in der Sitzung gemessen passen 1,4 und 2,1 zwanglos.
   *
   * d ist die Dauer der laufenden Sitzung, in Zehntelsekunden. Auch das ist gemessen:
   * derselbe Lader schreibt auf einem Textdatenpunkt "charge: t=1225s e=1.130kWh"
   * aus, und im selben Augenblick stand im Block d=12350 und e=11. 1235 gegen 1225
   * Sekunden — zehn Sekunden Unterschied, genau der Abfragetakt.
   *
   * Zwei alte Aufnahmen bestaetigen es unabhaengig davon: zwischen ihnen liegen
   * 240 Sekunden und 0,7 kWh, was 10,5 kW ergibt — die Leistung, die beide meldeten.
   * Energie ueber Zeit trifft die Leistung, und damit stimmen beide Einheiten.
   *
   * Der ganze Block zaehlt also in Zehnteln seiner Einheit, ohne Ausnahme: 2320 sind
   * 232,0 V, 55 sind 5,5 A, 370 sind 37,0 °C, 39 sind 3,9 kW, 113 sind 11,3 kWh und
   * 12350 sind 1235,0 Sekunden.
   *
   * @param {*} value
   * @returns {{phasen: Object, gesamt: number|null, temperatur: number|null,
   *            sitzung: number|null, zaehler: number|null}|null}
   */
  _parsePhaseJson(value) {
    let roh = value;
    if (typeof roh === 'string') {
      try { roh = JSON.parse(roh); } catch (e) { return null; }
    }
    if (!roh || typeof roh !== 'object' || Array.isArray(roh)) return null;

    const teiler = (schluessel, vorgabe) => {
      const n = Number(this.getSetting(schluessel));
      return Number.isFinite(n) && n !== 0 ? n : vorgabe;
    };
    const uTeiler = teiler('json_voltage_divisor', 10);
    const iTeiler = teiler('json_current_divisor', 10);
    // Homey rechnet Leistung in Watt. Der Block zaehlt in Zehnteln eines Kilowatts,
    // also ist ein Punkt hundert Watt.
    const pFaktor = teiler('json_power_factor', 100);

    const phasen = {};
    for (const name of ['L1', 'L2', 'L3']) {
      const v = roh[name];
      if (!Array.isArray(v) || v.length < 2) continue;
      const [u, i, p] = v.map(Number);
      if (!Number.isFinite(u) || !Number.isFinite(i)) continue;
      phasen[name] = {
        voltage: u / uTeiler,
        current: i / iTeiler,
        power:   Number.isFinite(p) ? p * pFaktor : 0,
      };
    }
    if (Object.keys(phasen).length === 0) return null;

    const zahl = (x) => (Number.isFinite(Number(x)) ? Number(x) : null);

    // Vorgabe e, wie im Manifest. Beide muessen dasselbe sagen: eine Einstellung, die
    // eine spaetere Fassung hinzufuegt, bekommt ihre Manifestvorgabe nur beim
    // Einrichten eines Geraets — auf allem, was schon bestand, liefert getSetting
    // null, und dann entscheidet allein diese Zeile.
    const feld = String(this.getSetting('json_session_field') ?? 'e');
    const sitzungRoh = (feld === 'none' || feld === '') ? null : zahl(roh[feld]);

    return {
      phasen,
      gesamt:     zahl(roh.p) === null ? null : zahl(roh.p) * pFaktor,
      temperatur: zahl(roh.t) === null ? null : zahl(roh.t) / teiler('json_temp_divisor', 10),
      sitzung:    sitzungRoh === null ? null : sitzungRoh / teiler('json_energy_divisor', 10),
      // Was nicht zugeordnet ist, wird berichtet — beide Felder, wenn keines gewaehlt ist.
      offen: ['d', 'e']
        .filter((n) => n !== feld && zahl(roh[n]) !== null)
        .map((n) => ({ name: n, wert: zahl(roh[n]) })),
    };
  }

  /** Traegt einen gelesenen JSON-Block in die Kacheln ein. */
  async _applyPhaseJson(block) {
    for (const [name, suffix] of [['L1', ''], ['L2', '.b'], ['L3', '.c']]) {
      if (block.phasen[name]) await this._applyPhase(block.phasen[name], suffix);
    }

    // Die Gesamtleistung schlaegt die der ersten Phase — dieselbe Vorrangregel wie
    // beim gepackten Weg, wo der Gesamt-DP die Phase A ueberstimmt. Homeys
    // Energieuebersicht braucht die Summe, nicht ein Drittel davon.
    if (block.gesamt !== null && this.hasCapability('measure_power')) {
      await this.setCapabilityValue('measure_power', Math.round(block.gesamt)).catch(() => {});
    }
    if (block.temperatur !== null && this.hasCapability('measure_temperature')) {
      await this.setCapabilityValue('measure_temperature',
        Math.round(block.temperatur * 10) / 10).catch(() => {});
    }
    if (block.sitzung !== null) await this._handleSessionEnergy(block.sitzung);

    // Die nicht zugeordneten Felder einmal ausschreiben, statt sie zu raten. Wer den
    // Bericht liest, sieht die Rohwerte und kann sie gegen sein Geraet halten.
    if (block.offen.length && !this._offenGemeldet) {
      this._offenGemeldet = true;
      const werte = block.offen.map((o) => {
        // d ist entschluesselt, nur nicht zugeordnet: es gibt keine Kachel dafuer.
        if (o.name === 'd') {
          const s = o.wert / 10;
          return `d=${o.wert} (${Math.floor(s / 60)}m ${Math.round(s % 60)}s of charging)`;
        }
        return `${o.name}=${o.wert}`;
      }).join(' and ');
      this._appLog(`The phase JSON also carries ${werte}. On the charger this was measured `
        + 'against, every field of the block counts in tenths of its unit, d included — it is '
        + 'the running session\'s duration, confirmed against the same charger writing '
        + '"charge: t=1225s" while the block read d=12350. It is not shown anywhere because '
        + 'there is no tile for it. If your charger disagrees, report these raw numbers with '
        + 'what its own app shows at the same moment.', 'info', true);
    }
  }

  /**
   * Nimmt einen Teiler zurueck, den niemand gemessen haben kann.
   *
   * Eine Fassung lang stand die Vorgabe des Teilers auf 1000, waehrend das Feld
   * daneben auf "keins" stand — der Teiler wurde also von nichts benutzt, und wer in
   * dieser Zeit ein Geraet einrichtete, hat die 1000 gespeichert, ohne sie je gegen
   * etwas halten zu koennen. Mit e als Vorgabe ergaeben sie aus 28 nun 0,028 kWh.
   *
   * Angefasst wird nur dieser eine Fall. Wer d gewaehlt hat, hat es bewusst getan —
   * die 1000 gehoeren dort zusammen, und sie bleiben stehen.
   */
  _raeumeTeilerAuf() {
    try {
      if ((this.getSetting('dp_phase_json') ?? 0) <= 0) return;
      if (Number(this.getSetting('json_energy_divisor')) !== 1000) return;
      if (String(this.getSetting('json_session_field') ?? '') === 'd') return;

      this.setSettings({ json_energy_divisor: 10 })
        .then(() => this._appLog('JSON session energy divisor corrected from 1000 to 10. The '
          + '1000 was a default from a version in which no field was read at all, so it was '
          + 'never measured against anything; the session energy in this block counts in tenths '
          + 'of a kilowatt-hour, verified against a charger\'s own app.', 'info'))
        .catch(() => {});
    } catch (e) { /* eine Vorgabe ist die Initialisierung nicht wert */ }
  }

  // ── Abgeschlossene Ladungen ─────────────────────────────────────────────────

  /** Ein Teiler aus den Einstellungen; null und Unsinn fallen auf die Vorgabe zurueck. */
  _teilerVon(schluessel, vorgabe) {
    const n = Number(this.getSetting(schluessel));
    return Number.isFinite(n) && n !== 0 ? n : vorgabe;
  }

  /**
   * Liest den Datensatz, den manche Lader nach jeder beendeten Ladung ausschreiben.
   *
   *   {"t":"2026-09-20 15:09:32","s":"15:09","e":"17:42","d":9159,"c":121}
   *
   * Dies ist der einzige Wert am ganzen Geraet, der sich ohne Raten nachpruefen
   * laesst, und er geht dreifach auf: s und e spannen 15:09 bis 17:42, also 9148
   * Sekunden; d zaehlt 9159, dieselbe Spanne auf die Sekunde statt auf die Minute
   * gerundet; und c von 121 sind die 12,1 kWh, die die Hersteller-App fuer genau
   * diese Ladung zeigte — zusammen mit den 2 h 32 min, die d bestaetigt.
   *
   * Daraus folgt zweierlei. Erstens hat dieser Lader eine genaue Sitzungsenergie,
   * die niemand zu erraten braucht. Zweitens heisst d in der Sprache dieser Firmware
   * Dauer und nicht Energie — was das d im Messblock nebenan fragwuerdig macht,
   * siehe dort.
   *
   * @param {*} value
   * @returns {{kwh: number, sekunden: number|null, kennung: string}|null}
   */
  _parseChargeHistory(value) {
    let roh = value;
    if (typeof roh === 'string') {
      try { roh = JSON.parse(roh); } catch (e) { return null; }
    }
    if (!roh || typeof roh !== 'object' || Array.isArray(roh)) return null;

    const c = Number(roh.c);
    if (!Number.isFinite(c)) return null;

    const d = Number(roh.d);
    return {
      kwh:      c / this._teilerVon('history_energy_divisor', 10),
      sekunden: Number.isFinite(d) ? d : null,
      // Ein Datensatz ist derselbe, solange sein Zeitstempel derselbe ist. Fehlt er,
      // muessen Dauer und Menge zusammen herhalten.
      kennung:  String(roh.t ?? `${roh.s}-${roh.e}-${d}-${c}`),
    };
  }

  /**
   * Traegt eine beendete Ladung ein.
   *
   * Der laufende Zaehler und der Verlaufsdatensatz brauchen verschiedene
   * Buchhaltung: beim laufenden Zaehler ist nur der Zuwachs neu, beim Verlauf die
   * ganze Ladung. Der Zuwachs-Weg wuerde hier falsch rechnen, sobald eine Ladung
   * kleiner ausfaellt als die davor — zwoelf kWh, dann acht, und die acht zaehlen
   * gar nicht. Darum wird der Datensatz an seinem Zeitstempel erkannt und einmal
   * vollstaendig addiert.
   */
  async _handleChargeHistory(rec) {
    if (this.hasCapability('charge_session_energy')) {
      await this.setCapabilityValue('charge_session_energy',
        Math.round(rec.kwh * 100) / 100).catch(() => {});
    }
    this._lastSessionKwh = rec.kwh;

    if (rec.kennung === this._letzteLadung) return;
    const erste = this._letzteLadung === null;
    this._letzteLadung = rec.kennung;
    await this.setStoreValue('lastHistoryId', rec.kennung).catch(() => {});

    // Abgerundet, nicht gerundet: 9159 Sekunden sind 2 h 32 min, und genau so
    // schreibt das Geraet selbst sie an. Aufgerundet waeren es 2 h 33 und der
    // Nutzer haette eine Minute, die er nirgends wiederfindet.
    const dauer = rec.sekunden === null ? ''
      : `, ${Math.floor(rec.sekunden / 3600)}h ${Math.floor((rec.sekunden % 3600) / 60)}m`;
    this._appLog(`Charge finished: ${Math.round(rec.kwh * 100) / 100} kWh${dauer}`, 'info');

    // Beim allerersten Datensatz steht nicht fest, ob er neu ist oder nur der, den
    // das Geraet seit Tagen vorhaelt. Ihn mitzuzaehlen hiesse, eine fremde Ladung
    // dem Gesamtzaehler anzulasten; also wird er nur gemerkt.
    if (erste) return;
    if (this._energySource() !== 'session' || this.getSetting('dp_energy_total') > 0) return;
    if (!(rec.kwh > 0) || rec.kwh > 200) return;

    this._energyAccum += rec.kwh;
    await this._writeTotalEnergy();
  }

  // ── Session → lifetime energy ───────────────────────────────────────────────

  /**
   * DP 25 (session energy) is the fallback lifetime-energy source for chargers
   * whose own total counter (DP 1) never updates over the local connection.
   * Lifetime energy accumulates from positive session deltas; when the session
   * counter drops (new session), the baseline resets without adding.
   */
  async _handleSessionEnergy(kwh) {
    if (this.hasCapability('charge_session_energy')) {
      await this.setCapabilityValue('charge_session_energy', Math.round(kwh * 100) / 100).catch(() => {});
    }

    // Only accumulate here when the session counter is the chosen source and the
    // charger's own lifetime counter isn't in use.
    //
    // Und nicht, wenn ein Verlaufsdatensatz gesetzt ist: der traegt jede beendete
    // Ladung vollstaendig ein, der laufende Zaehler traegt dieselbe Ladung als Summe
    // seiner Zuwaechse ein, und der Gesamtzaehler bekaeme sie zweimal. Wo es beides
    // gibt, gehoert die Buchhaltung dem exakten Wert; der laufende fuellt nur die
    // Kachel. Das war neu und mein Fehler — den Verlaufsdatensatz habe ich
    // eingebaut, als hier gerade gar nichts zugeordnet war, und da fiel es nicht auf.
    if (this._energySource() === 'session'
        && this.getSetting('dp_energy_total') <= 0
        && (this.getSetting('dp_charge_history') ?? 0) <= 0) {
      if (this._lastSessionKwh !== null && kwh > this._lastSessionKwh) {
        const delta = kwh - this._lastSessionKwh;
        if (this._isPlausibleDelta(delta)) {
          this._energyAccum += delta;
          await this._writeTotalEnergy();
        }
      }
    }
    this._lastSessionKwh  = kwh;
    this._lastSessionTime = Date.now();
    this.setStoreValue('lastSessionKwh', kwh).catch(() => {});
  }

  /** Which source feeds meter_power.charged. */
  _energySource() {
    return this.getSetting('total_energy_source') || 'session';
  }

  /**
   * Writes evcharger_charging_state from the three signals the charger provides.
   *
   * work_state alone is not dependable: some firmware reports "charger_end" for
   * the entire session, which would leave the tile stuck on "Plugged in" while
   * the car is charging. So when work_state claims the charge is merely plugged
   * in, but the charge switch is on and the control pilot shows an active PWM
   * signal, the charging state is reported instead. Called from the work_state,
   * switch and connection_state handlers, since any of them can change first.
   */
  async _updateChargingState() {
    const raw = this._prevWorkState;
    if (!raw) return;
    let state = STATE_MAP[raw];
    if (!state) return;

    if (state === 'plugged_in'
        && this.getCapabilityValue('evcharger_charging') === true
        && CP_CHARGING.has(this._lastConnState)) {
      state = 'plugged_in_charging';
    }
    await this.setCapabilityValue('evcharger_charging_state', state).catch(() => {});
    await this._schalterAusZustand(raw, state);
  }

  /**
   * Fuehrt den Schalter am gemeldeten Zustand nach, wenn der Schalt-DP stumm ist.
   *
   * Manche Lader nehmen Befehle auf einem reinen Schreib-Datenpunkt entgegen — bei
   * dem gemeldeten Geraet ist es DP 140, "x_do_charge". Der bestaetigt nichts und
   * meldet nichts: schaltet man am Geraet selbst oder in der Hersteller-App, bleibt
   * Homeys Schalter stehen, wo er stand. Der Zustand daneben stimmt derweil, weil er
   * aus einem anderen Datenpunkt kommt.
   *
   * Also wird der Schalter aus dem Zustand nachgezogen — aber nur, solange der
   * Schalt-DP noch nie von sich aus etwas gesagt hat. Sobald er einmal antwortet,
   * hoert das hier auf, und der gemeldete Wert gilt wieder allein.
   *
   * Woran das erkannt wird, war beim ersten Anlauf falsch: gefragt wurde, ob die
   * Nummer je in einem Paket vorkam. Das Echo eines eigenen Befehls kommt aber auch
   * in einem Paket vor. Wer also einmal in Homey schaltete, schaltete sich damit die
   * Nachfuehrung ab — und das war genau der Fall, fuer den sie gebaut ist. Gezaehlt
   * wird jetzt nur, was den Echo-Filter passiert hat, also eine echte Meldung.
   *
   * "Angesteckt, im Ruhen" zaehlt als eingeschaltet: der Lader ist freigegeben, das
   * Fahrzeug fragt nur gerade nichts ab. Abgeschaltet ist er erst, wenn der Zustand
   * das sagt.
   */
  async _schalterAusZustand(raw, state) {
    const dp = this.getSetting('dp_switch') ?? 0;
    if (dp <= 0) return;
    if (this._schaltDpMeldetSich) return;   // er meldet sich, also nicht eingreifen
    if (!AN_ZUSTAENDE.has(state) && !AUS_ZUSTAENDE.has(state)) return;

    const an = AN_ZUSTAENDE.has(state);
    if (this.getCapabilityValue('evcharger_charging') === an) return;

    if (!this._schalterGemeldet) {
      this._schalterGemeldet = true;
      this._appLog(`Data point ${dp} accepts commands but never reports back, so the charging `
        + `switch is being followed from the charger's own state instead ("${raw}"). It will `
        + `stop doing that the moment DP ${dp} reports a value of its own.`, 'info');
    }
    await this.setCapabilityValue('evcharger_charging', an).catch(() => {});
  }

  /**
   * Rejects a session-counter jump that no amount of charging could have produced
   * in the time that has passed.
   *
   * The session counter is firmware-maintained and can glitch — a charger has been
   * observed reporting 48.3 kWh for a session that actually delivered about 10,
   * hours after charging had already stopped, apparently after two brief restarts
   * confused its internal tally. Because the lifetime total is built from these
   * deltas, one bad reading would corrupt it permanently.
   *
   * The ceiling is what the charger could deliver at its configured maximum
   * current over the elapsed time, plus generous headroom so that a genuine long
   * gap (Homey restarted or offline mid-charge) is never discarded.
   */
  _isPlausibleDelta(deltaKwh) {
    if (!this._lastSessionTime) return true; // no baseline yet — cannot judge
    const elapsedH = (Date.now() - this._lastSessionTime) / 3_600_000;
    const maxKw    = ((this.getSetting('current_max') ?? 16) * this._wattsPerAmp()) / 1000;
    // ×1.25 absorbs mains above nominal; +0.5 kWh covers short polling intervals,
    // where elapsed time alone would give an unrealistically tight bound.
    const ceiling  = (maxKw * elapsedH * 1.25) + 0.5;
    if (deltaKwh <= ceiling) return true;

    this._appLog(
      `Ignored an implausible energy jump of ${deltaKwh.toFixed(2)} kWh: at most ` +
      `${ceiling.toFixed(2)} kWh could have been delivered in the ${(elapsedH * 60).toFixed(1)} min ` +
      `since the last reading. The charger's own session counter most likely glitched; ` +
      `the running total was left untouched.`,
      'warn',
    );
    return false;
  }

  async _writeTotalEnergy() {
    this.setStoreValue('energyAccum', this._energyAccum).catch(() => {});
    await this.setCapabilityValue('meter_power.charged',
      Math.round(this._energyAccum * 1000) / 1000).catch(() => {});
  }

  /**
   * Best guess at the current charging power in watts, for chargers that report
   * no usable power DP. While charging, these units draw essentially the current
   * limit that was set, so limit × voltage × phases is a fair approximation —
   * it is an estimate, not a measurement, and only used when explicitly selected.
   */
  _estimatedWatts() {
    // Gate on the resolved charging state, not the raw charge switch: the switch
    // can sit at "on" while the session has already finished, which would
    // otherwise book phantom power for as long as the cable stays plugged in.
    if (this.getCapabilityValue('evcharger_charging_state') !== 'plugged_in_charging') return 0;
    // target_power mirrors the current limit the charger reports on DP 4, so the
    // estimate follows whatever the charger is actually set to.
    const target = this.getCapabilityValue('target_power');
    if (typeof target === 'number' && target > 0) return target;
    // No limit known yet — fall back to the configured maximum current.
    return (this.getSetting('current_max') ?? 16) * this._wattsPerAmp();
  }

  /** True when no DP supplies real power readings, so an estimate is the only option. */
  _hasNoPowerDp() {
    return (this.getSetting('dp_power_total') ?? 0) <= 0
        && (this.getSetting('dp_phase_a') ?? 0) <= 0
        && (this.getSetting('dp_phase_json') ?? 0) <= 0;
  }

  /**
   * Trapezoidal energy integration, mirroring the Smart Plug driver. Runs on the
   * poll timer so that steady power still accumulates even though an unchanged DP
   * value is filtered out before it reaches _handleDps.
   */
  async _onPollTick() {
    // Voltage, current and power live in the packed phase DP, which most chargers
    // send only in reply to a refresh request. The base polling loop alternates
    // between a full query and a refresh, which would halve the update rate for
    // exactly those values — so ask for a refresh on every tick as well. Overlapping
    // requests are suppressed by the connection's own in-flight guard.
    if ((this.getSetting('dp_phase_a') ?? 0) > 0
        || (this.getSetting('dp_phase_json') ?? 0) > 0) {
      this.refreshDps().catch(() => {});
    }

    const source   = this._energySource();
    // Show an estimated wattage whenever the user asked for it and the charger
    // supplies no real power reading. Deliberately independent of the energy
    // source, so a charger with a working energy counter can still display power.
    const showEst  = (this.getSetting('estimate_power') === true || source === 'estimate')
                      && this._hasNoPowerDp();
    // A charger with its own lifetime counter owns meter_power.charged — the DP
    // writes it directly. Integrating on top of that had both writing the same
    // capability with different numbers, the later write winning, so the total
    // jittered between the charger's figure and ours. The hardware counter wins.
    const integrate = (source === 'power' || source === 'estimate')
      && this.getSetting('dp_energy_total') <= 0;
    if (!showEst && !integrate) return;

    const watts = (source === 'estimate' || showEst)
      ? this._estimatedWatts()
      : (this.getCapabilityValue('measure_power') ?? 0);

    if (showEst && this.hasCapability('measure_power')) {
      await this.setCapabilityValue('measure_power', Math.round(watts)).catch(() => {});
    }
    if (!integrate) return; // display only — do not accumulate energy
    this._lastPowerWatts = watts;

    if (this._lastPowerTime === null) {
      // First tick only establishes the baseline — nothing to integrate yet.
      this._lastPowerTime      = Date.now();
      this._prevTickPowerWatts = watts;
      return;
    }

    const now      = Date.now();
    const elapsedH = (now - this._lastPowerTime) / 3_600_000;
    // Cap at twice the poll interval so a long outage cannot produce a huge jump.
    const maxH     = (this._pollIntervalMs * 2) / 3_600_000;
    if (elapsedH > 0 && elapsedH < maxH) {
      const avgWatts = (this._prevTickPowerWatts + watts) / 2;
      if (avgWatts > 0) {
        this._energyAccum += (avgWatts * elapsedH) / 1000;
        await this._writeTotalEnergy();
      }
    }
    this._prevTickPowerWatts = watts;
    this._lastPowerTime      = now;
  }

  // ── DPS handling ───────────────────────────────────────────────────────────

  async _handleDps(dps) {
    const settings = this.getSettings();
    let   changed  = false;

    for (const [dpStr, value] of Object.entries(dps)) {
      if (this._lastDps[dpStr] === value) continue;
      this._lastDps[dpStr] = value;
      changed = true;

      const dp = parseInt(dpStr, 10);

      this._triggerDpChanged
        .trigger(this, { dp: dpStr, value: String(value) })
        .catch(() => {});

      // ── Switch ───────────────────────────────────────────────────────────
      if (settings.dp_switch > 0 && dp === settings.dp_switch) {
        // Hier ankommen heisst: der Datenpunkt meldet sich wirklich. Was hier landet,
        // hat den Echo-Filter schon hinter sich — ein Wert, den wir selbst gerade
        // gesetzt haben, kommt nie bis hierher. Genau diese Unterscheidung fehlte:
        // die erste Fassung fragte, ob die Nummer je angekommen sei, und das Echo
        // eines eigenen Befehls zaehlte mit. Wer einmal in Homey schaltete, schaltete
        // sich damit die Nachfuehrung ab — und das war ausgerechnet der Fall, fuer
        // den sie gebaut ist.
        this._schaltDpMeldetSich = true;
        await this.setCapabilityValue('evcharger_charging', Boolean(value)).catch(() => {});
        await this._updateChargingState();
        continue;
      }

      // ── Work state ───────────────────────────────────────────────────────
      if (settings.dp_work_state > 0 && dp === settings.dp_work_state) {
        const state = String(value);
        // Ein unbekannter Zustand kostete bisher den ganzen Datenpunkt: gemeldet und
        // verworfen, womit auch der Auslöser ausblieb. Dabei ist gerade er das, was
        // bei fremder Firmware noch nutzbar ist — der Rohwert steht im Flow zur
        // Verfügung, auch wenn die Kachel ihn nicht darstellen kann. Also nur die
        // Zuordnung überspringen, nicht den Rest. Gemeldet wird je Wert einmal,
        // statt siebzehnmal wie im Bericht, der das ans Licht brachte.
        if (!STATE_MAP[state] && !this._wsGemeldet?.has(state)) {
          (this._wsGemeldet = this._wsGemeldet || new Set()).add(state);
          this._appLog(`work_state: unknown value "${state}" — expected one of `
            + `${WORK_STATES.join(', ')}. The state tile keeps its last value; flows on `
            + '"EV state changed" still receive this text.', 'warn');
        }
        // prevRaw comes from _lastDps, which was already updated above — so read
        // the value captured before this loop iteration overwrote it.
        const prevRaw = this._prevWorkState ?? null;
        this._prevWorkState = state;

        await this._updateChargingState();

        if (prevRaw !== null && prevRaw !== state) {
          this._triggerStateChanged.trigger(this, { state, prev_state: prevRaw }).catch(() => {});
          // Das Ende einer Ladung an den zugeordneten Zustaenden festmachen, nicht an
          // den Tuya-Namen: der Lader, der WORKING statt charger_charging schreibt,
          // haette sonst nie ein Ende gemeldet.
          if (STATE_MAP[prevRaw] === 'plugged_in_charging'
              && STATE_MAP[state] && STATE_MAP[state] !== 'plugged_in_charging') {
            const kwh = this.getCapabilityValue('charge_session_energy') ?? 0;
            this._triggerChargingEnded.trigger(this, { energy: kwh }).catch(() => {});
          }
        }
        continue;
      }

      // ── Charge current limit → target_power (A → W) ───────────────────────
      // The charger may clamp what we asked for, so mirror back what it reports.
      // Clamped to the slider's own maximum: a charger reporting more amps than
      // current_max would otherwise produce a value the capability rejects.
      if (settings.dp_charge_current > 0 && dp === settings.dp_charge_current) {
        if (this.hasCapability('target_power')) {
          const amps    = Number(value) * this._scaleOf('current_scale', 1);
          const maxAmps = settings.current_max ?? 16;
          const watts   = Math.min(amps, maxAmps) * this._wattsPerAmp();
          await this.setCapabilityValue('target_power', watts).catch(() => {});
        }
        continue;
      }

      // ── Total power (DP 9) / single-phase power (DP 5) ────────────────────
      if (settings.dp_power_total > 0 && dp === settings.dp_power_total) {
        // Most chargers report watts, so the factor defaults to 1 and this line does
        // what it always did. Some report tenths of a kilowatt - 110 for 11 kW - and
        // without a factor that showed up as 110 W.
        const watt = Number(value) * this._scaleOf('power_scale', 1);
        await this.setCapabilityValue('measure_power', Math.round(watt)).catch(() => {});
        continue;
      }

      // ── Alle Phasen in einem JSON-Block ──────────────────────────────────
      if (settings.dp_phase_json > 0 && dp === settings.dp_phase_json) {
        const block = this._parsePhaseJson(value);
        if (block) { await this._applyPhaseJson(block); continue; }
        if (!this._jsonHinted) {
          this._jsonHinted = true;
          this._appLog(`Data point ${dp} is set as the phase JSON block, but what arrived is `
            + `not one: ${JSON.stringify(value).slice(0, 80)}. Expected an object with L1, L2 `
            + 'and L3, each a list of voltage, current and power. Set DP Phase JSON back to 0 '
            + 'if this charger puts something else there.', 'warn');
        }
        continue;
      }

      // ── Verlaufsdatensatz der letzten beendeten Ladung ───────────────────
      if (settings.dp_charge_history > 0 && dp === settings.dp_charge_history) {
        const rec = this._parseChargeHistory(value);
        if (rec) { await this._handleChargeHistory(rec); continue; }
        if (!this._verlaufGemeldet) {
          this._verlaufGemeldet = true;
          this._appLog(`Data point ${dp} is set as the charge history, but what arrived is not `
            + `a record this driver can read: ${JSON.stringify(value).slice(0, 80)}. Expected `
            + 'an object with a total under "c", such as {"t":"…","s":"15:09","e":"17:42",'
            + '"d":9159,"c":121}. Set Charge History DP back to 0 if this charger puts '
            + 'something else there.', 'warn');
        }
        continue;
      }

      // ── Phases A / B / C ─────────────────────────────────────────────────
      const phaseSuffix = (settings.dp_phase_a > 0 && dp === settings.dp_phase_a) ? ''
        : (settings.dp_phase_b > 0 && dp === settings.dp_phase_b) ? '.b'
        : (settings.dp_phase_c > 0 && dp === settings.dp_phase_c) ? '.c'
        : null;
      if (phaseSuffix !== null) {
        const parsed = this._parsePhase(value);
        if (!parsed) {
          // Einmal je DP: das Geraet meldet mehrmals pro Sekunde, und derselbe Rat
          // hundertmal ist keiner mehr.
          if (!this._phaseHinted?.has(dp)) {
            (this._phaseHinted = this._phaseHinted || new Set()).add(dp);
            const phase = phaseSuffix === '.b' ? 'B / L2'
              : phaseSuffix === '.c' ? 'C / L3' : 'A / L1';
            // Eine blanke Zahl ist die haeufigste Ursache, und sie hat eine genaue
            // Antwort: der Wert gehoert in eines der Einzelfelder. Ein gemeldeter
            // Charger hatte alle drei Phasenfelder mit Spannungs-DPs belegt, weil die
            // gepackten Felder in der Liste zuoberst stehen und man sechs Zahlen in
            // sechs Felder der Reihe nach eintraegt.
            const zahl = typeof value === 'number';
            this._appLog(
              `DP ${dp} is set as the packed phase ${phase} DP, but it carries `
              + `${zahl ? `a plain number (${value})` : 'no readable packed data'} — that `
              + 'field expects voltage, current and power in one raw packet. If this DP '
              + `holds only one of them, clear "Phase ${phase} DP" and enter ${dp} in `
              + `"Voltage DP, phase ${phase}" or "Current DP, phase ${phase}" instead. `
              + 'The manufacturer\'s DP list under Cloud Lookup says which it is.',
              'warn');
          }
          continue;
        }
        await this._applyPhase(parsed, phaseSuffix);
        continue;
      }

      // ── Voltage / current as plain numbers, one DP each ──────────────────
      //
      // Newer chargers - a reported Feyree among them - report per-phase voltage on
      // 102/103/104 and current on 105/106/107 as ordinary numbers instead of the
      // packed phase DP above. That DP goes through _parsePhase, which expects a raw
      // buffer, so these values had nowhere to go and both capabilities stayed empty.
      //
      // Behind their own settings, all defaulting to 0: an existing device has none of
      // these set, reaches this point with no match, and carries on exactly as before.
      const einzeln = [
        ['dp_voltage_a', 'voltage', '',   'voltage_scale'],
        ['dp_voltage_b', 'voltage', '.b', 'voltage_scale'],
        ['dp_voltage_c', 'voltage', '.c', 'voltage_scale'],
        ['dp_current_a', 'current', '',   'amp_scale'],
        ['dp_current_b', 'current', '.b', 'amp_scale'],
        ['dp_current_c', 'current', '.c', 'amp_scale'],
      ].find(([key]) => settings[key] > 0 && dp === settings[key]);
      if (einzeln) {
        const [, art, suffix, faktor] = einzeln;
        const zahl = Number(value);
        if (Number.isFinite(zahl)) {
          await this._applyPhaseField(art, suffix, zahl * this._scaleOf(faktor, 1));
        }
        continue;
      }

      // ── Lifetime energy total (DP 1) ─────────────────────────────────────
      if (settings.dp_energy_total > 0 && dp === settings.dp_energy_total) {
        const kwh = Number(value) * this._scaleOf('total_energy_scale', 0.01);
        await this.setCapabilityValue('meter_power.charged', Math.round(kwh * 100) / 100).catch(() => {});
        continue;
      }

      // ── Session energy (DP 25) ───────────────────────────────────────────
      if (settings.dp_session_energy > 0 && dp === settings.dp_session_energy) {
        await this._handleSessionEnergy(Number(value) * this._scaleOf('session_energy_scale', 0.01));
        continue;
      }

      // ── Fault bitmap ─────────────────────────────────────────────────────
      if (settings.dp_fault > 0 && dp === settings.dp_fault) {
        const code    = Number(value) || 0;
        const isAlarm = code > 0;
        if (this.hasCapability('fault_code')) {
          await this.setCapabilityValue('fault_code', code).catch(() => {});
        }
        if (this.hasCapability('alarm_generic')) {
          const prevAlarm = this.getCapabilityValue('alarm_generic');
          await this.setCapabilityValue('alarm_generic', isAlarm).catch(() => {});

          if (!prevAlarm && isAlarm) {
            // Debounce reconnect artifacts before notifying.
            clearTimeout(this._faultAlarmTimer);
            this._faultAlarmConfirmed = false;
            this._faultAlarmTimer = setTimeout(() => {
              if (this.getCapabilityValue('alarm_generic') === true) {
                this._faultAlarmConfirmed = true;
                this._triggerFaultOn.trigger(this, { fault_code: code }).catch(() => {});
                this.homey.notifications.createNotification({
                  excerpt: `${this.getName()}: ${this.homey.__('notifications.faultAlarm')}`,
                }).catch(() => {});
              }
            }, 5000);
          }
          if (prevAlarm && !isAlarm) {
            clearTimeout(this._faultAlarmTimer);
            this._faultAlarmConfirmed = false;
          }
        }
        continue;
      }

      // ── Connection state (CP pilot) ──────────────────────────────────────
      if (settings.dp_connection_state > 0 && dp === settings.dp_connection_state) {
        this._lastConnState = String(value);
        if (this.hasCapability('ev_connection_state')) {
          await this.setCapabilityValue('ev_connection_state', this._lastConnState).catch(() => {});
        }
        await this._updateChargingState();
        continue;
      }

      // ── Work mode ────────────────────────────────────────────────────────
      if (settings.dp_work_mode > 0 && dp === settings.dp_work_mode) {
        const modus = String(value);
        if (this.hasCapability('ev_work_mode')) {
          await this.setCapabilityValue('ev_work_mode', modus).catch((err) => {
            this._appLog(
              `work_mode: could not set "${value}". Many chargers report modes ` +
              `they don't implement — check DP 33 (mode_set) for the real list.`,
              'warn',
            );
          });
        }
        // Der Auslöser haengt am gemeldeten Wert, nicht an der Kachel. Meldet ein
        // Ladegeraet einen Modus, den die Auswahlliste nicht kennt, scheitert das
        // Setzen der Faehigkeit gleich darueber - gewechselt hat es trotzdem, und ein
        // Flow, der darauf wartet, soll den Wechsel sehen.
        const vorher = this._prevWorkMode ?? null;
        this._prevWorkMode = modus;
        if (vorher !== null && vorher !== modus) {
          this._triggerWorkModeChanged
            .trigger(this, { mode: modus, prev_mode: vorher }).catch(() => {});
        }
        continue;
      }

      // ── Temperature ──────────────────────────────────────────────────────
      if (settings.dp_temperature > 0 && dp === settings.dp_temperature) {
        if (this.hasCapability('measure_temperature')) {
          // Vorgabe 1: unveraendert wie bisher. 435 fuer 43,5 Grad braucht 0,1.
          const grad = Number(value) * this._scaleOf('temp_scale', 1);
          await this.setCapabilityValue('measure_temperature',
            Math.round(grad * 10) / 10).catch(() => {});
        }
        continue;
      }

      // ── Delayed start (h) ────────────────────────────────────────────────
      if (settings.dp_timer_on > 0 && dp === settings.dp_timer_on) {
        if (this.hasCapability('charge_delay_hours')) {
          await this.setCapabilityValue('charge_delay_hours', Number(value)).catch(() => {});
        }
        continue;
      }

      // Live-updates DP echoes back its own value — expected, not worth logging.
      if (settings.dp_live_updates > 0 && dp === settings.dp_live_updates) continue;

      // An unmapped numeric DP that keeps climbing is almost always the energy
      // counter pointed at the wrong DP number — the usual cause of a total that
      // never moves. Say so once, with the number to enter, instead of leaving
      // the value silently discarded.
      if (typeof value === 'number' && !this._risingHinted?.has(dp)) {
        const prev = this._unmappedPrev?.[dp];
        if (typeof prev === 'number' && value > prev) {
          (this._risingHinted = this._risingHinted || new Set()).add(dp);
          this._appLog(
            `DP ${dp} is counting up (${prev} → ${value}) but is not mapped to anything. ` +
            `If the charged-energy total stays at zero, set "Session Energy DP" to ${dp} ` +
            `in the device settings — on most of these chargers the rising counter is DP 1, ` +
            `while DP 25 holds the previous session and does not move during a charge.`,
            'warn',
          );
        }
        (this._unmappedPrev = this._unmappedPrev || {})[dp] = value;
      }

      this.log(`Unknown DP ${dp}:`, value);
    }

    if (changed) {
      this._scheduleStoreSave();
      this._writeDpSnapshot();
    }
  }

  // ── Public actions ──────────────────────────────────────────────────────────

  /** Called by the "ev_reset_energy" flow action. */
  async resetEnergy() {
    // Chargers that expose a clear-energy DP get the real command; otherwise
    // only the locally accumulated total is reset.
    const dp = this.getSetting('dp_clear_energy');
    if (dp > 0) {
      await this._set(dp, true).catch((err) =>
        this._appLog(`clear-energy command failed: ${err.message}`, 'warn'));
    }
    this._energyAccum     = 0;
    this._lastSessionKwh  = null;
    this._lastSessionTime = null;
    await this.setStoreValue('energyAccum', 0).catch(() => {});
    await this.setStoreValue('lastSessionKwh', null).catch(() => {});
    if (this.getSetting('dp_energy_total') <= 0) {
      await this.setCapabilityValue('meter_power.charged', 0).catch(() => {});
    }
    this._appLog('Energy total reset', 'info');
  }

  // ── Homey lifecycle ────────────────────────────────────────────────────────

  async onSettings({ changedKeys }) {
    const connectionKeys = ['ip', 'device_id', 'local_key', 'version'];
    if (changedKeys.some((k) => connectionKeys.includes(k))) {
      await this._connect();
      return;
    }
    if (changedKeys.includes('polling_interval')) {
      this._startPolling();
    }
    if (changedKeys.includes('reconnect_interval')) this._startAutoReconnect();
    if (this._touchesOptional(changedKeys, OPTIONAL_CAPABILITIES)) {
      await this._syncOptionalCapabilities(OPTIONAL_CAPABILITIES);
      this._registerListeners(); // newly added capabilities need listeners immediately
    }
    if (changedKeys.some((k) => ['current_min', 'current_max', 'phase_count', 'nominal_voltage'].includes(k))) {
      await this._applyCurrentLimitRange();
    }
    // A corrected scale changes how existing readings should be interpreted, so
    // pull fresh values rather than leaving the old ones on screen.
    if (changedKeys.some((k) => ['current_scale', 'session_energy_scale', 'total_energy_scale',
      'voltage_scale', 'amp_scale', 'power_scale', 'temp_scale'].includes(k))) {
      this._lastDps = {}; // clear dedup so the next poll re-applies every DP
      this.pollNow().catch(() => {});
    }
    // Turning the estimate off leaves a stale wattage on the tile — clear it.
    if (changedKeys.includes('estimate_power') && this.getSetting('estimate_power') !== true) {
      if (this._hasNoPowerDp() && this.hasCapability('measure_power')) {
        await this.setCapabilityValue('measure_power', null).catch(() => {});
      }
    }
    if (changedKeys.includes('total_energy_source')) {
      // Restart integration cleanly; the accumulated total is deliberately kept.
      this._lastPowerTime      = null;
      this._prevTickPowerWatts = 0;
      this._appLog(`Energy source changed to "${this._energySource()}"`, 'info');
    }
  }
}

module.exports = EvChargerDevice;
