'use strict';

const Homey                     = require('homey');
const TuyAPI                    = require('../../lib/SafeTuyAPI');
const { setupCloudLookup } = require('../../lib/pairCloudLookup');
const { describeConnectFailure } = require('../../lib/connectFailure');
const { detectProtocolVersion } = require('../../lib/autoDetect');
const { scanNetwork }           = require('../../lib/networkScan');
const { detectViaCloud, guessedDefaults }        = require('../../lib/dpCodeMap');

// Maps this driver's settings keys to the Tuya cloud "code" names that
// commonly represent them. See lib/dpCodeMap.js. dp_portions and
// dp_manual_button_portions are omitted — too ambiguous to tell apart by
// code name alone without a concrete device example.
// Verified against the standard code list for Tuya category "cwwsq" (pet feeder).
const CLOUD_CODE_MAP = {
  dp_child_lock:      ['child_lock'],
  dp_food_level:       ['food_state', 'food_level'],
  // feed_state is the standard code for the dispensing state on this category.
  dp_motor_state:      ['feed_state', 'motor_state'],
  // manual_feed is the standard "dispense N portions" command DP.
  dp_portions:         ['manual_feed'],
  dp_surplus_grain:    ['surplus_grain'],
  dp_voice_times:      ['voice_times'],
  dp_indicator_light:  ['indicator_light'],
  dp_battery:          ['battery_percentage', 'battery'],
  dp_battery_status:   ['battery_state', 'charge_state'],
  dp_feed_report:      ['feed_report'],
  dp_fault:            ['fault'],
};

// food_empty_values is deliberately absent here. It is not a value range but a
// subset — which of the reported states count as empty — so writing the declared
// range into it would make "full" count as empty and fire the food-empty
// notification constantly. The fault register is a different matter: its bit
// labels are exactly what the specification declares.
const CLOUD_ENUM_VALUES_MAP = {
  // Bitmap DP: the per-bit names live under "label", not "range" — asking for the
  // wrong one would write enum values in as bit names. See extractEnumValues.
  dp_fault: { setting: 'fault_bits', from: 'label' },
};

class PetFeederDriver extends Homey.Driver {
  async onInit() {
    this.log('Pet Feeder driver initialized');

    // ── Triggers ─────────────────────────────────────────────────────────────
    this.homey.flow.getDeviceTriggerCard('feeder_food_level_changed');
    this.homey.flow.getDeviceTriggerCard('feeder_feeding_done');
    this.homey.flow.getDeviceTriggerCard('feeder_device_connected');
    this.homey.flow.getDeviceTriggerCard('feeder_device_disconnected');
    this.homey.flow.getDeviceTriggerCard('feeder_dp_changed');

    // ── Conditions ───────────────────────────────────────────────────────────
    this.homey.flow.getConditionCard('feeder_food_is_low')
      .registerRunListener(async (args) => {
        const foodStatus = args.device.getCapabilityValue('food_status');
        const motorState = args.device.getCapabilityValue('motor_state');
        // Only "low", "less", "empty", "lack" mean food is actually low —
        // "high", "half", "full" all mean there is still adequate food in the hopper.
        // "less"/"lack" are Mypin 6L video-feeder variants for low/empty.
        const LOW_VALUES = new Set(['low', 'less', 'empty', 'lack']);
        const foodStatusLow = foodStatus !== null && LOW_VALUES.has(foodStatus);
        // DP 4 = "no_food" — iPettie/Petlibro devices use this to signal empty hopper
        const motorNoFood = motorState === 'no_food';
        return foodStatusLow || motorNoFood;
      });

    this.homey.flow.getConditionCard('feeder_device_is_connected')
      .registerRunListener(async (args) => args.device._conn?.connected === true);

    // ── Actions ──────────────────────────────────────────────────────────────
    this.homey.flow.getActionCard('feeder_feed_now')
      .registerRunListener(async (args) => {
        // args.portions comes from the flow card as a number; feed_portions is an
        // enum capability and therefore requires a string value.
        const portionsNum = args.portions ?? Number(args.device.getCapabilityValue('feed_portions')) ?? 1;
        const portionsStr = String(portionsNum);
        await args.device.setCapabilityValue('feed_portions', portionsStr);
        return args.device.triggerCapabilityListener('feed_portions', portionsStr);
      });

    // Diese Capabilities sind von der App definiert, und dafuer erzeugt Homey
    // keine Karten - ohne die hier gab es das Bedienelement nur auf der Kachel.
    this.homey.flow.getActionCard('feeder_set_child_lock')
      .registerRunListener(async (args) => {
        if (!args.device.hasCapability('child_lock')) return;
        const enabled = args.enabled === 'true';
        await args.device.setCapabilityValue('child_lock', enabled);
        return args.device.triggerCapabilityListener('child_lock', enabled);
      });

    this.homey.flow.getActionCard('feeder_set_indicator_light')
      .registerRunListener(async (args) => {
        if (!args.device.hasCapability('indicator_light')) return;
        const enabled = args.enabled === 'true';
        await args.device.setCapabilityValue('indicator_light', enabled);
        return args.device.triggerCapabilityListener('indicator_light', enabled);
      });

    this.homey.flow.getActionCard('feeder_set_voice_playback')
      .registerRunListener(async (args) => {
        if (!args.device.hasCapability('voice_playback')) return;
        const enabled = args.enabled === 'true';
        await args.device.setCapabilityValue('voice_playback', enabled);
        return args.device.triggerCapabilityListener('voice_playback', enabled);
      });

    // child_lock und oscillate sind von der App definiert - Homey erzeugt
    // dafuer weder "wurde umgeschaltet" noch eine Abfrage.
    this.homey.flow.getDeviceTriggerCard('feeder_child_lock_changed')
      .registerRunListener(async (args, state) =>
        String(args.enabled) === String(state.enabled));

    this.homey.flow.getConditionCard('feeder_child_lock_is_on')
      .registerRunListener(async (args) =>
        args.device.getCapabilityValue('child_lock') === true);

    this.homey.flow.getActionCard('feeder_force_reconnect')
      .registerRunListener(async (args) => args.device.forceReconnect());

    this.homey.flow.getActionCard('feeder_refresh_device')
      .registerRunListener(async (args) => args.device.pollNow());
  }

  // Lets the settings page re-apply the manufacturer's declared value lists to a
  // device that is already paired — see applyCloudValues() in app.js. Exposed as a
  // method because these maps are module-local constants.
  getCloudMaps() {
    return { codeMap: CLOUD_CODE_MAP, enumValuesMap: CLOUD_ENUM_VALUES_MAP };
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
          const cloudDps = await detectViaCloud(this.homey, deviceId, CLOUD_CODE_MAP, (m) => this.log(m), CLOUD_ENUM_VALUES_MAP, guessedDefaults(detectedDps, collectedDps));
          if (Object.keys(cloudDps).length > 0) Object.assign(detectedDps, cloudDps);
        }
      } catch (err) {
        connected = false;
        failureError = err.message;
        try { if (pairingDevice) pairingDevice.disconnect(); } catch (_e) {}
        this.log('Connection test failed:', err.message);
      }

      pendingDevice = {
        name: this.homey.__('device.defaultName.pet_feeder'),
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

    session.setHandler('list_devices',    async () => pendingDevice ? [pendingDevice] : []);
    session.setHandler('raw_dps',         async () => pendingRawDps || {});
    session.setHandler('set_device_name', async (name) => {
      if (pendingDevice && name?.trim()) pendingDevice.name = name.trim();
    });
  }

  _detectDps(dps) {
    const numDps  = [];
    const enumDps = [];
    const boolDps = [];

    for (const [dp, val] of Object.entries(dps)) {
      const num = parseInt(dp, 10);
      if (typeof val === 'boolean')     boolDps.push({ dp: num, val });
      else if (typeof val === 'number') numDps.push({ dp: num, val });
      else if (typeof val === 'string') enumDps.push({ dp: num, val });
    }

    // ── Portions (DP 3 per spec: manual_feed, range 1–12) ───────────────────
    // Prefer DP 3 explicitly. Fallback only within the standard DP range (≤ 20)
    // to avoid grabbing unrelated high-numbered DPs (e.g. SD-card status on
    // video feeders that happen to report a value of 1).
    const dpsMap = Object.fromEntries(Object.entries(dps).map(([k, v]) => [parseInt(k), v]));
    const portionsPreferred = [3];
    const portionsEntry =
      portionsPreferred.find((d) => d in dpsMap)
      ?? numDps.find((d) => d.dp <= 20 && d.val >= 1 && d.val <= 12)?.dp
      ?? 3;
    const dp_portions = typeof portionsEntry === 'number' ? portionsEntry : portionsEntry?.dp ?? 3;

    // ── Motor / feed state (DP 4 per spec) ───────────────────────────────────
    // Tuya spec:   standby | feeding | done
    // iPettie/Petlibro real values: standby | feeding | no_food | error_ir | feed_timeout
    // Also accept legacy strings for other firmwares.
    const MOTOR_STATES = ['standby', 'feeding', 'done', 'no_food', 'error_ir', 'feed_timeout', 'running', 'idle', 'work'];
    const motorEntry = enumDps.find((d) => MOTOR_STATES.includes(String(d.val).toLowerCase()));
    const dp_motor_state = motorEntry?.dp ?? 4;

    // ── Feed report (DP 15 per spec: actual servings dispensed 0–12) ─────────
    // Detect BEFORE surplus_grain so the assigned-DPs set can exclude DP 15.
    const dp_feed_report = (15 in dpsMap && typeof dpsMap[15] === 'number') ? 15 : 0;

    // ── Fault (DP 14 per spec: bitfield 1=no_food 2=jammed 4=feed_timeout 8=battery_low) ──
    const dp_fault = (14 in dpsMap) ? 14 : 0;

    // ── Battery percentage (DP 11 per Arlec/battery-feeder spec: 0–100 %) ────
    // Only enable when DP 11 exists, is a number, and falls within the 0–100 range.
    // Default disabled — the vast majority of feeders are AC-powered; battery models
    // (e.g. Arlec 5L) are the exception and explicitly report DP 11.
    const dp_battery = (
      11 in dpsMap &&
      typeof dpsMap[11] === 'number' &&
      dpsMap[11] >= 0 &&
      dpsMap[11] <= 100
    ) ? 11 : 0;

    // Track which DPs are already assigned to avoid double-mapping.
    const assignedNumDps = new Set([dp_portions, dp_feed_report].filter((d) => d > 0));

    // ── Surplus grain (DP 16 per spec: remaining food percentage 0–100) ──────
    // Only use the preferred DP (16) or skip — the numeric fallback is too greedy
    // and collides with feed_report (DP 15) on devices that lack DP 16.
    const dp_surplus_grain = (16 in dpsMap && typeof dpsMap[16] === 'number') ? 16 : 0;

    // ── Food level (non-standard custom DPs — not in the Tuya spec) ──────────
    // Some devices expose a custom DP (e.g. 101, 102) with enum food-level values.
    // Prefer unambiguous values (full/low/empty) over ambiguous ones (high/half),
    // so a device with both DP 101="high" and DP 102="full" picks DP 102 first.
    // "less" and "lack" are Mypin 6L video-feeder equivalents of "low" and "empty"
    const FOOD_LEVELS_CLEAR  = new Set(['full', 'empty', 'low', 'lack', 'less']);
    const FOOD_LEVELS_ALL    = new Set(['full', 'empty', 'low', 'half', 'high', 'less', 'lack']);
    const foodCandidates = enumDps.filter((d) =>
      FOOD_LEVELS_ALL.has(String(d.val).toLowerCase()) && d.dp !== dp_motor_state
    );
    // Sort: clear values first, then by DP number ascending for stable tie-breaking.
    foodCandidates.sort((a, b) => {
      const aScore = FOOD_LEVELS_CLEAR.has(String(a.val).toLowerCase()) ? 0 : 1;
      const bScore = FOOD_LEVELS_CLEAR.has(String(b.val).toLowerCase()) ? 0 : 1;
      return aScore !== bScore ? aScore - bScore : a.dp - b.dp;
    });
    const dp_food_level = foodCandidates[0]?.dp ?? 0; // default disabled — non-standard

    // ── Child lock (no standard child-lock DP in Tuya pet-feeder spec) ───────
    // Only consider DPs in the standard range (≤ 20). DPs > 20 are manufacturer-
    // specific (e.g. MYPIN DP 103/104) and must not be auto-assigned.
    // DP 9 = factory_reset — always excluded.
    const RESERVED_BOOL_DPS = new Set([1, 2, 6, 7, 8, 9, 12, 19, 20]);
    const childLockEntry = boolDps.find(
      (d) => d.dp <= 20 && !RESERVED_BOOL_DPS.has(d.dp) && d.dp !== dp_motor_state
    );
    const dp_child_lock = childLockEntry?.dp ?? 0;

    // ── Indicator light ──────────────────────────────────────────────────────
    // Not in the standard Tuya pet-feeder spec. Petlibro Granary reports it on DP 113.
    // wifi_off (DP 117) and log (DP 112) are excluded by the known-non-indicator list.
    const INDICATOR_EXCLUDED_DPS = new Set([9, 112, 117, 119]);
    const indicatorEntry = boolDps.find(
      (d) => d.dp > 20 && !INDICATOR_EXCLUDED_DPS.has(d.dp)
    );
    const dp_indicator_light = indicatorEntry?.dp ?? 0;

    return {
      dp_portions,
      dp_motor_state,
      dp_fault,
      dp_food_level,
      dp_surplus_grain,
      dp_feed_report,
      dp_child_lock,
      dp_battery,
      dp_indicator_light,
      food_empty_values: 'low,less,empty,lack',
    };
  }

  async onPairListDevices() { return []; }
}

module.exports = PetFeederDriver;
