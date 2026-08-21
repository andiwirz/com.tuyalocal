'use strict';

const Homey                     = require('homey');
const TuyAPI                    = require('../../lib/SafeTuyAPI');
const { setupCloudLookup } = require('../../lib/pairCloudLookup');
const { detectProtocolVersion } = require('../../lib/autoDetect');
const { scanNetwork }           = require('../../lib/networkScan');
const { detectViaCloud, guessedDefaults }        = require('../../lib/dpCodeMap');

// Maps this driver's settings keys to the Tuya cloud "code" names that
// commonly represent them. See lib/dpCodeMap.js.
// Verified against the standard code list for Tuya category "wk" (thermostat).
const CLOUD_CODE_MAP = {
  dp_onoff:        ['switch', 'switch_1', { code: 'power', type: 'Boolean' }],
  dp_mode:         ['mode', 'work_mode'],
  dp_target_temp:  ['temp_set'],
  dp_current_temp: ['temp_current'],
  dp_child_lock:   ['child_lock', 'lock'],
  // Radiator valves report their open/closed state as valve_state.
  dp_hvac_action:  ['work_state', 'valve_state'],
  dp_battery:      ['battery_percentage', 'battery'],
  dp_fault:        ['fault'],
};

const CLOUD_ENUM_VALUES_MAP = {
  // Bitmap DP: the per-bit names live under "label", not "range" — asking for the
  // wrong one would write enum values in as bit names. See extractEnumValues.
  dp_fault:     { setting: 'fault_bits', from: 'label' },
  dp_mode: 'mode_values',
};

class ThermostatDriver extends Homey.Driver {
  async onInit() {
    this.log('Thermostat driver initialized');

    // ── Conditions ──────────────────────────────────────────────────────────
    this.homey.flow.getConditionCard('thermostat_device_is_connected')
      .registerRunListener(async (args) => args.device._conn?.connected === true);

    this.homey.flow.getConditionCard('thermostat_mode_is')
      .registerRunListener(async (args) => {
        return args.device.getCapabilityValue('thermostat_mode') === args.mode;
      });

    // ── Actions ─────────────────────────────────────────────────────────────
    this.homey.flow.getActionCard('thermostat_force_reconnect')
      .registerRunListener(async (args) => args.device.forceReconnect());

    this.homey.flow.getActionCard('thermostat_refresh_device')
      .registerRunListener(async (args) => args.device.pollNow());

    this.homey.flow.getActionCard('thermostat_set_mode')
      .registerRunListener(async (args) => {
        if (!args.device.hasCapability('thermostat_mode')) {
          throw new Error('Mode DP not configured');
        }
        await args.device.triggerCapabilityListener('thermostat_mode', args.mode);
      });

    this.homey.flow.getActionCard('thermostat_set_target_temp')
      .registerRunListener(async (args) => {
        await args.device.triggerCapabilityListener('target_temperature', args.temperature);
      });
  }

  // Lets the settings page re-apply the manufacturer's declared value lists to a
  // device that is already paired — see applyCloudValues() in app.js. Exposed as a
  // method because these maps are module-local constants.
  getCloudMaps() {
    return { codeMap: CLOUD_CODE_MAP, enumValuesMap: CLOUD_ENUM_VALUES_MAP };
  }

  // One divisor serves both temperatures here. If a device declares different scales for
  // the two, findScaleMismatch reports the conflict rather than picking a side.
  getScaleMaps() {
    return { dp_target_temp: { setting: 'temp_divisor', kind: 'divisor' }, dp_current_temp: { setting: 'temp_divisor', kind: 'divisor' } };
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

      let connected      = false;
      let detectedDps    = null;
      let actualVersion  = String(version);
      const collectedDps = {};
      let pairingDevice  = null;

      try {
        let rawDps;
        if (version === 'auto') {
          const result = await detectProtocolVersion({ ip, deviceId, localKey });
          actualVersion = result.version;
          rawDps        = result.dps;
        } else {
          const device = new TuyAPI({
            id: deviceId, key: localKey, ip,
            version: actualVersion,
            issueGetOnConnect: true,
          });
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
        try { if (pairingDevice) pairingDevice.disconnect(); } catch (_e) {}
      }

      pendingDevice = {
        name: this.homey.__('device.defaultName.thermostat'),
        data: { id: deviceId },
        settings: {
          ip,
          device_id:        deviceId,
          local_key:        localKey,
          version:          actualVersion,
          polling_interval: 30,
          ...(detectedDps || {}),
        },
      };
      pendingRawDps = collectedDps;
      return { connected, detectedVersion: actualVersion, detectedDps };
    });

    session.setHandler('list_devices',    async () => pendingDevice ? [pendingDevice] : []);
    session.setHandler('raw_dps',         async () => pendingRawDps || {});
    session.setHandler('set_device_name', async (name) => {
      if (pendingDevice && name?.trim()) pendingDevice.name = name.trim();
    });
  }

  _detectDps(dps) {
    const result = {
      dp_onoff:        0,
      dp_target_temp:  0,
      dp_current_temp: 0,
      dp_mode:         0,
      dp_child_lock:   0,
      dp_battery:      0,
      dp_fault:        0,
      // A string, not the number 1: this is a dropdown in app.json, and Homey rejects
      // the whole device with invalid_setting_type when the types disagree. Writing a
      // number here made every thermostat fail at the last step of pairing.
      temp_divisor:    '1',
    };

    const MODE_VALUES = new Set([
      'manual', 'auto', 'program', 'holiday', 'eco', 'comfort', 'away',
      'heat', 'cool', 'off', 'wind', 'dry', 'fan_only',
      'hot', 'colding', 'dehumidify', 'wet',
    ]);

    const boolDps = [];
    const numDps  = [];
    const strDps  = [];

    for (const [dpStr, val] of Object.entries(dps)) {
      const dp = parseInt(dpStr, 10);
      if (typeof val === 'boolean')     boolDps.push({ dp, val });
      else if (typeof val === 'number') numDps.push({ dp, val });
      else if (typeof val === 'string') strDps.push({ dp, val });
    }

    // On/Off: prefer DP 1 if it's boolean
    const onoffEntry = boolDps.find((d) => d.dp === 1) ?? boolDps[0];
    if (onoffEntry) result.dp_onoff = onoffEntry.dp;

    // Mode: enum DP with known thermostat mode values
    const modeEntry = strDps.find((d) => MODE_VALUES.has(d.val.toLowerCase()));
    if (modeEntry) result.dp_mode = modeEntry.dp;

    // Child lock: boolean DP that is NOT on/off (prefer DP 6, 7, 28)
    const CHILD_LOCK_PREFERRED = [6, 7, 28];
    const childEntry = boolDps.find((d) =>
      d.dp !== result.dp_onoff && CHILD_LOCK_PREFERRED.includes(d.dp)
    ) ?? boolDps.find((d) => d.dp !== result.dp_onoff && d.dp > 5);
    if (childEntry) result.dp_child_lock = childEntry.dp;

    // Temperature detection: find two numeric DPs that look like temperatures
    // Heuristic: values 50–600 are likely ×10 (5.0–60.0°C), values 0–50 are raw °C
    const tempCandidates = numDps
      .filter((d) => d.dp !== result.dp_onoff)
      .sort((a, b) => a.dp - b.dp);

    if (tempCandidates.length >= 2) {
      // Check for ×10 pattern: both values > 50 suggest ×10 encoding
      const maxVal = Math.max(...tempCandidates.slice(0, 2).map((d) => d.val));
      if (maxVal > 50 && maxVal <= 600) {
        result.temp_divisor = '10';
      }
      result.dp_target_temp  = tempCandidates[0].dp;
      result.dp_current_temp = tempCandidates[1].dp;
    } else if (tempCandidates.length === 1) {
      // Single temp DP — assume it's current temperature
      const v = tempCandidates[0].val;
      if (v > 50 && v <= 600) result.temp_divisor = '10';
      result.dp_current_temp = tempCandidates[0].dp;
    }

    // Battery and fault are deliberately not guessed from the values.
    //
    // The old rule for battery was "any numeric DP from 14 up whose value is 0–100".
    // On a thermostat that describes almost every configuration data point: an
    // XH-CTW offered six candidates — holiday days, holiday setpoint, temperature
    // zone, the low-temperature limit and both setpoint bounds — and the rule picked
    // the lowest, so the tile reported 1 % battery from a "holiday lasts 1 day"
    // setting. A percentage-shaped number says nothing about what it measures, and a
    // wrong battery reading is worse than none: it looks like a device about to die.
    //
    // The fault rule was the same shape, "any DP from 40 up whose value is 0", which
    // is every disabled option on the device.
    //
    // Both are named in CLOUD_CODE_MAP, so a device whose specification declares
    // battery_percentage or fault gets them set during pairing, and the Fix It tab can
    // fill them in afterwards. What stays here is the one layout that is documented
    // rather than inferred: the BHT-002 family reports its fault bitmap on DP 45.
    const faultEntry = numDps.find((d) => d.dp === 45 && d.val === 0);
    if (faultEntry) result.dp_fault = faultEntry.dp;

    return result;
  }

  async onPairListDevices() { return []; }
}

module.exports = ThermostatDriver;
