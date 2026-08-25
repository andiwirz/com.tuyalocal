'use strict';

const { EventEmitter } = require('events');
const TuyAPI = require('./SafeTuyAPI');

const RECONNECT_BASE_MS    = 3000;   // first attempt ≈3 s; backs off exponentially to RECONNECT_MAX_MS
const RECONNECT_MAX_MS     = 300000;
const CMD_TIMEOUT_MS       = 5000;
const HEARTBEAT_TIMEOUT_MS = 30000; // 30 s — detect dead sockets twice as fast

// A second watchdog, watching something the heartbeat cannot see.
//
// The heartbeat only proves the socket is alive at the transport level: the device
// answered a keep-alive ping. Firmware can reach a state where it keeps answering
// those and stops answering anything else — no reply to a status query, no pushed
// report — and the connection then looks perfectly healthy while delivering nothing.
// Because every incoming keep-alive rearms the heartbeat watchdog, that state was
// permanent: no disconnect was ever declared, no reconnect was ever scheduled, and
// nothing was written to the log. Commands hid it rather than revealing it — on
// 3.4/3.5 a SET is fire-and-forget by design, so a command dispatched into that
// socket resolves successfully, Homey updates the capability, and the device does
// not move. A flow reports success and the lamp stays off.
//
// So absence of *data* is tracked separately from absence of *socket liveness*, and
// only real device reports reset it — never a keep-alive. The window is three polling
// cycles, because a device asked every 30 s that has said nothing for 90 s is not
// merely quiet. It is deliberately generous: reconnecting costs a real outage, and on
// 3.5 a rebuilt handshake occasionally stalls, so this must fire on a genuine fault
// and never on a slow answer.
const DATA_TIMEOUT_CYCLES = 3;
const DATA_TIMEOUT_MIN_MS = 90000;

// Upper bound on a whole connection attempt, because the library does not have one.
// TuyAPI guards the TCP handshake with its own 5 s timeout but clears it the moment
// the socket connects — and protocol 3.4/3.5 then waits for a session-key exchange
// without ever resolving or rejecting if the device does not answer. That state is
// silent and permanent: connect() never returns, so the catch below never runs, no
// reconnect is scheduled, and the heartbeat watchdog was never started because it
// only starts on 'connected'. A device stuck there stays offline until the app is
// restarted, which is exactly what a network outage produced: the reconnect loop
// rotates the protocol version, and if the network returns while it sits on 3.4 or
// 3.5, the first successful TCP connection wedges the device for good.
// 15 s is comfortably above TuyAPI's own 5 s TCP guard plus a local handshake, so
// this only fires where the library has no timeout at all.
const CONNECT_TIMEOUT_MS   = 15000;

// Protocol versions tried in order when the configured version keeps failing.
// Handles devices that changed protocol after a firmware OTA update.
//
// Deliberately the same list pairing uses, imported rather than repeated. The two
// had drifted: pairing tried 3.2 but this rotation did not, so a device on 3.2 —
// some curtain motors are — paired correctly and then, if it ever lost the
// connection long enough to trigger the rotation, never got 3.2 offered again.
const { VERSIONS_TO_TRY: VERSION_FALLBACKS } = require('./autoDetect');
const VERSION_ROTATE_AFTER = 5;  // rotate to next version after this many consecutive failures
const PUSH_ONLY_AFTER      = 3;  // consecutive GET timeouts before calling a device push-only

// Errors that mean the device is not on the network at all — no route to the
// address, or nothing answering there. The protocol version cannot be the cause of
// these, so the rotation above is skipped for them. It used to run regardless,
// which put "5 failures — trying protocol 3.3" in the log of a device whose real
// problem was a changed IP address, and sent people hunting through protocol
// settings. Timeouts are deliberately not in this list: a protocol mismatch can
// stall the handshake and surface as a timeout, so those must still rotate.
const UNREACHABLE_CODES = ['EHOSTUNREACH', 'EHOSTDOWN', 'ENETUNREACH', 'ENETDOWN', 'ENOTFOUND'];
const isUnreachable = (msg) => UNREACHABLE_CODES.some((code) => msg.includes(code));

// Whether a message describes a timeout. Deliberately not a bare includes('timeout'):
// TuyAPI's own connect timeout says "connection timed out", with a space, so a test
// for the single word missed the most common failure of all — it was filed as an
// error rather than a warning and got no explanatory hint.
const isTimeout = (msg) => {
  const m = String(msg).toLowerCase();
  return m.includes('timeout') || m.includes('timed out') || m.includes('etimedout');
};

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
    this._commandGapMs      = 0;     // 0 = kein Abstand; gesetzt aus den Geraeteeinstellungen
    this._lastCommandAt     = 0;
    this._heartbeatTimer    = null;
    this._pingTimer         = null;  // outbound keepalive ping
    this._dataTimer         = null;  // data watchdog — see DATA_TIMEOUT_CYCLES
    this._dataTimeoutMs     = 0;     // 0 = disabled; set by the device layer from its polling interval
    // Latched the first time this device answers something we asked it for, and
    // deliberately never reset — not even across reconnects. It is what separates a
    // device that has stopped answering from firmware that never answers at all:
    // push-only devices reply to nothing and would otherwise be torn down every 90 s
    // for being quiet, which is exactly the reconnect churn this must not cause.
    this._answersPolls      = false;
    this._connectedAt       = 0;     // for the connection summary in the disconnect log
    this._packetsIn         = 0;     // data packets received on the current connection
    this._noNewDataCount    = 0;     // consecutive "904 / no new data" replies
    this._provenTimer       = null;  // see _markConnectionProven
    this._versionProven     = false;
    this._reconnectTimer    = null;
    this._reconnectAttempts = 0;
    this._versionTried      = null;  // Set<string> — populated during protocol rotation
    this._statusTimeouts    = 0;     // consecutive GET timeouts — see the push-only hint
    this._getPending        = false;
    this._refreshPending    = false;
    this._stopped           = false;  // set by destroy() — prevents all reconnects after teardown

    // Log-spam throttle state
    this._lastLogMsg        = null;
    this._logRepeatCount    = 0;
  }

  get connected()        { return this._connected; }
  /**
   * True once this connection has shown the protocol version actually works —
   * see _markConnectionProven. `connected` alone does not mean that.
   */
  get versionProven()    { return this._versionProven; }
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
    this._stopDataWatchdog();
    this._stopProvenTimer();
    // Nothing can still be in flight on a socket we are about to replace, and a
    // stale flag here would block every future poll.
    this._getPending     = false;
    this._refreshPending = false;
    this._closeSocket();

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
      this._statusTimeouts    = 0;
      this._lastLogMsg        = null;
      this._logRepeatCount    = 0;
      // The failure counter and the protocol rotation are deliberately NOT reset here.
      // See _markConnectionProven: an open socket is not proof that this version works.
      this._startProvenTimer();
      if (this._version !== this._versionOrig) {
        this._emit('log',
          `Connected on protocol ${this._version} (configured: ${this._versionOrig}). ` +
          `Update "Protocol Version" in device settings to avoid the retry delay on next reconnect.`,
          'warn');
      }
      this._connectedAt        = Date.now();
      this._versionProven      = false;
      this._packetsIn          = 0;
      this._noNewDataCount     = 0;
      this._resetHeartbeatWatchdog();
      // Arms only for devices already known to answer — see _answersPolls.
      this._resetDataWatchdog();
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
      //
      // Counted all the same. A single 904 is routine; an unbroken run of them is a
      // device that is talking to us and reporting nothing, which is one of the two
      // ways the silent-but-connected state shows up — and the reason that state left
      // no trace at all in the log. The count is not acted on here, only carried into
      // the data watchdog's message so the log says which of the two it was.
      if (msg.includes('904')) { this._noNewDataCount++; return; }

      // Error 900 = IR/RF blaster has no persistent DP state to return — the device is
      // reachable and can accept SET commands, but status() GET returns nothing.
      // Silently ignore so the connection stays up and commands still work.
      if (msg.includes('900')) return;

      // "Timeout waiting for status response" = push-only firmware that does not respond
      // to schema GET requests at all. The device IS connected (TCP is up) and will push
      // DPs proactively and accept SET commands. Disconnecting here causes an endless
      // connect → GET timeout → disconnect loop that prevents any commands from going through.
      if (msg.toLowerCase().includes('timeout') && msg.toLowerCase().includes('status')) {
        // Only call a device push-only once it has failed to answer repeatedly. A single
        // timeout is usually the device being briefly busy — the old message announced
        // the diagnosis on the first one and told the user to switch off polling, on a
        // device that answers a status request perfectly well the rest of the time.
        this._statusTimeouts++;
        if (this._statusTimeouts >= PUSH_ONLY_AFTER) {
          this._throttleLog(
            `GET timed out ${this._statusTimeouts}× in a row — this device looks push-only: `
            + 'it never answers a status request. Set Polling Interval to 0 to stop asking.',
            'warn');
        } else {
          this._throttleLog('GET timed out — no status response this time', 'info');
        }
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
      const hint = TuyaConnection._failureHint(msg);
      this._throttleLog(`${msg}${hint}`, isTimeout(msg) ? 'warn' : 'error');
      this._handleDisconnect(msg);
    });

    this._tuya.on('data', (data) => {
      this._resetHeartbeatWatchdog();
      // Read before emitting: the device layer reads the same flag to tell a push
      // from a poll reply, and emitting first would let it clear underneath us.
      const solicited = this.isPollInFlight;
      if (data?.dps) { this._noteDeviceAnswered(solicited); this.emit('data', data.dps, data); }
    });

    // Responses to a DP_REFRESH request arrive on their own event, not on 'data'.
    // Some devices report certain DPs *only* in reply to such a request — notably
    // the packed voltage/current/power DPs on energy meters and EV chargers — so
    // without this handler those values are received and then silently dropped.
    this._tuya.on('dp-refresh', (data) => {
      this._resetHeartbeatWatchdog();
      const solicited = this.isPollInFlight;
      if (data?.dps) { this._noteDeviceAnswered(solicited); this.emit('data', data.dps, data); }
    });

    // Some TuyAPI builds emit 'heartbeat' for keep-alive packets.
    //
    // This rearms the heartbeat watchdog and nothing else. A pong says the socket is
    // open, not that the device is still reporting — see the data watchdog above.
    this._tuya.on('heartbeat', () => this._resetHeartbeatWatchdog());

    // The library's promise is raced against our own deadline — see CONNECT_TIMEOUT_MS
    // for why it needs one. The attempt keeps its own catch: once the race is decided
    // the loser still settles, and an unhandled rejection from it would be reported as
    // an app-level fault rather than the connection failure it is.
    let deadline;
    const attempt = this._tuya.connect();
    attempt.catch(() => {});
    try {
      await Promise.race([
        attempt,
        new Promise((_, reject) => {
          deadline = setTimeout(
            () => reject(new Error(`Handshake timed out after ${Math.round(CONNECT_TIMEOUT_MS / 1000)}s`)),
            CONNECT_TIMEOUT_MS,
          );
        }),
      ]);
    } catch (err) {
      const msg  = err.message || String(err);
      const hint = TuyaConnection._failureHint(msg);
      if (this._stopped) return;  // destroyed — don't reconnect
      // Close it before retrying, not after. A stalled handshake leaves the socket
      // open, and Tuya firmware accepts exactly one local connection: leave it behind
      // and every later attempt is refused by our own orphan.
      this._closeSocket();
      this._throttleLog(`Connection failed: ${msg}${hint}`, isTimeout(msg) ? 'warn' : 'error');
      this._scheduleReconnect(msg);
    } finally {
      clearTimeout(deadline);
    }
  }

  /**
   * Closes the underlying socket and drops it — including the case the library
   * itself will not handle.
   *
   * TuyAPI's disconnect() returns early while its own _connected flag is false,
   * which is precisely the state a stalled 3.4/3.5 key exchange leaves it in. The
   * socket then stays open while the reference to it is dropped, so nothing in the
   * process can ever close it, and it keeps the device's single connection slot
   * occupied for the lifetime of the app. Destroying the socket directly is the
   * only way out of that.
   */
  _closeSocket() {
    const tuya = this._tuya;
    if (!tuya) return;
    // Strip listeners first so events from the dying socket cannot fire on the
    // next connection's callbacks. Re-attach a no-op error handler so any
    // in-flight parse errors (e.g. HMAC mismatch) are absorbed, not thrown.
    try { tuya.removeAllListeners(); } catch (e) {}
    try { tuya.on('error', () => {}); } catch (e) {}
    try { tuya.disconnect(); } catch (e) {}
    try { tuya.client?.destroy(); } catch (e) {}
    this._tuya = null;
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
    this._stopDataWatchdog();
    this._stopProvenTimer();
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    // _closeSocket removes the listeners before closing, so an in-flight async
    // connect() whose _tuya reference we just stole cannot fire callbacks on us.
    this._closeSocket();
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
    if (dps && typeof dps === 'object') {
      // Counted as an answer too. This path bypasses the 'dp-refresh' handler, and
      // _guarded has already cleared the pending flag by the time it runs, so without
      // this a device that reports only through a resolved refresh would look silent
      // to the data watchdog and be reconnected every 90 s for answering correctly.
      this._noteDeviceAnswered(true);
      this.emit('data', dps, { dps });
    }
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
      // Erst der Abstand, dann die Pruefung: Die Verbindung kann waehrend der
      // Wartezeit wegbrechen, und dann darf nichts mehr in einen toten Socket gehen.
      await this._paceCommand();
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
      await this._paceCommand();
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
    const detail         = this._connectionSummary();
    this._connected      = false;
    this._getPending     = false;
    this._refreshPending = false;
    this._connectedAt    = 0;
    this._stopHeartbeatWatchdog();
    this._stopDataWatchdog();
    this._stopProvenTimer();
    // The summary travels beside the reason, not inside it: the reason is also the
    // text shown on the device tile while it is unavailable, and it is matched
    // against the unreachable-error list before the protocol rotation runs.
    this.emit('disconnected', reason, detail);
    this._scheduleReconnect(reason);
  }

  /**
   * Smallest gap between two commands, in milliseconds. 0 switches it off.
   *
   * The queue below has always serialised commands, but serialising is not spacing:
   * on protocol 3.4/3.5, and on any device with "fire and forget" left on, a command
   * is dispatched and the next one follows immediately. Two capability changes in one
   * flow therefore leave the app microseconds apart.
   *
   * Some firmware cannot keep up with that. It accepts the first command and drops
   * the second in silence — there is no error to see, because nothing on 3.4/3.5
   * answers a SET at all. A heater that needed two seconds between commands was the
   * reported case, and the same delay had to be set in the manufacturer's own cloud
   * app, so this is the device's limit rather than ours. But the app is what sends
   * them back to back, so the app is where the gap belongs.
   *
   * Off by default: it is a per-device quirk, and a blanket delay would slow every
   * other device down for it.
   */
  setCommandGap(ms) {
    const v = Number(ms);
    this._commandGapMs = Number.isFinite(v) && v > 0 ? Math.min(v, 10000) : 0;
  }

  /** Waits out the remainder of the gap, if any. Idle connections never wait. */
  async _paceCommand() {
    const gap = this._commandGapMs;
    if (!gap) return;
    const since = Date.now() - this._lastCommandAt;
    if (since < gap) {
      await new Promise((resolve) => setTimeout(resolve, gap - since));
    }
    this._lastCommandAt = Date.now();
  }

  /**
   * This connection has proved that the protocol version actually works.
   *
   * "Connected" alone does not prove it, and that is the whole point. On protocol 3.3,
   * 3.1 and 3.2 there is no session handshake: the library resolves connect() the
   * moment the TCP socket opens. A device that speaks 3.4 will accept that socket
   * quite happily and then reset it as soon as it is sent a frame it cannot parse.
   *
   * Resetting the failure counter on 'connected' therefore trapped the rotation. Each
   * cycle looked like this: TCP opens → counter back to zero → device resets the socket
   * → schedule reconnect, attempt 1 → repeat, for ever. The rotation needs five
   * consecutive failures to try the next version and could never reach two. A reported
   * pool heat pump sat in that loop indefinitely on 3.3 while its settings said 3.4,
   * every log line reading "attempt 1".
   *
   * So the counter is cleared by evidence instead: the first data the device sends, or
   * a connection that simply stays up. A mismatch dies in milliseconds and reaches
   * neither, so the rotation advances as it was always meant to.
   */
  _markConnectionProven() {
    this._versionProven     = true;
    this._reconnectAttempts = 0;
    this._versionTried      = null;
    this._stopProvenTimer();
  }

  /**
   * The second route to the same conclusion, for devices that legitimately say nothing.
   *
   * A push-only doorbell can sit connected and silent for hours, and it must not be
   * punished for that — without this, a handful of ordinary drops would rotate it onto
   * a protocol it does not speak. Surviving the heartbeat interval is enough: a version
   * mismatch never lasts that long.
   */
  _startProvenTimer() {
    this._stopProvenTimer();
    this._provenTimer = setTimeout(() => {
      this._provenTimer = null;
      if (this._connected) this._markConnectionProven();
    }, HEARTBEAT_TIMEOUT_MS);
  }

  _stopProvenTimer() {
    if (this._provenTimer) {
      clearTimeout(this._provenTimer);
      this._provenTimer = null;
    }
  }

  /**
   * Any answer from the device clears the push-only tally.
   * @param {boolean} [solicited] True when this answered something we asked for,
   *   which is what qualifies the device for the data watchdog.
   */
  _noteDeviceAnswered(solicited = false) {
    // Data from the device is the strongest evidence the version is right.
    this._markConnectionProven();
    this._statusTimeouts = 0;
    this._noNewDataCount = 0;
    this._packetsIn++;
    if (solicited) this._answersPolls = true;
    this._resetDataWatchdog();
  }

  /**
   * Sets the window after which silence counts as a dead connection.
   *
   * Driven by the device layer, because only that layer knows how often the device is
   * actually asked. Zero disables it: with polling switched off there is no
   * expectation of data at all, and a device that is merely quiet must not be torn
   * down for it.
   */
  setDataTimeout(pollIntervalMs) {
    const interval = Number(pollIntervalMs) || 0;
    const ms = interval > 0
      ? Math.max(DATA_TIMEOUT_MIN_MS, interval * DATA_TIMEOUT_CYCLES)
      : 0;
    if (ms === this._dataTimeoutMs) return;
    this._dataTimeoutMs = ms;
    if (ms === 0) this._stopDataWatchdog();
    else          this._resetDataWatchdog();
  }

  _resetDataWatchdog() {
    if (this._dataTimer) {
      clearTimeout(this._dataTimer);
      this._dataTimer = null;
    }
    if (!this._dataTimeoutMs || !this._answersPolls || !this._connected) return;
    this._dataTimer = setTimeout(() => {
      this._dataTimer = null;
      const secs  = Math.round(this._dataTimeoutMs / 1000);
      const stuck = this._noNewDataCount > 0
        ? ` — it answered ${this._noNewDataCount}× with "no new data" and nothing else`
        : ' — it still answers keep-alives but no longer reports anything';
      this._throttleLog(`Connected but silent for ${secs}s${stuck}. Reconnecting.`, 'warn');
      // Closed here rather than left to the reconnect. The socket is still open and
      // the device holds exactly one connection slot, so an orphan left behind for the
      // length of the backoff is refused by itself when the attempt comes.
      this._closeSocket();
      this._handleDisconnect(`silent for ${secs}s`);
    }, this._dataTimeoutMs);
  }

  _stopDataWatchdog() {
    if (this._dataTimer) {
      clearTimeout(this._dataTimer);
      this._dataTimer = null;
    }
  }

  /**
   * How the connection that just ended went, for the log line reporting it.
   *
   * "Disconnected: socket closed" on its own does not separate the two failures that
   * want different remedies: a socket that dropped 5 ms in having never carried
   * anything — wrong protocol, wrong key, another app holding the device's single
   * slot — and one that ran for an hour and then died, which is network, power save
   * or firmware. Duration and packet count tell them apart at a glance.
   */
  _connectionSummary() {
    if (!this._connectedAt) return '';
    const ms = Date.now() - this._connectedAt;
    let dur;
    if (ms < 1000)         dur = `${ms}ms`;
    else if (ms < 60000)   dur = `${Math.round(ms / 1000)}s`;
    else if (ms < 3600000) dur = `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
    else                   dur = `${Math.floor(ms / 3600000)}h ${Math.round((ms % 3600000) / 60000)}m`;
    const data = this._packetsIn === 0
      ? 'no data received'
      : `${this._packetsIn} packet${this._packetsIn === 1 ? '' : 's'}`;
    return `up ${dur}, ${data}`;
  }

  _resetHeartbeatWatchdog() {
    if (this._heartbeatTimer) clearTimeout(this._heartbeatTimer);
    this._heartbeatTimer = setTimeout(() => {
      this._throttleLog('No heartbeat received — reconnecting', 'warn');
      // _closeSocket, not disconnect(): the library's disconnect() returns early
      // whenever its own _connected flag is false, leaving the socket open and the
      // device's single connection slot occupied.
      this._closeSocket();
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

  /**
   * Turns a connection error into an explanation, because the raw text alone sends
   * people to the wrong place. Users read "connection failed" and start changing
   * the protocol version, which cannot help when nothing answered at the address.
   *
   * Note what is deliberately absent: there is no "Auto-detect" in the device
   * settings — that choice exists only while pairing — so the old hint pointed at a
   * setting that is not in the list.
   */
  static _failureHint(msg) {
    if (isUnreachable(msg)) {
      return ' — nothing answered at that address. The device is switched off, asleep,'
        + ' or its IP address has changed; a fixed address in the router prevents the last one.'
        + ' The protocol version is not the cause here.';
    }
    // Our own guard: the socket opened, so the device is on the network and reachable
    // — it simply ignored the key exchange. That points at the protocol version, not
    // the address, which is the opposite of the advice the unreachable case gets.
    if (msg.includes('Handshake timed out')) {
      return ' — the device accepted the connection but never completed the key exchange,'
        + ' which usually means it does not speak the protocol version being tried.'
        + ' The app rotates through the others on its own; if it settles on one that works,'
        + ' the log says so and that version belongs in the device settings.';
    }
    if (isTimeout(msg)) {
      return ' — nothing answered in time. The device is asleep, still starting up after a'
        + ' power cut, or busy with another connection; these devices accept exactly one.'
        + ' The app keeps retrying on its own.';
    }
    if (msg.includes('ECONNREFUSED')) {
      return ' — the device answered but refused the connection. These devices accept'
        + ' exactly one local connection at a time, so check whether another app or'
        + ' system is already connected to it.';
    }
    if (msg.includes('ECONNRESET')) {
      return ' — likely a protocol version mismatch. The app retries the other versions on its own'
        + ` after ${VERSION_ROTATE_AFTER} failed attempts. If it stays offline, set Protocol`
        + ' Version manually in the device settings; 3.3 and 3.4 are the common ones.';
    }
    return '';
  }

  /** @param {string} [reason]  The failure that triggered this, for the rotation check. */
  _scheduleReconnect(reason = '') {
    if (this._stopped)        return; // destroyed — no reconnect
    if (this._reconnectTimer) return;
    const base   = Math.min(RECONNECT_BASE_MS * Math.pow(2, this._reconnectAttempts), RECONNECT_MAX_MS);
    const jitter = base * 0.2 * (Math.random() * 2 - 1);
    const delay  = Math.max(1000, Math.round(base + jitter));
    this._reconnectAttempts++;

    // After VERSION_ROTATE_AFTER consecutive failures, try the next protocol version.
    // Handles devices whose firmware OTA changed the required protocol. Skipped while
    // the address itself is unreachable: no protocol can reach a device that is not
    // there, and rotating anyway wrote a misleading "trying protocol 3.3" into the log
    // of a device whose IP had changed, which is where people then went looking.
    if (this._reconnectAttempts % VERSION_ROTATE_AFTER === 0 && !isUnreachable(reason)) {
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
