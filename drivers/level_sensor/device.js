'use strict';

const BaseTuyaDevice = require('../../lib/BaseTuyaDevice');

// Capabilities that exist only when their DP is configured. The percentage is not
// in this list: it is the reason the device exists, and it stays in the manifest.
const OPTIONAL_CAPABILITIES = [
  { setting: 'dp_depth', capability: 'measure_distance'  },
  { setting: 'dp_state', capability: 'liquid_state'      },
  // Die beiden Alarme haben zwei moegliche Quellen, und jede rechtfertigt sie: den
  // Zustands-DP des Geraets, oder eine eigene Schwelle in Homey. Die Array-Form von
  // `setting` ist genau dafuer da. Wer nur eigene Schwellen setzt, bekommt die Alarme
  // also auch ohne dp_state.
  { setting: ['dp_state', 'own_low_percent'],  capability: 'alarm_tank_empty' },
  { setting: ['dp_state', 'own_high_percent'], capability: 'alarm_tank_full'  },
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
    this._triggerRoseAbove          = this.homey.flow.getDeviceTriggerCard('level_sensor_level_rose_above');
    this._triggerFellBelow          = this.homey.flow.getDeviceTriggerCard('level_sensor_level_fell_below');
    // Die Schwelle steht in der Karte, nicht im Geraet: es feuert genau dann, wenn der
    // Fuellstand sie ueberschreitet - nicht bei jedem Wert darueber.
    this._triggerRoseAbove.registerRunListener(
      (args, state) => state.vorher <= args.level && state.jetzt > args.level);
    this._triggerFellBelow.registerRunListener(
      (args, state) => state.vorher >= args.level && state.jetzt < args.level);

    await this._connect();
  }

  /**
   * Nach dem Verbinden ausdruecklich nach den Einstell-DPs fragen.
   *
   * Ein Tuya-Geraet schickt von sich aus, was sich aendert. Die Schwellen, die
   * Einbaumasse und die beiden Alarmschalter aendern sich nie - sie sind Einstellungen
   * im Geraet -, also kommen sie nie an, und die Felder, die sie anzeigen sollen,
   * bleiben leer. In einem gemeldeten Fall waren nach vollstaendiger Neuinstallation
   * genau die zwei gefuellt, die der Nutzer kurz zuvor in der Hersteller-App verstellt
   * hatte; die uebrigen vier standen auf "—".
   *
   * Die Statusabfrage hilft nicht: sie liefert, was das Geraet zu liefern beschliesst.
   * Wonach ausdruecklich gefragt werden kann, ist der DP_REFRESH, und der nimmt eine
   * Liste von DP-Nummern entgegen.
   *
   * Etwas Abstand zum Verbindungsaufbau, damit die Anfrage nicht mit der ersten
   * Statusabfrage zusammenfaellt - manche Firmware beantwortet nur eine von beiden.
   */
  _onConnected() {
    clearTimeout(this._configRefreshTimer);
    this._configRefreshTimer = setTimeout(() => {
      const dps = this._configDps();
      if (dps.length > 0) this._conn?.refresh(dps).catch(() => {});
    }, 1500);
  }

  /**
   * Die DP-Nummern, die dieses Geraet fuer seine Einstellungen fuehrt.
   *
   * Nur die, die still sind. Fuellstand, Tiefe und Zustand kommen von selbst und
   * gehoeren nicht in eine Nachfrage, die ohnehin nicht jedes Geraet beantwortet.
   */
  async onDeleted() {
    clearTimeout(this._configRefreshTimer);
    await super.onDeleted();
  }

  /** Die eigene Schwelle in Prozent, oder 0 wenn keine gesetzt ist. */
  _ownThreshold(welche) {
    const wert = Number(this.getSetting(
      welche === 'low' ? 'own_low_percent' : 'own_high_percent'));
    return Number.isFinite(wert) && wert > 0 ? wert : 0;
  }

  /**
   * Die Alarme aus dem Fuellstand rechnen, wenn eigene Schwellen gesetzt sind.
   *
   * Gemeldeter Grund: die Schwellen im Geraet loesen dessen eigenen Alarm aus und bei
   * manchen Modellen einen lauten Summer. Sie lassen sich also nicht bloss verschieben,
   * um in Homey frueher gewarnt zu werden - dafuer braucht es eine zweite, eigene.
   *
   * Der liquid_state-Enum bleibt unberuehrt. Der meldet, was das Geraet sagt; ihn zu
   * verbiegen hiesse, dass Kachel und DP-Debug sich widersprechen. Die Alarme sind der
   * richtige Ort: sie sind Homeys Urteil, der Enum ist die Auskunft des Geraets.
   *
   * @param {number} pct Der Fuellstand in Prozent.
   */
  async _applyOwnThresholds(pct) {
    const niedrig = this._ownThreshold('low');
    const hoch    = this._ownThreshold('high');

    if (niedrig > 0 && this.hasCapability('alarm_tank_empty')) {
      await this.setCapabilityValue('alarm_tank_empty', pct <= niedrig).catch(() => {});
    }
    if (hoch > 0 && this.hasCapability('alarm_tank_full')) {
      await this.setCapabilityValue('alarm_tank_full', pct >= hoch).catch(() => {});
    }
  }

  _configDps() {
    return ['dp_max_set', 'dp_mini_set', 'dp_install_height', 'dp_depth_full',
      'dp_upper_switch', 'dp_lower_switch']
      .map((k) => Number(this.getSetting(k)) || 0)
      .filter((dp) => dp > 0);
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
      const dp = parseInt(dpStr, 10);

      // Die Anzeigefelder stehen vor der Aenderungs-Sperre, und das ist der Punkt: sie
      // spiegeln einen Zustand, sie melden kein Ereignis. Diese sechs Datenpunkte sind
      // Konfiguration im Geraet und aendern sich so gut wie nie - und _lastDps wird
      // beim Start aus dem Geraetespeicher wiederhergestellt. Hinter der Sperre waeren
      // sie nach einem Update bereits bekannt und wuerden nie geschrieben; genau das
      // hat ein Melder gesehen, fuenf Striche und einen Wert.
      const anzeige = this._displayField(settings, dp, value);
      if (anzeige && this.getSetting(anzeige.key) !== anzeige.text) {
        // Nur bei geaendertem Text: das Geraet meldet die sechs bei jedem vollen Abruf
        // mit, und jedes Mal zu schreiben waere Schreiblast ohne Gegenwert.
        await this.setSettings({ [anzeige.key]: anzeige.text }).catch(() => {});
      }

      if (this._lastDps[dpStr] === value) continue;
      this._lastDps[dpStr] = value;
      changed = true;

      this._triggerDpChanged
        .trigger(this, { dp: dpStr, value: String(value) })
        .catch(() => {});

      // ── Level percentage ──────────────────────────────────────────────────
      if (settings.dp_level_percent > 0 && dp === settings.dp_level_percent) {
        const pct    = Math.max(0, Math.min(100, Number(value)));
        const vorher = this.getCapabilityValue('liquid_level');
        await this.setCapabilityValue('liquid_level', pct).catch(() => {});

        // Die Ausloeser bekommen beide Werte und entscheiden in ihrem Run-Listener, ob
        // die Schwelle dazwischen liegt. Der erste Wert nach dem Verbinden loest nicht
        // aus: davor steht null, und das ist kein Uebergang, sondern der erste Blick.
        if (typeof vorher === 'number' && vorher !== pct) {
          const zustand = { vorher, jetzt: pct };
          this._triggerRoseAbove.trigger(this, { level: pct }, zustand).catch(() => {});
          this._triggerFellBelow.trigger(this, { level: pct }, zustand).catch(() => {});
        }

        await this._applyOwnThresholds(pct);
        continue;
      }

      // ── Depth ─────────────────────────────────────────────────────────────
      // measure_distance ist in Zentimetern deklariert; das Geraet zaehlt in ganzen
      // Einheiten, je nach Modell Millimeter oder Zentimeter - dafuer ist der Teiler da.
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
        // Eine eigene Schwelle hat Vorrang: sie ist der Grund, warum es sie gibt.
        // Wer sie setzt, will frueher gewarnt werden, als das Geraet es tut - und
        // dessen Zustand wuerde die Warnung sonst gleich wieder zuruecknehmen.
        if (this.hasCapability('alarm_tank_empty') && !(this._ownThreshold('low') > 0)) {
          await this.setCapabilityValue('alarm_tank_empty', low !== null && token === low)
            .catch(() => {});
        }
        if (this.hasCapability('alarm_tank_full') && !(this._ownThreshold('high') > 0)) {
          await this.setCapabilityValue('alarm_tank_full', high !== null && token === high)
            .catch(() => {});
        }
        continue;
      }

      // Schwellen, Einbaumasse und die beiden Alarmschalter tragen keine Capability -
      // sie sind Konfiguration im Geraet, keine Messwerte. Angezeigt werden sie
      // trotzdem, weiter oben; hier bleibt nur, sie nicht als unbekannt zu melden.
      if (!anzeige) this.log(`Unknown DP ${dp}:`, value);
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
  _displayField(settings, dp, wert) {
    const prozent = (v) => `${Number(v)} %`;
    // Immer durch 1000, nicht ueber den Teiler der Tiefe. Der gilt fuer den Messwert,
    // und der zaehlt je nach Modell in Zentimetern - ein Melder hat ihn deshalb auf 1
    // stehen, weil seine Tiefe damit richtig herauskommt. Die beiden Einbaumasse zaehlen
    // aber in Millimetern: Tuya deklariert fuer sie 100-3000, was nur als Millimeter
    // Sinn ergibt (0,1 bis 3 m fuer einen Tanksensor), und die Hersteller-App zeigt fuer
    // 1059 genau 1,059 m. Der Rohwert steht daneben, damit sich das nachpruefen laesst.
    const meter   = (v) => `${(Number(v) / 1000).toFixed(3)} m (raw ${Number(v)})`;
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
