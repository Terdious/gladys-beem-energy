import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { DAY_RETENTION, SAMPLE_RETENTION_MS, STORE_FILE, createStore } from '../src/store.js';
import { tempDir } from './helpers/setup.js';

const NOW = Date.parse('2026-10-19T10:00:00.000Z');
const context = (overrides = {}) => ({
  now: NOW,
  dayKey: '2026-10-19',
  monthKey: '2026-10',
  ...overrides,
});

test('the first reading sets the baseline, the next ones grow the index', () => {
  const store = createStore({ dir: '/nonexistent' });
  assert.equal(store.record('1', { monthWh: 40000, todayWh: 1000, powerW: 300 }, context()), 0);
  assert.equal(store.record('1', { monthWh: 40250, todayWh: 1250, powerW: 300 }, context()), 0.25);
  assert.equal(store.indexKwh('1'), 0.25);
});

test('a lower month total is followed without a negative delta', () => {
  const store = createStore({ dir: '/nonexistent' });
  store.record('1', { monthWh: 40000 }, context());
  assert.equal(store.record('1', { monthWh: 39900 }, context()), 0);
  assert.equal(store.record('1', { monthWh: 40000 }, context()), 0.1);
});

test('a month change adds the tail of the old month and the start of the new one', () => {
  const store = createStore({ dir: '/nonexistent' });
  store.record('1', { monthWh: 50000 }, context({ monthKey: '2026-10' }));
  const added = store.record(
    '1',
    { monthWh: 700 },
    context({ monthKey: '2026-11', previousMonthFinalWh: 50300 }),
  );
  assert.equal(added, 1);
  assert.deepEqual(store.history('1').months, { '2026-10': 50300, '2026-11': 700 });
});

test('days and samples are pruned', () => {
  const store = createStore({ dir: '/nonexistent' });
  for (let day = 0; day < DAY_RETENTION + 5; day += 1) {
    const key = new Date(Date.UTC(2025, 0, 1 + day)).toISOString().slice(0, 10);
    store.record('1', { todayWh: day }, context({ dayKey: key }));
  }
  assert.equal(Object.keys(store.history('1').days).length, DAY_RETENTION);
  store.record('2', { powerW: 100 }, context({ now: NOW - SAMPLE_RETENTION_MS - 600_000 }));
  store.record('2', { powerW: 200 }, context());
  store.record('2', { powerW: 400 }, context({ now: NOW + 1000 }));
  assert.deepEqual(store.samples('2'), [{ t: NOW, w: 300 }]);
});

test('the store survives a restart and a corrupted file', async () => {
  const dir = await tempDir();
  const store = createStore({ dir });
  store.record('1', { monthWh: 1000 }, context());
  store.record('1', { monthWh: 3000 }, context());
  store.setEventMark('daily_report', '2026-10-19');
  store.markMonthFetched('2026-09');
  await store.save();

  const reloaded = createStore({ dir });
  await reloaded.load();
  assert.equal(reloaded.indexKwh('1'), 2);
  assert.equal(reloaded.eventMark('daily_report'), '2026-10-19');
  assert.equal(reloaded.isMonthFetched('2026-09'), true);

  await writeFile(join(dir, STORE_FILE), '{ not json');
  const broken = createStore({ dir });
  await broken.load();
  assert.equal(broken.indexKwh('1'), null);
});
