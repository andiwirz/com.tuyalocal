'use strict';

const Homey                     = require('homey');
const TuyAPI                    = require('../../lib/SafeTuyAPI');
const { setupCloudLookup } = require('../../lib/pairCloudLookup');
const { describeConnectFailure } = require('../../lib/connectFailure');
const { detectProtocolVersion } = require('../../lib/autoDetect');
const { scanNetwork }           = require('../../lib/networkScan');
const { detectViaCloud, guessedDefaults }        = require('../../lib/dpCodeMap');

// Maps this driver's settings keys to the Tuya cloud "code" names that
// commonly represent them. See lib/dpCodeMap.js for why this refines the
// local value-heuristic DP detection during pairing.
// Verified against the standard code list for Tuya category "fs" (fan).
const CLOUD_CODE_MAP = {
  // "fan_switch" comes first: on combo fan+light fixtures (categories "fsd"/
  // "xdd") there is no bare "switch" at all, and the value-heuristic's fallback
  // — the lowest-numbered boolean DP — lands on the light's switch_led instead,
  // since that is invariably numbered below the fan's own controls. Verified
  // against a real fixture's specification (switch_led DP 20, fan_switch DP 60):
  // without this, dp_onoff silently drives the light, not the fan.
  dp_onoff:            ['fan_switch', 'switch', 'switch_1', 'power'],
  // "fan_speed" is used by Tuya for both an integer percentage and an enum step
  // switch, so both settings claim the code and the declared type decides which
  // one gets it. Without that check an enum step switch lands on the numeric
  // setting, and writing a number to an enum DP is rejected by the device.
  dp_speed:            [{ code: 'fan_speed', type: 'Integer' }, { code: 'speed', type: 'Integer' }],
  dp_fan_speed:        ['fan_speed_enum', 'level', 'windspeed',
                        { code: 'fan_speed', type: 'Enum' }, { code: 'speed', type: 'Enum' }],
  // fan_horizontal / fan_vertical are the standard swing codes for this
  // category; shake / swing appear on rebadged units, fan_shake on combos.
  dp_oscillate:        ['fan_horizontal', 'fan_vertical', 'shake', 'swing', 'fan_shake'],
  dp_direction:        ['fan_direction', 'direction'],
  // "work_mode" is claimed by dp_light_mode below, not listed here: on a combo
  // it is the light's colour-mode selector (white/colour/scene/music), and the
  // fan's own selector is "fan_mode". A device that has work_mode but no light
  // at all is handed back to dp_mode by _reconcileCloud after the lookup.
  dp_mode:             ['fan_mode', 'mode'],
  dp_child_lock:       ['child_lock', 'lock'],
  dp_countdown_timer:  ['countdown', 'countdown_set'],
  dp_countdown_left:   ['countdown_left', 'fan_countdown_left'],
  dp_light_onoff:      ['light', 'switch_led'],
  dp_light_dim:        ['bright_value', 'bright_value_v2', 'bright_value_1'],
  dp_light_color_temp: ['temp_value', 'temp_value_v2'],
  dp_light_colour:     ['colour_data', 'colour_data_v2'],
  dp_light_mode:       ['work_mode'],
};

// When the cloud spec confirms a DP maps to one of these settings, the DP's
// full declared enum token list is written to the companion setting. Note:
// this driver's mode capability uses "fan_mode_values" (not "mode_values").
const CLOUD_ENUM_VALUES_MAP = {
  dp_mode:       'fan_mode_values',
  dp_fan_speed:  'fan_speed_values',
  dp_light_mode: 'light_mode_values',
};

// When the cloud spec declares an Integer DP's own min/max, that range replaces
// the 0–100 pairing assumes. bright_value and temp_value commonly span 10–1000
// and 0–1000 rather than 0–100, and fan_speed commonly spans 1–100 rather than
// the 1–6 pairing falls back to when no numeric speed was found locally — see
// extractIntegerRange in lib/dpCodeMap.js.
const CLOUD_RANGE_MAP = {
  dp_speed:            { min: 'speed_min',               max: 'speed_max' },
  dp_light_dim:        { min: 'dp_light_dim_min',        max: 'dp_light_dim_max' },
  dp_light_color_temp: { min: 'dp_light_color_temp_min', max: 'dp_light_color_temp_max' },
};

class FanDriver extends Homey.Driver {
  async onInit() {
    this.log('Fan driver initialized');

    // ── Trigger run-listeners ───────────────────────────────────────────────
    this.homey.flow.getDeviceTriggerCard('fan_mode_changed')
      .registerRunListener(async (args, state) => true); // always fire

    this.homey.flow.getDeviceTriggerCard('fan_direction_changed')
      .registerRunListener(async (args, state) => true); // always fire

    // ── Conditions ──────────────────────────────────────────────────────────
    this.homey.flow.getConditionCard('fan_device_is_connected')
      .registerRunListener(async (args) =>
        args.device._conn?.connected === true
      );

    const cap = (v) => v.charAt(0).toUpperCase() + v.slice(1).replace(/_/g, ' ');
    const modeAC = async (query, args) => {
      const values = (args.device.getSetting('fan_mode_values') || 'normal,sleep,nature,breeze,smart')
        .split(',').map((s) => s.trim()).filter(Boolean);
      const q = query.toLowerCase();
      return values.filter((v) => v.toLowerCase().includes(q)).map((v) => ({ id: v, name: cap(v) }));
    };
    const fanAC = async (query, args) => {
      const values = (args.device.getSetting('fan_speed_values') || 'low,medium,high,auto,turbo')
        .split(',').map((s) => s.trim()).filter(Boolean);
      const q = query.toLowerCase();
      return values.filter((v) => v.toLowerCase().includes(q)).map((v) => ({ id: v, name: cap(v) }));
    };

    this.homey.flow.getConditionCard('fan_mode_is')
      .registerArgumentAutocompleteListener('mode', modeAC)
      .registerRunListener(async (args) =>
        args.device.getCapabilityValue('fan_mode') === args.mode.id
      );

    this.homey.flow.getConditionCard('fan_direction_is')
      .registerRunListener(async (args) =>
        args.device.getCapabilityValue('fan_direction') === args.direction
      );

    this.homey.flow.getConditionCard('fan_light_is_on')
      .registerRunListener(async (args) =>
        args.device.getCapabilityValue('onoff.light') === true
      );

    // ── Actions ─────────────────────────────────────────────────────────────
    this.homey.flow.getActionCard('fan_set_mode')
      .registerArgumentAutocompleteListener('mode', modeAC)
      .registerRunListener(async (args) => {
        if (!args.device.hasCapability('fan_mode')) return;
        await args.device.setCapabilityValue('fan_mode', args.mode.id);
        return args.device.triggerCapabilityListener('fan_mode', args.mode.id);
      });

    this.homey.flow.getActionCard('fan_set_fan_speed')
      .registerArgumentAutocompleteListener('fan_speed', fanAC)
      .registerRunListener(async (args) => {
        if (!args.device.hasCapability('fan_speed')) return;
        await args.device.setCapabilityValue('fan_speed', args.fan_speed.id);
        return args.device.triggerCapabilityListener('fan_speed', args.fan_speed.id);
      });

    this.homey.flow.getActionCard('fan_set_oscillate')
      .registerRunListener(async (args) => {
        if (!args.device.hasCapability('oscillate')) return;
        const enabled = args.enabled === 'true';
        await args.device.setCapabilityValue('oscillate', enabled);
        return args.device.triggerCapabilityListener('oscillate', enabled);
      });

    this.homey.flow.getActionCard('fan_set_direction')
      .registerRunListener(async (args) => {
        if (!args.device.hasCapability('fan_direction')) return;
        await args.device.setCapabilityValue('fan_direction', args.direction);
        return args.device.triggerCapabilityListener('fan_direction', args.direction);
      });

    this.homey.flow.getActionCard('fan_set_timer')
      .registerRunListener(async (args) => {
        if (!args.device.hasCapability('countdown_timer')) return;
        await args.device.setCapabilityValue('countdown_timer', args.timer);
        return args.device.triggerCapabilityListener('countdown_timer', args.timer);
      });

    this.homey.flow.getActionCard('fan_set_light')
      .registerRunListener(async (args) => {
        if (!args.device.hasCapability('onoff.light')) return;
        const enabled = args.enabled === 'true';
        await args.device.setCapabilityValue('onoff.light', enabled);
        return args.device.triggerCapabilityListener('onoff.light', enabled);
      });

    this.homey.flow.getActionCard('fan_set_light_dim')
      .registerRunListener(async (args) => {
        if (!args.device.hasCapability('dim.light')) return;
        const value = Math.max(0, Math.min(1, Number(args.brightness) / 100));
        await args.device.setCapabilityValue('dim.light', value);
        return args.device.triggerCapabilityListener('dim.light', value);
      });

    // Sends the raw token, so scene/music are reachable even though Homey's
    // light_mode capability can only express white ↔ colour. Deliberately
    // throws when the DP is not configured instead of returning silently: a
    // flow that reports success while doing nothing reads as a broken device.
    const lightModeAC = async (query, args) => {
      const values = (args.device.getSetting('light_mode_values') || 'white,colour,scene,music')
        .split(',').map((s) => s.trim()).filter(Boolean);
      const q = query.toLowerCase();
      return values.filter((v) => v.toLowerCase().includes(q)).map((v) => ({ id: v, name: cap(v) }));
    };
    this.homey.flow.getActionCard('fan_set_light_mode')
      .registerArgumentAutocompleteListener('mode', lightModeAC)
      .registerRunListener(async (args) => args.device.setLightMode(args.mode.id));

    // Diese Capabilities sind von der App definiert, und dafuer erzeugt Homey
    // keine Karten - ohne die hier gab es das Bedienelement nur auf der Kachel.
    this.homey.flow.getActionCard('fan_set_child_lock')
      .registerRunListener(async (args) => {
        if (!args.device.hasCapability('child_lock')) return;
        const enabled = args.enabled === 'true';
        await args.device.setCapabilityValue('child_lock', enabled);
        return args.device.triggerCapabilityListener('child_lock', enabled);
      });

    this.homey.flow.getActionCard('fan_force_reconnect')
      .registerRunListener(async (args) => args.device.forceReconnect());

    this.homey.flow.getActionCard('fan_refresh_device')
      .registerRunListener(async (args) => args.device.pollNow());
  }

  // Lets the settings page re-apply the manufacturer's declared value lists to a
  // device that is already paired — see applyCloudValues() in app.js. Exposed as a
  // method because these maps are module-local constants.
  getCloudMaps() {
    return { codeMap: CLOUD_CODE_MAP, enumValuesMap: CLOUD_ENUM_VALUES_MAP, rangeMap: CLOUD_RANGE_MAP };
  }

  async onPair(session) {
    setupCloudLookup(session, this.homey, this);
    let pendingDevice = null;
    let pendingRawDps = {};

    session.setHandler('scan_network', async () => scanNetwork(this.homey));

    session.setHandler('credentials', async (data) => {
      const { ip, deviceId, localKey, version } = data;

      const net = require('net');
      if (!net.isIPv4(ip)) throw new Error(this.homey.__('pair.credentials.invalidIp'));
      if (localKey.length !== 16 && localKey.length !== 32)
        throw new Error(this.homey.__('pair.credentials.invalidKey'));

      let connected     = false;
      let failureError = '';
      let detectedDps   = null;
      let actualVersion = String(version);
      const collectedDps = {};
      let pairingDevice = null;

      try {
        let rawDps;
        if (version === 'auto') {
          const result = await detectProtocolVersion({ ip, deviceId, localKey });
          actualVersion = result.version;
          rawDps        = result.dps;
        } else {
          const device = new TuyAPI({ id: deviceId, key: localKey, ip, version: actualVersion, issueGetOnConnect: true });
          pairingDevice = device;
          device.on('error', () => {});
          const tmpDps = {};
          device.on('data', (payload) => { if (payload?.dps) Object.assign(tmpDps, payload.dps); });
          // Replies to a DP_REFRESH request arrive on a separate event; some devices
          // report the packed voltage/current/power DP only that way.
          device.on('dp-refresh', (payload) => { if (payload?.dps) Object.assign(tmpDps, payload.dps); });
          await Promise.race([
            device.connect(),
            new Promise((_, rej) => setTimeout(() => rej(new Error('Connection timed out')), 8000)),
          ]);
          await new Promise((resolve) => setTimeout(resolve, 2000));
          // Always ask for a refresh, not just when nothing arrived: devices that do
          // answer dp_query may still withhold the refresh-only DPs, which is where
          // packed voltage/current/power values usually live.
          try { device.refresh(); } catch (_) {}
          await new Promise((resolve) => setTimeout(resolve, 2000));
          device.disconnect();
          pairingDevice = null;
          rawDps = tmpDps;
        }
        Object.assign(collectedDps, rawDps);
        connected = true;
        if (Object.keys(collectedDps).length > 0) {
          detectedDps = this._detectDps(collectedDps);
          this.log('Locally detected DPs (value heuristic):', JSON.stringify(detectedDps));

          // Best-effort refinement using the device's Tuya cloud specification.
          // Only runs if Cloud Lookup credentials were saved previously (Settings
          // → ☁️ Cloud Lookup) — never blocks pairing if unavailable or it fails.
          const cloudDps = await detectViaCloud(this.homey, deviceId, CLOUD_CODE_MAP, (m) => this.log(m), CLOUD_ENUM_VALUES_MAP, guessedDefaults(detectedDps, collectedDps), CLOUD_RANGE_MAP);
          if (Object.keys(cloudDps).length > 0) {
            this._reconcileCloud(cloudDps, detectedDps);
            Object.assign(detectedDps, cloudDps);
            this.log('Final detected DPs (cloud-refined):', JSON.stringify(detectedDps));
          }
        }
      } catch (err) {
        connected = false;
        failureError = err.message;
        try { if (pairingDevice) pairingDevice.disconnect(); } catch (_e) {}
        this.log('Connection test failed:', err.message);
      }

      pendingDevice = {
        name: this.homey.__('device.defaultName.fan'),
        data: { id: deviceId },
        settings: {
          ip, device_id: deviceId, local_key: localKey, version: actualVersion,
          ...(detectedDps || {}),
        },
      };
      pendingRawDps = collectedDps;
      // The dialog used to say only "connection failed" — the same sentence
      // whether the address is wrong, the key is wrong, or the device does not
      // offer local control at all. So people work through the one visible
      // choice, the protocol version. Looking at port 6668 separates the cases.
      const failureHint = connected
        ? ''
        : await describeConnectFailure({ ip, error: failureError });
      if (failureHint) this.log(failureHint);

      return { connected, detectedVersion: actualVersion, detectedDps, failureHint };
    });

    session.setHandler('list_devices', async () => pendingDevice ? [pendingDevice] : []);
    session.setHandler('raw_dps',      async () => pendingRawDps || {});
    session.setHandler('set_device_name', async (name) => {
      if (pendingDevice && name?.trim()) pendingDevice.name = name.trim();
    });
  }

  /**
   * Cleans up the two ways the cloud lookup and the local value heuristic can
   * contradict each other on this driver. Mutates both arguments; call before
   * merging cloudDps over detectedDps.
   *
   * 1. "work_mode" resolves to dp_light_mode (the combo fixtures' light-mode
   *    selector), but a plain fan that declares work_mode with no light around
   *    it is using the code for its own mode — hand it back to dp_mode, along
   *    with the token list, and drop the phantom light setting. "No light" is
   *    judged by the same lookup: no switch_led/light code resolved.
   *
   * 2. The heuristic can assign a DP number that the cloud has just proven to
   *    mean something else — on the reported combos it read fan_switch (60) as
   *    the oscillation toggle, so "oscillate" would have cut the fan's power.
   *    A number cannot serve two settings; the guessed one is cleared.
   */
  _reconcileCloud(cloudDps, detectedDps) {
    if (cloudDps.dp_light_mode > 0 && !(cloudDps.dp_light_onoff > 0)) {
      if (!(cloudDps.dp_mode > 0)) {
        cloudDps.dp_mode = cloudDps.dp_light_mode;
        if (cloudDps.light_mode_values) cloudDps.fan_mode_values = cloudDps.light_mode_values;
      }
      cloudDps.dp_light_mode = 0;
      delete cloudDps.light_mode_values;
    }

    const isScaleKey = (k) => /_(?:min|max|invert)$/.test(k);
    const owner = new Map(); // dp number -> the setting the cloud resolved it to
    for (const [k, v] of Object.entries(cloudDps)) {
      if (k.startsWith('dp_') && !isScaleKey(k) && Number.isInteger(v) && v > 0) owner.set(v, k);
    }
    for (const [k, v] of Object.entries(detectedDps || {})) {
      if (!k.startsWith('dp_') || isScaleKey(k)) continue;
      if (cloudDps[k] !== undefined) continue; // the cloud value wins anyway
      if (Number.isInteger(v) && v > 0 && owner.has(v) && owner.get(v) !== k) {
        this.log(`Cloud reconcile: ${k} guessed DP ${v}, which is ${owner.get(v)} — cleared`);
        detectedDps[k] = 0;
      }
    }
  }

  _detectDps(dps) {
    const boolDps = [];
    const intDps  = [];
    const enumDps = [];

    for (const [dp, val] of Object.entries(dps)) {
      const num = parseInt(dp, 10);
      if (typeof val === 'boolean')      boolDps.push({ dp: num, val });
      else if (typeof val === 'number')  intDps.push({ dp: num, val });
      else if (typeof val === 'string')  enumDps.push({ dp: num, val });
    }

    const dp_onoff = (boolDps.find((d) => d.dp === 1) || boolDps[0])?.dp ?? 1;

    // Numeric speed: a small integer (1–100). The low range is searched first,
    // because that is where standalone fans put it and the assignment there is
    // long-established. Within it there is deliberately no further fallback: DP 3
    // carries an integer speed on many fans and an enum step switch on others, and
    // writing an integer to an enum DP is rejected by the device.
    //
    // Combo fan+light fixtures put it far higher — DP 62 on one reported brand,
    // DP 105 on the other — so a search that stopped at DP 10 found neither and the
    // speed control did nothing at all. One brand is rescued by Cloud Lookup, which
    // resolves "fan_speed" by name; the other keeps its fan data points out of the
    // published specification, so this heuristic is the only thing that can find them.
    //
    // The widened pass runs only when the low range yielded nothing, and it skips
    // zeros — which is what keeps it off the countdown and dream-strip data points on
    // the reported devices. It remains a guess: a fixture whose lamp happens to sit in
    // the 1–100 band at pairing time can have its brightness taken for the speed.
    // Cloud Lookup settles that, and both fields stay editable in device settings.
    const speedIn = (lo, hi) => intDps.find((d) =>
      d.dp !== dp_onoff && d.val >= 1 && d.val <= 100 && d.dp >= lo && d.dp <= hi);
    const lowSpeed   = speedIn(0, 10);
    const speedEntry = lowSpeed || speedIn(11, 255);
    const dp_speed   = speedEntry?.dp ?? 0;

    const KNOWN_FAN        = ['low', 'medium', 'middle', 'high', 'auto', 'turbo'];
    const fanEntry         = enumDps.find((d) => KNOWN_FAN.includes(String(d.val).toLowerCase()));
    let   dp_fan_speed     = fanEntry?.dp ?? 0;
    let   fan_speed_values = 'low,medium,high,auto,turbo';

    // Locally only a DP's *current* value is ever visible, never the list of values
    // it accepts — so the token list has to come from somewhere. It used to be one
    // fixed list of five, with the observed token appended when it was not already
    // in it. On a fan+light combo, which accepts nothing but fresh and nature, that
    // produced a picker offering Normal, Sleep, Breeze and Smart as well: four
    // buttons that do nothing, reported by a user as "Breeze does not respond".
    //
    // The list is now the family the observed token belongs to, so nothing is
    // offered that the token contradicts. A token from no known family yields a
    // one-entry list — useless as a picker, but honest, and it still satisfies the
    // guard in _syncEnumOptions that rejects a list missing the live value.
    // Cloud Lookup replaces all of this with the declared range where the
    // specification carries it; the xdd combos keep their fan DPs outside it,
    // which is exactly the case this has to get right on its own.
    const MODE_FAMILIES = [
      // Listed first, so a token both families share ("nature") keeps resolving the
      // way it always has and no existing fan's picker shrinks under it.
      ['normal', 'sleep', 'nature', 'breeze', 'smart'],  // standalone fans
      ['fresh', 'nature'],                               // fan+light combos (fsd/xdd)
    ];
    const KNOWN_MODES  = [...new Set([...MODE_FAMILIES.flat(), 'natural'])];
    const modeEntry    = enumDps.find((d) => KNOWN_MODES.includes(String(d.val).toLowerCase()));
    const dp_mode      = modeEntry?.dp ?? 0;

    const modeToken = modeEntry ? String(modeEntry.val).toLowerCase() : null;
    const fan_mode_values = (modeToken
      ? (MODE_FAMILIES.find((f) => f.includes(modeToken)) || [modeToken])
      : MODE_FAMILIES[0]).join(',');

    // The light's own mode selector on combo fixtures. Detected before the
    // numeric fan-speed fallback so its DP cannot be mistaken for a step switch.
    const KNOWN_LIGHT_MODES = ['white', 'colour', 'color', 'scene', 'music'];
    const lightModeEntry = enumDps.find((d) => KNOWN_LIGHT_MODES.includes(String(d.val).toLowerCase()));
    const dp_light_mode  = lightModeEntry?.dp ?? 0;

    // Packed HSV colour: exactly 12 hex characters. Checked here rather than in
    // the numeric fallback below because a colour whose hex digits happen to be
    // all decimal ("001203000300") would otherwise read as a speed step token.
    const colourEntry     = enumDps.find((d) => d.dp !== dp_light_mode && /^[0-9a-fA-F]{12}$/.test(String(d.val)));
    const dp_light_colour = colourEntry?.dp ?? 0;

    // Direction: enum DP whose value is 'forward' or 'reverse'
    const KNOWN_DIR    = ['forward', 'reverse'];
    const dirEntry     = enumDps.find((d) => KNOWN_DIR.includes(String(d.val).toLowerCase()));
    const dp_direction = dirEntry?.dp ?? 0;

    // The standard token list declares the idle state as "cancel", but plenty of
    // firmware reports "off" instead. Mode and direction are excluded so a mode
    // enum that happens to sit at "off" cannot be taken for a timer.
    const timerEntry = enumDps.find((d) => {
      if (d.dp === dp_mode || d.dp === dp_direction) return false;
      const v = String(d.val).toLowerCase();
      return v === 'cancel' || v === 'off' || /^\d+h$/.test(v);
    });
    const dp_countdown_timer = timerEntry?.dp ?? 0;

    // Step switches whose tokens are plain numbers ("1".."6") instead of words are
    // common on ceiling fans and match none of the KNOWN_FAN tokens above. They are
    // enums, so they belong on dp_fan_speed rather than the numeric dp_speed.
    if (dp_fan_speed === 0) {
      const numericFan = enumDps.find((d) =>
        d.dp !== dp_mode && d.dp !== dp_direction && d.dp !== dp_countdown_timer
        && d.dp !== dp_light_mode && d.dp !== dp_light_colour
        && /^\d+$/.test(String(d.val)));
      if (numericFan) {
        dp_fan_speed = numericFan.dp;
        // Locally only the DP's current value is visible, so the token list has to
        // be assumed: six steps covers the usual ceiling-fan remote, widened if the
        // live value is already higher. The cloud path overwrites this with the
        // declared range, and the field stays editable in device settings.
        const observed = parseInt(numericFan.val, 10);
        const steps    = Math.max(6, Number.isFinite(observed) ? observed : 6);
        fan_speed_values = Array.from({ length: steps }, (_, i) => String(i + 1)).join(',');
      }
    }

    // Light on/off heuristic: boolean DP with dp >= 10 (common Tuya light DPs: 15, 20, etc.)
    const lightOnoffEntry = boolDps.find((d) => d.dp !== dp_onoff && d.dp >= 10);
    const dp_light_onoff  = lightOnoffEntry?.dp ?? 0;

    // Oscillation is deliberately not guessed. The old rule took the first spare
    // boolean, and true/false says nothing about what it controls: on the reported
    // combo fixtures it landed on the lamp's colour_switch on one brand and on the
    // fan's own power switch on the other, so an "Oscillate" toggle either cut the
    // fan or silently disabled colour — and its owner wrote in to ask what the
    // control was even for. Cloud Lookup still resolves fan_horizontal /
    // fan_vertical / shake / swing by name, which is the only evidence that
    // actually identifies the function, and the field stays editable by hand.
    const dp_oscillate = 0;

    // Light brightness: int DP in range 0–100, not speed, dp >= 10
    const lightDimEntry = intDps.find((d) => d.dp !== dp_speed && d.dp >= 10 && d.val >= 0 && d.val <= 100);
    const dp_light_dim  = lightDimEntry?.dp ?? 0;

    // Light color temp: int DP in range 0–100, not speed, not light dim, dp >= 10
    const lightTempEntry     = intDps.find((d) => d.dp !== dp_speed && d.dp !== dp_light_dim && d.dp >= 10 && d.val >= 0 && d.val <= 100);
    const dp_light_color_temp = lightTempEntry?.dp ?? 0;

    // Detect speed range. Where the data point was found matters as much as the value
    // on it: a low-numbered one on a standalone fan is a step switch, so a live value
    // of 3 means three of about six steps, while a high-numbered one carries either a
    // percentage or a step count and the number alone cannot tell them apart.
    //
    // Which way to lean was decided by counting rather than by argument. Across the 52
    // fan-with-light configurations in the tuya-local project, those with a
    // high-numbered speed data point declare 1–6 seventeen times and 1–100 four times.
    // This used to assume 100 on the strength of two reported fixtures, and both of
    // them happen to sit in that smaller group. So a combo now assumes steps.
    //
    // The live value still gets the final say in the one direction it can: a fixture
    // already reporting more than 6 cannot be running a 1–6 scale, whatever the shape
    // of its data points. And a declared range from Cloud Lookup overrides all of this
    // whenever there is one — see CLOUD_RANGE_MAP.
    const rawSpeed  = speedEntry?.val ?? 1;
    const speed_min = 1;
    const isCombo   = dp_light_onoff > 0 || dp_light_dim > 0 || dp_light_color_temp > 0;
    const speed_max = (speedEntry && !lowSpeed)
      ? ((isCombo && rawSpeed <= 6) ? 6 : 100)
      : (rawSpeed <= 6 ? 6 : rawSpeed <= 12 ? 12 : 100);

    // Light dim range defaults
    const dp_light_dim_min = 0;
    const dp_light_dim_max = dp_light_dim > 0 ? 100 : 100;

    return {
      dp_onoff, dp_speed, dp_fan_speed, dp_oscillate, dp_direction, dp_mode,
      dp_child_lock: 0, dp_countdown_timer, dp_countdown_left: 0,
      speed_min, speed_max,
      fan_speed_values,
      fan_mode_values,
      dp_light_onoff, dp_light_dim, dp_light_dim_min, dp_light_dim_max, dp_light_color_temp,
      // Same 0–100 assumption as dp_light_dim_min/max, and the same caveat: the
      // cloud path (CLOUD_RANGE_MAP) overwrites this with the declared span when
      // available, but pairing alone has no way to know a device's temp_value
      // actually runs 0–1000.
      dp_light_color_temp_min: 0, dp_light_color_temp_max: 100,
      dp_light_colour, dp_light_mode,
      light_mode_values: 'white,colour,scene,music',
    };
  }

  async onPairListDevices() { return []; }
}

module.exports = FanDriver;
