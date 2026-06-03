'use strict';

const Homey                     = require('homey');
const TuyAPI                    = require('tuyapi');
const { detectProtocolVersion } = require('../../lib/autoDetect');
const { scanNetwork }           = require('../../lib/networkScan');

class GarageDoorDriver extends Homey.Driver {
  async onInit() {
    this.log('Garage Door driver initialized');

    // ── Triggers ─────────────────────────────────────────────────────────────
    this.homey.flow.getDeviceTriggerCard('garage_door_opened');
    this.homey.flow.getDeviceTriggerCard('garage_door_closed');
    this.homey.flow.getDeviceTriggerCard('garage_door_alarm_triggered');
    this.homey.flow.getDeviceTriggerCard('garage_door_device_connected');
    this.homey.flow.getDeviceTriggerCard('garage_door_device_disconnected');
    this.homey.flow.getDeviceTriggerCard('garage_door_dp_changed');

    // ── Conditions ───────────────────────────────────────────────────────────
    // Returns true when the door IS open (garagedoor_closed === false)
    this.homey.flow.getConditionCard('garage_door_is_open')
      .registerRunListener(async (args) =>
        args.device.getCapabilityValue('garagedoor_closed') === false
      );

    this.homey.flow.getConditionCard('garage_door_device_is_connected')
      .registerRunListener(async (args) => args.device._conn?.connected === true);

    // ── Actions ──────────────────────────────────────────────────────────────
    // Use triggerCapabilityListener so the UI updates optimistically (same as tapping the tile)
    // and the full capability-listener logic (DP control setting, error handling) is reused.
    this.homey.flow.getActionCard('garage_door_open')
      .registerRunListener(async (args) =>
        args.device.triggerCapabilityListener('garagedoor_closed', false)
      );

    this.homey.flow.getActionCard('garage_door_close')
      .registerRunListener(async (args) =>
        args.device.triggerCapabilityListener('garagedoor_closed', true)
      );

    // Toggle sends a pulse on the relay switch DP (DP 1) — equivalent to pressing the button
    this.homey.flow.getActionCard('garage_door_toggle')
      .registerRunListener(async (args) => {
        const dp = args.device.getSetting('dp_switch');
        if (!dp || dp === 0) throw new Error('Switch DP not configured');
        return args.device._conn?.set(dp, true);
      });

    // Stop:
    //   AOSD / ZC34T → sends "stop" on dp_door_control (DP 101)
    //   BoboYun      → dp_door_control = 0, falls back to dp_switch (DP 103: set true → stop)
    //   WOFEA        → dp_door_control = 6, sends "stop" (device ignores invalid enum — harmless)
    this.homey.flow.getActionCard('garage_door_stop')
      .registerRunListener(async (args) => {
        const dpControl = args.device.getSetting('dp_door_control');
        const dpSwitch  = args.device.getSetting('dp_switch');
        if (dpControl > 0) return args.device._conn?.set(dpControl, 'stop');
        if (dpSwitch  > 0) return args.device._conn?.set(dpSwitch, true);
        throw new Error('No stop DP configured (set dp_door_control or dp_switch)');
      });

    this.homey.flow.getActionCard('garage_door_force_reconnect')
      .registerRunListener(async (args) => args.device.forceReconnect());

    this.homey.flow.getActionCard('garage_door_refresh_device')
      .registerRunListener(async (args) => args.device.pollNow());
  }

  // ── Pairing ──────────────────────────────────────────────────────────────────

  async onPair(session) {
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
          await Promise.race([
            device.connect(),
            new Promise((_, rej) => setTimeout(() => rej(new Error('Connection timed out')), 8000)),
          ]);
          await new Promise((resolve) => setTimeout(resolve, 4000));
          device.disconnect();
          pairingDevice = null;
          rawDps = tmpDps;
        }
        Object.assign(collectedDps, rawDps);
        connected = true;
        if (Object.keys(collectedDps).length > 0) detectedDps = this._detectDps(collectedDps);
      } catch (err) {
        connected = false;
        try { if (pairingDevice) pairingDevice.disconnect(); } catch (_e) {}
        this.log('Connection test failed:', err.message);
      }

      pendingDevice = {
        name: this.homey.__('device.defaultName.garage_door'),
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

  // ── Auto-detect DPs from raw DPS payload ─────────────────────────────────────

  _detectDps(dps) {
    const dpsMap    = Object.fromEntries(Object.entries(dps).map(([k, v]) => [parseInt(k), v]));
    const boolDps   = Object.entries(dpsMap)
      .filter(([, v]) => typeof v === 'boolean')
      .map(([k]) => parseInt(k));
    const stringDps = Object.entries(dpsMap)
      .filter(([, v]) => typeof v === 'string')
      .map(([k, v]) => ({ dp: parseInt(k), val: String(v).toLowerCase() }));

    // ── Relay switch (DP 1, WOFEA only) ──────────────────────────────────────
    // WOFEA: DP 1 is bool relay. ZC34T / BoboYun: DP 1 is string — NOT a relay.
    const dp_switch = (1 in dpsMap && typeof dpsMap[1] === 'boolean') ? 1 : 0;

    // ── Action state (AOSD DP 107, BoboYun DP 10) ────────────────────────────
    // String DP reporting movement / position state.
    const ACTION_STATES = new Set(['opened', 'closed', 'opening', 'closing', 'partial_opening']);
    const actionEntry  = stringDps.find((d) => ACTION_STATES.has(d.val));
    const dp_door_action = actionEntry?.dp ?? 0;

    // ── Door contact sensor ────────────────────────────────────────────────────
    // When an action state DP was detected (AOSD / BoboYun), there is no separate
    // contact sensor — the action string IS the state source. Set to 0 so we don't
    // accidentally grab a light DP (e.g. AOSD DP 105) or voice DP (WOFEA DP 11).
    //
    // Without action DP:
    //   Priority 1: DP 3 bool                       — WOFEA
    //   Priority 2: non-switch bool DP ≤ 20         — eWeLink DP 2
    //   Priority 3: string DP "open"/"closed"       — ZC34T DP 1
    //   Fallback:   3                               — WOFEA safe default
    const CONTACT_STRINGS = new Set(['open', 'closed']);
    const stringContactEntry = stringDps.find((d) =>
      CONTACT_STRINGS.has(d.val) && d.dp !== dp_door_action
    );
    const dp_door_contact = (dp_door_action > 0) ? 0
      : (3 in dpsMap && typeof dpsMap[3] === 'boolean')         ? 3
      : (boolDps.find((d) => d !== dp_switch && d <= 20)        ?? null)
      ?? (stringContactEntry?.dp                                 ?? 3);

    // ── Door control command ──────────────────────────────────────────────────
    // String DP with open/close/stop value, excluding contact and action DPs.
    // WOFEA DP 6, AOSD DP 101, ZC34T DP 101.
    const DOOR_CMDS = new Set(['open', 'close', 'stop']);
    const ctrlEntry = stringDps.find((d) =>
      DOOR_CMDS.has(d.val) && d.dp !== dp_door_contact && d.dp !== dp_door_action
    );

    // ── Separate open/close DPs (BoboYun DP 106/107) ─────────────────────────
    // Detect BEFORE dp_door_control so we can skip the fallback for BoboYun.
    // Only bool DPs match — AOSD DP 107 is a string, so no conflict.
    const dp_door_open  = (106 in dpsMap && typeof dpsMap[106] === 'boolean') ? 106 : 0;
    const dp_door_close = (107 in dpsMap && typeof dpsMap[107] === 'boolean') ? 107 : 0;

    // ── Door control command (continued) ─────────────────────────────────────
    // Fallback: always use DP 6 when no control DP was found in the response
    // AND no separate BoboYun open/close DPs were detected.
    //
    // Root cause of the reported timeout: WOFEA only includes DP 6 in the GET
    // response when it was recently used. If the door hasn't been operated in a
    // while, DP 6 is absent from the DPS snapshot → ctrlEntry = undefined →
    // old code: dp_door_control = 0 → user sees 0 and sets wrong value (e.g. 1)
    // → string "open"/"close" sent to bool DP 1 → device timeout.
    // Fix: default to 6 unconditionally for non-BoboYun devices.
    const dp_door_control = (dp_door_open > 0) ? 0      // BoboYun: use separate DPs, no combined ctrl
      : (ctrlEntry?.dp ?? 6);                            // WOFEA/AOSD/ZC34T: 6 is always a safe default

    // ── Door alarm state ──────────────────────────────────────────────────────
    // WOFEA DP 12. BoboYun DP 141 not auto-detected (users set dp_door_state = 141).
    const ALARM_STATES = new Set(['unclosed_time', 'close_time_alarm', 'none']);
    const alarmEntry   = stringDps.find((d) => ALARM_STATES.has(d.val));
    const dp_door_state = alarmEntry?.dp ?? (12 in dpsMap ? 12 : 0);

    // ── Integrated light (AOSD DP 105, BoboYun DP 102) ───────────────────────
    // First bool DP > 100 not already assigned.
    const assigned = new Set(
      [dp_door_contact, dp_switch, dp_door_open, dp_door_close].filter((d) => d > 0)
    );
    const lightCandidate = boolDps.find((d) => d > 100 && !assigned.has(d));
    const dp_light = lightCandidate ?? 0;

    const detected = {
      dp_door_contact, dp_door_control, dp_switch, dp_door_state,
      dp_door_action, dp_door_open, dp_door_close, dp_light,
    };
    this.log('Detected DPs:', detected);
    return detected;
  }

  async onPairListDevices() { return []; }
}

module.exports = GarageDoorDriver;
