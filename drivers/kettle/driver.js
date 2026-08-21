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
// Verified against the standard code list for Tuya category "bh" (kettle).
const CLOUD_CODE_MAP = {
  // Some kettles expose the boil command as "start" rather than a plain switch.
  dp_onoff:        ['switch', 'start', 'switch_1', { code: 'power', type: 'Boolean' }],
  dp_mode:         ['mode', 'work_type', 'work_mode'],
  dp_target_temp:  ['temp_set'],
  dp_current_temp: ['temp_current'],
  dp_status:       ['status', 'work_state'],
  dp_keep_warm:    ['keep_warm', 'warm'],
  dp_fault:        ['fault'],
};

const CLOUD_ENUM_VALUES_MAP = {
  // Bitmap DP: the per-bit names live under "label", not "range" — asking for the
  // wrong one would write enum values in as bit names. See extractEnumValues.
  dp_fault:     { setting: 'fault_bits', from: 'label' },
  dp_mode: 'mode_values',
  dp_status: 'status_values',
};

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

  // Lets the settings page re-apply the manufacturer's declared value lists to a
  // device that is already paired — see applyCloudValues() in app.js. Exposed as a
  // method because these maps are module-local constants.
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
      if (localKey.length !== 16 && localKey.length !== 32)
        throw new Error(this.homey.__('pair.credentials.invalidKey'));

      let connected      = false;
      let failureError = '';
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
        failureError = err.message;
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
