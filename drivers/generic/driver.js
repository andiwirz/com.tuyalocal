'use strict';

const Homey                     = require('homey');
const TuyAPI                    = require('../../lib/SafeTuyAPI');
const { setupCloudLookup } = require('../../lib/pairCloudLookup');
const { describeConnectFailure } = require('../../lib/connectFailure');
const { detectProtocolVersion } = require('../../lib/autoDetect');
const { scanNetwork }           = require('../../lib/networkScan');

class GenericDriver extends Homey.Driver {
  async onInit() {
    this.log('Generic driver initialized');

    // ── Triggers ─────────────────────────────────────────────────────────────
    // Filters the "A specific data point changed" card so it only fires for
    // the DP number configured in the flow card, not every DP on the device.
    this.homey.flow.getDeviceTriggerCard('generic_dp_value_changed')
      .registerRunListener(async (args, state) => Number(args.dp) === Number(state.dp));

    // ── Actions ──────────────────────────────────────────────────────────────
    this.homey.flow.getActionCard('generic_force_reconnect')
      .registerRunListener(async (args) => {
        return args.device.forceReconnect();
      });

    this.homey.flow.getActionCard('generic_refresh_device')
      .registerRunListener(async (args) => {
        return args.device.pollNow();
      });

    this.homey.flow.getActionCard('generic_send_dp')
      .registerRunListener(async ({ device, dp, value }) => {
        // Parse value string → correct JS type
        let parsed;
        const v = String(value).trim();
        if (v === 'true')       parsed = true;
        else if (v === 'false') parsed = false;
        else if (v !== '' && !isNaN(v) && !isNaN(parseFloat(v))) parsed = parseFloat(v);
        else parsed = v;

        device.log(`Flow: send_dp ${dp} = ${JSON.stringify(parsed)}`);
        return device._set(Number(dp), parsed);
      });

    // ── Conditions ───────────────────────────────────────────────────────────
    this.homey.flow.getConditionCard('generic_device_is_connected')
      .registerRunListener(async (args) =>
        args.device._conn?.connected === true
      );

    this.homey.flow.getConditionCard('generic_dp_value_is')
      .registerRunListener(async ({ device, dp, value }) => {
        const raw = device._lastDps?.[String(dp)];
        if (raw === undefined) return false; // no data received for this DP yet

        // Parse the condition's value string the same way generic_send_dp does.
        let parsed;
        const v = String(value).trim();
        if (v === 'true')       parsed = true;
        else if (v === 'false') parsed = false;
        else if (v !== '' && !isNaN(v) && !isNaN(parseFloat(v))) parsed = parseFloat(v);
        else parsed = v;

        if (typeof parsed === 'boolean') return Boolean(raw) === parsed;
        if (typeof parsed === 'number')  return Number(raw) === parsed;
        return String(raw) === parsed;
      });
  }

  async onPair(session) {
    setupCloudLookup(session, this.homey, this);
    let pendingDevice = null;
    let pendingRawDps = {};

    // ── Network scan ─────────────────────────────────────────────────────────
    session.setHandler('scan_network', async () => {
      return scanNetwork(this.homey);
    });

    // ── Credentials / connect ─────────────────────────────────────────────────
    session.setHandler('credentials', async (data) => {
      const { ip, deviceId, localKey, version } = data;

      const net = require('net');
      if (!net.isIPv4(ip)) {
        throw new Error(this.homey.__('pair.credentials.invalidIp') || 'Invalid IP address');
      }
      if (localKey.length !== 16 && localKey.length !== 32) {
        throw new Error(this.homey.__('pair.credentials.invalidKey') || 'Invalid local key length');
      }

      let connected      = false;
      let failureError = '';
      let actualVersion  = String(version);
      const collectedDps = {};

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
          rawDps = tmpDps;
        }
        Object.assign(collectedDps, rawDps);
        connected = true;
      } catch (err) {
        connected = false;
        failureError = err.message;
        try { device.disconnect(); } catch (_e) {}
        this.log('Connection test failed:', err.message);
      }

      pendingDevice = {
        name: this.homey.__('device.defaultName.generic'),
        data: { id: deviceId },
        settings: {
          ip,
          device_id:        deviceId,
          local_key:        localKey,
          version:          actualVersion,
          dp_config:        '[]',
          polling_interval: 30,
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

    // ── List devices ──────────────────────────────────────────────────────────
    session.setHandler('list_devices', async () => {
      return pendingDevice ? [pendingDevice] : [];
    });

    // ── Raw DPS ───────────────────────────────────────────────────────────────
    session.setHandler('raw_dps', async () => {
      return pendingRawDps || {};
    });

    // ── Helpers called by list_devices.html ───────────────────────────────────
    session.setHandler('set_device_name', async (name) => {
      if (pendingDevice && name && name.trim()) {
        pendingDevice.name = name.trim();
      }
    });

    session.setHandler('set_dp_config', async (dpConfigJson) => {
      if (pendingDevice) {
        pendingDevice.settings.dp_config = dpConfigJson;
      }
    });
  }

  // Fallback for older Homey versions
  async onPairListDevices() {
    return [];
  }
}

module.exports = GenericDriver;
