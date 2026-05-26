'use strict';

const Homey          = require('homey');
const TuyaConnection = require('./TuyaConnection');

const SNAPSHOT_DEBOUNCE_MS  = 3000;   // persist dp_snapshot max once per 3 s
const STORE_MIN_INTERVAL_MS = 300000; // write lastDps store at most once per 5 min

/**
 * Shared base for all Tuya Local device drivers.
 *
 * Provides: connect/reconnect lifecycle, polling with watchdog, debounced
 * persistence (dp_snapshot, lastDps store), logging helpers, optional-capability
 * sync, enum-option sync, and capability migration helpers.
 *
 * Subclass contract
 * ─────────────────
 * 1. Call  `await this._baseInit()`  at the top of onInit.
 * 2. Set   `this._triggerDeviceConnected` and `this._triggerDeviceDisconnected`
 *    before calling  `await this._connect()`.
 * 3. Implement  `async _handleDps(dps)`  — called on every incoming data packet.
 * 4. Override   `_onConnected()`         — driver-specific state reset per connect.
 * 5. Override   `async _onPollTick()`    — extra work per poll tick (e.g. energy integration).
 * 6. Override   `async _onDeleted()`     — driver-specific timer/state cleanup.
 */
class BaseTuyaDevice extends Homey.Device {

  // ── Init helper ─────────────────────────────────────────────────────────────

  async _baseInit() {
    this._conn                  = null;
    this._pollTimer             = null;
    this._pollIntervalMs        = 0;
    this._lastDps               = {};
    this._lastRawMeta           = null;
    this._lastDataTime          = null;
    this._connecting            = false;
    this._snapshotDebounceTimer = null;
    this._storeDebounceTimer    = null;
    this._storeLastWriteTime    = 0;   // epoch ms of last successful store write
    this._pushFollowUpTimer     = null;
    this._offlineGraceTimer     = null;

    // Subclass sets these before calling _connect():
    this._triggerDeviceConnected    = null;
    this._triggerDeviceDisconnected = null;

    // Restore last known DPS from store — prevents redundant updates on first poll.
    try {
      const stored = this.getStoreValue('lastDps');
      if (stored && typeof stored === 'object') {
        this._lastDps = stored;
        this._writeDpSnapshot();
      }
    } catch (e) {}
  }

  // ── Hook methods — override in subclass ─────────────────────────────────────

  /** Called inside the 'connected' handler after common state is reset. */
  _onConnected() {}

  /** Called inside the 'disconnected' handler after common cleanup. */
  _onDisconnected(_reason) {}

  /**
   * Called at the start of every poll-timer tick, before the watchdog / GET.
   * SmartPlug overrides this to run trapezoidal energy integration.
   */
  async _onPollTick() {}

  /** Called at the end of onDeleted(), after common cleanup. */
  async _onDeleted() {}

  // ── Logging ─────────────────────────────────────────────────────────────────

  _appLog(message, level = 'info') {
    this.log(message);
    try { this.homey.app.addLog(this.getName(), message, level); } catch (e) {}
  }

  // ── Status helpers ──────────────────────────────────────────────────────────

  _updateLastSeen() {
    const lastSeen = new Date().toLocaleString(this.homey.i18n.getLanguage(), {
      dateStyle: 'short',
      timeStyle: 'medium',
      timeZone:  this.homey.clock.getTimezone(),
    });
    this.setSettings({ last_seen: lastSeen }).catch(() => {});
  }

  _updateStatusSettings(status) {
    this._updateLastSeen();
    this.setSettings({ connection_status: status }).catch(() => {});
  }

  // ── Debounced persistence ───────────────────────────────────────────────────

  /** Write dp_snapshot to homey.settings — debounced to avoid hammering storage. */
  _writeDpSnapshot() {
    clearTimeout(this._snapshotDebounceTimer);
    this._snapshotDebounceTimer = setTimeout(() => {
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
    }, SNAPSHOT_DEBOUNCE_MS);
  }

  /**
   * Persist _lastDps to device store — rate-limited to once per 5 minutes.
   *
   * Tuya devices can send data packets every 30 s. The old 3 s debounce caused
   * up to 2 store writes per minute (≈ 2 880/day) which unnecessarily wears
   * Homey Pro's flash storage.  The new approach schedules one write at most
   * every STORE_MIN_INTERVAL_MS (5 min, ≈ 288/day), while still writing
   * promptly after the very first change.
   *
   * Call _flushStoreSave() for an immediate unconditional write (e.g. onDeleted).
   */
  _scheduleStoreSave() {
    if (this._storeDebounceTimer) return; // already scheduled — coalesce all changes
    const elapsed = Date.now() - this._storeLastWriteTime;
    const delay   = Math.max(0, STORE_MIN_INTERVAL_MS - elapsed);
    this._storeDebounceTimer = setTimeout(() => {
      this._storeDebounceTimer = null;
      this._storeLastWriteTime = Date.now();
      this.setStoreValue('lastDps', { ...this._lastDps }).catch(() => {});
    }, delay);
  }

  /** Immediate, unconditional store write — call from onDeleted to flush pending state. */
  async _flushStoreSave() {
    clearTimeout(this._storeDebounceTimer);
    this._storeDebounceTimer = null;
    this._storeLastWriteTime = Date.now();
    await this.setStoreValue('lastDps', { ...this._lastDps }).catch(() => {});
  }

  // ── Connection ──────────────────────────────────────────────────────────────

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
      // Cancel any pending offline-grace timer — the device came back in time.
      clearTimeout(this._offlineGraceTimer);
      this._offlineGraceTimer = null;
      // Clear dedup cache so the first data packet after (re)connect always
      // writes fresh capability values and refreshes Homey's "last updated" timestamp.
      this._lastDps = {};
      this._onConnected(); // driver-specific state reset before polling starts
      this.setAvailable().catch(() => {});
      this._triggerDeviceConnected?.trigger(this).catch(() => {});
      this._updateStatusSettings('Connected');
      // Initial full state fetch after a short settle delay.
      setTimeout(() => this._conn?.get().catch(() => {}), 500);
      this._startPolling();
    });

    this._conn.on('disconnected', (reason) => {
      this._appLog(reason ? `Disconnected: ${reason}` : 'Disconnected', 'warn');
      this._stopPolling();
      this.setUnavailable(reason || 'Device disconnected').catch(() => {});
      this._updateStatusSettings('Disconnected');
      this._onDisconnected(reason);

      // Only fire the "device disconnected" flow trigger after a grace period.
      // Many Tuya devices (especially pet feeders with power-saving firmware)
      // drop the TCP connection briefly and reconnect on their own within seconds.
      // Firing the trigger immediately causes spurious "offline" notifications.
      // The grace timer is cancelled above in the 'connected' handler if the
      // device comes back before the window expires.
      const graceMs = (this.getSetting('offline_grace_seconds') ?? 60) * 1000;
      clearTimeout(this._offlineGraceTimer);
      this._offlineGraceTimer = setTimeout(() => {
        this._offlineGraceTimer = null;
        this._triggerDeviceDisconnected?.trigger(this).catch(() => {});
      }, graceMs);
    });

    this._conn.on('data', (dps, raw) => {
      this._lastDataTime = Date.now();
      this._updateLastSeen();
      if (raw) {
        this._lastRawMeta = {
          devId: raw.devId ?? null,
          t:     raw.t     ?? null,
          cid:   raw.cid   ?? null,
          uid:   raw.uid   ?? null,
        };
      }

      // If this packet was an unsolicited push (not a GET response), schedule a
      // follow-up GET so the full device state is fetched immediately.  This
      // matters for devices (e.g. AC) that only push a single DP proactively
      // (e.g. DP 1 power) while all other DPs only appear in GET responses.
      if (!this._conn.isPollInFlight) {
        clearTimeout(this._pushFollowUpTimer);
        this._pushFollowUpTimer = setTimeout(() => {
          this._conn?.get().catch(() => {});
        }, 500);
      }

      this._handleDps(dps).catch((err) => this.log('Error handling DPS:', err.message));
    });

    this._conn.on('log', ({ message, level }) => this._appLog(message, level));

    await this._conn.connect();
  }

  // ── Polling ─────────────────────────────────────────────────────────────────

  _startPolling() {
    this._stopPolling();
    const intervalSec = this.getSetting('polling_interval') ?? 30;
    if (!intervalSec || intervalSec <= 0) return;
    this.log(`Polling every ${intervalSec}s`);

    this._pollIntervalMs = intervalSec * 1000;
    this._pollTimer      = setInterval(async () => {
      // Driver-specific work first (e.g. energy integration in SmartPlug).
      await this._onPollTick().catch(() => {});

      // Watchdog: if connected but no data received for 3× poll interval, reconnect.
      if (this._conn?.connected && this._lastDataTime
          && Date.now() - this._lastDataTime > this._pollIntervalMs * 3) {
        this._appLog('No data received for extended period — reconnecting', 'warn');
        await this._connect();
        return;
      }
      this._conn?.get().catch((err) => this.log('Poll failed:', err.message));
    }, this._pollIntervalMs);
  }

  _stopPolling() {
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
  }

  // Public — called by flow actions.
  async pollNow() {
    await this._conn?.get();
  }

  async forceReconnect() {
    // Reset the guard in case a previous connect attempt is still in flight
    // (e.g. firmware is slow and the user force-interrupts via a flow action).
    this._connecting = false;
    this._appLog('Force reconnect requested', 'info');
    await this._connect();
  }

  // ── Capability helpers ──────────────────────────────────────────────────────

  /** Rename / remove capabilities across app versions. Pass `migrations = []` if none. */
  async _migrateCapabilities(migrations = []) {
    for (const { from, to } of migrations) {
      if (this.hasCapability(from) && !this.hasCapability(to)) {
        await this.addCapability(to).catch(() => {});
        await this.removeCapability(from).catch(() => {});
        this.log(`Migrated capability: ${from} → ${to}`);
      }
    }
  }

  /**
   * Add or remove optional capabilities based on their DP setting value.
   * Pass an array of `{ setting, capability }` pairs.
   * A capability is added when setting > 0, removed when setting === 0.
   */
  async _syncOptionalCapabilities(optionals = []) {
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

  /**
   * Update an enum capability's allowed values from a CSV setting string.
   * Skips with a warning if the current value would fall outside the new list.
   */
  async _syncEnumOptions(capabilityId, csv) {
    if (!this.hasCapability(capabilityId)) return;
    const capitalize = (v) => v.charAt(0).toUpperCase() + v.slice(1).replace(/_/g, ' ');
    const opts = (csv || '').split(',').map((v) => v.trim()).filter(Boolean)
      .map((v) => ({ id: v, title: { en: capitalize(v), de: capitalize(v) } }));
    if (opts.length === 0) return;

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
      this._appLog(
        `setCapabilityOptions(${capabilityId}) failed: ${err.message}. ` +
        `Values: [${opts.map((o) => o.id).join(', ')}]`,
        'warn',
      );
    }
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  async onDeleted() {
    this._stopPolling();
    clearTimeout(this._snapshotDebounceTimer);
    clearTimeout(this._pushFollowUpTimer);
    clearTimeout(this._offlineGraceTimer);
    if (this._conn) {
      this._conn.removeAllListeners();
      this._conn.disconnect();
      this._conn = null;
    }
    await this._onDeleted(); // driver-specific cleanup
    await this._flushStoreSave(); // write final DPS state before device is removed
    this.log('Device deleted');
  }
}

module.exports = BaseTuyaDevice;
