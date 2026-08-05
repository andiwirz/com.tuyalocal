'use strict';

const Homey                     = require('homey');
const TuyAPI                    = require('tuyapi');
const { setupCloudLookup } = require('../../lib/pairCloudLookup');
const { detectProtocolVersion } = require('../../lib/autoDetect');
const { scanNetwork }           = require('../../lib/networkScan');
const { detectViaCloud }        = require('../../lib/dpCodeMap');

// Maps this driver's settings keys to the Tuya cloud "code" names that
// commonly represent them. See lib/dpCodeMap.js for why this refines the
// local value-heuristic DP detection during pairing.
// Verified against the standard code list for Tuya category "fs" (fan).
const CLOUD_CODE_MAP = {
  dp_onoff:            ['switch', 'switch_1', 'power'],
  dp_speed:            ['fan_speed', 'speed'],
  dp_fan_speed:        ['fan_speed_enum', 'level'],
  // fan_horizontal / fan_vertical are the standard swing codes for this
  // category; shake / swing appear on rebadged units.
  dp_oscillate:        ['fan_horizontal', 'fan_vertical', 'shake', 'swing'],
  dp_direction:        ['fan_direction', 'direction'],
  dp_mode:             ['mode', 'work_mode'],
  dp_child_lock:       ['child_lock', 'lock'],
  dp_countdown_timer:  ['countdown', 'countdown_set'],
  dp_countdown_left:   ['countdown_left'],
  dp_light_onoff:      ['light', 'switch_led'],
  dp_light_dim:        ['bright_value', 'bright_value_v2', 'bright_value_1'],
  dp_light_color_temp: ['temp_value', 'temp_value_v2'],
};

// When the cloud spec confirms a DP maps to one of these settings, the DP's
// full declared enum token list is written to the companion setting. Note:
// this driver's mode capability uses "fan_mode_values" (not "mode_values").
const CLOUD_ENUM_VALUES_MAP = {
  dp_mode:      'fan_mode_values',
  dp_fan_speed: 'fan_speed_values',
};

class FanDriver extends Homey.Driver {
  async onInit() {
    this.log('Fan driver initialized');

    // ── Trigger run-listeners ───────────────────────────────────────────────
    this.homey.flow.getDeviceTriggerCard('fan_mode_changed')
      .registerRunListener(async (args, state) => true); // always fire

    this.homey.flow.getDeviceTriggerCard('fan_direction_changed')
      .registerRunListener(async (args, state) => true); // always fire

    // ── Conditions ──────────────────────────────────────────────────────────
    this.homey.flow.getConditionCard('fan_device_is_connected')
      .registerRunListener(async (args) =>
        args.device._conn?.connected === true
      );

    const cap = (v) => v.charAt(0).toUpperCase() + v.slice(1).replace(/_/g, ' ');
    const modeAC = async (query, args) => {
      const values = (args.device.getSetting('fan_mode_values') || 'normal,sleep,nature,breeze,smart')
        .split(',').map((s) => s.trim()).filter(Boolean);
      const q = query.toLowerCase();
      return values.filter((v) => v.toLowerCase().includes(q)).map((v) => ({ id: v, name: cap(v) }));
    };
    const fanAC = async (query, args) => {
      const values = (args.device.getSetting('fan_speed_values') || 'low,medium,high,auto,turbo')
        .split(',').map((s) => s.trim()).filter(Boolean);
      const q = query.toLowerCase();
      return values.filter((v) => v.toLowerCase().includes(q)).map((v) => ({ id: v, name: cap(v) }));
    };

    this.homey.flow.getConditionCard('fan_mode_is')
      .registerArgumentAutocompleteListener('mode', modeAC)
      .registerRunListener(async (args) =>
        args.device.getCapabilityValue('fan_mode') === args.mode.id
      );

    this.homey.flow.getConditionCard('fan_direction_is')
      .registerRunListener(async (args) =>
        args.device.getCapabilityValue('fan_direction') === args.direction
      );

    this.homey.flow.getConditionCard('fan_light_is_on')
      .registerRunListener(async (args) =>
        args.device.getCapabilityValue('onoff.light') === true
      );

    // ── Actions ─────────────────────────────────────────────────────────────
    this.homey.flow.getActionCard('fan_set_mode')
      .registerArgumentAutocompleteListener('mode', modeAC)
      .registerRunListener(async (args) => {
        if (!args.device.hasCapability('fan_mode')) return;
        await args.device.setCapabilityValue('fan_mode', args.mode.id);
        return args.device.triggerCapabilityListener('fan_mode', args.mode.id);
      });

    this.homey.flow.getActionCard('fan_set_fan_speed')
      .registerArgumentAutocompleteListener('fan_speed', fanAC)
      .registerRunListener(async (args) => {
        if (!args.device.hasCapability('fan_speed')) return;
        await args.device.setCapabilityValue('fan_speed', args.fan_speed.id);
        return args.device.triggerCapabilityListener('fan_speed', args.fan_speed.id);
      });

    this.homey.flow.getActionCard('fan_set_oscillate')
      .registerRunListener(async (args) => {
        if (!args.device.hasCapability('oscillate')) return;
        const enabled = args.enabled === 'true';
        await args.device.setCapabilityValue('oscillate', enabled);
        return args.device.triggerCapabilityListener('oscillate', enabled);
      });

    this.homey.flow.getActionCard('fan_set_direction')
      .registerRunListener(async (args) => {
        if (!args.device.hasCapability('fan_direction')) return;
        await args.device.setCapabilityValue('fan_direction', args.direction);
        return args.device.triggerCapabilityListener('fan_direction', args.direction);
      });

    this.homey.flow.getActionCard('fan_set_timer')
      .registerRunListener(async (args) => {
        if (!args.device.hasCapability('countdown_timer')) return;
        await args.device.setCapabilityValue('countdown_timer', args.timer);
        return args.device.triggerCapabilityListener('countdown_timer', args.timer);
      });

    this.homey.flow.getActionCard('fan_set_light')
      .registerRunListener(async (args) => {
        if (!args.device.hasCapability('onoff.light')) return;
        const enabled = args.enabled === 'true';
        await args.device.setCapabilityValue('onoff.light', enabled);
        return args.device.triggerCapabilityListener('onoff.light', enabled);
      });

    this.homey.flow.getActionCard('fan_set_light_dim')
      .registerRunListener(async (args) => {
        if (!args.device.hasCapability('dim.light')) return;
        const value = Math.max(0, Math.min(1, Number(args.brightness) / 100));
        await args.device.setCapabilityValue('dim.light', value);
        return args.device.triggerCapabilityListener('dim.light', value);
      });

    this.homey.flow.getActionCard('fan_force_reconnect')
      .registerRunListener(async (args) => args.device.forceReconnect());

    this.homey.flow.getActionCard('fan_refresh_device')
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
          this.log('Locally detected DPs (value heuristic):', JSON.stringify(detectedDps));

          // Best-effort refinement using the device's Tuya cloud specification.
          // Only runs if Cloud Lookup credentials were saved previously (Settings
          // → ☁️ Cloud Lookup) — never blocks pairing if unavailable or it fails.
          const cloudDps = await detectViaCloud(this.homey, deviceId, CLOUD_CODE_MAP, (m) => this.log(m), CLOUD_ENUM_VALUES_MAP);
          if (Object.keys(cloudDps).length > 0) {
            Object.assign(detectedDps, cloudDps);
            this.log('Final detected DPs (cloud-refined):', JSON.stringify(detectedDps));
          }
        }
      } catch (err) {
        connected = false;
        try { if (pairingDevice) pairingDevice.disconnect(); } catch (_e) {}
        this.log('Connection test failed:', err.message);
      }

      pendingDevice = {
        name: this.homey.__('device.defaultName.fan'),
        data: { id: deviceId },
        settings: {
          ip, device_id: deviceId, local_key: localKey, version: actualVersion,
          ...(detectedDps || {}),
        },
      };
      pendingRawDps = collectedDps;
      return { connected, detectedVersion: actualVersion, detectedDps };
    });

    session.setHandler('list_devices', async () => pendingDevice ? [pendingDevice] : []);
    session.setHandler('raw_dps',      async () => pendingRawDps || {});
    session.setHandler('set_device_name', async (name) => {
      if (pendingDevice && name?.trim()) pendingDevice.name = name.trim();
    });
  }

  _detectDps(dps) {
    const boolDps = [];
    const intDps  = [];
    const enumDps = [];

    for (const [dp, val] of Object.entries(dps)) {
      const num = parseInt(dp, 10);
      if (typeof val === 'boolean')      boolDps.push({ dp: num, val });
      else if (typeof val === 'number')  intDps.push({ dp: num, val });
      else if (typeof val === 'string')  enumDps.push({ dp: num, val });
    }

    const dp_onoff = (boolDps.find((d) => d.dp === 1) || boolDps[0])?.dp ?? 1;

    // Numeric speed: look for a small integer (1–100) on DPs 2–10
    const speedEntry = intDps.find((d) => d.dp !== dp_onoff && d.val >= 1 && d.val <= 100 && d.dp <= 10);
    const dp_speed = speedEntry?.dp ?? 3;

    const KNOWN_FAN   = ['low', 'medium', 'middle', 'high', 'auto', 'turbo'];
    const fanEntry    = enumDps.find((d) => KNOWN_FAN.includes(String(d.val).toLowerCase()));
    const dp_fan_speed = fanEntry?.dp ?? 0;

    const KNOWN_MODES  = ['normal', 'sleep', 'nature', 'breeze', 'smart', 'natural'];
    const modeEntry    = enumDps.find((d) => KNOWN_MODES.includes(String(d.val).toLowerCase()));
    const dp_mode      = modeEntry?.dp ?? 0;

    // Direction: enum DP whose value is 'forward' or 'reverse'
    const KNOWN_DIR    = ['forward', 'reverse'];
    const dirEntry     = enumDps.find((d) => KNOWN_DIR.includes(String(d.val).toLowerCase()));
    const dp_direction = dirEntry?.dp ?? 0;

    const timerEntry        = enumDps.find((d) => String(d.val) === 'cancel' || /^\d+h$/.test(String(d.val)));
    const dp_countdown_timer = timerEntry?.dp ?? 0;

    // Oscillation: a boolean DP that is not on/off, not light on/off
    // We detect light on/off first so we can exclude it
    // Light on/off heuristic: boolean DP with dp >= 10 (common Tuya light DPs: 15, 20, etc.)
    const lightOnoffEntry = boolDps.find((d) => d.dp !== dp_onoff && d.dp >= 10);
    const dp_light_onoff  = lightOnoffEntry?.dp ?? 0;

    const oscillateEntry = boolDps.find((d) => d.dp !== dp_onoff && d.dp !== dp_light_onoff && d.dp > 1);
    const dp_oscillate   = oscillateEntry?.dp ?? 0;

    // Light brightness: int DP in range 0–100, not speed, dp >= 10
    const lightDimEntry = intDps.find((d) => d.dp !== dp_speed && d.dp >= 10 && d.val >= 0 && d.val <= 100);
    const dp_light_dim  = lightDimEntry?.dp ?? 0;

    // Light color temp: int DP in range 0–100, not speed, not light dim, dp >= 10
    const lightTempEntry     = intDps.find((d) => d.dp !== dp_speed && d.dp !== dp_light_dim && d.dp >= 10 && d.val >= 0 && d.val <= 100);
    const dp_light_color_temp = lightTempEntry?.dp ?? 0;

    // Detect speed range
    const rawSpeed = speedEntry?.val ?? 1;
    const speed_min = 1;
    const speed_max = rawSpeed <= 6 ? 6 : rawSpeed <= 12 ? 12 : 100;

    // Light dim range defaults
    const dp_light_dim_min = 0;
    const dp_light_dim_max = dp_light_dim > 0 ? 100 : 100;

    return {
      dp_onoff, dp_speed, dp_fan_speed, dp_oscillate, dp_direction, dp_mode,
      dp_child_lock: 0, dp_countdown_timer, dp_countdown_left: 0,
      speed_min, speed_max,
      fan_speed_values: 'low,medium,high,auto,turbo',
      fan_mode_values:  'normal,sleep,nature,breeze,smart',
      dp_light_onoff, dp_light_dim, dp_light_dim_min, dp_light_dim_max, dp_light_color_temp,
    };
  }

  async onPairListDevices() { return []; }
}

module.exports = FanDriver;
