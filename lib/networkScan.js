'use strict';

// Shared network scan utility used by all driver pairing flows.
async function scanNetwork(homey) {
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
        if (homey) homey.app?.addLog?.('networkScan', `Could not bind UDP port ${port}: ${err.message}`, 'warn');
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

module.exports = { scanNetwork };
