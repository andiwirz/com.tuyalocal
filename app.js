'use strict';

const Homey = require('homey');

const LOG_MAX = 500;

class TuyaDehumidifierApp extends Homey.App {
  async onInit() {
    this._logs = [];
    this._flushTimer = null;

    // Restore logs from last session (best-effort)
    try {
      const stored = this.homey.settings.get('diagnostic_logs');
      if (Array.isArray(stored)) this._logs = stored;
    } catch (e) {}

    this.log('Tuya Dehumidifier App initialized');
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

module.exports = TuyaDehumidifierApp;
