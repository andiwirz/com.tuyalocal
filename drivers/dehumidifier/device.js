'use strict';

const BaseTuyaDevice = require('../../lib/BaseTuyaDevice');

const DEBOUNCE_MS = 300; // debounce delay for slider capabilities

// Some devices (e.g. Klarstein Dryfy) transmit the timer DP as a plain numeric
// enum ("0".."24") instead of the "cancel"/"1h".."24h" strings the countdown_timer
// capability expects. dp_countdown_timer_numeric enables translation both ways.
function countdownRawToCap(rawValue) {
  const s = String(rawValue);
  if (s === '0') return 'cancel';
  return /^\d+$/.test(s) ? `${s}h` : s;
}
function countdownCapToRaw(capValue) {
  if (capValue === 'cancel') return '0';
  const m = String(capValue).match(/^(\d+)h$/);
  return m ? m[1] : capValue;
}

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
  { settingKey: 'dp_temperature',      capability: 'measure_temperature', transform: (v) => Number(v),      settable: false              },
  { settingKey: 'dp_anion',            capability: 'anion',               transform: (v) => Boolean(v),     settable: true               },
  // Optional extra boolean DPs (enabled when DP > 0)
  { settingKey: 'dp_oscillate',        capability: 'oscillate',           transform: (v) => Boolean(v),     settable: true               },
  { settingKey: 'dp_self_clean',       capability: 'self_clean',          transform: (v) => Boolean(v),     settable: true               },
  { settingKey: 'dp_pump',             capability: 'pump',                transform: (v) => Boolean(v),     settable: true               },
];

const OPTIONAL_CAPABILITIES = [
  { setting: 'dp_temperature',     capability: 'measure_temperature' },
  { setting: 'dp_anion',           capability: 'anion'               },
  { setting: 'dp_child_lock',      capability: 'child_lock'          },
  { setting: 'dp_countdown_timer', capability: 'countdown_timer'     },
  { setting: 'dp_countdown_left',  capability: 'countdown_left'      },
  { setting: 'dp_water_full',      capability: 'alarm_water'         },
  { setting: 'dp_oscillate',       capability: 'oscillate'           },
  { setting: 'dp_self_clean',      capability: 'self_clean'          },
  { setting: 'dp_pump',            capability: 'pump'                },
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

    // ── Flow trigger cards ──────────────────────────────────────────────────
    // RunListeners for humidity_above/below are registered once in driver.js onInit.
    this._triggerHumidityAbove      = this.homey.flow.getDeviceTriggerCard('dehumidifier_humidity_above');
    this._triggerHumidityBelow      = this.homey.flow.getDeviceTriggerCard('dehumidifier_humidity_below');
    this._triggerWaterFull          = this.homey.flow.getDeviceTriggerCard('dehumidifier_water_tank_full');
    this._triggerWaterEmptied       = this.homey.flow.getDeviceTriggerCard('dehumidifier_water_tank_emptied');
    this._triggerDeviceConnected    = this.homey.flow.getDeviceTriggerCard('dehumidifier_device_connected');
    this._triggerDeviceDisconnected = this.homey.flow.getDeviceTriggerCard('dehumidifier_device_disconnected');
    this._triggerDpChanged          = this.homey.flow.getDeviceTriggerCard('dehumidifier_dp_changed');

    // Ohne diese Zuordnung schreibt _applyCapability nur den Wert; mit ihr
    // meldet es zusaetzlich einen echten Wechsel an die Flow-Karte.
    this._registerChangeTriggers({
      child_lock: 'dehumidifier_child_lock_changed',
      oscillate: 'dehumidifier_oscillate_changed',
    });

    // ── Capability listeners (auto-registered from DP_PROFILE) ──────────────
    // Registered via _registerListeners() so that capabilities enabled later
    // through device settings (e.g. dp_oscillate, dp_pump) become controllable
    // immediately — without requiring an app restart.
    this._registeredCaps = new Set();
    this._registerListeners();

    await this._connect();
  }

  /**
   * Register capability listeners for all currently present capabilities.
   * Safe to call repeatedly (e.g. from onSettings after _syncOptionalCapabilities):
   * each capability is only registered once per device lifetime.
   */
  _registerListeners() {
    for (const entry of DP_PROFILE) {
      if (!entry.settable) continue;
      if (!this.hasCapability(entry.capability)) continue;
      if (this._registeredCaps.has(entry.capability)) continue;
      this._registeredCaps.add(entry.capability);

      if (entry.debounce) {
        let timer = null;
        this.registerCapabilityListener(entry.capability, (value) => {
          clearTimeout(timer);
          // Resolve immediately so Homey UI stays responsive; command is delayed.
          return new Promise((resolve) => {
            timer = setTimeout(() => {
              this._set(this.getSetting(entry.settingKey), value)
                .then(resolve).catch(resolve);
            }, DEBOUNCE_MS);
          });
        });
      } else if (entry.capability === 'countdown_timer') {
        this.registerCapabilityListener('countdown_timer', async (value) => {
          const raw = this.getSetting('dp_countdown_timer_numeric')
            ? countdownCapToRaw(value)
            : value;
          await this._set(this.getSetting(entry.settingKey), raw);
        });
      } else {
        this.registerCapabilityListener(entry.capability, async (value) => {
          await this._set(this.getSetting(entry.settingKey), value);
        });
      }
    }
  }

  // ── Hook overrides ─────────────────────────────────────────────────────────

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

  // ── DPS handling ───────────────────────────────────────────────────────────

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
          // ── Oscillation guard ────────────────────────────────────────────
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

          // ── Confirmation debounce ────────────────────────────────────────
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
            // Both outcomes are logged. Without this the log showed the wait starting
            // and then nothing at all, so a real tank alarm could not be told from a
            // spurious pulse the debounce had swallowed — three of them over eight days
            // left no trace either way.
            if (this.getCapabilityValue('alarm_water') === true) {
              this._waterAlarmConfirmed = true;
              this._appLog('alarm_water: still true after the wait — tank full, notifying', 'warn');
              this._triggerWaterFull.trigger(this).catch(() => {});
              this.homey.notifications.createNotification({
                excerpt: `${this.getName()}: ${this.homey.__('notifications.waterFull')}`,
              }).catch(() => {});
            } else {
              this._appLog('alarm_water: cleared during the wait — spurious pulse, not reported', 'info');
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

      if (entry.capability === 'measure_temperature') {
        const divisor = this.getSetting('temp_divisor') || 10;
        await this.setCapabilityValue('measure_temperature', converted / divisor).catch(() => {});
        continue;
      }

      if (entry.capability === 'countdown_timer') {
        const capValue = settings.dp_countdown_timer_numeric
          ? countdownRawToCap(value)
          : converted;
        await this.setCapabilityValue('countdown_timer', capValue).catch((err) => {
          this._appLog(
            `countdown_timer: could not set "${capValue}" (raw DP value: ${JSON.stringify(value)}). ` +
            `If your device sends plain numbers (0, 1, 2 … 24) instead of "cancel"/"1h" … "24h", ` +
            `enable "Timer uses plain numbers" in the device settings.`,
            'warn',
          );
        });
        continue;
      }

      if (entry.capability === 'countdown_left') {
        const minutes = settings.dp_countdown_left_minutes;
        await this.setCapabilityValue('countdown_left', minutes ? converted / 60 : converted).catch(() => {});
        continue;
      }

      if (!this.hasCapability(entry.capability)) continue;
      await this._applyCapability(entry.capability, converted);
    }

    // Debounced persistence — avoids hammering storage on every DPS packet.
    if (changed) {
      this._scheduleStoreSave();
      this._writeDpSnapshot();
    }
  }

  // ── Homey lifecycle ────────────────────────────────────────────────────────

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
    if (changedKeys.includes('reconnect_interval')) this._startAutoReconnect();
    if (changedKeys.some((k) => OPTIONAL_CAPABILITIES.map((o) => o.setting).includes(k))) {
      await this._syncOptionalCapabilities(OPTIONAL_CAPABILITIES);
      this._registerListeners(); // newly added capabilities need listeners immediately
    }
    if (changedKeys.some((k) => ['mode_values', 'fan_speed_values'].includes(k))) {
      await this._syncEnumOptions('mode',      this.getSetting('mode_values'));
      await this._syncEnumOptions('fan_speed', this.getSetting('fan_speed_values'));
    }
  }
}

module.exports = DehumidifierDevice;
