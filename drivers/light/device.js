'use strict';

const BaseTuyaDevice = require('../../lib/BaseTuyaDevice');

const DEBOUNCE_MS = 200;

// ── HSV hex helpers ──────────────────────────────────────────────────────────
// Tuya color format: 12-char hex string HHHHSSSSBBBB
//   H: 0–360 (2 bytes), S: 0–1000 (2 bytes), V/B: 0–1000 (2 bytes)

function parseColorHex(hex) {
  if (typeof hex !== 'string' || hex.length < 12) return null;
  const h = parseInt(hex.slice(0, 4), 16);
  const s = parseInt(hex.slice(4, 8),  16);
  const v = parseInt(hex.slice(8, 12), 16);
  if (Number.isNaN(h) || Number.isNaN(s) || Number.isNaN(v)) return null;
  return { h, s, v };
}

function buildColorHex(h, s, v) {
  const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, Math.round(n)));
  return clamp(h, 0, 360) .toString(16).padStart(4, '0') +
         clamp(s, 0, 1000).toString(16).padStart(4, '0') +
         clamp(v, 0, 1000).toString(16).padStart(4, '0');
}

// ── Farbblock (paint_colour_data) ────────────────────────────────────────────
// RGBIC-Streifen ("dreamlight", einzeln ansteuerbare LEDs) nehmen Farbe und Helligkeit
// nicht ueber colour_data (DP 24), sondern ueber einen Rohblock, meist DP 61. Ein
// gemeldeter Streifen liess DP 24 bei Rot, Gruen, Blau, Weiss und 10 % unveraendert
// stehen; geaendert hat sich nur dieser Block, 11 Byte:
//
//   00 01 00 14 00 | HH HH | SS SS | VV VV
//
// H 0-360, S und V 0-1000 - dieselben Skalen wie im Hex-String. Weiss ist hier kein
// eigener Modus, sondern S = 0; work_mode blieb dabei "colour". Was die ersten fuenf
// Byte bedeuten, ist nicht bekannt - sie waren auf zwei Streifen mit 83 und 200 LEDs
// gleich. Sie werden darum aus dem zuletzt gemeldeten Block uebernommen, nie erfunden.

const BLOCK_KOPF   = 5;
const BLOCK_LAENGE = BLOCK_KOPF + 6;

function parseFarbblock(wert) {
  if (typeof wert !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(wert)) return null;
  const b = Buffer.from(wert, 'base64');
  if (b.length !== BLOCK_LAENGE) return null;
  return {
    kopf: b.subarray(0, BLOCK_KOPF),
    h: b.readUInt16BE(BLOCK_KOPF),
    s: b.readUInt16BE(BLOCK_KOPF + 2),
    v: b.readUInt16BE(BLOCK_KOPF + 4),
  };
}

function baueFarbblock(kopf, h, s, v) {
  const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, Math.round(n)));
  const b = Buffer.alloc(BLOCK_LAENGE);
  Buffer.from(kopf).copy(b, 0, 0, BLOCK_KOPF);
  b.writeUInt16BE(clamp(h, 0, 360),  BLOCK_KOPF);
  b.writeUInt16BE(clamp(s, 0, 1000), BLOCK_KOPF + 2);
  b.writeUInt16BE(clamp(v, 0, 1000), BLOCK_KOPF + 4);
  return b.toString('base64');
}

// Scale a raw Tuya brightness value (0–max) → Homey dim (0–1)
function rawToDim(raw, max) {
  return Math.max(0, Math.min(1, raw / max));
}
function dimToRaw(dim, max) {
  return Math.round(Math.max(0, Math.min(1, dim)) * max);
}

class LightDevice extends BaseTuyaDevice {
  async onInit() {
    this.log('Device initialized:', this.getName());

    await this._baseInit();

    // Pending color components — accumulate partial updates then flush.
    this._pendingH = null;
    this._pendingS = null;
    this._pendingV = null;

    await this._migrateCapabilities([]);
    await this._syncLightCapabilities();
    // measure_power entsteht nur, wenn eine feste Wattzahl eingetragen ist - bei 0
    // bleibt das Geraet, wie es war.
    await this._syncOptionalCapabilities([
      { setting: 'power_on_watts', capability: 'measure_power' },
    ]);
    await this._applyFixedPower();

    // ── Flow trigger cards ───────────────────────────────────────────────────
    this._triggerDeviceConnected    = this.homey.flow.getDeviceTriggerCard('light_device_connected');
    this._triggerDeviceDisconnected = this.homey.flow.getDeviceTriggerCard('light_device_disconnected');
    this._triggerDpChanged          = this.homey.flow.getDeviceTriggerCard('light_dp_changed');

    // ── Capability listeners ─────────────────────────────────────────────────
    this.registerCapabilityListener('onoff', async (value) => {
      const dp = this.getSetting('dp_onoff');
      if (dp > 0) await this._set(dp, value);
      // Der Zustand wird mitgegeben: Homey uebernimmt ihn erst, wenn dieser Listener
      // aufgeloest hat, die Faehigkeit traegt hier also noch den alten Wert. Ohne das
      // haengt die gemeldete Leistung eine Schaltung hinterher, bis das Geraet den DP
      // von sich aus zurueckmeldet - und mit fire_and_forget kann das ausbleiben.
      await this._applyFixedPower(Boolean(value));
    });

    this._dimTimer = null;
    this.registerCapabilityListener('dim', (value) => {
      clearTimeout(this._dimTimer);
      return this._entprellVersprechen('_dimTimer', (resolve) => {
        this._dimTimer = setTimeout(async () => {
          const mode = this.getCapabilityValue('light_mode');
          const dp   = this.getSetting('dp_brightness');
          // Ohne eigenen Helligkeits-DP ist V im Farbwert die einzige Helligkeit, die
          // das Geraet hat - auch ausserhalb des Farbmodus. Vorher ging der Regler dann
          // an einen DP, den es nicht gibt.
          if ((mode === 'color' || !(dp > 0)) && this.hasCapability('light_hue')) {
            // In colour mode, update V component of the HSV hex
            await this._sendColor({ v: value }).catch(() => {});
          } else {
            // In white mode, update brightness DP directly
            const max = this.getSetting('brightness_max') ?? 1000;
            if (dp > 0) await this._set(dp, dimToRaw(value, max)).catch(() => {});
          }
          resolve();
        }, DEBOUNCE_MS);
      });
    });

    this._tempTimer = null;
    this.registerCapabilityListener('light_temperature', (value) => {
      clearTimeout(this._tempTimer);
      return this._entprellVersprechen('_tempTimer', (resolve) => {
        this._tempTimer = setTimeout(async () => {
          const dp  = this.getSetting('dp_color_temp');
          const max = this.getSetting('color_temp_max') ?? 1000;
          const inv = this.getSetting('color_temp_invert') ?? false;
          if (dp > 0) {
            const raw = inv ? (max - dimToRaw(value, max)) : dimToRaw(value, max);
            await this._set(dp, raw).catch(() => {});
          }
          resolve();
        }, DEBOUNCE_MS);
      });
    });

    this._hueTimer = null;
    this.registerCapabilityListener('light_hue', (value) => {
      clearTimeout(this._hueTimer);
      return this._entprellVersprechen('_hueTimer', (resolve) => {
        this._hueTimer = setTimeout(async () => {
          await this._sendColor({ h: value }, { farbmodus: true }).catch(() => {});
          resolve();
        }, DEBOUNCE_MS);
      });
    });

    this._satTimer = null;
    this.registerCapabilityListener('light_saturation', (value) => {
      clearTimeout(this._satTimer);
      return this._entprellVersprechen('_satTimer', (resolve) => {
        this._satTimer = setTimeout(async () => {
          await this._sendColor({ s: value }, { farbmodus: true }).catch(() => {});
          resolve();
        }, DEBOUNCE_MS);
      });
    });

    this.registerCapabilityListener('light_mode', async (value) => {
      const dp = this.getSetting('dp_color_mode');
      if (dp > 0) {
        // Map Homey light_mode to device string
        const deviceVal = value === 'color' ? this.getSetting('color_mode_color_val') || 'colour'
                                            : this.getSetting('color_mode_white_val') || 'white';
        await this._set(dp, deviceVal);
      }
    });

    await this._connect();
  }

  // ── Send color command ───────────────────────────────────────────────────────
  // Merges current capability values with any overrides and sends the HSV hex.

  async _sendColor({ h: hNew, s: sNew, v: vNew } = {}, { farbmodus = false } = {}) {
    const block = Number(this.getSetting('dp_paint_color')) || 0;
    const dp    = block > 0 ? block : this.getSetting('dp_color');
    if (!dp || dp === 0) return;

    const curHue = this.getCapabilityValue('light_hue')        ?? 0;
    const curSat = this.getCapabilityValue('light_saturation') ?? 1;
    const curDim = this.getCapabilityValue('dim')              ?? 1;

    const h = Math.round((hNew !== undefined ? hNew : curHue) * 360);
    const s = Math.round((sNew !== undefined ? sNew : curSat) * 1000);
    const v = Math.round((vNew !== undefined ? vNew : curDim) * 1000);

    let wert;
    if (block > 0) {
      // Den Kopf liefert nur das Geraet. Ohne gemeldeten Block erst fragen, statt
      // fuenf Byte zu raten, deren Bedeutung niemand kennt.
      let bisher = parseFarbblock(this._lastDps[String(block)]);
      if (!bisher) {
        await this._conn?.get().catch(() => {});
        bisher = parseFarbblock(this._lastDps[String(block)]);
      }
      if (!bisher) {
        this._appLog(`Colour not sent: DP ${block} has not reported a colour block of `
          + `${BLOCK_LAENGE} bytes yet. Check Colour Block DP, or switch the light on once `
          + 'in the manufacturer\'s app.', 'warn');
        return;
      }
      wert = baueFarbblock(bisher.kopf, h, s, v);
    } else {
      wert = buildColorHex(h, s, v);
    }

    // Eine neue Farbe gilt nur im Farbmodus. Steht das Geraet auf Szene oder Musik,
    // verwirft es sie stumm - und light_mode zeigte dann trotzdem "color", weil alles
    // ausser dem Weiss-Wert so gelesen wird. Also erst umschalten. Nur fuer Farbton und
    // Saettigung: wer dimmt, will die laufende Szene nicht beenden.
    const modusDp = this.getSetting('dp_color_mode');
    if (farbmodus && modusDp > 0) {
      const farbe   = this.getSetting('color_mode_color_val') || 'colour';
      const gemeldet = this._lastDps[String(modusDp)];
      if (gemeldet !== undefined && String(gemeldet) !== farbe) await this._set(modusDp, farbe);
    }

    await this._set(dp, wert);
  }

  // ── DPS handling ─────────────────────────────────────────────────────────────

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

      // ── On/Off ────────────────────────────────────────────────────────────
      if (settings.dp_onoff > 0 && dp === settings.dp_onoff) {
        await this.setCapabilityValue('onoff', Boolean(value)).catch(() => {});
        await this._applyFixedPower(Boolean(value));
        continue;
      }

      // ── Color mode ─────────────────────────────────────────────────────────
      if (settings.dp_color_mode > 0 && dp === settings.dp_color_mode) {
        if (this.hasCapability('light_mode')) {
          const whiteVal = settings.color_mode_white_val || 'white';
          const homeyMode = String(value) === whiteVal ? 'temperature' : 'color';
          await this.setCapabilityValue('light_mode', homeyMode).catch(() => {});
        }
        continue;
      }

      // ── Brightness ─────────────────────────────────────────────────────────
      if (settings.dp_brightness > 0 && dp === settings.dp_brightness) {
        const max = settings.brightness_max ?? 1000;
        await this.setCapabilityValue('dim', rawToDim(Number(value), max)).catch(() => {});
        continue;
      }

      // ── Color temperature ──────────────────────────────────────────────────
      if (settings.dp_color_temp > 0 && dp === settings.dp_color_temp) {
        if (this.hasCapability('light_temperature')) {
          const max = settings.color_temp_max ?? 1000;
          const inv = settings.color_temp_invert ?? false;
          const raw = Number(value);
          const scaled = inv ? rawToDim(max - raw, max) : rawToDim(raw, max);
          await this.setCapabilityValue('light_temperature', scaled).catch(() => {});
        }
        continue;
      }

      // ── Farbblock ──────────────────────────────────────────────────────────
      if (settings.dp_paint_color > 0 && dp === Number(settings.dp_paint_color)) {
        await this._zeigeFarbblock(value);
        continue;
      }

      // ── HSV color hex ──────────────────────────────────────────────────────
      if (settings.dp_color > 0 && dp === settings.dp_color) {
        // Mit Farbblock ist DP 24 ein Ueberbleibsel, das stehen bleibt, waehrend die
        // Lampe die Farbe wechselt - gelesen setzte es die Kachel auf einen alten Wert.
        if (settings.dp_paint_color > 0) continue;
        const parsed = parseColorHex(String(value));
        if (parsed) {
          if (this.hasCapability('light_hue')) {
            await this.setCapabilityValue('light_hue',        parsed.h / 360).catch(() => {});
          }
          if (this.hasCapability('light_saturation')) {
            await this.setCapabilityValue('light_saturation', parsed.s / 1000).catch(() => {});
          }
          // V also maps to brightness when in color mode
          if (this.getCapabilityValue('light_mode') === 'color') {
            await this.setCapabilityValue('dim', parsed.v / 1000).catch(() => {});
          }
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

  /** Farbton, Saettigung und - ohne eigenen Helligkeits-DP oder im Farbmodus - Helligkeit aus dem Farbblock. */
  async _zeigeFarbblock(wert) {
    const block = parseFarbblock(wert);
    if (!block) {
      if (!this._farbblockGewarnt) {
        this._farbblockGewarnt = true;
        this._appLog(`Colour block DP ${this.getSetting('dp_paint_color')} reported `
          + `"${String(wert).slice(0, 40)}", which is not a ${BLOCK_LAENGE}-byte colour block. `
          + 'Check Colour Block DP.', 'warn');
      }
      return;
    }
    this._farbblockGewarnt = false;
    if (this.hasCapability('light_hue')) {
      await this.setCapabilityValue('light_hue', block.h / 360).catch(() => {});
    }
    if (this.hasCapability('light_saturation')) {
      await this.setCapabilityValue('light_saturation', block.s / 1000).catch(() => {});
    }
    if (!(this.getSetting('dp_brightness') > 0) || this.getCapabilityValue('light_mode') === 'color') {
      await this.setCapabilityValue('dim', block.v / 1000).catch(() => {});
    }
  }

  // ── Sync optional light capabilities based on DP settings ───────────────────

  async _syncLightCapabilities() {
    const OPTIONAL_CAPS = [
      { setting: 'dp_color_temp', capability: 'light_temperature' },
      { setting: 'dp_color_mode', capability: 'light_mode'        },
      { setting: ['dp_color', 'dp_paint_color'], capability: 'light_hue'        },
      { setting: ['dp_color', 'dp_paint_color'], capability: 'light_saturation' },
    ];

    for (const { setting, capability } of OPTIONAL_CAPS) {
      const dp = [].concat(setting).some((k) => this.getSetting(k) > 0);
      if (dp) {
        if (!this.hasCapability(capability)) await this.addCapability(capability).catch(() => {});
      } else {
        if (this.hasCapability(capability)) await this.removeCapability(capability).catch(() => {});
      }
    }
  }

  async _onDeleted() {
    clearTimeout(this._dimTimer);
    clearTimeout(this._tempTimer);
    clearTimeout(this._hueTimer);
    clearTimeout(this._satTimer);
  }

  // ── Homey lifecycle ──────────────────────────────────────────────────────────

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
    const lightSettings = ['dp_color_temp', 'dp_color_mode', 'dp_color', 'dp_paint_color'];
    if (changedKeys.some((k) => lightSettings.includes(k))) {
      await this._syncLightCapabilities();
    }
    // Den schon gemeldeten Block gleich lesen; die Gleichheitssperre in _handleDps
    // liesse ihn sonst erst durch, wenn sich die Farbe am Geraet aendert.
    if (changedKeys.includes('dp_paint_color')) {
      this._farbblockGewarnt = false;
      const dp = Number(this.getSetting('dp_paint_color'));
      if (dp > 0 && this._lastDps[String(dp)] !== undefined) {
        await this._zeigeFarbblock(this._lastDps[String(dp)]);
      } else if (dp > 0) {
        this._conn?.get().catch(() => {});
      }
    }
    if (changedKeys.some((k) => ['power_on_watts', 'power_off_watts'].includes(k))) {
      await this._syncOptionalCapabilities([
        { setting: 'power_on_watts', capability: 'measure_power' },
      ]);
      await this._applyFixedPower();
    }
  }
}

module.exports = LightDevice;
