'use strict';

// Deckenventilatoren - was beide Treiber (drivers/fan und drivers/fan_light) gleich
// brauchen. Die zwei teilen sonst keinen Code; das hier lebt an einer Stelle, damit
// eine Korrektur beide erreicht. Welche Faehigkeit der Ventilator und welche das
// Licht ist, unterscheidet sich zwischen ihnen und wird deshalb hereingereicht:
//
//   drivers/fan        Ventilator = onoff       Licht = onoff.light
//   drivers/fan_light  Ventilator = onoff.fan   Licht = onoff
//
// Gemeldet an zwei Mantra-Deckenventilatoren (Protokoll 3.5):
//
// 1. Die Richtung als true/false. Die Kachel kennt forward/reverse, wie es der
//    Tuya-Standard als Text vorsieht. Dieses Modell fuehrt sie auf DP 101 als Schalter:
//    false = vorwaerts (Sommer), true = rueckwaerts (Winter). Gelesen stand "true" in
//    der Kachel, gesendet ging "reverse" an einen Schalter-DP.
// 2. Die Stufe als Text "1" bis "32". Der Regler sendete eine Zahl.
// 3. Das Nachlauflicht: Nach dem Ausschalten des Ventilators schaltet er sein Licht
//    selbst ein - etwa 2 s danach, und nach dem Auslaufen (etwa 13 s) noch einmal.
//    Waehrend der Motor auslaeuft, ignoriert er Licht-aus.
// 4. Er laeuft nach jedem Einschalten vorwaerts an, gleich wie er zuletzt lief.

const NACHLAUF_MS     = 30000;       // so lange nach dem Ausschalten wird das Licht korrigiert
const NACHSCHUESSE_MS = [150, 500];  // Licht-aus vorsorglich, wie der Melder es tut
const NACHPRUEFEN_MS  = 2000;        // in diesem Takt erneut, solange es an gemeldet ist
const SPEICHER_RICHTUNG = 'gewaehlteRichtung';

/** Gemeldeter Wert -> Kachelwert. true/false wird zu reverse/forward. */
function richtungAusRoh(wert) {
  if (typeof wert === 'boolean') return wert ? 'reverse' : 'forward';
  return String(wert);
}

/**
 * Kachelwert -> zu sendender Wert. Ein Schalter-DP bekommt true/false, alles andere
 * bleibt Text wie bisher. Entschieden nach dem, was der DP zuletzt meldete: Geraete,
 * die nie true/false gemeldet haben, bekommen genau das, was sie immer bekamen.
 */
function richtungZuRoh(geraet, id) {
  const dp = Number(geraet.getSetting('dp_direction'));
  if (typeof geraet._lastDps?.[String(dp)] === 'boolean') return id === 'reverse';
  return id;
}

/** Stufe fuer den Regler: als Text, wenn der DP sie als Text meldet, sonst als Zahl. */
function stufeZuRoh(geraet, dp, zahl) {
  return typeof geraet._lastDps?.[String(dp)] === 'string' ? String(zahl) : zahl;
}

// ── Nachlauflicht ───────────────────────────────────────────────────────────

function _lichtDp(geraet) {
  const dp = Number(geraet.getSetting('dp_light_onoff'));
  return dp > 0 ? dp : 0;
}

/**
 * Licht-aus direkt ueber die Verbindung, ohne den Fake-State von _set. Der hielte eine
 * widersprechende Meldung bis zu 5 s zurueck, und genau die - "das Licht ist wieder
 * an" - muss hier sofort ankommen, damit erneut ausgeschaltet wird.
 */
function _lichtAus(geraet, wache) {
  if (geraet._lichtWache !== wache) return;
  const dp = _lichtDp(geraet);
  if (!dp || !geraet._conn?.connected) return;
  wache.gesendet++;
  Promise.resolve()
    .then(() => geraet._conn.set(dp, false))
    .catch((err) => geraet._appLog?.(`Courtesy light: switching off failed: ${err.message}`, 'warn'));
}

/** Beendet ein laufendes Nachlauffenster. Auch beim Loeschen des Geraets aufrufen. */
function wacheBeenden(geraet) {
  const w = geraet._lichtWache;
  if (!w) return;
  geraet._lichtWache = null;
  for (const t of w.timer) clearTimeout(t);
  clearInterval(w.intervall);
}

/**
 * Der Ventilator hat gemeldet. Nur der Wechsel von an auf aus oeffnet das Fenster -
 * und nur, wenn das Licht in diesem Moment aus ist. War es an, hat es jemand gewollt
 * (in Homey, mit der Fernbedienung oder am Schalter), und es bleibt, wie es ist.
 *
 * vorherRoh ist der zuletzt gemeldete Wert des Datenpunkts, nicht die Kachel. In
 * 1.0.289 war es die Kachel, und das Fenster oeffnete sich nie, wenn der Ventilator in
 * Homey ausgeschaltet wurde: Homey setzt die Kachel auf aus, sobald der Befehl
 * hinaus ist, und die Bestaetigung des Geraets fand dort schon aus vor.
 */
function ventilatorGemeldet(geraet, an, vorherRoh, lichtCap) {
  if (an === true) { wacheBeenden(geraet); return; }
  if (!(an === false && vorherRoh !== undefined && Boolean(vorherRoh) === true)) return;
  if (!geraet.getSetting('light_off_with_fan')) return;
  const dp = _lichtDp(geraet);
  if (!dp) return;
  if (geraet.getCapabilityValue(lichtCap) === true) {
    geraet._appLog?.('Fan turned off with the light on - light left alone', 'info');
    return;
  }
  wacheBeenden(geraet);
  const wache = { bis: Date.now() + NACHLAUF_MS, timer: [], intervall: null, gesendet: 0 };
  geraet._lichtWache = wache;
  for (const ms of NACHSCHUESSE_MS) wache.timer.push(setTimeout(() => _lichtAus(geraet, wache), ms));
  wache.intervall = setInterval(() => {
    if (geraet._lichtWache !== wache) return;
    if (Date.now() >= wache.bis) {
      wacheBeenden(geraet);
      if (geraet._lastDps?.[String(dp)] === true) {
        geraet._appLog?.('Courtesy light still on after 30 s - giving up', 'warn');
      }
      return;
    }
    if (geraet._lastDps?.[String(dp)] === true) _lichtAus(geraet, wache);
  }, NACHPRUEFEN_MS);
  geraet._appLog?.(`Fan turned off - keeping the light off for ${NACHLAUF_MS / 1000} s`, 'info');
}

/** Das Licht hat gemeldet. Geht es im Fenster an, wird sofort wieder ausgeschaltet. */
function lichtGemeldet(geraet, an) {
  const w = geraet._lichtWache;
  if (!w || an !== true) return;
  if (Date.now() >= w.bis) { wacheBeenden(geraet); return; }
  _lichtAus(geraet, w);
}

/** Jemand schaltet das Licht in Homey ein: das ist gewollt, das Fenster endet. */
function lichtBefohlen(geraet, an) {
  if (an === true) wacheBeenden(geraet);
}

// ── Richtung merken ─────────────────────────────────────────────────────────

function richtungMerkenAktiv(geraet) {
  return geraet.getSetting('direction_hold_when_off') === true
    && Number(geraet.getSetting('dp_direction')) > 0;
}

/**
 * Richtung aus Homey. Gemerkt wird sie immer, solange die Einstellung an ist; gesendet
 * nur, wenn der Ventilator laeuft. Gibt true zurueck, wenn der Aufrufer senden soll.
 */
async function richtungBefohlen(geraet, id, ventilatorCap) {
  if (!richtungMerkenAktiv(geraet)) return true;
  await geraet.setStoreValue(SPEICHER_RICHTUNG, id).catch(() => {});
  if (geraet.getCapabilityValue(ventilatorCap) === true) return true;
  geraet._appLog?.(`Direction "${id}" kept until the fan is switched on`, 'info');
  return false;
}

/**
 * Richtung gemeldet. Laeuft der Ventilator, gilt sie (auch eine Aenderung an der
 * Fernbedienung) und wird gemerkt. Steht er, wird sie nicht in die Kachel geschrieben:
 * dort steht, was beim naechsten Einschalten gesendet wird. Gibt true zurueck, wenn
 * der Aufrufer die Kachel setzen soll.
 */
function richtungGemeldet(geraet, id, ventilatorCap) {
  if (!richtungMerkenAktiv(geraet)) return true;
  if (geraet.getCapabilityValue(ventilatorCap) !== true) return false;
  geraet.setStoreValue(SPEICHER_RICHTUNG, id).catch(() => {});
  return true;
}

/**
 * Ventilator einschalten aus Homey. Mit gemerkter Richtung rueckwaerts gehen beide in
 * einem Befehl hinaus, damit er nicht erst vorwaerts anlaeuft. Gibt true zurueck, wenn
 * das erledigt ist; sonst sendet der Aufrufer wie bisher.
 *
 * Vorwaerts geht nicht mit: das ist die Richtung, in der diese Ventilatoren ohnehin
 * anlaufen. In 1.0.289 ging sie mit, und der gemeldete Mantra schaltete sich 0,4 s nach
 * dem Anlaufen wieder aus. Die App seines Melders schickt die Richtung ebenfalls nur fuer
 * rueckwaerts mit ({"1": true, "101": true}) und fuer vorwaerts nur das Einschalten.
 */
async function einschaltenMitRichtung(geraet, an) {
  if (an !== true || !richtungMerkenAktiv(geraet)) return false;
  const id = geraet.getStoreValue(SPEICHER_RICHTUNG) ?? geraet.getCapabilityValue('fan_direction');
  if (id !== 'reverse') return false;
  const dpAn = Number(geraet.getSetting('dp_onoff'));
  const dpRichtung = Number(geraet.getSetting('dp_direction'));
  if (!(dpAn > 0) || dpAn === dpRichtung) return false;
  if (!geraet._conn) return false;
  const roh = richtungZuRoh(geraet, id);
  const jetzt = Date.now();
  for (const [dp, wert] of [[dpAn, true], [dpRichtung, roh]]) {
    clearTimeout(geraet._pendingDps[String(dp)]?.timer);
    geraet._pendingDps[String(dp)] = { value: wert, time: jetzt };
  }
  await geraet._conn.setMultiple({ [dpAn]: true, [dpRichtung]: roh });
  if (geraet.hasCapability('fan_direction')) {
    await geraet.setCapabilityValue('fan_direction', id).catch(() => {});
  }
  return true;
}

module.exports = {
  NACHLAUF_MS,
  richtungAusRoh,
  richtungZuRoh,
  stufeZuRoh,
  ventilatorGemeldet,
  lichtGemeldet,
  lichtBefohlen,
  wacheBeenden,
  richtungBefohlen,
  richtungGemeldet,
  einschaltenMitRichtung,
};
