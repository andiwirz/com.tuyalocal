'use strict';

const Homey                     = require('homey');
const TuyAPI                    = require('tuyapi');
const { setupCloudLookup } = require('../../lib/pairCloudLookup');
const net                       = require('net');
const { detectProtocolVersion } = require('../../lib/autoDetect');
const { scanNetwork }           = require('../../lib/networkScan');
const { capitalize }            = require('../../lib/utils');

// ── Mode strings recognised during auto-detect ────────────────────────────────
// Covers common naming across 15+ pool/water heat pump models.
const MODE_VALUES = new Set([
  'heat', 'cool', 'auto', 'warm', 'smart', 'cold',
  'heating', 'cooling', 'hot', 'make_cold', 'make_hot',
  'auto_dhw', 'wth', 'heat_cool',
]);

class HeatPumpDriver extends Homey.Driver {
  async onInit() {
    this.log('Heat Pump driver initialized');

    // ── Triggers ─────────────────────────────────────────────────────────────
    this.homey.flow.getDeviceTriggerCard('heat_pump_mode_changed');
    this.homey.flow.getDeviceTriggerCard('heat_pump_fault_triggered');
    this.homey.flow.getDeviceTriggerCard('heat_pump_device_connected');
    this.homey.flow.getDeviceTriggerCard('heat_pump_device_disconnected');
    this.homey.flow.getDeviceTriggerCard('heat_pump_dp_changed');

    // ── Conditions ───────────────────────────────────────────────────────────
    this.homey.flow.getConditionCard('heat_pump_is_on')
      .registerRunListener(async (args) =>
        args.device.getCapabilityValue('onoff') === true
      );

    this.homey.flow.getConditionCard('heat_pump_fault_is_active')
      .registerRunListener(async (args) =>
        args.device.getCapabilityValue('alarm_generic') === true
      );

    this.homey.flow.getConditionCard('heat_pump_device_is_connected')
      .registerRunListener(async (args) => args.device._conn?.connected === true);

    // ── Actions ──────────────────────────────────────────────────────────────
    this.homey.flow.getActionCard('heat_pump_set_mode')
      .registerArgumentAutocompleteListener('mode', async (query, args) => {
        const values = (args.device.getSetting('mode_values') || 'heat,cool,auto')
          .split(',').map((s) => s.trim()).filter(Boolean);
        const q = query.toLowerCase();
        return values
          .filter((v) => v.toLowerCase().includes(q))
          .map((v) => ({ name: capitalize(v), id: v }));
      })
      .registerRunListener(async (args) => {
        await args.device.setCapabilityValue('heat_pump_mode', args.mode.id);
        return args.device.triggerCapabilityListener('heat_pump_mode', args.mode.id);
      });

    this.homey.flow.getActionCard('heat_pump_set_preset')
      .registerArgumentAutocompleteListener('preset', async (query, args) => {
        const values = (args.device.getSetting('preset_values') || 'sleep,comfort,boost')
          .split(',').map((s) => s.trim()).filter(Boolean);
        const q = query.toLowerCase();
        return values
          .filter((v) => v.toLowerCase().includes(q))
          .map((v) => ({ name: capitalize(v), id: v }));
      })
      .registerRunListener(async (args) => {
        await args.device.setCapabilityValue('heat_pump_preset', args.preset.id);
        return args.device.triggerCapabilityListener('heat_pump_preset', args.preset.id);
      });

    this.homey.flow.getActionCard('heat_pump_force_reconnect')
      .registerRunListener(async (args) => args.device.forceReconnect());

    this.homey.flow.getActionCard('heat_pump_refresh_device')
      .registerRunListener(async (args) => args.device.pollNow());
  }

  // ── Pairing ──────────────────────────────────────────────────────────────────

  async onPair(session) {
    setupCloudLookup(session, this.homey, this);
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
        name: this.homey.__('device.defaultName.heat_pump'),
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

  // ── Auto-detect DPs ──────────────────────────────────────────────────────────

  _detectDps(dps) {
    const dpsMap    = Object.fromEntries(Object.entries(dps).map(([k, v]) => [parseInt(k), v]));
    const boolDps   = Object.entries(dpsMap)
      .filter(([, v]) => typeof v === 'boolean')
      .map(([k]) => parseInt(k));
    const intDps    = Object.entries(dpsMap)
      .filter(([, v]) => typeof v === 'number')
      .map(([k, v]) => ({ dp: parseInt(k), val: v }));
    const stringDps = Object.entries(dpsMap)
      .filter(([, v]) => typeof v === 'string')
      .map(([k, v]) => ({ dp: parseInt(k), val: String(v).toLowerCase() }));

    // ── On/Off ────────────────────────────────────────────────────────────────
    // DP 1 bool (most devices) → DP 101 bool (Waterco) → first bool DP
    const dp_onoff = (1 in dpsMap && typeof dpsMap[1] === 'boolean') ? 1
      : (101 in dpsMap && typeof dpsMap[101] === 'boolean') ? 101
      : (boolDps[0] ?? 1);

    // ── Target temperature ────────────────────────────────────────────────────
    // Preferred candidates in order — first integer DP found wins.
    // Phalén: 106 · Waterco: 104 · Most others: 2 · ITS/BWT: 4
    const TEMP_SET_ORDER = [2, 4, 106, 104, 110, 111, 3];
    const dp_target_temp = TEMP_SET_ORDER
      .find((d) => d in dpsMap && typeof dpsMap[d] === 'number')
      ?? 2;

    // ── Current temperature (read-only) ──────────────────────────────────────
    // Phalén: 102 · Most: 3 · Aquastrong: 21 · Madimack: 16
    const TEMP_CUR_ORDER = [3, 102, 21, 16, 108, 101, 111, 112];
    const dp_current_temp = TEMP_CUR_ORDER
      .find((d) => d in dpsMap && typeof dpsMap[d] === 'number' && d !== dp_target_temp)
      ?? 0;   // 0 = disabled; some devices don't expose current temp

    // ── Operating mode ────────────────────────────────────────────────────────
    // String DP whose current value is a recognised mode keyword.
    const modeEntry = stringDps.find((d) => MODE_VALUES.has(d.val));
    const dp_mode   = modeEntry?.dp ?? 0;

    // ── Preset ────────────────────────────────────────────────────────────────
    // Bool DP whose value is not used for on/off or temp_unit.
    // Common temp-unit DPs: 103, 6, 13, 10, 19, 21.
    const TEMP_UNIT_DPS = new Set([103, 6, 13, 10, 19, 21]);
    const dp_preset = boolDps.find((d) =>
      d !== dp_onoff && !TEMP_UNIT_DPS.has(d)
    ) ?? 0;

    // ── Fault alarm ───────────────────────────────────────────────────────────
    // Bitfields arrive as integers. Check a known list of fault DP positions.
    const FAULT_DP_ORDER = [9, 13, 15, 21, 22, 6, 14, 31, 45, 115, 116, 107, 20, 101];
    const dp_fault = FAULT_DP_ORDER
      .find((d) => d in dpsMap && d !== dp_target_temp && d !== dp_current_temp)
      ?? 0;

    // ── Power level % ─────────────────────────────────────────────────────────
    // Common: Phalén DP 104, Madimack DP 20, Waterco DP 109.
    const POWER_DP_ORDER = [104, 109, 20];
    const dp_power_level = POWER_DP_ORDER
      .find((d) => d in dpsMap && typeof dpsMap[d] === 'number'
            && d !== dp_target_temp && d !== dp_current_temp)
      ?? 0;

    // ── Temperature divisor heuristic ─────────────────────────────────────────
    // If the target temperature raw value looks like it's ×10 (e.g. 350 for 35 °C),
    // set temp_divisor = 10 automatically.
    const rawTarget = dpsMap[dp_target_temp];
    const temp_divisor = (typeof rawTarget === 'number' && rawTarget > 100 && rawTarget < 1200) ? 10 : 1;

    // ── Mode values string ────────────────────────────────────────────────────
    // Build from all string DPs with mode-like values if detected.
    let mode_values = 'heat,cool,auto';  // safe default
    if (dp_mode > 0) {
      // Collect all distinct string values on the detected mode DP — we only have
      // the current snapshot so this is just one value; keep the default list
      // and let the user refine in settings.
      const val = dpsMap[dp_mode];
      if (val && !['heat', 'cool', 'auto'].includes(String(val).toLowerCase())) {
        // Device uses non-standard names; put the detected value first so it's visible
        mode_values = `${String(val).toLowerCase()},heat,cool,auto`;
      }
    }

    const detected = {
      dp_onoff, dp_target_temp, dp_current_temp,
      dp_mode, dp_preset, dp_fault, dp_power_level,
      temp_divisor, mode_values,
    };
    this.log('Detected DPs:', detected);
    return detected;
  }

  async onPairListDevices() { return []; }
}

module.exports = HeatPumpDriver;
