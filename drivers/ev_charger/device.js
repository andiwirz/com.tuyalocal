'use strict';

const BaseTuyaDevice = require('../../lib/BaseTuyaDevice');

const DEBOUNCE_MS = 300;

// ── Tuya EV charger (category "qccdz") DP map ────────────────────────────────
// Verified against all 37 EV-charger configs in make-all/tuya-local, covering
// Vevor, Nine, Tera, Emini, Aimiler, Ecopoint, Dowell, Feyree, AfyeEV, Junsun,
// Zencar, iPengen, Suntree, Immax, Voldt, Wadapower and others.
//
//   DP 1   value  forward_energy_total ×0.01 kWh — lifetime total. Real on many
//                 chargers, but silent over LAN on some (notably several Vevor
//                 portables). Configurable: when dp_energy_total = 0 the total
//                 is accumulated from DP 25 session deltas instead.
//   DP 3   enum   work_state
//   DP 4   value  charge_cur_set (A) — writable. Hardware ranges seen in the
//                 wild span 0–48 A, hence the configurable current_min/max.
//   DP 5   value  single-phase power (W) — 7 configs
//   DP 6   raw    phase A: 2B voltage ×0.1 V, 3B current ×0.001 A, then power.
//                 Buffer is 8 bytes (3B power) on most units but 7 bytes
//                 (2B power) on Nine / Amperepoint / Noeifevo — handled below.
//   DP 7   raw    phase B — 3-phase chargers
//   DP 8   raw    phase C — 3-phase chargers
//   DP 9   value  total power (W) — preferred over phase A when present
//   DP 10  bitmap fault (16 bits)
//   DP 13  enum   connection_state (CP pilot)
//   DP 14  enum   work_mode — enum range overpromises on most units; DP 33
//                 (mode_set bitmask) is the authoritative capability list.
//   DP 16  bool   clear-energy button (write-only pulse)
//   DP 18  bool   switch
//   DP 24  value  temp_current (°C)
//   DP 25  value  charge_energy_once ×0.01 kWh — current/last session
//   DP 27  enum   online|offline — "live updates". Several chargers only stream
//                 live measurements while this is set to "online".
//   DP 28  value  timer_on (h) — delayed start

const WORK_STATES = [
  'charger_free', 'charger_insert', 'charger_free_fault', 'charger_wait',
  'charger_charging', 'charger_pause', 'charger_end', 'charger_fault',
];

// Tuya's 8 work_state values → Homey's 5 standard evcharger_charging_state
// values. Tuya is more granular (it separates "waiting" from "finished" from
// "just plugged in"), so the raw value is additionally exposed through the
// ev_state_changed trigger and ev_state_is condition.
const STATE_MAP = {
  charger_free:       'plugged_out',
  charger_free_fault: 'plugged_out',
  charger_insert:     'plugged_in',
  charger_wait:       'plugged_in',
  charger_end:        'plugged_in',
  charger_fault:      'plugged_in',
  charger_charging:   'plugged_in_charging',
  charger_pause:      'plugged_in_paused',
};

const OPTIONAL_CAPABILITIES = [
  { setting: 'dp_charge_current',   capability: 'charge_current_limit'  },
  { setting: 'dp_fault',            capability: 'alarm_generic'         },
  { setting: 'dp_fault',            capability: 'fault_code'            },
  { setting: 'dp_connection_state', capability: 'ev_connection_state'   },
  { setting: 'dp_work_mode',        capability: 'ev_work_mode'          },
  { setting: 'dp_temperature',      capability: 'measure_temperature'   },
  { setting: 'dp_session_energy',   capability: 'charge_session_energy' },
  { setting: 'dp_timer_on',         capability: 'charge_delay_hours'    },
  // Phase B / C — only present on three-phase chargers
  { setting: 'dp_phase_b',          capability: 'measure_voltage.b'     },
  { setting: 'dp_phase_b',          capability: 'measure_current.b'     },
  { setting: 'dp_phase_b',          capability: 'measure_power.b'       },
  { setting: 'dp_phase_c',          capability: 'measure_voltage.c'     },
  { setting: 'dp_phase_c',          capability: 'measure_current.c'     },
  { setting: 'dp_phase_c',          capability: 'measure_power.c'       },
];

class EvChargerDevice extends BaseTuyaDevice {
  async onInit() {
    this.log('Device initialized:', this.getName());

    await this._baseInit();

    // Driver-specific state
    this._faultAlarmTimer      = null;
    this._faultAlarmConfirmed  = false;
    this._currentDebounceTimer = null;
    this._delayDebounceTimer   = null;
    // Raw Tuya work_state of the previous update — drives the detailed
    // state-changed trigger, which is finer-grained than Homey's 5-value
    // evcharger_charging_state. Seeded from the restored DPS cache so a restart
    // mid-session doesn't fire a spurious "session finished".
    this._prevWorkState = null;

    // Lifetime energy accumulated from session-energy (DP 25) deltas — used
    // only when dp_energy_total = 0 (charger's own counter unavailable/silent).
    this._energyAccum    = 0;
    this._lastSessionKwh = null;
    try {
      const stored = this.getStoreValue('energyAccum');
      if (typeof stored === 'number' && stored > 0) this._energyAccum = stored;
      const storedSession = this.getStoreValue('lastSessionKwh');
      if (typeof storedSession === 'number') this._lastSessionKwh = storedSession;
    } catch (e) {}

    await this._migrateCapabilities([]);
    await this._syncOptionalCapabilities(OPTIONAL_CAPABILITIES);
    await this._applyCurrentLimitRange();

    // Seed the previous raw state from the DPS cache restored by _baseInit, so a
    // restart during a charge doesn't look like a fresh state transition.
    const wsDp = this.getSetting('dp_work_state');
    if (wsDp > 0 && this._lastDps[String(wsDp)] !== undefined) {
      const cached = String(this._lastDps[String(wsDp)]);
      if (STATE_MAP[cached]) this._prevWorkState = cached;
    }

    if (this.getSetting('dp_energy_total') <= 0 && this._energyAccum > 0) {
      this.setCapabilityValue('meter_power.charged', Math.round(this._energyAccum * 100) / 100).catch(() => {});
    }

    // ── Flow trigger cards ──────────────────────────────────────────────────
    this._triggerDeviceConnected    = this.homey.flow.getDeviceTriggerCard('ev_device_connected');
    this._triggerDeviceDisconnected = this.homey.flow.getDeviceTriggerCard('ev_device_disconnected');
    this._triggerDpChanged          = this.homey.flow.getDeviceTriggerCard('ev_dp_changed');
    this._triggerChargingEnded      = this.homey.flow.getDeviceTriggerCard('ev_charging_ended');
    this._triggerStateChanged       = this.homey.flow.getDeviceTriggerCard('ev_state_changed');
    this._triggerFaultOn            = this.homey.flow.getDeviceTriggerCard('ev_fault_alarm_on');

    // ── Capability listeners ─────────────────────────────────────────────────
    this._registeredCaps = new Set();
    this._registerListeners();

    await this._connect();
  }

  /**
   * Register capability listeners for all currently present capabilities.
   * Safe to call repeatedly (from onSettings after _syncOptionalCapabilities).
   */
  _registerListeners() {
    const register = (capability, listener) => {
      if (!this.hasCapability(capability)) return;
      if (this._registeredCaps.has(capability)) return;
      this._registeredCaps.add(capability);
      this.registerCapabilityListener(capability, listener);
    };

    // evcharger_charging is Homey's standard charge on/off switch. Homey
    // generates the "Start/Stop charging" actions and "Is charging" condition
    // from it automatically — no custom flow cards needed for those.
    register('evcharger_charging', async (value) => {
      await this._set(this.getSetting('dp_switch'), Boolean(value));
    });

    // Current limit — debounced so slider drags don't flood the charger.
    register('charge_current_limit', (value) => {
      clearTimeout(this._currentDebounceTimer);
      return new Promise((resolve) => {
        this._currentDebounceTimer = setTimeout(async () => {
          const dp = this.getSetting('dp_charge_current');
          if (dp > 0) {
            const min  = this.getSetting('current_min') ?? 6;
            const max  = this.getSetting('current_max') ?? 16;
            const amps = Math.round(Math.max(min, Math.min(max, value)));
            await this._set(dp, amps).catch(() => {});
          }
          resolve();
        }, DEBOUNCE_MS);
      });
    });

    register('ev_work_mode', async (value) => {
      await this._set(this.getSetting('dp_work_mode'), String(value));
    });

    register('charge_delay_hours', (value) => {
      clearTimeout(this._delayDebounceTimer);
      return new Promise((resolve) => {
        this._delayDebounceTimer = setTimeout(async () => {
          const dp = this.getSetting('dp_timer_on');
          if (dp > 0) await this._set(dp, Math.round(value)).catch(() => {});
          resolve();
        }, DEBOUNCE_MS);
      });
    });
  }

  async _applyCurrentLimitRange() {
    if (!this.hasCapability('charge_current_limit')) return;
    const min = this.getSetting('current_min') ?? 6;
    const max = this.getSetting('current_max') ?? 16;
    if (max > min) {
      await this._setCapabilityOptionsIfChanged('charge_current_limit', { min, max, step: 1 })
        .catch(() => {});
    }
  }

  // ── Hook overrides ─────────────────────────────────────────────────────────

  _onConnected() {
    clearTimeout(this._faultAlarmTimer);
    this._faultAlarmTimer     = null;
    this._faultAlarmConfirmed = false;

    // Several chargers only stream live voltage/current/power while DP 27 is
    // set to "online". Re-assert it on every connect when the user enabled it.
    const dp = this.getSetting('dp_live_updates');
    if (dp > 0) {
      setTimeout(() => { this._set(dp, 'online').catch(() => {}); }, 2000);
    }
  }

  async _onDeleted() {
    clearTimeout(this._faultAlarmTimer);
    clearTimeout(this._currentDebounceTimer);
    clearTimeout(this._delayDebounceTimer);
    await this.setStoreValue('energyAccum', this._energyAccum).catch(() => {});
  }

  // ── Phase raw parsing ───────────────────────────────────────────────────────

  /**
   * Parses a phase DP (6 / 7 / 8), delivered by TuyAPI as a base64 string.
   *
   *   bytes 0-1  voltage ×0.1 V
   *   bytes 2-4  current ×0.001 A
   *   bytes 5+   power in W (3 bytes on most chargers, 2 bytes on the 7-byte
   *              variant used by Nine / Amperepoint / Noeifevo)
   *
   * Returns { voltage, current, power } or null when unparseable.
   */
  _parsePhase(rawValue) {
    try {
      const buf = Buffer.from(String(rawValue), 'base64');
      if (buf.length < 7) return null;

      const voltage = buf.readUInt16BE(0) * 0.1;
      const current = ((buf[2] << 16) | (buf[3] << 8) | buf[4]) * 0.001;
      // Power occupies whatever remains: 3 bytes (8-byte buffer) or 2 (7-byte).
      const power = buf.length >= 8
        ? ((buf[5] << 16) | (buf[6] << 8) | buf[7])
        : ((buf[5] << 8) | buf[6]);

      return { voltage, current, power };
    } catch (e) {
      return null;
    }
  }

  /** Writes a parsed phase to the given capability suffix ('' | '.b' | '.c'). */
  async _applyPhase(parsed, suffix) {
    const v = `measure_voltage${suffix}`;
    const c = `measure_current${suffix}`;
    const p = `measure_power${suffix}`;
    if (this.hasCapability(v)) {
      await this.setCapabilityValue(v, Math.round(parsed.voltage * 10) / 10).catch(() => {});
    }
    if (this.hasCapability(c)) {
      await this.setCapabilityValue(c, Math.round(parsed.current * 100) / 100).catch(() => {});
    }
    // Total power (DP 9) wins over per-phase power for the main measure_power
    // tile, so only write it here when no total-power DP is configured.
    if (this.hasCapability(p) && (suffix !== '' || this.getSetting('dp_power_total') <= 0)) {
      await this.setCapabilityValue(p, Math.round(parsed.power)).catch(() => {});
    }
  }

  // ── Session → lifetime energy ───────────────────────────────────────────────

  /**
   * DP 25 (session energy) is the fallback lifetime-energy source for chargers
   * whose own total counter (DP 1) never updates over the local connection.
   * Lifetime energy accumulates from positive session deltas; when the session
   * counter drops (new session), the baseline resets without adding.
   */
  async _handleSessionEnergy(kwh) {
    if (this.hasCapability('charge_session_energy')) {
      await this.setCapabilityValue('charge_session_energy', Math.round(kwh * 100) / 100).catch(() => {});
    }

    // Only accumulate when the charger's own lifetime counter isn't in use.
    if (this.getSetting('dp_energy_total') <= 0) {
      if (this._lastSessionKwh !== null && kwh > this._lastSessionKwh) {
        this._energyAccum += kwh - this._lastSessionKwh;
        this.setStoreValue('energyAccum', this._energyAccum).catch(() => {});
        await this.setCapabilityValue('meter_power.charged',
          Math.round(this._energyAccum * 100) / 100).catch(() => {});
      }
    }
    this._lastSessionKwh = kwh;
    this.setStoreValue('lastSessionKwh', kwh).catch(() => {});
  }

  // ── DPS handling ───────────────────────────────────────────────────────────

  async _handleDps(dps) {
    const settings = this.getSettings();
    let   changed  = false;

    for (const [dpStr, value] of Object.entries(dps)) {
      if (this._lastDps[dpStr] === value) continue;
      this._lastDps[dpStr] = value;
      changed = true;

      const dp = parseInt(dpStr, 10);

      this._triggerDpChanged
        .trigger(this, { dp: dpStr, value: String(value) })
        .catch(() => {});

      // ── Switch ───────────────────────────────────────────────────────────
      if (settings.dp_switch > 0 && dp === settings.dp_switch) {
        await this.setCapabilityValue('evcharger_charging', Boolean(value)).catch(() => {});
        continue;
      }

      // ── Work state ───────────────────────────────────────────────────────
      if (settings.dp_work_state > 0 && dp === settings.dp_work_state) {
        const state = String(value);
        const mapped = STATE_MAP[state];
        if (!mapped) {
          this._appLog(`work_state: unknown value "${state}" — expected one of ${WORK_STATES.join(', ')}`, 'warn');
          continue;
        }
        // prevRaw comes from _lastDps, which was already updated above — so read
        // the value captured before this loop iteration overwrote it.
        const prevRaw = this._prevWorkState ?? null;
        this._prevWorkState = state;

        await this.setCapabilityValue('evcharger_charging_state', mapped).catch(() => {});

        if (prevRaw !== null && prevRaw !== state) {
          this._triggerStateChanged.trigger(this, { state, prev_state: prevRaw }).catch(() => {});
          if (prevRaw === 'charger_charging'
              && ['charger_end', 'charger_pause', 'charger_free'].includes(state)) {
            const kwh = this.getCapabilityValue('charge_session_energy') ?? 0;
            this._triggerChargingEnded.trigger(this, { energy: kwh }).catch(() => {});
          }
        }
        continue;
      }

      // ── Charge current limit ─────────────────────────────────────────────
      if (settings.dp_charge_current > 0 && dp === settings.dp_charge_current) {
        if (this.hasCapability('charge_current_limit')) {
          await this.setCapabilityValue('charge_current_limit', Number(value)).catch(() => {});
        }
        continue;
      }

      // ── Total power (DP 9) / single-phase power (DP 5) ────────────────────
      if (settings.dp_power_total > 0 && dp === settings.dp_power_total) {
        await this.setCapabilityValue('measure_power', Math.round(Number(value))).catch(() => {});
        continue;
      }

      // ── Phases A / B / C ─────────────────────────────────────────────────
      const phaseSuffix = (settings.dp_phase_a > 0 && dp === settings.dp_phase_a) ? ''
        : (settings.dp_phase_b > 0 && dp === settings.dp_phase_b) ? '.b'
        : (settings.dp_phase_c > 0 && dp === settings.dp_phase_c) ? '.c'
        : null;
      if (phaseSuffix !== null) {
        const parsed = this._parsePhase(value);
        if (!parsed) {
          this._appLog(`phase${phaseSuffix || '_a'}: could not parse raw DP ${dp} value`, 'warn');
          continue;
        }
        await this._applyPhase(parsed, phaseSuffix);
        continue;
      }

      // ── Lifetime energy total (DP 1) ─────────────────────────────────────
      if (settings.dp_energy_total > 0 && dp === settings.dp_energy_total) {
        const kwh = Number(value) * 0.01;
        await this.setCapabilityValue('meter_power.charged', Math.round(kwh * 100) / 100).catch(() => {});
        continue;
      }

      // ── Session energy (DP 25) ───────────────────────────────────────────
      if (settings.dp_session_energy > 0 && dp === settings.dp_session_energy) {
        await this._handleSessionEnergy(Number(value) * 0.01);
        continue;
      }

      // ── Fault bitmap ─────────────────────────────────────────────────────
      if (settings.dp_fault > 0 && dp === settings.dp_fault) {
        const code    = Number(value) || 0;
        const isAlarm = code > 0;
        if (this.hasCapability('fault_code')) {
          await this.setCapabilityValue('fault_code', code).catch(() => {});
        }
        if (this.hasCapability('alarm_generic')) {
          const prevAlarm = this.getCapabilityValue('alarm_generic');
          await this.setCapabilityValue('alarm_generic', isAlarm).catch(() => {});

          if (!prevAlarm && isAlarm) {
            // Debounce reconnect artifacts before notifying.
            clearTimeout(this._faultAlarmTimer);
            this._faultAlarmConfirmed = false;
            this._faultAlarmTimer = setTimeout(() => {
              if (this.getCapabilityValue('alarm_generic') === true) {
                this._faultAlarmConfirmed = true;
                this._triggerFaultOn.trigger(this, { fault_code: code }).catch(() => {});
                this.homey.notifications.createNotification({
                  excerpt: `${this.getName()}: ${this.homey.__('notifications.faultAlarm')}`,
                }).catch(() => {});
              }
            }, 5000);
          }
          if (prevAlarm && !isAlarm) {
            clearTimeout(this._faultAlarmTimer);
            this._faultAlarmConfirmed = false;
          }
        }
        continue;
      }

      // ── Connection state (CP pilot) ──────────────────────────────────────
      if (settings.dp_connection_state > 0 && dp === settings.dp_connection_state) {
        if (this.hasCapability('ev_connection_state')) {
          await this.setCapabilityValue('ev_connection_state', String(value)).catch(() => {});
        }
        continue;
      }

      // ── Work mode ────────────────────────────────────────────────────────
      if (settings.dp_work_mode > 0 && dp === settings.dp_work_mode) {
        if (this.hasCapability('ev_work_mode')) {
          await this.setCapabilityValue('ev_work_mode', String(value)).catch((err) => {
            this._appLog(
              `work_mode: could not set "${value}". Many chargers report modes ` +
              `they don't implement — check DP 33 (mode_set) for the real list.`,
              'warn',
            );
          });
        }
        continue;
      }

      // ── Temperature ──────────────────────────────────────────────────────
      if (settings.dp_temperature > 0 && dp === settings.dp_temperature) {
        if (this.hasCapability('measure_temperature')) {
          await this.setCapabilityValue('measure_temperature', Number(value)).catch(() => {});
        }
        continue;
      }

      // ── Delayed start (h) ────────────────────────────────────────────────
      if (settings.dp_timer_on > 0 && dp === settings.dp_timer_on) {
        if (this.hasCapability('charge_delay_hours')) {
          await this.setCapabilityValue('charge_delay_hours', Number(value)).catch(() => {});
        }
        continue;
      }

      // Live-updates DP echoes back its own value — expected, not worth logging.
      if (settings.dp_live_updates > 0 && dp === settings.dp_live_updates) continue;

      this.log(`Unknown DP ${dp}:`, value);
    }

    if (changed) {
      this._scheduleStoreSave();
      this._writeDpSnapshot();
    }
  }

  // ── Public actions ──────────────────────────────────────────────────────────

  /** Called by the "ev_reset_energy" flow action. */
  async resetEnergy() {
    // Chargers that expose a clear-energy DP get the real command; otherwise
    // only the locally accumulated total is reset.
    const dp = this.getSetting('dp_clear_energy');
    if (dp > 0) {
      await this._set(dp, true).catch((err) =>
        this._appLog(`clear-energy command failed: ${err.message}`, 'warn'));
    }
    this._energyAccum    = 0;
    this._lastSessionKwh = null;
    await this.setStoreValue('energyAccum', 0).catch(() => {});
    await this.setStoreValue('lastSessionKwh', null).catch(() => {});
    if (this.getSetting('dp_energy_total') <= 0) {
      await this.setCapabilityValue('meter_power.charged', 0).catch(() => {});
    }
    this._appLog('Energy total reset', 'info');
  }

  // ── Homey lifecycle ────────────────────────────────────────────────────────

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
    if (changedKeys.some((k) => OPTIONAL_CAPABILITIES.map((o) => o.setting).includes(k))) {
      await this._syncOptionalCapabilities(OPTIONAL_CAPABILITIES);
      this._registerListeners(); // newly added capabilities need listeners immediately
    }
    if (changedKeys.some((k) => ['current_min', 'current_max'].includes(k))) {
      await this._applyCurrentLimitRange();
    }
  }
}

module.exports = EvChargerDevice;
