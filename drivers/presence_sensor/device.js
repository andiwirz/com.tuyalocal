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
  { settingKey: 'dp_motion_hold_time',   capability: 'motion_hold_time',   type: 'nachlauf', settable: true },
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
  { settingKey: 'dp_motion_hold_time',   capability: 'motion_hold_time',   art: 'nachlauf' },
  { settingKey: 'dp_motion_enabled',     capability: 'motion_enabled',     art: 'schalter' },
];

// Die Nachlaufzeit, in der Einheit des Geraets und in der der Kachel.
//
// Tuya gibt den Bereich einer Zahl roh an und sagt daneben, wo das Komma sitzt:
// 5 bis 3600 Sekunden mit einer Dezimalstelle heisst {"min":50,"max":36000,"scale":1}.
// Wer die 36000 fuer Sekunden nimmt, baut einen Schieber bis zehn Stunden — und wer
// 300 sendet, wo das Geraet Zehntel erwartet, bekommt 30 Sekunden Nachlauf.
//
// Der Rueckfallwert muss hier der Vorgabe im Manifest gleichen: eine Einstellung,
// die es bei der Geraeteanlage noch nicht gab, liefert auf einem bestehenden Geraet
// null, nicht ihre Vorgabe. Siehe lib/BaseTuyaDevice.js.
const NACHLAUF_VORGABE = { min: 0, max: 3600, decimals: 0, step: 1 };

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
    await this._richteNachlaufEin();
    this._registerListeners();

    // ── Flow trigger cards ──────────────────────────────────────────────────
    this._triggerDeviceConnected    = this.homey.flow.getDeviceTriggerCard('presence_sensor_device_connected');
    this._triggerDeviceDisconnected = this.homey.flow.getDeviceTriggerCard('presence_sensor_device_disconnected');
    this._triggerDpChanged          = this.homey.flow.getDeviceTriggerCard('presence_sensor_dp_changed');
    this._triggerPresenceDetected   = this.homey.flow.getDeviceTriggerCard('presence_sensor_presence_detected');
    // Je Auswahl eine Karte, die den neuen Wert als Token traegt — ein Flow, der
    // auf "Empfindlichkeit geaendert" wartet, soll auch wissen, worauf.
    this._triggerAuswahl = {
      dusk_threshold:     this.homey.flow.getDeviceTriggerCard('presence_sensor_dusk_threshold_changed'),
      motion_sensitivity: this.homey.flow.getDeviceTriggerCard('presence_sensor_motion_sensitivity_changed'),
    };
    this._triggerPresenceCleared    = this.homey.flow.getDeviceTriggerCard('presence_sensor_presence_cleared');

    await this._connect();
  }

  /**
   * Was das Geraet mit seiner Nachlaufzeit meint.
   *
   * Alles eine Stelle: der rohe Bereich, der Teiler und der Bereich in Sekunden.
   * Unbrauchbare Angaben fallen auf die Vorgabe zurueck — ein max unter dem min
   * waere ein Schieber ohne Weg.
   */
  _nachlaufBereich() {
    const g = (k) => {
      const v = Number(this.getSetting(`hold_time_${k}`));
      return Number.isFinite(v) ? v : NACHLAUF_VORGABE[k];
    };
    const decimals = Math.min(3, Math.max(0, Math.round(g('decimals'))));
    const teiler   = 10 ** decimals;
    let rohMin = g('min');
    let rohMax = g('max');
    if (!(rohMax > rohMin)) { rohMin = NACHLAUF_VORGABE.min; rohMax = NACHLAUF_VORGABE.max; }
    const rohStep = Math.max(1, g('step'));
    return {
      teiler,
      rohMin,
      rohMax,
      min:  rohMin / teiler,
      max:  rohMax / teiler,
      step: rohStep / teiler,
    };
  }

  /**
   * Der Schieber bekommt den Bereich des Geraets.
   *
   * min bleibt 0, damit ein Melder, der 0 meldet, seinen Wert auch zeigen darf, und
   * weil der SDK eine erreichbare Null will. Was darunter und ueber dem Minimum des
   * Geraets liegt, ist unmoeglich — Homey rastet es auf 0, statt dem Melder eine
   * Nachlaufzeit zu schicken, die er ablehnt. Dasselbe Muster wie beim Ladestrom
   * der Wallbox.
   */
  async _richteNachlaufEin() {
    if (!this.hasCapability('motion_hold_time')) return;
    const b = this._nachlaufBereich();
    const opts = { min: 0, max: b.max, step: b.step };
    if (b.min > 0) { opts.excludeMin = 0; opts.excludeMax = b.min; }
    await this._setCapabilityOptionsIfChanged('motion_hold_time', opts).catch(() => {});
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
        else if (e.art === 'nachlauf') {
          // Zurueck in die Einheit des Geraets, und in seinen Bereich. Eine 0 bleibt
          // eine 0 — das ist der einzige Wert unter dem Minimum, den es annehmen
          // koennte, und auf der Kachel der einzige, der dort erreichbar ist.
          const b = this._nachlaufBereich();
          const r = Math.round(Number(value) * b.teiler);
          roh = r <= 0 ? 0 : Math.min(b.rohMax, Math.max(b.rohMin, r));
        } else if (e.art === 'zahl') roh = Number(value);
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

        case 'nachlauf': {
          // Der Melder zaehlt in seiner Einheit, die Kachel in Sekunden.
          const b = this._nachlaufBereich();
          await this.setCapabilityValue(entry.capability, Number(value) / b.teiler).catch(() => {});
          break;
        }

        case 'auswahl': {
          // Schickt das Geraet eine Ziffer, wo die Kachel einen Namen fuehrt, sagt
          // die Werteliste, welcher gemeint ist. Ohne Zuordnung bleibt der Wert.
          const name = rohZuId(this.getSetting(ENUM_QUELLE[entry.capability]), value);
          const vorher = this.getCapabilityValue(entry.capability);
          if (vorher !== null && vorher !== undefined && vorher !== name) {
            const token = entry.capability === 'dusk_threshold' ? 'threshold' : 'sensitivity';
            this._triggerAuswahl[entry.capability]
              .trigger(this, { [token]: name }).catch(() => {});
          }
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
    if (changedKeys.some((k) => k.startsWith('hold_time_') || k === 'dp_motion_hold_time')) {
      await this._richteNachlaufEin();
    }
    this._registerListeners();
  }
}

module.exports = PresenceSensorDevice;
