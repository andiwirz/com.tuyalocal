'use strict';

/**
 * Die Huelle eines Tuya-IR-Codes — und nur sie.
 *
 * Ein angelernter Code ist base64 ueber eine Folge von 16-Bit-Zahlen, klein zuerst,
 * jede eine Dauer in Mikrosekunden; abwechselnd Puls und Pause, Puls voran. Was in
 * diesen Dauern steht — NEC, RC5, Sony —, steht hier nicht zur Debatte: der Blaster
 * gibt wieder, was er aufgenommen hat, und dazu muss niemand das Protokoll kennen.
 *
 * Zwei Dinge kann man aber ohne Protokollwissen sagen, und beide sind es wert:
 *
 *   1. Ob die Aufnahme ueberhaupt heil ist. Ein schwaches Signal, eine halb
 *      gedrueckte Taste oder muede Batterien in der Fernbedienung liefern einen
 *      Torso, der sich speichern laesst und nie funktioniert. Besser, das beim
 *      Anlernen zu sagen als den Benutzer in drei Wochen raten zu lassen.
 *
 *   2. Wie sie aussieht. Die Zeitklassen einer Aufnahme verraten die Bauart auch
 *      ohne Decoder: zwei Klassen im Verhaeltnis 1:2 sind Manchester, also RC5 oder
 *      RC6; ein langer Vorlauf und danach zwei kurze Klassen sind NEC. In einem
 *      Fehlerbericht ist das der Unterschied zwischen "geht nicht" und einer Spur.
 *
 * Die Regel, wann zwei Dauern dieselbe Klasse sind, ist von ClusterM/localtuya_rc
 * uebernommen (in_range, MAX_ERROR_PERCENT = 25).
 */

// Kleiner geht keine Aufnahme durch. Vier Werte sind zwei Puls-Pause-Paare - alles
// darunter kann kein Protokoll der Welt sein, und tinytuya bricht daran ebenfalls ab.
const MIN_WERTE = 4;

// Ab hier wird es nur noch verdaechtig, nicht unmoeglich. Die kuerzesten
// gebraeuchlichen Rahmen - Sony mit zwoelf Bit - kommen auf rund 25 Werte; darunter
// ist eine Aufnahme wahrscheinlich abgeschnitten, aber eben nicht sicher.
const KNAPP_WERTE  = 16;
const KNAPP_DAUER  = 10;   // ms

// Zwei Dauern gehoeren zur selben Klasse, solange sie sich um weniger als das
// unterscheiden.
const KLASSEN_TOLERANZ = 0.25;

// Mehr Klassen als das sagen nichts mehr - eine verrauschte Aufnahme haette sonst
// vierzig davon, und die Zeile im Protokoll waere unlesbar.
const MAX_KLASSEN = 6;

/**
 * Liest die Dauern aus einem Code.
 *
 * @param {string} code  Der Code, wie er angelernt oder eingefuegt wurde.
 * @returns {{pulse: number[]|null, fehler: string|null, warnung: string|null}}
 *   `fehler` gesetzt heisst: das ist keine brauchbare Aufnahme. `warnung` gesetzt
 *   heisst: sie ist es vermutlich, aber ungewoehnlich kurz.
 */
function lesePulse(code) {
  const sauber = String(code == null ? '' : code).replace(/\s+/g, '');
  if (!sauber) return { pulse: null, fehler: 'the code is empty', warnung: null };

  // Das Formatzeichen vor einem Code ist nicht Teil der Daten. Angelernte Codes
  // kommen ohne, aber ein anderswo abgeschriebener traegt es oft mit - dieselbe
  // Regel wie in der Quellimplementierung: bei dieser Restlaenge ist das erste
  // Zeichen keines der Nutzdaten.
  const kern = sauber.length % 4 === 1 ? sauber.slice(1) : sauber;

  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(kern)) {
    return { pulse: null, fehler: 'the code is not base64', warnung: null };
  }

  const bytes = Buffer.from(kern, 'base64');
  if (bytes.length % 2 !== 0) {
    return {
      pulse: null,
      fehler: `the code holds ${bytes.length} bytes, an odd number — every duration `
        + 'takes two, so the capture broke off mid-value',
      warnung: null,
    };
  }

  const pulse = [];
  for (let i = 0; i + 1 < bytes.length; i += 2) pulse.push(bytes.readUInt16LE(i));

  if (pulse.length < MIN_WERTE) {
    return {
      pulse: null,
      fehler: `the code holds only ${pulse.length} duration`
        + `${pulse.length === 1 ? '' : 's'} — far too few for any remote`,
      warnung: null,
    };
  }
  if (pulse.some((v) => v === 0)) {
    return {
      pulse: null,
      fehler: 'the code contains a duration of zero, which no signal has',
      warnung: null,
    };
  }

  const dauerMs = pulse.reduce((a, v) => a + v, 0) / 1000;
  const warnung = (pulse.length < KNAPP_WERTE || dauerMs < KNAPP_DAUER)
    ? `only ${pulse.length} durations over ${dauerMs.toFixed(1)} ms — shorter than most `
      + 'remotes send, so it may be a partial capture'
    : null;

  return { pulse, fehler: null, warnung };
}

/**
 * Die Zeitklassen einer Aufnahme, von der kuerzesten an.
 *
 * @param {number[]} pulse
 * @returns {Array<{mittel: number, anzahl: number}>}
 */
function zeitklassen(pulse) {
  const klassen = [];
  for (const v of [...pulse].sort((a, b) => a - b)) {
    const passend = klassen.find((k) => Math.abs(k.mittel - v) / k.mittel < KLASSEN_TOLERANZ);
    if (passend) {
      passend.anzahl += 1;
      // Laufendes Mittel: die Klasse wandert mit den Werten, die sie aufnimmt,
      // statt an ihrem ersten zu kleben.
      passend.mittel += (v - passend.mittel) / passend.anzahl;
    } else {
      klassen.push({ mittel: v, anzahl: 1 });
    }
  }
  return klassen;
}

/**
 * Eine Zeile, die eine Aufnahme beschreibt.
 *
 * @param {number[]} pulse
 * @returns {string}
 */
function beschreibePulse(pulse) {
  const dauerMs = pulse.reduce((a, v) => a + v, 0) / 1000;
  const klassen = zeitklassen(pulse);
  const gezeigt = klassen.slice(0, MAX_KLASSEN)
    .map((k) => `~${Math.round(k.mittel)} µs ×${k.anzahl}`);
  if (klassen.length > MAX_KLASSEN) gezeigt.push(`and ${klassen.length - MAX_KLASSEN} more`);
  return `${pulse.length} durations, ${dauerMs.toFixed(1)} ms, `
    + `timing classes ${gezeigt.join(', ')}`;
}

module.exports = {
  lesePulse,
  beschreibePulse,
  zeitklassen,
  MIN_WERTE,
  KNAPP_WERTE,
  KLASSEN_TOLERANZ,
};
