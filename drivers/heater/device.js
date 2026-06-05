'use strict';

const BaseTuyaDevice = require('../../lib/BaseTuyaDevice');

const DEBOUNCE_MS = 300;

// target_temperature, measure_temperature and alarm_generic (fault) are
// handled manually in _handleDps so that temp_divisor is applied correctly.
const DP_PROFILE = [
  { settingKey: 'dp_onoff',           capability: 'onoff',           transform: (v) => Boolean(v),  settable: true  },
  { settingKey: 'dp_mode',            capability: 'mode',            transform: (v) => String(v),   settable: true  },
  { settingKey: 'dp_oscillate',       capability: 'oscillate',       transform: (v) => Boolean(v),  settable: true  },
  { settingKey: 'dp_child_lock',      capability: 'child_lock',      transform: (v) => Boolean(v),  settable: true  },
  { settingKey: 'dp_countdown_timer', capability: 'countdown_timer', transform: (v) => String(v),   settable: true  },
  { settingKey: 'dp_countdown_left',  capability: 'countdown_left',  transform: (v) => Number(v),   settable: false },
  // Work state: "heating" = true, anything else (e.g. "no_heating") = false
  { settingKey: 'dp_work_state',      capability: 'heater_active',   transform: (v) => String(v).toLowerCase() === 'heating', settable: false },
];

const OPTIONAL_CAPABILITIES = [
  { setting: 'dp_mode',            capability: 'mode'            },
  { setting: 'dp_oscillate',       capability: 'oscillate'       },
  { setting: 'dp_child_lock',      capability: 'child_lock'      },
  { setting: 'dp_fault',           capability: 'alarm_generic'   },
  { setting: 'dp_countdown_timer', capability: 'countdown_timer' },
  { setting: 'dp_countdown_left',  capability: 'countdown_left'  },
  { setting: 'dp_current_temp',    capability: 'measure_temperature' },
  { setting: 'dp_work_state',      capability: 'heater_active'   },
];

class HeaterDevice extends BaseTuyaDevice {
  async onInit() {
    this.log('Device initialized:', this.getName());

    await this._baseInit();

    this._connectedAt         = null;
    this._faultAlarmTimer     = null;
    this._faultAlarmConfirmed = false;

    await this._migrateCapabilities([]);
    await this._syncOptionalCapabilities(OPTIONAL_CAPABILITIES);
    await this._syncEnumOptions('mode', this.getSetting('mode_values'));
    await this._syncTempCapabilityOptions();

    // ── Flow trigger cards ───────────────────────────────────────────────────
    this._triggerDeviceConnected    = this.homey.flow.getDeviceTriggerCard('heater_device_connected');
    this._triggerDeviceDisconnected = this.homey.flow.getDeviceTriggerCard('heater_device_disconnected');
    this._triggerDpChanged          = this.homey.flow.getDeviceTriggerCard('heater_dp_changed');
    this._triggerFaultOn            = this.homey.flow.getDeviceTriggerCard('heater_fault_alarm_on');
    this._triggerStartedHeating     = this.homey.flow.getDeviceTriggerCard('heater_started_heating');
    this._triggerStoppedHeating     = this.homey.flow.getDeviceTriggerCard('heater_stopped_heating');

    // ── Capability listeners — DP_PROFILE ───────────────────────────────────
    for (const entry of DP_PROFILE) {
      if (!entry.settable) continue;
      if (!this.hasCapability(entry.capability)) continue;
      this.registerCapabilityListener(entry.capability, async (value) => {
        await this._set(this.getSetting(entry.settingKey), value);
      });
    }

    // ── target_temperature — apply temp_divisor when sending ─────────────────
    let tempDebounceTimer = null;
    this.registerCapabilityListener('target_temperature', (value) => {
      clearTimeout(tempDebounceTimer);
      return new Promise((resolve) => {
        tempDebounceTimer = setTimeout(async () => {
          const dp      = this.getSetting('dp_target_temp');
          const divisor = this.getSetting('temp_divisor') || 1;
          if (dp > 0) {
            await this._set(dp, Math.round(value * divisor)).catch(() => {});
          }
          resolve();
        }, DEBOUNCE_MS);
      });
    });

    await this._connect();
  }

  // ── Hook overrides ───────────────────────────────────────────────────────────

  _onConnected() {
    this._connectedAt         = Date.now();
    clearTimeout(this._faultAlarmTimer);
    this._faultAlarmTimer     = null;
    this._faultAlarmConfirmed = false;
  }

  async _onDeleted() {
    clearTimeout(this._faultAlarmTimer);
  }

  // ── DPS handling ─────────────────────────────────────────────────────────────

  async _handleDps(dps) {
    const settings = this.getSettings();
    const divisor  = settings.temp_divisor || 1;
    let   changed  = false;

    for (const [dpStr, value] of Object.entries(dps)) {
      if (this._lastDps[dpStr] === value) continue;
      this._lastDps[dpStr] = value;
      changed = true;

      const dp = parseInt(dpStr, 10);

      this._triggerDpChanged
        .trigger(this, { dp: dpStr, value: String(value) })
        .catch(() => {});

      // ── Target temperature ─────────────────────────────────────────────────
      if (settings.dp_target_temp > 0 && dp === settings.dp_target_temp) {
        await this.setCapabilityValue('target_temperature', Number(value) / divisor).catch(() => {});
        continue;
      }

      // ── Current (measured) temperature ────────────────────────────────────
      if (settings.dp_current_temp > 0 && dp === settings.dp_current_temp) {
        if (this.hasCapability('measure_temperature')) {
          await this.setCapabilityValue('measure_temperature', Number(value) / divisor).catch(() => {});
        }
        continue;
      }

      // ── Fault alarm ────────────────────────────────────────────────────────
      if (settings.dp_fault > 0 && dp === settings.dp_fault) {
        const isActive   = value !== 0 && value !== false;
        const faultCode  = typeof value === 'number' ? value : (isActive ? 1 : 0);
        const prevActive = this.getCapabilityValue('alarm_generic');
        await this.setCapabilityValue('alarm_generic', isActive).catch(() => {});

        if (!prevActive && isActive) {
          const GRACE_MS   = (this.getSetting('alarm_grace_seconds') ?? 30) * 1000;
          const elapsed    = this._connectedAt ? Date.now() - this._connectedAt : GRACE_MS;
          const debounceMs = elapsed < GRACE_MS ? GRACE_MS - elapsed + 5_000 : 5_000;
          clearTimeout(this._faultAlarmTimer);
          this._faultAlarmConfirmed = false;
          this._faultAlarmTimer = setTimeout(() => {
            if (this.getCapabilityValue('alarm_generic') === true) {
              this._faultAlarmConfirmed = true;
              this._triggerFaultOn.trigger(this, { fault_code: faultCode }).catch(() => {});
              this.homey.notifications.createNotification({
                excerpt: `${this.getName()}: ${this.homey.__('notifications.faultAlarm')}`,
              }).catch(() => {});
            }
          }, debounceMs);
        }

        if (prevActive && !isActive) {
          clearTimeout(this._faultAlarmTimer);
          this._faultAlarmConfirmed = false;
        }
        continue;
      }

      // ── All other DPs ──────────────────────────────────────────────────────
      const entry = DP_PROFILE.find((e) => {
        const dpNum = settings[e.settingKey];
        return dpNum > 0 && dp === dpNum;
      });

      if (!entry) {
        this.log(`Unknown DP ${dp}:`, value);
        continue;
      }

      const converted = entry.transform(value);

      // Fire started/stopped heating triggers on state change
      if (entry.capability === 'heater_active') {
        const prev = this.getCapabilityValue('heater_active');
        await this.setCapabilityValue('heater_active', converted).catch(() => {});
        if (prev !== converted) {
          if (converted) {
            this._triggerStartedHeating.trigger(this).catch(() => {});
            this.log('Heater started heating');
          } else {
            this._triggerStoppedHeating.trigger(this).catch(() => {});
            this.log('Heater stopped heating');
          }
        }
        continue;
      }

      await this.setCapabilityValue(entry.capability, converted).catch(() => {});
    }

    if (changed) {
      this._scheduleStoreSave();
      this._writeDpSnapshot();
    }
  }

  // ── Homey lifecycle ──────────────────────────────────────────────────────────

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
    if (changedKeys.includes('mode_values')) {
      await this._syncEnumOptions('mode', this.getSetting('mode_values'));
    }
    if (changedKeys.some((k) => ['temp_step', 'temp_min', 'temp_max'].includes(k))) {
      await this._syncTempCapabilityOptions();
    }
  }

  async _syncTempCapabilityOptions() {
    const step = this.getSetting('temp_step') ?? 1;
    const min  = this.getSetting('temp_min')  ?? 5;
    const max  = this.getSetting('temp_max')  ?? 35;
    await this.setCapabilityOptions('target_temperature', { step, min, max }).catch(() => {});
  }
}

module.exports = HeaterDevice;
