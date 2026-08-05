'use strict';

const Homey                     = require('homey');
const TuyAPI                    = require('tuyapi');
const { setupCloudLookup }      = require('../../lib/pairCloudLookup');
const { detectProtocolVersion } = require('../../lib/autoDetect');
const { scanNetwork }           = require('../../lib/networkScan');
const { detectViaCloud }        = require('../../lib/dpCodeMap');

// Maps this driver's settings keys to the Tuya cloud "code" names for the
// qccdz (EV charger) category. See lib/dpCodeMap.js.
const CLOUD_CODE_MAP = {
  dp_switch:           ['switch'],
  dp_work_state:       ['work_state'],
  dp_charge_current:   ['charge_cur_set'],
  dp_phase_a:          ['phase_a', 'phase_1'],
  dp_phase_b:          ['phase_b', 'phase_2'],
  dp_phase_c:          ['phase_c', 'phase_3'],
  dp_power_total:      ['power_total', 'cur_power'],
  dp_energy_total:     ['forward_energy_total'],
  dp_session_energy:   ['charge_energy_once'],
  dp_fault:            ['fault'],
  dp_connection_state: ['connection_state'],
  dp_work_mode:        ['work_mode'],
  dp_temperature:      ['temp_current'],
  dp_timer_on:         ['timer_on'],
  dp_live_updates:     ['online_state'],
  dp_clear_energy:     ['clear_energy', 'energy_clear'],
};

const WORK_STATES = [
  'charger_free', 'charger_insert', 'charger_free_fault', 'charger_wait',
  'charger_charging', 'charger_pause', 'charger_end', 'charger_fault',
];

class EvChargerDriver extends Homey.Driver {
  async onInit() {
    this.log('EV Charger driver initialized');

    // ── Trigger run-listeners ───────────────────────────────────────────────
    this.homey.flow.getDeviceTriggerCard('ev_state_changed')
      .registerRunListener(async () => true); // always fire; tokens carry the state

    // ── Conditions ──────────────────────────────────────────────────────────
    this.homey.flow.getConditionCard('ev_device_is_connected')
      .registerRunListener(async (args) => args.device._conn?.connected === true);

    this.homey.flow.getConditionCard('ev_is_charging')
      .registerRunListener(async (args) =>
        args.device.getCapabilityValue('ev_charger_state') === 'charger_charging'
      );

    this.homey.flow.getConditionCard('ev_state_is')
      .registerRunListener(async (args) =>
        args.device.getCapabilityValue('ev_charger_state') === args.state
      );

    // ── Actions ─────────────────────────────────────────────────────────────
    this.homey.flow.getActionCard('ev_set_current')
      .registerRunListener(async (args) => {
        if (!args.device.hasCapability('charge_current_limit')) return;
        const min  = args.device.getSetting('current_min') ?? 6;
        const max  = args.device.getSetting('current_max') ?? 16;
        const amps = Math.round(Math.max(min, Math.min(max, args.current)));
        await args.device.setCapabilityValue('charge_current_limit', amps);
        return args.device.triggerCapabilityListener('charge_current_limit', amps);
      });

    this.homey.flow.getActionCard('ev_reset_energy')
      .registerRunListener(async (args) => args.device.resetEnergy());

    this.homey.flow.getActionCard('ev_force_reconnect')
      .registerRunListener(async (args) => args.device.forceReconnect());

    this.homey.flow.getActionCard('ev_refresh_device')
      .registerRunListener(async (args) => args.device.pollNow());
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

      let connected      = false;
      let detectedDps    = null;
      let actualVersion  = String(version);
      const collectedDps = {};
      let pairingDevice  = null;

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
        if (Object.keys(collectedDps).length > 0) {
          detectedDps = this._detectDps(collectedDps);
          this.log('Locally detected DPs (value heuristic):', JSON.stringify(detectedDps));

          const cloudDps = await detectViaCloud(this.homey, deviceId, CLOUD_CODE_MAP, (m) => this.log(m));
          if (Object.keys(cloudDps).length > 0) {
            Object.assign(detectedDps, cloudDps);
            this.log('Final detected DPs (cloud-refined):', JSON.stringify(detectedDps));
          }
        }
      } catch (err) {
        connected = false;
        try { if (pairingDevice) pairingDevice.disconnect(); } catch (_e) {}
        this.log('Connection test failed:', err.message);
      }

      pendingDevice = {
        name: this.homey.__('device.defaultName.ev_charger'),
        data: { id: deviceId },
        settings: {
          ip, device_id: deviceId, local_key: localKey, version: actualVersion,
          ...(detectedDps || {}),
        },
      };
      pendingRawDps = collectedDps;
      return { connected, detectedVersion: actualVersion, detectedDps };
    });

    session.setHandler('list_devices', async () => pendingDevice ? [pendingDevice] : []);
    session.setHandler('raw_dps',      async () => pendingRawDps || {});
    session.setHandler('set_device_name', async (name) => {
      if (pendingDevice && name?.trim()) pendingDevice.name = name.trim();
    });
  }

  /**
   * Auto-detect DP mapping from a raw DPS snapshot.
   *
   * Defaults follow the qccdz layout shared by all 37 EV-charger configs in
   * make-all/tuya-local. Optional DPs that only some models expose (phases B/C,
   * total power, lifetime counter, live-updates switch) start at 0 and are
   * enabled only when actually observed in the snapshot, so single-phase units
   * don't end up with dead phase-B/C tiles.
   */
  _detectDps(dps) {
    const result = {
      dp_switch:           18,
      dp_work_state:       3,
      dp_charge_current:   4,
      dp_phase_a:          6,
      dp_phase_b:          0,
      dp_phase_c:          0,
      dp_power_total:      0,
      dp_energy_total:     0,
      dp_session_energy:   25,
      dp_fault:            10,
      dp_connection_state: 13,
      dp_work_mode:        0,
      dp_temperature:      0,
      dp_timer_on:         0,
      dp_live_updates:     0,
      dp_clear_energy:     0,
      current_min:         6,
      current_max:         16,
    };

    const present = (dp) => Object.prototype.hasOwnProperty.call(dps, String(dp));

    for (const [dpStr, val] of Object.entries(dps)) {
      const dp = parseInt(dpStr, 10);

      if (typeof val === 'string') {
        // These three enums are unmistakable — match them wherever they sit.
        if (WORK_STATES.includes(val))       { result.dp_work_state = dp;       continue; }
        if (val.startsWith('controlpi_'))    { result.dp_connection_state = dp; continue; }
        if (val.startsWith('charge_'))       { result.dp_work_mode = dp;        continue; }
        if (val === 'online' || val === 'offline') { result.dp_live_updates = dp; continue; }
      }
    }

    // Optional DPs at their standard positions — enable only if the charger
    // actually reported them.
    if (present(7))  result.dp_phase_b      = 7;
    if (present(8))  result.dp_phase_c      = 8;
    if (present(9))  result.dp_power_total  = 9;   // total power, W
    else if (present(5)) result.dp_power_total = 5; // single-phase power, W
    if (present(24)) result.dp_temperature  = 24;
    if (present(28)) result.dp_timer_on     = 28;
    if (present(16)) result.dp_clear_energy = 16;

    // Lifetime counter: trust it only when the charger reports a non-zero value.
    // Several models (notably Vevor portables) expose DP 1 but never update it
    // over the local connection — leaving it at 0 makes the driver accumulate
    // from session energy (DP 25) instead, which is reliable everywhere.
    if (present(1) && Number(dps['1']) > 0) result.dp_energy_total = 1;

    return result;
  }

  async onPairListDevices() { return []; }
}

module.exports = EvChargerDriver;
