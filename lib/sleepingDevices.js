'use strict';

// Tuya-Kategorien, deren WLAN-Geraete fast immer mit Batterie laufen und schlafen.
//
// Sie wachen kurz auf, melden ihre Werte an die Tuya-Cloud und schlafen weiter. Eine
// lokale Verbindung nehmen sie nicht an - kein Treiber und keine Einstellung aendert das.
// Gemeldet zweimal innerhalb weniger Tage mit Temperatursensoren (wsdcg): beide Male
// zeigte die Cloud-Abfrage alle Werte, und das Hinzufuegen scheiterte mit einer Meldung,
// die nach falscher IP oder falschem Schluessel klang.
//
// Bewusst knapp: nur Kategorien, die als WLAN-Geraet praktisch nur mit Batterie vorkommen.
// Bewegungsmelder (pir) fehlen, weil die App einen am Netz betriebenen kennt, und
// Rauchmelder (ywbj), weil es fuer sie einen Treiber gibt. Ein Hinweis, keine Sperre: ein
// Modell am Netz oder an USB, das online bleibt, laesst sich trotzdem hinzufuegen.
const SLEEPING_CATEGORIES = new Set([
  'wsdcg',   // Temperatur und Luftfeuchte
  'mcs',     // Tuer- und Fensterkontakt
  'sj',      // Wassermelder
  'cwysj',   // Pflanzensensor
  'zd',      // Erschuetterungssensor
]);

/** True, wenn ein Geraet dieser Kategorie aller Voraussicht nach schlaeft. */
function probablySleeps(category) {
  return SLEEPING_CATEGORIES.has(String(category || '').trim().toLowerCase());
}

module.exports = { probablySleeps, SLEEPING_CATEGORIES };
