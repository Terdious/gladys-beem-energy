import { test } from 'node:test';
import assert from 'node:assert/strict';

import { LOCK_AFTER_429_MS, TOKEN_LIFETIME_MS, createBeemClient } from '../src/beem/client.js';
import { EMAIL, PASSWORD, createFakeBeem } from './helpers/fakeBeem.js';

function setup() {
  const clock = { now: Date.parse('2026-10-19T10:00:00.000Z') };
  const beem = createFakeBeem({ summaries: { '2026-10': [{ boxId: 1, totalMonth: 1000 }] } });
  const client = createBeemClient({
    email: EMAIL,
    password: PASSWORD,
    fetchImpl: beem.fetch,
    now: () => clock.now,
  });
  return { clock, beem, client };
}

test('the client logs in once and reuses its token', async () => {
  const { beem, client } = setup();
  await client.getDevices();
  await client.getBoxSummary({ month: 10, year: 2026 });
  assert.equal(beem.callsTo('/user/login').length, 1);
  assert.deepEqual(beem.callsTo('/box/summary')[0].body, { month: 10, year: 2026 });
  assert.equal(beem.callsTo('/devices')[0].authorization, 'Bearer token-1');
});

test('the token is renewed before it expires, and once on a 401', async () => {
  const { beem, client, clock } = setup();
  await client.getDevices();
  clock.now += TOKEN_LIFETIME_MS + 1;
  await client.getDevices();
  assert.equal(beem.callsTo('/user/login').length, 2);

  beem.state.token = 'token-2';
  await client.getDevices();
  assert.equal(beem.callsTo('/user/login').length, 3);
  assert.equal(beem.calls.at(-1).authorization, 'Bearer token-2');
});

test('concurrent calls share one login', async () => {
  const { beem, client } = setup();
  await Promise.all([client.getDevices(), client.getBoxSummary({ month: 10, year: 2026 })]);
  assert.equal(beem.callsTo('/user/login').length, 1);
});

test('a 429 locks the client for a while', async () => {
  const { beem, client, clock } = setup();
  beem.failNext(429);
  await assert.rejects(client.getDevices(), { code: 'rate_limited' });
  const calls = beem.calls.length;
  await assert.rejects(client.getDevices(), { code: 'rate_limited' });
  assert.equal(beem.calls.length, calls);
  assert.ok(client.lockedUntil() > clock.now);
  clock.now += LOCK_AFTER_429_MS;
  assert.equal(client.lockedUntil(), 0);
  await client.getDevices();
});

test('errors carry a stable code', async () => {
  const { beem, client } = setup();
  beem.failNext(503);
  await assert.rejects(client.getDevices(), { code: 'unavailable' });
  beem.failNext('network');
  await assert.rejects(client.getDevices(), { code: 'network' });
  const wrong = createBeemClient({ email: EMAIL, password: 'nope', fetchImpl: beem.fetch });
  await assert.rejects(wrong.login(), { code: 'auth' });
  const empty = createBeemClient({ email: '', password: '', fetchImpl: beem.fetch });
  await assert.rejects(empty.getDevices(), { code: 'missing_credentials' });
});

test('the password is never in an error message', async () => {
  const { beem, client } = setup();
  beem.failNext(500);
  const err = await client.getDevices().catch((error) => error);
  assert.ok(!err.message.includes(PASSWORD));
});
