'use strict';

const Homey                     = require('homey');
const TuyAPI                    = require('../../lib/SafeTuyAPI');
const { setupCloudLookup }      = require('../../lib/pairCloudLookup');
const { describeConnectFailure } = require('../../lib/connectFailure');
const { detectProtocolVersion } = require('../../lib/autoDetect');
const { scanNetwork }           = require('../../lib/networkScan');
const { detectViaCloud, guessedDefaults } = require('../../lib/dpCodeMap');

// This driver has no local value heuristic — every DP number below is a written-in
// guess matching the ZY-M100-WIFI mmWave sensor's layout. On a radar sensor from
// another family they can point at nothing at all, which is what CLOUD_CODE_MAP
// (by name) and the cloud specification (by absence) are used to correct.
const DEFAULT_DPS = {
  dp_presence:        1,
  dp_sensitivity:     2,
  dp_near_detection:  3,
  dp_far_detection:   4,
  dp_alarm:           6,
  dp_distance:        9,
  dp_detection_delay: 101,
  dp_fading_time:     102,
  dp_luminance:       104,
};

// Maps this driver's settings keys to the Tuya cloud "code" names that
// commonly represent them. See lib/dpCodeMap.js. This map overrides the
// DEFAULT_DPS layout above for models whose DP numbering differs.
const CLOUD_CODE_MAP = {
  dp_presence:       ['presence_state'],
  dp_sensitivity:    ['sensitivity'],
  dp_near_detection: ['near_detection'],
  dp_far_detection:  ['far_detection'],
  dp_alarm:          ['checking_result'],
  dp_distance:       ['target_dis_closest'],
  dp_detection_delay: ['detection_delay'],
  dp_fading_time:     ['fading_time'],
  dp_luminance:       ['illuminance'],
};

class PresenceSensorDriver extends Homey.Driver {
  async onInit() {
    this.log('Presence sensor driver initialized');

    // ── Conditions ─────────────────────────────────────────────────────────
    this.homey.flow.getConditionCard('presence_sensor_device_is_connected')
      .registerRunListener(async (args) => args.device._conn?.connected === true);

    this.homey.flow.getConditionCard('presence_sensor_presence_is_active')
      .registerRunListener(async (args) =>
        args.device.getCapabilityValue('alarm_motion') === true
      );

    // ── Actions ─────────────────────────────────────────────────────────────
    this.homey.flow.getActionCard('presence_sensor_force_reconnect')
      .registerRunListener(async (args) => args.device.forceReconnect());

    this.homey.flow.getActionCard('presence_sensor_refresh_device')
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
          // Replies to a DP_REFRESH request arrive on a separate event; some devices
          // report the packed voltage/current/power DP only that way.
          device.on('dp-refresh', (payload) => {
            if (payload?.dps) Object.assign(tmpDps, payload.dps);
          });
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
      } catch (err) {
        connected = false;
        failureError = err.message;
        try { if (pairingDevice) pairingDevice.disconnect(); } catch (_e) {}
        this.log('Connection test failed:', err.message);
      }

      // Best-effort: refine the ZY-M100-WIFI-shaped defaults using the device's
      // Tuya cloud specification — matters for other radar sensor models whose
      // DP layout differs. Never blocks pairing if unavailable or it fails.
      const cloudDps = await detectViaCloud(this.homey, deviceId, CLOUD_CODE_MAP, (m) => this.log(m),
        {}, guessedDefaults(DEFAULT_DPS, collectedDps));

      pendingDevice = this._buildPendingDevice({
        ip, deviceId, localKey, version: actualVersion, detectedDps: cloudDps,
      });
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
    session.setHandler('raw_dps', async () => pendingRawDps || {});
    session.setHandler('set_device_name', async (name) => {
      if (pendingDevice && name?.trim()) pendingDevice.name = name.trim();
    });
  }

  _buildPendingDevice({ ip, deviceId, localKey, version, detectedDps }) {
    return {
      name: this.homey.__('device.defaultName.presence_sensor'),
      data: { id: deviceId },
      settings: {
        ip,
        device_id:            deviceId,
        local_key:            localKey,
        version,
        polling_interval:     0,
        offline_grace_seconds: 60,
        // ZY-M100-WIFI layout, overridden below by detectedDps (Tuya cloud spec)
        // when available — remapped for other models, or set to 0 for the DPs the
        // specification shows this device does not have.
        ...DEFAULT_DPS,
        ...(detectedDps || {}),
      },
    };
  }

  async onPairListDevices() { return []; }
}

module.exports = PresenceSensorDriver;
