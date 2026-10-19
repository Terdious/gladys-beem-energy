// -----------------------------------------------------------------------------
// The `history` widget: the production over time, as bars.
//
// `period: days`: the last 30 days (the days the integration saw: the cloud
// gives no daily history, they accumulate from the installation of the
// integration on). `period: months`: the last 12 or 24 months (the monthly
// history the cloud gives, fetched at startup).
//
// Tiles: the total and the average of the period, the best day (or month).
// Status: the current month against the same month of last year, the
// records, the best box of the period.
// -----------------------------------------------------------------------------

import { WIDGET_COLORS } from '@gladysassistant/integration-sdk';

import { boxFigures, dailySeries, monthlySeries, siteFigures } from '../production.js';
import { dayKey, monthKey, parseMonthKey, shiftMonth, monthKeyOf } from '../time.js';
import {
  T,
  UNKNOWN,
  clip,
  NO_BOX,
  NOT_CONNECTED,
  dayInstant,
  dayLabel,
  fitRows,
  kwhText,
  kwhValue,
  messageContent,
  monthInstant,
  monthLabel,
  siteSelection,
  tile,
  titleOf,
} from './common.js';

export const HISTORY_WIDGET = 'history';

export const PERIODS = { DAYS: 'days', MONTHS_12: 'months_12', MONTHS_24: 'months_24' };

const best = (series) =>
  series.reduce(
    (top, entry) => (entry.kwh !== null && entry.kwh > (top?.kwh ?? -1) ? entry : top),
    null,
  );

/** The current month against the same month one year before: `+12 %`. */
export function yearOverYear(boxes, now, timeZone) {
  const current = parseMonthKey(monthKey(now, timeZone));
  const previousKey = monthKeyOf(shiftMonth(current, -12));
  const figures = siteFigures(boxes, now, timeZone);
  const previous = boxes
    .map((box) => box.history.months[previousKey])
    .filter((wh) => wh !== undefined);
  if (previous.length === 0 || figures.monthKwh === null) {
    return null;
  }
  const previousKwh = previous.reduce((total, wh) => total + wh, 0) / 1000;
  return {
    previousKey,
    previousKwh,
    ratio: previousKwh > 0 ? (figures.monthKwh - previousKwh) / previousKwh : null,
  };
}

/**
 * Content of the history widget.
 * @param {Array<object>} boxes snapshots
 * @param {{ now: number, config: object, title: string|object, period: string }} options
 */
export function historyContent(boxes, { now, config, title, period }) {
  const timeZone = config.timezone;
  const daily = period === PERIODS.DAYS;
  const series = daily
    ? dailySeries(boxes, now, timeZone, 30)
    : monthlySeries(boxes, now, timeZone, period === PERIODS.MONTHS_24 ? 24 : 12);
  const known = series.filter((entry) => entry.kwh !== null);
  const components = [{ type: 'text', variant: 'heading', text: title }];
  if (known.length > 0) {
    components.push({
      type: 'chart',
      series: [
        {
          name: T('Production', 'Production'),
          points: known.map((entry) => ({
            t: daily ? dayInstant(entry.key) : monthInstant(entry.key),
            v: kwhValue(entry.kwh),
          })),
        },
      ],
      chart_type: 'bar',
      title: daily ? T('Last 30 days', '30 derniers jours') : T('Per month', 'Par mois'),
      unit: 'kWh',
    });
  }
  const total = known.reduce((sum, entry) => sum + entry.kwh, 0);
  // The average leaves out the current day / month: it is not over yet.
  const complete = known.filter(
    (entry) => entry.key !== (daily ? dayKey(now, timeZone) : monthKey(now, timeZone)),
  );
  const average =
    complete.length > 0
      ? complete.reduce((sum, entry) => sum + entry.kwh, 0) / complete.length
      : null;
  const top = best(known);
  components.push(
    tile(
      kwhValue(known.length > 0 ? total : null),
      'kWh',
      T('Over the period', 'Sur la période'),
      'layers',
    ),
    tile(
      kwhValue(average),
      'kWh',
      daily
        ? T('Per day (average)', 'Par jour (moyenne)')
        : T('Per month (average)', 'Par mois (moyenne)'),
      'activity',
    ),
    tile(
      kwhValue(top?.kwh ?? null),
      'kWh',
      daily ? T('Best day', 'Meilleur jour') : T('Best month', 'Meilleur mois'),
      'award',
    ),
  );

  const rows = [];
  if (top) {
    rows.push({
      label: daily ? T('Best day', 'Meilleur jour') : T('Best month', 'Meilleur mois'),
      icon: 'award',
      value: daily
        ? `${dayLabel(top.key)} · ${kwhText(top.kwh)}`
        : T(
            `${monthLabel(top.key).en} · ${kwhText(top.kwh)}`,
            `${monthLabel(top.key).fr} · ${kwhText(top.kwh)}`,
          ),
      color: WIDGET_COLORS.SUCCESS,
    });
  }
  const comparison = yearOverYear(boxes, now, timeZone);
  if (comparison) {
    const label = monthLabel(comparison.previousKey);
    const percent = comparison.ratio === null ? null : Math.round(comparison.ratio * 100);
    rows.push({
      label: T(`This month vs ${label.en}`, `Ce mois vs ${label.fr}`),
      icon: percent !== null && percent < 0 ? 'trending-down' : 'trending-up',
      value:
        percent === null
          ? kwhText(comparison.previousKwh)
          : `${percent > 0 ? '+' : ''}${percent} % · ${kwhText(comparison.previousKwh)}`,
      color: percent !== null && percent < 0 ? WIDGET_COLORS.WARNING : WIDGET_COLORS.SUCCESS,
    });
  }
  const ranking = boxes
    .map((box) => ({ box, figures: boxFigures(box, now, timeZone) }))
    .filter(({ figures }) => figures.monthKwh !== null)
    .sort((a, b) => (b.figures.monthKwh ?? 0) - (a.figures.monthKwh ?? 0));
  for (const { box, figures } of ranking.slice(0, 6)) {
    const perKwp = figures.peakKw
      ? ` · ${kwhValue(figures.monthKwh / figures.peakKw)} kWh/kWc`
      : '';
    rows.push({
      label: clip(box.name),
      icon: 'sun',
      value: `${kwhText(figures.monthKwh)}${perKwp}`,
      color: WIDGET_COLORS.NEUTRAL,
    });
  }
  if (rows.length === 0) {
    rows.push({
      label: T('History', 'Historique'),
      icon: 'info',
      value: UNKNOWN,
      color: WIDGET_COLORS.NEUTRAL,
    });
  }
  components.push({ type: 'status', items: fitRows(rows) });
  return { ttl_seconds: 300, components };
}

export const historyWidget = {
  async get(_gladys, { settings = {}, site }) {
    const config = site.config();
    const all = site.snapshots();
    if (all.length === 0) {
      return messageContent(site.lastRefreshAt() === null ? NOT_CONNECTED : NO_BOX);
    }
    const { boxes } = siteSelection(all, { devices: settings.devices });
    const period = Object.values(PERIODS).includes(settings.period)
      ? settings.period
      : PERIODS.DAYS;
    return historyContent(boxes.length > 0 ? boxes : all, {
      now: Date.now(),
      config,
      title: titleOf(settings, T('Solar production', 'Production solaire')),
      period,
    });
  },
};
