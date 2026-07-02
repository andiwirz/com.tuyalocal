'use strict';

const Homey                     = require('homey');
const TuyAPI                    = require('tuyapi');
const { setupCloudLookup } = require('../../lib/pairCloudLookup');
const net                       = require('net');
const { detectProtocolVersion } = require('../../lib/autoDetect');
const { scanNetwork }           = require('../../lib/networkScan');

class CurtainMotorDriver extends Homey.Driver {
  async onInit() {
    this.log('Curtain Motor driver initialized');

    // ── Triggers ─────────────────────────────────────────────────────────────
    this.homey.flow.getDeviceTriggerCard('curtain_opened');
    this.homey.flow.getDeviceTriggerCard('curtain_closed');
    this.homey.flow.getDeviceTriggerCard('curtain_position_changed');
    this.homey.flow.getDeviceTriggerCard('curtain_fault_triggered');
    this.homey.flow.getDeviceTriggerCard('curtain_device_connected');
    this.homey.flow.getDeviceTriggerCard('curtain_device_disconnected');
    this.homey.flow.getDeviceTriggerCard('curtain_dp_changed');

    // ── Conditions ───────────────────────────────────────────────────────────
    this.homey.flow.getConditionCard('curtain_is_open')
      .registerRunListener(async (args) =>
        (args.device.getCapabilityValue('windowcoverings_set') ?? 0) > 0.5
      );

    this.homey.flow.getConditionCard('curtain_is_closed')
      .registerRunListener(async (args) =>
        (args.device.getCapabilityValue('windowcoverings_set') ?? 0) <= 0
      );

    this.homey.flow.getConditionCard('curtain_is_moving')
      .registerRunListener(async (args) => {
        const state = args.device.getCapabilityValue('windowcoverings_state');
        return state === 'up' || state === 'down';
      });

    this.homey.flow.getConditionCard('curtain_device_is_connected')
      .registerRunListener(async (args) => args.device._conn?.connected === true);

    // ── Actions ──────────────────────────────────────────────────────────────
    this.homey.flow.getActionCard('curtain_open')
      .registerRunListener(async (args) =>
        args.device.triggerCapabilityListener('windowcoverings_state', 'up')
      );

    this.homey.flow.getActionCard('curtain_close')
      .registerRunListener(async (args) =>
        args.device.triggerCapabilityListener('windowcoverings_state', 'down')
      );

    this.homey.flow.getActionCard('curtain_stop')
      .registerRunListener(async (args) =>
        args.device.triggerCapabilityListener('windowcoverings_state', 'idle')
      );

    // Set position: flow arg position = 0–100 %, converted to 0.0–1.0 for Homey
    this.homey.flow.getActionCard('curtain_set_position')
      .registerRunListener(async (args) =>
        args.device.triggerCapabilityListener('windowcoverings_set', args.position / 100)
      );

    // Move to the pre-configured favourite position (Zemismart v2 DP 19 position_best).
    // Sends the stored dp_position_best DP value (0–100) to trigger the motor.
    this.homey.flow.getActionCard('curtain_goto_favourite')
      .registerRunListener(async (args) => {
        const dp = args.device.getSetting('dp_position_best');
        if (!dp || dp === 0) throw new Error('Favourite Position DP not configured (set dp_position_best in device settings)');
        const pos = args.device.getSetting('position_best') ?? 50;
        return args.device._set(dp, Math.round(pos));
      });

    this.homey.flow.getActionCard('curtain_force_reconnect')
      .registerRunListener(async (args) => args.device.forceReconnect());

    this.homey.flow.getActionCard('curtain_refresh_device')
      .registerRunListener(async (args) => args.device.pollNow());
  }

  // ── Pairing ──────────────────────────────────────────────────────────────────

  async onPair(session) {
    setupCloudLookup(session, this.homey);
    let pendingDevice = null;
    let pendingRawDps = {};

    session.setHandler('scan_network', async () => scanNetwork(this.homey));

    session.setHandler('credentials', async (data) => {
      const { ip, deviceId, localKey, version } = data;
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
          await new Promise((resolve) => setTimeout(resolve, 2000));
          if (Object.keys(tmpDps).length === 0) {
            try { device.refresh(); } catch (_) {}
            await new Promise((resolve) => setTimeout(resolve, 2000));
          }
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
        name: this.homey.__('device.defaultName.curtain_motor'),
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

  // ── Auto-detect DPs from raw DPS snapshot ────────────────────────────────────

  _detectDps(dps) {
    const dpsMap    = Object.fromEntries(Object.entries(dps).map(([k, v]) => [parseInt(k), v]));
    const stringDps = Object.entries(dpsMap)
      .filter(([, v]) => typeof v === 'string')
      .map(([k, v]) => ({ dp: parseInt(k), val: String(v).toLowerCase() }));

    // ── Control DP (enum open/stop/close) ────────────────────────────────────
    const CONTROL_VALS = new Set(['open', 'stop', 'close']);
    const ctrlEntry   = stringDps.find((d) => CONTROL_VALS.has(d.val));
    const dp_control  = ctrlEntry?.dp ?? 1;

    // ── Position DP (integer 0–100, not the control DP) ──────────────────────
    const POSITION_CANDIDATES = [2, 3, 9, 102];
    const dp_percent_control  = POSITION_CANDIDATES
      .find((d) => d in dpsMap && typeof dpsMap[d] === 'number' && d !== dp_control)
      ?? 2;

    // ── Work state DP (enum opening/closing) ─────────────────────────────────
    const WORK_VALS    = new Set(['opening', 'closing']);
    const workEntry    = stringDps.find((d) => WORK_VALS.has(d.val));
    const dp_work_state = workEntry?.dp ?? 0;

    // ── Fault DP (bitmap, typically DP 10 or 12) ─────────────────────────────
    const FAULT_CANDIDATES = [10, 12, 9, 13, 15];
    const dp_fault = FAULT_CANDIDATES
      .find((d) => d in dpsMap && typeof dpsMap[d] === 'number'
            && d !== dp_control && d !== dp_percent_control)
      ?? 0;

    const detected = { dp_control, dp_percent_control, dp_work_state, dp_fault };
    this.log('Detected DPs:', detected);
    return detected;
  }

  async onPairListDevices() { return []; }
}

module.exports = CurtainMotorDriver;
