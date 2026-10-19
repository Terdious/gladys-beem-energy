import { test } from 'node:test';
import assert from 'node:assert/strict';

import { boxIds } from '../src/devices/box.js';
import { STORE_SAVE_INTERVAL_MS } from '../src/site.js';
import { createStore } from '../src/store.js';
import { setupSite, tempDir } from './helpers/setup.js';
import { summary, threePhaseBoxes } from './helpers/fakeBeem.js';

// 19 October 2026, 12:00 in Paris (UTC+2).
const NOON = Date.parse('2026-10-19T10:00:00.000Z');

const october = (at, overrides = {}) =>
  threePhaseBoxes().map((box, i) =>
    summary({
      boxId: box.id,
      power: 400 + i * 10,
      day: 1500 + i * 100,
      month: 40000 + i * 1000,
      at,
      ...overrides,
    }),
  );

test('a refresh publishes the six boxes, their states, transports and the status', async () => {
  const { gladys, site } = await setupSite({
    at: NOON,
    boxes: threePhaseBoxes(),
    summaries: { '2026-10': october(NOON) },
  });
  assert.equal(await site.refresh(), true);

  const devices = gladys.fake.discoveredDevices;
  assert.equal(devices.length, 6);
  const beemOn = devices.find((device) => device.name === 'Beem On L1');
  assert.equal(beemOn.external_id, boxIds(gladys, '201').device);
  assert.ok(
    beemOn.params.some((param) => param.name === 'BEEM_PEAK_POWER_W' && param.value === '1000'),
  );

  const ids = boxIds(gladys, '101');
  assert.equal(gladys.fake.lastState(ids.feature('power')), 400);
  assert.equal(gladys.fake.lastState(ids.feature('today')), 1.5);
  assert.equal(gladys.fake.lastState(ids.feature('wifi')), 80);
  // The first reading only sets the baseline of the index.
  assert.equal(gladys.fake.lastState(ids.feature('energy')), 0);

  assert.ok(gladys.fake.transports.every((entry) => entry.transport === 'cloud'));
  assert.deepEqual(gladys.fake.connectionStatus, { connected: true });
});

test('the index grows with the month total, across a month change', async () => {
  const at = Date.parse('2026-10-31T20:00:00.000Z'); // 21:00 in Paris
  const { gladys, site, beem, clock } = await setupSite({
    at,
    boxes: threePhaseBoxes().slice(0, 1),
    summaries: { '2026-10': [summary({ boxId: 101, day: 3000, month: 50000, at })] },
  });
  await site.refresh();
  const energy = boxIds(gladys, '101').feature('energy');

  beem.state.summaries['2026-10'] = [summary({ boxId: 101, day: 3400, month: 50400, at })];
  clock.now = at + 60_000;
  await site.refresh();
  assert.equal(gladys.fake.lastState(energy), 0.4);

  // November 1st, 10:00: the cloud reset the month; October ended at 50.6 kWh.
  clock.now = Date.parse('2026-11-01T09:00:00.000Z');
  beem.state.summaries['2026-10'] = [summary({ boxId: 101, day: 3600, month: 50600, at })];
  beem.state.summaries['2026-11'] = [summary({ boxId: 101, day: 700, month: 700, at: clock.now })];
  await site.refresh();
  // 0.4 + the October tail (0.2) + November so far (0.7).
  assert.equal(gladys.fake.lastState(energy), 1.3);
  assert.equal(site.store.history('101').months['2026-10'], 50600);
});

test('a box asleep for the night reads 0 W, not its last power', async () => {
  const evening = Date.parse('2026-10-19T19:00:00.000Z');
  const { gladys, site } = await setupSite({
    at: evening,
    boxes: threePhaseBoxes().slice(0, 1),
    summaries: {
      '2026-10': [
        summary({ boxId: 101, power: 35, day: 2500, month: 40000, at: evening - 3_600_000 }),
      ],
    },
  });
  await site.refresh();
  assert.equal(gladys.fake.lastState(boxIds(gladys, '101').feature('power')), 0);
});

test('a box missing from the summary is reported unreachable', async () => {
  const { gladys, site } = await setupSite({
    at: NOON,
    boxes: threePhaseBoxes().slice(0, 2),
    summaries: { '2026-10': [summary({ boxId: 101, power: 100, at: NOON })] },
  });
  await site.refresh();
  const entry = gladys.fake.transports.find(
    (transport) => transport.device_external_id === boxIds(gladys, '102').device,
  );
  assert.equal(entry.transport, 'unreachable');
});

test('wrong credentials report the auth status and publish nothing', async () => {
  const { gladys, site } = await setupSite({
    at: NOON,
    boxes: threePhaseBoxes(),
    config: { password: 'wrong' },
  });
  assert.equal(await site.refresh(), false);
  assert.equal(site.lastError(), 'auth');
  assert.equal(gladys.fake.connectionStatus.connected, false);
  assert.match(gladys.fake.connectionStatus.message.fr, /refusé/);
  assert.equal(gladys.fake.discoveredDevices.length, 0);
});

test('missing credentials ask for them without calling the cloud', async () => {
  const { gladys, site, beem } = await setupSite({ at: NOON, config: { email: '', password: '' } });
  assert.equal(await site.refresh(), false);
  assert.equal(beem.calls.length, 0);
  assert.match(gladys.fake.connectionStatus.message.en, /e-mail and password/);
});

test('a 429 locks the client: the next refreshes do not call the cloud', async () => {
  const { site, beem, clock } = await setupSite({ at: NOON, boxes: threePhaseBoxes() });
  beem.failNext(429);
  assert.equal(await site.refresh(), false);
  assert.equal(site.lastError(), 'rate_limited');
  const calls = beem.calls.length;
  clock.now += 5 * 60_000;
  await site.refresh();
  assert.equal(beem.calls.length, calls);
  clock.now += 20 * 60_000;
  beem.state.summaries['2026-10'] = october(clock.now);
  assert.equal(await site.refresh(), true);
});

test('the topology is re-read hourly and a renamed box is re-published', async () => {
  const { gladys, site, beem, clock } = await setupSite({
    at: NOON,
    boxes: threePhaseBoxes(),
    summaries: { '2026-10': october(NOON) },
  });
  await site.refresh();
  const publications = gladys.fake.bodies('POST', '/discovered_device').length;
  clock.now += 2 * 60_000;
  await site.refresh();
  assert.equal(beem.callsTo('/devices').length, 1);
  assert.equal(gladys.fake.bodies('POST', '/discovered_device').length, publications);

  beem.state.boxes[0].name = 'Garage';
  clock.now += 61 * 60_000;
  await site.refresh();
  assert.equal(beem.callsTo('/devices').length, 2);
  assert.ok(gladys.fake.discoveredDevices.some((device) => device.name === 'Garage'));
});

test('the history backfill fetches each past month once and stops before the account', async () => {
  const { site, beem } = await setupSite({
    at: NOON,
    boxes: threePhaseBoxes().slice(0, 1),
    summaries: {
      '2026-10': [summary({ boxId: 101, month: 40000, at: NOON })],
      '2026-09': [summary({ boxId: 101, month: 90000, at: NOON })],
      '2026-08': [summary({ boxId: 101, month: 120000, at: NOON })],
    },
    config: { history_months: 12 },
  });
  await site.refresh();
  assert.equal(await site.backfillHistory(), 4); // Sep, Aug, then Jul and Jun empty
  assert.deepEqual(site.store.history('101').months, {
    '2026-10': 40000,
    '2026-09': 90000,
    '2026-08': 120000,
  });
  const summaryCalls = beem.callsTo('/box/summary').length;
  assert.equal(await site.backfillHistory(), 2); // the empty months are asked again
  assert.equal(beem.callsTo('/box/summary').length, summaryCalls + 2);
});

test('the store is saved periodically and loaded back', async () => {
  const dir = await tempDir();
  const { site, clock, beem } = await setupSite({
    at: NOON,
    dir,
    boxes: threePhaseBoxes().slice(0, 1),
    summaries: { '2026-10': [summary({ boxId: 101, month: 40000, at: NOON })] },
  });
  await site.refresh();
  beem.state.summaries['2026-10'] = [summary({ boxId: 101, month: 41000, at: NOON })];
  clock.now += STORE_SAVE_INTERVAL_MS;
  await site.refresh();

  const reloaded = createStore({ dir });
  await reloaded.load();
  assert.equal(reloaded.indexKwh('101'), 1);
  assert.equal(reloaded.lastMonthOf('101'), '2026-10');
});

test('the widgets are nudged after a refresh listener runs', async () => {
  const { site } = await setupSite({
    at: NOON,
    boxes: threePhaseBoxes(),
    summaries: { '2026-10': october(NOON) },
  });
  let calls = 0;
  site.onRefresh(() => {
    calls += 1;
  });
  await site.refresh();
  assert.equal(calls, 1);
});
