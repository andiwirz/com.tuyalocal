'use strict';

const Homey                     = require('homey');
const TuyAPI                    = require('../../lib/SafeTuyAPI');
const { setupCloudLookup }      = require('../../lib/pairCloudLookup');
const { describeConnectFailure } = require('../../lib/connectFailure');
const { detectProtocolVersion } = require('../../lib/autoDetect');
const { scanNetwork }           = require('../../lib/networkScan');
const { detectViaCloud, guessedDefaults } = require('../../lib/dpCodeMap');

// The wnykq (IR remote) layout. There are two families of these boxes: one puts
// its command channel on 201/202, the other drives a fixed air-conditioner layout
// from DP 1 upwards. This driver serves the first, which is the one that can learn
// codes from any remote — an air conditioner on the second is better off in the
// Air Conditioner driver, which already speaks that layout.
const DEFAULT_DPS = {
  dp_ir_send:     201,
  dp_ir_study:    202,
  dp_temperature: 101,
  dp_humidity:    102,
};

const CLOUD_CODE_MAP = {
  dp_ir_send:     ['ir_send', 'ir_code_to_send', 'study_code'],
  dp_ir_study:    ['ir_study_code', 'study_result', 'ir_code'],
  dp_temperature: ['temp_current', 'va_temperature', 'temperature'],
  dp_humidity:    ['humidity_value', 'va_humidity', 'humidity'],
};

class IrBlasterDriver extends Homey.Driver {
  async onInit() {
    this.log('IR blaster driver initialized');

    // ── Conditions ─────────────────────────────────────────────────────────
    this.homey.flow.getConditionCard('ir_device_is_connected')
      .registerRunListener(async (args) => args.device._conn?.connected === true);

    // ── Actions ─────────────────────────────────────────────────────────────
    const senden = this.homey.flow.getActionCard('ir_send_code');
    senden.registerRunListener(async (args) => args.device.sendSavedCode(args.code.name));
    senden.registerArgumentAutocompleteListener('code',
      async (query, args) => (args.device ? args.device.codeAutocomplete(query) : []));

    // Lautstaerke und Programmplatz sind die Tasten, die man nicht einmal drueckt.
    // Als eigene Karte statt als zwei weitere Felder an der Karte oben: der haeufige
    // Fall bleibt damit zweifeldrig, und wer wiederholen will, findet sie im Menue.
    const mehrfach = this.homey.flow.getActionCard('ir_send_repeatedly');
    mehrfach.registerRunListener(async (args) => args.device.sendSavedCode(args.code.name, {
      wiederholungen: args.repeats,
      abstandMs:      args.gap,
    }));
    mehrfach.registerArgumentAutocompleteListener('code',
      async (query, args) => (args.device ? args.device.codeAutocomplete(query) : []));

    // Dasselbe wie oben, nur mit getipptem Namen. Ein Auswahlfeld laesst sich in Homey
    // nicht aus einer Variablen fuellen — wer den Knopf im Flow ausrechnet, statt ihn
    // beim Bauen zu wissen, braucht diese Karte.
    this.homey.flow.getActionCard('ir_send_named_code')
      .registerRunListener(async (args) => args.device.sendSavedCode(String(args.name).trim()));

    this.homey.flow.getActionCard('ir_send_raw')
      .registerRunListener(async (args) => args.device.sendRawCode(args.code));

    this.homey.flow.getActionCard('ir_learn_code')
      .registerRunListener(async (args) => args.device.startLearning(args.name));

    this.homey.flow.getActionCard('ir_stop_learning')
      .registerRunListener(async (args) => args.device.stopLearning());

    const vergessen = this.homey.flow.getActionCard('ir_forget_code');
    vergessen.registerRunListener(async (args) => {
      const weg = await args.device.forgetCode(args.code.name);
      if (!weg) throw new Error(`No IR code saved as "${args.code.name}".`);
    });
    vergessen.registerArgumentAutocompleteListener('code',
      async (query, args) => (args.device ? args.device.codeAutocomplete(query) : []));

    this.homey.flow.getActionCard('ir_force_reconnect')
      .registerRunListener(async (args) => args.device.forceReconnect());

    this.homey.flow.getActionCard('ir_refresh_device')
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
      if (!net.isIPv4(ip)) {
        throw new Error(this.homey.__('pair.credentials.invalidIp'));
      }
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
          device.on('dp-refresh', (payload) => {
            if (payload?.dps) Object.assign(tmpDps, payload.dps);
          });
          const versuch = device.connect();
          versuch.catch(() => {});
          await Promise.race([
            versuch,
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

      // Der Befehlsdatenpunkt ist der einzige, der nicht von selbst meldet: er ist
      // ein Eingang, und ein Geraet, das noch nie einen Befehl bekommen hat, hat
      // nichts darauf zu zeigen. Er darf darum nicht abgeschaltet werden, nur weil
      // er beim Anlernen schwieg - sonst haette der Treiber keinen Weg nach draussen.
      const geraten = guessedDefaults(DEFAULT_DPS, collectedDps);
      geraten.dp_ir_send = DEFAULT_DPS.dp_ir_send;

      const cloudDps = await detectViaCloud(this.homey, deviceId, CLOUD_CODE_MAP,
        (m) => this.log(m), {}, geraten);

      pendingDevice = this._buildPendingDevice({
        ip, deviceId, localKey, version: actualVersion, detectedDps: cloudDps,
      });
      pendingRawDps = collectedDps;

      const failureHint = connected
        ? ''
        : await describeConnectFailure({ ip, error: failureError });
      if (failureHint) this.log(failureHint);

      return { connected, detectedVersion: actualVersion, failureHint };
    });

    session.setHandler('list_devices', async () => pendingDevice ? [pendingDevice] : []);
    session.setHandler('raw_dps', async () => pendingRawDps || {});
    session.setHandler('set_device_name', async (name) => {
      if (pendingDevice && name?.trim()) pendingDevice.name = name.trim();
    });
  }

  _buildPendingDevice({ ip, deviceId, localKey, version, detectedDps }) {
    return {
      name: this.homey.__('device.defaultName.ir_blaster'),
      data: { id: deviceId },
      settings: {
        ip,
        device_id:             deviceId,
        local_key:             localKey,
        version,
        // Ein Blaster meldet von sich aus, wenn sich etwas aendert - abgefragt wird
        // nur, damit ein stiller Ausfall auffaellt, und damit der Sensor, den die
        // meisten dieser Kaesten eingebaut haben, nicht einfriert.
        polling_interval:      60,
        offline_grace_seconds: 60,
        ...DEFAULT_DPS,
        ...(detectedDps || {}),
      },
    };
  }

  async onPairListDevices() { return []; }
}

module.exports = IrBlasterDriver;
