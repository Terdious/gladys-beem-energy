import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  NEXT_ACTION,
  PERIOD_ACTION,
  PREVIOUS_ACTION,
  createViews,
  hasPrevious,
  instanceKey,
  viewButtons,
  windowOf,
} from '../src/dashboard/period.js';

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
