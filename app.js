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

  // ── Tuya Cloud API helpers ──────────────────────────────────────────────────

  async cloudLookup({ accessId, accessSecret, region }) {
    if (!accessId || !accessSecret || !region) throw new Error('Missing credentials');
    const host = TUYA_REGIONS[region];
    if (!host) throw new Error(`Unknown region: ${region}`);

    const { token, uid } = await this._tuyaGetToken(host, accessId, accessSecret);
    const devices = await this._tuyaGetDevices(host, accessId, accessSecret, token, uid);
    return devices;
  }

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
    // Step 1: v2.0 batch — best source for custom_name + product_name + local_key
    let batchWorked = false;
    for (let i = 0; i < allDevices.length; i += 20) {
      const batch = allDevices.slice(i, i + 20);
      const ids = batch.map((d) => d.id).join(',');
      try {
        const res = await this._tuyaRequest(host,
          `/v2.0/cloud/thing/batch?device_ids=${encodeURIComponent(ids)}`,
          clientId, secret, token);
        if (res.success && Array.isArray(res.result)) {
          batchWorked = true;
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

    // Step 2: v2.0 per-device endpoint for missing custom_name — most reliable source
    const missingCustomName = allDevices.filter((d) => !d.custom_name);
    for (const d of missingCustomName) {
      try {
        const res = await this._tuyaRequest(host,
          `/v2.0/cloud/thing/${d.id}`, clientId, secret, token);
        if (res.success && res.result) {
          const r = res.result;
          if (r.custom_name) d.custom_name = r.custom_name;
          if (!d.local_key && r.local_key) d.local_key = r.local_key;
          if (!d.product && r.product_name) d.product = r.product_name;
        }
      } catch (_) {}
    }

    // Step 3: v1.0 iot-03 per-device for remaining missing fields (local_key, product)
    const needsFallback = allDevices.filter((d) => !d.local_key || !d.product);
    for (const d of needsFallback) {
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
      // factory-infos fallback for local_key only
      if (!d.local_key) {
        try {
          const res = await this._tuyaRequest(host,
            `/v1.0/iot-03/devices/factory-infos?device_ids=${d.id}`,
            clientId, secret, token);
          if (res.success && res.result?.[0]?.local_key) d.local_key = res.result[0].local_key;
        } catch (_) {}
      }
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

    // Strategy 1: Get linked UIDs → devices per UID
    const uids = [];
    try {
      const uidRes = await this._tuyaRequest(host,
        '/v1.0/iot-03/devices/users?page_no=1&page_size=100',
        clientId, secret, token);
      if (uidRes.success) {
        for (const u of (uidRes.result?.list || [])) { if (u.uid) uids.push(u.uid); }
      } else {
        errors.push('users: ' + (uidRes.msg || 'failed'));
      }
    } catch (e) { errors.push('users: ' + e.message); }

    for (const uid of uids) {
      try {
        const res = await this._tuyaRequest(host,
          `/v1.0/users/${uid}/devices`, clientId, secret, token);
        if (res.success) (res.result || []).forEach(addDevice);
      } catch (_) {}
    }
    if (allDevices.length > 0) {
      await this._enrichDevices(host, clientId, secret, token, allDevices);
      return allDevices;
    }

    // Strategy 2: Use project UID from token
    if (projectUid) {
      try {
        const res = await this._tuyaRequest(host,
          `/v1.0/users/${projectUid}/devices`, clientId, secret, token);
        if (res.success) (res.result || []).forEach(addDevice);
        else errors.push('projectUid: ' + (res.msg || 'failed'));
      } catch (e) { errors.push('projectUid: ' + e.message); }
    }
    if (allDevices.length > 0) {
      await this._enrichDevices(host, clientId, secret, token, allDevices);
      return allDevices;
    }

    // Strategy 3: v1.0 with source_type
    for (const uid of [projectUid, ...uids]) {
      if (!uid) continue;
      try {
        const res = await this._tuyaRequest(host,
          `/v1.0/iot-03/devices?source_type=tuyaUser&source_id=${uid}&page_size=100`,
          clientId, secret, token);
        if (res.success) (res.result?.list || []).forEach(addDevice);
        else errors.push('source(' + uid.slice(0, 8) + '): ' + (res.msg || 'failed'));
      } catch (_) {}
      if (allDevices.length > 0) {
        await this._enrichDevices(host, clientId, secret, token, allDevices);
        return allDevices;
      }
    }

    // Strategy 4: /v1.0/devices (older API without iot-03 prefix)
    try {
      const res = await this._tuyaRequest(host,
        '/v1.0/devices?page_no=0&page_size=100&schema=tuyaSmart',
        clientId, secret, token);
      if (res.success) {
        const list = res.result?.list || res.result?.devices || res.result || [];
        if (Array.isArray(list)) list.forEach(addDevice);
      } else {
        errors.push('schema: ' + (res.msg || 'failed'));
      }
    } catch (e) { errors.push('schema: ' + e.message); }
    if (allDevices.length > 0) {
      await this._enrichDevices(host, clientId, secret, token, allDevices);
      return allDevices;
    }

    // Strategy 5: v2.0 cloud thing API (paginated, max 20 per page)
    for (let page = 1; page <= 50; page++) {
      try {
        const res = await this._tuyaRequest(host,
          `/v2.0/cloud/thing/device?page_size=20&page_no=${page}`,
          clientId, secret, token);
        if (!res.success) {
          if (page === 1) errors.push('v2: ' + (res.msg || 'failed'));
          break;
        }
        const list = res.result?.list || res.result || [];
        if (!Array.isArray(list) || list.length === 0) break;
        list.forEach(addDevice);
        if (list.length < 20) break;
      } catch (e) {
        if (page === 1) errors.push('v2: ' + e.message);
        break;
      }
    }
    if (allDevices.length > 0) {
      await this._enrichDevices(host, clientId, secret, token, allDevices);
      return allDevices;
    }

    throw new Error('No devices found (' + errors.join('; ') + ')');
  }

  _tuyaRequest(host, requestPath, clientId, secret, token) {
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

  async onUninit() {
    clearTimeout(this._flushTimer);
    try { this.homey.settings.set('diagnostic_logs', this._logs); } catch (e) {}
  }
}

module.exports = TuyaLocalApp;
