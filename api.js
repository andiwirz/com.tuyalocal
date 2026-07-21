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
};
