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
  curveOf,
  cutsOf,
  firstCurveAt,
  firstMonthOf,
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
  round,
  tile,
  titleOf,
} from './common.js';
import {
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

export const BOX_WIDGET = 'box';

export const BOX_VIEW = {
  periods: ['hours_12', 'day', 'week', 'month', 'year'],
  defaultPeriod: 'day',
};

// Components of a content the core keeps.
const MAX_COMPONENTS = 8;

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
export function boxContent(
  gladys,
  site,
  box,
  { now, config, title, view = { period: 'day', offset: 0 } },
) {
  const ids = boxIds(gladys, box.id);
  const all = site.snapshots();
  const timeZone = config.timezone;
  const figures = boxFigures(box, now, timeZone);
  const firstMonth = firstMonthOf([box]);
  const window = windowOf(view.period, view.offset, now, timeZone, {
    firstYear: firstMonth?.slice(0, 4),
  });
  const live = window.current && window.kind === 'curve';
  const energy = windowEnergy(site.store, [box], window, now, timeZone);

  const components = [{ type: 'text', variant: 'heading', text: title }];
  const chart =
    window.kind === 'curve'
      ? powerChart(site.store, box, all, window)
      : barsChart(site.store, box, all, window, now, timeZone);
  if (chart) {
    components.push(chart);
  }
  const buttons = viewButtons(
    view,
    BOX_VIEW.periods,
    hasPrevious(window, { now, firstMonth, firstCurve: firstCurveAt(site.store, [box]) }),
  );

  // Tiles by importance; a tile that does not fit in the 8 components gives
  // its figure to a status row when it has one.
  const candidates = live
    ? [
        {
          tile: {
            type: 'value',
            device_feature: ids.feature(FEATURE.POWER),
            label: T('Power', 'Puissance'),
            icon: 'sun',
          },
        },
        { tile: tile(kwhValue(figures.todayKwh), 'kWh', T('Today', "Aujourd'hui"), 'zap') },
        {
          tile: tile(
            round(figures.yieldToday, 2),
            'kWh/kW',
            T('Yield today', 'Rendement du jour'),
            'award',
          ),
        },
        {
          tile: {
            type: 'gauge',
            value: figures.loadPercent ?? 0,
            min: 0,
            max: 100,
            unit: '%',
            label: T('Of peak power', 'De la puissance crête'),
            color: figures.loadPercent === null ? WIDGET_COLORS.NEUTRAL : WIDGET_COLORS.PRIMARY,
          },
          row: {
            label: T('Of peak power', 'De la puissance crête'),
            icon: 'percent',
            value: figures.loadPercent === null ? UNKNOWN : `${figures.loadPercent} %`,
            color: WIDGET_COLORS.NEUTRAL,
          },
        },
        {
          tile: tile(kwhValue(figures.monthKwh), 'kWh', T('This month', 'Ce mois-ci'), 'calendar'),
          row: {
            label: T('This month', 'Ce mois-ci'),
            icon: 'calendar',
            value: kwhText(figures.monthKwh),
            color: WIDGET_COLORS.NEUTRAL,
          },
        },
      ]
    : periodCandidates(site.store, box, window, energy);
  const room = Math.max(0, MAX_COMPONENTS - components.length - 1 - buttons.length);
  const moved = candidates.slice(room).filter((candidate) => candidate.row);

  const rows = [];
  if (live) {
    rows.push(reportRow(box, timeZone), signalRow(box.reading.dbm));
    rows.push(cutsRow(cutsOf(site.store, box, all, window.from, window.to), timeZone));
    const comparison = comparisonRow(box, all, now, config);
    if (comparison) {
      rows.push(comparison);
    }
  } else {
    if (window.kind === 'curve' && !chart?.hourly) {
      rows.push(cutsRow(cutsOf(site.store, box, all, window.from, window.to), timeZone, false));
    }
    const comparison = periodComparisonRow(site.store, box, all, window, now, timeZone, energy);
    if (comparison) {
      rows.push(comparison);
    }
    rows.push(signalRow(box.reading.dbm));
  }
  rows.push(...moved.map((candidate) => candidate.row));
  rows.push(panelsRow(box));
  if (live) {
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
  }
  rows.push({
    label: firstMonth
      ? T(`Since ${monthLabel(firstMonth).en}`, `Depuis ${monthLabel(firstMonth).fr}`)
      : T('In total', 'Au total'),
    icon: 'database',
    value: kwhText(figures.lifetimeKwh),
    color: WIDGET_COLORS.NEUTRAL,
  });
  if (chart) {
    delete chart.hourly;
  }
  components.push({ type: 'status', items: fitRows(rows) });
  components.push(...buttons);
  components.push(...candidates.slice(0, room).map((candidate) => candidate.tile));
  return { ttl_seconds: live ? 60 : 300, components };
}

/** Tiles of a past or long period: production, best or peak, yield. */
function periodCandidates(store, box, window, energy) {
  const peakKw = box.peakPowerW > 0 ? box.peakPowerW / 1000 : null;
  const candidates = [
    { tile: tile(kwhValue(energy.total), 'kWh', T('Production', 'Production'), 'zap') },
  ];
  if (window.kind === 'curve') {
    const peak = curveOf(store, [box], window.from, window.to).points.reduce(
      (best, point) => Math.max(best, point.w),
      0,
    );
    candidates.push({
      tile: tile(peak > 0 ? peak : null, 'W', T('Peak power', 'Puissance max'), 'sun'),
    });
  } else {
    const best = energy.entries.reduce(
      (top, entry) => (entry.kwh !== null && entry.kwh > (top?.kwh ?? -1) ? entry : top),
      null,
    );
    candidates.push({
      tile: tile(
        kwhValue(best?.kwh ?? null),
        'kWh',
        best ? bestLabel(window, best.key) : T('Best', 'Meilleur'),
        'award',
      ),
    });
  }
  candidates.push({
    tile: tile(
      peakKw && energy.total !== null ? round(energy.total / peakKw, 2) : null,
      'kWh/kW',
      T('Yield', 'Rendement'),
      'award',
    ),
    row: {
      label: T('Yield', 'Rendement'),
      icon: 'award',
      value:
        peakKw && energy.total !== null ? `${round(energy.total / peakKw, 2)} kWh/kWc` : UNKNOWN,
      color: WIDGET_COLORS.NEUTRAL,
    },
  });
  return candidates;
}

/** Yield of the box over a window, against the median of the other boxes. */
function periodComparisonRow(store, box, all, window, now, timeZone, energy) {
  if (all.length < 2 || !(box.peakPowerW > 0) || energy.total === null) {
    return null;
  }
  const yields = all
    .filter((other) => other.peakPowerW > 0)
    .map((other) => {
      const total = windowEnergy(store, [other], window, now, timeZone).total;
      return total === null ? null : total / (other.peakPowerW / 1000);
    })
    .filter((value) => value !== null);
  const middle = median(yields);
  if (middle === null || !(middle > 0)) {
    return null;
  }
  const percent = Math.round((energy.total / (box.peakPowerW / 1000) / middle) * 100);
  return {
    label: T('Against the other boxes', 'Face aux autres box'),
    icon: 'bar-chart-2',
    value: T(`${percent} % of the median`, `${percent} % de la médiane`),
    color: WIDGET_COLORS.NEUTRAL,
  };
}

/**
 * The curve of a window: the box's power and the power it would have at
 * the median load of the other boxes — 5-minute samples, or hourly before
 * them. Null without any point. `hourly` tells which (removed before the
 * content is sent).
 */
export function powerChart(store, box, all, window) {
  const { hourly } = curveOf(store, [box], window.from, window.to);
  const series = comparedSeries(store, box, all, window.from, window.to, { hourly });
  const own = series
    .filter((point) => point.w !== null)
    .map((point) => ({ t: new Date(point.t).toISOString(), v: point.w }));
  if (own.length === 0 || !series.some((point) => point.w > 0 || point.expected > 0)) {
    return null;
  }
  const expected = series
    .filter((point) => point.expected !== null)
    .map((point) => ({ t: new Date(point.t).toISOString(), v: point.expected }));
  const label = labelText(window.label);
  return {
    type: 'chart',
    series: [
      { name: T('This box', 'Cette box'), points: own.slice(-MAX_CHART_POINTS) },
      ...(expected.length > 0
        ? [{ name: T('Expected', 'Attendu'), points: expected.slice(-MAX_CHART_POINTS) }]
        : []),
    ],
    chart_type: 'line',
    title: hourly
      ? T(`Hourly power · ${label.en}`, `Puissance horaire · ${label.fr}`)
      : T(`Power · ${label.en}`, `Puissance · ${label.fr}`),
    unit: 'W',
    ...(window.current ? { now_marker: true } : {}),
    hourly,
  };
}

/**
 * The production bars of a window (per day, month or year) next to what the
 * box would produce at the median yield (kWh per kWp) of the other boxes.
 */
export function barsChart(store, box, all, window, now, timeZone) {
  const own = windowEnergy(store, [box], window, now, timeZone).entries;
  if (!own.some((entry) => entry.kwh !== null)) {
    return null;
  }
  const peers = all
    .filter((other) => other.id !== box.id && other.peakPowerW > 0)
    .map((other) => ({
      peakKw: other.peakPowerW / 1000,
      entries: windowEnergy(store, [other], window, now, timeZone).entries,
    }));
  const expected = own
    .map((entry, i) => {
      const yields = peers
        .map((peer) => peer.entries[i].kwh)
        .map((kwh, j) => (kwh === null ? null : kwh / peers[j].peakKw))
        .filter((value) => value !== null);
      const middle = median(yields);
      return middle === null || !(box.peakPowerW > 0)
        ? null
        : { t: entryInstant(window, entry.key), v: kwhValue((middle * box.peakPowerW) / 1000) };
    })
    .filter(Boolean);
  const label = labelText(window.label);
  return {
    type: 'chart',
    series: [
      {
        name: T('This box', 'Cette box'),
        points: own
          .filter((entry) => entry.kwh !== null)
          .map((entry) => ({ t: entryInstant(window, entry.key), v: kwhValue(entry.kwh) })),
      },
      ...(expected.length > 0 ? [{ name: T('Expected', 'Attendu'), points: expected }] : []),
    ],
    chart_type: 'bar',
    title: T(`Production · ${label.en}`, `Production · ${label.fr}`),
    unit: 'kWh',
  };
}

/** Cuts row: `3 · last 09:12`, in warning when there were some. */
export function cutsRow({ count, lastAt }, timeZone, today = true) {
  const label = today ? T('Cuts today', "Coupures aujourd'hui") : T('Cuts', 'Coupures');
  if (count === 0) {
    return {
      label,
      icon: 'activity',
      value: T('None', 'Aucune'),
      color: WIDGET_COLORS.SUCCESS,
    };
  }
  const time = localTime(lastAt, timeZone);
  return {
    label,
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
  async get(gladys, { settings = {}, site, views = sharedViews }) {
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
      view: views.get(BOX_WIDGET, settings, BOX_VIEW),
    });
  },

  async action(_gladys, { actionKey, settings = {}, values, site, views = sharedViews }) {
    const now = Date.now();
    const timeZone = site.config().timezone;
    const view = views.apply(BOX_WIDGET, settings, BOX_VIEW, actionKey, values, { now, timeZone });
    const box = site.snapshots().find((snapshot) => snapshot.externalId === settings.device);
    const firstMonth = box ? firstMonthOf([box]) : null;
    return viewMessage(
      windowOf(view.period, view.offset, now, timeZone, { firstYear: firstMonth?.slice(0, 4) }),
      view,
    );
  },
};
