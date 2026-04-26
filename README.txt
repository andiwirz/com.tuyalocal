Tuya Local gives you direct, local control over your Tuya-based smart home devices — no cloud, no internet dependency, no latency.

The app communicates with your devices over your local network using the Tuya LAN protocol. Once added, devices respond instantly to commands and report their state in real time — even when your internet connection is down. All traffic stays within your home network.

Each driver is purpose-built for its device category, with automatic detection of optional capabilities and data points during pairing. The Generic driver lets you map any Tuya data point to any Homey capability — covering devices not handled by the dedicated drivers.

Features:
- Cloud-free — no data leaves your local network
- Real-time push updates — no polling required (optional polling configurable)
- Automatic reconnect with exponential backoff and watchdog
- Network scanner — finds devices via UDP broadcast and TCP subnet scan
- Auto-detection of data points during pairing with inline DP editor
- Repair flow — update IP or Local Key without re-pairing
- Push notifications for alarms (water tank full, fault)
- Diagnostic log buffer, live DP debug panel and raw payload viewer in app settings

Homey Flow support:
Each driver provides triggers, conditions and actions tailored to its device type — including threshold crossing triggers, connected/disconnected events, data point change events and control actions. The Generic driver allows any Tuya data point to be used in Flow.

To pair a device you need its local IP address, Device ID and Local Key. These can be obtained via the Tuya IoT Platform (iot.tuya.com) or the community tool "npx @tuyapi/cli wizard". Full instructions are in the README on GitHub.
