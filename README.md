# Tuya Local — Homey App

**Version 1.0.4** · Local control of Tuya smart devices — no cloud, no internet dependency.

All communication happens over your local network via the Tuya LAN protocol. Three built-in drivers cover the most common device types; a fully generic driver handles anything else.

---

## Drivers

| Driver | Typical devices | Device class |
|---|---|---|
| [Dehumidifier](#dehumidifier-1) | Dehumidifiers, air dryers | Dehumidifier |
| [Smart Plug](#smart-plug-1) | Smart plugs with energy monitoring | Socket |
| [Generic Tuya Device](#generic-tuya-device-1) | Any Tuya device not covered above | Other |

---

## Features

- **Cloud-free** — all traffic stays on your local network
- **Real-time push** — instant state updates without polling (polling is optional and configurable)
- **Automatic reconnect** — exponential back-off with jitter; watchdog detects stale connections and reconnects
- **Network scanner** — finds Tuya devices via UDP broadcast (ports 6666 / 6667) and a full TCP subnet scan (port 6668)
- **Auto DP detection** — on pairing, the app connects to the device, collects live data points and maps them to capabilities automatically
- **Inline DP editor** — every DP number can be adjusted in the pairing screen before adding the device
- **Optional capabilities** — tiles are added or removed dynamically based on your DP settings; set a DP to `0` to hide the tile
- **Repair flow** — update IP address or Local Key at any time without re-pairing
- **Push notifications** — Homey notification when the water tank is full (Dehumidifier) or a fault is detected (Smart Plug)
- **Diagnostic tools** — in-app log buffer, live DP debug panel and raw payload viewer
- **Bilingual** — full English and German UI

---

## Requirements

- Homey Pro with firmware **≥ 12.0.0**
- Device reachable on your **local network**
- **Device ID**, **Local Key** and **IP address** — see [How to get Device ID and Local Key](#how-to-get-device-id-and-local-key)

---

## How to get Device ID and Local Key

### Method 1 — tuya-cli wizard (recommended)

Requires Node.js ≥ 16 on your computer.

```bash
npx @tuyapi/cli wizard
```

The wizard logs you into the Tuya IoT Platform, links your Smart Life / Tuya mobile app, and lists every device with its **Device ID** and **Local Key**.

> If you recently reset or re-paired a device the Local Key changes. Re-run the wizard to get the new key.

### Method 2 — Tuya IoT Platform

1. Create a free account at [iot.tuya.com](https://iot.tuya.com).
2. **Cloud → Development → Create Cloud Project** — industry: Smart Home, region: same as your mobile app.
3. Enable API subscriptions: *IoT Core* and *Authorization*.
4. **Devices → Link Tuya App Account** — scan the QR code with Smart Life or the Tuya app.
5. In **All Devices**, click the pencil icon next to your device → copy **Device ID** and **Device Secret** (= Local Key).

### Finding the IP address

- Check your router's DHCP client list.
- Use the **Scan Network** button in the pairing wizard (UDP + TCP scan, ~10 s).
- Assign a **static IP / DHCP reservation** so the address never changes.

---

## Installation

### From Homey App Store *(when published)*

Search for **Tuya Local** in the Homey app → install.

### Developer install

```bash
git clone https://github.com/andiwirz/com.tuyalocal
cd com.tuyalocal
npm install
homey app install
```

---

## Pairing

1. Homey app → **Devices** → **+** → **Tuya Local** → choose your driver.
2. **Scan Network** to auto-discover devices, or enter IP / Device ID / Local Key / Protocol Version manually.
3. Click **Test & Connect** — the app connects, waits 4 seconds for live data, then shows a summary screen.
4. Review the detected DP mapping. Adjust DP numbers directly in the table if needed.  
   *Generic:* the full DP mapper opens — assign each data point to a capability and configure scale, unit, options.
5. Expand **Show all detected DPs** to inspect the raw snapshot from the device.
6. Optionally rename the device, then click **Add Device**.

---

## Device Settings

### Dehumidifier

#### Connection

| Setting | Description | Default |
|---|---|---|
| IP Address | Local IP of the device | — |
| Device ID | Tuya device identifier | — |
| Local Key | LAN encryption key (16 or 32 chars) | — |
| Protocol Version | 3.1 / 3.3 / 3.4 / 3.5 | 3.3 |
| Polling Interval (s) | Active poll cadence — `0` disables polling | 30 |

#### Data Points

| Setting | Capability | Default DP | Optional |
|---|---|---|---|
| `dp_onoff` | On / Off | 1 | — |
| `dp_current_humidity` | Current humidity (%) | 16 | — |
| `dp_target_humidity` | Target humidity setpoint (%) | 2 | — |
| `dp_mode` | Operating mode | 4 | — |
| `dp_fan_speed` | Fan speed | 5 | — |
| `dp_child_lock` | Child lock | 14 | ✓ `0` = disabled |
| `dp_countdown_timer` | Countdown timer | 17 | ✓ `0` = disabled |
| `dp_countdown_left` | Timer remaining — read-only | 18 | ✓ `0` = disabled |
| `dp_water_full` | Water tank full alarm | 19 | ✓ `0` = disabled |
| `dp_temperature` | Temperature — raw ÷ 10 = °C | 0 | ✓ `0` = disabled |
| `dp_anion` | Ioniser (anion) | 0 | ✓ `0` = disabled |

#### Mode & Fan Speed Values

The exact strings your device uses can differ between manufacturers. Set only the values your device actually supports; the picker will show only those options.

| Setting | Default (full superset) |
|---|---|
| `mode_values` | `manual,laundry,auto,continuous,smart,sleep,drying` |
| `fan_speed_values` | `low,medium,middle,high,auto,turbo` |

To find the exact strings your device sends, check the **Raw Data** panel in app settings.  
After saving, **restart the Tuya Local app** for the picker to reflect the updated options.

---

### Smart Plug

#### Connection

Same settings as Dehumidifier (IP, Device ID, Local Key, Protocol Version, Polling Interval).

#### Data Points

| Setting | Capability | Default DP | Optional |
|---|---|---|---|
| `dp_switch` | On / Off | 1 | — |
| `dp_power` | Power — raw × scale = W | 19 | — |
| `dp_voltage` | Voltage — raw × 0.1 = V | 20 | — |
| `dp_current` | Current — raw × 0.001 = A | 18 | — |
| `dp_energy` | Total energy — raw × 0.001 = kWh | 17 | — |
| `dp_fault` | Fault bitmap alarm | 0 | ✓ `0` = disabled |
| `dp_relay_status` | Relay power-on behavior (on / off / memory) | 0 | ✓ `0` = disabled |

#### Power Scale

Some plugs send power in milliwatts (raw 1500 = 150 W), others in watts (raw 150 = 150 W).

| Setting | Behavior |
|---|---|
| **Auto-detect** *(default)* | Raw value > 2000 → ×0.1; first value ≤ 2000 → ×1 |
| **×0.1** | Always multiply raw value by 0.1 |
| **×1** | Always use raw value directly |

---

### Generic Tuya Device

Maps any Tuya DP to any Homey capability. The mapping is built visually during pairing — no manual JSON editing required.

#### DP Mapping fields

Each entry in the `dp_config` JSON array supports the following fields:

| Field | Type | Required | Description |
|---|---|---|---|
| `dp` | number | ✓ | Tuya data point number |
| `cap` | string | ✓ | Homey capability ID (e.g. `onoff`, `generic_sensor_1`) |
| `label` | string | | Custom display name shown in the UI |
| `settable` | boolean | | `true` = Homey can send commands; `false` = read-only |
| `scale` | number | | Multiply raw number by this factor (e.g. `0.1` → raw 220 = 22.0) |
| `integer` | boolean | | `false` = send as float; omit or `true` = round to integer (default) |
| `unit` | string | | Unit label shown in the UI (e.g. `°C`, `%`, `W`) |
| `min` / `max` / `step` | number | | Range and step for slider capabilities |
| `options` | string | | Comma-separated enum values for picker capabilities |
| `readMap` | string | | JSON map: raw DP value → capability value (e.g. `{"1":"on","2":"off"}`) |
| `writeMap` | string | | JSON map: capability value → raw DP value (e.g. `{"on":"1","off":"2"}`) |

**Debounce:** Slider capabilities (`generic_number_*` or any mapping with both `min` and `max` set) are debounced by 300 ms to prevent flooding the device during drag.

#### Available capability pools

| Pool | Capability IDs | Type | Settable |
|---|---|---|---|
| Sensors | `generic_sensor_1` … `generic_sensor_4` | number | No |
| Sliders | `generic_number_1`, `generic_number_2` | number | Yes |
| Toggles | `generic_switch_1` … `generic_switch_4` | boolean | Yes |
| Pickers | `generic_picker_1` … `generic_picker_4` | enum | Yes |
| Standard | `onoff`, `measure_temperature`, `measure_humidity`, `measure_power`, `measure_voltage`, `measure_current`, `meter_power`, and others | various | varies |

---

## Homey Flows

### Dehumidifier

#### Triggers

| Trigger | Filter tokens | Flow tokens |
|---|---|---|
| Humidity went above threshold | threshold (%) | `humidity`, `prevHumidity`, `trend` |
| Humidity dropped below threshold | threshold (%) | `humidity`, `prevHumidity`, `trend` |
| Water tank became full | — | — |
| Water tank was emptied | — | — |
| Device connected | — | — |
| Device disconnected | — | — |
| A data point changed | — | `dp` (string), `value` (string) |

#### Conditions

| Condition |
|---|
| Humidity is / is not above [value] % |
| Humidity is / is not below [value] % |
| Water tank is / is not full |
| Device is / is not connected |
| Mode is / is not [mode] |

#### Actions

| Action | Notes |
|---|---|
| Set target humidity | 25–80 % |
| Set operating mode | Uses values from `mode_values` setting |
| Set fan speed | Uses values from `fan_speed_values` setting |
| Set countdown timer | cancel / 1h … 24h |
| Enable / disable child lock | Only works when `dp_child_lock` > 0 |
| Enable / disable ioniser | Only works when `dp_anion` > 0 |
| Refresh device state | Triggers an immediate GET request |
| Force reconnect | Drops and re-establishes the TCP connection |

---

### Smart Plug

#### Triggers

| Trigger | Filter tokens | Flow tokens |
|---|---|---|
| Power went above threshold | threshold (W) | `power` (W), `prevPower` (W) |
| Power dropped below threshold | threshold (W) | `power` (W), `prevPower` (W) |
| Device connected | — | — |
| Device disconnected | — | — |
| A data point changed | — | `dp` (string), `value` (string) |

Threshold triggers fire only on the exact crossing moment — not on every update while above/below.

#### Conditions

| Condition |
|---|
| Power is / is not above [value] W |
| Fault alarm is / is not active |
| Device is / is not connected |

#### Actions

| Action |
|---|
| Refresh device state |
| Force reconnect |

---

### Generic Tuya Device

#### Triggers

| Trigger | Flow tokens |
|---|---|
| Device connected | — |
| Device disconnected | — |
| A data point changed | `dp` (string), `value` (string) |

#### Conditions

| Condition |
|---|
| Device is / is not connected |

#### Actions

| Action |
|---|
| Refresh device state |
| Force reconnect |

---

## Push Notifications

| Event | Driver | Condition |
|---|---|---|
| Water tank is full | Dehumidifier | `alarm_water` transitions from `false` → `true` |
| Fault detected | Smart Plug | `alarm_generic` transitions from `false` → `true` |

---

## Diagnostics

Open **Homey app → More → Apps → Tuya Local → Settings**.

### Diagnostic Logs

Timestamped in-memory buffer (max 500 entries, cleared on app restart):

| Level | Meaning |
|---|---|
| `[INF]` | Normal events: connect, disconnect, capability updates |
| `[WRN]` | Warnings: reconnect attempts, stale connection, rejected capability option values |
| `[ERR]` | Errors |

### DP Debug Panel

Live view of the most recent data points per device:
- Select a device from the dropdown
- Shows DP number, current value, and type
- Colour-coded: green = `true`, red = `false`, purple = number, orange = string
- **Auto-refresh** updates every 5 seconds

### Raw Data Panel

Full unprocessed payload for the selected device:
- DPs as a sorted JSON object
- Device metadata: `devId`, `uid`, `cid`, timestamp
- **Copy** button for clipboard export
- Useful for finding exact enum strings (`mode`, `fan_speed`, etc.)

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Device stays unavailable | Wrong IP, Device ID or Local Key | Use **Repair** to update credentials |
| Device connects but values are wrong | Incorrect DP numbers | Adjust DPs in device settings |
| Power reading is 10× too high or low | Wrong power scale | Change **Power Scale** setting to ×0.1 or ×1 |
| Mode / fan picker shows wrong options | `mode_values` / `fan_speed_values` mismatch | Update values, then restart the Tuya Local app |
| Picker still shows old options after saving | Homey caches capability options | Restart the Tuya Local app |
| Generic device shows raw key as label | Missing locale key | Labels are set via the `label` field in the dp_config mapping |

---

## Tech Stack

- [tuyapi](https://github.com/codetheweb/tuyapi) ^7.5.2 — Tuya LAN protocol implementation
- Node.js built-ins: `dgram`, `net`, `os`, `dns`
- Homey App SDK v3

---

## Contributing

Bug reports and feature requests → [GitHub Issues](https://github.com/andiwirz/com.tuyalocal/issues)

Donations → [PayPal](https://paypal.me/AndiWirz)

---

## License

MIT
