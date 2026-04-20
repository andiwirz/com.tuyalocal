Tuya Local gives you direct, local control over your Tuya-based smart home devices — no cloud, no internet dependency, no latency.

The app communicates with your devices over your local network using the Tuya LAN protocol. Once added, your devices respond instantly to commands and report their current state in real time, even when your internet connection is down. All communication stays within your home network.

Features:
- Cloud-free operation — all traffic stays on your local network
- Automatic network scanner — finds Tuya devices via UDP broadcast and TCP subnet scan
- Auto-detection of device data points (DPs) during pairing
- Automatic reconnect with exponential backoff and heartbeat watchdog
- Optional temperature sensor support (detected automatically if available)
- Repair flow — update IP or Local Key without removing the device
- Diagnostic log buffer and live DP debug panel in app settings

Supported devices:
- Dehumidifier: on/off, current humidity, target humidity, fan speed, operating mode, countdown timer, child lock, water tank alarm, temperature (optional)

Homey Flow support:
- Triggers: humidity threshold crossed (up/down), water tank full/emptied, device connected/disconnected, any data point changed
- Conditions: humidity above/below, water tank full, device connected, mode check
- Actions: set target humidity, set mode, set fan speed, set timer, child lock, refresh state, force reconnect

To pair a device you need its local IP address, Device ID, and Local Key. These can be obtained via the Tuya IoT Platform (iot.tuya.com) or using the community tool "npx @tuyapi/cli wizard". Detailed instructions are in the README on GitHub.
