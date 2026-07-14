'use strict';

const BaseTuyaDevice = require('../../lib/BaseTuyaDevice');

// Capabilities that are boolean in nature â€” used in _dpToCap to coerce to boolean
const BOOLEAN_CAPS = new Set([
  'onoff', 'alarm_generic', 'alarm_contact', 'alarm_co', 'alarm_co2',
  'alarm_fire', 'alarm_flood', 'alarm_heat', 'alarm_motion', 'alarm_pm25',
  'alarm_smoke', 'alarm_tamper', 'alarm_water',
]);
const GENERIC_SWITCH_RE = /^generic_switch_\d+$/;

class GenericDevice extends BaseTuyaDevice {
  async onInit() {
    this.log('GenericDevice initialized:', this.getName());

    await this._baseInit();

    // Driver-specific state
    this._debounceTimers  = new Map(); // keyed by capability id â€” cleared on each _registerListeners()
    this._mappingsCache   = null;      // parsed dp_config â€” invalidated on settings change (#3)

    await this._migrateCapabilities([]);
    await this._syncCapabilities();

    // â”€â”€ Flow trigger cards â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    this._triggerDeviceConnected    = this.homey.flow.getDeviceTriggerCard('generic_device_connected');
    this._triggerDeviceDisconnected = this.homey.flow.getDeviceTriggerCard('generic_device_disconnected');
    this._triggerDpChanged          = this.homey.flow.getDeviceTriggerCard('generic_dp_changed');

    this._registerListeners();

    await this._connect();
  }

  // â”€â”€ Hook overrides â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  async _onDeleted() {
    for (const timer of this._debounceTimers.values()) clearTimeout(timer);
    this._debounceTimers.clear();
  }

  // â”€â”€ DP config helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  /**
   * Returns the parsed dp_config array. Caches the result so JSON.parse is
   * not called on every incoming DPS packet. Cache is invalidated in onSettings
   * whenever dp_config changes.
   */
  _getMappings() {
    if (this._mappingsCache !== null) return this._mappingsCache;

    try {
      const raw = this.getSetting('dp_config');
      if (!raw || raw.trim() === '') {
        this._mappingsCache = [];
        return this._mappingsCache;
      }
      const arr = JSON.parse(raw);
      if (!Array.isArray(arr)) {
        this._appLog('dp_config is not a JSON array â€” ignoring', 'warn');
        this._mappingsCache = [];
        return this._mappingsCache;
      }
      // Validate each entry: must have a positive integer dp and a non-empty cap string.
      const valid = [];
      for (const entry of arr) {
        if (typeof entry.dp !== 'number' || entry.dp <= 0 || !Number.isInteger(entry.dp)) {
          this._appLog(`dp_config entry skipped â€” invalid dp: ${JSON.stringify(entry)}`, 'warn');
          continue;
        }
        if (typeof entry.cap !== 'string' || entry.cap.trim() === '') {
          this._appLog(`dp_config entry skipped â€” missing cap: ${JSON.stringify(entry)}`, 'warn');
          continue;
        }
        // Normalise flags so downstream code can use strict equality.
        // `readonly: true`  â€” never register a capability listener (no writes to device)
        // `invert: true`    â€” mirror numeric value within [min, max] on both read & write
        entry.readonly = entry.readonly === true;
        entry.invert   = entry.invert   === true;
        valid.push(entry);
      }
      this._mappingsCache = valid;
    } catch (e) {
      this._appLog(`dp_config JSON parse failed: ${e.message}`, 'warn');
      this._mappingsCache = [];
    }

    return this._mappingsCache;
  }

  /** Force re-parse on next _getMappings() call. */
  _invalidateMappingsCache() {
    this._mappingsCache = null;
  }

  async _syncCapabilities() {
    const mappings    = this._getMappings();
    const mappedCaps  = new Set(mappings.map((m) => m.cap));

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

    // Build enum values from options CSV, with optional display labels.
    if (mapping.options && typeof mapping.options === 'string') {
      const vals   = mapping.options.split(',').map((v) => v.trim()).filter(Boolean);
      const labels = mapping.labels
        ? mapping.labels.split(',').map((l) => l.trim())
        : [];
      if (vals.length > 0) {
        opts.values = vals.map((v, i) => ({
          id:    v,
          title: { en: labels[i] || v, de: labels[i] || v },
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

  _registerListeners() {
    const DEBOUNCE_MS = 300;

    // Clear any pending debounce timers from the previous registration pass.
    // This prevents stale timers from firing after a dp_config change.
    for (const timer of this._debounceTimers.values()) clearTimeout(timer);
    this._debounceTimers.clear();

    const mappings = this._getMappings();

    for (const mapping of mappings) {
      if (!mapping.settable) continue;
      if (mapping.readonly)  continue; // sensor-only DP â€” never write
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
              this._set(mapping.dp, dpValue)
                .then(resolve).catch(resolve);
            }, DEBOUNCE_MS));
          });
        });
      } else {
        this.registerCapabilityListener(mapping.cap, async (value) => {
          const dpValue = this._capToDP(value, mapping);
          await this._set(mapping.dp, dpValue);
        });
      }
    }
  }

  // â”€â”€ Value conversion â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  /**
   * Helper: mirror a numeric value within [min, max].
   * Used when `mapping.invert = true` â€” flips the range so that, e.g.,
   * a curtain motor where 0 = open and 100 = closed becomes 100 = open, 0 = closed.
   * Requires both `mapping.min` and `mapping.max` to be defined; no-ops otherwise.
   */
  _invertNumber(value, mapping) {
    if (mapping.min == null || mapping.max == null) return value;
    return mapping.max + mapping.min - value;
  }

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
      // Apply invert before scale so the inversion happens in capability-space.
      const v = mapping.invert ? this._invertNumber(value, mapping) : value;
      if (mapping.float === true || mapping.integer === false) return v / (mapping.scale || 1);
      return Math.round(v / (mapping.scale || 1));
    }
    return value;
  }

  _dpToCap(rawValue, mapping) {
    const scale = mapping.scale || 1;

    if (typeof rawValue === 'number') {
      // Apply scale first (converts raw DP units â†’ capability units),
      // then invert if requested.
      const scaled = scale !== 1 ? rawValue * scale : rawValue;
      return mapping.invert ? this._invertNumber(scaled, mapping) : scaled;
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

  // â”€â”€ DPS handling â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  async _handleDps(dps) {
    const mappings = this._getMappings();
    let   changed  = false;

    for (const [dpStr, rawValue] of Object.entries(dps)) {
      if (this._lastDps[dpStr] === rawValue) continue;
      this._lastDps[dpStr] = rawValue;
      changed = true;

      const dpNum   = parseInt(dpStr, 10);
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

    // Debounced persistence â€” avoids hammering storage on every DPS packet.
    if (changed) {
      this._scheduleStoreSave();
      this._writeDpSnapshot();
    }
  }

  // â”€â”€ Homey lifecycle â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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
    if (changedKeys.includes('reconnect_interval')) this._startAutoReconnect();
    if (changedKeys.includes('dp_config')) {
      this.log('DP config changed, syncing capabilities and listeners');
      this._invalidateMappingsCache();
      await this._syncCapabilities();
      this._registerListeners();
    }
  }
}

module.exports = GenericDevice;
