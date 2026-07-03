'use strict';

function setupCloudLookup(session, homey, driver) {
  session.setHandler('check_device_exists', async (deviceId) => {
    if (!driver || !deviceId) return false;
    const devices = driver.getDevices();
    return devices.some((d) => d.getData().id === deviceId);
  });

  session.setHandler('cloud_lookup_saved_creds', async () => {
    return {
      accessId:     homey.settings.get('cloud_access_id')     || '',
      accessSecret: homey.settings.get('cloud_access_secret') || '',
      region:       homey.settings.get('cloud_region')        || 'eu',
    };
  });

  session.setHandler('cloud_lookup', async ({ accessId, accessSecret, region }) => {
    if (!accessId || !accessSecret || !region) throw new Error('Missing credentials');
    return homey.app.cloudLookup({ accessId, accessSecret, region });
  });

  session.setHandler('cloud_save_creds', async ({ accessId, accessSecret, region }) => {
    homey.settings.set('cloud_access_id',     accessId     || '');
    homey.settings.set('cloud_access_secret', accessSecret || '');
    homey.settings.set('cloud_region',        region       || '');
  });
}

module.exports = { setupCloudLookup };
