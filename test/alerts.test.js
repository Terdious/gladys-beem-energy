import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DAILY_REPORT_TRIGGER,
  SILENCE_CONFIRM_MS,
  UNDERPERFORMING_TRIGGER,
  createAlerts,
} from '../src/alerts.js';
import { boxIds } from '../src/devices/box.js';
import { setupSite } from './helpers/setup.js';
import { summary, threePhaseBoxes } from './helpers/fakeBeem.js';

const at = (iso) => Date.parse(iso);

/** Six boxes; `power(box)` and `day(box)` give each reading. */
async function setup(start, { power, day }) {
  const context = await setupSite({
    at: start,
    boxes: threePhaseBoxes(),
    config: { tariff_mode: 'base', price_base: 0.2 },
  });
  const alerts = createAlerts({
    gladys: context.gladys,
    site: context.site,
    now: () => context.clock.now,
  });
  const read = async (time) => {
    context.clock.now = time;
    context.beem.state.summaries['2026-10'] = threePhaseBoxes().map((box) =>
      summary({ boxId: box.id, power: power(box), day: day(box), month: 40000, at: time }),
    );
    await context.site.refresh();
    await alerts.evaluate();
  };
  return { ...context, alerts, read };
}

const events = (gladys, key) => gladys.fake.sceneEvents.filter((event) => event.key === key);

test('a box silent while the others produce fires once, after the confirmation delay', async () => {
  const start = at('2026-10-19T09:00:00.000Z');
  const { gladys, read } = await setup(start, {
    power: (box) => (box.id === 202 ? 0 : 500),
    day: () => 1000,
  });
  await read(start);
  assert.equal(events(gladys, UNDERPERFORMING_TRIGGER).length, 0);
  await read(start + SILENCE_CONFIRM_MS);
  await read(start + SILENCE_CONFIRM_MS + 120_000);
  const fired = events(gladys, UNDERPERFORMING_TRIGGER);
  assert.equal(fired.length, 1);
  assert.equal(fired[0].data.device, boxIds(gladys, '202').device);
  assert.equal(fired[0].data.reason, 'silent');
});

test('a low yield fires in the afternoon only', async () => {
  const morning = at('2026-10-19T08:00:00.000Z');
  const { gladys, read } = await setup(morning, {
    power: () => 0,
    day: (box) => (box.id === 103 ? 800 : box.id > 200 ? 3000 : 2700),
  });
  await read(morning);
  assert.equal(events(gladys, UNDERPERFORMING_TRIGGER).length, 0);
  await read(at('2026-10-19T12:30:00.000Z'));
  const fired = events(gladys, UNDERPERFORMING_TRIGGER);
  assert.equal(fired.length, 1);
  assert.equal(fired[0].data.reason, 'low_yield');
  assert.equal(fired[0].data.device_name, 'BeemBox L3');
  assert.equal(fired[0].data.ratio, 30);
});

test('the daily report fires once the boxes are asleep in the evening', async () => {
  const afternoon = at('2026-10-19T13:00:00.000Z'); // 15:00 in Paris
  let power = 300;
  const { gladys, read, store } = await setup(afternoon, { power: () => power, day: () => 2000 });
  await read(afternoon);
  await read(at('2026-10-19T15:00:00.000Z'));
  assert.equal(events(gladys, DAILY_REPORT_TRIGGER).length, 0);
  power = 0;
  await read(at('2026-10-19T15:10:00.000Z'));
  assert.equal(events(gladys, DAILY_REPORT_TRIGGER).length, 0);
  await read(at('2026-10-19T15:45:00.000Z'));
  await read(at('2026-10-19T16:00:00.000Z'));
  const fired = events(gladys, DAILY_REPORT_TRIGGER);
  assert.equal(fired.length, 1);
  assert.deepEqual(fired[0].data, {
    today_kwh: 12,
    month_kwh: 240,
    yield_kwh_per_kwp: 2.11,
    savings: 2.4,
    co2_kg: 0.6,
    best_box: 'Beem On L1',
    best_box_kwh: 2,
  });
  assert.equal(store.eventMark('daily_report'), '2026-10-19');
});
