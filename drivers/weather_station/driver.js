'use strict';

const Homey                     = require('homey');
const TuyAPI                    = require('../../lib/SafeTuyAPI');
const { setupCloudLookup }      = require('../../lib/pairCloudLookup');
const { describeConnectFailure } = require('../../lib/connectFailure');
const { detectProtocolVersion } = require('../../lib/autoDetect');
const { scanNetwork }           = require('../../lib/networkScan');
const { detectViaCloud, guessedDefaults } = require('../../lib/dpCodeMap');

// A weather station is nothing but a row of integers, and there is no local value
// heuristic here for exactly that reason: temperature, humidity, pressure, wind and
// rain are all whole numbers on adjacent data points, and telling them apart by
// value shape would be guessing between quantities that differ by nothing but their
// name. The layout below matches the WIFIWEST500WT; CLOUD_CODE_MAP corrects it by
// name for other models, and the specification switches off, by absence, what a
// device does not have.
//
// The reported station shows why this matters. Its owner first mapped it by hand
// and had data point 110 down as a UV index and 114 as a wind gust; the
// specification names them windspeed and rain_24h. That is how a rain total of
// 31 mm came to be displayed as a 91 km/h gust.
const DEFAULT_DPS = {
  dp_temp_extra:    0,   // "temp_current" — see the hint on the setting
  dp_temp_in:     101,
  dp_hum_in:      102,
  dp_temp_out:    103,
  dp_hum_out:     104,
  dp_pressure:    109,
  dp_wind:        110,
  dp_gust:        111,
  dp_wind_dir:    112,
  dp_rain_1h:     113,
  dp_rain_24h:    114,
  dp_comfort:     126,
  dp_rain_total:  134,
};

// Verified against the manufacturer's specification for the reported station.
// The "ch1" prefix is Tuya's channel numbering for the outdoor sensor; models with
// more than one outdoor probe repeat it as ch2temp and so on, which this driver
// does not try to cover.
const CLOUD_CODE_MAP = {
  dp_temp_extra:  ['temp_current'],
  dp_temp_in:     ['intemp', 'temp_indoor'],
  dp_hum_in:      ['inhum', 'humidity_indoor'],
  dp_temp_out:    ['ch1temp', 'temp_outdoor', 'outtemp'],
  dp_hum_out:     ['ch1hum', 'humidity_outdoor', 'outhum'],
  dp_pressure:    ['pressure', 'atmospheric_pressture', 'atmospheric_pressure'],
  dp_wind:        ['windspeed', 'windspeed_avg'],
  dp_gust:        ['gustwind', 'windspeed_gust'],
  dp_wind_dir:    ['wd', 'wind_direct'],
  dp_rain_1h:     ['rain_1h'],
  dp_rain_24h:    ['rain_24h'],
  dp_rain_total:  ['rain', 'rain_total'],
  dp_comfort:     ['com', 'comfort'],
};

// Both lists come from the device rather than from a fixed table: the compass has
// eight points on some stations and sixteen on others, and the angle each token
// stands for is derived from its position in the declared list, so neither count
// has to be written in here.
const CLOUD_ENUM_VALUES_MAP = {
  dp_wind_dir: 'wd_values',
  dp_comfort:  'comfort_values',
};

class WeatherStationDriver extends Homey.Driver {
  async onInit() {
    this.log('Weather station driver initialized');

    this.homey.flow.getDeviceTriggerCard('weather_station_comfort_changed')
      .registerRunListener(async () => true);

    this.homey.flow.getConditionCard('weather_station_device_is_connected')
      .registerRunListener(async (args) => args.device._conn?.connected === true);

    this.homey.flow.getConditionCard('weather_station_comfort_is')
      .registerArgumentAutocompleteListener('comfort', async (query, args) => {
        const values = (args.device.getSetting('comfort_values') || 'moist,dry,comfortable,na')
          .split(',').map((s) => s.trim()).filter(Boolean);
        const q = String(query || '').toLowerCase();
        return values.filter((v) => v.toLowerCase().includes(q))
          .map((v) => ({ id: v, name: v.charAt(0).toUpperCase() + v.slice(1).replace(/_/g, ' ') }));
      })
      .registerRunListener(async (args) =>
        args.device.getCapabilityValue('comfort_level') === args.comfort.id);

    this.homey.flow.getConditionCard('weather_station_wind_above')
      .registerRunListener(async (args) => {
        const wind = args.device.getCapabilityValue('measure_wind_strength');
        return typeof wind === 'number' && wind > Number(args.speed);
      });

    this.homey.flow.getConditionCard('weather_station_wind_from')
      .registerRunListener(async (args) => args.device.windIsFrom(args.sector));

    this.homey.flow.getActionCard('weather_station_force_reconnect')
      .registerRunListener(async (args) => args.device.forceReconnect());

    this.homey.flow.getActionCard('weather_station_refresh_device')
      .registerRunListener(async (args) => args.device.pollNow());
  }

  // Lets the settings page re-apply the manufacturer's declared token lists to a
  // device that is already paired — see applyCloudValues() in app.js.
  getCloudMaps() {
    return { codeMap: CLOUD_CODE_MAP, enumValuesMap: CLOUD_ENUM_VALUES_MAP };
  }

  async onPair(session) {
    setupCloudLookup(session, this.homey, this);
    let pendingDevice = null;
    let pendingRawDps = {};

    session.setHandler('scan_network', async () => scanNetwork(this.homey));

    session.setHandler('credentials', async (data) => {
      const { ip, deviceId, localKey, version } = data;

      const net = require('net');
      if (!net.isIPv4(ip)) throw new Error(this.homey.__('pair.credentials.invalidIp'));
      if (localKey.length !== 16 && localKey.length !== 32) {
        throw new Error(this.homey.__('pair.credentials.invalidKey'));
      }

      let connected     = false;
      let failureError = '';
      let actualVersion = String(version);
      const collectedDps = {};
      let pairingDevice  = null;

      try {
        let rawDps;
        if (version === 'auto') {
          const result = await detectProtocolVersion({ ip, deviceId, localKey });
          actualVersion = result.version;
          rawDps        = result.dps;
          this.log(`Auto-detected protocol version: ${actualVersion}`);
        } else {
          const device = new TuyAPI({
            id: deviceId, key: localKey, ip, version: actualVersion, issueGetOnConnect: true,
          });
          pairingDevice = device;
          device.on('error', (err) => { this.log('Connection test error:', err.message); });
          const tmpDps = {};
          device.on('data',       (p) => { if (p?.dps) Object.assign(tmpDps, p.dps); });
          device.on('dp-refresh', (p) => { if (p?.dps) Object.assign(tmpDps, p.dps); });
          await Promise.race([
            device.connect(),
            new Promise((_, rej) => setTimeout(() => rej(new Error('Connection timed out')), 8000)),
          ]);
          await new Promise((resolve) => setTimeout(resolve, 2000));
          try { device.refresh(); } catch (_) {}
          await new Promise((resolve) => setTimeout(resolve, 2000));
          device.disconnect();
          pairingDevice = null;
          rawDps = tmpDps;
        }
        Object.assign(collectedDps, rawDps);
        connected = true;
      } catch (err) {
        connected = false;
        failureError = err.message;
        try { if (pairingDevice) pairingDevice.disconnect(); } catch (_e) {}
        this.log('Connection test failed:', err.message);
      }

      const cloudDps = await detectViaCloud(this.homey, deviceId, CLOUD_CODE_MAP, (m) => this.log(m),
        CLOUD_ENUM_VALUES_MAP, guessedDefaults(DEFAULT_DPS, collectedDps));

      pendingDevice = {
        name: this.homey.__('device.defaultName.weather_station'),
        data: { id: deviceId },
        settings: {
          ip,
          device_id:             deviceId,
          local_key:             localKey,
          version:               actualVersion,
          // Weather changes slowly and these stations push by themselves; asking
          // every 30 s only adds traffic.
          polling_interval:      300,
          offline_grace_seconds: 60,
          ...DEFAULT_DPS,
          ...(cloudDps || {}),
        },
      };
      pendingRawDps = collectedDps;

      // The dialog used to say only "connection failed" — the same sentence
      // whether the address is wrong, the key is wrong, or the device does not
      // offer local control at all. So people work through the one visible
      // choice, the protocol version. Looking at port 6668 separates the cases.
      const failureHint = connected
        ? ''
        : await describeConnectFailure({ ip, error: failureError });
      if (failureHint) this.log(failureHint);

      return { connected, detectedVersion: actualVersion, failureHint };
    });

    session.setHandler('list_devices', async () => pendingDevice ? [pendingDevice] : []);
    session.setHandler('raw_dps',      async () => pendingRawDps || {});
    session.setHandler('set_device_name', async (name) => {
      if (pendingDevice && name?.trim()) pendingDevice.name = name.trim();
    });
  }

  async onPairListDevices() { return []; }
}

module.exports = WeatherStationDriver;
