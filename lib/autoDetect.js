'use strict';

const TuyAPI = require('tuyapi');

// Ordered by real-world frequency (3.3 most common; 3.22 used by newer Tuya chips/gateways)
const VERSIONS_TO_TRY  = ['3.3', '3.4', '3.1', '3.5', '3.2', '3.22'];
const PER_VERSION_MS   = 6000; // max time to wait for connect + first response per version
const COLLECT_EXTRA_MS = 1500; // extra collection window after first DPS packet arrives
const REFRESH_DELAY_MS = 2000; // delay before sending dp_refresh if dp_query returned nothing

/**
 * Try each Tuya protocol version in order until one succeeds.
 *
 * @param {object}   opts
 * @param {string}   opts.ip         - device IP
 * @param {string}   opts.deviceId   - Tuya device ID
 * @param {string}   opts.localKey   - local key
 * @param {Function} [opts.onAttempt] - called with (version) before each attempt
 * @returns {Promise<{version: string, dps: object}>}
 * @throws  {Error} if no version succeeds
 */
async function detectProtocolVersion({ ip, deviceId, localKey, onAttempt } = {}) {
  for (const version of VERSIONS_TO_TRY) {
    if (typeof onAttempt === 'function') onAttempt(version);
    try {
      return await _tryVersion({ ip, deviceId, localKey, version });
    } catch (err) {
      // try next version
    }
  }
  throw new Error('No protocol version worked. Check IP, Device ID and Local Key.');
}

function _tryVersion({ ip, deviceId, localKey, version }) {
  return new Promise((resolve, reject) => {
    const dps     = {};
    let done      = false;
    let dataTimer = null;

    function finish(success) {
      if (done) return;
      done = true;
      clearTimeout(mainTimer);
      clearTimeout(dataTimer);
      try { device.removeAllListeners(); } catch (e) {}
      // After stripping listeners the socket is still open briefly.  Re-attach a
      // no-op error handler so any residual parse errors (e.g. HMAC mismatch on
      // in-flight packets) are absorbed instead of crashing the app.
      try { device.on('error', () => {}); } catch (e) {}
      try { device.disconnect();          } catch (e) {}
      if (success) resolve({ version, dps });
      else         reject(new Error(`Version ${version} failed`));
    }

    // Hard deadline — fall back to success only if we collected at least some DPS
    const mainTimer = setTimeout(
      () => finish(Object.keys(dps).length > 0),
      PER_VERSION_MS,
    );

    const device = new TuyAPI({
      id:                deviceId,
      key:               localKey,
      ip,
      version,
      issueGetOnConnect: true,
    });

    // Error / disconnect: succeed only if we already collected data
    device.on('error',       () => setTimeout(() => finish(Object.keys(dps).length > 0), 100));
    device.on('disconnected',() => setTimeout(() => finish(Object.keys(dps).length > 0), 100));

    const collect = (payload) => {
      if (payload?.dps) Object.assign(dps, payload.dps);
      // Give the device a little more time to push additional DPS before finishing
      if (!dataTimer) {
        dataTimer = setTimeout(() => finish(true), COLLECT_EXTRA_MS);
      }
    };

    device.on('data', collect);
    // Replies to a DP_REFRESH request arrive on their own event. Several devices
    // report the packed voltage/current/power DP only that way, so without this
    // the pairing snapshot would be missing it and auto-detection would conclude
    // the device has no power reporting at all.
    device.on('dp-refresh', collect);

    device.connect().then(() => {
      // Ask for a refresh unconditionally: devices that ignore dp_query respond to
      // it, and devices that answered dp_query may still hold back the refresh-only
      // DPs. The collected set is a union, so an extra request can only add.
      setTimeout(() => {
        if (!done) {
          try { device.refresh(); } catch (_) {}
        }
      }, REFRESH_DELAY_MS);
    }).catch(() => {
      setTimeout(() => finish(Object.keys(dps).length > 0), 100);
    });
  });
}

module.exports = { detectProtocolVersion, VERSIONS_TO_TRY };
