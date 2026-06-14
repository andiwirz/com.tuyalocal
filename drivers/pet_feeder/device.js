'use strict';

const BaseTuyaDevice = require('../../lib/BaseTuyaDevice');

// ── DP → capability mapping ──────────────────────────────────────────────────
// DP 3  manual_feed     : integer 1–50 (portions to dispense; Petlibro up to 50, others up to 12)
// DP 4  feed_state      : enum standby|feeding|no_food|error_ir|feed_timeout|(done)
// DP 14 fault           : bitfield  1=no_food  2=jammed  4=feed_timeout  8=battery_low
// DP 15 feed_report     : integer 0–50 (actual servings dispensed — report only)
// DP 16 surplus_grain   : integer 0–100 % (remaining food — report only)
// DP 102+/108+ food_level : non-standard enum full|low|empty (custom/legacy firmware, e.g. Petlibro DP 108)

const DP_PROFILE = [
  // feed_portions is an enum picker — device sends integers, we map to string IDs.
  // Guard against 0: some devices (e.g. Petlibro Granary) echo 0 for write-only DPs on connect.
  { settingKey: 'dp_portions',        capability: 'feed_portions',   transform: (v) => v > 0 ? String(v) : null, settable: true  },
  { settingKey: 'dp_motor_state',     capability: 'motor_state',     transform: (v) => String(v),       settable: false },
  { settingKey: 'dp_fault',           capability: 'alarm_generic',   transform: (v) => Number(v) > 0,   settable: false },
  { settingKey: 'dp_food_level',      capability: 'food_status',     transform: (v) => String(v),       settable: false },
  { settingKey: 'dp_surplus_grain',   capability: 'surplus_grain',   transform: (v) => Number(v),       settable: false },
  { settingKey: 'dp_feed_report',     capability: 'feed_report',     transform: (v) => Number(v),       settable: false },
  { settingKey: 'dp_child_lock',      capability: 'child_lock',      transform: (v) => Boolean(v),      settable: true  },
  // Battery percentage (0–100 %). Present on battery-powered feeders (e.g. Arlec 5L DP 11).
  // Disabled by default — most feeders are AC-powered.
  { settingKey: 'dp_battery',         capability: 'measure_battery', transform: (v) => Number(v),       settable: false },
  // ── New optional DPs ────────────────────────────────────────────────────────
  // DP 19  indicator_light : boolean — LED indicator on/off (settable)
  // DP 103 voice_playback  : boolean — mealtime recording on/off (settable)
  // DP 101 battery_status  : enum    — High/Medium/Low (report only)
  // DP 18  voice_times     : number  — recording repetitions (settable via device setting)
  // DP 106 manual_button_portions : number — portions per button press (settable via device setting)
  { settingKey: 'dp_indicator_light', capability: 'indicator_light', transform: (v) => Boolean(v),      settable: true  },
  { settingKey: 'dp_voice_playback',  capability: 'voice_playback',  transform: (v) => Boolean(v),      settable: true  },
  { settingKey: 'dp_battery_status',  capability: 'battery_status',  transform: (v) => String(v).toLowerCase(), settable: false },
];

// DPs that map to device settings (not capabilities) — written to device on settings change,
// and settings are updated when the device reports them.
const SETTINGS_DPS = [
  { settingKey: 'dp_voice_times',          valueSetting: 'voice_times',           transform: (v) => Number(v) },
  { settingKey: 'dp_manual_button_portions', valueSetting: 'manual_button_portions', transform: (v) => Number(v) },
];

const OPTIONAL_CAPABILITIES = [
  { setting: 'dp_motor_state',       capability: 'motor_state'      },
  { setting: 'dp_fault',             capability: 'alarm_generic'    },
  { setting: 'dp_food_level',        capability: 'food_status'      },
  { setting: 'dp_surplus_grain',     capability: 'surplus_grain'    },
  { setting: 'dp_feed_report',       capability: 'feed_report'      },
  { setting: 'dp_child_lock',        capability: 'child_lock'       },
  { setting: 'dp_battery',           capability: 'measure_battery'  },
  { setting: 'dp_indicator_light',   capability: 'indicator_light'  },
  { setting: 'dp_voice_playback',    capability: 'voice_playback'   },
  { setting: 'dp_battery_status',    capability: 'battery_status'   },
];

class PetFeederDevice extends BaseTuyaDevice {
  async onInit() {
    this.log('Device initialized:', this.getName());

    await this._baseInit();

    // ── Migrate feed_portions: number/slider → enum/picker ───────────────────
    // If the old capability options contain a numeric 'min' key it was the legacy
    // slider type — remove and re-add so Homey registers it as an enum.
    if (this.hasCapability('feed_portions')) {
      const opts = this.getCapabilityOptions('feed_portions') || {};
      if (opts.min !== undefined) {
        this.log('Migrating feed_portions: slider → picker');
        await this.removeCapability('feed_portions').catch(() => {});
        await this.addCapability('feed_portions').catch(() => {});
      }
    }

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
      if (!this.hasCapability(entry.capability)) continue;

      if (entry.capability === 'feed_portions') {
        // Non-persistent: after a manual feed command is sent, reset the picker
        // back to portions_min so the UI is ready for the next feed.
        // The reset is delayed 3 s to allow the device to process the command first.
        // The capability is an enum — values are strings; send as Number to the device.
        this.registerCapabilityListener('feed_portions', async (value) => {
          await this._set(this.getSetting('dp_portions'), Number(value));
          setTimeout(() => {
            const resetTo = String(this.getSetting('portions_min') ?? 1);
            this.setCapabilityValue('feed_portions', resetTo).catch(() => {});
          }, 3000);
        });
      } else {
        this.registerCapabilityListener(entry.capability, async (value) => {
          await this._set(this.getSetting(entry.settingKey), value);
        });
      }
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

      const dp = parseInt(dpStr, 10);

      this._triggerDpChanged
        .trigger(this, { dp: dpStr, value: String(value) })
        .catch(() => {});

      // ── Settings-backed DPs (voice_times, manual_button_portions) ──────────
      // These DPs map to device settings, not capabilities — handle before DP_PROFILE lookup.
      const settingsDp = SETTINGS_DPS.find((s) => {
        const dpNum = settings[s.settingKey];
        return dpNum > 0 && dp === dpNum;
      });
      if (settingsDp) {
        await this.setSettings({ [settingsDp.valueSetting]: settingsDp.transform(value) }).catch(() => {});
        continue;
      }

      const entry = DP_PROFILE.find((e) => {
        const dpNum = settings[e.settingKey];
        return dpNum > 0 && dp === dpNum;
      });

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

  // ── Portions picker range ────────────────────────────────────────────────────
  // Builds enum values from portions_min..portions_max so the picker only shows
  // the entries that the device actually supports.

  async _syncPortionsRange() {
    const min = this.getSetting('portions_min') ?? 1;
    const max = this.getSetting('portions_max') ?? 12;
    const values = [];
    for (let i = min; i <= max; i++) {
      const s = String(i);
      values.push({ id: s, title: { en: s, de: s } });
    }
    try {
      await this.setCapabilityOptions('feed_portions', { values });
      this.log(`feed_portions picker → ${min}–${max} (${values.length} options)`);
    } catch (err) {
      this.log('setCapabilityOptions(feed_portions) failed:', err.message);
    }
  }

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
    if (changedKeys.includes('portions_min') || changedKeys.includes('portions_max')) {
      await this._syncPortionsRange();
    }

    // ── Write settings-backed DPs to device when value changes ───────────────
    for (const entry of SETTINGS_DPS) {
      if (!changedKeys.includes(entry.valueSetting)) continue;
      const dp = newSettings[entry.settingKey] ?? this.getSetting(entry.settingKey);
      if (dp > 0) {
        await this._set(dp, newSettings[entry.valueSetting]).catch((err) => {
          this.log(`Failed to write ${entry.valueSetting} to DP ${dp}:`, err.message);
        });
      }
    }
  }
}

module.exports = PetFeederDevice;
