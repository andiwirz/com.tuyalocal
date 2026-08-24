'use strict';

const BaseTuyaDevice = require('../../lib/BaseTuyaDevice');

// Energy meters and metering circuit breakers — Tuya categories "zndb" (meter) and
// "dlq" (breaker): DIN-rail meters, clamp meters, and breakers that report what they
// are switching.
//
// Separate from the smart plug rather than folded into it, because the thing being
// measured is the point here and the switch is optional. A clamp meter in a
// distribution board has no switch at all, and the plug driver — declared as a socket
// with onoff in its manifest — gives one anyway: a dead toggle on a device that
// cannot switch anything. That was the report that prompted this.
//
// Scope, from counting the 70 energy-meter definitions in the tuya-local project:
// 42 report each quantity on its own data point, which is what this driver reads. The
// other 28 pack voltage, current and power for a phase into one binary value — 27 of
// them on data point 6. Those are not supported: the format is undocumented and no
// reading from a real device has been available to check an implementation against, so
// such a meter will pair and then show nothing.
//
// (An earlier version of this note said sixty and ten. That came from grepping for the
// name "phase_a" rather than from asking which definitions report all three quantities
// from one data point, which is the question that actually decides it.)
const DP_PROFILE = [
  // The switch is first but optional, and off by default: a meter that only measures
  // must not be given a control it does not have.
  { settingKey: 'dp_switch',        capability: 'onoff',            transform: (v)      => Boolean(v),                              settable: true  },
  { settingKey: 'dp_power',         capability: 'measure_power',    transform: (v, dev) => dev._applyScale(v, 'power_scale',   0.1),   settable: false },
  { settingKey: 'dp_voltage',       capability: 'measure_voltage',  transform: (v, dev) => dev._applyScale(v, 'voltage_scale', 0.1),   settable: false },
  { settingKey: 'dp_current',       capability: 'measure_current',  transform: (v, dev) => dev._applyScale(v, 'current_scale', 0.001), settable: false },
  { settingKey: 'dp_energy',        capability: 'meter_power',      transform: (v, dev) => dev._applyScale(v, 'kwh_scale',     0.01),  settable: false },
  { settingKey: 'dp_power_factor',  capability: 'power_factor',     transform: (v)      => Number(v),                                settable: false },
  { settingKey: 'dp_fault',         capability: 'alarm_generic',    transform: (v)      => Number(v) > 0,                            settable: false },
];

// The calibration coefficients on the classic metering block: test_bit and the four
// voltage/current/power/electricity coefficients. Read-only factory values that never
// change and that this driver has no use for.
const CALIBRATION_DPS = new Set([21, 22, 23, 24, 25]);

const OPTIONAL_CAPABILITIES = [
  { setting: 'dp_switch',       capability: 'onoff'          },
  { setting: 'dp_energy',       capability: 'meter_power'    },
  { setting: 'dp_power_factor', capability: 'power_factor'   },
  { setting: 'dp_fault',        capability: 'alarm_generic'  },
];

class EnergyMeterDevice extends BaseTuyaDevice {
  async onInit() {
    this.log('Device initialized:', this.getName());

    await this._baseInit();
    await this._migrateCapabilities([]);
    await this._syncOptionalCapabilities(OPTIONAL_CAPABILITIES);

    this._triggerDeviceConnected    = this.homey.flow.getDeviceTriggerCard('meter_device_connected');
    this._triggerDeviceDisconnected = this.homey.flow.getDeviceTriggerCard('meter_device_disconnected');
    this._triggerDpChanged          = this.homey.flow.getDeviceTriggerCard('meter_dp_changed');

    this._registeredCaps = new Set();
    this._registerListeners();

    await this._connect();
  }

  /**
   * Only the switch is settable, and only on the devices that have one. Registered
   * through the same guarded helper the other drivers use, so a switch enabled later
   * in settings becomes usable without restarting the app.
   */
  _registerListeners() {
    for (const entry of DP_PROFILE) {
      if (!entry.settable) continue;
      if (!this.hasCapability(entry.capability)) continue;
      if (this._registeredCaps.has(entry.capability)) continue;
      this._registeredCaps.add(entry.capability);
      this.registerCapabilityListener(entry.capability, async (value) => {
        await this._set(this.getSetting(entry.settingKey), value);
      });
    }
  }

  // ── Scaling ────────────────────────────────────────────────────────────────

  _getScale(key, fallback) {
    const n = parseFloat(this.getSetting(key));
    return Number.isFinite(n) && n > 0 ? n : fallback;
  }

  /**
   * Applies a scaling divisor to a raw integer, rounded to the number of decimals
   * that divisor can express. Without the rounding, binary floating point turns a
   * raw 2376 × 0.1 into 237.60000000000002, and that is what would be written to the
   * capability and kept in Insights for ever.
   */
  _applyScale(raw, key, fallback) {
    const scale = this._getScale(key, fallback);
    const value = Number(raw) * scale;
    const digits = Math.round(-Math.log10(scale));
    if (digits < 0 || digits > 6 || Math.abs(10 ** -digits - scale) > 1e-12) return value;
    return Number(value.toFixed(digits));
  }

  // ── DPS handling ───────────────────────────────────────────────────────────

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

      const entry = DP_PROFILE.find((e) => {
        const n = settings[e.settingKey];
        return n > 0 && dp === n;
      });
      if (!entry) {
        // A data point this driver does not read is logged rather than dropped, so it
        // is visible instead of invisible — that is how the reported meter's reactive
        // and effective power were spotted at all.
        //
        // Except for the calibration block. Those five are documented, deliberately
        // unread, and present on every meter of this family, so logging them puts five
        // lines of noise in front of anything worth reading on each reconnect. The same
        // guard the level sensor uses, for the same reason.
        if (!CALIBRATION_DPS.has(dp)) this.log(`Unmapped DP ${dp}:`, value);
        continue;
      }
      if (!this.hasCapability(entry.capability)) continue;

      const converted = entry.transform(value, this);
      if (typeof converted === 'number' && !Number.isFinite(converted)) continue;
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
    if (changedKeys.includes('polling_interval'))   this._startPolling();
    if (changedKeys.includes('reconnect_interval')) this._startAutoReconnect();
    if (changedKeys.some((k) => OPTIONAL_CAPABILITIES.map((o) => o.setting).includes(k))) {
      await this._syncOptionalCapabilities(OPTIONAL_CAPABILITIES);
      this._registerListeners();
    }
    // A changed divisor has to reach the tile without waiting for the device to send
    // the same reading again — on a meter that can be a long time.
    if (changedKeys.some((k) => k.endsWith('_scale'))) {
      this._lastDps = {};
      this.pollNow().catch(() => {});
    }
  }
}

module.exports = EnergyMeterDevice;
