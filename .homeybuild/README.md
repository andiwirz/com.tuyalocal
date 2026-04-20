# com.tuyalocal

A Homey app for direct, **local control** of Tuya-based smart devices — no cloud, no internet dependency. Communication happens entirely over your local network using the Tuya LAN protocol.

## Features

- Local-only control (LAN protocol) — no cloud required
- Instant responses and real-time status updates
- Automatic device discovery via UDP broadcast (ports 6666/6667) and TCP subnet scan
- Auto-detection of device data points (DPs)
- Bilingual UI (English and German)
- Homey Flow automations with triggers, conditions, and actions

### Supported Devices

- **Dehumidifier** — on/off, humidity monitoring, target humidity, operating modes, fan speed, countdown timer, child lock, water tank alarm

## Requirements

- Homey hub (firmware ≥ 12.0.0)
- Tuya device reachable on your local network
- Device **ID**, **Local Key**, and **IP address** from the [Tuya Developer Platform](https://iot.tuya.com)

## Installation

```bash
git clone https://github.com/andiwirz/com.tuyalocal
cd com.tuyalocal
npm install
```

**Run on Homey:**
```bash
npm start        # deploys via homey app run
npm run validate # validates app manifest
```

## Pairing a Device

1. Open the Homey app and add **Tuya Local**.
2. Choose **Scan Network** — the app listens for Tuya UDP broadcasts and scans your subnet on TCP port 6668.
3. Or choose **Manual Entry** and provide: IP address, Device ID, Local Key, and protocol version.
4. Detected data points are shown for confirmation before the device is added.

## Configuration (Device Settings)

| Setting | Description | Default |
|---|---|---|
| `ip` | Local IP address of the device | — |
| `device_id` | Tuya device identifier | — |
| `local_key` | Local encryption key | — |
| `version` | Protocol version (3.1, 3.3, 3.4, 3.5) | 3.3 |
| `polling_interval` | State poll interval in seconds (0 = disabled) | 300 |

### DP Mappings (auto-detected, adjustable)

| Setting | DP function | Default |
|---|---|---|
| `dp_onoff` | Power on/off | 1 |
| `dp_current_humidity` | Current humidity | 16 |
| `dp_target_humidity` | Target humidity | 2 |
| `dp_mode` | Operating mode | 4 |
| `dp_fan_speed` | Fan speed | 5 |
| `dp_countdown_timer` | Timer set | 17 |
| `dp_countdown_left` | Timer remaining | 18 |
| `dp_child_lock` | Child lock | 14 |
| `dp_water_full` | Water tank full alarm (0 = disabled) | 19 |

## Homey Flows

**Triggers**
- Humidity exceeded threshold *(token: humidity %)*
- Humidity dropped below threshold *(token: humidity %)*
- Water tank became full
- Water tank was emptied

**Conditions**
- Humidity is above / below value
- Water tank is full
- Mode is (manual / laundry)

**Actions**
- Set target humidity (25–80 %)
- Set operating mode
- Set fan speed
- Set countdown timer
- Enable / disable child lock
- Refresh device state

## DP Discovery Tool

If auto-detection fails, use the standalone CLI tool to inspect device DPs:

```bash
node discover-dps.js <ip> <deviceId> <localKey> [version]

# example
node discover-dps.js 192.168.1.100 abc123 0123456789abcdef 3.3
```

## Tech Stack

- [tuyapi](https://github.com/codetheweb/tuyapi) ^7.5.2 — Tuya LAN protocol communication
- Node.js native: `dgram`, `net`, `os`, `dns`
- Homey App SDK v3

## Contributing

Bug reports and feature requests: [GitHub Issues](https://github.com/andiwirz/com.tuyalocal/issues)

Donations: [PayPal](https://paypal.me/AndiWirz)

## License

MIT
