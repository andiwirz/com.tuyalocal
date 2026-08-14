'use strict';

const { EventEmitter } = require('events');
const TuyAPI = require('tuyapi');

const RECONNECT_BASE_MS    = 3000;   // first attempt ≈3 s; backs off exponentially to RECONNECT_MAX_MS
const RECONNECT_MAX_MS     = 300000;
const CMD_TIMEOUT_MS       = 5000;
const HEARTBEAT_TIMEOUT_MS = 30000; // 30 s — detect dead sockets twice as fast

// Protocol versions tried in order when the configured version keeps failing.
// Handles devices that changed protocol after a firmware OTA update.
//
// Deliberately the same list pairing uses, imported rather than repeated. The two
// had drifted: pairing tried 3.2 but this rotation did not, so a device on 3.2 —
// some curtain motors are — paired correctly and then, if it ever lost the
// connection long enough to trigger the rotation, never got 3.2 offered again.
const { VERSIONS_TO_TRY: VERSION_FALLBACKS } = require('./autoDetect');
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
    this._protocolFailures  = 0;     // failures before any valid protocol response
    this._connectionConfirmed = false;
    this._versionTried      = null;  // Set<string> — populated during protocol rotation
    this._getPending        = false;
    this._refreshPending    = false;
    this._stopped           = false;  // set by destroy() — prevents all reconnects after teardown

    // Log-spam throttle state
    this._lastLogMsg        = null;
    this._logRepeatCount    = 0;
  }

  get connected()        { return this._connected; }
  /** True while a GET request is in flight — false means incoming data is a push. */
  /**
   * True while a poll we initiated is awaiting its reply — covers both the full
   * GET and a DP_REFRESH request. The device layer uses this to tell a solicited
   * reply from an unsolicited push, so that a reply we asked for does not also
   * trigger a redundant follow-up GET.
   */
  get isPollInFlight()   { return this._getPending || this._refreshPending; }
  /** True for protocol 3.4 and 3.5 — fire-and-forget SET, status pushed asynchronously. */
  get _isNewProtocol()   { return this._version === '3.4' || this._version === '3.5'; }

  async connect() {
    if (this._stopped) return;  // destroyed — never reconnect

    // A TCP socket can open even when the selected Tuya protocol version is wrong.
    // Only data or a heartbeat response proves that the protocol is usable.
    this._connectionConfirmed = false;

    // AES requires a key of exactly 16, 24, or 32 bytes. Tuya local keys are always 16
    // ASCII characters. If the user pasted a truncated or invalid key the cipher throws
    // an unhandled RangeError inside TuyAPI's own ping timer — catch it here before any
    // socket work starts and bail without scheduling a reconnect (wrong key won't self-heal).
    const keyLen = Buffer.byteLength(this._key || '', 'utf8');
    if (keyLen !== 16 && keyLen !== 24 && keyLen !== 32) {
      this._emit('log',
        `Invalid local key length (${keyLen} bytes) — Tuya local keys must be exactly 16 characters. ` +
        `Update "Local Key" in device Settings.`,
        'error');
      return;
    }

    this._stopHeartbeatWatchdog();
    // Nothing can still be in flight on a socket we are about to replace, and a
    // stale flag here would block every future poll.
    this._getPending     = false;
    this._refreshPending = false;
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
      this._lastLogMsg        = null;
      this._logRepeatCount    = 0;
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
      if (msg.includes('904')) {
        this._confirmConnection();
        return;
      }

      // Error 900 = IR/RF blaster has no persistent DP state to return — the device is
      // reachable and can accept SET commands, but status() GET returns nothing.
      // Silently ignore so the connection stays up and commands still work.
      if (msg.includes('900')) {
        this._confirmConnection();
        return;
      }

      // "Timeout waiting for status response" = push-only firmware that does not respond
      // to schema GET requests at all. The device IS connected (TCP is up) and will push
      // DPs proactively and accept SET commands. Disconnecting here causes an endless
      // connect → GET timeout → disconnect loop that prevents any commands from going through.
      if (msg.toLowerCase().includes('timeout') && msg.toLowerCase().includes('status')) {
        this._throttleLog('GET timed out — device appears push-only (no status response). Set Polling Interval to 0 to suppress this warning.', 'warn');
        return;
      }

      // A truncated or corrupt frame makes the packet parser read past the end of
      // the buffer. The socket itself is still fine, so tearing the connection down
      // and reconnecting over a single bad frame only causes an outage — the next
      // packet almost always parses normally. Log it and carry on.
      if (msg.includes('out of range') || msg.includes('ERR_OUT_OF_RANGE')
          || msg.toLowerCase().includes('crc')) {
        this._throttleLog(`Ignoring malformed packet from device: ${msg}`, 'warn');
        return;
      }

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
      this._confirmConnection();
      this._resetHeartbeatWatchdog();
      if (data?.dps) this.emit('data', data.dps, data);
    });

    // Responses to a DP_REFRESH request arrive on their own event, not on 'data'.
    // Some devices report certain DPs *only* in reply to such a request — notably
    // the packed voltage/current/power DPs on energy meters and EV chargers — so
    // without this handler those values are received and then silently dropped.
    this._tuya.on('dp-refresh', (data) => {
      this._confirmConnection();
      this._resetHeartbeatWatchdog();
      if (data?.dps) this.emit('data', data.dps, data);
    });

    // Some TuyAPI builds emit 'heartbeat' for keep-alive packets.
    this._tuya.on('heartbeat', () => {
      this._confirmConnection();
      this._resetHeartbeatWatchdog();
    });

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

  /**
   * Guards an in-flight request so a hung promise cannot wedge the pending flag.
   *
   * The library normally rejects unanswered requests after ~5 s, but a socket
   * replaced by a reconnect can leave a promise that never settles — and with the
   * flag stuck at true every later poll would return early, silently freezing all
   * values for the lifetime of the connection.
   */
  async _guarded(flag, fn) {
    if (this[flag]) return undefined;
    this[flag] = true;
    let timer;
    try {
      return await Promise.race([
        fn(),
        new Promise((resolve) => { timer = setTimeout(() => resolve(undefined), CMD_TIMEOUT_MS * 2); }),
      ]);
    } catch (e) {
      return undefined;
    } finally {
      clearTimeout(timer);
      this[flag] = false;
    }
  }

  async get() {
    if (!this._connected || !this._tuya) return;
    await this._guarded('_getPending', () => this._tuya.get({ schema: true }));
  }

  /**
   * Ask the device to re-report the DPs that TuyAPI tracks for refresh
   * (4, 5, 6, 18, 19, 20 by default — the usual homes for packed energy data).
   *
   * The reply normally arrives via the 'dp-refresh' event handler above, but the
   * promise also resolves with it. Feeding the resolved value through as well
   * costs nothing and covers builds that resolve without emitting the event; the
   * device layer de-duplicates unchanged DPs, so a value seen twice is harmless.
   */
  /**
   * @param {number[]} [requestedDps] DP numbers to ask for. Without it the library
   *   falls back to its own hardcoded list (4, 5, 6, 18, 19, 20), which is a poor
   *   fit for most devices: DPs outside that set are never requested, and on
   *   devices that answer nothing but a refresh they can never be read at all.
   *   Callers should pass the DPs their device is actually configured for.
   */
  async refresh(requestedDps) {
    if (!this._connected || !this._tuya) return;
    const opts = Array.isArray(requestedDps) && requestedDps.length > 0
      ? { requestedDPS: requestedDps }
      : {};
    const dps = await this._guarded('_refreshPending', () => this._tuya.refresh(opts));
    // refresh() resolves with the dps object itself, not a wrapper around one.
    // The 'dp-refresh' handler normally delivers this already; forwarding it here
    // too covers builds that resolve without emitting, and unchanged values are
    // filtered out by the device layer.
    if (dps && typeof dps === 'object') this.emit('data', dps, { dps });
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

  /**
   * Mark the current protocol as working only after an application-level reply.
   * TuyAPI's `connected` event means only that TCP port 6668 accepted a socket;
   * devices can do that for the wrong Tuya protocol and close it on the first GET.
   */
  _confirmConnection() {
    if (this._connectionConfirmed) return;
    this._connectionConfirmed = true;
    this._protocolFailures     = 0;
    this._versionTried         = null;

    if (this._version !== this._versionOrig) {
      this._emit('log',
        `Protocol ${this._version} confirmed (configured: ${this._versionOrig}). ` +
        `Update "Protocol Version" in device settings to avoid the retry delay on next reconnect.`,
        'warn');
    }
  }

  _handleDisconnect(reason) {
    if (!this._connected) return; // prevent double-firing
    if (this._stopped)   return; // destroyed — no reconnect
    this._connected      = false;
    this._getPending     = false;
    this._refreshPending = false;
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

    // Keep protocol validation separate from TCP backoff. A wrong protocol can
    // still open the socket, which resets _reconnectAttempts in the `connected`
    // handler. It must not also reset protocol rotation or the app can remain on
    // that wrong fallback forever, reconnecting every few seconds until restart.
    if (!this._connectionConfirmed) this._protocolFailures++;

    // After VERSION_ROTATE_AFTER consecutive failures, try the next protocol version.
    // Handles devices whose firmware OTA changed the required protocol.
    if (this._protocolFailures > 0 && this._protocolFailures % VERSION_ROTATE_AFTER === 0) {
      if (!this._versionTried) this._versionTried = new Set([this._version]);
      const next = VERSION_FALLBACKS.find((v) => !this._versionTried.has(v));
      if (next) {
        this._version = next;
        this._versionTried.add(next);
        this._emit('log',
          `${this._protocolFailures} unconfirmed connections — trying protocol ${next} ` +
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
