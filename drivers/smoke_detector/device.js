'use strict';

const BaseTuyaDevice = require('../../lib/BaseTuyaDevice');

// ── Tuya smoke detector (category ywbj) DP map ──────────────────────────────
//
//   DP 1   enum   smoke_sensor_status: "alarm" | "normal"   (alarm_smoke)
//                 Some firmware sends a boolean here instead — both are read.
//   DP 2   int    smoke_sensor_value, concentration in ppm   (smoke_level)
//   DP 8   bool   self_checking — write true to start a test (action card)
//   DP 9   enum   checking_result: checking | check_success
//                                  | check_failure | others  (alarm_generic)
//   DP 14  enum   battery_state: low | middle | high         (alarm_battery)
//   DP 15  int    battery_percentage 0–100                   (measure_battery)
//   DP 16  bool   muffling — write true to silence           (action card)
//
// Which of 14 and 15 carries which is not settled: the two are swapped on some
// units, and a reported implementation had them the other way round from the
// specification. So neither handler trusts its data point — each looks at the
// value. A number is a percentage, a word is a level. That way a swapped pair
// still lands correctly, and the defaults only have to be plausible.

const DP_PROFILE = [
  { settingKey: 'dp_smoke',           capability: 'alarm_smoke',    type: 'smoke'   },
  { settingKey: 'dp_smoke_value',     capability: 'smoke_level',    type: 'level'   },
  { settingKey: 'dp_battery_percent', capability: 'measure_battery', type: 'battery' },
  { settingKey: 'dp_battery_state',   capability: 'alarm_battery',  type: 'battery' },
  { settingKey: 'dp_tamper',          capability: 'alarm_tamper',   type: 'tamper'  },
  { settingKey: 'dp_self_test',       capability: 'alarm_generic',  type: 'selftest' },
];

const OPTIONAL_CAPABILITIES = [
  { setting: 'dp_smoke_value',     capability: 'smoke_level'     },
  { setting: 'dp_battery_percent', capability: 'measure_battery' },
  { setting: 'dp_battery_state',   capability: 'alarm_battery'   },
  { setting: 'dp_tamper',          capability: 'alarm_tamper'    },
  { setting: 'dp_self_test',       capability: 'alarm_generic'   },
];

// Ergebnisse der Selbstpruefung, die kein Fehler sind. Alles andere ist einer:
// die Liste der Fehlschlaege ist je nach Firmware laenger als die der Erfolge, und
// ein unbekanntes Wort als "in Ordnung" zu lesen waere bei einem Rauchmelder die
// falsche Richtung zu irren.
const SELFTEST_OK = new Set(['check_success', 'checking', 'normal', 'success']);

class SmokeDetectorDevice extends BaseTuyaDevice {
  async onInit() {
    this.log('Device initialized:', this.getName());

    await this._baseInit();
    await this._syncOptionalCapabilities(OPTIONAL_CAPABILITIES);

    this._triggerDeviceConnected    = this.homey.flow.getDeviceTriggerCard('smoke_device_connected');
    this._triggerDeviceDisconnected = this.homey.flow.getDeviceTriggerCard('smoke_device_disconnected');
    this._triggerDpChanged          = this.homey.flow.getDeviceTriggerCard('smoke_dp_changed');
    this._triggerSelfTestFinished   = this.homey.flow.getDeviceTriggerCard('smoke_self_test_finished');
    this._triggerLevelRoseAbove     = this.homey.flow.getDeviceTriggerCard('smoke_level_rose_above');
    // Die Schwelle steht in der Karte, nicht im Geraet: es feuert in dem Moment, in dem
    // der Wert sie ueberschreitet, und nicht bei jedem Wert darueber. Dasselbe Muster
    // wie beim Fuellstandsensor.
    this._triggerLevelRoseAbove.registerRunListener(
      (args, state) => state.vorher <= args.level && state.jetzt > args.level);

    await this._connect();
  }

  // ── Value readers ─────────────────────────────────────────────────────────

  /**
   * Ist das Rauchsignal ein Alarm?
   *
   * Zwei Bauarten, und das Geraet sagt selbst, welche es ist: ein Schalter oder ein
   * benannter Zustand. Bei den benannten steht die Liste in den Einstellungen, weil
   * "alarm" zwar der Normalfall ist, aber nicht der einzige.
   *
   * @param {*} raw
   * @returns {boolean}
   */
  _istAlarm(raw) {
    if (typeof raw === 'boolean') return raw;
    if (typeof raw === 'number')  return raw > 0;
    const wort = String(raw).trim().toLowerCase();
    // Eine Zeichenkette, die nur Ziffern enthaelt, ist eine Zahl. Die einzige
    // dokumentierte Konfiguration im tuya-local-Projekt fuehrt DP 1 als integer mit
    // "1" fuer Alarm - als Wort gelesen stuende es in keiner Liste, und der Melder
    // schwiege bei Rauch. Das ist der schlimmste Fehler, den dieser Treiber haben
    // kann, also wird die Zahl vor dem Wort geprueft.
    if (/^\d+$/.test(wort)) return Number(wort) > 0;
    const liste = String(this.getSetting('smoke_alarm_values') || 'alarm')
      .split(',').map((v) => v.trim().toLowerCase()).filter(Boolean);
    if (liste.includes(wort)) return true;
    // Ein Wort, das weder als Alarm noch als Ruhe gelesen werden kann, wird einmal
    // gemeldet und als Ruhe behandelt - ein Daueralarm aus einem Tippfehler waere
    // schlimmer als eine fehlende Meldung, denn er wuerde abgeschaltet.
    if (['normal', 'nornal', 'ok', 'none', 'no_smoke'].includes(wort)) return false;
    if (!this._smokeWordWarned) {
      this._smokeWordWarned = true;
      this._appLog(
        `Smoke sensor reports "${raw}", which is neither in "Smoke alarm values" `
        + `[${liste.join(', ')}] nor a known word for "no smoke". Treated as no smoke — `
        + 'add the word to that setting if it means an alarm on your detector.', 'warn');
    }
    return false;
  }

  /**
   * Traegt dieser Wert einen Prozentsatz oder eine Stufe?
   *
   * @param {*} raw
   * @returns {{prozent: number|null, schwach: boolean|null}}
   */
  _leseBatterie(raw) {
    if (typeof raw === 'number' || (typeof raw === 'string' && /^\d+$/.test(raw.trim()))) {
      const prozent = Math.max(0, Math.min(100, Number(raw)));
      const grenze  = Number(this.getSetting('battery_low_percent') ?? 15);
      return { prozent, schwach: prozent <= grenze };
    }
    const wort = String(raw).trim().toLowerCase();
    if (wort === 'low')  return { prozent: null, schwach: true };
    if (['middle', 'high', 'normal', 'full'].includes(wort)) {
      return { prozent: null, schwach: false };
    }
    return { prozent: null, schwach: null };
  }

  // ── DPS handling ───────────────────────────────────────────────────────────

  async _handleDps(dps) {
    const settings = this.getSettings();
    let changed = false;

    for (const [dpStr, rawValue] of Object.entries(dps)) {
      const dp    = parseInt(dpStr, 10);
      const entry = DP_PROFILE.find((e) => settings[e.settingKey] > 0 && dp === settings[e.settingKey]);

      if (this._lastDps[dpStr] === rawValue) continue;
      this._lastDps[dpStr] = rawValue;
      changed = true;

      this._triggerDpChanged
        .trigger(this, { dp: dpStr, value: String(rawValue) })
        .catch(() => {});

      if (!entry) {
        this.log(`Unknown DP ${dp}:`, rawValue);
        continue;
      }

      switch (entry.type) {
        case 'smoke':
          await this.setCapabilityValue('alarm_smoke', this._istAlarm(rawValue)).catch(() => {});
          break;

        case 'level': {
          const ppm = Number(rawValue);
          if (!Number.isFinite(ppm) || !this.hasCapability('smoke_level')) break;
          const vorher = this.getCapabilityValue('smoke_level');
          await this.setCapabilityValue('smoke_level', ppm).catch(() => {});
          // Der erste Wert nach dem Verbinden loest nicht aus: davor steht null, und
          // das ist kein Uebergang, sondern der erste Blick.
          if (typeof vorher === 'number' && vorher !== ppm) {
            this._triggerLevelRoseAbove
              .trigger(this, { level: ppm }, { vorher, jetzt: ppm }).catch(() => {});
          }
          break;
        }

        case 'battery': {
          const { prozent, schwach } = this._leseBatterie(rawValue);
          if (prozent !== null && this.hasCapability('measure_battery')) {
            await this.setCapabilityValue('measure_battery', prozent).catch(() => {});
          }
          // Melden beide DPs, entscheidet der Prozentsatz - er ist die genauere
          // Angabe, und die einzige dokumentierte Konfiguration haengt beide an
          // dieselbe Groesse, den Prozentsatz als Wert und die Stufe als Anhaengsel.
          // Ohne diese Regel entschiede die Reihenfolge, in der die Datenpunkte im
          // Paket stehen, und dasselbe Paket koennte zweimal verschieden ausgehen.
          const hatProzent = prozent !== null
            || this.getCapabilityValue('measure_battery') != null;
          if (schwach !== null && this.hasCapability('alarm_battery')
              && (prozent !== null || !hatProzent)) {
            await this.setCapabilityValue('alarm_battery', schwach).catch(() => {});
          }
          break;
        }

        case 'tamper':
          if (this.hasCapability('alarm_tamper')) {
            await this.setCapabilityValue('alarm_tamper',
              this._istAlarm(rawValue)).catch(() => {});
          }
          break;

        case 'selftest': {
          // Zwei Bauarten. Manche Melder melden ein Wort ("check_success"), andere ein
          // Bitfeld, in dem 0 "kein Fehler" heisst und jedes gesetzte Bit einen. Die
          // einzige dokumentierte Konfiguration im tuya-local-Projekt legt auf DP 11
          // ein solches Bitfeld; als Wort gelesen ergaebe die 0 einen Fehleralarm auf
          // einem gesunden Geraet - genau die Umkehrung dessen, was sie bedeutet.
          const wort   = String(rawValue).trim().toLowerCase();
          const zahl   = /^\d+$/.test(wort) ? Number(wort) : null;
          const fehler = zahl !== null ? zahl !== 0 : !SELFTEST_OK.has(wort);
          if (this.hasCapability('alarm_generic')) {
            await this.setCapabilityValue('alarm_generic', fehler).catch(() => {});
          }
          // "checking" ist der Zwischenstand, kein Ergebnis - darauf einen Flow zu
          // starten hiesse, jede Pruefung zweimal zu melden.
          if (wort !== 'checking') {
            this._triggerSelfTestFinished
              .trigger(this, { result: String(rawValue), passed: !fehler })
              .catch(() => {});
          }
          break;
        }

        default:
          break;
      }
    }

    if (changed) {
      this._scheduleStoreSave();
      this._writeDpSnapshot();
    }
  }

  // ── Actions ───────────────────────────────────────────────────────────────

  /** Silences a sounding alarm, if the detector offers the data point for it. */
  async silenceAlarm() {
    const dp = this.getSetting('dp_muffling');
    if (!dp || dp <= 0) {
      throw new Error('This detector has no silence data point configured. '
        + 'Set DP Muffling in its advanced settings.');
    }
    await this._set(dp, true);
  }

  /** Starts the detector's own self-test. The result arrives on the result DP. */
  async startSelfTest() {
    const dp = this.getSetting('dp_self_test_start');
    if (!dp || dp <= 0) {
      throw new Error('This detector has no self-test data point configured. '
        + 'Set DP Self-Test Start in its advanced settings.');
    }
    await this._set(dp, true);
  }

  // ── Settings ──────────────────────────────────────────────────────────────

  async onSettings({ changedKeys }) {
    const connectionKeys = ['ip', 'device_id', 'local_key', 'version'];
    if (changedKeys.some((k) => connectionKeys.includes(k))) {
      await this._connect();
      return;
    }
    if (changedKeys.includes('polling_interval')) this._startPolling();
    if (changedKeys.includes('reconnect_interval')) this._startAutoReconnect();
    if (changedKeys.some((k) => OPTIONAL_CAPABILITIES.map((o) => o.setting).includes(k))) {
      await this._syncOptionalCapabilities(OPTIONAL_CAPABILITIES);
    }
    // Eine geaenderte Wortliste soll sich sofort zeigen, nicht erst beim naechsten
    // unbekannten Wort - sonst bleibt die Warnung stehen, obwohl sie erledigt ist.
    if (changedKeys.includes('smoke_alarm_values')) this._smokeWordWarned = false;
  }
}

module.exports = SmokeDetectorDevice;
