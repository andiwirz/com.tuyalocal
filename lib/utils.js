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

/**
 * Liest eine Werteliste, die eine Zuordnung tragen darf.
 *
 *   "cool,heat,auto"            -> jeder Wert steht fuer sich
 *   "cool=1,heat=4,auto=0"      -> Homey zeigt cool, das Geraet bekommt 1
 *
 * Manche Klimageraete fuehren Betriebsart und Luefterstufe als nummerierte
 * Auswahl: der Datenpunkt traegt "0" bis "4" und sonst nichts. Bisher musste in
 * der Einstellung stehen, was das Geraet schickt — dann stand im Waehler "0", und
 * wer "1,4,0,2,3" eintrug, bekam eine Absage, weil der aktuelle Wert "auto" darin
 * nicht vorkam. Mit der Zuordnung steht links, was man sieht, und rechts, was
 * gesendet wird.
 *
 * Ein Eintrag ohne Gleichheitszeichen bleibt, was er war — die alten Listen
 * funktionieren unveraendert weiter.
 *
 * @param {string} csv
 * @returns {Array<{id: string, roh: string}>}
 */
function leseWerteliste(csv) {
  return String(csv || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((eintrag) => {
      const i = eintrag.indexOf('=');
      if (i < 0) return { id: eintrag, roh: eintrag };
      return { id: eintrag.slice(0, i).trim(), roh: eintrag.slice(i + 1).trim() };
    })
    .filter((e) => e.id && e.roh);
}

/** Traegt die Liste eine Zuordnung, oder sind es blosse Werte? */
function hatZuordnung(csv) {
  return leseWerteliste(csv).some((e) => e.id !== e.roh);
}

/** Was das Geraet schickt -> was Homey zeigt. Unbekanntes bleibt, wie es kam. */
function rohZuId(csv, roh) {
  const t = leseWerteliste(csv).find((e) => e.roh === String(roh));
  return t ? t.id : String(roh);
}

/** Was Homey waehlt -> was das Geraet bekommt. */
function idZuRoh(csv, id) {
  const t = leseWerteliste(csv).find((e) => e.id === String(id));
  return t ? t.roh : String(id);
}

module.exports = { capitalize, fehlertext, leseWerteliste, hatZuordnung, rohZuId, idZuRoh };
