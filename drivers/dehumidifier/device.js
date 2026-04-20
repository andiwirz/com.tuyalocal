'use strict';

const Homey = require('homey');
const TuyAPI = require('tuyapi');

const RECONNECT_BASE_MS    = 10000;   // 10 s initial delay
const RECONNECT_MAX_MS     = 300000;  // 5 min maximum delay
const CMD_TIMEOUT_MS       = 5000;    // per-command timeout
const HEARTBEAT_TIMEOUT_MS = 60000;   // reconnect if no data for 60 s

// Maps device settings keys → Homey capabilities.
// settable: false = read-only, no capability listener registered.
const DP_PROFILE = [
  { settingKey: 'dp_onoff',            capability: 'onoff',            transform: (v) => Boolean(v),  settable: true  },
  { settingKey: 'dp_current_humidity', capability: 'measure_humidity', transform: (v) => Number(v),   settable: false },
  { settingKey: 'dp_target_humidity',  capability: 'target_humidity',  transform: (v) => Number(v),   settable: true  },
  { settingKey: 'dp_fan_speed',        capability: 'fan_speed',        transform: (v) => String(v),   settable: true  },
  { settingKey: 'dp_mode',             capability: 'mode',             transform: (v) => String(v),   settable: true  },
  { settingKey: 'dp_countdown_left',   capability: 'countdown_left',   transform: (v) => Number(v),   settable: false },
  { settingKey: 'dp_countdown_timer',  capability: 'countdown_timer',  transform: (v) => String(v),   settable: true  },
  { settingKey: 'dp_child_lock',       capability: 'child_lock',       transform: (v) => Boolean(v),  settable: true  },
  { settingKey: 'dp_water_full',       capability: 'alarm_water',      transform: (v) => Boolean(v),  settable: false },
];

class DehumidifierDevice extends Homey.Device {
  async onInit() {
    this.log('Device initialized:', this.getName());

    this._reconnectTimer    = null;
    this._reconnectAttempts = 0;
    this._pollTimer         = null;
    this._pollPending       = false;
    this._tuya              = null;
    this._connected         = false;
    this._cmdQueue          = Promise.resolve();
    this._heartbeatTimer    = null;
    this._lastDps           = {};

    await this._migrateCapabilities();

    // ── Flow trigger cards ───────────────────────────────────────────────────
    this._triggerHumidityAbove = this.homey.flow.getDeviceTriggerCard('humidity_above');
    this._triggerHumidityAbove.registerRunListener(async (args, state) =>
      state.prevHumidity <= args.humidity && state.humidity > args.humidity
    );

    this._triggerHumidityBelow = this.homey.flow.getDeviceTriggerCard('humidity_below');
    this._triggerHumidityBelow.registerRunListener(async (args, state) =>
      state.prevHumidity >= args.humidity && state.humidity < args.humidity
    );

    this._triggerWaterFull        = this.homey.flow.getDeviceTriggerCard('water_tank_full');
    this._triggerWaterEmptied     = this.homey.flow.getDeviceTriggerCard('water_tank_emptied');
    this._triggerDeviceConnected  = this.homey.flow.getDeviceTriggerCard('device_connected');
    this._triggerDeviceDisconnected = this.homey.flow.getDeviceTriggerCard('device_disconnected');

    // ── Capability listeners (auto-registered from DP_PROFILE) ──────────────
    for (const entry of DP_PROFILE) {
      if (!entry.settable) continue;
      this.registerCapabilityListener(entry.capability, async (value) => {
        await this._setDp(this.getSetting(entry.settingKey), value);
      });
    }

    await this._connect();
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

  _appLog(message) {
    this.log(message);
    try { this.homey.app.addLog(this.getName(), message); } catch (e) {}
  }

  async _connect() {
    this._stopHeartbeatWatchdog();
    if (this._tuya) {
      try { this._tuya.disconnect(); } catch (e) {}
      this._tuya = null;
    }

    const { ip, device_id, local_key, version } = this.getSettings();

    if (!ip || !device_id || !local_key) {
      this.setUnavailable(this.homey.__('errors.missing_settings')).catch(() => {});
      return;
    }

    this._tuya = new TuyAPI({
      id: device_id,
      key: local_key,
      ip,
      version: String(version || '3.3'),
      issueGetOnConnect: false,
    });

    this._tuya.on('connected', () => {
      this._appLog('Connected');
      this._connected         = true;
      this._reconnectAttempts = 0;
      this.setAvailable().catch(() => {});
      this._triggerDeviceConnected.trigger(this).catch(() => {});
      this._resetHeartbeatWatchdog();

      // Request all DPs after a short delay; guard with _pollPending to prevent
      // overlap if the polling timer fires at the same moment.
      setTimeout(() => {
        if (this._tuya && this._connected && !this._pollPending) {
          this._pollPending = true;
          this._tuya.get({ schema: true })
            .catch((err) => this._appLog(`Initial state fetch failed: ${err.message}`))
            .finally(() => { this._pollPending = false; });
        }
      }, 500);

      this._startPolling();
    });

    this._tuya.on('disconnected', () => {
      this._appLog('Disconnected');
      this._connected = false;
      this._stopPolling();
      this._stopHeartbeatWatchdog();
      this.setUnavailable('Device disconnected').catch(() => {});
      this._triggerDeviceDisconnected.trigger(this).catch(() => {});
      this._scheduleReconnect();
    });

    this._tuya.on('error', (err) => {
      const msg = (err && err.message) ? err.message : String(err || 'Unknown error');
      this._appLog(`Error: ${msg}`);

      // Timeout on a single GET/SET – TCP connection is usually still alive.
      if (msg.toLowerCase().includes('timeout')) {
        this.log('Timeout (non-fatal), will retry on next poll');
        return;
      }

      this._connected = false;
      this._stopPolling();
      this._stopHeartbeatWatchdog();
      this.setUnavailable(`Error: ${msg}`).catch(() => {});
      this._triggerDeviceDisconnected.trigger(this).catch(() => {});
      this._scheduleReconnect();
    });

    this._tuya.on('data', (data) => {
      this._resetHeartbeatWatchdog();
      this.log('Raw DPS received:', JSON.stringify(data));
      if (data && data.dps) {
        this._handleDps(data.dps).catch((err) =>
          this.log('Error handling DPS:', err.message)
        );
      }
    });

    // Some TuyAPI versions emit 'heartbeat' for keep-alive packets.
    this._tuya.on('heartbeat', () => this._resetHeartbeatWatchdog());

    try {
      await this._tuya.connect();
    } catch (err) {
      this._appLog(`Connection failed: ${err.message}`);
      this.setUnavailable('Connection failed').catch(() => {});
      this._scheduleReconnect();
    }
  }

  async _handleDps(dps) {
    const settings = this.getSettings();

    for (const [dpStr, value] of Object.entries(dps)) {
      // Skip unchanged values (_lastDps cache)
      if (this._lastDps[dpStr] === value) continue;
      this._lastDps[dpStr] = value;

      const dp    = parseInt(dpStr, 10);
      const entry = DP_PROFILE.find((e) => {
        const dpNum = settings[e.settingKey];
        return dpNum > 0 && dp === dpNum;
      });

      if (!entry) {
        this.log(`Unknown DP ${dp}:`, value);
        continue;
      }

      const converted = entry.transform(value);

      if (entry.capability === 'measure_humidity') {
        const prevHumidity = this.getCapabilityValue('measure_humidity') || 0;
        await this.setCapabilityValue('measure_humidity', converted).catch(() => {});
        const tokens = { humidity: converted };
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
  }

  // ── Heartbeat watchdog ─────────────────────────────────────────────────────

  _resetHeartbeatWatchdog() {
    if (this._heartbeatTimer) clearTimeout(this._heartbeatTimer);
    this._heartbeatTimer = setTimeout(() => {
      this._appLog('No heartbeat received — reconnecting');
      if (this._tuya) {
        try { this._tuya.disconnect(); } catch (e) {}
      }
    }, HEARTBEAT_TIMEOUT_MS);
  }

  _stopHeartbeatWatchdog() {
    if (this._heartbeatTimer) {
      clearTimeout(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
  }

  // ── Internal helpers ───────────────────────────────────────────────────────

  // Serialises all SET commands through a queue so concurrent capability
  // changes don't race each other on the TCP socket.
  async _setDp(dp, value) {
    if (!this._connected || !this._tuya) throw new Error('Device not connected');

    const version       = this.getSetting('version');
    const isNewProtocol = version === '3.4' || version === '3.5';

    const execute = async () => {
      if (!this._connected || !this._tuya) throw new Error('Device not connected');

      if (isNewProtocol) {
        // Protocol 3.4/3.5: fire-and-forget — device pushes STATUS asynchronously,
        // so waiting for a response echo would always time out.
        this._tuya.set({ dps: dp, set: value }).catch((err) => {
          const msg = String(err?.message || err);
          if (!msg.toLowerCase().includes('timeout')) {
            this._appLog(`Set DP ${dp} failed: ${msg}`);
          }
        });
        return;
      }

      try {
        await Promise.race([
          this._tuya.set({ dps: dp, set: value }),
          new Promise((_, rej) =>
            setTimeout(() => rej(new Error('timeout')), CMD_TIMEOUT_MS)
          ),
        ]);
      } catch (err) {
        const msg = (err && err.message) ? err.message : String(err || 'Unknown error');
        // SET timeouts are non-fatal – the device usually applies the value anyway.
        if (msg.toLowerCase().includes('timeout')) {
          this.log(`Set DP ${dp} timed out (value may still have been applied)`);
          return;
        }
        throw err;
      }
    };

    // Keep the queue alive even if this task throws.
    const task = this._cmdQueue.then(execute);
    this._cmdQueue = task.catch(() => {});
    return task;
  }

  _startPolling() {
    this._stopPolling();
    const intervalSec = this.getSetting('polling_interval') ?? 30;
    if (!intervalSec || intervalSec <= 0) return;
    this.log(`Polling every ${intervalSec}s`);
    this._pollTimer = setInterval(() => {
      if (this._tuya && this._connected && !this._pollPending) {
        this._pollPending = true;
        this._tuya.get({ schema: true })
          .catch((err) => this.log('Poll failed:', err.message))
          .finally(() => { this._pollPending = false; });
      }
    }, intervalSec * 1000);
  }

  _stopPolling() {
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
  }

  // Public – called by the "refresh_device" flow action.
  async pollNow() {
    if (!this._tuya || !this._connected || this._pollPending) return;
    this._pollPending = true;
    try {
      await this._tuya.get({ schema: true });
    } catch (err) {
      this.log('Manual poll failed:', err && err.message);
    } finally {
      this._pollPending = false;
    }
  }

  _scheduleReconnect() {
    if (this._reconnectTimer) return;
    // Exponential backoff with ±20 % jitter to avoid thundering herd when
    // multiple devices reconnect simultaneously after a network outage.
    const base   = Math.min(RECONNECT_BASE_MS * Math.pow(2, this._reconnectAttempts), RECONNECT_MAX_MS);
    const jitter = base * 0.2 * (Math.random() * 2 - 1);
    const delay  = Math.max(1000, Math.round(base + jitter));
    this._reconnectAttempts++;
    this.log(`Reconnecting in ${Math.round(delay / 1000)}s (attempt ${this._reconnectAttempts})`);
    this._reconnectTimer = setTimeout(async () => {
      this._reconnectTimer = null;
      await this._connect();
    }, delay);
  }

  async onSettings({ newSettings, changedKeys }) {
    const connectionKeys = ['ip', 'device_id', 'local_key', 'version'];
    if (changedKeys.some((k) => connectionKeys.includes(k))) {
      this.log('Connection settings changed, reconnecting');
      this._reconnectAttempts = 0;
      await this._connect();
    } else if (changedKeys.includes('polling_interval')) {
      this.log('Polling interval changed, restarting polling');
      this._startPolling();
    }
  }

  async onDeleted() {
    this._stopPolling();
    this._stopHeartbeatWatchdog();
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    if (this._tuya) {
      try { this._tuya.disconnect(); } catch (e) {}
      this._tuya = null;
    }
    this.log('Device deleted');
  }
}

module.exports = DehumidifierDevice;
