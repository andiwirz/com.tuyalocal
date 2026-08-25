'use strict';

const Homey                     = require('homey');
const TuyAPI                    = require('../../lib/SafeTuyAPI');
const { setupCloudLookup } = require('../../lib/pairCloudLookup');
const { describeConnectFailure } = require('../../lib/connectFailure');
const { detectProtocolVersion } = require('../../lib/autoDetect');
const { scanNetwork }           = require('../../lib/networkScan');
const { detectViaCloud, guessedDefaults }        = require('../../lib/dpCodeMap');

// Maps this driver's settings keys to the Tuya cloud "code" names that
// commonly represent them. See lib/dpCodeMap.js.
// Verified against the standard code list for Tuya category "jsq" (humidifier).
const CLOUD_CODE_MAP = {
  // switch_spray is the primary on/off on many humidifiers — listed after
  // "switch" so a device exposing both keeps the plain switch as the main power.
  dp_onoff:            ['switch', 'switch_spray', 'switch_1', { code: 'power', type: 'Boolean' }],
  dp_mode:             ['mode', 'work_mode', 'spray_mode'],
  dp_target_humidity:  ['humidity_set'],
  dp_current_humidity: ['humidity_current', 'humidity_indoor'],
  dp_fan_speed:        ['fan_speed_enum', 'level', 'level_current', 'windspeed', { code: 'fan_speed', type: 'Enum' }],
  dp_child_lock:       ['child_lock', 'lock'],
  dp_countdown_timer:  ['countdown_set', 'countdown'],
  dp_countdown_left:   ['countdown_left'],
  dp_temperature:      ['temp_current'],
  dp_water_empty:      ['lack_water', 'water_empty'],
  dp_anion:            ['anion'],
};

// When the cloud spec confirms a DP maps to one of these settings, the DP's
// full declared enum token list is written to the companion setting.
const CLOUD_ENUM_VALUES_MAP = {
  dp_mode:      'mode_values',
  dp_fan_speed: 'fan_speed_values',
};

class HumidifierDriver extends Homey.Driver {
  async onInit() {
    this.log('Humidifier driver initialized');

    this.homey.flow.getDeviceTriggerCard('humidifier_humidity_above')
      .registerRunListener(async (args, state) =>
        state.prevHumidity <= args.humidity && state.humidity > args.humidity
      );
    this.homey.flow.getDeviceTriggerCard('humidifier_humidity_below')
      .registerRunListener(async (args, state) =>
        state.prevHumidity >= args.humidity && state.humidity < args.humidity
      );

    this.homey.flow.getConditionCard('humidifier_device_is_connected')
      .registerRunListener(async (args) => args.device._conn?.connected === true);

    this.homey.flow.getConditionCard('humidifier_humidity_is_above')
      .registerRunListener(async (args) =>
        args.device.getCapabilityValue('measure_humidity') > args.humidity
      );
    this.homey.flow.getConditionCard('humidifier_humidity_is_below')
      .registerRunListener(async (args) =>
        args.device.getCapabilityValue('measure_humidity') < args.humidity
      );
    this.homey.flow.getConditionCard('humidifier_water_is_empty')
      .registerRunListener(async (args) =>
        args.device.getCapabilityValue('alarm_water') === true
      );

    this.homey.flow.getActionCard('humidifier_set_target_humidity')
      .registerRunListener(async (args) => {
        await args.device.setCapabilityValue('target_humidity', args.humidity);
        return args.device.triggerCapabilityListener('target_humidity', args.humidity);
      });
    const cap = (v) => v.charAt(0).toUpperCase() + v.slice(1).replace(/_/g, ' ');
    const modeAC = async (query, args) => {
      const values = (args.device.getSetting('mode_values') || 'auto,manual,normal,sleep,eco,boost')
        .split(',').map((s) => s.trim()).filter(Boolean);
      const q = query.toLowerCase();
      return values.filter((v) => v.toLowerCase().includes(q)).map((v) => ({ id: v, name: cap(v) }));
    };
    const fanAC = async (query, args) => {
      const values = (args.device.getSetting('fan_speed_values') || 'low,medium,high,auto')
        .split(',').map((s) => s.trim()).filter(Boolean);
      const q = query.toLowerCase();
      return values.filter((v) => v.toLowerCase().includes(q)).map((v) => ({ id: v, name: cap(v) }));
    };

    this.homey.flow.getActionCard('humidifier_set_mode')
      .registerArgumentAutocompleteListener('mode', modeAC)
      .registerRunListener(async (args) => {
        await args.device.setCapabilityValue('mode', args.mode.id);
        return args.device.triggerCapabilityListener('mode', args.mode.id);
      });
    this.homey.flow.getActionCard('humidifier_set_fan_speed')
      .registerArgumentAutocompleteListener('fan_speed', fanAC)
      .registerRunListener(async (args) => {
        await args.device.setCapabilityValue('fan_speed', args.fan_speed.id);
        return args.device.triggerCapabilityListener('fan_speed', args.fan_speed.id);
      });
    // Diese Capabilities sind von der App definiert, und dafuer erzeugt Homey
    // keine Karten - ohne die hier gab es das Bedienelement nur auf der Kachel.
    this.homey.flow.getActionCard('humidifier_set_anion')
      .registerRunListener(async (args) => {
        if (!args.device.hasCapability('anion')) return;
        const enabled = args.enabled === 'true';
        await args.device.setCapabilityValue('anion', enabled);
        return args.device.triggerCapabilityListener('anion', enabled);
      });

    this.homey.flow.getActionCard('humidifier_set_child_lock')
      .registerRunListener(async (args) => {
        if (!args.device.hasCapability('child_lock')) return;
        const enabled = args.enabled === 'true';
        await args.device.setCapabilityValue('child_lock', enabled);
        return args.device.triggerCapabilityListener('child_lock', enabled);
      });

    this.homey.flow.getActionCard('humidifier_set_timer')
      .registerRunListener(async (args) => {
        if (!args.device.hasCapability('countdown_timer')) return;
        await args.device.setCapabilityValue('countdown_timer', args.timer);
        return args.device.triggerCapabilityListener('countdown_timer', args.timer);
      });

    // child_lock und oscillate sind von der App definiert - Homey erzeugt
    // dafuer weder "wurde umgeschaltet" noch eine Abfrage.
    this.homey.flow.getDeviceTriggerCard('humidifier_child_lock_changed')
      .registerRunListener(async (args, state) =>
        String(args.enabled) === String(state.enabled));

    this.homey.flow.getConditionCard('humidifier_child_lock_is_on')
      .registerRunListener(async (args) =>
        args.device.getCapabilityValue('child_lock') === true);

    this.homey.flow.getActionCard('humidifier_force_reconnect')
      .registerRunListener(async (args) => args.device.forceReconnect());
    this.homey.flow.getActionCard('humidifier_refresh_device')
      .registerRunListener(async (args) => args.device.pollNow());
  }

  // Lets the settings page re-apply the manufacturer's declared value lists to a
  // device that is already paired — see applyCloudValues() in app.js. Exposed as a
  // method because these maps are module-local constants.
  getCloudMaps() {
    return { codeMap: CLOUD_CODE_MAP, enumValuesMap: CLOUD_ENUM_VALUES_MAP };
  }

  // Temperature is the only scaled reading on this driver.
  getScaleMaps() {
    return { dp_temperature: { setting: 'temp_divisor', kind: 'divisor' } };
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
      if (localKey.length !== 16 && localKey.length !== 32)
        throw new Error(this.homey.__('pair.credentials.invalidKey'));

      let connected     = false;
      let failureError = '';
      let detectedDps   = null;
      let actualVersion = String(version);
      const collectedDps = {};
      let pairingDevice = null;
      try {
        let rawDps;
        if (version === 'auto') {
          const result = await detectProtocolVersion({ ip, deviceId, localKey });
          actualVersion = result.version;
          rawDps        = result.dps;
        } else {
          const device = new TuyAPI({ id: deviceId, key: localKey, ip, version: actualVersion, issueGetOnConnect: true });
          pairingDevice = device;
          device.on('error', () => {});
          const tmpDps = {};
          device.on('data', (payload) => { if (payload?.dps) Object.assign(tmpDps, payload.dps); });
          // Replies to a DP_REFRESH request arrive on a separate event; some devices
          // report the packed voltage/current/power DP only that way.
          device.on('dp-refresh', (payload) => { if (payload?.dps) Object.assign(tmpDps, payload.dps); });
          await Promise.race([
            device.connect(),
            new Promise((_, rej) => setTimeout(() => rej(new Error('Connection timed out')), 8000)),
          ]);
          await new Promise((resolve) => setTimeout(resolve, 2000));
          // Always ask for a refresh, not just when nothing arrived: devices that do
          // answer dp_query may still withhold the refresh-only DPs, which is where
          // packed voltage/current/power values usually live.
          try { device.refresh(); } catch (_) {}
          await new Promise((resolve) => setTimeout(resolve, 2000));
          device.disconnect();
          pairingDevice = null;
          rawDps = tmpDps;
        }
        Object.assign(collectedDps, rawDps);
        connected = true;
        if (Object.keys(collectedDps).length > 0) {
          detectedDps = this._detectDps(collectedDps);
          const cloudDps = await detectViaCloud(this.homey, deviceId, CLOUD_CODE_MAP, (m) => this.log(m), CLOUD_ENUM_VALUES_MAP, guessedDefaults(detectedDps, collectedDps));
          if (Object.keys(cloudDps).length > 0) Object.assign(detectedDps, cloudDps);
        }
      } catch (err) {
        connected = false;
        failureError = err.message;
        try { if (pairingDevice) pairingDevice.disconnect(); } catch (_e) {}
        this.log('Connection test failed:', err.message);
      }

      pendingDevice = {
        name: this.homey.__('device.defaultName.humidifier'),
        data: { id: deviceId },
        settings: {
          ip, device_id: deviceId, local_key: localKey, version: actualVersion,
          ...(detectedDps || {}),
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

      return { connected, detectedVersion: actualVersion, detectedDps, failureHint };
    });

    session.setHandler('list_devices',    async () => pendingDevice ? [pendingDevice] : []);
    session.setHandler('raw_dps',         async () => pendingRawDps || {});
    session.setHandler('set_device_name', async (name) => {
      if (pendingDevice && name?.trim()) pendingDevice.name = name.trim();
    });
  }

  _detectDps(dps) {
    const boolDps = [];
    const humDps  = [];
    const tempDps = [];
    const enumDps = [];

    for (const [dp, val] of Object.entries(dps)) {
      const num = parseInt(dp, 10);
      if (typeof val === 'boolean')                              boolDps.push({ dp: num, val });
      else if (typeof val === 'number' && val >= 0 && val <= 100) humDps.push({ dp: num, val });
      else if (typeof val === 'number' && val > 100 && val <= 600) tempDps.push({ dp: num, val });
      else if (typeof val === 'string')                          enumDps.push({ dp: num, val });
    }

    const dp_onoff = (boolDps.find((d) => d.dp === 1) || boolDps.find((d) => d.val === true) || boolDps[0])?.dp ?? 1;

    humDps.sort((a, b) => a.dp - b.dp);
    const targetEntry = humDps.find((d) => d.val % 5 === 0 && d.val >= 25 && d.val <= 80) || humDps.find((d) => d.val % 5 === 0) || humDps[0];
    const dp_target_humidity = targetEntry?.dp ?? 13;
    const currentEntry = humDps.find((d) => d.dp !== dp_target_humidity && d.val >= 20 && d.val <= 100) || humDps.find((d) => d.dp !== dp_target_humidity);
    const dp_current_humidity = currentEntry?.dp ?? 14;

    const KNOWN_MODES = ['auto', 'manual', 'normal', 'sleep', 'eco', 'boost', 'low', 'middle', 'high'];
    const modeEntry = enumDps.find((d) => KNOWN_MODES.includes(String(d.val).toLowerCase()));
    const dp_mode   = modeEntry?.dp ?? 24;

    const KNOWN_FAN   = ['low', 'high', 'medium', 'auto', 'turbo'];
    const fanEntry    = enumDps.find((d) => KNOWN_FAN.includes(String(d.val).toLowerCase()));
    const dp_fan_speed = fanEntry?.dp ?? 0;

    const timerEntry = enumDps.find((d) => String(d.val) === 'cancel' || /^\d+h$/.test(String(d.val)));
    const dp_countdown_timer = timerEntry?.dp ?? 0;

    const usedDps = new Set([dp_onoff, dp_target_humidity, dp_current_humidity, dp_mode, dp_fan_speed, dp_countdown_timer]);
    const tempEntry = tempDps.filter((d) => !usedDps.has(d.dp))[0];
    const dp_temperature = tempEntry?.dp ?? 0;

    return {
      dp_onoff, dp_mode, dp_current_humidity, dp_target_humidity,
      dp_fan_speed, dp_countdown_timer, dp_countdown_left: 0,
      dp_child_lock: 0, dp_water_empty: 0, dp_temperature, dp_anion: 0,
      mode_values:      'auto,manual,normal,sleep,eco,boost',
      fan_speed_values: 'low,medium,middle,high,auto',
    };
  }

  async onPairListDevices() { return []; }
}

module.exports = HumidifierDriver;
