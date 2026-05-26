'use strict';

const BaseTuyaDevice = require('../../lib/BaseTuyaDevice');

// ── DP → capability mapping ──────────────────────────────────────────────────
// DP 3  manual_feed     : integer 1–12 (portions to dispense)
// DP 4  feed_state      : enum standby|feeding|no_food|error_ir|feed_timeout|(done)
// DP 14 fault           : bitfield  1=no_food  2=jammed  4=feed_timeout  8=battery_low
// DP 15 feed_report     : integer 0–12 (actual servings dispensed — report only)
// DP 16 surplus_grain   : integer 0–100 % (remaining food — report only)
// DP 102+ food_level    : non-standard enum full|low|empty (custom/legacy firmware)

const DP_PROFILE = [
  { settingKey: 'dp_portions',      capability: 'feed_portions',  transform: (v) => Number(v),       settable: true  },
  { settingKey: 'dp_motor_state',   capability: 'motor_state',    transform: (v) => String(v),       settable: false },
  { settingKey: 'dp_fault',         capability: 'alarm_generic',  transform: (v) => Number(v) > 0,   settable: false },
  { settingKey: 'dp_food_level',    capability: 'food_status',    transform: (v) => String(v),       settable: false },
  { settingKey: 'dp_surplus_grain', capability: 'surplus_grain',  transform: (v) => Number(v),       settable: false },
  { settingKey: 'dp_feed_report',   capability: 'feed_report',    transform: (v) => Number(v),       settable: false },
  { settingKey: 'dp_child_lock',    capability: 'child_lock',     transform: (v) => Boolean(v),      settable: true  },
];

const OPTIONAL_CAPABILITIES = [
  { setting: 'dp_motor_state',   capability: 'motor_state'   },
  { setting: 'dp_fault',         capability: 'alarm_generic' },
  { setting: 'dp_food_level',    capability: 'food_status'   },
  { setting: 'dp_surplus_grain', capability: 'surplus_grain' },
  { setting: 'dp_feed_report',   capability: 'feed_report'   },
  { setting: 'dp_child_lock',    capability: 'child_lock'    },
];

class PetFeederDevice extends BaseTuyaDevice {
  async onInit() {
    this.log('Device initialized:', this.getName());

    await this._baseInit();
    await this._migrateCapabilities([]);
    await this._syncOptionalCapabilities(OPTIONAL_CAPABILITIES);
    await this._syncPortionsRange();

    // ── Flow trigger cards ───────────────────────────────────────────────────
    this._triggerFoodLevelChanged    = this.homey.flow.getDeviceTriggerCard('feeder_food_level_changed');
    this._triggerFeedingDone         = this.homey.flow.getDeviceTriggerCard('feeder_feeding_done');
    this._triggerDeviceConnected     = this.homey.flow.getDeviceTriggerCard('feeder_device_connected');
    this._triggerDeviceDisconnected  = this.homey.flow.getDeviceTriggerCard('feeder_device_disconnected');
    this._triggerDpChanged           = this.homey.flow.getDeviceTriggerCard('feeder_dp_changed');

    // ── Capability listeners ─────────────────────────────────────────────────
    for (const entry of DP_PROFILE) {
      if (!entry.settable) continue;
      this.registerCapabilityListener(entry.capability, async (value) => {
        await this._conn?.set(this.getSetting(entry.settingKey), value);
      });
    }

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

      const dp    = parseInt(dpStr, 10);
      const entry = DP_PROFILE.find((e) => {
        const dpNum = settings[e.settingKey];
        return dpNum > 0 && dp === dpNum;
      });

      this._triggerDpChanged
        .trigger(this, { dp: dpStr, value: String(value) })
        .catch(() => {});

      if (!entry) {
        this.log(`Unknown DP ${dp}:`, value);
        continue;
      }

      const converted = entry.transform(value);

      // ── Fault (DP 14: bitfield 1=no_food 2=jammed 4=feed_timeout 8=battery_low) ──
      if (entry.capability === 'alarm_generic') {
        await this.setCapabilityValue('alarm_generic', converted).catch(() => {});
        continue;
      }

      // ── Motor / feed state (DP 4) ────────────────────────────────────────
      if (entry.capability === 'motor_state') {
        const prev = this.getCapabilityValue('motor_state');
        await this.setCapabilityValue('motor_state', converted).catch(() => {});

        // Feeding done:
        //   • "done"    — Tuya spec terminal state (some firmwares)
        //   • standby ← feeding — iPettie / Petlibro W5 (no "done" state on this device)
        //   Ignore standby ← no_food / error_ir / feed_timeout (error paths, not successful feed)
        const feedingComplete =
          converted === 'done' ||
          (converted === 'standby' && prev === 'feeding');
        if (feedingComplete) {
          this._triggerFeedingDone.trigger(this).catch(() => {});
        }

        // "no_food" means the motor tried to run but the hopper was empty.
        // Treat it the same as a food-empty condition and notify the user —
        // even if no separate food_status DP is configured.
        if (converted === 'no_food') {
          this.homey.notifications.createNotification({
            excerpt: `${this.getName()}: ${this.homey.__('notifications.foodEmpty')}`,
          }).catch(() => {});
          // Also fire the food-level-changed trigger so flows can react.
          this._triggerFoodLevelChanged
            .trigger(this, { food_status: 'empty', prev_status: prev || 'full' })
            .catch(() => {});
        }
        continue;
      }

      // ── Custom food-level DP (non-standard, e.g. DP 101/102) ────────────
      if (entry.capability === 'food_status') {
        const prev = this.getCapabilityValue('food_status');
        await this.setCapabilityValue('food_status', converted).catch(() => {});
        if (prev !== converted) {
          this._triggerFoodLevelChanged
            .trigger(this, { food_status: converted, prev_status: prev || 'full' })
            .catch(() => {});

          const emptyValues = (this.getSetting('food_empty_values') || 'low,empty')
            .split(',').map((s) => s.trim().toLowerCase());
          const wasEmpty   = emptyValues.includes((prev || '').toLowerCase());
          const isNowEmpty = emptyValues.includes(converted.toLowerCase());
          if (isNowEmpty && !wasEmpty) {
            this.homey.notifications.createNotification({
              excerpt: `${this.getName()}: ${this.homey.__('notifications.foodEmpty')}`,
            }).catch(() => {});
          }
        }
        continue;
      }

      await this.setCapabilityValue(entry.capability, converted).catch(() => {});
    }

    if (changed) {
      this._scheduleStoreSave();
      this._writeDpSnapshot();
    }
  }

  // ── Homey lifecycle ──────────────────────────────────────────────────────────

  // ── Portions slider range ────────────────────────────────────────────────────

  async _syncPortionsRange() {
    const min = this.getSetting('portions_min') ?? 1;
    const max = this.getSetting('portions_max') ?? 12;
    try {
      await this.setCapabilityOptions('feed_portions', { min, max });
      this.log(`feed_portions range → ${min}–${max}`);
    } catch (err) {
      this.log('setCapabilityOptions(feed_portions) failed:', err.message);
    }
  }

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
    if (changedKeys.includes('portions_min') || changedKeys.includes('portions_max')) {
      await this._syncPortionsRange();
    }
  }
}

module.exports = PetFeederDevice;
