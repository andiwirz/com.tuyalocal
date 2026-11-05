'use strict';

const BaseTuyaDevice = require('../../lib/BaseTuyaDevice');
const { rohZuId, idZuRoh } = require('../../lib/utils.js');

// Was der Steuer-DP fuer auf, stop und zu sendet - siehe _befehl. Die Vorgabe sind die
// Woerter selbst, wie bisher; sie muss der Vorgabe von control_values im Manifest gleichen,
// denn ein Geraet, das vor der Einstellung angelegt wurde, liefert fuer sie null.
const BEFEHLE_VORGABE = 'open,stop,close';

// ── Universal curtain motor driver ────────────────────────────────────────────
//
// Zemismart v1 (category "cl"):
//   DP 1   control          enum open|stop|close
//   DP 2   percent_control  integer 0–100  (0 = closed, 100 = open)
//   DP 5   control_back     bool   — reverse motor direction
//   DP 7   work_state       enum opening|closing  (read-only)
//   DP 10  fault            bitmap
//
// Zemismart v2 (same core, extra DPs):
//   DP 1   control          enum open|stop|close
//   DP 2   percent_control  integer 0–100
//   DP 5   control_back     bool / control_back_mode enum forward|back
//   DP 7   work_state       enum opening|closing
//   DP 12  fault            bitmap (motor_fault)
//   DP 16  border           enum — limit calibration  (device-settings-only)
//   DP 19  position_best    integer — favourite position  (device-settings-only)
//
// Homey mapping:
//   windowcoverings_state  "up"/"idle"/"down"  ↔  "open"/"stop"/"close"
//   windowcoverings_set    0.0 – 1.0           ↔  percent_control 0–100
//     (0.0 = fully closed, 1.0 = fully open; enable invert_position if reversed)
//   alarm_generic          fault bitmap non-zero

const DP_PROFILE = [
  { settingKey: 'dp_control',         capability: 'windowcoverings_state', type: 'control',    settable: true  },
  { settingKey: 'dp_percent_control', capability: 'windowcoverings_set',   type: 'position',   settable: true  },
  { settingKey: 'dp_percent_state',   capability: 'windowcoverings_set',   type: 'position_state', settable: false },
  { settingKey: 'dp_work_state',      capability: 'windowcoverings_state', type: 'work_state', settable: false },
  { settingKey: 'dp_fault',          capability: 'alarm_generic',          type: 'alarm',      settable: false },
];

const OPTIONAL_CAPABILITIES = [
  { setting: 'dp_fault', capability: 'alarm_generic' },
];

// Tuya control → Homey windowcoverings_state
const CONTROL_TO_STATE = { open: 'up', stop: 'idle', close: 'down' };
// Homey windowcoverings_state → Tuya control
const STATE_TO_CONTROL = { up: 'open', idle: 'stop', down: 'close' };
// Tuya work_state → Homey windowcoverings_state
const WORK_STATE_MAP   = { opening: 'up', closing: 'down' };

class CurtainMotorDevice extends BaseTuyaDevice {
  async onInit() {
    this.log('Device initialized:', this.getName());

    await this._baseInit();

    // Migrate: add capabilities added after initial release
    if (!this.hasCapability('windowcoverings_closed')) {
      await this.addCapability('windowcoverings_closed').catch(() => {});
    }

    // Fault-alarm debounce state
    this._connectedAt         = null;
    this._faultAlarmTimer     = null;
    this._faultAlarmConfirmed = false;

    await this._syncOptionalCapabilities(OPTIONAL_CAPABILITIES);

    // ── Flow trigger cards ───────────────────────────────────────────────────
    this._triggerOpened             = this.homey.flow.getDeviceTriggerCard('curtain_opened');
    this._triggerClosed             = this.homey.flow.getDeviceTriggerCard('curtain_closed');
    this._triggerPositionChanged    = this.homey.flow.getDeviceTriggerCard('curtain_position_changed');
    this._triggerFault              = this.homey.flow.getDeviceTriggerCard('curtain_fault_triggered');
    this._triggerDeviceConnected    = this.homey.flow.getDeviceTriggerCard('curtain_device_connected');
    this._triggerDeviceDisconnected = this.homey.flow.getDeviceTriggerCard('curtain_device_disconnected');
    this._triggerDpChanged          = this.homey.flow.getDeviceTriggerCard('curtain_dp_changed');

    // ── Capability listeners ─────────────────────────────────────────────────

    // windowcoverings_state: "up"/"idle"/"down" → open/stop/close
    // invert_control swaps open↔close for devices where the Tuya "open" command
    // physically closes the curtain (common on some Zemismart installations).
    this.registerCapabilityListener('windowcoverings_state', async (value) => {
      const dp     = this.getSetting('dp_control');
      const invert = this.getSetting('invert_control') || false;
      if (!dp || dp === 0) throw new Error('Control DP not configured');
      const cmdMap = invert
        ? { up: 'close', idle: 'stop', down: 'open' }
        : STATE_TO_CONTROL;
      const cmd = cmdMap[value];
      if (!cmd) throw new Error(`Unknown state: ${value}`);
      this.log(`Curtain ${cmd} (DP ${dp})${invert ? ' [inverted]' : ''}`);
      await this._set(dp, this._befehl(cmd));
    });

    // windowcoverings_closed: Quick Action toggle — true = close, false = open
    this.registerCapabilityListener('windowcoverings_closed', async (value) => {
      const dp     = this.getSetting('dp_control');
      const invert = this.getSetting('invert_control') || false;
      if (!dp || dp === 0) throw new Error('Control DP not configured');
      const cmd = value
        ? (invert ? 'open' : 'close')
        : (invert ? 'close' : 'open');
      this.log(`Curtain ${cmd} via Quick Action (DP ${dp})${invert ? ' [inverted]' : ''}`);
      await this._set(dp, this._befehl(cmd));
    });

    // windowcoverings_set: 0.0–1.0 → 0–100 (with optional inversion)
    this.registerCapabilityListener('windowcoverings_set', async (value) => {
      const dp     = this.getSetting('dp_percent_control');
      const invert = this.getSetting('invert_position') || false;
      if (!dp || dp === 0) throw new Error('Position DP not configured');
      const raw = Math.round(invert ? (1 - value) * 100 : value * 100);
      this.log(`Curtain position → ${raw}% (DP ${dp})`);
      await this._set(dp, raw);
    });

    await this._connect();
  }

  // ── Hook overrides ────────────────────────────────────────────────────────────

  _onConnected() {
    this._connectedAt         = Date.now();
    clearTimeout(this._faultAlarmTimer);
    this._faultAlarmTimer     = null;
    this._faultAlarmConfirmed = false;
  }

  async _onDeleted() {
    clearTimeout(this._faultAlarmTimer);
  }

  // -- Befehlswerte -------------------------------------------------------------
  //
  // Gemeldet mit einem Nedis-Rolladenschalter (WIFIWC10WT): sein Steuer-DP meldet "2",
  // und die Cloud uebersetzt das als close. Der Treiber sandte die Woerter open, stop und
  // close, die dieser Schalter ohne Fehler verwirft - es bewegte sich nichts -, und das
  // gemeldete "2" verstand er nicht. control_values sagt, was gesendet wird, in der Form
  // name=value wie die Wertelisten der anderen Treiber. Ohne Zuordnung bleibt jedes Wort,
  // wie es ist; ein Motor, der Woerter spricht, merkt davon nichts.

  /** Die Befehlswerte, oder ihre Vorgabe. Ein leeres Feld ist keine Liste. */
  _befehlsliste() {
    const wert = this.getSetting('control_values');
    return wert !== null && wert !== undefined && String(wert).trim() !== '' ? String(wert) : BEFEHLE_VORGABE;
  }

  /** open, stop oder close, wie das Geraet es erwartet. */
  _befehl(wort) {
    return idZuRoh(this._befehlsliste(), wort);
  }

  /**
   * Ein gemeldeter Wert, den keiner der drei Befehle traegt. Einmal je Wert: der
   * Schalter meldet ihn nach jedem Neuverbinden wieder.
   */
  _unbekannterBefehl(value) {
    const roh = String(value);
    this._gewarnteBefehle = this._gewarnteBefehle || new Set();
    if (this._gewarnteBefehle.has(roh)) return;
    this._gewarnteBefehle.add(roh);
    this._appLog(`Control DP reports "${roh}", which is none of the command values (${this._befehlsliste()}).`
      + (/^\d+$/.test(roh)
        ? ' This motor uses numbers: set Command values in the device settings - usually open=1,close=2,stop=3.'
        : ''), 'warn');
  }

  /**
   * Geaenderte Befehlswerte gelten auch fuer die Kachel sofort: der letzte gemeldete
   * Wert wird mit ihnen neu gelesen - siehe _umrechnungen in BaseTuyaDevice.
   */
  _umrechnungen() {
    return [...super._umrechnungen(), ['dp_control', 'control_values']];
  }

  // ── DPS handling ─────────────────────────────────────────────────────────────

  /**
   * invert_control gilt in beide Richtungen. Gesendet wurde vertauscht, das Echo des
   * Geraets aber wortwoertlich gelesen: "Auf" schickte close, das Echo close hiess
   * "runter", und die Kachel zeigte das Gegenteil dessen, was gedrueckt wurde. Ebenso
   * work_state - das Geraet nennt seine eigene Richtung, und die ist vertauscht.
   */
  _richtung(state, settings) {
    if (!settings.invert_control) return state;
    return state === 'up' ? 'down' : state === 'down' ? 'up' : state;
  }

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

      const entry = DP_PROFILE.find((e) => {
        const dpNum = settings[e.settingKey];
        return dpNum > 0 && dp === dpNum;
      });

      if (!entry) {
        this.log(`Unknown DP ${dp}:`, value);
        continue;
      }

      if (!this.hasCapability(entry.capability)) continue;

      switch (entry.type) {

        // ── Control command echo → windowcoverings_state ──────────────────────
        case 'control': {
          // Ueber die Befehlswerte zurueck auf das Wort: bei open=1,close=2,stop=3 meint
          // ein gemeldetes "2" close.
          const wort  = String(rohZuId(this._befehlsliste(), value)).toLowerCase();
          const state = this._richtung(CONTROL_TO_STATE[wort], settings);
          if (state) {
            await this.setCapabilityValue('windowcoverings_state', state).catch(() => {});
          } else {
            this._unbekannterBefehl(value);
          }
          break;
        }

        // ── Movement state → windowcoverings_state ────────────────────────────
        // Overrides the control echo while the motor is actively moving so the
        // tile shows "moving" rather than the last command sent.
        case 'work_state': {
          const state = this._richtung(WORK_STATE_MAP[String(value).toLowerCase()], settings);
          if (state) {
            await this.setCapabilityValue('windowcoverings_state', state).catch(() => {});
          }
          break;
        }

        // ── Position (percent_control 0–100) ──────────────────────────────────
        // Where the motor actually is, when it reports that apart from the target.
        // Reported with a motor whose DP 2 (percent_control) stayed on 100 while DP 3
        // (percent_state) went from 100 to 0: DP 2 is where a position is asked for,
        // DP 3 where the curtain is. With a current-position DP set, only it moves the
        // tile - the target would put the old value back on every reconnect, and fire
        // "opened" on its way there. The same DP in both settings means one DP for both,
        // as before.
        case 'position_state':
        case 'position': {
          const istDp = Number(settings.dp_percent_state);
          if (entry.type === 'position' && istDp > 0 && istDp !== Number(settings.dp_percent_control)) break;
          const invert  = settings.invert_position || false;
          const percent = Number(value);
          const homey   = Math.min(1, Math.max(0, invert ? (100 - percent) / 100 : percent / 100));
          const prev    = this.getCapabilityValue('windowcoverings_set');
          await this.setCapabilityValue('windowcoverings_set', homey).catch(() => {});

          // Keep Quick Action boolean in sync with position
          if (this.hasCapability('windowcoverings_closed')) {
            await this.setCapabilityValue('windowcoverings_closed', homey <= 0).catch(() => {});
          }

          // Fire opened/closed triggers when reaching limits
          if (homey >= 1 && (prev === null || prev < 1)) {
            this._triggerOpened.trigger(this).catch(() => {});
          } else if (homey <= 0 && (prev === null || prev > 0)) {
            this._triggerClosed.trigger(this).catch(() => {});
          }
          // Nur bei einer echten Aenderung. Nach jedem Neuverbinden ist _lastDps leer,
          // die Position kommt unveraendert noch einmal, und die Karte feuerte jedes Mal.
          if (prev === null || Math.round(prev * 100) !== Math.round(homey * 100)) {
            this._triggerPositionChanged
              .trigger(this, { position: Math.round(homey * 100) })
              .catch(() => {});
          }
          break;
        }

        // ── Fault (bitmap non-zero = fault) ───────────────────────────────────
        case 'alarm': {
          const isAlarm   = typeof value === 'number' ? value !== 0 : Boolean(value);
          const prevAlarm = this.getCapabilityValue('alarm_generic');
          await this.setCapabilityValue('alarm_generic', isAlarm).catch(() => {});

          if (!prevAlarm && isAlarm) {
            const GRACE_MS   = 30_000;
            const elapsed    = this._connectedAt ? Date.now() - this._connectedAt : GRACE_MS;
            const debounceMs = elapsed < GRACE_MS ? GRACE_MS - elapsed + 5_000 : 5_000;
            clearTimeout(this._faultAlarmTimer);
            this._faultAlarmConfirmed = false;
            this._faultAlarmTimer = setTimeout(() => {
              if (this.getCapabilityValue('alarm_generic') === true) {
                this._faultAlarmConfirmed = true;
                this._triggerFault.trigger(this, { fault_code: String(value) }).catch(() => {});
                this.homey.notifications.createNotification({
                  excerpt: `${this.getName()}: ${this.homey.__('notifications.faultAlarm')}`,
                }).catch(() => {});
              }
            }, debounceMs);
          }
          if (prevAlarm && !isAlarm) {
            clearTimeout(this._faultAlarmTimer);
            this._faultAlarmConfirmed = false;
          }
          break;
        }

        default:
          break;
      }
    }

    if (changed) {
      this._scheduleStoreSave();
      this._writeDpSnapshot();
    }
  }

  // ── Settings ─────────────────────────────────────────────────────────────────

  async onSettings({ changedKeys }) {
    const connectionKeys = ['ip', 'device_id', 'local_key', 'version'];
    if (changedKeys.some((k) => connectionKeys.includes(k))) {
      await this._connect();
      return;
    }
    if (changedKeys.includes('polling_interval')) {
      this._startPolling();
    }
    if (changedKeys.includes('reconnect_interval')) this._startAutoReconnect();
    if (this._touchesOptional(changedKeys, OPTIONAL_CAPABILITIES)) {
      await this._syncOptionalCapabilities(OPTIONAL_CAPABILITIES);
    }
    // The current-position DP usually already has a value on record, from when it was
    // just an unknown DP - and an unchanged value is skipped, so the tile would wait
    // for the next movement. A moment later, once the new setting is saved (inside
    // onSettings getSetting still returns the old one), forget that value and ask.
    if (changedKeys.includes('dp_percent_state') || changedKeys.includes('dp_percent_control')) {
      this.homey.setTimeout(() => {
        const istDp = Number(this.getSetting('dp_percent_state'));
        if (istDp > 0 && this._lastDps) delete this._lastDps[String(istDp)];
        this.pollNow().catch(() => {});
      }, 1000);
    }
  }
}

module.exports = CurtainMotorDevice;
