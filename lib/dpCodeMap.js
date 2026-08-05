'use strict';

/**
 * Refines the local value-heuristic DP detection using the device's Tuya Cloud
 * specification (code names like "envhumid", "windspeed", "shake", "dry", "pump").
 *
 * The local pairing connection only ever sees raw DP numbers and values — no
 * semantic names — so drivers fall back to guessing from value shape (boolean
 * position, number ranges, known enum strings). That guessing breaks down for
 * devices whose enum DPs use plain numeric strings ("0"/"1") instead of
 * descriptive ones ("auto"/"low"), or whose boolean DPs happen to coincide in
 * value with an unrelated DP.
 *
 * The Cloud API's /specification and /status endpoints return the manufacturer's
 * own code name per DP (e.g. "envhumid" = current humidity, "windspeed" = fan
 * speed) — this is exactly the same data Cloud Lookup already fetches for the
 * settings page's "Raw Data" view. When available (i.e. the user has saved
 * Cloud Lookup credentials at least once in Settings), matching by code name is
 * far more reliable than guessing from value shape alone.
 *
 * This is best-effort and fully optional: if cloud credentials are not
 * available, or the lookup fails, callers simply keep the existing local
 * heuristic result untouched.
 */

function normalizeCode(code) {
  return String(code || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * @param {Array<{code:string, dp_id:number}>} specStatus  From cloudDeviceDetail().status
 * @param {Object<string,string[]>} codeAliasMap           settingKey -> accepted code aliases
 * @returns {Object<string,number>} settingKey -> dp number, only for codes that matched
 */
function detectFromCloudSpec(specStatus, codeAliasMap) {
  if (!Array.isArray(specStatus)) return {};

  const lookup = {};
  for (const [settingKey, aliases] of Object.entries(codeAliasMap)) {
    for (const alias of aliases) lookup[normalizeCode(alias)] = settingKey;
  }

  const result = {};
  for (const entry of specStatus) {
    if (!entry || !entry.dp_id) continue;
    const settingKey = lookup[normalizeCode(entry.code)];
    // First match wins — codeAliasMap order reflects priority for ambiguous devices.
    if (settingKey && result[settingKey] === undefined) {
      result[settingKey] = entry.dp_id;
    }
  }
  return result;
}

/**
 * Fetches the device's cloud DP specification and returns a settingKey -> dp
 * map using codeAliasMap. Returns {} (never throws) if cloud credentials are
 * not saved, the device isn't found in the cloud account, or the request fails
 * — callers should merge the result on top of their local heuristic detection.
 */
async function detectViaCloud(homey, deviceId, codeAliasMap, log) {
  try {
    const accessId     = homey.settings.get('cloud_access_id');
    const accessSecret  = homey.settings.get('cloud_access_secret');
    const region         = homey.settings.get('cloud_region');
    if (!accessId || !accessSecret || !region) return {};

    const detail  = await homey.app.cloudDeviceDetail({ accessId, accessSecret, region, deviceId });
    const cloudDps = detectFromCloudSpec(detail?.status, codeAliasMap);
    if (Object.keys(cloudDps).length > 0 && log) {
      log(`Cloud DP spec refined detection: ${JSON.stringify(cloudDps)}`);
    }
    return cloudDps;
  } catch (e) {
    if (log) log(`Cloud DP spec lookup skipped: ${e.message}`);
    return {};
  }
}

module.exports = { detectFromCloudSpec, detectViaCloud, normalizeCode };
