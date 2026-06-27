'use strict';

const Homey                     = require('homey');
const TuyAPI                    = require('tuyapi');
const { detectProtocolVersion } = require('../../lib/autoDetect');
const { scanNetwork }           = require('../../lib/networkScan');

class KettleDriver extends Homey.Driver {
  async onInit() {
    this.log('Kettle driver initialized');

    // ── Conditions ──────────────────────────────────────────────────────────
    this.homey.flow.getConditionCard('kettle_device_is_connected')
      .registerRunListener(async (args) => args.device._conn?.connected === true);

    this.homey.flow.getConditionCard('kettle_is_heating')
      .registerRunListener(async (args) => {
        const status = args.device.getCapabilityValue('kettle_status');
        return status === 'heating' || status === 'cooking';
      });

    // ── Actions ─────────────────────────────────────────────────────────────
    this.homey.flow.getActionCard('kettle_force_reconnect')
      .registerRunListener(async (args) => args.device.forceReconnect());

    this.homey.flow.getActionCard('kettle_refresh_device')
      .registerRunListener(async (args) => args.device.pollNow());

    this.homey.flow.getActionCard('kettle_set_target_temp')
      .registerRunListener(async (args) => {
        if (!args.device.hasCapability('target_temperature')) {
          throw new Error('Target temperature DP not configured');
        }
        await args.device.triggerCapabilityListener('target_temperature', args.temperature);
      });

    this.homey.flow.getActionCard('kettle_set_mode')
      .registerRunListener(async (args) => {
        if (!args.device.hasCapability('kettle_mode')) {
          throw new Error('Mode DP not configured');
        }
        await args.device.triggerCapabilityListener('kettle_mode', args.mode);
      });

    this.homey.flow.getActionCard('kettle_set_keep_warm')
      .registerRunListener(async (args) => {
        if (!args.device.hasCapability('kettle_keep_warm')) {
          throw new Error('Keep warm DP not configured');
        }
        await args.device.triggerCapabilityListener('kettle_keep_warm', args.state === 'on');
      });
  }

  async onPair(session) {
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
        name: this.homey.__('device.defaultName.kettle'),
        data: { id: deviceId },
        settings: {
          ip,
          device_id:        deviceId,
          local_key:        localKey,
          version:          actualVersion,
          polling_interval: 10,
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
      dp_current_temp: 0,
      dp_target_temp:  0,
      dp_keep_warm:    0,
      dp_status:       0,
      dp_mode:         0,
      dp_fault:        0,
    };

    const STATUS_VALUES = new Set([
      'standby', 'heating', 'cooling', 'warm', 'heating_temp',
      'boiling', 'boiling_temp', 'pause', 'done', 'cooking',
    ]);
    const MODE_PREFIXES = ['boiling', 'setting', 'temp_', 'mzj_'];

    const boolDps = [];
    const numDps  = [];
    const strDps  = [];

    for (const [dpStr, val] of Object.entries(dps)) {
      const dp = parseInt(dpStr, 10);
      if (typeof val === 'boolean')     boolDps.push({ dp, val });
      else if (typeof val === 'number') numDps.push({ dp, val });
      else if (typeof val === 'string') strDps.push({ dp, val });
    }

    // On/Off: first bool DP (usually DP 1)
    if (boolDps.length > 0) {
      result.dp_onoff = boolDps[0].dp;
      // Keep warm: second bool DP (usually DP 13)
      if (boolDps.length > 1) {
        result.dp_keep_warm = boolDps[1].dp;
      }
    }

    // Current temperature: number DP with value in plausible range (0–120 °C)
    const tempCandidates = numDps.filter((d) => d.val >= 0 && d.val <= 120);
    if (tempCandidates.length > 0) {
      result.dp_current_temp = tempCandidates[0].dp;
      // Target temp: second numeric DP in range
      if (tempCandidates.length > 1) {
        result.dp_target_temp = tempCandidates[1].dp;
      }
    }

    // Status: enum DP with known status values
    const statusEntry = strDps.find((d) => STATUS_VALUES.has(d.val.toLowerCase()));
    if (statusEntry) result.dp_status = statusEntry.dp;

    // Mode: enum DP with mode-like values (not status)
    const modeEntry = strDps.find((d) =>
      d.dp !== result.dp_status &&
      MODE_PREFIXES.some((p) => d.val.toLowerCase().startsWith(p))
    );
    if (modeEntry) result.dp_mode = modeEntry.dp;

    // Fault: DP 19 or any bitfield DP = 0
    const faultEntry = numDps.find((d) => d.dp === 19 && d.val === 0);
    if (faultEntry) result.dp_fault = 19;

    return result;
  }

  async onPairListDevices() { return []; }
}

module.exports = KettleDriver;
