'use strict';

const Homey = require('homey');

const LOG_MAX = 500;

class TuyaLocalApp extends Homey.App {
  async onInit() {
    this._logs = [];
    this._flushTimer = null;

    // Restore logs from last session (best-effort)
    try {
      const stored = this.homey.settings.get('diagnostic_logs');
      if (Array.isArray(stored)) this._logs = stored;
    } catch (e) {}

    const version = this.homey.manifest?.version ?? '?';
    this.addLog('App', `Started — v${version}`, 'info');
    this.log(`Tuya Local App v${version} initialized`);
    // Persist version so the settings page can display it without a build-time template.
    try { this.homey.settings.set('app_version', version); } catch (e) {}

    // ── Process-level safety net ─────────────────────────────────────────────
    // TuyAPI can throw errors inside socket data/timeout handlers that bypass all
    // per-device error handlers (e.g. HMAC mismatch, connection timed out thrown
    // on the raw socket).  Catching them here keeps the app alive and adds hints
    // to the diagnostic log so the user knows what to do.
    process.on('uncaughtException', (err) => {
      const msg  = err?.message || String(err);
      const hint = this._errorHint(msg);
      this.error('Uncaught exception (app kept alive):', msg);
      this.addLog('App', `Uncaught exception: ${msg}${hint}`, 'error');
    });
    process.on('unhandledRejection', (reason) => {
      const msg  = reason?.message || String(reason);
      const hint = this._errorHint(msg);
      this.error('Unhandled rejection (app kept alive):', msg);
      this.addLog('App', `Unhandled rejection: ${msg}${hint}`, 'error');
    });
  }

  /** Return a user-friendly hint for well-known TuyAPI error messages. */
  _errorHint(msg) {
    if (msg.includes('HMAC mismatch')) {
      return ' — Local Key is incorrect or has been rotated. Get the current key from Tuya IoT Platform and update it via the device Repair screen. If the key is correct, try switching to protocol Auto-detect in Repair — the device may have upgraded from 3.3 to 3.4.';
    }
    if (msg.includes('ECONNRESET') || msg.includes('ECONNREFUSED')) {
      return ' — likely protocol version mismatch. Use Auto-detect in the device Repair screen.';
    }
    return '';
  }

  addLog(source, message, level = 'info') {
    this._logs.push({
      time:    new Date().toISOString(),
      source:  String(source),
      message: String(message),
      level:   String(level),
    });
    if (this._logs.length > LOG_MAX) this._logs.shift();

    // Debounced flush to persistent store (max once per 5 s)
    clearTimeout(this._flushTimer);
    this._flushTimer = setTimeout(() => {
      try { this.homey.settings.set('diagnostic_logs', this._logs); } catch (e) {}
    }, 5000);
  }

  async onUninit() {
    clearTimeout(this._flushTimer);
    try { this.homey.settings.set('diagnostic_logs', this._logs); } catch (e) {}
  }
}

module.exports = TuyaLocalApp;
