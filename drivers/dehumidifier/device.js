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
    this._alarmFalseSince     = null;  // when alarm_water last transitioned to false

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
    // If alarm was not active before reconnect, start the suppression window now.
    // This prevents the GET-response artifact (device sends true right after connect)
    // from immediately re-arming the debounce timer.
    if (!this.getCapabilityValue('alarm_water')) {
      this._alarmFalseSince = Date.now();
    }
    // Note: no T+60 s scheduled GET — regular 30 s polling handles state sync,
    // and the extra GET was bypassing dedup and re-triggering the alarm cycle.
  }

  async _onDeleted() {
    clearTimeout(this._waterAlarmTimer);
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
          // Some devices cycle alarm_water true/false every few minutes even when
          // the tank is not actually full (firmware bug).  Require the alarm to
          // have been continuously false for at least MIN_FALSE_MS before we even
          // start the confirmation debounce.  If the device oscillates faster than
          // this window, the alarm is permanently suppressed — exactly what we want.
          const MIN_FALSE_MS = 5 * 60 * 1000; // 5 minutes
          const now          = Date.now();
          if (this._alarmFalseSince !== null && now - this._alarmFalseSince < MIN_FALSE_MS) {
            this._appLog(
              `alarm_water: suppressed — was false for only ` +
              `${Math.round((now - this._alarmFalseSince) / 1000)} s (< ${MIN_FALSE_MS / 60000} min)`,
              'info',
            );
            continue;
          }

          // ── Confirmation debounce ────────────────────────────────────────────
          // Alarm must stay true continuously for MIN_CONFIRM_MS before we fire.
          // This absorbs both reconnect artifacts (short true burst on connect) and
          // firmware bounces (true→false→true within seconds).
          const MIN_CONFIRM_MS = 2 * 60 * 1000; // 2 minutes minimum, always
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
          this._alarmFalseSince = Date.now(); // restart oscillation guard window
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
