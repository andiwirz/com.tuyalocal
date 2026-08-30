'use strict';

// Tuya kennt zwei Farbformate, und welches gilt, haengt am Geraet.
//
//   12 Zeichen  HHHHSSSSVVVV        Farbton 0-360, Saettigung und Helligkeit 0-1000
//   14 Zeichen  RRGGBBHHHHSSVV      erst RGB, dann Farbton 0-360, dann 0-255 / 0-255
//
// Das zweite ist das aeltere und sitzt vor allem in Geraeten mit Protokoll 3.1/3.3.
// Wer ihm das kurze schickt, dessen Lampe liest die ersten sechs Zeichen als RGB - und
// die lauten bei jedem Farbton "00 xx 03":
//
//     120° -> 007803e803e8 -> R=0  G=120 B=3
//     240° -> 00f003e803e8 -> R=0  G=240 B=3
//
// Also gruen, immer, nur unterschiedlich hell. Genau so wurde es gemeldet: "es
// schaltet auf gruen und danach passiert nichts mehr".
//
// Erkannt wird am Geraet selbst: was es meldet, ist das, was es versteht. Die Laenge
// der gemeldeten Zeichenkette sagt es eindeutig, es muss also nichts geraten und nichts
// eingestellt werden.
//
// drivers/light/device.js fuehrt eine eigene Kopie dieser Funktionen; sie gehoert zu den
// Dateien, die auf die Kodierungs-Reparatur warten, und wird hier nicht angefasst.
// Beim Zusammenlegen faellt sie weg.

const FORMAT_KURZ = 12;
const FORMAT_LANG = 14;

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, Math.round(n)));

/** RGB aus Farbton/Saettigung/Helligkeit — nur fuer die ersten sechs Zeichen des langen
 *  Formats. Die Lampe rechnet ohnehin aus dem HSV-Teil; das RGB davor ist Beiwerk, muss
 *  aber stimmen, weil manche Firmware genau davon ausgeht. */
function hsvToRgb(h, s, v) {
  const sn = s / 1000;
  const vn = v / 1000;
  const c = vn * sn;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = vn - c;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x]
    : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [r, g, b].map((k) => clamp((k + m) * 255, 0, 255));
}

/**
 * Liest beide Formate. Rueckgabe immer in der langen Skala (0-360 / 0-1000 / 0-1000),
 * dazu das erkannte Format, damit der Aufrufer in derselben Sprache antworten kann.
 *
 * @returns {{h: number, s: number, v: number, format: number}|null}
 */
function parseColorHex(hex) {
  if (typeof hex !== 'string') return null;
  const t = hex.trim();

  if (t.length >= FORMAT_LANG) {
    // RRGGBB HHHH SS VV — die beiden letzten Werte laufen bis 255, nicht bis 1000.
    const h = parseInt(t.slice(6, 10), 16);
    const s = parseInt(t.slice(10, 12), 16);
    const v = parseInt(t.slice(12, 14), 16);
    if (!Number.isNaN(h) && !Number.isNaN(s) && !Number.isNaN(v)) {
      return {
        h,
        s: Math.round((s / 255) * 1000),
        v: Math.round((v / 255) * 1000),
        format: FORMAT_LANG,
      };
    }
    return null;
  }

  if (t.length >= FORMAT_KURZ) {
    const h = parseInt(t.slice(0, 4), 16);
    const s = parseInt(t.slice(4, 8), 16);
    const v = parseInt(t.slice(8, 12), 16);
    if (Number.isNaN(h) || Number.isNaN(s) || Number.isNaN(v)) return null;
    return { h, s, v, format: FORMAT_KURZ };
  }

  return null;
}

/**
 * Baut die Zeichenkette im verlangten Format.
 *
 * @param {number} h  Farbton 0-360
 * @param {number} s  Saettigung 0-1000
 * @param {number} v  Helligkeit 0-1000
 * @param {number} [format] 12 (Vorgabe) oder 14
 */
function buildColorHex(h, s, v, format = FORMAT_KURZ) {
  const hh = clamp(h, 0, 360);
  const ss = clamp(s, 0, 1000);
  const vv = clamp(v, 0, 1000);

  if (format === FORMAT_LANG) {
    const rgb = hsvToRgb(hh, ss, vv)
      .map((k) => k.toString(16).padStart(2, '0')).join('');
    return rgb
      + hh.toString(16).padStart(4, '0')
      + clamp((ss / 1000) * 255, 0, 255).toString(16).padStart(2, '0')
      + clamp((vv / 1000) * 255, 0, 255).toString(16).padStart(2, '0');
  }

  return hh.toString(16).padStart(4, '0')
       + ss.toString(16).padStart(4, '0')
       + vv.toString(16).padStart(4, '0');
}

module.exports = { parseColorHex, buildColorHex, FORMAT_KURZ, FORMAT_LANG };
