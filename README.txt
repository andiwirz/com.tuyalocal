Tuya Local gives you direct, local control over your Tuya-based smart home devices — no cloud, no internet dependency, no latency.

The app communicates with your devices over your local network using the Tuya LAN protocol. Once added, devices respond instantly to commands and report their state in real time — even when your internet connection is down. All traffic stays within your home network.

Three built-in drivers cover the most common device types:

Dehumidifier
Control dehumidifiers and air dryers with full support for on/off, current and target humidity, fan speed, operating mode, countdown timer, child lock, water tank alarm, temperature sensor and ioniser. Optional capabilities are added or removed automatically based on your device's data points.

Smart Plug (energy monitoring)
Control smart plugs with real-time energy monitoring: on/off switching, power (W), voltage (V), current (A), total energy (kWh), optional fault alarm and relay power-on behavior. Auto-detects the correct power scale. Homey Flow triggers fire when power crosses a threshold — ideal for automations based on appliance state.

Generic Tuya Device
Map any Tuya data point to any Homey capability using a visual pairing interface. Supports sensors, toggles, sliders and pickers with configurable scale, unit, value mapping and enum options. Works with any Tuya device not covered by the dedicated drivers.

Features:
- Cloud-free — no data leaves your local network
- Real-time push updates — no polling required (optional polling configurable)
- Automatic reconnect with exponential backoff and watchdog
- Network scanner — finds devices via UDP broadcast and TCP subnet scan
- Auto-detection of data points during pairing with inline DP editor
- Repair flow — update IP or Local Key without re-pairing
- Push notifications for water tank full and fault alarms
- Diagnostic log buffer, live DP debug panel and raw payload viewer in app settings

Homey Flow support:

Dehumidifier: humidity threshold triggers (with previous value and trend tokens), water tank full/emptied, device connected/disconnected, data point changed — conditions for humidity, water tank and mode — actions for humidity target, mode, fan speed, timer, child lock, ioniser, refresh and reconnect.

Smart Plug: power threshold triggers (fires only on crossing, not continuously), device connected/disconnected, data point changed — conditions for power above, fault alarm active, device connected — actions for refresh and reconnect.

Generic: device connected/disconnected, data point changed — condition for device connected — actions for refresh and reconnect.

To pair a device you need its local IP address, Device ID and Local Key. These can be obtained via the Tuya IoT Platform (iot.tuya.com) or the community tool "npx @tuyapi/cli wizard". Full instructions are in the README on GitHub.
