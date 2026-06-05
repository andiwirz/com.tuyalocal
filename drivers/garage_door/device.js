'use strict';

const BaseTuyaDevice = require('../../lib/BaseTuyaDevice');

// ── DP → capability mapping ──────────────────────────────────────────────────
//
// WOFEA WF-CS01 / Tuya ckmkzq (standard garage door controller):
// DP 1   switch_1          : bool              — relay toggle (pulse → motor)
// DP 3   doorcontact_state : bool              — magnetic contact (true=closed)
// DP 6   door_control_1    : enum open|close   — combined open/close command
// DP 12  door_state_1      : enum none|unclosed_time|close_time_alarm
//
// ZC34T-03-3A swing arm opener:
// DP 1   state             : string "open"|"closed"       — dp_door_contact = 1
// DP 101 control           : string "open"|"close"|"stop" — dp_door_control = 101
//
// AOSD garage door with light:
// DP 101 control           : string "open"|"close"|"stop" — dp_door_control = 101
// DP 107 action            : string "opened"|"closed"|"opening"|"closing" — dp_door_action = 107
// DP 105 light             : bool                         — dp_light = 105
//
// BoboYun gatePro opener:
// DP 10  action            : string "opened"|"closed"|"opening"|"closing" — dp_door_action = 10
// DP 106 control_open      : bool (send true → open)     — dp_door_open = 106
// DP 107 control_close     : bool (send true → close)    — dp_door_close = 107
// DP 103 control (stop)    : bool (send true → stop)     — dp_switch = 103
// DP 141 alarm             : string event codes          — dp_door_state = 141
// DP 102 light             : bool                        — dp_light = 102
//
// eWeLink-style simple relay:
// DP 1   dpAction          : bool   — relay trigger  → dp_switch = 1
// DP 2   dpStatus          : bool   — door state     → dp_door_contact = 2

// DP_PROFILE entries have a `type` field used in _handleDps to select the right handler:
//   'contact' — bool or string "open"/"closed" → garagedoor_closed
//   'action'  — string "opened"/"closed"/"opening"/"closing" → garagedoor_closed (final-state triggers only)
//   'alarm'   — string alarm state → alarm_generic
//   'switch'  — bool → onoff.light
const DP_PROFILE = [
  { settingKey: 'dp_door_contact', capability: 'garagedoor_closed', type: 'contact', settable: false },
  { settingKey: 'dp_door_action',  capability: 'garagedoor_closed', type: 'action',  settable: false },
  { settingKey: 'dp_door_state',   capability: 'alarm_generic',     type: 'alarm',   settable: false },
  { settingKey: 'dp_light',        capability: 'onoff.light',        type: 'switch',  settable: true  },
];

const OPTIONAL_CAPABILITIES = [
  { setting: 'dp_door_state', capability: 'alarm_generic' },
  { setting: 'dp_light',      capability: 'onoff.light'   },
];

class GarageDoorDevice extends BaseTuyaDevice {
  async onInit() {
    this.log('Device initialized:', this.getName());

    await this._baseInit();
    await this._syncOptionalCapabilities(OPTIONAL_CAPABILITIES);

    // ── Flow trigger cards ───────────────────────────────────────────────────
    this._triggerDoorOpened         = this.homey.flow.getDeviceTriggerCard('garage_door_opened');
    this._triggerDoorClosed         = this.homey.flow.getDeviceTriggerCard('garage_door_closed');
    this._triggerAlarm              = this.homey.flow.getDeviceTriggerCard('garage_door_alarm_triggered');
    this._triggerDeviceConnected    = this.homey.flow.getDeviceTriggerCard('garage_door_device_connected');
    this._triggerDeviceDisconnected = this.homey.flow.getDeviceTriggerCard('garage_door_device_disconnected');
    this._triggerDpChanged          = this.homey.flow.getDeviceTriggerCard('garage_door_dp_changed');

    // ── Capability listeners ─────────────────────────────────────────────────

    // garagedoor_closed — sends command via whichever control scheme is configured.
    // Control priority:
    //  1. use_relay_toggle = true  → relay pulse on dp_switch (1-button cycle, e.g. WOFEA)
    //  2. dp_door_open / dp_door_close  → separate bool DPs (BoboYun)
    //  3. dp_door_control  → combined string "open"/"close" (AOSD / ZC34T)
    //  4. dp_switch fallback  → relay pulse when no control DP is set
    this.registerCapabilityListener('garagedoor_closed', async (value) => {
      const dpOpen    = this.getSetting('dp_door_open');
      const dpClose   = this.getSetting('dp_door_close');
      const dpControl = this.getSetting('dp_door_control');
      const dpSwitch  = this.getSetting('dp_switch');
      const useToggle = this.getSetting('use_relay_toggle') || false;

      if (useToggle && dpSwitch > 0) {
        // 1-button cycle door: pulse the relay regardless of target state.
        // Physical cycle: open → stop → close → stop → open …
        // fireAndForget: WOFEA (and similar single-relay openers) drop the TCP connection
        // immediately after processing the relay pulse.  Awaiting an echo would either
        // block for 5 s (timeout) or throw ECONNRESET — both give the user a spurious
        // error even though the relay DID fire.  With fireAndForget the Promise resolves
        // as soon as the command is dispatched; the reconnect happens transparently.
        //
        // Reset pulse: some devices are edge-triggered — they only fire the relay on a
        // false→true transition.  If DP stays at true after the pulse (no auto-reset),
        // a second set(true) is ignored as "no change".  We send a false reset 300 ms
        // after the pulse so the device DP returns to false, making the next press a
        // valid false→true edge.
        this.log(`Relay pulse (toggle mode): set(${dpSwitch}, true)`);
        await this._set(dpSwitch, true, { fireAndForget: true });
        this.homey.setTimeout(
          () => this._set(dpSwitch, false, { fireAndForget: true }).catch(() => {}),
          300,
        );
      } else if (!value && dpOpen > 0) {
        this.log(`Sending open command: set(${dpOpen}, true)`);
        await this._set(dpOpen, true);
      } else if (value && dpClose > 0) {
        this.log(`Sending close command: set(${dpClose}, true)`);
        await this._set(dpClose, true);
      } else if (dpControl > 0) {
        const cmd = value ? 'close' : 'open';
        this.log(`Sending door command: ${cmd} (DP ${dpControl})`);
        await this._set(dpControl, cmd);
      } else if (dpSwitch > 0) {
        // Fallback: no control DP configured — pulse relay (same edge-reset logic as above).
        this.log(`Relay pulse (fallback): set(${dpSwitch}, true)`);
        await this._set(dpSwitch, true, { fireAndForget: true });
        this.homey.setTimeout(
          () => this._set(dpSwitch, false, { fireAndForget: true }).catch(() => {}),
          300,
        );
      } else {
        throw new Error('No door control DP configured (set dp_door_control or dp_switch)');
      }
    });

    // onoff.light — added dynamically when dp_light > 0
    this._lightListenerRegistered = false;
    this._registerLightListener();

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

      // Generic DP-changed trigger — fires for every changed DP
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

      // ── Contact sensor → garagedoor_closed (bool or string "open"/"closed") ─
      if (entry.type === 'contact') {
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

      // ── Action state → garagedoor_closed ("opened"/"closed"/"opening"/"closing") ─
      // Used by AOSD (DP 107) and BoboYun (DP 10).
      // Triggers opened/closed flow cards only on final states (not while moving).
      if (entry.type === 'action') {
        const actionStr = String(value).toLowerCase();
        const converted = this._actionToBool(actionStr);
        if (converted === null) {
          this.log(`Unknown action state: ${actionStr}`);
          continue;
        }
        const invert = settings.door_contact_invert || false;
        const final  = invert ? !converted : converted;
        const prev   = this.getCapabilityValue('garagedoor_closed');
        await this.setCapabilityValue('garagedoor_closed', final).catch(() => {});
        // Fire trigger only on terminal states — not on "opening" / "closing"
        const isTerminal = actionStr === 'opened' || actionStr === 'closed';
        if (prev !== final && isTerminal) {
          if (final) {
            this._triggerDoorClosed.trigger(this).catch(() => {});
            this.log('Door closed (action state)');
          } else {
            this._triggerDoorOpened.trigger(this).catch(() => {});
            this.log('Door opened (action state)');
          }
        }
        continue;
      }

      // ── Alarm state (WOFEA DP 12 / BoboYun DP 141) ───────────────────────
      // WOFEA values:  none | unclosed_time | close_time_alarm
      // BoboYun values: "No" = clear; any other string = alarm event
      if (entry.type === 'alarm') {
        const valueStr = String(value);
        const isAlarm  = valueStr !== 'none' && valueStr !== 'No';
        await this.setCapabilityValue('alarm_generic', isAlarm).catch(() => {});
        if (isAlarm) {
          this._triggerAlarm.trigger(this, { alarm_state: valueStr }).catch(() => {});
          // Push notification — use a specific "left open" message for known timeout codes,
          // and a generic fault message for any other alarm state (e.g. BoboYun closeLongTime).
          const notifKey = (valueStr === 'unclosed_time' || valueStr === 'openLongTime')
            ? 'notifications.garageDoorOpen'
            : 'notifications.faultAlarm';
          this.homey.notifications.createNotification({
            excerpt: `${this.getName()}: ${this.homey.__(notifKey)}`,
          }).catch(() => {});
        }
        continue;
      }

      // ── Integrated light (AOSD DP 105 / BoboYun DP 102) ─────────────────
      if (entry.type === 'switch') {
        await this.setCapabilityValue('onoff.light', Boolean(value)).catch(() => {});
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
      // If dp_light was just enabled, register its listener for the first time.
      this._registerLightListener();
    }
    // Re-apply contact/action reading immediately when invert flips
    if (changedKeys.includes('door_contact_invert') && this.hasCapability('garagedoor_closed')) {
      // Use newSettings for DP numbers (getSettings() could still hold pre-save values)
      for (const key of ['dp_door_contact', 'dp_door_action']) {
        const dpNum = newSettings[key];
        if (!dpNum || dpNum === 0) continue;
        const rawVal = this._lastDps[String(dpNum)];
        if (rawVal === undefined) continue;
        const invert = newSettings.door_contact_invert;
        const converted = key === 'dp_door_action'
          ? (() => { const b = this._actionToBool(String(rawVal).toLowerCase()); return b === null ? null : (invert ? !b : b); })()
          : this._contactToBool(rawVal, invert);
        if (converted !== null) {
          await this.setCapabilityValue('garagedoor_closed', converted).catch(() => {});
          break;
        }
      }
    }
  }

  // ── Helpers ──────────────────────────────────────────────────────────────────

  /**
   * Register the onoff.light capability listener once.
   * Called from onInit and from onSettings when dp_light is enabled.
   */
  _registerLightListener() {
    if (this._lightListenerRegistered || !this.hasCapability('onoff.light')) return;
    this.registerCapabilityListener('onoff.light', async (value) => {
      const dp = this.getSetting('dp_light');
      if (!dp || dp === 0) throw new Error('Light DP not configured');
      await this._set(dp, Boolean(value));
    });
    this._lightListenerRegistered = true;
    this.log('onoff.light capability listener registered');
  }

  /**
   * Convert a contact DP value to garagedoor_closed bool (true = door closed).
   *  - WOFEA bool DP 3:   true/false  →  direct
   *  - ZC34T string DP 1: "closed"/"open"  →  string compare
   */
  _contactToBool(value, invert = false) {
    const isClosed = typeof value === 'boolean'
      ? value
      : String(value).toLowerCase() === 'closed';
    return invert ? !isClosed : isClosed;
  }

  /**
   * Convert an action-state string to garagedoor_closed bool.
   *  "opened" / "opening" / "partial_opening"  →  false (door open)
   *  "closed" / "closing"                       →  true  (door closed)
   *  anything else                              →  null  (unknown, skip)
   */
  _actionToBool(actionStr) {
    switch (actionStr) {
      case 'opened':
      case 'opening':
      case 'partial_opening':
        return false;
      case 'closed':
      case 'closing':
        return true;
      default:
        return null;
    }
  }
}

module.exports = GarageDoorDevice;
