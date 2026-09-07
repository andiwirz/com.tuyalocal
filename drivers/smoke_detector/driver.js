'use strict';

const Homey                     = require('homey');
const TuyAPI                    = require('../../lib/SafeTuyAPI');
const { setupCloudLookup }      = require('../../lib/pairCloudLookup');
const { describeConnectFailure } = require('../../lib/connectFailure');
const { detectProtocolVersion } = require('../../lib/autoDetect');
const { scanNetwork }           = require('../../lib/networkScan');
const { detectViaCloud, guessedDefaults } = require('../../lib/dpCodeMap');

// The ywbj (smoke detector) layout as Tuya documents it. Every number here is a
// written-in guess: a detector from another family can put them elsewhere, which
// is what CLOUD_CODE_MAP (by name) and the cloud specification (by absence) fix.
//
// 14 and 15 are the pair to watch. The specification calls 14 the level and 15 the
// percentage; a reported implementation had them the other way round. The device
// side does not trust either — it reads the value and decides. These defaults only
// have to be plausible, not right.
const DEFAULT_DPS = {
  dp_smoke:           1,
  dp_self_test_start: 8,
  dp_self_test:       9,
  dp_battery_state:   14,
  dp_battery_percent: 15,
  dp_muffling:        16,
  dp_tamper:          0,
};

const CLOUD_CODE_MAP = {
  dp_smoke:           ['smoke_sensor_status', 'smoke_sensor_state', 'smoke_state'],
  dp_self_test_start: ['self_checking'],
  dp_self_test:       ['checking_result'],
  dp_battery_state:   ['battery_state'],
  dp_battery_percent: ['battery_percentage', 'battery_percent', 'residual_electricity'],
  dp_muffling:        ['muffling'],
  dp_tamper:          ['tamper_alarm', 'temper_alarm'],
};

class SmokeDetectorDriver extends Homey.Driver {
  async onInit() {
    this.log('Smoke detector driver initialized');

    // ── Conditions ─────────────────────────────────────────────────────────
    this.homey.flow.getConditionCard('smoke_device_is_connected')
      .registerRunListener(async (args) => args.device._conn?.connected === true);

    // ── Actions ─────────────────────────────────────────────────────────────
    this.homey.flow.getActionCard('smoke_silence_alarm')
      .registerRunListener(async (args) => args.device.silenceAlarm());

    this.homey.flow.getActionCard('smoke_self_test')
      .registerRunListener(async (args) => args.device.startSelfTest());

    this.homey.flow.getActionCard('smoke_force_reconnect')
      .registerRunListener(async (args) => args.device.forceReconnect());

    this.homey.flow.getActionCard('smoke_refresh_device')
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
      name: this.homey.__('device.defaultName.smoke_detector'),
      data: { id: deviceId },
      settings: {
        ip,
        device_id:            deviceId,
        local_key:            localKey,
        version,
        // Five minutes rather than the thirty seconds the mains-powered drivers use.
        // A detector pushes its alarm the moment it sounds; the poll only refreshes
        // the battery reading, and on a cell-powered device every request answered
        // is battery spent. The interval is the one a reported implementation
        // settled on after running it in a house for months.
        polling_interval:     300,
        offline_grace_seconds: 60,
        ...DEFAULT_DPS,
        ...(detectedDps || {}),
      },
    };
  }

  async onPairListDevices() { return []; }
}

module.exports = SmokeDetectorDriver;
