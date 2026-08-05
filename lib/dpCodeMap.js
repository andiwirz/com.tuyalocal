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

  // code -> { settingKey, rank }. rank is the alias's position in its array, so
  // the order aliases are written in decides which one wins on a device that
  // exposes several of them — e.g. a humidifier reporting both "switch" and
  // "switch_spray" uses whichever is listed first, not whichever the device
  // happens to return first.
  const lookup = {};
  for (const [settingKey, aliases] of Object.entries(codeAliasMap)) {
    aliases.forEach((alias, rank) => {
      lookup[normalizeCode(alias)] = { settingKey, rank };
    });
  }

  const result = {};
  const chosen = {}; // settingKey -> rank of the alias that produced the value
  for (const entry of specStatus) {
    if (!entry || !entry.dp_id) continue;
    const hit = lookup[normalizeCode(entry.code)];
    if (!hit) continue;
    if (result[hit.settingKey] === undefined || hit.rank < chosen[hit.settingKey]) {
      result[hit.settingKey] = entry.dp_id;
      chosen[hit.settingKey] = hit.rank;
    }
  }
  return result;
}

/**
 * Given the raw cloud spec array and a resolved DP id, returns the CSV list of
 * enum tokens Tuya declares for that DP (e.g. "cold,wet,wind,hot"), or null if
 * it isn't an enum, wasn't found, or the values couldn't be parsed.
 *
 * This matters because the local value-heuristic can only ever see the DP's
 * *current* live value — it has no way to know the other tokens the enum
 * supports (e.g. a device whose current mode is "cold" gives no clue that
 * "wet"/"wind"/"hot" are also valid). The cloud specification declares the
 * full allowed range directly, so this is strictly more complete.
 */
function extractEnumValues(specStatus, dpId) {
  if (!Array.isArray(specStatus) || !dpId) return null;
  const entry = specStatus.find((e) => e && e.dp_id === dpId);
  if (!entry || !entry.values) return null;
  try {
    const parsed = typeof entry.values === 'string' ? JSON.parse(entry.values) : entry.values;
    const range   = parsed?.range;
    if (Array.isArray(range) && range.length > 0) return range.join(',');
  } catch (e) { /* not JSON / not an enum — ignore */ }
  return null;
}

/**
 * Fetches the device's cloud DP specification and returns a settingKey -> dp
 * map using codeAliasMap. Returns {} (never throws) if cloud credentials are
 * not saved, the device isn't found in the cloud account, or the request fails
 * — callers should merge the result on top of their local heuristic detection.
 *
 * @param {Object<string,string>} [enumValuesMap]  settingKey -> companion CSV
 *   settings key (e.g. { dp_mode: 'mode_values' }). When the settingKey is
 *   matched and its DP is an enum, the full declared token list is written to
 *   the companion setting — fixing devices whose enum uses non-standard
 *   tokens (e.g. "cold"/"wet"/"wind"/"hot" instead of "cool"/"dry"/"fan"/"heat").
 */
async function detectViaCloud(homey, deviceId, codeAliasMap, log, enumValuesMap = {}) {
  try {
    const accessId     = homey.settings.get('cloud_access_id');
    const accessSecret  = homey.settings.get('cloud_access_secret');
    const region         = homey.settings.get('cloud_region');
    if (!accessId || !accessSecret || !region) return {};

    const detail    = await homey.app.cloudDeviceDetail({ accessId, accessSecret, region, deviceId });
    const specStatus = detail?.status;
    const cloudDps   = detectFromCloudSpec(specStatus, codeAliasMap);

    for (const [settingKey, valuesKey] of Object.entries(enumValuesMap)) {
      const dpId = cloudDps[settingKey];
      if (!dpId) continue;
      const csv = extractEnumValues(specStatus, dpId);
      if (csv) cloudDps[valuesKey] = csv;
    }

    if (Object.keys(cloudDps).length > 0 && log) {
      log(`Cloud DP spec refined detection: ${JSON.stringify(cloudDps)}`);
    }
    return cloudDps;
  } catch (e) {
    if (log) log(`Cloud DP spec lookup skipped: ${e.message}`);
    return {};
  }
}

module.exports = { detectFromCloudSpec, extractEnumValues, detectViaCloud, normalizeCode };
