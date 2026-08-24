'use strict';

const Homey                     = require('homey');
const TuyAPI                    = require('../../lib/SafeTuyAPI');
const { setupCloudLookup }      = require('../../lib/pairCloudLookup');
const { describeConnectFailure } = require('../../lib/connectFailure');
const { detectProtocolVersion } = require('../../lib/autoDetect');
const { scanNetwork }           = require('../../lib/networkScan');
const { detectViaCloud, guessedDefaults } = require('../../lib/dpCodeMap');

// Defaults are the classic Tuya metering block, which is what the reported meter
// uses and what the majority of single-phase devices in the tuya-local catalogue
// use as well. Everything beyond it differs enough between models that guessing
// would do more harm than good — Cloud Lookup resolves the rest by name.
const DEFAULT_DPS = {
  dp_switch:       0,   // off: a clamp meter has no switch, and a dead toggle is worse than none
  dp_energy:      17,
  dp_current:     18,
  dp_power:       19,
  dp_voltage:     20,
  dp_fault:       26,
  dp_power_factor: 0,
};

// The manufacturer's own names, which is the only evidence that actually identifies
// one of these data points: the numbers move between models — power sits on 19, 105,
// 103 or 9 depending on the meter — while the codes do not.
const CLOUD_CODE_MAP = {
  dp_switch:       ['switch', 'switch_1', 'switch_prepayment'],
  dp_power:        ['cur_power', 'power_total', 'active_power', 'power_a'],
  dp_current:      ['cur_current', 'current_total', 'current_a'],
  dp_voltage:      ['cur_voltage', 'voltage_a'],
  dp_energy:       ['add_ele', 'energy_forward', 'forward_energy_total',
                    'total_forward_energy', 'energy'],
  dp_power_factor: ['power_factor', 'powerfactor_a'],
  dp_fault:        ['fault', 'alarm_set_1'],
};

class EnergyMeterDriver extends Homey.Driver {
  async onInit() {
    this.log('Energy meter driver initialized');

    this.homey.flow.getConditionCard('meter_device_is_connected')
      .registerRunListener(async (args) => args.device._conn?.connected === true);

    this.homey.flow.getConditionCard('meter_power_above')
      .registerRunListener(async (args) => {
        const w = args.device.getCapabilityValue('measure_power');
        return typeof w === 'number' && w > Number(args.watts);
      });

    this.homey.flow.getConditionCard('meter_current_above')
      .registerRunListener(async (args) => {
        const a = args.device.getCapabilityValue('measure_current');
        return typeof a === 'number' && a > Number(args.amps);
      });

    this.homey.flow.getConditionCard('meter_fault_is_active')
      .registerRunListener(async (args) =>
        args.device.getCapabilityValue('alarm_generic') === true);

    this.homey.flow.getActionCard('meter_force_reconnect')
      .registerRunListener(async (args) => args.device.forceReconnect());

    this.homey.flow.getActionCard('meter_refresh_device')
      .registerRunListener(async (args) => args.device.pollNow());
  }

  getCloudMaps() {
    return { codeMap: CLOUD_CODE_MAP };
  }

  /**
   * Which scaling setting belongs to which data point, for the Fix It check that
   * reads the divisor Tuya declares rather than leaving someone to work it out from
   * "the reading is ten times too high". See findScaleMismatch() in app.js.
   *
   * The declared divisor beats any assumption, and these span a wide range: energy is
   * commonly hundredths of a kWh but sometimes thousandths, power tenths of a watt or
   * thousandths.
   *
   * Written out here rather than referring to a constant, which is the house form —
   * two tools read this method's body directly, one by blanking it before scanning for
   * value assignments and one by evaluating it, and neither can follow a name out of
   * scope.
   */
  getScaleMaps() {
    return {
      dp_power:   'power_scale',
      dp_voltage: 'voltage_scale',
      dp_current: 'current_scale',
      dp_energy:  'kwh_scale',
    };
  }

  /**
   * What the live values alone can tell us.
   *
   * Deliberately thin. A meter reports numbers and almost nothing else, and one
   * number looks much like another: a voltage of 2376 and an energy total of 2376
   * are the same integer. Only two shapes are distinctive enough to act on — mains
   * voltage, which sits in a narrow band, and the conventional block this driver
   * defaults to. Everything else is left to Cloud Lookup, which knows the names.
   */
  _detectDps(dps) {
    const result = {};

    const bools = Object.entries(dps)
      .filter(([, v]) => typeof v === 'boolean')
      .map(([k]) => parseInt(k, 10))
      .sort((a, b) => a - b);
    // A breaker's own switch. A meter without one keeps dp_switch at 0 and shows no
    // toggle, which is the whole reason this driver exists apart from the plug.
    if (bools.length > 0) result.dp_switch = bools.includes(1) ? 1 : bools[0];

    // The conventional block, by number and before anything else. Its four data points
    // are the one arrangement that really is conventional, and here the number is the
    // stronger evidence: on this very block the current reads 2491 — milliamps — which
    // sits squarely inside the band that would otherwise identify a mains voltage. The
    // first draft of this method read the reported meter's current as its voltage and
    // then found no current at all.
    const CONVENTIONAL = {
      17: 'dp_energy', 18: 'dp_current', 19: 'dp_power', 20: 'dp_voltage',
    };
    for (const [dpStr, val] of Object.entries(dps)) {
      const dp = parseInt(dpStr, 10);
      if (typeof val !== 'number') continue;
      if (CONVENTIONAL[dp]) result[CONVENTIONAL[dp]] = dp;
      else if (dp === 26 && val === 0) result.dp_fault = dp;
    }

    // Only for a meter that does not use that block: mains voltage is the one quantity
    // a value alone can identify, because 100–280 V covers every grid this runs on and
    // nothing else idles there. Data points already spoken for are skipped.
    if (!result.dp_voltage) {
      const taken = new Set(Object.values(result));
      for (const [dpStr, val] of Object.entries(dps)) {
        const dp = parseInt(dpStr, 10);
        if (typeof val !== 'number' || taken.has(dp)) continue;
        if (val >= 1000 && val <= 2800) { result.dp_voltage = dp; break; }
      }
    }
    return result;
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
      if (localKey.length !== 16 && localKey.length !== 32) {
        throw new Error(this.homey.__('pair.credentials.invalidKey'));
      }

      let connected     = false;
      let failureError  = '';
      let actualVersion = String(version);
      const collectedDps = {};
      let pairingDevice  = null;

      try {
        let rawDps;
        if (version === 'auto') {
          const result = await detectProtocolVersion({ ip, deviceId, localKey });
          actualVersion = result.version;
          rawDps        = result.dps;
        } else {
          const device = new TuyAPI({
            id: deviceId, key: localKey, ip, version: actualVersion, issueGetOnConnect: true,
          });
          pairingDevice = device;
          device.on('error', () => {});
          const tmpDps = {};
          device.on('data',       (p) => { if (p?.dps) Object.assign(tmpDps, p.dps); });
          device.on('dp-refresh', (p) => { if (p?.dps) Object.assign(tmpDps, p.dps); });
          await Promise.race([
            device.connect(),
            new Promise((_, rej) => setTimeout(() => rej(new Error('Connection timed out')), 8000)),
          ]);
          await new Promise((resolve) => setTimeout(resolve, 2000));
          try { device.refresh(); } catch (_) {}
          await new Promise((resolve) => setTimeout(resolve, 2000));
          device.disconnect();
          pairingDevice = null;
          rawDps = tmpDps;
        }
        Object.assign(collectedDps, rawDps);
        connected = true;
      } catch (err) {
        connected = false;
        failureError = err.message;
        try { if (pairingDevice) pairingDevice.disconnect(); } catch (_e) {}
        this.log('Connection test failed:', err.message);
      }

      const detected = { ...DEFAULT_DPS, ...this._detectDps(collectedDps) };
      const cloudDps = await detectViaCloud(this.homey, deviceId, CLOUD_CODE_MAP,
        (m) => this.log(m), null, guessedDefaults(detected, collectedDps));
      Object.assign(detected, cloudDps || {});

      // Say so when this device is one the numbers cannot identify.
      //
      // On a meter the local heuristic can only go so far, and that is measured rather
      // than assumed: across the 42 single-data-point meter definitions in the
      // tuya-local catalogue it resolves six. A table listing every number ever seen
      // for each quantity would reach twelve — and would assign the wrong quantity on
      // much of the rest, because the same number means different things on different
      // models: data point 103 is the power on seven of them, the voltage on three and
      // the current on two; 101 is the voltage on six and the current on one. A
      // confident wrong reading on a meter is worse than none. Only the manufacturer's
      // code names are consistent, which is what Cloud Lookup supplies.
      //
      // So a meter paired without Cloud Lookup, whose data points are not the
      // conventional block, ends up with no readings at all. Better to say that here
      // than to hand over a silent device.
      const reads = ['dp_power', 'dp_voltage', 'dp_current']
        .filter((k) => Number(detected[k]) > 0
          && Object.prototype.hasOwnProperty.call(collectedDps, String(detected[k])));
      if (reads.length === 0) {
        this.log('No measurement data point could be identified on this meter. '
          + 'A meter reports numbers and little else, so the data point numbers alone '
          + 'cannot say which is which — set up Cloud Lookup (Settings → Cloud Lookup) '
          + 'and pair again, or read the numbers off the DP Debug tab and enter them in '
          + 'the device settings by hand.');
      } else if (Object.keys(cloudDps || {}).length === 0 && reads.length < 3) {
        this.log(`Only ${reads.length} of the three measurements were identified `
          + '(power, voltage, current). Cloud Lookup resolves the rest by name; without '
          + 'it the remaining data points have to be entered by hand.');
      }

      pendingDevice = {
        name: this.homey.__('device.defaultName.energy_meter'),
        data: { id: deviceId },
        settings: {
          ip,
          device_id:             deviceId,
          local_key:             localKey,
          version:               actualVersion,
          polling_interval:      60,
          offline_grace_seconds: 60,
          ...detected,
        },
      };
      pendingRawDps = collectedDps;

      const failureHint = connected
        ? ''
        : await describeConnectFailure({ ip, error: failureError });
      if (failureHint) this.log(failureHint);

      return { connected, detectedVersion: actualVersion, failureHint };
    });

    session.setHandler('list_devices', async () => pendingDevice ? [pendingDevice] : []);
    session.setHandler('raw_dps',      async () => pendingRawDps || {});
    session.setHandler('set_device_name', async (name) => {
      if (pendingDevice && name?.trim()) pendingDevice.name = name.trim();
    });
  }

  async onPairListDevices() { return []; }
}

module.exports = EnergyMeterDriver;
