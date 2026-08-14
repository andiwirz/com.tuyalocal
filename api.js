'use strict';

// Every handler here also needs an entry under "api" in app.json, mapping this
// object's key to the method and URL path the settings page calls:
//   "cloudlookup": { "method": "GET", "path": "/cloud-lookup" }
// Homey routes only what is declared there. A handler added here alone is never
// reached — the settings page gets a bare "Cannot GET /api/app/<id>/<path>", which
// looks like a naming problem and is not one. The keys happen to be the hyphen-free
// spelling of their paths, but nothing derives one from the other.
module.exports = {
  async cloudlookup({ homey, query }) {
    const { accessId, accessSecret, region } = query;
    return homey.app.cloudLookup({ accessId, accessSecret, region });
  },
  async clouddevicedetail({ homey, query }) {
    const { accessId, accessSecret, region, deviceId } = query;
    return homey.app.cloudDeviceDetail({ accessId, accessSecret, region, deviceId });
  },
  // Fills the "…_values" pickers of devices that are already paired from the Tuya
  // specification. Writes value lists only — never DP numbers. See app.js.
  // Dry run unless dryRun=0, the same way round as every other check here. It used to
  // be the opposite — writing unless asked not to — which made a preview that forgot
  // the parameter apply its changes instead of showing them. Defaulting to the harmless
  // direction means a mistake in the settings page cannot save anything.
  async applycloudvalues({ homey, query }) {
    return homey.app.applyCloudValues({
      onlyDevice: query?.device || null,
      dryRun:     query?.dryRun !== '0',
    });
  },
  // Finds configured data points the device provably does not have. Defaults to a
  // dry run: only dryRun=0 actually switches them off.
  async findphantomdps({ homey, query }) {
    return homey.app.findPhantomDps({
      onlyDevice: query?.device || null,
      dryRun:     query?.dryRun !== '0',
    });
  },
  // Compares each stored local key against the Tuya account. Dry run by default;
  // the keys themselves are never returned, only a shortened form.
  async findstalekeys({ homey, query }) {
    return homey.app.findStaleKeys({
      onlyDevice: query?.device || null,
      dryRun:     query?.dryRun !== '0',
    });
  },
  // Devices working on a different protocol version than the one configured. Needs no
  // cloud credentials.
  async findprotocolmismatch({ homey, query }) {
    return homey.app.findProtocolMismatch({
      onlyDevice: query?.device || null,
      dryRun:     query?.dryRun !== '0',
    });
  },
  // Reads the divisor Tuya declares per data point and stores it. Dry run unless
  // dryRun=0, like the others.
  async findscalemismatch({ homey, query }) {
    return homey.app.findScaleMismatch({
      onlyDevice: query?.device || null,
      dryRun:     query?.dryRun !== '0',
    });
  },
  // The settings page has no access to devices or their settings — only the app
  // does — so the support bundle has to be assembled here and handed over whole.
  async diagnostics({ homey, query }) {
    const bundle = await homey.app.buildSupportBundle({
      includeCloud: query?.cloud !== '0',
      onlyDevice:   query?.device || null,
      // The cloud is queried one device after another, so on a dozen devices this
      // request takes several seconds. Pushed to the settings page as it goes, so
      // the page can count up instead of showing one frozen message.
      // Wrapped: a missing realtime channel must not cost the whole bundle.
      onProgress: (done, total, name) => {
        try { homey.api.realtime('bundle_progress', { done, total, name }); } catch (e) {}
      },
    });
    // Also write it to the app log, so that a Homey diagnostics report created
    // afterwards carries the whole bundle and the user only needs to send its id.
    homey.app.log('----- SUPPORT BUNDLE BEGIN -----');
    for (const line of bundle.text.split('\n')) homey.app.log(line);
    homey.app.log('----- SUPPORT BUNDLE END -----');
    return bundle;
  },
};
