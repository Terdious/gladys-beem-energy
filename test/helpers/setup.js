// -----------------------------------------------------------------------------
// A site wired to the SDK's fake Gladys and the fake Beem cloud, on a clock
// the test moves.
// -----------------------------------------------------------------------------

import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';

import { createBeemClient } from '../../src/beem/client.js';
import { normalizeConfig } from '../../src/config.js';
import { createSite } from '../../src/site.js';
import { createStore } from '../../src/store.js';
import { EMAIL, PASSWORD, createFakeBeem } from './fakeBeem.js';

/** A temporary data directory (never /data in the tests). */
export const tempDir = () => mkdtemp(join(tmpdir(), 'beem-test-'));

/**
 * @param {{ at: number, boxes?: Array<object>, summaries?: object, config?: object, dir?: string }} options
 */
export async function setupSite({ at, boxes, summaries, config = {}, dir } = {}) {
  const clock = { now: at };
  const now = () => clock.now;
  const beem = createFakeBeem({ boxes, summaries });
  const gladys = createFakeGladys();
  await gladys.connect();
  const store = createStore({ dir: dir ?? (await tempDir()) });
  const site = createSite({
    gladys,
    store,
    now,
    sleep: async () => {},
    clientFactory: (options) => createBeemClient({ ...options, fetchImpl: beem.fetch, now }),
  });
  site.configure(normalizeConfig({ email: EMAIL, password: PASSWORD, ...config }));
  return { clock, beem, gladys, store, site };
}
