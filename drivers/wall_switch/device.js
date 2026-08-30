'use strict';

const BaseTuyaDevice = require('../../lib/BaseTuyaDevice');

// â”€â”€ DP â†’ capability mapping â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// DP 1  switch_1      : boolean â€” gang 1
// DP 2  switch_2      : boolean â€” gang 2 (optional)
// DP 3  switch_3      : boolean â€” gang 3 (optional)
// DP 4  switch_4      : boolean â€” gang 4 (optional)
// DP 7  countdown_1   : integer seconds â€” countdown timer for gang 1
// DP 8  countdown_2   : integer seconds â€” countdown timer for gang 2
// DP 14 relay_status  : enum off|on|last â€” power-on behavior

// Die Faehigkeit von Kanal 1 haengt an der Einstellung: ohne Sammelschalter traegt er
// das blosse `onoff` wie bisher, mit ihm zieht er auf `onoff.1` um und `onoff` wird die
// Summe. Siehe _gangCapability - GANG_CAPS.capability ist darum nur die Vorgabe.
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

    // Tracks the last gang state we fired a trigger for â€” survives reconnects
    // (unlike _lastDps which is cleared) and isn't affected by triggerCapabilityListener
    // (unlike getCapabilityValue which can be pre-set by Homey SDK).
    this._lastGangState = {};
    for (const gang of GANG_CAPS) {
      const val = this.getCapabilityValue(gang.capability);
      if (val !== null) this._lastGangState[gang.gang] = val;
    }

    await this._syncGangCapabilities();

    // â”€â”€ Flow trigger cards â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    this._triggerDeviceConnected    = this.homey.flow.getDeviceTriggerCard('switch_device_connected');
    this._triggerDeviceDisconnected = this.homey.flow.getDeviceTriggerCard('switch_device_disconnected');
    this._triggerDpChanged          = this.homey.flow.getDeviceTriggerCard('switch_dp_changed');
    this._triggerSwitchChanged      = this.homey.flow.getDeviceTriggerCard('switch_gang_changed');

    // â”€â”€ Capability listeners â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    this._registerGangListeners();

    await this._connect();
  }

  // â”€â”€ Gang capability sync â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  /** True, solange der Hauptschalter alle Kanaele zusammenfassen soll. */
  get _aggregating() {
    return this.getSetting('aggregate_main') === true;
  }

  /**
   * Welche Faehigkeit dieser Kanal gerade traegt.
   *
   * Nur Kanal 1 wandert: ohne Sammelschalter das blosse `onoff` - die Faehigkeit, die
   * Kachel, Dashboard und Sprachassistent bedienen -, mit ihm `onoff.1`, damit `onoff`
   * fuer die Summe frei wird. Genau daran haengt der gemeldete Fall: eine zusaetzliche
   * Unterfaehigkeit haette das Problem nicht geloest, weil jene drei weiterhin bei
   * Kanal 1 gelandet waeren.
   */
  _gangCapability(gang) {
    if (gang.gang !== 1) return gang.capability;
    return this._aggregating ? 'onoff.1' : 'onoff';
  }

  /** Alle Kanaele, die eine DP-Nummer haben. */
  _activeGangs() {
    return GANG_CAPS.filter((g) => (this.getSetting(g.settingKey) || 0) > 0);
  }

  async _syncGangCapabilities() {
    // `onoff` bleibt in beiden Betriebsarten bestehen - es ist die Hauptfaehigkeit und
    // darf nie fehlen; nur seine Bedeutung wechselt. Umziehen muss allein Kanal 1.
    const einsHat = this._aggregating ? 'onoff.1' : 'onoff';
    const einsWeg = this._aggregating ? 'onoff' : 'onoff.1';
    if (einsWeg === 'onoff.1' && this.hasCapability('onoff.1')) {
      await this.removeCapability('onoff.1').catch(() => {});
    }
    if ((this.getSetting('dp_switch_1') || 0) > 0 && !this.hasCapability(einsHat)) {
      await this.addCapability(einsHat).catch(() => {});
    }

    for (const gang of GANG_CAPS) {
      const dp  = this.getSetting(gang.settingKey) || 0;
      const cap = this._gangCapability(gang);

      if (dp > 0 && !this.hasCapability(cap)) {
        await this.addCapability(cap);
      } else if (dp <= 0 && gang.gang > 1 && this.hasCapability(cap)) {
        await this.removeCapability(cap);
        continue;
      }

      if (dp > 0 && this.hasCapability(cap)) {
        await this._setGangTitle(gang);
      }
    }

    if (this._aggregating) await this._setAggregateTitle();
  }

  /** Der Sammelschalter heisst nach dem, was er tut, nicht nach Kanal 1. */
  async _setAggregateTitle() {
    await this._setCapabilityOptionsIfChanged('onoff', {
      title: { en: 'All channels', de: 'Alle Kanäle' },
    }).catch(() => {});
  }

  /**
   * Den Sammelwert aus den Kanaelen nachziehen: ein, sobald einer an ist.
   *
   * Ausdruecklich mit setCapabilityValue und nie ueber den Listener - sonst schriebe das
   * Nachziehen wieder Befehle aufs Geraet und die Schleife waere da, die zu vermeiden
   * ausdruecklich verlangt war.
   */
  async _updateAggregate(vorgriffGang, vorgriffWert) {
    if (!this._aggregating || !this.hasCapability('onoff')) return;
    const irgendeinerAn = this._activeGangs().some((g) => {
      if (g.gang === vorgriffGang) return vorgriffWert === true;
      const cap = this._gangCapability(g);
      return this.hasCapability(cap) && this.getCapabilityValue(cap) === true;
    });
    if (this.getCapabilityValue('onoff') === irgendeinerAn) return;
    await this.setCapabilityValue('onoff', irgendeinerAn).catch(() => {});
  }

  async _setGangTitle(gang) {
    const customName = (this.getSetting(gang.nameSetting) || '').trim();
    // Neben einem Sammelschalter heisst Kanal 1 "Schalter 1" wie seine Geschwister;
    // allein traegt er weiterhin "Ein/Aus", weil er dann das Geraet selbst ist.
    const eigen     = gang.gang === 1 && this._aggregating;
    const defaultEn = gang.gang === 1 && !eigen ? 'Power' : `Switch ${gang.gang}`;
    const defaultDe = gang.gang === 1 && !eigen ? 'Ein/Aus' : `Schalter ${gang.gang}`;
    const title = customName
      ? { en: customName, de: customName }
      : { en: defaultEn, de: defaultDe };
    await this._setCapabilityOptionsIfChanged(this._gangCapability(gang), { title })
      .catch(() => {});
  }

  _registerGangListeners() {
    for (const gang of GANG_CAPS) {
      const dp  = this.getSetting(gang.settingKey) || 0;
      const cap = this._gangCapability(gang);
      if (dp > 0 && this.hasCapability(cap)) {
        this.registerCapabilityListener(cap, async (value) => {
          await this._set(dp, value);
          // Der Sammelwert folgt der Faehigkeit, die Homey gleich setzt - hier steht
          // noch der alte Wert, also wird er mitgegeben.
          await this._updateAggregate(gang.gang, value);
        });
      }
    }

    // Der Sammelschalter selbst. Jeder eingerichtete Kanal bekommt den Befehl, auch der,
    // der schon so steht: "aus schaltet immer alle aus" war die ausdrueckliche Vorgabe,
    // und ein uebersprungener Kanal waere genau das Loch darin - nach einem Griff an die
    // Wand weiss die App nicht sicher, was jeder Kanal gerade tut.
    if (this._aggregating && this.hasCapability('onoff')) {
      this.registerCapabilityListener('onoff', async (value) => {
        for (const gang of this._activeGangs()) {
          const dp = this.getSetting(gang.settingKey) || 0;
          await this._set(dp, value).catch(() => {});
          const cap = this._gangCapability(gang);
          if (this.hasCapability(cap)) {
            await this.setCapabilityValue(cap, value).catch(() => {});
          }
        }
      });
    }
  }

  // â”€â”€ DPS handling â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  async _handleDps(dps) {
    const settings = this.getSettings();
    let changed = false;

    // Collect known non-switch DPs to avoid noisy "Unknown DP" logging
    const countdownDps = new Set(
      [1, 2, 3, 4].map((n) => settings[`dp_countdown_${n}`]).filter((d) => d > 0),
    );

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

      const gangCap = gangEntry ? this._gangCapability(gangEntry) : null;
      if (gangEntry && this.hasCapability(gangCap)) {
        const bool = Boolean(value);
        await this.setCapabilityValue(gangCap, bool).catch(() => {});
        // Auch ein Griff an die Wand zieht den Sammelschalter nach - das war die
        // Anforderung, die eine reine Befehlsverdrahtung nicht erfuellt haette.
        await this._updateAggregate();

        // Only fire trigger if the gang state ACTUALLY changed â€” prevents spurious
        // triggers on reconnect (when _lastDps is cleared and all DPs re-process).
        if (this._lastGangState[gangEntry.gang] !== bool) {
          this._lastGangState[gangEntry.gang] = bool;
          this._triggerSwitchChanged
            .trigger(this, { gang: String(gangEntry.gang), state: bool }, { gang: String(gangEntry.gang) })
            .catch(() => {});
        }
        continue;
      }

      // Relay status â†’ device setting
      if (settings.dp_relay_status > 0 && dp === settings.dp_relay_status) {
        const KNOWN = ['on', 'off', 'last', 'memory'];
        const strVal = String(value);
        if (KNOWN.includes(strVal)) {
          this.setSettings({ relay_status: strVal }).catch(() => {});
        }
        continue;
      }

      // Countdown DPs are stored in settings only â€” no capability, just acknowledge
      if (countdownDps.has(dp)) continue;

      this.log(`Unknown DP ${dp}:`, value);
    }

    if (changed) {
      this._scheduleStoreSave();
      this._writeDpSnapshot();
    }
  }

  // â”€â”€ Homey lifecycle â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  async onSettings({ changedKeys }) {
    // Der Sammelschalter aendert, welche Faehigkeit Kanal 1 traegt - das muss vor allem
    // anderen geschehen, sonst melden sich die Listener auf der alten an.
    if (changedKeys.includes('aggregate_main')) {
      await this._syncGangCapabilities();
      this._registerGangListeners();
      await this._updateAggregate();
    }
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
    if (changedKeys.includes('reconnect_interval')) this._startAutoReconnect();

    // Gang DPs or names changed â†’ sync capabilities and titles
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
