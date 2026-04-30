'use strict';

const Homey                     = require('homey');
const TuyAPI                    = require('tuyapi');
const { detectProtocolVersion } = require('../../lib/autoDetect');

class HumidifierDriver extends Homey.Driver {
  async onInit() {
    this.log('Humidifier driver initialized');

    this.homey.flow.getDeviceTriggerCard('humidifier_humidity_above')
      .registerRunListener(async (args, state) =>
        state.prevHumidity <= args.humidity && state.humidity > args.humidity
      );
    this.homey.flow.getDeviceTriggerCard('humidifier_humidity_below')
      .registerRunListener(async (args, state) =>
        state.prevHumidity >= args.humidity && state.humidity < args.humidity
      );

    this.homey.flow.getConditionCard('humidifier_device_is_connected')
      .registerRunListener(async (args) => args.device._conn?.connected === true);

    this.homey.flow.getConditionCard('humidifier_humidity_is_above')
      .registerRunListener(async (args) =>
        args.device.getCapabilityValue('measure_humidity') > args.humidity
      );
    this.homey.flow.getConditionCard('humidifier_humidity_is_below')
      .registerRunListener(async (args) =>
        args.device.getCapabilityValue('measure_humidity') < args.humidity
      );
    this.homey.flow.getConditionCard('humidifier_water_is_empty')
      .registerRunListener(async (args) =>
        args.device.getCapabilityValue('alarm_water') === true
      );

    this.homey.flow.getActionCard('humidifier_set_target_humidity')
      .registerRunListener(async (args) => {
        await args.device.setCapabilityValue('target_humidity', args.humidity);
        return args.device.triggerCapabilityListener('target_humidity', args.humidity);
      });
    this.homey.flow.getActionCard('humidifier_set_mode')
      .registerRunListener(async (args) => {
        await args.device.setCapabilityValue('mode', args.mode);
        return args.device.triggerCapabilityListener('mode', args.mode);
      });
    this.homey.flow.getActionCard('humidifier_set_fan_speed')
      .registerRunListener(async (args) => {
        await args.device.setCapabilityValue('fan_speed', args.fan_speed);
        return args.device.triggerCapabilityListener('fan_speed', args.fan_speed);
      });
    this.homey.flow.getActionCard('humidifier_force_reconnect')
      .registerRunListener(async (args) => args.device.forceReconnect());
    this.homey.flow.getActionCard('humidifier_refresh_device')
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
        name: this.homey.__('device.defaultName.humidifier'),
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
    const humDps  = [];
    const tempDps = [];
    const enumDps = [];

    for (const [dp, val] of Object.entries(dps)) {
      const num = parseInt(dp, 10);
      if (typeof val === 'boolean')                              boolDps.push({ dp: num, val });
      else if (typeof val === 'number' && val >= 0 && val <= 100) humDps.push({ dp: num, val });
      else if (typeof val === 'number' && val > 100 && val <= 600) tempDps.push({ dp: num, val });
      else if (typeof val === 'string')                          enumDps.push({ dp: num, val });
    }

    const dp_onoff = (boolDps.find((d) => d.dp === 1) || boolDps.find((d) => d.val === true) || boolDps[0])?.dp ?? 1;

    humDps.sort((a, b) => a.dp - b.dp);
    const targetEntry = humDps.find((d) => d.val % 5 === 0 && d.val >= 25 && d.val <= 80) || humDps.find((d) => d.val % 5 === 0) || humDps[0];
    const dp_target_humidity = targetEntry?.dp ?? 13;
    const currentEntry = humDps.find((d) => d.dp !== dp_target_humidity && d.val >= 20 && d.val <= 100) || humDps.find((d) => d.dp !== dp_target_humidity);
    const dp_current_humidity = currentEntry?.dp ?? 14;

    const KNOWN_MODES = ['auto', 'manual', 'normal', 'sleep', 'eco', 'boost', 'low', 'middle', 'high'];
    const modeEntry = enumDps.find((d) => KNOWN_MODES.includes(String(d.val).toLowerCase()));
    const dp_mode   = modeEntry?.dp ?? 24;

    const KNOWN_FAN   = ['low', 'high', 'medium', 'auto', 'turbo'];
    const fanEntry    = enumDps.find((d) => KNOWN_FAN.includes(String(d.val).toLowerCase()));
    const dp_fan_speed = fanEntry?.dp ?? 0;

    const timerEntry = enumDps.find((d) => String(d.val) === 'cancel' || /^\d+h$/.test(String(d.val)));
    const dp_countdown_timer = timerEntry?.dp ?? 0;

    const usedDps = new Set([dp_onoff, dp_target_humidity, dp_current_humidity, dp_mode, dp_fan_speed, dp_countdown_timer]);
    const tempEntry = tempDps.filter((d) => !usedDps.has(d.dp))[0];
    const dp_temperature = tempEntry?.dp ?? 0;

    return {
      dp_onoff, dp_mode, dp_current_humidity, dp_target_humidity,
      dp_fan_speed, dp_countdown_timer, dp_countdown_left: 0,
      dp_child_lock: 0, dp_water_empty: 0, dp_temperature, dp_anion: 0,
      mode_values:      'auto,manual,normal,sleep,eco,boost',
      fan_speed_values: 'low,medium,middle,high,auto',
    };
  }

  async onRepair(session, device) {
    session.setHandler('get_settings', async () => ({
      ip:        device.getSetting('ip')        || '',
      local_key: device.getSetting('local_key') || '',
      version:   device.getSetting('version')   || '3.3',
    }));

    session.setHandler('save_settings', async (data) => {
      const { ip, local_key, version } = data;
      if (!ip || !local_key) throw new Error(this.homey.__('pair.credentials.fillAll'));
      const net = require('net');
      if (!net.isIPv4(ip)) throw new Error(this.homey.__('pair.credentials.invalidIp'));
      if (local_key.length !== 16 && local_key.length !== 32)
        throw new Error(this.homey.__('pair.credentials.invalidKey'));

      let connected = false;
      let actualVersion = String(version);
      try {
        if (version === 'auto') {
          const result = await detectProtocolVersion({ ip, deviceId: device.getSetting('device_id'), localKey: local_key });
          actualVersion = result.version;
        } else {
          const testDev = new TuyAPI({ id: device.getSetting('device_id'), key: local_key, ip, version: actualVersion, issueGetOnConnect: true });
          testDev.on('error', () => {});
          await Promise.race([testDev.connect(), new Promise((_, rej) => setTimeout(() => rej(new Error('Timed out')), 8000))]);
          await new Promise((r) => setTimeout(r, 2000));
          testDev.disconnect();
        }
        connected = true;
      } catch (err) {
        this.log('Repair test failed:', err.message);
      }
      if (!connected) throw new Error(this.homey.__('pair.credentials.failed'));
      await device.setSettings({ ip, local_key, version: actualVersion });
      return { detectedVersion: actualVersion };
    });
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

module.exports = HumidifierDriver;
