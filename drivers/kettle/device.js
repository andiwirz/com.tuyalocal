'use strict';

const BaseTuyaDevice = require('../../lib/BaseTuyaDevice');
const { capitalize }  = require('../../lib/utils');

// ── DP → capability mapping ──────────────────────────────────────────────────
// DP 1   on/off           : boolean — start/stop heating
// DP 2   current_temp     : integer °C — current water temperature
// DP 4   target_temp      : integer °C — target temperature
// DP 13  keep_warm        : boolean — keep-warm toggle
// DP 15  status           : enum standby|heating|cooling|warm|heating_temp
// DP 16  mode             : enum boil|heat|quick_boil|quick_heat|tea variants
// DP 19  fault            : bitfield — fault alarm

const DP_PROFILE = [
  { settingKey: 'dp_onoff',        capability: 'onoff',              type: 'switch',  settable: true  },
  { settingKey: 'dp_current_temp', capability: 'measure_temperature',type: 'temp_ro', settable: false },
  { settingKey: 'dp_target_temp',  capability: 'target_temperature', type: 'temp',    settable: true  },
  { settingKey: 'dp_keep_warm',    capability: 'kettle_keep_warm',   type: 'bool',    settable: true  },
  { settingKey: 'dp_status',       capability: 'kettle_status',      type: 'enum_ro', settable: false },
  { settingKey: 'dp_mode',         capability: 'kettle_mode',        type: 'enum',    settable: true  },
  { settingKey: 'dp_fault',        capability: 'alarm_generic',      type: 'alarm',   settable: false },
];

const OPTIONAL_CAPABILITIES = [
  { setting: 'dp_target_temp',  capability: 'target_temperature' },
  { setting: 'dp_keep_warm',    capability: 'kettle_keep_warm'   },
  { setting: 'dp_status',       capability: 'kettle_status'      },
  { setting: 'dp_mode',         capability: 'kettle_mode'        },
  { setting: 'dp_fault',        capability: 'alarm_generic'      },
];

class KettleDevice extends BaseTuyaDevice {
  async onInit() {
    this.log('Device initialized:', this.getName());

    await this._baseInit();

    await this._syncOptionalCapabilities(OPTIONAL_CAPABILITIES);
    await this._syncTempRange();
    await this._syncModeOptions();
    await this._syncStatusOptions();

    // ── Flow trigger cards ───────────────────────────────────────────────────
    this._triggerDeviceConnected    = this.homey.flow.getDeviceTriggerCard('kettle_device_connected');
    this._triggerDeviceDisconnected = this.homey.flow.getDeviceTriggerCard('kettle_device_disconnected');
    this._triggerDpChanged          = this.homey.flow.getDeviceTriggerCard('kettle_dp_changed');
    this._triggerStatusChanged      = this.homey.flow.getDeviceTriggerCard('kettle_status_changed');
    this._triggerBoilDone           = this.homey.flow.getDeviceTriggerCard('kettle_boil_done');

    // ── Capability listeners ─────────────────────────────────────────────────
    this.registerCapabilityListener('onoff', async (value) => {
      const dp = this.getSetting('dp_onoff');
      if (dp > 0) await this._set(dp, value);
    });

    if (this.hasCapability('target_temperature')) {
      this.registerCapabilityListener('target_temperature', async (value) => {
        const dp = this.getSetting('dp_target_temp');
        if (dp > 0) await this._set(dp, Math.round(value));
      });
    }

    if (this.hasCapability('kettle_keep_warm')) {
      this.registerCapabilityListener('kettle_keep_warm', async (value) => {
        const dp = this.getSetting('dp_keep_warm');
        if (dp > 0) await this._set(dp, value);
      });
    }

    if (this.hasCapability('kettle_mode')) {
      this.registerCapabilityListener('kettle_mode', async (value) => {
        const dp = this.getSetting('dp_mode');
        if (dp > 0) await this._set(dp, value);
      });
    }

    await this._connect();
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

      switch (entry.type) {
        case 'switch': {
          await this.setCapabilityValue('onoff', Boolean(value)).catch(() => {});
          break;
        }

        case 'temp_ro': {
          await this.setCapabilityValue('measure_temperature', Number(value)).catch(() => {});
          break;
        }

        case 'temp': {
          await this.setCapabilityValue('target_temperature', Number(value)).catch(() => {});
          break;
        }

        case 'bool': {
          await this.setCapabilityValue(entry.capability, Boolean(value)).catch(() => {});
          break;
        }

        case 'enum_ro': {
          const prev = this.getCapabilityValue('kettle_status');
          const status = String(value).toLowerCase();
          await this.setCapabilityValue('kettle_status', status).catch(() => {});
          if (prev !== status) {
            this._triggerStatusChanged
              .trigger(this, { status, prev_status: prev ?? status })
              .catch(() => {});
            // "done" variants: boiling, boiling_temp, pause, cooling → signal boil complete
            const DONE_STATES = new Set(['boiling', 'boiling_temp', 'pause', 'done', 'cooling']);
            if (DONE_STATES.has(status) && prev === 'heating') {
              this._triggerBoilDone.trigger(this).catch(() => {});
            }
          }
          break;
        }

        case 'enum': {
          const mode = String(value).toLowerCase();
          await this.setCapabilityValue('kettle_mode', mode).catch(() => {});
          break;
        }

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
    }
    if (changedKeys.some((k) => ['temp_min', 'temp_max', 'temp_step'].includes(k))) {
      await this._syncTempRange();
    }
    if (changedKeys.includes('mode_values') || changedKeys.includes('dp_mode')) {
      await this._syncModeOptions();
    }
    if (changedKeys.includes('status_values') || changedKeys.includes('dp_status')) {
      await this._syncStatusOptions();
    }
  }

  // ── Sync helpers ─────────────────────────────────────────────────────────────

  async _syncTempRange() {
    if (!this.hasCapability('target_temperature')) return;
    const min  = this.getSetting('temp_min')  ?? 40;
    const max  = this.getSetting('temp_max')  ?? 100;
    const step = this.getSetting('temp_step') ?? 5;
    await this.setCapabilityOptions('target_temperature', { min, max, step }).catch(() => {});
  }

  async _syncModeOptions() {
    if (!this.hasCapability('kettle_mode')) return;
    const values = (this.getSetting('mode_values') || 'boil,heat,keep_warm')
      .split(',').map((s) => s.trim()).filter(Boolean)
      .map((v) => ({ id: v, title: { en: capitalize(v), de: capitalize(v) } }));
    await this.setCapabilityOptions('kettle_mode', { values }).catch(() => {});
  }

  async _syncStatusOptions() {
    if (!this.hasCapability('kettle_status')) return;
    const values = (this.getSetting('status_values') || 'standby,heating,cooling,warm,done')
      .split(',').map((s) => s.trim()).filter(Boolean)
      .map((v) => ({ id: v, title: { en: capitalize(v), de: capitalize(v) } }));
    await this.setCapabilityOptions('kettle_status', { values }).catch(() => {});
  }
}

module.exports = KettleDevice;
