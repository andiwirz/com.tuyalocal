'use strict';

const BaseTuyaDevice = require('../../lib/BaseTuyaDevice');

// ── DP → capability mapping ──────────────────────────────────────────────────
// DP 1  switch_1      : boolean — gang 1
// DP 2  switch_2      : boolean — gang 2 (optional)
// DP 3  switch_3      : boolean — gang 3 (optional)
// DP 4  switch_4      : boolean — gang 4 (optional)
// DP 7  countdown_1   : integer seconds — countdown timer for gang 1
// DP 8  countdown_2   : integer seconds — countdown timer for gang 2
// DP 14 relay_status  : enum off|on|last — power-on behavior

const GANG_CAPS = [
  { gang: 1, settingKey: 'dp_switch_1', nameSetting: 'name_switch_1', capability: 'onoff'    },
  { gang: 2, settingKey: 'dp_switch_2', nameSetting: 'name_switch_2', capability: 'onoff.2'  },
  { gang: 3, settingKey: 'dp_switch_3', nameSetting: 'name_switch_3', capability: 'onoff.3'  },
  { gang: 4, settingKey: 'dp_switch_4', nameSetting: 'name_switch_4', capability: 'onoff.4'  },
];

class WallSwitchDevice extends BaseTuyaDevice {
  async onInit() {
    this.log('Device initialized:', this.getName());

    await this._baseInit();

    await this._syncGangCapabilities();

    // ── Flow trigger cards ───────────────────────────────────────────────────
    this._triggerDeviceConnected    = this.homey.flow.getDeviceTriggerCard('switch_device_connected');
    this._triggerDeviceDisconnected = this.homey.flow.getDeviceTriggerCard('switch_device_disconnected');
    this._triggerDpChanged          = this.homey.flow.getDeviceTriggerCard('switch_dp_changed');
    this._triggerSwitchChanged      = this.homey.flow.getDeviceTriggerCard('switch_gang_changed');

    // ── Capability listeners ─────────────────────────────────────────────────
    this._registerGangListeners();

    await this._connect();
  }

  // ── Gang capability sync ──────────────────────────────────────────────────────

  async _syncGangCapabilities() {
    for (const gang of GANG_CAPS) {
      const dp = this.getSetting(gang.settingKey) || 0;

      if (dp > 0 && !this.hasCapability(gang.capability)) {
        await this.addCapability(gang.capability);
      } else if (dp <= 0 && gang.gang > 1 && this.hasCapability(gang.capability)) {
        await this.removeCapability(gang.capability);
        continue;
      }

      if (dp > 0 && this.hasCapability(gang.capability)) {
        await this._setGangTitle(gang);
      }
    }
  }

  async _setGangTitle(gang) {
    const customName = (this.getSetting(gang.nameSetting) || '').trim();
    const defaultEn  = gang.gang === 1 ? 'Power' : `Switch ${gang.gang}`;
    const defaultDe  = gang.gang === 1 ? 'Ein/Aus' : `Schalter ${gang.gang}`;
    const title = customName
      ? { en: customName, de: customName }
      : { en: defaultEn, de: defaultDe };
    await this.setCapabilityOptions(gang.capability, { title }).catch(() => {});
  }

  _registerGangListeners() {
    for (const gang of GANG_CAPS) {
      const dp = this.getSetting(gang.settingKey) || 0;
      if (dp > 0 && this.hasCapability(gang.capability)) {
        this.registerCapabilityListener(gang.capability, async (value) => {
          await this._set(dp, value);
        });
      }
    }
  }

  // ── DPS handling ─────────────────────────────────────────────────────────────

  async _handleDps(dps) {
    const settings = this.getSettings();
    let changed = false;

    for (const [dpStr, value] of Object.entries(dps)) {
      if (this._lastDps[dpStr] === value) continue;
      this._lastDps[dpStr] = value;
      changed = true;

      const dp = parseInt(dpStr, 10);

      this._triggerDpChanged
        .trigger(this, { dp: dpStr, value: String(value) })
        .catch(() => {});

      // Match against gang DPs
      const gangEntry = GANG_CAPS.find((g) => {
        const gDp = settings[g.settingKey];
        return gDp > 0 && dp === gDp;
      });

      if (gangEntry && this.hasCapability(gangEntry.capability)) {
        const bool = Boolean(value);
        this.log(`Gang ${gangEntry.gang} (DP ${dp}) → ${bool}`);
        await this.setCapabilityValue(gangEntry.capability, bool).catch(() => {});
        this._triggerSwitchChanged
          .trigger(this, { gang: String(gangEntry.gang), state: bool }, { gang: String(gangEntry.gang) })
          .then(() => this.log(`Trigger switch_gang_changed fired: gang=${gangEntry.gang} state=${bool}`))
          .catch((err) => this.log(`Trigger switch_gang_changed FAILED: gang=${gangEntry.gang} err=${err.message}`));
        continue;
      }

      // Relay status → device setting
      if (settings.dp_relay_status > 0 && dp === settings.dp_relay_status) {
        const KNOWN = ['on', 'off', 'last', 'memory'];
        const strVal = String(value);
        if (KNOWN.includes(strVal)) {
          this.setSettings({ relay_status: strVal }).catch(() => {});
        }
        continue;
      }

      this.log(`Unknown DP ${dp}:`, value);
    }

    if (changed) {
      this._scheduleStoreSave();
      this._writeDpSnapshot();
    }
  }

  // ── Homey lifecycle ──────────────────────────────────────────────────────────

  async onSettings({ changedKeys }) {
    const connectionKeys = ['ip', 'device_id', 'local_key', 'version'];
    if (changedKeys.some((k) => connectionKeys.includes(k))) {
      this.log('Connection settings changed, reconnecting');
      await this._connect();
      return;
    }
    if (changedKeys.includes('polling_interval')) {
      this.log('Polling interval changed, restarting polling');
      this._startPolling();
    }

    // Gang DPs or names changed → sync capabilities and titles
    const gangKeys = GANG_CAPS.map((g) => g.settingKey);
    const nameKeys = GANG_CAPS.map((g) => g.nameSetting);
    if (changedKeys.some((k) => gangKeys.includes(k) || nameKeys.includes(k))) {
      await this._syncGangCapabilities();
      this._registerGangListeners();
    }

    if (changedKeys.includes('relay_status')) {
      const dp = this.getSetting('dp_relay_status');
      if (dp > 0) {
        await this._set(dp, this.getSetting('relay_status'))
          .catch((err) => this._appLog(`relay_status set failed: ${err.message}`, 'warn'));
      }
    }
  }
}

module.exports = WallSwitchDevice;
