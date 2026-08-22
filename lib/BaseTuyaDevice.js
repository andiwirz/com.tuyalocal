'use strict';

const Homey          = require('homey');
const TuyaConnection = require('./TuyaConnection');

const SNAPSHOT_DEBOUNCE_MS  = 3000;   // persist dp_snapshot max once per 3 s
const STORE_MIN_INTERVAL_MS = 300000; // write lastDps store at most once per 5 min

// Muss mit der Vorgabe von command_gap_ms in app.json uebereinstimmen. Sie steht
// hier ein zweites Mal, weil ein Geraet seine eigene Manifest-Vorgabe nicht lesen
// kann und Homey sie bei bereits eingerichteten Geraeten nicht nachtraegt.
const DEFAULT_COMMAND_GAP_MS = 200;

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
 * 3. Implement  `async _handleDps(dps, meta)`  — called on every incoming data
 *    packet. `meta.isPush` is true when the packet was an unsolicited report from
 *    the device rather than a reply to our own GET/refresh.
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
    this._pendingDps            = {};  // fake-state: { dp: { value, time } }
    this._capOptCache           = {};  // last-set capabilityOptions per capability
    this._dataQueue             = Promise.resolve();
    this._lastRawMeta           = null;
    this._lastDataTime          = null;
    this._connecting            = false;
    this._snapshotDebounceTimer = null;
    this._seenDps               = new Set();  // every DP number this device has ever reported
    this._seenDirty             = false;
    this._seenDebounceTimer     = null;
    this._storeDebounceTimer    = null;
    this._storeLastWriteTime    = 0;   // epoch ms of last successful store write
    this._pushFollowUpTimer     = null;
    this._offlineGraceTimer     = null;
    this._unavailableTimer      = null;
    this._initialGetTimer       = null;
    this._autoReconnectTimer    = null;
    this._gapBackfillTimer      = null;

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

    // Which DP numbers this device has ever reported, and since when we have been
    // watching. Kept apart from lastDps because that one is pruned: drivers delete
    // event DPs from it so the same payload triggers again, which would make the
    // doorbell's ring DP look as though it had never arrived at all.
    try {
      const seen = this.getStoreValue('seenDps');
      if (Array.isArray(seen)) this._seenDps = new Set(seen.map(Number).filter((n) => n > 0));
      // Seed from what is already known, so the record is not empty after an upgrade.
      for (const dp of Object.keys(this._lastDps)) {
        const n = parseInt(dp, 10);
        if (n > 0) this._seenDps.add(n);
      }
      if (!this.getStoreValue('seenSince')) {
        this.setStoreValue('seenSince', Date.now()).catch(() => {});
      }
      if (this._seenDps.size > 0) this._scheduleSeenSave();
    } catch (e) {}

    // Eine neu hinzugekommene Einstellung bleibt bei bereits eingerichteten Geraeten
    // leer: Homey traegt die Vorgabe aus dem Manifest nur beim Einrichten ein. Das
    // Feld sieht dann kaputt aus, und - schlimmer - getSetting liefert null, also
    // haetten genau die Geraete, die es schon gibt, weiterhin keinen Abstand.
    // Einmalig nachtragen; danach ist der Wert gesetzt und dieser Zweig ruht.
    //
    // Nicht mitten in onInit, sondern kurz danach: Ein Schreibvorgang waehrend der
    // Geraeteinitialisierung ist der Zeitpunkt, an dem Homey ihn am ehesten fallen
    // laesst. Und mit Protokolleintrag in beide Richtungen - die erste Fassung
    // verschluckte jeden Fehler, sodass weder im Log noch im Feld zu sehen war, ob
    // der Nachtrag ueberhaupt lief.
    if (this.getSetting('command_gap_ms') == null) {
      this._gapBackfillTimer = this.homey.setTimeout(() => {
        this._gapBackfillTimer = null;
        this.setSettings({ command_gap_ms: DEFAULT_COMMAND_GAP_MS })
          .then(() => this._appLog(
            `Minimum gap between commands set to ${DEFAULT_COMMAND_GAP_MS} ms `
            + '(new setting, not present on this device yet)', 'info'))
          .catch((err) => this._appLog(
            `Could not set the minimum gap between commands: ${err.message}. `
            + `Commands are spaced by ${DEFAULT_COMMAND_GAP_MS} ms anyway; the field `
            + 'stays empty until you save it yourself.', 'warn'));
      }, 2000);
    }

    this._startAutoReconnect();
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

  /**
   * Notes which DP numbers this device reports. Lets a data point the device has
   * simply not mentioned yet be told apart from one it does not have — see
   * findPhantomDps() in app.js, which never switches anything off on this alone.
   */
  _recordSeenDps(dps) {
    let added = false;
    for (const dp of Object.keys(dps || {})) {
      const n = parseInt(dp, 10);
      if (!(n > 0) || this._seenDps.has(n)) continue;
      this._seenDps.add(n);
      added = true;
    }
    if (added) this._scheduleSeenSave();
  }

  /** Debounced and only on a change — this must not add flash writes. */
  _scheduleSeenSave() {
    this._seenDirty = true;
    clearTimeout(this._seenDebounceTimer);
    this._seenDebounceTimer = setTimeout(() => {
      if (!this._seenDirty) return;
      this._seenDirty = false;
      this.setStoreValue('seenDps', [...this._seenDps].sort((a, b) => a - b)).catch(() => {});
    }, SNAPSHOT_DEBOUNCE_MS);
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
          // Which driver the device is paired with. Not used for anything functional,
          // but DP Debug puts it in the copied table: the same DP numbers mean
          // different things per driver, so a report without it is ambiguous.
          driver:    this.driver?.id ?? null,
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
      // destroy(), not disconnect(): this instance is being thrown away, so it must
      // never reconnect again. disconnect() leaves _stopped false, and if its
      // connect() was still in flight — which forceReconnect() makes likely, since it
      // clears the _connecting guard on purpose — the rejection lands in a catch that
      // calls _scheduleReconnect(). The orphan then reopens a real socket to the
      // device while having no listeners left, so it reports nothing and cannot be
      // seen in the log. Tuya firmware accepts exactly one local connection, so that
      // invisible socket starves the live connection for the lifetime of the process
      // and only an app restart clears it.
      this._conn.removeAllListeners();
      this._conn.destroy();
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
      // Cancel any pending unavailable/offline timers — the device came back in time.
      clearTimeout(this._offlineGraceTimer);
      this._offlineGraceTimer = null;
      clearTimeout(this._unavailableTimer);
      this._unavailableTimer = null;
      // Clear dedup cache so the first data packet after (re)connect always
      // writes fresh capability values and refreshes Homey's "last updated" timestamp.
      this._lastDps = {};
      this._onConnected(); // driver-specific state reset before polling starts
      this.setAvailable().catch(() => {});
      this._triggerDeviceConnected?.trigger(this).catch(() => {});
      this._updateStatusSettings('Connected');
      // Initial full state fetch after a short settle delay.
      this._initialGetTimer = setTimeout(() => this._conn?.get().catch(() => {}), 500);
      this._startPolling();
    });

    this._conn.on('disconnected', (reason, detail) => {
      // The detail says how long the connection lasted and whether it ever carried
      // anything, which is what separates "never got anywhere" from "ran fine and
      // then died". It stays out of the reason itself so the device tile keeps the
      // short message.
      const base = reason ? `Disconnected: ${reason}` : 'Disconnected';
      this._appLog(detail ? `${base} (${detail})` : base, 'warn');
      this._stopPolling();
      this._onDisconnected(reason);

      // Delay marking unavailable by 5s — transient disconnects (e.g. device
      // rejecting a command while off) typically reconnect within 3s.
      // Avoids the "unavailable" flash for brief TCP drops.
      clearTimeout(this._unavailableTimer);
      this._unavailableTimer = setTimeout(() => {
        this._unavailableTimer = null;
        if (!this._conn?.connected) {
          this.setUnavailable(reason || 'Device disconnected').catch(() => {});
          this._updateStatusSettings('Disconnected');
        }
      }, 5000);

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
      // Before any filtering or driver handling: a DP that arrives is real, even when
      // this particular value is suppressed further down as a stale reply.
      this._recordSeenDps(dps);
      if (raw) {
        this._lastRawMeta = {
          devId: raw.devId ?? null,
          t:     raw.t     ?? null,
          cid:   raw.cid   ?? null,
          uid:   raw.uid   ?? null,
        };
      }

      // Whether this packet was an unsolicited report from the device rather than a
      // reply to our own GET/refresh. Captured here, not read again inside
      // _handleDps, because that runs off a promise queue — by then the in-flight
      // flags may already describe a different packet.
      //
      // Drivers need this for events that a value comparison cannot detect: a pet
      // feeder reporting "2 servings dispensed" twice in a row is two feeds, but a
      // poll reply re-reporting that same 2 is not a feed at all.
      const isPush = !this._conn.isPollInFlight;

      // If this packet was an unsolicited push (not a GET response), schedule a
      // follow-up GET so the full device state is fetched immediately.  This
      // matters for devices (e.g. AC) that only push a single DP proactively
      // (e.g. DP 1 power) while all other DPs only appear in GET responses.
      if (isPush) {
        clearTimeout(this._pushFollowUpTimer);
        this._pushFollowUpTimer = setTimeout(() => {
          this._conn?.get().catch(() => {});
        }, 500);
      }

      // Filter out DPs that have a fresh pending (fake-state) value — prevents
      // stale poll responses from reverting the UI after a SET command.
      const filtered = {};
      for (const [dpStr, val] of Object.entries(dps)) {
        if (!this._hasFreshPendingValue(dpStr, val)) filtered[dpStr] = val;
      }
      if (Object.keys(filtered).length > 0) {
        this._dataQueue = this._dataQueue
          .then(() => this._handleDps(filtered, { isPush }))
          .catch((err) => this.log('_handleDps error:', err.message));
      }
    });

    this._conn.on('log', ({ message, level }) => this._appLog(message, level));

    await this._conn.connect();
  }

  // ── Polling ─────────────────────────────────────────────────────────────────

  _startPolling() {
    this._stopPolling();
    const intervalSec = this.getSetting('polling_interval') ?? 30;
    // The connection cannot know how often this device is asked, so it is told here.
    // Zero switches the data watchdog off: a device nobody polls is under no
    // obligation to say anything, and tearing it down for silence would be wrong.
    this._conn?.setDataTimeout(intervalSec > 0 ? intervalSec * 1000 : 0);
    if (!intervalSec || intervalSec <= 0) return;
    this.log(`Polling every ${intervalSec}s`);

    this._pollIntervalMs = intervalSec * 1000;
    this._pollTickCount  = 0;
    this._pollTimer      = this.homey.setInterval(async () => {
      // Driver-specific work first (e.g. energy integration in SmartPlug).
      await this._onPollTick().catch(() => {});

      if (!this._conn?.connected) return;

      // Alternate between full GET and lightweight refresh (updatedps).
      // refresh() only requests DPs that changed since last query — less traffic.
      // Connection health is monitored by TuyaConnection's heartbeat watchdog (30s),
      // not by data absence — devices that don't push still have active TCP keepalives.
      //
      // Force a full GET if no DP data received for 30s — ensures fresh state after
      // prolonged silence (e.g. device was busy, network hiccup, or push-less firmware).
      const silentForTooLong = this._lastDataTime
        && Date.now() - this._lastDataTime > 30000;

      this._pollTickCount++;
      if (silentForTooLong || this._pollTickCount % 2 !== 0) {
        this._conn?.get().catch((err) => this.log('Poll failed:', err.message));
      } else {
        this.refreshDps().catch(() => {});
      }
    }, this._pollIntervalMs);
  }

  /**
   * DP numbers this device is configured for, taken from its `dp_*` settings.
   *
   * Used to tell the device exactly which DPs to report in a refresh request.
   * Without a list the library asks for a fixed set (4, 5, 6, 18, 19, 20), so a
   * DP outside it is never requested — which matters for devices that answer
   * nothing but a refresh, and for anything on a high DP number such as 101.
   *
   * Settings whose name starts with `dp_` but that hold a range rather than a DP
   * are excluded; booleans and strings drop out on their own via the type check.
   */
  _configuredDps() {
    // Was hier nicht als DP-Nummer zaehlt, entscheidet dieselbe Regel wie beim
    // Abschalten geratener Vorgaben — frueher stand hier eine handgepflegte Liste
    // zweier Namen, und als der Ventilator einen Farbtemperatur-Bereich bekam,
    // fragte die Refresh-Anfrage fortan den Datenpunkt 100 ab, den es nicht gibt.
    const { isNotADpNumber } = require('./dpCodeMap');
    const out = new Set();
    let settings;
    try { settings = this.getSettings(); } catch (e) { return []; }
    for (const [key, value] of Object.entries(settings || {})) {
      if (!key.startsWith('dp_') || isNotADpNumber(key)) continue;
      if (typeof value !== 'number' || !Number.isInteger(value)) continue;
      if (value >= 1 && value <= 255) out.add(value);
    }
    return [...out].sort((a, b) => a - b);
  }

  /** Refresh, asking for this device's own DPs rather than the library's default set. */
  async refreshDps() {
    return this._conn?.refresh(this._configuredDps());
  }

  /**
   * Records what a fault register actually said, for drivers that have the
   * fault_bits and fault_status settings.
   *
   * The alarm capability can only ever be yes or no, so on its own it turns "the
   * hopper is empty" into "something is wrong" and leaves the user guessing. The
   * decoded text is written to a read-only setting, which puts it in front of the
   * user and into the support bundle, and is logged the first time it appears.
   *
   * @param {*} rawValue  The fault DP's raw value.
   * @returns {{active: boolean, code: number, bits: string[], text: string}}
   */
  _recordFault(rawValue) {
    const { decodeFaultBits } = require('./faultBits');
    // Both reads are guarded. This runs inside the DP loop, so an exception here
    // would abandon the remaining data points of the same report — a device in a
    // bad state must not lose its readings over a cosmetic status line.
    let labels = '';
    let previous = null;
    try { labels = this.getSetting('fault_bits'); } catch (e) {}
    try { previous = this.getSetting('fault_status'); } catch (e) {}

    const decoded = decodeFaultBits(rawValue, labels);
    const text    = decoded.active ? decoded.text : '—';

    // Only on a change: the fault DP is re-reported on every poll, and both the
    // log and the settings write would otherwise repeat for as long as it lasts.
    if (previous !== text) {
      this.setSettings({ fault_status: text }).catch(() => {});
      if (decoded.active) {
        this._appLog(`Fault: ${decoded.text} (register ${decoded.code})`, 'warn');
      } else if (previous && previous !== '—') {
        this._appLog('Fault cleared', 'info');
      }
    }
    return decoded;
  }

  _stopPolling() {
    if (this._pollTimer) {
      this.homey.clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
  }

  _startAutoReconnect() {
    this._stopAutoReconnect();
    const intervalMin = this.getSetting('reconnect_interval') ?? 0;
    if (!intervalMin || intervalMin <= 0) return;
    this.log(`Auto-reconnect every ${intervalMin} min`);
    this._autoReconnectTimer = this.homey.setInterval(async () => {
      if (this._conn?.connected) return; // already connected — nothing to do
      this._appLog('Auto-reconnect triggered (device offline)', 'info');
      await this.forceReconnect();
    }, intervalMin * 60 * 1000);
  }

  _stopAutoReconnect() {
    if (this._autoReconnectTimer) {
      this.homey.clearInterval(this._autoReconnectTimer);
      this._autoReconnectTimer = null;
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

  // ── Set helper ──────────────────────────────────────────────────────────────

  /**
   * Send a DP value via the connection.
   * Automatically adds fireAndForget:true when the device-level "fire_and_forget"
   * setting is enabled, so that devices that drop TCP after a SET command work
   * correctly without needing driver-specific overrides.
   */
  async _set(dp, value, opts = {}) {
    if (this.getSetting('fire_and_forget')) opts = { ...opts, fireAndForget: true };
    // Read per command rather than wired through onSettings in every driver: it is one
    // number, it costs nothing here, and a change takes effect on the next command
    // instead of the next reconnect.
    // ?? statt ||: eine bewusst eingetragene 0 schaltet das Warten ab und darf nicht
    // auf die Vorgabe zurueckfallen. Der Zweig greift nur, bis das Nachtragen oben
    // durch ist - oder falls es fehlschlug.
    this._conn?.setCommandGap(this.getSetting('command_gap_ms') ?? DEFAULT_COMMAND_GAP_MS);
    // Fake-state: remember the pending value so stale poll responses don't overwrite
    // the UI for 5 seconds after a command is sent.
    this._pendingDps[String(dp)] = { value, time: Date.now() };
    return this._conn?.set(dp, value, opts);
  }

  /**
   * Check if a DP has a fresh pending (fake-state) value.
   * Returns true if the incoming device value should be ignored because a SET
   * was sent less than 5 seconds ago with a different value.
   */
  _hasFreshPendingValue(dpStr, incomingValue) {
    const pending = this._pendingDps[dpStr];
    if (!pending) return false;
    if (Date.now() - pending.time > 5000) {
      delete this._pendingDps[dpStr];
      return false;
    }
    // If the device echoes back the SAME value we sent, clear the pending entry
    // (the device confirmed our command — no need to fake anymore).
    if (pending.value === incomingValue) {
      delete this._pendingDps[dpStr];
      return false;
    }
    // Device sent a different value than what we just commanded — keep the fake state.
    return true;
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
      // `setting` may be an array when more than one DP can justify the same
      // capability — doorbell motion, for instance, arrives either on its own event
      // DP or inside a combined alarm message, and the capability has to survive
      // either one being disabled on its own.
      const keys = Array.isArray(setting) ? setting : [setting];
      const dp   = keys.some((key) => this.getSetting(key) > 0);
      if (dp) {
        if (!this.hasCapability(capability))
          await this.addCapability(capability).catch(() => {});
      } else {
        if (this.hasCapability(capability))
          await this.removeCapability(capability).catch(() => {});
      }
    }
  }

  /**
   * Call setCapabilityOptions only when the serialised options differ from the
   * last-applied value. Prevents unnecessary Homey device-update events on
   * every restart when settings haven't changed.
   */
  async _setCapabilityOptionsIfChanged(capabilityId, opts) {
    const key = JSON.stringify(opts);
    if (this._capOptCache[capabilityId] === key) return false;
    await this.setCapabilityOptions(capabilityId, opts);
    this._capOptCache[capabilityId] = key;
    return true;
  }

  /**
   * Corrects a companion value list against a token the device has just sent.
   *
   * The lists come from the manufacturer's specification, and a specification can
   * disagree with the firmware in front of it. One reported heater declares its
   * heating level as the range 1, 2, 3 while actually reporting "level_1": the
   * picker guard below then refuses the list, so the tile keeps working, but the
   * flow card offers 1, 2 and 3 — and writing one of those to the device is
   * discarded without an error. The flow reports success and the heater does not
   * move, which is exactly what its owner saw.
   *
   * Pairing already reconciles this, but only from the snapshot collected during
   * the connection test: a device that does not happen to report the data point in
   * those few seconds keeps the wrong list and nothing says so. Here the device
   * itself provides the evidence, on every report, for as long as it is paired.
   *
   * Deliberately narrow: both lists have to read as the same numbers carrying
   * different prefixes — level_1, level_2, level_3 against 1, 2, 3, in either
   * direction. The count stays as declared, the spelling comes from the device.
   * Anything less obvious is logged and left alone, because a list the user can
   * correct beats one this code guessed at.
   *
   * @param {string} capabilityId  The enum capability the token belongs to.
   * @param {string} settingKey    The companion CSV setting to correct.
   * @param {*}      token         The value the device just reported.
   */
  async _reconcileEnumToken(capabilityId, settingKey, token) {
    const value = String(token);
    let csv;
    try { csv = this.getSetting(settingKey); } catch (e) { return; }
    if (typeof csv !== 'string' || !csv) return;

    const declared = csv.split(',').map((v) => v.trim()).filter(Boolean);
    if (declared.length === 0 || declared.includes(value)) return;

    // Both sides are read as prefix + number, and either prefix may be empty. The
    // rule was one-directional at first: it could turn 1, 2, 3 into level_1, level_2,
    // level_3 but not the other way, because an empty prefix was treated as "no
    // match". A heater that declares level_1 but reports a bare 1 is the same
    // disagreement seen from the other side, and it needs the same repair.
    const shape = (v) => {
      const m = String(v).match(/^(.*?)(\d+)$/);
      return m ? { prefix: m[1], number: m[2] } : null;
    };
    const here = shape(value);
    const there = declared.map(shape);
    const uniform = there.every((x) => x && x.prefix === there[0].prefix);
    if (!here || !uniform || here.prefix === there[0].prefix) {
      // Only once per token, or a device sitting on an unlisted value would say so
      // on every single report.
      if (this._enumWarned !== value) {
        this._enumWarned = value;
        this._appLog(`${capabilityId}: the device reports "${value}", but ${settingKey} is `
          + `[${declared.join(', ')}]. Correct that setting by hand — commands sent with a `
          + 'value the device does not know are discarded without an error.', 'warn');
      }
      return;
    }

    const rebuilt = there.map((x) => `${here.prefix}${x.number}`).join(',');
    if (rebuilt === csv) return;
    try {
      await this.setSettings({ [settingKey]: rebuilt });
      await this._syncEnumOptions(capabilityId, rebuilt);
      this._appLog(`${capabilityId}: kept the declared ${declared.length} steps but in the `
        + `device's own spelling — ${settingKey} is now ${rebuilt}`, 'info');
    } catch (err) {
      this._appLog(`${capabilityId}: could not correct ${settingKey}: ${err.message}`, 'warn');
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
      const changed = await this._setCapabilityOptionsIfChanged(capabilityId, { values: opts });
      if (changed) this._appLog(`${capabilityId} options → ${opts.map((o) => o.id).join(', ')}`, 'info');
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
    this._stopAutoReconnect();
    clearTimeout(this._snapshotDebounceTimer);
    clearTimeout(this._pushFollowUpTimer);
    clearTimeout(this._offlineGraceTimer);
    clearTimeout(this._unavailableTimer);
    clearTimeout(this._initialGetTimer);
    if (this._gapBackfillTimer) this.homey.clearTimeout(this._gapBackfillTimer);
    if (this._conn) {
      this._conn.removeAllListeners();
      this._conn.destroy(); // sets _stopped=true, prevents zombie reconnects
      this._conn = null;
    }
    await this._onDeleted(); // driver-specific cleanup
    await this._flushStoreSave(); // write final DPS state before device is removed

    // Remove this device's entry from the global dp_snapshot so DP Debug does not
    // show ghost entries for devices that have been deleted.
    try {
      const snapshot = this.homey.settings.get('dp_snapshot') || {};
      if (Object.prototype.hasOwnProperty.call(snapshot, this.getData().id)) {
        delete snapshot[this.getData().id];
        this.homey.settings.set('dp_snapshot', snapshot);
      }
    } catch (e) {}

    this.log('Device deleted');
  }
}

module.exports = BaseTuyaDevice;
