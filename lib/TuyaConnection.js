'use strict';

const { EventEmitter } = require('events');
const TuyAPI = require('tuyapi');

const RECONNECT_BASE_MS    = 3000;   // first attempt ≈3 s; backs off exponentially to RECONNECT_MAX_MS
const RECONNECT_MAX_MS     = 300000;
const CMD_TIMEOUT_MS       = 5000;
const HEARTBEAT_TIMEOUT_MS = 30000; // 30 s — detect dead sockets twice as fast

// Protocol versions tried in order when the configured version keeps failing.
// Handles devices that changed protocol after a firmware OTA update.
const VERSION_FALLBACKS    = ['3.3', '3.4', '3.1', '3.5'];
const VERSION_ROTATE_AFTER = 5;  // rotate to next version after this many consecutive failures

/**
 * Wraps a TuyAPI connection with reconnect, heartbeat watchdog,
 * command queue, and protocol-aware set().
 *
 * Events:
 *   'connected'              – socket established
 *   'disconnected' (reason)  – socket closed or fatal error
 *   'data'         (dps)     – DPS object received
 *   'log'          ({message, level}) – internal log entry
 */
class TuyaConnection extends EventEmitter {
  constructor({ id, key, ip, version }) {
    super();
    this._id          = id;
    this._key         = key;
    this._ip          = ip;
    this._versionOrig = String(version || '3.3');  // configured version — never mutated
    this._version     = this._versionOrig;

    this._tuya              = null;
    this._connected         = false;
    this._cmdQueue          = Promise.resolve();
    this._heartbeatTimer    = null;
    this._pingTimer         = null;  // outbound keepalive ping
    this._reconnectTimer    = null;
    this._reconnectAttempts = 0;
    this._versionTried      = null;  // Set<string> — populated during protocol rotation
    this._getPending        = false;
    this._stopped           = false;  // set by destroy() — prevents all reconnects after teardown

    // Log-spam throttle state
    this._lastLogMsg        = null;
    this._logRepeatCount    = 0;
  }

  get connected()        { return this._connected; }
  /** True while a GET request is in flight — false means incoming data is a push. */
  get isPollInFlight()   { return this._getPending; }
  /** True for protocol 3.4 and 3.5 — fire-and-forget SET, status pushed asynchronously. */
  get _isNewProtocol()   { return this._version === '3.4' || this._version === '3.5'; }

  async connect() {
    if (this._stopped) return;  // destroyed — never reconnect

    this._stopHeartbeatWatchdog();
    if (this._tuya) {
      // Strip listeners first so events from the dying socket cannot fire on the
      // new connection's callbacks.  Re-attach a no-op error handler so any
      // in-flight parse errors (e.g. HMAC mismatch) are absorbed, not thrown.
      try { this._tuya.removeAllListeners(); } catch (e) {}
      try { this._tuya.on('error', () => {}); } catch (e) {}
      try { this._tuya.disconnect(); } catch (e) {}
      this._tuya = null;
    }

    this._tuya = new TuyAPI({
      id:                this._id,
      key:               this._key,
      ip:                this._ip,
      version:           this._version,
      issueGetOnConnect: false,
    });

    this._tuya.on('connected', () => {
      // Guard: destroy() may have been called while connect() was in flight.
      // If so, immediately close the socket and do not start the heartbeat watchdog
      // or emit 'connected' — that would turn this into a zombie connection.
      if (this._stopped) {
        try { this._tuya?.removeAllListeners(); } catch (e) {}
        try { this._tuya?.disconnect(); } catch (e) {}
        return;
      }
      this._connected         = true;
      this._reconnectAttempts = 0;
      this._versionTried      = null;  // reset rotation tracking on success
      this._lastLogMsg        = null;
      this._logRepeatCount    = 0;
      if (this._version !== this._versionOrig) {
        this._emit('log',
          `Connected on protocol ${this._version} (configured: ${this._versionOrig}). ` +
          `Update "Protocol Version" in device settings to avoid the retry delay on next reconnect.`,
          'warn');
      }
      this._resetHeartbeatWatchdog();
      this.emit('connected');
    });

    this._tuya.on('disconnected', () => {
      this._handleDisconnect('socket closed');
    });

    this._tuya.on('error', (err) => {
      const msg = err?.message || String(err || 'unknown');

      // Error 904 = "no new data" on protocol 3.4/3.5 — the device is still connected
      // and responding; it simply has no state changes to report since the last poll.
      // This is normal behaviour, not a fault. Silently ignore it so it never appears
      // in the log and never triggers a reconnect.
      if (msg.includes('904')) return;

      // Error 900 = IR/RF blaster has no persistent DP state to return — the device is
      // reachable and can accept SET commands, but status() GET returns nothing.
      // Silently ignore so the connection stays up and commands still work.
      if (msg.includes('900')) return;

      // Timeouts are a real disconnect — the socket is dead.  Treat them the same
      // as any other error so we reconnect rather than leaving a zombie connection.
      const isReset = msg.includes('ECONNRESET') || msg.includes('ECONNREFUSED');
      const hint    = isReset
        ? ' — likely protocol version mismatch. Set Protocol Version to Auto-detect in the device Settings.'
        : '';
      const level   = msg.toLowerCase().includes('timeout') ? 'warn' : 'error';
      this._throttleLog(`${msg}${hint}`, level);
      this._handleDisconnect(msg);
    });

    this._tuya.on('data', (data) => {
      this._resetHeartbeatWatchdog();
      if (data?.dps) this.emit('data', data.dps, data);
    });

    // Some TuyAPI builds emit 'heartbeat' for keep-alive packets.
    this._tuya.on('heartbeat', () => this._resetHeartbeatWatchdog());

    try {
      await this._tuya.connect();
    } catch (err) {
      const msg     = err.message || String(err);
      const isReset = msg.includes('ECONNRESET') || msg.includes('ECONNREFUSED');
      const hint    = isReset
        ? ' — likely protocol version mismatch. Set Protocol Version to Auto-detect in the device Settings.'
        : '';
      if (this._stopped) return;  // destroyed — don't reconnect
      this._throttleLog(`Connection failed: ${msg}${hint}`, 'error');
      this._scheduleReconnect();
    }
  }

  /**
   * Permanent teardown — called when the Homey device is deleted.
   * Sets _stopped so that any in-flight connect() or scheduled reconnect cannot
   * revive this connection (zombie-connection prevention).
   */
  destroy() {
    this._stopped = true;
    this.disconnect();
  }

  disconnect() {
    this._stopHeartbeatWatchdog();
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    if (this._tuya) {
      // Remove all listeners BEFORE disconnecting so that any in-flight async
      // connect() whose _tuya reference we just stole cannot fire callbacks on us.
      try { this._tuya.removeAllListeners(); } catch (e) {}
      try { this._tuya.on('error', () => {}); } catch (e) {}  // absorb residual errors
      try { this._tuya.disconnect(); } catch (e) {}
      this._tuya = null;
    }
    this._connected = false;
  }

  async get() {
    if (!this._connected || !this._tuya || this._getPending) return;
    this._getPending = true;
    try {
      await this._tuya.get({ schema: true });
    } finally {
      this._getPending = false;
    }
  }

  async refresh() {
    if (!this._connected || !this._tuya) return;
    try {
      await this._tuya.refresh();
    } catch (_) {}
  }

  // Serialises all SET commands; fire-and-forget for protocol 3.4/3.5 or when requested.
  //
  // options.fireAndForget — pass true for relay-pulse commands on devices that drop the TCP
  //   connection immediately after processing a SET (e.g. WOFEA single-relay opener).
  //   The command is queued, sent, and the returned Promise resolves as soon as it is
  //   dispatched — no response echo is awaited, so ECONNRESET never propagates to the
  //   caller and the capability listener reports success (which is correct: the relay fired).
  async set(dp, value, { fireAndForget = false } = {}) {
    if (!this._connected || !this._tuya) throw new Error('Device not connected');

    const execute = async () => {
      if (!this._connected || !this._tuya) throw new Error('Device not connected');

      if (this._isNewProtocol || fireAndForget) {
        // Fire-and-forget: device pushes STATUS asynchronously (3.4/3.5) or caller
        // explicitly opted out of waiting for an echo (single-relay pulse devices).
        this._tuya.set({ dps: dp, set: value }).catch((err) => {
          const msg = String(err?.message || err);
          if (!msg.toLowerCase().includes('timeout')) {
            this._emit('log', `Set DP ${dp} failed: ${msg}`, 'error');
          }
        });
        return;
      }

      try {
        await Promise.race([
          this._tuya.set({ dps: dp, set: value }),
          new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), CMD_TIMEOUT_MS)),
        ]);
      } catch (err) {
        const msg = err?.message || String(err);
        if (msg.toLowerCase().includes('timeout')) {
          this._emit('log', `Set DP ${dp} timed out (value may still have applied)`, 'warn');
          return;
        }
        throw err;
      }
    };

    const task = this._cmdQueue.then(execute);
    this._cmdQueue = task.catch(() => {});
    return task;
  }

  /**
   * Send multiple DPs in a single network packet.
   * @param {object} dpsObj  — plain object mapping dp numbers to values, e.g. { 4: 'cool', 2: 22 }
   *
   * Behaviour mirrors set():
   *   - Protocol 3.4/3.5: fire-and-forget (device pushes STATUS asynchronously).
   *   - Other protocols:   awaited with CMD_TIMEOUT_MS timeout; timeout is logged
   *                        as a warning but not re-thrown (value may still have applied).
   */
  async setMultiple(dpsObj) {
    if (!this._connected || !this._tuya) throw new Error('Device not connected');
    if (!dpsObj || Object.keys(dpsObj).length === 0) return;

    const execute = async () => {
      if (!this._connected || !this._tuya) throw new Error('Device not connected');

      if (this._isNewProtocol) {
        this._tuya.set({ multiple: true, data: dpsObj }).catch((err) => {
          const msg = String(err?.message || err);
          if (!msg.toLowerCase().includes('timeout')) {
            this._emit('log', `setMultiple failed: ${msg}`, 'error');
          }
        });
        return;
      }

      try {
        await Promise.race([
          this._tuya.set({ multiple: true, data: dpsObj }),
          new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), CMD_TIMEOUT_MS)),
        ]);
      } catch (err) {
        const msg = err?.message || String(err);
        if (msg.toLowerCase().includes('timeout')) {
          this._emit('log', 'setMultiple timed out (values may still have applied)', 'warn');
          return;
        }
        throw err;
      }
    };

    const task = this._cmdQueue.then(execute);
    this._cmdQueue = task.catch(() => {});
    return task;
  }

  // ── Internal ───────────────────────────────────────────────────────────────

  _handleDisconnect(reason) {
    if (!this._connected) return; // prevent double-firing
    if (this._stopped)   return; // destroyed — no reconnect
    this._connected = false;
    this._stopHeartbeatWatchdog();
    this.emit('disconnected', reason);
    this._scheduleReconnect();
  }

  _resetHeartbeatWatchdog() {
    if (this._heartbeatTimer) clearTimeout(this._heartbeatTimer);
    this._heartbeatTimer = setTimeout(() => {
      this._throttleLog('No heartbeat received — reconnecting', 'warn');
      if (this._tuya) try { this._tuya.disconnect(); } catch (e) {}
      this._handleDisconnect('heartbeat timeout');
    }, HEARTBEAT_TIMEOUT_MS);

    // Send an outbound ping at half the watchdog interval so that firmware which
    // requires host-initiated keep-alives doesn't silently drop the connection.
    if (this._pingTimer) clearTimeout(this._pingTimer);
    this._pingTimer = setTimeout(() => {
      this._pingTimer = null;
      if (this._connected && this._tuya) {
        try { this._tuya._sendPing(); } catch (_) {}
      }
    }, Math.floor(HEARTBEAT_TIMEOUT_MS / 2));
  }

  _stopHeartbeatWatchdog() {
    if (this._heartbeatTimer) {
      clearTimeout(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
    if (this._pingTimer) {
      clearTimeout(this._pingTimer);
      this._pingTimer = null;
    }
  }

  _scheduleReconnect() {
    if (this._stopped)        return; // destroyed — no reconnect
    if (this._reconnectTimer) return;
    const base   = Math.min(RECONNECT_BASE_MS * Math.pow(2, this._reconnectAttempts), RECONNECT_MAX_MS);
    const jitter = base * 0.2 * (Math.random() * 2 - 1);
    const delay  = Math.max(1000, Math.round(base + jitter));
    this._reconnectAttempts++;

    // After VERSION_ROTATE_AFTER consecutive failures, try the next protocol version.
    // Handles devices whose firmware OTA changed the required protocol.
    if (this._reconnectAttempts % VERSION_ROTATE_AFTER === 0) {
      if (!this._versionTried) this._versionTried = new Set([this._version]);
      const next = VERSION_FALLBACKS.find((v) => !this._versionTried.has(v));
      if (next) {
        this._version = next;
        this._versionTried.add(next);
        this._emit('log',
          `${this._reconnectAttempts} failures — trying protocol ${next} ` +
          `(configured: ${this._versionOrig})`, 'warn');
      } else {
        // All versions exhausted — reset and cycle again from the configured version
        this._versionTried = null;
        this._version      = this._versionOrig;
        this._emit('log', `All protocol versions tried — reverting to ${this._versionOrig}`, 'warn');
      }
    }

    this._emit('log', `Reconnecting in ${Math.round(delay / 1000)}s (attempt ${this._reconnectAttempts})`, 'info');
    this._reconnectTimer = setTimeout(async () => {
      this._reconnectTimer = null;
      await this.connect();
    }, delay);
  }

  /**
   * Like _emit('log', ...) but suppresses repeated identical messages.
   * First 3 occurrences are logged normally.  Subsequent ones are dropped
   * unless they fall on a ×10 boundary (logged with a repeat count).
   * When a different message arrives, emits a "suppressed N more times" notice
   * so the log stays complete without being flooded.
   */
  _throttleLog(message, level) {
    if (message === this._lastLogMsg) {
      this._logRepeatCount++;
      if (this._logRepeatCount <= 3) {
        this._emit('log', message, level);
      } else if (this._logRepeatCount % 10 === 0) {
        this._emit('log', `${message} [repeated ×${this._logRepeatCount}]`, level);
      }
      // else: silently suppress
    } else {
      // Flush suppressed count for the previous message before switching
      if (this._logRepeatCount > 3) {
        const suppressed = this._logRepeatCount - 3;
        this._emit('log',
          `(previous message suppressed ${suppressed} more time${suppressed === 1 ? '' : 's'})`,
          'info',
        );
      }
      this._lastLogMsg     = message;
      this._logRepeatCount = 1;
      this._emit('log', message, level);
    }
  }

  _emit(event, message, level) {
    if (event === 'log') {
      this.emit('log', { message, level: level || 'info' });
    } else {
      this.emit(event, message);
    }
  }
}

module.exports = TuyaConnection;
