/**
 * DP Discovery Script
 * Run: node discover-dps.js <ip> <deviceId> <localKey> [version]
 * Example: node discover-dps.js 10.160.13.148 abc123 0123456789abcdef 3.3
 */
'use strict';

const TuyAPI = require('tuyapi');

const [,, ip, deviceId, localKey, version = '3.3'] = process.argv;

if (!ip || !deviceId || !localKey) {
  console.log('Usage: node discover-dps.js <ip> <deviceId> <localKey> [version]');
  process.exit(1);
}

console.log(`Connecting to ${ip} (version ${version})…\n`);

const device = new TuyAPI({ id: deviceId, key: localKey, ip, version, issueGetOnConnect: true });

device.on('error', err => console.error('Error:', err.message));

device.on('connected', () => console.log('✓ Connected\n'));

device.on('data', data => {
  if (!data || !data.dps) return;
  console.log('──── DPS received ────');
  for (const [dp, val] of Object.entries(data.dps)) {
    const type = typeof val;
    console.log(`  DP ${String(dp).padStart(3)}: ${String(val).padEnd(20)}  (${type})`);
  }
  console.log();
});

device.on('disconnected', () => {
  console.log('Disconnected.');
  process.exit(0);
});

device.connect().catch(err => {
  console.error('Connection failed:', err.message);
  process.exit(1);
});

// Auto-exit after 15 seconds
setTimeout(() => {
  console.log('\nTimeout — disconnecting.');
  device.disconnect();
}, 15000);
