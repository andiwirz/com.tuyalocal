'use strict';

const Homey = require('homey');
const TuyAPI = require('tuyapi');

class DehumidifierDriver extends Homey.Driver {
  async onInit() {
    this.log('Dehumidifier driver initialized');

    // ── Conditions ──────────────────────────────────────────────────────────
    this.homey.flow.getConditionCard('humidity_is_above')
      .registerRunListener(async (args) =>
        args.device.getCapabilityValue('measure_humidity') > args.humidity
      );

    this.homey.flow.getConditionCard('humidity_is_below')
      .registerRunListener(async (args) =>
        args.device.getCapabilityValue('measure_humidity') < args.humidity
      );

    this.homey.flow.getConditionCard('water_tank_is_full')
      .registerRunListener(async (args) =>
        args.device.getCapabilityValue('alarm_water') === true
      );

    this.homey.flow.getConditionCard('mode_is')
      .registerRunListener(async (args) =>
        args.device.getCapabilityValue('mode') === args.mode
      );

    // ── Actions ─────────────────────────────────────────────────────────────
    this.homey.flow.getActionCard('set_target_humidity')
      .registerRunListener(async (args) => {
        await args.device.setCapabilityValue('target_humidity', args.humidity);
        return args.device.triggerCapabilityListener('target_humidity', args.humidity);
      });

    this.homey.flow.getActionCard('set_mode')
      .registerRunListener(async (args) => {
        await args.device.setCapabilityValue('mode', args.mode);
        return args.device.triggerCapabilityListener('mode', args.mode);
      });

    this.homey.flow.getActionCard('set_fan_speed')
      .registerRunListener(async (args) => {
        await args.device.setCapabilityValue('fan_speed', args.fan_speed);
        return args.device.triggerCapabilityListener('fan_speed', args.fan_speed);
      });

    this.homey.flow.getActionCard('set_timer')
      .registerRunListener(async (args) => {
        await args.device.setCapabilityValue('countdown_timer', args.timer);
        return args.device.triggerCapabilityListener('countdown_timer', args.timer);
      });

    this.homey.flow.getActionCard('set_child_lock')
      .registerRunListener(async (args) => {
        const enabled = args.enabled === 'true';
        await args.device.setCapabilityValue('child_lock', enabled);
        return args.device.triggerCapabilityListener('child_lock', enabled);
      });

    this.homey.flow.getActionCard('refresh_device')
      .registerRunListener(async (args) => {
        return args.device.pollNow();
      });

    this.homey.flow.getActionCard('force_reconnect')
      .registerRunListener(async (args) => {
        return args.device.forceReconnect();
      });

    // ── Conditions (new) ─────────────────────────────────────────────────────
    this.homey.flow.getConditionCard('device_is_connected')
      .registerRunListener(async (args) =>
        args.device._conn?.connected === true
      );
  }

  async onPair(session) {
    // Session-local state – safe when multiple pair sessions run in parallel
    let pendingDevice = null;
    let pendingRawDps = {};

    // ── Network scan: UDP broadcast + TCP fallback ───────────────────────────
    session.setHandler('scan_network', async () => {
      return this._scanNetwork();
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

      let connected    = false;
      let detectedDps  = null;
      const collectedDps = {};

      try {
        const device = new TuyAPI({
          id: deviceId,
          key: localKey,
          ip,
          version: String(version),
          issueGetOnConnect: true,
        });

        device.on('error', (err) => {
          this.log('Connection test error:', err.message);
        });
        device.on('data', (payload) => {
          if (payload && payload.dps) Object.assign(collectedDps, payload.dps);
        });

        await Promise.race([
          device.connect(),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Connection timed out')), 8000)
          ),
        ]);

        await new Promise((resolve) => setTimeout(resolve, 4000));
        device.disconnect();
        connected = true;

        if (Object.keys(collectedDps).length > 0) {
          detectedDps = this._detectDps(collectedDps);
          this.log('Detected DPs:', JSON.stringify(detectedDps));
        }
      } catch (err) {
        this.log('Connection test failed:', err.message);
      }

      pendingDevice = {
        name: `${this.homey.__('device.defaultName')} (${ip})`,
        data: { id: deviceId },
        settings: {
          ip,
          device_id: deviceId,
          local_key: localKey,
          version: String(version),
          ...(detectedDps || {}),
        },
      };

      pendingRawDps = collectedDps;

      return { connected, detectedDps };
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
    };
  }

  // Allow users to update IP / Local Key / Protocol after pairing without
  // having to remove and re-add the device.
  // Reuses the existing credentials view; intercepts its events to update
  // device settings instead of creating a new device.
  async onRepair(session, device) {
    session.setHandler('get_settings', async () => {
      return {
        ip:        device.getSetting('ip')        || '',
        local_key: device.getSetting('local_key') || '',
        version:   device.getSetting('version')   || '3.3',
      };
    });

    session.setHandler('save_settings', async (data) => {
      const { ip, local_key, version } = data;
      if (!ip || !local_key) throw new Error(this.homey.__('pair.credentials.fillAll'));

      const net = require('net');
      if (!net.isIPv4(ip)) throw new Error(this.homey.__('pair.credentials.invalidIp'));
      if (local_key.length !== 16 && local_key.length !== 32) {
        throw new Error(this.homey.__('pair.credentials.invalidKey'));
      }

      let connected = false;
      try {
        const testDev = new TuyAPI({
          id: device.getSetting('device_id'),
          key: local_key,
          ip,
          version: String(version),
          issueGetOnConnect: true,
        });
        testDev.on('error', () => {});
        await Promise.race([
          testDev.connect(),
          new Promise((_, rej) => setTimeout(() => rej(new Error('Connection timed out')), 8000)),
        ]);
        await new Promise((resolve) => setTimeout(resolve, 2000));
        testDev.disconnect();
        connected = true;
      } catch (err) {
        this.log('Repair connection test failed:', err.message);
      }

      if (connected) {
        await device.setSettings({ ip, local_key, version: String(version) });
      }

      return { connected };
    });
  }

  // Extracted so scan logic can be shared between onPair and onRepair
  async _scanNetwork() {
    const dgram = require('dgram');
    const net   = require('net');
    const os    = require('os');

    const UDP_PORTS       = [6666, 6667];
    const TCP_PORT        = 6668;
    const UDP_LISTEN_MS   = 6000;
    const TCP_TIMEOUT_MS  = 600;
    const TCP_CONCURRENCY = 50;

    const found = new Set();

    await new Promise((resolve) => {
      const sockets = [];
      for (const port of UDP_PORTS) {
        try {
          const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
          sock.on('message', (msg, rinfo) => { found.add(rinfo.address); });
          sock.on('error', () => {});
          sock.bind(port, () => { try { sock.setBroadcast(true); } catch (e) {} });
          sockets.push(sock);
        } catch (err) {
          this.log(`Could not bind UDP port ${port}:`, err.message);
        }
      }
      setTimeout(() => {
        sockets.forEach((s) => { try { s.close(); } catch (e) {} });
        resolve();
      }, UDP_LISTEN_MS);
    });

    const ipToInt = (ip) => ip.split('.').reduce((acc, b) => ((acc << 8) | parseInt(b, 10)) >>> 0, 0);
    const intToIp = (n)  => [24, 16, 8, 0].map((s) => (n >>> s) & 0xFF).join('.');
    const seenSubnets = new Set();
    const queue = [];
    const MAX_TCP_HOSTS = 2046;

    for (const ifaces of Object.values(os.networkInterfaces())) {
      for (const addr of ifaces) {
        if (addr.family !== 'IPv4' || addr.internal) continue;
        const ipInt   = ipToInt(addr.address);
        const maskInt = ipToInt(addr.netmask || '255.255.255.0');
        const network   = (ipInt & maskInt) >>> 0;
        const broadcast = (network | (~maskInt >>> 0)) >>> 0;
        const hostCount = broadcast - network - 1;
        if (seenSubnets.has(network)) continue;
        seenSubnets.add(network);
        if (hostCount > MAX_TCP_HOSTS) continue;
        for (let i = network + 1; i < broadcast; i++) queue.push(intToIp(i));
      }
    }

    const probeIp = (ip) => new Promise((resolve) => {
      const socket = new net.Socket();
      socket.setTimeout(TCP_TIMEOUT_MS);
      socket.on('connect', () => { socket.destroy(); resolve(ip); });
      socket.on('timeout', () => { socket.destroy(); resolve(null); });
      socket.on('error',   () => { resolve(null); });
      socket.connect(TCP_PORT, ip);
    });

    for (let i = 0; i < queue.length; i += TCP_CONCURRENCY) {
      const results = await Promise.all(queue.slice(i, i + TCP_CONCURRENCY).map(probeIp));
      results.forEach((ip) => { if (ip) found.add(ip); });
    }

    const dns = require('dns');
    const reverseLookup = (ip) => new Promise((resolve) => {
      dns.reverse(ip, (err, hostnames) =>
        resolve(!err && hostnames && hostnames.length ? hostnames[0] : null)
      );
    });

    const ips = [...found];
    return Promise.all(ips.map(async (ip) => ({ ip, hostname: await reverseLookup(ip) })));
  }

  // Fallback for older Homey versions
  async onPairListDevices() {
    return [];
  }
}

module.exports = DehumidifierDriver;
