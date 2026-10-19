// -----------------------------------------------------------------------------
// Dashboard widgets (Gladys 5.1+).
//
//   - `box`      (src/dashboard/box.js): one Beem box — live power, gauge of
//                the peak power, day / month / yield, signal, panels, alert.
//   - `site`     (src/dashboard/site.js): the whole installation,
//                single-phase or three-phase (boxes assigned to L1, L2, L3),
//                power curve of the day, phase balance, underperforming boxes.
//   - `savings`  (src/dashboard/savings.js): the savings estimate of the
//                tariff of the Configuration tab, payback and CO2 avoided.
//   - `history`  (src/dashboard/history.js): bars per day or per month,
//                records, year-over-year comparison, ranking of the boxes.
//
// The manifest allows at most 5 widgets and their keys are stored in the
// users' dashboards: the fifth slot is kept free on purpose.
//
// index.js registers `get` with onWidgetGet. The content budget of the core
// (8 components, 1 focal, 6 tiles, 1 status) decides what each widget shows.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';

import { BOX_WIDGET, boxWidget } from './dashboard/box.js';
import { HISTORY_WIDGET, historyWidget } from './dashboard/history.js';
import { SAVINGS_WIDGET, savingsWidget } from './dashboard/savings.js';
import { SITE_WIDGET, siteWidget } from './dashboard/site.js';

const logger = createLogger({ name: 'widgets' });

export const WIDGETS = {
  [BOX_WIDGET]: boxWidget,
  [SITE_WIDGET]: siteWidget,
  [SAVINGS_WIDGET]: savingsWidget,
  [HISTORY_WIDGET]: historyWidget,
};

/**
 * Nudge the open dashboards after a refresh of the cloud: the computed
 * figures changed. Fire-and-forget, rate-limited core-side (1 per 10 s per
 * widget), dropped while disconnected.
 */
export function refreshWidgets(gladys) {
  for (const key of Object.keys(WIDGETS)) {
    try {
      gladys.requestWidgetRefresh(key);
    } catch (err) {
      logger.debug(`Widget ${key} not nudged (${err.message})`);
    }
  }
}
