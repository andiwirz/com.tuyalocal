'use strict';

const Homey                     = require('homey');
const TuyAPI                    = require('tuyapi');
const { detectProtocolVersion } = require('../../lib/autoDetect');

class HeaterDriver extends Homey.Driver {
  async onInit() {
    this.log('Heater driver initialized');

    this.homey.flow.getConditionCard('heater_device_is_connected')
      .registerRunListener(async (args) => args.device._conn?.connected === true);

    this.homey.flow.getConditionCard('heater_fault_is_active')
      .registerRunListener(async (args) => args.device.getCapabilityValue('alarm_generic') === true);

    this.homey.flow.getConditionCard('heater_mode_is')
      .registerRunListener(async (args) =>
        args.device.getCapabilityValue('mode') === args.mode
      );

    this.homey.flow.getActionCard('heater_set_mode')
      .registerRunListener(async (args) => {
        if (!args.device.hasCapability('mode')) return;
        await args.device.setCapabilityValue('mode', args.mode);
        return args.device.triggerCapabilityListener('mode', args.mode);
      });

    this.homey.flow.getActionCard('heater_set_target_temp')
      .registerRunListener(async (args) => {
        await args.device.setCapabilityValue('target_temperature', args.temperature);
        return args.device.triggerCapabilityListener('target_temperature', args.temperature);
      });

    this.homey.flow.getActionCard('heater_set_child_lock')
      .registerRunListener(async (args) => {
        if (!args.device.hasCapability('child_lock')) return;
        const enabled = args.enabled === 'true';
        await args.device.setCapabilityValue('child_lock', enabled);
        return args.device.triggerCapabilityListener('child_lock', enabled);
      });

    this.homey.flow.getActionCard('heater_force_reconnect')
      .registerRunListener(async (args) => args.device.forceReconnect());

    this.homey.flow.getActionCard('heater_refresh_device')
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
        if (Object.keys(collectedDps).length > 0) detectedDps = this._detectDps(collectedDps);
      } catch (err) {
        this.log('Connection test failed:', err.message);
      }

      pendingDevice = {
        name: this.homey.__('device.defaultName.heater'),
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
    const boolDps = [];
    const intDps  = [];
    const enumDps = [];

    for (const [dp, val] of Object.entries(dps)) {
      const num = parseInt(dp, 10);
      if (typeof val === 'boolean')     boolDps.push({ dp: num, val });
      else if (typeof val === 'number') intDps.push({ dp: num, val });
      else if (typeof val === 'string') enumDps.push({ dp: num, val });
    }

    const dp_onoff = (boolDps.find((d) => d.dp === 1) || boolDps[0])?.dp ?? 1;

    // Temperatures: integers in typical range 50–500 (stored as 10× °C)
    //   or 5–45 if stored as direct °C
    const tempDps = intDps.filter((d) => d.dp !== dp_onoff && (
      (d.val >= 5 && d.val <= 45) ||
      (d.val >= 50 && d.val <= 450)
    ));
    tempDps.sort((a, b) => a.dp - b.dp);

    // DP 2 = target temp, DP 3 = current temp is the standard Tuya heater layout
    const targetEntry  = tempDps.find((d) => d.dp === 2) || tempDps[0];
    const currentEntry = tempDps.find((d) => d.dp === 3) || tempDps.find((d) => d.dp !== targetEntry?.dp) || tempDps[1];

    const dp_target_temp  = targetEntry?.dp  ?? 2;
    const dp_current_temp = currentEntry?.dp ?? 0;

    // Divisor: 1 if raw value is in normal range, 10 if ×10 encoded
    const rawTarget  = targetEntry?.val ?? 20;
    const temp_divisor = rawTarget > 45 ? 10 : 1;

    const KNOWN_MODES  = ['eco', 'comfort', 'boost', 'away', 'auto', 'low', 'high', 'sleep'];
    const modeEntry    = enumDps.find((d) => KNOWN_MODES.includes(String(d.val).toLowerCase()));
    const dp_mode      = modeEntry?.dp ?? 0;

    const timerEntry = enumDps.find((d) => String(d.val) === 'cancel' || /^\d+h$/.test(String(d.val)));
    const dp_countdown_timer = timerEntry?.dp ?? 0;

    const oscillateEntry = boolDps.find((d) => d.dp !== dp_onoff && d.dp > 1);
    const dp_oscillate   = oscillateEntry?.dp ?? 0;

    return {
      dp_onoff, dp_target_temp, dp_current_temp, dp_mode, dp_oscillate,
      dp_child_lock: 0, dp_fault: 0, dp_countdown_timer, dp_countdown_left: 0,
      temp_divisor,
      temp_min: 5, temp_max: 35, temp_step: 1,
      mode_values: 'eco,comfort,boost,away,auto',
    };
  }

  async _scanNetwork() {
    const dgram = require('dgram');
    const net   = require('net');
    const os    = require('os');
    const found = new Set();
    await new Promise((resolve) => {
      const sockets = [];
      for (const port of [6666, 6667]) {
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
      s.connect(6668, ip);
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

module.exports = HeaterDriver;
