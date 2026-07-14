'use strict';

const BaseTuyaDevice = require('../../lib/BaseTuyaDevice');
const { capitalize }  = require('../../lib/utils');

// â”€â”€ Tuya thermostat DP patterns â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
//
// Pattern A â€” BHT-002 / Moes / Beok floor heating (temps Ã—10):
//   DP 1   bool   on/off
//   DP 2   str    mode (manual / auto / program / holiday)
//   DP 16  int    target_temperature (Ã—10)
//   DP 24  int    current_temperature (Ã—10)
//   DP 27  int    temp_correction (-9â€¦9)
//   DP 28  bool   child_lock
//   DP 45  bitmask fault
//
// Pattern B â€” Simple thermostat / zone valve:
//   DP 1   bool   on/off
//   DP 2   int    target_temperature
//   DP 3   int    current_temperature
//   DP 4   str    mode (heat / cool / auto / off)
//   DP 5   int    eco_temperature
//   DP 6   bool   child_lock
//
// Pattern C â€” TRV / radiator valve:
//   DP 1   bool   on/off
//   DP 2   int    target_temperature
//   DP 3   int    current_temperature
//   DP 4   str    mode (auto / manual / holiday)
//   DP 7   bool   child_lock
//   DP 14  int    battery_percentage
//   DP 15  bool   window_detect

const DP_PROFILE = [
  { settingKey: 'dp_onoff',        capability: 'onoff',               type: 'switch',  settable: true  },
  { settingKey: 'dp_target_temp',  capability: 'target_temperature',  type: 'temp',    settable: true  },
  { settingKey: 'dp_current_temp', capability: 'measure_temperature', type: 'temp_ro', settable: false },
  { settingKey: 'dp_mode',         capability: 'thermostat_mode',     type: 'mode',    settable: true  },
  { settingKey: 'dp_child_lock',   capability: 'child_lock',          type: 'bool',    settable: true  },
  { settingKey: 'dp_battery',      capability: 'measure_battery',     type: 'number',  settable: false },
  { settingKey: 'dp_fault',        capability: 'alarm_generic',       type: 'alarm',   settable: false },
];

const OPTIONAL_CAPABILITIES = [
  { setting: 'dp_mode',       capability: 'thermostat_mode' },
  { setting: 'dp_child_lock', capability: 'child_lock'      },
  { setting: 'dp_battery',    capability: 'measure_battery'  },
  { setting: 'dp_fault',      capability: 'alarm_generic'    },
];

class ThermostatDevice extends BaseTuyaDevice {
  async onInit() {
    this.log('Device initialized:', this.getName());

    await this._baseInit();

    await this._syncOptionalCapabilities(OPTIONAL_CAPABILITIES);
    await this._syncTempRange();
    await this._syncModeOptions();

    // â”€â”€ Flow trigger cards â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    this._triggerDeviceConnected    = this.homey.flow.getDeviceTriggerCard('thermostat_device_connected');
    this._triggerDeviceDisconnected = this.homey.flow.getDeviceTriggerCard('thermostat_device_disconnected');
    this._triggerDpChanged          = this.homey.flow.getDeviceTriggerCard('thermostat_dp_changed');
    this._triggerModeChanged        = this.homey.flow.getDeviceTriggerCard('thermostat_mode_changed');

    // â”€â”€ Capability listeners â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    this.registerCapabilityListener('onoff', async (value) => {
      const dp = this.getSetting('dp_onoff');
      if (dp > 0) await this._set(dp, value);
    });

    this.registerCapabilityListener('target_temperature', async (value) => {
      const dp  = this.getSetting('dp_target_temp');
      const div = this.getSetting('temp_divisor') || 1;
      if (dp > 0) await this._set(dp, Math.round(value * div));
    });

    if (this.hasCapability('thermostat_mode')) {
      this.registerCapabilityListener('thermostat_mode', async (value) => {
        const dp = this.getSetting('dp_mode');
        if (dp > 0) await this._set(dp, value);
      });
    }

    if (this.hasCapability('child_lock')) {
      this.registerCapabilityListener('child_lock', async (value) => {
        const dp = this.getSetting('dp_child_lock');
        if (dp > 0) await this._set(dp, value);
      });
    }

    await this._connect();
  }

  // â”€â”€ DPS handling â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  async _handleDps(dps) {
    const settings = this.getSettings();
    const div = settings.temp_divisor || 1;
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

      if (!entry || !this.hasCapability(entry.capability)) {
        if (!entry) this.log(`Unknown DP ${dp}:`, value);
        continue;
      }

      switch (entry.type) {
        case 'switch':
          await this.setCapabilityValue('onoff', Boolean(value)).catch(() => {});
          break;

        case 'temp':
          await this.setCapabilityValue('target_temperature', Number(value) / div).catch(() => {});
          break;

        case 'temp_ro':
          await this.setCapabilityValue('measure_temperature', Number(value) / div).catch(() => {});
          break;

        case 'mode': {
          const prev = this.getCapabilityValue('thermostat_mode');
          const mode = String(value).toLowerCase();
          await this.setCapabilityValue('thermostat_mode', mode).catch(() => {});
          if (prev !== mode) {
            this._triggerModeChanged
              .trigger(this, { mode, prev_mode: prev ?? mode })
              .catch(() => {});
          }
          break;
        }

        case 'bool':
          await this.setCapabilityValue(entry.capability, Boolean(value)).catch(() => {});
          break;

        case 'number':
          await this.setCapabilityValue(entry.capability, Number(value)).catch(() => {});
          break;

        case 'alarm': {
          const isAlarm = typeof value === 'number' ? value !== 0 : Boolean(value);
          await this.setCapabilityValue('alarm_generic', isAlarm).catch(() => {});
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
    }
    if (changedKeys.some((k) => ['temp_min', 'temp_max', 'temp_step'].includes(k))) {
      await this._syncTempRange();
    }
    if (changedKeys.includes('mode_values') || changedKeys.includes('dp_mode')) {
      await this._syncModeOptions();
    }
  }

  // â”€â”€ Sync helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  async _syncTempRange() {
    const min  = this.getSetting('temp_min')  ?? 5;
    const max  = this.getSetting('temp_max')  ?? 35;
    const step = this.getSetting('temp_step') ?? 0.5;
    await this.setCapabilityOptions('target_temperature', { min, max, step }).catch(() => {});
  }

  async _syncModeOptions() {
    if (!this.hasCapability('thermostat_mode')) return;
    const values = (this.getSetting('mode_values') || 'manual,auto,program')
      .split(',').map((s) => s.trim()).filter(Boolean)
      .map((v) => ({ id: v, title: { en: capitalize(v), de: capitalize(v) } }));
    await this.setCapabilityOptions('thermostat_mode', { values }).catch(() => {});
  }
}

module.exports = ThermostatDevice;
