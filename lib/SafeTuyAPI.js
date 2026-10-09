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

// Command numbers by name, for the connection trace. 3, 4 and 5 carry two names in
// the library; on a LAN connection they are the 3.4/3.5 key exchange, so those win.
const { CommandType } = require('tuyapi/lib/message-parser');
const BEFEHLSNAME = {};
for (const [name, nr] of Object.entries(CommandType)) BEFEHLSNAME[nr] = name;
Object.assign(BEFEHLSNAME, { 3: 'SESS_KEY_NEG_START', 4: 'SESS_KEY_NEG_RES', 5: 'SESS_KEY_NEG_FINISH' });

// Fields every payload carries and no trace line needs — two of them are the device ID.
const RAUSCHEN = new Set(['gwId', 'devId', 'uid', 't']);

class SafeTuyAPI extends TuyAPI {
  /**
   * @param {Object} options  As TuyAPI's, plus:
   * @param {number} [options.spurMs]  Record every frame sent and received during this
   *   many milliseconds after each new connection, as 'trace' events. 0 or absent: off.
   */
  constructor(options = {}) {
    super(options);
    this._spurMs     = Number(options.spurMs) > 0 ? Number(options.spurMs) : 0;
    this._spurBeginn = null;
    this._controlUid = options.controlUid === true;
    // First the command format, then the trace around it: the trace then records
    // the frame as it actually goes out.
    this._installiereUntergeraetFormat();
    if (this._controlUid) this._installiereBefehlsformat();
    if (this._spurMs > 0) this._installiereSpur();
  }

  // ── Commands for a sub-device on 3.4 and 3.5 ──────────────────────────────
  //
  // A command for a device behind a gateway carries that device's cid. On 3.4 and 3.5
  // the library puts it inside data: {data: {ctype: 0, cid, dps}, protocol: 5, t}.
  // tinytuya, which a good many people drive these gateways with, sends the same and
  // repeats cid at the top level (read in its source, generate_payload). Repeated here
  // too, so the frame matches that implementation instead of differing from it in the
  // one field that says who the command is for. Frames without a cid in data - every
  // command to an ordinary device - pass untouched.

  _installiereUntergeraetFormat() {
    const parser = this.device?.parser;
    if (!parser || typeof parser.encode !== 'function') return;
    const encode = parser.encode.bind(parser);
    parser.encode = (opts) => {
      const d = opts?.data;
      if (opts?.commandByte === CommandType.CONTROL_NEW && d && typeof d === 'object'
          && !Buffer.isBuffer(d) && d.data && typeof d.data === 'object' && d.data.cid
          && d.cid === undefined) {
        return encode({ ...opts, data: { ...d, cid: d.data.cid } });
      }
      return encode(opts);
    };
  }

  // ── The alternative command format ────────────────────────────────────────
  //
  // Reported with an outdoor plug on 3.3 that answered every status request and
  // acknowledged every ON/OFF within 50 ms - and switched nothing. The one
  // difference between what it honoured and what it ignored was the payload:
  //
  //   status request (TuyAPI): {gwId, devId, t: "1760...", dps: {}, uid: <device id>}
  //   command        (TuyAPI): {devId, gwId, uid: "", t: 1760..., dps: {...}}
  //   command   (tinytuya and localtuya alike): {devId, uid: <device id>, t: "1760...", dps}
  //
  // The library this app is built on is the odd one out. Most firmware accepts both;
  // a firmware that checks uid would behave exactly like that plug. So, when asked
  // for, a 3.1-3.3 command goes out the way tinytuya and localtuya send it. 3.4 and
  // 3.5 use CONTROL_NEW with a different payload and are not touched.
  //
  // Nor is a command for a sub-device behind a gateway. The library sends it as
  // {t, dps, cid}, without devId and uid - which is also how tinytuya addresses one.
  // Rewritten, it would carry the gateway's own id as devId and uid, so the gateway
  // could take the command as its own.

  _installiereBefehlsformat() {
    const parser = this.device?.parser;
    if (!parser || typeof parser.encode !== 'function') return;
    const encode = parser.encode.bind(parser);
    parser.encode = (opts) => {
      const d = opts?.data;
      if (opts?.commandByte === CommandType.CONTROL && d && typeof d === 'object'
          && !Buffer.isBuffer(d) && d.dps && typeof d.dps === 'object' && !d.cid) {
        const id = d.devId || this.device?.id;
        const neu = { devId: id, uid: id, t: String(d.t ?? Math.round(Date.now() / 1000)), dps: d.dps };
        return encode({ ...opts, data: neu });
      }
      return encode(opts);
    };
  }

  // ── The connection trace ──────────────────────────────────────────────────
  //
  // Reported with a pet feeder that dispensed food in the seconds after the app
  // connected — twice, each about a second after the FIRST frame of its kind on the
  // new connection, never after a later one. A log of what we asked and what it
  // answered could not tell which frame it was, because nothing recorded frames.
  //
  // Hooked into the parser rather than the socket: encode() still has the payload in
  // plain text and parse() already has it decrypted, so a line can say what was sent
  // and what came back, not just how many bytes. The one thing this misses is a frame
  // built but never sent — on 3.2, get() encodes a query and then skips it.

  _installiereSpur() {
    const parser = this.device?.parser;
    if (!parser || typeof parser.encode !== 'function' || typeof parser.parse !== 'function') return;

    const encode = parser.encode.bind(parser);
    parser.encode = (opts) => {
      // Read BEFORE encoding: encode() replaces opts.data with the encrypted buffer,
      // and afterwards all a line could say is how many bytes it was.
      let zeile = null;
      if (this._inSpur()) {
        try {
          const inhalt = SafeTuyAPI._kurz(opts?.data);
          zeile = `→ ${SafeTuyAPI._befehl(opts?.commandByte)} seq ${opts?.sequenceN ?? '?'}`
            + (inhalt ? `: ${inhalt}` : '');
        } catch (_) { /* a trace line must never cost a frame */ }
      }
      const ergebnis = encode(opts);
      if (zeile !== null) { try { this._spur(zeile); } catch (_) { /* as above */ } }
      return ergebnis;
    };

    // The device's return code - 0 for "taken", anything else for "refused". The
    // library reads it to find the payload and then drops it, so a trace showed an
    // acknowledgement without saying whether it was a yes. Read here per frame, with
    // the library's own test for whether those four bytes are a return code at all.
    if (typeof parser.parsePacket === 'function') {
      const parsePacket = parser.parsePacket.bind(parser);
      parser.parsePacket = (buffer) => {
        const paket = parsePacket(buffer);
        try {
          if (paket && typeof paket === 'object' && Buffer.isBuffer(buffer) && buffer.length >= 20
              && buffer.readUInt32BE(0) === 0x000055aa) {
            const rc = buffer.readUInt32BE(16);
            if ((rc & 0xFFFFFF00) === 0) paket._rueckgabecode = rc;
          }
        } catch (_) { /* a trace detail must never cost a frame */ }
        return paket;
      };
    }

    const parse = parser.parse.bind(parser);
    parser.parse = (buffer) => {
      let pakete;
      try {
        pakete = parse(buffer);
      } catch (err) {
        if (this._inSpur()) {
          try { this._spur(`← unreadable frame, ${SafeTuyAPI._kopf(buffer)}: ${err?.message || err}`); } catch (_) {}
        }
        throw err;
      }
      if (this._inSpur()) {
        for (const p of Array.isArray(pakete) ? pakete : []) {
          try {
            const inhalt = SafeTuyAPI._kurz(p?.payload);
            const rc = p?._rueckgabecode;
            this._spur(`← ${SafeTuyAPI._befehl(p?.commandByte)} seq ${p?.sequenceN ?? '?'}`
              + (rc !== undefined ? `, return code ${rc}` : '')
              + (inhalt ? `: ${inhalt}` : ''));
          } catch (_) { /* as above */ }
        }
      }
      return pakete;
    };
  }

  /**
   * A new connection starts the window — not every call: the library calls connect()
   * before each command and returns at once when the socket is already up.
   */
  connect() {
    if (this._spurMs > 0 && !this.isConnected() && !this.connectPromise) {
      this._spurBeginn = Date.now();
      this._spur(`Trace: recording every frame of the first ${Math.round(this._spurMs / 1000)} s `
        + `of this connection (protocol ${this.device?.version ?? '?'}`
        + `${this._controlUid ? ', alternative command format' : ''})`);
    }
    return super.connect();
  }

  _inSpur() {
    return this._spurMs > 0 && this._spurBeginn !== null
      && Date.now() - this._spurBeginn <= this._spurMs;
  }

  _spur(text) {
    const s = this._spurBeginn === null ? 0 : (Date.now() - this._spurBeginn) / 1000;
    this.emit('trace', `Trace +${s.toFixed(2)} s ${text}`);
  }

  static _befehl(nr) {
    return BEFEHLSNAME[nr] ? `${BEFEHLSNAME[nr]} (${nr})` : `command ${nr}`;
  }

  /** What a payload says, in one short phrase — DPs with their values where it has any. */
  static _kurz(wert) {
    if (wert === undefined || wert === false) return '';
    if (wert === null) return 'null';
    if (Buffer.isBuffer(wert)) return wert.length ? `${wert.length} bytes` : '';
    if (typeof wert === 'string') return JSON.stringify(wert.length > 80 ? `${wert.slice(0, 80)}…` : wert);
    if (typeof wert !== 'object') return String(wert);
    const dps = wert.dps ?? wert.data?.dps;
    const cid = wert.cid ?? wert.data?.cid;
    if (dps && typeof dps === 'object') {
      const teile = Object.entries(dps).map(([k, v]) => `${k}=${SafeTuyAPI._wert(v)}`);
      return `dps {${teile.join(', ')}}${cid ? ' (sub-device)' : ''}`;
    }
    // Without DPs only the field names are shown, never their values — which is what
    // keeps the device ID out, not RAUSCHEN; that only keeps the line short. The one
    // value worth having is a refresh's DP list: which DPs it asked the device for.
    const felder = Object.keys(wert).filter((k) => !RAUSCHEN.has(k))
      .map((k) => (k === 'dpId' && Array.isArray(wert.dpId) ? `dpId [${wert.dpId.join(',')}]` : k));
    return felder.length ? `{${felder.join(', ')}}` : '{}';
  }

  static _wert(v) {
    if (v === null) return 'null';
    if (typeof v === 'string') return JSON.stringify(v.length > 24 ? `${v.slice(0, 24)}…` : v);
    if (typeof v === 'object') return '{…}';
    return String(v);
  }

  /** The header of a frame that could not be parsed — its command number, if it has one. */
  static _kopf(buffer) {
    if (!Buffer.isBuffer(buffer)) return 'no data';
    const hex = buffer.subarray(0, 16).toString('hex').replace(/(.{8})(?=.)/g, '$1 ');
    let befehl = '';
    if (buffer.length >= 12 && buffer.readUInt32BE(0) === 0x000055aa) {
      befehl = `, ${SafeTuyAPI._befehl(buffer.readUInt32BE(8))}`;
    } else if (buffer.length >= 14 && buffer.readUInt32BE(0) === 0x00006699) {
      befehl = `, ${SafeTuyAPI._befehl(buffer.readUInt32BE(10))}`;
    }
    return `${buffer.length} bytes${befehl}, header ${hex}`;
  }
  /**
   * A status request is never turned into a write here.
   *
   * The library does exactly that when a device answers a request in a way it does
   * not like: get() on "data format error" or "json obj data unvalid", refresh() on
   * the latter, and both then call set() with every requested DP set to null, "to
   * get data". That is a control command, sent without anyone having asked for one,
   * to devices this app drives — pet feeders, locks, garage doors. What a firmware
   * does with null on its feed or open DP is up to the firmware.
   *
   * refresh() makes it worse: it passes its DP list as an array, and set() turns that
   * into a single key, "4,5,6,18,19,20". A firmware that reads the key with atoi()
   * sees DP 4.
   *
   * Recognised by its exact shape: set: null with isSetCallToGetData passed in. The
   * library sets that flag itself only after this point, and nothing in this app
   * passes it. Protocol 3.2 keeps it, because there it is not a fallback but the way
   * reads work at all — get() skips the query entirely and goes straight here.
   *
   * Resolves without data instead of sending. Nothing is lost: a device that does not
   * answer status requests reports through its own pushes, which this app reads
   * anyway. The 'read-write-refused' event says it happened, for the log.
   */
  set(options) {
    if (SafeTuyAPI._istLeseRueckfall(options) && String(this.device?.version) !== '3.2') {
      const dps = Array.isArray(options.dps) ? options.dps : [options.dps ?? 1];
      this.emit('read-write-refused', { dps, version: String(this.device?.version) });
      return Promise.resolve(undefined);
    }
    return super.set(options);
  }

  static _istLeseRueckfall(options) {
    return !!options && options.isSetCallToGetData === true && options.set === null
      && options.multiple !== true;
  }

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
