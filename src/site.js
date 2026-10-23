// -----------------------------------------------------------------------------
// The Beem installation: one account, its boxes, their readings.
//
// The Beem cloud answers for every box of the account in one call
// (/box/summary), so the integration does not poll device by device: one
// timer reads the summary every `poll_frequency` seconds and publishes the
// states of all the boxes (changed values only, with a heartbeat).
//
//   - The topology (/devices: names, panels, peak powers) is re-read every
//     hour, and the devices re-published when it changed (a box added in the
//     Beem application appears in Gladys without a restart).
//   - On a month change, the final total of the month left is asked once
//     (src/store.js: the index loses nothing across midnight).
//   - At startup, the monthly history is fetched once per month (a past
//     month never changes), a request every few seconds, from the newest:
//     the year and lifetime figures, the savings and the payback start there.
//
// A failure (cloud down, 429) keeps the last states, reports the connection
// status on the Configuration screen and is retried at the next tick; the
// rate-limit lock of the client makes the ticks no-ops until it expires.
// -----------------------------------------------------------------------------

import { createLogger, DEVICE_TRANSPORTS } from '@gladysassistant/integration-sdk';

import { BeemApiError, createBeemClient } from './beem/client.js';
import { describeBox, intradayDays, rawBoxesOf, readSummary, summariesById } from './beem/boxes.js';
import { boxIds, boxStates, buildBoxDevice } from './devices/box.js';
import { hasCredentials } from './config.js';
import { DAY_RETENTION } from './store.js';
import {
  dayKey,
  localParts,
  monthKey,
  monthKeyOf,
  parseMonthKey,
  shiftDay,
  shiftMonth,
  startOfDayKey,
} from './time.js';

const logger = createLogger({ name: 'site' });

export const TOPOLOGY_REFRESH_MS = 60 * 60 * 1000;
export const STORE_SAVE_INTERVAL_MS = 5 * 60 * 1000;
export const STATE_HEARTBEAT_MS = 30 * 60 * 1000;
export const HISTORY_REQUEST_SPACING_MS = 3000;
// Days of production per intraday request (the Beem application's own pace).
export const DAYS_PER_REQUEST = 7;
// The backfill stops after this many months without any box: the account
// did not exist yet.
const EMPTY_MONTHS_BEFORE_STOP = 2;

/** Connection status messages of the Configuration screen. */
export const STATUS_MESSAGES = {
  missing_credentials: {
    en: 'Enter the e-mail and password of your Beem account.',
    fr: 'Renseignez l’e-mail et le mot de passe de votre compte Beem.',
  },
  auth: {
    en: 'The Beem cloud refused the e-mail or the password.',
    fr: 'Le cloud Beem a refusé l’e-mail ou le mot de passe.',
  },
  rate_limited: {
    en: 'Beem API rate limit reached: new attempt in about 20 minutes.',
    fr: 'Limite de l’API Beem atteinte : nouvel essai dans 20 minutes environ.',
  },
  unavailable: {
    en: 'The Beem cloud is unavailable, new attempt at the next refresh.',
    fr: 'Le cloud Beem est indisponible, nouvel essai au prochain rafraîchissement.',
  },
  network: {
    en: 'The Beem cloud cannot be reached, check the network.',
    fr: 'Le cloud Beem est injoignable, vérifiez le réseau.',
  },
  invalid_response: {
    en: 'Unexpected answer from the Beem cloud, see the integration logs.',
    fr: 'Réponse inattendue du cloud Beem, consultez les logs de l’intégration.',
  },
  no_box: {
    en: 'Connected, but the Beem account has no solar box.',
    fr: 'Connecté, mais le compte Beem ne compte aucune box solaire.',
  },
};

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A comparable fingerprint of the published topology. */
const topologyKey = (boxes, config) =>
  JSON.stringify([config.feature_names, boxes.map((b) => [b.id, b.name, b.peakPowerW])]);

/**
 * Create the installation.
 * @param {{ gladys: object, store: ReturnType<typeof import('./store.js').createStore>, clientFactory?: typeof createBeemClient, now?: () => number, sleep?: (ms: number) => Promise<void> }} options
 */
export function createSite({
  gladys,
  store,
  clientFactory = createBeemClient,
  now = Date.now,
  sleep = defaultSleep,
}) {
  let config = null;
  let client = null;
  let credentialsKey = null;
  let boxes = [];
  let topologyAt = 0;
  let publishedTopology = null;
  const readings = new Map();
  let lastRefreshAt = null;
  let lastError = null;
  let statusKey = null;
  let lastSaveAt = now();
  let refreshInFlight = null;
  let backfillInFlight = null;
  const listeners = new Set();
  // What the daily backfill met: shown by the diagnostic action.
  const dayHistory = { requests: 0, unmatched: [], error: null };

  async function reportStatus(error) {
    const key = error ? `error:${error}` : 'ok';
    if (key === statusKey) {
      return;
    }
    statusKey = key;
    try {
      if (error) {
        await gladys.setConnectionStatus(false, STATUS_MESSAGES[error] ?? STATUS_MESSAGES.network);
      } else if (boxes.length === 0) {
        await gladys.setConnectionStatus(true, STATUS_MESSAGES.no_box);
      } else {
        await gladys.setConnectionStatus(true);
      }
    } catch (err) {
      statusKey = null;
      logger.warn(`Connection status not reported (${err.message})`);
    }
  }

  async function loadTopology(force) {
    if (!force && boxes.length > 0 && now() - topologyAt < TOPOLOGY_REFRESH_MS) {
      return;
    }
    if (force) {
      // A scan (or a (re)connection) re-publishes the devices even unchanged:
      // a box deleted by the user in Gladys comes back.
      publishedTopology = null;
    }
    const payload = await client.getDevices();
    boxes = rawBoxesOf(payload)
      .map(describeBox)
      .sort((a, b) => a.name.localeCompare(b.name));
    topologyAt = now();
    const key = topologyKey(boxes, config);
    if (key !== publishedTopology) {
      if (boxes.length > 0) {
        await gladys.publishDiscoveredDevices(
          boxes.map((box) => buildBoxDevice(gladys, box, config)),
        );
      }
      publishedTopology = key;
      logger.info(`${boxes.length} Beem box(es) published`);
    }
  }

  /** The summary of a month, by box id (null when the request failed). */
  async function summaryOf(period) {
    try {
      return summariesById(await client.getBoxSummary(period));
    } catch (err) {
      logger.warn(`Summary of ${monthKeyOf(period)} unavailable (${err.message})`);
      return null;
    }
  }

  async function doRefresh({ forceTopology = false } = {}) {
    if (!config || !hasCredentials(config)) {
      lastError = 'missing_credentials';
      await reportStatus(lastError);
      return false;
    }
    try {
      await loadTopology(forceTopology);
      const at = now();
      const timeZone = config.timezone;
      const { year, month } = localParts(at, timeZone);
      const currentMonth = monthKeyOf({ year, month });
      const summaries = summariesById(await client.getBoxSummary({ year, month }));

      // Month change: one request per month left, shared by the boxes.
      const previousFinals = new Map();
      for (const box of boxes) {
        const last = store.lastMonthOf(box.id);
        if (last !== null && last !== currentMonth && !previousFinals.has(last)) {
          previousFinals.set(last, await summaryOf(parseMonthKey(last)));
        }
      }

      const states = [];
      const transports = [];
      for (const box of boxes) {
        const reading = readSummary(summaries.get(box.id), at);
        readings.set(box.id, { ...reading, at });
        if (reading.reported) {
          const last = store.lastMonthOf(box.id);
          const finals = last === null ? null : previousFinals.get(last);
          store.record(box.id, reading, {
            now: at,
            dayKey: dayKey(at, timeZone),
            monthKey: currentMonth,
            previousMonthFinalWh: readSummary(finals?.get(box.id), at).monthWh,
          });
        }
        states.push(...boxStates(gladys, box.id, reading, store.indexKwh(box.id)));
        transports.push({
          external_id: boxIds(gladys, box.id).device,
          transport: reading.reported ? DEVICE_TRANSPORTS.CLOUD : DEVICE_TRANSPORTS.UNREACHABLE,
        });
      }
      if (states.length > 0) {
        await gladys.publishChangedStates(states, { heartbeat: STATE_HEARTBEAT_MS });
      }
      if (transports.length > 0) {
        await gladys.publishTransports(transports);
      }
      lastRefreshAt = at;
      lastError = null;
      await reportStatus(null);
      if (now() - lastSaveAt >= STORE_SAVE_INTERVAL_MS) {
        lastSaveAt = now();
        await store.save();
      }
      for (const listener of listeners) {
        try {
          await listener();
        } catch (err) {
          logger.error('Refresh listener failed', err);
        }
      }
      return true;
    } catch (err) {
      lastError = err instanceof BeemApiError ? err.code : 'network';
      if (!(err instanceof BeemApiError)) {
        logger.error('Refresh failed', err);
      } else {
        logger.warn(`Refresh failed: ${err.message}`);
      }
      await reportStatus(lastError);
      return false;
    }
  }

  async function backfillMonths() {
    const current = parseMonthKey(monthKey(now(), config.timezone));
    let fetched = 0;
    let empty = 0;
    for (let offset = 1; offset <= config.history_months; offset += 1) {
      const period = shiftMonth(current, -offset);
      const key = monthKeyOf(period);
      if (store.isMonthFetched(key)) {
        empty = 0;
        continue;
      }
      if (fetched > 0) {
        await sleep(HISTORY_REQUEST_SPACING_MS);
      }
      let summaries;
      try {
        summaries = await client.getBoxSummary(period);
      } catch (err) {
        logger.warn(`History of ${key} not fetched (${err.message}): retried at the next start`);
        break;
      }
      fetched += 1;
      let any = false;
      for (const [id, entry] of summariesById(summaries)) {
        const { monthWh } = readSummary(entry, now());
        if (monthWh !== null) {
          store.setMonth(id, key, monthWh);
          any = any || monthWh > 0;
        }
      }
      store.markMonthFetched(key);
      empty = any ? 0 : empty + 1;
      if (empty >= EMPTY_MONTHS_BEFORE_STOP) {
        break;
      }
    }
    return fetched;
  }

  /**
   * The daily totals of the past days, from the hourly production of the
   * Beem application: 7 days per request, from yesterday back, each period
   * once. Best effort: a payload whose devices match no box stops it (the
   * diagnostic shows its keys), an error retries at the next start.
   */
  async function backfillDays() {
    const timeZone = config.timezone;
    const today = dayKey(now(), timeZone);
    const maxDays = Math.min(DAY_RETENTION, config.history_months * 31);
    const dayOf = (at) => dayKey(at, timeZone);
    let fetched = 0;
    let empty = 0;
    for (let back = DAYS_PER_REQUEST; back <= maxDays; back += DAYS_PER_REQUEST) {
      const first = shiftDay(today, -back);
      if (store.areDaysFetched(first)) {
        empty = 0;
        continue;
      }
      if (fetched > 0) {
        await sleep(HISTORY_REQUEST_SPACING_MS);
      }
      let payload;
      try {
        payload = await client.getProductionIntraday({
          from: new Date(startOfDayKey(first, timeZone)).toISOString(),
          to: new Date(startOfDayKey(shiftDay(first, DAYS_PER_REQUEST), timeZone)).toISOString(),
        });
      } catch (err) {
        dayHistory.error = err.message;
        logger.warn(`Daily history from ${first} not fetched (${err.message})`);
        break;
      }
      fetched += 1;
      const { days, unmatched } = intradayDays(payload, boxes, dayOf);
      if (days.size === 0 && unmatched.length > 0) {
        dayHistory.unmatched = [...new Set(unmatched)];
        logger.warn(
          `Daily history: no device of the intraday production matches a box (keys: ${dayHistory.unmatched.join(' | ')})`,
        );
        break;
      }
      let any = false;
      for (const [id, totals] of days) {
        for (const [key, wh] of totals) {
          // Only the days of the period: the edges of the request can carry
          // an hour of the day before or after.
          if (key >= first && key < shiftDay(first, DAYS_PER_REQUEST)) {
            store.setDay(id, key, Math.round(wh));
            any = any || wh > 0;
          }
        }
      }
      store.markDaysFetched(first);
      empty = any ? 0 : empty + 1;
      if (empty >= EMPTY_MONTHS_BEFORE_STOP) {
        break;
      }
    }
    dayHistory.requests += fetched;
    return fetched;
  }

  async function doBackfill() {
    if (!config || !hasCredentials(config) || config.history_months === 0) {
      return 0;
    }
    const months = await backfillMonths();
    const days = boxes.length > 0 ? await backfillDays() : 0;
    if (months + days > 0) {
      logger.info(`Production history: ${months} month(s), ${days} week(s) of days fetched`);
      await store.save();
      for (const listener of listeners) {
        await Promise.resolve(listener()).catch(() => {});
      }
    }
    return months;
  }

  return {
    /** Apply a (new) configuration; new credentials start a new client. */
    configure(newConfig) {
      const key = `${newConfig.email}\u0000${newConfig.password}`;
      const topologyChanged = config && config.feature_names !== newConfig.feature_names;
      config = newConfig;
      if (key !== credentialsKey) {
        credentialsKey = key;
        client = hasCredentials(newConfig)
          ? clientFactory({ email: newConfig.email, password: newConfig.password })
          : null;
        boxes = [];
        topologyAt = 0;
        publishedTopology = null;
        statusKey = null;
      } else if (topologyChanged) {
        publishedTopology = null;
      }
    },

    /** Read the cloud now (concurrent calls share one refresh). */
    refresh(options) {
      if (!refreshInFlight) {
        refreshInFlight = doRefresh(options).finally(() => {
          refreshInFlight = null;
        });
      }
      return refreshInFlight;
    },

    /** Fetch the monthly history not fetched yet. */
    backfillHistory() {
      if (!backfillInFlight) {
        backfillInFlight = doBackfill().finally(() => {
          backfillInFlight = null;
        });
      }
      return backfillInFlight;
    },

    /** Called after every successful refresh (alerts, widget refresh). */
    onRefresh(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    client: () => client,
    config: () => config,
    lastRefreshAt: () => lastRefreshAt,
    lastError: () => lastError,
    dayHistory: () => ({ ...dayHistory }),

    /**
     * One snapshot per box, the only shape the widgets, scenes and alerts
     * read.
     */
    snapshots() {
      return boxes.map((box) => ({
        ...box,
        externalId: boxIds(gladys, box.id).device,
        reading: readings.get(box.id) ?? readSummary(undefined, now()),
        indexKwh: store.indexKwh(box.id),
        history: store.history(box.id),
      }));
    },

    store,
  };
}
