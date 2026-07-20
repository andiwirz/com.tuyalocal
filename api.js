'use strict';

module.exports = [
  {
    method: 'GET',
    path:   '/cloud-lookup',
    fn:     async ({ homey, query }) => {
      const { accessId, accessSecret, region } = query;
      return homey.app.cloudLookup({ accessId, accessSecret, region });
    },
  },
  {
    method: 'GET',
    path:   '/cloud-device-detail',
    fn:     async ({ homey, query }) => {
      const { accessId, accessSecret, region, deviceId } = query;
      return homey.app.cloudDeviceDetail({ accessId, accessSecret, region, deviceId });
    },
  },
];
