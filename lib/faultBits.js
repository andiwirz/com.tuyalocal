'use strict';

/**
 * Turns a Tuya fault register into something a person can read.
 *
 * Most devices report faults as a bitmap packed into one integer DP: the pet
 * feeder's DP 14 uses 1 = no food, 2 = jammed, 4 = feed timeout, 8 = battery low,
 * so a value of 5 means the hopper is empty *and* a feed timed out. Collapsing
 * that to a single "fault" alarm — which is all the app used to do — throws away
 * the only part the user actually needs: a notification saying "Störung" gives
 * them nothing to act on, while "no food" sends them to the hopper.
 *
 * The bit labels are device specific and Tuya does not standardise them, so they
 * are not guessed here. They come from the manufacturer's own specification (a
 * bitmap DP declares one label per bit) and are stored per device during pairing.
 * Where no labels are known the raw value is reported as a code, which is honest
 * and still more use than a bare boolean.
 */

/**
 * @param {number|string|boolean} value  The fault DP's raw value.
 * @param {string} [labelsCsv]  Bit labels in bit order, lowest bit first, as
 *   stored in the driver's fault_bits setting. Empty entries are allowed for bits
 *   the manufacturer left unnamed.
 * @returns {{ active: boolean, code: number, bits: string[], text: string }}
 *   `active` is whether anything is wrong at all, `bits` the names of the set
 *   bits, and `text` a ready-to-display summary.
 */
function decodeFaultBits(value, labelsCsv) {
  // Some firmwares report the register as a boolean rather than a number. There
  // is no bit information in that case, only "yes" or "no".
  if (typeof value === 'boolean') {
    return { active: value, code: value ? 1 : 0, bits: [], text: value ? 'fault' : 'ok' };
  }

  const code = Number(value);
  if (!Number.isFinite(code)) {
    return { active: false, code: 0, bits: [], text: 'ok' };
  }
  // A negative or fractional reading is not a bitmap; treat it as a plain fault
  // indication rather than pretending to decode it.
  if (code <= 0 || !Number.isInteger(code)) {
    return { active: code !== 0, code, bits: [], text: code === 0 ? 'ok' : `code ${code}` };
  }

  const labels = String(labelsCsv || '')
    .split(',')
    .map((s) => s.trim());

  const bits = [];
  const unnamed = [];
  // 32 bits is well past anything Tuya declares, and stops a nonsense reading
  // from spinning here.
  for (let i = 0; i < 32; i++) {
    if ((code & (1 << i)) === 0) continue;
    const label = labels[i];
    if (label) bits.push(label);
    else unnamed.push(i);
  }

  // Two conventions, chosen for what the reader can do with them. As soon as one
  // bit has a name, the set bits are listed individually, and the ones we cannot
  // name are given by position so they are not silently dropped. If nothing is
  // named, the whole register is reported as a code instead — that is the form
  // device manuals print, so it is the one worth looking up.
  let text;
  if (bits.length > 0) {
    text = bits.join(', ');
    if (unnamed.length > 0) text += `, bit ${unnamed.join(', bit ')}`;
  } else {
    text = `code ${code}`;
  }

  return { active: true, code, bits, text };
}

module.exports = { decodeFaultBits };
