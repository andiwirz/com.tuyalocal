'use strict';

// Homey resolves Homey.api() from settings pages by stripping the leading '/',
// removing hyphens, and lowercasing the URL path to produce the object key.
//   /cloud-lookup       → cloudlookup
//   /cloud-device-detail → clouddevicedetail
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
  async applycloudvalues({ homey, query }) {
    return homey.app.applyCloudValues({ onlyDevice: query?.device || null });
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
