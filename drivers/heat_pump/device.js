'use strict';

const BaseTuyaDevice = require('../../lib/BaseTuyaDevice');
const { capitalize }  = require('../../lib/utils');

// ── Universal pool / air-water heat pump driver ───────────────────────────────
//
// Supports all major Tuya pool-heat-pump DP layouts found in tuya-local:
//
// Standard pool HPs (Brustec / BWT / CBC / Madimack / Mountfield / Varpoolfaye / Waterco):
//   DP 1    bool   on/off
//   DP 2    int    target_temperature  (°C or °F)
//   DP 3    int    current_temperature
//   DP 4/5  str    mode / preset
//   DP 9/13/15/21  bitfield  fault
//
// Phalén Calidi XP / Fairland InverterPlus (user device):
//   DP 1    bool   on/off
//   DP 102  int    current_temperature
//   DP 103  bool   temp unit (true=°C, false=°F)
//   DP 104  int    power_level 0–100 %
//   DP 105  str    mode (warm / cool / smart)
//   DP 106  int    target_temperature (12–45 °C)
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
//   DP 103–106  int  temperatures (×10 → temp_divisor = 10)
//   DP 109  str    mode (cool/heat/auto/hot_water/…)
//
// ── DP_PROFILE ────────────────────────────────────────────────────────────────
//
// Each entry has a `type` field used in _handleDps:
//   'switch'   → onoff (bool)
//   'temp'     → target_temperature (int, applies temp_divisor)
//   'temp_ro'  → measure_temperature (int, applies temp_divisor, read-only)
//   'mode'     → heat_pump_mode (str or combined bool+mode)
//   'preset'   → heat_pump_preset (bool or str)
//   'alarm'    → alarm_generic (bitfield / bool: non-zero = fault)
//   'number'   → power_level (int)

const DP_PROFILE = [
  { settingKey: 'dp_onoff',        capability: 'onoff',              type: 'switch',  settable: true  },
  { settingKey: 'dp_target_temp',  capability: 'target_temperature', type: 'temp',    settable: true  },
  { settingKey: 'dp_current_temp', capability: 'measure_temperature',type: 'temp_ro', settable: false },
  { settingKey: 'dp_mode',         capability: 'heat_pump_mode',     type: 'mode',    settable: true  },
  { settingKey: 'dp_preset',       capability: 'heat_pump_preset',   type: 'preset',  settable: true  },
  { settingKey: 'dp_fault',        capability: 'alarm_generic',      type: 'alarm',   settable: false },
  { settingKey: 'dp_power_level',  capability: 'power_level',        type: 'number',  settable: false },
];

const OPTIONAL_CAPABILITIES = [
  { setting: 'dp_mode',        capability: 'heat_pump_mode'  },
  { setting: 'dp_preset',      capability: 'heat_pump_preset'},
  { setting: 'dp_fault',       capability: 'alarm_generic'   },
  { setting: 'dp_power_level', capability: 'power_level'     },
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

    // ── Flow trigger cards ───────────────────────────────────────────────────
    this._triggerModeChanged        = this.homey.flow.getDeviceTriggerCard('heat_pump_mode_changed');
    this._triggerFault              = this.homey.flow.getDeviceTriggerCard('heat_pump_fault_triggered');
    this._triggerDeviceConnected    = this.homey.flow.getDeviceTriggerCard('heat_pump_device_connected');
    this._triggerDeviceDisconnected = this.homey.flow.getDeviceTriggerCard('heat_pump_device_disconnected');
    this._triggerDpChanged          = this.homey.flow.getDeviceTriggerCard('heat_pump_dp_changed');

    // ── Capability listeners (always-present capabilities) ───────────────────
    this.registerCapabilityListener('onoff', async (value) => {
      const dp = this.getSetting('dp_onoff');
      if (!dp || dp === 0) throw new Error('On/Off DP not configured');
      await this._conn?.set(dp, value);
    });

    this.registerCapabilityListener('target_temperature', async (value) => {
      const dp  = this.getSetting('dp_target_temp');
      const div = this.getSetting('temp_divisor') || 1;
      if (!dp || dp === 0) throw new Error('Target temperature DP not configured');
      await this._conn?.set(dp, Math.round(value * div));
    });

    await this._connect();
  }

  // ── Hook overrides ────────────────────────────────────────────────────────────

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

  // ── Optional capability listeners ─────────────────────────────────────────────
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
        await this._conn?.set(dp, value);
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
          await this._conn?.set(dp, value === (vals[1] ?? 'boost'));
        } else {
          await this._conn?.set(dp, value);
        }
      });
    }
  }

  // ── DPS handling ─────────────────────────────────────────────────────────────

  async _handleDps(dps) {
    const settings = this.getSettings();
    let changed = false;

    for (const [dpStr, value] of Object.entries(dps)) {
      if (this._lastDps[dpStr] === value) continue;
      this._lastDps[dpStr] = value;
      changed = true;

      const dp = parseInt(dpStr, 10);

      this._triggerDpChanged
        .trigger(this, { dp: dpStr, value: String(value) })
        .catch(() => {});

      const entry = DP_PROFILE.find((e) => {
        const dpNum = settings[e.settingKey];
        return dpNum > 0 && dp === dpNum;
      });

      if (!entry) {
        this.log(`Unknown DP ${dp}:`, value);
        continue;
      }

      if (!this.hasCapability(entry.capability)) continue;

      const div = settings.temp_divisor || 1;

      switch (entry.type) {
        // ── On / Off ─────────────────────────────────────────────────────────
        case 'switch': {
          await this.setCapabilityValue('onoff', Boolean(value)).catch(() => {});
          break;
        }

        // ── Target temperature ────────────────────────────────────────────────
        case 'temp': {
          await this.setCapabilityValue('target_temperature', Number(value) / div).catch(() => {});
          break;
        }

        // ── Current temperature (read-only) ──────────────────────────────────
        case 'temp_ro': {
          await this.setCapabilityValue('measure_temperature', Number(value) / div).catch(() => {});
          break;
        }

        // ── Operating mode ────────────────────────────────────────────────────
        case 'mode': {
          const prev = this.getCapabilityValue('heat_pump_mode');
          const mode = String(value).toLowerCase();
          await this.setCapabilityValue('heat_pump_mode', mode).catch(() => {});
          if (prev !== mode) {
            this._triggerModeChanged
              .trigger(this, { mode, prev_mode: prev ?? mode })
              .catch(() => {});
          }
          break;
        }

        // ── Preset (bool or string) ───────────────────────────────────────────
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

        // ── Fault alarm (bitfield or bool) ────────────────────────────────────
        // non-zero number = fault active; bool true = fault; string ≠ eorr0/no = fault
        //
        // Debounce: heat-pump firmware (like AC / Heater) can send a transient fault=true
        // immediately after reconnect that self-corrects within seconds.  Suppress the
        // notification until the alarm has persisted for the full debounce window.
        case 'alarm': {
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

        // ── Power level 0–100 % ───────────────────────────────────────────────
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

  // ── Settings ─────────────────────────────────────────────────────────────────

  async onSettings({ changedKeys }) {
    const connectionKeys = ['ip', 'device_id', 'local_key', 'version'];
    if (changedKeys.some((k) => connectionKeys.includes(k))) {
      await this._connect();
      return;
    }
    if (changedKeys.includes('polling_interval')) {
      this._startPolling();
    }
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

  // ── Sync helpers ─────────────────────────────────────────────────────────────

  /**
   * Update target_temperature slider range from temp_min / temp_max / temp_step settings.
   */
  async _syncTempRange() {
    const min  = this.getSetting('temp_min')  ?? 12;
    const max  = this.getSetting('temp_max')  ?? 45;
    const step = this.getSetting('temp_step') ?? 1;
    try {
      await this.setCapabilityOptions('target_temperature', { min, max, step });
      this.log(`target_temperature range → ${min}–${max} step ${step}`);
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
      await this.setCapabilityOptions('heat_pump_mode', { values });
      this.log(`heat_pump_mode picker → ${values.map((v) => v.id).join(', ')}`);
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
      await this.setCapabilityOptions('heat_pump_preset', { values });
      this.log(`heat_pump_preset picker → ${values.map((v) => v.id).join(', ')}`);
    } catch (err) {
      this.log('setCapabilityOptions(heat_pump_preset) failed:', err.message);
    }
  }
}

module.exports = HeatPumpDevice;
