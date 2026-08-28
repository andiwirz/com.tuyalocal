# Tuya Local — Homey App

**Version 1.0.215** · Local WiFi/LAN control of Tuya smart devices — no cloud, no Zigbee hub required.

All communication happens over your local network via the Tuya LAN protocol. Twenty-one built-in drivers cover the most common device types; a fully generic driver handles anything else.

---

## Drivers

| Driver | Typical devices | Device class |
|---|---|---|
| [Dehumidifier](#dehumidifier-1) | Dehumidifiers, air dryers | Dehumidifier |
| [Smart Plug](#smart-plug-1) | Smart plugs with energy monitoring | Socket |
| [Air Conditioner](#air-conditioner-1) | Any Tuya local LAN air conditioner | Air Conditioner |
| [Fan](#fan-1) | Ceiling fans, table fans, tower fans | Fan |
| [Ceiling Fan Light](#ceiling-fan-light-1) | Ceiling fans with a built-in light (fan + light on one device) | Light |
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
| [Doorbell](#doorbell-1) | Tuya video doorbells (Marmitek Buzz LO, Bcom Majic IPBox, Cleverio CD-200 and compatible) | Doorbell |
| [Presence Sensor](#presence-sensor-1) | mmWave radar presence sensors (ZY-M100-WIFI and compatible) | Sensor |
| [Energy Meter](#energy-meter-1) | DIN-rail meters, clamp meters and metering breakers (`zndb`, `dlq`) | Sensor |
| [Weather Station](#weather-station-1) | WiFi weather stations with outdoor sensors (temperature, humidity, pressure, wind, rain) | Sensor |
| [Ultrasonic Level Sensor](#ultrasonic-level-sensor-1) | Tank and cistern level sensors with configurable alarm thresholds | Sensor |
| [EV Charger](#ev-charger-1) | Tuya EV chargers, category `qccdz` (Vevor, Nine, Tera, Emini, Aimiler, Ecopoint, Dowell, Feyree, AfyeEV, Junsun, Zencar, iPengen, Suntree, Immax, Voldt, Wadapower and other rebrands) | EV Charger |
| [Generic Tuya Device](#generic-tuya-device-1) | Any Tuya device not covered above | Other |

A **Face Access Panel** driver also exists but is **deprecated**: these panels keep their user
database, unlocking and event reporting behind the Tuya cloud, and the local protocol exposes
too little to control one usefully. Existing devices keep working; the driver no longer appears
when adding a device.

---

## Features

- **Cloud-free** — all traffic stays on your local network
- **Real-time push** — instant state updates without polling (polling is optional and configurable)
- **Automatic reconnect** — exponential back-off with jitter; watchdog detects stale connections and reconnects
- **Protocol auto-rotation** — after 5 consecutive reconnect failures the connection manager cycles through the fallback protocol versions (3.3 → 3.4 → 3.1 → 3.5 → 3.2). A connection counts towards that only once the device has actually answered, or once it has simply stayed up: protocols 3.1, 3.2 and 3.3 have no session handshake, so an open TCP socket on its own proves nothing — a device that speaks a different version accepts the socket and then resets it. Once a version really works it is kept and logged, so you can put it in the device settings and skip the retry delay next time
- **Stale-connection watchdog** — a second watchdog beside the heartbeat, watching for something the heartbeat cannot see: firmware that keeps answering keep-alive pings while it has stopped answering everything else. That state used to look perfectly healthy — and on protocol 3.4/3.5, where a SET is fire-and-forget, commands into it reported success while the device did not move. A device that has sent no data for three polling cycles (at least 90 s) is now reconnected
- **Command pacing** — a configurable minimum gap between two commands to the same device (**Command Gap**, default 100 ms). Some firmware accepts the first command of a pair and silently drops the second when they arrive microseconds apart, which nothing on 3.4/3.5 reports as an error
- **Outbound heartbeat** — sends a keep-alive ping every 15 s; keeps connections alive on strict firmware that requires host-initiated keep-alives
- **Push-only device support** — devices that don't respond to GET requests (e.g. BCM700D-TY01 curtain motors) stay connected and accept SET commands without entering a reconnect loop; set Polling Interval to 0 for these devices
- **Cloud Lookup** — fetch Device ID and Local Key from the Tuya IoT Platform inside the app settings or directly during device pairing — no CLI tools needed. Device names show your custom name (as set in the Tuya app) as the primary label. Click a device name to see all DPs with types, current values, and allowed ranges. Access credentials are saved on Homey and auto-filled next time
- **Protocol auto-detect** — pairing and repair default to *Auto-detect*, which tries 3.3 → 3.4 → 3.1 → 3.5 → 3.2 in order and saves the working version automatically
- **Network scanner** — finds Tuya devices via UDP broadcast (ports 6666 / 6667) and a full TCP subnet scan (port 6668)
- **Auto DP detection** — on pairing, the app connects to the device, collects live data points and maps them to capabilities automatically
- **Cloud-assisted DP detection** — once Cloud Lookup credentials are saved, pairing additionally reads the device's Tuya specification and matches DPs by the manufacturer's own code names (`envhumid`, `windspeed`, `work_state`, `bright_value`, …) instead of guessing from value shape. It also picks up the *full* list of allowed values for mode and fan-speed pickers rather than only the value the device happens to report at that moment — which is what makes devices with plain numeric enums (`0` / `1`) work out of the box. Entirely optional
- **Energy dashboard integration** — drivers that measure power feed Homey's energy dashboard; the EV Charger additionally exposes `target_power` so Homey's energy management can steer the charge rate (e.g. solar-surplus charging)
- **Inline DP editor** — every DP number can be adjusted in the pairing screen before adding the device
- **Optional capabilities** — tiles are added or removed dynamically based on your DP settings; set a DP to `0` to hide the tile
- **Live credential updates** — change IP address, Local Key or Protocol Version directly in device settings at any time without re-pairing
- **Computed energy metering** — kWh accumulated from live power readings using trapezoidal integration; persisted across restarts
- **Push notifications** — Homey notifications for water tank events, fault alarms and other device alerts
- **Efficient polling** — alternates between full GET and lightweight dp_refresh to reduce traffic
- **Fix It tab** — five checks that compare your devices against what Tuya declares and offer to correct them: stale local keys, wrong protocol version, wrong measurement scaling, picker options that never got updated, and data points a device does not actually have. Every check previews exactly what it would change, per device, and saves nothing until you confirm
- **Connect-failure diagnosis** — when a device fails to connect during pairing, the app probes port 6668 and says which of the three it was: nothing at that address, the port closed, or the connection refused because something else already holds the device's single connection slot
- **Diagnostic tools** — in-app log buffer, live DP debug panel, and a Help tab covering every driver and the common faults
- **Bilingual** — full English and German UI

---

## Requirements

- Homey Pro with firmware **≥ 12.13.0** — required by the EV Charger driver's `target_power` capability
- Device reachable on your **local network**
- **Device ID**, **Local Key** and **IP address** — see [How to get Device ID and Local Key](#how-to-get-device-id-and-local-key)

---

## How to get Device ID and Local Key

### Method 1 — Cloud Lookup (recommended)

No CLI tools or terminal needed. Everything happens inside the Homey app. Credentials are saved on Homey and auto-filled next time.

**One-time setup:**

1. Create a free account at [iot.tuya.com](https://iot.tuya.com).
2. **Cloud** → **Project Management** → **Create Cloud Project** — industry: Smart Home, region: same as your mobile app.
3. Open your project → **Devices** → **Link Tuya App Account** → scan the QR code with Tuya Smart / Smart Life.
4. Open your project → **Overview** → copy **Access ID / Client ID** and **Access Secret / Client Secret**.

**Option A — During pairing (easiest):**

5. When adding a device, click **☁️ Fetch Device ID & Local Key from Cloud** in the credentials screen.
6. Paste your Access ID and Secret, select your data center, click **Fetch Devices**.
7. Click a device in the list — Device ID and Local Key are filled in automatically.
8. Check **Save credentials on Homey** so they're pre-filled next time.

**Option B — In app settings:**

5. In Homey: **More** → **Apps** → **Tuya Local** → **Settings** → **☁️ Cloud Lookup** tab.
6. Paste your Access ID and Secret, select your data center, click **Fetch Devices**.
7. Use the **Copy** button next to each device to copy all fields (custom name, name, Device ID, Local Key, product, category, UUID).

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
   - To fill in Device ID and Local Key automatically, click **☁️ Fetch Device ID & Local Key from Cloud** — enter your Tuya API credentials once (or re-use previously saved ones), pick your device from the list, and the fields are filled in automatically.
   - Check **Save credentials on Homey** to have them pre-filled next time.
3. Leave **Protocol Version** on **Auto-detect** (default) — the app tries 3.3 → 3.4 → 3.1 → 3.5 → 3.2 and saves the working version automatically. Select a specific version only if auto-detect fails.
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
| `dp_oscillate` | <img src="assets/capabilities/oscillate.svg" height="24"> | `oscillate` | boolean | 0 | ✓ `0` = disabled |
| `dp_self_clean` | <img src="assets/capabilities/self_clean.svg" height="24"> | `self_clean` | boolean | 0 | ✓ `0` = disabled |
| `dp_pump` | <img src="assets/capabilities/pump.svg" height="24"> | `pump` | boolean | 0 | ✓ `0` = disabled |

#### Timer Format

Two settings cover the common deviations from the standard timer format.

| Setting | Description | Default |
|---|---|---|
| `dp_countdown_timer_numeric` | Enable if the timer DP sends `0`…`24` instead of `cancel` / `1h` … `24h` | off |
| `dp_countdown_left_minutes` | Enable if the remaining-time DP counts minutes (0–1440) instead of hours | off |

#### Mode & Fan Speed Values

| Setting | Default (full superset) |
|---|---|
| `mode_values` | `manual,laundry,auto,continuous,smart,sleep,drying` |
| `fan_speed_values` | `low,medium,middle,high,auto,turbo` |

The exact strings vary by manufacturer. Check the **Raw Data** panel in app settings to find what your device sends. After saving, **restart the Tuya Local app** for the picker to reflect the updated options.

Some dehumidifiers report modes and fan speeds as plain numbers rather than names — set `mode_values = 0,1` and `fan_speed_values = 0,1` to match, otherwise the picker rejects the values and the tiles stay empty.

> **Water tank alarm:** on many models this DP is really a *fault bitmap* covering several error conditions, not a dedicated tank sensor. The driver treats any non-zero value as "tank full", so an unrelated fault can surface as a tank alarm. Watch the raw value in **DP Debug** while filling the tank to confirm what your device actually sends.

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
| `dp_relay_status` | <img src="assets/capabilities/relay_status.svg" height="24"> | `relay_status` | enum | 38 | ✓ `0` = disabled |
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
| `dp_light_onoff` |  | `onoff.light` | boolean | 0 | ✓ `0` = disabled |
| `dp_light_dim` |  | `dim.light` | number | 0 | ✓ `0` = disabled |
| `dp_light_color_temp` |  | `light_temperature` | number | 0 | ✓ `0` = disabled |

The speed slider (`dim`) maps the numeric DP range `speed_min … speed_max` to 0–100 %. Both a numeric speed DP and a string enum DP (`fan_speed`) can be active at the same time.

#### Ceiling Fans with a Light

Fill in the three light DPs and the fan gains separate light controls plus the flow cards **Set light**, **Set light brightness** and the condition **Light is on**. Leave them at `0` for fans without a light — nothing extra appears.

| Setting | Description | Default |
|---|---|---|
| `dp_light_dim_min` / `dp_light_dim_max` | Device brightness range, scaled to 0–100 % | 0 / 100 |
| `dp_light_color_temp_invert` | Enable if warm and cold are swapped | off |

Because the speed slider already occupies `dim`, the light's brightness uses its own `dim.light` sub-capability.

#### Speed, Mode & Direction Values

| Setting | Default |
|---|---|
| `fan_speed_values` | `low,medium,high,auto,turbo` |
| `fan_mode_values` | `normal,sleep,nature,breeze,smart` |

The `fan_direction` capability uses fixed values `forward` and `reverse` (Tuya standard). The DP is auto-detected at pairing time if the device reports either of those strings.

---

### Ceiling Fan Light

A ceiling fan with a light built into it — one Tuya device carrying two independent things.
Separate from the Fan driver because Homey has to be told which of the two the device *is*:
this one is a **Light**, so the main tile, the on/off button and Homey's light groups all act
on the light. The fan gets its own sub-capabilities and its own flow cards.

| What | Capability | Driven by |
|---|---|---|
| Light on/off *(main switch)* | `onoff` | `dp_light_onoff` |
| Light brightness | `dim` | `dp_light_dim` |
| Fan on/off | `onoff.fan` | `dp_onoff` |
| Fan speed (slider) | `dim.fan` | `dp_speed` |

> If the main switch operates the fan instead of the light, `dp_light_onoff` was not detected at
> pairing. Set it in device settings — the fan keeps its own `dp_onoff`.

#### Connection

Same settings as Dehumidifier, plus **Fire and Forget** (on by default — most of these fans are 3.4/3.5).

#### Data Points — fan

| Setting | Icon | Capability | Type | Default DP | Optional |
|---|:---:|---|---|---|---|
| `dp_onoff` |  | `onoff.fan` | boolean | 1 | — |
| `dp_speed` |  | `dim.fan` | number | 3 | ✓ `0` = disabled |
| `dp_fan_speed` | <img src="assets/capabilities/fan_speed.svg" height="24"> | `fan_speed` | enum | 0 | ✓ `0` = disabled |
| `dp_oscillate` | <img src="assets/capabilities/oscillate.svg" height="24"> | `oscillate` | boolean | 0 | ✓ `0` = disabled |
| `dp_direction` | <img src="assets/capabilities/fan_direction.svg" height="24"> | `fan_direction` | enum | 0 | ✓ `0` = disabled |
| `dp_mode` | <img src="assets/capabilities/fan_mode.svg" height="24"> | `fan_mode` | enum | 0 | ✓ `0` = disabled |
| `dp_child_lock` | <img src="assets/capabilities/child_lock.svg" height="24"> | `child_lock` | boolean | 0 | ✓ `0` = disabled |
| `dp_countdown_timer` | <img src="assets/capabilities/countdown_timer.svg" height="24"> | `countdown_timer` | enum | 0 | ✓ `0` = disabled |
| `dp_countdown_left` | <img src="assets/capabilities/countdown_left.svg" height="24"> | `countdown_left` | number | 0 | ✓ `0` = disabled |

`speed_min` / `speed_max` (default 1 … 100) map the device's raw speed range onto the 0–100 % slider.
A fan with six steps takes `speed_min = 1`, `speed_max = 6`.

#### Data Points — light

| Setting | Icon | Capability | Type | Default DP | Optional |
|---|:---:|---|---|---|---|
| `dp_light_onoff` |  | `onoff` | boolean | 0 | — |
| `dp_light_dim` |  | `dim` | number | 0 | ✓ `0` = disabled |
| `dp_light_color_temp` |  | `light_temperature` | number | 0 | ✓ `0` = disabled |
| `dp_light_colour` |  | `light_hue`, `light_saturation` | string | 0 | ✓ `0` = disabled |
| `dp_light_mode` |  | `light_mode` | enum | 0 | ✓ `0` = disabled |

`dp_light_dim_min` / `dp_light_dim_max` and `dp_light_color_temp_min` / `_max` map the device's raw
ranges onto Homey's 0–100 %. `dp_light_color_temp_invert` (on by default) flips the colour-temperature
direction for devices that count from warm to cold rather than the other way round.

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
| `dp_onoff` |  | `onoff` | boolean | 1 | — |
| `dp_target_temp` |  | `target_temperature` | number | 2 | — |
| `dp_current_temp` |  | `measure_temperature` | number | 3 | ✓ `0` = disabled |
| `dp_mode` | <img src="assets/capabilities/heat_pump_mode.svg" height="24"> | `heat_pump_mode` | enum | 0 | ✓ `0` = disabled |
| `dp_preset` | <img src="assets/capabilities/heat_pump_preset.svg" height="24"> | `heat_pump_preset` | enum or bool | 0 | ✓ `0` = disabled |
| `dp_fault` |  | `alarm_generic` | bitfield / bool | 0 | ✓ `0` = disabled |
| `dp_power_level` | <img src="assets/capabilities/power_level.svg" height="24"> | `power_level` | number | 0 | ✓ `0` = disabled |

#### Temperature Settings

| Setting | Description | Default |
|---|---|---|
| `temp_divisor` | Divide raw DP value to get °C for **both** target and measured temperature — use `10` if device sends e.g. `350` for 35 °C | 1 (auto-detected) |
| `current_temp_divisor` | Override divisor for the **measured temperature only** — use `10` if the current temp DP is ×10 but the target temp DP is raw °C (e.g. Weau). Set to `0` to fall back to `temp_divisor`. | 0 (uses `temp_divisor`) |
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

| Setting | Icon | Capability | Type | Default DP | Optional |
|---|:---:|---|---|---|---|
| `dp_control` |  | `windowcoverings_state` | enum `open`/`stop`/`close` | 1 | — |
| `dp_percent_control` |  | `windowcoverings_set` | integer 0–100 % | 2 | — |
| `dp_work_state` |  | `windowcoverings_state` | enum `opening`/`closing` (read-only) | 7 | ✓ `0` = disabled |
| `dp_fault` |  | `alarm_generic` | bitmap | 0 | ✓ `0` = disabled |

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

| Setting | Icon | Capability | Type | Default DP | Optional |
|---|:---:|---|---|---|---|
| `dp_onoff` |  | `onoff` | boolean | 1 | — |
| `dp_target_temp` |  | `target_temperature` | number | 2 | — |
| `dp_current_temp` |  | `measure_temperature` | number | 3 | — |
| `dp_mode` | <img src="assets/capabilities/thermostat_mode.svg" height="24"> | `thermostat_mode` | enum | 4 | ✓ `0` = disabled |
| `dp_child_lock` | <img src="assets/capabilities/child_lock.svg" height="24"> | `child_lock` | boolean | 0 | ✓ `0` = disabled |
| `dp_battery` |  | `measure_battery` | number | 0 | ✓ `0` = disabled (TRVs only) |
| `dp_fault` |  | `alarm_generic` | bitfield | 0 | ✓ `0` = disabled |
| `dp_hvac_action` |  | `alarm_heat` | enum / bool / int | 0 | ✓ `0` = disabled — shows heating indicator when boiler is actively firing |

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

| Setting | Icon | Capability | Type | Default DP | Optional |
|---|:---:|---|---|---|---|
| `dp_onoff` |  | `onoff` | boolean | 1 | — |
| `dp_current_temp` |  | `measure_temperature` | number | 2 | — |
| `dp_target_temp` |  | `target_temperature` | number | 4 | ✓ `0` = disabled |
| `dp_keep_warm` | <img src="assets/capabilities/kettle_keep_warm.svg" height="24"> | `kettle_keep_warm` | boolean | 13 | ✓ `0` = disabled |
| `dp_status` | <img src="assets/capabilities/kettle_status.svg" height="24"> | `kettle_status` | enum | 15 | ✓ `0` = disabled |
| `dp_mode` | <img src="assets/capabilities/kettle_mode.svg" height="24"> | `kettle_mode` | enum | 16 | ✓ `0` = disabled |
| `dp_fault` |  | `alarm_generic` | bitfield | 0 | ✓ `0` = disabled |

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

| Setting | Icon | Capability | Type | Default DP | Optional |
|---|:---:|---|---|---|---|
| `dp_switch_1` |  | `onoff` | boolean | 1 | — |
| `dp_switch_2` |  | `onoff.2` | boolean | 0 | ✓ `0` = disabled |
| `dp_switch_3` |  | `onoff.3` | boolean | 0 | ✓ `0` = disabled |
| `dp_switch_4` |  | `onoff.4` | boolean | 0 | ✓ `0` = disabled |
| `dp_countdown_1–4` |  | *(settings only)* | number | 0 | ✓ `0` = disabled |
| `dp_relay_status` |  | *(settings only)* | enum | 0 | ✓ `0` = disabled |

#### Switch Names

Each switch tile can be renamed in **Settings → Switch Names**. Leave empty for the default name ("Power" / "Switch 2/3/4"). The app needs to be restarted for name changes to take effect.

---

### Doorbell

Event-driven driver for Tuya video doorbells. The device pushes events over the LAN connection — no polling is used (default `polling_interval = 0`).

Compatible devices include: **Marmitek Buzz LO**, **Bcom Majic IPBox**, **Cleverio CD-200**, and any Tuya doorbell that sends DP 136 (ring) or DP 115 (motion).

#### Connection

| Setting | Description | Default |
|---|---|---|
| `ip` | Device IP address | — |
| `device_id` | Tuya Device ID | — |
| `local_key` | Tuya Local Key (16 or 32 chars) | — |
| `version` | Protocol version | Auto-detect |
| `polling_interval` | Seconds between GET polls (`0` = push-only, recommended) | 0 |
| `offline_grace_seconds` | Seconds without data before marking device offline | 60 |

#### Event Data Points

These DPs fire a trigger when the device pushes a new value.

| Setting | Trigger | Type | Default DP | Notes |
|---|---|---|---|---|
| `dp_doorbell` | Doorbell rang | boolean | 136 | `true` = ring event |
| `dp_motion_event` | Motion detected | boolean | 115 | `true` = motion event |
| `dp_alarm_message` | Ring or motion via alarm message | string (base64) | 0 | DP 185 on some devices; decodes `ipc_doorbell` / `ipc_motion` JSON |

> **Seed protection:** the ring and motion triggers are suppressed for the very first packet after each (re)connect to prevent false events. Subsequent packets fire normally.

#### Control Data Points

| Setting | Description | Type | Default DP | Optional |
|---|---|---|---|---|
| `dp_motion_switch` | Enable/disable motion detection | boolean | 134 | ✓ `0` = disabled |
| `dp_nightvision` | Night vision mode | number (`0`=auto, `1`=off, `2`=color) | 108 | ✓ `0` = disabled |
| `dp_chime_volume` | Chime volume (0–100) | number | 157 | ✓ `0` = disabled |
| `dp_device_volume` | Device speaker volume (0–100) | number | 160 | ✓ `0` = disabled |
| `dp_indicator` | Status LED on/off | boolean | 101 | ✓ `0` = disabled |
| `dp_recording` | Cloud/SD recording on/off | boolean | 150 | ✓ `0` = disabled |

#### Motion Settings

| Setting | Description | Default |
|---|---|---|
| `dp_motion_sensitivity` | DP for motion sensitivity (`0`=low, `1`=medium, `2`=high) | 106 |
| `motion_reset_seconds` | Seconds after which the motion alarm auto-clears | 30 |

---

### Presence Sensor

Driver for Tuya mmWave radar presence sensors. Push-driven — no polling is used (default `polling_interval = 0`).

The defaults match the **ZY-M100-WIFI** DP layout exactly. Sensors using a different layout are corrected automatically at pairing when Cloud Lookup credentials are saved.

#### Connection

| Setting | Description | Default |
|---|---|---|
| `ip` | Device IP address | — |
| `device_id` | Tuya Device ID | — |
| `local_key` | Tuya Local Key (16 or 32 chars) | — |
| `version` | Protocol version | Auto-detect |
| `polling_interval` | Seconds between GET polls (`0` = push-only, recommended) | 0 |
| `offline_grace_seconds` | Seconds without data before marking device offline | 60 |

#### Data Points

| Setting | Icon | Capability | Type | Default DP | Notes |
|---|:---:|---|---|---|---|
| `dp_presence` |  | `alarm_motion` | enum | 1 | `presence` / `none` |
| `dp_alarm` |  | `alarm_generic` | enum | 6 | `checking_result`; anything other than `check_success` / `checking` raises the alarm |
| `dp_distance` | <img src="assets/capabilities/measure_distance.svg" height="24"> | `measure_distance` | number | 9 | Distance to closest target, cm |
| `dp_luminance` |  | `measure_luminance` | number | 104 | Illuminance, lux |

#### Radar Settings

These are device settings rather than tiles — they configure the radar itself.

| Setting | Description | Default DP |
|---|---|---|
| `dp_sensitivity` | Radar sensitivity, 0–9 | 2 |
| `dp_near_detection` | Near detection limit, 0–1000 cm (step 10) | 3 |
| `dp_far_detection` | Far detection limit, 0–1000 cm (step 10) | 4 |
| `dp_detection_delay` | Seconds before presence is reported | 101 |
| `dp_fading_time` | Seconds before presence clears after the room empties | 102 |

---

### EV Charger

Driver for Tuya EV chargers (category `qccdz`). Single-phase and three-phase units are both supported, verified against every EV-charger configuration published in the [tuya-local](https://github.com/make-all/tuya-local) project.

Uses Homey's native EV charger capabilities, so the built-in **Start charging** / **Stop charging** actions, the **Is charging** condition and the charging-state trigger are all available without custom flow cards.

#### Connection

| Setting | Description | Default |
|---|---|---|
| `ip` | Device IP address | — |
| `device_id` | Tuya Device ID | — |
| `local_key` | Tuya Local Key (16 or 32 chars) | — |
| `version` | Protocol version | Auto-detect |
| `polling_interval` | Seconds between GET polls | 30 |
| `reconnect_interval` | Minutes between reconnect attempts while offline (`0` = disabled) | 0 |
| `offline_grace_seconds` | Seconds without data before marking device offline | 60 |

#### Data Points

| Setting | Icon | Capability | Type | Default DP | Notes |
|---|:---:|---|---|---|---|
| `dp_switch` |  | `evcharger_charging` | boolean | 18 | Homey's standard charge switch |
| `dp_work_state` |  | `evcharger_charging_state` | enum | 3 | Tuya's 8 states mapped onto Homey's 5 — see below |
| `dp_charge_current` |  | `target_power` | number | 4 | Charger speaks amps, Homey speaks watts |
| `dp_phase_a` |  | voltage / current / power | raw | 6 | Packed DP: 2 B voltage ×0.1 V, 3 B current ×0.001 A, then power in W. Both the 8-byte and 7-byte layouts are decoded automatically |
| `dp_phase_b` |  | `measure_*.b` (L2) | raw | 0 | Three-phase only, typically 7 |
| `dp_phase_c` |  | `measure_*.c` (L3) | raw | 0 | Three-phase only, typically 8 |
| `dp_power_total` |  | `measure_power` | number | 0 | Plain watts, typically 9 (or 5 on some single-phase units). Takes priority over the power decoded from Phase A |
| `dp_session_energy` | <img src="assets/capabilities/bolt.svg" height="24"> | `charge_session_energy` | number | 25 | Energy of current / last session |
| `dp_energy_total` |  | `meter_power.charged` | number | 0 | Charger's own lifetime counter, typically 1 — see below |
| `dp_fault` | <img src="assets/capabilities/alert.svg" height="24"> | `alarm_generic` + `fault_code` | bitmap | 10 | 16-bit bitmap; raw code also exposed as a sensor |
| `dp_connection_state` |  | connection state | enum | 13 | Control-pilot state (`controlpi_*`) · ✓ `0` = disabled |
| `dp_work_mode` |  | charging mode | enum | 0 | Typically 14 — see below · ✓ `0` = disabled |
| `dp_temperature` |  | `measure_temperature` | number | 0 | Typically 24 · ✓ `0` = disabled |
| `dp_timer_on` |  | delayed start (h) | number | 0 | Typically 28 · ✓ `0` = disabled |
| `dp_live_updates` |  | live measurements | enum | 0 | Typically 27 · ✓ `0` = disabled — see below |
| `dp_clear_energy` |  | reset device counter | boolean | 0 | Write-only pulse, typically 16 · ✓ `0` = disabled |

#### Power / Current Conversion

Homey controls the charge rate in watts (`target_power`), the charger accepts amps. The conversion is `W = A × voltage × phases`.

| Setting | Description | Default |
|---|---|---|
| `current_min` / `current_max` | Physical amp range of your charger (e.g. 6–16 for 3.7 kW, 6–32 for 7.4 kW). Tuya often reports a far wider range than the hardware allows | 6 / 16 |
| `phase_count` | 1 or 3 — detected at pairing from the number of phase DPs reported | 1 |
| `nominal_voltage` | Grid voltage used for the conversion | 230 |

A 16 A single-phase charger becomes a 0–3680 W slider in 230 W steps (1 A each). Anything below the charger's minimum current is treated as idle and stops the charge, rather than requesting an impossible current.

#### DP Scaling

Chargers are not consistent here, and a single pairing snapshot cannot tell the variants apart — so each scale has its own setting. Defaults match the large majority; change one only if a reading is off by a factor of ten or a hundred.

| Setting | Description | Default |
|---|---|---|
| `current_scale` | `1` = raw value is amps · `0.1` = raw value is amps × 10 | 1 |
| `session_energy_scale` | `0.01` = raw value is kWh × 100 · `1` = raw value is kWh | 0.01 |
| `total_energy_scale` | Same options, for the lifetime counter — some chargers scale it differently from the session counter | 0.01 |

#### Charging State Mapping

Tuya reports eight states, Homey has five:

| Tuya `work_state` | Homey `evcharger_charging_state` |
|---|---|
| `charger_free`, `charger_free_fault` | Not plugged in |
| `charger_insert`, `charger_wait`, `charger_end`, `charger_fault` | Plugged in |
| `charger_charging` | Charging |
| `charger_pause` | Paused |

The exact Tuya state stays available through the **Detailed charger state changed** trigger and its matching condition, which can tell *waiting* from *finished*.

#### Notes

> **Total energy:** many chargers expose a lifetime counter (DP 1) that reports a plausible value but never updates over the local connection. Because one reading cannot distinguish a working counter from a frozen one, `dp_energy_total` defaults to `0` and the total is accumulated from the session counter instead — which works on every model tested. Set it to `1` if your charger's own counter does update.

> **Live measurements:** some chargers only stream voltage / current / power while their `online_state` DP is set to `online`. Set `dp_live_updates = 27` and the app re-asserts it on every reconnect.

> **Charging modes:** chargers usually advertise five modes (immediate, to %, fixed kWh, scheduled, delayed) but implement far fewer — on many units only *Charge Now* does anything. DP 33 (`mode_set`) is a bitmask declaring what the hardware actually supports and is more trustworthy than the advertised enum. `dp_work_mode` is therefore disabled by default.

---

### Energy Meter

DIN-rail meters, clamp meters and metering circuit breakers — Tuya categories `zndb` and `dlq`.

Separate from the Smart Plug because here the measurement is the point and the switch is optional.
A clamp meter in a distribution board has no switch at all, and the plug driver — declared as a
socket with `onoff` in its manifest — gives one anyway: a dead toggle on a device that cannot switch
anything. `dp_switch` is therefore **0 by default**; set it only on a breaker that really switches
what it measures.

#### Connection

Same settings as Dehumidifier (IP, Device ID, Local Key, Protocol Version, Polling Interval,
Command Gap, Offline Grace Period).

#### Data Points

| Setting | Icon | Capability | Type | Default DP | Optional |
|---|:---:|---|---|---|---|
| `dp_power` |  | `measure_power` | number | 19 | — |
| `dp_voltage` |  | `measure_voltage` | number | 20 | — |
| `dp_current` |  | `measure_current` | number | 18 | — |
| `dp_energy` |  | `meter_power` | number | 17 | ✓ `0` = disabled |
| `dp_switch` |  | `onoff` | boolean | **0** | ✓ only for breakers |
| `dp_power_factor` | <img src="assets/capabilities/power_factor.svg" height="24"> | `power_factor` | number | 0 | ✓ `0` = disabled |
| `dp_fault` |  | `alarm_generic` | number | 26 | ✓ any value above zero raises the alarm |

Defaults are the classic Tuya metering block (17 / 18 / 19 / 20), which is what most single-phase
meters use. DPs 21–25 are the factory calibration coefficients — read-only, never useful, and
deliberately not logged as unmapped.

#### Scaling

| Setting | Default | Example |
|---|---|---|
| `power_scale` | `0.1` | raw 4538 → 453.8 W |
| `voltage_scale` | `0.1` | raw 2376 → 237.6 V |
| `current_scale` | `0.001` | raw 2491 → 2.491 A |
| `kwh_scale` | `0.01` | raw 364 → 3.64 kWh |

Values are rounded to the number of decimals the divisor can express, so a raw 2376 becomes 237.6 V
rather than 237.60000000000002 in Insights for ever. **Check measurement scaling** on the Fix It tab
reads the divisor Tuya declares and offers to correct these.

#### What the numbers alone cannot tell you

A meter reports numbers and almost nothing else, and one number looks much like another — a voltage
of 2376 and an energy total of 2376 are the same integer. Local detection therefore resolves the
conventional block and mains voltage, and leaves the rest to Cloud Lookup, which knows the
manufacturer's code names (`cur_power`, `add_ele`, `cur_voltage`, …). Across the 42 single-DP meter
definitions in the tuya-local catalogue the local heuristic identifies six; a wider number table
would reach twelve and get much of the rest wrong, because DP 103 is the power on seven models, the
voltage on three and the current on two. A confident wrong reading on a meter is worse than none.

If nothing could be identified, pairing says so rather than handing over a silent device.

> **Not supported:** meters that pack voltage, current and power for a phase into one binary value
> (28 of the 70 definitions, 27 of them on DP 6). The format is undocumented and no reading from a
> real device has been available to check an implementation against, so such a meter pairs and then
> shows nothing.

---

### Weather Station

WiFi weather stations with outdoor sensors — indoor and outdoor temperature and humidity, barometric
pressure, wind speed, gust and direction, and rainfall.

#### Connection

Same settings as Dehumidifier. **Polling Interval defaults to 300 s**: these stations report on their
own schedule and nothing is gained by asking more often.

#### Temperature and Humidity

| Setting | Icon | Capability | Default DP |
|---|:---:|---|---|
| `dp_temp_in` |  | `measure_temperature` (indoor) | 101 |
| `dp_hum_in` |  | `measure_humidity` (indoor) | 102 |
| `dp_temp_out` |  | `measure_temperature.outdoor` | 103 |
| `dp_hum_out` |  | `measure_humidity.outdoor` | 104 |
| `dp_temp_extra` |  | `measure_temperature.extra` | 0 |

`temp_divisor` and `humidity_divisor` default to `10` — these stations send tenths.

#### Pressure, Wind and Rain

| Setting | Icon | Capability | Default DP |
|---|:---:|---|---|
| `dp_pressure` |  | `measure_pressure` | 109 |
| `dp_wind` |  | `measure_wind_strength` | 110 |
| `dp_gust` |  | `measure_gust_strength` | 111 |
| `dp_wind_dir` | <img src="assets/capabilities/wind_direction.svg" height="24"> | `wind_direction` + `measure_wind_angle` | 112 |
| `dp_rain_1h` |  | `measure_rain_intensity` | 113 |
| `dp_rain_24h` |  | `measure_rain` | 114 |
| `dp_rain_total` |  | `measure_rain.total` | 134 |

`wind_divisor` defaults to **1**: these stations send whole units, and a divisor of 10 produced gust
readings with a decimal place the hardware does not have.

`wd_values` maps the raw direction index onto compass points, in order from north clockwise —
`N,NNE,NE,ENE,E,ESE,SE,SSE,S,SSW,SW,WSW,W,WNW,NW,NNW`. That one data point feeds two capabilities
on purpose: `wind_direction` carries the compass point that the tile shows, and Homey's own
`measure_wind_angle` keeps the degrees, so a flow can use whichever it needs.

#### Comfort

| Setting | Icon | Capability | Default DP |
|---|:---:|---|---|
| `dp_comfort` | <img src="assets/capabilities/comfort_level.svg" height="24"> | `comfort_level` | 126 |

`comfort_values` maps the raw strings the station sends onto that picker, default
`moist,dry,comfortable,na`.

---

### Ultrasonic Level Sensor

Tank and cistern level sensors: an ultrasonic head measures the distance down to the liquid and
reports both a depth and a percentage, plus configurable high and low alarm thresholds.

#### Connection

Same settings as Dehumidifier.

#### Data Points

| Setting | Icon | Capability | Type | Default DP |
|---|:---:|---|---|---|
| `dp_level_percent` | <img src="assets/capabilities/liquid_level.svg" height="24"> | `liquid_level` | number | 22 |
| `dp_depth` | <img src="assets/capabilities/measure_distance.svg" height="24"> | `measure_distance` | number | 2 |
| `dp_state` | <img src="assets/capabilities/liquid_state.svg" height="24"> | `liquid_state`, `alarm_tank_empty`, `alarm_tank_full` | enum | 1 |

`depth_divisor` defaults to `1000` — the depth arrives in millimetres.

`state_values` maps the raw strings, default `normal,lower_alarm,upper_alarm`. The state drives
three capabilities from the one data point: the `liquid_state` picker showing which of the three it
is, plus an empty and a full alarm that a flow can react to directly.

#### Thresholds and Installation

These are written by flow actions rather than read as capabilities, which is why they sit in their
own group. Their DP numbers only need changing if your sensor arranges them differently.

| Setting | Meaning | Default DP |
|---|---|---|
| `dp_max_set` | High threshold | 7 |
| `dp_mini_set` | Low threshold | 8 |
| `dp_upper_switch` | High alarm enabled | 14 |
| `dp_lower_switch` | Low alarm enabled | 15 |
| `dp_install_height` | Mounting height above the tank floor | 19 |
| `dp_depth_full` | Depth that counts as full | 21 |

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
| `dp_fault` |  | `alarm_generic` | bitfield | 14 | ✓ `0` = disabled |
| `dp_feed_report` | <img src="assets/capabilities/feed_report.svg" height="24"> | `feed_report` | number | 15 | ✓ `0` = disabled |
| `dp_surplus_grain` | <img src="assets/capabilities/surplus_grain.svg" height="24"> | `surplus_grain` | number | 16 | ✓ `0` = disabled |
| `dp_food_level` | <img src="assets/capabilities/food_status.svg" height="24"> | `food_status` | enum | 0 | ✓ `0` = disabled |
| `dp_child_lock` | <img src="assets/capabilities/child_lock.svg" height="24"> | `child_lock` | boolean | 0 | ✓ `0` = disabled |
| `dp_battery` |  | `measure_battery` | number | 0 | ✓ `0` = disabled |
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

| Setting | Icon | Capability | Default DP | Description |
|---|:---:|---|---|---|
| `dp_door_contact` |  | `garagedoor_closed` | 3 | Bool or string `"open"`/`"closed"` contact sensor. WOFEA DP 3, ZC34T DP 1, eWeLink DP 2. |
| `dp_door_action` |  | `garagedoor_closed` | 0 | String action state (`opened`/`closed`/`opening`/`closing`). AOSD DP 107, BoboYun DP 10. |
| `dp_door_control` |  | — | 6 | Combined open/close command DP. WOFEA DP 6 (enum), AOSD/ZC34T DP 101 (string). |
| `dp_door_open` |  | — | 0 | Separate bool open DP (BoboYun DP 106: send `true` → open). |
| `dp_door_close` |  | — | 0 | Separate bool close DP (BoboYun DP 107: send `true` → close). |
| `dp_switch` |  | — | 1 | Relay toggle DP (WOFEA DP 1 = relay pulse; BoboYun DP 103 = stop). Used by Toggle and Stop actions. |
| `dp_door_state` |  | `alarm_generic` | 12 | Alarm state. WOFEA: `none`/`unclosed_time`/`close_time_alarm`. BoboYun: `No`/event strings (set to 141). |
| `dp_light` |  | `onoff.light` | 0 | Integrated light switch. AOSD DP 105, BoboYun DP 102. `0` = disabled. |

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
| Dehumidifier child lock switched | `enabled` as a filter — pick *turned on* or *turned off* | — |
| Dehumidifier oscillation switched | `enabled` as a filter — pick *turned on* or *turned off* | — |

#### Conditions

| Condition |
|---|
| Humidity is / is not above [value] % |
| Humidity is / is not below [value] % |
| Water tank is / is not full |
| Device is / is not connected |
| Mode is / is not [mode] |
| Dehumidifier child lock is / is not on |
| Dehumidifier oscillation is / is not on |

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
| AC child lock switched | `enabled` as a filter — pick *turned on* or *turned off* |

#### Conditions

| Condition |
|---|
| AC is / is not connected |
| AC mode is / is not [mode] |
| AC fan speed is / is not [speed] |
| AC sleep mode is on / is off |
| AC fault alarm is / is not active |
| AC child lock is / is not on |

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
| Set AC timer | Countdown, `cancel` or 1–24 h — requires `dp_countdown_timer` > 0 |
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
| Fan child lock switched | `enabled` as a filter — pick *turned on* or *turned off* |
| Fan oscillation switched | `enabled` as a filter — pick *turned on* or *turned off* |

#### Conditions

| Condition |
|---|
| Fan is / is not connected |
| Fan mode is / is not [mode] |
| Fan direction is / is not [forward\|reverse] |
| Fan child lock is / is not on |
| Fan oscillation is / is not on |

#### Actions

| Action | Notes |
|---|---|
| Set fan mode | normal / sleep / nature / breeze / smart |
| Set fan speed | low / medium / high / auto / turbo |
| Set fan oscillation | on / off — requires `dp_oscillate` > 0 |
| Set fan direction | forward / reverse — requires `dp_direction` > 0 |
| Set fan child lock | on / off — requires `dp_child_lock` > 0 |
| Force fan reconnect | Drops and re-establishes the TCP connection |
| Refresh fan values | Triggers an immediate GET request |

---

### Ceiling Fan Light

Homey generates the light's own cards — **Turn on**, **Turn off**, **Dim**, **Is on** — automatically
from the `onoff` and `dim` capabilities, because the driver is a Light. It generates nothing for the
fan: sub-capabilities (`onoff.fan`, `dim.fan`) and app-defined capabilities (`fan_speed`, `oscillate`,
`child_lock`) get no cards of their own. Everything below is the driver making up that difference.

#### Triggers

| Trigger | Flow tokens |
|---|---|
| Fan connected | — |
| Fan disconnected | — |
| The fan was switched on or off | `on` (boolean) |
| Fan mode changed | `mode` (string), `prev_mode` (string) |
| Fan direction changed | `direction` (string), `prev_direction` (string) |
| Fan data point changed | `dp` (string), `value` (string) |
| Ceiling fan child lock switched | `enabled` as a filter — pick *turned on* or *turned off* |
| Ceiling fan oscillation switched | `enabled` as a filter — pick *turned on* or *turned off* |

#### Conditions

| Condition |
|---|
| Device is / is not connected |
| Fan is / is not running |
| Fan speed is / is not [speed] |
| Fan mode is / is not [mode] |
| Fan direction is / is not [forward\|reverse] |
| The fan is / is not oscillating |
| The child lock is / is not on |

#### Actions

| Action | Notes |
|---|---|
| Turn the fan on or off | The fan only — the light keeps Homey's own on/off card |
| Set fan speed | low / medium / high / auto / turbo — requires `dp_fan_speed` > 0 |
| Set fan speed by percentage | 0–100 %, mapped onto `speed_min` … `speed_max` — requires `dp_speed` > 0 |
| Set fan mode | normal / sleep / nature / breeze / smart — requires `dp_mode` > 0 |
| Set fan direction | forward / reverse — requires `dp_direction` > 0 |
| Set fan oscillation | on / off — requires `dp_oscillate` > 0 |
| Set the child lock | on / off — requires `dp_child_lock` > 0 |
| Set timer | Countdown — requires `dp_countdown_timer` > 0 |
| Set light mode (advanced) | white / colour / scene / music — requires `dp_light_mode` > 0 |
| Reconnect the device | Drops and re-establishes the TCP connection |
| Refresh device data | Triggers an immediate GET request |

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
| Humidifier child lock switched | `enabled` as a filter — pick *turned on* or *turned off* | — |

#### Conditions

| Condition |
|---|
| Humidifier is / is not connected |
| Humidity is / is not above [value] % |
| Humidity is / is not below [value] % |
| Water tank is / is not empty |
| Humidifier child lock is / is not on |

#### Actions

| Action | Notes |
|---|---|
| Set target humidity | 25–95 % |
| Set humidifier mode | auto / manual / normal / sleep / eco / boost |
| Set humidifier fan speed | low / medium / high / auto |
| Set humidifier ioniser | on / off — requires `dp_anion` > 0 |
| Set humidifier child lock | on / off — requires `dp_child_lock` > 0 |
| Set humidifier timer | Countdown, `cancel` or 1–24 h — requires `dp_countdown_timer` > 0 |
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
| Heater child lock switched | `enabled` as a filter — pick *turned on* or *turned off* |
| Heater oscillation switched | `enabled` as a filter — pick *turned on* or *turned off* |

#### Conditions

| Condition |
|---|
| Heater is / is not connected |
| Heater fault alarm is / is not active |
| Heater mode is / is not [mode] |
| Heater child lock is / is not on |
| Heater oscillation is / is not on |

#### Actions

| Action | Notes |
|---|---|
| Set heater mode | eco / comfort / boost / away / auto |
| Set heater target temperature | Configurable min/max/step |
| Set heater child lock | on / off — requires `dp_child_lock` > 0 |
| Set heater timer | Countdown, `cancel` or 1–24 h — requires `dp_countdown_timer` > 0 |
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
| Light colour mode is / is not [colour\|white] |

#### Actions

| Action | Notes |
|---|---|
| Set light colour mode | Colour / White — switches `work_mode` on the lamp; requires `dp_color_mode` > 0 |
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
| Feeder child lock switched | `enabled` as a filter — pick *turned on* or *turned off* |

> **Offline grace period:** The "disconnected" trigger is delayed by the **Offline Grace Period** setting (default 60 s). Tuya pet feeder firmware briefly drops the TCP connection at certain intervals — without the grace period this causes spurious nightly offline notifications.

#### Conditions

| Condition |
|---|
| Food level is / is not low |
| Pet feeder is / is not connected |
| Feeder child lock is / is not on |

#### Actions

| Action | Notes |
|---|---|
| Feed [[portions]] portion(s) now | Dispenses 1–50 portions immediately |
| Refresh pet feeder values | Triggers an immediate GET request |
| Set feeder child lock | on / off — requires `dp_child_lock` > 0 |
| Set feeder indicator light | on / off — requires `dp_indicator_light` > 0 |
| Set feeder voice playback | on / off — the announcement the feeder plays when it dispenses — requires `dp_voice_playback` > 0 |
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
| Thermostat child lock switched | `enabled` as a filter — pick *turned on* or *turned off* |

#### Conditions

| Condition |
|---|
| Thermostat mode is / is not [mode] |
| Thermostat is / is not connected |
| Thermostat child lock is / is not on |

#### Actions

| Action | Notes |
|---|---|
| Set thermostat mode | Uses values from `mode_values` setting |
| Set target temperature | Configurable min/max/step |
| Set thermostat child lock | on / off — requires `dp_child_lock` > 0 |
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

### Doorbell

#### Triggers

| Trigger | Flow tokens | Notes |
|---|---|---|
| Doorbell rang | — | Fires on every ring event (DP 136 or decoded `ipc_doorbell` in DP 185) |
| Motion detected | — | Fires when motion starts; auto-clears after `motion_reset_seconds` |
| Doorbell connected | — | Device established a LAN connection |
| Doorbell disconnected | — | Connection lost after offline grace period |
| Doorbell data point changed | `dp` (string), `value` (string) | Any raw DP change |

#### Conditions

| Condition |
|---|
| Motion is / is not active |
| Doorbell is / is not connected |

#### Actions

| Action | Notes |
|---|---|
| Enable motion detection | Sets `dp_motion_switch` DP to `true`; throws error if DP is set to 0 |
| Disable motion detection | Sets `dp_motion_switch` DP to `false`; throws error if DP is set to 0 |
| Set night vision | Select mode: Auto / Off / Color (always on); requires `dp_nightvision` ≠ 0 |
| Set chime volume | Enter volume 0–100 (step 10); requires `dp_chime_volume` ≠ 0 |
| Set motion sensitivity | Select Low / Medium / High; requires `dp_motion_sensitivity` ≠ 0 |
| Force doorbell reconnect | Drops and re-establishes the TCP connection |
| Refresh doorbell values | Triggers an immediate GET request |

---

### Presence Sensor

#### Triggers

| Trigger | Flow tokens | Notes |
|---|---|---|
| Presence detected | — | Radar reports `presence` |
| Presence cleared | — | Radar reports `none` (after `dp_fading_time`) |
| Presence sensor connected | — | Device established a LAN connection |
| Presence sensor disconnected | — | Connection lost after offline grace period |
| Presence sensor data point changed | `dp` (string), `value` (string) | Any raw DP change |

#### Conditions

| Condition |
|---|
| Presence is / is not active |
| Presence sensor is / is not connected |

#### Actions

| Action | Notes |
|---|---|
| Force presence sensor reconnect | Drops and re-establishes the TCP connection |
| Refresh presence sensor values | Triggers an immediate GET request |

---

### EV Charger

Homey generates **Start charging**, **Stop charging**, **Is charging** and a charging-state trigger automatically from the native EV charger capabilities, plus **Set target power** from `target_power`. The cards below are the driver's own additions.

#### Triggers

| Trigger | Flow tokens | Notes |
|---|---|---|
| Charging session finished | `energy` (number) | Fires when the charger leaves the charging state, with the kWh delivered in that session |
| Detailed charger state changed | `state`, `prev_state` (string) | Raw Tuya state — distinguishes *waiting* / *finished* / *plugged in*, which Homey's standard state groups together |
| Charger fault occurred | `fault_code` (number) | Raw 16-bit fault bitmap value, debounced against reconnect artifacts |
| Charger connected | — | Device established a LAN connection |
| Charger disconnected | — | Connection lost after offline grace period |
| Charger data point changed | `dp` (string), `value` (string) | Any raw DP change |

#### Conditions

| Condition | Notes |
|---|---|
| Detailed charger state is / is not | Compares the raw Tuya `work_state` — finer-grained than Homey's standard state |
| Charger is / is not connected | — |

#### Actions

| Action | Notes |
|---|---|
| Set charge current | Enter amps; clamped to `current_min` … `current_max` and converted to watts internally. Homey's built-in *Set target power* covers the same DP in watts |
| Reset energy meter | Clears the accumulated total; also sends the device's own clear-energy command when `dp_clear_energy` is set |
| Force charger reconnect | Drops and re-establishes the TCP connection |
| Refresh charger values | Triggers an immediate GET request |

---

### Energy Meter

#### Triggers

| Trigger | Flow tokens |
|---|---|
| Device connected | — |
| Device disconnected | — |
| A data point changed | `dp` (string), `value` (string) |

#### Conditions

| Condition | Notes |
|---|---|
| Device is / is not connected | |
| Power is / is not above [watts] | |
| Current is / is not above [amps] | Useful as an overload warning on a circuit whose breaker rating you know |
| Fault is / is not active | `dp_fault` above zero |

#### Actions

| Action | Notes |
|---|---|
| Force reconnect | Drops and re-establishes the TCP connection |
| Refresh device values | Triggers an immediate GET request |

---

### Weather Station

Homey generates cards for the measurement capabilities itself. The cards below are the driver's own
additions.

#### Triggers

| Trigger | Flow tokens |
|---|---|
| Weather station connected | — |
| Weather station disconnected | — |
| Comfort level changed | `comfort` (string), `prev_comfort` (string) |
| Weather station data point changed | `dp` (string), `value` (string) |

#### Conditions

| Condition | Notes |
|---|---|
| Weather station is / is not connected | |
| Comfort level is / is not [level] | moist / dry / comfortable / na |
| Wind speed is / is not above [value] | |
| Wind is / is not from [direction] | Compass point, taken from `wd_values` |

#### Actions

| Action | Notes |
|---|---|
| Force weather station reconnect | Drops and re-establishes the TCP connection |
| Refresh weather station values | Triggers an immediate GET request |

---

### Ultrasonic Level Sensor

#### Triggers

| Trigger | Flow tokens |
|---|---|
| Level sensor connected | — |
| Level sensor disconnected | — |
| Level state changed | `state` (string), `prev_state` (string) |
| Level sensor data point changed | `dp` (string), `value` (string) |

#### Conditions

| Condition | Notes |
|---|---|
| Level sensor is / is not connected | |
| Level state is / is not [state] | normal / lower_alarm / upper_alarm |
| Liquid level is / is not above [percent] | |

#### Actions

| Action | Notes |
|---|---|
| Set high threshold | Writes `dp_max_set` on the device |
| Set low threshold | Writes `dp_mini_set` on the device |
| Enable or disable a level alarm | Writes `dp_upper_switch` / `dp_lower_switch` |
| Force level sensor reconnect | Drops and re-establishes the TCP connection |
| Refresh level sensor values | Triggers an immediate GET request |

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
| Fault detected | EV Charger | Fault bitmap becomes non-zero (debounced against reconnect artifacts) |

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

Every data point the app has received from a device, which is how you find out which DP carries
what: operate the device with its own buttons while watching the table, and the DP that moves is
the one the setting needs to point at.

- Select a device from the dropdown
- Shows DP number, current value, and type
- Colour-coded: green = `true`, red = `false`, purple = number, orange = string
- **Auto-refresh** re-reads every 5 seconds — switch it on *before* operating the device, otherwise
  a DP can change and change back between two looks
- **Copy Local DP Table**, **Report on GitHub** and **Copy for forum** package the table for a bug report

What this panel cannot show is what the numbers *mean*: the local protocol never transmits a name,
a type or an allowed range. Cloud Lookup does, which is why the two are used together.

### Fix It

Five checks that compare your devices against what Tuya declares for them. Each one previews exactly
what it would change, device by device, says why a device was left alone, and saves nothing until you
confirm. All except **protocol versions** need Cloud Lookup credentials.

| Check | What it finds |
|---|---|
| **Check local keys** | A local key changes every time the device is reset or re-paired in the Tuya app, and the symptom is a device that never connects again. Compares the stored key against your account. Keys are shown shortened, never in full |
| **Check protocol versions** | The device is connected and answering on a different version than the settings say. Waits for the device to answer first, so it cannot save a version a device was merely stuck on |
| **Check measurement scaling** | Readings that are 10× or 100× off, using the divisor Tuya declares rather than leaving you to work it out from the number |
| **Update pickers on existing devices** | Mode and fan-speed lists that were seeded from whatever the device happened to report at pairing time. Never touches DP numbers |
| **Find data points your device does not have** | Driver defaults written for one device family pointing at nothing on another. A DP is only reported when the specification does not list it **and** your device has never once reported it |

### Help

A per-driver reference inside the app: what each driver covers, what its data points mean, and the
faults that come up most often. Linked from the other tabs where a topic needs more room than a
tooltip.

### Cloud Lookup

Fetch device credentials and DP specifications from the Tuya IoT Platform (available in app settings and during pairing):
- Enter your **Access ID** and **Access Secret** from iot.tuya.com → Cloud → Project Management → your project → Overview
- Select your **Data Center** and click **Fetch Devices**
- Device list shows the **custom name** (as set in the Tuya app) as the primary name, with the product model name as a subtitle
- **Click a device name** to see the full DP specification: DP numbers, code names, types, current values, allowed ranges, and read/write status
- **Copy** button per device copies all available fields: custom name, name, Device ID, Local Key, product, category, UUID
- Check **Save credentials on Homey** to persist your Access ID, Secret, and region — they are auto-filled next time you open Cloud Lookup in settings or pairing
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
| Heat pump target temp correct but measured temp is 10× too high | Asymmetric DP scaling (e.g. Weau): target DP is raw °C but measured DP is ×10 | Set **Measured Temperature Divisor (override)** (`current_temp_divisor`) to `10`, leave the main `temp_divisor` at `1` |
| Mode / fan picker shows wrong options | `mode_values` / `fan_speed_values` mismatch | Update values in device settings, then restart the Tuya Local app |
| Picker still shows old options after saving | Homey caches capability options | Restart the Tuya Local app |
| Light color mode not working | Wrong `color_mode_white_val` / `color_mode_color_val` | Check the DP Debug tab for the actual strings sent by the device (e.g. `white`, `colour`, `color`) |
| Humidifier water alarm fires on connect | Device sends transient alarm on reconnect | Built-in debounce suppresses these; if they persist increase the alarm guard window |
| Spurious fault alarm after reconnect | Reconnect artifact | Built-in 30 s grace period on reconnect suppresses these (AC, Heater, Heat Pump) |
| Heat pump mode/preset picker does nothing | DP was enabled after initial pairing — listener not registered | Restart the Tuya Local app; the listener is re-registered on next `onInit` |
| Pet feeder sends 3–4 "disconnected" notifications per night | Tuya firmware briefly drops TCP connection at timed intervals | Increase **Offline Grace Period** in device settings (default 60 s already handles most cases; try 120 s if it still fires) |
| Generic device shows raw key as label | Missing locale key | Set labels via the `label` field in the dp_config mapping |
| Curtain position slider is inverted | Device uses 0 = open, 100 = closed | Enable `invert_position` in device settings |
| Curtain tile shows "moving" but motor has stopped | `work_state` DP not resetting on this device | Set `dp_work_state = 0` to disable it |
| Curtain motor limit positions are wrong | Motor limits not calibrated | Run limit calibration from the Tuya / Smart Life app (DP 16 `border`) before using Homey |
| Thermostat temperature is 10× too high | Device sends ×10 values (e.g. BHT-002, Moes) | Set `temp_divisor = 10` in device settings |
| Thermostat mode picker shows wrong options | `mode_values` mismatch | Check the DP Debug tab for the actual strings, update `mode_values` in settings |
| Thermostat heating indicator (`alarm_heat`) never activates | `dp_hvac_action` not set | Set **DP HVAC Action** in device settings to the DP that reports `heating`/`1`/`true` when the boiler fires |
| Wall switch trigger doesn't fire for switch 2+ | Using Homey's built-in "Turned on/off" trigger | Use the Wall Switch-specific **"A switch gang changed"** trigger card instead |
| Wall switch tile names don't update | Homey caches capability titles | Restart the Tuya Local app after changing switch names |
| Kettle mode picker empty | `mode_values` doesn't match device strings | Check DP Debug for the exact mode strings (some use `mzj_black`, `boiling_quick`, etc.) |
| Device missing DPs or SET commands rejected | Standard Instruction Set hides some DPs | Switch to **DP Instruction Set** on iot.tuya.com → Devices → your device → Instruction Mode |
| Cloud Lookup shows fewer DPs than expected | Same cause — Standard mode limits visible DPs | Switch to DP Instruction mode, then re-fetch in Cloud Lookup |
| SET command causes disconnect | Device rejects encrypted command | 1) Refresh Local Key via Cloud Lookup. 2) Enable **Fire and Forget** in device settings. 3) Switch instruction mode to DP on iot.tuya.com |
| Device unavailable immediately — log shows `Invalid local key length` | Local Key is not exactly 16 characters — likely a copy/paste truncation | Open device **Settings** → re-enter the Local Key (must be exactly 16 characters) |
| Curtain motor / push-only device enters connect → timeout → disconnect loop | Firmware does not respond to GET requests (e.g. BCM700D-TY01) | Set **Polling Interval** to `0` in device settings — the device will stay connected and push DPs and accept commands normally |
| Protocol version mismatch after firmware OTA update | OTA changed the required protocol; configured version no longer works | The app auto-rotates through 3.3 / 3.4 / 3.1 / 3.5 / 3.2 after 5 failed reconnects and logs which version connected — update **Protocol Version** in device settings to that version to skip the retry delay |
| Device goes offline after a while and never recovers | **Auto-Reconnect Interval** set very low, tearing down healthy connections | Fixed in 1.0.128 — auto-reconnect now only fires while the device is genuinely offline. Set the interval back to `0` or a few minutes |
| Mode or fan-speed tile stays empty | Device reports values that are not in the picker's list (often plain numbers) | Check the raw value in **DP Debug**, then set `mode_values` / `fan_speed_values` to match exactly (e.g. `0,1`) and restart the app |
| Newly enabled tile does not respond to taps | Capability listener registered only at startup | Fixed in 1.0.129 for Fan and Dehumidifier. On other drivers, restart the Tuya Local app once |
| Generic picker shows raw numbers instead of labels | `readMap` was previously ignored on numeric DPs | Fixed in 1.0.140. Add a `readMap` with the raw values as **text** keys: `{"0":"Auto","1":"Continuous"}` |
| EV charger total energy never increases | Charger's lifetime counter (DP 1) does not update over LAN | Leave `dp_energy_total` at `0` — the total is then accumulated from the session counter |
| EV charger session energy is 100× too low / current 10× too high | Charger uses a different DP scale than the majority | Adjust `session_energy_scale`, `total_energy_scale` or `current_scale` in device settings |
| EV charger power slider range looks wrong | `current_min` / `current_max` / `phase_count` don't match the hardware | Set them to your charger's real amp range and phase count — the watt range is derived (`W = A × V × phases`) |
| EV charger shows no voltage / current / power | Charger only streams live values while `online_state` is `online` | Set `dp_live_updates = 27` — the app re-asserts it on every reconnect |
| EV charging mode picker has no effect | Charger advertises modes it does not implement | Set `dp_work_mode = 0` to hide the picker; DP 33 (`mode_set`) declares what the hardware really supports |
| Endless connect → ECONNRESET loop, log always says `attempt 1` | Protocol 3.1/3.2/3.3 has no session handshake, so the open TCP socket was read as success and cleared the failure counter — the version rotation never reached its five failures | Fixed in 1.0.208. A connection now only counts once the device answers. Afterwards, set **Protocol Version** to the version the log says actually worked |
| Device shows as connected but commands do nothing | Firmware still answers keep-alive pings while it has stopped answering everything else; on 3.4/3.5 a SET is fire-and-forget, so the app sees no error | Fixed in 1.0.190 — a device silent for three polling cycles is reconnected. If it recurs, reduce **Polling Interval** so the watchdog window closes sooner |
| Two commands in one flow, only the first arrives | Firmware cannot keep up with commands sent microseconds apart, and nothing on 3.4/3.5 reports a dropped SET | Raise **Command Gap** in device settings (default 100 ms; a reported heater needed 2000 ms) |
| Energy meter shows no readings at all | The DP numbers alone cannot say which number is the power and which the voltage — on this device family the same number means different things on different models | Set up **Cloud Lookup** and pair again: it matches by the manufacturer's own code names. Or read the numbers off **DP Debug** and enter them by hand |
| Ceiling fan light: the main on/off switches the fan, not the light | `dp_light_onoff` not detected at pairing | Set **DP Light On/Off** in device settings — that DP drives the main `onoff`; the fan sits on its own `dp_onoff` |

---

## Tech Stack

- [tuyapi](https://github.com/codetheweb/tuyapi) ^7.5.2 — Tuya LAN protocol implementation
- `lib/SafeTuyAPI.js` — a thin subclass around it. The library parses incoming packets on the socket's own event, outside any promise, so a malformed frame threw where nothing could catch it and took the whole app down with it. The subclass guards the packet handler and routes the failure back into the connection that caused it
- `lib/TuyaConnection.js` — connection lifecycle: reconnect back-off, protocol rotation, the heartbeat and stale-data watchdogs, command queueing and pacing
- Node.js built-ins: `dgram`, `net`, `os`, `dns`
- Homey App SDK v3

---

## Contributing

Bug reports and feature requests → [GitHub Issues](https://github.com/andiwirz/com.tuyalocal/issues)

Donations → [PayPal](https://paypal.me/AndiWirz)

---

## License

MIT
