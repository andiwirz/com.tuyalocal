Twelve purpose-built drivers cover the most common Tuya device categories — and a fully generic driver handles anything else. Once paired, devices respond instantly to Homey commands and report state changes in real time, even without an internet connection.

Supported device types:
Dehumidifier · Smart Plug · Air Conditioner · Fan · Humidifier · Heater · Light · Pet Feeder · Garage Door · Heat Pump · Curtain Motor · Generic Tuya Device

Features:
- Automatic data-point detection during pairing with an inline DP editor
- Optional capabilities are added or removed dynamically based on your settings
- Network scanner — finds devices via UDP broadcast and TCP subnet scan
- Automatic reconnect with exponential backoff and heartbeat watchdog
- Push notifications for alarms (water tank, fault, garage door left open)
- Diagnostic log buffer, live DP debug panel and raw payload viewer in app settings

Homey Flow support:
Each driver provides triggers, conditions and actions tailored to its device type — including threshold crossing triggers, connected/disconnected events, data point change triggers and control actions. The Generic driver allows any Tuya data point to be used in a Flow.

Getting started:
To pair a device you need its local IP address, Device ID and Local Key. These can be obtained via the Tuya IoT Platform (iot.tuya.com) or the community tool "npx @tuyapi/cli wizard". Full instructions are in the in-app Help tab and on GitHub.
