'use strict';

const Homey          = require('homey');
const TuyaConnection = require('../../lib/TuyaConnection');

const DEBOUNCE_MS = 300; // debounce delay for slider capabilities

// Maps settings keys → Homey capabilities.
// settable: false = read-only, no capability listener registered.
// debounce: true  = delay physical command to avoid rapid-fire sends (e.g. sliders).
const DP_PROFILE = [
  { settingKey: 'dp_onoff',            capability: 'onoff',            transform: (v) => Boolean(v),  settable: true              },
  { settingKey: 'dp_current_humidity', capability: 'measure_humidity', transform: (v) => Number(v),   settable: false             },
  { settingKey: 'dp_target_humidity',  capability: 'target_humidity',  transform: (v) => Number(v),   settable: true, debounce: true },
  { settingKey: 'dp_fan_speed',        capability: 'fan_speed',        transform: (v) => String(v),   settable: true              },
  { settingKey: 'dp_mode',             capability: 'mode',             transform: (v) => String(v),   settable: true              },
  { settingKey: 'dp_countdown_left',   capability: 'countdown_left',   transform: (v) => Number(v),   settable: false             },
  { settingKey: 'dp_countdown_timer',  capability: 'countdown_timer',  transform: (v) => String(v),   settable: true              },
  { settingKey: 'dp_child_lock',       capability: 'child_lock',       transform: (v) => Boolean(v),  settable: true              },
  { settingKey: 'dp_water_full',       capability: 'alarm_water',      transform: (v) => Boolean(v),  settable: false             },
  { settingKey: 'dp_temperature',      capability: 'measure_temperature', transform: (v) => Number(v) / 10, settable: false            },
  { settingKey: 'dp_anion',            capability: 'anion',               transform: (v) => Boolean(v),     settable: true             },
];

class DehumidifierDevice extends Homey.Device {
  async onInit() {
    this.log('Device initialized:', this.getName());

    this._conn         = null;
    this._pollTimer    = null;
    this._lastDps      = {};
    this._lastRawMeta  = null;
    this._lastDataTime = null;

    // Restore last known DPS from store — prevents redundant updates on first poll.
    try {
      const stored = this.getStoreValue('lastDps');
      if (stored && typeof stored === 'object') {
        this._lastDps = stored;
        this._writeDpSnapshot();
      }
    } catch (e) {}

    await this._migrateCapabilities();
    await this._syncOptionalCapabilities();
    await this._syncEnumCapabilities();

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

  async _syncEnumCapabilities() {
    const capitalize = (v) => v.charAt(0).toUpperCase() + v.slice(1).replace(/_/g, ' ');
    const toOptions  = (csv) =>
      (csv || '').split(',').map((v) => v.trim()).filter(Boolean)
        .map((v) => ({ id: v, title: { en: capitalize(v), de: capitalize(v) } }));

    const apply = async (capabilityId, csv) => {
      if (!this.hasCapability(capabilityId)) return;
      const opts = toOptions(csv);
      if (opts.length === 0) return;

      // If the capability's current value is not in the new option list, Homey will
      // reject the call. Skip and warn rather than silently fail.
      const currentValue = this.getCapabilityValue(capabilityId);
      if (currentValue !== null && currentValue !== undefined
          && !opts.some((o) => o.id === currentValue)) {
        this._appLog(
          `${capabilityId}: cannot restrict options to [${opts.map((o) => o.id).join(', ')}] — ` +
          `current value "${currentValue}" is not in that list. ` +
          `Update the device to a supported value first, or include "${currentValue}" in the setting.`,
          'warn',
        );
        return;
      }

      try {
        await this.setCapabilityOptions(capabilityId, { values: opts });
        this._appLog(`${capabilityId} options → ${opts.map((o) => o.id).join(', ')}`, 'info');
      } catch (err) {
        // Homey rejects values not in the app.json superset — log clearly so the user can debug
        this._appLog(
          `setCapabilityOptions(${capabilityId}) failed: ${err.message}. ` +
          `Attempted values: [${opts.map((o) => o.id).join(', ')}]. ` +
          `Each value must exist in the capability's superset defined in app.json.`,
          'warn',
        );
      }
    };

    await apply('mode',      this.getSetting('mode_values'));
    await apply('fan_speed', this.getSetting('fan_speed_values'));
  }

  async _syncOptionalCapabilities() {
    const optionals = [
      { setting: 'dp_temperature',     capability: 'measure_temperature' },
      { setting: 'dp_anion',           capability: 'anion'               },
      { setting: 'dp_child_lock',      capability: 'child_lock'          },
      { setting: 'dp_countdown_timer', capability: 'countdown_timer'     },
      { setting: 'dp_countdown_left',  capability: 'countdown_left'      },
      { setting: 'dp_water_full',      capability: 'alarm_water'         },
    ];

    for (const { setting, capability } of optionals) {
      const dp = this.getSetting(setting);
      if (dp > 0) {
        if (!this.hasCapability(capability))
          await this.addCapability(capability).catch(() => {});
      } else {
        if (this.hasCapability(capability))
          await this.removeCapability(capability).catch(() => {});
      }
    }
  }

  // Placeholder for future capability renames across app versions.
  async _migrateCapabilities() {
    const migrations = [
      // { from: 'old_capability_id', to: 'new_capability_id' }
    ];
    for (const { from, to } of migrations) {
      if (this.hasCapability(from) && !this.hasCapability(to)) {
        await this.addCapability(to).catch(() => {});
        await this.removeCapability(from).catch(() => {});
        this.log(`Migrated capability: ${from} → ${to}`);
      }
    }
  }

  _writeDpSnapshot() {
    try {
      const snapshot = this.homey.settings.get('dp_snapshot') || {};
      snapshot[this.getData().id] = {
        name:      this.getName(),
        dps:       { ...this._lastDps },
        rawMeta:   this._lastRawMeta,
        updatedAt: Date.now(),
      };
      this.homey.settings.set('dp_snapshot', snapshot);
    } catch (e) {}
  }

  _appLog(message, level = 'info') {
    this.log(message);
    try { this.homey.app.addLog(this.getName(), message, level); } catch (e) {}
  }

  async _connect() {
    if (this._conn) {
      this._conn.removeAllListeners();
      this._conn.disconnect();
      this._conn = null;
    }

    const { ip, device_id, local_key, version } = this.getSettings();
    if (!ip || !device_id || !local_key) {
      this.setUnavailable(this.homey.__('errors.missing_settings')).catch(() => {});
      return;
    }

    this._conn = new TuyaConnection({ id: device_id, key: local_key, ip, version });

    this._conn.on('connected', () => {
      this._appLog('Connected', 'info');
      this._lastDataTime = Date.now();
      // Clear dedup cache so the first data packet after (re)connect always
      // writes fresh capability values and refreshes Homey's "last updated" timestamp.
      this._lastDps = {};
      this.setAvailable().catch(() => {});
      this._triggerDeviceConnected.trigger(this).catch(() => {});
      this._updateStatusSettings('Connected');
      // Initial full state fetch after a short settle delay.
      setTimeout(() => this._conn?.get().catch(() => {}), 500);
      this._startPolling();
    });

    this._conn.on('disconnected', (reason) => {
      this._appLog(reason ? `Disconnected: ${reason}` : 'Disconnected', 'warn');
      this._stopPolling();
      this.setUnavailable(reason || 'Device disconnected').catch(() => {});
      this._triggerDeviceDisconnected.trigger(this).catch(() => {});
      this._updateStatusSettings('Disconnected');
    });

    this._conn.on('data', (dps, raw) => {
      this._lastDataTime = Date.now();
      if (raw) {
        this._lastRawMeta = {
          devId: raw.devId  ?? null,
          t:     raw.t      ?? null,
          cid:   raw.cid    ?? null,
          uid:   raw.uid    ?? null,
        };
      }
      this.log('Raw DPS received:', JSON.stringify(dps));
      this._handleDps(dps).catch((err) => this.log('Error handling DPS:', err.message));
    });

    this._conn.on('log', ({ message, level }) => this._appLog(message, level));

    await this._conn.connect();
  }

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
          this._triggerWaterFull.trigger(this).catch(() => {});
          this.homey.notifications.createNotification({
            excerpt: `${this.getName()}: ${this.homey.__('notifications.waterFull')}`,
          }).catch(() => {});
        }
        if (prevWater && !converted) {
          this._triggerWaterEmptied.trigger(this).catch(() => {});
        }
        continue;
      }

      await this.setCapabilityValue(entry.capability, converted).catch(() => {});
    }

    // Persist updated DPS snapshot so _lastDps survives an app restart.
    if (changed) {
      this.setStoreValue('lastDps', this._lastDps).catch(() => {});
      this._writeDpSnapshot();
    }
  }

  _updateStatusSettings(status) {
    const lastSeen = new Date().toLocaleString(this.homey.i18n.getLanguage(), {
      dateStyle: 'short',
      timeStyle: 'medium',
      timeZone:  this.homey.clock.getTimezone(),
    });
    this.setSettings({ connection_status: status, last_seen: lastSeen }).catch(() => {});
  }

  // ── Polling ────────────────────────────────────────────────────────────────

  _startPolling() {
    this._stopPolling();
    const intervalSec = this.getSetting('polling_interval') ?? 30;
    if (!intervalSec || intervalSec <= 0) return;
    this.log(`Polling every ${intervalSec}s`);

    const intervalMs = intervalSec * 1000;
    this._pollTimer  = setInterval(async () => {
      // If connected but no data received for 3× the poll interval, force reconnect.
      if (this._conn?.connected && this._lastDataTime
          && Date.now() - this._lastDataTime > intervalMs * 3) {
        this._appLog('No data received for extended period — reconnecting', 'warn');
        await this._connect();
        return;
      }
      this._conn?.get().catch((err) => this.log('Poll failed:', err.message));
    }, intervalMs);
  }

  _stopPolling() {
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
  }

  // Public – called by the "refresh_device" flow action.
  async pollNow() {
    await this._conn?.get();
  }

  // Public – called by the "force_reconnect" flow action.
  async forceReconnect() {
    this._appLog('Force reconnect requested', 'info');
    await this._connect();
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
    if (changedKeys.some((k) => [
      'dp_temperature', 'dp_anion', 'dp_child_lock',
      'dp_countdown_timer', 'dp_countdown_left', 'dp_water_full',
    ].includes(k))) {
      await this._syncOptionalCapabilities();
    }
    if (changedKeys.some((k) => ['mode_values', 'fan_speed_values'].includes(k))) {
      await this._syncEnumCapabilities();
    }
  }

  async onDeleted() {
    this._stopPolling();
    if (this._conn) {
      this._conn.removeAllListeners();
      this._conn.disconnect();
      this._conn = null;
    }
    this.log('Device deleted');
  }
}

module.exports = DehumidifierDevice;
