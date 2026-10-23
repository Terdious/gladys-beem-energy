import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  NEXT_ACTION,
  bestLabel,
  offsetForDate,
  parseDate,
  PERIOD_ACTION,
  PREVIOUS_ACTION,
  createViews,
  hasPrevious,
  instanceKey,
  viewButtons,
  windowOf,
} from '../src/dashboard/period.js';
import { localIso } from '../src/time.js';

// Thursday 22 October 2026, 15:00 in Paris (UTC+2).
const NOW = Date.parse('2026-10-22T13:00:00.000Z');
const TZ = 'Europe/Paris';

test('12 hours: the last 12 hours, stepping back 12 hours', () => {
  const current = windowOf('hours_12', 0, NOW, TZ);
  assert.equal(current.to, NOW);
  assert.equal(current.label, '22/10 03:00 → 15:00');
  assert.equal(windowOf('hours_12', -1, NOW, TZ).label, '22/10 15:00 → 03:00');
});

test('day: the local day, DST included', () => {
  const day = windowOf('day', 0, NOW, TZ);
  assert.deepEqual(day.days, ['2026-10-22']);
  assert.equal(day.from, Date.parse('2026-10-21T22:00:00.000Z'));
  assert.deepEqual(day.label, { en: 'Thu 22/10', fr: 'jeu. 22/10' });
  // Sunday 25 October 2026 is 25 hours long in Paris.
  const dst = windowOf('day', 3, NOW, TZ);
  assert.equal(dst.to - dst.from, 25 * 3_600_000);
});

test('week, month and year windows', () => {
  const week = windowOf('week', -1, NOW, TZ);
  assert.deepEqual([week.days[0], week.days.at(-1)], ['2026-10-09', '2026-10-15']);
  const month = windowOf('month', 0, NOW, TZ);
  assert.equal(month.days.length, 22, 'a current month stops today');
  const september = windowOf('month', -1, NOW, TZ);
  assert.equal(september.days.length, 30);
  assert.deepEqual(september.label, { en: 'Sep 2026', fr: 'sept. 2026' });
  assert.equal(windowOf('year', 0, NOW, TZ).months.length, 10);
  assert.equal(windowOf('year', -1, NOW, TZ).months.at(-1), '2025-12');
  assert.deepEqual(windowOf('all', 0, NOW, TZ, { firstYear: '2023' }).years, [
    '2023',
    '2024',
    '2025',
    '2026',
  ]);
});

test('previous only while there is data before', () => {
  const bounds = { now: NOW, firstMonth: '2026-09' };
  assert.equal(hasPrevious(windowOf('month', 0, NOW, TZ), bounds), true);
  assert.equal(hasPrevious(windowOf('month', -1, NOW, TZ), bounds), false);
  assert.equal(hasPrevious(windowOf('day', -13, NOW, TZ), bounds), true, 'the 8th is partly kept');
  assert.equal(hasPrevious(windowOf('day', -14, NOW, TZ), bounds), false, '14 days of curves');
  assert.equal(hasPrevious(windowOf('all', 0, NOW, TZ), bounds), false);
});

test('views: a period chosen in the form, cycled without one, previous and next', () => {
  const views = createViews();
  const spec = { periods: ['month', 'year', 'all'], defaultPeriod: 'month' };
  const settings = { devices: ['a'] };
  assert.deepEqual(views.get('history', settings, spec), { period: 'month', offset: 0 });
  views.apply('history', settings, spec, PREVIOUS_ACTION);
  views.apply('history', settings, spec, PREVIOUS_ACTION);
  assert.deepEqual(views.get('history', settings, spec), { period: 'month', offset: -2 });
  views.apply('history', settings, spec, NEXT_ACTION);
  views.apply('history', settings, spec, NEXT_ACTION);
  views.apply('history', settings, spec, NEXT_ACTION);
  assert.equal(views.get('history', settings, spec).offset, 0, 'never in the future');
  views.apply('history', settings, spec, PERIOD_ACTION, { period: 'all' });
  assert.equal(views.get('history', settings, spec).period, 'all');
  // An older core relays no form: the period cycles.
  views.apply('history', settings, spec, PERIOD_ACTION, {});
  assert.equal(views.get('history', settings, spec).period, 'month');
  // Another instance (other settings) keeps its own view.
  assert.deepEqual(views.get('history', {}, spec), { period: 'month', offset: 0 });
  assert.notEqual(instanceKey('history', { a: 1, b: 2 }), instanceKey('history', { a: 2 }));
  assert.equal(instanceKey('history', { a: 1, b: 2 }), instanceKey('history', { b: 2, a: 1 }));
});

test('the buttons: the period form, previous, then next once stepped back', () => {
  const periods = ['month', 'year', 'all'];
  const current = viewButtons({ period: 'month', offset: 0 }, periods, true);
  assert.deepEqual(
    current.map((button) => button.action.key),
    ['period', 'previous'],
  );
  assert.deepEqual(
    current[0].action.fields[0].options.map((option) => option.value),
    periods,
  );
  assert.equal(current[0].action.fields[0].default, 'month');
  const back = viewButtons({ period: 'month', offset: -3 }, periods, false);
  assert.deepEqual(
    back.map((button) => button.action.key),
    ['period', 'next'],
  );
});

test('local ISO times carry their offset, summer and winter', () => {
  assert.equal(localIso(Date.parse('2026-10-11T22:00:00.000Z'), TZ), '2026-10-12T00:00:00+02:00');
  assert.equal(localIso(Date.parse('2026-12-01T23:00:00.000Z'), TZ), '2026-12-02T00:00:00+01:00');
  assert.equal(
    localIso(Date.parse('2026-12-01T23:00:00.000Z'), 'America/Martinique'),
    '2026-12-01T19:00:00-04:00',
  );
});

test('dates typed in the period form', () => {
  const at = (text) => parseDate(text, NOW, TZ);
  assert.deepEqual(at('05/09/2025'), { year: 2025, month: 9, day: 5 });
  assert.deepEqual(at('5-9-25'), { year: 2025, month: 9, day: 5 });
  assert.deepEqual(at('05/09'), { year: 2026, month: 9, day: 5 });
  assert.deepEqual(at('25/12'), { year: 2025, month: 12, day: 25 }, 'still to come: last year');
  assert.deepEqual(at('09/2025'), { year: 2025, month: 9 });
  assert.deepEqual(at('2025-09-05'), { year: 2025, month: 9, day: 5 });
  assert.deepEqual(at('Sept. 2025'), { year: 2025, month: 9 });
  assert.deepEqual(at('août'), { year: 2026, month: 8 });
  assert.deepEqual(at('décembre'), { year: 2025, month: 12 });
  assert.deepEqual(at('2 février 2026'), { year: 2026, month: 2, day: 2 });
  assert.deepEqual(at('2024'), { year: 2024 });
  for (const wrong of ['hier', '31/02/2026', '13/2025', '1890', '']) {
    assert.equal(at(wrong), null, wrong);
  }
});

test('a date gives the offset of the period holding it', () => {
  const date = { year: 2026, month: 10, day: 15 };
  assert.equal(offsetForDate('day', date, NOW, TZ), -7);
  assert.equal(offsetForDate('week', date, NOW, TZ), -1);
  assert.equal(offsetForDate('month', { year: 2025, month: 9 }, NOW, TZ), -13);
  assert.equal(offsetForDate('year', { year: 2023 }, NOW, TZ), -3);
  assert.equal(offsetForDate('day', { year: 2027, month: 1, day: 1 }, NOW, TZ), 0, 'to come');
  const hours = offsetForDate('hours_12', date, NOW, TZ);
  const window = windowOf('hours_12', hours, NOW, TZ);
  const noon = Date.parse('2026-10-15T10:00:00.000Z');
  assert.ok(window.from <= noon && noon < window.to);
  // The window of the offset holds the date.
  const week = windowOf('week', offsetForDate('week', date, NOW, TZ), NOW, TZ);
  assert.ok(week.days.includes('2026-10-15'));
});

test('the best tile names its day, month or year', () => {
  assert.deepEqual(bestLabel(windowOf('month', 0, NOW, TZ), '2026-10-02'), {
    en: 'Best · Friday 02',
    fr: 'Meilleur · vendredi 02',
  });
  assert.equal(bestLabel(windowOf('year', 0, NOW, TZ), '2026-08').fr, 'Meilleur · août 2026');
  for (const label of Object.values(bestLabel(windowOf('month', 0, NOW, TZ), '2026-10-07'))) {
    assert.ok(label.length <= 24, label);
  }
});

test('the period form carries an optional date field', () => {
  const [button] = viewButtons({ period: 'month', offset: 0 }, ['month', 'year'], true);
  const date = button.action.fields.find((field) => field.key === 'date');
  assert.equal(date.type, 'string');
  assert.equal(date.required, undefined);
});
