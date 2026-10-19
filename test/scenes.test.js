import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ACTIONS } from '../src/actions.js';
import { boxIds } from '../src/devices/box.js';
import { SCENE_ACTIONS, productionOutputs } from '../src/scenes.js';
import { setupSite } from './helpers/setup.js';
import { summary, threePhaseBoxes } from './helpers/fakeBeem.js';

const NOON = Date.parse('2026-10-19T10:00:00.000Z');

async function producing(config = {}) {
  const context = await setupSite({
    at: NOON,
    boxes: threePhaseBoxes(),
    summaries: {
      '2026-10': threePhaseBoxes().map((box) =>
        summary({ boxId: box.id, power: 450, day: 1500, month: 30000, at: NOON }),
      ),
    },
    config: { tariff_mode: 'base', price_base: 0.2, ...config },
  });
  await context.site.refresh();
  return context;
}

test('get_production sums the installation, or reads one box', async () => {
  const { gladys, site } = await producing();
  const all = productionOutputs(site, {}, NOON);
  assert.deepEqual(all, {
    power_w: 2700,
    today_kwh: 9,
    month_kwh: 180,
    year_kwh: 180,
    load_percent: 47,
    savings_today: 1.8,
    savings_month: 36,
  });
  const one = productionOutputs(site, { device: boxIds(gladys, '201').device }, NOON);
  assert.equal(one.power_w, 450);
  assert.equal(one.load_percent, 45);
  assert.throws(() => productionOutputs(site, { device: 'ext:unknown' }, NOON), /Unknown/);
});

test('get_production refreshes first when the cloud was never read', async () => {
  const context = await setupSite({
    at: NOON,
    boxes: threePhaseBoxes(),
    summaries: { '2026-10': [summary({ boxId: 101, power: 100, at: NOON })] },
  });
  const outputs = await SCENE_ACTIONS.get_production(context.gladys, {
    fields: {},
    site: context.site,
  });
  assert.equal(outputs.power_w, 100);
  assert.equal(outputs.savings_today, null);
});

test('test_connection lists the boxes; wrong credentials say so', async () => {
  const { gladys, site } = await producing();
  const message = await ACTIONS.test_connection(gladys, { fields: {}, site });
  assert.match(message.fr, /6 box trouvée/);

  const wrong = await setupSite({ at: NOON, boxes: threePhaseBoxes(), config: { password: 'x' } });
  const refused = await ACTIONS.test_connection(wrong.gladys, { fields: {}, site: wrong.site });
  assert.match(refused.en, /refused/);
});

test('diagnostic describes every box without any secret', async () => {
  const { gladys, site } = await producing();
  const message = await ACTIONS.diagnostic(gladys, { fields: {}, site });
  assert.equal(message.en.split('\n').length, 6);
  assert.match(message.fr, /Beem On L1 \(id 201, 1000 Wp\) : 450 W/);
  assert.ok(!message.en.includes('secret-password'));
});

test('reload_history starts in the background', async () => {
  const { gladys, site, beem } = await producing({ history_months: 2 });
  const before = beem.callsTo('/box/summary').length;
  const message = await ACTIONS.reload_history(gladys, { fields: {}, site });
  assert.match(message.en, /up to 2 month/);
  await site.backfillHistory();
  assert.equal(beem.callsTo('/box/summary').length, before + 2);
});
