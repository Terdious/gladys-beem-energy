// -----------------------------------------------------------------------------
// The `site` widget: the whole solar installation on one card.
//
// Single-phase: the totals of the selected boxes (none: all of them).
// Three-phase: the boxes assigned to L1, L2 and L3 in three device
// multi-selects (one Beem box per phase and kit size, typically), one status
// row per phase (power · today), and a phase balance row: the spread between
// the highest and the lowest phase power, in warning past the
// `imbalance_threshold` setting (a three-phase meter counts each phase on its
// own: a production all on L1 does not offset a consumption on L2).
//
// The power curve of the day comes from the 5-minute averages the
// integration keeps (src/store.js): one series per phase in three-phase, the
// total otherwise. Then the boxes that produce clearly less than the others,
// and the assignment mistakes.
//
// Content budget of the core: 1 heading, 1 chart, 5 tiles, 1 status.
// -----------------------------------------------------------------------------

import { WIDGET_COLORS } from '@gladysassistant/integration-sdk';

import { powerSeries, siteFigures, underperformers } from '../production.js';
import { dayKey } from '../time.js';
import {
  T,
  UNKNOWN,
  ASSIGN_PHASES,
  LAYOUTS,
  NO_BOX,
  NOT_CONNECTED,
  fitRows,
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

export const SITE_WIDGET = 'site';

// Default of the `imbalance_threshold` setting (W), the manifest's too.
export const DEFAULT_IMBALANCE_THRESHOLD = 500;
// Points of an inline chart series the core keeps.
const MAX_CHART_POINTS = 300;

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

function phaseRows(phases, now, timeZone) {
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
      // "L1 (2) · 1.4 kWp": the phase, its boxes, its peak power.
      label: `${label} (${boxes.length})${figures.peakKw ? ` · ${round(figures.peakKw, 1)} kWc` : ''}`,
      icon: 'git-commit',
      value: `${figures.powerW ?? UNKNOWN} W · ${kwhText(figures.todayKwh)}`,
      color:
        figures.reporting === boxes.length
          ? WIDGET_COLORS.SUCCESS
          : figures.reporting === 0
            ? WIDGET_COLORS.DANGER
            : WIDGET_COLORS.WARNING,
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

/** The power curve of the day: one series per phase, or the total. */
export function powerChart(site, selection, now, timeZone) {
  // From the last local midnight: the samples of the day only.
  const today = dayKey(now, timeZone);
  let from = now - 24 * 60 * 60 * 1000;
  while (dayKey(from, timeZone) !== today) {
    from += 5 * 60 * 1000;
  }
  const toPoints = (boxes) =>
    powerSeries(site.store, boxes, from)
      .slice(-MAX_CHART_POINTS)
      .map(({ t, w }) => ({ t: new Date(t).toISOString(), v: w }));
  const series =
    selection.layout === LAYOUTS.THREE_PHASE
      ? selection.phases
          .filter((phase) => phase.boxes.length > 0)
          .map((phase) => ({ name: phase.label, points: toPoints(phase.boxes) }))
      : [{ name: T('Production', 'Production'), points: toPoints(selection.boxes) }];
  const filled = series.filter((entry) => entry.points.length > 0);
  if (filled.length === 0) {
    return null;
  }
  return {
    type: 'chart',
    series: filled,
    chart_type: 'area',
    title: T('Power today', 'Puissance du jour'),
    unit: 'W',
    now_marker: true,
  };
}

/**
 * Content of the site widget.
 * @param {object} site
 * @param {ReturnType<typeof siteSelection>} selection
 * @param {{ now: number, config: object, title: string|object, threshold: number, showChart: boolean }} options
 */
export function siteContent(site, selection, { now, config, title, threshold, showChart }) {
  const timeZone = config.timezone;
  const { boxes } = selection;
  const figures = siteFigures(boxes, now, timeZone);
  const components = [{ type: 'text', variant: 'heading', text: title }];
  if (showChart) {
    const chart = powerChart(site, selection, now, timeZone);
    if (chart) {
      components.push(chart);
    }
  }
  components.push(
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
      color: figures.loadPercent === null ? WIDGET_COLORS.NEUTRAL : WIDGET_COLORS.WARNING,
    },
  );

  const rows = [];
  if (selection.layout === LAYOUTS.THREE_PHASE) {
    rows.push(...phaseRows(selection.phases, now, timeZone));
    const balance = phaseBalance(selection.phases, now, timeZone, threshold);
    if (balance) {
      rows.push(balanceRow(balance));
    }
  }
  rows.push({
    label: T('Boxes · peak power', 'Box · puissance crête'),
    icon: 'grid',
    value: `${figures.reporting}/${figures.boxes} · ${figures.peakKw ? `${round(figures.peakKw, 2)} kWc` : UNKNOWN}`,
    color:
      figures.reporting === figures.boxes
        ? WIDGET_COLORS.SUCCESS
        : figures.reporting === 0
          ? WIDGET_COLORS.DANGER
          : WIDGET_COLORS.WARNING,
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
  rows.push(...selectionAlerts(selection));
  components.push({ type: 'status', items: fitRows(rows) });
  return { ttl_seconds: 60, components };
}

export const siteWidget = {
  async get(_gladys, { settings = {}, site }) {
    const config = site.config();
    const all = site.snapshots();
    if (all.length === 0) {
      return messageContent(site.lastRefreshAt() === null ? NOT_CONNECTED : NO_BOX);
    }
    const selection = siteSelection(all, settings);
    if (selection.boxes.length === 0) {
      return messageContent(selection.layout === LAYOUTS.THREE_PHASE ? ASSIGN_PHASES : NO_BOX);
    }
    return siteContent(site, selection, {
      now: Date.now(),
      config,
      title: titleOf(settings, T('Solar installation', 'Installation solaire')),
      threshold: thresholdOf(settings),
      showChart: settings.show_chart !== false,
    });
  },
};
