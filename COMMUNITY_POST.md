# Tuya Local — control Tuya WiFi devices without the cloud

Hi everyone

**Tuya Local** connects Homey directly to Tuya WiFi devices over your own network, using their local LAN protocol instead of the Tuya cloud. No bridge, no external server, no account dependency at runtime — once a device is paired, everything happens between Homey and the device.

📲 **[Install from the Homey App Store](https://homey.app/en-ch/app/com.tuyalocal/Tuya-Local/)**

---

## Requirements

- **Homey Pro** with firmware **12.13.0 or newer**
- Device reachable on your local network (a static IP or DHCP reservation is strongly recommended)
- **Device ID**, **Local Key** and **IP address** for each device — the app can fetch the first two for you, see *Getting started* below

> ⚠️ This app is for **WiFi** Tuya devices that speak the local LAN protocol. **Bluetooth/BLE** Tuya devices are cloud-only by design and cannot be controlled locally — no app can change that.

---

## Supported devices

There are **17 dedicated drivers** plus a fully generic one. Dedicated drivers detect their data points automatically at pairing and come with proper Homey capabilities, tiles and flow cards — no manual mapping needed.

| Driver | Typical devices |
|---|---|
| **Smart Plug** | Plugs and sockets with energy monitoring |
| **Wall Switch** | 1/2/3/4-gang WiFi wall switches |
| **Light** | Bulbs, LED strips, ceiling lights (white, tunable, RGB) |
| **Air Conditioner** | Split units, portable ACs |
| **Heater** | Panel heaters, convectors, oil radiators |
| **Heat Pump** | Pool and air-water heat pumps (Phalén, Fairland, Brustec, BWT, Waterco …) |
| **Thermostat** | Floor heating, room thermostats, TRVs, zone valves |
| **Dehumidifier** | Dehumidifiers and air dryers |
| **Humidifier** | Humidifiers, aroma diffusers |
| **Fan** | Table, tower and ceiling fans — including ceiling fans with an integrated light |
| **Curtain Motor** | Curtain, blind and roller motors (Zemismart v1 & v2 and compatible) |
| **Garage Door** | Openers (WOFEA, AOSD, ZC34T, BoboYun gatePro) |
| **Doorbell** | Video doorbells (Marmitek Buzz LO, Bcom Majic IPBox, Cleverio CD-200 …) |
| **Presence Sensor** | mmWave radar presence sensors (ZY-M100-WIFI and compatible) |
| **EV Charger** | Tuya EV chargers — Vevor, Nine, Tera, Emini, Aimiler, Ecopoint, Dowell, Feyree, AfyeEV, Junsun, Zencar, iPengen, Suntree, Immax, Voldt, Wadapower and other rebrands of the same hardware |
| **Pet Feeder** | Automatic feeders (WOFEA, Mypin, PETKIT …) |
| **Smart Kettle** | Kettles with temperature control |
| **Generic** | Anything else — map any DP to any Homey capability yourself |

Altogether the app ships **242 flow cards**, so most devices can be automated in detail rather than just switched on and off.

---

## Getting started

**1. Get your credentials.** Open the app settings in Homey → **☁️ Cloud Lookup** tab, enter your Tuya IoT Platform Access ID and Secret, and the app fetches Device IDs and Local Keys for all your devices. Credentials are stored on Homey and pre-filled next time. The same lookup is available directly inside the pairing wizard.

**2. Find the IP.** Use **Scan Network** in the pairing wizard (UDP broadcast plus a TCP subnet scan), or read it from your router.

**3. Pair.** Pick the driver matching your device, enter IP / Device ID / Local Key, and leave the protocol version on **Auto-detect**. The app connects, reads the live data points and fills in the DP mapping for you. Every DP number is shown in the pairing screen and can be corrected before you add the device.

That's it — no manual DP mapping for the dedicated drivers.

> 💡 **Worth doing once:** saving your Cloud Lookup credentials also improves pairing itself. The app then reads the device's Tuya specification and matches data points by the manufacturer's own names (`work_state`, `envhumid`, `bright_value` …) instead of guessing from value patterns. It also picks up the *complete* list of valid options for mode and fan-speed pickers rather than just the one value the device happens to report at that moment. This is what makes devices with plain numeric modes (`0` / `1` instead of `auto` / `low`) work correctly out of the box.

---

## What the app handles for you

**Connection robustness** — this is where most of the work went:

- **Protocol auto-detect** covering 3.1 / 3.2 / 3.3 / 3.4 / 3.5 / 3.22
- **Auto-rotation after a firmware update:** if a device stops connecting, the app cycles through fallback protocol versions, keeps whichever works, and logs it so you can update the setting
- **Push-only devices** that never answer GET requests (some curtain motors) stay connected and accept commands instead of looping — set Polling Interval to 0
- **Outbound heartbeat** keeps connections alive on firmware that expects host-initiated keep-alives
- **Watchdog and exponential back-off** with jitter for reconnects
- **Live credential updates** — change IP, Local Key or protocol version in device settings at any time, no re-pairing

**Device handling:**

- **Optional tiles** — set any DP to `0` and the tile disappears; set a number and it appears
- **Computed energy metering** — kWh accumulated from live power readings, persisted across restarts, for devices whose own counter is unreliable
- **Energy dashboard integration**, including `target_power` on the EV Charger so Homey's energy management can steer the charge rate (solar-surplus charging)
- **Push notifications** for water tank events, faults and other alerts, debounced so reconnects don't produce false alarms

**Diagnostics** (all in app settings):

- **Logs** tab with a live log buffer
- **DP Debug** showing every data point of every device with current values
- **Raw Data** viewer for the unprocessed payloads

Full English and German UI.

---

## Honest limitations

- **BLE devices don't work.** If a device only appears in Smart Life over Bluetooth, it has no local WiFi API.
- **Some devices are genuinely cloud-only.** If no DPs ever show up in scans or in tools like tinytuya, local control isn't possible.
- **The Local Key changes** whenever you reset or re-pair a device in the Tuya app. If a device suddenly stops connecting, refresh it via Cloud Lookup — this is the single most common cause of "device unavailable".
- **Some DPs are hidden** if your Tuya IoT project uses the *Standard Instruction Set*. Switching that device to *DP Instruction Set* on iot.tuya.com exposes all raw DPs.

---

## Feedback and contributions

The device-specific parts of this app were built from user reports, and that's still the fastest way to get your hardware supported properly. What helps most:

- **Which devices work well** — a short "model X works with driver Y" is genuinely useful
- **Which ones don't** — especially if a tile stays empty or a command does nothing
- **A DP table** for anything unsupported: app settings → **☁️ Cloud Lookup** → click your device name → **Copy DP Table**. That single paste usually contains everything needed to add or fix a driver.
- **Logs** from the Logs tab for connection problems

Comment here or open an issue on GitHub — device model plus DP table plus log excerpt is the ideal report.

---

**Links**

- 📲 [Homey App Store](https://homey.app/en-ch/app/com.tuyalocal/Tuya-Local/)
- 💻 [GitHub — andiwirz/com.tuyalocal](https://github.com/andiwirz/com.tuyalocal)
- 🐛 [Report an issue](https://github.com/andiwirz/com.tuyalocal/issues)
- ☕ [Buy me a beer (PayPal)](https://paypal.me/AndiWirz) — appreciated, never expected
