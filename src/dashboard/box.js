// -----------------------------------------------------------------------------
// The `box` widget: one Beem box (one kit) on a card.
//
// Live tiles bound to the device features (they follow the published states
// without waiting for the TTL), a gauge of the power over the peak power,
// the day / month figures and the yield (kWh per kWp, comparable between a
// 300 W and a 500 W kit), the power curve of the day from the history Gladys
// keeps, and the status: signal, last report, panels, year and lifetime.
// -----------------------------------------------------------------------------

import { WIDGET_COLORS } from '@gladysassistant/integration-sdk';

import { FEATURE, boxIds } from '../devices/box.js';
import { boxFigures, underperformers } from '../production.js';
import { localTime } from '../time.js';
import {
  T,
  UNKNOWN,
  fitRows,
  kwhText,
  kwhValue,
  messageContent,
  round,
  tile,
  titleOf,
} from './common.js';

export const BOX_WIDGET = 'box';

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

/** Panels row: `3 × 300 W · 900 Wp · 180° / 30°`. */
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
  if (oriented) {
    parts.push(`${oriented.orientation}°${oriented.tilt === null ? '' : ` / ${oriented.tilt}°`}`);
  }
  return {
    label: T('Panels', 'Panneaux'),
    icon: 'sun',
    value: parts.length > 0 ? parts.join(' · ') : UNKNOWN,
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
export function boxContent(gladys, box, all, { now, config, title }) {
  const ids = boxIds(gladys, box.id);
  const figures = boxFigures(box, now, config.timezone);
  const components = [
    { type: 'text', variant: 'heading', text: title },
    {
      type: 'chart',
      device_features: [ids.feature(FEATURE.POWER)],
      interval: 'last-day',
      chart_type: 'area',
      title: T('Power today', 'Puissance du jour'),
      unit: 'W',
    },
    {
      type: 'gauge',
      value: figures.loadPercent ?? 0,
      min: 0,
      max: 100,
      unit: '%',
      label: T('Of peak power', 'De la puissance crête'),
      color: figures.loadPercent === null ? WIDGET_COLORS.NEUTRAL : WIDGET_COLORS.WARNING,
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
  ];

  const rows = [reportRow(box, config.timezone), signalRow(box.reading.dbm), panelsRow(box)];
  rows.push({
    label: T('Yesterday · this year', 'Hier · cette année'),
    icon: 'calendar',
    value: `${kwhText(figures.yesterdayKwh)} · ${kwhText(figures.yearKwh)}`,
    color: WIDGET_COLORS.NEUTRAL,
  });
  rows.push({
    label: T('Since the first month known', 'Depuis le premier mois connu'),
    icon: 'database',
    value: kwhText(figures.lifetimeKwh),
    color: WIDGET_COLORS.NEUTRAL,
  });
  const flagged = underperformers(
    all,
    now,
    config.timezone,
    config.underperformance_threshold,
  ).find((entry) => entry.box.id === box.id);
  if (flagged) {
    rows.push({
      label: T('Underperforming', 'Sous-production'),
      icon: 'alert-triangle',
      value:
        flagged.reason === 'silent'
          ? T('Silent while the others produce', 'Muette, les autres produisent')
          : T(`${flagged.ratio} % of the other boxes`, `${flagged.ratio} % des autres box`),
      color: WIDGET_COLORS.WARNING,
    });
  }
  components.push({ type: 'status', items: fitRows(rows) });
  return { ttl_seconds: 60, components };
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
    return boxContent(gladys, box, all, {
      now: Date.now(),
      config,
      title: titleOf(settings, box.name),
    });
  },
};
