'use strict';

const BaseTuyaDevice = require('../../lib/BaseTuyaDevice');

const DEBOUNCE_MS = 300;

// Maps settings keys → Homey capabilities.
// dp_speed (numeric speed integer) is handled separately because it needs
// min/max scaling to the Homey dim range (0–1).
const DP_PROFILE = [
  { settingKey: 'dp_onoff',           capability: 'onoff',         transform: (v) => Boolean(v),  settable: true  },
  { settingKey: 'dp_fan_speed',       capability: 'fan_speed',     transform: (v) => String(v),   settable: true  },
  { settingKey: 'dp_oscillate',       capability: 'oscillate',     transform: (v) => Boolean(v),  settable: true  },
  { settingKey: 'dp_direction',       capability: 'fan_direction', transform: (v) => String(v),   settable: true  },
  { settingKey: 'dp_mode',            capability: 'fan_mode',      transform: (v) => String(v),   settable: true  },
  { settingKey: 'dp_child_lock',      capability: 'child_lock',    transform: (v) => Boolean(v),  settable: true  },
  { settingKey: 'dp_countdown_timer', capability: 'countdown_timer', transform: (v) => String(v), settable: true  },
  { settingKey: 'dp_countdown_left',  capability: 'countdown_left',  transform: (v) => Number(v), settable: false },
];

const OPTIONAL_CAPABILITIES = [
  { setting: 'dp_fan_speed',       capability: 'fan_speed'       },
  { setting: 'dp_oscillate',       capability: 'oscillate'       },
  { setting: 'dp_direction',       capability: 'fan_direction'   },
  { setting: 'dp_mode',            capability: 'fan_mode'        },
  { setting: 'dp_child_lock',      capability: 'child_lock'      },
  { setting: 'dp_countdown_timer', capability: 'countdown_timer' },
  { setting: 'dp_countdown_left',  capability: 'countdown_left'  },
];

class FanDevice extends BaseTuyaDevice {
  async onInit() {
    this.log('Device initialized:', this.getName());

    await this._baseInit();

    await this._migrateCapabilities([]);
    await this._syncOptionalCapabilities(OPTIONAL_CAPABILITIES);
    await this._syncEnumOptions('fan_speed', this.getSetting('fan_speed_values'));
    await this._syncEnumOptions('fan_mode',  this.getSetting('fan_mode_values'));

    // ── Flow trigger cards ───────────────────────────────────────────────────
    this._triggerDeviceConnected    = this.homey.flow.getDeviceTriggerCard('fan_device_connected');
    this._triggerDeviceDisconnected = this.homey.flow.getDeviceTriggerCard('fan_device_disconnected');
    this._triggerDpChanged          = this.homey.flow.getDeviceTriggerCard('fan_dp_changed');
    this._triggerModeChanged        = this.homey.flow.getDeviceTriggerCard('fan_mode_changed');
    this._triggerDirectionChanged   = this.homey.flow.getDeviceTriggerCard('fan_direction_changed');

    // ── Capability listeners — DP_PROFILE ───────────────────────────────────
    for (const entry of DP_PROFILE) {
      if (!entry.settable) continue;
      if (!this.hasCapability(entry.capability)) continue;
      this.registerCapabilityListener(entry.capability, async (value) => {
        await this._conn?.set(this.getSetting(entry.settingKey), value);
      });
    }

    // ── dim (fan speed 0–1) ─────────────────────────────────────────────────
    let dimDebounceTimer = null;
    this.registerCapabilityListener('dim', (value) => {
      clearTimeout(dimDebounceTimer);
      return new Promise((resolve) => {
        dimDebounceTimer = setTimeout(async () => {
          const dp = this.getSetting('dp_speed');
          if (dp > 0) {
            const min = this.getSetting('speed_min') ?? 1;
            const max = this.getSetting('speed_max') ?? 6;
            const raw = Math.round(min + (max - min) * Math.max(0, Math.min(1, value)));
            await this._conn?.set(dp, raw).catch(() => {});
          }
          resolve();
        }, DEBOUNCE_MS);
      });
    });

    await this._connect();
  }

  // ── DPS handling ─────────────────────────────────────────────────────────────

  async _handleDps(dps) {
    const settings = this.getSettings();
    const speedMin  = settings.speed_min ?? 1;
    const speedMax  = settings.speed_max ?? 6;
    let   changed   = false;

    for (const [dpStr, value] of Object.entries(dps)) {
      if (this._lastDps[dpStr] === value) continue;
      this._lastDps[dpStr] = value;
      changed = true;

      const dp = parseInt(dpStr, 10);

      this._triggerDpChanged
        .trigger(this, { dp: dpStr, value: String(value) })
        .catch(() => {});

      // ── Numeric speed → dim ────────────────────────────────────────────────
      if (settings.dp_speed > 0 && dp === settings.dp_speed) {
        const raw = Number(value);
        const dim = speedMax > speedMin
          ? Math.max(0, Math.min(1, (raw - speedMin) / (speedMax - speedMin)))
          : 0;
        await this.setCapabilityValue('dim', dim).catch(() => {});
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

      if (entry.capability === 'fan_mode') {
        const prevMode = this.getCapabilityValue('fan_mode');
        await this.setCapabilityValue('fan_mode', converted).catch(() => {});
        if (prevMode !== null && prevMode !== converted) {
          this._triggerModeChanged
            .trigger(this, { mode: converted, prev_mode: prevMode })
            .catch(() => {});
        }
        continue;
      }

      if (entry.capability === 'fan_direction') {
        const prevDir = this.getCapabilityValue('fan_direction');
        await this.setCapabilityValue('fan_direction', converted).catch(() => {});
        if (prevDir !== null && prevDir !== converted) {
          this._triggerDirectionChanged
            .trigger(this, { direction: converted, prev_direction: prevDir })
            .catch(() => {});
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
    if (changedKeys.some((k) => ['fan_speed_values', 'fan_mode_values'].includes(k))) {
      await this._syncEnumOptions('fan_speed', this.getSetting('fan_speed_values'));
      await this._syncEnumOptions('fan_mode',  this.getSetting('fan_mode_values'));
    }
  }
}

module.exports = FanDevice;
