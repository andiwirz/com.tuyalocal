'use strict';

const Homey                     = require('homey');
const TuyAPI                    = require('tuyapi');
const { setupCloudLookup } = require('../../lib/pairCloudLookup');
const { detectProtocolVersion } = require('../../lib/autoDetect');
const { scanNetwork }           = require('../../lib/networkScan');

class LightDriver extends Homey.Driver {
  async onInit() {
    this.log('Light driver initialized');

    this.homey.flow.getConditionCard('light_device_is_connected')
      .registerRunListener(async (args) => args.device._conn?.connected === true);

    this.homey.flow.getActionCard('light_force_reconnect')
      .registerRunListener(async (args) => args.device.forceReconnect());

    this.homey.flow.getActionCard('light_refresh_device')
      .registerRunListener(async (args) => args.device.pollNow());
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

      let connected     = false;
      let detectedDps   = null;
      let actualVersion = String(version);
      const collectedDps = {};
      let pairingDevice = null;
      try {
        let rawDps;
        if (version === 'auto') {
          const result = await detectProtocolVersion({ ip, deviceId, localKey });
          actualVersion = result.version;
          rawDps        = result.dps;
        } else {
          const device = new TuyAPI({ id: deviceId, key: localKey, ip, version: actualVersion, issueGetOnConnect: true });
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
        if (Object.keys(collectedDps).length > 0) detectedDps = this._detectDps(collectedDps);
      } catch (err) {
        connected = false;
        try { if (pairingDevice) pairingDevice.disconnect(); } catch (_e) {}
        this.log('Connection test failed:', err.message);
      }

      pendingDevice = {
        name: this.homey.__('device.defaultName.light'),
        data: { id: deviceId },
        settings: {
          ip, device_id: deviceId, local_key: localKey, version: actualVersion,
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
    const boolDps   = [];
    const intDps    = [];
    const enumDps   = [];
    const stringDps = [];

    for (const [dp, val] of Object.entries(dps)) {
      const num = parseInt(dp, 10);
      if (typeof val === 'boolean')      boolDps.push({ dp: num, val });
      else if (typeof val === 'number')  intDps.push({ dp: num, val });
      else if (typeof val === 'string') {
        // Detect hex color string (12+ hex chars)
        if (/^[0-9a-fA-F]{12,}$/.test(val)) stringDps.push({ dp: num, val, isHex: true });
        else                                  enumDps.push({ dp: num, val });
      }
    }

    // Standard Tuya light layout:
    //   DP 1/20 = switch, DP 2/21 = color_mode, DP 3/22 = brightness, DP 4/23 = color_temp, DP 5/24 = HSV color
    const dp_onoff = (boolDps.find((d) => d.dp === 1) || boolDps.find((d) => d.dp === 20) || boolDps[0])?.dp ?? 1;

    // Color mode: string DP with values like 'white','colour','color'
    const COLOR_MODE_VALS = ['white', 'colour', 'color', 'scene', 'animation'];
    const colorModeEntry  = enumDps.find((d) => COLOR_MODE_VALS.includes(String(d.val).toLowerCase()));
    const dp_color_mode   = colorModeEntry?.dp ?? 0;

    // Brightness: int DP in range 10–1000 or 0–255
    const brightnessEntry = intDps.find((d) => d.dp !== dp_onoff && d.val >= 0 && d.val <= 1000);
    const dp_brightness   = brightnessEntry?.dp ?? 3;
    const brightness_max  = (brightnessEntry?.val ?? 1000) > 255 ? 1000 : 255;

    // Color temp: int DP in range 0–1000 (different from brightness)
    const colorTempEntry  = intDps.find((d) => d.dp !== dp_onoff && d.dp !== dp_brightness && d.val >= 0 && d.val <= 1000);
    const dp_color_temp   = colorTempEntry?.dp ?? 0;
    const color_temp_max  = 1000;

    // HSV hex color
    const colorHexEntry = stringDps.find((d) => d.isHex);
    const dp_color      = colorHexEntry?.dp ?? 0;

    // Detect color_mode string values
    const whiteVal  = colorModeEntry ? String(colorModeEntry.val) : 'white';
    const colorVal  = 'colour';

    return {
      dp_onoff, dp_color_mode, dp_brightness, dp_color_temp, dp_color,
      brightness_max, color_temp_max,
      color_temp_invert: false,
      color_mode_white_val: whiteVal,
      color_mode_color_val: colorVal,
    };
  }

  async onPairListDevices() { return []; }
}

module.exports = LightDriver;
