// -----------------------------------------------------------------------------
// Local calendar of a timezone.
//
// Gladys gives an integration no instance timezone, and the Beem cloud counts
// the days and the months of a box in local time (France). The configuration
// carries the timezone (`timezone`, Europe/Paris by default): the day and
// month keys, the off-peak hours and the "end of the solar day" all follow
// it, DST included.
// -----------------------------------------------------------------------------

export const DEFAULT_TIMEZONE = 'Europe/Paris';

const formatters = new Map();

function formatterOf(timeZone) {
  if (!formatters.has(timeZone)) {
    formatters.set(
      timeZone,
      new Intl.DateTimeFormat('en-US', {
        timeZone,
        hourCycle: 'h23',
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        hour: 'numeric',
        minute: 'numeric',
        second: 'numeric',
      }),
    );
  }
  return formatters.get(timeZone);
}

/** The IANA timezone to use: the given one when valid, else DEFAULT_TIMEZONE. */
export function resolveTimezone(timeZone) {
  const name = typeof timeZone === 'string' ? timeZone.trim() : '';
  if (name !== '') {
    try {
      return new Intl.DateTimeFormat('en-US', { timeZone: name }).resolvedOptions().timeZone;
    } catch {
      // RangeError: not a timezone this Node.js knows.
    }
  }
  return DEFAULT_TIMEZONE;
}

/**
 * Wall clock of an instant in a timezone.
 * @param {number} at timestamp (ms)
 * @param {string} timeZone IANA timezone
 * @returns {{ year: number, month: number, day: number, hour: number, minute: number, second: number }}
 */
export function localParts(at, timeZone) {
  const parts = Object.fromEntries(
    formatterOf(timeZone)
      .formatToParts(new Date(at))
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, Number(part.value)]),
  );
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: parts.hour,
    minute: parts.minute,
    second: parts.second,
  };
}

const pad = (value) => String(value).padStart(2, '0');

/** `YYYY-MM-DD` of an instant in a timezone. */
export function dayKey(at, timeZone) {
  const { year, month, day } = localParts(at, timeZone);
  return `${year}-${pad(month)}-${pad(day)}`;
}

/** `YYYY-MM` of an instant in a timezone. */
export function monthKey(at, timeZone) {
  const { year, month } = localParts(at, timeZone);
  return `${year}-${pad(month)}`;
}

/** `YYYY-MM` of a { year, month } pair. */
export const monthKeyOf = ({ year, month }) => `${year}-${pad(month)}`;

/** The { year, month } before or after another one (`offset` months). */
export function shiftMonth({ year, month }, offset) {
  const index = year * 12 + (month - 1) + offset;
  return { year: Math.floor(index / 12), month: (index % 12) + 1 };
}

/** { year, month } of a `YYYY-MM` key. */
export function parseMonthKey(key) {
  const [year, month] = key.split('-').map(Number);
  return { year, month };
}

/** `YYYY-MM-DD` of the day before or after a `YYYY-MM-DD` key. */
export function shiftDay(key, offset) {
  const [year, month, day] = key.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + offset));
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

/** Number of days of a month. */
export function daysInMonth({ year, month }) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Minute of the local day (0-1439) of an instant. */
export function minuteOfDay(at, timeZone) {
  const { hour, minute } = localParts(at, timeZone);
  return hour * 60 + minute;
}

/** `HH:MM` of an instant in a timezone. */
export function localTime(at, timeZone) {
  const { hour, minute } = localParts(at, timeZone);
  return `${pad(hour)}:${pad(minute)}`;
}

/**
 * The instant (ms) a local day starts in a timezone (DST-aware): the first
 * minute whose local date is the day.
 * @param {string} key `YYYY-MM-DD`
 * @param {string} timeZone
 */
export function startOfDayKey(key, timeZone) {
  const [year, month, day] = key.split('-').map(Number);
  // Every timezone is within 14 hours of UTC: start before, step 15 min.
  let at = Date.UTC(year, month - 1, day) - 14 * 60 * 60 * 1000;
  while (dayKey(at, timeZone) < key) {
    at += 15 * 60 * 1000;
  }
  return at;
}

/**
 * An instant as a local ISO time with its UTC offset, the way the Beem
 * application sends its ranges: `2026-10-16T00:00:00+02:00`.
 */
export function localIso(at, timeZone) {
  const { year, month, day, hour, minute, second } = localParts(at, timeZone);
  const wall = Date.UTC(year, month - 1, day, hour, minute, second);
  const offset = Math.round((wall - Math.floor(at / 1000) * 1000) / 60000);
  const sign = offset < 0 ? '-' : '+';
  const abs = Math.abs(offset);
  return `${year}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}:${pad(second)}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}
