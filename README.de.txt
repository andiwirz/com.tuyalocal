Tuya Local ermöglicht die direkte, lokale Steuerung von Tuya-basierten Smart-Home-Geräten — ohne Cloud, ohne Internetabhängigkeit, ohne Verzögerung.

Die App kommuniziert über das lokale Netzwerk direkt mit den Geräten und nutzt das Tuya-LAN-Protokoll. Nach dem Einrichten reagieren die Geräte sofort auf Befehle und melden ihren Status in Echtzeit — auch ohne Internetverbindung. Alle Daten bleiben im Heimnetzwerk.

Drei integrierte Treiber decken die häufigsten Gerätetypen ab:

Entfeuchter
Vollständige Steuerung von Luftentfeuchtern und Lufttrocknern: Ein/Aus, aktuelle und Ziel-Luftfeuchtigkeit, Lüftergeschwindigkeit, Betriebsmodus, Countdown-Timer, Kindersicherung, Wassertank-Alarm, Temperatursensor und Ionisator. Optionale Funktionen werden automatisch aktiviert oder deaktiviert, je nach vorhandenen Datenpunkten des Geräts.

Smart Plug (Energiemessung)
Steuerung von Smart Plugs mit Echtzeit-Energiemessung: Ein/Aus, Leistung (W), Spannung (V), Strom (A), Gesamtenergie (kWh), optionaler Fehleralarm und Relais-Einschaltverhalten. Automatische Erkennung der Leistungsskalierung. Homey Flow-Auslöser feuern wenn die Leistung einen Schwellenwert über- oder unterschreitet — ideal für Automationen basierend auf dem Gerätezustand.

Generisches Tuya-Gerät
Jeden Tuya-Datenpunkt einer Homey-Capability zuweisen — über eine visuelle Benutzeroberfläche beim Einrichten. Unterstützt Sensoren, Schalter, Schieberegler und Auswahlfelder mit konfigurierbarer Skalierung, Einheit, Wertzuordnung und Enum-Optionen. Geeignet für alle Tuya-Geräte, die nicht von den speziellen Treibern abgedeckt werden.

Funktionen:
- Cloud-frei — kein Datenverkehr verlässt das lokale Netzwerk
- Echtzeit-Push-Updates — kein Polling erforderlich (optional konfigurierbar)
- Automatische Neuverbindung mit exponentiellem Backoff und Watchdog
- Netzwerk-Scanner — findet Geräte per UDP-Broadcast und TCP-Subnetz-Scan
- Automatische Datenpunkt-Erkennung beim Einrichten mit direktem DP-Editor
- Reparatur-Funktion — IP oder Local Key aktualisieren ohne erneutes Einrichten
- Push-Benachrichtigungen bei vollem Wassertank und Fehleralarm
- Diagnose-Protokoll, Live-DP-Debugansicht und Rohdaten-Viewer in den App-Einstellungen

Homey Flow-Unterstützung:

Entfeuchter: Luftfeuchtigkeits-Schwellenwert-Auslöser (mit Vorwert und Trend), Wassertank voll/geleert, Gerät verbunden/getrennt, Datenpunkt geändert — Bedingungen für Luftfeuchtigkeit, Wassertank und Modus — Aktionen für Ziel-Luftfeuchtigkeit, Modus, Lüftergeschwindigkeit, Timer, Kindersicherung, Ionisator, Aktualisierung und Neuverbindung.

Smart Plug: Leistungs-Schwellenwert-Auslöser (feuert nur beim Kreuzungsmoment, nicht kontinuierlich), Gerät verbunden/getrennt, Datenpunkt geändert — Bedingungen für Leistung über Schwellenwert, Fehleralarm aktiv, Gerät verbunden — Aktionen für Aktualisierung und Neuverbindung.

Generisch: Gerät verbunden/getrennt, Datenpunkt geändert — Bedingung für Verbindungsstatus — Aktionen für Aktualisierung und Neuverbindung.

Für das Einrichten werden die lokale IP-Adresse, die Geräte-ID und der Local Key benötigt. Diese sind über die Tuya IoT Platform (iot.tuya.com) oder das Community-Tool "npx @tuyapi/cli wizard" erhältlich. Eine ausführliche Anleitung steht im README auf GitHub.
