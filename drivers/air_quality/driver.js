'use strict';

const Homey                     = require('homey');
const TuyAPI                    = require('../../lib/SafeTuyAPI');
const { setupCloudLookup }      = require('../../lib/pairCloudLookup');
const { describeConnectFailure } = require('../../lib/connectFailure');
const { detectProtocolVersion } = require('../../lib/autoDetect');
const { scanNetwork }           = require('../../lib/networkScan');
const { detectViaCloud, guessedDefaults } = require('../../lib/dpCodeMap');

// The hjjcy (air quality monitor) layout as Tuya documents it, and as the reported
// monitor confirms it. Every number is a written-in guess: a monitor from another
// family puts them elsewhere, which is what CLOUD_CODE_MAP (by name) and
// guessedDefaults (by absence) fix. A monitor that measures four of these ten
// things ends up with the other six switched off rather than six empty tiles.
const DEFAULT_DPS = {
  dp_aqi:         1,
  dp_temperature: 2,
  dp_humidity:    3,
  dp_co2:         4,
  dp_ch2o:        5,
  dp_pm25:        7,
  dp_pm1:         8,
  dp_pm10:        9,
  dp_battery:     22,
  dp_charging:    23,
  dp_volume:      28,
  dp_tvoc:        101,
  dp_co:          102,
  dp_backlight:   103,
  dp_co2_alarm:   104,
  dp_buzzer:      106,
  dp_pm03:        107,
  dp_co_alarm:    113,
  dp_pm25_alarm:  114,
};

const CLOUD_CODE_MAP = {
  dp_aqi:         ['air_quality_index', 'air_quality', 'airquality_value'],
  dp_temperature: ['temp_current', 'va_temperature', 'temp_indoor', 'temperature'],
  dp_humidity:    ['humidity_value', 'va_humidity', 'humidity_indoor', 'humidity'],
  dp_co2:         ['co2_value', 'co2'],
  dp_co:          ['co_value', 'co'],
  dp_ch2o:        ['ch2o_value', 'hcho_value', 'ch2o'],
  dp_pm25:        ['pm25_value', 'pm25'],
  dp_pm1:         ['pm1', 'pm1_value'],
  dp_pm10:        ['pm10', 'pm10_value'],
  dp_pm03:        ['pm03', 'pm03_value'],
  dp_tvoc:        ['tvoc_value', 'voc_value', 'tvoc'],
  dp_battery:     ['battery_percentage', 'battery_percent', 'residual_electricity'],
  dp_charging:    ['charge_state', 'charging_state', 'is_charging'],
  dp_volume:      ['alarm_volume', 'volume_set'],
  dp_backlight:   ['bl_level', 'backlight', 'bright_value'],
  dp_buzzer:      ['buzz', 'buzzer', 'alarm_switch'],
  dp_co2_alarm:   ['co2_alarm_value', 'co2_alarm'],
  dp_co_alarm:    ['co_alarm_value', 'co_alarm'],
  dp_pm25_alarm:  ['pm25_alarm_value', 'pm25_alarm'],
};

class AirQualityDriver extends Homey.Driver {
  async onInit() {
    this.log('Air quality driver initialized');

    // ── Conditions ─────────────────────────────────────────────────────────
    this.homey.flow.getConditionCard('air_quality_device_is_connected')
      .registerRunListener(async (args) => args.device._conn?.connected === true);

    this.homey.flow.getConditionCard('air_quality_pm03_above')
      .registerRunListener(async (args) => {
        const wert = args.device.getCapabilityValue('pm03_level');
        return typeof wert === 'number' && wert > Number(args.level);
      });

    // Die drei Bedienwerte sind von der App definiert — Homey erzeugt dafuer weder
    // eine Abfrage noch "wurde umgeschaltet".
    this.homey.flow.getConditionCard('air_quality_volume_is')
      .registerRunListener(async (args) =>
        args.device.getCapabilityValue('alarm_volume') === args.volume);

    this.homey.flow.getConditionCard('air_quality_backlight_is')
      .registerRunListener(async (args) =>
        args.device.getCapabilityValue('backlight_level') === args.level);

    this.homey.flow.getConditionCard('air_quality_buzzer_is_on')
      .registerRunListener(async (args) => args.device.getCapabilityValue('buzzer') === true);

    this.homey.flow.getDeviceTriggerCard('air_quality_buzzer_changed')
      .registerRunListener(async (args, state) => String(args.enabled) === String(state.enabled));

    // ── Actions ─────────────────────────────────────────────────────────────
    this.homey.flow.getActionCard('air_quality_set_volume')
      .registerRunListener(async (args) => args.device.setzeSchalter('alarm_volume', args.volume));

    this.homey.flow.getActionCard('air_quality_set_backlight')
      .registerRunListener(async (args) => args.device.setzeSchalter('backlight_level', args.level));

    this.homey.flow.getActionCard('air_quality_set_buzzer')
      .registerRunListener(async (args) => args.device.setzeSchalter('buzzer', args.state === 'on'));

    this.homey.flow.getActionCard('air_quality_force_reconnect')
      .registerRunListener(async (args) => args.device.forceReconnect());

    this.homey.flow.getActionCard('air_quality_refresh_device')
      .registerRunListener(async (args) => args.device.pollNow());
  }

  async onPair(session) {
    setupCloudLookup(session, this.homey, this);
    let pendingDevice = null;
    let pendingRawDps = {};

    session.setHandler('scan_network', async () => scanNetwork(this.homey));

    session.setHandler('credentials', async (data) => {
      const { ip, deviceId, localKey, version } = data;

      const net = require('net');
      if (!net.isIPv4(ip)) {
        throw new Error(this.homey.__('pair.credentials.invalidIp'));
      }
      if (localKey.length !== 16 && localKey.length !== 32) {
        throw new Error(this.homey.__('pair.credentials.invalidKey'));
      }

      let connected     = false;
      let failureError  = '';
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
            id: deviceId, key: localKey, ip,
            version: actualVersion,
            issueGetOnConnect: true,
          });
          pairingDevice = device;
          device.on('error', (err) => { this.log('Connection test error:', err.message); });
          const tmpDps = {};
          device.on('data', (payload) => {
            if (payload?.dps) Object.assign(tmpDps, payload.dps);
          });
          device.on('dp-refresh', (payload) => {
            if (payload?.dps) Object.assign(tmpDps, payload.dps);
          });
          const versuch = device.connect();
          versuch.catch(() => {});
          await Promise.race([
            versuch,
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

      const cloudDps = await detectViaCloud(this.homey, deviceId, CLOUD_CODE_MAP,
        (m) => this.log(m), {}, guessedDefaults(DEFAULT_DPS, collectedDps));

      pendingDevice = this._buildPendingDevice({
        ip, deviceId, localKey, version: actualVersion, detectedDps: cloudDps,
      });
      pendingRawDps = collectedDps;

      const failureHint = connected
        ? ''
        : await describeConnectFailure({ ip, error: failureError });
      if (failureHint) this.log(failureHint);

      return { connected, detectedVersion: actualVersion, failureHint };
    });

    session.setHandler('list_devices', async () => pendingDevice ? [pendingDevice] : []);
    session.setHandler('raw_dps', async () => pendingRawDps || {});
    session.setHandler('set_device_name', async (name) => {
      if (pendingDevice && name?.trim()) pendingDevice.name = name.trim();
    });
  }

  _buildPendingDevice({ ip, deviceId, localKey, version, detectedDps }) {
    return {
      name: this.homey.__('device.defaultName.air_quality'),
      data: { id: deviceId },
      settings: {
        ip,
        device_id:             deviceId,
        local_key:             localKey,
        version,
        // A monitor pushes a changed reading on its own, so the poll is only there
        // to notice a silent one. Sixty seconds is the compromise the other
        // mains-powered sensors use; a battery-backed monitor sitting on USB pays
        // nothing for it.
        polling_interval:      60,
        offline_grace_seconds: 60,
        ...DEFAULT_DPS,
        ...(detectedDps || {}),
      },
    };
  }

  async onPairListDevices() { return []; }
}

module.exports = AirQualityDriver;
