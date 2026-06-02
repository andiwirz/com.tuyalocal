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

    // Stop: sends "stop" on the control DP — supported by ZC34T (DP 101) and
    // cover-style devices. Ignored silently by WOFEA (device rejects unknown enum value).
    this.homey.flow.getActionCard('garage_door_stop')
      .registerRunListener(async (args) => {
        const dp = args.device.getSetting('dp_door_control');
        if (!dp || dp === 0) throw new Error('Door control DP not configured');
        return args.device._conn?.set(dp, 'stop');
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
    // DP 1 is the relay on WOFEA (bool). On ZC34T, DP 1 is a string state —
    // do NOT treat it as a switch in that case.
    const dp_switch = (1 in dpsMap && typeof dpsMap[1] === 'boolean') ? 1 : 0;

    // ── Door contact sensor ────────────────────────────────────────────────────
    // Priority 1: DP 3 bool  — WOFEA (doorcontact_state)
    // Priority 2: any other bool DP, excluding the relay switch
    // Priority 3: first string DP whose value is "open" or "closed" — ZC34T (DP 1)
    // Fallback:   3  — safe WOFEA default if device didn't respond at pairing time
    const CONTACT_STRINGS = new Set(['open', 'closed']);
    const stringContactEntry = stringDps.find((d) => CONTACT_STRINGS.has(d.val));
    const dp_door_contact =
      (3 in dpsMap && typeof dpsMap[3] === 'boolean')   ? 3
      : (boolDps.find((d) => d !== dp_switch)           ?? null)
      ?? (stringContactEntry?.dp                        ?? 3);

    // ── Door control command ────────────────────────────────────────────────────
    // Find a string DP whose current value is "open", "close", or "stop",
    // but NOT the contact DP (avoids confusing ZC34T's state DP 1 for the control DP 101).
    // Covers WOFEA DP 6 (enum "open") and ZC34T DP 101 (string "open"/"close"/"stop").
    const DOOR_CMDS = new Set(['open', 'close', 'stop']);
    const ctrlEntry = stringDps.find((d) =>
      DOOR_CMDS.has(d.val) && d.dp !== dp_door_contact
    );
    const dp_door_control = ctrlEntry?.dp ?? (6 in dpsMap ? 6 : 0);

    // ── Door alarm state (DP 12, WOFEA) ────────────────────────────────────────
    const ALARM_STATES = new Set(['unclosed_time', 'close_time_alarm', 'none']);
    const alarmEntry = stringDps.find((d) => ALARM_STATES.has(d.val));
    const dp_door_state = alarmEntry?.dp ?? (12 in dpsMap ? 12 : 0);

    this.log('Detected DPs:', { dp_door_contact, dp_door_control, dp_switch, dp_door_state });
    return { dp_door_contact, dp_door_control, dp_switch, dp_door_state };
  }

  async onPairListDevices() { return []; }
}

module.exports = GarageDoorDriver;
