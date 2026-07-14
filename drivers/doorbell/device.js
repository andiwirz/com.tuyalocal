'use strict';

const BaseTuyaDevice = require('../../lib/BaseTuyaDevice');

// ── Marmitek Buzz LO / Tuya category "sp" video doorbell ─────────────────────
//
// Event DPs (read-only, push-based):
//   DP 136  doorbell_active       string  — Unix timestamp string on ring
//   DP 115  movement_detect_pic   raw     — raw image on motion detected
//   DP 185  alarm_message         raw     — base64 JSON {cmd:"ipc_doorbell"|"ipc_motion",...}
//   DP 154  doorbell_pic          raw     — raw image on ring
//
// Control DPs (settable):
//   DP 134  motion_switch         bool    — enable/disable motion detection
//   DP 106  motion_sensitivity    enum    — 0=low, 1=medium, 2=high
//   DP 108  basic_nightvision     enum    — 0=auto, 1=off, 2=color
//   DP 101  basic_indicator       bool    — status LED
//   DP 150  record_switch         bool    — SD recording
//   DP 157  chime_ring_volume     int     — 0–100
//   DP 160  basic_device_volume   int     — 0–10

class DoorbellDevice extends BaseTuyaDevice {
  async onInit() {
    this.log('Device initialized:', this.getName());

    await this._baseInit();

    this._motionResetTimer   = null;
    this._doorbellResetTimer = null;

    if (!this.hasCapability('alarm_generic')) {
      await this.addCapability('alarm_generic');
    }

    // ── Flow trigger cards ───────────────────────────────────────────────────
    this._triggerRang               = this.homey.flow.getDeviceTriggerCard('doorbell_rang');
    this._triggerMotionDetected     = this.homey.flow.getDeviceTriggerCard('doorbell_motion_detected');
    this._triggerDeviceConnected    = this.homey.flow.getDeviceTriggerCard('doorbell_device_connected');
    this._triggerDeviceDisconnected = this.homey.flow.getDeviceTriggerCard('doorbell_device_disconnected');
    this._triggerDpChanged          = this.homey.flow.getDeviceTriggerCard('doorbell_dp_changed');

    await this._connect();
  }

  async _onDeleted() {
    clearTimeout(this._motionResetTimer);
    clearTimeout(this._doorbellResetTimer);
  }

  // ── DPS handling ─────────────────────────────────────────────────────────────

  async _handleDps(dps) {
    const settings = this.getSettings();
    const dpDoorbell     = settings.dp_doorbell     || 136;
    const dpMotionEvent  = settings.dp_motion_event  || 115;
    const dpAlarmMsg     = settings.dp_alarm_message || 0;

    let changed = false;

    for (const [dpStr, value] of Object.entries(dps)) {
      // prevValue is undefined on first-ever data packet for this DP
      const prevValue = this._lastDps[dpStr];
      if (prevValue === value) continue;
      this._lastDps[dpStr] = value;
      changed = true;

      const dp = parseInt(dpStr, 10);

      this._triggerDpChanged
        .trigger(this, { dp: dpStr, value: String(value) })
        .catch(() => {});

      // Skip triggering events on the initial seed (first data packet after first add).
      // prevValue === undefined means this is the very first time we've seen this DP.
      if (prevValue === undefined) continue;

      // Doorbell ring event
      if (dp === dpDoorbell && value) {
        this.log('Doorbell rang (DP', dpDoorbell, ')');
        this._triggerRang.trigger(this).catch(() => {});
        this._onDoorbellRang();
      }

      // Motion detection event (raw image DP)
      if (dp === dpMotionEvent && value) {
        this._onMotionDetected();
      }

      // Alarm message (base64 JSON — decodes cmd: ipc_doorbell / ipc_motion)
      if (dpAlarmMsg > 0 && dp === dpAlarmMsg && value) {
        this._handleAlarmMessage(value, dpDoorbell, dpMotionEvent);
      }
    }

    if (changed) {
      this._scheduleStoreSave();
      this._writeDpSnapshot();
    }
  }

  _handleAlarmMessage(rawValue, dpDoorbell, dpMotionEvent) {
    try {
      const json = JSON.parse(Buffer.from(String(rawValue), 'base64').toString('utf8'));
      const cmd = json.cmd || '';
      this.log(`Alarm message cmd: ${cmd}`);
      if (cmd === 'ipc_doorbell') {
        // Only trigger from alarm_message if dp_doorbell is disabled (0) to avoid duplicates
        if (!dpDoorbell) {
          this._triggerRang.trigger(this).catch(() => {});
          this._onDoorbellRang();
        }
      } else if (cmd === 'ipc_motion' || cmd === 'ipc_motion_detect') {
        if (!dpMotionEvent) {
          this._onMotionDetected();
        }
      }
    } catch (_) {
      // Non-base64 or non-JSON payload — ignore
    }
  }

  _onDoorbellRang() {
    if (this.hasCapability('alarm_generic')) {
      this.setCapabilityValue('alarm_generic', true).catch(() => {});
    }
    clearTimeout(this._doorbellResetTimer);
    this._doorbellResetTimer = setTimeout(() => {
      if (this.hasCapability('alarm_generic')) {
        this.setCapabilityValue('alarm_generic', false).catch(() => {});
      }
    }, 5000);
  }

  _onMotionDetected() {
    this.log('Motion detected');

    if (this.hasCapability('alarm_motion')) {
      this.setCapabilityValue('alarm_motion', true).catch(() => {});
    }
    this._triggerMotionDetected.trigger(this).catch(() => {});

    // Auto-reset alarm_motion after the configured period
    clearTimeout(this._motionResetTimer);
    const resetMs = (this.getSetting('motion_reset_seconds') || 30) * 1000;
    this._motionResetTimer = setTimeout(() => {
      if (this.hasCapability('alarm_motion')) {
        this.setCapabilityValue('alarm_motion', false).catch(() => {});
      }
    }, resetMs);
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
  }
}

module.exports = DoorbellDevice;
