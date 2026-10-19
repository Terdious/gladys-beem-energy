// -----------------------------------------------------------------------------
// Integration configuration.
//
// The configuration is filled in by the user in Gladys, from the `config_schema`
// declared in `gladys-assistant-integration.json`. The SDK fetches it for you
// (`gladys.getConfig()`) and notifies you of every change through
// `gladys.onConfigUpdated()`.
//
// This module only provides defaults and normalizes the received object, so the
// rest of the code never has to deal with `undefined`.
// -----------------------------------------------------------------------------

import { resolveTimezone } from './time.js';

// Defaults: they MUST stay consistent with the `default` values declared in the
// `config_schema` of the manifest.
export const DEFAULT_CONFIG = {
  email: '', // Beem account (the one of the Beem application)
  password: '', // secret, never logged
  // Seconds between two reads of the Beem cloud. The cloud itself refreshes
  // a box about once a minute; faster brings nothing, and the Beem API
  // rate-limits the accounts that insist.
  poll_frequency: 120,
  // Months of production history fetched from the cloud at startup (monthly
  // totals: the year, the lifetime figures and the payback start there).
  history_months: 24,
  feature_names: 'en', // language of the feature names of newly discovered devices
  // The day and the month of the Beem cloud, the off-peak hours and the end
  // of the solar day follow this timezone (Gladys gives an integration none).
  timezone: 'Europe/Paris',
  // Savings estimate (src/savings.js). Prices per kWh in the user's
  // currency; no manifest default (null here): an empty field shows its
  // placeholder, and a missing price disables the estimate.
  tariff_mode: 'none', // none | base | peak_offpeak
  price_base: null,
  price_peak: null,
  price_offpeak: null,
  offpeak_hours: '', // e.g. "22:00-06:00" or "01:30-07:30,12:30-14:30"
  self_consumption_rate: 100, // % of the production the home consumes
  resale_enabled: false,
  resale_price: null,
  installation_cost: null, // price paid for the kits, for the payback
  co2_factor: 50, // g CO2 avoided per kWh produced
  // Alert when a box yields less than this % of the median of the boxes
  // (kWh per installed kWp); 0 disables the detection.
  underperformance_threshold: 60,
};

export const TARIFF_MODE_VALUES = ['none', 'base', 'peak_offpeak'];
export const FEATURE_NAME_LANGUAGES = ['en', 'fr'];

// Bounds of the poll frequency (s): the manifest's `min` and `max` too.
export const MIN_POLL_FREQUENCY = 60;
export const MAX_POLL_FREQUENCY = 3600;

/** A form value (maybe the string "true") as a boolean. */
function toBoolean(value, fallback) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  const normalized = String(value).trim().toLowerCase();
  return normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on';
}

/** A form value as a finite number (a decimal comma accepted), or null. */
function toNumberOrNull(value) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return null;
  }
  const number = typeof value === 'number' ? value : Number(String(value).replace(',', '.'));
  return Number.isFinite(number) ? number : null;
}

/** A number within [min, max], the fallback when missing or invalid. */
function toBounded(value, fallback, min, max) {
  const number = toNumberOrNull(value);
  if (number === null) {
    return fallback;
  }
  return Math.min(max, Math.max(min, number));
}

/** A price or an amount: a number >= 0, or null (never guessed). */
function toAmountOrNull(value) {
  const number = toNumberOrNull(value);
  return number !== null && number >= 0 ? number : null;
}

/**
 * Merge the user config with the defaults.
 * @param {Record<string, unknown>} raw config returned by the SDK
 */
export function normalizeConfig(raw = {}) {
  return {
    ...DEFAULT_CONFIG,
    ...raw,
    email: String(raw.email ?? DEFAULT_CONFIG.email).trim(),
    // A password may start or end with a space: kept as typed.
    password: String(raw.password ?? DEFAULT_CONFIG.password),
    poll_frequency: toBounded(
      raw.poll_frequency,
      DEFAULT_CONFIG.poll_frequency,
      MIN_POLL_FREQUENCY,
      MAX_POLL_FREQUENCY,
    ),
    history_months: Math.round(
      toBounded(raw.history_months, DEFAULT_CONFIG.history_months, 0, 120),
    ),
    feature_names: FEATURE_NAME_LANGUAGES.includes(raw.feature_names)
      ? raw.feature_names
      : DEFAULT_CONFIG.feature_names,
    timezone: resolveTimezone(raw.timezone),
    tariff_mode: TARIFF_MODE_VALUES.includes(raw.tariff_mode)
      ? raw.tariff_mode
      : DEFAULT_CONFIG.tariff_mode,
    price_base: toAmountOrNull(raw.price_base),
    price_peak: toAmountOrNull(raw.price_peak),
    price_offpeak: toAmountOrNull(raw.price_offpeak),
    offpeak_hours: String(raw.offpeak_hours ?? DEFAULT_CONFIG.offpeak_hours).trim(),
    self_consumption_rate: toBounded(
      raw.self_consumption_rate,
      DEFAULT_CONFIG.self_consumption_rate,
      0,
      100,
    ),
    resale_enabled: toBoolean(raw.resale_enabled, DEFAULT_CONFIG.resale_enabled),
    resale_price: toAmountOrNull(raw.resale_price),
    installation_cost: toAmountOrNull(raw.installation_cost),
    co2_factor: toBounded(raw.co2_factor, DEFAULT_CONFIG.co2_factor, 0, 2000),
    underperformance_threshold: toBounded(
      raw.underperformance_threshold,
      DEFAULT_CONFIG.underperformance_threshold,
      0,
      100,
    ),
  };
}

/** True when the Beem credentials are filled in. */
export const hasCredentials = (config) => config.email !== '' && config.password !== '';
