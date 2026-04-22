'use strict';

const Homey = require('homey');
const TuyAPI = require('tuyapi');

class SmartPlugDriver extends Homey.Driver {
  async onInit() {
    this.log('Smart Plug driver initialized');

    // ── Conditions ──────────────────────────────────────────────────────────
    this.homey.flow.getConditionCard('plug_device_is_connected')
      .registerRunListener(async (args) =>
        args.device._conn?.connected === true
      );

    this.homey.flow.getConditionCard('plug_alarm_active')
      .registerRunListener(async (args) =>
        args.device.getCapabilityValue('alarm_generic') === true
      );

    // ── Trigger run-listeners (threshold filtering) ──────────────────────────
    this.homey.flow.getDeviceTriggerCard('plug_power_above')
      .registerRunListener(async (args, state) =>
        state.prevPower <= args.power && state.power > args.power
      );

    this.homey.flow.getDeviceTriggerCard('plug_power_below')
      .registerRunListener(async (args, state) =>
        state.prevPower >= args.power && state.power < args.power
      );

    // ── Conditions ──────────────────────────────────────────────────────────
    this.homey.flow.getConditionCard('plug_power_is_above')
      .registerRunListener(async (args) =>
        (args.device.getCapabilityValue('measure_power') ?? 0) > args.power
      );

    // ── Actions ─────────────────────────────────────────────────────────────
    this.homey.flow.getActionCard('plug_force_reconnect')
      .registerRunListener(async (args) => {
        return args.device.forceReconnect();
      });

    this.homey.flow.getActionCard('plug_refresh_device')
      .registerRunListener(async (args) => {
        return args.device.pollNow();
      });

    this.homey.flow.getActionCard('plug_set_countdown')
      .registerRunListener(async (args) => {
        return args.device.setCountdown(args.seconds);
      });
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
        name: this.homey.__('device.defaultName.smart_plug'),
        data: { id: deviceId },
        settings: {
          ip,
          device_id:       deviceId,
          local_key:       localKey,
          version:         String(version),
          power_scale:     'auto',
          polling_interval: 30,
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
    const result = {
      dp_switch:        1,
      dp_power:         19,
      dp_voltage:       20,
      dp_current:       18,
      dp_energy:        17,
      dp_fault:         0,   // disabled by default
      dp_relay_status:  0,   // disabled by default
      dp_power_factor:  0,   // disabled by default
      dp_countdown:     0,   // disabled by default
    };

    // Collect all boolean DPs first, then prefer DP 1 — the Tuya spec
    // assigns on/off to DP 1 in the vast majority of devices.
    const boolDps = Object.entries(dps)
      .filter(([, v]) => typeof v === 'boolean')
      .map(([k]) => parseInt(k, 10));
    if (boolDps.length > 0) {
      result.dp_switch = boolDps.includes(1) ? 1 : boolDps[0];
    }

    for (const [dpStr, val] of Object.entries(dps)) {
      const dp = parseInt(dpStr, 10);
      if (typeof val === 'boolean') {
        // Already handled above — skip
      } else if (typeof val === 'number') {
        // Countdown timer: DP 9, integer seconds (0 = inactive)
        if (dp === 9) result.dp_countdown = dp;
        // Voltage: raw value 1000–2800 (= 100–280 V × 0.1)
        else if (val >= 1000 && val <= 2800) result.dp_voltage = dp;
        // Energy (cumulative, typically small number, DP 17 by convention)
        else if (dp === 17) result.dp_energy = dp;
        // Current (typically 0 when off, DP 18 by convention)
        else if (dp === 18) result.dp_current = dp;
        // Power (typically 0 when off, DP 19 by convention)
        else if (dp === 19) result.dp_power = dp;
        // Power factor (0–100 %, typically DP 21)
        else if (dp === 21 && val >= 0 && val <= 100) result.dp_power_factor = dp;
        // Fault bitmap (0 when no fault, typically DP 26)
        else if (dp === 26 && val === 0) result.dp_fault = dp;
      } else if (typeof val === 'string') {
        // Relay status enum
        if (['on', 'off', 'memory'].includes(val)) result.dp_relay_status = dp;
      }
    }
    return result;
  }

  // Allow users to update IP / Local Key / Protocol after pairing without
  // having to remove and re-add the device.
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

module.exports = SmartPlugDriver;
