'use strict';

const BaseTuyaDevice = require('../../lib/BaseTuyaDevice');

// ── DP → capability mapping ──────────────────────────────────────────────────
// DP 3  manual_feed     : integer 1–50 (portions to dispense; Petlibro up to 50, others up to 12)
// DP 4  feed_state      : enum standby|feeding|no_food|error_ir|feed_timeout|(done)
// DP 14 fault           : bitfield  1=no_food  2=jammed  4=feed_timeout  8=battery_low
// DP 15 feed_report     : integer 0–50 (actual servings dispensed — report only)
// DP 16 surplus_grain   : integer 0–100 % (remaining food — report only)
// DP 102+/108+ food_level : non-standard enum full|low|empty (custom/legacy firmware, e.g. Petlibro DP 108)

const DP_PROFILE = [
  // feed_portions is an enum picker — device sends integers, we map to string IDs.
  // Guard against 0: some devices (e.g. Petlibro Granary) echo 0 for write-only DPs on connect.
  { settingKey: 'dp_portions',        capability: 'feed_portions',   transform: (v) => v > 0 ? String(v) : null, settable: true  },
  { settingKey: 'dp_motor_state',     capability: 'motor_state',     transform: (v) => String(v),       settable: false },
  { settingKey: 'dp_fault',           capability: 'alarm_generic',   transform: (v) => Number(v) > 0,   settable: false },
  { settingKey: 'dp_food_level',      capability: 'food_status',     transform: (v) => String(v),       settable: false },
  { settingKey: 'dp_surplus_grain',   capability: 'surplus_grain',   transform: (v) => Number(v),       settable: false },
  { settingKey: 'dp_feed_report',     capability: 'feed_report',     transform: (v) => Number(v),       settable: false },
  { settingKey: 'dp_child_lock',      capability: 'child_lock',      transform: (v) => Boolean(v),      settable: true  },
  // Battery percentage (0–100 %). Present on battery-powered feeders (e.g. Arlec 5L DP 11).
  // Disabled by default — most feeders are AC-powered.
  { settingKey: 'dp_battery',         capability: 'measure_battery', transform: (v) => Number(v),       settable: false },
  // ── New optional DPs ────────────────────────────────────────────────────────
  // DP 19  indicator_light : boolean — LED indicator on/off (settable)
  // DP 103 voice_playback  : boolean — mealtime recording on/off (settable)
  // DP 101 battery_status  : enum    — High/Medium/Low (report only)
  // DP 18  voice_times     : number  — recording repetitions (settable via device setting)
  // DP 106 manual_button_portions : number — portions per button press (settable via device setting)
  { settingKey: 'dp_indicator_light', capability: 'indicator_light', transform: (v) => Boolean(v),      settable: true  },
  { settingKey: 'dp_voice_playback',  capability: 'voice_playback',  transform: (v) => Boolean(v),      settable: true  },
  { settingKey: 'dp_battery_status',  capability: 'battery_status',  transform: (v) => String(v).toLowerCase(), settable: false },
];

// DPs that map to device settings (not capabilities) — written to device on settings change,
// and settings are updated when the device reports them.
const SETTINGS_DPS = [
  { settingKey: 'dp_voice_times',          valueSetting: 'voice_times',           transform: (v) => Number(v) },
  { settingKey: 'dp_manual_button_portions', valueSetting: 'manual_button_portions', transform: (v) => Number(v) },
];

const OPTIONAL_CAPABILITIES = [
  { setting: 'dp_motor_state',       capability: 'motor_state'      },
  { setting: 'dp_fault',             capability: 'alarm_generic'    },
  { setting: 'dp_food_level',        capability: 'food_status'      },
  { setting: 'dp_surplus_grain',     capability: 'surplus_grain'    },
  { setting: 'dp_feed_report',       capability: 'feed_report'      },
  { setting: 'dp_child_lock',        capability: 'child_lock'       },
  { setting: 'dp_battery',           capability: 'measure_battery'  },
  { setting: 'dp_indicator_light',   capability: 'indicator_light'  },
  { setting: 'dp_voice_playback',    capability: 'voice_playback'   },
  { setting: 'dp_battery_status',    capability: 'battery_status'   },
];

// A feed report arriving within this window after (re)connecting is the device
// restating its stored last feed, not a fresh one — firmware on protocol 3.4/3.5
// pushes its state asynchronously, so that restatement can arrive as a push.
// Triggering on it would fire "Feeding completed" on every app restart.
const FEED_REPORT_CONNECT_GRACE_MS = 15000;

// Devices that report both a terminal motor state and a feed report would fire the
// trigger twice for one feed. Whichever arrives first wins, the other is ignored.
const FEEDING_DONE_COOLDOWN_MS = 10000;
// Ein Fuetterungsbefehl so kurz nach dem Verbinden wird als Warnung protokolliert -
// siehe _meldeFuetterung.
const FUETTERUNG_NACH_VERBINDEN_MS = 5000;

class PetFeederDevice extends BaseTuyaDevice {
  async onInit() {
    this.log('Device initialized:', this.getName());

    await this._baseInit();

    // ── Migrate feed_portions: number/slider → enum/picker ───────────────────
    // If the old capability options contain a numeric 'min' key it was the legacy
    // slider type — remove and re-add so Homey registers it as an enum.
    if (this.hasCapability('feed_portions')) {
      let opts = {};
      try { opts = this.getCapabilityOptions('feed_portions') ?? {}; } catch (_) {}
      if (opts.min !== undefined) {
        this.log('Migrating feed_portions: slider → picker');
        await this.removeCapability('feed_portions').catch(() => {});
        await this.addCapability('feed_portions').catch(() => {});
      }
    }

    await this._syncOptionalCapabilities(OPTIONAL_CAPABILITIES);
    await this._syncPortionsRange();

    // ── Flow trigger cards ───────────────────────────────────────────────────
    this._triggerFoodLevelChanged    = this.homey.flow.getDeviceTriggerCard('feeder_food_level_changed');
    this._triggerFeedingDone         = this.homey.flow.getDeviceTriggerCard('feeder_feeding_done');
    this._triggerDeviceConnected     = this.homey.flow.getDeviceTriggerCard('feeder_device_connected');
    this._triggerDeviceDisconnected  = this.homey.flow.getDeviceTriggerCard('feeder_device_disconnected');
    this._triggerDpChanged           = this.homey.flow.getDeviceTriggerCard('feeder_dp_changed');

    // Ohne diese Zuordnung schreibt _applyCapability nur den Wert; mit ihr
    // meldet es zusaetzlich einen echten Wechsel an die Flow-Karte.
    this._registerChangeTriggers({
      child_lock: 'feeder_child_lock_changed',
    });

    // ── Capability listeners ─────────────────────────────────────────────────
    // Registered through a helper so that a capability switched on later — by
    // pointing its DP setting at a number — becomes controllable at once. Without
    // that, the tile appears and taps do nothing until the app is restarted.
    this._registeredCaps = new Set();
    this._portionsResetTimer = null;
    this._registerListeners();

    await this._connect();
  }

  /** Idempotent: skips capabilities already wired, which Homey would reject. */
  _registerListeners() {
    const register = (capability, listener) => {
      if (!this.hasCapability(capability)) return;
      if (this._registeredCaps.has(capability)) return;
      this._registeredCaps.add(capability);
      this.registerCapabilityListener(capability, listener);
    };

    for (const entry of DP_PROFILE) {
      if (!entry.settable) continue;

      if (entry.capability === 'feed_portions') {
        // Non-persistent: after a manual feed command is sent, reset the picker
        // back to portions_min so the UI is ready for the next feed. The reset is
        // delayed 3 s to let the device process the command first. The capability is
        // an enum — values are strings; send as Number to the device.
        register('feed_portions', async (value) => {
          this._meldeFuetterung(Number(value), 'the portions picker (the tile, the Homey app, a voice '
            + 'assistant, or a flow that sets the picker)');
          await this._set(this.getSetting('dp_portions'), Number(value));
          this._portionenZuruecksetzen();
        });
      } else {
        register(entry.capability, async (value) => {
          await this._set(this.getSetting(entry.settingKey), value);
        });
      }
    }
  }

  async _onDeleted() {
    clearTimeout(this._portionsResetTimer);
  }

  _onConnected() {
    this._connectedAt = Date.now();
  }

  /**
   * Fires the "Feeding completed" trigger, suppressing a second call for the same
   * feed. `portions` is the number of servings dispensed where the device reports
   * it, 0 where only a motor state was available.
   */
  _fireFeedingDone(portions, source) {
    const now = Date.now();
    if (this._lastFeedingDoneAt && now - this._lastFeedingDoneAt < FEEDING_DONE_COOLDOWN_MS) {
      this.log(`Feeding completed (${source}) ignored — already reported ${now - this._lastFeedingDoneAt} ms ago`);
      return;
    }
    this._lastFeedingDoneAt = now;
    this.log(`Feeding completed (${source}), portions: ${portions}`);
    this._triggerFeedingDone.trigger(this, { portions }).catch(() => {});
  }

  // ── DPS handling ─────────────────────────────────────────────────────────────

  async _handleDps(dps, meta = {}) {
    const settings = this.getSettings();
    let   changed  = false;

    // ── Feeding completed, detected from the feed report (DP 15) ────────────────
    // Some feeders never leave "standby" on DP 4 and never send the spec's "done"
    // state, so the motor-state path below never fires on them. What they do send is
    // an unsolicited report of the servings actually dispensed, once per feed.
    //
    // That report cannot be detected by comparing values: two feeds of 2 servings
    // report 2 and then 2 again, which the unchanged-DP skip further down discards.
    // Nor can it be detected by mere arrival, because every poll reply restates the
    // last value. What identifies a feed is the *unsolicited* arrival of a non-zero
    // report — hence isPush, and hence this block sitting above the skip.
    const feedReportDp = settings.dp_feed_report;
    if (meta.isPush && feedReportDp > 0 && Object.prototype.hasOwnProperty.call(dps, String(feedReportDp))) {
      const portions = Number(dps[String(feedReportDp)]);
      if (portions > 0) {
        const sinceConnect = this._connectedAt ? Date.now() - this._connectedAt : Infinity;
        if (sinceConnect < FEED_REPORT_CONNECT_GRACE_MS) {
          this.log(`Feed report ${portions} ignored — arrived ${sinceConnect} ms after connect (stored state, not a fresh feed)`);
        } else {
          this._fireFeedingDone(portions, `DP ${feedReportDp} push`);
        }
      }
    }

    for (const [dpStr, value] of Object.entries(dps)) {
      if (this._lastDps[dpStr] === value) continue;
      this._lastDps[dpStr] = value;
      changed = true;

      const dp = parseInt(dpStr, 10);

      this._triggerDpChanged
        .trigger(this, { dp: dpStr, value: String(value) })
        .catch(() => {});

      // ── Settings-backed DPs (voice_times, manual_button_portions) ──────────
      // These DPs map to device settings, not capabilities — handle before DP_PROFILE lookup.
      const settingsDp = SETTINGS_DPS.find((s) => {
        const dpNum = settings[s.settingKey];
        return dpNum > 0 && dp === dpNum;
      });
      if (settingsDp) {
        await this.setSettings({ [settingsDp.valueSetting]: settingsDp.transform(value) }).catch(() => {});
        continue;
      }

      const entry = DP_PROFILE.find((e) => {
        const dpNum = settings[e.settingKey];
        return dpNum > 0 && dp === dpNum;
      });

      if (!entry) {
        this.log(`Unknown DP ${dp}:`, value);
        continue;
      }

      const converted = entry.transform(value);

      // ── Fault (DP 14: bitfield 1=no_food 2=jammed 4=feed_timeout 8=battery_low) ──
      if (entry.capability === 'alarm_generic') {
        // Which fault, not just that there is one — see _recordFault.
        this._recordFault(value);
        await this.setCapabilityValue('alarm_generic', converted).catch(() => {});
        continue;
      }

      // ── Motor / feed state (DP 4) ────────────────────────────────────────
      if (entry.capability === 'motor_state') {
        const prev = this.getCapabilityValue('motor_state');
        await this.setCapabilityValue('motor_state', converted).catch(() => {});

        // Feeding done:
        //   • "done"    — Tuya spec terminal state (some firmwares)
        //   • standby ← feeding — iPettie / Petlibro W5 (no "done" state on this device)
        //   Ignore standby ← no_food / error_ir / feed_timeout (error paths, not successful feed)
        const feedingComplete =
          converted === 'done' ||
          (converted === 'standby' && prev === 'feeding');
        if (feedingComplete) {
          // Dieselbe Schonfrist wie beim Rueckmeldeweg darueber, und aus demselben
          // Grund — nur faellt sie hier staerker ins Gewicht.
          //
          // prev kommt aus der Faehigkeit, und Homey bewahrt Faehigkeitswerte ueber
          // einen Neustart. Endete der letzte App-Lauf, waehrend dort "feeding"
          // stand, dann ist der erste "standby" nach dem Verbinden zwangslaeufig ein
          // Uebergang von feeding auf standby — obwohl das Geraet nur seinen
          // tatsaechlichen Zustand nennt. Gemeldet wurde daraufhin eine
          // abgeschlossene Fuetterung, jedes Mal beim Starten der App.
          //
          // Der Wert wird trotzdem eingetragen: falsch ist die Meldung, nicht der
          // Zustand.
          const seitVerbindung = this._connectedAt ? Date.now() - this._connectedAt : Infinity;
          if (seitVerbindung < FEED_REPORT_CONNECT_GRACE_MS) {
            this.log(`Feeding completed (DP ${dp} = ${converted}) ignored — arrived `
              + `${seitVerbindung} ms after connect, where the previous state is whatever `
              + 'was left over from the last run rather than something just observed');
          } else {
            // The portions token is only known when the device also reports a feed
            // count; 0 means "this device does not say how much it dispensed".
            const reported = this.hasCapability('feed_report')
              ? Number(this.getCapabilityValue('feed_report')) || 0
              : 0;
            this._fireFeedingDone(reported, `DP ${dp} = ${converted}`);
          }
        }

        // "no_food" means the motor tried to run but the hopper was empty.
        // Treat it the same as a food-empty condition and notify the user —
        // even if no separate food_status DP is configured.
        if (converted === 'no_food') {
          this.homey.notifications.createNotification({
            excerpt: `${this.getName()}: ${this.homey.__('notifications.foodEmpty')}`,
          }).catch(() => {});
          // Also fire the food-level-changed trigger so flows can react.
          this._triggerFoodLevelChanged
            .trigger(this, { food_status: 'empty', prev_status: prev || 'full' })
            .catch(() => {});
        }
        continue;
      }

      // ── Custom food-level DP (non-standard, e.g. DP 101/102) ────────────
      if (entry.capability === 'food_status') {
        const prev = this.getCapabilityValue('food_status');
        await this.setCapabilityValue('food_status', converted).catch(() => {});
        if (prev !== converted) {
          this._triggerFoodLevelChanged
            .trigger(this, { food_status: converted, prev_status: prev || 'full' })
            .catch(() => {});

          const emptyValues = (this.getSetting('food_empty_values') || 'low,empty')
            .split(',').map((s) => s.trim().toLowerCase());
          const wasEmpty   = emptyValues.includes((prev || '').toLowerCase());
          const isNowEmpty = emptyValues.includes(converted.toLowerCase());
          if (isNowEmpty && !wasEmpty) {
            this.homey.notifications.createNotification({
              excerpt: `${this.getName()}: ${this.homey.__('notifications.foodEmpty')}`,
            }).catch(() => {});
          }
        }
        continue;
      }

      await this._applyCapability(entry.capability, converted);
    }

    if (changed) {
      this._scheduleStoreSave();
      this._writeDpSnapshot();
    }
  }

  // ── Homey lifecycle ──────────────────────────────────────────────────────────

  // ── Portions picker range ────────────────────────────────────────────────────
  /**
   * Schreibt jeden Fuetterungsbefehl ins Protokoll, mit dem Weg, auf dem er kam.
   *
   * Gemeldet: der Futterautomat fuetterte bei jedem Verbindungsaufbau - nach einem
   * Update, einem Neustart, einer geaenderten Einstellung. Die Verbindungsspur zeigte,
   * dass 30 ms nach "verbunden" ein Befehl fuer eine Portion hinausging; die App selbst
   * sendet beim Verbinden nie einen. Ein Befehl an die Fuetterung kommt nur ueber die
   * Flow-Karte "Jetzt fuettern" oder ueber die Portionen-Auswahl, und welcher von beiden
   * es war, stand nirgends. Jetzt steht es im Protokoll und im Support-Bericht, mit dem
   * Abstand zum Verbindungsaufbau - so kurz danach als Warnung.
   *
   * @param {number} portionen
   * @param {string} weg  Wie der Befehl kam, als Teil des Satzes.
   */
  _meldeFuetterung(portionen, weg) {
    const seit = this._connectedAt ? Date.now() - this._connectedAt : null;
    const dauer = (ms) => (ms < 10000 ? `${ms} ms`
      : ms < 120000 ? `${Math.round(ms / 1000)} s`
        : ms < 7200000 ? `${Math.round(ms / 60000)} min`
          : `${Math.round(ms / 3600000)} h`);
    const kurz = seit !== null && seit < FUETTERUNG_NACH_VERBINDEN_MS;
    this._appLog(`Feed command: ${portionen} portion${portionen === 1 ? '' : 's'} via ${weg}`
      + (seit !== null ? `, ${dauer(seit)} after connecting` : '')
      + (kurz ? ' - right after the connection came up. A flow that starts when the feeder '
        + 'connects would do exactly this.' : ''),
    kurz ? 'warn' : 'info', true);
  }

  /** Die Auswahl nach einer Fuetterung zurueck auf portions_min, nach 3 s. */
  _portionenZuruecksetzen() {
    clearTimeout(this._portionsResetTimer);
    this._portionsResetTimer = setTimeout(() => {
      const resetTo = String(this.getSetting('portions_min') ?? 1);
      this.setCapabilityValue('feed_portions', resetTo).catch(() => {});
    }, 3000);
  }

  /**
   * "Jetzt fuettern" aus der Flow-Karte.
   *
   * Die Karte erlaubt 1 bis 50 Portionen, die Auswahl der Kachel nur portions_min bis
   * portions_max (Vorgabe 1 bis 12). Die Karte setzte zuerst die Kachel und loeste dann
   * deren Listener aus; einen Wert ausserhalb der Auswahl lehnte Homey ab, bevor etwas ans
   * Geraet ging, und der Flow scheiterte mit einer Meldung, die nichts erklaerte. Jetzt wird
   * gegen die Einstellungen geprueft - mit einer Meldung, die sagt, was zu tun ist - und
   * direkt gesendet. Die Kachel zeigt den Wert nur, wenn er in ihrer Auswahl steht.
   *
   * @param {number} portionen
   */
  async feedNow(portionen) {
    const n   = Math.round(Number(portionen));
    const min = Number(this.getSetting('portions_min') ?? 1);
    const max = Number(this.getSetting('portions_max') ?? 12);
    if (!Number.isFinite(n) || n < 1) throw new Error(`"${portionen}" is not a number of portions`);
    if (n > max) {
      throw new Error(`${n} portions is above the maximum set for this feeder (${max}). If it can `
        + 'dispense more, raise "Portions \u2014 maximum" in the device settings.');
    }
    if (n < min) {
      throw new Error(`${n} portions is below the minimum set for this feeder (${min}) - see `
        + '"Portions \u2014 minimum" in the device settings.');
    }
    const dp = this.getSetting('dp_portions');
    if (!(dp > 0)) {
      throw new Error('No data point set for portions (dp_portions is 0) - set it in the device settings');
    }
    this._meldeFuetterung(n, 'the "Feed now" flow card');
    await this._set(dp, n);
    if (this.hasCapability('feed_portions')) {
      await this.setCapabilityValue('feed_portions', String(n)).catch(() => {});
      this._portionenZuruecksetzen();
    }
    return true;
  }

  // Builds enum values from portions_min..portions_max so the picker only shows
  // the entries that the device actually supports.

  async _syncPortionsRange() {
    const min = this.getSetting('portions_min') ?? 1;
    const max = this.getSetting('portions_max') ?? 12;
    const values = [];
    for (let i = min; i <= max; i++) {
      const s = String(i);
      values.push({ id: s, title: { en: s, de: s } });
    }
    try {
      const changed = await this._setCapabilityOptionsIfChanged('feed_portions', { values });
      this.log(`feed_portions picker → ${min}–${max} (${values.length} options)`);
    } catch (err) {
      this.log('setCapabilityOptions(feed_portions) failed:', err.message);
    }
  }

  async onSettings({ changedKeys, newSettings }) {
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
      this._registerListeners(); // newly added capabilities need listeners immediately
    }
    if (changedKeys.includes('portions_min') || changedKeys.includes('portions_max')) {
      await this._syncPortionsRange();
    }

    // ── Write settings-backed DPs to device when value changes ───────────────
    for (const entry of SETTINGS_DPS) {
      if (!changedKeys.includes(entry.valueSetting)) continue;
      const dp = newSettings[entry.settingKey] ?? this.getSetting(entry.settingKey);
      if (dp > 0) {
        await this._set(dp, newSettings[entry.valueSetting]).catch((err) => {
          this.log(`Failed to write ${entry.valueSetting} to DP ${dp}:`, err.message);
        });
      }
    }
  }
}

module.exports = PetFeederDevice;
