'use strict';

const Homey                     = require('homey');
const TuyAPI                    = require('tuyapi');
const { detectProtocolVersion } = require('../../lib/autoDetect');

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

    this.homey.flow.getConditionCard('fan_mode_is')
      .registerRunListener(async (args) =>
        args.device.getCapabilityValue('fan_mode') === args.mode
      );

    this.homey.flow.getConditionCard('fan_direction_is')
      .registerRunListener(async (args) =>
        args.device.getCapabilityValue('fan_direction') === args.direction
      );

    // ── Actions ─────────────────────────────────────────────────────────────
    this.homey.flow.getActionCard('fan_set_mode')
      .registerRunListener(async (args) => {
        if (!args.device.hasCapability('fan_mode')) return;
        await args.device.setCapabilityValue('fan_mode', args.mode);
        return args.device.triggerCapabilityListener('fan_mode', args.mode);
      });

    this.homey.flow.getActionCard('fan_set_fan_speed')
      .registerRunListener(async (args) => {
        if (!args.device.hasCapability('fan_speed')) return;
        await args.device.setCapabilityValue('fan_speed', args.fan_speed);
        return args.device.triggerCapabilityListener('fan_speed', args.fan_speed);
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

    this.homey.flow.getActionCard('fan_force_reconnect')
      .registerRunListener(async (args) => args.device.forceReconnect());

    this.homey.flow.getActionCard('fan_refresh_device')
      .registerRunListener(async (args) => args.device.pollNow());
  }

  async onPair(session) {
    let pendingDevice = null;
    let pendingRawDps = {};

    session.setHandler('scan_network', async () => this._scanNetwork());

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

      try {
        let rawDps;
        if (version === 'auto') {
          const result = await detectProtocolVersion({ ip, deviceId, localKey });
          actualVersion = result.version;
          rawDps        = result.dps;
        } else {
          const device = new TuyAPI({ id: deviceId, key: localKey, ip, version: actualVersion, issueGetOnConnect: true });
          device.on('error', () => {});
          const tmpDps = {};
          device.on('data', (payload) => { if (payload?.dps) Object.assign(tmpDps, payload.dps); });
          await Promise.race([
            device.connect(),
            new Promise((_, rej) => setTimeout(() => rej(new Error('Connection timed out')), 8000)),
          ]);
          await new Promise((resolve) => setTimeout(resolve, 4000));
          device.disconnect();
          rawDps = tmpDps;
        }
        Object.assign(collectedDps, rawDps);
        connected = true;
        if (Object.keys(collectedDps).length > 0) {
          detectedDps = this._detectDps(collectedDps);
        }
      } catch (err) {
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
    const speedEntry = intDps.find((d) => d.dp !== dp_onoff && d.val >= 1 && d.val <= 100);
    const dp_speed = speedEntry?.dp ?? 3;

    const KNOWN_FAN   = ['low', 'medium', 'middle', 'high', 'auto', 'turbo'];
    const fanEntry    = enumDps.find((d) => KNOWN_FAN.includes(String(d.val).toLowerCase()));
    const dp_fan_speed = fanEntry?.dp ?? 0;

    const KNOWN_MODES  = ['normal', 'sleep', 'nature', 'breeze', 'smart', 'natural'];
    const modeEntry    = enumDps.find((d) => KNOWN_MODES.includes(String(d.val).toLowerCase()));
    const dp_mode      = modeEntry?.dp ?? 0;

    // Direction: enum DP whose value is 'forward' or 'reverse'
    const KNOWN_DIR     = ['forward', 'reverse'];
    const dirEntry      = enumDps.find((d) => KNOWN_DIR.includes(String(d.val).toLowerCase()));
    const dp_direction  = dirEntry?.dp ?? 0;

    const timerEntry    = enumDps.find((d) => String(d.val) === 'cancel' || /^\d+h$/.test(String(d.val)));
    const dp_countdown_timer = timerEntry?.dp ?? 0;

    // Oscillation: a boolean DP that is not on/off
    const oscillateEntry = boolDps.find((d) => d.dp !== dp_onoff && d.dp > 1);
    const dp_oscillate   = oscillateEntry?.dp ?? 0;

    // Detect speed range
    const rawSpeed = speedEntry?.val ?? 1;
    const speed_min = 1;
    const speed_max = rawSpeed <= 6 ? 6 : rawSpeed <= 12 ? 12 : 100;

    return {
      dp_onoff, dp_speed, dp_fan_speed, dp_oscillate, dp_direction, dp_mode,
      dp_child_lock: 0, dp_countdown_timer, dp_countdown_left: 0,
      speed_min, speed_max,
      fan_speed_values: 'low,medium,high,auto,turbo',
      fan_mode_values:  'normal,sleep,nature,breeze,smart',
    };
  }

  async _scanNetwork() {
    const dgram = require('dgram');
    const net   = require('net');
    const os    = require('os');
    const UDP_PORTS = [6666, 6667];
    const TCP_PORT  = 6668;
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
        } catch (err) {}
      }
      setTimeout(() => { sockets.forEach((s) => { try { s.close(); } catch (e) {} }); resolve(); }, 6000);
    });
    const ipToInt = (ip) => ip.split('.').reduce((a, b) => ((a << 8) | parseInt(b, 10)) >>> 0, 0);
    const intToIp = (n)  => [24, 16, 8, 0].map((s) => (n >>> s) & 0xFF).join('.');
    const queue = [];
    for (const ifaces of Object.values(os.networkInterfaces())) {
      for (const addr of ifaces) {
        if (addr.family !== 'IPv4' || addr.internal) continue;
        const ipInt   = ipToInt(addr.address);
        const maskInt = ipToInt(addr.netmask || '255.255.255.0');
        const network   = (ipInt & maskInt) >>> 0;
        const broadcast = (network | (~maskInt >>> 0)) >>> 0;
        if ((broadcast - network - 1) > 2046) continue;
        for (let i = network + 1; i < broadcast; i++) queue.push(intToIp(i));
      }
    }
    const probeIp = (ip) => new Promise((resolve) => {
      const s = new net.Socket();
      s.setTimeout(600);
      s.on('connect', () => { s.destroy(); resolve(ip); });
      s.on('timeout', () => { s.destroy(); resolve(null); });
      s.on('error',   () => { resolve(null); });
      s.connect(TCP_PORT, ip);
    });
    for (let i = 0; i < queue.length; i += 50) {
      const results = await Promise.all(queue.slice(i, i + 50).map(probeIp));
      results.forEach((ip) => { if (ip) found.add(ip); });
    }
    const dns = require('dns');
    const ips = [...found];
    return Promise.all(ips.map(async (ip) => ({
      ip,
      hostname: await new Promise((r) => dns.reverse(ip, (e, h) => r(e || !h?.length ? null : h[0]))),
    })));
  }

  async onPairListDevices() { return []; }
}

module.exports = FanDriver;
