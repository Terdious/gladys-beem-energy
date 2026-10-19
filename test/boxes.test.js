import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';

import {
  STALE_PRODUCTION_MS,
  describeBox,
  rawBoxesOf,
  readSummary,
  signalQuality,
} from '../src/beem/boxes.js';
import { boxIdOfDevice, boxIds, buildBoxDevice } from '../src/devices/box.js';
import { normalizeConfig } from '../src/config.js';
import { rawBox } from './helpers/fakeBeem.js';

const NOW = Date.parse('2026-10-19T10:00:00.000Z');

test('the peak power is the sum of the panels, the nominal power otherwise', () => {
  assert.equal(
    describeBox(rawBox({ id: 1, name: 'A', panels: 2, panelPower: 500 })).peakPowerW,
    1000,
  );
  assert.equal(describeBox({ id: 2, name: 'B', power: 900 }).peakPowerW, 900);
  assert.equal(describeBox({ id: 3 }).name, 'Beem box 3');
});

test('the boxes of a battery installation are listed once', () => {
  const box = rawBox({ id: 7, name: 'A' });
  const boxes = rawBoxesOf({ beemboxes: [box], batteries: [{ beemboxes: [box, { id: 8 }] }] });
  assert.deepEqual(
    boxes.map((entry) => entry.id),
    [7, 8],
  );
});

test('a summary reads the power, the day, the month and the signal', () => {
  const reading = readSummary(
    {
      boxId: 1,
      wattHour: 412.6,
      totalDay: 1530,
      totalMonth: 40210,
      lastDbm: -58,
      lastProduction: new Date(NOW - 60_000).toISOString(),
    },
    NOW,
  );
  assert.deepEqual(
    { ...reading, lastProductionAt: undefined },
    {
      reported: true,
      powerW: 413,
      todayWh: 1530,
      monthWh: 40210,
      dbm: -58,
      lastProductionAt: undefined,
      asleep: false,
    },
  );
});

test('a stale report reads 0 W, an absent box reads nothing', () => {
  const stale = readSummary(
    {
      boxId: 1,
      wattHour: 50,
      lastProduction: new Date(NOW - STALE_PRODUCTION_MS - 1).toISOString(),
    },
    NOW,
  );
  assert.equal(stale.powerW, 0);
  assert.equal(stale.asleep, true);
  assert.equal(readSummary(undefined, NOW).reported, false);
});

test('the signal quality maps -100..-50 dBm to 0..100 %', () => {
  assert.equal(signalQuality(-100), 0);
  assert.equal(signalQuality(-75), 50);
  assert.equal(signalQuality(-40), 100);
  assert.equal(signalQuality(null), null);
});

test('a box device is accepted by Gladys and keyed on the cloud id', async () => {
  const gladys = createFakeGladys();
  await gladys.connect();
  const device = buildBoxDevice(
    gladys,
    describeBox(rawBox({ id: 201, name: 'Beem On', panels: 2, panelPower: 500 })),
    normalizeConfig({ feature_names: 'fr' }),
  );
  await gladys.publishDiscoveredDevices([device]);
  assert.equal(gladys.fake.discoveredDevices.length, 1);
  assert.equal(device.external_id, boxIds(gladys, '201').device);
  assert.equal(boxIdOfDevice(gladys, device.external_id), '201');
  assert.equal(device.features[0].name, 'Puissance solaire');
  assert.equal(device.features[0].max, 1250);
  assert.deepEqual(
    device.features.map((feature) => feature.type),
    ['power', 'index', 'daily-production', 'integer'],
  );
});
