import { test } from 'node:test';
import assert from 'node:assert/strict';

import { validateWidgetContent } from '@gladysassistant/integration-sdk';

import { boxContent, compassOf, cutsRow } from '../src/dashboard/box.js';
import { siteSelection } from '../src/dashboard/common.js';
import { historyContent, yearOverYear } from '../src/dashboard/history.js';
import { savingsContent } from '../src/dashboard/savings.js';
import { phaseBalance, siteContent } from '../src/dashboard/site.js';
import { boxIds } from '../src/devices/box.js';
import { cutsOf } from '../src/production.js';
import { WIDGETS } from '../src/widgets.js';
import { setupSite } from './helpers/setup.js';
import { summary, threePhaseBoxes } from './helpers/fakeBeem.js';

const NOON = Date.parse('2026-10-19T10:00:00.000Z');

const TARIFF = {
  tariff_mode: 'peak_offpeak',
  price_peak: 0.2146,
  price_offpeak: 0.1696,
  offpeak_hours: '22:00-06:00',
  self_consumption_rate: 90,
  installation_cost: 4500,
};

/** Six boxes producing, the morning sampled every 5 minutes, a history. */
async function producingSite(config = {}) {
  const setup = await setupSite({
    at: NOON - 3 * 3_600_000,
    boxes: threePhaseBoxes(),
    config: { ...TARIFF, ...config },
  });
  const { site, beem, clock } = setup;
  for (let at = NOON - 3 * 3_600_000; at <= NOON; at += 5 * 60_000) {
    clock.now = at;
    const hours = (at - (NOON - 3 * 3_600_000)) / 3_600_000;
    beem.state.summaries['2026-10'] = threePhaseBoxes().map((box, i) =>
      summary({
        boxId: box.id,
        power: Math.round((box.id > 200 ? 700 : 600) * (0.3 + hours / 5)),
        day: Math.round(hours * 400 + i * 50),
        month: 40000 + Math.round(hours * 400),
        at,
      }),
    );
    await site.refresh();
  }
  for (const box of threePhaseBoxes()) {
    site.store.setMonth(String(box.id), '2026-09', 90000);
    site.store.setMonth(String(box.id), '2025-10', 60000);
  }
  return setup;
}

const threePhaseSettings = (gladys) => ({
  layout: 'three_phase',
  phase_l1: [boxIds(gladys, '101').device, boxIds(gladys, '201').device],
  phase_l2: [boxIds(gladys, '102').device, boxIds(gladys, '202').device],
  phase_l3: [boxIds(gladys, '103').device, boxIds(gladys, '203').device],
});

const statusOf = (content) => content.components.find((component) => component.type === 'status');
const text = (value) => (typeof value === 'string' ? value : value.en);

test('the box widget is rendered exactly as sent and binds its live tiles', async () => {
  const { gladys, site } = await producingSite();
  const content = boxContent(gladys, site, site.snapshots()[0], {
    now: NOON,
    config: site.config(),
    title: 'Beem On L1',
  });
  assert.deepEqual(validateWidgetContent(content), []);
  const published = new Set(
    gladys.fake.discoveredDevices.flatMap((device) => device.features.map((f) => f.external_id)),
  );
  const bound = content.components.flatMap(
    (c) => c.device_features ?? (c.device_feature ? [c.device_feature] : []),
  );
  assert.ok(bound.length >= 1);
  for (const id of bound) {
    assert.ok(published.has(id), `unknown feature ${id}`);
  }
});

test('the site widget, single-phase and three-phase, is rendered exactly as sent', async () => {
  const { gladys, site } = await producingSite();
  for (const settings of [{}, threePhaseSettings(gladys)]) {
    const selection = siteSelection(site.snapshots(), settings);
    const content = siteContent(site, selection, {
      now: NOON,
      config: site.config(),
      title: 'Installation',
      threshold: 500,
      showChart: true,
    });
    assert.deepEqual(validateWidgetContent(content), []);
    const chart = content.components.find((component) => component.type === 'chart');
    assert.equal(chart.series.length, settings.layout ? 3 : 1);
  }
});

test('three-phase: one row per phase and the phase balance', async () => {
  const { gladys, site } = await producingSite();
  const selection = siteSelection(site.snapshots(), threePhaseSettings(gladys));
  const content = siteContent(site, selection, {
    now: NOON,
    config: site.config(),
    title: 'Installation',
    threshold: 500,
    showChart: false,
  });
  const labels = statusOf(content).items.map((item) => text(item.label));
  assert.ok(labels[0].startsWith('L1 (2) · 1.9 kWc'));
  assert.ok(labels.includes('Phase balance'));
  const balance = phaseBalance(selection.phases, NOON, 'Europe/Paris', 500);
  assert.equal(balance.warning, false);
});

test('three-phase: a box picked twice or nowhere is reported', async () => {
  const { gladys, site } = await producingSite();
  const settings = threePhaseSettings(gladys);
  settings.phase_l2 = [boxIds(gladys, '101').device];
  const selection = siteSelection(site.snapshots(), settings);
  assert.equal(selection.duplicates.length, 1);
  assert.equal(selection.unassigned.length, 2);
});

test('a silent box is flagged on the site widget', async () => {
  const { site, beem, clock } = await producingSite();
  clock.now = NOON + 60_000;
  beem.state.summaries['2026-10'] = beem.state.summaries['2026-10'].filter(
    (entry) => entry.boxId !== 202,
  );
  await site.refresh();
  const content = siteContent(site, siteSelection(site.snapshots(), {}), {
    now: clock.now,
    config: site.config(),
    title: 'Installation',
    threshold: 500,
    showChart: false,
  });
  const silent = statusOf(content).items.find((item) => text(item.label) === 'Silent boxes');
  assert.match(silent.value, /Beem On L2/);
});

test('the savings widget values the production and shows the payback', async () => {
  const { site } = await producingSite();
  const content = savingsContent(site, site.snapshots(), {
    now: NOON,
    config: site.config(),
    title: 'Savings',
  });
  assert.deepEqual(validateWidgetContent(content), []);
  const gauge = content.components.find((component) => component.type === 'gauge');
  assert.ok(gauge.value > 0 && gauge.value < 100);
  const labels = statusOf(content).items.map((item) => text(item.label));
  assert.ok(labels.includes('Payback'));
  assert.ok(labels.includes('Given to the grid'));
});

test('the savings widget asks for a tariff when there is none', async () => {
  const { site } = await producingSite({ tariff_mode: 'none' });
  const content = savingsContent(site, site.snapshots(), {
    now: NOON,
    config: site.config(),
    title: 'Savings',
  });
  assert.deepEqual(validateWidgetContent(content), []);
  assert.match(content.components[0].text.en, /electricity price/);
});

test('the history widget, per day and per month, is rendered exactly as sent', async () => {
  const { site } = await producingSite();
  for (const period of ['days', 'months_12', 'months_24']) {
    const content = historyContent(site.snapshots(), {
      now: NOON,
      config: site.config(),
      title: 'History',
      period,
    });
    assert.deepEqual(validateWidgetContent(content), [], period);
  }
  const comparison = yearOverYear(site.snapshots(), NOON, 'Europe/Paris');
  assert.equal(comparison.previousKey, '2025-10');
  assert.equal(comparison.previousKwh, 360);
});

test('every widget answers before the first connection to the cloud', async () => {
  const { gladys, site } = await setupSite({ at: NOON, config: { email: '' } });
  for (const [key, widget] of Object.entries(WIDGETS)) {
    const content = await widget.get(gladys, { settings: {}, site });
    assert.deepEqual(validateWidgetContent(content), [], key);
  }
});

test('the box widget of a deleted box says so', async () => {
  const { gladys, site } = await producingSite();
  const content = await WIDGETS.box.get(gladys, { settings: { device: 'ext:gone' }, site });
  assert.match(content.components[0].text.en, /no longer exists/);
});

test('the box widget compares the box with the others and draws the expected curve', async () => {
  const { gladys, site } = await producingSite();
  const box = site.snapshots().find((snapshot) => snapshot.id === '201');
  const content = boxContent(gladys, site, box, { now: NOON, config: site.config(), title: 'B' });
  const chart = content.components.find((component) => component.type === 'chart');
  assert.deepEqual(
    chart.series.map((series) => series.name.en),
    ['This box', 'Expected'],
  );
  // A load close to its peers': the expected curve is close to its own.
  const [own, expected] = chart.series.map((series) => series.points.at(-1).v);
  assert.ok(Math.abs(own - expected) / own < 0.1, `${own} vs ${expected}`);
  const rows = statusOf(content).items;
  const comparison = rows.find((item) => text(item.label) === 'Against the other boxes');
  assert.match(comparison.value.en, /% of the median/);
  assert.ok(
    rows.some((item) => text(item.label) === 'This year'),
    'yesterday unknown: hidden',
  );
  assert.ok(rows.some((item) => text(item.label) === 'Since Oct 2025'));
});

test('a box that cuts out while the others produce counts its cuts', async () => {
  const { gladys, site, beem, clock } = await producingSite();
  const read = async (at, cut) => {
    clock.now = at;
    beem.state.summaries['2026-10'] = threePhaseBoxes()
      .filter((box) => !(cut && box.id === 201))
      .map((box) => summary({ boxId: box.id, power: 500, day: 3000, month: 41000, at }));
    await site.refresh();
  };
  const step = 5 * 60_000;
  // Two cuts: absent from the summary for 10 min, then 5 min; back since.
  const pattern = [true, true, false, true, false, false];
  for (const [i, cut] of pattern.entries()) {
    await read(NOON + (i + 1) * step, cut);
  }
  const box = site.snapshots().find((snapshot) => snapshot.id === '201');
  const from = Date.parse('2026-10-18T22:00:00.000Z');
  const cuts = cutsOf(site.store, box, site.snapshots(), from);
  assert.equal(cuts.count, 2);
  assert.equal(cuts.lastAt, NOON + 4 * step);
  assert.deepEqual(cutsRow(cuts, 'Europe/Paris').value, {
    en: '2 · last 12:20',
    fr: '2 · dernière 12:20',
  });
  const content = boxContent(gladys, site, box, {
    now: clock.now,
    config: site.config(),
    title: 'B',
  });
  assert.deepEqual(validateWidgetContent(content), []);
});

test('the panel azimuth reads as a compass point', () => {
  assert.equal(compassOf(0, 'fr'), 'S');
  assert.equal(compassOf(-30, 'en'), 'SE');
  assert.equal(compassOf(-90, 'fr'), 'E');
  assert.equal(compassOf(90, 'fr'), 'O');
  assert.equal(compassOf(180, 'en'), 'N');
});

test('the site, savings and history widgets repeat no default title', async () => {
  const { gladys, site } = await producingSite();
  for (const key of ['site', 'savings', 'history']) {
    const content = await WIDGETS[key].get(gladys, { settings: {}, site });
    assert.ok(
      !content.components.some((component) => component.variant === 'heading'),
      `${key} has no heading`,
    );
    const titled = await WIDGETS[key].get(gladys, { settings: { title: 'Mine' }, site });
    assert.equal(titled.components[0].text, 'Mine');
  }
});
