'use strict';

const BaseTuyaDevice = require('../../lib/BaseTuyaDevice');

const DEBOUNCE_MS = 200;

// ── HSV hex helpers ──────────────────────────────────────────────────────────
// Tuya color format: 12-char hex string HHHHSSSSBBBB
//   H: 0–360 (2 bytes), S: 0–1000 (2 bytes), V/B: 0–1000 (2 bytes)

function parseColorHex(hex) {
  if (typeof hex !== 'string' || hex.length < 12) return null;
  return {
    h: parseInt(hex.slice(0, 4), 16),  // 0–360
    s: parseInt(hex.slice(4, 8),  16), // 0–1000
    v: parseInt(hex.slice(8, 12), 16), // 0–1000
  };
}

function buildColorHex(h, s, v) {
  const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, Math.round(n)));
  return clamp(h, 0, 360) .toString(16).padStart(4, '0') +
         clamp(s, 0, 1000).toString(16).padStart(4, '0') +
         clamp(v, 0, 1000).toString(16).padStart(4, '0');
}

// Scale a raw Tuya brightness value (0–max) → Homey dim (0–1)
function rawToDim(raw, max) {
  return Math.max(0, Math.min(1, raw / max));
}
function dimToRaw(dim, max) {
  return Math.round(Math.max(0, Math.min(1, dim)) * max);
}

class LightDevice extends BaseTuyaDevice {
  async onInit() {
    this.log('Device initialized:', this.getName());

    await this._baseInit();

    // Pending color components — accumulate partial updates then flush.
    this._pendingH = null;
    this._pendingS = null;
    this._pendingV = null;

    await this._migrateCapabilities([]);
    await this._syncLightCapabilities();

    // ── Flow trigger cards ───────────────────────────────────────────────────
    this._triggerDeviceConnected    = this.homey.flow.getDeviceTriggerCard('light_device_connected');
    this._triggerDeviceDisconnected = this.homey.flow.getDeviceTriggerCard('light_device_disconnected');
    this._triggerDpChanged          = this.homey.flow.getDeviceTriggerCard('light_dp_changed');

    // ── Capability listeners ─────────────────────────────────────────────────
    this.registerCapabilityListener('onoff', async (value) => {
      const dp = this.getSetting('dp_onoff');
      if (dp > 0) await this._conn?.set(dp, value);
    });

    let dimTimer = null;
    this.registerCapabilityListener('dim', (value) => {
      clearTimeout(dimTimer);
      return new Promise((resolve) => {
        dimTimer = setTimeout(async () => {
          const mode = this.getCapabilityValue('light_mode');
          if (mode === 'color' && this.hasCapability('light_hue')) {
            // In colour mode, update V component of the HSV hex
            await this._sendColor({ v: value }).catch(() => {});
          } else {
            // In white mode, update brightness DP directly
            const dp  = this.getSetting('dp_brightness');
            const max = this.getSetting('brightness_max') ?? 1000;
            if (dp > 0) await this._conn?.set(dp, dimToRaw(value, max)).catch(() => {});
          }
          resolve();
        }, DEBOUNCE_MS);
      });
    });

    let tempTimer = null;
    this.registerCapabilityListener('light_temperature', (value) => {
      clearTimeout(tempTimer);
      return new Promise((resolve) => {
        tempTimer = setTimeout(async () => {
          const dp  = this.getSetting('dp_color_temp');
          const max = this.getSetting('color_temp_max') ?? 1000;
          const inv = this.getSetting('color_temp_invert') ?? false;
          if (dp > 0) {
            const raw = inv ? (max - dimToRaw(value, max)) : dimToRaw(value, max);
            await this._conn?.set(dp, raw).catch(() => {});
          }
          resolve();
        }, DEBOUNCE_MS);
      });
    });

    let hueTimer = null;
    this.registerCapabilityListener('light_hue', (value) => {
      clearTimeout(hueTimer);
      return new Promise((resolve) => {
        hueTimer = setTimeout(async () => {
          await this._sendColor({ h: value }).catch(() => {});
          resolve();
        }, DEBOUNCE_MS);
      });
    });

    let satTimer = null;
    this.registerCapabilityListener('light_saturation', (value) => {
      clearTimeout(satTimer);
      return new Promise((resolve) => {
        satTimer = setTimeout(async () => {
          await this._sendColor({ s: value }).catch(() => {});
          resolve();
        }, DEBOUNCE_MS);
      });
    });

    this.registerCapabilityListener('light_mode', async (value) => {
      const dp = this.getSetting('dp_color_mode');
      if (dp > 0) {
        // Map Homey light_mode to device string
        const deviceVal = value === 'color' ? this.getSetting('color_mode_color_val') || 'colour'
                                            : this.getSetting('color_mode_white_val') || 'white';
        await this._conn?.set(dp, deviceVal);
      }
    });

    await this._connect();
  }

  // ── Send color command ───────────────────────────────────────────────────────
  // Merges current capability values with any overrides and sends the HSV hex.

  async _sendColor({ h: hNew, s: sNew, v: vNew } = {}) {
    const dp = this.getSetting('dp_color');
    if (!dp || dp === 0) return;

    const curHue = this.getCapabilityValue('light_hue')        ?? 0;
    const curSat = this.getCapabilityValue('light_saturation') ?? 1;
    const curDim = this.getCapabilityValue('dim')              ?? 1;

    const h = Math.round((hNew !== undefined ? hNew : curHue) * 360);
    const s = Math.round((sNew !== undefined ? sNew : curSat) * 1000);
    const v = Math.round((vNew !== undefined ? vNew : curDim) * 1000);

    await this._conn?.set(dp, buildColorHex(h, s, v));
  }

  // ── DPS handling ─────────────────────────────────────────────────────────────

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

      // ── On/Off ────────────────────────────────────────────────────────────
      if (settings.dp_onoff > 0 && dp === settings.dp_onoff) {
        await this.setCapabilityValue('onoff', Boolean(value)).catch(() => {});
        continue;
      }

      // ── Color mode ─────────────────────────────────────────────────────────
      if (settings.dp_color_mode > 0 && dp === settings.dp_color_mode) {
        if (this.hasCapability('light_mode')) {
          const whiteVal = settings.color_mode_white_val || 'white';
          const homeyMode = String(value) === whiteVal ? 'temperature' : 'color';
          await this.setCapabilityValue('light_mode', homeyMode).catch(() => {});
        }
        continue;
      }

      // ── Brightness ─────────────────────────────────────────────────────────
      if (settings.dp_brightness > 0 && dp === settings.dp_brightness) {
        const max = settings.brightness_max ?? 1000;
        await this.setCapabilityValue('dim', rawToDim(Number(value), max)).catch(() => {});
        continue;
      }

      // ── Color temperature ──────────────────────────────────────────────────
      if (settings.dp_color_temp > 0 && dp === settings.dp_color_temp) {
        if (this.hasCapability('light_temperature')) {
          const max = settings.color_temp_max ?? 1000;
          const inv = settings.color_temp_invert ?? false;
          const raw = Number(value);
          const scaled = inv ? rawToDim(max - raw, max) : rawToDim(raw, max);
          await this.setCapabilityValue('light_temperature', scaled).catch(() => {});
        }
        continue;
      }

      // ── HSV color hex ──────────────────────────────────────────────────────
      if (settings.dp_color > 0 && dp === settings.dp_color) {
        const parsed = parseColorHex(String(value));
        if (parsed) {
          if (this.hasCapability('light_hue')) {
            await this.setCapabilityValue('light_hue',        parsed.h / 360).catch(() => {});
          }
          if (this.hasCapability('light_saturation')) {
            await this.setCapabilityValue('light_saturation', parsed.s / 1000).catch(() => {});
          }
          // V also maps to brightness when in color mode
          if (this.getCapabilityValue('light_mode') === 'color') {
            await this.setCapabilityValue('dim', parsed.v / 1000).catch(() => {});
          }
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

  // ── Sync optional light capabilities based on DP settings ───────────────────

  async _syncLightCapabilities() {
    const OPTIONAL_CAPS = [
      { setting: 'dp_color_temp', capability: 'light_temperature' },
      { setting: 'dp_color_mode', capability: 'light_mode'        },
      { setting: 'dp_color',      capability: 'light_hue'         },
      { setting: 'dp_color',      capability: 'light_saturation'  },
    ];

    for (const { setting, capability } of OPTIONAL_CAPS) {
      const dp = this.getSetting(setting);
      if (dp > 0) {
        if (!this.hasCapability(capability)) await this.addCapability(capability).catch(() => {});
      } else {
        if (this.hasCapability(capability)) await this.removeCapability(capability).catch(() => {});
      }
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
    const lightSettings = ['dp_color_temp', 'dp_color_mode', 'dp_color'];
    if (changedKeys.some((k) => lightSettings.includes(k))) {
      await this._syncLightCapabilities();
    }
  }
}

module.exports = LightDevice;
