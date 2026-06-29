# Tuya Local — Homey App

**Version 1.0.78** · Local WiFi/LAN control of Tuya smart devices — no cloud, no Zigbee hub required.

All communication happens over your local network via the Tuya LAN protocol. Sixteen built-in drivers cover the most common device types; a fully generic driver handles anything else.

---

## Drivers

| Driver | Typical devices | Device class |
|---|---|---|
| [Dehumidifier](#dehumidifier-1) | Dehumidifiers, air dryers | Dehumidifier |
| [Smart Plug](#smart-plug-1) | Smart plugs with energy monitoring | Socket |
| [Air Conditioner](#air-conditioner-1) | Any Tuya local LAN air conditioner | Thermostat |
| [Fan](#fan-1) | Ceiling fans, table fans, tower fans | Fan |
| [Humidifier](#humidifier-1) | Humidifiers, aroma diffusers | Humidifier |
| [Heater](#heater-1) | Panel heaters, convectors, oil radiators | Heater |
| [Light](#light-1) | Bulbs, LED strips, ceiling lights | Light |
| [Pet Feeder](#pet-feeder-1) | Automatic pet feeders (e.g. WOFEA, Mypin, PETKIT) | Pet Feeder |
| [Garage Door](#garage-door-1) | Garage door openers (WOFEA, AOSD, ZC34T, BoboYun gatePro) | Garage Door |
| [Heat Pump](#heat-pump-1) | Pool / air-water heat pumps (Phalén, Fairland, Brustec, BWT, Waterco, …) | Heat Pump |
| [Curtain Motor](#curtain-motor-1) | Curtain / blind / roller motors (Zemismart v1 & v2 and compatible) | Blinds |
| [Thermostat](#thermostat-1) | Floor heating, room thermostats, TRVs, zone valves | Thermostat |
| [Smart Kettle](#smart-kettle-1) | Smart kettles with temperature control | Kettle |
| [Wall Switch](#wall-switch-1) | 1/2/3/4-gang WiFi wall switches | Socket |
| [Generic Tuya Device](#generic-tuya-device-1) | Any Tuya device not covered above | Other |

---

## Features

- **Cloud-free** — all traffic stays on your local network
- **Real-time push** — instant state updates without polling (polling is optional and configurable)
- **Automatic reconnect** — exponential back-off with jitter; watchdog detects stale connections and reconnects
- **Cloud Lookup** — fetch Device ID and Local Key directly from the Tuya IoT Platform inside the app settings — no CLI tools needed. Click a device name to see all DPs with types, current values, and allowed ranges
- **Protocol auto-detect** — pairing and repair default to *Auto-detect*, which tries 3.3 → 3.4 → 3.1 → 3.5 → 3.2 → 3.22 in order and saves the working version automatically
- **Network scanner** — finds Tuya devices via UDP broadcast (ports 6666 / 6667) and a full TCP subnet scan (port 6668)
- **Auto DP detection** — on pairing, the app connects to the device, collects live data points and maps them to capabilities automatically
- **Inline DP editor** — every DP number can be adjusted in the pairing screen before adding the device
- **Optional capabilities** — tiles are added or removed dynamically based on your DP settings; set a DP to `0` to hide the tile
- **Live credential updates** — change IP address, Local Key or Protocol Version directly in device settings at any time without re-pairing
- **Computed energy metering** — kWh accumulated from live power readings using trapezoidal integration; persisted across restarts
- **Push notifications** — Homey notifications for water tank events, fault alarms and other device alerts
- **Efficient polling** — alternates between full GET and lightweight dp_refresh to reduce traffic
- **Diagnostic tools** — in-app log buffer, live DP debug panel and raw payload viewer
- **Bilingual** — full English and German UI

---

## Requirements

- Homey Pro with firmware **≥ 12.0.0**
- Device reachable on your **local network**
- **Device ID**, **Local Key** and **IP address** — see [How to get Device ID and Local Key](#how-to-get-device-id-and-local-key)

---

## How to get Device ID and Local Key

### Method 1 — Cloud Lookup in app settings (recommended)

No CLI tools or terminal needed. Everything happens inside the Homey app.

1. Create a free account at [iot.tuya.com](https://iot.tuya.com).
2. **Cloud** → **Project Management** → **Create Cloud Project** — industry: Smart Home, region: same as your mobile app.
3. Open your project → **Devices** → **Link Tuya App Account** → scan the QR code with Tuya Smart / Smart Life.
4. Open your project → **Overview** → copy **Access ID / Client ID** and **Access Secret / Client Secret**.
5. In Homey: **More** → **Apps** → **Tuya Local** → **Settings** → **☁️ Cloud Lookup** tab.
6. Paste your Access ID and Secret, select your data center, click **Fetch Devices**.
7. Use the **Copy** button next to each device to copy Name, Device ID and Local Key.

> If you recently reset or re-paired a device the Local Key changes. Click **Fetch Devices** again to get the new key.

### Method 2 — tuya-cli wizard

Requires Node.js ≥ 16 on your computer.

```bash
npx @tuyapi/cli wizard
```

The wizard logs you into the Tuya IoT Platform, links your Smart Life / Tuya mobile app, and lists every device with its **Device ID** and **Local Key**.

### Method 3 — Tuya IoT Platform (manual)

1. Open your project at [iot.tuya.com](https://iot.tuya.com).
2. **Devices** → **All Devices** → click the pencil icon next to your device.
3. Copy **Device ID** and **Device Secret** (= Local Key).

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
| Offline Grace Period (s) | Seconds to wait before triggering "device disconnected" flows — `0` = immediate | 60 |

#### Data Points

| Setting | Icon | Capability | Type | Default DP | Optional |
|---|:---:|---|---|---|---|
| `dp_onoff` |  | `onoff` | boolean | 1 | — |
| `dp_current_humidity` |  | `measure_humidity` | number | 16 | — |
| `dp_target_humidity` | <img src="assets/capabilities/target_humidity.svg" height="24"> | `target_humidity` | number | 2 | — |
| `dp_mode` | <img src="assets/capabilities/mode.svg" height="24"> | `mode` | enum | 4 | — |
| `dp_fan_speed` | <img src="assets/capabilities/fan_speed.svg" height="24"> | `fan_speed` | enum | 5 | — |
| `dp_child_lock` | <img src="assets/capabilities/child_lock.svg" height="24"> | `child_lock` | boolean | 14 | ✓ `0` = disabled |
| `dp_countdown_timer` | <img src="assets/capabilities/countdown_timer.svg" height="24"> | `countdown_timer` | enum | 17 | ✓ `0` = disabled |
| `dp_countdown_left` | <img src="assets/capabilities/countdown_left.svg" height="24"> | `countdown_left` | number | 18 | ✓ `0` = disabled |
| `dp_water_full` |  | `alarm_water` | boolean | 19 | ✓ `0` = disabled |
| `dp_temperature` |  | `measure_temperature` | number | 0 | ✓ `0` = disabled |
| `dp_anion` | <img src="assets/capabilities/anion.svg" height="24"> | `anion` | boolean | 0 | ✓ `0` = disabled |

#### Mode & Fan Speed Values

| Setting | Default (full superset) |
|---|---|
| `mode_values` | `manual,laundry,auto,continuous,smart,sleep,drying` |
| `fan_speed_values` | `low,medium,middle,high,auto,turbo` |

The exact strings vary by manufacturer. Check the **Raw Data** panel in app settings to find what your device sends. After saving, **restart the Tuya Local app** for the picker to reflect the updated options.

---

### Smart Plug

#### Connection

Same settings as Dehumidifier (IP, Device ID, Local Key, Protocol Version, Polling Interval, Offline Grace Period).

#### Data Points

| Setting | Icon | Capability | Type | Default DP | Optional |
|---|:---:|---|---|---|---|
| `dp_switch` |  | `onoff` | boolean | 1 | — |
| `dp_power` |  | `measure_power` | number | 19 | — |
| `dp_voltage` |  | `measure_voltage` | number | 20 | — |
| `dp_current` |  | `measure_current` | number | 18 | — |
| `dp_energy` |  | `meter_power` | number | **0** | ✓ see below |
| `dp_relay_status` |  | `relay_status` | enum | 38 | ✓ `0` = disabled |
| `dp_fault` |  | `alarm_generic` | boolean | 0 | ✓ `0` = disabled |
| `dp_power_factor` | <img src="assets/capabilities/power_factor.svg" height="24"> | `power_factor` | number | 0 | ✓ `0` = disabled |
| `dp_countdown` | <img src="assets/capabilities/countdown_timer.svg" height="24"> | *(flow only)* | number | 0 | ✓ `0` = disabled |

#### Energy Metering

Most Tuya plugs send the energy counter (DP 17, `add_ele`) as a **resetting delta** — the Tuya cloud accumulates the deltas into a lifetime total, but locally the value appears frozen.

When `dp_energy = 0` (default), the app computes kWh itself by integrating live power readings using **trapezoidal averaging** — the mean of the previous and current power reading multiplied by elapsed time. The result is monotonically increasing and persisted across app restarts.

Set `dp_energy = 17` only if your device provides a reliable cumulative local energy counter.

The energy accumulator can be reset via the **Reset energy meter** flow action.

#### Turn On Behavior Values

Controls what the device does when mains power is restored after an outage.

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

Same settings as Dehumidifier (IP, Device ID, Local Key, Protocol Version, Polling Interval, Offline Grace Period).

#### Data Points

| Setting | Icon | Capability | Type | Default DP | Optional |
|---|:---:|---|---|---|---|
| `dp_onoff` |  | `onoff` | boolean | 1 | — |
| `dp_target_temp` |  | `target_temperature` | number | 2 | — |
| `dp_current_temp` |  | `measure_temperature` | number | 3 | — |
| `dp_mode` | <img src="assets/capabilities/ac_mode.svg" height="24"> | `ac_mode` | enum | 4 | — |
| `dp_fan_speed` | <img src="assets/capabilities/ac_fan_speed.svg" height="24"> | `ac_fan_speed` | enum | 5 | — |
| `dp_swing` | <img src="assets/capabilities/ac_swing.svg" height="24"> | `ac_swing` | boolean | 0 | ✓ `0` = disabled |
| `dp_sleep` | <img src="assets/capabilities/ac_sleep.svg" height="24"> | `ac_sleep` | boolean | 0 | ✓ `0` = disabled |
| `dp_eco` | <img src="assets/capabilities/ac_eco.svg" height="24"> | `ac_eco` | boolean | 0 | ✓ `0` = disabled |
| `dp_child_lock` | <img src="assets/capabilities/child_lock.svg" height="24"> | `child_lock` | boolean | 0 | ✓ `0` = disabled |
| `dp_countdown_timer` | <img src="assets/capabilities/countdown_timer.svg" height="24"> | `countdown_timer` | number | 0 | ✓ `0` = disabled |
| `dp_countdown_left` | <img src="assets/capabilities/countdown_left.svg" height="24"> | `countdown_left` | number | 0 | ✓ `0` = disabled |
| `dp_fault` |  | `alarm_generic` | boolean | 20 | ✓ `0` = disabled |

#### Temperature Scaling

Some AC units send temperatures multiplied by 10 (e.g. `220` = 22.0 °C). The driver auto-detects this during pairing. If the displayed temperature is still 10× too high, set **`temp_divisor = 10`** in device settings.

#### Mode & Fan Speed Values

| Setting | Default |
|---|---|
| `mode_values` | `cool,heat,auto,dry,fan` |
| `fan_speed_values` | `auto,low,medium,high,turbo` |

---

### Fan

#### Connection

Same settings as Dehumidifier (IP, Device ID, Local Key, Protocol Version, Polling Interval, Offline Grace Period).

#### Data Points

| Setting | Icon | Capability | Type | Default DP | Optional |
|---|:---:|---|---|---|---|
| `dp_onoff` |  | `onoff` | boolean | 1 | — |
| `dp_speed` |  | `dim` (speed slider) | number | 3 | ✓ `0` = disabled |
| `speed_min` / `speed_max` |  | Speed range | number | 1 / 100 | — |
| `dp_fan_speed` | <img src="assets/capabilities/fan_speed.svg" height="24"> | `fan_speed` (enum) | enum | 0 | ✓ `0` = disabled |
| `dp_oscillate` | <img src="assets/capabilities/oscillate.svg" height="24"> | `oscillate` | boolean | 0 | ✓ `0` = disabled |
| `dp_direction` | <img src="assets/capabilities/fan_direction.svg" height="24"> | `fan_direction` | enum | 0 | ✓ `0` = disabled |
| `dp_mode` | <img src="assets/capabilities/fan_mode.svg" height="24"> | `fan_mode` | enum | 0 | ✓ `0` = disabled |
| `dp_child_lock` | <img src="assets/capabilities/child_lock.svg" height="24"> | `child_lock` | boolean | 0 | ✓ `0` = disabled |
| `dp_countdown_timer` | <img src="assets/capabilities/countdown_timer.svg" height="24"> | `countdown_timer` | enum | 0 | ✓ `0` = disabled |
| `dp_countdown_left` | <img src="assets/capabilities/countdown_left.svg" height="24"> | `countdown_left` | number | 0 | ✓ `0` = disabled |

The speed slider (`dim`) maps the numeric DP range `speed_min … speed_max` to 0–100 %. Both a numeric speed DP and a string enum DP (`fan_speed`) can be active at the same time.

#### Speed, Mode & Direction Values

| Setting | Default |
|---|---|
| `fan_speed_values` | `low,medium,high,auto,turbo` |
| `fan_mode_values` | `normal,sleep,nature,breeze,smart` |

The `fan_direction` capability uses fixed values `forward` and `reverse` (Tuya standard). The DP is auto-detected at pairing time if the device reports either of those strings.

---

### Humidifier

#### Connection

Same settings as Dehumidifier (IP, Device ID, Local Key, Protocol Version, Polling Interval, Offline Grace Period).

#### Data Points

| Setting | Icon | Capability | Type | Default DP | Optional |
|---|:---:|---|---|---|---|
| `dp_onoff` |  | `onoff` | boolean | 1 | — |
| `dp_current_humidity` |  | `measure_humidity` | number | 14 | — |
| `dp_target_humidity` | <img src="assets/capabilities/target_humidity.svg" height="24"> | `target_humidity` | number | 13 | — |
| `dp_mode` | <img src="assets/capabilities/mode.svg" height="24"> | `mode` | enum | 24 | — |
| `dp_fan_speed` | <img src="assets/capabilities/fan_speed.svg" height="24"> | `fan_speed` | enum | 0 | ✓ `0` = disabled |
| `dp_child_lock` | <img src="assets/capabilities/child_lock.svg" height="24"> | `child_lock` | boolean | 0 | ✓ `0` = disabled |
| `dp_water_empty` |  | `alarm_water` | boolean | 0 | ✓ `0` = disabled |
| `dp_countdown_timer` | <img src="assets/capabilities/countdown_timer.svg" height="24"> | `countdown_timer` | enum | 0 | ✓ `0` = disabled |
| `dp_countdown_left` | <img src="assets/capabilities/countdown_left.svg" height="24"> | `countdown_left` | number | 0 | ✓ `0` = disabled |
| `dp_temperature` |  | `measure_temperature` | number | 0 | ✓ `0` = disabled |
| `dp_anion` | <img src="assets/capabilities/anion.svg" height="24"> | `anion` | boolean | 0 | ✓ `0` = disabled |

> **Note:** `alarm_water` for a humidifier indicates that the water tank is **empty** (refill needed), as opposed to the dehumidifier where it means the tank is full.

#### Mode & Fan Speed Values

| Setting | Default |
|---|---|
| `mode_values` | `auto,manual,normal,sleep,eco,boost` |
| `fan_speed_values` | `low,medium,middle,high,auto` |

---

### Heater

#### Connection

Same settings as Dehumidifier (IP, Device ID, Local Key, Protocol Version, Polling Interval, Offline Grace Period).

#### Data Points

| Setting | Icon | Capability | Type | Default DP | Optional |
|---|:---:|---|---|---|---|
| `dp_onoff` |  | `onoff` | boolean | 1 | — |
| `dp_target_temp` |  | `target_temperature` | number | 2 | — |
| `dp_current_temp` |  | `measure_temperature` | number | 0 | ✓ `0` = disabled |
| `dp_mode` | <img src="assets/capabilities/mode.svg" height="24"> | `mode` | enum | 0 | ✓ `0` = disabled |
| `dp_oscillate` | <img src="assets/capabilities/oscillate.svg" height="24"> | `oscillate` | boolean | 0 | ✓ `0` = disabled |
| `dp_child_lock` | <img src="assets/capabilities/child_lock.svg" height="24"> | `child_lock` | boolean | 0 | ✓ `0` = disabled |
| `dp_fault` |  | `alarm_generic` | boolean | 0 | ✓ `0` = disabled |
| `dp_countdown_timer` | <img src="assets/capabilities/countdown_timer.svg" height="24"> | `countdown_timer` | enum | 0 | ✓ `0` = disabled |
| `dp_countdown_left` | <img src="assets/capabilities/countdown_left.svg" height="24"> | `countdown_left` | number | 0 | ✓ `0` = disabled |

#### Temperature Settings

| Setting | Description | Default |
|---|---|---|
| `temp_divisor` | Divide raw DP value to get °C — use `10` if device sends e.g. `215` for 21.5 °C | 1 |
| `temp_min` | Minimum target temperature (°C) | 5 |
| `temp_max` | Maximum target temperature (°C) | 35 |
| `temp_step` | Step size for the temperature slider (°C) | 1 |

#### Mode Values

| Setting | Default |
|---|---|
| `mode_values` | `eco,comfort,boost,away,auto` |

---

### Light

#### Connection

Same settings as Dehumidifier (IP, Device ID, Local Key, Protocol Version, Polling Interval, Offline Grace Period).

#### Data Points

| Setting | Icon | Capability | Type | Default DP | Optional |
|---|:---:|---|---|---|---|
| `dp_onoff` |  | `onoff` | boolean | 20 | — |
| `dp_brightness` |  | `dim` | number | 22 | — |
| `dp_color_temp` |  | `light_temperature` | number | 23 | ✓ `0` = disabled |
| `dp_color_mode` |  | `light_mode` | string | 21 | ✓ `0` = disabled |
| `dp_color` |  | `light_hue` + `light_saturation` | HSV hex | 24 | ✓ `0` = disabled |

Standard Tuya light DP layout (newer protocol):

| DP | Function |
|---|---|
| 20 | On/Off |
| 21 | Color mode (`white` / `colour`) |
| 22 | Brightness (0–1000) |
| 23 | Color temperature (0–1000) |
| 24 | HSV color (12-char hex `HHHHSSSSBBBB`) |

Older protocol uses DPs 1–5 instead of 20–24.

#### Light Settings

| Setting | Description | Default |
|---|---|---|
| `brightness_max` | Maximum raw brightness value | 1000 |
| `color_temp_max` | Maximum raw color temperature value | 1000 |
| `color_temp_invert` | Enable if `0` = warm white and max = cool white | false |
| `color_mode_white_val` | String the device uses for white/CCT mode | `white` |
| `color_mode_color_val` | String the device uses for color (HSV) mode | `colour` |

#### Color Handling

In **white mode**, the brightness (`dim`) slider writes directly to `dp_brightness`. In **color mode**, the brightness slider updates the V (value) component of the HSV hex string. Hue and saturation are mapped from the Homey `light_hue` / `light_saturation` capabilities.

---

### Heat Pump

Universal driver for pool / air-water heat pumps. Auto-detects all major DP layouts at pairing time.

| Device family | On/Off | Target temp | Current temp | Mode |
|---|---|---|---|---|
| Brustec / BWT / CBC / Madimack / Mountfield / Varpoolfaye | DP 1 | DP 2 | DP 3 | DP 4/5 |
| Phalén Calidi XP / Fairland InverterPlus | DP 1 | DP 106 | DP 102 | DP 105 |
| Waterco Electroheat ECO-VS | DP 101 | DP 104 | — | — |
| Apricus / Powerworld water HP | DP 1 | DP 2 | DP 3 | DP 4 |
| Arcelik / Axen combo (DHW + space heating) | DP 1 | DP 103–106 | — | DP 109 |

#### Connection

Same settings as Dehumidifier (IP, Device ID, Local Key, Protocol Version, Polling Interval, Offline Grace Period).

#### Data Points

| Setting | Icon | Capability | Type | Default DP | Optional |
|---|:---:|---|---|---|---|
| `dp_onoff` | | `onoff` | boolean | 1 | — |
| `dp_target_temp` | | `target_temperature` | number | 2 | — |
| `dp_current_temp` | | `measure_temperature` | number | 3 | ✓ `0` = disabled |
| `dp_mode` | <img src="assets/capabilities/heat_pump_mode.svg" height="24"> | `heat_pump_mode` | enum | 0 | ✓ `0` = disabled |
| `dp_preset` | <img src="assets/capabilities/heat_pump_preset.svg" height="24"> | `heat_pump_preset` | enum or bool | 0 | ✓ `0` = disabled |
| `dp_fault` | | `alarm_generic` | bitfield / bool | 0 | ✓ `0` = disabled |
| `dp_power_level` | <img src="assets/capabilities/power_level.svg" height="24"> | `power_level` | number | 0 | ✓ `0` = disabled |

#### Temperature Settings

| Setting | Description | Default |
|---|---|---|
| `temp_divisor` | Divide raw DP value to get °C — use `10` if device sends e.g. `350` for 35 °C | 1 (auto-detected) |
| `temp_min` | Minimum target temperature (°C) | 12 |
| `temp_max` | Maximum target temperature (°C) | 45 |
| `temp_step` | Step size for the temperature slider (°C) | 1 |

#### Mode & Preset Values

| Setting | Description | Default |
|---|---|---|
| `mode_values` | Comma-separated mode strings matching your device | `heat,cool,auto` |
| `preset_values` | Comma-separated preset names — for bool DPs the first value = false, second = true | `sleep,comfort,boost` |

Check the **Raw Data** panel in app settings to find the exact strings your device sends. A bool preset DP (e.g. Phalén DP 117: `false` = sleep, `true` = boost) is handled automatically — set `preset_values = sleep,boost`.

---

### Curtain Motor

Universal driver for curtain, blind and roller motors (Tuya category `cl`). Auto-detects all DP layouts at pairing time.

| Device | Control DP | Position DP | Work state DP | Fault DP |
|---|---|---|---|---|
| Zemismart v1 | DP 1 `open`/`stop`/`close` | DP 2 (0–100 %) | DP 7 | DP 10 |
| Zemismart v2 | DP 1 | DP 2 | DP 7 | DP 12 |
| Most category-cl motors | DP 1 | DP 2 | DP 7 | DP 10 or 12 |

#### Connection

Same settings as Dehumidifier (IP, Device ID, Local Key, Protocol Version, Polling Interval, Offline Grace Period).

#### Data Points

| Setting | Capability | Type | Default DP | Optional |
|---|---|---|---|---|
| `dp_control` | `windowcoverings_state` | enum `open`/`stop`/`close` | 1 | — |
| `dp_percent_control` | `windowcoverings_set` | integer 0–100 % | 2 | — |
| `dp_work_state` | `windowcoverings_state` | enum `opening`/`closing` (read-only) | 7 | ✓ `0` = disabled |
| `dp_fault` | `alarm_generic` | bitmap | 0 | ✓ `0` = disabled |

#### Device Settings

| Setting | Description | Default |
|---|---|---|
| `invert_position` | Enable if `0 %` = open and `100 %` = closed on your device | `false` |

> **Position convention:** The driver maps `percent_control` where `0` = fully closed and `100` = fully open to Homey's `windowcoverings_set` (0.0–1.0). Enable `invert_position` if your device uses the opposite convention.

> **Zemismart v2 extra DPs:** DP 16 (`border` / limit calibration) and DP 19 (`position_best` / favourite position) are motor-setup commands — run the limit calibration from the Tuya/Smart Life app first, then use Homey for daily control.

---

### Thermostat

Universal driver for floor heating thermostats, room thermostats, TRVs (radiator valves), and zone valves.

#### Connection

Same settings as Dehumidifier (IP, Device ID, Local Key, Protocol Version, Polling Interval, Offline Grace Period).

#### Data Points

| Setting | Capability | Type | Default DP | Optional |
|---|---|---|---|---|
| `dp_onoff` | `onoff` | boolean | 1 | — |
| `dp_target_temp` | `target_temperature` | number | 2 | — |
| `dp_current_temp` | `measure_temperature` | number | 3 | — |
| `dp_mode` | `thermostat_mode` | enum | 4 | ✓ `0` = disabled |
| `dp_child_lock` | `child_lock` | boolean | 0 | ✓ `0` = disabled |
| `dp_battery` | `measure_battery` | number | 0 | ✓ `0` = disabled (TRVs only) |
| `dp_fault` | `alarm_generic` | bitfield | 0 | ✓ `0` = disabled |

#### Temperature Settings

| Setting | Description | Default |
|---|---|---|
| `temp_divisor` | Divide raw DP value to get °C — use `10` if device sends e.g. `220` for 22.0 °C (common on BHT-002 / Moes) | 1 (auto-detected) |
| `temp_min` | Minimum target temperature (°C) | 5 |
| `temp_max` | Maximum target temperature (°C) | 35 |
| `temp_step` | Step size for the temperature slider (°C) | 0.5 |

#### Mode Values

| Setting | Default |
|---|---|
| `mode_values` | `manual,auto,program` |

Common alternatives: `heat,cool,off` (HVAC), `auto,manual,holiday` (TRV), `comfort,eco,away` (floor heating).

---

### Smart Kettle

Supports Tuya smart kettles with temperature control, keep-warm, and mode selection (Anko, Aeno, Kogan and others).

#### Connection

Same settings as Dehumidifier (IP, Device ID, Local Key, Protocol Version, Polling Interval, Offline Grace Period).

#### Data Points

| Setting | Capability | Type | Default DP | Optional |
|---|---|---|---|---|
| `dp_onoff` | `onoff` | boolean | 1 | — |
| `dp_current_temp` | `measure_temperature` | number | 2 | — |
| `dp_target_temp` | `target_temperature` | number | 4 | ✓ `0` = disabled |
| `dp_keep_warm` | `kettle_keep_warm` | boolean | 13 | ✓ `0` = disabled |
| `dp_status` | `kettle_status` | enum | 15 | ✓ `0` = disabled |
| `dp_mode` | `kettle_mode` | enum | 16 | ✓ `0` = disabled |
| `dp_fault` | `alarm_generic` | bitfield | 0 | ✓ `0` = disabled |

#### Temperature Settings

| Setting | Description | Default |
|---|---|---|
| `temp_min` | Minimum target temperature (°C) | 40 |
| `temp_max` | Maximum target temperature (°C) | 100 |
| `temp_step` | Step size (°C) | 5 |

#### Mode & Status Values

| Setting | Default |
|---|---|
| `mode_values` | `boil,heat,keep_warm` |
| `status_values` | `standby,heating,cooling,warm,done` |

Some kettles use tea-specific modes (e.g. Aeno EK1S): `mzj_black,mzj_green,mzj_water,mzj_oolong,mzj_warm`.

---

### Wall Switch

Dedicated driver for 1/2/3/4-gang WiFi wall switches. Each gang gets its own tile and flow cards.

#### Connection

Same settings as Dehumidifier (IP, Device ID, Local Key, Protocol Version, Polling Interval, Offline Grace Period).

#### Data Points

| Setting | Capability | Type | Default DP | Optional |
|---|---|---|---|---|
| `dp_switch_1` | `onoff` | boolean | 1 | — |
| `dp_switch_2` | `onoff.2` | boolean | 0 | ✓ `0` = disabled |
| `dp_switch_3` | `onoff.3` | boolean | 0 | ✓ `0` = disabled |
| `dp_switch_4` | `onoff.4` | boolean | 0 | ✓ `0` = disabled |
| `dp_countdown_1–4` | *(settings only)* | number | 0 | ✓ `0` = disabled |
| `dp_relay_status` | *(settings only)* | enum | 0 | ✓ `0` = disabled |

#### Switch Names

Each switch tile can be renamed in **Settings → Switch Names**. Leave empty for the default name ("Power" / "Switch 2/3/4"). The app needs to be restarted for name changes to take effect.

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

**Debounce:** Slider capabilities are debounced by 300 ms to prevent flooding the device during drag.

#### Available capability pools

| Pool | Capability IDs | Type | Settable |
|---|---|---|---|
| Sensors | `generic_sensor_1` … `generic_sensor_4` | number | No |
| Sliders | `generic_number_1`, `generic_number_2` | number | Yes |
| Toggles | `generic_switch_1` … `generic_switch_4` | boolean | Yes |
| Pickers | `generic_picker_1` … `generic_picker_4` | enum | Yes |
| Standard | `onoff`, `measure_temperature`, `measure_humidity`, `measure_power`, `measure_voltage`, `measure_current`, `meter_power`, and others | various | varies |

---

### Pet Feeder

#### Connection

Same settings as Dehumidifier (IP, Device ID, Local Key, Protocol Version, Polling Interval, Offline Grace Period).

#### Data Points

| Setting | Icon | Capability | Type | Default DP | Optional |
|---|:---:|---|---|---|---|
| `dp_portions` | <img src="assets/capabilities/feed_portions.svg" height="24"> | `feed_portions` | enum picker | 3 | — |
| `dp_motor_state` | <img src="assets/capabilities/motor_state.svg" height="24"> | `motor_state` | enum | 4 | ✓ `0` = disabled |
| `dp_fault` | | `alarm_generic` | bitfield | 14 | ✓ `0` = disabled |
| `dp_feed_report` | <img src="assets/capabilities/feed_report.svg" height="24"> | `feed_report` | number | 15 | ✓ `0` = disabled |
| `dp_surplus_grain` | <img src="assets/capabilities/surplus_grain.svg" height="24"> | `surplus_grain` | number | 16 | ✓ `0` = disabled |
| `dp_food_level` | <img src="assets/capabilities/food_status.svg" height="24"> | `food_status` | enum | 0 | ✓ `0` = disabled |
| `dp_child_lock` | <img src="assets/capabilities/child_lock.svg" height="24"> | `child_lock` | boolean | 0 | ✓ `0` = disabled |
| `dp_battery` | | `measure_battery` | number | 0 | ✓ `0` = disabled |
| `dp_indicator_light` | <img src="assets/capabilities/indicator_light.svg" height="24"> | `indicator_light` | boolean | 0 | ✓ `0` = disabled |
| `dp_voice_playback` | <img src="assets/capabilities/voice_playback.svg" height="24"> | `voice_playback` | boolean | 0 | ✓ `0` = disabled |
| `dp_battery_status` | <img src="assets/capabilities/battery_status.svg" height="24"> | `battery_status` | enum | 0 | ✓ `0` = disabled |

All DP numbers are auto-detected at pairing time. Set any optional DP to `0` to hide the tile.

#### Food Level Values

| Value | Meaning |
|---|---|
| `full` / `high` / `half` | Adequate food in the hopper |
| `low` / `less` / `lack` | Level is low — triggers push notification |
| `empty` | Hopper is empty — also triggers notification |

`less` and `lack` are used by Mypin 6L and some video feeder variants.

#### Portions Picker

| Setting | Description | Default |
|---|---|---|
| `portions_min` | Lowest value shown in the portions picker | 1 |
| `portions_max` | Highest value shown in the portions picker | 12 |

The picker range is rebuilt on every startup and whenever these settings change.

#### Other Settings

| Setting | Description | Default |
|---|---|---|
| `food_empty_values` | Comma-separated food status values that trigger a push notification | `low,less,empty,lack` |
| `voice_times` | Number of times the mealtime recording plays (written to device) | 1 |
| `manual_button_portions` | Portions dispensed per physical button press (written to device) | 1 |

---

### Garage Door

Supports four device families with automatic DP pattern detection at pairing time.

| Device family | State DP | Control DP | Examples |
|---|---|---|---|
| WOFEA / ckmkzq | DP 3 bool | DP 6 enum `open`/`close` | WOFEA WF-CS01 |
| ZC34T swing arm | DP 1 string `"open"`/`"closed"` | DP 101 string `open`/`close`/`stop` | ZC34T-03-3A |
| AOSD + light | DP 107 string `opened`/`closing`/… | DP 101 string | AOSD garage door with light |
| BoboYun gatePro | DP 10 string `opened`/`closing`/… | DP 106 bool (open) + DP 107 bool (close) | BoboYun gatePro |

#### Connection

Same settings as Dehumidifier (IP, Device ID, Local Key, Protocol Version, Polling Interval, Offline Grace Period).

#### Data Points

| Setting | Capability | Default DP | Description |
|---|---|---|---|
| `dp_door_contact` | `garagedoor_closed` | 3 | Bool or string `"open"`/`"closed"` contact sensor. WOFEA DP 3, ZC34T DP 1, eWeLink DP 2. |
| `dp_door_action` | `garagedoor_closed` | 0 | String action state (`opened`/`closed`/`opening`/`closing`). AOSD DP 107, BoboYun DP 10. |
| `dp_door_control` | — | 6 | Combined open/close command DP. WOFEA DP 6 (enum), AOSD/ZC34T DP 101 (string). |
| `dp_door_open` | — | 0 | Separate bool open DP (BoboYun DP 106: send `true` → open). |
| `dp_door_close` | — | 0 | Separate bool close DP (BoboYun DP 107: send `true` → close). |
| `dp_switch` | — | 1 | Relay toggle DP (WOFEA DP 1 = relay pulse; BoboYun DP 103 = stop). Used by Toggle and Stop actions. |
| `dp_door_state` | `alarm_generic` | 12 | Alarm state. WOFEA: `none`/`unclosed_time`/`close_time_alarm`. BoboYun: `No`/event strings (set to 141). |
| `dp_light` | `onoff.light` | 0 | Integrated light switch. AOSD DP 105, BoboYun DP 102. `0` = disabled. |

All DPs are auto-detected at pairing time. For AOSD and BoboYun, `dp_door_action` and `dp_light` are detected automatically; BoboYun's `dp_door_state` (DP 141) must be set manually.

#### Device Settings

| Setting | Description | Default |
|---|---|---|
| `door_contact_invert` | Swap open/closed reading from the contact sensor — enable if the door shows open when closed | `false` |
| `use_relay_toggle` | Enable for single-relay openers (e.g. WOFEA): tile button and Open/Close flow actions send a relay pulse on `dp_switch` instead of an open/close command. The door status continues to be read from the contact sensor. | `false` |

#### Control Logic

| Configuration | Open door | Close door | Stop door |
|---|---|---|---|
| `dp_door_open > 0` (BoboYun) | `set(dp_door_open, true)` | `set(dp_door_close, true)` | `set(dp_switch, true)` |
| `dp_door_control > 0` (WOFEA / AOSD / ZC34T) | `set(dp_door_control, 'open')` | `set(dp_door_control, 'close')` | `set(dp_door_control, 'stop')` |

**Stop note:** WOFEA DP 6 only accepts `open`/`close`; sending `stop` is silently ignored by the device. Use the **Toggle** action to interrupt movement on WOFEA devices.

#### Action state vs. contact sensor

- **Contact sensor** (`dp_door_contact`): reports binary open/closed — opens/closed flow triggers fire on every change.
- **Action state** (`dp_door_action`): reports `opened`/`opening`/`closing`/`closed` — opened/closed flow triggers fire only on **terminal states** (`opened` / `closed`), not during movement.

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
| AC fault alarm triggered | `fault_code` (number) |
| AC mode changed | `mode` (string), `prev_mode` (string) |
| AC data point changed | `dp` (string), `value` (string) |

#### Conditions

| Condition |
|---|
| AC is / is not connected |
| AC mode is / is not [mode] |
| AC fan speed is / is not [speed] |
| AC sleep mode is on / is off |
| AC fault alarm is / is not active |

#### Actions

| Action | Notes |
|---|---|
| Set AC mode | cool / heat / auto / dry / fan |
| Set AC fan speed | auto / low / medium / high / turbo |
| Set AC target temperature | Configurable min/max/step |
| Set AC swing | on / off — requires `dp_swing` > 0 |
| Set AC sleep mode | on / off — requires `dp_sleep` > 0 |
| Set AC ECO mode | on / off — requires `dp_eco` > 0 |
| Set AC ioniser | on / off — requires `dp_anion` > 0 |
| Set AC horizontal swing | on / off — requires `dp_swing_h` > 0 |
| Set AC child lock | on / off — requires `dp_child_lock` > 0 |
| Force AC reconnect | Drops and re-establishes the TCP connection |
| Refresh AC device | Triggers an immediate GET request |

---

### Fan

#### Triggers

| Trigger | Flow tokens |
|---|---|
| Fan connected | — |
| Fan disconnected | — |
| Fan mode changed | `mode` (string), `prev_mode` (string) |
| Fan direction changed | `direction` (string), `prev_direction` (string) |
| Fan data point changed | `dp` (string), `value` (string) |

#### Conditions

| Condition |
|---|
| Fan is / is not connected |
| Fan mode is / is not [mode] |
| Fan direction is / is not [forward\|reverse] |

#### Actions

| Action | Notes |
|---|---|
| Set fan mode | normal / sleep / nature / breeze / smart |
| Set fan speed | low / medium / high / auto / turbo |
| Set fan oscillation | on / off — requires `dp_oscillate` > 0 |
| Set fan direction | forward / reverse — requires `dp_direction` > 0 |
| Force fan reconnect | Drops and re-establishes the TCP connection |
| Refresh fan values | Triggers an immediate GET request |

---

### Humidifier

#### Triggers

| Trigger | Filter tokens | Flow tokens |
|---|---|---|
| Humidity went above threshold | threshold (%) | `humidity`, `prevHumidity` |
| Humidity dropped below threshold | threshold (%) | `humidity`, `prevHumidity` |
| Water tank became empty | — | — |
| Water tank was refilled | — | — |
| Humidifier connected | — | — |
| Humidifier disconnected | — | — |
| Humidifier data point changed | — | `dp` (string), `value` (string) |

#### Conditions

| Condition |
|---|
| Humidifier is / is not connected |
| Humidity is / is not above [value] % |
| Humidity is / is not below [value] % |
| Water tank is / is not empty |

#### Actions

| Action | Notes |
|---|---|
| Set target humidity | 25–95 % |
| Set humidifier mode | auto / manual / normal / sleep / eco / boost |
| Set humidifier fan speed | low / medium / high / auto |
| Force humidifier reconnect | Drops and re-establishes the TCP connection |
| Refresh humidifier values | Triggers an immediate GET request |

---

### Heater

#### Triggers

| Trigger | Flow tokens |
|---|---|
| Heater connected | — |
| Heater disconnected | — |
| Heater fault alarm triggered | — |
| Heater data point changed | `dp` (string), `value` (string) |

#### Conditions

| Condition |
|---|
| Heater is / is not connected |
| Heater fault alarm is / is not active |
| Heater mode is / is not [mode] |

#### Actions

| Action | Notes |
|---|---|
| Set heater mode | eco / comfort / boost / away / auto |
| Set heater target temperature | Configurable min/max/step |
| Set heater child lock | on / off — requires `dp_child_lock` > 0 |
| Force heater reconnect | Drops and re-establishes the TCP connection |
| Refresh heater values | Triggers an immediate GET request |

---

### Light

#### Triggers

| Trigger | Flow tokens |
|---|---|
| Light connected | — |
| Light disconnected | — |
| Light data point changed | `dp` (string), `value` (string) |

#### Conditions

| Condition |
|---|
| Light is / is not connected |

#### Actions

| Action | Notes |
|---|---|
| Force light reconnect | Drops and re-establishes the TCP connection |
| Refresh light values | Triggers an immediate GET request |

> Standard Homey light capabilities (`onoff`, `dim`, `light_hue`, `light_saturation`, `light_temperature`, `light_mode`) are fully accessible via the built-in Homey flow cards.

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

### Pet Feeder

#### Triggers

| Trigger | Flow tokens |
|---|---|
| Pet feeder connected | — |
| Pet feeder disconnected | — |
| Food level changed | `food_status` (string), `prev_status` (string) |
| Feeding completed | — |
| Pet feeder data point changed | `dp` (string), `value` (string) |

> **Offline grace period:** The "disconnected" trigger is delayed by the **Offline Grace Period** setting (default 60 s). Tuya pet feeder firmware briefly drops the TCP connection at certain intervals — without the grace period this causes spurious nightly offline notifications.

#### Conditions

| Condition |
|---|
| Food level is / is not low |
| Pet feeder is / is not connected |

#### Actions

| Action | Notes |
|---|---|
| Feed [[portions]] portion(s) now | Dispenses 1–50 portions immediately |
| Refresh pet feeder values | Triggers an immediate GET request |
| Force pet feeder reconnect | Drops and re-establishes the TCP connection |

---

### Heat Pump

#### Triggers

| Trigger | Flow tokens |
|---|---|
| Heat pump connected | — |
| Heat pump disconnected | — |
| Heat pump mode changed | `mode` (string), `prev_mode` (string) |
| Fault alarm triggered | `fault_code` (string) |
| Heat pump data point changed | `dp` (string), `value` (string) |

#### Conditions

| Condition |
|---|
| Heat pump is / is not on |
| Fault alarm is / is not active |
| Heat pump is / is not connected |

#### Actions

| Action | Notes |
|---|---|
| Set operating mode | Values from `mode_values` setting — autocomplete in flow editor |
| Set preset | Values from `preset_values` setting — autocomplete in flow editor |
| Force heat pump reconnect | Drops and re-establishes the TCP connection |
| Refresh heat pump values | Triggers an immediate GET request |

---

### Garage Door

#### Triggers

| Trigger | Flow tokens |
|---|---|
| Garage door opened | — |
| Garage door closed | — |
| Garage door alarm triggered | `alarm_state` (string) — e.g. `unclosed_time`, `close_time_alarm`, `openLongTime` |
| Garage door opener connected | — |
| Garage door opener disconnected | — |
| Garage door data point changed | `dp` (string), `value` (string) |

> **Opened/closed triggers with action state DP:** When using `dp_door_action` (AOSD / BoboYun), the opened and closed triggers fire only on terminal states (`opened` / `closed`), not on intermediate `opening` / `closing` states.

#### Conditions

| Condition |
|---|
| Garage door is open / is closed |
| Garage door opener is / is not connected |

#### Actions

| Action | Notes |
|---|---|
| Open garage door | Sends open command via `dp_door_control` or `dp_door_open` |
| Close garage door | Sends close command via `dp_door_control` or `dp_door_close` |
| Stop garage door | Sends stop via `dp_door_control` (AOSD/ZC34T) or `dp_switch` (BoboYun). WOFEA: use Toggle instead |
| Toggle garage door | Sends a relay pulse on `dp_switch` — equivalent to pressing the wall button |
| Force garage door opener reconnect | Drops and re-establishes the TCP connection |
| Refresh garage door values | Triggers an immediate GET request |

---

### Curtain Motor

#### Triggers

| Trigger | Flow tokens |
|---|---|
| Curtain fully opened | — |
| Curtain fully closed | — |
| Curtain position changed | `position` (number, %) |
| Motor fault triggered | `fault_code` (string) |
| Curtain motor connected | — |
| Curtain motor disconnected | — |
| Curtain motor data point changed | `dp` (string), `value` (string) |

> **Opened / closed triggers** fire when the position reaches 100 % (opened) or 0 % (closed). They do **not** fire during intermediate movement.

#### Conditions

| Condition |
|---|
| Curtain is / is not open (> 50 %) |
| Curtain is / is not fully closed (= 0 %) |
| Curtain is / is not moving |
| Curtain motor is / is not connected |

#### Actions

| Action | Notes |
|---|---|
| Open curtain | Sends `open` on `dp_control` |
| Close curtain | Sends `close` on `dp_control` |
| Stop curtain | Sends `stop` on `dp_control` |
| Set curtain position to [%] | 0 = fully closed, 100 = fully open |
| Force curtain motor reconnect | Drops and re-establishes the TCP connection |
| Refresh curtain motor values | Triggers an immediate GET request |

---

### Thermostat

#### Triggers

| Trigger | Flow tokens |
|---|---|
| Thermostat mode changed | `mode` (string), `prev_mode` (string) |
| Thermostat connected | — |
| Thermostat disconnected | — |
| Thermostat data point changed | `dp` (string), `value` (string) |

#### Conditions

| Condition |
|---|
| Thermostat mode is / is not [mode] |
| Thermostat is / is not connected |

#### Actions

| Action | Notes |
|---|---|
| Set thermostat mode | Uses values from `mode_values` setting |
| Set target temperature | Configurable min/max/step |
| Force thermostat reconnect | Drops and re-establishes the TCP connection |
| Refresh thermostat values | Triggers an immediate GET request |

---

### Smart Kettle

#### Triggers

| Trigger | Flow tokens |
|---|---|
| Kettle finished boiling | — |
| Kettle status changed | `status` (string), `prev_status` (string) |
| Kettle connected | — |
| Kettle disconnected | — |
| Kettle data point changed | `dp` (string), `value` (string) |

#### Conditions

| Condition |
|---|
| Kettle is / is not heating |
| Kettle is / is not connected |

#### Actions

| Action | Notes |
|---|---|
| Set target temperature | 40–100 °C |
| Set kettle mode | Uses values from `mode_values` setting |
| Set keep warm | on / off |
| Force kettle reconnect | Drops and re-establishes the TCP connection |
| Refresh kettle values | Triggers an immediate GET request |

---

### Wall Switch

#### Triggers

| Trigger | Flow tokens |
|---|---|
| A switch gang changed | `gang` (string: 1/2/3/4), `state` (boolean) |
| Wall switch connected | — |
| Wall switch disconnected | — |
| Wall switch data point changed | `dp` (string), `value` (string) |

#### Conditions

| Condition |
|---|
| Switch gang is / is not on |
| Wall switch is / is not connected |

#### Actions

| Action | Notes |
|---|---|
| Set switch gang on or off | Select gang (1–4) and state (on/off) |
| Toggle switch gang | Inverts current state of selected gang |
| Force wall switch reconnect | Drops and re-establishes the TCP connection |
| Refresh wall switch values | Triggers an immediate GET request |

---

## Push Notifications

| Event | Driver | Condition |
|---|---|---|
| Water tank is full | Dehumidifier | Alarm active — debounced to suppress reconnect artifacts |
| Water tank is empty | Humidifier | `alarm_water` transitions `false` → `true` |
| Fault detected | Smart Plug | `alarm_generic` transitions `false` → `true` |
| Fault detected | Air Conditioner | `alarm_generic` transitions `false` → `true` (debounced, 30 s grace on reconnect) |
| Fault detected | Heater | `alarm_generic` transitions `false` → `true` (debounced, 30 s grace on reconnect) |
| Fault detected | Heat Pump | `alarm_generic` transitions `false` → `true` (debounced, 30 s grace on reconnect) |
| Food level low / empty | Pet Feeder | `food_status` transitions to any value in `food_empty_values` (default: `low,less,empty,lack`) |
| Motor reports no food | Pet Feeder | `motor_state` = `no_food` — hopper empty during feeding attempt |
| Garage door left open | Garage Door | Alarm state `unclosed_time` (WOFEA) or `openLongTime` (BoboYun) — uses "left open" message |
| Garage door alarm | Garage Door | Any other alarm state (e.g. `close_time_alarm`, `closeLongTime`) — uses generic fault message |
| Motor fault detected | Curtain Motor | `alarm_generic` transitions `false` → `true` (debounced, 30 s grace on reconnect) |

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

Repeated identical messages are automatically suppressed: the first 3 occurrences are shown in full, then one summary every 10th repeat, and a final "suppressed N more times" note when the message changes.

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

### Cloud Lookup

Fetch device credentials and DP specifications from the Tuya IoT Platform:
- Enter your **Access ID** and **Access Secret** from iot.tuya.com → Cloud → Project Management → your project → Overview
- Select your **Data Center** and click **Fetch Devices**
- View all linked devices with **Device ID** and **Local Key**
- **Click a device name** to see the full DP specification: DP numbers, code names, types, current values, allowed ranges, and read/write status
- **Copy** button per device (Name + ID + Key) and **Copy DP Table** for the specification
- Useful for finding exact enum strings (`mode`, `fan_speed`, etc.)

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Device stays unavailable | Wrong IP, Device ID or Local Key | Open the device in Homey → **Settings** → update the credentials; check the Logs tab for the exact error |
| ECONNRESET on every connect | Protocol version mismatch | Open device **Settings** → set Protocol Version to **Auto-detect**, or manually try 3.3, 3.4, 3.1, 3.5 in turn |
| Device connects but values are wrong | Incorrect DP numbers | Adjust DPs in device settings |
| Smart Plug power reading is 10× off | Wrong power scale | Change **Power Scale** setting to ×0.1 |
| Energy (kWh) shows `—` or never updates | `dp_energy` set to 17 but device sends delta locally | Set `dp_energy = 0` — app will compute kWh from power readings |
| AC / Heater temperature is 10× too high | Device sends ×10 scaled values | Set `temp_divisor = 10` in device settings |
| Mode / fan picker shows wrong options | `mode_values` / `fan_speed_values` mismatch | Update values in device settings, then restart the Tuya Local app |
| Picker still shows old options after saving | Homey caches capability options | Restart the Tuya Local app |
| Light color mode not working | Wrong `color_mode_white_val` / `color_mode_color_val` | Check Raw Data panel for actual strings sent by device (e.g. `white`, `colour`, `color`) |
| Humidifier water alarm fires on connect | Device sends transient alarm on reconnect | Built-in debounce suppresses these; if they persist increase the alarm guard window |
| Spurious fault alarm after reconnect | Reconnect artifact | Built-in 30 s grace period on reconnect suppresses these (AC, Heater, Heat Pump) |
| Heat pump mode/preset picker does nothing | DP was enabled after initial pairing — listener not registered | Restart the Tuya Local app; the listener is re-registered on next `onInit` |
| Pet feeder sends 3–4 "disconnected" notifications per night | Tuya firmware briefly drops TCP connection at timed intervals | Increase **Offline Grace Period** in device settings (default 60 s already handles most cases; try 120 s if it still fires) |
| Generic device shows raw key as label | Missing locale key | Set labels via the `label` field in the dp_config mapping |
| Curtain position slider is inverted | Device uses 0 = open, 100 = closed | Enable `invert_position` in device settings |
| Curtain tile shows "moving" but motor has stopped | `work_state` DP not resetting on this device | Set `dp_work_state = 0` to disable it |
| Curtain motor limit positions are wrong | Motor limits not calibrated | Run limit calibration from the Tuya / Smart Life app (DP 16 `border`) before using Homey |
| Thermostat temperature is 10× too high | Device sends ×10 values (e.g. BHT-002, Moes) | Set `temp_divisor = 10` in device settings |
| Thermostat mode picker shows wrong options | `mode_values` mismatch | Check Raw Data panel for actual strings, update `mode_values` in settings |
| Wall switch trigger doesn't fire for switch 2+ | Using Homey's built-in "Turned on/off" trigger | Use the Wall Switch-specific **"A switch gang changed"** trigger card instead |
| Wall switch tile names don't update | Homey caches capability titles | Restart the Tuya Local app after changing switch names |
| Kettle mode picker empty | `mode_values` doesn't match device strings | Check Raw Data for exact mode strings (some use `mzj_black`, `boiling_quick`, etc.) |
| Device missing DPs or SET commands rejected | Standard Instruction Set hides some DPs | Switch to **DP Instruction Set** on iot.tuya.com → Devices → your device → Instruction Mode |
| Cloud Lookup shows fewer DPs than expected | Same cause — Standard mode limits visible DPs | Switch to DP Instruction mode, then re-fetch in Cloud Lookup |
| SET command causes disconnect | Device rejects encrypted command | 1) Refresh Local Key via Cloud Lookup. 2) Enable **Fire and Forget** in device settings. 3) Switch instruction mode to DP on iot.tuya.com |

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
