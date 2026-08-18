'use strict';

// Tuya packed colour format: a 12-character hex string HHHHSSSSVVVV.
//   H: 0-360 (2 bytes), S: 0-1000 (2 bytes), V: 0-1000 (2 bytes)
// drivers/light/device.js carries a module-local copy of these two functions;
// it is one of the files awaiting the encoding repair and is deliberately not
// touched here. Fold its copy onto this module when that repair lands.

function parseColorHex(hex) {
  if (typeof hex !== 'string' || hex.length < 12) return null;
  const h = parseInt(hex.slice(0, 4), 16);
  const s = parseInt(hex.slice(4, 8), 16);
  const v = parseInt(hex.slice(8, 12), 16);
  if (Number.isNaN(h) || Number.isNaN(s) || Number.isNaN(v)) return null;
  return { h, s, v };
}

function buildColorHex(h, s, v) {
  const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, Math.round(n)));
  return clamp(h, 0, 360).toString(16).padStart(4, '0')
       + clamp(s, 0, 1000).toString(16).padStart(4, '0')
       + clamp(v, 0, 1000).toString(16).padStart(4, '0');
}

module.exports = { parseColorHex, buildColorHex };
