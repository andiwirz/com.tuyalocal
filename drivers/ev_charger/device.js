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

// Control-pilot states that mean the charger is actively supplying current.
// Per the CP standard, 9 V = vehicle connected and 6 V = vehicle ready, while the
// PWM suffix means the charger is signalling an available current — i.e. a charge
// is under way. Used to correct work_state on chargers that leave it at
// "charger_end" for the whole session (observed on SS_V1.x firmware).
const CP_CHARGING = new Set(['controlpi_9v_pwm', 'controlpi_6v_pwm']);

const OPTIONAL_CAPABILITIES = [
  { setting: 'dp_charge_current',   capability: 'target_power'          },
  { setting: 'dp_fault',            capability: 'alarm_generic'         },
  { setting: 'dp_fault',            capability: 'fault_code'            },
  { setting: 'dp_connection_state', capability: 'ev_connection_state'   },
  { setting: 'dp_work_mode',        capability: 'ev_work_mode'          },
  { setting: 'dp_temperature',      capability: 'measure_temperature'   },
  { setting: 'dp_session_energy',   capability: 'charge_session_energy' },
  { setting: 'dp_timer_on',         capability: 'charge_delay_hours'    },
  // Voltage and current come only from the packed phase DP. measure_power is
  // deliberately not optional — the SDK expects it on an EV charger, and the
  // "estimate" energy source can populate it without a power DP.
  { setting: 'dp_phase_a',          capability: 'measure_voltage'       },
  { setting: 'dp_phase_a',          capability: 'measure_current'       },
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

    // Accumulated lifetime energy. Which source feeds it is chosen by the
    // energy_source setting — see _handleSessionEnergy and _onPollTick.
    this._energyAccum    = 0;
    this._lastSessionKwh = null;
    try {
      const stored = this.getStoreValue('energyAccum');
      if (typeof stored === 'number' && stored > 0) this._energyAccum = stored;
      const storedSession = this.getStoreValue('lastSessionKwh');
      if (typeof storedSession === 'number') this._lastSessionKwh = storedSession;
    } catch (e) {}

    // Power integration state (energy_source = power | estimate)
    this._lastPowerTime      = null; // timestamp of the previous integration step
    this._lastPowerWatts     = 0;    // most recent power reading or estimate
    this._prevTickPowerWatts = 0;    // power at the previous step, for trapezoidal averaging

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

    // target_power is Homey's standard charge-power control (watts) and is what
    // its energy management steers — e.g. solar-surplus charging. The charger
    // itself only accepts a current limit in amps, so watts are converted here.
    //
    // Homey clamps to min/max and snaps values inside the exclude range to 0
    // before the listener runs, so 0 here genuinely means "idle". These chargers
    // have no 0 A setting: idling is done by stopping the charge instead.
    // Debounced because Homey may adjust target_power frequently.
    register('target_power', (value) => {
      clearTimeout(this._currentDebounceTimer);
      return new Promise((resolve) => {
        this._currentDebounceTimer = setTimeout(async () => {
          const dp = this.getSetting('dp_charge_current');
          if (dp > 0) {
            const watts = Number(value) || 0;
            if (watts <= 0) {
              // Idle request — stop charging rather than writing an invalid 0 A.
              await this._set(this.getSetting('dp_switch'), false).catch(() => {});
            } else {
              await this._set(dp, this._wattsToRawCurrent(watts)).catch(() => {});
            }
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

  // ── Power ⇄ current conversion ──────────────────────────────────────────────
  // The charger speaks amps (DP 4); Homey's target_power speaks watts.
  //   W = A × V × phases

  /** Watts per amp for this installation (voltage × phase count). */
  _wattsPerAmp() {
    const volts  = this.getSetting('nominal_voltage') ?? 230;
    const phases = parseInt(this.getSetting('phase_count') ?? '1', 10) || 1;
    return volts * phases;
  }

  /**
   * Multiplier turning a raw DP value into its real-world unit. Chargers are not
   * consistent here: most report the current limit as plain amps and energy in
   * hundredths of a kWh, but some scale the current by ten, and the session and
   * lifetime counters can even use different scales on the same unit — hence one
   * setting per DP rather than one shared assumption.
   */
  _scaleOf(settingKey, fallback) {
    const v = parseFloat(this.getSetting(settingKey));
    return Number.isFinite(v) && v > 0 ? v : fallback;
  }

  /** Convert a target power in watts to the raw value the charger expects on its current DP. */
  _wattsToRawCurrent(watts) {
    const min  = this.getSetting('current_min') ?? 6;
    const max  = this.getSetting('current_max') ?? 16;
    const amps = Math.max(min, Math.min(max, Math.round(watts / this._wattsPerAmp())));
    return Math.round(amps / this._scaleOf('current_scale', 1));
  }

  /**
   * Keep target_power's slider range in step with the configured hardware limits.
   *
   * min is 0 so the device can always idle (required by the SDK), and the
   * exclude range covers everything below the charger's minimum current — Homey
   * snaps requests inside it to 0 instead of asking for an impossible current.
   */
  async _applyCurrentLimitRange() {
    if (!this.hasCapability('target_power')) return;
    const wPerA = this._wattsPerAmp();
    const min   = this.getSetting('current_min') ?? 6;
    const max   = this.getSetting('current_max') ?? 16;
    if (max <= min) return;
    await this._setCapabilityOptionsIfChanged('target_power', {
      min:        0,
      max:        max * wPerA,
      step:       wPerA, // one amp
      excludeMin: 0,
      excludeMax: min * wPerA,
    }).catch(() => {});
  }

  // ── Hook overrides ─────────────────────────────────────────────────────────

  _onConnected() {
    clearTimeout(this._faultAlarmTimer);
    this._faultAlarmTimer     = null;
    this._faultAlarmConfirmed = false;
    // Drop the integration baseline: time spent offline must not be counted as
    // charging time on the next tick.
    this._lastPowerTime       = null;
    this._prevTickPowerWatts  = 0;

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

    // Only accumulate here when the session counter is the chosen source and the
    // charger's own lifetime counter isn't in use.
    if (this._energySource() === 'session' && this.getSetting('dp_energy_total') <= 0) {
      if (this._lastSessionKwh !== null && kwh > this._lastSessionKwh) {
        this._energyAccum += kwh - this._lastSessionKwh;
        await this._writeTotalEnergy();
      }
    }
    this._lastSessionKwh = kwh;
    this.setStoreValue('lastSessionKwh', kwh).catch(() => {});
  }

  /** Which source feeds meter_power.charged. */
  _energySource() {
    return this.getSetting('energy_source') || 'session';
  }

  /**
   * Writes evcharger_charging_state from the three signals the charger provides.
   *
   * work_state alone is not dependable: some firmware reports "charger_end" for
   * the entire session, which would leave the tile stuck on "Plugged in" while
   * the car is charging. So when work_state claims the charge is merely plugged
   * in, but the charge switch is on and the control pilot shows an active PWM
   * signal, the charging state is reported instead. Called from the work_state,
   * switch and connection_state handlers, since any of them can change first.
   */
  async _updateChargingState() {
    const raw = this._prevWorkState;
    if (!raw) return;
    let state = STATE_MAP[raw];
    if (!state) return;

    if (state === 'plugged_in'
        && this.getCapabilityValue('evcharger_charging') === true
        && CP_CHARGING.has(this._lastConnState)) {
      state = 'plugged_in_charging';
    }
    await this.setCapabilityValue('evcharger_charging_state', state).catch(() => {});
  }

  async _writeTotalEnergy() {
    this.setStoreValue('energyAccum', this._energyAccum).catch(() => {});
    await this.setCapabilityValue('meter_power.charged',
      Math.round(this._energyAccum * 1000) / 1000).catch(() => {});
  }

  /**
   * Best guess at the current charging power in watts, for chargers that report
   * no usable power DP. While charging, these units draw essentially the current
   * limit that was set, so limit × voltage × phases is a fair approximation —
   * it is an estimate, not a measurement, and only used when explicitly selected.
   */
  _estimatedWatts() {
    if (this.getCapabilityValue('evcharger_charging') !== true) return 0;
    const target = this.getCapabilityValue('target_power');
    if (typeof target === 'number' && target > 0) return target;
    // No target known yet — fall back to the configured maximum current.
    return (this.getSetting('current_max') ?? 16) * this._wattsPerAmp();
  }

  /**
   * Trapezoidal energy integration, mirroring the Smart Plug driver. Runs on the
   * poll timer so that steady power still accumulates even though an unchanged DP
   * value is filtered out before it reaches _handleDps.
   */
  async _onPollTick() {
    const source = this._energySource();
    if (source !== 'power' && source !== 'estimate') return;

    const watts = source === 'estimate'
      ? this._estimatedWatts()
      : (this.getCapabilityValue('measure_power') ?? 0);

    if (source === 'estimate' && this.hasCapability('measure_power')) {
      await this.setCapabilityValue('measure_power', Math.round(watts)).catch(() => {});
    }
    this._lastPowerWatts = watts;

    if (this._lastPowerTime === null) {
      // First tick only establishes the baseline — nothing to integrate yet.
      this._lastPowerTime      = Date.now();
      this._prevTickPowerWatts = watts;
      return;
    }

    const now      = Date.now();
    const elapsedH = (now - this._lastPowerTime) / 3_600_000;
    // Cap at twice the poll interval so a long outage cannot produce a huge jump.
    const maxH     = (this._pollIntervalMs * 2) / 3_600_000;
    if (elapsedH > 0 && elapsedH < maxH) {
      const avgWatts = (this._prevTickPowerWatts + watts) / 2;
      if (avgWatts > 0) {
        this._energyAccum += (avgWatts * elapsedH) / 1000;
        await this._writeTotalEnergy();
      }
    }
    this._prevTickPowerWatts = watts;
    this._lastPowerTime      = now;
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
        await this._updateChargingState();
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

        await this._updateChargingState();

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

      // ── Charge current limit → target_power (A → W) ───────────────────────
      // The charger may clamp what we asked for, so mirror back what it reports.
      // Clamped to the slider's own maximum: a charger reporting more amps than
      // current_max would otherwise produce a value the capability rejects.
      if (settings.dp_charge_current > 0 && dp === settings.dp_charge_current) {
        if (this.hasCapability('target_power')) {
          const amps    = Number(value) * this._scaleOf('current_scale', 1);
          const maxAmps = settings.current_max ?? 16;
          const watts   = Math.min(amps, maxAmps) * this._wattsPerAmp();
          await this.setCapabilityValue('target_power', watts).catch(() => {});
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
        const kwh = Number(value) * this._scaleOf('total_energy_scale', 0.01);
        await this.setCapabilityValue('meter_power.charged', Math.round(kwh * 100) / 100).catch(() => {});
        continue;
      }

      // ── Session energy (DP 25) ───────────────────────────────────────────
      if (settings.dp_session_energy > 0 && dp === settings.dp_session_energy) {
        await this._handleSessionEnergy(Number(value) * this._scaleOf('session_energy_scale', 0.01));
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
        this._lastConnState = String(value);
        if (this.hasCapability('ev_connection_state')) {
          await this.setCapabilityValue('ev_connection_state', this._lastConnState).catch(() => {});
        }
        await this._updateChargingState();
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
    if (changedKeys.some((k) => ['current_min', 'current_max', 'phase_count', 'nominal_voltage'].includes(k))) {
      await this._applyCurrentLimitRange();
    }
    // A corrected scale changes how existing readings should be interpreted, so
    // pull fresh values rather than leaving the old ones on screen.
    if (changedKeys.some((k) => ['current_scale', 'session_energy_scale', 'total_energy_scale'].includes(k))) {
      this._lastDps = {}; // clear dedup so the next poll re-applies every DP
      this.pollNow().catch(() => {});
    }
    if (changedKeys.includes('energy_source')) {
      // Restart integration cleanly; the accumulated total is deliberately kept.
      this._lastPowerTime      = null;
      this._prevTickPowerWatts = 0;
      this._appLog(`Energy source changed to "${this._energySource()}"`, 'info');
    }
  }
}

module.exports = EvChargerDevice;
