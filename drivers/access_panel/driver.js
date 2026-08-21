'use strict';

const Homey                     = require('homey');
const TuyAPI                    = require('../../lib/SafeTuyAPI');
const { setupCloudLookup }      = require('../../lib/pairCloudLookup');
const { describeConnectFailure } = require('../../lib/connectFailure');
const { detectProtocolVersion } = require('../../lib/autoDetect');
const { scanNetwork }           = require('../../lib/networkScan');
const { detectViaCloud, guessedDefaults } = require('../../lib/dpCodeMap');

// WiFi face/fingerprint access panels, Tuya category "mk".
//
// Most of what these panels do is out of reach and will stay that way. Of the 37
// data points on the reported model, 25 are Raw: enrolling a face or a fingerprint,
// creating a temporary password, and — the one that matters most — reporting *who*
// just unlocked the door all live in those, in a binary format Tuya documents only
// under agreement. This driver covers the twelve that are not: lock and door state,
// the alarms, the doorbell press, and a handful of settings.
//
// No local value heuristic. Eight of the twelve are booleans sitting next to one
// another, and true or false says nothing about whether it means "door open",
// "tamper" or "motor engaged". On a lock, a boolean wired to the wrong meaning is
// considerably worse than a missing one.
const DEFAULT_DPS = {
  dp_doorbell_volume: 26,
  dp_hold_open:       28,
  dp_auto_lock:       30,
  dp_auto_lock_time:  31,
  dp_alarm_time:      34,
  dp_lock_state:      40,
  dp_doorbell:       101,
  dp_error_alarm:    102,
  dp_tamper_alarm:   103,
  dp_door_contact:   104,
  dp_door_alarm:     105,
};

// Verified against the specification and property list of the reported panel. The
// block from 101 upwards appears only in the property list, not in the published
// specification — which is precisely why matching is done by code name: the
// property list carries the DP number alongside the name, so those resolve too.
const CLOUD_CODE_MAP = {
  dp_doorbell_volume: ['doorbell_volume'],
  dp_hold_open:       ['normal_open_switch'],
  dp_auto_lock:       ['automatic_lock'],
  dp_auto_lock_time:  ['auto_lock_time'],
  dp_alarm_time:      ['alarm_time'],
  dp_lock_state:      ['lock_motor_state'],
  dp_doorbell:        ['door_bell', 'doorbell'],
  dp_error_alarm:     ['error_alarm'],
  dp_tamper_alarm:    ['anti_alarm', 'tamper_alarm'],
  dp_door_contact:    ['open_closedoor', 'door_state'],
  dp_door_alarm:      ['doorsensor_alarm'],
};

const CLOUD_ENUM_VALUES_MAP = {
  dp_doorbell_volume: 'volume_values',
};

class AccessPanelDriver extends Homey.Driver {
  async onInit() {
    this.log('Access panel driver initialized');

    for (const id of ['access_panel_doorbell_pressed', 'access_panel_lock_changed']) {
      this.homey.flow.getDeviceTriggerCard(id).registerRunListener(async () => true);
    }

    // The way in to everything this driver cannot decode. Twenty-five of this
    // panel's data points are an undocumented binary format, so the app cannot say
    // what an unlock record means — but it can hand the raw value over and let the
    // owner recognise it. Enrol a face, unlock the door once, read the value off
    // this trigger, and a comparison against it identifies that person from then on.
    //
    // The choices are the data points the panel has actually reported, rather than
    // a list of numbers to guess among, named where Cloud Lookup gave a name at
    // pairing. That map is only ever used for labels: the value written into the
    // flow is the number.
    this.homey.flow.getDeviceTriggerCard('access_panel_dp_value_changed')
      .registerArgumentAutocompleteListener('dp', async (query, args) => {
        const seen  = args.device.reportedDps();
        const codes = args.device.dpCodes();
        const q     = String(query || '').toLowerCase();
        return seen
          .map((dp) => ({
            id:   String(dp),
            name: codes[dp] ? `${dp} — ${codes[dp]}` : `DP ${dp}`,
          }))
          .filter((o) => o.name.toLowerCase().includes(q) || o.id === q);
      })
      .registerRunListener(async (args, state) => Number(args.dp?.id) === Number(state.dp));

    this.homey.flow.getConditionCard('access_panel_device_is_connected')
      .registerRunListener(async (args) => args.device._conn?.connected === true);

    this.homey.flow.getConditionCard('access_panel_is_locked')
      .registerRunListener(async (args) => args.device.getCapabilityValue('locked') === true);

    this.homey.flow.getConditionCard('access_panel_door_is_open')
      .registerRunListener(async (args) => args.device.getCapabilityValue('alarm_contact') === true);

    this.homey.flow.getActionCard('access_panel_set_hold_open')
      .registerRunListener(async (args) =>
        args.device.setBooleanDp('dp_hold_open', 'hold_open', args.enabled === 'true'));

    this.homey.flow.getActionCard('access_panel_set_auto_lock')
      .registerRunListener(async (args) =>
        args.device.setBooleanDp('dp_auto_lock', 'auto_lock', args.enabled === 'true'));

    this.homey.flow.getActionCard('access_panel_set_auto_lock_time')
      .registerRunListener(async (args) =>
        args.device.setNumberDp('dp_auto_lock_time', args.seconds, 0, 100));

    this.homey.flow.getActionCard('access_panel_set_alarm_time')
      .registerRunListener(async (args) =>
        args.device.setNumberDp('dp_alarm_time', args.seconds, 0, 180));

    this.homey.flow.getActionCard('access_panel_set_doorbell_volume')
      .registerArgumentAutocompleteListener('volume', async (query, args) => {
        const values = (args.device.getSetting('volume_values') || 'mute,low,high')
          .split(',').map((s) => s.trim()).filter(Boolean);
        const q = String(query || '').toLowerCase();
        return values.filter((v) => v.toLowerCase().includes(q))
          .map((v) => ({ id: v, name: v.charAt(0).toUpperCase() + v.slice(1) }));
      })
      .registerRunListener(async (args) => args.device.setDoorbellVolume(args.volume.id));

    this.homey.flow.getActionCard('access_panel_force_reconnect')
      .registerRunListener(async (args) => args.device.forceReconnect());

    this.homey.flow.getActionCard('access_panel_refresh_device')
      .registerRunListener(async (args) => args.device.pollNow());
  }

  /**
   * The manufacturer's name for every data point, as { number: code }.
   *
   * Only ever used to label the choices in the per-data-point flow card. Twenty-five
   * of them are opaque blobs, and picking "13" out of a list of numbers is a good way
   * to wire the wrong one; "13 — unlock_face_kit" is not. Best-effort by design: no
   * Cloud Lookup, no names, and the card falls back to plain numbers rather than
   * failing.
   */
  async _fetchDpCodes(deviceId) {
    try {
      const accessId     = this.homey.settings.get('cloud_access_id');
      const accessSecret = this.homey.settings.get('cloud_access_secret');
      const region       = this.homey.settings.get('cloud_region');
      if (!accessId || !accessSecret || !region) return {};
      const detail = await this.homey.app.cloudDeviceDetail({
        accessId, accessSecret, region, deviceId });
      const out = {};
      for (const entry of detail?.status || []) {
        if (entry && entry.dp_id && entry.code) out[entry.dp_id] = entry.code;
      }
      this.log(`Stored ${Object.keys(out).length} data point names for the flow card`);
      return out;
    } catch (err) {
      this.log(`Could not read data point names: ${err.message}`);
      return {};
    }
  }

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
      let failureError = '';
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
        failureError = err.message;
        try { if (pairingDevice) pairingDevice.disconnect(); } catch (_e) {}
        this.log('Connection test failed:', err.message);
      }

      const cloudDps = await detectViaCloud(this.homey, deviceId, CLOUD_CODE_MAP, (m) => this.log(m),
        CLOUD_ENUM_VALUES_MAP, guessedDefaults(DEFAULT_DPS, collectedDps));

      pendingDevice = {
        name: this.homey.__('device.defaultName.access_panel'),
        data: { id: deviceId },
        store: { dpCodes: await this._fetchDpCodes(deviceId) },
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

      // The dialog used to say only "connection failed" — the same sentence
      // whether the address is wrong, the key is wrong, or the device does not
      // offer local control at all. So people work through the one visible
      // choice, the protocol version. Looking at port 6668 separates the cases.
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

module.exports = AccessPanelDriver;
