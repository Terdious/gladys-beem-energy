// -----------------------------------------------------------------------------
// Production figures over box snapshots (site.snapshots()): the sums the
// widgets, the scene actions and the alerts share.
//
// The day and the month come from the cloud totals (exact); the year and the
// lifetime are the sums of the monthly totals of the store (the history
// fetched at startup, then the live months). A box absent from the summary
// counts for its last known totals, never for a power (a stale power would
// freeze the site at a wrong value).
// -----------------------------------------------------------------------------

import { SAMPLE_BUCKET_MS } from './store.js';
import { dayKey, monthKey, parseMonthKey, shiftDay, shiftMonth, monthKeyOf } from './time.js';

const kwh = (wh) => (wh === null || wh === undefined ? null : wh / 1000);

/** Sum of the known values, null when none is known. */
export function sumKnown(values) {
  const known = values.filter((value) => value !== null && value !== undefined);
  return known.length === 0 ? null : known.reduce((total, value) => total + value, 0);
}

/**
 * The figures of one box now.
 * @param {object} box snapshot
 * @param {number} now timestamp (ms)
 * @param {string} timeZone
 */
export function boxFigures(box, now, timeZone) {
  const today = dayKey(now, timeZone);
  const month = monthKey(now, timeZone);
  const year = month.slice(0, 4);
  const { days, months } = box.history;
  const todayWh = box.reading.todayWh ?? days[today] ?? null;
  const monthWh = box.reading.monthWh ?? months[month] ?? null;
  const pastMonths = Object.entries(months).filter(([key]) => key !== month);
  const yearWh =
    (monthWh ?? 0) +
    pastMonths.filter(([key]) => key.startsWith(year)).reduce((total, [, wh]) => total + wh, 0);
  const lifetimeWh = (monthWh ?? 0) + pastMonths.reduce((total, [, wh]) => total + wh, 0);
  const peakKw = box.peakPowerW > 0 ? box.peakPowerW / 1000 : null;
  return {
    powerW: box.reading.reported ? box.reading.powerW : null,
    todayKwh: kwh(todayWh),
    yesterdayKwh: kwh(days[shiftDay(today, -1)] ?? null),
    monthKwh: kwh(monthWh),
    yearKwh: kwh(yearWh),
    lifetimeKwh: kwh(lifetimeWh),
    peakKw,
    // kWh per installed kWp today: comparable between kits of any size.
    yieldToday: peakKw && todayWh !== null ? todayWh / 1000 / peakKw : null,
    // Share of the peak power produced right now (%).
    loadPercent:
      box.peakPowerW > 0 && box.reading.reported && box.reading.powerW !== null
        ? Math.round((box.reading.powerW / box.peakPowerW) * 100)
        : null,
  };
}

/**
 * The figures of some boxes, summed.
 * @param {Array<object>} boxes snapshots
 * @param {number} now
 * @param {string} timeZone
 */
export function siteFigures(boxes, now, timeZone) {
  const each = boxes.map((box) => boxFigures(box, now, timeZone));
  const pick = (key) => sumKnown(each.map((figures) => figures[key]));
  const peakKw = pick('peakKw');
  const todayKwh = pick('todayKwh');
  const powerW = pick('powerW');
  return {
    boxes: boxes.length,
    reporting: boxes.filter((box) => box.reading.reported).length,
    powerW,
    todayKwh,
    yesterdayKwh: pick('yesterdayKwh'),
    monthKwh: pick('monthKwh'),
    yearKwh: pick('yearKwh'),
    lifetimeKwh: pick('lifetimeKwh'),
    peakKw,
    yieldToday: peakKw && todayKwh !== null ? todayKwh / peakKw : null,
    loadPercent: peakKw && powerW !== null ? Math.round(powerW / (peakKw * 10)) : null,
  };
}

/**
 * Daily totals of some boxes over the last `count` days (today included),
 * oldest first; a day no box has is null.
 */
export function dailySeries(boxes, now, timeZone, count) {
  const today = dayKey(now, timeZone);
  const series = [];
  for (let offset = count - 1; offset >= 0; offset -= 1) {
    const key = shiftDay(today, -offset);
    const values = boxes.map((box) =>
      offset === 0 && box.reading.todayWh !== null ? box.reading.todayWh : box.history.days[key],
    );
    series.push({ key, kwh: kwh(sumKnown(values)) });
  }
  return series;
}

/**
 * Monthly totals of some boxes over the last `count` months (the current
 * one included), oldest first; a month no box has is null.
 */
export function monthlySeries(boxes, now, timeZone, count) {
  const current = parseMonthKey(monthKey(now, timeZone));
  const series = [];
  for (let offset = count - 1; offset >= 0; offset -= 1) {
    const key = monthKeyOf(shiftMonth(current, -offset));
    const values = boxes.map((box) =>
      offset === 0 && box.reading.monthWh !== null ? box.reading.monthWh : box.history.months[key],
    );
    series.push({ key, kwh: kwh(sumKnown(values)) });
  }
  return series;
}

/**
 * Every month any box knows, oldest first, summed: [{ key, kwh }].
 */
export function allMonths(boxes, now, timeZone) {
  const current = monthKey(now, timeZone);
  const totals = new Map();
  for (const box of boxes) {
    const months = { ...box.history.months };
    if (box.reading.monthWh !== null) {
      months[current] = box.reading.monthWh;
    }
    for (const [key, wh] of Object.entries(months)) {
      totals.set(key, (totals.get(key) ?? 0) + wh);
    }
  }
  return [...totals.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, wh]) => ({ key, kwh: wh / 1000 }));
}

/**
 * Site power per 5-minute bucket since `from`, from the store samples: the
 * sum of the boxes averaged per bucket. A bucket where a box has no sample
 * counts it at 0 (asleep, or not read yet).
 * @param {ReturnType<typeof import('./store.js').createStore>} store
 * @param {Array<object>} boxes snapshots
 * @param {number} from timestamp (ms)
 * @returns {Array<{ t: number, w: number }>}
 */
export function powerSeries(store, boxes, from) {
  const buckets = new Map();
  for (const box of boxes) {
    for (const { t, w } of store.samples(box.id, from)) {
      buckets.set(t, (buckets.get(t) ?? 0) + w);
    }
  }
  return [...buckets.entries()]
    .sort(([a], [b]) => a - b)
    .map(([t, w]) => ({ t, w: Math.round(w) }));
}

export const POWER_BUCKET_MS = SAMPLE_BUCKET_MS;

/** Median of some numbers, null for none. */
export function median(values) {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (sorted.length === 0) {
    return null;
  }
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

// Below this site yield (kWh/kWp), the day is too dark to compare boxes.
export const MIN_YIELD_TO_COMPARE = 0.5;
// Peers producing above this share of their peak power make a silent box
// suspicious (W per W peak).
export const MIN_PEER_LOAD_FOR_SILENCE = 0.05;

/**
 * Boxes producing clearly less than the others. Two cases:
 *   - `low_yield`: today's kWh per kWp below `threshold` % of the median of
 *     the boxes (two boxes at least, a day bright enough);
 *   - `silent`: no production reported while the other boxes produce (a
 *     micro-inverter off, a Wi-Fi lost, a breaker tripped).
 * @param {Array<object>} boxes snapshots
 * @param {number} now
 * @param {string} timeZone
 * @param {number} threshold % (0 disables)
 * @returns {Array<{ box: object, reason: 'low_yield'|'silent', ratio: number|null }>}
 */
export function underperformers(boxes, now, timeZone, threshold) {
  if (!(threshold > 0) || boxes.length < 2) {
    return [];
  }
  const figures = boxes.map((box) => ({ box, figures: boxFigures(box, now, timeZone) }));
  const result = [];
  const peerLoads = figures
    .filter(({ box }) => box.peakPowerW > 0 && box.reading.reported && box.reading.powerW > 0)
    .map(({ box }) => box.reading.powerW / box.peakPowerW);
  const peerLoad = median(peerLoads);
  const medianYield = median(figures.map(({ figures: f }) => f.yieldToday));
  for (const { box, figures: f } of figures) {
    const silent = !box.reading.reported || !(box.reading.powerW > 0);
    if (
      silent &&
      peerLoad !== null &&
      peerLoad >= MIN_PEER_LOAD_FOR_SILENCE &&
      peerLoads.length >= 1
    ) {
      result.push({ box, reason: 'silent', ratio: f.yieldToday === null ? null : 0 });
      continue;
    }
    if (
      medianYield !== null &&
      medianYield >= MIN_YIELD_TO_COMPARE &&
      f.yieldToday !== null &&
      f.yieldToday < (medianYield * threshold) / 100
    ) {
      result.push({
        box,
        reason: 'low_yield',
        ratio: Math.round((f.yieldToday / medianYield) * 100),
      });
    }
  }
  return result;
}

/**
 * Per 5-minute bucket since `from`: the box's own average power, and what
 * it would have produced at the median load (W per W peak) of the other
 * boxes producing in the same bucket. `w` is null in a bucket the box has
 * no sample for (absent from the summary), `expected` in a bucket no other
 * box has a sample for, or without a known peak power.
 * @param {ReturnType<typeof import('./store.js').createStore>} store
 * @param {object} box snapshot
 * @param {Array<object>} all every snapshot
 * @param {number} from timestamp (ms)
 * @returns {Array<{ t: number, w: number|null, expected: number|null }>}
 */
export function comparedSeries(store, box, all, from) {
  const peers = all.filter((other) => other.id !== box.id && other.peakPowerW > 0);
  const loads = new Map();
  for (const peer of peers) {
    for (const { t, w } of store.samples(peer.id, from)) {
      if (!loads.has(t)) {
        loads.set(t, []);
      }
      loads.get(t).push(w / peer.peakPowerW);
    }
  }
  const own = new Map(store.samples(box.id, from).map(({ t, w }) => [t, w]));
  const instants = [...new Set([...own.keys(), ...loads.keys()])].sort((a, b) => a - b);
  return instants.map((t) => {
    const load = loads.has(t) ? median(loads.get(t)) : null;
    return {
      t,
      // No sample: the box was absent from the cloud summary.
      w: own.has(t) ? Math.round(own.get(t)) : null,
      expected: load === null || !(box.peakPowerW > 0) ? null : Math.round(load * box.peakPowerW),
    };
  });
}

/**
 * Cuts of a box since `from`: the runs of 5-minute buckets where it produced
 * nothing while the other boxes produced (their median load at least
 * MIN_PEER_LOAD_FOR_SILENCE), closed by a production of the box again. A
 * run still open is left out: at dusk, a box facing east stops before the
 * ones facing west (the silent alert covers a cut still going on).
 * @returns {{ count: number, lastAt: number|null }}
 */
export function cutsOf(store, box, all, from) {
  const series = comparedSeries(store, box, all, from);
  let count = 0;
  let lastAt = null;
  let runStart = null;
  let produced = false;
  for (const { t, w, expected } of series) {
    const peersProduce =
      expected !== null &&
      box.peakPowerW > 0 &&
      expected / box.peakPowerW >= MIN_PEER_LOAD_FOR_SILENCE;
    if (w > 0) {
      if (runStart !== null && produced) {
        count += 1;
        lastAt = runStart;
      }
      runStart = null;
      produced = true;
    } else if (peersProduce && runStart === null) {
      runStart = t;
    } else if (!peersProduce) {
      runStart = null;
    }
  }
  return { count, lastAt };
}
