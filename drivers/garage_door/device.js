'use strict';

const BaseTuyaDevice = require('../../lib/BaseTuyaDevice');

// ── DP → capability mapping ──────────────────────────────────────────────────
//
// WOFEA WF-CS01 / Tuya category ckmkzq (standard garage door controller):
// DP 1  switch_1          : bool              — relay toggle (momentary pulse, triggers motor)
// DP 3  doorcontact_state : bool              — magnetic contact (true=closed, false=open)
// DP 6  door_control_1    : enum open|close   — open/close command
// DP 12 door_state_1      : enum none|unclosed_time|close_time_alarm — alarm state
//
// ZC34T-03-3A swing arm opener (and similar string-state devices):
// DP 1  state             : string "open"|"closed"        — door state
//                           → set dp_door_contact = 1
// DP 101 control          : string "open"|"close"|"stop"  — command
//                           → set dp_door_control = 101, dp_switch = 0
//
// eWeLink-style simple relay:
// DP 1  dpAction          : bool   — relay trigger  → dp_switch = 1
// DP 2  dpStatus          : bool   — door state     → dp_door_contact = 2

const DP_PROFILE = [
  // Door contact sensor → garagedoor_closed (bool: true = closed, false = open)
  // Controlled by dp_door_contact setting; invert via door_contact_invert checkbox.
  { settingKey: 'dp_door_contact', capability: 'garagedoor_closed', settable: false },
  // Door alarm state (DP 12, optional — 0 = disabled)
  { settingKey: 'dp_door_state',   capability: 'alarm_generic',     settable: false },
];

const OPTIONAL_CAPABILITIES = [
  { setting: 'dp_door_state', capability: 'alarm_generic' },
];

class GarageDoorDevice extends BaseTuyaDevice {
  async onInit() {
    this.log('Device initialized:', this.getName());

    await this._baseInit();
    await this._migrateCapabilities([]);
    await this._syncOptionalCapabilities(OPTIONAL_CAPABILITIES);

    // ── Flow trigger cards ───────────────────────────────────────────────────
    this._triggerDoorOpened         = this.homey.flow.getDeviceTriggerCard('garage_door_opened');
    this._triggerDoorClosed         = this.homey.flow.getDeviceTriggerCard('garage_door_closed');
    this._triggerAlarm              = this.homey.flow.getDeviceTriggerCard('garage_door_alarm_triggered');
    this._triggerDeviceConnected    = this.homey.flow.getDeviceTriggerCard('garage_door_device_connected');
    this._triggerDeviceDisconnected = this.homey.flow.getDeviceTriggerCard('garage_door_device_disconnected');
    this._triggerDpChanged          = this.homey.flow.getDeviceTriggerCard('garage_door_dp_changed');

    // ── Capability listeners ─────────────────────────────────────────────────
    // garagedoor_closed: true = close, false = open
    // Fires when the user taps the tile in Homey or a flow action calls setCapabilityValue.
    this.registerCapabilityListener('garagedoor_closed', async (value) => {
      const dp = this.getSetting('dp_door_control');
      if (!dp || dp === 0) throw new Error('Door control DP not configured');
      const cmd = value ? 'close' : 'open';
      this.log(`Sending door command: ${cmd} (DP ${dp})`);
      await this._conn?.set(dp, cmd);
    });

    await this._connect();
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

      // Fire generic DP-changed trigger for every changed DP (useful for debugging / advanced flows)
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

      // ── Door contact sensor → garagedoor_closed ───────────────────────────
      if (entry.capability === 'garagedoor_closed') {
        const invert    = settings.door_contact_invert || false;
        const converted = this._contactToBool(value, invert);
        const prev      = this.getCapabilityValue('garagedoor_closed');
        await this.setCapabilityValue('garagedoor_closed', converted).catch(() => {});
        if (prev !== converted) {
          if (converted) {
            this._triggerDoorClosed.trigger(this).catch(() => {});
            this.log('Door closed (contact sensor)');
          } else {
            this._triggerDoorOpened.trigger(this).catch(() => {});
            this.log('Door opened (contact sensor)');
          }
        }
        continue;
      }

      // ── Door alarm state (DP 12) ──────────────────────────────────────────
      // none → no alarm; unclosed_time / close_time_alarm → alarm active
      if (entry.capability === 'alarm_generic') {
        const isAlarm = String(value) !== 'none';
        await this.setCapabilityValue('alarm_generic', isAlarm).catch(() => {});
        if (isAlarm) {
          this._triggerAlarm
            .trigger(this, { alarm_state: String(value) })
            .catch(() => {});
          // Push notification for door-left-open alarm
          if (String(value) === 'unclosed_time') {
            this.homey.notifications.createNotification({
              excerpt: `${this.getName()}: ${this.homey.__('notifications.garageDoorOpen')}`,
            }).catch(() => {});
          }
        }
        continue;
      }
    }

    if (changed) {
      this._scheduleStoreSave();
      this._writeDpSnapshot();
    }
  }

  // ── Homey lifecycle ──────────────────────────────────────────────────────────

  async onSettings({ changedKeys, newSettings }) {
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
    // Re-apply the door contact reading immediately when the invert setting changes —
    // otherwise the displayed state stays wrong until the next DP 3 push from the device.
    if (changedKeys.includes('door_contact_invert') && this.hasCapability('garagedoor_closed')) {
      const dpNum = this.getSetting('dp_door_contact');
      const rawVal = this._lastDps[String(dpNum)];
      if (rawVal !== undefined) {
        const converted = this._contactToBool(rawVal, newSettings.door_contact_invert);
        await this.setCapabilityValue('garagedoor_closed', converted).catch(() => {});
      }
    }
  }

  // ── Helpers ──────────────────────────────────────────────────────────────────

  /**
   * Convert a door-contact DP value to a bool (true = door closed).
   * Handles both device types:
   *  - WOFEA (bool DP 3):   true / false  →  direct
   *  - ZC34T (string DP 1): "closed" / "open"  →  string comparison
   */
  _contactToBool(value, invert = false) {
    let isClosed;
    if (typeof value === 'boolean') {
      isClosed = value;
    } else {
      // String-based state DP (ZC34T DP 1: "open" | "closed" | null)
      isClosed = String(value).toLowerCase() === 'closed';
    }
    return invert ? !isClosed : isClosed;
  }
}

module.exports = GarageDoorDevice;
