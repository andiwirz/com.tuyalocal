'use strict';

const net = require('net');

// Why a pairing attempt failed, in terms the person pairing can act on.
//
// The dialog used to say "connection failure, continue anyway?" and nothing else. That
// is the same sentence whether the address is wrong, the key is wrong, or the device
// does not offer local control at all — so the only visible knob, the protocol version
// dropdown, is the one people turn. A reporter with a face access panel worked through
// all five versions before concluding something was odd about the device. He was right,
// but the app had told him nothing.
//
// So the failure is diagnosed rather than reported. Every Tuya device that speaks the
// local protocol listens on TCP 6668; whether that port is open separates the causes
// cleanly, and it is one connect() to find out:
//
//   open        the device is there and offering local control, so what failed is the
//               Device ID, the Local Key or the protocol version — the case where
//               working through the versions is actually the right move
//   refused     something answers at that address but nothing is on 6668. No protocol
//               version can change that. Whole Tuya categories are cloud-only, locks
//               and access control among them
//   filtered    nothing answered in time: wrong address, a sleeping device, or a
//               firewall, guest network or VLAN between Homey and it
//   unreachable no route to the address at all
const TUYA_PORT       = 6668;
const PROBE_TIMEOUT_MS = 2500;

/**
 * @returns {Promise<'open'|'refused'|'filtered'|'unreachable'>}
 */
function probeTuyaPort(ip, timeoutMs = PROBE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let settled = false;
    const socket = new net.Socket();
    const done = (state) => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch (e) {}
      resolve(state);
    };
    socket.setTimeout(timeoutMs);
    socket.on('connect', () => done('open'));
    socket.on('timeout', () => done('filtered'));
    socket.on('error', (err) => done(err?.code === 'ECONNREFUSED' ? 'refused' : 'unreachable'));
    try { socket.connect(TUYA_PORT, ip); } catch (e) { done('unreachable'); }
  });
}

/**
 * A sentence explaining a failed pairing attempt, for the pairing dialog and the log.
 *
 * Never throws and never blocks pairing: a probe that goes wrong falls back to the
 * error text the attempt itself produced, which is what was shown before this existed.
 *
 * @param {object} opts
 * @param {string} opts.ip     address that was tried
 * @param {string} [opts.error] message from the failed connection attempt
 */
async function describeConnectFailure({ ip, error } = {}) {
  const detail = error ? ` (${error})` : '';
  let state;
  try {
    state = await probeTuyaPort(ip);
  } catch (e) {
    return `Could not connect to ${ip}${detail}`;
  }

  switch (state) {
    case 'open':
      return `${ip} is reachable and port ${TUYA_PORT} is open, so this device does offer `
        + 'local control. Check the Device ID and Local Key first, then try another '
        + `protocol version${detail}`;
    case 'refused':
      return `${ip} answers, but nothing is listening on port ${TUYA_PORT}, so this device `
        + 'is not offering Tuya local control. No protocol version will change that. Some '
        + 'categories are cloud-only — door locks and access panels most often — and a '
        + `device that has just restarted may need a minute${detail}`;
    case 'filtered':
      return `Nothing answered on port ${TUYA_PORT} at ${ip}. Check the address is the `
        + 'right one, that the device is powered and awake, and that it is on the same '
        + 'network as Homey — a guest network, a VLAN or an access-point firewall will '
        + `block this${detail}`;
    default:
      return `No route to ${ip}. Check the address${detail}`;
  }
}

module.exports = { describeConnectFailure, probeTuyaPort, TUYA_PORT };
