// -----------------------------------------------------------------------------
// Savings ESTIMATE of the solar production.
//
// A plug-and-play kit has no grid meter of its own: nothing tells which part
// of the production the home consumed and which part went to the grid. The
// estimate therefore rests on the user's own figures:
//
//   value of 1 kWh produced = self-consumption rate x solar price
//                           + (1 - rate) x resale price (0 without resale:
//                             the surplus of a kit without contract is given
//                             to the grid)
//
// The solar price is the base price, or with peak / off-peak hours the price
// weighted by WHEN the panels produce: the average power of the boxes over
// the last two days per minute of the day (src/store.js samples) when the
// store has them, a standard daylight profile otherwise. The off-peak hours
// of a French contract are mostly at night: the solar price lands close to
// the peak price, minus the off-peak hours around noon some contracts have.
//
// Every figure follows from the energy and the tariff of today: a price
// change applies to the past too (the estimate is not an invoice).
//
// Payback: the savings since the first month of history over the cost of
// the installation, and the date it is reached at the pace of the last 12
// months (or of the months known, fewer at first).
// -----------------------------------------------------------------------------

export const TARIFF_MODES = { NONE: 'none', BASE: 'base', PEAK_OFFPEAK: 'peak_offpeak' };

const MINUTES_PER_DAY = 24 * 60;

// Standard daylight profile (local time): production from 06:30 to 21:00,
// a sine arch peaking around 13:45 (the solar noon of France in summer
// time). Only its shape matters: it weights the peak and off-peak prices.
const PROFILE_START = 6 * 60 + 30;
const PROFILE_END = 21 * 60;

function minuteOf(hours, minutes) {
  if (minutes > 59 || hours > 24 || (hours === 24 && minutes !== 0)) {
    return null;
  }
  return hours * 60 + minutes;
}

/**
 * Parse off-peak hours: `HH:MM-HH:MM` ranges separated by commas (or
 * semicolons), a range ending before it starts crossing midnight.
 * @param {unknown} text e.g. "22:00-06:00" or "01:30-07:30,12:30-14:30"
 * @returns {{ ranges: Array<{ start: number, end: number }> } | { error: string }}
 */
export function parseOffpeakHours(text) {
  const source = typeof text === 'string' ? text.trim() : '';
  if (source === '') {
    return { error: 'no off-peak hours' };
  }
  const ranges = [];
  for (const raw of source.split(/[,;]/)) {
    const part = raw.trim();
    const match = part.match(/^(\d{1,2})[:h](\d{2})\s*-\s*(\d{1,2})[:h](\d{2})$/i);
    if (!match) {
      return { error: `"${part}" is not a HH:MM-HH:MM range` };
    }
    const [h1, m1, h2, m2] = match.slice(1).map(Number);
    const start = minuteOf(h1, m1);
    const end = minuteOf(h2, m2);
    if (start === null || end === null) {
      return { error: `"${part}" is not a valid time range` };
    }
    if (start % MINUTES_PER_DAY === end % MINUTES_PER_DAY) {
      return { error: `"${part}" is empty` };
    }
    ranges.push({ start: start % MINUTES_PER_DAY, end });
  }
  return { ranges };
}

/** One flag per minute of the day: off-peak or not. */
export function offpeakMask(ranges) {
  const mask = new Uint8Array(MINUTES_PER_DAY);
  for (const { start, end } of ranges) {
    if (end > start) {
      mask.fill(1, start, end);
    } else {
      mask.fill(1, start, MINUTES_PER_DAY);
      mask.fill(1, 0, end);
    }
  }
  return mask;
}

/** The standard daylight profile: one weight per minute of the day. */
export function defaultSolarProfile() {
  const weights = new Float64Array(MINUTES_PER_DAY);
  for (let minute = PROFILE_START; minute < PROFILE_END; minute += 1) {
    weights[minute] = Math.sin(
      (Math.PI * (minute - PROFILE_START + 0.5)) / (PROFILE_END - PROFILE_START),
    );
  }
  return weights;
}

/**
 * A production profile from measured powers: the energy per minute of the
 * day, null when the samples hold too little production to be a shape.
 * @param {Array<{ minute: number, w: number }>} samples minute of the day + power
 * @param {number} bucketMinutes width of one sample
 */
export function measuredSolarProfile(samples, bucketMinutes = 5) {
  const weights = new Float64Array(MINUTES_PER_DAY);
  let total = 0;
  for (const { minute, w } of samples) {
    if (!(w > 0)) {
      continue;
    }
    for (let offset = 0; offset < bucketMinutes; offset += 1) {
      weights[(minute + offset) % MINUTES_PER_DAY] += w;
    }
    total += w;
  }
  // Less than ~1 kWh measured: a few cloudy minutes, not a day shape.
  return total * (bucketMinutes / 60) >= 1000 ? weights : null;
}

/**
 * Build the tariff from the normalized configuration.
 * @param {object} config normalized config (src/config.js)
 * @param {{ profile?: Float64Array|null }} [options] production profile
 * @returns {{ tariff: object|null, error: string|null }} tariff null when disabled or invalid
 */
export function buildTariff(config, { profile = null } = {}) {
  const mode = config.tariff_mode;
  if (mode !== TARIFF_MODES.BASE && mode !== TARIFF_MODES.PEAK_OFFPEAK) {
    return { tariff: null, error: null };
  }
  const selfRate = Math.max(0, Math.min(100, config.self_consumption_rate)) / 100;
  const resaleEnabled = config.resale_enabled === true;
  if (resaleEnabled && config.resale_price === null) {
    return { tariff: null, error: 'resale enabled without a resale price' };
  }
  const resalePrice = resaleEnabled ? config.resale_price : 0;
  let solarPrice;
  let offpeakShare = 0;
  if (mode === TARIFF_MODES.BASE) {
    if (config.price_base === null) {
      return { tariff: null, error: 'no base price' };
    }
    solarPrice = config.price_base;
  } else {
    if (config.price_peak === null || config.price_offpeak === null) {
      return { tariff: null, error: 'peak or off-peak price missing' };
    }
    const parsed = parseOffpeakHours(config.offpeak_hours);
    if (parsed.error) {
      return { tariff: null, error: `off-peak hours: ${parsed.error}` };
    }
    const mask = offpeakMask(parsed.ranges);
    const weights = profile ?? defaultSolarProfile();
    let total = 0;
    let offpeak = 0;
    for (let minute = 0; minute < MINUTES_PER_DAY; minute += 1) {
      total += weights[minute];
      if (mask[minute]) {
        offpeak += weights[minute];
      }
    }
    offpeakShare = total > 0 ? offpeak / total : 0;
    solarPrice = config.price_peak * (1 - offpeakShare) + config.price_offpeak * offpeakShare;
  }
  return {
    tariff: {
      mode,
      solarPrice,
      offpeakShare,
      selfRate,
      resaleEnabled,
      resalePrice,
      valuePerKwh: selfRate * solarPrice + (1 - selfRate) * resalePrice,
    },
    error: null,
  };
}

/**
 * Value of some production.
 * @param {number} kwh energy produced
 * @param {object} tariff from buildTariff
 */
export function valueOf(kwh, tariff) {
  const selfKwh = kwh * tariff.selfRate;
  const exportedKwh = kwh - selfKwh;
  const avoided = selfKwh * tariff.solarPrice;
  const resale = exportedKwh * tariff.resalePrice;
  return { total: avoided + resale, avoided, resale, selfKwh, exportedKwh };
}

/**
 * Payback of the installation.
 * @param {{ cost: number|null, lifetimeSavings: number, months: Array<{ key: string, kwh: number }>, tariff: object, now: number }} input
 *   months: the totals of the known months, oldest first, the current one last
 * @returns {{ progress: number, remaining: number, etaMonths: number|null }|null} null without a cost
 */
export function paybackOf({ cost, lifetimeSavings, months, tariff }) {
  if (!(cost > 0)) {
    return null;
  }
  const progress = Math.min(1, lifetimeSavings / cost);
  const remaining = Math.max(0, cost - lifetimeSavings);
  // The pace: the 12 complete months before the current one (fewer when the
  // history is shorter); the current month is incomplete.
  const complete = months.slice(0, -1).slice(-12);
  const perMonth =
    complete.length > 0
      ? complete.reduce((total, month) => total + valueOf(month.kwh, tariff).total, 0) /
        complete.length
      : 0;
  const etaMonths = remaining === 0 ? 0 : perMonth > 0 ? remaining / perMonth : null;
  return { progress, remaining, etaMonths };
}
