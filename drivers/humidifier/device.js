'use strict';

const BaseTuyaDevice = require('../../lib/BaseTuyaDevice');

const DEBOUNCE_MS = 300;

const DP_PROFILE = [
  { settingKey: 'dp_onoff',            capability: 'onoff',               transform: (v) => Boolean(v),     settable: true                },
  { settingKey: 'dp_current_humidity', capability: 'measure_humidity',    transform: (v) => Number(v),      settable: false               },
  { settingKey: 'dp_target_humidity',  capability: 'target_humidity',     transform: (v) => Number(v),      settable: true, debounce: true },
  { settingKey: 'dp_fan_speed',        capability: 'fan_speed',           transform: (v) => String(v),      settable: true                },
  { settingKey: 'dp_mode',             capability: 'mode',                transform: (v) => String(v),      settable: true                },
  { settingKey: 'dp_countdown_left',   capability: 'countdown_left',      transform: (v) => Number(v),      settable: false               },
  { settingKey: 'dp_countdown_timer',  capability: 'countdown_timer',     transform: (v) => String(v),      settable: true                },
  { settingKey: 'dp_child_lock',       capability: 'child_lock',          transform: (v) => Boolean(v),     settable: true                },
  { settingKey: 'dp_water_empty',      capability: 'alarm_water',         transform: (v) => Boolean(v),     settable: false               },
  { settingKey: 'dp_temperature',      capability: 'measure_temperature', transform: (v) => Number(v),      settable: false               },
  { settingKey: 'dp_anion',            capability: 'anion',               transform: (v) => Boolean(v),     settable: true                },
];

const OPTIONAL_CAPABILITIES = [
  // Wie im README dokumentiert: bei 0 keine Kachel. fan_speed steht fest im Manifest,
  // dp_fan_speed ist aber oft 0 - die Kachel war da und schickte ihr Antippen an DP 0.
  { setting: 'dp_fan_speed',       capability: 'fan_speed'           },
  { setting: 'dp_temperature',     capability: 'measure_temperature' },
  { setting: 'dp_anion',           capability: 'anion'               },
  { setting: 'dp_child_lock',      capability: 'child_lock'          },
  { setting: 'dp_countdown_timer', capability: 'countdown_timer'     },
  { setting: 'dp_countdown_left',  capability: 'countdown_left'      },
  { setting: 'dp_water_empty',     capability: 'alarm_water'         },
];

class HumidifierDevice extends BaseTuyaDevice {
  async onInit() {
    this.log('Device initialized:', this.getName());

    await this._baseInit();

    await this._migrateCapabilities([]);
    await this._syncOptionalCapabilities(OPTIONAL_CAPABILITIES);
    await this._syncEnumOptions('mode',      this.getSetting('mode_values'));
    await this._syncEnumOptions('fan_speed', this.getSetting('fan_speed_values'));

    // ── Flow trigger cards ───────────────────────────────────────────────────
    this._triggerHumidityAbove      = this.homey.flow.getDeviceTriggerCard('humidifier_humidity_above');
    this._triggerHumidityBelow      = this.homey.flow.getDeviceTriggerCard('humidifier_humidity_below');
    this._triggerWaterEmpty         = this.homey.flow.getDeviceTriggerCard('humidifier_water_empty');
    this._triggerWaterFilled        = this.homey.flow.getDeviceTriggerCard('humidifier_water_filled');
    this._triggerDeviceConnected    = this.homey.flow.getDeviceTriggerCard('humidifier_device_connected');
    this._triggerDeviceDisconnected = this.homey.flow.getDeviceTriggerCard('humidifier_device_disconnected');
    this._triggerDpChanged          = this.homey.flow.getDeviceTriggerCard('humidifier_dp_changed');

    // Ohne diese Zuordnung schreibt _applyCapability nur den Wert; mit ihr
    // meldet es zusaetzlich einen echten Wechsel an die Flow-Karte.
    this._registerChangeTriggers({
      child_lock: 'humidifier_child_lock_changed',
    });

    // ── Capability listeners ─────────────────────────────────────────────────
    // Registered through a helper so that a capability switched on later — by
    // pointing its DP setting at a number — becomes controllable at once. Without
    // that, the tile appears and taps do nothing until the app is restarted.
    this._registeredCaps = new Set();
    this._debounceTimers = {};
    this._registerListeners();

    await this._connect();
  }

  /** Idempotent: skips capabilities already wired, which Homey would reject. */
  _registerListeners() {
    const register = (capability, listener) => {
      if (!this.hasCapability(capability)) return;
      if (this._registeredCaps.has(capability)) return;
      this._registeredCaps.add(capability);
      this.registerCapabilityListener(capability, listener);
    };

    for (const entry of DP_PROFILE) {
      if (!entry.settable) continue;
      if (entry.debounce) {
        const cap = entry.capability;
        register(cap, (value) => {
          clearTimeout(this._debounceTimers[cap]);
          return this._entprellVersprechen(cap, (resolve) => {
            this._debounceTimers[cap] = setTimeout(() => {
              this._set(this.getSetting(entry.settingKey), value)
                .then(resolve).catch(resolve);
            }, DEBOUNCE_MS);
          });
        });
      } else {
        register(entry.capability, async (value) => {
          await this._set(this._dpOderFehler(entry), value);
        });
      }
    }
  }

  /**
   * Der DP einer Kachel, oder ein Fehler, den Homey anzeigt - nie ein Befehl an DP 0.
   * Fuer die Kacheln, die fest im Manifest stehen und nicht verschwinden, wenn ihr DP
   * auf 0 gestellt wird (Modus, Zielfeuchte): ihr Antippen ging sonst als Befehl an
   * DP 0 hinaus, ohne Wirkung und ohne Wort.
   */
  _dpOderFehler(entry) {
    const dp = this.getSetting(entry.settingKey);
    if (dp > 0) return dp;
    throw new Error(`No data point set for ${entry.capability} (${entry.settingKey} is 0) - set it in the device settings`);
  }

  async _onDeleted() {
    for (const timer of Object.values(this._debounceTimers || {})) clearTimeout(timer);
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
        const prevEmpty = this.getCapabilityValue('alarm_water');
        await this.setCapabilityValue('alarm_water', converted).catch(() => {});
        if (!prevEmpty && converted) {
          this._triggerWaterEmpty.trigger(this).catch(() => {});
          this.homey.notifications.createNotification({
            excerpt: `${this.getName()}: ${this.homey.__('notifications.waterEmpty')}`,
          }).catch(() => {});
        }
        if (prevEmpty && !converted) {
          this._triggerWaterFilled.trigger(this).catch(() => {});
        }
        continue;
      }

      if (entry.capability === 'measure_temperature') {
        const divisor = this.getSetting('temp_divisor') || 10;
        await this.setCapabilityValue('measure_temperature', converted / divisor).catch(() => {});
        continue;
      }

      await this._applyCapability(entry.capability, converted);
    }

    if (changed) {
      this._scheduleStoreSave();
      this._writeDpSnapshot();
    }
  }

  // ── Homey lifecycle ──────────────────────────────────────────────────────────

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
    if (this._touchesOptional(changedKeys, OPTIONAL_CAPABILITIES)) {
      await this._syncOptionalCapabilities(OPTIONAL_CAPABILITIES);
      this._registerListeners(); // newly added capabilities need listeners immediately
    }
    // dp_fan_speed dabei: geht er von 0 auf eine Nummer, kommt die Kachel eben erst
    // dazu und braucht ihre Werteliste.
    if (changedKeys.some((k) => ['mode_values', 'fan_speed_values', 'dp_fan_speed'].includes(k))) {
      await this._syncEnumOptions('mode',      this.getSetting('mode_values'));
      await this._syncEnumOptions('fan_speed', this.getSetting('fan_speed_values'));
    }
  }
}

module.exports = HumidifierDevice;
