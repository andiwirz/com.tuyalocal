'use strict';

module.exports = {
  async cloudLookup({ homey, query }) {
    const { accessId, accessSecret, region } = query;
    return homey.app.cloudLookup({ accessId, accessSecret, region });
  },
  async cloudDeviceDetail({ homey, query }) {
    const { accessId, accessSecret, region, deviceId } = query;
    return homey.app.cloudDeviceDetail({ accessId, accessSecret, region, deviceId });
  },
};
