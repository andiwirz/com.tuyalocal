'use strict';

const Homey                     = require('homey');
const TuyAPI                    = require('tuyapi');
const { setupCloudLookup } = require('../../lib/pairCloudLookup');
const { detectProtocolVersion } = require('../../lib/autoDetect');
const { scanNetwork }           = require('../../lib/networkScan');

class AirConditionerDriver extends Homey.Driver {
  async onInit() {
    this.log('Air Conditioner driver initialized');

    // ── Conditions ─────────────────────────────────────────────────────────
    this.homey.flow.getConditionCard('ac_device_is_connected')
      .registerRunListener(async (args) => args.device._conn?.connected === true);

    const cap = (v) => v.charAt(0).toUpperCase() + v.slice(1).replace(/_/g, ' ');
    const modeAC = async (query, args) => {
      const values = (args.device.getSetting('mode_values') || 'cool,heat,auto,dry,fan')
        .split(',').map((s) => s.trim()).filter(Boolean);
      const q = query.toLowerCase();
      return values.filter((v) => v.toLowerCase().includes(q)).map((v) => ({ id: v, name: cap(v) }));
    };
    const fanAC = async (query, args) => {
      const values = (args.device.getSetting('fan_speed_values') || 'auto,low,medium,high,turbo')
        .split(',').map((s) => s.trim()).filter(Boolean);
      const q = query.toLowerCase();
      return values.filter((v) => v.toLowerCase().includes(q)).map((v) => ({ id: v, name: cap(v) }));
    };

    this.homey.flow.getConditionCard('ac_mode_is')
      .registerArgumentAutocompleteListener('mode', modeAC)
      .registerRunListener(async (args) =>
        args.device.getCapabilityValue('ac_mode') === args.mode.id
      );

    this.homey.flow.getConditionCard('ac_fan_speed_is')
      .registerArgumentAutocompleteListener('fan_speed', fanAC)
      .registerRunListener(async (args) =>
        args.device.getCapabilityValue('ac_fan_speed') === args.fan_speed.id
      );

    this.homey.flow.getConditionCard('ac_sleep_is_on')
      .registerRunListener(async (args) =>
        args.device.getCapabilityValue('ac_sleep') === true
      );

    this.homey.flow.getConditionCard('ac_fault_is_active')
      .registerRunListener(async (args) =>
        args.device.getCapabilityValue('alarm_generic') === true
      );

    // ── Actions ─────────────────────────────────────────────────────────────
    this.homey.flow.getActionCard('ac_set_mode')
      .registerArgumentAutocompleteListener('mode', modeAC)
      .registerRunListener(async (args) => {
        await args.device.setCapabilityValue('ac_mode', args.mode.id);
        return args.device.triggerCapabilityListener('ac_mode', args.mode.id);
      });

    this.homey.flow.getActionCard('ac_set_fan_speed')
      .registerArgumentAutocompleteListener('fan_speed', fanAC)
      .registerRunListener(async (args) => {
        await args.device.setCapabilityValue('ac_fan_speed', args.fan_speed.id);
        return args.device.triggerCapabilityListener('ac_fan_speed', args.fan_speed.id);
      });

    this.homey.flow.getActionCard('ac_set_target_temp')
      .registerRunListener(async (args) => {
        await args.device.setCapabilityValue('target_temperature', args.temperature);
        return args.device.triggerCapabilityListener('target_temperature', args.temperature);
      });

    this.homey.flow.getActionCard('ac_set_swing')
      .registerRunListener(async (args) => {
        if (!args.device.hasCapability('ac_swing')) return;
        await args.device.setCapabilityValue('ac_swing', args.swing);
        return args.device.triggerCapabilityListener('ac_swing', args.swing);
      });

    this.homey.flow.getActionCard('ac_set_sleep')
      .registerRunListener(async (args) => {
        if (!args.device.hasCapability('ac_sleep')) return;
        const enabled = args.enabled === 'true' || args.enabled === true;
        await args.device.setCapabilityValue('ac_sleep', enabled);
        return args.device.triggerCapabilityListener('ac_sleep', enabled);
      });

    this.homey.flow.getActionCard('ac_set_eco')
      .registerRunListener(async (args) => {
        if (!args.device.hasCapability('ac_eco')) return;
        const enabled = args.enabled === 'true' || args.enabled === true;
        await args.device.setCapabilityValue('ac_eco', enabled);
        return args.device.triggerCapabilityListener('ac_eco', enabled);
      });

    this.homey.flow.getActionCard('ac_set_anion')
      .registerRunListener(async (args) => {
        if (!args.device.hasCapability('anion')) return;
        const enabled = args.enabled === 'true' || args.enabled === true;
        await args.device.setCapabilityValue('anion', enabled);
        return args.device.triggerCapabilityListener('anion', enabled);
      });

    this.homey.flow.getActionCard('ac_set_swing_h')
      .registerRunListener(async (args) => {
        if (!args.device.hasCapability('ac_swing_h')) return;
        const enabled = args.enabled === 'true' || args.enabled === true;
        await args.device.setCapabilityValue('ac_swing_h', enabled);
        return args.device.triggerCapabilityListener('ac_swing_h', enabled);
      });

    this.homey.flow.getActionCard('ac_set_child_lock')
      .registerRunListener(async (args) => {
        if (!args.device.hasCapability('child_lock')) return;
        const enabled = args.enabled === 'true' || args.enabled === true;
        await args.device.setCapabilityValue('child_lock', enabled);
        return args.device.triggerCapabilityListener('child_lock', enabled);
      });

    this.homey.flow.getActionCard('ac_force_reconnect')
      .registerRunListener(async (args) => args.device.forceReconnect());

    this.homey.flow.getActionCard('ac_refresh_device')
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
      let actualVersion = String(version);
      const collectedDps = {};

      let pairingDevice = null;
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
          const detected = this._detectDps(collectedDps);
          this.log('Detected DPs:', JSON.stringify(detected));
          // Merge detected settings into pendingDevice later
          pendingDevice = this._buildPendingDevice({ ip, deviceId, localKey, version: actualVersion, detectedDps: detected });
        }
      } catch (err) {
        connected = false;
        try { if (pairingDevice) pairingDevice.disconnect(); } catch (_e) {}
        this.log('Connection test failed:', err.message);
      }

      if (!pendingDevice) {
        pendingDevice = this._buildPendingDevice({ ip, deviceId, localKey, version: actualVersion, detectedDps: null });
      }

      pendingRawDps = collectedDps;
      return { connected, detectedVersion: actualVersion };
    });

    session.setHandler('list_devices', async () => pendingDevice ? [pendingDevice] : []);
    session.setHandler('raw_dps', async () => pendingRawDps || {});
    session.setHandler('set_device_name', async (name) => {
      if (pendingDevice && name?.trim()) pendingDevice.name = name.trim();
    });
  }

  _buildPendingDevice({ ip, deviceId, localKey, version, detectedDps }) {
    const defaults = {
      ip,
      device_id:           deviceId,
      local_key:           localKey,
      version,
      polling_interval:    30,
      dp_onoff:            1,
      dp_target_temp:      2,
      dp_current_temp:     3,
      dp_mode:             4,
      dp_fan_speed:        5,
      dp_swing:            0,
      dp_swing_h:          0,
      dp_anion:            0,
      dp_sleep:            0,
      dp_eco:              0,
      dp_child_lock:       0,
      dp_countdown_timer:  0,
      dp_countdown_left:   0,
      dp_fault:            20,
      temp_divisor:        1,
      mode_values:         'cool,heat,auto,dry,fan',
      fan_speed_values:    'auto,low,medium,high,turbo',
      swing_values:        'off,on',
    };

    return {
      name: this.homey.__('device.defaultName.air_conditioner'),
      data: { id: deviceId },
      settings: { ...defaults, ...(detectedDps || {}) },
    };
  }

  // ── Auto-detect DPs from a snapshot ──────────────────────────────────────

  _detectDps(dps) {
    const result = {
      dp_onoff:           1,
      dp_target_temp:     2,
      dp_current_temp:    3,
      dp_mode:            4,
      dp_fan_speed:       5,
      dp_swing:           0,
      dp_swing_h:         0,
      dp_anion:           0,
      dp_eco:             0,
      dp_child_lock:      0,
      dp_sleep:           0,
      dp_countdown_timer: 0,
      dp_countdown_left:  0,
      dp_fault:           20,
      temp_divisor:       1,
      mode_values:        'cool,heat,auto,dry,fan',
      fan_speed_values:   'auto,low,medium,high,turbo',
      swing_values:       'off,on',
    };

    const KNOWN_MODES = new Set(['cool','heat','auto','dry','fan','cold','warm','dehumid',
      'COOL','HEAT','AUTO','DRY','FAN','fan_only']);
    const KNOWN_FAN   = new Set(['auto','low','medium','middle','high','turbo','1','2','3','4','5']);
    const KNOWN_SWING = new Set(['off','on','updown','leftright','updown_leftright','fixed','swing']);

    const boolDps = [];
    const numDps  = [];
    const strDps  = [];

    for (const [dpStr, val] of Object.entries(dps)) {
      const dp = parseInt(dpStr, 10);
      if (typeof val === 'boolean') boolDps.push({ dp, val });
      else if (typeof val === 'number') numDps.push({ dp, val });
      else if (typeof val === 'string') strDps.push({ dp, val });
    }

    // ── Power: DP 1 boolean or first boolean DP
    const powerEntry = boolDps.find((d) => d.dp === 1) || boolDps[0];
    if (powerEntry) result.dp_onoff = powerEntry.dp;

    // ── Temperatures
    // Detect if temperatures are ×10 (e.g. 220 = 22°C) or direct (22 = 22°C)
    const tempCandidates = numDps.filter((d) => d.val >= 16 && d.val <= 50);   // direct °C
    const tempX10        = numDps.filter((d) => d.val >= 160 && d.val <= 500); // ×10 scaled

    if (tempX10.length >= 1 && tempCandidates.length === 0) {
      result.temp_divisor = 10;
      const sorted = [...tempX10].sort((a, b) => a.dp - b.dp);
      if (sorted[0]) result.dp_target_temp  = sorted[0].dp;
      if (sorted[1]) result.dp_current_temp = sorted[1].dp;
    } else if (tempCandidates.length >= 1) {
      const sorted = [...tempCandidates].sort((a, b) => a.dp - b.dp);
      // Typically DP 2 = target, DP 3 = current; prefer those
      const t2 = sorted.find((d) => d.dp === 2);
      const t3 = sorted.find((d) => d.dp === 3);
      if (t2) result.dp_target_temp  = t2.dp;
      else    result.dp_target_temp  = sorted[0].dp;
      if (t3) result.dp_current_temp = t3.dp;
      else if (sorted[1]) result.dp_current_temp = sorted[1].dp;
    }

    // ── Mode
    const modeEntry = strDps.find((d) => KNOWN_MODES.has(d.val));
    if (modeEntry) {
      result.dp_mode = modeEntry.dp;
      // Keep the full default mode list so all common options are immediately
      // available in the picker.  If the detected value is not in the defaults
      // (exotic firmware variant), prepend it so the picker still works on first open.
      const defaultModes = result.mode_values; // 'cool,heat,auto,dry,fan'
      result.mode_values = defaultModes.split(',').includes(modeEntry.val)
        ? defaultModes
        : [modeEntry.val, ...defaultModes.split(',')].join(',');
    }

    // ── Fan speed
    const fanEntry = strDps.find((d) => KNOWN_FAN.has(d.val) && d.dp !== result.dp_mode);
    if (fanEntry) {
      result.dp_fan_speed = fanEntry.dp;
      const defaultFan = result.fan_speed_values; // 'auto,low,medium,high,turbo'
      result.fan_speed_values = defaultFan.split(',').includes(fanEntry.val)
        ? defaultFan
        : [fanEntry.val, ...defaultFan.split(',')].join(',');
    }

    // ── Swing — check bool DPs (classic) and enum DPs (windshake style)
    const unusedBools = boolDps.filter((d) => d.dp !== result.dp_onoff);
    const boolSwing   = unusedBools.find((d) => d.dp === 8);
    const enumSwing   = strDps.find((d) =>
      KNOWN_SWING.has(d.val) && d.dp !== result.dp_mode && d.dp !== result.dp_fan_speed,
    );
    if (boolSwing) {
      result.dp_swing     = boolSwing.dp;
      result.swing_values = 'off,on';
    } else if (enumSwing) {
      result.dp_swing = enumSwing.dp;
      // Seed swing_values with detected value if it is not already covered by the
      // default 'off,on' (e.g. device currently reports 'updown').
      const defaultSwing = result.swing_values; // 'off,on'
      result.swing_values = defaultSwing.split(',').includes(enumSwing.val)
        ? defaultSwing
        : [enumSwing.val, ...defaultSwing.split(',')].join(',');
    }

    // ── Anion / ioniser — DP 11 is the standard code
    const anionEntry = unusedBools.find((d) => d.dp === 11);
    if (anionEntry) result.dp_anion = anionEntry.dp;

    // ── Horizontal swing — DP 110 is common for windshakeH
    const swingHEntry = unusedBools.find((d) => d.dp === 110);
    if (swingHEntry) result.dp_swing_h = swingHEntry.dp;

    // ── Sleep — prefer conventional DP 9, fall back to DP 103 or other unused booleans
    const assignedBoolDps = new Set([
      result.dp_onoff, result.dp_swing, result.dp_swing_h, result.dp_anion,
      6,  // eco (DP 6 is reserved for eco; don't let fallback assign it to sleep)
      7,  // child lock (DP 7 is reserved for child lock)
    ].filter(Boolean));
    const sleepEntry     = unusedBools.find((d) => d.dp === 9)
                        || unusedBools.find((d) => d.dp === 103)
                        || unusedBools.find((d) => !assignedBoolDps.has(d.dp));
    const ecoEntry       = unusedBools.find((d) => d.dp === 6);
    const childLockEntry = unusedBools.find((d) => d.dp === 7);

    if (sleepEntry)      result.dp_sleep      = sleepEntry.dp;
    if (ecoEntry)        result.dp_eco        = ecoEntry.dp;
    if (childLockEntry)  result.dp_child_lock = childLockEntry.dp;

    // ── Timer / countdown
    const timer10 = numDps.find((d) => d.dp === 10);
    const timer11 = numDps.find((d) => d.dp === 11);
    if (timer10) result.dp_countdown_timer = 10;
    if (timer11) result.dp_countdown_left  = 11;

    return result;
  }

  async onPairListDevices() { return []; }
}

module.exports = AirConditionerDriver;
