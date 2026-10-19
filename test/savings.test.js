import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normalizeConfig } from '../src/config.js';
import {
  buildTariff,
  defaultSolarProfile,
  measuredSolarProfile,
  parseOffpeakHours,
  paybackOf,
  valueOf,
} from '../src/savings.js';

const close = (actual, expected, epsilon = 1e-6) =>
  assert.ok(Math.abs(actual - expected) < epsilon, `${actual} != ${expected}`);

test('off-peak hours parse ranges, across midnight too', () => {
  assert.deepEqual(parseOffpeakHours('22:00-06:00'), { ranges: [{ start: 1320, end: 360 }] });
  assert.deepEqual(parseOffpeakHours('02h00-07h00 ; 13:00-16:00').ranges.length, 2);
  assert.ok(parseOffpeakHours('').error);
  assert.ok(parseOffpeakHours('25:00-06:00').error);
  assert.ok(parseOffpeakHours('06:00-06:00').error);
});

test('no tariff without a mode, an error for a missing price', () => {
  assert.deepEqual(buildTariff(normalizeConfig()), { tariff: null, error: null });
  assert.match(buildTariff(normalizeConfig({ tariff_mode: 'base' })).error, /base price/);
  assert.match(
    buildTariff(normalizeConfig({ tariff_mode: 'base', price_base: 0.2, resale_enabled: true }))
      .error,
    /resale/,
  );
});

test('base: the kWh is worth the price times the self-consumption, plus the resale', () => {
  const { tariff } = buildTariff(
    normalizeConfig({
      tariff_mode: 'base',
      price_base: '0,2016',
      self_consumption_rate: 80,
      resale_enabled: true,
      resale_price: 0.04,
    }),
  );
  close(tariff.valuePerKwh, 0.8 * 0.2016 + 0.2 * 0.04);
  const value = valueOf(10, tariff);
  close(value.avoided, 8 * 0.2016);
  close(value.resale, 2 * 0.04);
});

test('peak / off-peak: the solar price follows the production profile', () => {
  const night = buildTariff(
    normalizeConfig({
      tariff_mode: 'peak_offpeak',
      price_peak: 0.3,
      price_offpeak: 0.1,
      offpeak_hours: '22:00-06:00',
    }),
  ).tariff;
  close(night.offpeakShare, 0);
  close(night.solarPrice, 0.3);

  const noon = buildTariff(
    normalizeConfig({
      tariff_mode: 'peak_offpeak',
      price_peak: 0.3,
      price_offpeak: 0.1,
      offpeak_hours: '11:00-16:00',
    }),
  ).tariff;
  assert.ok(noon.offpeakShare > 0.4 && noon.offpeakShare < 0.7);
  assert.ok(noon.solarPrice < 0.3 && noon.solarPrice > 0.1);

  // A measured profile producing only in the off-peak hours.
  const samples = Array.from({ length: 60 }, (_, i) => ({ minute: 12 * 60 + i * 5, w: 1000 }));
  const profile = measuredSolarProfile(samples);
  const measured = buildTariff(
    normalizeConfig({
      tariff_mode: 'peak_offpeak',
      price_peak: 0.3,
      price_offpeak: 0.1,
      offpeak_hours: '11:00-17:00',
    }),
    { profile },
  ).tariff;
  close(measured.offpeakShare, 1);
  assert.equal(measuredSolarProfile([{ minute: 600, w: 50 }]), null);
  assert.equal(defaultSolarProfile()[3 * 60], 0);
});

test('the payback follows the pace of the complete months', () => {
  const { tariff } = buildTariff(normalizeConfig({ tariff_mode: 'base', price_base: 0.2 }));
  const months = [
    { key: '2026-08', kwh: 500 },
    { key: '2026-09', kwh: 500 },
    { key: '2026-10', kwh: 100 },
  ];
  const payback = paybackOf({ cost: 1000, lifetimeSavings: 220, months, tariff });
  close(payback.progress, 0.22);
  close(payback.remaining, 780);
  close(payback.etaMonths, 7.8);
  assert.equal(paybackOf({ cost: null, lifetimeSavings: 1, months, tariff }), null);
  assert.equal(paybackOf({ cost: 100, lifetimeSavings: 220, months, tariff }).etaMonths, 0);
});
