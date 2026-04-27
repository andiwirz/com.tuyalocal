'use strict';

const Homey                     = require('homey');
const TuyAPI                    = require('tuyapi');
const { detectProtocolVersion } = require('../../lib/autoDetect');

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
    // Session-local state
    let pendingDevice = null;
    let pendingRawDps = {};

    // ── Network scan ─────────────────────────────────────────────────────────
    session.setHandler('scan_network', async () => {
      return this._scanNetwork();
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
          await new Promise((resolve) => setTimeout(resolve, 4000));
          device.disconnect();
          rawDps = tmpDps;
        }
        Object.assign(collectedDps, rawDps);
        connected = true;
      } catch (err) {
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

  // Allow users to update IP / Local Key / Protocol after pairing
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
      if (!ip || !local_key) throw new Error(this.homey.__('pair.credentials.fillAll') || 'Please fill all fields');

      const net = require('net');
      if (!net.isIPv4(ip)) throw new Error(this.homey.__('pair.credentials.invalidIp') || 'Invalid IP address');
      if (local_key.length !== 16 && local_key.length !== 32) {
        throw new Error(this.homey.__('pair.credentials.invalidKey') || 'Invalid local key length');
      }

      let connected     = false;
      let actualVersion = String(version);
      try {
        if (version === 'auto') {
          const result = await detectProtocolVersion({ ip, deviceId: device.getSetting('device_id'), localKey: local_key });
          actualVersion = result.version;
          this.log(`Repair: auto-detected protocol version: ${actualVersion}`);
        } else {
          const testDev = new TuyAPI({
            id: device.getSetting('device_id'),
            key: local_key, ip,
            version: actualVersion,
            issueGetOnConnect: true,
          });
          testDev.on('error', (err) => { this.log('Repair test error:', err.message); });
          await Promise.race([
            testDev.connect(),
            new Promise((_, rej) => setTimeout(() => rej(new Error('Connection timed out')), 8000)),
          ]);
          await new Promise((resolve) => setTimeout(resolve, 2000));
          testDev.disconnect();
        }
        connected = true;
      } catch (err) {
        this.log('Repair connection test failed:', err.message);
      }

      if (!connected) {
        throw new Error(this.homey.__('pair.credentials.failed'));
      }
      await device.setSettings({ ip, local_key, version: actualVersion });
      return { detectedVersion: actualVersion };
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

module.exports = GenericDriver;
