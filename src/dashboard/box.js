// -----------------------------------------------------------------------------
// The `box` widget: one Beem box (one kit) on a card.
//
// A live tile bound to the power feature (it follows the published states
// without waiting for the TTL), a gauge of the power over the peak power,
// the day / month figures and the yield (kWh per kWp, comparable between a
// 300 W and a 500 W kit). The curve of the day is the box's 5-minute average
// power (src/store.js) next to the power it would have at the median load
// of the other boxes: a box below its peers, or cut, shows at a glance.
// The status: last report, signal, cuts of the day, yield against the other
// boxes, panels, year and lifetime.
// -----------------------------------------------------------------------------

import { WIDGET_COLORS } from '@gladysassistant/integration-sdk';

import { FEATURE, boxIds } from '../devices/box.js';
import {
  MIN_YIELD_TO_COMPARE,
  boxFigures,
  comparedSeries,
  cutsOf,
  median,
  underperformers,
} from '../production.js';
import { localTime } from '../time.js';
import {
  T,
  UNKNOWN,
  fitRows,
  kwhText,
  kwhValue,
  messageContent,
  monthLabel,
  startOfToday,
  round,
  tile,
  titleOf,
} from './common.js';

export const BOX_WIDGET = 'box';

// Points of an inline chart series the core keeps.
const MAX_CHART_POINTS = 300;

const BOX_NOT_FOUND = T(
  'This Beem box no longer exists: pick another one in the widget settings.',
  "Cette box Beem n'existe plus : choisissez-en une autre dans les réglages du widget.",
);

/** Wi-Fi row: `-62 dBm · 76 %`, colored by quality. */
export function signalRow(dbm) {
  if (dbm === null) {
    return {
      label: T('Wi-Fi signal', 'Signal Wi-Fi'),
      icon: 'wifi-off',
      value: UNKNOWN,
      color: WIDGET_COLORS.NEUTRAL,
    };
  }
  const quality = Math.max(0, Math.min(100, Math.round(2 * (dbm + 100))));
  return {
    label: T('Wi-Fi signal', 'Signal Wi-Fi'),
    icon: 'wifi',
    value: `${dbm} dBm · ${quality} %`,
    color:
      dbm >= -67
        ? WIDGET_COLORS.SUCCESS
        : dbm >= -80
          ? WIDGET_COLORS.WARNING
          : WIDGET_COLORS.DANGER,
  };
}

const COMPASS = {
  en: ['S', 'SW', 'W', 'NW', 'N', 'NE', 'E', 'SE'],
  fr: ['S', 'SO', 'O', 'NO', 'N', 'NE', 'E', 'SE'],
};

/**
 * The compass point of a panel azimuth as the Beem application stores it:
 * degrees from the south, negative to the east (-90 east, 90 west).
 */
export function compassOf(azimuth, language = 'en') {
  const sector = Math.round((((azimuth % 360) + 360) % 360) / 45) % 8;
  return COMPASS[language][sector];
}

/** Panels row: `3 × 300 W · 900 Wp · SE -30° · ∠30°`. */
function panelsRow(box) {
  const parts = [];
  if (box.panels.length > 0) {
    const peaks = [...new Set(box.panels.map((panel) => panel.peakPowerW).filter(Boolean))];
    parts.push(
      peaks.length === 1 ? `${box.panels.length} × ${peaks[0]} W` : `${box.panels.length}`,
    );
  }
  if (box.peakPowerW > 0) {
    parts.push(`${box.peakPowerW} Wp`);
  }
  const oriented = box.panels.find((panel) => panel.orientation !== null);
  const value = (language) => {
    const all = [...parts];
    if (oriented) {
      all.push(`${compassOf(oriented.orientation, language)} ${oriented.orientation}°`);
      if (oriented.tilt !== null) {
        all.push(`∠${oriented.tilt}°`);
      }
    }
    return all.length > 0 ? all.join(' · ') : UNKNOWN;
  };
  return {
    label: T('Panels', 'Panneaux'),
    icon: 'sun',
    value: T(value('en'), value('fr')),
    color: WIDGET_COLORS.NEUTRAL,
  };
}

/** Last report row: the time, `asleep` at night. */
function reportRow(box, timeZone) {
  const { reading } = box;
  if (!reading.reported) {
    return {
      label: T('Last report', 'Dernier relevé'),
      icon: 'clock',
      value: T('Not in the cloud summary', 'Absente du relevé cloud'),
      color: WIDGET_COLORS.DANGER,
    };
  }
  const time =
    reading.lastProductionAt === null ? UNKNOWN : localTime(reading.lastProductionAt, timeZone);
  return {
    label: T('Last report', 'Dernier relevé'),
    icon: reading.asleep ? 'moon' : 'clock',
    value: reading.asleep ? T(`${time} · asleep`, `${time} · en veille`) : time,
    color: reading.asleep ? WIDGET_COLORS.NEUTRAL : WIDGET_COLORS.SUCCESS,
  };
}

/**
 * Content of the box widget.
 * @param {object} gladys SDK instance
 * @param {object} box snapshot
 * @param {Array<object>} all every snapshot (peer comparison)
 * @param {{ now: number, config: object, title: string|object }} options
 */
export function boxContent(gladys, site, box, { now, config, title }) {
  const ids = boxIds(gladys, box.id);
  const all = site.snapshots();
  const timeZone = config.timezone;
  const figures = boxFigures(box, now, timeZone);
  const today = startOfToday(now, timeZone);
  const components = [{ type: 'text', variant: 'heading', text: title }];
  const chart = powerChart(site.store, box, all, today);
  if (chart) {
    components.push(chart);
  }
  components.push(
    {
      type: 'gauge',
      value: figures.loadPercent ?? 0,
      min: 0,
      max: 100,
      unit: '%',
      label: T('Of peak power', 'De la puissance crête'),
      color: figures.loadPercent === null ? WIDGET_COLORS.NEUTRAL : WIDGET_COLORS.PRIMARY,
    },
    {
      type: 'value',
      device_feature: ids.feature(FEATURE.POWER),
      label: T('Power', 'Puissance'),
      icon: 'sun',
    },
    tile(kwhValue(figures.todayKwh), 'kWh', T('Today', "Aujourd'hui"), 'zap'),
    tile(kwhValue(figures.monthKwh), 'kWh', T('This month', 'Ce mois-ci'), 'calendar'),
    tile(round(figures.yieldToday, 2), 'kWh/kW', T('Yield today', 'Rendement du jour'), 'award'),
  );

  const rows = [reportRow(box, timeZone), signalRow(box.reading.dbm)];
  rows.push(cutsRow(cutsOf(site.store, box, all, today), timeZone));
  const comparison = comparisonRow(box, all, now, config);
  if (comparison) {
    rows.push(comparison);
  }
  rows.push(panelsRow(box));
  rows.push(
    figures.yesterdayKwh === null
      ? {
          label: T('This year', 'Cette année'),
          icon: 'calendar',
          value: kwhText(figures.yearKwh),
          color: WIDGET_COLORS.NEUTRAL,
        }
      : {
          label: T('Yesterday · this year', 'Hier · cette année'),
          icon: 'calendar',
          value: `${kwhText(figures.yesterdayKwh)} · ${kwhText(figures.yearKwh)}`,
          color: WIDGET_COLORS.NEUTRAL,
        },
  );
  const first = Object.entries(box.history.months)
    .filter(([, wh]) => wh > 0)
    .map(([key]) => key)
    .sort()[0];
  rows.push({
    label: first
      ? T(`Since ${monthLabel(first).en}`, `Depuis ${monthLabel(first).fr}`)
      : T('In total', 'Au total'),
    icon: 'database',
    value: kwhText(figures.lifetimeKwh),
    color: WIDGET_COLORS.NEUTRAL,
  });
  components.push({ type: 'status', items: fitRows(rows) });
  return { ttl_seconds: 60, components };
}

/**
 * The curve of the day: the box's 5-minute averages and the power it would
 * have at the median load of the other boxes. Null before any sample.
 */
export function powerChart(store, box, all, from) {
  const series = comparedSeries(store, box, all, from);
  const own = series
    .filter((point) => point.w !== null)
    .map((point) => ({ t: new Date(point.t).toISOString(), v: point.w }));
  if (own.length === 0) {
    return null;
  }
  const expected = series
    .filter((point) => point.expected !== null)
    .map((point) => ({ t: new Date(point.t).toISOString(), v: point.expected }));
  return {
    type: 'chart',
    series: [
      { name: T('This box', 'Cette box'), points: own.slice(-MAX_CHART_POINTS) },
      ...(expected.length > 0
        ? [{ name: T('Expected', 'Attendu'), points: expected.slice(-MAX_CHART_POINTS) }]
        : []),
    ],
    chart_type: 'line',
    title: T('Power today', 'Puissance du jour'),
    unit: 'W',
    now_marker: true,
  };
}

/** Cuts row: `3 · last 09:12`, in warning when there were some. */
export function cutsRow({ count, lastAt }, timeZone) {
  if (count === 0) {
    return {
      label: T('Cuts today', "Coupures aujourd'hui"),
      icon: 'activity',
      value: T('None', 'Aucune'),
      color: WIDGET_COLORS.SUCCESS,
    };
  }
  const time = localTime(lastAt, timeZone);
  return {
    label: T('Cuts today', "Coupures aujourd'hui"),
    icon: 'wifi-off',
    value: T(`${count} · last ${time}`, `${count} · dernière ${time}`),
    color: WIDGET_COLORS.WARNING,
  };
}

/**
 * The yield of the box today against the median of the boxes, or the
 * underperformance alert (silent, low yield). Null with a single box.
 */
function comparisonRow(box, all, now, config) {
  if (all.length < 2) {
    return null;
  }
  const label = T('Against the other boxes', 'Face aux autres box');
  const flagged = underperformers(
    all,
    now,
    config.timezone,
    config.underperformance_threshold,
  ).find((entry) => entry.box.id === box.id);
  if (flagged?.reason === 'silent') {
    return {
      label,
      icon: 'alert-triangle',
      value: T('Silent while they produce', 'Muette, les autres produisent'),
      color: WIDGET_COLORS.DANGER,
    };
  }
  const own = boxFigures(box, now, config.timezone).yieldToday;
  const middle = median(all.map((other) => boxFigures(other, now, config.timezone).yieldToday));
  if (own === null || middle === null || !(middle > 0)) {
    return { label, icon: 'bar-chart-2', value: UNKNOWN, color: WIDGET_COLORS.NEUTRAL };
  }
  const percent = Math.round((own / middle) * 100);
  return {
    label,
    icon: flagged ? 'alert-triangle' : 'bar-chart-2',
    value: T(`${percent} % of the median`, `${percent} % de la médiane`),
    // Too early or too dark to compare: shown, not judged.
    color:
      middle < MIN_YIELD_TO_COMPARE
        ? WIDGET_COLORS.NEUTRAL
        : flagged
          ? WIDGET_COLORS.WARNING
          : WIDGET_COLORS.SUCCESS,
  };
}

export const boxWidget = {
  async get(gladys, { settings = {}, site }) {
    const config = site.config();
    const all = site.snapshots();
    if (all.length === 0) {
      return messageContent(T('No Beem box found yet.', 'Aucune box Beem trouvée pour le moment.'));
    }
    const box = all.find((snapshot) => snapshot.externalId === settings.device);
    if (!box) {
      return messageContent(BOX_NOT_FOUND);
    }
    return boxContent(gladys, site, box, {
      now: Date.now(),
      config,
      title: titleOf(settings, box.name),
    });
  },
};
