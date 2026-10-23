// -----------------------------------------------------------------------------
// Entry point of the Beem Energy integration for Gladys Assistant.
//
// Role of this file: wire the SDK to the installation (src/site.js). It holds
// no Beem logic; it only:
//   1. instantiates the SDK (connection, auth, reconnection: handled for you);
//   2. registers the event handlers BEFORE connect();
//   3. connects, then reads the Beem cloud at the configured pace.
//
// Environment variables provided by the Gladys supervisor to the container:
//   - GLADYS_HOST_API_URL         (host API URL)
//   - GLADYS_INTEGRATION_TOKEN    (integration-scoped JWT)
//   - GLADYS_INTEGRATION_SELECTOR (integration identifier)
// The SDK reads them automatically: `new GladysIntegration()` is enough.
// -----------------------------------------------------------------------------

import { GladysIntegration, logger } from '@gladysassistant/integration-sdk';

import { ACTIONS } from './src/actions.js';
import { createAlerts } from './src/alerts.js';
import { normalizeConfig } from './src/config.js';
import { SCENE_ACTIONS } from './src/scenes.js';
import { createSite } from './src/site.js';
import { createStore } from './src/store.js';
import { WIDGETS, refreshWidgets } from './src/widgets.js';

const gladys = new GladysIntegration();
const store = createStore();
const site = createSite({ gladys, store });
const alerts = createAlerts({ gladys, site });

site.configure(normalizeConfig());
site.onRefresh(async () => {
  await alerts.evaluate();
  refreshWidgets(gladys);
});

// One timer reads the cloud for every box at once (src/site.js): the devices
// are published without polling.
let timer = null;
let storeLoaded = null;

function schedule() {
  clearInterval(timer);
  timer = setInterval(() => {
    site.refresh().catch((err) => logger.error('Refresh failed', err));
  }, site.config().poll_frequency * 1000);
}

function stop() {
  clearInterval(timer);
  timer = null;
}

/** Read the cloud now, then the history not fetched yet, then keep reading. */
async function start() {
  await (storeLoaded ??= store.load());
  if (await site.refresh({ forceTopology: true })) {
    site.backfillHistory().catch((err) => logger.error('History backfill failed', err));
  }
  schedule();
}

// --- Discovery: Gladys asks for the list of devices --------------------------
gladys.onScanRequest(async () => {
  logger.info('onScanRequest -> reading the Beem account');
  await site.refresh({ forceTopology: true });
});

// --- Configuration updated by the user ---------------------------------------
gladys.onConfigUpdated(async (newConfig) => {
  logger.info('onConfigUpdated -> new configuration received');
  site.configure(normalizeConfig(newConfig));
  await start();
});

// --- Configuration screen actions ---------------------------------------------
for (const [actionKey, handler] of Object.entries(ACTIONS)) {
  gladys.onAction(actionKey, (fields) => handler(gladys, { fields, site }));
}

// --- Scene actions (Gladys 5.1+) ----------------------------------------------
// The scene triggers need no handler: src/alerts.js fires them.
for (const [actionKey, handler] of Object.entries(SCENE_ACTIONS)) {
  gladys.onSceneAction(actionKey, (fields) => handler(gladys, { fields, site }));
}

// --- Dashboard widgets (Gladys 5.1+) ------------------------------------------
// The site, savings and history widgets answer their period buttons
// (src/dashboard/period.js): the core refreshes the widget after the action.
for (const [widgetKey, widget] of Object.entries(WIDGETS)) {
  gladys.onWidgetGet(widgetKey, (request) => widget.get(gladys, { ...request, site }));
  if (typeof widget.action === 'function') {
    gladys.onWidgetAction(widgetKey, (actionKey, params, { settings, values }) =>
      widget.action(gladys, { actionKey, params, settings, values, site }),
    );
  }
}

// --- Connection lifecycle ----------------------------------------------------
gladys.on('connected', async () => {
  try {
    site.configure(normalizeConfig(await gladys.getConfig()));
    await start();
  } catch (err) {
    logger.error('Post-connection initialization failed', err);
  }
});

gladys.on('disconnected', () => {
  // Nothing can be published while disconnected: the next connection
  // restarts the reads.
  stop();
  store.save().catch(() => {});
});

// --- Graceful shutdown -------------------------------------------------------
// The production indexes must survive the restart (src/store.js).
gladys.handleShutdown(async (signal) => {
  logger.info(`Received ${signal} -> graceful shutdown`);
  stop();
  await store.save();
});

// --- Startup -----------------------------------------------------------------
logger.info('Starting the Beem Energy integration...');
gladys.connect().catch((err) => {
  logger.error('Initial connection failed', err);
  process.exit(1);
});
