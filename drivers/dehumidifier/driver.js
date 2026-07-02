'use strict';

const Homey                     = require('homey');
const TuyAPI                    = require('tuyapi');
const { setupCloudLookup } = require('../../lib/pairCloudLookup');
const { detectProtocolVersion } = require('../../lib/autoDetect');
const { scanNetwork }           = require('../../lib/networkScan');

class DehumidifierDriver extends Homey.Driver {
  async onInit() {
    this.log('Dehumidifier driver initialized');

    // ── Trigger run-listeners (threshold filtering) ──────────────────────────
    this.homey.flow.getDeviceTriggerCard('dehumidifier_humidity_above')
      .registerRunListener(async (args, state) =>
        state.prevHumidity <= args.humidity && state.humidity > args.humidity
      );

    this.homey.flow.getDeviceTriggerCard('dehumidifier_humidity_below')
      .registerRunListener(async (args, state) =>
        state.prevHumidity >= args.humidity && state.humidity < args.humidity
      );

    // ── Conditions ──────────────────────────────────────────────────────────
    this.homey.flow.getConditionCard('dehumidifier_humidity_is_above')
      .registerRunListener(async (args) =>
        args.device.getCapabilityValue('measure_humidity') > args.humidity
      );

    this.homey.flow.getConditionCard('dehumidifier_humidity_is_below')
      .registerRunListener(async (args) =>
        args.device.getCapabilityValue('measure_humidity') < args.humidity
      );

    this.homey.flow.getConditionCard('dehumidifier_water_tank_is_full')
      .registerRunListener(async (args) =>
        args.device.getCapabilityValue('alarm_water') === true
      );

    const cap = (v) => v.charAt(0).toUpperCase() + v.slice(1).replace(/_/g, ' ');
    const modeAC = async (query, args) => {
      const values = (args.device.getSetting('mode_values') || 'manual,laundry,auto,continuous,smart,sleep,drying')
        .split(',').map((s) => s.trim()).filter(Boolean);
      const q = query.toLowerCase();
      return values.filter((v) => v.toLowerCase().includes(q)).map((v) => ({ id: v, name: cap(v) }));
    };
    const fanAC = async (query, args) => {
      const values = (args.device.getSetting('fan_speed_values') || 'low,medium,high,auto')
        .split(',').map((s) => s.trim()).filter(Boolean);
      const q = query.toLowerCase();
      return values.filter((v) => v.toLowerCase().includes(q)).map((v) => ({ id: v, name: cap(v) }));
    };

    this.homey.flow.getConditionCard('dehumidifier_mode_is')
      .registerArgumentAutocompleteListener('mode', modeAC)
      .registerRunListener(async (args) =>
        args.device.getCapabilityValue('mode') === args.mode.id
      );

    // ── Actions ─────────────────────────────────────────────────────────────
    this.homey.flow.getActionCard('dehumidifier_set_target_humidity')
      .registerRunListener(async (args) => {
        await args.device.setCapabilityValue('target_humidity', args.humidity);
        return args.device.triggerCapabilityListener('target_humidity', args.humidity);
      });

    this.homey.flow.getActionCard('dehumidifier_set_mode')
      .registerArgumentAutocompleteListener('mode', modeAC)
      .registerRunListener(async (args) => {
        await args.device.setCapabilityValue('mode', args.mode.id);
        return args.device.triggerCapabilityListener('mode', args.mode.id);
      });

    this.homey.flow.getActionCard('dehumidifier_set_fan_speed')
      .registerArgumentAutocompleteListener('fan_speed', fanAC)
      .registerRunListener(async (args) => {
        await args.device.setCapabilityValue('fan_speed', args.fan_speed.id);
        return args.device.triggerCapabilityListener('fan_speed', args.fan_speed.id);
      });

    this.homey.flow.getActionCard('dehumidifier_set_timer')
      .registerRunListener(async (args) => {
        await args.device.setCapabilityValue('countdown_timer', args.timer);
        return args.device.triggerCapabilityListener('countdown_timer', args.timer);
      });

    this.homey.flow.getActionCard('dehumidifier_set_child_lock')
      .registerRunListener(async (args) => {
        const enabled = args.enabled === 'true';
        await args.device.setCapabilityValue('child_lock', enabled);
        return args.device.triggerCapabilityListener('child_lock', enabled);
      });

    this.homey.flow.getActionCard('dehumidifier_refresh_device')
      .registerRunListener(async (args) => {
        return args.device.pollNow();
      });

    this.homey.flow.getActionCard('dehumidifier_set_anion')
      .registerRunListener(async (args) => {
        if (!args.device.hasCapability('anion')) return;
        const enabled = args.enabled === 'true';
        await args.device.setCapabilityValue('anion', enabled);
        return args.device.triggerCapabilityListener('anion', enabled);
      });

    this.homey.flow.getActionCard('dehumidifier_force_reconnect')
      .registerRunListener(async (args) => {
        return args.device.forceReconnect();
      });

    // ── Conditions (new) ─────────────────────────────────────────────────────
    this.homey.flow.getConditionCard('dehumidifier_device_is_connected')
      .registerRunListener(async (args) =>
        args.device._conn?.connected === true
      );
  }

  async onPair(session) {
    setupCloudLookup(session, this.homey);
    let pendingDevice = null;
    let pendingRawDps = {};

    // ── Network scan: UDP broadcast + TCP fallback ───────────────────────────
    session.setHandler('scan_network', async () => {
      return scanNetwork(this.homey);
    });

    session.setHandler('credentials', async (data) => {
      const { ip, deviceId, localKey, version } = data;

      // Validate inputs before attempting a connection
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
        name: this.homey.__('device.defaultName.dehumidifier'),
        data: { id: deviceId },
        settings: {
          ip,
          device_id: deviceId,
          local_key: localKey,
          version:   actualVersion,
          ...(detectedDps || {}),
        },
      };

      pendingRawDps = collectedDps;

      return { connected, detectedVersion: actualVersion, detectedDps };
    });

    session.setHandler('list_devices', async () => {
      return pendingDevice ? [pendingDevice] : [];
    });

    session.setHandler('raw_dps', async () => {
      return pendingRawDps || {};
    });

    // Called by list_devices.html when the user edits the device name
    session.setHandler('set_device_name', async (name) => {
      if (pendingDevice && name && name.trim()) {
        pendingDevice.name = name.trim();
      }
    });
  }

  // Auto-detect DP mapping from a raw DPS snapshot
  _detectDps(dps) {
    const boolDps = [];
    const humDps  = [];
    const tempDps = [];
    const enumDps = [];

    for (const [dp, val] of Object.entries(dps)) {
      const num = parseInt(dp, 10);
      if (typeof val === 'boolean') {
        boolDps.push({ dp: num, val });
      } else if (typeof val === 'number' && val >= 0 && val <= 100) {
        humDps.push({ dp: num, val });
      } else if (typeof val === 'number' && val > 100 && val <= 600) {
        // Raw temperature values, e.g. 220 = 22.0 °C
        tempDps.push({ dp: num, val });
      } else if (typeof val === 'string') {
        enumDps.push({ dp: num, val });
      }
    }

    // On/Off: DP 1 if boolean, else a DP that is currently true, else any bool
    const onoffEntry = boolDps.find((d) => d.dp === 1)
      || boolDps.find((d) => d.val === true)
      || boolDps[0];
    const dp_onoff = onoffEntry ? onoffEntry.dp : 1;

    // Child lock: boolean DP that is currently false (locked = false on most devices),
    // explicitly not the on/off DP and not DP 1
    const childLockEntry = boolDps.find((d) => d.dp !== dp_onoff && d.dp !== 1 && d.val === false)
      || boolDps.find((d) => d.dp !== dp_onoff);
    const dp_child_lock = childLockEntry ? childLockEntry.dp : 14;

    const dp_water_full = 19;

    humDps.sort((a, b) => a.dp - b.dp);

    // Target humidity: divisible by 5 within typical setpoint range 25–80
    const targetEntry = humDps.find((d) => d.val % 5 === 0 && d.val >= 25 && d.val <= 80)
      || humDps.find((d) => d.val % 5 === 0)
      || humDps[0];
    const dp_target_humidity = targetEntry ? targetEntry.dp : 2;

    // Current humidity: different DP from target, within realistic ambient range
    const currentEntry = humDps.find((d) => d.dp !== dp_target_humidity && d.val >= 20 && d.val <= 100)
      || humDps.find((d) => d.dp !== dp_target_humidity);
    const dp_current_humidity = currentEntry ? currentEntry.dp : 16;

    // Mode: expanded known dehumidifier mode values
    const KNOWN_MODES = ['manual', 'laundry', 'auto', 'sleep', 'continuous', 'smart'];
    const modeEntry = enumDps.find((d) => KNOWN_MODES.includes(String(d.val).toLowerCase()));
    const dp_mode   = modeEntry ? modeEntry.dp : 4;

    // Fan speed: expanded known fan values
    const KNOWN_FAN  = ['low', 'high', 'medium', 'auto', 'turbo'];
    const fanEntry   = enumDps.find((d) => KNOWN_FAN.includes(String(d.val).toLowerCase()));
    const dp_fan_speed = fanEntry ? fanEntry.dp : 5;

    // Timer: 'cancel' or Xh pattern (e.g. '1h', '12h')
    const timerEntry = enumDps.find(
      (d) => String(d.val) === 'cancel' || /^\d+h$/.test(String(d.val))
    );
    const dp_countdown_timer = timerEntry ? timerEntry.dp : 17;

    const dp_countdown_left = 18;

    // Temperature: raw value 101–600 (e.g. 220 = 22.0 °C), prefer highest DP number
    // to avoid false positives from countdown timers (which also produce large numbers)
    const usedDps = new Set([dp_onoff, dp_child_lock, dp_target_humidity,
      dp_current_humidity, dp_mode, dp_fan_speed, dp_countdown_timer, dp_countdown_left, dp_water_full]);
    const tempEntry = tempDps.filter((d) => !usedDps.has(d.dp))[0];
    const dp_temperature = tempEntry ? tempEntry.dp : 0;

    return {
      dp_onoff, dp_mode, dp_child_lock, dp_countdown_left,
      dp_countdown_timer, dp_current_humidity, dp_target_humidity,
      dp_fan_speed, dp_water_full, dp_temperature,
      mode_values:      'manual,laundry,auto,continuous,smart,sleep,drying',
      fan_speed_values: 'low,medium,middle,high,auto,turbo',
    };
  }

  // Fallback for older Homey versions
  async onPairListDevices() {
    return [];
  }
}

module.exports = DehumidifierDriver;
