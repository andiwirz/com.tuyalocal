'use strict';

const Homey          = require('homey');
const TuyaConnection = require('../../lib/TuyaConnection');

// Capabilities that are boolean in nature — used in _dpToCap to coerce to boolean
const BOOLEAN_CAPS = new Set([
  'onoff', 'alarm_generic', 'alarm_contact', 'alarm_co', 'alarm_co2',
  'alarm_fire', 'alarm_flood', 'alarm_heat', 'alarm_motion', 'alarm_pm25',
  'alarm_smoke', 'alarm_tamper', 'alarm_water',
]);
const GENERIC_SWITCH_RE = /^generic_switch_\d+$/;

class GenericDevice extends Homey.Device {
  async onInit() {
    this.log('GenericDevice initialized:', this.getName());

    this._conn            = null;
    this._pollTimer       = null;
    this._lastDps         = {};
    this._lastRawMeta     = null;
    this._lastDataTime    = null;
    this._debounceTimers  = new Map(); // keyed by capability id — cleared on each _registerListeners()
    this._connecting      = false;     // guard against simultaneous _connect() calls

    // Restore last known DPS from store — prevents redundant updates on first poll
    try {
      const stored = this.getStoreValue('lastDps');
      if (stored && typeof stored === 'object') {
        this._lastDps = stored;
        this._writeDpSnapshot();
      }
    } catch (e) {}

    await this._migrateCapabilities();
    await this._syncCapabilities();

    // ── Flow trigger cards ───────────────────────────────────────────────────
    this._triggerDeviceConnected    = this.homey.flow.getDeviceTriggerCard('generic_device_connected');
    this._triggerDeviceDisconnected = this.homey.flow.getDeviceTriggerCard('generic_device_disconnected');
    this._triggerDpChanged          = this.homey.flow.getDeviceTriggerCard('generic_dp_changed');

    this._registerListeners();

    await this._connect();
  }

  // ── DP config helpers ──────────────────────────────────────────────────────

  _getMappings() {
    try {
      const raw = this.getSetting('dp_config');
      if (!raw || raw.trim() === '') return [];
      const arr = JSON.parse(raw);
      if (!Array.isArray(arr)) {
        this._appLog('dp_config is not a JSON array — ignoring', 'warn');
        return [];
      }
      // Validate each entry: must have a positive integer dp and a non-empty cap string.
      const valid = [];
      for (const entry of arr) {
        if (typeof entry.dp !== 'number' || entry.dp <= 0 || !Number.isInteger(entry.dp)) {
          this._appLog(`dp_config entry skipped — invalid dp: ${JSON.stringify(entry)}`, 'warn');
          continue;
        }
        if (typeof entry.cap !== 'string' || entry.cap.trim() === '') {
          this._appLog(`dp_config entry skipped — missing cap: ${JSON.stringify(entry)}`, 'warn');
          continue;
        }
        valid.push(entry);
      }
      return valid;
    } catch (e) {
      this._appLog(`dp_config JSON parse failed: ${e.message}`, 'warn');
      return [];
    }
  }

  async _syncCapabilities() {
    const mappings = this._getMappings();
    const mappedCaps = new Set(mappings.map((m) => m.cap));

    // Add capabilities that are in the mapping but not yet on the device
    for (const mapping of mappings) {
      if (!this.hasCapability(mapping.cap)) {
        try {
          await this.addCapability(mapping.cap);
          this.log(`Added capability: ${mapping.cap}`);
        } catch (err) {
          this.log(`Failed to add capability ${mapping.cap}:`, err.message);
        }
      }
      await this._applyCapabilityOptions(mapping);
    }

    // Remove generic_* capabilities that are no longer in the mapping
    for (const cap of this.getCapabilities()) {
      if (cap.startsWith('generic_') && !mappedCaps.has(cap)) {
        try {
          await this.removeCapability(cap);
          this.log(`Removed capability: ${cap}`);
        } catch (err) {
          this.log(`Failed to remove capability ${cap}:`, err.message);
        }
      }
    }
  }

  async _applyCapabilityOptions(mapping) {
    if (!this.hasCapability(mapping.cap)) return;

    const opts = {};

    if (mapping.label) {
      opts.title = { en: mapping.label, de: mapping.label };
    }
    if (mapping.unit !== undefined && mapping.unit !== null) {
      opts.units = { en: mapping.unit, de: mapping.unit };
    }
    if (mapping.min !== undefined && mapping.min !== null) {
      opts.min = mapping.min;
    }
    if (mapping.max !== undefined && mapping.max !== null) {
      opts.max = mapping.max;
    }
    if (mapping.step !== undefined && mapping.step !== null) {
      opts.step = mapping.step;
    }

    // Build enum values from options CSV
    if (mapping.options && typeof mapping.options === 'string') {
      const vals = mapping.options.split(',').map((v) => v.trim()).filter(Boolean);
      if (vals.length > 0) {
        opts.values = vals.map((v) => ({
          id: v,
          title: { en: v, de: v },
        }));
      }
    }

    if (Object.keys(opts).length === 0) return;

    try {
      await this.setCapabilityOptions(mapping.cap, opts);
    } catch (err) {
      this.log(`setCapabilityOptions(${mapping.cap}) failed: ${err.message}`);
    }
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

  _registerListeners() {
    const DEBOUNCE_MS = 300;

    // Clear any pending debounce timers from the previous registration pass.
    // This prevents stale timers from firing after a dp_config change.
    for (const timer of this._debounceTimers.values()) clearTimeout(timer);
    this._debounceTimers.clear();

    const mappings = this._getMappings();

    for (const mapping of mappings) {
      if (!mapping.settable) continue;
      if (!this.hasCapability(mapping.cap)) continue;

      // Numeric capabilities with min/max (sliders) or generic_number_* get debounce
      // so rapid slider drags don't flood the device with commands.
      const needsDebounce = mapping.cap.startsWith('generic_number_')
        || (mapping.min !== undefined && mapping.max !== undefined);

      if (needsDebounce) {
        // Store timers in the shared Map so they can be cancelled on re-registration.
        this.registerCapabilityListener(mapping.cap, (value) => {
          clearTimeout(this._debounceTimers.get(mapping.cap));
          // Resolve immediately so Homey UI stays responsive; command is delayed.
          return new Promise((resolve) => {
            this._debounceTimers.set(mapping.cap, setTimeout(() => {
              const dpValue = this._capToDP(value, mapping);
              this._conn?.set(mapping.dp, dpValue)
                .then(resolve).catch(resolve);
            }, DEBOUNCE_MS));
          });
        });
      } else {
        this.registerCapabilityListener(mapping.cap, async (value) => {
          const dpValue = this._capToDP(value, mapping);
          await this._conn?.set(mapping.dp, dpValue);
        });
      }
    }
  }

  // ── Value conversion ───────────────────────────────────────────────────────

  _capToDP(value, mapping) {
    if (typeof value === 'boolean') {
      return value;
    }
    if (typeof value === 'string') {
      if (mapping.writeMap) {
        try {
          const wm = typeof mapping.writeMap === 'string'
            ? JSON.parse(mapping.writeMap)
            : mapping.writeMap;
          if (wm && wm[value] !== undefined) return wm[value];
        } catch (e) {
          this._appLog(`writeMap parse failed for DP ${mapping.dp}: ${e.message}`, 'warn');
        }
      }
      return value;
    }
    if (typeof value === 'number') {
      if (mapping.integer === false) return value / (mapping.scale || 1);
      return Math.round(value / (mapping.scale || 1));
    }
    return value;
  }

  _dpToCap(rawValue, mapping) {
    const scale = mapping.scale || 1;

    if (typeof rawValue === 'number' && scale !== 1) {
      return rawValue * scale;
    }

    if (typeof rawValue === 'string' && mapping.readMap) {
      try {
        const rm = typeof mapping.readMap === 'string'
          ? JSON.parse(mapping.readMap)
          : mapping.readMap;
        if (rm && rm[rawValue] !== undefined) return rm[rawValue];
      } catch (e) {
        this._appLog(`readMap parse failed for DP ${mapping.dp}: ${e.message}`, 'warn');
      }
      return rawValue;
    }

    // Coerce to boolean for boolean-type capabilities
    const cap = mapping.cap || '';
    if (BOOLEAN_CAPS.has(cap) || GENERIC_SWITCH_RE.test(cap)) {
      return Boolean(rawValue);
    }

    return rawValue;
  }

  // ── DPS handling ───────────────────────────────────────────────────────────

  async _handleDps(dps) {
    const mappings = this._getMappings();
    let   changed  = false;

    for (const [dpStr, rawValue] of Object.entries(dps)) {
      if (this._lastDps[dpStr] === rawValue) continue;
      this._lastDps[dpStr] = rawValue;
      changed = true;

      const dpNum  = parseInt(dpStr, 10);
      const mapping = mappings.find((m) => m.dp === dpNum);

      // Always trigger dp_changed flow card
      this._triggerDpChanged
        .trigger(this, { dp: dpStr, value: String(rawValue) })
        .catch(() => {});

      if (!mapping) {
        this.log(`Unmapped DP ${dpNum}:`, rawValue);
        continue;
      }

      if (!this.hasCapability(mapping.cap)) continue;

      const converted = this._dpToCap(rawValue, mapping);
      await this.setCapabilityValue(mapping.cap, converted).catch((err) => {
        this.log(`setCapabilityValue(${mapping.cap}) failed:`, err.message);
      });
    }

    if (changed) {
      this.setStoreValue('lastDps', this._lastDps).catch(() => {});
      this._writeDpSnapshot();
    }
  }

  // ── Connection ─────────────────────────────────────────────────────────────

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
      this.setUnavailable(this.homey.__('errors.missing_settings') || 'Missing settings').catch(() => {});
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
      this._updateLastSeen();
      if (raw) {
        this._lastRawMeta = {
          devId: raw.devId ?? null,
          t:     raw.t     ?? null,
          cid:   raw.cid   ?? null,
          uid:   raw.uid   ?? null,
        };
      }
      this.log('Raw DPS received:', JSON.stringify(dps));
      this._handleDps(dps).catch((err) => this.log('Error handling DPS:', err.message));
    });

    this._conn.on('log', ({ message, level }) => this._appLog(message, level));

    await this._conn.connect();
  }

  // ── Polling ────────────────────────────────────────────────────────────────

  _startPolling() {
    this._stopPolling();
    const intervalSec = this.getSetting('polling_interval') ?? 30;
    if (!intervalSec || intervalSec <= 0) return;
    this.log(`Polling every ${intervalSec}s`);

    const intervalMs = intervalSec * 1000;
    this._pollTimer  = setInterval(async () => {
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

  // Public – called by the "generic_refresh_device" flow action
  async pollNow() {
    await this._conn?.get();
  }

  // Public – called by the "generic_force_reconnect" flow action
  async forceReconnect() {
    this._appLog('Force reconnect requested', 'info');
    await this._connect();
  }

  // ── Utilities ──────────────────────────────────────────────────────────────

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
    if (changedKeys.includes('dp_config')) {
      this.log('DP config changed, syncing capabilities and listeners');
      await this._syncCapabilities();
      this._registerListeners();
    }
  }

  async onDeleted() {
    this._stopPolling();
    for (const timer of this._debounceTimers.values()) clearTimeout(timer);
    this._debounceTimers.clear();
    if (this._conn) {
      this._conn.removeAllListeners();
      this._conn.disconnect();
      this._conn = null;
    }
    this.log('Device deleted');
  }
}

module.exports = GenericDevice;
