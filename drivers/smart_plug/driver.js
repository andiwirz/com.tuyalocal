'use strict';

const Homey                     = require('homey');
const TuyAPI                    = require('../../lib/SafeTuyAPI');
const { setupCloudLookup } = require('../../lib/pairCloudLookup');
const { describeConnectFailure } = require('../../lib/connectFailure');
const { detectProtocolVersion } = require('../../lib/autoDetect');
const { scanNetwork }           = require('../../lib/networkScan');
const { detectViaCloud, guessedDefaults, shiftedEnergyBlock } = require('../../lib/dpCodeMap');

// Maps this driver's settings keys to the Tuya cloud "code" names that
// commonly represent them. See lib/dpCodeMap.js. dp_power_factor is omitted
// — no reliably standardised code name across manufacturers.
const CLOUD_CODE_MAP = {
  dp_switch:       ['switch_1', 'switch'],
  dp_power:        ['cur_power'],
  dp_current:      ['cur_current'],
  dp_voltage:      ['cur_voltage'],
  dp_energy:       ['add_ele', 'energy'],
  dp_relay_status: ['relay_status'],
  dp_countdown:    ['countdown_1', 'countdown'],
  dp_fault:        ['fault'],
};

class SmartPlugDriver extends Homey.Driver {
  async onInit() {
    this.log('Smart Plug driver initialized');

    // ── Conditions ──────────────────────────────────────────────────────────
    this.homey.flow.getConditionCard('plug_device_is_connected')
      .registerRunListener(async (args) =>
        args.device._conn?.connected === true
      );

    this.homey.flow.getConditionCard('plug_alarm_active')
      .registerRunListener(async (args) =>
        args.device.getCapabilityValue('alarm_generic') === true
      );

    // ── Trigger run-listeners (threshold filtering) ──────────────────────────
    this.homey.flow.getDeviceTriggerCard('plug_power_above')
      .registerRunListener(async (args, state) =>
        state.prevPower <= args.power && state.power > args.power
      );

    this.homey.flow.getDeviceTriggerCard('plug_power_below')
      .registerRunListener(async (args, state) =>
        state.prevPower >= args.power && state.power < args.power
      );

    // ── Conditions ──────────────────────────────────────────────────────────
    this.homey.flow.getConditionCard('plug_power_is_above')
      .registerRunListener(async (args) =>
        (args.device.getCapabilityValue('measure_power') ?? 0) > args.power
      );

    // ── Actions ─────────────────────────────────────────────────────────────
    this.homey.flow.getActionCard('plug_force_reconnect')
      .registerRunListener(async (args) => {
        return args.device.forceReconnect();
      });

    this.homey.flow.getActionCard('plug_refresh_device')
      .registerRunListener(async (args) => {
        return args.device.pollNow();
      });

    this.homey.flow.getActionCard('plug_set_countdown')
      .registerRunListener(async (args) => {
        return args.device.setCountdown(args.seconds);
      });

    this.homey.flow.getActionCard('plug_reset_energy')
      .registerRunListener(async (args) => {
        return args.device.resetEnergy();
      });
  }

  // Which scaling setting belongs to which data point, for the Fix It check that reads
  // the divisor Tuya declares for the DP instead of leaving the user to work it out
  // from "the value is ten times too high". See findScaleMismatch() in app.js.
  getScaleMaps() {
    return {
      dp_voltage: 'voltage_scale',
      dp_current: 'current_scale',
      dp_energy:  'kwh_scale',
      dp_power:   'power_scale',
    };
  }

  async onPair(session) {
    setupCloudLookup(session, this.homey, this);
    let pendingDevice = null;
    let pendingRawDps = {};

    session.setHandler('scan_network', async () => scanNetwork(this.homey));

    session.setHandler('credentials', async (data) => {
      const { ip, deviceId, localKey, version } = data;

      // Validate inputs before attempting a connection
      const net = require('net');
      if (!net.isIPv4(ip)) {
        throw new Error(this.homey.__('pair.credentials.invalidIp'));
      }
      if (localKey.length !== 16 && localKey.length !== 32) {
        throw new Error(this.homey.__('pair.credentials.invalidKey'));
      }

      let connected      = false;
      let failureError = '';
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
          this.log(`Auto-detected protocol version: ${actualVersion}`);
        } else {
          const device = new TuyAPI({
            id: deviceId, key: localKey, ip,
            version: actualVersion,
            issueGetOnConnect: true,
          });
          pairingDevice = device;
          device.on('error', (err) => { this.log('Connection test error:', err.message); });
          const tmpDps = {};
          device.on('data', (payload) => {
            if (payload?.dps) Object.assign(tmpDps, payload.dps);
          });
          // Replies to a DP_REFRESH request arrive on a separate event; some devices
          // report the packed voltage/current/power DP only that way.
          device.on('dp-refresh', (payload) => {
            if (payload?.dps) Object.assign(tmpDps, payload.dps);
          });
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
          const cloudDps = await detectViaCloud(this.homey, deviceId, CLOUD_CODE_MAP, (m) => this.log(m), {}, guessedDefaults(detectedDps, collectedDps));
          if (Object.keys(cloudDps).length > 0) Object.assign(detectedDps, cloudDps);
          this.log('Detected DPs:', JSON.stringify(detectedDps));
        }
      } catch (err) {
        connected = false;
        failureError = err.message;
        try { if (pairingDevice) pairingDevice.disconnect(); } catch (_e) {}
        this.log('Connection test failed:', err.message);
      }

      pendingDevice = {
        name: this.homey.__('device.defaultName.smart_plug'),
        data: { id: deviceId },
        settings: {
          ip,
          device_id:        deviceId,
          local_key:        localKey,
          version:          actualVersion,
          power_scale:      '0.1',
          polling_interval: 30,
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

    session.setHandler('list_devices', async () => {
      return pendingDevice ? [pendingDevice] : [];
    });

    session.setHandler('raw_dps', async () => {
      return pendingRawDps || {};
    });

    // Called by list_devices.html when the user edits the device name
    session.setHandler('set_device_name', async (name) => {
      if (pendingDevice && name && name.trim()) {
        pendingDevice.name = name.trim();
      }
    });
  }

  // Auto-detect DP mapping from a raw DPS snapshot
  _detectDps(dps) {
    const result = {
      dp_switch:        1,
      dp_power:         19,
      dp_voltage:       20,
      dp_current:       18,
      dp_energy:        0,   // disabled by default — app computes kWh from power
      dp_fault:         0,   // disabled by default
      dp_relay_status:  38,  // DP 38 is the Tuya standard for relay power-on behavior
      dp_power_factor:  0,   // disabled by default
      dp_countdown:     0,   // disabled by default
    };

    // Die verschobene Belegung 20/21/22/23, bevor die Regeln nach Nummer greifen: dort
    // ist DP 21 der Strom, waehrend die Regel weiter unten ihn ausdruecklich meidet,
    // weil er auf den meisten Steckdosen "test_bit" heisst. Als Teil dieses Blocks ist
    // er es nicht - 13216 Milliampere sind kein Werksmerker. Siehe shiftedEnergyBlock.
    const verschoben = shiftedEnergyBlock(dps);
    if (verschoben) Object.assign(result, verschoben);

    // Collect all boolean DPs first, then prefer DP 1 — the Tuya spec
    // assigns on/off to DP 1 in the vast majority of devices.
    const boolDps = Object.entries(dps)
      .filter(([, v]) => typeof v === 'boolean')
      .map(([k]) => parseInt(k, 10));
    if (boolDps.length > 0) {
      result.dp_switch = boolDps.includes(1) ? 1 : boolDps[0];
    }

    for (const [dpStr, val] of Object.entries(dps)) {
      const dp = parseInt(dpStr, 10);
      // Was der verschobene Block schon vergeben hat, bleibt vergeben.
      if (verschoben && [20, 21, 22, 23].includes(dp)) continue;
      if (typeof val === 'boolean') {
        // Already handled above — skip
      } else if (typeof val === 'number') {
        // Countdown timer: DP 9, integer seconds (0 = inactive)
        if (dp === 9) result.dp_countdown = dp;
        // Voltage: raw value 1000–2800 (= 100–280 V × 0.1)
        else if (val >= 1000 && val <= 2800) result.dp_voltage = dp;
        // Energy counter (DP 17 by convention) — kept at 0 (disabled) because
        // most Tuya plugs send add_ele as a resetting delta that appears frozen
        // locally; the app computes kWh from power readings instead.
        // Current (typically 0 when off, DP 18 by convention)
        else if (dp === 18) result.dp_current = dp;
        // Power (typically 0 when off, DP 19 by convention)
        else if (dp === 19) result.dp_power = dp;
        // DP 21 is 'test_bit' on most power-monitoring plugs (factory QA flag, always 1).
        // Real power-factor DPs use a different code — do NOT auto-detect DP 21.
        // Fault bitmap (0 when no fault, typically DP 26)
        else if (dp === 26 && val === 0) result.dp_fault = dp;
      } else if (typeof val === 'string') {
        // Relay status enum
        if (['on', 'off', 'memory'].includes(val)) result.dp_relay_status = dp;
      }
    }
    return result;
  }

  // Fallback for older Homey versions
  async onPairListDevices() {
    return [];
  }
}

module.exports = SmartPlugDriver;
