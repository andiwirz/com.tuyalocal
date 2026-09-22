'use strict';

/**
 * Capitalize the first letter of a string and replace underscores with spaces.
 * Used for human-readable display of Tuya enum values (modes, presets, etc.).
 *
 * @param {string} s  — raw enum value, e.g. 'make_hot'
 * @returns {string}  — display label,  e.g. 'Make hot'
 */
function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, ' ');
}

/**
 * Der Text eines Fehlers, auch wenn gar kein Fehler kommt.
 *
 * TuyAPI meldet den Zeitablauf beim Warten auf eine Statusantwort als blanke
 * Zeichenkette: emit('error', 'Timeout waiting for status response from device id: …').
 * Wer darauf err.message liest, bekommt undefined — und genau das stand in einem
 * Bericht dreissigmal im Protokoll, direkt neben der Zeile, die denselben Zeitablauf
 * ausgeschrieben hat. Zwei Zeilen fuer ein Ereignis, eine davon leer.
 *
 * @param {*} err  Fehler, Zeichenkette oder was sonst am Ereignis haengt
 * @returns {string}
 */
function fehlertext(err) {
  if (err == null) return 'unknown error';
  if (typeof err === 'string') return err;
  return err.message || String(err);
}

module.exports = { capitalize, fehlertext };
