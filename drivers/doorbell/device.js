'use strict';

const BaseTuyaDevice = require('../../lib/BaseTuyaDevice');

// â”€â”€ Marmitek Buzz LO / Tuya category "sp" video doorbell â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
//
// Event DPs (read-only, push-based):
//   DP 136  doorbell_active       string  â€” Unix timestamp string on ring
//   DP 115  movement_detect_pic   raw     â€” raw image on motion detected
//   DP 185  alarm_message         raw     â€” base64 JSON {cmd:"ipc_doorbell"|"ipc_motion",...}
//   DP 154  doorbell_pic          raw     â€” raw image on ring
//
// Control DPs (settable):
//   DP 134  motion_switch         bool    â€” enable/disable motion detection
//   DP 106  motion_sensitivity    enum    â€” 0=low, 1=medium, 2=high
//   DP 108  basic_nightvision     enum    â€” 0=auto, 1=off, 2=color
//   DP 101  basic_indicator       bool    â€” status LED
//   DP 150  record_switch         bool    â€” SD recording
//   DP 157  chime_ring_volume     int     â€” 0â€“100
//   DP 160  basic_device_volume   int     â€” 0â€“10
//
// â”€â”€ Wireless chime / plug-in receiver (a different device family entirely) â”€â”€â”€â”€
//
// These units carry no camera and number their DPs from 1, so none of the defaults
// above apply and every DP has to be pointed at by hand (or by cloud code name):
//   DP 1   doorbell_list_data    raw     â€” list of paired buttons, not an event
//   DP 2   doorbell_ring_value   int     â€” selected ring tone, 0â€“32
//   DP 3   doorbell_volume_value int     â€” volume 0â€“100 (dp_chime_volume)
//   DP 4   switch_night_light    bool    â€” night light (dp_night_light)
//   DP 5   alarm_message         raw     â€” UTF-16BE name of the button that rang
//   DP 10  doorbell_call         int     â€” which button rang, 1â€“8 (dp_doorbell)
//
// The ring payload on these units is constant per button, so the same value
// arrives on every press. That is handled by the event-DP clearing further down,
// which is what makes a repeated identical payload trigger again.

const OPTIONAL_CAPABILITIES = [
  // Motion can arrive on its own event DP or inside the combined alarm message.
  // Chimes have neither, and a permanently-false motion tile on a device that
  // cannot detect motion is worse than no tile at all.
  { setting: ['dp_motion_event', 'dp_alarm_message'], capability: 'alarm_motion' },
  { setting: 'dp_night_light',                        capability: 'onoff.light'  },
];

class DoorbellDevice extends BaseTuyaDevice {
  async onInit() {
    this.log('Device initialized:', this.getName());

    await this._baseInit();

    this._motionResetTimer   = null;
    this._doorbellResetTimer = null;
    // Tracks event DPs that were intentionally cleared from _lastDps after firing,
    // so the seed-protection check does not block the very next occurrence.
    this._eventDpsCleared = new Set();

    if (!this.hasCapability('alarm_generic')) {
      await this.addCapability('alarm_generic');
    }
    await this._syncOptionalCapabilities(OPTIONAL_CAPABILITIES);

    // Night light — only present on chime-style units, hence a sub-capability
    // rather than the device's primary on/off. The flag guards against a second
    // registration from onSettings, which Homey rejects.
    this._nightLightRegistered = false;
    this._registerNightLight();

    // â”€â”€ Flow trigger cards â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    this._triggerRang               = this.homey.flow.getDeviceTriggerCard('doorbell_rang');
    this._triggerMotionDetected     = this.homey.flow.getDeviceTriggerCard('doorbell_motion_detected');
    this._triggerDeviceConnected    = this.homey.flow.getDeviceTriggerCard('doorbell_device_connected');
    this._triggerDeviceDisconnected = this.homey.flow.getDeviceTriggerCard('doorbell_device_disconnected');
    this._triggerDpChanged          = this.homey.flow.getDeviceTriggerCard('doorbell_dp_changed');

    await this._connect();
  }

  /** Reset cleared-event set on every (re)connect so seed protection works correctly. */
  _onConnected() {
    this._eventDpsCleared.clear();
  }

  async _onDeleted() {
    clearTimeout(this._motionResetTimer);
    clearTimeout(this._doorbellResetTimer);
  }

  // â”€â”€ DPS handling â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  async _handleDps(dps) {
    const settings = this.getSettings();
    const dpDoorbell     = settings.dp_doorbell     || 136;
    const dpMotionEvent  = settings.dp_motion_event  || 115;
    const dpAlarmMsg     = settings.dp_alarm_message || 0;
    const dpNightLight   = settings.dp_night_light   || 0;

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

      // Night light state — a plain state DP, so it is mirrored before the seed
      // check below: the tile must show the real state on the first packet too,
      // unlike the event DPs, which must not fire on that packet.
      if (dpNightLight > 0 && dp === dpNightLight && this.hasCapability('onoff.light')) {
        await this.setCapabilityValue('onoff.light', Boolean(value)).catch(() => {});
      }

      // Skip triggering events on the initial seed (first data packet after connect).
      // Bypass seed protection for event DPs that were intentionally cleared after
      // firing — those have been seen before and must be allowed to re-trigger.
      if (prevValue === undefined && !this._eventDpsCleared.has(dpStr)) {
        // …but do not let the seed leave its value behind for an event DP. A camera
        // doorbell reports a fresh timestamp per ring, so a stale entry is harmless
        // there. A wireless chime reports the same payload on every press of a given
        // button — with the seed value remembered, the unchanged-DP skip above would
        // discard every subsequent press of that button for the lifetime of the
        // connection, and the doorbell would simply never fire. Forgetting the value
        // and marking the DP as cleared puts it in the same state as after a ring.
        if (dp === dpDoorbell || dp === dpMotionEvent || (dpAlarmMsg > 0 && dp === dpAlarmMsg)) {
          this._eventDpsCleared.add(dpStr);
          delete this._lastDps[dpStr];
        }
        continue;
      }

      // Doorbell ring event
      if (dp === dpDoorbell && value) {
        this.log('Doorbell rang (DP', dpDoorbell, ')');
        this._triggerRang.trigger(this).catch(() => {});
        this._onDoorbellRang();
        // persist:false — clear so the same timestamp re-triggers on the next ring
        this._eventDpsCleared.add(dpStr);
        delete this._lastDps[dpStr];
      }

      // Motion detection event (raw image DP)
      if (dp === dpMotionEvent && value) {
        this._onMotionDetected();
        // persist:false — clear so identical image blobs re-trigger motion
        this._eventDpsCleared.add(dpStr);
        delete this._lastDps[dpStr];
      }

      // Alarm message (base64 JSON â€” decodes cmd: ipc_doorbell / ipc_motion)
      if (dpAlarmMsg > 0 && dp === dpAlarmMsg && value) {
        this._handleAlarmMessage(value, dpDoorbell, dpMotionEvent);
        // persist:false — clear so identical alarm payloads re-trigger
        this._eventDpsCleared.add(dpStr);
        delete this._lastDps[dpStr];
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
      // Non-base64 or non-JSON payload â€” ignore
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

    // Pointing a DP at a capability, or away from it, has to add or remove that
    // capability straight away — otherwise the tile only appears after a restart.
    const capKeys = ['dp_motion_event', 'dp_alarm_message', 'dp_night_light'];
    if (changedKeys.some((k) => capKeys.includes(k))) {
      await this._syncOptionalCapabilities(OPTIONAL_CAPABILITIES);
      this._registerNightLight();
    }
  }

  _registerNightLight() {
    if (this._nightLightRegistered) return;
    if (!this.hasCapability('onoff.light')) return;
    this._nightLightRegistered = true;
    this.registerCapabilityListener('onoff.light', async (value) => {
      await this._set(this.getSetting('dp_night_light'), Boolean(value));
    });
  }
}

module.exports = DoorbellDevice;
