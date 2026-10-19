// -----------------------------------------------------------------------------
// Scene triggers, evaluated after every refresh of the cloud.
//
//   - `box_underperforming`: a box produces clearly less than the others
//     (src/production.js underperformers): `silent` once it stayed silent
//     SILENCE_CONFIRM_MS while its peers produce, `low_yield` from
//     LOW_YIELD_FROM_HOUR (the morning is too short to compare yields:
//     orientations differ). Once per box and per day: a scene sends one
//     notification, not one per refresh.
//   - `daily_production_report`: the solar day is over (from REPORT_FROM_HOUR,
//     every box at 0 W for REPORT_QUIET_MS), or REPORT_LATEST_HOUR is
//     reached: the day's figures, once per day, for a notification scene.
//
// The once-per-day marks are saved in the store: a restart in the evening
// does not send the report twice.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';

import { boxFigures, siteFigures, underperformers } from './production.js';
import { buildTariff, valueOf } from './savings.js';
import { dayKey, localParts } from './time.js';

const logger = createLogger({ name: 'alerts' });

export const UNDERPERFORMING_TRIGGER = 'box_underperforming';
export const DAILY_REPORT_TRIGGER = 'daily_production_report';
export const SCENE_TRIGGER_KEYS = [UNDERPERFORMING_TRIGGER, DAILY_REPORT_TRIGGER];

export const SILENCE_CONFIRM_MS = 30 * 60 * 1000;
export const LOW_YIELD_FROM_HOUR = 14;
export const REPORT_FROM_HOUR = 16;
export const REPORT_LATEST_HOUR = 22;
export const REPORT_QUIET_MS = 30 * 60 * 1000;

const round = (value, digits = 2) =>
  value === null || value === undefined ? null : Math.round(value * 10 ** digits) / 10 ** digits;

/**
 * Create the evaluator.
 * @param {{ gladys: object, site: ReturnType<typeof import('./site.js').createSite>, now?: () => number }} options
 */
export function createAlerts({ gladys, site, now = Date.now }) {
  const silentSince = new Map();
  let producingSeenAt = null;

  async function fire(key, data) {
    try {
      await gladys.publishSceneEvent(key, data);
    } catch (err) {
      logger.warn(`Scene event ${key} not published (${err.message})`);
    }
  }

  async function evaluateUnderperformance(boxes, config, at, today, hour) {
    const flagged = underperformers(boxes, at, config.timezone, config.underperformance_threshold);
    const silentIds = new Set(flagged.filter((f) => f.reason === 'silent').map((f) => f.box.id));
    for (const id of [...silentSince.keys()]) {
      if (!silentIds.has(id)) {
        silentSince.delete(id);
      }
    }
    for (const { box, reason, ratio } of flagged) {
      if (reason === 'silent') {
        if (!silentSince.has(box.id)) {
          silentSince.set(box.id, at);
        }
        if (at - silentSince.get(box.id) < SILENCE_CONFIRM_MS) {
          continue;
        }
      } else if (hour < LOW_YIELD_FROM_HOUR) {
        continue;
      }
      const mark = `underperforming:${box.id}`;
      if (site.store.eventMark(mark) === today) {
        continue;
      }
      site.store.setEventMark(mark, today);
      const figures = boxFigures(box, at, config.timezone);
      logger.info(`Box ${box.name} underperforming (${reason})`);
      await fire(UNDERPERFORMING_TRIGGER, {
        device: box.externalId,
        device_name: box.name,
        reason,
        ratio,
        today_kwh: round(figures.todayKwh),
      });
    }
  }

  async function evaluateDailyReport(boxes, config, at, today, hour) {
    const figures = siteFigures(boxes, at, config.timezone);
    if (figures.powerW > 0) {
      producingSeenAt = at;
    }
    if (site.store.eventMark('daily_report') === today || hour < REPORT_FROM_HOUR) {
      return;
    }
    const quiet =
      figures.powerW === 0 && (producingSeenAt === null || at - producingSeenAt >= REPORT_QUIET_MS);
    if (!quiet && hour < REPORT_LATEST_HOUR) {
      return;
    }
    site.store.setEventMark('daily_report', today);
    const { tariff } = buildTariff(config);
    const best = boxes
      .map((box) => ({ box, kwh: boxFigures(box, at, config.timezone).todayKwh ?? 0 }))
      .sort((a, b) => b.kwh - a.kwh)[0];
    const todayKwh = figures.todayKwh ?? 0;
    await fire(DAILY_REPORT_TRIGGER, {
      today_kwh: round(todayKwh),
      month_kwh: round(figures.monthKwh),
      yield_kwh_per_kwp: round(figures.yieldToday),
      savings: tariff ? round(valueOf(todayKwh, tariff).total) : null,
      co2_kg: round((todayKwh * config.co2_factor) / 1000),
      best_box: best?.box.name ?? null,
      best_box_kwh: best ? round(best.kwh) : null,
    });
  }

  return {
    /** Evaluate the triggers on the current snapshots. */
    async evaluate() {
      const config = site.config();
      const boxes = site.snapshots();
      if (!config || boxes.length === 0) {
        return;
      }
      const at = now();
      const today = dayKey(at, config.timezone);
      const { hour } = localParts(at, config.timezone);
      await evaluateUnderperformance(boxes, config, at, today, hour);
      await evaluateDailyReport(boxes, config, at, today, hour);
    },
  };
}
