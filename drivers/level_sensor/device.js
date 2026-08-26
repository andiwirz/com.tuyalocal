'use strict';

const BaseTuyaDevice = require('../../lib/BaseTuyaDevice');

// Capabilities that exist only when their DP is configured. The percentage is not
// in this list: it is the reason the device exists, and it stays in the manifest.
const OPTIONAL_CAPABILITIES = [
  { setting: 'dp_depth', capability: 'measure_distance'  },
  { setting: 'dp_state', capability: 'liquid_state'      },
  { setting: 'dp_state', capability: 'alarm_tank_empty'  },
  { setting: 'dp_state', capability: 'alarm_tank_full'   },
];

class LevelSensorDevice extends BaseTuyaDevice {
  async onInit() {
    this.log('Level sensor initialized:', this.getName());

    await this._baseInit();
    await this._migrateCapabilities([]);
    await this._syncOptionalCapabilities(OPTIONAL_CAPABILITIES);
    await this._syncEnumOptions('liquid_state', this.getSetting('state_values'));

    this._triggerDeviceConnected    = this.homey.flow.getDeviceTriggerCard('level_sensor_device_connected');
    this._triggerDeviceDisconnected = this.homey.flow.getDeviceTriggerCard('level_sensor_device_disconnected');
    this._triggerDpChanged          = this.homey.flow.getDeviceTriggerCard('level_sensor_dp_changed');
    this._triggerStateChanged       = this.homey.flow.getDeviceTriggerCard('level_sensor_state_changed');

    await this._connect();
  }

  /**
   * The two alarm tokens, taken from the declared list rather than written in.
   *
   * Which token means "too low" differs between models, and the list itself comes
   * from the manufacturer's specification via Cloud Lookup. Matching on "lower"
   * and "upper" as substrings covers the reported device (lower_alarm /
   * upper_alarm) and the low/high spelling other firmware uses, without turning
   * every unrecognised token into an alarm.
   */
  _alarmTokens() {
    const list = (this.getSetting('state_values') || 'normal,lower_alarm,upper_alarm')
      .split(',').map((v) => v.trim()).filter(Boolean);
    const find = (...needles) => list.find((v) => {
      const t = v.toLowerCase();
      return needles.some((n) => t.includes(n)) && !t.includes('normal');
    }) || null;
    return { low: find('lower', 'low', 'min'), high: find('upper', 'high', 'max', 'full') };
  }

  /** Raw length values are converted with this divisor — see the setting's hint. */
  _depthDivisor() {
    const d = parseInt(this.getSetting('depth_divisor'), 10);
    return Number.isFinite(d) && d > 0 ? d : 1000;
  }

  // ── Public, called by the flow actions in driver.js ─────────────────────────

  /**
   * Writes one of the two percentage thresholds.
   *
   * Throws rather than returning quietly when the DP is not configured: a flow
   * that reports success while changing nothing is the worst of both worlds, and
   * these two DPs are frequently absent from a device's local reports, so the
   * user has no other way of noticing.
   */
  async setThreshold(settingKey, percent) {
    const dp = this.getSetting(settingKey);
    if (!(dp > 0)) {
      throw new Error(this.homey.__('errors.dpNotConfigured', { setting: settingKey }));
    }
    const value = Math.max(0, Math.min(100, Math.round(Number(percent))));
    await this._set(dp, value);
    return true;
  }

  /** Enables or disables one of the two level alarms on the device itself. */
  async setAlarmEnabled(settingKey, enabled) {
    const dp = this.getSetting(settingKey);
    if (!(dp > 0)) {
      throw new Error(this.homey.__('errors.dpNotConfigured', { setting: settingKey }));
    }
    await this._set(dp, Boolean(enabled));
    return true;
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

      // ── Level percentage ──────────────────────────────────────────────────
      if (settings.dp_level_percent > 0 && dp === settings.dp_level_percent) {
        const pct = Math.max(0, Math.min(100, Number(value)));
        await this.setCapabilityValue('liquid_level', pct).catch(() => {});
        continue;
      }

      // ── Depth ─────────────────────────────────────────────────────────────
      // measure_distance is metres; the device counts in whole units of
      // millimetres or centimetres depending on the model, which is what the
      // divisor setting is for.
      if (settings.dp_depth > 0 && dp === settings.dp_depth) {
        if (this.hasCapability('measure_distance')) {
          await this.setCapabilityValue('measure_distance', Number(value) / this._depthDivisor())
            .catch(() => {});
        }
        continue;
      }

      // ── Level state, and the two alarms derived from it ───────────────────
      if (settings.dp_state > 0 && dp === settings.dp_state) {
        const token = String(value);
        const { low, high } = this._alarmTokens();

        if (this.hasCapability('liquid_state')) {
          const prev = this.getCapabilityValue('liquid_state');
          await this.setCapabilityValue('liquid_state', token).catch(() => {});
          if (prev !== null && prev !== token) {
            this._triggerStateChanged
              .trigger(this, { state: token, previous_state: prev })
              .catch(() => {});
          }
        }
        if (this.hasCapability('alarm_tank_empty')) {
          await this.setCapabilityValue('alarm_tank_empty', low !== null && token === low)
            .catch(() => {});
        }
        if (this.hasCapability('alarm_tank_full')) {
          await this.setCapabilityValue('alarm_tank_full', high !== null && token === high)
            .catch(() => {});
        }
        continue;
      }

      // Thresholds, installation height and the two alarm switches carry no capability:
      // they are configuration inside the device, not readings. They are shown in the
      // settings all the same, because being able to say which data point holds the
      // high threshold without being able to see what it holds is half an answer — and
      // that is exactly how one reporter came to read the data point number as the
      // threshold itself.
      const anzeige = this._displayField(settings, dp);
      if (anzeige) {
        // Nur bei echter Aenderung schreiben. Das Geraet meldet diese sechs bei jedem
        // vollen Abruf mit, und eine Einstellung bei jedem Durchlauf neu zu schreiben
        // waere Schreiblast ohne Gegenwert.
        if (this.getSetting(anzeige.key) !== anzeige.text) {
          await this.setSettings({ [anzeige.key]: anzeige.text }).catch(() => {});
        }
        continue;
      }
      this.log(`Unknown DP ${dp}:`, value);
    }

    if (changed) {
      this._scheduleStoreSave();
      this._writeDpSnapshot();
    }
  }

  /**
   * Welches Anzeigefeld gehoert zu diesem Datenpunkt, und wie liest sich sein Wert?
   *
   * Die beiden Schwellen sind Prozent des vollen Tanks. Einbauhoehe und Tiefe bei 100 %
   * kommen in denselben ganzen Einheiten wie die Tiefe - Hersteller deklarieren die
   * Einheit als "m", zaehlen aber in Millimetern, deshalb derselbe Teiler wie dort.
   * Die beiden Schalter sind an oder aus.
   *
   * @returns {{key: string, text: string}|null}
   */
  _displayField(settings, dp) {
    const wert = this._lastDps[String(dp)];
    const prozent = (v) => `${Number(v)} %`;
    // Mit Rohwert, und das ist kein Beiwerk. Der Teiler ist eine Einstellung, und auf
    // mindestens einem gemeldeten Geraet zaehlen Tiefe und Einbaumasse nicht in
    // derselben Einheit - 1059 sind dort 1,059 m, waehrend die Tiefe in Zentimetern
    // kommt. Welcher Teiler stimmt, entscheidet sich am Geraet; die Rohzahl daneben
    // laesst sich mit der Hersteller-App vergleichen, die gerechnete allein nicht.
    const meter   = (v) => `${(Number(v) / this._depthDivisor()).toFixed(3)} m (raw ${Number(v)})`;
    // Ausgeschriebene Schluessel, nicht zusammengesetzte: eine Pruefung, die die
    // verwendeten Schluessel gegen die Sprachdateien haelt, findet nur, was dasteht.
    const schalter = (v) => (v ? this.homey.__('settings.on')  || 'on'
                               : this.homey.__('settings.off') || 'off');
    const tabelle = [
      ['dp_max_set',        'val_max_set',        prozent],
      ['dp_mini_set',       'val_mini_set',       prozent],
      ['dp_install_height', 'val_install_height', meter],
      ['dp_depth_full',     'val_depth_full',     meter],
      ['dp_upper_switch',   'val_upper_switch',   schalter],
      ['dp_lower_switch',   'val_lower_switch',   schalter],
    ];
    for (const [dpKey, feld, formatiere] of tabelle) {
      if (settings[dpKey] > 0 && dp === settings[dpKey]) {
        return { key: feld, text: formatiere(wert) };
      }
    }
    return null;
  }

  // ── Homey lifecycle ────────────────────────────────────────────────────────

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
    if (changedKeys.includes('state_values')) {
      await this._syncEnumOptions('liquid_state', this.getSetting('state_values'));
    }
  }
}

module.exports = LevelSensorDevice;
