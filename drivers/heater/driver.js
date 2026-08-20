'use strict';

const Homey                     = require('homey');
const TuyAPI                    = require('tuyapi');
const { setupCloudLookup } = require('../../lib/pairCloudLookup');
const { detectProtocolVersion } = require('../../lib/autoDetect');
const { scanNetwork }           = require('../../lib/networkScan');
const { detectViaCloud, guessedDefaults }        = require('../../lib/dpCodeMap');

// Maps this driver's settings keys to the Tuya cloud "code" names that
// commonly represent them. See lib/dpCodeMap.js.
const CLOUD_CODE_MAP = {
  dp_onoff:           ['switch', 'power', 'switch_1'],
  dp_mode:            ['mode', 'work_mode'],
  dp_target_temp:     ['temp_set'],
  dp_current_temp:    ['temp_current'],
  dp_oscillate:       ['shake', 'swing'],
  dp_child_lock:      ['child_lock', 'lock'],
  dp_countdown_timer: ['countdown_set', 'countdown'],
  dp_countdown_left:  ['countdown_left'],
  // The reported heater uses "level"; the others are the spellings the same
  // function carries on neighbouring models.
  dp_level:           ['level', 'heat_level', 'power_level', 'work_power'],
  dp_work_state:      ['work_state'],
  dp_fault:           ['fault'],
};

// When the cloud spec confirms a DP maps to one of these settings, the DP's
// full declared enum token list is written to the companion setting.
const CLOUD_ENUM_VALUES_MAP = {
  dp_mode:  'mode_values',
  dp_level: 'level_values',
};

class HeaterDriver extends Homey.Driver {
  async onInit() {
    this.log('Heater driver initialized');

    this.homey.flow.getConditionCard('heater_device_is_connected')
      .registerRunListener(async (args) => args.device._conn?.connected === true);

    this.homey.flow.getConditionCard('heater_fault_is_active')
      .registerRunListener(async (args) => args.device.getCapabilityValue('alarm_generic') === true);

    const modeAutocomplete = async (query, args) => {
      const values = (args.device.getSetting('mode_values') || 'eco,comfort,boost,away,auto')
        .split(',').map((s) => s.trim()).filter(Boolean);
      const q = query.toLowerCase();
      return values
        .filter((v) => v.toLowerCase().includes(q))
        .map((v) => ({ id: v, name: v.charAt(0).toUpperCase() + v.slice(1).replace(/_/g, ' ') }));
    };

    this.homey.flow.getConditionCard('heater_mode_is')
      .registerArgumentAutocompleteListener('mode', modeAutocomplete)
      .registerRunListener(async (args) =>
        args.device.getCapabilityValue('mode') === args.mode.id
      );

    this.homey.flow.getActionCard('heater_set_mode')
      .registerArgumentAutocompleteListener('mode', modeAutocomplete)
      .registerRunListener(async (args) => {
        if (!args.device.hasCapability('mode')) return;
        await args.device.setCapabilityValue('mode', args.mode.id);
        return args.device.triggerCapabilityListener('mode', args.mode.id);
      });

    this.homey.flow.getActionCard('heater_set_target_temp')
      .registerRunListener(async (args) => {
        await args.device.setCapabilityValue('target_temperature', args.temperature);
        return args.device.triggerCapabilityListener('target_temperature', args.temperature);
      });

    this.homey.flow.getActionCard('heater_set_child_lock')
      .registerRunListener(async (args) => {
        if (!args.device.hasCapability('child_lock')) return;
        const enabled = args.enabled === 'true';
        await args.device.setCapabilityValue('child_lock', enabled);
        return args.device.triggerCapabilityListener('child_lock', enabled);
      });

    // "oscillate" is one of this app's own capabilities, so Homey generates no
    // flow cards for it — the app has to bring them. The fan, dehumidifier and
    // air conditioner all did; this driver did not, which left a heater whose
    // oscillation works on the tile with no way to reach it from a flow.
    //
    // Reports an error rather than returning quietly when the capability is off,
    // unlike the two cards above: a flow that says it succeeded while doing
    // nothing is how the user finds out about a missing DP number far too late.
    this.homey.flow.getActionCard('heater_set_oscillate')
      .registerRunListener(async (args) => {
        if (!args.device.hasCapability('oscillate')) {
          throw new Error(this.homey.__('errors.dpNotConfigured', { setting: 'dp_oscillate' }));
        }
        const enabled = args.enabled === 'true';
        await args.device.setCapabilityValue('oscillate', enabled);
        return args.device.triggerCapabilityListener('oscillate', enabled);
      });

    // The heating power step. Named steps, not a percentage — Homey's own
    // power_level is a 0–100 % slider and writing 50 % to a device expecting
    // "level_2" is simply rejected, so this is an enum with its own card and the
    // choices come from what the device declares.
    const levelAutocomplete = async (query, args) => {
      const values = (args.device.getSetting('level_values') || '1,2,3')
        .split(',').map((s) => s.trim()).filter(Boolean);
      const q = String(query || '').toLowerCase();
      return values
        .filter((v) => v.toLowerCase().includes(q))
        // The id is what goes to the heater and is never touched. The name is only
        // what the card reads as, and a bare "1" says nothing in a sentence like
        // "Set heating level to 1" — so a plain number is shown as "Level 1" while
        // still being sent as "1".
        .map((v) => ({
          id: v,
          name: /^\d+$/.test(v)
            ? this.homey.__('flow.levelName', { n: v })
            : v.charAt(0).toUpperCase() + v.slice(1).replace(/_/g, ' '),
        }));
    };

    this.homey.flow.getConditionCard('heater_level_is')
      .registerArgumentAutocompleteListener('level', levelAutocomplete)
      .registerRunListener(async (args) =>
        args.device.getCapabilityValue('heat_level') === args.level?.id
      );

    this.homey.flow.getActionCard('heater_set_level')
      .registerArgumentAutocompleteListener('level', levelAutocomplete)
      .registerRunListener(async (args) => {
        if (!args.device.hasCapability('heat_level')) {
          throw new Error(this.homey.__('errors.dpNotConfigured', { setting: 'dp_level' }));
        }
        // A stored autocomplete choice can outlive the list it came from — the list
        // is corrected from what the device reports, and a flow saved before that
        // still holds the old spelling. Reading .id off nothing would surface as an
        // unreadable type error, so say what is actually wrong.
        const step = args.level?.id;
        if (!step) throw new Error(this.homey.__('errors.pickAgain'));

        // Sent to the device first. triggerCapabilityListener writes the value and
        // updates the capability itself, so the setCapabilityValue that used to run
        // ahead of it was not only redundant: Homey rejects a value outside the
        // capability's current options, and that rejection happened before anything
        // reached the heater — a card that failed without having tried.
        return args.device.triggerCapabilityListener('heat_level', step);
      });

    this.homey.flow.getConditionCard('heater_is_heating')
      .registerRunListener(async (args) =>
        args.device.getCapabilityValue('heater_active') === true
      );

    this.homey.flow.getActionCard('heater_force_reconnect')
      .registerRunListener(async (args) => args.device.forceReconnect());

    this.homey.flow.getActionCard('heater_refresh_device')
      .registerRunListener(async (args) => args.device.pollNow());
  }

  // Lets the settings page re-apply the manufacturer's declared value lists to a
  // device that is already paired — see applyCloudValues() in app.js. Exposed as a
  // method because these maps are module-local constants.
  getCloudMaps() {
    return { codeMap: CLOUD_CODE_MAP, enumValuesMap: CLOUD_ENUM_VALUES_MAP };
  }

  /**
   * Keeps a declared token list from contradicting the value the device is sending.
   *
   * The reported heater declares its heating level as the range 1, 2, 3 while
   * actually reporting "level_1". Writing "1" to it is rejected, so taking the
   * specification at face value would have filled the flow card's choices with
   * three tokens the device refuses — and the picker guard in _syncEnumOptions
   * would then refuse the whole list, because the live value is in neither.
   *
   * Neither source is wrong about everything: the device is authoritative on how
   * a step is spelled, the specification on how many there are. So when the live
   * token is absent from the declared range, the range is rebuilt in the device's
   * own spelling, keeping the declared count. Only shapes that are plainly the
   * same thing twice are reconciled — a numeric range against a prefix_number
   * token; anything else is left exactly as declared.
   *
   * @param {Object} cloudDps  Result of detectViaCloud — mutated in place.
   * @param {Object} liveDps   The raw DP snapshot collected during pairing.
   */
  _reconcileTokens(cloudDps, liveDps) {
    for (const [dpKey, valuesKey] of Object.entries(CLOUD_ENUM_VALUES_MAP)) {
      const dp   = cloudDps[dpKey];
      const csv  = cloudDps[valuesKey];
      if (!(dp > 0) || typeof csv !== 'string' || !csv) continue;

      const live = liveDps?.[String(dp)];
      if (typeof live !== 'string' || !live) continue;

      const declared = csv.split(',').map((v) => v.trim()).filter(Boolean);
      if (declared.includes(live)) continue;              // no contradiction

      const m = live.match(/^(.*?)(\d+)$/);               // e.g. "level_1" -> "level_", 1
      if (!m || !declared.every((v) => /^\d+$/.test(v))) {
        this.log(`Cloud tokens for ${dpKey}: device reports "${live}", specification says `
          + `[${declared.join(', ')}] — left as declared, correct "${valuesKey}" by hand if needed`);
        continue;
      }
      const rebuilt = declared.map((n) => `${m[1]}${n}`);
      cloudDps[valuesKey] = rebuilt.join(',');
      this.log(`Cloud tokens for ${dpKey}: kept the declared ${declared.length} steps but in the `
        + `device's own spelling — ${rebuilt.join(', ')}`);
    }
  }

  // One divisor serves both temperatures.
  getScaleMaps() {
    return { dp_target_temp: { setting: 'temp_divisor', kind: 'divisor' }, dp_current_temp: { setting: 'temp_divisor', kind: 'divisor' } };
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
          const cloudDps = await detectViaCloud(this.homey, deviceId, CLOUD_CODE_MAP, (m) => this.log(m), CLOUD_ENUM_VALUES_MAP, guessedDefaults(detectedDps, collectedDps));
          this._reconcileTokens(cloudDps, collectedDps);
          if (Object.keys(cloudDps).length > 0) Object.assign(detectedDps, cloudDps);
        }
      } catch (err) {
        connected = false;
        try { if (pairingDevice) pairingDevice.disconnect(); } catch (_e) {}
        this.log('Connection test failed:', err.message);
      }

      pendingDevice = {
        name: this.homey.__('device.defaultName.heater'),
        data: { id: deviceId },
        settings: {
          ip, device_id: deviceId, local_key: localKey, version: actualVersion,
          ...(detectedDps || {}),
        },
      };
      pendingRawDps = collectedDps;
      return { connected, detectedVersion: actualVersion, detectedDps };
    });

    session.setHandler('list_devices',    async () => pendingDevice ? [pendingDevice] : []);
    session.setHandler('raw_dps',         async () => pendingRawDps || {});
    session.setHandler('set_device_name', async (name) => {
      if (pendingDevice && name?.trim()) pendingDevice.name = name.trim();
    });
  }

  _detectDps(dps) {
    const boolDps = [];
    const intDps  = [];
    const enumDps = [];

    for (const [dp, val] of Object.entries(dps)) {
      const num = parseInt(dp, 10);
      if (typeof val === 'boolean')     boolDps.push({ dp: num, val });
      else if (typeof val === 'number') intDps.push({ dp: num, val });
      else if (typeof val === 'string') enumDps.push({ dp: num, val });
    }

    const dp_onoff = (boolDps.find((d) => d.dp === 1) || boolDps[0])?.dp ?? 1;

    // ── Temperatures ──────────────────────────────────────────────────────────
    // Step 1: collect all integer DPs in a plausible temperature range
    //   direct °C: 5–45  |  ×10 encoded °C: 50–450
    const potentialTempDps = intDps.filter((d) => d.dp !== dp_onoff && (
      (d.val >= 5 && d.val <= 45) ||
      (d.val >= 50 && d.val <= 450)
    ));

    // Step 2: identify °F mirror DPs and exclude them.
    //   A °F mirror DP has a value that is ≈ (some celsius candidate × 9/5 + 32).
    //   We compare each high-range DP against every direct-°C candidate.
    const celsiusCandidates = potentialTempDps.filter((d) => d.val >= 5 && d.val <= 45);
    const fahrenheitDpSet   = new Set(
      potentialTempDps
        .filter((d) => d.val > 45)
        .filter((d) => celsiusCandidates.some(
          (c) => Math.abs(d.val - Math.round(c.val * 9 / 5 + 32)) <= 2,
        ))
        .map((d) => d.dp),
    );
    const tempDps = potentialTempDps.filter((d) => !fahrenheitDpSet.has(d.dp));

    tempDps.sort((a, b) => a.dp - b.dp);

    // DP 2 = target temp, DP 3 = current temp is the standard Tuya heater layout
    const targetEntry  = tempDps.find((d) => d.dp === 2) || tempDps[0];
    const currentEntry = tempDps.find((d) => d.dp === 3) || tempDps.find((d) => d.dp !== targetEntry?.dp) || tempDps[1];

    const dp_target_temp  = targetEntry?.dp  ?? 2;
    const dp_current_temp = currentEntry?.dp ?? 0;

    // Divisor: 1 if raw value is in normal range, 10 if ×10 encoded
    const rawTarget    = targetEntry?.val ?? 20;
    const temp_divisor = rawTarget > 45 ? 10 : 1;

    // ── Mode ──────────────────────────────────────────────────────────────────
    const KNOWN_MODES = ['eco', 'comfort', 'boost', 'away', 'auto', 'low', 'high', 'sleep'];
    const modeEntry   = enumDps.find((d) => KNOWN_MODES.includes(String(d.val).toLowerCase()));
    const dp_mode     = modeEntry?.dp ?? 0;

    // Seed mode_values from the detected mode value so the flow card autocomplete
    // shows a sensible set of choices without manual configuration.
    const MODE_FAMILIES = {
      low:     'low,high',
      high:    'low,high',
      eco:     'eco,comfort,boost,away,auto',
      comfort: 'eco,comfort,boost,away,auto',
      boost:   'eco,comfort,boost,away,auto',
      away:    'eco,comfort,boost,away,auto',
      auto:    'eco,comfort,boost,away,auto',
      sleep:   'sleep,auto',
    };
    const detectedMode = modeEntry?.val ? String(modeEntry.val).toLowerCase() : null;
    const mode_values  = (detectedMode && MODE_FAMILIES[detectedMode])
      ? MODE_FAMILIES[detectedMode]
      : 'eco,comfort,boost,away,auto';

    // ── Work-state DP ─────────────────────────────────────────────────────────
    // Detect a DP whose current value indicates active/idle heating state.
    const WORK_STATES = new Set(['heating', 'no_heating', 'standby', 'idle']);
    const workEntry   = enumDps.find(
      (d) => WORK_STATES.has(String(d.val).toLowerCase()) && d.dp !== dp_mode,
    );
    const dp_work_state = workEntry?.dp ?? 0;

    const timerEntry = enumDps.find((d) => String(d.val) === 'cancel' || /^\d+h$/.test(String(d.val)));
    const dp_countdown_timer = timerEntry?.dp ?? 0;

    // ── Heating level ─────────────────────────────────────────────────────────
    // The power step, which on these heaters is a list of named steps rather than
    // a percentage — so Homey's own power_level slider is the wrong shape for it.
    // Matched on the "level_N" spelling rather than on a bare number: a bare "1"
    // is indistinguishable from a step switch, a scene index or a fan speed, and
    // this driver already has three other enum DPs competing for the same values.
    const levelEntry = enumDps.find((d) =>
      d.dp !== dp_mode && d.dp !== dp_work_state && d.dp !== dp_countdown_timer
      && /^level_\d+$/i.test(String(d.val)));
    const dp_level = levelEntry?.dp ?? 0;
    // Locally only the current step is visible, never how many there are. Three is
    // what the reported heater declares and what this family of devices uses; the
    // observed number widens it if it is already higher, and Cloud Lookup replaces
    // the whole list with the declared range wherever the specification carries it.
    const observedLevel = levelEntry ? parseInt(String(levelEntry.val).split('_')[1], 10) : 0;
    const levelSteps    = Math.max(3, Number.isFinite(observedLevel) ? observedLevel : 3);
    const level_values  = levelEntry
      ? Array.from({ length: levelSteps }, (_, i) => `level_${i + 1}`).join(',')
      : 'level_1,level_2,level_3';

    const oscillateEntry = boolDps.find((d) => d.dp !== dp_onoff && d.dp > 1);
    const dp_oscillate   = oscillateEntry?.dp ?? 0;

    return {
      dp_onoff, dp_target_temp, dp_current_temp, dp_mode, dp_oscillate,
      dp_child_lock: 0, dp_fault: 0, dp_countdown_timer, dp_countdown_left: 0,
      dp_work_state, dp_level,
      temp_divisor,
      temp_min: 5, temp_max: 35, temp_step: 1,
      mode_values, level_values,
    };
  }

  async onPairListDevices() { return []; }
}

module.exports = HeaterDriver;
