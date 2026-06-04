'use strict';

const BaseTuyaDevice = require('../../lib/BaseTuyaDevice');

// ── Universal curtain motor driver ────────────────────────────────────────────
//
// Zemismart v1 (category "cl"):
//   DP 1   control          enum open|stop|close
//   DP 2   percent_control  integer 0–100  (0 = closed, 100 = open)
//   DP 5   control_back     bool   — reverse motor direction
//   DP 7   work_state       enum opening|closing  (read-only)
//   DP 10  fault            bitmap
//
// Zemismart v2 (same core, extra DPs):
//   DP 1   control          enum open|stop|close
//   DP 2   percent_control  integer 0–100
//   DP 5   control_back     bool / control_back_mode enum forward|back
//   DP 7   work_state       enum opening|closing
//   DP 12  fault            bitmap (motor_fault)
//   DP 16  border           enum — limit calibration  (device-settings-only)
//   DP 19  position_best    integer — favourite position  (device-settings-only)
//
// Homey mapping:
//   windowcoverings_state  "up"/"idle"/"down"  ↔  "open"/"stop"/"close"
//   windowcoverings_set    0.0 – 1.0           ↔  percent_control 0–100
//     (0.0 = fully closed, 1.0 = fully open; enable invert_position if reversed)
//   alarm_generic          fault bitmap non-zero

const DP_PROFILE = [
  { settingKey: 'dp_control',         capability: 'windowcoverings_state', type: 'control',    settable: true  },
  { settingKey: 'dp_percent_control', capability: 'windowcoverings_set',   type: 'position',   settable: true  },
  { settingKey: 'dp_work_state',      capability: 'windowcoverings_state', type: 'work_state', settable: false },
  { settingKey: 'dp_fault',          capability: 'alarm_generic',          type: 'alarm',      settable: false },
];

const OPTIONAL_CAPABILITIES = [
  { setting: 'dp_fault', capability: 'alarm_generic' },
];

// Tuya control → Homey windowcoverings_state
const CONTROL_TO_STATE = { open: 'up', stop: 'idle', close: 'down' };
// Homey windowcoverings_state → Tuya control
const STATE_TO_CONTROL = { up: 'open', idle: 'stop', down: 'close' };
// Tuya work_state → Homey windowcoverings_state
const WORK_STATE_MAP   = { opening: 'up', closing: 'down' };

class CurtainMotorDevice extends BaseTuyaDevice {
  async onInit() {
    this.log('Device initialized:', this.getName());

    await this._baseInit();

    // Fault-alarm debounce state
    this._connectedAt         = null;
    this._faultAlarmTimer     = null;
    this._faultAlarmConfirmed = false;

    await this._syncOptionalCapabilities(OPTIONAL_CAPABILITIES);

    // ── Flow trigger cards ───────────────────────────────────────────────────
    this._triggerOpened             = this.homey.flow.getDeviceTriggerCard('curtain_opened');
    this._triggerClosed             = this.homey.flow.getDeviceTriggerCard('curtain_closed');
    this._triggerPositionChanged    = this.homey.flow.getDeviceTriggerCard('curtain_position_changed');
    this._triggerFault              = this.homey.flow.getDeviceTriggerCard('curtain_fault_triggered');
    this._triggerDeviceConnected    = this.homey.flow.getDeviceTriggerCard('curtain_device_connected');
    this._triggerDeviceDisconnected = this.homey.flow.getDeviceTriggerCard('curtain_device_disconnected');
    this._triggerDpChanged          = this.homey.flow.getDeviceTriggerCard('curtain_dp_changed');

    // ── Capability listeners ─────────────────────────────────────────────────

    // windowcoverings_state: "up"/"idle"/"down" → open/stop/close
    // invert_control swaps open↔close for devices where the Tuya "open" command
    // physically closes the curtain (common on some Zemismart installations).
    this.registerCapabilityListener('windowcoverings_state', async (value) => {
      const dp     = this.getSetting('dp_control');
      const invert = this.getSetting('invert_control') || false;
      if (!dp || dp === 0) throw new Error('Control DP not configured');
      const cmdMap = invert
        ? { up: 'close', idle: 'stop', down: 'open' }
        : STATE_TO_CONTROL;
      const cmd = cmdMap[value];
      if (!cmd) throw new Error(`Unknown state: ${value}`);
      this.log(`Curtain ${cmd} (DP ${dp})${invert ? ' [inverted]' : ''}`);
      await this._conn?.set(dp, cmd);
    });

    // windowcoverings_set: 0.0–1.0 → 0–100 (with optional inversion)
    this.registerCapabilityListener('windowcoverings_set', async (value) => {
      const dp     = this.getSetting('dp_percent_control');
      const invert = this.getSetting('invert_position') || false;
      if (!dp || dp === 0) throw new Error('Position DP not configured');
      const raw = Math.round(invert ? (1 - value) * 100 : value * 100);
      this.log(`Curtain position → ${raw}% (DP ${dp})`);
      await this._conn?.set(dp, raw);
    });

    await this._connect();
  }

  // ── Hook overrides ────────────────────────────────────────────────────────────

  _onConnected() {
    this._connectedAt         = Date.now();
    clearTimeout(this._faultAlarmTimer);
    this._faultAlarmTimer     = null;
    this._faultAlarmConfirmed = false;
  }

  async _onDeleted() {
    clearTimeout(this._faultAlarmTimer);
  }

  // ── DPS handling ─────────────────────────────────────────────────────────────

  async _handleDps(dps) {
    const settings = this.getSettings();
    let changed = false;

    for (const [dpStr, value] of Object.entries(dps)) {
      if (this._lastDps[dpStr] === value) continue;
      this._lastDps[dpStr] = value;
      changed = true;

      const dp = parseInt(dpStr, 10);

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

      switch (entry.type) {

        // ── Control command echo → windowcoverings_state ──────────────────────
        case 'control': {
          const state = CONTROL_TO_STATE[String(value).toLowerCase()];
          if (state) {
            await this.setCapabilityValue('windowcoverings_state', state).catch(() => {});
          }
          break;
        }

        // ── Movement state → windowcoverings_state ────────────────────────────
        // Overrides the control echo while the motor is actively moving so the
        // tile shows "moving" rather than the last command sent.
        case 'work_state': {
          const state = WORK_STATE_MAP[String(value).toLowerCase()];
          if (state) {
            await this.setCapabilityValue('windowcoverings_state', state).catch(() => {});
          }
          break;
        }

        // ── Position (percent_control 0–100) ──────────────────────────────────
        case 'position': {
          const invert  = settings.invert_position || false;
          const percent = Number(value);
          const homey   = Math.min(1, Math.max(0, invert ? (100 - percent) / 100 : percent / 100));
          const prev    = this.getCapabilityValue('windowcoverings_set');
          await this.setCapabilityValue('windowcoverings_set', homey).catch(() => {});

          // Fire opened/closed triggers when reaching limits
          if (homey >= 1 && (prev === null || prev < 1)) {
            this._triggerOpened.trigger(this).catch(() => {});
          } else if (homey <= 0 && (prev === null || prev > 0)) {
            this._triggerClosed.trigger(this).catch(() => {});
          }
          this._triggerPositionChanged
            .trigger(this, { position: Math.round(homey * 100) })
            .catch(() => {});
          break;
        }

        // ── Fault (bitmap non-zero = fault) ───────────────────────────────────
        case 'alarm': {
          const isAlarm   = typeof value === 'number' ? value !== 0 : Boolean(value);
          const prevAlarm = this.getCapabilityValue('alarm_generic');
          await this.setCapabilityValue('alarm_generic', isAlarm).catch(() => {});

          if (!prevAlarm && isAlarm) {
            const GRACE_MS   = 30_000;
            const elapsed    = this._connectedAt ? Date.now() - this._connectedAt : GRACE_MS;
            const debounceMs = elapsed < GRACE_MS ? GRACE_MS - elapsed + 5_000 : 5_000;
            clearTimeout(this._faultAlarmTimer);
            this._faultAlarmConfirmed = false;
            this._faultAlarmTimer = setTimeout(() => {
              if (this.getCapabilityValue('alarm_generic') === true) {
                this._faultAlarmConfirmed = true;
                this._triggerFault.trigger(this, { fault_code: String(value) }).catch(() => {});
                this.homey.notifications.createNotification({
                  excerpt: `${this.getName()}: ${this.homey.__('notifications.faultAlarm')}`,
                }).catch(() => {});
              }
            }, debounceMs);
          }
          if (prevAlarm && !isAlarm) {
            clearTimeout(this._faultAlarmTimer);
            this._faultAlarmConfirmed = false;
          }
          break;
        }

        default:
          break;
      }
    }

    if (changed) {
      this._scheduleStoreSave();
      this._writeDpSnapshot();
    }
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
    if (changedKeys.some((k) => OPTIONAL_CAPABILITIES.map((o) => o.setting).includes(k))) {
      await this._syncOptionalCapabilities(OPTIONAL_CAPABILITIES);
    }
  }
}

module.exports = CurtainMotorDevice;
