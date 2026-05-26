'use strict';

const BaseTuyaDevice = require('../../lib/BaseTuyaDevice');

const DEBOUNCE_MS = 300;

// ─────────────────────────────────────────────────────────────────────────────
// DP profile — entries whose transforms are straightforward scalars.
// target_temperature, measure_temperature, and alarm_generic (fault) are handled
// separately in _handleDps because they need context (temp_divisor / debounce).
// ─────────────────────────────────────────────────────────────────────────────
const DP_PROFILE = [
  { settingKey: 'dp_onoff',           capability: 'onoff',           transform: (v) => Boolean(v),  settable: true               },
  { settingKey: 'dp_mode',            capability: 'ac_mode',         transform: (v) => String(v),   settable: true               },
  { settingKey: 'dp_fan_speed',       capability: 'ac_fan_speed',    transform: (v) => String(v),   settable: true               },
  { settingKey: 'dp_swing',           capability: 'ac_swing',        transform: (v) => String(v),   settable: true               },
  { settingKey: 'dp_swing_h',         capability: 'ac_swing_h',      transform: (v) => Boolean(v),  settable: true               },
  { settingKey: 'dp_anion',           capability: 'anion',           transform: (v) => Boolean(v),  settable: true               },
  { settingKey: 'dp_sleep',           capability: 'ac_sleep',        transform: (v) => Boolean(v),  settable: true               },
  { settingKey: 'dp_eco',             capability: 'ac_eco',          transform: (v) => Boolean(v),  settable: true               },
  { settingKey: 'dp_child_lock',      capability: 'child_lock',      transform: (v) => Boolean(v),  settable: true               },
  { settingKey: 'dp_countdown_left',  capability: 'countdown_left',  transform: (v) => Number(v),   settable: false              },
  { settingKey: 'dp_countdown_timer', capability: 'countdown_timer', transform: (v) => String(v),   settable: true               },
];

const OPTIONAL_CAPABILITIES = [
  { setting: 'dp_swing',           capability: 'ac_swing'        },
  { setting: 'dp_swing_h',         capability: 'ac_swing_h'      },
  { setting: 'dp_anion',           capability: 'anion'           },
  { setting: 'dp_sleep',           capability: 'ac_sleep'        },
  { setting: 'dp_eco',             capability: 'ac_eco'          },
  { setting: 'dp_child_lock',      capability: 'child_lock'      },
  { setting: 'dp_fault',           capability: 'alarm_generic'   },
  { setting: 'dp_countdown_timer', capability: 'countdown_timer' },
  { setting: 'dp_countdown_left',  capability: 'countdown_left'  },
];

class AirConditionerDevice extends BaseTuyaDevice {
  async onInit() {
    this.log('Device initialized:', this.getName());

    await this._baseInit();

    // Driver-specific state
    this._connectedAt         = null;
    this._faultAlarmTimer     = null;
    this._faultAlarmConfirmed = false;
    this._lazyDpDetected      = false; // true once optional DPs have been auto-discovered

    // One-time migration: ac_swing changed from boolean to enum
    if (this.hasCapability('ac_swing')) {
      const swingOpts = this.getCapabilityOptions('ac_swing');
      if (!swingOpts || !swingOpts.values) {
        await this.removeCapability('ac_swing').catch(() => {});
      }
    }

    await this._migrateCapabilities([]);
    await this._syncOptionalCapabilities(OPTIONAL_CAPABILITIES);
    await this._syncEnumOptions('ac_mode',      this.getSetting('mode_values'));
    await this._syncEnumOptions('ac_fan_speed', this.getSetting('fan_speed_values'));
    await this._syncEnumOptions('ac_swing',     this.getSetting('swing_values'));
    await this._syncTempCapabilityOptions();

    // ── Flow trigger cards ────────────────────────────────────────────────────
    this._triggerDeviceConnected    = this.homey.flow.getDeviceTriggerCard('ac_device_connected');
    this._triggerDeviceDisconnected = this.homey.flow.getDeviceTriggerCard('ac_device_disconnected');
    this._triggerDpChanged          = this.homey.flow.getDeviceTriggerCard('ac_dp_changed');
    this._triggerFaultOn            = this.homey.flow.getDeviceTriggerCard('ac_fault_alarm_on');
    this._triggerModeChanged        = this.homey.flow.getDeviceTriggerCard('ac_mode_changed');

    // ── Capability listeners — DP_PROFILE (simple) ────────────────────────────
    for (const entry of DP_PROFILE) {
      if (!entry.settable) continue;
      if (!this.hasCapability(entry.capability)) continue;

      if (entry.debounce) {
        let timer = null;
        this.registerCapabilityListener(entry.capability, (value) => {
          clearTimeout(timer);
          return new Promise((resolve) => {
            timer = setTimeout(() => {
              this._conn?.set(this.getSetting(entry.settingKey), value)
                .then(resolve).catch(resolve);
            }, DEBOUNCE_MS);
          });
        });
      } else {
        this.registerCapabilityListener(entry.capability, async (value) => {
          await this._conn?.set(this.getSetting(entry.settingKey), value);
        });
      }
    }

    // ── target_temperature — apply temp_divisor when sending ──────────────────
    let tempDebounceTimer = null;
    this.registerCapabilityListener('target_temperature', (value) => {
      clearTimeout(tempDebounceTimer);
      return new Promise((resolve) => {
        tempDebounceTimer = setTimeout(async () => {
          const dp      = this.getSetting('dp_target_temp');
          const divisor = this.getSetting('temp_divisor') || 1;
          if (dp > 0) {
            await this._conn?.set(dp, Math.round(value * divisor)).catch(() => {});
          }
          resolve();
        }, DEBOUNCE_MS);
      });
    });

    await this._connect();
  }

  // ── Hook overrides ───────────────────────────────────────────────────────────

  /** Reset fault state on (re)connect. */
  _onConnected() {
    this._connectedAt     = Date.now();
    this._lazyDpDetected  = false; // allow optional-DP discovery on fresh data
    // Clear any pending fault timer from the previous connection cycle.
    clearTimeout(this._faultAlarmTimer);
    this._faultAlarmTimer     = null;
    this._faultAlarmConfirmed = false;
  }

  async _onDeleted() {
    clearTimeout(this._faultAlarmTimer);
  }

  // ── DPS handling ──────────────────────────────────────────────────────────

  async _handleDps(dps) {
    const settings = this.getSettings();
    const divisor  = settings.temp_divisor || 1;
    let   changed  = false;

    // ── Lazy optional-DP discovery ───────────────────────────────────────────
    // If pairing happened in a mode where some DPs (e.g. sleep DP 103) are not
    // reported by the device, they won't be auto-configured.  When those DPs
    // appear later (e.g. user switches to Cooling mode), we detect them here.
    // Runs once per connection; _lazyDpDetected is reset on each reconnect.
    if (!this._lazyDpDetected) {
      this._lazyDpDetected = true;
      await this._autoDiscoverOptionalDps(dps, settings);
    }

    for (const [dpStr, value] of Object.entries(dps)) {
      if (this._lastDps[dpStr] === value) continue;
      this._lastDps[dpStr] = value;
      changed = true;

      const dp = parseInt(dpStr, 10);

      // Generic dp_changed trigger
      this._triggerDpChanged
        .trigger(this, { dp: dpStr, value: String(value) })
        .catch(() => {});

      // ── Target temperature ──────────────────────────────────────────────────
      if (settings.dp_target_temp > 0 && dp === settings.dp_target_temp) {
        await this.setCapabilityValue('target_temperature', Number(value) / divisor).catch(() => {});
        continue;
      }

      // ── Current (measured) temperature ─────────────────────────────────────
      if (settings.dp_current_temp > 0 && dp === settings.dp_current_temp) {
        if (this.hasCapability('measure_temperature')) {
          await this.setCapabilityValue('measure_temperature', Number(value) / divisor).catch(() => {});
        }
        continue;
      }

      // ── Fault alarm (debounced against reconnect artifacts) ─────────────────
      if (settings.dp_fault > 0 && dp === settings.dp_fault) {
        const isActive    = value !== 0 && value !== false;
        const faultCode   = typeof value === 'number' ? value : (isActive ? 1 : 0);
        const prevActive  = this.getCapabilityValue('alarm_generic');
        await this.setCapabilityValue('alarm_generic', isActive).catch(() => {});

        if (!prevActive && isActive) {
          const GRACE_MS   = 30_000;
          const elapsed    = this._connectedAt ? Date.now() - this._connectedAt : GRACE_MS;
          const debounceMs = elapsed < GRACE_MS ? GRACE_MS - elapsed + 5_000 : 5_000;

          clearTimeout(this._faultAlarmTimer);
          this._faultAlarmConfirmed = false;
          this._faultAlarmTimer     = setTimeout(() => {
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

      // ── All other DPs — matched via DP_PROFILE ─────────────────────────────
      const entry = DP_PROFILE.find((e) => {
        const dpNum = settings[e.settingKey];
        return dpNum > 0 && dp === dpNum;
      });

      if (!entry) {
        this.log(`Unknown DP ${dp}:`, value);
        continue;
      }

      const converted = entry.transform(value);

      // Capture prev value before updating so the trigger token contains both old and new mode.
      if (entry.capability === 'ac_mode') {
        const prevMode = this.getCapabilityValue('ac_mode');
        await this.setCapabilityValue('ac_mode', converted).catch(() => {});
        if (prevMode !== null && prevMode !== converted) {
          this._triggerModeChanged
            .trigger(this, { mode: converted, prev_mode: prevMode })
            .catch(() => {});
        }
        continue;
      }

      await this.setCapabilityValue(entry.capability, converted).catch(() => {});
    }

    // Debounced persistence — avoids hammering storage on every DPS packet.
    if (changed) {
      this._scheduleStoreSave();
      this._writeDpSnapshot();
    }
  }

  // ── Homey lifecycle ───────────────────────────────────────────────────────

  async onSettings({ changedKeys }) {
    const connectionKeys = ['ip', 'device_id', 'local_key', 'version'];
    if (changedKeys.some((k) => connectionKeys.includes(k))) {
      this.log('Connection settings changed, reconnecting');
      await this._connect();
      return;
    }
    if (changedKeys.includes('polling_interval')) {
      this.log('Polling interval changed, restarting polling');
      this._startPolling();
    }
    if (changedKeys.some((k) => OPTIONAL_CAPABILITIES.map((o) => o.setting).includes(k))) {
      await this._syncOptionalCapabilities(OPTIONAL_CAPABILITIES);
    }
    if (changedKeys.some((k) => ['mode_values', 'fan_speed_values', 'swing_values'].includes(k))) {
      await this._syncEnumOptions('ac_mode',      this.getSetting('mode_values'));
      await this._syncEnumOptions('ac_fan_speed', this.getSetting('fan_speed_values'));
      await this._syncEnumOptions('ac_swing',     this.getSetting('swing_values'));
    }
    if (changedKeys.some((k) => ['temp_step', 'temp_min', 'temp_max'].includes(k))) {
      await this._syncTempCapabilityOptions();
    }
  }

  // ── Lazy optional-DP discovery ─────────────────────────────────────────────
  // Called once per connection with the first data packet.  Updates settings and
  // syncs capabilities for any well-known DP that the device now reports but
  // was not detected at pairing time (e.g. sleep DP 103 missing in Fan mode).
  async _autoDiscoverOptionalDps(dps, settings) {
    const updates = {};

    // DP 103 → sleep mode (boolean)
    if (settings.dp_sleep === 0 && typeof dps['103'] === 'boolean') {
      updates.dp_sleep = 103;
    }
    // DP 11 → anion / ioniser (boolean — only if not already used as countdown_left)
    if (settings.dp_anion === 0 && settings.dp_countdown_left !== 11
        && typeof dps['11'] === 'boolean') {
      updates.dp_anion = 11;
    }
    // DP 110 → horizontal swing (boolean)
    if (settings.dp_swing_h === 0 && typeof dps['110'] === 'boolean') {
      updates.dp_swing_h = 110;
    }

    if (Object.keys(updates).length > 0) {
      this._appLog(
        `Auto-discovered optional DPs: ${JSON.stringify(updates)}`,
        'info',
      );
      await this.setSettings(updates).catch(() => {});
      await this._syncOptionalCapabilities(OPTIONAL_CAPABILITIES);
    }
  }

  async _syncTempCapabilityOptions() {
    const step = this.getSetting('temp_step') ?? 1;
    const min  = this.getSetting('temp_min')  ?? 16;
    const max  = this.getSetting('temp_max')  ?? 30;
    await this.setCapabilityOptions('target_temperature', { step, min, max }).catch(() => {});
  }
}

module.exports = AirConditionerDevice;
