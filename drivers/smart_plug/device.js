'use strict';

const Homey          = require('homey');
const TuyaConnection = require('../../lib/TuyaConnection');

// Maps settings keys → Homey capabilities.
// settable: false = read-only, no capability listener registered.
const DP_PROFILE = [
  { settingKey: 'dp_switch',       capability: 'onoff',           transform: (v)      => Boolean(v),                        settable: true  },
  { settingKey: 'dp_voltage',      capability: 'measure_voltage', transform: (v)      => Number(v) * 0.1,                   settable: false },
  { settingKey: 'dp_current',      capability: 'measure_current', transform: (v)      => Number(v) * 0.001,                 settable: false },
  { settingKey: 'dp_energy',       capability: 'meter_power',     transform: (v)      => Number(v) * 0.001,                 settable: false },
  { settingKey: 'dp_fault',        capability: 'alarm_generic',   transform: (v)      => Number(v) > 0,                     settable: false },
  { settingKey: 'dp_relay_status', capability: 'relay_status',    transform: (v)      => String(v),                         settable: true  },
  { settingKey: 'dp_power',        capability: 'measure_power',   transform: (v, dev) => Number(v) * dev._getPowerScale(),  settable: false },
];

class SmartPlugDevice extends Homey.Device {
  async onInit() {
    this.log('Device initialized:', this.getName());

    this._conn               = null;
    this._pollTimer          = null;
    this._lastDps            = {};
    this._lastRawMeta        = null;
    this._lastDataTime       = null;
    this._detectedPowerScale = 0.1;   // default scale until auto-detected
    this._powerScaleDetected = false; // set to true once scale is locked in

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

    // ── Flow trigger cards ───────────────────────────────────────────────────
    this._triggerDeviceConnected    = this.homey.flow.getDeviceTriggerCard('plug_device_connected');
    this._triggerDeviceDisconnected = this.homey.flow.getDeviceTriggerCard('plug_device_disconnected');
    this._triggerDpChanged          = this.homey.flow.getDeviceTriggerCard('plug_dp_changed');
    this._triggerPowerAbove         = this.homey.flow.getDeviceTriggerCard('plug_power_above');
    this._triggerPowerBelow         = this.homey.flow.getDeviceTriggerCard('plug_power_below');

    // ── Capability listeners (auto-registered from DP_PROFILE) ──────────────
    for (const entry of DP_PROFILE) {
      if (!entry.settable) continue;

      this.registerCapabilityListener(entry.capability, async (value) => {
        await this._conn?.set(this.getSetting(entry.settingKey), value);
      });
    }

    await this._connect();
  }

  _getPowerScale() {
    const s = this.getSetting('power_scale');
    if (s === '1')   return 1;
    if (s === '0.1') return 0.1;
    // 'auto': detect from last known power value — if raw value ever exceeded 2000, scale is 0.1
    return this._detectedPowerScale || 0.1;
  }

  // Placeholder for capability renames across app versions.
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

  async _syncOptionalCapabilities() {
    const optionals = [
      { setting: 'dp_fault',        capability: 'alarm_generic' },
      { setting: 'dp_relay_status', capability: 'relay_status'  },
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

      // Auto-detect power scale when dp_power is received
      if (entry.settingKey === 'dp_power' && settings.power_scale === 'auto') {
        const rawNum = Number(value);
        if (rawNum > 2000) {
          this._detectedPowerScale = 0.1;
        } else if (rawNum >= 0 && rawNum <= 2000 && !this._powerScaleDetected) {
          this._detectedPowerScale  = 1;
          this._powerScaleDetected  = true;
        }
      }

      const converted = entry.transform(value, this);

      // For measure_power: capture previous value, set new value, then fire
      // threshold-crossing triggers so the run-listener can filter by args.power.
      if (entry.settingKey === 'dp_power') {
        const prevPower = this.getCapabilityValue('measure_power') ?? 0;
        await this.setCapabilityValue(entry.capability, converted).catch(() => {});
        const powerTokens = { power: converted, prevPower };
        this._triggerPowerAbove.trigger(this, powerTokens, powerTokens).catch(() => {});
        this._triggerPowerBelow.trigger(this, powerTokens, powerTokens).catch(() => {});
      } else if (entry.capability === 'alarm_generic') {
        const prevAlarm = this.getCapabilityValue('alarm_generic');
        await this.setCapabilityValue('alarm_generic', converted).catch(() => {});
        if (!prevAlarm && converted) {
          this.homey.notifications.createNotification({
            excerpt: `${this.getName()}: ${this.homey.__('notifications.faultAlarm')}`,
          }).catch(() => {});
        }
      } else {
        await this.setCapabilityValue(entry.capability, converted).catch(() => {});
      }
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

  // Public – called by the "plug_refresh_device" flow action.
  async pollNow() {
    await this._conn?.get();
  }

  // Public – called by the "plug_force_reconnect" flow action.
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
    if (changedKeys.some((k) => ['dp_fault', 'dp_relay_status'].includes(k))) {
      await this._syncOptionalCapabilities();
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

module.exports = SmartPlugDevice;
