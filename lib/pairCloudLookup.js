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
    const devices = await homey.app.cloudLookup({ accessId, accessSecret, region });
    // Enrich local keys in batches of 20 (pairing flow uses WebSocket — more lenient timeout)
    for (let i = 0; i < devices.length; i += 20) {
      const batch = devices.slice(i, i + 20);
      const ids   = batch.map((d) => d.id).join(',');
      try {
        const enriched = await homey.app.cloudEnrich({ accessId, accessSecret, region, deviceIds: ids });
        for (const r of enriched) {
          const d = devices.find((x) => x.id === r.id);
          if (!d) continue;
          if (r.local_key) d.local_key = r.local_key;
          if (r.product)   d.product   = r.product;
        }
      } catch (_) {}
    }
    return devices;
  });

  session.setHandler('cloud_save_creds', async ({ accessId, accessSecret, region }) => {
    homey.settings.set('cloud_access_id',     accessId     || '');
    homey.settings.set('cloud_access_secret', accessSecret || '');
    homey.settings.set('cloud_region',        region       || '');
  });
}

module.exports = { setupCloudLookup };
