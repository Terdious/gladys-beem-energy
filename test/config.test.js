import { test } from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_CONFIG, hasCredentials, normalizeConfig } from '../src/config.js';

test('an empty config is the defaults', () => {
  assert.deepEqual(normalizeConfig(), DEFAULT_CONFIG);
  assert.equal(hasCredentials(normalizeConfig()), false);
});

test('form values are coerced and bounded', () => {
  const config = normalizeConfig({
    email: '  me@example.com ',
    password: ' spaced ',
    poll_frequency: '10',
    history_months: '500',
    timezone: 'Mars/Olympus',
    price_base: '0,2016',
    price_peak: '-1',
    resale_enabled: 'true',
    self_consumption_rate: 150,
    feature_names: 'de',
    tariff_mode: 'weird',
  });
  assert.equal(config.email, 'me@example.com');
  assert.equal(config.password, ' spaced ');
  assert.equal(config.poll_frequency, 60);
  assert.equal(config.history_months, 120);
  assert.equal(config.timezone, 'Europe/Paris');
  assert.equal(config.price_base, 0.2016);
  assert.equal(config.price_peak, null);
  assert.equal(config.resale_enabled, true);
  assert.equal(config.self_consumption_rate, 100);
  assert.equal(config.feature_names, 'en');
  assert.equal(config.tariff_mode, 'none');
  assert.equal(hasCredentials(config), true);
});

test('a valid timezone is kept', () => {
  assert.equal(normalizeConfig({ timezone: 'America/Martinique' }).timezone, 'America/Martinique');
});
