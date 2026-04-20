'use strict';

const Homey = require('homey');
const TuyAPI = require('tuyapi');

const RECONNECT_BASE_MS = 10000;   // 10 s initial delay
const RECONNECT_MAX_MS  = 300000;  // 5 min maximum delay
const CMD_TIMEOUT_MS    = 5000;    // per-command timeout

class DehumidifierDevice extends Homey.Device {
  async onInit() {
    this.log('Device initialized:', this.getName());

    this._reconnectTimer    = null;
    this._reconnectAttempts = 0;
    this._pollTimer         = null;
    this._pollPending       = false;
    this._tuya              = null;
    this._connected         = false;
    this._cmdQueue          = Promise.resolve(); // serial command queue

    // ── Flow trigger cards ───────────────────────────────────────────────────
    this._triggerHumidityAbove = this.homey.flow.getDeviceTriggerCard('humidity_above');
    this._triggerHumidityAbove.registerRunListener(async (args, state) =>
      state.prevHumidity <= args.humidity && state.humidity > args.humidity
    );

    this._triggerHumidityBelow = this.homey.flow.getDeviceTriggerCard('humidity_below');
    this._triggerHumidityBelow.registerRunListener(async (args, state) =>
      state.prevHumidity >= args.humidity && state.humidity < args.humidity
    );

    this._triggerWaterFull    = this.homey.flow.getDeviceTriggerCard('water_tank_full');
    this._triggerWaterEmptied = this.homey.flow.getDeviceTriggerCard('water_tank_emptied');

    // ── Capability listeners ─────────────────────────────────────────────────
    this.registerCapabilityListener('onoff',            this._onCapabilityOnOff.bind(this));
    this.registerCapabilityListener('target_humidity',  this._onCapabilityTargetHumidity.bind(this));
    this.registerCapabilityListener('fan_speed',        this._onCapabilityFanSpeed.bind(this));
    this.registerCapabilityListener('mode',             this._onCapabilityMode.bind(this));
    this.registerCapabilityListener('child_lock',       this._onCapabilityChildLock.bind(this));
    this.registerCapabilityListener('countdown_timer',  this._onCapabilityCountdownTimer.bind(this));

    await this._connect();
  }

  _appLog(message) {
    this.log(message);
    try { this.homey.app.addLog(this.getName(), message); } catch (e) {}
  }

  async _connect() {
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

      // Request all DPs after a short delay; guard with _pollPending to prevent
      // overlap if the polling timer fires at the same moment
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
      this.setUnavailable('Device disconnected').catch(() => {});
      this._scheduleReconnect();
    });

    this._tuya.on('error', (err) => {
      const msg = (err && err.message) ? err.message : String(err || 'Unknown error');
      this._appLog(`Error: ${msg}`);

      // Timeout on a single GET/SET – TCP connection is usually still alive.
      // Treat as non-fatal; next poll will retry.
      if (msg.toLowerCase().includes('timeout')) {
        this.log('Timeout (non-fatal), will retry on next poll');
        return;
      }

      this._connected = false;
      this._stopPolling();
      this.setUnavailable(`Error: ${msg}`).catch(() => {});
      this._scheduleReconnect();
    });

    this._tuya.on('data', (data) => {
      this.log('Raw DPS received:', JSON.stringify(data));
      if (data && data.dps) {
        this._handleDps(data.dps).catch((err) =>
          this.log('Error handling DPS:', err.message)
        );
      }
    });

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
      const dp = parseInt(dpStr, 10);

      if (dp === settings.dp_onoff) {
        await this.setCapabilityValue('onoff', Boolean(value)).catch(() => {});
      } else if (dp === settings.dp_current_humidity) {
        const prevHumidity = this.getCapabilityValue('measure_humidity') || 0;
        const newHumidity  = Number(value);
        await this.setCapabilityValue('measure_humidity', newHumidity).catch(() => {});
        const tokens = { humidity: newHumidity };
        const state  = { humidity: newHumidity, prevHumidity };
        this._triggerHumidityAbove.trigger(this, tokens, state).catch(() => {});
        this._triggerHumidityBelow.trigger(this, tokens, state).catch(() => {});
      } else if (dp === settings.dp_target_humidity) {
        await this.setCapabilityValue('target_humidity', Number(value)).catch(() => {});
      } else if (dp === settings.dp_fan_speed) {
        await this.setCapabilityValue('fan_speed', String(value)).catch(() => {});
      } else if (dp === settings.dp_mode) {
        await this.setCapabilityValue('mode', String(value)).catch(() => {});
      } else if (dp === settings.dp_countdown_left) {
        await this.setCapabilityValue('countdown_left', Number(value)).catch(() => {});
      } else if (dp === settings.dp_countdown_timer) {
        await this.setCapabilityValue('countdown_timer', String(value)).catch(() => {});
      } else if (dp === settings.dp_child_lock) {
        await this.setCapabilityValue('child_lock', Boolean(value)).catch(() => {});
      } else if (settings.dp_water_full > 0 && dp === settings.dp_water_full) {
        const prevWater = this.getCapabilityValue('alarm_water');
        const newWater  = Boolean(value);
        await this.setCapabilityValue('alarm_water', newWater).catch(() => {});
        if (!prevWater && newWater) {
          this._triggerWaterFull.trigger(this).catch(() => {});
          this.homey.notifications.createNotification({
            excerpt: `${this.getName()}: ${this.homey.__('notifications.waterFull')}`,
          }).catch(() => {});
        }
        if (prevWater && !newWater) {
          this._triggerWaterEmptied.trigger(this).catch(() => {});
        }
      } else {
        this.log(`Unknown DP ${dp}:`, value);
      }
    }
  }

  // ── Capability handlers ────────────────────────────────────────────────────

  async _onCapabilityOnOff(value) {
    await this._setDp(this.getSetting('dp_onoff'), value);
  }

  async _onCapabilityTargetHumidity(value) {
    await this._setDp(this.getSetting('dp_target_humidity'), value);
  }

  async _onCapabilityFanSpeed(value) {
    await this._setDp(this.getSetting('dp_fan_speed'), value);
  }

  async _onCapabilityMode(value) {
    await this._setDp(this.getSetting('dp_mode'), value);
  }

  async _onCapabilityChildLock(value) {
    await this._setDp(this.getSetting('dp_child_lock'), value);
  }

  async _onCapabilityCountdownTimer(value) {
    await this._setDp(this.getSetting('dp_countdown_timer'), value);
  }

  // ── Internal helpers ───────────────────────────────────────────────────────

  // Serialises all SET commands through a queue so concurrent capability
  // changes don't race each other on the TCP socket.
  async _setDp(dp, value) {
    if (!this._connected || !this._tuya) throw new Error('Device not connected');

    const execute = async () => {
      if (!this._connected || !this._tuya) throw new Error('Device not connected');
      try {
        await Promise.race([
          this._tuya.set({ dps: dp, set: value }),
          new Promise((_, rej) =>
            setTimeout(() => rej(new Error('timeout')), CMD_TIMEOUT_MS)
          ),
        ]);
      } catch (err) {
        const msg = (err && err.message) ? err.message : String(err || 'Unknown error');
        // SET timeouts are non-fatal – the device usually applies the value anyway
        if (msg.toLowerCase().includes('timeout')) {
          this.log(`Set DP ${dp} timed out (value may still have been applied)`);
          return;
        }
        throw err;
      }
    };

    // Keep the queue alive even if this task throws
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

  // Public – called by the "refresh_device" flow action
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
    const base  = Math.min(RECONNECT_BASE_MS * Math.pow(2, this._reconnectAttempts), RECONNECT_MAX_MS);
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
