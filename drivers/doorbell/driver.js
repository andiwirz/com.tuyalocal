'use strict';

const Homey                     = require('homey');
const TuyAPI                    = require('tuyapi');
const { setupCloudLookup }      = require('../../lib/pairCloudLookup');
const { detectProtocolVersion } = require('../../lib/autoDetect');
const { scanNetwork }           = require('../../lib/networkScan');

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
      } catch (err) {
        connected = false;
        try { if (pairingDevice) pairingDevice.disconnect(); } catch (_e) {}
        this.log('Connection test failed:', err.message);
      }

      pendingDevice = this._buildPendingDevice({
        ip, deviceId, localKey, version: actualVersion,
      });
      pendingRawDps = collectedDps;

      return { connected, detectedVersion: actualVersion };
    });

    session.setHandler('list_devices', async () => pendingDevice ? [pendingDevice] : []);
    session.setHandler('raw_dps', async () => pendingRawDps || {});
    session.setHandler('set_device_name', async (name) => {
      if (pendingDevice && name?.trim()) pendingDevice.name = name.trim();
    });
  }

  _buildPendingDevice({ ip, deviceId, localKey, version }) {
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
        dp_doorbell:          136,
        dp_motion_event:      115,
        dp_alarm_message:     0,
        dp_motion_switch:     134,
        dp_motion_sensitivity: 106,
        dp_nightvision:       108,
        dp_indicator:         101,
        dp_recording:         150,
        dp_chime_volume:      157,
        dp_device_volume:     160,
        motion_reset_seconds: 30,
      },
    };
  }

  async onPairListDevices() { return []; }
}

module.exports = DoorbellDriver;
