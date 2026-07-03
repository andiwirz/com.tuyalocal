'use strict';

const Homey                     = require('homey');
const TuyAPI                    = require('tuyapi');
const { setupCloudLookup } = require('../../lib/pairCloudLookup');
const { detectProtocolVersion } = require('../../lib/autoDetect');
const { scanNetwork }           = require('../../lib/networkScan');

class WallSwitchDriver extends Homey.Driver {
  async onInit() {
    this.log('Wall Switch driver initialized');

    // ── Conditions ──────────────────────────────────────────────────────────
    this.homey.flow.getConditionCard('switch_device_is_connected')
      .registerRunListener(async (args) => args.device._conn?.connected === true);

    this.homey.flow.getConditionCard('switch_gang_is_on')
      .registerRunListener(async (args) => {
        const cap = args.gang === '1' ? 'onoff' : `onoff.${args.gang}`;
        return args.device.getCapabilityValue(cap) === true;
      });

    // ── Trigger run-listeners ────────────────────────────────────────────────
    this.homey.flow.getDeviceTriggerCard('switch_gang_changed')
      .registerRunListener(async (args, state) => String(state.gang) === args.gang);

    // ── Actions ─────────────────────────────────────────────────────────────
    this.homey.flow.getActionCard('switch_force_reconnect')
      .registerRunListener(async (args) => args.device.forceReconnect());

    this.homey.flow.getActionCard('switch_refresh_device')
      .registerRunListener(async (args) => args.device.pollNow());

    this.homey.flow.getActionCard('switch_set_gang')
      .registerRunListener(async (args) => {
        const cap = args.gang === '1' ? 'onoff' : `onoff.${args.gang}`;
        if (!args.device.hasCapability(cap)) {
          throw new Error(`Switch ${args.gang} is not configured on this device`);
        }
        const value = args.state === 'on';
        await args.device.triggerCapabilityListener(cap, value);
      });

    this.homey.flow.getActionCard('switch_toggle_gang')
      .registerRunListener(async (args) => {
        const cap = args.gang === '1' ? 'onoff' : `onoff.${args.gang}`;
        if (!args.device.hasCapability(cap)) {
          throw new Error(`Switch ${args.gang} is not configured on this device`);
        }
        const current = args.device.getCapabilityValue(cap) ?? false;
        await args.device.triggerCapabilityListener(cap, !current);
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
        if (Object.keys(collectedDps).length > 0) {
          detectedDps = this._detectDps(collectedDps);
          this.log('Detected DPs:', JSON.stringify(detectedDps));
        }
      } catch (err) {
        connected = false;
        try { if (pairingDevice) pairingDevice.disconnect(); } catch (_e) {}
        this.log('Connection test failed:', err.message);
      }

      pendingDevice = {
        name: this.homey.__('device.defaultName.wall_switch'),
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
      dp_switch_1:     0,
      dp_switch_2:     0,
      dp_switch_3:     0,
      dp_switch_4:     0,
      dp_countdown_1:  0,
      dp_countdown_2:  0,
      dp_countdown_3:  0,
      dp_countdown_4:  0,
      dp_relay_status: 0,
    };

    // Standard Tuya layout: switch DPs at 1–4, countdown DPs at 7–10
    for (const [dpStr, val] of Object.entries(dps)) {
      const dp = parseInt(dpStr, 10);
      if (typeof val === 'boolean' && dp >= 1 && dp <= 4) {
        result[`dp_switch_${dp}`] = dp;
      } else if (typeof val === 'number' && dp >= 7 && dp <= 10) {
        result[`dp_countdown_${dp - 6}`] = dp;
      } else if (typeof val === 'string' && ['on', 'off', 'last', 'memory'].includes(val)) {
        result.dp_relay_status = dp;
      }
    }

    // Fallback: if no switches found at standard positions, use first 4 boolean DPs
    if (result.dp_switch_1 === 0) {
      const boolDps = Object.entries(dps)
        .filter(([, v]) => typeof v === 'boolean')
        .map(([k]) => parseInt(k, 10))
        .sort((a, b) => a - b);
      boolDps.forEach((dp, i) => {
        if (i < 4) result[`dp_switch_${i + 1}`] = dp;
      });
    }

    return result;
  }

  async onPairListDevices() { return []; }
}

module.exports = WallSwitchDriver;
