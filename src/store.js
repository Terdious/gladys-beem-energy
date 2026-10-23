// -----------------------------------------------------------------------------
// Production store, saved under /data (the only writable volume).
//
// Gladys tracks the energy of a producer from a cumulative INDEX feature (the
// energy-monitoring service turns its deltas into thirty-minute production).
// The Beem cloud gives no lifetime counter: only the energy of the current day
// and of the current month, both reset by the cloud. So the store keeps, per
// box, its own lifetime index, grown by the increase of the month total:
//
//   same month      index += totalMonth - last totalMonth (never negative)
//   new month       index += totalMonth
//                         + (final total of the previous month - last seen),
//                   the final total being asked to the cloud once (the
//                   production between the last reading and midnight, or
//                   during a container downtime, is recovered exactly).
//
// The month total is the robust base: a reading missed for a whole day (a
// container down overnight) is caught up by the next one, which a day total
// could not do. The first reading of a box only sets the baseline: what the
// box produced before it was tracked is in the monthly history, never in the
// index (an index jumping by months of production would read as a huge
// half-hour in Gladys).
//
// Also kept per box: the total of each day seen (last 400 days), of each month
// (live, and the history fetched from the cloud at startup: months from the
// summary, days from the intraday production), and the average power per
// 5-minute bucket of the last 14 days (the inline charts).
//
// The index must survive restarts (falling back to 0 would read as a huge
// negative delta): the file is written atomically, every few minutes and at
// shutdown.
// -----------------------------------------------------------------------------

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { createLogger } from '@gladysassistant/integration-sdk';

const logger = createLogger({ name: 'store' });

export const STORE_VERSION = 1;
export const STORE_FILE = 'beem-energy.json';
export const DAY_RETENTION = 400;
export const SAMPLE_BUCKET_MS = 5 * 60 * 1000;
// 14 days: the power curves of the past days the site widget steps back to.
export const SAMPLE_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;

/** The data directory: /data in the container, overridable for the tests. */
export const dataDir = () => process.env.BEEM_DATA_DIR || '/data';

function emptyBox() {
  return {
    indexKwh: 0,
    monthKey: null,
    monthWh: null,
    days: {},
    months: {},
    samples: [],
  };
}

const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value);

function sanitizeEntries(object) {
  const result = {};
  for (const [key, value] of Object.entries(object ?? {})) {
    if (isFiniteNumber(value) && value >= 0) {
      result[key] = value;
    }
  }
  return result;
}

function loadBox(raw) {
  const box = emptyBox();
  if (isFiniteNumber(raw?.indexKwh) && raw.indexKwh >= 0) {
    box.indexKwh = raw.indexKwh;
  }
  if (typeof raw?.monthKey === 'string' && isFiniteNumber(raw?.monthWh)) {
    box.monthKey = raw.monthKey;
    box.monthWh = raw.monthWh;
  }
  box.days = sanitizeEntries(raw?.days);
  box.months = sanitizeEntries(raw?.months);
  box.samples = Array.isArray(raw?.samples)
    ? raw.samples.filter(
        (sample) =>
          Array.isArray(sample) && sample.length === 3 && sample.every((v) => isFiniteNumber(v)),
      )
    : [];
  return box;
}

/**
 * Create an empty store, or the one saved in the data directory.
 * @param {{ dir?: string }} [options]
 */
export function createStore({ dir } = {}) {
  let state = {
    version: STORE_VERSION,
    boxes: {},
    fetchedMonths: [],
    fetchedDays: [],
    events: {},
  };
  let dirty = false;

  const boxState = (id) => {
    if (!state.boxes[id]) {
      state.boxes[id] = emptyBox();
    }
    return state.boxes[id];
  };

  const filePath = () => join(dir ?? dataDir(), STORE_FILE);

  return {
    async load() {
      try {
        const raw = JSON.parse(await readFile(filePath(), 'utf8'));
        const boxes = {};
        for (const [id, box] of Object.entries(raw?.boxes ?? {})) {
          boxes[id] = loadBox(box);
        }
        state = {
          version: STORE_VERSION,
          boxes,
          fetchedMonths: Array.isArray(raw?.fetchedMonths)
            ? raw.fetchedMonths.filter((key) => typeof key === 'string')
            : [],
          fetchedDays: Array.isArray(raw?.fetchedDays)
            ? raw.fetchedDays.filter((key) => typeof key === 'string')
            : [],
          events: raw?.events && typeof raw.events === 'object' ? raw.events : {},
        };
        logger.info(`Production store loaded (${Object.keys(boxes).length} box(es))`);
      } catch (err) {
        if (err.code !== 'ENOENT') {
          // A corrupted file must not stop the integration: start again, the
          // indexes restart from the next readings.
          logger.warn(`Production store unreadable, starting from scratch (${err.message})`);
        }
      }
    },

    async save() {
      if (!dirty) {
        return;
      }
      const target = filePath();
      try {
        await mkdir(dir ?? dataDir(), { recursive: true });
        const temporary = `${target}.tmp`;
        await writeFile(temporary, JSON.stringify(state));
        await rename(temporary, target);
        dirty = false;
      } catch (err) {
        logger.error(`Production store not saved (${err.message})`);
      }
    },

    /** The month a box was last read in, null before its first reading. */
    lastMonthOf(id) {
      return state.boxes[id]?.monthKey ?? null;
    },

    /**
     * Record a reading of a box.
     * @param {string} id box id
     * @param {{ todayWh: number|null, monthWh: number|null, powerW: number|null }} reading
     * @param {{ now: number, dayKey: string, monthKey: string, previousMonthFinalWh?: number|null }} context
     * @returns {number} the kWh added to the index
     */
    record(id, reading, { now, dayKey, monthKey, previousMonthFinalWh = null }) {
      const box = boxState(id);
      let addedWh = 0;
      if (isFiniteNumber(reading.monthWh) && reading.monthWh >= 0) {
        if (box.monthKey === monthKey) {
          addedWh = Math.max(0, reading.monthWh - box.monthWh);
          // A lower total is a cloud correction: follow it, the next increase
          // is counted from there.
          box.monthWh = reading.monthWh;
        } else if (box.monthKey !== null) {
          const tail = isFiniteNumber(previousMonthFinalWh)
            ? Math.max(0, previousMonthFinalWh - box.monthWh)
            : 0;
          if (isFiniteNumber(previousMonthFinalWh)) {
            box.months[box.monthKey] = previousMonthFinalWh;
          }
          addedWh = tail + reading.monthWh;
          box.monthWh = reading.monthWh;
        } else {
          box.monthWh = reading.monthWh;
        }
        box.monthKey = monthKey;
        box.months[monthKey] = reading.monthWh;
        box.indexKwh += addedWh / 1000;
      }
      if (isFiniteNumber(reading.todayWh) && reading.todayWh >= 0) {
        box.days[dayKey] = reading.todayWh;
        const keys = Object.keys(box.days).sort();
        for (const key of keys.slice(0, Math.max(0, keys.length - DAY_RETENTION))) {
          delete box.days[key];
        }
      }
      if (isFiniteNumber(reading.powerW)) {
        const bucket = Math.floor(now / SAMPLE_BUCKET_MS) * SAMPLE_BUCKET_MS;
        const last = box.samples[box.samples.length - 1];
        if (last && last[0] === bucket) {
          last[1] += reading.powerW;
          last[2] += 1;
        } else {
          box.samples.push([bucket, reading.powerW, 1]);
        }
        const oldest = now - SAMPLE_RETENTION_MS;
        while (box.samples.length > 0 && box.samples[0][0] < oldest) {
          box.samples.shift();
        }
      }
      dirty = true;
      return addedWh / 1000;
    },

    /** Store the total of a past month of a box (history from the cloud). */
    setMonth(id, key, wh) {
      if (isFiniteNumber(wh) && wh >= 0) {
        boxState(id).months[key] = wh;
        dirty = true;
      }
    },

    /** Remember that a past month was fetched: it never changes again. */
    markMonthFetched(key) {
      if (!state.fetchedMonths.includes(key)) {
        state.fetchedMonths.push(key);
        dirty = true;
      }
    },

    /**
     * Store the total of a past day of a box (history from the cloud). A day
     * the integration saw live keeps its live total: the summary is exact.
     */
    setDay(id, key, wh) {
      const box = boxState(id);
      if (isFiniteNumber(wh) && wh >= 0 && box.days[key] === undefined) {
        box.days[key] = wh;
        const keys = Object.keys(box.days).sort();
        for (const old of keys.slice(0, Math.max(0, keys.length - DAY_RETENTION))) {
          delete box.days[old];
        }
        dirty = true;
      }
    },

    /** Remember that the days of a past period were fetched. */
    markDaysFetched(key) {
      if (!state.fetchedDays.includes(key)) {
        state.fetchedDays.push(key);
        state.fetchedDays = state.fetchedDays.sort().slice(-DAY_RETENTION);
        dirty = true;
      }
    },

    areDaysFetched(key) {
      return state.fetchedDays.includes(key);
    },

    isMonthFetched(key) {
      return state.fetchedMonths.includes(key);
    },

    /** Forget the fetched marks: the next backfill asks every month again. */
    clearFetchedMonths() {
      state.fetchedMonths = [];
      state.fetchedDays = [];
      dirty = true;
    },

    indexKwh(id) {
      return state.boxes[id]?.indexKwh ?? null;
    },

    /** Copies of the day and month totals of a box (Wh), keyed by date. */
    history(id) {
      const box = state.boxes[id];
      return { days: { ...(box?.days ?? {}) }, months: { ...(box?.months ?? {}) } };
    },

    /** 5-minute average powers of a box in [from, to): [{ t, w }]. */
    samples(id, from = 0, to = Infinity) {
      return (state.boxes[id]?.samples ?? [])
        .filter(([t]) => t >= from && t < to)
        .map(([t, total, count]) => ({ t, w: total / count }));
    },

    /** One-shot event marks (a scene trigger fired once per day...). */
    eventMark(key) {
      return state.events[key] ?? null;
    },

    setEventMark(key, value) {
      state.events[key] = value;
      dirty = true;
    },

    boxIds() {
      return Object.keys(state.boxes);
    },
  };
}
