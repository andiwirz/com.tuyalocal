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
   * @returns {{text: string, devices: Array}} The text block, plus the same facts
   *   per device in structured form so the settings page can prefill a GitHub
   *   issue from them instead of parsing them back out of the text.
   */
  async buildSupportBundle({ includeCloud = true, onlyDevice = null } = {}) {
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

    for (const driver of Object.values(this.homey.drivers.getDrivers())) {
      for (const device of driver.getDevices()) {
        let id = '';
        try { id = device.getData().id || ''; } catch (e) {}
        const settings = (() => { try { return device.getSettings() || {}; } catch (e) { return {}; } })();

        out.push('');
        out.push(`DEVICE  ${device.getName()}`);
        out.push(`  driver     ${driver.id}`);
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
        const wantCloud = cloudUsable && (!onlyDevice || device.getName() === onlyDevice);
        if (!wantCloud && cloudUsable && onlyDevice) {
          out.push('  cloud spec  skipped (only the reported device is looked up)');
          record.cloudSpec = '';
        }
        if (wantCloud && id) {
          try {
            const detail = await this.cloudDeviceDetail({ accessId, accessSecret, region, deviceId: id });
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

    // Fetch from multiple endpoints to get the most complete picture
    const [statusRes, specRes, propsRes] = await Promise.all([
      this._tuyaRequest(host, `/v1.0/iot-03/devices/${deviceId}/status`, accessId, accessSecret, token).catch(() => ({})),
      this._tuyaRequest(host, `/v1.0/iot-03/devices/${deviceId}/specification`, accessId, accessSecret, token).catch(() => ({})),
      this._tuyaRequest(host, `/v2.0/cloud/thing/${deviceId}/shadow/properties`, accessId, accessSecret, token).catch(() => ({})),
    ]);

    const status = statusRes.success ? (statusRes.result || []) : [];
    const spec   = specRes.success ? (specRes.result || {}) : {};
    const props  = propsRes.success ? (propsRes.result?.properties || []) : [];

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
      status: Object.values(dps),
      category: spec.category || '',
    };
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
