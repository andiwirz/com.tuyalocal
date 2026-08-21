'use strict';

const BaseTuyaDevice = require('../../lib/BaseTuyaDevice');

// settingKey -> capability, plus which divisor setting scales it. Every one of these
// data points is a whole number on the wire; the divisor turns it into the unit
// Homey expects. On the reported station all of them are tenths, but a divisor per
// quantity rather than one for the whole device means a model that scales its
// pressure differently from its temperatures does not need a code change.
const NUMERIC_PROFILE = [
  { settingKey: 'dp_temp_in',    capability: 'measure_temperature',          divisor: 'temp_divisor'     },
  { settingKey: 'dp_temp_out',   capability: 'measure_temperature.outdoor',  divisor: 'temp_divisor'     },
  { settingKey: 'dp_temp_extra', capability: 'measure_temperature.extra',    divisor: 'temp_divisor'     },
  { settingKey: 'dp_hum_in',     capability: 'measure_humidity',             divisor: 'humidity_divisor' },
  { settingKey: 'dp_hum_out',    capability: 'measure_humidity.outdoor',     divisor: 'humidity_divisor' },
  { settingKey: 'dp_pressure',   capability: 'measure_pressure',             divisor: 'pressure_divisor' },
  { settingKey: 'dp_wind',       capability: 'measure_wind_strength',        divisor: 'wind_divisor'     },
  { settingKey: 'dp_gust',       capability: 'measure_gust_strength',        divisor: 'wind_divisor'     },
  { settingKey: 'dp_rain_1h',    capability: 'measure_rain_intensity',       divisor: 'rain_divisor'     },
  { settingKey: 'dp_rain_24h',   capability: 'measure_rain',                 divisor: 'rain_divisor'     },
  { settingKey: 'dp_rain_total', capability: 'measure_rain.total',           divisor: 'rain_divisor'     },
];

const OPTIONAL_CAPABILITIES = [
  ...NUMERIC_PROFILE.map(({ settingKey, capability }) => ({ setting: settingKey, capability })),
  // Both, from the same data point. The station sends a compass point, and that is
  // what a person wants to read off the tile — "SW", not 225°. The angle is kept
  // beside it because it is the standard capability: it charts as a number in
  // Insights, and the "wind is from" flow condition compares against it. Neither
  // stands in for the other.
  { setting: 'dp_wind_dir', capability: 'wind_direction'     },
  { setting: 'dp_wind_dir', capability: 'measure_wind_angle' },
  { setting: 'dp_comfort',  capability: 'comfort_level'      },
];

class WeatherStationDevice extends BaseTuyaDevice {
  async onInit() {
    this.log('Weather station initialized:', this.getName());

    await this._baseInit();
    await this._migrateCapabilities([]);
    await this._syncOptionalCapabilities(OPTIONAL_CAPABILITIES);
    await this._syncEnumOptions('comfort_level',  this.getSetting('comfort_values'));
    // The tokens are whatever this station sends, so the choices come from the same
    // setting the angle conversion reads. A station with eight points, or one that
    // spells them differently, gets its own list rather than the declared sixteen.
    await this._syncEnumOptions('wind_direction', this.getSetting('wd_values'));

    this._triggerDeviceConnected    = this.homey.flow.getDeviceTriggerCard('weather_station_device_connected');
    this._triggerDeviceDisconnected = this.homey.flow.getDeviceTriggerCard('weather_station_device_disconnected');
    this._triggerDpChanged          = this.homey.flow.getDeviceTriggerCard('weather_station_dp_changed');
    this._triggerComfortChanged     = this.homey.flow.getDeviceTriggerCard('weather_station_comfort_changed');

    await this._connect();
  }

  /** The compass tokens this station uses, in the order that defines their angles. */
  _windTokens() {
    return (this.getSetting('wd_values')
      || 'N,NNE,NE,ENE,E,ESE,SE,SSE,S,SSW,SW,WSW,W,WNW,NW,NNW')
      .split(',').map((v) => v.trim()).filter(Boolean);
  }

  /**
   * Turns a compass token into degrees.
   *
   * Homey's wind angle is a number, the station sends a compass point, and how many
   * points there are differs between models — sixteen on the reported one, eight on
   * simpler stations. Rather than write in a table of sixteen names, the angle comes
   * from the token's position in the declared list, so an eight-point station lands
   * on 45° steps without anything here changing. Returns null for a token that is
   * not in the list, which leaves the previous reading alone rather than inventing
   * a heading of zero — due north is a real direction and a poor stand-in for
   * "unknown".
   */
  _windAngle(token) {
    const list = this._windTokens();
    const i    = list.indexOf(String(token));
    if (i < 0 || list.length === 0) return null;
    return Math.round((i * 360 / list.length) * 10) / 10;
  }

  /** True when the wind is blowing from the named sector — used by the flow card. */
  windIsFrom(sector) {
    const angle = this.getCapabilityValue('measure_wind_angle');
    if (typeof angle !== 'number') return false;
    const centre = { n: 0, e: 90, s: 180, w: 270 }[String(sector).toLowerCase()];
    if (centre === undefined) return false;
    // Each of the four sectors covers 90°, so a reading is "from north" when it is
    // within 45° of due north. The modulo turns the difference into the shortest
    // angle between the two, which is what makes 350° count as north as well.
    const diff = Math.abs(((angle - centre + 540) % 360) - 180);
    return diff <= 45;
  }

  _divisor(settingKey) {
    const d = parseInt(this.getSetting(settingKey), 10);
    return Number.isFinite(d) && d > 0 ? d : 1;
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

      // ── Wind direction ────────────────────────────────────────────────────
      if (settings.dp_wind_dir > 0 && dp === settings.dp_wind_dir) {
        const angle = this._windAngle(value);
        if (angle === null) {
          this._appLog(`Wind direction "${value}" is not in the configured list `
            + `(${this._windTokens().join(', ')}) — reading kept`, 'warn');
          continue;
        }
        // The token as sent, for reading, and the angle, for charting and comparing.
        // Both are gated on the same test: a token outside the configured list has no
        // angle, and the picker would reject it as a value, so neither is written.
        if (this.hasCapability('wind_direction')) {
          await this.setCapabilityValue('wind_direction', String(value)).catch(() => {});
        }
        if (this.hasCapability('measure_wind_angle')) {
          await this.setCapabilityValue('measure_wind_angle', angle).catch(() => {});
        }
        continue;
      }

      // ── Comfort ───────────────────────────────────────────────────────────
      if (settings.dp_comfort > 0 && dp === settings.dp_comfort) {
        if (this.hasCapability('comfort_level')) {
          const token = String(value);
          const prev  = this.getCapabilityValue('comfort_level');
          await this.setCapabilityValue('comfort_level', token).catch(() => {});
          if (prev !== null && prev !== token) {
            this._triggerComfortChanged
              .trigger(this, { comfort: token, previous_comfort: prev })
              .catch(() => {});
          }
        }
        continue;
      }

      // ── Everything numeric ────────────────────────────────────────────────
      const entry = NUMERIC_PROFILE.find((e) => settings[e.settingKey] > 0
        && dp === settings[e.settingKey]);
      if (!entry) {
        // Data points 127 to 133 are proprietary binary blobs — alarm thresholds,
        // display layout, per-channel battery states — with no published format.
        // Logged rather than decoded, so a device that sends something new is
        // visible in DP Debug instead of silently dropped.
        this.log(`Unmapped DP ${dp}:`, value);
        continue;
      }
      if (!this.hasCapability(entry.capability)) continue;
      const scaled = Number(value) / this._divisor(entry.divisor);
      if (!Number.isFinite(scaled)) continue;
      await this.setCapabilityValue(entry.capability, scaled).catch(() => {});
    }

    if (changed) {
      this._scheduleStoreSave();
      this._writeDpSnapshot();
    }
  }

  // ── Homey lifecycle ────────────────────────────────────────────────────────

  async onSettings({ changedKeys }) {
    const connectionKeys = ['ip', 'device_id', 'local_key', 'version'];
    if (changedKeys.some((k) => connectionKeys.includes(k))) {
      await this._connect();
      return;
    }
    if (changedKeys.includes('polling_interval'))   this._startPolling();
    if (changedKeys.includes('reconnect_interval')) this._startAutoReconnect();
    if (changedKeys.some((k) => OPTIONAL_CAPABILITIES.map((o) => o.setting).includes(k))) {
      await this._syncOptionalCapabilities(OPTIONAL_CAPABILITIES);
    }
    if (changedKeys.includes('comfort_values')) {
      await this._syncEnumOptions('comfort_level', this.getSetting('comfort_values'));
    }
    if (changedKeys.includes('wd_values')) {
      await this._syncEnumOptions('wind_direction', this.getSetting('wd_values'));
    }
  }
}

module.exports = WeatherStationDevice;
