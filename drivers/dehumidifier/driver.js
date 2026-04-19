'use strict';

const Homey = require('homey');
const TuyAPI = require('tuyapi');

class DehumidifierDriver extends Homey.Driver {
  async onInit() {
    this.log('Dehumidifier driver initialized');
    this._pendingDevice = null;
  }

  async onPair(session) {
    session.setHandler('showView', async (viewId) => {
      if (viewId === 'list_devices' || viewId === 'add_devices') {
        await session.emit('devices', this._pendingDevice ? [this._pendingDevice] : []);
      }
    });

    session.setHandler('list_devices', async () => {
      return this._pendingDevice ? [this._pendingDevice] : [];
    });

    session.setHandler('add_devices', async (devices) => {
      return devices;
    });

    session.setHandler('credentials', async (data) => {
      const { ip, deviceId, localKey, version } = data;

      let connected = false;
      try {
        const device = new TuyAPI({
          id: deviceId,
          key: localKey,
          ip,
          version: String(version),
          issueGetOnConnect: false,
        });

        // Prevent unhandled 'error' events from crashing the process
        device.on('error', (err) => {
          this.log('Connection test error:', err.message);
        });

        await Promise.race([
          device.connect(),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Connection timed out')), 8000)
          ),
        ]);

        device.disconnect();
        connected = true;
      } catch (err) {
        this.log('Connection test failed:', err.message);
      }

      this._pendingDevice = {
        name: `Dehumidifier (${ip})`,
        data: { id: deviceId },
        settings: {
          ip,
          device_id: deviceId,
          local_key: localKey,
          version: String(version),
        },
      };

      return { connected };
    });
  }

  async onPairListDevices() {
    if (!this._pendingDevice) return [];
    return [this._pendingDevice];
  }
}

module.exports = DehumidifierDriver;
