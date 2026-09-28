'use strict';

const BaseTuyaDevice = require('../../lib/BaseTuyaDevice');
const { rohZuId, idZuRoh } = require('../../lib/utils.js');

// ── ZY-M100-WIFI mmWave Presence Sensor DP map ──────────────────────────────
//
//   DP 1   enum   presence_state: "none" | "presence"      (alarm_motion)
//   DP 2   int    sensitivity 0–9                           (setting)
//   DP 3   int    near_detection 0–1000 cm, step 10         (setting)
//   DP 4   int    far_detection  0–1000 cm, step 10         (setting)
//   DP 6   enum   checking_result: checking | check_success | check_failure
//                                  | others | comm_fault | radar_fault (alarm_generic)
//   DP 9   int    target_dis_closest 0–1000 cm              (measure_distance)
//   DP 101 int    detection_delay (s)                        (setting)
//   DP 102 int    fading_time (s)                            (setting)
//   DP 103 str    cli diagnostic string                      (ignored)
//   DP 104 int    illuminance (lux)                          (measure_luminance)

const DP_PROFILE = [
  { settingKey: 'dp_presence',  capability: 'alarm_motion',       type: 'presence', settable: false },
  { settingKey: 'dp_alarm',     capability: 'alarm_generic',      type: 'check',    settable: false },
  { settingKey: 'dp_distance',  capability: 'measure_distance',   type: 'number',   settable: false },
  { settingKey: 'dp_luminance', capability: 'measure_luminance',  type: 'number',   settable: false },
  // Die vier Einstellbaren. Sie lesen wie alles andere und schreiben zusaetzlich
  // zurueck — siehe EINSTELLBAR und _registerListeners.
  { settingKey: 'dp_dusk_threshold',     capability: 'dusk_threshold',     type: 'auswahl',  settable: true },
  { settingKey: 'dp_motion_sensitivity', capability: 'motion_sensitivity', type: 'auswahl',  settable: true },
  { settingKey: 'dp_motion_hold_time',   capability: 'motion_hold_time',   type: 'number',   settable: true },
  { settingKey: 'dp_motion_enabled',     capability: 'motion_enabled',     type: 'schalter', settable: true },
];

// Wie verschiedene Firmware dasselbe sagt. "presence" ist die Tuya-Schreibweise,
// "pir" die eines gemeldeten Bewegungsmelders, "motion" und "occupied" kommen in
// anderen Katalogen vor. Was in keiner der beiden Mengen steht, wird als Zahl oder
// Wahrheitswert gelesen — manche Melder schicken dort schlicht true.
const ANWESEND = new Set(['presence', 'pir', 'motion', 'occupied', 'true', '1']);
const ABWESEND = new Set(['none', 'nobody', 'no_motion', 'false', '0', '']);

// Welche Auswahl-Faehigkeit ihre erlaubten Werte aus welcher Einstellung bezieht.
// Beide duerfen eine Zuordnung tragen ("5lux=1"), weil hier uebersetzt wird: beim
// Lesen zurueck auf den Namen, beim Senden auf den Wert des Geraets.
const ENUM_QUELLE = {
  dusk_threshold:     'dusk_threshold_values',
  motion_sensitivity: 'motion_sensitivity_values',
};

// Die vier Bedienelemente eines Melders, der mehr kann als melden: ab wann er bei
// Helligkeit ueberhaupt reagiert, wie empfindlich er ist, wie lange er nach der
// letzten Bewegung weiter meldet, und ob er ueberhaupt arbeitet. Alle vier sind am
// gemeldeten Geraet einstellbar gewesen, und der Treiber hatte fuer keinen etwas.
const EINSTELLBAR = [
  { settingKey: 'dp_dusk_threshold',     capability: 'dusk_threshold',     art: 'enum' },
  { settingKey: 'dp_motion_sensitivity', capability: 'motion_sensitivity', art: 'enum' },
  { settingKey: 'dp_motion_hold_time',   capability: 'motion_hold_time',   art: 'zahl' },
  { settingKey: 'dp_motion_enabled',     capability: 'motion_enabled',     art: 'schalter' },
];

const OPTIONAL_CAPABILITIES = [
  { setting: 'dp_dusk_threshold',     capability: 'dusk_threshold'     },
  { setting: 'dp_motion_sensitivity', capability: 'motion_sensitivity' },
  { setting: 'dp_motion_hold_time',   capability: 'motion_hold_time'   },
  { setting: 'dp_motion_enabled',     capability: 'motion_enabled'     },
  { setting: 'dp_alarm',     capability: 'alarm_generic'     },
  { setting: 'dp_distance',  capability: 'measure_distance'  },
  { setting: 'dp_luminance', capability: 'measure_luminance' },
];

class PresenceSensorDevice extends BaseTuyaDevice {
  async onInit() {
    this.log('Device initialized:', this.getName());

    await this._baseInit();
    await this._syncOptionalCapabilities(OPTIONAL_CAPABILITIES);
    await this._syncEnumOptions('dusk_threshold',
      this.getSetting('dusk_threshold_values'), { zuordnung: true });
    await this._syncEnumOptions('motion_sensitivity',
      this.getSetting('motion_sensitivity_values'), { zuordnung: true });
    this._registerListeners();

    // ── Flow trigger cards ──────────────────────────────────────────────────
    this._triggerDeviceConnected    = this.homey.flow.getDeviceTriggerCard('presence_sensor_device_connected');
    this._triggerDeviceDisconnected = this.homey.flow.getDeviceTriggerCard('presence_sensor_device_disconnected');
    this._triggerDpChanged          = this.homey.flow.getDeviceTriggerCard('presence_sensor_dp_changed');
    this._triggerPresenceDetected   = this.homey.flow.getDeviceTriggerCard('presence_sensor_presence_detected');
    this._triggerPresenceCleared    = this.homey.flow.getDeviceTriggerCard('presence_sensor_presence_cleared');

    await this._connect();
  }

  /**
   * Die vier Bedienelemente, die zurueckschreiben.
   *
   * Nur einmal je Faehigkeit: die Methode laeuft auch nach einer Einstellungsaenderung
   * noch einmal, weil dort Faehigkeiten dazukommen koennen, und ein zweiter Zuhoerer
   * auf derselben Kachel wuerde jeden Befehl doppelt senden.
   */
  _registerListeners() {
    this._registeredCaps = this._registeredCaps || new Set();
    for (const e of EINSTELLBAR) {
      if (!this.hasCapability(e.capability)) continue;
      if (this._registeredCaps.has(e.capability)) continue;
      this._registeredCaps.add(e.capability);
      this.registerCapabilityListener(e.capability, async (value) => {
        const dp = this.getSetting(e.settingKey);
        if (!(dp > 0)) return;
        const quelle = ENUM_QUELLE[e.capability];
        let roh = value;
        if (quelle) roh = idZuRoh(this.getSetting(quelle), value);
        else if (e.art === 'zahl') roh = Number(value);
        else if (e.art === 'schalter') roh = Boolean(value);
        await this._set(dp, roh);
      });
    }
  }

  // ── DPS handling ───────────────────────────────────────────────────────────

  async _handleDps(dps) {
    const settings = this.getSettings();
    let changed = false;

    for (const [dpStr, rawValue] of Object.entries(dps)) {
      const dp    = parseInt(dpStr, 10);
      const entry = DP_PROFILE.find((e) => settings[e.settingKey] > 0 && dp === settings[e.settingKey]);

      const value = rawValue;

      if (this._lastDps[dpStr] === value) continue;
      this._lastDps[dpStr] = value;
      changed = true;

      this._triggerDpChanged
        .trigger(this, { dp: dpStr, value: String(rawValue) })
        .catch(() => {});

      if (!entry || !this.hasCapability(entry.capability)) {
        if (!entry) this.log(`Unknown DP ${dp}:`, rawValue);
        continue;
      }

      switch (entry.type) {
        case 'presence': {
          // DP 1 enum: "presence" → true, "none" → false
          //
          // Und die anderen Schreibweisen, die dieselbe Sache meinen. Ein gemeldeter
          // Melder fuehrt sein pir_state als "pir" / "none": gegen "presence"
          // geprueft, war das immer falsch, und die Kachel blieb auf "keine
          // Bewegung" stehen, waehrend der Datenpunkt munter wechselte. Manche
          // Firmware schickt dort auch schlicht wahr oder eine 1.
          const roh = String(value).toLowerCase();
          const present = ANWESEND.has(roh)
            || (!ABWESEND.has(roh) && (value === true || Number(value) > 0));
          await this.setCapabilityValue('alarm_motion', present).catch(() => {});
          if (present) {
            this._triggerPresenceDetected.trigger(this, {}).catch(() => {});
          } else {
            this._triggerPresenceCleared.trigger(this, {}).catch(() => {});
          }
          break;
        }

        case 'check': {
          // DP 6 enum: fault states → alarm true; check_success → false
          const fault = !['check_success', 'checking'].includes(String(value).toLowerCase());
          await this.setCapabilityValue('alarm_generic', fault).catch(() => {});
          break;
        }

        case 'number':
          await this.setCapabilityValue(entry.capability, Number(value)).catch(() => {});
          break;

        case 'auswahl': {
          // Schickt das Geraet eine Ziffer, wo die Kachel einen Namen fuehrt, sagt
          // die Werteliste, welcher gemeint ist. Ohne Zuordnung bleibt der Wert.
          const name = rohZuId(this.getSetting(ENUM_QUELLE[entry.capability]), value);
          await this.setCapabilityValue(entry.capability, name).catch(() => {
            this._appLog(`${entry.capability}: the device reports "${value}", which is not in `
              + `the value list. Add it — or, if the device uses numbers, write the list as `
              + 'name=value so the picker keeps its words.', 'warn');
          });
          break;
        }

        case 'schalter':
          await this.setCapabilityValue(entry.capability, Boolean(value)).catch(() => {});
          break;

        default:
          break;
      }
    }

    if (changed) {
      this._scheduleStoreSave();
      this._writeDpSnapshot();
    }
  }

  // ── Settings ──────────────────────────────────────────────────────────────

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
    }
    if (changedKeys.some((k) => ['dusk_threshold_values', 'motion_sensitivity_values'].includes(k))) {
      await this._syncEnumOptions('dusk_threshold',
        this.getSetting('dusk_threshold_values'), { zuordnung: true });
      await this._syncEnumOptions('motion_sensitivity',
        this.getSetting('motion_sensitivity_values'), { zuordnung: true });
    }
    this._registerListeners();
  }
}

module.exports = PresenceSensorDevice;
