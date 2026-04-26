# Tuya Local — Homey App

**Version 1.0.18** · Local control of Tuya smart devices — no cloud, no internet dependency.

All communication happens over your local network via the Tuya LAN protocol. Four built-in drivers cover the most common device types; a fully generic driver handles anything else.

---

## Drivers

| Driver | Typical devices | Device class |
|---|---|---|
| [Dehumidifier](#dehumidifier-1) | Dehumidifiers, air dryers | Dehumidifier |
| [Smart Plug](#smart-plug-1) | Smart plugs with energy monitoring | Socket |
| [Air Conditioner](#air-conditioner-1) | Any Tuya local LAN air conditioner | Thermostat |
| [Generic Tuya Device](#generic-tuya-device-1) | Any Tuya device not covered above | Other |

---

## Features

- **Cloud-free** — all traffic stays on your local network
- **Real-time push** — instant state updates without polling (polling is optional and configurable)
- **Automatic reconnect** — exponential back-off with jitter; watchdog detects stale connections and reconnects
- **Protocol auto-detect** — pairing and repair default to *Auto-detect*, which tries 3.3 → 3.4 → 3.1 → 3.5 in order and saves the working version automatically
- **Network scanner** — finds Tuya devices via UDP broadcast (ports 6666 / 6667) and a full TCP subnet scan (port 6668)
- **Auto DP detection** — on pairing, the app connects to the device, collects live data points and maps them to capabilities automatically
- **Inline DP editor** — every DP number can be adjusted in the pairing screen before adding the device
- **Optional capabilities** — tiles are added or removed dynamically based on your DP settings; set a DP to `0` to hide the tile
- **Repair flow** — update IP address or Local Key at any time without re-pairing
- **Computed energy metering** — kWh accumulated from live power readings using trapezoidal integration; persisted across restarts
- **Push notifications** — Homey notification when the water tank is full (Dehumidifier) or a fault is detected (Smart Plug / Air Conditioner)
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
2. **Scan Network** to auto-discover devices, or enter IP / Device ID / Local Key manually.
3. Leave **Protocol Version** on **Auto-detect** (default) — the app tries 3.3 → 3.4 → 3.1 → 3.5 and saves the working version automatically. Select a specific version only if auto-detect fails.
4. Click **Test & Connect** — the app connects, collects live data, then shows a summary screen.
5. Review the detected DP mapping. Adjust DP numbers directly in the table if needed.  
   *Generic:* the full DP mapper opens — assign each data point to a capability and configure scale, unit, options.
6. Expand **Show all detected DPs** to inspect the raw snapshot from the device.
7. Optionally rename the device, then click **Add Device**.

---

## Device Settings

### Dehumidifier

#### Connection

| Setting | Description | Default |
|---|---|---|
| IP Address | Local IP of the device | — |
| Device ID | Tuya device identifier | — |
| Local Key | LAN encryption key (16 or 32 chars) | — |
| Protocol Version | Auto-detect / 3.1 / 3.3 / 3.4 / 3.5 | Auto-detect |
| Polling Interval (s) | Active poll cadence — `0` disables polling | 30 |

#### Data Points

| Setting | Capability | Type | Default DP | Optional |
|---|---|---|---|---|
| `dp_onoff` | `onoff` | boolean | 1 | — |
| `dp_current_humidity` | `measure_humidity` | number | 16 | — |
| `dp_target_humidity` | `target_humidity` | number | 2 | — |
| `dp_mode` | `mode` | enum | 4 | — |
| `dp_fan_speed` | `fan_speed` | enum | 5 | — |
| `dp_child_lock` | `child_lock` | boolean | 14 | ✓ `0` = disabled |
| `dp_countdown_timer` | `countdown_timer` | enum | 17 | ✓ `0` = disabled |
| `dp_countdown_left` | `countdown_left` | number | 18 | ✓ `0` = disabled |
| `dp_water_full` | `alarm_water` | boolean | 19 | ✓ `0` = disabled |
| `dp_temperature` | `measure_temperature` | number | 0 | ✓ `0` = disabled |
| `dp_anion` | `anion` | boolean | 0 | ✓ `0` = disabled |

#### Mode & Fan Speed Values

| Setting | Default (full superset) |
|---|---|
| `mode_values` | `manual,laundry,auto,continuous,smart,sleep,drying` |
| `fan_speed_values` | `low,medium,middle,high,auto,turbo` |

The exact strings vary by manufacturer. Check the **Raw Data** panel in app settings to find what your device sends. After saving, **restart the Tuya Local app** for the picker to reflect the updated options.

---

### Smart Plug

#### Connection

Same settings as Dehumidifier (IP, Device ID, Local Key, Protocol Version, Polling Interval).

#### Data Points

| Setting | Capability | Type | Default DP | Optional |
|---|---|---|---|---|
| `dp_switch` | `onoff` | boolean | 1 | — |
| `dp_power` | `measure_power` | number | 19 | — |
| `dp_voltage` | `measure_voltage` | number | 20 | — |
| `dp_current` | `measure_current` | number | 18 | — |
| `dp_energy` | `meter_power` | number | **0** | ✓ see below |
| `dp_relay_status` | `relay_status` | enum | 38 | ✓ `0` = disabled |
| `dp_fault` | `alarm_generic` | boolean | 0 | ✓ `0` = disabled |
| `dp_power_factor` | `power_factor` | number | 0 | ✓ `0` = disabled |
| `dp_countdown` | *(flow only)* | number | 0 | ✓ `0` = disabled |

#### Energy Metering

Most Tuya plugs send the energy counter (DP 17, `add_ele`) as a **resetting delta** — the Tuya cloud accumulates the deltas into a lifetime total, but locally the value appears frozen.

When `dp_energy = 0` (default), the app computes kWh itself by integrating live power readings using **trapezoidal averaging** — the mean of the previous and current power reading multiplied by elapsed time. The result is monotonically increasing and persisted across app restarts.

Set `dp_energy = 17` only if your device provides a reliable cumulative local energy counter.

The energy accumulator can be reset via the **Reset energy meter** flow action.

#### Turn On Behavior Values

Controls what the device does when mains power is restored after an outage. The `relay_status_values` setting restricts the picker to the subset your device supports.

| Value | Meaning |
|---|---|
| `off` | Always Off — device stays off when power is restored |
| `on` | Always On — device turns on when power is restored |
| `memory` | Last State — device resumes its previous state |

Default: `off,on,memory` (all three options shown).

#### Power Scale

| Setting | Behavior |
|---|---|
| **×0.1** *(default)* | Multiply raw value by 0.1 — standard for Tuya plugs |
| **×1** | Use raw value directly |
| **Auto-detect** | Raw > 2000 → ×0.1; first non-zero value ≤ 2000 → ×1 (legacy, not recommended) |

---

### Air Conditioner

#### Connection

Same settings as Dehumidifier (IP, Device ID, Local Key, Protocol Version, Polling Interval).

#### Data Points

| Setting | Capability | Type | Default DP | Optional |
|---|---|---|---|---|
| `dp_onoff` | `onoff` | boolean | 1 | — |
| `dp_target_temp` | `target_temperature` | number | 2 | — |
| `dp_current_temp` | `measure_temperature` | number | 3 | — |
| `dp_mode` | `ac_mode` | enum | 4 | — |
| `dp_fan_speed` | `ac_fan_speed` | enum | 5 | — |
| `dp_swing` | `ac_swing` | boolean | 0 | ✓ `0` = disabled |
| `dp_sleep` | `ac_sleep` | boolean | 0 | ✓ `0` = disabled |
| `dp_eco` | `ac_eco` | boolean | 0 | ✓ `0` = disabled |
| `dp_child_lock` | `child_lock` | boolean | 0 | ✓ `0` = disabled |
| `dp_countdown_timer` | `countdown_timer` | number | 0 | ✓ `0` = disabled |
| `dp_countdown_left` | `countdown_left` | number | 0 | ✓ `0` = disabled |
| `dp_fault` | `alarm_generic` | boolean | 20 | ✓ `0` = disabled |

#### Temperature Scaling

Some AC units send temperatures multiplied by 10 (e.g. `220` = 22.0 °C). The driver auto-detects this during pairing. If the displayed temperature is still 10× too high, set **`temp_divisor = 10`** in device settings.

#### Mode & Fan Speed Values

| Setting | Default |
|---|---|
| `mode_values` | `cool,heat,auto,dry,fan` |
| `fan_speed_values` | `auto,low,medium,high,turbo` |

The allowed strings vary by manufacturer. Check the **DP Debug** panel while operating the device manually, then update these settings to match. After saving, **restart the Tuya Local app**.

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

> Water tank triggers are debounced — the alarm must stay active for 5 seconds (30 s after reconnect) before firing, suppressing the transient pulse the device emits on reconnect.

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

| Action | Notes |
|---|---|
| Refresh device state | Triggers an immediate GET request |
| Force reconnect | Drops and re-establishes the TCP connection |
| Set countdown timer | 0–86400 s; `0` cancels. Requires `dp_countdown` > 0 |
| Reset energy meter | Resets the computed kWh accumulator to zero |

---

### Air Conditioner

#### Triggers

| Trigger | Flow tokens |
|---|---|
| AC connected | — |
| AC disconnected | — |
| AC fault alarm triggered | — |
| AC data point changed | `dp` (string), `value` (string) |

> The fault alarm trigger is debounced — the alarm must stay active for 5 seconds (30 s after reconnect) before firing.

#### Conditions

| Condition |
|---|
| AC is / is not connected |
| AC mode is / is not [mode] |

#### Actions

| Action | Notes |
|---|---|
| Set AC mode | cool / heat / auto / dry / fan (from `mode_values`) |
| Set AC fan speed | auto / low / medium / high / turbo (from `fan_speed_values`) |
| Set AC target temperature | 16–35 °C |
| Set AC swing | on / off — requires `dp_swing` > 0 |
| Set AC sleep mode | on / off — requires `dp_sleep` > 0 |
| Force AC reconnect | Drops and re-establishes the TCP connection |
| Refresh AC device | Triggers an immediate GET request |

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
| Water tank is full | Dehumidifier | Alarm active for > 5 s (debounced to suppress reconnect artifacts) |
| Fault detected | Smart Plug | `alarm_generic` transitions from `false` → `true` |
| Fault detected | Air Conditioner | `alarm_generic` transitions from `false` → `true` (debounced, 30 s grace on reconnect) |

---

## Diagnostics

Open **Homey app → More → Apps → Tuya Local → Settings**.

### Diagnostic Logs

Timestamped in-memory buffer (max 500 entries, cleared on app restart):

| Level | Meaning |
|---|---|
| `[INF]` | Normal events: connect, disconnect, capability updates |
| `[WRN]` | Warnings: reconnect attempts, stale connection, rejected capability option values |
| `[ERR]` | Errors — includes ECONNRESET hint when a protocol version mismatch is likely |

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
| Device stays unavailable | Wrong IP, Device ID or Local Key | Use **Repair** to update credentials; check the Logs tab for the exact error |
| ECONNRESET on every connect | Protocol version mismatch | Use *Auto-detect* in Repair, or manually try 3.3, 3.4, 3.1, 3.5 |
| Device connects but values are wrong | Incorrect DP numbers | Adjust DPs in device settings |
| Smart Plug power reading is 10× off | Wrong power scale | Change **Power Scale** setting to ×0.1 |
| Energy (kWh) shows `—` or never updates | `dp_energy` set to 17 but device sends delta locally | Set `dp_energy = 0` — app will compute kWh from power readings |
| AC temperature is 10× too high | Device sends ×10 scaled values | Set `temp_divisor = 10` in AC device settings |
| AC mode / fan picker shows wrong options | `mode_values` / `fan_speed_values` mismatch | Update values in device settings, then restart the Tuya Local app |
| Picker still shows old options after saving | Homey caches capability options | Restart the Tuya Local app |
| Spurious water / fault alarm after reconnect | Reconnect artifact — device sends transient alarm on connect | Built-in debounce suppresses these; if they persist check the Logs tab |
| Generic device shows raw key as label | Missing locale key | Set labels via the `label` field in the dp_config mapping |

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
