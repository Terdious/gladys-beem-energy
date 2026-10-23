// -----------------------------------------------------------------------------
// The `history` widget: the production over time, as bars.
//
// The period is chosen live (src/dashboard/period.js): a month (one bar per
// day), a year (one bar per month) or all the years (one bar per year), and
// "Previous" / "Next" step through the past months and years. The days come
// from the integration itself and from the hourly history of the Beem cloud
// fetched at startup; the months from the monthly history of the cloud.
//
// Tiles: the production of the period, its average per day / month / year,
// the best one, and the comparison with the same period one year before.
// Status: the best day / month / year, the comparison in kWh, and the
// ranking of the boxes over the period (with their yield per kWp).
//
// Content budget of the core: 8 components, buttons included.
// -----------------------------------------------------------------------------

import { WIDGET_COLORS } from '@gladysassistant/integration-sdk';

import { energyOfDays, energyOfMonths, firstMonthOf, siteFigures } from '../production.js';
import {
  T,
  UNKNOWN,
  NO_BOX,
  NOT_CONNECTED,
  clip,
  fitRows,
  headingOf,
  kwhText,
  kwhValue,
  messageContent,
  siteSelection,
  tile,
  titleOf,
} from './common.js';
import {
  PER_ENTRY,
  entryInstant,
  entryLabel,
  hasPrevious,
  labelText,
  sharedViews,
  viewButtons,
  viewMessage,
  windowEnergy,
  windowOf,
} from './period.js';

export const HISTORY_WIDGET = 'history';

const MAX_COMPONENTS = 8;

// The `period` setting (stored values kept from 1.0) is the default view.
const DEFAULT_PERIODS = { days: 'month', months_12: 'year', months_24: 'year' };

export const historyView = (settings) => ({
  periods: ['month', 'year', 'all'],
  defaultPeriod: DEFAULT_PERIODS[settings?.period] ?? 'month',
});

/**
 * The production of the period against the same period one year before,
 * like for like: a month against the same month (a current month against
 * the same days), a year against the same months (a current year against
 * its complete months only), each side over what both know. Null when the
 * year before is unknown, or for all the years.
 * @returns {{ previousKwh: number, percent: number|null }|null}
 */
export function yearOverYear(boxes, window, now, timeZone) {
  const back = (key) => `${Number(key.slice(0, 4)) - 1}${key.slice(4)}`;
  let pairs;
  if (window.period === 'month' && window.current) {
    // A month not over: against the same days one year before.
    const days = window.days;
    pairs = zip(
      energyOfDays(boxes, days, now, timeZone),
      energyOfDays(boxes, days.map(back), now, timeZone),
    );
  } else if (window.period === 'month') {
    pairs = zip(
      energyOfMonths(boxes, [window.month], now, timeZone),
      energyOfMonths(boxes, [back(window.month)], now, timeZone),
    );
  } else if (window.period === 'year') {
    // A year not over: its complete months only.
    const months = window.current ? window.months.slice(0, -1) : window.months;
    pairs = zip(
      energyOfMonths(boxes, months, now, timeZone),
      energyOfMonths(boxes, months.map(back), now, timeZone),
    );
  } else {
    return null;
  }
  // Like for like: only the days / months known on both sides.
  const both = pairs.filter(([a, b]) => a.kwh !== null && b.kwh !== null);
  if (both.length === 0) {
    return null;
  }
  const current = both.reduce((total, [a]) => total + a.kwh, 0);
  const previous = both.reduce((total, [, b]) => total + b.kwh, 0);
  return {
    previousKwh: previous,
    percent: previous > 0 ? Math.round(((current - previous) / previous) * 100) : null,
  };
}

const zip = (a, b) => a.map((entry, i) => [entry, b[i]]);

const signed = (percent) => `${percent > 0 ? '+' : ''}${percent} %`;

/**
 * Content of the history widget.
 * @param {object} site
 * @param {Array<object>} boxes snapshots
 * @param {{ now: number, config: object, title: string|object|null,
 *   view?: { period: string, offset: number }, periods?: string[] }} options
 */
export function historyContent(
  site,
  boxes,
  { now, config, title, view = { period: 'month', offset: 0 }, periods = historyView().periods },
) {
  const timeZone = config.timezone;
  const firstMonth = firstMonthOf(boxes);
  const window = windowOf(view.period, view.offset, now, timeZone, {
    firstYear: firstMonth?.slice(0, 4),
  });
  const energy = windowEnergy(site.store, boxes, window, now, timeZone);
  const known = energy.entries.filter((entry) => entry.kwh !== null);
  const label = labelText(window.label);

  const components = headingOf(title);
  if (known.length > 0) {
    components.push({
      type: 'chart',
      series: [
        {
          name: T('Production', 'Production'),
          points: known.map((entry) => ({
            t: entryInstant(window, entry.key),
            v: kwhValue(entry.kwh),
          })),
        },
      ],
      chart_type: 'bar',
      title: T(`Production · ${label.en}`, `Production · ${label.fr}`),
      unit: 'kWh',
    });
  }

  // The average leaves out the current day / month / year: not over yet.
  const complete = energy.entries.filter(
    (entry, i) => entry.kwh !== null && !(window.current && i === energy.entries.length - 1),
  );
  const average =
    complete.length > 0
      ? complete.reduce((sum, entry) => sum + entry.kwh, 0) / complete.length
      : null;
  const best = known.reduce((top, entry) => (entry.kwh > (top?.kwh ?? -1) ? entry : top), null);
  const comparison = yearOverYear(boxes, window, now, timeZone);

  const rows = [];
  if (known.length === 0) {
    rows.push({
      label: T('Period', 'Période'),
      icon: 'calendar',
      value: T(`${label.en} · no data`, `${label.fr} · aucune donnée`),
      color: WIDGET_COLORS.NEUTRAL,
    });
  }
  if (best) {
    const bestLabel = labelText(entryLabel(window, best.key));
    rows.push({
      label: T('Best', 'Meilleur'),
      icon: 'award',
      value: T(`${bestLabel.en} · ${kwhText(best.kwh)}`, `${bestLabel.fr} · ${kwhText(best.kwh)}`),
      color: WIDGET_COLORS.SUCCESS,
    });
  }
  if (comparison) {
    rows.push({
      label: T('One year before', 'Un an plus tôt'),
      icon: comparison.percent !== null && comparison.percent < 0 ? 'trending-down' : 'trending-up',
      value:
        comparison.percent === null
          ? kwhText(comparison.previousKwh)
          : `${signed(comparison.percent)} · ${kwhText(comparison.previousKwh)}`,
      color:
        comparison.percent !== null && comparison.percent < 0
          ? WIDGET_COLORS.WARNING
          : WIDGET_COLORS.SUCCESS,
    });
  }
  const ranking = boxes
    .map((box) => ({
      box,
      kwh: windowEnergy(site.store, [box], window, now, timeZone).total,
      peakKw: siteFigures([box], now, timeZone).peakKw,
    }))
    .filter((entry) => entry.kwh !== null)
    .sort((a, b) => b.kwh - a.kwh);
  for (const { box, kwh, peakKw } of ranking) {
    const perKwp = peakKw ? ` · ${kwhValue(kwh / peakKw)} kWh/kWc` : '';
    rows.push({
      label: clip(box.name),
      icon: 'sun',
      value: `${kwhText(kwh)}${perKwp}`,
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

  components.push(...viewButtons(view, periods, hasPrevious(window, { now, firstMonth })));
  const tiles = [
    tile(kwhValue(energy.total), 'kWh', T('Production', 'Production'), 'layers'),
    tile(kwhValue(average), 'kWh', PER_ENTRY[window.kind], 'activity'),
    tile(kwhValue(best?.kwh ?? null), 'kWh', T('Best', 'Meilleur'), 'award'),
  ];
  if (comparison?.percent !== null && comparison?.percent !== undefined) {
    tiles.push(
      tile(
        signed(comparison.percent),
        null,
        T('Vs one year before', 'Vs un an plus tôt'),
        comparison.percent < 0 ? 'trending-down' : 'trending-up',
      ),
    );
  }
  components.push(...tiles.slice(0, Math.max(0, MAX_COMPONENTS - components.length)));
  return { ttl_seconds: 300, components };
}

const boxesOf = (all, settings) => {
  const { boxes } = siteSelection(all, { devices: settings.devices });
  return boxes.length > 0 ? boxes : all;
};

export const historyWidget = {
  async get(_gladys, { settings = {}, site, views = sharedViews }) {
    const all = site.snapshots();
    if (all.length === 0) {
      return messageContent(site.lastRefreshAt() === null ? NOT_CONNECTED : NO_BOX);
    }
    const spec = historyView(settings);
    return historyContent(site, boxesOf(all, settings), {
      now: Date.now(),
      config: site.config(),
      title: titleOf(settings, null),
      view: views.get(HISTORY_WIDGET, settings, spec),
      periods: spec.periods,
    });
  },

  async action(_gladys, { actionKey, settings = {}, values, site, views = sharedViews }) {
    const view = views.apply(HISTORY_WIDGET, settings, historyView(settings), actionKey, values);
    const firstMonth = firstMonthOf(boxesOf(site.snapshots(), settings));
    return viewMessage(
      windowOf(view.period, view.offset, Date.now(), site.config().timezone, {
        firstYear: firstMonth?.slice(0, 4),
      }),
    );
  },
};
