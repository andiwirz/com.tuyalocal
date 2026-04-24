'use strict';

const Homey          = require('homey');
const TuyaConnection = require('../../lib/TuyaConnection');

// Maps settings keys → Homey capabilities.
// settable: false = read-only, no capability listener registered.
const DP_PROFILE = [
  { settingKey: 'dp_switch',        capability: 'onoff',           transform: (v)      => Boolean(v),                        settable: true  },
  { settingKey: 'dp_voltage',       capability: 'measure_voltage', transform: (v)      => Number(v) * 0.1,                   settable: false },
  { settingKey: 'dp_current',       capability: 'measure_current', transform: (v)      => Number(v) * 0.001,                 settable: false },
  { settingKey: 'dp_energy',        capability: 'meter_power',     transform: (v)      => Number(v) * 0.001,                 settable: false },
  { settingKey: 'dp_fault',         capability: 'alarm_generic',   transform: (v)      => Number(v) > 0,                     settable: false },
  { settingKey: 'dp_power',         capability: 'measure_power',   transform: (v, dev) => Number(v) * dev._getPowerScale(),  settable: false },
  // Optional: power factor (DP 21 on most power-monitoring plugs, 0–100 %)
  { settingKey: 'dp_power_factor',  capability: 'power_factor',    transform: (v)      => Number(v),                         settable: false },
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
    this._lastPowerTime      = null;  // timestamp of last poll-timer tick
    this._lastPowerWatts     = 0;     // most recent watts reading from device
    this._prevTickPowerWatts = 0;     // watts at the previous poll tick (for trapezoidal averaging)
    this._energyAccum        = 0;     // accumulated kWh (computed from power)
    this._faultAlarmTimer     = null;  // debounce: prevents spurious fault notifications on reconnect
    this._faultAlarmConfirmed = false; // true only after alarm stayed true for debounce period
    this._justReconnected     = false; // true for 30 s after each connect — extends alarm debounce
    this._connecting          = false; // guard against simultaneous _connect() calls

    // Restore last known DPS from store — prevents redundant updates on first poll.
    try {
      const stored = this.getStoreValue('lastDps');
      if (stored && typeof stored === 'object') {
        this._lastDps = stored;
        this._writeDpSnapshot();
      }
    } catch (e) {}

    // Restore accumulated energy so meter_power survives app restarts.
    try {
      const storedEnergy = this.getStoreValue('energyAccum');
      if (typeof storedEnergy === 'number' && storedEnergy > 0) {
        this._energyAccum = storedEnergy;
        this.setCapabilityValue('meter_power', Math.round(this._energyAccum * 1000) / 1000).catch(() => {});
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

  // Capability migrations across app versions.
  async _migrateCapabilities() {
    // relay_status was a capability tile in ≤ v1.0.14 — now it lives in device settings.
    if (this.hasCapability('relay_status')) {
      await this.removeCapability('relay_status').catch(() => {});
      this.log('Migrated: relay_status capability removed (now a device setting)');
    }
  }

  async _syncOptionalCapabilities() {
    const optionals = [
      { setting: 'dp_fault',        capability: 'alarm_generic' },
      { setting: 'dp_power_factor', capability: 'power_factor'  },
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
    if (this._connecting) {
      this._appLog('Connection already in progress — skipping duplicate call', 'warn');
      return;
    }
    this._connecting = true;
    try {
      await this._connectInner();
    } finally {
      this._connecting = false;
    }
  }

  async _connectInner() {
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
      // Reset power-integration baseline — avoids a giant energy spike if the
      // device was offline for an extended period.
      this._lastPowerTime      = null;
      this._prevTickPowerWatts = 0;
      // Grace period: Tuya devices reconnect roughly every hour and can send a
      // transient fault = true as initial state. Extend the alarm debounce to 30 s
      // so the correcting false has time to arrive before we fire a notification.
      this._justReconnected = true;
      setTimeout(() => { this._justReconnected = false; }, 30000);
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

      // relay_status is stored as a device setting (not a capability tile).
      if (settings.dp_relay_status > 0 && dp === settings.dp_relay_status) {
        const KNOWN = ['on', 'off', 'memory'];
        const strVal = String(value);
        if (KNOWN.includes(strVal)) {
          this.setSettings({ relay_status: strVal }).catch(() => {});
        } else {
          this._appLog(
            `relay_status: device reported unknown value "${strVal}". ` +
            `Known values are: ${KNOWN.join(', ')}. ` +
            `If your device uses a different string, please report it via the community forum.`,
            'warn',
          );
        }
        continue;
      }

      if (!entry) {
        this.log(`Unknown DP ${dp}:`, value);
        continue;
      }

      // Auto-detect power scale when dp_power is received
      if (entry.settingKey === 'dp_power' && settings.power_scale === 'auto') {
        const rawNum = Number(value);
        if (rawNum > 2000) {
          this._detectedPowerScale = 0.1;
        } else if (rawNum > 0 && rawNum <= 2000 && !this._powerScaleDetected) {
          // Only lock ×1 scale on a non-zero reading; a reading of 0 (device on
          // but no load) must not permanently lock out the ×0.1 detection path.
          this._detectedPowerScale  = 1;
          this._powerScaleDetected  = true;
        }
      }

      const converted = entry.transform(value, this);

      // For measure_power: capture previous value, set new value, then fire
      // threshold-crossing triggers so the run-listener can filter by args.power.
      if (entry.settingKey === 'dp_power') {
        const prevPower = this.getCapabilityValue('measure_power') ?? 0;
        const watts     = converted;

        // Keep the latest wattage so the poll-timer energy integrator can use it.
        // Anchor _lastPowerTime on the first reading so the integrator knows when
        // to start; subsequent time-stepping is handled entirely in _startPolling.
        this._lastPowerWatts = watts;
        if (this._lastPowerTime === null) this._lastPowerTime = Date.now();

        await this.setCapabilityValue(entry.capability, watts).catch(() => {});
        const powerTokens = { power: watts, prevPower };
        this._triggerPowerAbove.trigger(this, powerTokens, powerTokens).catch(() => {});
        this._triggerPowerBelow.trigger(this, powerTokens, powerTokens).catch(() => {});
      } else if (entry.capability === 'alarm_generic') {
        const prevAlarm = this.getCapabilityValue('alarm_generic');
        await this.setCapabilityValue('alarm_generic', converted).catch(() => {});

        if (!prevAlarm && converted) {
          // Debounce: Tuya devices can send fault = true as a reconnect artifact,
          // followed by false a few seconds later.
          // Use a 30 s window during the grace period after connect; 5 s otherwise.
          const debounceMs = this._justReconnected ? 30000 : 5000;
          clearTimeout(this._faultAlarmTimer);
          this._faultAlarmConfirmed = false;
          this._faultAlarmTimer = setTimeout(() => {
            if (this.getCapabilityValue('alarm_generic') === true) {
              this._faultAlarmConfirmed = true;
              this.homey.notifications.createNotification({
                excerpt: `${this.getName()}: ${this.homey.__('notifications.faultAlarm')}`,
              }).catch(() => {});
            }
          }, debounceMs);
        }

        if (prevAlarm && !converted) {
          clearTimeout(this._faultAlarmTimer);
          this._faultAlarmConfirmed = false;
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
      // ── Energy integration (trapezoidal) ──────────────────────────────────
      // Runs every tick so stable power (unchanged DP value, blocked by dedup)
      // still accumulates correctly.  Only active when dp_energy = 0 (disabled).
      // Trapezoidal formula: (P_prev + P_curr) / 2 × elapsed — averages the
      // power at the start and end of each interval, smoothing load spikes.
      if (this.getSetting('dp_energy') <= 0 && this._lastPowerTime !== null) {
        const now      = Date.now();
        const elapsedH = (now - this._lastPowerTime) / 3_600_000;
        // Cap at 2× poll interval — guards against a spike after a long outage.
        if (elapsedH > 0 && elapsedH < (intervalSec * 2) / 3600) {
          const avgWatts = (this._prevTickPowerWatts + this._lastPowerWatts) / 2;
          // Guard against negative readings from a misbehaving device.
          if (avgWatts > 0) this._energyAccum += (avgWatts * elapsedH) / 1000;
          this.setStoreValue('energyAccum', this._energyAccum).catch(() => {});
          this.setCapabilityValue('meter_power',
            Math.round(this._energyAccum * 1000) / 1000).catch(() => {});
        }
        this._prevTickPowerWatts = this._lastPowerWatts;
        this._lastPowerTime      = now;
      }
      // ──────────────────────────────────────────────────────────────────────

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

  // Public – called by the "plug_reset_energy" flow action.
  async resetEnergy() {
    this._energyAccum    = 0;
    this._lastPowerTime  = null;
    this._lastPowerWatts = 0;
    await this.setStoreValue('energyAccum', 0).catch(() => {});
    await this.setCapabilityValue('meter_power', 0).catch(() => {});
    this._appLog('Energy accumulator reset', 'info');
  }

  // Public – called by the "plug_set_countdown" flow action.
  // seconds = 0 cancels any active countdown.
  async setCountdown(seconds) {
    const dp = this.getSetting('dp_countdown');
    if (!dp || dp <= 0) throw new Error('Countdown DP not configured (set dp_countdown in device settings)');
    await this._conn?.set(dp, Math.round(seconds));
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
    if (changedKeys.some((k) => ['dp_fault', 'dp_power_factor'].includes(k))) {
      await this._syncOptionalCapabilities();
    }
    // User changed the Turn On Behavior dropdown → send command to device immediately.
    if (changedKeys.includes('relay_status')) {
      const dp = this.getSetting('dp_relay_status');
      if (dp > 0) {
        await this._conn?.set(dp, this.getSetting('relay_status'))
          .catch((err) => this._appLog(`relay_status set failed: ${err.message}`, 'warn'));
      } else {
        this._appLog('Turn On Behavior changed but dp_relay_status = 0 — no command sent. Set the DP number first.', 'warn');
      }
    }
  }

  async onDeleted() {
    this._stopPolling();
    clearTimeout(this._faultAlarmTimer);
    if (this._conn) {
      this._conn.removeAllListeners();
      this._conn.disconnect();
      this._conn = null;
    }
    this.log('Device deleted');
  }
}

module.exports = SmartPlugDevice;
