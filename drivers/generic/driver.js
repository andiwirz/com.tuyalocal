'use strict';

const Homey                     = require('homey');
const TuyAPI                    = require('tuyapi');
const { setupCloudLookup } = require('../../lib/pairCloudLookup');
const { detectProtocolVersion } = require('../../lib/autoDetect');
const { scanNetwork }           = require('../../lib/networkScan');

class GenericDriver extends Homey.Driver {
  async onInit() {
    this.log('Generic driver initialized');

    // ── Actions ──────────────────────────────────────────────────────────────
    this.homey.flow.getActionCard('generic_force_reconnect')
      .registerRunListener(async (args) => {
        return args.device.forceReconnect();
      });

    this.homey.flow.getActionCard('generic_refresh_device')
      .registerRunListener(async (args) => {
        return args.device.pollNow();
      });

    // ── Conditions ───────────────────────────────────────────────────────────
    this.homey.flow.getConditionCard('generic_device_is_connected')
      .registerRunListener(async (args) =>
        args.device._conn?.connected === true
      );
  }

  async onPair(session) {
    setupCloudLookup(session, this.homey);
    let pendingDevice = null;
    let pendingRawDps = {};

    // ── Network scan ─────────────────────────────────────────────────────────
    session.setHandler('scan_network', async () => {
      return scanNetwork(this.homey);
    });

    // ── Credentials / connect ─────────────────────────────────────────────────
    session.setHandler('credentials', async (data) => {
      const { ip, deviceId, localKey, version } = data;

      const net = require('net');
      if (!net.isIPv4(ip)) {
        throw new Error(this.homey.__('pair.credentials.invalidIp') || 'Invalid IP address');
      }
      if (localKey.length !== 16 && localKey.length !== 32) {
        throw new Error(this.homey.__('pair.credentials.invalidKey') || 'Invalid local key length');
      }

      let connected      = false;
      let actualVersion  = String(version);
      const collectedDps = {};

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
          rawDps = tmpDps;
        }
        Object.assign(collectedDps, rawDps);
        connected = true;
      } catch (err) {
        connected = false;
        try { device.disconnect(); } catch (_e) {}
        this.log('Connection test failed:', err.message);
      }

      pendingDevice = {
        name: this.homey.__('device.defaultName.generic'),
        data: { id: deviceId },
        settings: {
          ip,
          device_id:        deviceId,
          local_key:        localKey,
          version:          actualVersion,
          dp_config:        '[]',
          polling_interval: 30,
        },
      };

      pendingRawDps = collectedDps;

      return { connected, detectedVersion: actualVersion };
    });

    // ── List devices ──────────────────────────────────────────────────────────
    session.setHandler('list_devices', async () => {
      return pendingDevice ? [pendingDevice] : [];
    });

    // ── Raw DPS ───────────────────────────────────────────────────────────────
    session.setHandler('raw_dps', async () => {
      return pendingRawDps || {};
    });

    // ── Helpers called by list_devices.html ───────────────────────────────────
    session.setHandler('set_device_name', async (name) => {
      if (pendingDevice && name && name.trim()) {
        pendingDevice.name = name.trim();
      }
    });

    session.setHandler('set_dp_config', async (dpConfigJson) => {
      if (pendingDevice) {
        pendingDevice.settings.dp_config = dpConfigJson;
      }
    });
  }

  // Fallback for older Homey versions
  async onPairListDevices() {
    return [];
  }
}

module.exports = GenericDriver;
