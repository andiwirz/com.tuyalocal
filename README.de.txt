Zwölf spezialisierte Treiber decken die gängigsten Tuya-Gerätekategorien ab — und ein vollständig generischer Treiber übernimmt alles andere. Nach dem Einrichten reagieren Geräte sofort auf Homey-Befehle und melden Zustandsänderungen in Echtzeit, auch ohne Internetverbindung.

Unterstützte Gerätetypen:
Entfeuchter · Smart Plug · Klimaanlage · Lüfter · Luftbefeuchter · Heizgerät · Licht · Futterautomat · Garagentor · Wärmepumpe · Rolladenmotor · Generisches Tuya-Gerät

Funktionen:
- Automatische Datenpunkt-Erkennung beim Einrichten mit direktem DP-Editor
- Optionale Capabilities werden anhand der Einstellungen dynamisch hinzugefügt oder entfernt
- Netzwerk-Scanner — findet Geräte per UDP-Broadcast und TCP-Subnetz-Scan
- Automatische Neuverbindung mit exponentiellem Backoff und Heartbeat-Watchdog
- Push-Benachrichtigungen bei Alarm (Wassertank, Fehleralarm, Garagentor offen)
- Diagnose-Protokoll, Live-DP-Debugansicht und Rohdaten-Viewer in den App-Einstellungen

Homey Flow-Unterstützung:
Jeder Treiber bietet Auslöser, Bedingungen und Aktionen passend zur Gerätekategorie — darunter Schwellenwert-Auslöser, Verbindungs-Events, Datenpunkt-Änderungs-Auslöser und Steuerungsaktionen. Der generische Treiber erlaubt es, beliebige Tuya-Datenpunkte in Flows einzusetzen.

Einrichten:
Für das Pairing werden die lokale IP-Adresse, die Geräte-ID und der Local Key benötigt. Diese sind über die Tuya IoT Platform (iot.tuya.com) oder das Community-Tool "npx @tuyapi/cli wizard" erhältlich. Eine ausführliche Anleitung steht im Hilfe-Tab der App und auf GitHub.
