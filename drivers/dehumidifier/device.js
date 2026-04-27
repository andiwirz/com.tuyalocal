'use strict';

const BaseTuyaDevice = require('../../lib/BaseTuyaDevice');

const DEBOUNCE_MS = 300; // debounce delay for slider capabilities

// Maps settings keys → Homey capabilities.
// settable: false = read-only, no capability listener registered.
// debounce: true  = delay physical command to avoid rapid-fire sends (e.g. sliders).
const DP_PROFILE = [
  { settingKey: 'dp_onoff',            capability: 'onoff',               transform: (v) => Boolean(v),     settable: true               },
  { settingKey: 'dp_current_humidity', capability: 'measure_humidity',    transform: (v) => Number(v),      settable: false              },
  { settingKey: 'dp_target_humidity',  capability: 'target_humidity',     transform: (v) => Number(v),      settable: true, debounce: true },
  { settingKey: 'dp_fan_speed',        capability: 'fan_speed',           transform: (v) => String(v),      settable: true               },
  { settingKey: 'dp_mode',             capability: 'mode',                transform: (v) => String(v),      settable: true               },
  { settingKey: 'dp_countdown_left',   capability: 'countdown_left',      transform: (v) => Number(v),      settable: false              },
  { settingKey: 'dp_countdown_timer',  capability: 'countdown_timer',     transform: (v) => String(v),      settable: true               },
  { settingKey: 'dp_child_lock',       capability: 'child_lock',          transform: (v) => Boolean(v),     settable: true               },
  { settingKey: 'dp_water_full',       capability: 'alarm_water',         transform: (v) => Boolean(v),     settable: false              },
  { settingKey: 'dp_temperature',      capability: 'measure_temperature', transform: (v) => Number(v) / 10, settable: false              },
  { settingKey: 'dp_anion',            capability: 'anion',               transform: (v) => Boolean(v),     settable: true               },
];

const OPTIONAL_CAPABILITIES = [
  { setting: 'dp_temperature',     capability: 'measure_temperature' },
  { setting: 'dp_anion',           capability: 'anion'               },
  { setting: 'dp_child_lock',      capability: 'child_lock'          },
  { setting: 'dp_countdown_timer', capability: 'countdown_timer'     },
  { setting: 'dp_countdown_left',  capability: 'countdown_left'      },
  { setting: 'dp_water_full',      capability: 'alarm_water'         },
];

class DehumidifierDevice extends BaseTuyaDevice {
  async onInit() {
    this.log('Device initialized:', this.getName());

    await this._baseInit();

    // Driver-specific state
    this._waterAlarmTimer     = null;  // debounce: prevents spurious reconnect triggers
    this._waterAlarmConfirmed = false; // true only after alarm stayed true for debounce period
    this._connectedAt         = null;  // timestamp of last successful connect — used for grace period

    // Restore _alarmFalseSince from the device store so the oscillation guard survives
    // Homey restarts.  Without persistence, a restart resets the timestamp to "now",
    // allowing the next hourly firmware pulse to pass the guard immediately.
    try {
      const stored = this.getStoreValue('alarmFalseSince');
      this._alarmFalseSince = (typeof stored === 'number') ? stored : null;
    } catch (e) { this._alarmFalseSince = null; }

    await this._migrateCapabilities([]);
    await this._syncOptionalCapabilities(OPTIONAL_CAPABILITIES);
    await this._syncEnumOptions('mode',      this.getSetting('mode_values'));
    await this._syncEnumOptions('fan_speed', this.getSetting('fan_speed_values'));

    // ── Flow trigger cards ───────────────────────────────────────────────────
    // RunListeners for humidity_above/below are registered once in driver.js onInit.
    this._triggerHumidityAbove      = this.homey.flow.getDeviceTriggerCard('humidity_above');
    this._triggerHumidityBelow      = this.homey.flow.getDeviceTriggerCard('humidity_below');
    this._triggerWaterFull          = this.homey.flow.getDeviceTriggerCard('water_tank_full');
    this._triggerWaterEmptied       = this.homey.flow.getDeviceTriggerCard('water_tank_emptied');
    this._triggerDeviceConnected    = this.homey.flow.getDeviceTriggerCard('device_connected');
    this._triggerDeviceDisconnected = this.homey.flow.getDeviceTriggerCard('device_disconnected');
    this._triggerDpChanged          = this.homey.flow.getDeviceTriggerCard('dp_changed');

    // ── Capability listeners (auto-registered from DP_PROFILE) ──────────────
    for (const entry of DP_PROFILE) {
      if (!entry.settable) continue;

      if (entry.debounce) {
        let timer = null;
        this.registerCapabilityListener(entry.capability, (value) => {
          clearTimeout(timer);
          // Resolve immediately so Homey UI stays responsive; command is delayed.
          return new Promise((resolve) => {
            timer = setTimeout(() => {
              this._conn?.set(this.getSetting(entry.settingKey), value)
                .then(resolve).catch(resolve);
            }, DEBOUNCE_MS);
          });
        });
      } else {
        this.registerCapabilityListener(entry.capability, async (value) => {
          await this._conn?.set(this.getSetting(entry.settingKey), value);
        });
      }
    }

    await this._connect();
  }

  // ── Hook overrides ───────────────────────────────────────────────────────────

  /** Reset alarm state on (re)connect. */
  _onConnected() {
    this._connectedAt = Date.now();
    // Clear any pending alarm timer from the previous connection cycle.
    clearTimeout(this._waterAlarmTimer);
    this._waterAlarmTimer     = null;
    this._waterAlarmConfirmed = false;
    // Seed _alarmFalseSince only if we have no stored value.  The persisted
    // timestamp is far more accurate (could be hours old) — overwriting it with
    // "now" on every reconnect was resetting the oscillation guard and allowing
    // the next hourly firmware pulse to pass through.
    if (!this.getCapabilityValue('alarm_water') && this._alarmFalseSince === null) {
      this._setAlarmFalseSince(Date.now());
    }
  }

  async _onDeleted() {
    clearTimeout(this._waterAlarmTimer);
  }

  /** Update _alarmFalseSince and persist it so the oscillation guard survives restarts. */
  _setAlarmFalseSince(time) {
    this._alarmFalseSince = time;
    this.setStoreValue('alarmFalseSince', time).catch(() => {});
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

      // Generic dp_changed trigger fires for every changed DP.
      this._triggerDpChanged
        .trigger(this, { dp: dpStr, value: String(value) })
        .catch(() => {});

      if (!entry) {
        this.log(`Unknown DP ${dp}:`, value);
        continue;
      }

      const converted = entry.transform(value);

      if (entry.capability === 'measure_humidity') {
        const prevHumidity = this.getCapabilityValue('measure_humidity') || 0;
        await this.setCapabilityValue('measure_humidity', converted).catch(() => {});
        const trend  = converted > prevHumidity ? 'up' : 'down';
        const tokens = { humidity: converted, prevHumidity, trend };
        const state  = { humidity: converted, prevHumidity };
        this._triggerHumidityAbove.trigger(this, tokens, state).catch(() => {});
        this._triggerHumidityBelow.trigger(this, tokens, state).catch(() => {});
        continue;
      }

      if (entry.capability === 'alarm_water') {
        const prevWater = this.getCapabilityValue('alarm_water');
        await this.setCapabilityValue('alarm_water', converted).catch(() => {});

        if (!prevWater && converted) {
          // ── Oscillation guard ────────────────────────────────────────────────
          // Some devices emit a spurious alarm_water=true pulse periodically (e.g.
          // every hour on reconnect or firmware heartbeat).  Require the alarm to
          // have been continuously false for MIN_FALSE_MS before we even start the
          // confirmation debounce.  The window is long enough to outlast the device's
          // pulse interval — if the pulse repeats every ~60 min the false period is
          // ~57 min, so a 2-hour guard will always suppress it.
          const guardHours   = this.getSetting('alarm_guard_hours') ?? 2;
          const MIN_FALSE_MS = guardHours * 60 * 60 * 1000;
          const now          = Date.now();
          if (this._alarmFalseSince !== null && now - this._alarmFalseSince < MIN_FALSE_MS) {
            this._appLog(
              `alarm_water: suppressed — was false for only ` +
              `${Math.round((now - this._alarmFalseSince) / 60000)} min (< ${MIN_FALSE_MS / 60000} min)`,
              'info',
            );
            continue;
          }

          // ── Confirmation debounce ────────────────────────────────────────────
          // Alarm must stay true continuously for MIN_CONFIRM_MS before we fire.
          // 10 minutes absorbs short firmware pulses that pass the oscillation guard
          // (e.g. because the device was genuinely false for > 2 h before the pulse).
          const MIN_CONFIRM_MS = 10 * 60 * 1000; // 10 minutes
          const GRACE_MS       = 90_000;
          const elapsed        = this._connectedAt ? now - this._connectedAt : GRACE_MS;
          const remaining      = Math.max(0, GRACE_MS - elapsed);
          const debounceMs     = Math.max(MIN_CONFIRM_MS, remaining + 5_000);

          this._appLog(
            `alarm_water: true — waiting ${Math.round(debounceMs / 1000)} s for confirmation`,
            'info',
          );

          clearTimeout(this._waterAlarmTimer);
          this._waterAlarmConfirmed = false;
          this._waterAlarmTimer = setTimeout(() => {
            if (this.getCapabilityValue('alarm_water') === true) {
              this._waterAlarmConfirmed = true;
              this._triggerWaterFull.trigger(this).catch(() => {});
              this.homey.notifications.createNotification({
                excerpt: `${this.getName()}: ${this.homey.__('notifications.waterFull')}`,
              }).catch(() => {});
            }
          }, debounceMs);
        }

        if (prevWater && !converted) {
          clearTimeout(this._waterAlarmTimer);
          this._setAlarmFalseSince(Date.now()); // persist — survives Homey restarts
          // Only fire "water emptied" if "water full" was genuinely confirmed,
          // so the false that follows a spurious true is silently swallowed.
          if (this._waterAlarmConfirmed) {
            this._triggerWaterEmptied.trigger(this).catch(() => {});
          }
          this._waterAlarmConfirmed = false;
        }
        continue;
      }

      await this.setCapabilityValue(entry.capability, converted).catch(() => {});
    }

    // Debounced persistence — avoids hammering storage on every DPS packet.
    if (changed) {
      this._scheduleStoreSave();
      this._writeDpSnapshot();
    }
  }

  // ── Homey lifecycle ──────────────────────────────────────────────────────────

  async onSettings({ changedKeys }) {
    const connectionKeys = ['ip', 'device_id', 'local_key', 'version'];
    if (changedKeys.some((k) => connectionKeys.includes(k))) {
      this.log('Connection settings changed, reconnecting');
      await this._connect();
      return; // reconnect picks up everything else
    }
    if (changedKeys.includes('polling_interval')) {
      this.log('Polling interval changed, restarting polling');
      this._startPolling();
    }
    if (changedKeys.some((k) => OPTIONAL_CAPABILITIES.map((o) => o.setting).includes(k))) {
      await this._syncOptionalCapabilities(OPTIONAL_CAPABILITIES);
    }
    if (changedKeys.some((k) => ['mode_values', 'fan_speed_values'].includes(k))) {
      await this._syncEnumOptions('mode',      this.getSetting('mode_values'));
      await this._syncEnumOptions('fan_speed', this.getSetting('fan_speed_values'));
    }
  }
}

module.exports = DehumidifierDevice;
