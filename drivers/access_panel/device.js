'use strict';

const BaseTuyaDevice = require('../../lib/BaseTuyaDevice');

// The booleans that become a capability directly. Each carries its own invert flag,
// because none of these names says which way round it counts: a panel reporting
// open_closedoor = true might mean the door is open or that it is closed, and the
// only way to know is to look at the door.
const BOOLEAN_PROFILE = [
  { settingKey: 'dp_door_contact', capability: 'alarm_contact',       invert: 'door_contact_invert' },
  { settingKey: 'dp_error_alarm',  capability: 'alarm_generic',       invert: null },
  { settingKey: 'dp_tamper_alarm', capability: 'alarm_tamper',        invert: null },
  { settingKey: 'dp_door_alarm',   capability: 'alarm_generic.door',  invert: null },
  { settingKey: 'dp_hold_open',    capability: 'hold_open',           invert: null },
  { settingKey: 'dp_auto_lock',    capability: 'auto_lock',           invert: null },
];

const OPTIONAL_CAPABILITIES = [
  ...BOOLEAN_PROFILE.map(({ settingKey, capability }) => ({ setting: settingKey, capability })),
  { setting: 'dp_lock_state',      capability: 'locked'          },
  { setting: 'dp_doorbell_volume', capability: 'doorbell_volume' },
];

class AccessPanelDevice extends BaseTuyaDevice {
  async onInit() {
    this.log('Access panel initialized:', this.getName());

    await this._baseInit();
    await this._migrateCapabilities([]);
    await this._syncOptionalCapabilities(OPTIONAL_CAPABILITIES);
    await this._syncEnumOptions('doorbell_volume', this.getSetting('volume_values'));

    this._triggerDeviceConnected    = this.homey.flow.getDeviceTriggerCard('access_panel_device_connected');
    this._triggerDeviceDisconnected = this.homey.flow.getDeviceTriggerCard('access_panel_device_disconnected');
    this._triggerDpChanged          = this.homey.flow.getDeviceTriggerCard('access_panel_dp_changed');
    this._triggerDoorbell           = this.homey.flow.getDeviceTriggerCard('access_panel_doorbell_pressed');
    this._triggerLockChanged        = this.homey.flow.getDeviceTriggerCard('access_panel_lock_changed');
    this._triggerDpValue            = this.homey.flow.getDeviceTriggerCard('access_panel_dp_value_changed');

    this._registerListeners();
    await this._connect();
  }

  _registerListeners() {
    const register = (capability, listener) => {
      if (!this.hasCapability(capability)) return;
      if (this._registered && this._registered.has(capability)) return;
      (this._registered = this._registered || new Set()).add(capability);
      this.registerCapabilityListener(capability, listener);
    };

    // Locking and unlocking is off unless the owner switches it on. Two reasons,
    // and both are about a door rather than a lamp. The specification lists
    // lock_motor_state as writable, but on many of these panels a remote unlock
    // actually travels through the encrypted remote-unlock data points, which this
    // app cannot speak — so writing here may do nothing at all. And which way round
    // the boolean counts cannot be read off the name, so a first attempt has an even
    // chance of unlocking a door that was meant to be locked. Better a control the
    // owner deliberately enables after checking than one that ships armed.
    register('locked', async (value) => {
      if (!this.getSetting('allow_lock_control')) {
        throw new Error(this.homey.__('errors.lockControlDisabled'));
      }
      const dp = this.getSetting('dp_lock_state');
      if (!(dp > 0)) {
        throw new Error(this.homey.__('errors.dpNotConfigured', { setting: 'dp_lock_state' }));
      }
      const raw = this.getSetting('lock_state_invert') ? !value : value;
      await this._set(dp, Boolean(raw));
    });

    register('hold_open', async (value) => this.setBooleanDp('dp_hold_open', 'hold_open', value));
    register('auto_lock', async (value) => this.setBooleanDp('dp_auto_lock', 'auto_lock', value));
    register('doorbell_volume', async (value) => this.setDoorbellVolume(value));
  }

  /**
   * The data point numbers this panel has actually sent, for the flow card's list.
   *
   * Taken from what the device reported rather than from a table of numbers,
   * because a list of every possible data point would mostly be entries this model
   * does not have — and the ones it does have are the point.
   */
  reportedDps() {
    const seen = [...(this._seenDps || [])];
    if (seen.length > 0) return seen.sort((a, b) => a - b);
    // Nothing recorded yet — a device added moments ago. Fall back to the numbers
    // the driver is configured for, so the card is not empty on the first day.
    return this._configuredDps();
  }

  /** dp number -> the manufacturer's code name, for labels only. */
  dpCodes() {
    try { return this.getStoreValue('dpCodes') || {}; } catch (e) { return {}; }
  }

  // ── Public, called by the flow actions in driver.js ─────────────────────────

  /**
   * Writes a boolean data point and keeps its capability in step.
   *
   * Throws when the data point is not configured rather than returning quietly: a
   * flow that reports success while changing nothing is how a missing DP number
   * stays hidden, and on an access panel the thing that silently did not happen
   * might be "stop holding the door open".
   */
  async setBooleanDp(settingKey, capability, value) {
    const dp = this.getSetting(settingKey);
    if (!(dp > 0)) {
      throw new Error(this.homey.__('errors.dpNotConfigured', { setting: settingKey }));
    }
    await this._set(dp, Boolean(value));
    if (this.hasCapability(capability)) {
      await this.setCapabilityValue(capability, Boolean(value)).catch(() => {});
    }
    return true;
  }

  /** Writes one of the two timing values, clamped to the range the panel declares. */
  async setNumberDp(settingKey, seconds, min, max) {
    const dp = this.getSetting(settingKey);
    if (!(dp > 0)) {
      throw new Error(this.homey.__('errors.dpNotConfigured', { setting: settingKey }));
    }
    const value = Math.max(min, Math.min(max, Math.round(Number(seconds))));
    await this._set(dp, value);
    return true;
  }

  async setDoorbellVolume(token) {
    const dp = this.getSetting('dp_doorbell_volume');
    if (!(dp > 0)) {
      throw new Error(this.homey.__('errors.dpNotConfigured', { setting: 'dp_doorbell_volume' }));
    }
    await this._set(dp, String(token));
    if (this.hasCapability('doorbell_volume')) {
      await this.setCapabilityValue('doorbell_volume', String(token)).catch(() => {});
    }
    return true;
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

      const previous = this._lastRaw ? this._lastRaw[dpStr] : undefined;
      this._lastRaw = this._lastRaw || {};
      this._lastRaw[dpStr] = value;

      this._triggerDpChanged
        .trigger(this, { dp: dpStr, value: String(value) })
        .catch(() => {});

      // The per-data-point trigger, filtered in the driver by the dp in this state.
      this._triggerDpValue
        .trigger(this, {
          value:          String(value),
          previous_value: previous === undefined ? '' : String(previous),
          code:           this.dpCodes()[dp] || '',
        }, { dp })
        .catch(() => {});

      // ── Doorbell ──────────────────────────────────────────────────────────
      // An event, not a state: two presses in a row carry the same value, so the
      // entry is dropped from the de-duplication cache to let the second one
      // through. The same approach the doorbell driver uses.
      if (settings.dp_doorbell > 0 && dp === settings.dp_doorbell) {
        if (value === true || value === 'true' || value === 1) {
          this._triggerDoorbell.trigger(this).catch(() => {});
        }
        delete this._lastDps[dpStr];
        continue;
      }

      // ── Lock state ────────────────────────────────────────────────────────
      if (settings.dp_lock_state > 0 && dp === settings.dp_lock_state) {
        if (this.hasCapability('locked')) {
          const locked = settings.lock_state_invert ? !value : Boolean(value);
          const prev   = this.getCapabilityValue('locked');
          await this.setCapabilityValue('locked', locked).catch(() => {});
          if (prev !== null && prev !== locked) {
            this._triggerLockChanged.trigger(this, { locked }).catch(() => {});
          }
        }
        continue;
      }

      // ── Doorbell volume ───────────────────────────────────────────────────
      if (settings.dp_doorbell_volume > 0 && dp === settings.dp_doorbell_volume) {
        if (this.hasCapability('doorbell_volume')) {
          await this.setCapabilityValue('doorbell_volume', String(value)).catch(() => {});
        }
        continue;
      }

      // ── The remaining booleans ────────────────────────────────────────────
      const entry = BOOLEAN_PROFILE.find((e) => settings[e.settingKey] > 0
        && dp === settings[e.settingKey]);
      if (entry) {
        if (!this.hasCapability(entry.capability)) continue;
        const flag = entry.invert ? Boolean(settings[entry.invert]) : false;
        await this.setCapabilityValue(entry.capability, flag ? !value : Boolean(value))
          .catch(() => {});
        continue;
      }

      // The two timing values are written by flow actions and carry no capability,
      // so an incoming value only has to be remembered — which the assignment at
      // the top of the loop already did. Naming them here keeps them out of the
      // log: a panel reports both on every full query, and two lines of noise per
      // minute is how a genuinely unknown data point stops being noticed.
      const known = ['dp_auto_lock_time', 'dp_alarm_time']
        .some((k) => settings[k] > 0 && dp === settings[k]);
      if (known) continue;

      // Everything else on this panel is a Raw data point — enrolment, temporary
      // passwords, and the unlock records that would say who opened the door. The
      // format is not published, so they are logged and left alone rather than
      // decoded on a guess.
      this.log(`Unmapped DP ${dp}:`, value);
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
    if (changedKeys.includes('volume_values')) {
      await this._syncEnumOptions('doorbell_volume', this.getSetting('volume_values'));
    }
  }
}

module.exports = AccessPanelDevice;
