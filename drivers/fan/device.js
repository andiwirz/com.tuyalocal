'use strict';

const BaseTuyaDevice = require('../../lib/BaseTuyaDevice');
const { parseColorHex, buildColorHex } = require('../../lib/tuyaColor');

const DEBOUNCE_MS = 300;

// Maps settings keys → Homey capabilities.
// dp_speed (numeric speed integer) is handled separately because it needs
// min/max scaling to the Homey dim range (0–1).
// dp_light_dim and dp_light_color_temp are also handled separately (scaling).
const DP_PROFILE = [
  { settingKey: 'dp_onoff',           capability: 'onoff',           transform: (v) => Boolean(v),  settable: true  },
  { settingKey: 'dp_fan_speed',       capability: 'fan_speed',       transform: (v) => String(v),   settable: true  },
  { settingKey: 'dp_oscillate',       capability: 'oscillate',       transform: (v) => Boolean(v),  settable: true  },
  { settingKey: 'dp_direction',       capability: 'fan_direction',   transform: (v) => String(v),   settable: true  },
  { settingKey: 'dp_mode',            capability: 'fan_mode',        transform: (v) => String(v),   settable: true  },
  { settingKey: 'dp_child_lock',      capability: 'child_lock',      transform: (v) => Boolean(v),  settable: true  },
  { settingKey: 'dp_countdown_timer', capability: 'countdown_timer', transform: (v) => String(v),   settable: true  },
  { settingKey: 'dp_countdown_left',  capability: 'countdown_left',  transform: (v) => Number(v),   settable: false },
  { settingKey: 'dp_light_onoff',     capability: 'onoff.light',     transform: (v) => Boolean(v),  settable: true  },
];

const OPTIONAL_CAPABILITIES = [
  { setting: 'dp_fan_speed',        capability: 'fan_speed'         },
  { setting: 'dp_oscillate',        capability: 'oscillate'         },
  { setting: 'dp_direction',        capability: 'fan_direction'     },
  { setting: 'dp_mode',             capability: 'fan_mode'          },
  { setting: 'dp_child_lock',       capability: 'child_lock'        },
  { setting: 'dp_countdown_timer',  capability: 'countdown_timer'   },
  { setting: 'dp_countdown_left',   capability: 'countdown_left'    },
  // Light sub-capabilities (enabled when DP > 0)
  { setting: 'dp_light_onoff',      capability: 'onoff.light'       },
  { setting: 'dp_light_dim',        capability: 'dim.light'         },
  { setting: 'dp_light_color_temp', capability: 'light_temperature' },
  // Fan+light combo fixtures ("fsd"/"xdd") carry a full RGB light: a packed
  // HSV data point and a mode selector (white/colour/scene/music). Homey's
  // light_mode only expresses white ↔ colour; scene and music are reachable
  // through the "Set light mode (advanced)" flow action instead.
  { setting: 'dp_light_colour',     capability: 'light_hue'         },
  { setting: 'dp_light_colour',     capability: 'light_saturation'  },
  { setting: 'dp_light_mode',       capability: 'light_mode'        },
];

class FanDevice extends BaseTuyaDevice {
  async onInit() {
    this.log('Device initialized:', this.getName());

    await this._baseInit();

    await this._migrateCapabilities([]);
    await this._syncOptionalCapabilities(OPTIONAL_CAPABILITIES);
    await this._syncEnumOptions('fan_speed', this.getSetting('fan_speed_values'));
    await this._syncEnumOptions('fan_mode',  this.getSetting('fan_mode_values'));

    // ── Flow trigger cards ──────────────────────────────────────────────────
    this._triggerDeviceConnected    = this.homey.flow.getDeviceTriggerCard('fan_device_connected');
    this._triggerDeviceDisconnected = this.homey.flow.getDeviceTriggerCard('fan_device_disconnected');
    this._triggerDpChanged          = this.homey.flow.getDeviceTriggerCard('fan_dp_changed');
    this._triggerModeChanged        = this.homey.flow.getDeviceTriggerCard('fan_mode_changed');
    this._triggerDirectionChanged   = this.homey.flow.getDeviceTriggerCard('fan_direction_changed');

    // ── Capability listeners ─────────────────────────────────────────────────
    // Registered via _registerListeners() so that capabilities enabled later
    // through device settings (e.g. dp_light_onoff) become controllable
    // immediately — without requiring an app restart.
    this._registeredCaps        = new Set();
    this._dimDebounceTimer      = null;
    this._lightDimDebounceTimer = null;
    this._hueDebounceTimer      = null;
    this._satDebounceTimer      = null;
    this._registerListeners();

    await this._connect();
  }

  /**
   * Register capability listeners for all currently present capabilities.
   * Safe to call repeatedly (e.g. from onSettings after _syncOptionalCapabilities):
   * each capability is only registered once per device lifetime.
   */
  _registerListeners() {
    const register = (capability, listener) => {
      if (!this.hasCapability(capability)) return;
      if (this._registeredCaps.has(capability)) return;
      this._registeredCaps.add(capability);
      this.registerCapabilityListener(capability, listener);
    };

    // ── DP_PROFILE ────────────────────────────────────────────────────────────
    for (const entry of DP_PROFILE) {
      if (!entry.settable) continue;
      register(entry.capability, async (value) => {
        await this._set(this.getSetting(entry.settingKey), value);
      });
    }

    // ── dim (fan speed 0–1) ─────────────────────────────────────────────────
    register('dim', (value) => {
      clearTimeout(this._dimDebounceTimer);
      return new Promise((resolve) => {
        this._dimDebounceTimer = setTimeout(async () => {
          const dp = this.getSetting('dp_speed');
          if (dp > 0) {
            const min = this.getSetting('speed_min') ?? 1;
            const max = this.getSetting('speed_max') ?? 6;
            const raw = Math.round(min + (max - min) * Math.max(0, Math.min(1, value)));
            await this._set(dp, raw).catch(() => {});
          }
          resolve();
        }, DEBOUNCE_MS);
      });
    });

    // ── dim.light (light brightness 0–1) ────────────────────────────────────
    // In colour mode the brightness lives inside the packed HSV data point, not
    // on the white-light brightness DP — writing the latter while the light is
    // showing a colour does nothing visible on the reported fixtures.
    register('dim.light', (value) => {
      clearTimeout(this._lightDimDebounceTimer);
      return new Promise((resolve) => {
        this._lightDimDebounceTimer = setTimeout(async () => {
          if (this.getCapabilityValue('light_mode') === 'color' && this.hasCapability('light_hue')) {
            await this._sendLightColor({ v: value }).catch(() => {});
            resolve();
            return;
          }
          const dp = this.getSetting('dp_light_dim');
          if (dp > 0) {
            const min = this.getSetting('dp_light_dim_min') ?? 0;
            const max = this.getSetting('dp_light_dim_max') ?? 100;
            const raw = Math.round(min + (max - min) * Math.max(0, Math.min(1, value)));
            await this._set(dp, raw).catch(() => {});
          }
          resolve();
        }, DEBOUNCE_MS);
      });
    });

    // ── light_temperature (Homey 0=cold, 1=warm → device min–max) ───────────
    // dp_light_color_temp_invert flips the direction for devices where the raw
    // DP is min=warm/max=cold instead of the assumed min=cold/max=warm.
    register('light_temperature', async (value) => {
      const dp = this.getSetting('dp_light_color_temp');
      if (dp > 0) {
        const invert = this.getSetting('dp_light_color_temp_invert') || false;
        const min     = this.getSetting('dp_light_color_temp_min') ?? 0;
        const max     = this.getSetting('dp_light_color_temp_max') ?? 100;
        const clamped = Math.max(0, Math.min(1, value));
        const raw     = Math.round(min + (max - min) * (invert ? 1 - clamped : clamped));
        await this._set(dp, raw).catch(() => {});
      }
    });

    // ── light_hue / light_saturation → packed HSV colour ────────────────────
    register('light_hue', (value) => {
      clearTimeout(this._hueDebounceTimer);
      return new Promise((resolve) => {
        this._hueDebounceTimer = setTimeout(async () => {
          await this._sendLightColor({ h: value }).catch(() => {});
          resolve();
        }, DEBOUNCE_MS);
      });
    });

    register('light_saturation', (value) => {
      clearTimeout(this._satDebounceTimer);
      return new Promise((resolve) => {
        this._satDebounceTimer = setTimeout(async () => {
          await this._sendLightColor({ s: value }).catch(() => {});
          resolve();
        }, DEBOUNCE_MS);
      });
    });

    // ── light_mode (Homey: color | temperature) ─────────────────────────────
    register('light_mode', async (value) => {
      const dp = this.getSetting('dp_light_mode');
      if (dp > 0) {
        const t = this._lightModeTokens();
        await this._set(dp, value === 'color' ? t.colour : t.white).catch(() => {});
      }
    });
  }

  // The device's own tokens for the two modes Homey's light_mode can express.
  // Read from light_mode_values so a fixture declaring unusual tokens can be
  // corrected in settings; the fallbacks are the Tuya standard names.
  _lightModeTokens() {
    const csv = (this.getSetting('light_mode_values') || 'white,colour,scene,music')
      .split(',').map((s) => s.trim()).filter(Boolean);
    const white  = csv.find((v) => v.toLowerCase() === 'white') || csv[0] || 'white';
    const colour = csv.find((v) => ['colour', 'color'].includes(v.toLowerCase()))
      || csv.find((v) => v !== white) || 'colour';
    return { white, colour };
  }

  // Merges current capability values with any overrides and sends the packed
  // HSV hex — same format and approach as drivers/light/device.js.
  async _sendLightColor({ h: hNew, s: sNew, v: vNew } = {}) {
    const dp = this.getSetting('dp_light_colour');
    if (!(dp > 0)) return;
    const curHue = this.getCapabilityValue('light_hue')        ?? 0;
    const curSat = this.getCapabilityValue('light_saturation') ?? 1;
    const curDim = this.getCapabilityValue('dim.light')        ?? 1;
    const h = Math.round((hNew !== undefined ? hNew : curHue) * 360);
    const s = Math.round((sNew !== undefined ? sNew : curSat) * 1000);
    const v = Math.round((vNew !== undefined ? vNew : curDim) * 1000);
    await this._set(dp, buildColorHex(h, s, v));
  }

  // For the "Set light mode (advanced)" flow action: sends any token the device
  // declares — including scene/music, which Homey's light_mode cannot express.
  async setLightMode(token) {
    const dp = this.getSetting('dp_light_mode');
    if (!(dp > 0)) {
      throw new Error('The Light Mode DP is not configured for this device — set it under Device settings → Light (optional).');
    }
    await this._set(dp, token);
    if (this.hasCapability('light_mode')) {
      const homeyMode = token === this._lightModeTokens().white ? 'temperature' : 'color';
      await this.setCapabilityValue('light_mode', homeyMode).catch(() => {});
    }
  }

  async _onDeleted() {
    clearTimeout(this._dimDebounceTimer);
    clearTimeout(this._lightDimDebounceTimer);
    clearTimeout(this._hueDebounceTimer);
    clearTimeout(this._satDebounceTimer);
  }

  // ── DPS handling ───────────────────────────────────────────────────────────

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

      // ── Numeric speed → dim ─────────────────────────────────────────────
      if (settings.dp_speed > 0 && dp === settings.dp_speed) {
        const raw = Number(value);
        const dim = speedMax > speedMin
          ? Math.max(0, Math.min(1, (raw - speedMin) / (speedMax - speedMin)))
          : 0;
        await this.setCapabilityValue('dim', dim).catch(() => {});
        continue;
      }

      // ── Light brightness → dim.light ────────────────────────────────────
      if (settings.dp_light_dim > 0 && dp === settings.dp_light_dim) {
        if (this.hasCapability('dim.light')) {
          const min    = settings.dp_light_dim_min ?? 0;
          const max    = settings.dp_light_dim_max ?? 100;
          const dimVal = max > min
            ? Math.max(0, Math.min(1, (Number(value) - min) / (max - min)))
            : 0;
          await this.setCapabilityValue('dim.light', dimVal).catch(() => {});
        }
        continue;
      }

      // ── Light color temp (min–max) → light_temperature (0–1) ────────────
      if (settings.dp_light_color_temp > 0 && dp === settings.dp_light_color_temp) {
        if (this.hasCapability('light_temperature')) {
          const invert = settings.dp_light_color_temp_invert || false;
          const min    = settings.dp_light_color_temp_min ?? 0;
          const max    = settings.dp_light_color_temp_max ?? 100;
          const raw    = max > min
            ? Math.max(0, Math.min(1, (Number(value) - min) / (max - min)))
            : 0;
          const temp   = invert ? 1 - raw : raw;
          await this.setCapabilityValue('light_temperature', temp).catch(() => {});
        }
        continue;
      }

      // ── Light mode (white/colour/scene/music) → light_mode ──────────────
      // Homey's light_mode knows only color and temperature; scene/music read
      // as "color" here, which is at least the right half of the picker.
      if (settings.dp_light_mode > 0 && dp === settings.dp_light_mode) {
        if (this.hasCapability('light_mode')) {
          const homeyMode = String(value) === this._lightModeTokens().white ? 'temperature' : 'color';
          await this.setCapabilityValue('light_mode', homeyMode).catch(() => {});
        }
        continue;
      }

      // ── Packed HSV colour → light_hue / light_saturation ────────────────
      if (settings.dp_light_colour > 0 && dp === settings.dp_light_colour) {
        const parsed = parseColorHex(String(value));
        if (parsed) {
          if (this.hasCapability('light_hue')) {
            await this.setCapabilityValue('light_hue', parsed.h / 360).catch(() => {});
          }
          if (this.hasCapability('light_saturation')) {
            await this.setCapabilityValue('light_saturation', parsed.s / 1000).catch(() => {});
          }
          // V doubles as the brightness while the light is in colour mode.
          if (this.hasCapability('dim.light') && this.getCapabilityValue('light_mode') === 'color') {
            await this.setCapabilityValue('dim.light', parsed.v / 1000).catch(() => {});
          }
        }
        continue;
      }

      // ── All other DPs – matched via DP_PROFILE ──────────────────────────
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

      if (!this.hasCapability(entry.capability)) continue;
      await this.setCapabilityValue(entry.capability, converted).catch(() => {});
    }

    if (changed) {
      this._scheduleStoreSave();
      this._writeDpSnapshot();
    }
  }

  // ── Homey lifecycle ────────────────────────────────────────────────────────

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
      this._registerListeners(); // newly added capabilities need listeners immediately
    }
    if (changedKeys.some((k) => ['fan_speed_values', 'fan_mode_values'].includes(k))) {
      await this._syncEnumOptions('fan_speed', this.getSetting('fan_speed_values'));
      await this._syncEnumOptions('fan_mode',  this.getSetting('fan_mode_values'));
    }
  }
}

module.exports = FanDevice;
