'use strict';

const Homey                     = require('homey');
const TuyAPI                    = require('../../lib/SafeTuyAPI');
const { setupCloudLookup }      = require('../../lib/pairCloudLookup');
const { detectProtocolVersion } = require('../../lib/autoDetect');
const { scanNetwork }           = require('../../lib/networkScan');
const { detectViaCloud, guessedDefaults } = require('../../lib/dpCodeMap');

// Ultrasonic liquid level sensors report a percentage, a depth and a three-state
// level alarm. There is no local value heuristic here: a bare number carries no
// clue whether it is a percentage, a depth in millimetres or an installation
// height, and this driver has to distinguish six numeric DPs from one another.
// Guessing between them would produce exactly the class of wrong-but-plausible
// reading these drivers keep being reported for. The layout below matches the
// EPTTECH TLC2326P; CLOUD_CODE_MAP corrects it by name for other models, and the
// cloud specification switches off, by absence, whatever a device does not have.
const DEFAULT_DPS = {
  dp_state:           1,
  dp_depth:           2,
  dp_max_set:         7,
  dp_mini_set:        8,
  dp_upper_switch:   14,
  dp_lower_switch:   15,
  dp_install_height: 19,
  dp_depth_full:      21,
  dp_level_percent:  22,
};

// Verified against the manufacturer's own specification for the reported device.
const CLOUD_CODE_MAP = {
  dp_state:          ['liquid_state'],
  dp_depth:          ['liquid_depth'],
  dp_max_set:        ['max_set'],
  dp_mini_set:       ['mini_set'],
  dp_upper_switch:   ['upper_switch'],
  dp_lower_switch:   ['lower_switch'],
  dp_install_height: ['installation_height'],
  dp_depth_full:      ['liquid_depth_max'],
  dp_level_percent:  ['liquid_level_percent'],
};

// The three level states are an enum, and their tokens differ between models —
// the reported one uses normal/lower_alarm/upper_alarm. Reading the declared range
// is what lets the alarms be wired to the right tokens instead of to fixed strings.
const CLOUD_ENUM_VALUES_MAP = {
  dp_state: 'state_values',
};

class LevelSensorDriver extends Homey.Driver {
  async onInit() {
    this.log('Level sensor driver initialized');

    // ── Triggers ────────────────────────────────────────────────────────────
    this.homey.flow.getDeviceTriggerCard('level_sensor_state_changed')
      .registerRunListener(async () => true);

    // ── Conditions ──────────────────────────────────────────────────────────
    this.homey.flow.getConditionCard('level_sensor_device_is_connected')
      .registerRunListener(async (args) => args.device._conn?.connected === true);

    this.homey.flow.getConditionCard('level_sensor_state_is')
      .registerArgumentAutocompleteListener('state', async (query, args) => {
        const values = (args.device.getSetting('state_values') || 'normal,lower_alarm,upper_alarm')
          .split(',').map((s) => s.trim()).filter(Boolean);
        const q = String(query || '').toLowerCase();
        return values.filter((v) => v.toLowerCase().includes(q))
          .map((v) => ({ id: v, name: v.charAt(0).toUpperCase() + v.slice(1).replace(/_/g, ' ') }));
      })
      .registerRunListener(async (args) =>
        args.device.getCapabilityValue('liquid_state') === args.state.id);

    this.homey.flow.getConditionCard('level_sensor_level_above')
      .registerRunListener(async (args) => {
        const level = args.device.getCapabilityValue('liquid_level');
        return typeof level === 'number' && level > Number(args.level);
      });

    // ── Actions ─────────────────────────────────────────────────────────────
    // The thresholds and the two alarm switches are written, not read: the
    // reported device never sent DPs 14, 15 and 21 over the local connection, so
    // capabilities for them would sit empty forever. As flow actions they do the
    // one thing that is actually useful — change the value — without pretending
    // to display a state the device does not report.
    this.homey.flow.getActionCard('level_sensor_set_max_level')
      .registerRunListener(async (args) => args.device.setThreshold('dp_max_set', args.level));

    this.homey.flow.getActionCard('level_sensor_set_min_level')
      .registerRunListener(async (args) => args.device.setThreshold('dp_mini_set', args.level));

    this.homey.flow.getActionCard('level_sensor_set_alarm_enabled')
      .registerRunListener(async (args) => args.device.setAlarmEnabled(
        args.which === 'upper' ? 'dp_upper_switch' : 'dp_lower_switch',
        args.enabled === 'true',
      ));

    this.homey.flow.getActionCard('level_sensor_force_reconnect')
      .registerRunListener(async (args) => args.device.forceReconnect());

    this.homey.flow.getActionCard('level_sensor_refresh_device')
      .registerRunListener(async (args) => args.device.pollNow());
  }

  // Lets the settings page re-apply the manufacturer's declared token list to a
  // device that is already paired — see applyCloudValues() in app.js.
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
      if (localKey.length !== 16 && localKey.length !== 32) {
        throw new Error(this.homey.__('pair.credentials.invalidKey'));
      }

      let connected     = false;
      let actualVersion = String(version);
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
            id: deviceId, key: localKey, ip, version: actualVersion, issueGetOnConnect: true,
          });
          pairingDevice = device;
          device.on('error', (err) => { this.log('Connection test error:', err.message); });
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
        try { if (pairingDevice) pairingDevice.disconnect(); } catch (_e) {}
        this.log('Connection test failed:', err.message);
      }

      const cloudDps = await detectViaCloud(this.homey, deviceId, CLOUD_CODE_MAP, (m) => this.log(m),
        CLOUD_ENUM_VALUES_MAP, guessedDefaults(DEFAULT_DPS, collectedDps));

      pendingDevice = {
        name: this.homey.__('device.defaultName.level_sensor'),
        data: { id: deviceId },
        settings: {
          ip,
          device_id:             deviceId,
          local_key:             localKey,
          version:               actualVersion,
          polling_interval:      60,
          offline_grace_seconds: 60,
          ...DEFAULT_DPS,
          ...(cloudDps || {}),
        },
      };
      pendingRawDps = collectedDps;

      return { connected, detectedVersion: actualVersion };
    });

    session.setHandler('list_devices', async () => pendingDevice ? [pendingDevice] : []);
    session.setHandler('raw_dps',      async () => pendingRawDps || {});
    session.setHandler('set_device_name', async (name) => {
      if (pendingDevice && name?.trim()) pendingDevice.name = name.trim();
    });
  }

  async onPairListDevices() { return []; }
}

module.exports = LevelSensorDriver;
