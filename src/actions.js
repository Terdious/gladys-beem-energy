// -----------------------------------------------------------------------------
// Configuration screen actions (manifest `actions`): what a user runs while
// setting the integration up, or before opening an issue.
//
//   - `test_connection`: log in to the Beem cloud and list the boxes found.
//   - `diagnostic`: per box, what the cloud reports right now (power, day,
//     month, signal, last report) and what the store keeps (index, months).
//   - `reload_history`: fetch the monthly history again (a box added to the
//     account after the first fetch, a history cut by a rate limit).
//
// Every message is bilingual and never shows the e-mail, the password or a
// token.
// -----------------------------------------------------------------------------

import { BeemApiError } from './beem/client.js';
import { STATUS_MESSAGES } from './site.js';
import { hasCredentials } from './config.js';
import { localTime } from './time.js';

const T = (en, fr) => ({ en, fr });

function errorMessage(err) {
  const message = err instanceof BeemApiError ? STATUS_MESSAGES[err.code] : null;
  return message ?? STATUS_MESSAGES.network;
}

const kwh = (wh) => (wh === null ? '—' : `${Math.round(wh / 10) / 100} kWh`);

export const ACTIONS = {
  async test_connection(_gladys, { site }) {
    const config = site.config();
    if (!hasCredentials(config)) {
      return STATUS_MESSAGES.missing_credentials;
    }
    try {
      await site.client().login();
    } catch (err) {
      return errorMessage(err);
    }
    if (!(await site.refresh({ forceTopology: true }))) {
      return STATUS_MESSAGES[site.lastError()] ?? STATUS_MESSAGES.network;
    }
    const boxes = site.snapshots();
    if (boxes.length === 0) {
      return STATUS_MESSAGES.no_box;
    }
    const names = boxes.map((box) => box.name).join(', ');
    return T(
      `Connected: ${boxes.length} box(es) found (${names}).`,
      `Connecté : ${boxes.length} box trouvée(s) (${names}).`,
    );
  },

  async diagnostic(_gladys, { site }) {
    const config = site.config();
    if (site.lastRefreshAt() === null && !(await site.refresh())) {
      return STATUS_MESSAGES[site.lastError()] ?? STATUS_MESSAGES.network;
    }
    const lines = { en: [], fr: [] };
    for (const box of site.snapshots()) {
      const { reading } = box;
      const months = Object.keys(box.history.months).length;
      const last =
        reading.lastProductionAt === null
          ? '—'
          : localTime(reading.lastProductionAt, config.timezone);
      const peak = box.peakPowerW > 0 ? `${box.peakPowerW} Wp` : '? Wp';
      const index = box.indexKwh === null ? '—' : `${Math.round(box.indexKwh * 100) / 100} kWh`;
      if (!reading.reported) {
        lines.en.push(`${box.name} (id ${box.id}, ${peak}): absent from the cloud summary.`);
        lines.fr.push(`${box.name} (id ${box.id}, ${peak}) : absente du relevé cloud.`);
        continue;
      }
      const signal = reading.dbm === null ? '—' : `${reading.dbm} dBm`;
      lines.en.push(
        `${box.name} (id ${box.id}, ${peak}): ${reading.powerW ?? '—'} W, today ${kwh(reading.todayWh)}, ` +
          `month ${kwh(reading.monthWh)}, ${signal}, last report ${last}${reading.asleep ? ' (asleep)' : ''}, ` +
          `index ${index}, ${months} month(s) of history.`,
      );
      lines.fr.push(
        `${box.name} (id ${box.id}, ${peak}) : ${reading.powerW ?? '—'} W, jour ${kwh(reading.todayWh)}, ` +
          `mois ${kwh(reading.monthWh)}, ${signal}, dernier relevé ${last}${reading.asleep ? ' (en veille)' : ''}, ` +
          `index ${index}, ${months} mois d'historique.`,
      );
    }
    if (lines.en.length === 0) {
      return STATUS_MESSAGES.no_box;
    }
    return { en: lines.en.join('\n'), fr: lines.fr.join('\n') };
  },

  async reload_history(_gladys, { site }) {
    if (!hasCredentials(site.config())) {
      return STATUS_MESSAGES.missing_credentials;
    }
    site.store.clearFetchedMonths();
    // One request every few seconds: longer than the action timeout for a
    // long history, so it runs in the background (the widgets follow).
    site.backfillHistory().catch(() => {});
    const months = site.config().history_months;
    return T(
      `History reload started: up to ${months} month(s), a few seconds each.`,
      `Rechargement de l'historique lancé : jusqu'à ${months} mois, quelques secondes chacun.`,
    );
  },
};
