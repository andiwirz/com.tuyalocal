Tuya Local ermöglicht die direkte, lokale Steuerung von Tuya-basierten Smart-Home-Geräten — ohne Cloud, ohne Internetabhängigkeit, ohne Verzögerung.

Die App kommuniziert über das lokale Netzwerk direkt mit den Geräten und nutzt dabei das Tuya-LAN-Protokoll. Nach dem Einrichten reagieren die Geräte sofort auf Befehle und melden ihren aktuellen Status in Echtzeit, auch wenn keine Internetverbindung besteht. Alle Daten bleiben innerhalb des Heimnetzwerks.

Funktionen:
- Cloud-freier Betrieb — kein Datenverkehr verlässt das lokale Netzwerk
- Automatischer Netzwerk-Scanner — erkennt Tuya-Geräte per UDP-Broadcast und TCP-Subnetz-Scan
- Automatische Datenpunkt-Erkennung (DPs) beim Einrichten
- Automatische Neuverbindung mit exponentiellem Backoff und Heartbeat-Watchdog
- Optionale Temperatur-Unterstützung (wird automatisch erkannt, wenn vorhanden)
- Reparatur-Funktion — IP oder Local Key aktualisieren, ohne das Gerät neu hinzuzufügen
- Diagnose-Protokoll und Live DP-Debug-Ansicht in den App-Einstellungen

Unterstützte Geräte:
- Entfeuchter: Ein/Aus, Luftfeuchtigkeit, Zielwert, Lüftergeschwindigkeit, Betriebsmodus, Countdown-Timer, Kindersicherung, Wassertank-Alarm, Temperatur (optional)

Homey Flow:
- Auslöser: Luftfeuchtigkeit über/unter Schwellenwert, Wassertank voll/geleert, Gerät verbunden/getrennt, Datenpunkt geändert
- Bedingungen: Luftfeuchtigkeit, Wassertankstatus, Verbindungsstatus, Modus-Prüfung
- Aktionen: Ziel-Luftfeuchtigkeit setzen, Modus, Lüftergeschwindigkeit, Timer, Kindersicherung, Status aktualisieren, Neuverbindung erzwingen

Für das Einrichten werden die lokale IP-Adresse, die Geräte-ID und der Local Key benötigt. Diese sind über die Tuya IoT Platform (iot.tuya.com) oder das Community-Tool "npx @tuyapi/cli wizard" erhältlich. Eine ausführliche Anleitung steht im README auf GitHub.
