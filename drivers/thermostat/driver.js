'use strict';

const Homey                     = require('homey');
const TuyAPI                    = require('tuyapi');
const { setupCloudLookup } = require('../../lib/pairCloudLookup');
const { detectProtocolVersion } = require('../../lib/autoDetect');
const { scanNetwork }           = require('../../lib/networkScan');

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

  async onPair(session) {
    setupCloudLookup(session, this.homey);
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
          await Promise.race([
            device.connect(),
            new Promise((_, rej) => setTimeout(() => rej(new Error('Connection timed out')), 8000)),
          ]);
          await new Promise((resolve) => setTimeout(resolve, 2000));
          if (Object.keys(tmpDps).length === 0) {
            try { device.refresh(); } catch (_) {}
            await new Promise((resolve) => setTimeout(resolve, 2000));
          }
          device.disconnect();
          pairingDevice = null;
          rawDps = tmpDps;
        }
        Object.assign(collectedDps, rawDps);
        connected = true;
        if (Object.keys(collectedDps).length > 0) {
          detectedDps = this._detectDps(collectedDps);
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
      temp_divisor:    1,
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
        result.temp_divisor = 10;
      }
      result.dp_target_temp  = tempCandidates[0].dp;
      result.dp_current_temp = tempCandidates[1].dp;
    } else if (tempCandidates.length === 1) {
      // Single temp DP — assume it's current temperature
      const v = tempCandidates[0].val;
      if (v > 50 && v <= 600) result.temp_divisor = 10;
      result.dp_current_temp = tempCandidates[0].dp;
    }

    // Battery: numeric DP in 0–100 range, DP ≥ 14 (not temp or onoff)
    const batteryEntry = numDps.find((d) =>
      d.dp >= 14 && d.val >= 0 && d.val <= 100 &&
      d.dp !== result.dp_target_temp && d.dp !== result.dp_current_temp
    );
    if (batteryEntry) result.dp_battery = batteryEntry.dp;

    // Fault: DP 45 (BHT-002 pattern) or any DP with value 0 that looks like a bitfield
    const faultEntry = numDps.find((d) =>
      d.dp >= 40 && d.val === 0 &&
      d.dp !== result.dp_target_temp && d.dp !== result.dp_current_temp &&
      d.dp !== result.dp_battery
    );
    if (faultEntry) result.dp_fault = faultEntry.dp;

    return result;
  }

  async onPairListDevices() { return []; }
}

module.exports = ThermostatDriver;
