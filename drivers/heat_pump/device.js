'use strict';

const BaseTuyaDevice = require('../../lib/BaseTuyaDevice');
const { capitalize }  = require('../../lib/utils');

// â”€â”€ Universal pool / air-water heat pump driver â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
//
// Supports all major Tuya pool-heat-pump DP layouts found in tuya-local:
//
// Standard pool HPs (Brustec / BWT / CBC / Madimack / Mountfield / Varpoolfaye / Waterco):
//   DP 1    bool   on/off
//   DP 2    int    target_temperature  (Â°C or Â°F)
//   DP 3    int    current_temperature
//   DP 4/5  str    mode / preset
//   DP 9/13/15/21  bitfield  fault
//
// PhalÃ©n Calidi XP / Fairland InverterPlus (user device):
//   DP 1    bool   on/off
//   DP 102  int    current_temperature
//   DP 103  bool   temp unit (true=Â°C, false=Â°F)
//   DP 104  int    power_level 0â€“100 %
//   DP 105  str    mode (warm / cool / smart)
//   DP 106  int    target_temperature (12â€“45 Â°C)
//   DP 115/116 bitfield  fault
//   DP 117  bool   preset (false=sleep, true=boost)
//
// Waterco Electroheat ECO-VS (DPs in 100-range):
//   DP 101  bool   on/off
//   DP 104  int    target_temperature
//   DP 107  bitfield  fault
//   DP 109  int    power_level
//
// Apricus / Powerworld water heat pumps:
//   DP 1    bool   operation_mode (off / heat_pump)
//   DP 2    int    target_temperature
//   DP 3    int    current_temperature
//   DP 4    str    work_mode / preset
//
// Arcelik / Axen combo (DHW + space heating):
//   DP 1    bool   on/off
//   DP 103â€“106  int  temperatures (Ã—10 â†’ temp_divisor = 10)
//   DP 109  str    mode (cool/heat/auto/hot_water/â€¦)
//
// â”€â”€ DP_PROFILE â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
//
// Each entry has a `type` field used in _handleDps:
//   'switch'   â†’ onoff (bool)
//   'temp'     â†’ target_temperature (int, applies temp_divisor)
//   'temp_ro'  â†’ measure_temperature (int, applies temp_divisor, read-only)
//   'mode'     â†’ heat_pump_mode (str or combined bool+mode)
//   'preset'   â†’ heat_pump_preset (bool or str)
//   'alarm'    â†’ alarm_generic (bitfield / bool: non-zero = fault)
//   'number'   â†’ power_level (int)

const DP_PROFILE = [
  { settingKey: 'dp_onoff',        capability: 'onoff',              type: 'switch',  settable: true  },
  { settingKey: 'dp_target_temp',  capability: 'target_temperature', type: 'temp',    settable: true  },
  { settingKey: 'dp_current_temp', capability: 'measure_temperature',type: 'temp_ro', settable: false },
  { settingKey: 'dp_mode',         capability: 'heat_pump_mode',     type: 'mode',    settable: true  },
  { settingKey: 'dp_preset',       capability: 'heat_pump_preset',   type: 'preset',  settable: true  },
  { settingKey: 'dp_fault',        capability: 'alarm_generic',      type: 'alarm',   settable: false },
  { settingKey: 'dp_power_level',  capability: 'power_level',        type: 'number',  settable: false },
  { settingKey: 'dp_silent',       capability: 'heat_pump_silent',   type: 'silent',  settable: true  },
];

// Welche Einstellung die erlaubten Werte einer Auswahl fuehrt. Stimmen Liste und
// Geraet nicht ueberein, verpuffen Befehle wortlos - siehe _reconcileEnumToken.
const ENUM_VALUE_SETTINGS = {
  heat_pump_mode:   'mode_values',
  heat_pump_preset: 'preset_values',
};

const OPTIONAL_CAPABILITIES = [
  { setting: 'dp_mode',        capability: 'heat_pump_mode'  },
  { setting: 'dp_preset',      capability: 'heat_pump_preset'},
  { setting: 'dp_fault',       capability: 'alarm_generic'   },
  { setting: 'dp_power_level', capability: 'power_level'     },
  { setting: 'dp_silent',      capability: 'heat_pump_silent'},
];

class HeatPumpDevice extends BaseTuyaDevice {
  async onInit() {
    this.log('Device initialized:', this.getName());

    await this._baseInit();

    // Fault-alarm debounce state
    this._connectedAt         = null;
    this._faultAlarmTimer     = null;
    this._faultAlarmConfirmed = false;

    await this._syncOptionalCapabilities(OPTIONAL_CAPABILITIES);
    await this._syncTempRange();
    await this._syncModeOptions();
    await this._syncPresetOptions();
    this._registerOptionalListeners();

    // â”€â”€ Flow trigger cards â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    this._triggerModeChanged        = this.homey.flow.getDeviceTriggerCard('heat_pump_mode_changed');
    this._triggerSilentChanged      = this.homey.flow.getDeviceTriggerCard('heat_pump_silent_changed');
    this._triggerFault              = this.homey.flow.getDeviceTriggerCard('heat_pump_fault_triggered');
    this._triggerDeviceConnected    = this.homey.flow.getDeviceTriggerCard('heat_pump_device_connected');
    this._triggerDeviceDisconnected = this.homey.flow.getDeviceTriggerCard('heat_pump_device_disconnected');
    this._triggerDpChanged          = this.homey.flow.getDeviceTriggerCard('heat_pump_dp_changed');

    // â”€â”€ Capability listeners (always-present capabilities) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    this.registerCapabilityListener('onoff', async (value) => {
      const dp = this.getSetting('dp_onoff');
      if (!dp || dp === 0) throw new Error('On/Off DP not configured');
      await this._set(dp, value);
    });

    this.registerCapabilityListener('target_temperature', async (value) => {
      const dp  = this.getSetting('dp_target_temp');
      const div = this.getSetting('temp_divisor') || 1;
      if (!dp || dp === 0) throw new Error('Target temperature DP not configured');
      await this._set(dp, Math.round(value * div));
    });

    await this._connect();
  }

  // â”€â”€ Hook overrides â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  /** Reset fault-debounce state on every (re)connect. */
  _onConnected() {
    this._connectedAt         = Date.now();
    clearTimeout(this._faultAlarmTimer);
    this._faultAlarmTimer     = null;
    this._faultAlarmConfirmed = false;
  }

  async _onDeleted() {
    clearTimeout(this._faultAlarmTimer);
  }

  // â”€â”€ Optional capability listeners â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  //
  // Called from onInit (after _syncOptionalCapabilities) AND from onSettings
  // whenever dp_mode / dp_preset changes.  Homey SDK replaces the listener if
  // registerCapabilityListener is called again for the same capability, so
  // re-calling this is always safe.

  _registerOptionalListeners() {
    if (this.hasCapability('heat_pump_mode')) {
      this.registerCapabilityListener('heat_pump_mode', async (value) => {
        const dp = this.getSetting('dp_mode');
        if (!dp || dp === 0) throw new Error('Mode DP not configured');
        await this._set(dp, value);
      });
    }
    if (this.hasCapability('heat_pump_silent')) {
      this.registerCapabilityListener('heat_pump_silent', async (value) => {
        const dp = this.getSetting('dp_silent');
        if (!dp || dp === 0) throw new Error('Silent Mode DP not configured');
        await this._set(dp, this._silentToRaw(value));
      });
    }
    if (this.hasCapability('heat_pump_preset')) {
      this.registerCapabilityListener('heat_pump_preset', async (value) => {
        const dp  = this.getSetting('dp_preset');
        if (!dp || dp === 0) throw new Error('Preset DP not configured');
        const raw = this._lastDps[String(dp)];
        if (typeof raw === 'boolean') {
          // Bool preset: false = first value (e.g. sleep), true = second value (e.g. boost)
          const vals = (this.getSetting('preset_values') || 'sleep,comfort,boost')
            .split(',').map((s) => s.trim()).filter(Boolean);
          await this._set(dp, value === (vals[1] ?? 'boost'));
        } else {
          await this._set(dp, value);
        }
      });
    }
  }

  // â”€â”€ DPS handling â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  async _handleDps(dps) {
    const settings = this.getSettings();
    let changed = false;

    for (const [dpStr, rawValue] of Object.entries(dps)) {
      const dp    = parseInt(dpStr, 10);
      const entry = DP_PROFILE.find((e) => settings[e.settingKey] > 0 && dp === settings[e.settingKey]);

      // Normalize mode/preset strings to lowercase before the dedup filter so that
      // "Cool" and "cool" are treated as the same value — prevents the device sending
      // mixed-case strings from getting stuck in _lastDps and never re-applied.
      const value = (entry?.type === 'mode' || entry?.type === 'preset') && typeof rawValue === 'string'
        ? rawValue.toLowerCase()
        : rawValue;

      if (this._lastDps[dpStr] === value) continue;
      this._lastDps[dpStr] = value;
      changed = true;

      this._triggerDpChanged
        .trigger(this, { dp: dpStr, value: String(rawValue) })
        .catch(() => {})

      if (!entry) {
        this.log(`Unknown DP ${dp}:`, rawValue);
        continue;
      }

      if (!this.hasCapability(entry.capability)) continue;

      // Meldet das Geraet ein Token, das nicht in der Begleitliste steht, ist die Liste
      // falsch - und Befehle mit einem Wert daraus verpuffen kommentarlos. Ein
      // gemeldeter Fall hatte mode_values auf "heat,cool,auto", waehrend das Geraet
      // "warm" meldete und laut Herstellerangabe nur smart/warm/cool kennt: die
      // Modusauswahl in Homey bot drei Werte an, die keiner war. Siehe
      // _reconcileEnumToken.
      const listeZu = ENUM_VALUE_SETTINGS[entry.capability];
      if (listeZu && typeof value === 'string') {
        await this._reconcileEnumToken(entry.capability, listeZu, value);
      }

      const div = settings.temp_divisor || 1;
      // current_temp_divisor overrides div for measured temp only (0 = use div)
      const divCurrent = settings.current_temp_divisor || div;

      switch (entry.type) {
        // â”€â”€ On / Off â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        // â”€â”€ Fluestermodus â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        case 'silent': {
          const leise = this._rawToSilent(value);
          const vorher = this.getCapabilityValue('heat_pump_silent');
          await this.setCapabilityValue('heat_pump_silent', leise).catch(() => {});
          // Der erste Wert nach dem Verbinden loest nicht aus: davor steht null, und
          // das ist kein Wechsel, sondern der erste Blick auf einen Zustand, den das
          // Geraet die ganze Zeit schon hatte.
          if (vorher !== null && vorher !== undefined && vorher !== leise) {
            this._triggerSilentChanged.trigger(this, { silent: leise }).catch(() => {});
          }
          break;
        }

        case 'switch': {
          await this.setCapabilityValue('onoff', Boolean(value)).catch(() => {});
          break;
        }

        // â”€â”€ Target temperature â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        case 'temp': {
          await this.setCapabilityValue('target_temperature', Number(value) / div).catch(() => {});
          // A temperature push without a simultaneous mode DP update indicates the
          // mode was changed via cloud (SmartLife). Refresh to pick up the current mode.
          setTimeout(() => { this.refreshDps().catch(() => {}); }, 1500);
          break;
        }

        // â”€â”€ Current temperature (read-only) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        case 'temp_ro': {
          await this.setCapabilityValue('measure_temperature', Number(value) / divCurrent).catch(() => {});
          break;
        }

        // â”€â”€ Operating mode â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        case 'mode': {
          const prev = this.getCapabilityValue('heat_pump_mode');
          const mode = value; // already lowercased at loop entry
          await this.setCapabilityValue('heat_pump_mode', mode).catch(() => {});
          if (prev !== mode) {
            this._triggerModeChanged
              .trigger(this, { mode, prev_mode: prev ?? mode })
              .catch(() => {});
            // Each mode stores its own target temperature. After a mode change the
            // device silently switches to the stored temperature for that mode without
            // pushing the new value. A short-delay refresh fetches the updated temp.
            setTimeout(() => { this.refreshDps().catch(() => {}); }, 1500);
          }
          break;
        }

        // â”€â”€ Preset (bool or string) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        case 'preset': {
          const presetVals = (settings.preset_values || 'sleep,comfort,boost')
            .split(',').map((s) => s.trim()).filter(Boolean);
          let preset;
          if (typeof value === 'boolean') {
            preset = value ? (presetVals[1] ?? 'boost') : (presetVals[0] ?? 'sleep');
          } else {
            preset = String(value).toLowerCase();
          }
          await this.setCapabilityValue('heat_pump_preset', preset).catch(() => {});
          break;
        }

        // â”€â”€ Fault alarm (bitfield or bool) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        // non-zero number = fault active; bool true = fault; string â‰  eorr0/no = fault
        //
        // Debounce: heat-pump firmware (like AC / Heater) can send a transient fault=true
        // immediately after reconnect that self-corrects within seconds.  Suppress the
        // notification until the alarm has persisted for the full debounce window.
        case 'alarm': {
          // Recorded straight away, unlike the notification below: knowing which
          // fault the register named is useful even while the debounce decides
          // whether it is worth telling the user about.
          this._recordFault(value);
          let isAlarm;
          if (typeof value === 'boolean') {
            isAlarm = value;
          } else if (typeof value === 'number') {
            isAlarm = value !== 0;
          } else {
            const v = String(value).toLowerCase();
            isAlarm = v !== 'eorr0' && v !== 'no' && v !== '0' && v !== 'false';
          }

          const prevAlarm = this.getCapabilityValue('alarm_generic');
          await this.setCapabilityValue('alarm_generic', isAlarm).catch(() => {});

          if (!prevAlarm && isAlarm) {
            // Grace window: extend debounce if we just reconnected.
            const GRACE_MS   = 30_000; // 30 s post-connect grace period
            const elapsed    = this._connectedAt ? Date.now() - this._connectedAt : GRACE_MS;
            const debounceMs = elapsed < GRACE_MS ? GRACE_MS - elapsed + 5_000 : 5_000;
            clearTimeout(this._faultAlarmTimer);
            this._faultAlarmConfirmed = false;
            this._faultAlarmTimer = setTimeout(() => {
              if (this.getCapabilityValue('alarm_generic') === true) {
                this._faultAlarmConfirmed = true;
                this._triggerFault.trigger(this, { fault_code: String(value) }).catch(() => {});
                this.homey.notifications.createNotification({
                  excerpt: `${this.getName()}: ${this.homey.__('notifications.faultAlarm')}`,
                }).catch(() => {});
              }
            }, debounceMs);
          }
          if (prevAlarm && !isAlarm) {
            clearTimeout(this._faultAlarmTimer);
            this._faultAlarmConfirmed = false;
          }
          break;
        }

        // â”€â”€ Power level 0â€“100 % â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        case 'number': {
          await this.setCapabilityValue('power_level', Number(value)).catch(() => {});
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

  // â”€â”€ Settings â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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
    if (changedKeys.some((k) => OPTIONAL_CAPABILITIES.map((o) => o.setting).includes(k))) {
      await this._syncOptionalCapabilities(OPTIONAL_CAPABILITIES);
      // Re-register listeners for any newly added optional capabilities.
      this._registerOptionalListeners();
    }
    if (changedKeys.some((k) => ['temp_min', 'temp_max', 'temp_step'].includes(k))) {
      await this._syncTempRange();
    }
    // Rebuild mode picker when either the DP assignment or the value list changes.
    if (changedKeys.includes('mode_values') || changedKeys.includes('dp_mode')) {
      await this._syncModeOptions();
    }
    // Rebuild preset picker when either the DP assignment or the value list changes.
    if (changedKeys.includes('preset_values') || changedKeys.includes('dp_preset')) {
      await this._syncPresetOptions();
    }
  }

  /**
   * Welcher Rohwert den leisen Modus bedeutet.
   *
   * Der Tuya-Code heisst "SilentMode", was fuer true = leise spraeche. Auf der
   * gemeldeten Waermepumpe ist es umgekehrt - true ist Smart, false ist Silence -, und
   * das ist gemessen, nicht vermutet. Beides fest zu verdrahten waere fuer die jeweils
   * andere Bauart verkehrt, also entscheidet eine Einstellung. Die Faehigkeit heisst
   * immer "Fluestermodus" und ist an, wenn leise gefahren wird.
   */
  _silentTrueIsQuiet() {
    return this.getSetting('silent_true_means') === 'silent';
  }

  /**
   * Die beiden Namen, falls das Geraet den Fluestermodus benennt statt ihn zu schalten.
   *
   * @returns {{normal: string, leise: string}|null}
   */
  _silentTokens() {
    const teile = String(this.getSetting('silent_values') || '')
      .split(',').map((v) => v.trim()).filter(Boolean);
    return teile.length >= 2 ? { normal: teile[0], leise: teile[1] } : null;
  }

  /**
   * Rohwert -> "leise ist an".
   *
   * Zwei Bauarten fuer dieselbe Funktion, und das Geraet sagt selbst, welche es ist:
   *
   *   DP 117 boolesch      true = Smart, false = Silence   (gemeldete Fairland)
   *   DP 102 Zeichenkette  "smart" / "silence"             (gemeldete Fairland PSL)
   *
   * Unterschieden wird am Wert, nicht an einer Einstellung - so wie es der
   * Voreinstellungs-Zweig in diesem Treiber schon haelt. Nur die beiden Namen muessen
   * hinterlegt sein, weil sie zum Senden gebraucht werden.
   */
  _rawToSilent(raw) {
    if (typeof raw === 'string') {
      const t = this._silentTokens();
      if (!t) return false;
      const wert = raw.trim().toLowerCase();
      if (wert === t.leise.toLowerCase())  return true;
      if (wert === t.normal.toLowerCase()) return false;
      // Weder das eine noch das andere: die Liste passt nicht zum Geraet, und ein
      // Befehl daraus wuerde wortlos verworfen. Einmal sagen, nicht bei jedem Paket.
      if (!this._silentTokenWarned) {
        this._silentTokenWarned = true;
        this._appLog(`Silent mode: the device reports "${raw}", but "Silent mode values" `
          + `is [${t.normal}, ${t.leise}]. Correct that setting — a command with a value `
          + 'the device does not know is discarded without an error.', 'warn');
      }
      return false;
    }
    return this._silentTrueIsQuiet() ? Boolean(raw) : !raw;
  }

  /**
   * "leise ist an" -> Rohwert.
   *
   * Welche Bauart, entscheidet der zuletzt gesehene Wert desselben DP - dieselbe Probe
   * wie beim Voreinstellungs-DP weiter oben. Vor dem ersten empfangenen Wert bleibt es
   * beim Schalter, denn das ist die haeufigere Bauart.
   */
  _silentToRaw(leise) {
    const dp = this.getSetting('dp_silent');
    const zuletzt = dp ? this._lastDps[String(dp)] : undefined;
    if (typeof zuletzt === 'string') {
      const t = this._silentTokens();
      if (t) return leise ? t.leise : t.normal;
    }
    return this._silentTrueIsQuiet() ? Boolean(leise) : !leise;
  }

  // â”€â”€ Sync helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  /**
   * Update target_temperature slider range from temp_min / temp_max / temp_step settings.
   */
  async _syncTempRange() {
    const min  = this.getSetting('temp_min')  ?? 12;
    const max  = this.getSetting('temp_max')  ?? 45;
    const step = this.getSetting('temp_step') ?? 1;
    try {
      const changed = await this._setCapabilityOptionsIfChanged('target_temperature', { min, max, step });
      if (changed) this.log(`target_temperature range â†’ ${min}â€“${max} step ${step}`);
    } catch (err) {
      this.log('setCapabilityOptions(target_temperature) failed:', err.message);
    }
  }

  /**
   * Rebuild heat_pump_mode picker from the mode_values setting string.
   * Called at init and when mode_values or dp_mode changes.
   */
  async _syncModeOptions() {
    if (!this.hasCapability('heat_pump_mode')) return;
    const values = (this.getSetting('mode_values') || 'heat,cool,auto')
      .split(',').map((s) => s.trim()).filter(Boolean)
      .map((v) => ({ id: v, title: { en: capitalize(v), de: capitalize(v) } }));
    try {
      const changedMode = await this._setCapabilityOptionsIfChanged('heat_pump_mode', { values });
      if (changedMode) this.log(`heat_pump_mode picker â†’ ${values.map((v) => v.id).join(', ')}`);
    } catch (err) {
      this.log('setCapabilityOptions(heat_pump_mode) failed:', err.message);
    }
  }

  /**
   * Rebuild heat_pump_preset picker from the preset_values setting string.
   * Called at init and when preset_values or dp_preset changes.
   */
  async _syncPresetOptions() {
    if (!this.hasCapability('heat_pump_preset')) return;
    const values = (this.getSetting('preset_values') || 'sleep,comfort,boost')
      .split(',').map((s) => s.trim()).filter(Boolean)
      .map((v) => ({ id: v, title: { en: capitalize(v), de: capitalize(v) } }));
    try {
      const changedPreset = await this._setCapabilityOptionsIfChanged('heat_pump_preset', { values });
      if (changedPreset) this.log(`heat_pump_preset picker â†’ ${values.map((v) => v.id).join(', ')}`);
    } catch (err) {
      this.log('setCapabilityOptions(heat_pump_preset) failed:', err.message);
    }
  }
}

module.exports = HeatPumpDevice;
