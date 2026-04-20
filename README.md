# Tuya Local — Homey App

Direct, **local control** of Tuya-based smart devices — no cloud, no internet dependency. All communication happens over your local network using the Tuya LAN protocol.

---

## Features

- **Cloud-free** — device control and state updates never leave your home network
- **Real-time push** — devices report state changes instantly; no polling required (polling is optional)
- **Automatic reconnect** — exponential backoff with jitter; watchdog detects stale connections
- **Network scanner** — finds Tuya devices via UDP broadcast (ports 6666/6667) and TCP subnet scan (port 6668)
- **Auto DP detection** — on/off, humidity, fan speed, mode, timers and child lock are detected automatically during pairing
- **Optional temperature** — `measure_temperature` capability is added only when a temperature DP is detected (raw value ÷ 10)
- **Repair flow** — update IP / Local Key without removing and re-adding the device
- **Diagnostic logs** — in-app log buffer with severity levels (info / warn / error)
- **DP debug panel** — live view of all received data points per device (App Settings → DP Debug)
- **Bilingual** — English and German UI

### Supported Devices

| Device | Capabilities |
|---|---|
| Dehumidifier | on/off · current humidity · target humidity · fan speed · mode · countdown timer · child lock · water tank alarm · temperature *(optional)* |

---

## Requirements

- Homey Pro running firmware **≥ 12.0.0**
- Tuya device reachable on your **local network**
- Device **ID**, **Local Key**, and **IP address** (see below)

---

## How to get Device ID and Local Key

The Local Key is a 16- or 32-character encryption key assigned by Tuya when the device was activated. There are two reliable methods to obtain it.

### Method 1 — tuya-cli wizard (recommended)

The `@tuyapi/cli` tool automates the entire extraction process.

**Prerequisites:** Node.js ≥ 16 installed on your computer.

```bash
npx @tuyapi/cli wizard
```

The wizard will ask you to:
1. Log in with your **Tuya IoT Platform** account (or create one at [iot.tuya.com](https://iot.tuya.com))
2. Select the region your account is registered in
3. Link your **Smart Life** or **Tuya** mobile app to your IoT project (one-time step)

It then lists all devices from your linked mobile app with their **Device ID** and **Local Key**. Copy the values for your device.

> **Note:** If you recently reset or re-paired a device, the Local Key may have changed. Re-run the wizard to get the updated key.

---

### Method 2 — Tuya IoT Platform (manual)

1. **Create an account** at [iot.tuya.com](https://iot.tuya.com) (free tier is sufficient).

2. **Create a Cloud Project**
   - Go to **Cloud → Development → Create Cloud Project**
   - Choose any name, select **Smart Home** as the industry, and pick your data center region (must match your mobile app region — e.g. Central Europe)
   - Under **Subscribed APIs**, enable at least: *IoT Core* and *Authorization*

3. **Link your mobile app**
   - Open your project → **Devices** tab → **Link Tuya App Account**
   - Scan the QR code with your **Smart Life** or **Tuya** app
   - Your devices appear in the **All Devices** list

4. **Find Device ID and Local Key**
   - In the **All Devices** list, click the **Edit** (pencil) icon next to your device
   - Note the **Device ID** (`devId`) and **Device Secret** (`localKey` / `Local Key`)

> **Tip:** The Local Key shown in the platform is the same key the device uses for LAN encryption. It only changes if you reset the device and re-pair it in the mobile app.

---

### Finding the IP address

- Check your **router's DHCP client list** and look for the device by its MAC address or hostname.
- Or use the built-in **Scan Network** button in the pairing wizard — the app listens for Tuya UDP broadcasts and scans your subnet automatically.
- Assign a **static/reserved IP** in your router (DHCP reservation) so the address never changes.

---

## Installation

```bash
git clone https://github.com/andiwirz/com.tuyalocal
cd com.tuyalocal
npm install
```

**Deploy to Homey:**
```bash
homey app build    # build the app
homey app install  # install on Homey Pro
```

---

## Pairing a Device

1. Open the Homey app → **Add device** → **Tuya Local** → **Dehumidifier**.
2. Click **Scan Network** — waits for UDP broadcasts and scans the local subnet (~10 s).  
   Or enter credentials manually: IP, Device ID, Local Key, Protocol Version.
3. The app connects to the device, collects live data points, and maps them automatically.
4. A preview table shows each detected DP with its current value and mapped function.
5. Optionally rename the device, then click **Add Device**.

---

## Device Settings

### Connection

| Setting | Description | Default |
|---|---|---|
| IP Address | Local IP of the device | — |
| Device ID | Tuya device identifier | — |
| Local Key | LAN encryption key (16 or 32 chars) | — |
| Protocol Version | 3.1 / 3.3 / 3.4 / 3.5 | 3.3 |
| Polling Interval | Active state poll in seconds (0 = disabled) | 30 |

### Data Points (auto-detected, manually adjustable)

| Setting | Function | Default |
|---|---|---|
| `dp_onoff` | Power on/off | 1 |
| `dp_current_humidity` | Current humidity (%) | 16 |
| `dp_target_humidity` | Target humidity setpoint (%) | 2 |
| `dp_mode` | Operating mode | 4 |
| `dp_fan_speed` | Fan speed | 5 |
| `dp_countdown_timer` | Timer duration | 17 |
| `dp_countdown_left` | Timer remaining (read-only) | 18 |
| `dp_child_lock` | Child lock | 14 |
| `dp_water_full` | Water tank full alarm (0 = disabled) | 19 |
| `dp_temperature` | Temperature sensor — raw ÷ 10 = °C (0 = disabled) | 0 |

> Setting `dp_temperature` to a non-zero value dynamically adds the `measure_temperature` capability. Setting it back to 0 removes it.

### Status (read-only)

| Setting | Description |
|---|---|
| Connection | Current connection state |
| Last data received | Timestamp of the most recent data push |

### Repair

Use **Repair** (long-press the device in Homey) to update the IP address or Local Key without removing and re-adding the device. The app tests the new credentials before saving.

---

## Homey Flows

### Triggers

| Trigger | Tokens |
|---|---|
| Humidity went above threshold | `humidity`, `prevHumidity`, `trend` |
| Humidity dropped below threshold | `humidity`, `prevHumidity`, `trend` |
| Water tank became full | — |
| Water tank was emptied | — |
| Device connected | — |
| Device disconnected | — |
| A data point changed | `dp` (string), `value` (string) |

### Conditions

| Condition |
|---|
| Humidity is / is not above value |
| Humidity is / is not below value |
| Water tank is / is not full |
| Device is / is not connected |
| Mode is / is not (manual / laundry) |

### Actions

| Action |
|---|
| Set target humidity (25–80 %) |
| Set operating mode |
| Set fan speed |
| Set countdown timer |
| Enable / disable child lock |
| Refresh device state |
| Force reconnect |

---

## Diagnostics

Open **Homey app → More → Apps → Tuya Local → Settings** to access:

### Diagnostic Logs
Timestamped log buffer (max 500 entries, cleared on app restart) with severity levels:
- `[INF]` — normal events (connect, disconnect, DP changes)
- `[WRN]` — warnings (reconnect attempts, stale connection)
- `[ERR]` — errors

### DP Debug Panel
Live view of all data points received from each device:
- Select a device from the dropdown
- Shows **DP number**, **raw value**, and **type** (boolean / number / string)
- Values are colour-coded: green = `true`, red = `false`, purple = number, orange = string
- **Auto-refresh** mode updates the table every 5 seconds
- Useful for identifying unknown DPs on new devices and verifying DP mappings

---

## Tech Stack

- [tuyapi](https://github.com/codetheweb/tuyapi) ^7.5.2 — Tuya LAN protocol
- Node.js built-ins: `dgram`, `net`, `os`, `dns`
- Homey App SDK v3

---

## Contributing

Bug reports and feature requests → [GitHub Issues](https://github.com/andiwirz/com.tuyalocal/issues)

Donations → [PayPal](https://paypal.me/AndiWirz)

## License

MIT
