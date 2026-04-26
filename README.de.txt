Tuya Local ermöglicht die direkte, lokale Steuerung von Tuya-basierten Smart-Home-Geräten — ohne Cloud, ohne Internetabhängigkeit, ohne Verzögerung.

Die App kommuniziert über das lokale Netzwerk direkt mit den Geräten und nutzt das Tuya-LAN-Protokoll. Nach dem Einrichten reagieren die Geräte sofort auf Befehle und melden ihren Status in Echtzeit — auch ohne Internetverbindung. Alle Daten bleiben im Heimnetzwerk.

Jeder Treiber ist auf seine Gerätekategorie zugeschnitten und erkennt optionale Funktionen und Datenpunkte beim Einrichten automatisch. Der generische Treiber erlaubt es, jeden Tuya-Datenpunkt einer beliebigen Homey-Capability zuzuweisen — für Geräte, die von den speziellen Treibern nicht abgedeckt werden.

Funktionen:
- Cloud-frei — kein Datenverkehr verlässt das lokale Netzwerk
- Echtzeit-Push-Updates — kein Polling erforderlich (optional konfigurierbar)
- Automatische Neuverbindung mit exponentiellem Backoff und Watchdog
- Netzwerk-Scanner — findet Geräte per UDP-Broadcast und TCP-Subnetz-Scan
- Automatische Datenpunkt-Erkennung beim Einrichten mit direktem DP-Editor
- Reparatur-Funktion — IP oder Local Key aktualisieren ohne erneutes Einrichten
- Push-Benachrichtigungen bei Alarm (Wassertank voll, Fehleralarm)
- Diagnose-Protokoll, Live-DP-Debugansicht und Rohdaten-Viewer in den App-Einstellungen

Homey Flow-Unterstützung:
Jeder Treiber bietet Auslöser, Bedingungen und Aktionen passend zur Gerätekategorie — darunter Schwellenwert-Auslöser, Verbindungs-Events, Datenpunkt-Änderungs-Auslöser und Steuerungsaktionen. Der generische Treiber erlaubt es, beliebige Tuya-Datenpunkte in Flows einzusetzen.

Für das Einrichten werden die lokale IP-Adresse, die Geräte-ID und der Local Key benötigt. Diese sind über die Tuya IoT Platform (iot.tuya.com) oder das Community-Tool "npx @tuyapi/cli wizard" erhältlich. Eine ausführliche Anleitung steht im README auf GitHub.
