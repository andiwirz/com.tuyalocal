'use strict';

const Homey                     = require('homey');
const TuyAPI                    = require('../../lib/SafeTuyAPI');
const { setupCloudLookup }      = require('../../lib/pairCloudLookup');
const { describeConnectFailure } = require('../../lib/connectFailure');
const { detectProtocolVersion } = require('../../lib/autoDetect');
const { scanNetwork }           = require('../../lib/networkScan');
const { detectViaCloud, guessedDefaults } = require('../../lib/dpCodeMap');

// Maps this driver's settings keys to the Tuya cloud "code" names that
// commonly represent them. See lib/dpCodeMap.js. The hardcoded defaults in
// _buildPendingDevice() match a common smart-doorbell DP layout — this map
// overrides them for other camera/doorbell models with a different one.
// dp_alarm_message is intentionally excluded — it's a fallback ring source
// only used when dp_doorbell is disabled (see device.js), not something we
// want cloud detection to enable by default.
//
// The second alias on several keys covers wireless chimes / plug-in receivers,
// whose DPs start at 1 and share no numbering with the camera layout above. Without
// them such a unit pairs with every DP pointing at nothing and stays silent.
const CLOUD_CODE_MAP = {
  dp_doorbell:           ['doorbell_active', 'doorbell_call'],
  dp_motion_event:       ['movement_detect_pic'],
  dp_motion_switch:      ['motion_switch'],
  dp_motion_sensitivity: ['motion_sensitivity'],
  dp_nightvision:        ['basic_nightvision'],
  dp_indicator:          ['basic_indicator'],
  dp_recording:          ['record_switch'],
  dp_chime_volume:       ['chime_ring_volume', 'doorbell_volume_value'],
  dp_device_volume:      ['basic_device_volume'],
  dp_night_light:        ['switch_night_light'],
  dp_ring_tone:          ['doorbell_ring_value'],
  // On chimes this switch decides whether the unit reports anything at all. One
  // was shipped with it off: the bell rang, nothing reached the network, and the
  // ring trigger could not fire however the DPs were configured.
  dp_alarm_push:         ['alarm_propel_switch'],
};

// Fallback DP numbers for a camera doorbell, used when nothing better is known.
// Also handed to detectViaCloud so that the ones this particular device provably
// does not have are switched off instead of left pointing at nothing.
const DEFAULT_DPS = {
  dp_doorbell:           136,
  dp_motion_event:       115,
  dp_alarm_message:      0,
  dp_motion_switch:      134,
  dp_motion_sensitivity: 106,
  dp_nightvision:        108,
  dp_indicator:          101,
  dp_recording:          150,
  dp_chime_volume:       157,
  dp_device_volume:      160,
  // Chime-only DPs — off by default so a camera doorbell is unaffected. Cloud code
  // names fill them in for the units that have them.
  dp_night_light:        0,
  dp_ring_tone:          0,
  dp_alarm_push:         0,
};

class DoorbellDriver extends Homey.Driver {
  async onInit() {
    this.log('Doorbell driver initialized');

    // ── Conditions ─────────────────────────────────────────────────────────
    this.homey.flow.getConditionCard('doorbell_device_is_connected')
      .registerRunListener(async (args) => args.device._conn?.connected === true);

    this.homey.flow.getConditionCard('doorbell_motion_is_active')
      .registerRunListener(async (args) =>
        args.device.getCapabilityValue('alarm_motion') === true
      );

    // ── Actions ─────────────────────────────────────────────────────────────
    this.homey.flow.getActionCard('doorbell_enable_motion')
      .registerRunListener(async (args) => {
        const dp = args.device.getSetting('dp_motion_switch');
        if (!dp) throw new Error('Motion switch DP is set to 0 (disabled) in device settings');
        await args.device._set(dp, true);
      });

    this.homey.flow.getActionCard('doorbell_disable_motion')
      .registerRunListener(async (args) => {
        const dp = args.device.getSetting('dp_motion_switch');
        if (!dp) throw new Error('Motion switch DP is set to 0 (disabled) in device settings');
        await args.device._set(dp, false);
      });

    this.homey.flow.getActionCard('doorbell_force_reconnect')
      .registerRunListener(async (args) => args.device.forceReconnect());

    this.homey.flow.getActionCard('doorbell_refresh_device')
      .registerRunListener(async (args) => args.device.pollNow());

    this.homey.flow.getActionCard('doorbell_set_nightvision')
      .registerRunListener(async (args) => {
        const dp = args.device.getSetting('dp_nightvision');
        if (!dp) throw new Error('Night vision DP is set to 0 (disabled) in device settings');
        await args.device._set(dp, args.mode);
      });

    this.homey.flow.getActionCard('doorbell_set_chime_volume')
      .registerRunListener(async (args) => {
        const dp = args.device.getSetting('dp_chime_volume');
        if (!dp) throw new Error('Chime volume DP is set to 0 (disabled) in device settings');
        await args.device._set(dp, Math.round(args.volume));
      });

    this.homey.flow.getActionCard('doorbell_set_motion_sensitivity')
      .registerRunListener(async (args) => {
        const dp = args.device.getSetting('dp_motion_sensitivity');
        if (!dp) throw new Error('Motion sensitivity DP is set to 0 (disabled) in device settings');
        await args.device._set(dp, args.sensitivity);
      });

    // Night light and ring tone exist on wireless chimes. The night light also has
    // a tile (onoff.light), but Homey generates no flow cards for sub-capabilities,
    // so both the action and the condition have to be declared explicitly.
    this.homey.flow.getActionCard('doorbell_set_night_light')
      .registerRunListener(async (args) => {
        const dp = args.device.getSetting('dp_night_light');
        if (!dp) throw new Error('Night light DP is set to 0 (disabled) in device settings');
        const on = args.state === 'true';
        await args.device._set(dp, on);
        if (args.device.hasCapability('onoff.light')) {
          await args.device.setCapabilityValue('onoff.light', on).catch(() => {});
        }
      });

    this.homey.flow.getConditionCard('doorbell_night_light_is_on')
      .registerRunListener(async (args) => args.device.getCapabilityValue('onoff.light') === true);

    this.homey.flow.getActionCard('doorbell_set_alarm_push')
      .registerRunListener(async (args) => {
        const dp = args.device.getSetting('dp_alarm_push');
        if (!dp) throw new Error('Alarm Push DP is set to 0 (disabled) in device settings');
        await args.device._set(dp, args.state === 'true');
      });

    this.homey.flow.getActionCard('doorbell_set_ring_tone')
      .registerRunListener(async (args) => {
        const dp = args.device.getSetting('dp_ring_tone');
        if (!dp) throw new Error('Ring tone DP is set to 0 (disabled) in device settings');
        await args.device._set(dp, Math.round(args.tone));
      });
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

      // Best-effort: refine the hardcoded defaults using the device's Tuya
      // cloud specification — matters for camera/doorbell models whose DP
      // layout differs. Never blocks pairing if unavailable or it fails.
      const cloudDps = await detectViaCloud(this.homey, deviceId, CLOUD_CODE_MAP, (m) => this.log(m), {}, guessedDefaults(DEFAULT_DPS, collectedDps));

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
      name: this.homey.__('device.defaultName.doorbell'),
      data: { id: deviceId },
      settings: {
        ip,
        device_id:            deviceId,
        local_key:            localKey,
        version,
        polling_interval:     0,
        offline_grace_seconds: 60,
        // Camera-doorbell defaults, overridden by detectedDps (Tuya cloud spec)
        // where available — both for models with a different layout and for chimes,
        // where the spec also switches off the defaults the device does not have.
        ...DEFAULT_DPS,
        motion_reset_seconds: 30,
        ...(detectedDps || {}),
      },
    };
  }

  async onPairListDevices() { return []; }
}

module.exports = DoorbellDriver;
