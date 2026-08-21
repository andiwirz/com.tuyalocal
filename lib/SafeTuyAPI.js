'use strict';

const TuyAPI = require('tuyapi');

// TuyAPI, with the one place it can take the whole app down closed off.
//
// The library guards parsing and turns a failure into an 'error' event, but the loop
// that runs afterwards calls _packetHandler(packet) outside that try/catch. Anything
// thrown in there escapes into the socket's own 'data' listener and becomes an
// uncaught exception — which does not fail one device, it stops the app, and every
// other device in it.
//
// It does throw. The parser documents a payload as Buffer | Object | String and also
// returns a bare `false` for an empty one, while the 3.4/3.5 key-exchange branch
// calls packet.payload.subarray(0, 16) on whatever turned up. Reproduced against the
// library with all four shapes: `false`, a decode-failure string such as "data format
// error", a parsed JSON object, and an empty buffer — the first three give exactly
// "packet.payload.subarray is not a function", the fourth trips over a null local key
// one line further down.
//
// A device gets there by answering the key exchange with something that is not key
// material: a wrong Local Key, a wrong device ID, or firmware that does not speak the
// version being tried. That last one is a state this app reaches on purpose — the
// reconnect logic rotates through protocol versions after five failures, and pairing's
// auto-detect walks the same list. So the crash sits at the end of a path the app
// takes by design, on any device that is not on 3.4 or 3.5.
//
// Subclassed rather than patched at each `new`, so every construction in this app is
// covered and exactly one place has to know about it.
const SESS_KEY_NEG_RES = 4;

class SafeTuyAPI extends TuyAPI {
  _packetHandler(packet) {
    try {
      return super._packetHandler(packet);
    } catch (err) {
      const wrapped = new Error(SafeTuyAPI._describe(packet, err));

      // Both, mirroring how the library itself reports the sibling failure a few
      // lines below the throw — an HMAC mismatch rejects the pending connect and
      // emits. Rejecting matters: without it the handshake never settles and the
      // caller waits out its own timeout for a failure that is already known.
      if (this.connectPromise) {
        this.connectPromise.reject(wrapped);
        delete this.connectPromise;
      }
      // Emitting on an EventEmitter with no 'error' listener throws, which would
      // trade one crash for another. Every caller here attaches one; this covers the
      // gap between construction and that call.
      if (this.listenerCount('error') > 0) this.emit('error', wrapped);
    }
    return undefined;
  }

  /** Says what the device did, because the raw TypeError names only our own variable. */
  static _describe(packet, err) {
    if (packet?.commandByte === SESS_KEY_NEG_RES) {
      return 'The device answered the 3.4/3.5 key exchange with something that is not a '
        + 'session key. Check the Local Key first; if it is correct, this device does not '
        + `speak the protocol version being tried (${err.message})`;
    }
    return `Malformed packet from device, command ${packet?.commandByte ?? 'unknown'} `
      + `(${err.message})`;
  }
}

module.exports = SafeTuyAPI;
