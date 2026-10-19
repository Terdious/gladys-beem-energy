// -----------------------------------------------------------------------------
// Scene actions (Gladys 5.1+).
//
//   - `get_production`: the current figures of one box, or of the whole
//     installation when no box is chosen, as outputs a scene reuses
//     ({{action.today_kwh}} in a message, a condition on the power to start
//     the dishwasher when the sun shines...).
//
// The scene triggers need no handler: src/alerts.js fires them.
// -----------------------------------------------------------------------------

import { boxFigures, siteFigures } from './production.js';
import { buildTariff, valueOf } from './savings.js';

export const GET_PRODUCTION_ACTION = 'get_production';

const round = (value, digits = 2) =>
  value === null || value === undefined ? null : Math.round(value * 10 ** digits) / 10 ** digits;

/**
 * Outputs of `get_production`.
 * @param {object} site
 * @param {{ device?: string }} fields
 * @param {number} now
 */
export function productionOutputs(site, fields, now = Date.now()) {
  const config = site.config();
  const all = site.snapshots();
  const chosen = fields?.device ? all.find((box) => box.externalId === fields.device) : null;
  if (fields?.device && !chosen) {
    throw new Error('Unknown Beem box: pick another one in the scene');
  }
  const figures = chosen
    ? boxFigures(chosen, now, config.timezone)
    : siteFigures(all, now, config.timezone);
  const { tariff } = buildTariff(config);
  const value = (kwh) => (tariff && kwh !== null ? round(valueOf(kwh, tariff).total) : null);
  return {
    power_w: figures.powerW,
    today_kwh: round(figures.todayKwh),
    month_kwh: round(figures.monthKwh),
    year_kwh: round(figures.yearKwh),
    load_percent: figures.loadPercent,
    savings_today: value(figures.todayKwh),
    savings_month: value(figures.monthKwh),
  };
}

/** @type {Record<string, (gladys: object, ctx: { fields: object, site: object }) => Promise<object>>} */
export const SCENE_ACTIONS = {
  async [GET_PRODUCTION_ACTION](_gladys, { fields, site }) {
    if (site.lastRefreshAt() === null) {
      await site.refresh();
    }
    return productionOutputs(site, fields);
  },
};
