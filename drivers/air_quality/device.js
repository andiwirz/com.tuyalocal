'use strict';

const BaseTuyaDevice = require('../../lib/BaseTuyaDevice');

// ── Tuya air quality monitor (category hjjcy / pm25) DP map ─────────────────
//
//   DP 1    enum   air_quality_index: level_1 … level_n          (level_aqi)
//   DP 2    int    temp_current                                  (measure_temperature)
//   DP 3    int    humidity_value                                (measure_humidity)
//   DP 4    int    co2_value in ppm                              (measure_co2)
//   DP 5    int    ch2o_value, formaldehyde                       (measure_ch2o)
//   DP 7    int    pm25_value in µg/m³                           (measure_pm25)
//   DP 8    int    pm1                                            (measure_pm1)
//   DP 9    int    pm10                                           (measure_pm10)
//   DP 22   int    battery_percentage 0–100                       (measure_battery)
//   DP 23   bool   charge_state                                   (battery_charging_state)
//   DP 28   enum   alarm_volume: mute | low | middle | high       (alarm_volume)
//   DP 101  int    tvoc_value                                     (measure_tvoc)
//   DP 102  int    co_value in ppm                                (measure_co)
//   DP 103  enum   bl_level, display backlight                    (backlight_level)
//   DP 104  int    co2_alarm_value    — the device's own limit    (alarm_co2)
//   DP 106  bool   buzz, buzzer on or off                         (buzzer)
//   DP 107  int    pm03                                           (pm03_level)
//   DP 113  int    co_alarm_value     — the device's own limit    (alarm_co)
//   DP 114  int    pm25_alarm_value   — the device's own limit    (alarm_pm25)
//
// Not read: 105 sleep_timer, 108 secondcal, 109–111 and 116–118 (the three alarm
// clocks), 112 temp_unit_convert, 115 hcho_alarm_value. The clocks and the
// calibration have no Homey counterpart worth a tile, and the display's unit is
// the display's business — Homey shows what the user's Homey is set to.
//
// The three limits are the interesting part. This device carries its own alarm
// thresholds, so the driver does not have to invent any: whatever the owner set
// on the device itself is what the CO₂, CO and PM2.5 alarms compare against.

const NUMERIC_PROFILE = [
  { settingKey: 'dp_temperature', capability: 'measure_temperature', teiler: 'temp_scale'     },
  { settingKey: 'dp_humidity',    capability: 'measure_humidity',    teiler: 'humidity_scale' },
  { settingKey: 'dp_co2',         capability: 'measure_co2'    },
  { settingKey: 'dp_co',          capability: 'measure_co'     },
  { settingKey: 'dp_pm25',        capability: 'measure_pm25'   },
  { settingKey: 'dp_pm1',         capability: 'measure_pm1'    },
  { settingKey: 'dp_pm10',        capability: 'measure_pm10'   },
  { settingKey: 'dp_pm03',        capability: 'pm03_level'     },
  { settingKey: 'dp_ch2o',        capability: 'measure_ch2o',  teiler: 'ch2o_scale' },
  { settingKey: 'dp_tvoc',        capability: 'measure_tvoc',  teiler: 'tvoc_scale' },
];

// Welche Messung an welcher geraeteeigenen Schwelle haengt. Beide Seiten werden
// unskaliert verglichen, in den Einheiten des Geraets - die Schwelle ist ja in
// derselben Zahlenwelt gesetzt worden wie der Messwert.
const SCHWELLEN = [
  { grenzKey: 'dp_co2_alarm',  messKey: 'dp_co2',  capability: 'alarm_co2'  },
  { grenzKey: 'dp_co_alarm',   messKey: 'dp_co',   capability: 'alarm_co'   },
  { grenzKey: 'dp_pm25_alarm', messKey: 'dp_pm25', capability: 'alarm_pm25' },
];

// Die drei Bedienwerte. Homey erzeugt fuer von der App definierte Faehigkeiten weder
// "wurde umgeschaltet" noch eine Abfrage - beides steht darum je Eintrag dabei.
const SCHALTER = [
  {
    settingKey: 'dp_buzzer', capability: 'buzzer', art: 'bool',
    karte: 'air_quality_buzzer_changed',
  },
  {
    settingKey: 'dp_volume', capability: 'alarm_volume', art: 'enum',
    werteKey: 'volume_values', karte: 'air_quality_volume_changed', token: 'volume',
  },
  {
    settingKey: 'dp_backlight', capability: 'backlight_level', art: 'enum',
    werteKey: 'backlight_values', karte: 'air_quality_backlight_changed', token: 'level',
  },
];

const OPTIONAL_CAPABILITIES = [
  ...NUMERIC_PROFILE.map(({ settingKey, capability }) => ({ setting: settingKey, capability })),
  ...SCHALTER.map(({ settingKey, capability }) => ({ setting: settingKey, capability })),
  ...SCHWELLEN.map(({ grenzKey, capability }) => ({ setting: grenzKey, capability })),
  { setting: 'dp_aqi',        capability: 'level_aqi'              },
  { setting: 'dp_battery',    capability: 'measure_battery'        },
  { setting: 'dp_battery',    capability: 'alarm_battery'          },
  { setting: 'dp_charging',   capability: 'battery_charging_state' },
];

// Die Woerter, die Geraete fuer ihre Luftguetestufe benutzen, auf Homeys sechs
// Stufen. Nur eindeutige Woerter stehen hier: "low" und "high" waeren zweideutig,
// denn sie koennen die Belastung meinen oder die Guete, und die beiden zeigen in
// entgegengesetzte Richtungen.
const AQI_WORTE = {
  excellent: 'good',  great: 'good',      best: 'good',   good: 'good',
  fair: 'fair',       mild: 'fair',       normal: 'fair', medium: 'fair', middle: 'fair',
  moderate: 'moderate',
  poor: 'poor',       bad: 'poor',
  very_poor: 'very_poor', severe: 'very_poor', serious: 'very_poor',
  extremely_poor: 'extremely_poor', hazardous: 'extremely_poor',
};

// level_1, level_2, … sagen nicht, wie viele Stufen es gibt - und ohne diese Zahl
// ist die zweite von drei etwas anderes als die zweite von sechs. Die Zahl steht
// darum in den Einstellungen, und die Leiter dazu hier.
const AQI_LEITERN = {
  2: ['good', 'poor'],
  3: ['good', 'moderate', 'poor'],
  4: ['good', 'fair', 'moderate', 'poor'],
  5: ['good', 'fair', 'moderate', 'poor', 'very_poor'],
  6: ['good', 'fair', 'moderate', 'poor', 'very_poor', 'extremely_poor'],
};

class AirQualityDevice extends BaseTuyaDevice {
  async onInit() {
    this.log('Air quality monitor initialized:', this.getName());

    this._roh = {};

    await this._baseInit();
    await this._syncOptionalCapabilities(OPTIONAL_CAPABILITIES);
    await this._syncEnumOptions('alarm_volume',    this.getSetting('volume_values'));
    await this._syncEnumOptions('backlight_level', this.getSetting('backlight_values'));

    this._triggerDeviceConnected    = this.homey.flow.getDeviceTriggerCard('air_quality_device_connected');
    this._triggerDeviceDisconnected = this.homey.flow.getDeviceTriggerCard('air_quality_device_disconnected');
    this._triggerDpChanged          = this.homey.flow.getDeviceTriggerCard('air_quality_dp_changed');
    this._triggerLevelChanged       = this.homey.flow.getDeviceTriggerCard('air_quality_level_changed');
    this._triggerPm03RoseAbove      = this.homey.flow.getDeviceTriggerCard('air_quality_pm03_rose_above');
    // Die Schwelle steht in der Karte, nicht im Geraet: sie feuert in dem Moment, in dem
    // der Wert sie ueberschreitet, und nicht bei jedem Wert darueber.
    this._triggerPm03RoseAbove.registerRunListener(
      (args, state) => state.vorher <= args.level && state.jetzt > args.level);

    // Der Wahrheitswert reist im Zustand, die beiden Auswahlfelder als Token - so, wie
    // die jeweilige Karte im Manifest gebaut ist.
    this._registerChangeTriggers(Object.fromEntries(SCHALTER
      .filter((e) => e.art === 'bool').map((e) => [e.capability, e.karte])));
    this._triggerSchalter = Object.fromEntries(SCHALTER
      .filter((e) => e.art === 'enum')
      .map((e) => [e.capability, this.homey.flow.getDeviceTriggerCard(e.karte)]));

    for (const { settingKey, capability, art } of SCHALTER) {
      if (!this.hasCapability(capability)) continue;
      this.registerCapabilityListener(capability, async (value) => {
        const dp = this.getSetting(settingKey);
        if (!dp || dp <= 0) throw new Error(`No data point configured for ${capability}.`);
        await this._set(dp, art === 'bool' ? value === true : String(value));
      });
    }

    await this._connect();
  }

  // ── Value readers ─────────────────────────────────────────────────────────

  /**
   * Der Teiler fuer einen Messwert.
   *
   * "auto" gibt es, weil diese Geraete sich in genau dieser Frage widersprechen.
   * Die Tuya-Spezifikation fuehrt temp_current mit Bereich -400 bis 2000 und
   * humidity_value mit 0 bis 1000, also beide in Zehnteln - das gemeldete Geraet
   * schickt aber 28 und 68, und 2,8 Grad bei 6,8 % Luftfeuchte ist kein Wert, den
   * ein Zimmer je annimmt. Die Regel entscheidet darum am Wert selbst: was als
   * Ganzes keine Zimmertemperatur mehr sein kann, ist eine in Zehnteln.
   *
   * @param {string} key   Einstellungsname des Teilers.
   * @param {number} roh   Der unskalierte Wert.
   * @returns {number}
   */
  _teiler(key, roh) {
    const gesetzt = String(this.getSetting(key) ?? '1');
    if (gesetzt !== 'auto') {
      const n = Number(gesetzt);
      return Number.isFinite(n) && n !== 0 ? n : 1;
    }
    // Ueber 80 Grad oder unter -40 misst kein Raumsensor; ueber 100 % gibt es keine
    // Luftfeuchte. Beides kann nur ein Wert in Zehnteln sein.
    if (key === 'temp_scale')     return (roh > 80 || roh < -40) ? 10 : 1;
    if (key === 'humidity_scale') return roh > 100 ? 10 : 1;
    return 1;
  }

  /**
   * Die Luftguetestufe des Geraets auf Homeys Skala.
   *
   * @param {*} raw
   * @returns {string|null}  Eine der sechs Stufen, oder null wenn unklar.
   */
  _aqiStufe(raw) {
    const wort = String(raw).trim().toLowerCase();
    if (AQI_WORTE[wort]) return AQI_WORTE[wort];

    // level_2, level2 oder schlicht 2 - alle drei meinen dasselbe.
    const treffer = wort.match(/^(?:level[_-]?)?(\d+)$/);
    if (treffer) {
      const stufen = Number(this.getSetting('aqi_levels') ?? 3);
      const leiter = AQI_LEITERN[stufen] || AQI_LEITERN[3];
      const i      = Number(treffer[1]) - 1;
      if (i >= 0 && i < leiter.length) return leiter[i];
      // Eine Stufe ausserhalb der erklaerten Leiter: die oberste ist naeher an der
      // Wahrheit als gar nichts, denn die Nummern zaehlen aufwaerts in die
      // Belastung hinein.
      if (i >= leiter.length) return leiter[leiter.length - 1];
    }

    if (this._aqiGewarnt !== wort) {
      this._aqiGewarnt = wort;
      this._appLog(`Air quality level: the device reports "${raw}", which is neither one of `
        + 'the known words nor a numbered level. The tile is left alone — tell me what your '
        + 'monitor shows at that moment and it can be added.', 'warn');
    }
    return null;
  }

  /** Setzt einen Schwellenalarm neu, sobald Messwert oder Grenze sich geaendert haben. */
  async _pruefeSchwelle(eintrag) {
    const { grenzKey, messKey, capability } = eintrag;
    if (!this.hasCapability(capability)) return;
    const grenze = this._roh[grenzKey];
    const wert   = this._roh[messKey];
    if (typeof grenze !== 'number' || typeof wert !== 'number') return;
    await this.setCapabilityValue(capability, wert > grenze).catch(() => {});
  }

  // ── DPS handling ───────────────────────────────────────────────────────────

  async _handleDps(dps) {
    const settings = this.getSettings();
    let changed = false;

    for (const [dpStr, rawValue] of Object.entries(dps)) {
      const dp = parseInt(dpStr, 10);

      if (this._lastDps[dpStr] === rawValue) continue;
      this._lastDps[dpStr] = rawValue;
      changed = true;

      this._triggerDpChanged
        .trigger(this, { dp: dpStr, value: String(rawValue) })
        .catch(() => {});

      if (this._hasFreshPendingValue(dpStr, rawValue)) continue;

      // ── Luftguetestufe ───────────────────────────────────────────────────
      if (settings.dp_aqi > 0 && dp === settings.dp_aqi) {
        const stufe = this._aqiStufe(rawValue);
        if (stufe && this.hasCapability('level_aqi')) {
          const vorher = this.getCapabilityValue('level_aqi');
          await this.setCapabilityValue('level_aqi', stufe).catch(() => {});
          if (vorher !== null && vorher !== stufe) {
            this._triggerLevelChanged
              .trigger(this, { level: stufe, previous_level: vorher })
              .catch(() => {});
          }
        }
        continue;
      }

      // ── Batterie ─────────────────────────────────────────────────────────
      if (settings.dp_battery > 0 && dp === settings.dp_battery) {
        const prozent = Math.max(0, Math.min(100, Number(rawValue)));
        if (!Number.isFinite(prozent)) continue;
        if (this.hasCapability('measure_battery')) {
          await this.setCapabilityValue('measure_battery', prozent).catch(() => {});
        }
        if (this.hasCapability('alarm_battery')) {
          const grenze = Number(this.getSetting('battery_low_percent') ?? 15);
          await this.setCapabilityValue('alarm_battery', prozent <= grenze).catch(() => {});
        }
        continue;
      }

      // ── Ladezustand ──────────────────────────────────────────────────────
      if (settings.dp_charging > 0 && dp === settings.dp_charging) {
        if (this.hasCapability('battery_charging_state')) {
          // Das Geraet sagt nur "am Strom" oder "nicht am Strom". "idle" waere die
          // dritte Moeglichkeit - voll und trotzdem angesteckt -, aber das meldet es
          // nicht, und sie zu erfinden hiesse, eine Vollmeldung zu behaupten.
          const laedt = rawValue === true || rawValue === 1 || String(rawValue) === 'true';
          await this.setCapabilityValue('battery_charging_state',
            laedt ? 'charging' : 'discharging').catch(() => {});
        }
        continue;
      }

      // ── Schalter und Auswahlfelder ───────────────────────────────────────
      const schalter = SCHALTER.find((e) => settings[e.settingKey] > 0
        && dp === settings[e.settingKey]);
      if (schalter) {
        if (!this.hasCapability(schalter.capability)) continue;
        if (schalter.art === 'bool') {
          // Schreibt den Wert und meldet einen echten Wechsel an seine Karte.
          await this._applyCapability(schalter.capability, rawValue === true);
          continue;
        }
        await this._reconcileEnumToken(schalter.capability, schalter.werteKey, rawValue);
        const token  = String(rawValue);
        const vorher = this.getCapabilityValue(schalter.capability);
        await this.setCapabilityValue(schalter.capability, token).catch(() => {});
        // Der erste Wert nach dem Verbinden ist kein Wechsel, sondern der erste Blick.
        if (vorher !== null && vorher !== undefined && vorher !== token) {
          this._triggerSchalter[schalter.capability]
            ?.trigger(this, {
              [schalter.token]: token,
              [`previous_${schalter.token}`]: vorher,
            }).catch(() => {});
        }
        continue;
      }

      // ── Die geraeteeigenen Grenzwerte ────────────────────────────────────
      const grenze = SCHWELLEN.find((e) => settings[e.grenzKey] > 0
        && dp === settings[e.grenzKey]);
      if (grenze) {
        const zahl = Number(rawValue);
        if (Number.isFinite(zahl)) {
          this._roh[grenze.grenzKey] = zahl;
          await this._pruefeSchwelle(grenze);
        }
        continue;
      }

      // ── Alles Gemessene ──────────────────────────────────────────────────
      const entry = NUMERIC_PROFILE.find((e) => settings[e.settingKey] > 0
        && dp === settings[e.settingKey]);
      if (!entry) {
        this.log(`Unmapped DP ${dp}:`, rawValue);
        continue;
      }
      // Ein Wahrheitswert ist keine Messung. Number(true) ist 1, und ohne diese Sperre
      // stuende auf der Kachel 1 — als Temperatur, als ppm, als was auch immer der
      // Datenpunkt gerade traegt. Auf diesen Geraeten liegen Schalter und Messwerte
      // dicht beieinander, und eine falsch geratene Nummer soll auffallen statt eine
      // Messung vorzutaeuschen.
      if (typeof rawValue === 'boolean') {
        this._boolGewarnt = this._boolGewarnt || new Set();
        if (!this._boolGewarnt.has(entry.settingKey)) {
          this._boolGewarnt.add(entry.settingKey);
          this._appLog(`Data point ${dp} reports true/false, not a number, so it is not a `
            + `reading. ${entry.capability} left alone — correct ${entry.settingKey} in this `
            + 'device\'s advanced settings, or run Cloud Lookup, which finds the data points '
            + 'by name.', 'warn');
        }
        continue;
      }
      const roh = Number(rawValue);
      if (!Number.isFinite(roh)) continue;
      this._roh[entry.settingKey] = roh;
      if (this.hasCapability(entry.capability)) {
        const wert   = entry.teiler ? roh / this._teiler(entry.teiler, roh) : roh;
        const vorher = this.getCapabilityValue(entry.capability);
        await this.setCapabilityValue(entry.capability, wert).catch(() => {});
        // PM0.3 ist der eine Messwert, fuer den Homey keine Karte erzeugt — er braucht
        // seine eigene Schwellenmeldung, sonst laesst sich auf ihn nichts bauen.
        if (entry.capability === 'pm03_level'
            && typeof vorher === 'number' && vorher !== wert) {
          this._triggerPm03RoseAbove
            .trigger(this, { level: wert }, { vorher, jetzt: wert }).catch(() => {});
        }
      }
      // Ein neuer Messwert kann einen Schwellenalarm kippen, auch wenn die Grenze
      // selbst seit Stunden dieselbe ist.
      const dazu = SCHWELLEN.find((e) => e.messKey === entry.settingKey);
      if (dazu) await this._pruefeSchwelle(dazu);
    }

    if (changed) {
      this._scheduleStoreSave();
      this._writeDpSnapshot();
    }
  }

  // ── Actions ───────────────────────────────────────────────────────────────

  /**
   * Schreibt einen der drei Bedienwerte.
   *
   * @param {string} capability
   * @param {*}      value
   */
  async setzeSchalter(capability, value) {
    const eintrag = SCHALTER.find((e) => e.capability === capability);
    if (!eintrag) throw new Error(`Unknown control ${capability}.`);
    const dp = this.getSetting(eintrag.settingKey);
    if (!dp || dp <= 0) {
      throw new Error('This monitor has no data point configured for that control. '
        + 'Set it in the device\'s advanced settings.');
    }
    const wert = eintrag.art === 'bool' ? value === true || value === 'true' : String(value);
    await this._set(dp, wert);
    if (this.hasCapability(capability)) {
      await this.setCapabilityValue(capability, wert).catch(() => {});
    }
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
    if (changedKeys.includes('volume_values')) {
      await this._syncEnumOptions('alarm_volume', this.getSetting('volume_values'));
    }
    if (changedKeys.includes('backlight_values')) {
      await this._syncEnumOptions('backlight_level', this.getSetting('backlight_values'));
    }
    // Eine geaenderte Stufenzahl soll sich sofort zeigen, nicht erst beim naechsten
    // unbekannten Wort.
    if (changedKeys.includes('aqi_levels')) this._aqiGewarnt = null;
  }
}

module.exports = AirQualityDevice;
