// -----------------------------------------------------------------------------
// The `site` widget: the whole solar installation on one card.
//
// Single-phase: the totals of the selected boxes (none: all of them).
// Three-phase: the boxes assigned to L1, L2 and L3 in three device
// multi-selects (one Beem box per phase and kit size, typically), one status
// row per phase, and a phase balance row: the spread between the highest and
// the lowest phase power, in warning past the `imbalance_threshold` setting
// (a three-phase meter counts each phase on its own: a production all on L1
// does not offset a consumption on L2).
//
// The period is chosen live (src/dashboard/period.js): 12 hours and day show
// the power curve (the 5-minute averages of src/store.js, one curve per phase
// in three-phase), week and month the production per day, year per month;
// "Previous" / "Next" step through the past periods. The current day leads
// with the live figures (power, today, month, year, share of the peak
// power); a past or longer period with its production, average, best and
// yield. The live alerts (silent boxes, low yield) show on the current
// period only.
//
// Content budget of the core: 8 components, buttons included. The tiles get
// the room the heading, the chart, the status and the buttons leave, the most
// useful first.
// -----------------------------------------------------------------------------

import { WIDGET_COLORS } from '@gladysassistant/integration-sdk';

import {
  curveOf,
  firstCurveAt,
  firstMonthOf,
  siteFigures,
  underperformers,
} from '../production.js';
import {
  T,
  UNKNOWN,
  ASSIGN_PHASES,
  LAYOUTS,
  NO_BOX,
  NOT_CONNECTED,
  fitRows,
  headingOf,
  kwhText,
  kwhValue,
  messageContent,
  namesOf,
  round,
  selectionAlerts,
  siteSelection,
  tile,
  titleOf,
} from './common.js';
import {
  PER_ENTRY,
  bestLabel,
  entryInstant,
  hasPrevious,
  labelText,
  sharedViews,
  viewButtons,
  viewMessage,
  windowEnergy,
  windowOf,
} from './period.js';

export const SITE_WIDGET = 'site';

// Default of the `imbalance_threshold` setting (W), the manifest's too.
export const DEFAULT_IMBALANCE_THRESHOLD = 500;
// Points of an inline chart series the core keeps.
const MAX_CHART_POINTS = 300;
// Components of a content the core keeps.
const MAX_COMPONENTS = 8;

export const SITE_VIEW = {
  periods: ['hours_12', 'day', 'week', 'month', 'year'],
  defaultPeriod: 'day',
};

/** The `imbalance_threshold` setting, a non-negative number of watts. */
export function thresholdOf(settings) {
  const raw = settings?.imbalance_threshold;
  const value = Number(raw);
  return raw !== undefined && raw !== null && raw !== '' && Number.isFinite(value) && value >= 0
    ? value
    : DEFAULT_IMBALANCE_THRESHOLD;
}

/**
 * Phase balance: spread between the highest and the lowest power of the
 * phases that have boxes. Null with fewer than two such phases.
 */
export function phaseBalance(phases, now, timeZone, threshold) {
  const powers = phases
    .filter((phase) => phase.boxes.length > 0)
    .map((phase) => ({
      label: phase.label,
      w: siteFigures(phase.boxes, now, timeZone).powerW ?? 0,
    }));
  if (powers.length < 2) {
    return null;
  }
  const highest = powers.reduce((best, phase) => (phase.w > best.w ? phase : best));
  const lowest = powers.reduce((best, phase) => (phase.w < best.w ? phase : best));
  const spread = Math.round(highest.w - lowest.w);
  return { spread, highest: highest.label, warning: spread > threshold };
}

const reportingColor = (reporting, count) =>
  reporting === count
    ? WIDGET_COLORS.SUCCESS
    : reporting === 0
      ? WIDGET_COLORS.DANGER
      : WIDGET_COLORS.WARNING;

/** "L1 (2) · 1.9 kWc": the phase, its boxes, its peak power. */
function phaseLabel(label, boxes, figures) {
  return `${label} (${boxes.length})${figures.peakKw ? ` · ${round(figures.peakKw, 1)} kWc` : ''}`;
}

function livePhaseRows(phases, now, timeZone) {
  return phases.map(({ label, boxes }) => {
    if (boxes.length === 0) {
      return {
        label,
        icon: 'git-commit',
        value: T('No box', 'Aucune box'),
        color: WIDGET_COLORS.NEUTRAL,
      };
    }
    const figures = siteFigures(boxes, now, timeZone);
    return {
      label: phaseLabel(label, boxes, figures),
      icon: 'git-commit',
      value: `${figures.powerW ?? UNKNOWN} W · ${kwhText(figures.todayKwh)}`,
      color: reportingColor(figures.reporting, boxes.length),
    };
  });
}

/** Phase rows of a past or long period: its production and its share. */
function periodPhaseRows(site, phases, window, now, timeZone, total) {
  return phases.map(({ label, boxes }) => {
    if (boxes.length === 0) {
      return {
        label,
        icon: 'git-commit',
        value: T('No box', 'Aucune box'),
        color: WIDGET_COLORS.NEUTRAL,
      };
    }
    const figures = siteFigures(boxes, now, timeZone);
    const energy = windowEnergy(site.store, boxes, window, now, timeZone).total;
    const share = energy !== null && total > 0 ? ` · ${Math.round((energy / total) * 100)} %` : '';
    return {
      label: phaseLabel(label, boxes, figures),
      icon: 'git-commit',
      value: `${kwhText(energy)}${share}`,
      color: WIDGET_COLORS.NEUTRAL,
    };
  });
}

function balanceRow({ spread, highest, warning }) {
  return {
    label: T('Phase balance', 'Équilibre des phases'),
    icon: 'bar-chart-2',
    value:
      spread === 0
        ? T('Balanced', 'Équilibrées')
        : T(`Δ ${spread} W · ${highest} highest`, `Δ ${spread} W · ${highest} la plus haute`),
    color: warning ? WIDGET_COLORS.WARNING : WIDGET_COLORS.SUCCESS,
  };
}

/** The chart of a window: power curves, or production bars. */
export function siteChart(site, selection, window, now, timeZone) {
  const groups =
    selection.layout === LAYOUTS.THREE_PHASE
      ? selection.phases
          .filter((phase) => phase.boxes.length > 0)
          .map((phase) => ({ name: phase.label, boxes: phase.boxes }))
      : [{ name: T('Production', 'Production'), boxes: selection.boxes }];
  const label = labelText(window.label);
  if (window.kind === 'curve') {
    // One resolution for the whole chart: the 5-minute samples, or the hours.
    const { hourly } = curveOf(site.store, selection.boxes, window.from, window.to);
    const series = groups
      .map((group) => ({
        name: group.name,
        points: curveOf(site.store, group.boxes, window.from, window.to, { hourly })
          .points.slice(-MAX_CHART_POINTS)
          .map(({ t, w }) => ({ t: new Date(t).toISOString(), v: w })),
      }))
      .filter((entry) => entry.points.length > 0);
    if (series.length === 0) {
      return null;
    }
    return {
      type: 'chart',
      series,
      chart_type: 'area',
      title: hourly
        ? T(`Hourly power · ${label.en}`, `Puissance horaire · ${label.fr}`)
        : T(`Power · ${label.en}`, `Puissance · ${label.fr}`),
      unit: 'W',
      ...(window.current ? { now_marker: true } : {}),
    };
  }
  const series = groups
    .map((group) => ({
      name: group.name,
      points: windowEnergy(site.store, group.boxes, window, now, timeZone)
        .entries.filter((entry) => entry.kwh !== null)
        .map((entry) => ({ t: entryInstant(window, entry.key), v: kwhValue(entry.kwh) })),
    }))
    .filter((entry) => entry.points.length > 0);
  if (series.length === 0) {
    return null;
  }
  return {
    type: 'chart',
    series,
    chart_type: 'bar',
    title: T(`Production · ${label.en}`, `Production · ${label.fr}`),
    unit: 'kWh',
  };
}

/** Tiles of the live day: power, today, month, year, share of the peak. */
function liveTiles(figures) {
  return [
    tile(figures.powerW, 'W', T('Power', 'Puissance'), 'sun'),
    tile(kwhValue(figures.todayKwh), 'kWh', T('Today', "Aujourd'hui"), 'zap'),
    tile(kwhValue(figures.monthKwh), 'kWh', T('This month', 'Ce mois-ci'), 'calendar'),
    tile(kwhValue(figures.yearKwh), 'kWh', T('This year', 'Cette année'), 'trending-up'),
    {
      type: 'gauge',
      value: figures.loadPercent ?? 0,
      min: 0,
      max: 100,
      unit: '%',
      label: T('Of peak power', 'De la puissance crête'),
      color: figures.loadPercent === null ? WIDGET_COLORS.NEUTRAL : WIDGET_COLORS.PRIMARY,
    },
  ];
}

/** Tiles of a past or long period: production, peak or average, best, yield. */
function periodTiles(site, boxes, window, now, timeZone, energy, figures) {
  const tiles = [tile(kwhValue(energy.total), 'kWh', T('Production', 'Production'), 'zap')];
  if (window.kind === 'curve') {
    const peak = curveOf(site.store, boxes, window.from, window.to).points.reduce(
      (best, sample) => Math.max(best, sample.w),
      0,
    );
    tiles.push(tile(peak > 0 ? peak : null, 'W', T('Peak power', 'Puissance max'), 'sun'));
  } else {
    // The average leaves out the current day / month: it is not over yet.
    const complete = energy.entries.filter(
      (entry, i) => entry.kwh !== null && !(window.current && i === energy.entries.length - 1),
    );
    const average =
      complete.length > 0
        ? complete.reduce((total, entry) => total + entry.kwh, 0) / complete.length
        : null;
    const best = energy.entries.reduce(
      (top, entry) => (entry.kwh !== null && entry.kwh > (top?.kwh ?? -1) ? entry : top),
      null,
    );
    tiles.push(
      tile(
        kwhValue(best?.kwh ?? null),
        'kWh',
        best ? bestLabel(window, best.key) : T('Best', 'Meilleur'),
        'award',
      ),
    );
    tiles.push(tile(kwhValue(average), 'kWh', PER_ENTRY[window.kind], 'activity'));
  }
  tiles.push(
    tile(
      figures.peakKw && energy.total !== null ? round(energy.total / figures.peakKw, 2) : null,
      'kWh/kW',
      T('Yield', 'Rendement'),
      'award',
    ),
  );
  return tiles;
}

/**
 * Content of the site widget.
 * @param {object} site
 * @param {ReturnType<typeof siteSelection>} selection
 * @param {{ now: number, config: object, title: string|object|null, threshold: number,
 *   showChart: boolean, view?: { period: string, offset: number } }} options
 */
export function siteContent(
  site,
  selection,
  { now, config, title, threshold, showChart, view = { period: 'day', offset: 0 } },
) {
  const timeZone = config.timezone;
  const { boxes } = selection;
  const figures = siteFigures(boxes, now, timeZone);
  const firstMonth = firstMonthOf(boxes);
  const window = windowOf(view.period, view.offset, now, timeZone, {
    firstYear: firstMonth?.slice(0, 4),
  });
  const live = window.current && window.kind === 'curve';
  const energy = windowEnergy(site.store, boxes, window, now, timeZone);

  const components = headingOf(title);
  const chart = showChart ? siteChart(site, selection, window, now, timeZone) : null;
  if (chart) {
    components.push(chart);
  }

  const rows = [];
  if (!chart) {
    // The period shown, when no chart title carries it.
    const label = labelText(window.label);
    rows.push({
      label: T('Period', 'Période'),
      icon: 'calendar',
      value: T(label.en, label.fr),
      color: WIDGET_COLORS.NEUTRAL,
    });
  }
  if (selection.layout === LAYOUTS.THREE_PHASE) {
    if (live) {
      rows.push(...livePhaseRows(selection.phases, now, timeZone));
      const balance = phaseBalance(selection.phases, now, timeZone, threshold);
      if (balance) {
        rows.push(balanceRow(balance));
      }
    } else {
      rows.push(...periodPhaseRows(site, selection.phases, window, now, timeZone, energy.total));
    }
  }
  if (live) {
    rows.push({
      label: T('Boxes · peak power', 'Box · puissance crête'),
      icon: 'grid',
      value: `${figures.reporting}/${figures.boxes} · ${figures.peakKw ? `${round(figures.peakKw, 2)} kWc` : UNKNOWN}`,
      color: reportingColor(figures.reporting, figures.boxes),
    });
    rows.push({
      label: T('Yield today · yesterday', 'Rendement · hier'),
      icon: 'award',
      value: `${figures.yieldToday === null ? UNKNOWN : `${round(figures.yieldToday, 2)} kWh/kWc`} · ${kwhText(figures.yesterdayKwh)}`,
      color: WIDGET_COLORS.NEUTRAL,
    });
    const flagged = underperformers(boxes, now, timeZone, config.underperformance_threshold);
    const silent = flagged.filter((entry) => entry.reason === 'silent').map((entry) => entry.box);
    const low = flagged.filter((entry) => entry.reason === 'low_yield').map((entry) => entry.box);
    if (silent.length > 0) {
      rows.push({
        label: T('Silent boxes', 'Box muettes'),
        icon: 'wifi-off',
        value: namesOf(silent),
        color: WIDGET_COLORS.DANGER,
      });
    }
    if (low.length > 0) {
      rows.push({
        label: T('Low yield', 'Rendement faible'),
        icon: 'alert-triangle',
        value: namesOf(low),
        color: WIDGET_COLORS.WARNING,
      });
    }
  }
  rows.push(...selectionAlerts(selection));
  if (rows.length > 0) {
    components.push({ type: 'status', items: fitRows(rows) });
  }

  components.push(
    ...viewButtons(
      view,
      SITE_VIEW.periods,
      hasPrevious(window, { now, firstMonth, firstCurve: firstCurveAt(site.store, boxes) }),
    ),
  );
  const tiles = live
    ? liveTiles(figures)
    : periodTiles(site, boxes, window, now, timeZone, energy, figures);
  components.push(...tiles.slice(0, Math.max(0, MAX_COMPONENTS - components.length)));
  return { ttl_seconds: live ? 60 : 300, components };
}

function selectionOf(site, settings) {
  const all = site.snapshots();
  if (all.length === 0) {
    return { error: messageContent(site.lastRefreshAt() === null ? NOT_CONNECTED : NO_BOX) };
  }
  const selection = siteSelection(all, settings);
  if (selection.boxes.length === 0) {
    return {
      error: messageContent(selection.layout === LAYOUTS.THREE_PHASE ? ASSIGN_PHASES : NO_BOX),
    };
  }
  return { selection };
}

export const siteWidget = {
  async get(_gladys, { settings = {}, site, views = sharedViews }) {
    const { selection, error } = selectionOf(site, settings);
    if (error) {
      return error;
    }
    return siteContent(site, selection, {
      now: Date.now(),
      config: site.config(),
      title: titleOf(settings, null),
      threshold: thresholdOf(settings),
      showChart: settings.show_chart !== false,
      view: views.get(SITE_WIDGET, settings, SITE_VIEW),
    });
  },

  async action(_gladys, { actionKey, settings = {}, values, site, views = sharedViews }) {
    const now = Date.now();
    const view = views.apply(SITE_WIDGET, settings, SITE_VIEW, actionKey, values, {
      now,
      timeZone: site.config().timezone,
    });
    const firstMonth = firstMonthOf(site.snapshots());
    return viewMessage(
      windowOf(view.period, view.offset, now, site.config().timezone, {
        firstYear: firstMonth?.slice(0, 4),
      }),
      view,
    );
  },
};
