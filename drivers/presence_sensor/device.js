'use strict';

const BaseTuyaDevice = require('../../lib/BaseTuyaDevice');

// ── ZY-M100-WIFI mmWave Presence Sensor DP map ──────────────────────────────
//
//   DP 1   enum   presence_state: "none" | "presence"      (alarm_motion)
//   DP 2   int    sensitivity 0–9                           (setting)
//   DP 3   int    near_detection 0–1000 cm, step 10         (setting)
//   DP 4   int    far_detection  0–1000 cm, step 10         (setting)
//   DP 6   enum   checking_result: checking | check_success | check_failure
//                                  | others | comm_fault | radar_fault (alarm_generic)
//   DP 9   int    target_dis_closest 0–1000 cm              (measure_distance)
//   DP 101 int    detection_delay (s)                        (setting)
//   DP 102 int    fading_time (s)                            (setting)
//   DP 103 str    cli diagnostic string                      (ignored)
//   DP 104 int    illuminance (lux)                          (measure_luminance)

const DP_PROFILE = [
  { settingKey: 'dp_presence',  capability: 'alarm_motion',       type: 'presence', settable: false },
  { settingKey: 'dp_alarm',     capability: 'alarm_generic',      type: 'check',    settable: false },
  { settingKey: 'dp_distance',  capability: 'measure_distance',   type: 'number',   settable: false },
  { settingKey: 'dp_luminance', capability: 'measure_luminance',  type: 'number',   settable: false },
];

const OPTIONAL_CAPABILITIES = [
  { setting: 'dp_alarm',     capability: 'alarm_generic'     },
  { setting: 'dp_distance',  capability: 'measure_distance'  },
  { setting: 'dp_luminance', capability: 'measure_luminance' },
];

class PresenceSensorDevice extends BaseTuyaDevice {
  async onInit() {
    this.log('Device initialized:', this.getName());

    await this._baseInit();
    await this._syncOptionalCapabilities(OPTIONAL_CAPABILITIES);

    // ── Flow trigger cards ──────────────────────────────────────────────────
    this._triggerDeviceConnected    = this.homey.flow.getDeviceTriggerCard('presence_sensor_device_connected');
    this._triggerDeviceDisconnected = this.homey.flow.getDeviceTriggerCard('presence_sensor_device_disconnected');
    this._triggerDpChanged          = this.homey.flow.getDeviceTriggerCard('presence_sensor_dp_changed');
    this._triggerPresenceDetected   = this.homey.flow.getDeviceTriggerCard('presence_sensor_presence_detected');
    this._triggerPresenceCleared    = this.homey.flow.getDeviceTriggerCard('presence_sensor_presence_cleared');

    await this._connect();
  }

  // ── DPS handling ───────────────────────────────────────────────────────────

  async _handleDps(dps) {
    const settings = this.getSettings();
    let changed = false;

    for (const [dpStr, rawValue] of Object.entries(dps)) {
      const dp    = parseInt(dpStr, 10);
      const entry = DP_PROFILE.find((e) => settings[e.settingKey] > 0 && dp === settings[e.settingKey]);

      const value = rawValue;

      if (this._lastDps[dpStr] === value) continue;
      this._lastDps[dpStr] = value;
      changed = true;

      this._triggerDpChanged
        .trigger(this, { dp: dpStr, value: String(rawValue) })
        .catch(() => {});

      if (!entry || !this.hasCapability(entry.capability)) {
        if (!entry) this.log(`Unknown DP ${dp}:`, rawValue);
        continue;
      }

      switch (entry.type) {
        case 'presence': {
          // DP 1 enum: "presence" → true, "none" → false
          const present = String(value).toLowerCase() === 'presence';
          await this.setCapabilityValue('alarm_motion', present).catch(() => {});
          if (present) {
            this._triggerPresenceDetected.trigger(this, {}).catch(() => {});
          } else {
            this._triggerPresenceCleared.trigger(this, {}).catch(() => {});
          }
          break;
        }

        case 'check': {
          // DP 6 enum: fault states → alarm true; check_success → false
          const fault = !['check_success', 'checking'].includes(String(value).toLowerCase());
          await this.setCapabilityValue('alarm_generic', fault).catch(() => {});
          break;
        }

        case 'number':
          await this.setCapabilityValue(entry.capability, Number(value)).catch(() => {});
          break;

        default:
          break;
      }
    }

    if (changed) {
      this._scheduleStoreSave();
      this._writeDpSnapshot();
    }
  }

  // ── Settings ──────────────────────────────────────────────────────────────

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
  }
}

module.exports = PresenceSensorDevice;
