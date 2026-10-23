// -----------------------------------------------------------------------------
// Period shown by a widget, chosen live like on the charts of the core.
//
// A widget carries a "Period" button opening a form with its periods (the
// widget action forms of Gladys 5.2; an older core relays the tap without
// values, and the period simply cycles), and "Previous" / "Next" buttons to
// step by one period. The core refreshes the widget after a successful
// action, the content then follows the new view.
//
// The view lives here, in memory, per widget instance: the core identifies
// an instance by its settings only (the content cache and the actions are
// keyed on them), so the view is keyed on the widget key and the settings.
// Two dashboards showing the same widget with the same settings share their
// view; a restart goes back to the default period.
// -----------------------------------------------------------------------------

import {
  curveEnergy,
  curveOf,
  energyOfDays,
  energyOfMonths,
  energyOfYears,
} from '../production.js';
import { SAMPLE_RETENTION_MS } from '../store.js';
import {
  dayKey,
  daysInMonth,
  localParts,
  localTime,
  monthKeyOf,
  parseMonthKey,
  shiftDay,
  shiftMonth,
  startOfDayKey,
} from '../time.js';
import { T, dayLabel, monthLabel } from './common.js';

export const PERIODS = {
  hours_12: { label: T('12 hours', '12 heures'), kind: 'curve' },
  day: { label: T('Day', 'Jour'), kind: 'curve' },
  week: { label: T('Week', 'Semaine'), kind: 'days' },
  month: { label: T('Month', 'Mois'), kind: 'days' },
  year: { label: T('Year', 'Année'), kind: 'months' },
  all: { label: T('All years', 'Toutes les années'), kind: 'years' },
};

export const PERIOD_ACTION = 'period';
export const PREVIOUS_ACTION = 'previous';
export const NEXT_ACTION = 'next';
export const VIEW_ACTIONS = [PERIOD_ACTION, PREVIOUS_ACTION, NEXT_ACTION];

const HOURS_12_MS = 12 * 60 * 60 * 1000;

const WEEKDAYS = {
  en: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
  fr: ['dim.', 'lun.', 'mar.', 'mer.', 'jeu.', 'ven.', 'sam.'],
};

/** `Thu 22/10` / `jeu. 22/10` of a `YYYY-MM-DD` key. */
export function dayTitle(key) {
  const weekday = new Date(`${key}T12:00:00.000Z`).getUTCDay();
  return T(`${WEEKDAYS.en[weekday]} ${dayLabel(key)}`, `${WEEKDAYS.fr[weekday]} ${dayLabel(key)}`);
}

/** The days from `first` to `last` included. */
function daysBetween(first, last) {
  const keys = [];
  for (let key = first; key <= last; key = shiftDay(key, 1)) {
    keys.push(key);
  }
  return keys;
}

/**
 * The window of a period, `offset` periods before the current one (0: the
 * current one, -1: the previous one...).
 * @param {string} period key of PERIODS
 * @param {number} offset 0 or less
 * @param {number} now timestamp (ms)
 * @param {string} timeZone
 * @param {{ firstYear?: string }} [bounds] the first year with data (`all`)
 * @returns {{ period: string, kind: string, current: boolean, label: object|string,
 *   from?: number, to?: number, days?: string[], months?: string[], years?: string[] }}
 */
export function windowOf(period, offset, now, timeZone, { firstYear } = {}) {
  const today = dayKey(now, timeZone);
  const current = offset === 0;
  switch (period) {
    case 'hours_12': {
      const to = now + offset * HOURS_12_MS;
      const from = to - HOURS_12_MS;
      const span = `${localTime(from, timeZone)} → ${localTime(to, timeZone)}`;
      const day = dayLabel(dayKey(to, timeZone));
      return { period, kind: 'curve', current, from, to, label: `${day} ${span}` };
    }
    case 'day': {
      const key = shiftDay(today, offset);
      return {
        period,
        kind: 'curve',
        current,
        from: startOfDayKey(key, timeZone),
        to: startOfDayKey(shiftDay(key, 1), timeZone),
        days: [key],
        label: dayTitle(key),
      };
    }
    case 'week': {
      const last = shiftDay(today, offset * 7);
      const days = daysBetween(shiftDay(last, -6), last);
      return {
        period,
        kind: 'days',
        current,
        days,
        label: `${dayLabel(days[0])} → ${dayLabel(last)}`,
      };
    }
    case 'month': {
      const month = shiftMonth(parseMonthKey(today.slice(0, 7)), offset);
      const key = monthKeyOf(month);
      const last = current ? today : `${key}-${String(daysInMonth(month)).padStart(2, '0')}`;
      return {
        period,
        kind: 'days',
        current,
        month: key,
        days: daysBetween(`${key}-01`, last),
        label: monthLabel(key),
      };
    }
    case 'year': {
      const { year, month } = localParts(now, timeZone);
      const shown = year + offset;
      const lastMonth = current ? month : 12;
      const months = Array.from({ length: lastMonth }, (_, i) =>
        monthKeyOf({ year: shown, month: i + 1 }),
      );
      return { period, kind: 'months', current, year: String(shown), months, label: String(shown) };
    }
    default: {
      const { year } = localParts(now, timeZone);
      const first = Math.min(Number(firstYear ?? year), year);
      const years = Array.from({ length: year - first + 1 }, (_, i) => String(first + i));
      return {
        period: 'all',
        kind: 'years',
        current: true,
        years,
        label: years.length > 1 ? `${years[0]} → ${years.at(-1)}` : years[0],
      };
    }
  }
}

/**
 * Whether the period before a window still holds data: the curves back to
 * the 5-minute samples kept SAMPLE_RETENTION_MS or the first backfilled hour,
 * the days and months back to the first month with production.
 * @param {ReturnType<typeof windowOf>} window
 * @param {{ now: number, firstMonth: string|null }} bounds
 */
export function hasPrevious(window, { now, firstMonth, firstCurve = null }) {
  if (window.kind === 'years') {
    return false;
  }
  if (window.kind === 'curve') {
    // The 5-minute samples, or the hours backfilled before them.
    const oldest = Math.min(now - SAMPLE_RETENTION_MS, firstCurve ?? Infinity);
    return window.from > oldest;
  }
  if (firstMonth === null) {
    return false;
  }
  const start = window.days?.[0] ?? window.months?.[0];
  return start.slice(0, 7) > firstMonth;
}

/** A stable key of an instance: the widget key and its settings. */
export function instanceKey(widgetKey, settings = {}) {
  const sorted = Object.keys(settings)
    .sort()
    .map((key) => [key, settings[key]]);
  return `${widgetKey}:${JSON.stringify(sorted)}`;
}

/**
 * The views of the widget instances.
 * @param {{ maxInstances?: number }} [options]
 */
export function createViews({ maxInstances = 200 } = {}) {
  const views = new Map();
  return {
    /**
     * The view of an instance.
     * @param {string} widgetKey
     * @param {object} settings
     * @param {{ periods: string[], defaultPeriod: string }} spec
     * @returns {{ period: string, offset: number }}
     */
    get(widgetKey, settings, { periods, defaultPeriod }) {
      const view = views.get(instanceKey(widgetKey, settings));
      return view && periods.includes(view.period)
        ? { ...view }
        : { period: defaultPeriod, offset: 0 };
    },

    /**
     * Apply a tap on a view button. The period form may carry a `date`
     * (src/dashboard/period.js parseDate): the view goes to the period
     * holding it; an unreadable one keeps the current period.
     * @returns {{ period: string, offset: number, invalidDate?: true }} the new view
     */
    apply(widgetKey, settings, spec, actionKey, values = {}, { now = Date.now(), timeZone } = {}) {
      const view = this.get(widgetKey, settings, spec);
      let invalidDate = false;
      if (actionKey === PERIOD_ACTION) {
        const chosen = values?.period;
        view.period = spec.periods.includes(chosen)
          ? chosen
          : // No form on this core: the tap cycles the periods.
            spec.periods[(spec.periods.indexOf(view.period) + 1) % spec.periods.length];
        view.offset = 0;
        const text = typeof values?.date === 'string' ? values.date.trim() : '';
        if (text !== '' && timeZone) {
          const date = parseDate(text, now, timeZone);
          if (date) {
            view.offset = offsetForDate(view.period, date, now, timeZone);
          } else {
            invalidDate = true;
          }
        }
      } else if (actionKey === PREVIOUS_ACTION) {
        view.offset -= 1;
      } else if (actionKey === NEXT_ACTION) {
        view.offset = Math.min(0, view.offset + 1);
      }
      const key = instanceKey(widgetKey, settings);
      views.delete(key);
      views.set(key, view);
      // The oldest instances go first: a dashboard edited many times leaves
      // settings nobody shows anymore.
      while (views.size > maxInstances) {
        views.delete(views.keys().next().value);
      }
      return invalidDate ? { ...view, invalidDate } : { ...view };
    },
  };
}

/**
 * The buttons of a view: the period form, previous (when there is data
 * before), next (once stepped back).
 * @param {{ period: string, offset: number }} view
 * @param {string[]} periods
 * @param {boolean} canGoBack
 */
export function viewButtons(view, periods, canGoBack) {
  const buttons = [
    {
      type: 'button',
      label: PERIODS[view.period].label,
      icon: 'calendar',
      style: 'secondary',
      action: {
        key: PERIOD_ACTION,
        fields: [
          {
            key: 'period',
            type: 'select',
            label: T('Period', 'Période'),
            required: true,
            default: view.period,
            display: 'radio',
            options: periods.map((key) => ({ value: key, label: PERIODS[key].label })),
          },
          {
            // The core offers no date picker in a widget form: a text field
            // read by parseDate.
            key: 'date',
            type: 'string',
            label: T('Go to the date (optional)', 'Aller à la date (facultatif)'),
            description: T(
              'Empty: the current period. E.g. 05/09/2025, 09/2025, Sept 2025, 2025.',
              'Vide : la période en cours. Ex. 05/09/2025, 09/2025, sept. 2025, 2025.',
            ),
            placeholder: T('e.g. 05/09/2025', 'ex. 05/09/2025'),
          },
        ],
      },
    },
  ];
  if (canGoBack) {
    buttons.push({
      type: 'button',
      label: T('Previous', 'Précédent'),
      icon: 'chevron-left',
      style: 'secondary',
      action: { key: PREVIOUS_ACTION },
    });
  }
  if (view.offset < 0) {
    buttons.push({
      type: 'button',
      label: T('Next', 'Suivant'),
      icon: 'chevron-right',
      style: 'secondary',
      action: { key: NEXT_ACTION },
    });
  }
  return buttons;
}

/** The toast after a tap: the period now shown, or the date not read. */
export const viewMessage = (window, { invalidDate = false } = {}) => {
  const label = typeof window.label === 'string' ? T(window.label, window.label) : window.label;
  return invalidDate
    ? T(
        `Date not understood (e.g. 05/09/2025, 09/2025, 2025): showing ${label.en}`,
        `Date non comprise (ex. 05/09/2025, 09/2025, 2025) : affichage ${label.fr}`,
      )
    : T(`Showing ${label.en}`, `Affichage : ${label.fr}`);
};

// Month names and abbreviations, English and French, without accents.
const MONTH_NAMES = [
  ['jan', 'janv', 'january', 'janvier'],
  ['feb', 'fev', 'fevr', 'february', 'fevrier'],
  ['mar', 'march', 'mars'],
  ['apr', 'avr', 'april', 'avril'],
  ['may', 'mai'],
  ['jun', 'june', 'juin'],
  ['jul', 'juil', 'july', 'juillet'],
  ['aug', 'aou', 'august', 'aout'],
  ['sep', 'sept', 'september', 'septembre'],
  ['oct', 'october', 'octobre'],
  ['nov', 'november', 'novembre'],
  ['dec', 'december', 'decembre'],
];

const plain = (text) =>
  text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\./g, '')
    .trim();

/**
 * Read a date typed in the period form: `05/09/2025`, `5-9-25`, `05/09`
 * (the last such day), `09/2025`, `2025-09-05`, `2025-09`, `sept. 2025`,
 * `september 2025`, `2025`. Null when not understood.
 * @returns {{ year: number, month?: number, day?: number }|null}
 */
export function parseDate(text, now, timeZone) {
  const value = plain(String(text ?? ''));
  const today = localParts(now, timeZone);
  const fullYear = (y) => (y < 100 ? 2000 + y : y);
  const valid = ({ year, month, day }) =>
    year >= 2000 &&
    year <= 2100 &&
    (month === undefined || (month >= 1 && month <= 12)) &&
    (day === undefined || (day >= 1 && day <= daysInMonth({ year, month })));
  let date = null;
  let match;
  if ((match = value.match(/^(\d{4})-(\d{1,2})(?:-(\d{1,2}))?$/))) {
    date = { year: +match[1], month: +match[2], ...(match[3] ? { day: +match[3] } : {}) };
  } else if ((match = value.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/))) {
    date = { year: fullYear(+match[3]), month: +match[2], day: +match[1] };
  } else if ((match = value.match(/^(\d{1,2})[/.-](\d{4})$/))) {
    date = { year: +match[2], month: +match[1] };
  } else if ((match = value.match(/^(\d{1,2})[/.-](\d{1,2})$/))) {
    // Day and month: this year, or last year when still to come.
    const later = +match[2] > today.month || (+match[2] === today.month && +match[1] > today.day);
    date = { year: today.year - (later ? 1 : 0), month: +match[2], day: +match[1] };
  } else if ((match = value.match(/^(\d{4})$/))) {
    date = { year: +match[1] };
  } else if ((match = value.match(/^(?:(\d{1,2})\s+)?([a-z]+)\s*(\d{4})?$/))) {
    const month = MONTH_NAMES.findIndex((names) => names.includes(match[2])) + 1;
    if (month > 0) {
      let year = match[3] ? +match[3] : today.year;
      if (!match[3] && month > today.month) {
        year -= 1;
      }
      date = { year, month, ...(match[1] ? { day: +match[1] } : {}) };
    }
  }
  return date && valid(date) ? date : null;
}

const daysSince = (from, to) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

/**
 * The offset of the period of `period` holding a date (0 or less: a date to
 * come is the current period). A date without its day (or month) is the
 * first one.
 */
export function offsetForDate(period, date, now, timeZone) {
  const today = localParts(now, timeZone);
  const month = date.month ?? 1;
  const key = `${date.year}-${String(month).padStart(2, '0')}-${String(date.day ?? 1).padStart(2, '0')}`;
  const todayKey = dayKey(now, timeZone);
  if (key > todayKey) {
    return 0;
  }
  switch (period) {
    case 'hours_12': {
      // The 12 hours holding noon of that day.
      const noon = startOfDayKey(key, timeZone) + HOURS_12_MS;
      return noon >= now ? 0 : -Math.floor((now - noon) / HOURS_12_MS);
    }
    case 'day':
      return -daysSince(key, todayKey);
    case 'week':
      return -Math.floor(daysSince(key, todayKey) / 7);
    case 'month':
      return -((today.year - date.year) * 12 + (today.month - month));
    case 'year':
      return -(today.year - date.year);
    default:
      return 0;
  }
}

/** The views of this process, shared by the widgets. */
export const sharedViews = createViews();

/** Mid-year of a year, for a bar placed on its year whatever the viewer's timezone. */
export const yearInstant = (year) => `${year}-07-01T12:00:00.000Z`;

/**
 * The production of some boxes over a window, per bar of the window (a day,
 * a month, a year; a curve window counts its days, or its 5-minute samples
 * for 12 hours): `entries` [{ key, kwh }] and their `total`, null when no
 * entry is known.
 */
export function windowEnergy(store, boxes, window, now, timeZone) {
  let entries;
  if (window.period === 'hours_12') {
    const kwh = curveEnergy(curveOf(store, boxes, window.from, window.to));
    entries = [{ key: 'hours_12', kwh: kwh > 0 ? kwh : null }];
  } else if (window.days) {
    entries = energyOfDays(boxes, window.days, now, timeZone);
  } else if (window.months) {
    entries = energyOfMonths(boxes, window.months, now, timeZone);
  } else {
    entries = energyOfYears(boxes, window.years, now, timeZone);
  }
  const known = entries.filter((entry) => entry.kwh !== null);
  if (known.length === 0 && window.period === 'month') {
    // No day known in that month (before the integration and the daily
    // history): its total still comes from the monthly history.
    const [month] = energyOfMonths(boxes, [window.month], now, timeZone);
    return { entries, total: month.kwh };
  }
  return {
    entries,
    total: known.length === 0 ? null : known.reduce((total, entry) => total + entry.kwh, 0),
  };
}

/** The chart instant of an entry of a window: midday of its day, month or year. */
export function entryInstant(window, key) {
  if (window.kind === 'months') {
    return `${key}-15T12:00:00.000Z`;
  }
  if (window.kind === 'years') {
    return yearInstant(key);
  }
  return `${key}T12:00:00.000Z`;
}

/** The label of an entry of a window: `Thu 22/10`, `Oct 2026`, `2026`. */
export function entryLabel(window, key) {
  if (window.kind === 'months') {
    return monthLabel(key);
  }
  if (window.kind === 'years') {
    return T(key, key);
  }
  return dayTitle(key);
}

const WEEKDAYS_LONG = {
  en: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
  fr: ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'],
};

/**
 * The label of a "best" tile, naming its entry (≤ 24 characters): `Best ·
 * Friday 02`, `Meilleur · août 2026`, `Meilleur · 2025`.
 */
export function bestLabel(window, key) {
  if (window.kind === 'months' || window.kind === 'years') {
    const label = labelText(entryLabel(window, key));
    return T(`Best · ${label.en}`, `Meilleur · ${label.fr}`);
  }
  const weekday = new Date(`${key}T12:00:00.000Z`).getUTCDay();
  const day = key.slice(8, 10);
  return T(
    `Best · ${WEEKDAYS_LONG.en[weekday]} ${day}`,
    `Meilleur · ${WEEKDAYS_LONG.fr[weekday]} ${day}`,
  );
}

/** Per-entry unit of a window, for "average per ...". */
export const PER_ENTRY = {
  days: T('Per day (average)', 'Par jour (moyenne)'),
  months: T('Per month (average)', 'Par mois (moyenne)'),
  years: T('Per year (average)', 'Par an (moyenne)'),
};

/** A window label as a multi-language text. */
export const labelText = (label) => (typeof label === 'string' ? T(label, label) : label);
