'use strict';

const { EventEmitter } = require('events');
const TuyAPI = require('tuyapi');

const RECONNECT_BASE_MS    = 10000;
const RECONNECT_MAX_MS     = 300000;
const CMD_TIMEOUT_MS       = 5000;
const HEARTBEAT_TIMEOUT_MS = 60000;

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
    this._id      = id;
    this._key     = key;
    this._ip      = ip;
    this._version = String(version || '3.3');

    this._tuya              = null;
    this._connected         = false;
    this._cmdQueue          = Promise.resolve();
    this._heartbeatTimer    = null;
    this._reconnectTimer    = null;
    this._reconnectAttempts = 0;
    this._getPending        = false;
  }

  get connected() { return this._connected; }

  async connect() {
    this._stopHeartbeatWatchdog();
    if (this._tuya) {
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
      this._connected         = true;
      this._reconnectAttempts = 0;
      this._resetHeartbeatWatchdog();
      this.emit('connected');
    });

    this._tuya.on('disconnected', () => {
      this._handleDisconnect('socket closed');
    });

    this._tuya.on('error', (err) => {
      const msg = err?.message || String(err || 'unknown');
      if (msg.toLowerCase().includes('timeout')) {
        this._emit('log', `Timeout (non-fatal): ${msg}`, 'warn');
        return;
      }
      this._emit('log', `Error: ${msg}`, 'error');
      this._handleDisconnect(msg);
    });

    this._tuya.on('data', (data) => {
      this._resetHeartbeatWatchdog();
      if (data?.dps) this.emit('data', data.dps);
    });

    // Some TuyAPI builds emit 'heartbeat' for keep-alive packets.
    this._tuya.on('heartbeat', () => this._resetHeartbeatWatchdog());

    try {
      await this._tuya.connect();
    } catch (err) {
      this._emit('log', `Connection failed: ${err.message}`, 'error');
      this._scheduleReconnect();
    }
  }

  disconnect() {
    this._stopHeartbeatWatchdog();
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    if (this._tuya) {
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

  // Serialises all SET commands; fire-and-forget for protocol 3.4/3.5.
  async set(dp, value) {
    if (!this._connected || !this._tuya) throw new Error('Device not connected');

    const isNewProtocol = this._version === '3.4' || this._version === '3.5';

    const execute = async () => {
      if (!this._connected || !this._tuya) throw new Error('Device not connected');

      if (isNewProtocol) {
        // 3.4/3.5: device pushes STATUS asynchronously — don't wait for echo.
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

  // ── Internal ───────────────────────────────────────────────────────────────

  _handleDisconnect(reason) {
    if (!this._connected) return; // prevent double-firing
    this._connected = false;
    this._stopHeartbeatWatchdog();
    this.emit('disconnected', reason);
    this._scheduleReconnect();
  }

  _resetHeartbeatWatchdog() {
    if (this._heartbeatTimer) clearTimeout(this._heartbeatTimer);
    this._heartbeatTimer = setTimeout(() => {
      this._emit('log', 'No heartbeat received — reconnecting', 'warn');
      if (this._tuya) try { this._tuya.disconnect(); } catch (e) {}
    }, HEARTBEAT_TIMEOUT_MS);
  }

  _stopHeartbeatWatchdog() {
    if (this._heartbeatTimer) {
      clearTimeout(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
  }

  _scheduleReconnect() {
    if (this._reconnectTimer) return;
    const base   = Math.min(RECONNECT_BASE_MS * Math.pow(2, this._reconnectAttempts), RECONNECT_MAX_MS);
    const jitter = base * 0.2 * (Math.random() * 2 - 1);
    const delay  = Math.max(1000, Math.round(base + jitter));
    this._reconnectAttempts++;
    this._emit('log', `Reconnecting in ${Math.round(delay / 1000)}s (attempt ${this._reconnectAttempts})`, 'info');
    this._reconnectTimer = setTimeout(async () => {
      this._reconnectTimer = null;
      await this.connect();
    }, delay);
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
