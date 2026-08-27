'use strict';

const Homey  = require('homey');
const crypto = require('crypto');
const https  = require('https');

const LOG_MAX = 500;

const TUYA_REGIONS = {
  eu:      'openapi.tuyaeu.com',
  'eu-w':  'openapi-weaz.tuyaeu.com',
  us:      'openapi.tuyaus.com',
  'us-e':  'openapi-ueaz.tuyaus.com',
  cn:      'openapi.tuyacn.com',
  in:      'openapi.tuyain.com',
};

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

    // Prune orphaned dp_snapshot entries (ghost devices left over from deletions before
    // v1.0.54 that didn't clean up after themselves).  We defer by 15 s to give all
    // device onInit() calls time to complete before we query the live device list.
    setTimeout(() => this._pruneOrphanSnapshots(), 15000);

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

    // The only flow card in this app that is not tied to a single device. Every
    // driver already has its own "force reconnect" action, but a household with
    // forty devices needed forty flows to say one thing, so the answer to "reconnect
    // everything after the router came back" was no answer at all.
    this.homey.flow.getActionCard('reconnect_all_devices')
      .registerRunListener(async (args) => this.reconnectAll(args?.scope === 'all'));
  }

  /**
   * Rebuilds the local connection of every paired device.
   *
   * Returns as soon as the reconnects are dispatched rather than awaiting them:
   * a single attempt can take up to its connection timeout, and a flow card that
   * blocks for minutes on a large installation would be reported as a broken card.
   *
   * The attempts are staggered rather than fired together — forty simultaneous TCP
   * connections is a burst worth spreading out, and nothing here is time-critical.
   *
   * @param {boolean} includeConnected  Reconnect healthy devices too. Off by
   *   default: rebuilding a working connection costs a short outage for no gain,
   *   and this card is meant to be safe to run on a schedule.
   * @returns {Promise<{reconnected: number, skipped: number}>}
   */
  async reconnectAll(includeConnected = false) {
    const targets = [];
    for (const driver of Object.values(this.homey.drivers.getDrivers())) {
      for (const device of driver.getDevices()) {
        if (typeof device.forceReconnect !== 'function') continue;
        // Reading the connection directly, the same way the support bundle does.
        if (!includeConnected && device._conn?.connected === true) continue;
        targets.push(device);
      }
    }

    targets.forEach((device, i) => {
      this.homey.setTimeout(() => {
        device.forceReconnect().catch(() => {});
      }, i * 200);
    });

    const scope = includeConnected ? 'all devices' : 'offline devices';
    this.addLog('App', `Reconnect requested for ${scope}: ${targets.length} device(s)`, 'info');
    return { reconnected: targets.length, skipped: 0 };
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
    // Writing a log line must never be able to take down the thing being logged.
    // _logs is created in onInit, so this only matters where the app object exists
    // without having been through it — but a caller that crashes because logging
    // failed is the wrong failure to have, whatever produced the situation.
    if (!Array.isArray(this._logs)) this._logs = [];
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

  /**
   * Remove dp_snapshot entries for devices that no longer exist in Homey.
   * Runs 15 s after startup so all device onInit() calls have completed.
   */
  _pruneOrphanSnapshots() {
    try {
      const snapshot = this.homey.settings.get('dp_snapshot');
      if (!snapshot || typeof snapshot !== 'object') return;

      // Collect all Tuya device IDs that are currently live
      const liveIds = new Set();
      for (const driver of Object.values(this.homey.drivers.getDrivers())) {
        for (const device of driver.getDevices()) {
          try { liveIds.add(device.getData().id); } catch (e) {}
        }
      }

      let changed = false;
      for (const id of Object.keys(snapshot)) {
        if (!liveIds.has(id)) {
          delete snapshot[id];
          changed = true;
          this.log(`Pruned orphaned dp_snapshot entry: ${id}`);
        }
      }
      if (changed) this.homey.settings.set('dp_snapshot', snapshot);
    } catch (e) {
      this.error('_pruneOrphanSnapshots failed:', e.message);
    }
  }

  // ── Support bundle ──────────────────────────────────────────────────────────

  /**
   * Assembles everything needed to diagnose a device problem into one text block:
   * per-device driver, DP mapping, live DPs and — where cloud credentials are
   * stored — the manufacturer's DP specification, followed by the warning/error
   * log. This exists because the settings page cannot see device settings at all,
   * so until now the DP mapping could only be obtained as screenshots; one report
   * in the forum ran to twenty of them.
   *
   * Credentials never appear: the local key is replaced outright and the device id
   * truncated to six characters, which is enough to tell two devices apart in a
   * report while not publishing the identifier. That way the output is safe to
   * paste in public, rather than asking the user to censor it — advice that has
   * demonstrably been ignored.
   *
   * @param {boolean} [includeCloud=true] Fetch the cloud DP specification per
   *   device. Costs roughly 300 ms each and is skipped when no credentials exist.
   * @param {string} [onlyDevice] Restrict the cloud lookup to the device with this
   *   name. Reporting a single device otherwise pays for one cloud request per
   *   device in the house — several seconds on a dozen of them — to fetch data that
   *   the report will not use. Every device still appears in the text, just without
   *   a specification unless it is the one being reported.
   * @param {Function} [onProgress] Called as (done, total, name) before each device
   *   is processed. The cloud requests run one after another — a dozen devices is
   *   around four seconds — so without this the settings page would sit on a single
   *   unchanging message for the whole time.
   * @returns {{text: string, devices: Array}} The text block, plus the same facts
   *   per device in structured form so the settings page can prefill a GitHub
   *   issue from them instead of parsing them back out of the text.
   */
  async buildSupportBundle({ includeCloud = true, onlyDevice = null, onProgress = null } = {}) {
    const REDACTED = '********';
    const pad = (s, n) => String(s).padEnd(n);
    const out = [];
    const devices = [];

    const appVersion = this.homey.manifest?.version ?? '?';
    out.push(`Tuya Local v${appVersion} — support bundle`);
    out.push(`Generated: ${new Date().toISOString()}`);

    const snapshot = this.homey.settings.get('dp_snapshot') || {};

    // Cloud credentials are read once; their presence decides whether the
    // specification can be fetched at all.
    const accessId     = this.homey.settings.get('cloud_access_id');
    const accessSecret = this.homey.settings.get('cloud_access_secret');
    const region       = this.homey.settings.get('cloud_region');
    const cloudUsable  = includeCloud && !!(accessId && accessSecret && region);
    out.push(`Cloud lookup: ${cloudUsable ? `configured (${region})` : 'not configured'}`);
    out.push('='.repeat(72));

    // Flattened first so the total is known before the loop starts — a progress
    // report of "3 of ?" is not a progress report.
    const allDevices = [];
    for (const driver of Object.values(this.homey.drivers.getDrivers())) {
      for (const device of driver.getDevices()) allDevices.push({ driver, device });
    }

    let done = 0;
    for (const { driver, device } of allDevices) {
      {
        if (onProgress) {
          try { onProgress(done, allDevices.length, device.getName()); } catch (e) {}
        }
        done++;

        let id = '';
        try { id = device.getData().id || ''; } catch (e) {}
        const settings = (() => { try { return device.getSettings() || {}; } catch (e) { return {}; } })();

        // Look the device up before printing its block, so the model can appear in
        // the header rather than further down. The result is reused by the cloud
        // spec section below — one cloud call per device, as before.
        const wantCloud = cloudUsable && (!onlyDevice || device.getName() === onlyDevice);
        let cloudDetail = null;
        let cloudError  = null;
        if (wantCloud && id) {
          try {
            cloudDetail = await this.cloudDeviceDetail({ accessId, accessSecret, region, deviceId: id });
          } catch (err) { cloudError = err; }
        }

        // Remember the model so later bundles still name the device even if the
        // cloud credentials are removed, or the lookup fails that day. Every store
        // access is guarded: building a bundle is the one thing that has to work
        // when a device is in a bad state, so it must not throw here.
        const readStore = (k) => { try { return device.getStoreValue(k) || ''; } catch (e) { return ''; } };
        const saveStore = (k, v) => {
          try { Promise.resolve(device.setStoreValue(k, v)).catch(() => {}); } catch (e) {}
        };

        let model = readStore('cloudProduct');
        if (cloudDetail?.product && cloudDetail.product !== model) {
          model = cloudDetail.product;
          saveStore('cloudProduct', model);
        }
        const productId = cloudDetail?.productId || readStore('cloudProductId');
        if (cloudDetail?.productId) saveStore('cloudProductId', cloudDetail.productId);

        out.push('');
        out.push(`DEVICE  ${device.getName()}`);
        out.push(`  driver     ${driver.id}`);
        out.push(`  model      ${model || '?'}${productId ? `  (product ${productId})` : ''}`);
        out.push(`  device id  ${id ? id.slice(0, 6) + '…' : '?'}`);
        out.push(`  available  ${device.getAvailable() ? 'yes' : 'no'}`);

        // Connection block: the configured protocol version and the one actually
        // in use differ after a rotation, and that difference is the answer to a
        // whole class of "it only works sometimes" reports.
        const conn = device._conn;
        out.push(`  protocol   configured ${settings.version ?? '?'}`
          + (conn?._version ? `, connected ${conn._version}` : '')
          + `  ip ${settings.ip ?? '?'}`);
        out.push(`  status     ${settings.connection_status ?? '?'} · last seen ${settings.last_seen ?? '?'}`
          + ` · poll ${settings.polling_interval ?? '?'}s`);

        // DP mapping and the remaining settings, credentials removed.
        const dpKeys  = Object.keys(settings).filter((k) => k.startsWith('dp_')).sort();
        const others  = Object.keys(settings).filter((k) =>
          !k.startsWith('dp_') && !['ip', 'device_id', 'local_key', 'version',
            'connection_status', 'last_seen', 'polling_interval'].includes(k)).sort();
        if (dpKeys.length) {
          out.push('  DP mapping');
          for (const k of dpKeys) out.push(`    ${pad(k, 26)} ${settings[k]}`);
        }
        if (others.length) {
          out.push('  other settings');
          for (const k of others) {
            const v = ['local_key'].includes(k) ? REDACTED : settings[k];
            out.push(`    ${pad(k, 26)} ${JSON.stringify(v)}`);
          }
        }

        // Live DPs as the device last reported them.
        const entry = snapshot[id];
        const dpLines = [];
        if (entry && entry.dps && Object.keys(entry.dps).length) {
          out.push(`  live DPs   (updated ${new Date(entry.updatedAt).toISOString()})`);
          for (const dp of Object.keys(entry.dps).map(Number).sort((a, b) => a - b)) {
            const v = entry.dps[String(dp)];
            out.push(`    DP ${pad(dp, 5)} ${pad(JSON.stringify(v), 28)} ${typeof v}`);
            dpLines.push(`DP ${dp}\t${JSON.stringify(v)}\t${typeof v}`);
          }
        } else {
          out.push('  live DPs   none received yet');
        }

        const record = {
          name:      device.getName(),
          driver:    driver.id,
          protocol:  conn?._version || settings.version || '',
          available: device.getAvailable(),
          dpTable:   dpLines.join('\n'),
          cloudSpec: '',   // filled below when the cloud answers
        };
        devices.push(record);

        // The cloud specification is matched on the device id — the same id the
        // device is paired with — so no guessing is involved. Kept in the record as
        // well as the text, so a bug report can be prefilled with it rather than
        // relying on the reporter to paste the bundle.
        if (!wantCloud && cloudUsable && onlyDevice) {
          out.push('  cloud spec  skipped (only the reported device is looked up)');
          record.cloudSpec = '';
        }
        if (wantCloud && id) {
          try {
            if (cloudError) throw cloudError;
            const detail = cloudDetail;
            const spec = detail?.status;
            if (Array.isArray(spec) && spec.length) {
              out.push('  cloud spec  code / dp / type / value / range');
              const specLines = [];
              for (const e of spec) {
                let range = '';
                try {
                  const p = typeof e.values === 'string' ? JSON.parse(e.values) : e.values;
                  if (p?.range) range = p.range.join(',');
                  else if (p?.min !== undefined) range = `${p.min}-${p.max}${p.unit ? ' ' + p.unit : ''}`;
                } catch (_) {}
                out.push(`    ${pad(e.code, 26)} ${pad(e.dp_id, 5)} ${pad(e.type, 9)}`
                  + ` ${pad(JSON.stringify(e.value ?? null), 16)} ${range}`);
                specLines.push(`${e.code}\tDP ${e.dp_id}\t${e.type}\t${JSON.stringify(e.value ?? null)}\t${range}`);
              }
              record.cloudSpec = specLines.join('\n');
            } else {
              out.push('  cloud spec  device not found in the cloud account');
              record.cloudSpec = '(device not found in the cloud account)';
            }
          } catch (err) {
            out.push(`  cloud spec  lookup failed: ${err.message}`);
            record.cloudSpec = `(lookup failed: ${err.message})`;
          }
        } else if (!cloudUsable) {
          record.cloudSpec = '(no cloud credentials saved — see the Cloud Lookup tab)';
        }
        out.push('-'.repeat(72));
      }
    }
    if (onProgress) {
      try { onProgress(allDevices.length, allDevices.length, null); } catch (e) {}
    }

    // Only warnings and errors: the full buffer runs to 500 entries and the
    // informational lines are noise in a report.
    const logs = this.homey.settings.get('diagnostic_logs');
    const bad  = (Array.isArray(logs) ? logs : []).filter((e) => e.level === 'warn' || e.level === 'error');
    out.push('');
    out.push(`LOG — warnings and errors, newest first (${bad.length} of ${(logs || []).length} entries)`);
    const logLines = bad.slice().reverse().map((e) => {
      const t = e.time ? new Date(e.time).toISOString() : '?';
      return `${t}  [${(e.level || 'info').toUpperCase()}]  [${e.source || '?'}]  ${e.message || ''}`;
    });
    for (const l of logLines) out.push('  ' + l);

    return {
      text:       out.join('\n'),
      appVersion,
      devices,
      // Trimmed separately: the issue URL has a length budget the full log blows.
      recentLog:  logLines.slice(0, 25).join('\n'),
    };
  }

  // ── Tuya Cloud API helpers ──────────────────────────────────────────────────

  async cloudLookup({ accessId, accessSecret, region }) {
    if (!accessId || !accessSecret || !region) throw new Error('Missing credentials');
    const host = TUYA_REGIONS[region];
    if (!host) throw new Error(`Unknown region: ${region}`);

    this.addLog('Cloud', `Lookup started — region: ${region}, host: ${host}`, 'info');
    const t0 = Date.now();

    let token, uid;
    try {
      ({ token, uid } = await this._tuyaGetToken(host, accessId, accessSecret));
      this.addLog('Cloud', `Token OK — uid: ${uid || '(none)'}`, 'info');
    } catch (e) {
      this.addLog('Cloud', `Token failed: ${e.message}`, 'error');
      throw e;
    }

    let devices;
    try {
      devices = await this._tuyaGetDevices(host, accessId, accessSecret, token, uid);
    } catch (e) {
      this.addLog('Cloud', `Device list failed: ${e.message}`, 'error');
      throw e;
    }
    this.addLog('Cloud', `Device list: ${devices.length} device(s) in ${Date.now() - t0} ms — enriching local keys…`, 'info');

    // Enrich local keys — two passes, matching cloudEnrich strategy:
    //   Pass 1: v2.0/cloud/thing/batch  — best source (returns local_key + product_name)
    //   Pass 2: v1.0/iot-03/devices/factory-infos — fallback for any still-missing keys
    // 120 ms pause between calls keeps us below Tuya's 10 req/s limit.
    // Worst case for 150 devices: 16 calls × ~500 ms = ~8 s — within Homey.api() ~10 s timeout.
    const pause = () => new Promise((r) => setTimeout(r, 120));

    // Pass 1: v2.0 batch
    for (let i = 0; i < devices.length; i += 20) {
      if (i > 0) await pause();
      const batch = devices.slice(i, i + 20);
      const ids   = batch.map((d) => d.id).join(',');
      try {
        const res = await this._tuyaRequest(host,
          `/v2.0/cloud/thing/batch?device_ids=${ids}`,
          accessId, accessSecret, token);
        if (res.success && Array.isArray(res.result)) {
          const found = res.result.filter((r) => r.local_key).length;
          this.addLog('Cloud', `v2.0 batch ${Math.floor(i / 20) + 1}: ${res.result.length} returned, ${found} with local_key`, 'info');
          for (const r of res.result) {
            const d = batch.find((x) => x.id === r.id);
            if (!d) continue;
            if (r.local_key)    d.local_key = r.local_key;
            if (r.product_name) d.product   = r.product_name;
          }
        } else {
          this.addLog('Cloud', `v2.0 batch ${Math.floor(i / 20) + 1} failed: code=${res.code} msg=${res.msg}`, 'warn');
        }
      } catch (e) {
        this.addLog('Cloud', `v2.0 batch ${Math.floor(i / 20) + 1} error: ${e.message}`, 'warn');
      }
    }

    // Pass 2: factory-infos fallback for any devices still missing local_key
    const missingKey = devices.filter((d) => !d.local_key);
    if (missingKey.length > 0) {
      this.addLog('Cloud', `factory-infos fallback for ${missingKey.length} device(s) without local_key`, 'info');
      for (let i = 0; i < missingKey.length; i += 20) {
        await pause();
        const batch = missingKey.slice(i, i + 20);
        const ids   = batch.map((d) => d.id).join(',');
        try {
          const res = await this._tuyaRequest(host,
            `/v1.0/iot-03/devices/factory-infos?device_ids=${ids}`,
            accessId, accessSecret, token);
          if (res.success && Array.isArray(res.result)) {
            const found = res.result.filter((r) => r.local_key).length;
            this.addLog('Cloud', `factory-infos ${Math.floor(i / 20) + 1}: ${res.result.length} returned, ${found} with local_key`, 'info');
            for (const r of res.result) {
              const d = batch.find((x) => x.id === r.id || x.uuid === r.uuid);
              if (d && r.local_key) d.local_key = r.local_key;
            }
          } else {
            this.addLog('Cloud', `factory-infos ${Math.floor(i / 20) + 1} failed: code=${res.code} msg=${res.msg}`, 'warn');
          }
        } catch (e) {
          this.addLog('Cloud', `factory-infos ${Math.floor(i / 20) + 1} error: ${e.message}`, 'warn');
        }
      }
    }

    const withKey = devices.filter((d) => d.local_key).length;
    this.addLog('Cloud', `Lookup complete — ${devices.length} device(s), ${withKey} with local_key, ${Date.now() - t0} ms total`, 'info');
    return devices;
  }

  /**
   * Enrich up to 20 devices with local_key and product name.
   * Called from the settings page in small batches after the device list is shown,
   * so the Homey.api() timeout is never hit on accounts with many devices.
   */
  async cloudEnrich({ accessId, accessSecret, region, deviceIds }) {
    if (!accessId || !accessSecret || !region || !deviceIds) throw new Error('Missing parameters');
    const host = TUYA_REGIONS[region];
    if (!host) throw new Error(`Unknown region: ${region}`);

    const ids = String(deviceIds).split(',').map((s) => s.trim()).filter(Boolean).slice(0, 20);
    if (ids.length === 0) return [];

    this.addLog('Cloud', `Enrich batch: ${ids.length} device(s)`, 'info');
    const { token } = await this._tuyaGetToken(host, accessId, accessSecret);

    const result = ids.map((id) => ({ id, local_key: '', product: '' }));

    // v2.0 batch — best source for local_key + product_name
    try {
      const res = await this._tuyaRequest(host,
        `/v2.0/cloud/thing/batch?device_ids=${ids.join(',')}`,
        accessId, accessSecret, token);
      if (res.success && Array.isArray(res.result)) {
        const found = res.result.filter((r) => r.local_key).length;
        this.addLog('Cloud', `v2.0 batch: ${res.result.length} returned, ${found} with local_key`, 'info');
        for (const r of res.result) {
          const d = result.find((x) => x.id === r.id);
          if (!d) continue;
          if (r.local_key) d.local_key = r.local_key;
          if (r.product_name) d.product = r.product_name;
        }
      } else {
        this.addLog('Cloud', `v2.0 batch failed: code=${res.code} msg=${res.msg}`, 'warn');
      }
    } catch (e) {
      this.addLog('Cloud', `v2.0 batch error: ${e.message}`, 'warn');
    }

    // factory-infos fallback for any still missing local_key
    const missing = result.filter((d) => !d.local_key);
    if (missing.length > 0) {
      this.addLog('Cloud', `factory-infos fallback for ${missing.length} device(s) without local_key`, 'info');
      try {
        const res = await this._tuyaRequest(host,
          `/v1.0/iot-03/devices/factory-infos?device_ids=${missing.map((d) => d.id).join(',')}`,
          accessId, accessSecret, token);
        if (res.success && Array.isArray(res.result)) {
          const found = res.result.filter((r) => r.local_key).length;
          this.addLog('Cloud', `factory-infos: ${res.result.length} returned, ${found} with local_key`, 'info');
          for (const r of res.result) {
            const d = result.find((x) => x.id === r.id || x.uuid === r.uuid);
            if (d && r.local_key) d.local_key = r.local_key;
          }
        } else {
          this.addLog('Cloud', `factory-infos failed: code=${res.code} msg=${res.msg}`, 'warn');
        }
      } catch (e) {
        this.addLog('Cloud', `factory-infos error: ${e.message}`, 'warn');
      }
    }

    const withKey = result.filter((d) => d.local_key).length;
    if (missing.length > 0 && withKey < ids.length) {
      this.addLog('Cloud', `Enrich complete: ${withKey}/${ids.length} have local_key`, withKey === 0 ? 'warn' : 'info');
    }

    return result;
  }

  // Lowercase alias so Homey's case-sensitive API-key lookup finds this method
  // when the app.json key "cloudenrich" is resolved.
  async cloudenrich(args) { return this.cloudEnrich(args); }

  async cloudDeviceDetail({ accessId, accessSecret, region, deviceId }) {
    if (!accessId || !accessSecret || !region || !deviceId) throw new Error('Missing parameters');
    const host = TUYA_REGIONS[region];
    if (!host) throw new Error(`Unknown region: ${region}`);

    const { token } = await this._tuyaGetToken(host, accessId, accessSecret);

    // Fetch from multiple endpoints to get the most complete picture. The thing
    // endpoint is only here for the model name: the local protocol never reveals
    // which product a device actually is, so without it a report says "a plug"
    // where it could say which plug. It runs in the same batch, so it costs no
    // extra wall time, and a failure just leaves the model blank.
    const [statusRes, specRes, propsRes, thingRes] = await Promise.all([
      this._tuyaRequest(host, `/v1.0/iot-03/devices/${deviceId}/status`, accessId, accessSecret, token).catch(() => ({})),
      this._tuyaRequest(host, `/v1.0/iot-03/devices/${deviceId}/specification`, accessId, accessSecret, token).catch(() => ({})),
      this._tuyaRequest(host, `/v2.0/cloud/thing/${deviceId}/shadow/properties`, accessId, accessSecret, token).catch(() => ({})),
      this._tuyaRequest(host, `/v2.0/cloud/thing/${deviceId}`, accessId, accessSecret, token).catch(() => ({})),
    ]);

    const status = statusRes.success ? (statusRes.result || []) : [];
    const spec   = specRes.success ? (specRes.result || {}) : {};
    const props  = propsRes.success ? (propsRes.result?.properties || []) : [];
    const thing  = thingRes.success ? (thingRes.result || {}) : {};

    // Build a map: code → { dp_id, value, type, range/values }
    const dps = {};

    // Properties endpoint has dp_id + current values
    for (const p of props) {
      dps[p.code] = {
        code: p.code, dp_id: p.dp_id, type: p.type,
        current_value: p.value, settable: false,
      };
    }

    // Specification adds type details and settable info
    for (const fn of (spec.functions || [])) {
      if (dps[fn.code]) {
        dps[fn.code].type = fn.type || dps[fn.code].type;
        dps[fn.code].values = fn.values;
        dps[fn.code].settable = true;
        if (fn.dp_id) dps[fn.code].dp_id = fn.dp_id;
      } else {
        dps[fn.code] = { code: fn.code, type: fn.type, values: fn.values, dp_id: fn.dp_id, settable: true };
      }
    }
    for (const st of (spec.status || [])) {
      if (dps[st.code]) {
        if (!dps[st.code].values && st.values) dps[st.code].values = st.values;
        if (!dps[st.code].type && st.type) dps[st.code].type = st.type;
        if (st.dp_id) dps[st.code].dp_id = st.dp_id;
      } else {
        dps[st.code] = { code: st.code, type: st.type, values: st.values, dp_id: st.dp_id, settable: false };
      }
    }

    // Status endpoint fills in current values for anything still missing
    for (const s of status) {
      if (dps[s.code]) {
        if (dps[s.code].current_value === undefined) dps[s.code].current_value = s.value;
      } else {
        dps[s.code] = { code: s.code, current_value: s.value, settable: false };
      }
    }

    return {
      status:    Object.values(dps),
      category:  spec.category || thing.category || '',
      product:   thing.product_name || thing.model || '',
      productId: thing.product_id || '',
    };
  }

  /**
   * Re-reads the manufacturer's declared enum ranges for devices that are already
   * paired, and writes them into the companion "…_values" settings.
   *
   * Those lists are otherwise only filled during pairing, so a device added before
   * its vocabulary was known — a unit whose modes are "0"/"1"/"2", say — keeps a
   * picker full of names it does not understand until it is deleted and added
   * again. This is the same lookup pairing performs, made available afterwards.
   *
   * Dry run by default, like every other check: the same work is done but nothing is
   * saved, so the settings page can show what would change and let the user decide.
   * Writing device settings without showing them first is hard to undo by hand, so the
   * harmless direction is the one that needs no argument.
   *
   * Deliberately narrow: only companion settings are written — value lists, and,
   * where the specification states a data point's own numeric span, the min/max
   * pair a slider is scaled against. DP numbers themselves are left exactly as
   * they are, and nothing is ever switched off. During pairing the live DP
   * snapshot protects a real DP from being cleared by an incomplete specification;
   * here there is no snapshot, so that protection is unavailable and remapping
   * would risk breaking a device the user has already tuned by hand.
   *
   * @returns {Promise<{devices: Array, skipped: Array, dryRun: boolean}>}
   *   `devices` holds what was changed, or what would change when dryRun is set.
   */
  async applyCloudValues({ onlyDevice = null, dryRun = true } = {}) {
    const accessId     = this.homey.settings.get('cloud_access_id');
    const accessSecret = this.homey.settings.get('cloud_access_secret');
    const region       = this.homey.settings.get('cloud_region');
    if (!accessId || !accessSecret || !region) {
      throw new Error('Cloud Lookup is not configured. Enter your Tuya API credentials first.');
    }

    const { detectViaCloud } = require('./lib/dpCodeMap');
    const devices = [];
    const skipped = [];

    for (const driver of Object.values(this.homey.drivers.getDrivers())) {
      const maps = typeof driver.getCloudMaps === 'function' ? driver.getCloudMaps() : null;
      const hasEnumMap  = !!maps?.enumValuesMap && Object.keys(maps.enumValuesMap).length > 0;
      const hasRangeMap = !!maps?.rangeMap && Object.keys(maps.rangeMap).length > 0;
      for (const device of driver.getDevices()) {
        const name = device.getName();
        if (onlyDevice && name !== onlyDevice) continue;

        if (!hasEnumMap && !hasRangeMap) {
          skipped.push({ name, driver: driver.id, reason: 'this driver has no value lists to fill' });
          continue;
        }

        let id = '';
        try { id = device.getData().id || ''; } catch (e) {}
        if (!id) {
          skipped.push({ name, driver: driver.id, reason: 'no device id' });
          continue;
        }

        let cloudDps = {};
        try {
          cloudDps = await detectViaCloud(this.homey, id, maps.codeMap,
            (m) => this.log(`[${name}] ${m}`), maps.enumValuesMap || {}, null, maps.rangeMap || {});
        } catch (err) {
          skipped.push({ name, driver: driver.id, reason: `lookup failed: ${err.message}` });
          continue;
        }

        // Only the companion keys are allowed through — never a dp_* DP number.
        // A value-list entry is either the setting name or { setting, from } —
        // see extractEnumValues in lib/dpCodeMap.js. A range entry is the pair of
        // settings its min/max are written to — see extractIntegerRange there.
        const allowed = new Set([
          ...Object.values(maps.enumValuesMap || {}).map((t) => (typeof t === 'string' ? t : t?.setting)),
          ...Object.values(maps.rangeMap || {}).flatMap((r) => [r?.min, r?.max]),
        ].filter(Boolean));
        const changes = [];
        for (const [key, value] of Object.entries(cloudDps)) {
          if (!allowed.has(key)) continue;
          const isText   = typeof value === 'string' && value.trim();
          const isNumber = typeof value === 'number' && Number.isFinite(value);
          if (!isText && !isNumber) continue;
          let current = null;
          try { current = device.getSetting(key); } catch (e) {}
          if (current === value) continue;
          changes.push({ key, from: current ?? '', to: value });
        }

        if (changes.length === 0) {
          const found = Object.keys(cloudDps).length > 0;
          skipped.push({ name, driver: driver.id,
            reason: found ? 'already up to date' : 'device not found in the cloud account' });
          continue;
        }

        if (dryRun) {
          devices.push({ name, driver: driver.id, changes });
          continue;
        }

        try {
          const patch = {};
          for (const c of changes) patch[c.key] = c.to;
          await device.setSettings(patch);
          devices.push({ name, driver: driver.id, changes });
          this.log(`[${name}] cloud value lists applied: `
            + changes.map((c) => `${c.key} = ${c.to}`).join('; '));
        } catch (err) {
          skipped.push({ name, driver: driver.id, reason: `could not save: ${err.message}` });
        }
      }
    }

    return { devices, skipped, dryRun };
  }

  /**
   * Finds configured data points that the device provably does not have, for devices
   * that are already paired.
   *
   * Pairing already does this: a default whose number is absent from the
   * manufacturer's specification is switched off there. What it cannot do is help a
   * device paired before that existed, or one whose driver defaults were written for
   * a different device family. A wireless chime carrying a camera doorbell's defaults
   * shows a motion tile, a night-vision switch and an SD-recording switch that can
   * never do anything, and every one of those numbers points into thin air.
   *
   * Two independent signals are required, and the specification is the only one that
   * can prove absence:
   *
   *   - the specification lists the device's data points and this number is not
   *     among them, and
   *   - the device has never reported that number in all the time we have been
   *     watching it.
   *
   * The second condition alone would be badly wrong. Plenty of real data points only
   * ever appear when something happens — a fault register on a healthy device, a
   * doorbell's ring, an alarm — so "never seen" on its own means nothing. It is kept
   * as corroboration because Tuya specifications are occasionally incomplete: if the
   * device has ever mentioned the number itself, that outranks a specification that
   * fails to list it, exactly as during pairing.
   *
   * @returns {Promise<{devices: Array, skipped: Array, dryRun: boolean}>}
   */
  async findPhantomDps({ onlyDevice = null, dryRun = true } = {}) {
    const accessId     = this.homey.settings.get('cloud_access_id');
    const accessSecret = this.homey.settings.get('cloud_access_secret');
    const region       = this.homey.settings.get('cloud_region');
    if (!accessId || !accessSecret || !region) {
      throw new Error('Cloud Lookup is not configured. Enter your Tuya API credentials first.');
    }

    const devices = [];
    const skipped = [];

    for (const driver of Object.values(this.homey.drivers.getDrivers())) {
      for (const device of driver.getDevices()) {
        const name = device.getName();
        if (onlyDevice && name !== onlyDevice) continue;

        const note = (reason) => skipped.push({ name, driver: driver.id, reason });
        const read = (k) => { try { return device.getStoreValue(k); } catch (e) { return null; } };

        let id = '';
        try { id = device.getData().id || ''; } catch (e) {}
        if (!id) { note('no device id'); continue; }

        const settings = (() => { try { return device.getSettings() || {}; } catch (e) { return {}; } })();
        const configured = Object.entries(settings)
          .filter(([k, v]) => k.startsWith('dp_') && Number.isInteger(v) && v > 0);
        if (configured.length === 0) { note('no data points configured'); continue; }

        // Without a single reported data point we know nothing about this device, and
        // a specification on its own is not enough to start switching things off.
        const seen = new Set((read('seenDps') || []).map(Number));
        if (seen.size === 0) { note('device has not reported anything yet'); continue; }

        let spec = null;
        try {
          const detail = await this.cloudDeviceDetail({ accessId, accessSecret, region, deviceId: id });
          spec = detail?.status;
        } catch (err) { note(`lookup failed: ${err.message}`); continue; }

        const present = new Set((Array.isArray(spec) ? spec : []).map((e) => e && e.dp_id).filter(Boolean));
        if (present.size === 0) { note('device not found in the cloud account'); continue; }

        const changes = [];
        for (const [key, dp] of configured) {
          if (present.has(dp)) continue;   // the manufacturer says it exists
          if (seen.has(dp)) continue;      // we have seen it ourselves — trust that
          changes.push({ key, from: dp, to: 0 });
        }

        if (changes.length === 0) { note('nothing points at a missing data point'); continue; }

        const since = read('seenSince');
        const entry = {
          name,
          driver:   driver.id,
          changes,
          watchedSince: since || null,
          seenCount: seen.size,
        };

        if (dryRun) { devices.push(entry); continue; }

        try {
          const patch = {};
          for (const c of changes) patch[c.key] = 0;
          await device.setSettings(patch);
          devices.push(entry);
          this.log(`[${name}] switched off data points the device does not have: `
            + changes.map((c) => `${c.key} (was ${c.from})`).join(', '));
        } catch (err) {
          note(`could not save: ${err.message}`);
        }
      }
    }

    return { devices, skipped, dryRun };
  }

  /**
   * Compares each device's stored local key against the one the Tuya account now
   * holds, and offers to update the ones that no longer match.
   *
   * This is the most common way a working device stops working: the key changes every
   * time the device is reset or re-paired in the Tuya app, and the symptom is a device
   * that simply never connects again. The cloud is authoritative here, so unlike the
   * other checks there is no guesswork — the comparison is exact.
   *
   * The keys never leave this method in full. Only a shortened form goes back to the
   * settings page, because that page ends up in screenshots on the community forum —
   * it happened this week — and a local key is the credential for the device.
   *
   * @returns {Promise<{devices: Array, skipped: Array, dryRun: boolean}>}
   */
  async findStaleKeys({ onlyDevice = null, dryRun = true } = {}) {
    const accessId     = this.homey.settings.get('cloud_access_id');
    const accessSecret = this.homey.settings.get('cloud_access_secret');
    const region       = this.homey.settings.get('cloud_region');
    if (!accessId || !accessSecret || !region) {
      throw new Error('Cloud Lookup is not configured. Enter your Tuya API credentials first.');
    }

    // One request for the whole account rather than one per device: the lookup already
    // returns every device with its key, and Tuya rate-limits per second.
    let cloudDevices = [];
    try {
      cloudDevices = await this.cloudLookup({ accessId, accessSecret, region }) || [];
    } catch (err) {
      throw new Error(`Cloud Lookup failed: ${err.message}`);
    }
    const byId = new Map(cloudDevices.filter((d) => d && d.id).map((d) => [String(d.id), d]));

    // The account listing is not complete, and cannot be relied on to be.
    // _tuyaGetDevices tries four strategies in order and returns at the first one that
    // yields anything — they do not see the same devices, so a unit that sits in another
    // home, under another linked user, or was added to the project directly rather than
    // through the app account is simply absent from whichever list won.
    //
    // Pairing never noticed, because it asks for one device by its own id. That is how a
    // sensor could be paired from its cloud specification and then be reported here as
    // "not found in the cloud account" while working perfectly — which is exactly what
    // was reported, with a clean log, because nothing had failed.
    //
    // So whatever the listing missed is asked for directly, by the same route pairing
    // uses. Batched by twenty, like every other call against this API.
    // Die Kennungen, unter denen ein Geraet in der Tuya-Cloud stehen kann.
    //
    // getData().id schreibt Homey beim Paaren fest und laesst sie nie mehr aendern. Die
    // Einstellung device_id ist die, mit der das Geraet spricht, und sie ist aenderbar -
    // nach einem erneuten Anlernen in der Tuya-App steht dort eine andere. Wer nur die
    // erste sucht, findet ein solches Geraet nie wieder und meldet es als nicht im Konto
    // vorhanden, waehrend der abgelaufene Schluessel stehen bleibt.
    //
    // Die Einstellung kommt zuerst, sie ist die aktuelle. Als lokale Funktion, weil
    // dieser Rumpf einzeln gelesen und ausgefuehrt wird.
    const kennungen = (device) => {
      let data = '';
      let setting = '';
      try { data = String(device.getData().id || ''); } catch (e) {}
      try { setting = String(device.getSetting('device_id') || ''); } catch (e) {}
      const ids = [...new Set([setting, data].filter(Boolean))];
      return { ids, setting, data,
        abweichend: Boolean(setting && data && setting !== data) };
    };

    const wanted = [];
    for (const driver of Object.values(this.homey.drivers.getDrivers())) {
      for (const device of driver.getDevices()) {
        if (onlyDevice && device.getName() !== onlyDevice) continue;
        for (const id of kennungen(device).ids) {
          if (!byId.has(id)) wanted.push(id);
        }
      }
    }
    const missingIds = [...new Set(wanted)];
    for (let i = 0; i < missingIds.length; i += 20) {
      const batch = missingIds.slice(i, i + 20);
      try {
        const rows = await this.cloudEnrich({
          accessId, accessSecret, region, deviceIds: batch.join(','),
        });
        for (const r of rows || []) {
          if (r && r.id && r.local_key) byId.set(String(r.id), r);
        }
      } catch (err) {
        this.addLog('Cloud',
          `Direct lookup of ${batch.length} device(s) failed: ${err.message}`, 'warn');
      }
    }
    if (missingIds.length > 0) {
      const found = missingIds.filter((id) => byId.has(id)).length;
      this.addLog('Cloud',
        `${missingIds.length} device(s) missing from the account listing — asked for by id, `
        + `${found} found`, found === missingIds.length ? 'info' : 'warn');
    }

    const short = (k) => {
      const str = String(k || '');
      return str.length > 4 ? `${str.slice(0, 4)}\u2026 (${str.length} chars)` : '(empty)';
    };

    const devices = [];
    const skipped = [];

    for (const driver of Object.values(this.homey.drivers.getDrivers())) {
      for (const device of driver.getDevices()) {
        const name = device.getName();
        if (onlyDevice && name !== onlyDevice) continue;
        const note = (reason) => skipped.push({ name, driver: driver.id, reason });

        const kennung = kennungen(device);
        if (kennung.ids.length === 0) { note('no device id'); continue; }

        const entry = kennung.ids.map((id) => byId.get(id)).find(Boolean);
        if (!entry) {
          // Weichen die beiden Kennungen ab, ist das der wahrscheinliche Grund und
          // gehoert in die Begruendung: gesucht wurde unter beiden, gefunden keine.
          note(kennung.abweichend
            ? 'not found in the cloud under either id — the Device ID in settings '
              + `(${kennung.setting.slice(0, 8)}\u2026) differs from the one it was paired `
              + `with (${kennung.data.slice(0, 8)}\u2026), and the account holds neither`
            : 'not in the cloud account, and not found by its id either');
          continue;
        }
        if (!entry.local_key) { note('the cloud account holds no key for it'); continue; }

        let stored = '';
        try { stored = device.getSetting('local_key') || ''; } catch (e) {}
        if (stored === entry.local_key) { note('key is up to date'); continue; }

        const change = { key: 'local_key', from: short(stored), to: short(entry.local_key) };

        if (dryRun) { devices.push({ name, driver: driver.id, changes: [change] }); continue; }

        try {
          // Writing this reconnects the device, which is the point: onSettings treats
          // local_key as a connection setting.
          await device.setSettings({ local_key: entry.local_key });
          devices.push({ name, driver: driver.id, changes: [change] });
          this.log(`[${name}] local key updated from the Tuya account`);
        } catch (err) {
          note(`could not save: ${err.message}`);
        }
      }
    }

    return { devices, skipped, dryRun };
  }

  /**
   * Finds devices talking a different protocol version than the one configured, and
   * offers to store the version actually in use.
   *
   * The connection rotates through the versions when the configured one keeps failing,
   * so a device can end up working on 3.3 while its settings still say 3.4. It works,
   * but every reconnect pays the rotation delay first — five failed attempts before it
   * tries again. The app already notices and asks the user to correct it by hand; this
   * turns that request into one press.
   *
   * Needs no cloud credentials: both values are known locally. Only devices with a live
   * connection are judged, because the version in use is not knowable otherwise.
   *
   * @returns {Promise<{devices: Array, skipped: Array, dryRun: boolean}>}
   */
  async findProtocolMismatch({ onlyDevice = null, dryRun = true } = {}) {
    const devices = [];
    const skipped = [];

    for (const driver of Object.values(this.homey.drivers.getDrivers())) {
      for (const device of driver.getDevices()) {
        const name = device.getName();
        if (onlyDevice && name !== onlyDevice) continue;
        const note = (reason) => skipped.push({ name, driver: driver.id, reason });

        const conn = device._conn;
        if (!conn || !conn.connected) { note('not connected — cannot tell'); continue; }
        // Connected is not the same as working, and on protocol 3.3, 3.2 and 3.1 the
        // difference matters here: those have no session handshake, so the socket opens
        // for any device whether or not it speaks that version. Writing the version of a
        // connection that has never delivered a byte would enshrine the wrong one in the
        // settings — which is how a reported pool heat pump would have had its 3.4 setting
        // overwritten with the 3.3 it was merely stuck on. Wait for the device to answer.
        if (!conn.versionProven) { note('connected but has not answered yet — cannot tell'); continue; }

        const inUse = String(conn._version || '');
        if (!inUse) { note('connection reports no version'); continue; }

        let configured = '';
        try { configured = String(device.getSetting('version') || ''); } catch (e) {}
        if (configured === inUse) { note('protocol version is correct'); continue; }

        const change = {
          key: 'version',
          from: configured || '(not set)',
          to:   inUse,
        };

        if (dryRun) { devices.push({ name, driver: driver.id, changes: [change] }); continue; }

        try {
          await device.setSettings({ version: inUse });
          devices.push({ name, driver: driver.id, changes: [change] });
          this.log(`[${name}] protocol version corrected to ${inUse} (was ${change.from})`);
        } catch (err) {
          note(`could not save: ${err.message}`);
        }
      }
    }

    return { devices, skipped, dryRun };
  }

  /**
   * Reads the scaling Tuya declares for a data point and offers to store it, for the
   * settings that currently have to be worked out by hand.
   *
   * A power-monitoring plug reports whole numbers and the specification says how to
   * scale them: cur_voltage carries scale 1, so raw 2301 is 230.1 V. A thermostat
   * reporting 2750 for 27.50 C carries scale 2. Get it wrong and the tile reads ten or
   * a hundred times off, which is a recurring report — and the only way to fix it today
   * is to notice the factor and pick it from a dropdown.
   *
   * Two spellings are in use across the drivers and both are supported, because the
   * settings were written that way and renaming them would reset every device that has
   * one. A plain string names a multiplier setting (0.1); { setting, kind: 'divisor' }
   * names a divisor setting (10). Which one a setting is cannot be guessed from its
   * value — 1 means the same in both — so the driver has to say.
   *
   * What it will not do:
   *   - invent a value the setting does not accept. Dropdowns are checked against their
   *     option list, number fields against min and max, both read from the manifest so
   *     there is no second copy to drift.
   *   - resolve a contradiction. Several drivers use one divisor for both the target and
   *     the measured temperature; if the specification declares different scales for the
   *     two, no single value satisfies both and the conflict is reported instead.
   *
   * @returns {Promise<{devices: Array, skipped: Array, dryRun: boolean}>}
   */
  async findScaleMismatch({ onlyDevice = null, dryRun = true } = {}) {
    const accessId     = this.homey.settings.get('cloud_access_id');
    const accessSecret = this.homey.settings.get('cloud_access_secret');
    const region       = this.homey.settings.get('cloud_region');
    if (!accessId || !accessSecret || !region) {
      throw new Error('Cloud Lookup is not configured. Enter your Tuya API credentials first.');
    }

    // Tuya states an exponent: the reading is raw / 10^scale. Built as strings rather
    // than from arithmetic so they match the dropdowns' own spelling exactly.
    const asMultiplier = (scale) => (scale === 0 ? '1' : `0.${'0'.repeat(scale - 1)}1`);
    const asDivisor    = (scale) => (scale === 0 ? '1' : `1${'0'.repeat(scale)}`);

    // What each setting will accept, from the manifest: a list for a dropdown, a range
    // for a number field.
    const rulesFor = (driverId) => {
      const out = {};
      try {
        const manifest = this.homey.manifest?.drivers?.find((d) => d.id === driverId);
        const walk = (items) => {
          for (const item of items || []) {
            if (item.type === 'group') { walk(item.children); continue; }
            if (Array.isArray(item.values)) out[item.id] = { list: item.values.map((v) => String(v.id)) };
            else if (item.type === 'number') out[item.id] = { min: item.min, max: item.max };
          }
        };
        walk(manifest?.settings);
      } catch (e) {}
      return out;
    };
    const accepts = (rule, value) => {
      if (!rule) return false;
      if (rule.list) return rule.list.includes(value);
      const n = Number(value);
      if (!Number.isFinite(n)) return false;
      return (rule.min === undefined || n >= rule.min) && (rule.max === undefined || n <= rule.max);
    };

    const devices = [];
    const skipped = [];

    for (const driver of Object.values(this.homey.drivers.getDrivers())) {
      const maps  = typeof driver.getScaleMaps === 'function' ? driver.getScaleMaps() : null;
      const rules = maps ? rulesFor(driver.id) : {};

      for (const device of driver.getDevices()) {
        const name = device.getName();
        if (onlyDevice && name !== onlyDevice) continue;
        const note = (reason) => skipped.push({ name, driver: driver.id, reason });

        if (!maps || Object.keys(maps).length === 0) {
          note('this driver has no scaling settings');
          continue;
        }
        if (Object.keys(rules).length === 0) {
          note('could not read the allowed values from the app manifest');
          continue;
        }

        let id = '';
        try { id = device.getData().id || ''; } catch (e) {}
        if (!id) { note('no device id'); continue; }

        const settings = (() => { try { return device.getSettings() || {}; } catch (e) { return {}; } })();

        let spec = null;
        try {
          const detail = await this.cloudDeviceDetail({ accessId, accessSecret, region, deviceId: id });
          spec = detail?.status;
        } catch (err) { note(`lookup failed: ${err.message}`); continue; }
        if (!Array.isArray(spec) || spec.length === 0) {
          note('device not found in the cloud account');
          continue;
        }

        // Collect one proposal per data point first, then reconcile: several data points
        // can share a single setting.
        const wishes = {};   // settingKey -> [{ dpKey, wanted }]
        for (const [dpKey, target] of Object.entries(maps)) {
          const dp = settings[dpKey];
          if (!Number.isInteger(dp) || dp <= 0) continue;   // data point switched off

          const scaleKey = typeof target === 'string' ? target : target?.setting;
          const kind     = typeof target === 'string' ? 'multiplier' : (target?.kind || 'multiplier');
          if (!scaleKey) continue;

          const entry = spec.find((e) => e && e.dp_id === dp);
          if (!entry || !entry.values) continue;

          let declared = null;
          try {
            const parsed = typeof entry.values === 'string' ? JSON.parse(entry.values) : entry.values;
            if (Number.isInteger(parsed?.scale)) declared = parsed.scale;
          } catch (e) { /* not JSON — nothing to read */ }
          if (declared === null || declared < 0 || declared > 6) continue;

          const wanted = kind === 'divisor' ? asDivisor(declared) : asMultiplier(declared);
          (wishes[scaleKey] = wishes[scaleKey] || []).push({ dpKey, wanted });
        }

        const changes = [];
        const notes   = [];
        for (const [scaleKey, list] of Object.entries(wishes)) {
          const distinct = [...new Set(list.map((w) => w.wanted))];
          if (distinct.length > 1) {
            notes.push(`${scaleKey}: the specification asks for ${distinct.join(' and ')} on `
              + `${list.map((w) => w.dpKey).join(' and ')}, and one setting cannot be both`);
            continue;
          }

          const wanted  = distinct[0];
          const current = String(settings[scaleKey] ?? '');
          if (current === wanted) continue;

          if (!accepts(rules[scaleKey], wanted)) {
            notes.push(`${scaleKey}: the specification says ${wanted}, which this setting does not accept`);
            continue;
          }
          changes.push({ key: scaleKey, from: current || '(not set)', to: wanted });
        }

        for (const n of notes) note(n);

        if (changes.length === 0) {
          if (notes.length === 0) note('every scaling factor already matches');
          continue;
        }

        if (dryRun) { devices.push({ name, driver: driver.id, changes }); continue; }

        try {
          const patch = {};
          for (const c of changes) {
            // Number fields must be written as numbers, dropdowns as their option string.
            patch[c.key] = rules[c.key] && rules[c.key].list ? c.to : Number(c.to);
          }
          await device.setSettings(patch);
          devices.push({ name, driver: driver.id, changes });
          this.log(`[${name}] scaling set from the specification: `
            + changes.map((c) => `${c.key} = ${c.to}`).join(', '));
        } catch (err) {
          note(`could not save: ${err.message}`);
        }
      }
    }

    return { devices, skipped, dryRun };
  }
  async _tuyaGetToken(host, clientId, secret) {
    const path = '/v1.0/token?grant_type=1';
    const res  = await this._tuyaRequest(host, path, clientId, secret, null);
    if (!res.success) throw new Error(res.msg || 'Token request failed');
    return { token: res.result.access_token, uid: res.result.uid || '' };
  }

  async _enrichDevices(host, clientId, secret, token, allDevices) {
    // 120 ms between batch calls keeps us well below Tuya's 10 req/s limit.
    const pause = () => new Promise((r) => setTimeout(r, 120));

    // Step 1: v2.0 batch — best source for custom_name + product_name + local_key.
    // Use literal commas (not %2C) — Tuya normalises the URL before signature
    // verification, so percent-encoding commas causes "sign invalid".
    for (let i = 0; i < allDevices.length; i += 20) {
      if (i > 0) await pause();
      const batch = allDevices.slice(i, i + 20);
      const ids = batch.map((d) => d.id).join(',');
      try {
        const res = await this._tuyaRequest(host,
          `/v2.0/cloud/thing/batch?device_ids=${ids}`,
          clientId, secret, token);
        if (res.success && Array.isArray(res.result)) {
          for (const r of res.result) {
            const d = allDevices.find((x) => x.id === r.id);
            if (!d) continue;
            if (!d.local_key && r.local_key) d.local_key = r.local_key;
            if (!d.product && r.product_name) d.product = r.product_name;
            if (!d.name && r.name) d.name = r.name;
            if (r.custom_name) d.custom_name = r.custom_name;
          }
        } else {
          this.addLog('Cloud', `Batch enrich failed: ${res.msg || JSON.stringify(res).slice(0, 80)}`, 'warn');
        }
      } catch (e) {
        this.addLog('Cloud', `Batch enrich error: ${e.message}`, 'warn');
      }
    }

    // Step 2: v1.0 factory-infos batch — local_key for any devices still missing it.
    const missingKey = allDevices.filter((d) => !d.local_key);
    for (let i = 0; i < missingKey.length; i += 20) {
      await pause();
      const batch = missingKey.slice(i, i + 20);
      const ids = batch.map((d) => d.id).join(',');
      try {
        const res = await this._tuyaRequest(host,
          `/v1.0/iot-03/devices/factory-infos?device_ids=${ids}`,
          clientId, secret, token);
        if (res.success && Array.isArray(res.result)) {
          for (const r of res.result) {
            const d = allDevices.find((x) => x.id === r.id || x.uuid === r.uuid);
            if (d && !d.local_key && r.local_key) d.local_key = r.local_key;
          }
        }
      } catch (_) {}
    }

    // Step 3: v1.0 per-device for product name still missing after both batch passes.
    // Capped at 20 to stay within Homey.api() timeout budget.
    const needsProduct = allDevices.filter((d) => !d.product).slice(0, 20);
    for (const d of needsProduct) {
      await pause();
      try {
        const res = await this._tuyaRequest(host,
          `/v1.0/iot-03/devices/${d.id}`, clientId, secret, token);
        if (res.success && res.result) {
          const r = res.result;
          if (!d.local_key && r.local_key) d.local_key = r.local_key;
          if (!d.product && r.product_name) d.product = r.product_name;
          if (!d.custom_name && r.custom_name) d.custom_name = r.custom_name;
        }
      } catch (_) {}
    }
  }

  async _tuyaGetDevices(host, clientId, secret, token, projectUid) {
    const allDevices = [];
    const seen = new Set();
    const errors = [];
    const addDevice = (d) => {
      if (!d.id || seen.has(d.id)) return;
      seen.add(d.id);
      allDevices.push({
        name:         d.name || '',
        custom_name:  d.custom_name || '',
        product:      d.product_name || '',
        id:           d.id || '',
        local_key:    d.local_key || '',
        category:     d.category || '',
        online:       d.online ?? false,
        uuid:         d.uuid || '',
      });
    };

    // Helper: cursor-paginated fetch from /v1.3/iot-03/devices
    // source_type=tuyaUser + source_id works with both bay... and ay... UIDs on v1.3 (not v1.0).
    // Pagination uses last_row_key cursor — page_no is NOT supported on this endpoint.
    const fetchV13 = async (sourceType, sourceId, label) => {
      let lastRowKey = '';
      const before = allDevices.length;
      for (let page = 1; page <= 50; page++) {
        try {
          let path = `/v1.3/iot-03/devices?source_type=${sourceType}&source_id=${encodeURIComponent(sourceId)}&page_size=100`;
          if (lastRowKey) path += `&last_row_key=${encodeURIComponent(lastRowKey)}`;
          const res = await this._tuyaRequest(host, path, clientId, secret, token);
          if (!res.success) {
            if (page === 1) { errors.push(`${label}: ${res.msg || 'failed'}`); this.addLog('Cloud', `${label}: failed — code=${res.code} msg=${res.msg}`, 'warn'); }
            break;
          }
          const list = res.result?.list || [];
          if (!Array.isArray(list) || list.length === 0) { this.addLog('Cloud', `${label}: p${page} empty`, 'info'); break; }
          const cnt = allDevices.length;
          list.forEach(addDevice);
          const added = allDevices.length - cnt;
          this.addLog('Cloud', `${label}: p${page} → ${list.length} fetched, ${added} new (total ${allDevices.length})`, 'info');
          if (added === 0) break; // cursor not advancing
          lastRowKey = res.result?.last_row_key || '';
          if (!res.result?.has_more) break;
        } catch (e) {
          if (page === 1) { errors.push(`${label}: ${e.message}`); this.addLog('Cloud', `${label}: error — ${e.message}`, 'warn'); }
          break;
        }
      }
      return allDevices.length > before; // true if this call added anything
    };

    // Strategy 1: /v1.0/iot-01/associated-users/devices (tinytuya / tuya-homebridge approach).
    // Lists Smart Home linked users and their devices in one cursor-paginated endpoint.
    const linkedUids = [];
    try {
      let lastRowKey = '';
      for (let page = 1; page <= 20; page++) {
        let path = '/v1.0/iot-01/associated-users/devices?size=100';
        if (lastRowKey) path += `&last_row_key=${encodeURIComponent(lastRowKey)}`;
        const res = await this._tuyaRequest(host, path, clientId, secret, token);
        if (!res.success) {
          if (page === 1) { errors.push('assoc: ' + (res.msg || 'failed')); this.addLog('Cloud', `S1: iot-01/associated-users failed — code=${res.code} msg=${res.msg}`, 'warn'); }
          break;
        }
        const devs = res.result?.devices || res.result?.list || (Array.isArray(res.result) ? res.result : []);
        if (!Array.isArray(devs) || devs.length === 0) break;
        const cnt = allDevices.length;
        devs.forEach(addDevice);
        // Collect UIDs for later v1.3 queries
        devs.forEach((d) => { if (d.uid && !linkedUids.includes(d.uid)) linkedUids.push(d.uid); });
        const added = allDevices.length - cnt;
        this.addLog('Cloud', `S1: p${page} → ${devs.length} fetched, ${added} new (total ${allDevices.length})`, 'info');
        lastRowKey = res.result?.last_row_key || '';
        if (!res.result?.has_more) break;
      }
    } catch (e) { errors.push('assoc: ' + e.message); this.addLog('Cloud', `S1: error — ${e.message}`, 'warn'); }
    if (allDevices.length > 0) { this.addLog('Cloud', `S1 success: ${allDevices.length} device(s)`, 'info'); return allDevices; }
    this.addLog('Cloud', 'S1: no devices, trying S2', 'info');

    // Strategy 2: /v1.3/iot-03/devices with source_type=tuyaUser for all known UIDs.
    // v1.3 (not v1.0!) is required for source_type to work — v1.0 returns error 1109.
    // Try: projectUid (bay... or ay...) + any UIDs collected from S1.
    const uidsToTry = [...new Set([projectUid, ...linkedUids].filter(Boolean))];
    for (const uid of uidsToTry) {
      await fetchV13('tuyaUser', uid, `S2/uid=${uid.slice(0, 8)}`);
    }
    if (allDevices.length > 0) { this.addLog('Cloud', `S2 success: ${allDevices.length} device(s)`, 'info'); return allDevices; }
    this.addLog('Cloud', 'S2: no devices, trying S3', 'info');

    // Strategy 3: /v1.3/iot-03/devices with source_type=homeApp.
    // Lists ALL devices linked to the app schema across all users — no UID required.
    // Works when user logged into Smart Life ("smartlife") or Tuya Smart ("tuyaSmart").
    for (const schema of ['smartlife', 'tuyaSmart']) {
      await fetchV13('homeApp', schema, `S3/${schema}`);
    }
    if (allDevices.length > 0) { this.addLog('Cloud', `S3 success: ${allDevices.length} device(s)`, 'info'); return allDevices; }
    this.addLog('Cloud', 'S3: no devices, trying S4', 'info');

    // Legacy fallback: try /v1.0/users/{uid}/devices for each known UID
    for (const uid of uidsToTry) {
      try {
        const res = await this._tuyaRequest(host, `/v1.0/users/${uid}/devices`, clientId, secret, token);
        if (res.success) {
          const list = Array.isArray(res.result) ? res.result : (res.result?.list || []);
          this.addLog('Cloud', `S3 legacy: /users/${uid.slice(0,8)}/devices → ${list.length} device(s)`, 'info');
          list.forEach(addDevice);
        } else {
          this.addLog('Cloud', `S3 legacy: /users/${uid.slice(0,8)}/devices failed — code=${res.code} msg=${res.msg}`, 'warn');
        }
      } catch (_) {}
    }
    if (allDevices.length > 0) { this.addLog('Cloud', `S3 legacy success: ${allDevices.length} device(s)`, 'info'); return allDevices; }
    this.addLog('Cloud', 'S3 legacy: no devices, trying S4', 'info');

    // Strategy 4: /v1.0/devices (older API without iot-03 prefix)
    try {
      const res = await this._tuyaRequest(host,
        '/v1.0/devices?page_no=0&page_size=100&schema=tuyaSmart',
        clientId, secret, token);
      if (res.success) {
        const list = res.result?.list || res.result?.devices || res.result || [];
        if (Array.isArray(list)) { this.addLog('Cloud', `S4: /v1.0/devices → ${list.length} device(s)`, 'info'); list.forEach(addDevice); }
      } else {
        errors.push('schema: ' + (res.msg || 'failed'));
        this.addLog('Cloud', `S4: /v1.0/devices failed — code=${res.code} msg=${res.msg}`, 'warn');
      }
    } catch (e) { errors.push('schema: ' + e.message); this.addLog('Cloud', `S4: /v1.0/devices error — ${e.message}`, 'warn'); }
    if (allDevices.length > 0) { this.addLog('Cloud', `S4 success: ${allDevices.length} device(s)`, 'info'); return allDevices; }
    this.addLog('Cloud', 'S4: no devices, trying S5', 'info');

    // Strategy 5: v2.0 cloud/thing/device — supports both page_no and last_row_key cursor.
    // Primary termination: added===0 (dedup caught all — same page returned again).
    // Secondary: list.length < 20 (last page). Both are needed because the API may use
    // either pagination style depending on account type.
    {
      let lastRowKey = '';
      for (let page = 1; page <= 50; page++) {
        try {
          let path = `/v2.0/cloud/thing/device?page_size=20&page_no=${page}`;
          if (lastRowKey) path += `&last_row_key=${encodeURIComponent(lastRowKey)}`;
          const res = await this._tuyaRequest(host, path, clientId, secret, token);
          if (!res.success) {
            const msg = `code=${res.code} msg=${res.msg}`;
            if (page === 1) { errors.push('v2: ' + (res.msg || 'failed')); this.addLog('Cloud', `S5: p${page} failed — ${msg}`, 'warn'); }
            break;
          }
          const list = res.result?.list || (Array.isArray(res.result) ? res.result : []);
          if (!Array.isArray(list) || list.length === 0) { this.addLog('Cloud', `S5: p${page} empty`, 'info'); break; }
          const before = allDevices.length;
          list.forEach(addDevice);
          const added = allDevices.length - before;
          // Log cursor presence to help diagnose pagination style
          const cursor = res.result?.last_row_key || '';
          this.addLog('Cloud', `S5: p${page} → ${list.length} fetched, ${added} new (total ${allDevices.length})${cursor ? ' cursor✓' : ''}`, 'info');
          // Stop if no new unique devices — same page repeated, pagination not advancing
          if (added === 0) { this.addLog('Cloud', 'S5: no new devices — stopping', 'info'); break; }
          lastRowKey = cursor;
          const hasMore5 = res.result?.has_more === true;
          if (!hasMore5 && list.length < 20) break; // Last page
        } catch (e) {
          if (page === 1) { errors.push('v2: ' + e.message); this.addLog('Cloud', `S5: error — ${e.message}`, 'warn'); }
          break;
        }
      }
    }
    // S5 may return a capped subset — always continue to S6/S7 to collect additional devices.
    // Duplicates are caught by the seen Set inside addDevice.
    this.addLog('Cloud', `S5: ${allDevices.length} device(s) so far — continuing to S6/S7`, 'info');

    // Strategy 6: /v1.0/iot-03/devices without source_type — plain project device list.
    // Supports page_size up to 200; use has_more to detect further pages.
    for (let page = 1; page <= 50; page++) {
      try {
        const res = await this._tuyaRequest(host,
          `/v1.0/iot-03/devices?page_no=${page}&page_size=200`,
          clientId, secret, token);
        if (!res.success) {
          const msg = `code=${res.code} msg=${res.msg}`;
          if (page === 1) { errors.push('s6: ' + (res.msg || 'failed')); this.addLog('Cloud', `S6: p${page} failed — ${msg}`, 'warn'); }
          break;
        }
        const list = res.result?.list || res.result?.devices || (Array.isArray(res.result) ? res.result : []);
        if (!Array.isArray(list) || list.length === 0) { this.addLog('Cloud', `S6: p${page} empty`, 'info'); break; }
        const before = allDevices.length;
        list.forEach(addDevice);
        const added = allDevices.length - before;
        this.addLog('Cloud', `S6: p${page} → ${list.length} fetched, ${added} new (total ${allDevices.length})`, 'info');
        if (added === 0) { this.addLog('Cloud', 'S6: no new devices — stopping', 'info'); break; }
        const hasMore = res.result?.has_more === true;
        if (!hasMore || list.length < 200) break;
      } catch (e) {
        if (page === 1) { errors.push('s6: ' + e.message); this.addLog('Cloud', `S6: error — ${e.message}`, 'warn'); }
        break;
      }
    }
    this.addLog('Cloud', `S6: ${allDevices.length} device(s) so far — continuing to S7`, 'info');

    // Strategy 7: /v1.0/projects/{clientId}/devices — project-scoped list, page_size up to 1000.
    // clientId (Access ID) is the Tuya IoT project ID.
    for (let page = 1; page <= 20; page++) {
      try {
        const res = await this._tuyaRequest(host,
          `/v1.0/projects/${clientId}/devices?page_no=${page}&page_size=1000`,
          clientId, secret, token);
        if (!res.success) {
          const msg = `code=${res.code} msg=${res.msg}`;
          if (page === 1) { errors.push('s7: ' + (res.msg || 'failed')); this.addLog('Cloud', `S7: p${page} failed — ${msg}`, 'warn'); }
          break;
        }
        const list = res.result?.list || res.result?.devices || (Array.isArray(res.result) ? res.result : []);
        if (!Array.isArray(list) || list.length === 0) { this.addLog('Cloud', `S7: p${page} empty`, 'info'); break; }
        const before = allDevices.length;
        list.forEach(addDevice);
        const added = allDevices.length - before;
        this.addLog('Cloud', `S7: p${page} → ${list.length} fetched, ${added} new (total ${allDevices.length})`, 'info');
        if (added === 0) { this.addLog('Cloud', 'S7: no new devices — stopping', 'info'); break; }
        const hasMore = res.result?.has_more === true;
        if (!hasMore || list.length < 1000) break;
      } catch (e) {
        if (page === 1) { errors.push('s7: ' + e.message); this.addLog('Cloud', `S7: error — ${e.message}`, 'warn'); }
        break;
      }
    }
    if (allDevices.length > 0) { this.addLog('Cloud', `S7 success: ${allDevices.length} device(s)`, 'info'); return allDevices; }

    this.addLog('Cloud', `All strategies failed — ${errors.join('; ')}`, 'error');
    throw new Error('No devices found (' + errors.join('; ') + ')');
  }

  _tuyaRequestOnce(host, requestPath, clientId, secret, token) {
    return new Promise((resolve, reject) => {
      // Tuya requires query params sorted alphabetically in the signature
      let signPath = requestPath;
      const qIdx = requestPath.indexOf('?');
      if (qIdx !== -1) {
        const base   = requestPath.slice(0, qIdx);
        const params = requestPath.slice(qIdx + 1).split('&').sort().join('&');
        signPath = base + '?' + params;
      }

      const t           = Date.now().toString();
      const contentHash = crypto.createHash('sha256').update('').digest('hex');
      const stringToSign = 'GET\n' + contentHash + '\n\n' + signPath;
      const signStr = token
        ? clientId + token + t + stringToSign
        : clientId + t + stringToSign;
      const sign    = crypto.createHmac('sha256', secret)
        .update(signStr).digest('hex').toUpperCase();

      const headers = {
        'client_id':   clientId,
        'sign':        sign,
        'sign_method': 'HMAC-SHA256',
        't':           t,
      };
      if (token) headers['access_token'] = token;

      const req = https.get({ hostname: host, path: signPath, headers, timeout: 10000 }, (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          try { resolve(JSON.parse(body)); }
          catch (e) { reject(new Error('Invalid JSON response')); }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
    });
  }

  async _tuyaRequest(host, requestPath, clientId, secret, token) {
    // Retry up to 3 times on Tuya rate-limit (code 429 or code 1010).
    // Tuya enforces 10 req/s per client_id — rapid batch calls can exceed this.
    const RETRY_DELAYS = [1000, 2000, 3000];
    for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
      const res = await this._tuyaRequestOnce(host, requestPath, clientId, secret, token);
      const code = res.code ?? res.error_code;
      if (res.success || (code !== 429 && code !== 1010)) return res;
      if (attempt === RETRY_DELAYS.length) return res;
      await new Promise((r) => setTimeout(r, RETRY_DELAYS[attempt]));
    }
  }

  async onUninit() {
    clearTimeout(this._flushTimer);
    try { this.homey.settings.set('diagnostic_logs', this._logs); } catch (e) {}
  }
}

module.exports = TuyaLocalApp;
