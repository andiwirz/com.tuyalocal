'use strict';

const Homey = require('homey');
const TuyAPI = require('tuyapi');

const RECONNECT_DELAY_MS = 10000;

class DehumidifierDevice extends Homey.Device {
  async onInit() {
    this.log('Device initialized:', this.getName());

    this._reconnectTimer = null;
    this._tuya = null;
    this._connected = false;

    this.registerCapabilityListener('onoff', this._onCapabilityOnOff.bind(this));
    this.registerCapabilityListener('target_humidity', this._onCapabilityTargetHumidity.bind(this));

    await this._connect();
  }

  async _connect() {
    if (this._tuya) {
      try {
        this._tuya.disconnect();
      } catch (e) {}
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
      issueGetOnConnect: true,
    });

    this._tuya.on('connected', () => {
      this.log('Connected');
      this._connected = true;
      this.setAvailable().catch(() => {});
    });

    this._tuya.on('disconnected', () => {
      this.log('Disconnected');
      this._connected = false;
      this.setUnavailable('Device disconnected').catch(() => {});
      this._scheduleReconnect();
    });

    this._tuya.on('error', (err) => {
      this.log('Error:', err.message);
      this._connected = false;
      this.setUnavailable(`Error: ${err.message}`).catch(() => {});
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
      this.log('Connection failed:', err.message);
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
        await this.setCapabilityValue('measure_humidity', Number(value)).catch(() => {});
      } else if (dp === settings.dp_target_humidity) {
        await this.setCapabilityValue('target_humidity', Number(value)).catch(() => {});
      } else if (dp === settings.dp_water_full) {
        await this.setCapabilityValue('alarm_water', Boolean(value)).catch(() => {});
      } else {
        this.log(`Unknown DP ${dp}:`, value);
      }
    }
  }

  async _onCapabilityOnOff(value) {
    await this._setDp(this.getSetting('dp_onoff'), value);
  }

  async _onCapabilityTargetHumidity(value) {
    await this._setDp(this.getSetting('dp_target_humidity'), value);
  }

  async _setDp(dp, value) {
    if (!this._connected || !this._tuya) {
      throw new Error('Device not connected');
    }
    await this._tuya.set({ dps: dp, set: value });
  }

  _scheduleReconnect() {
    if (this._reconnectTimer) return;
    this.log(`Reconnecting in ${RECONNECT_DELAY_MS / 1000}s`);
    this._reconnectTimer = setTimeout(async () => {
      this._reconnectTimer = null;
      await this._connect();
    }, RECONNECT_DELAY_MS);
  }

  async onSettings({ newSettings, changedKeys }) {
    const connectionKeys = ['ip', 'device_id', 'local_key', 'version'];
    if (changedKeys.some((k) => connectionKeys.includes(k))) {
      this.log('Connection settings changed, reconnecting');
      await this._connect();
    }
  }

  async onDeleted() {
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    if (this._tuya) {
      try {
        this._tuya.disconnect();
      } catch (e) {}
      this._tuya = null;
    }
    this.log('Device deleted');
  }
}

module.exports = DehumidifierDevice;
