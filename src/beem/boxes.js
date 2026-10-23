// -----------------------------------------------------------------------------
// BeemBox normalization: the raw `/devices` and `/box/summary` payloads into
// one plain snapshot per box, the only shape the rest of the code reads.
//
// A "box" is the plug-and-play micro-inverter of a Beem kit (BeemBox for the
// 300 W kits, Beem On for the 500 W ones): it carries one or more panels and
// reports, through the cloud, its current power, the energy of the day and of
// the month, its Wi-Fi signal and the date of its last production report.
//
// Field names are those of the Beem application; a few aliases are accepted
// because the payloads evolved between application releases.
// -----------------------------------------------------------------------------

// A box powered by its panels goes to sleep at dusk: its last reported power
// stays in the summary all night. Past this age, the power is read as 0.
export const STALE_PRODUCTION_MS = 15 * 60 * 1000;

const toNumber = (value) => {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

const firstNumber = (object, keys) => {
  for (const key of keys) {
    const value = toNumber(object?.[key]);
    if (value !== null) {
      return value;
    }
  }
  return null;
};

const toTimestamp = (value) => {
  if (value === null || value === undefined || value === '') {
    return null;
  }
  const time = typeof value === 'number' ? value : Date.parse(String(value));
  return Number.isFinite(time) ? time : null;
};

/** The cloud id of a box, as a string ('' when absent). */
export function boxIdOf(raw) {
  const id = raw?.id ?? raw?.boxId;
  return id === undefined || id === null ? '' : String(id).trim();
}

/**
 * The boxes of a `/devices` payload: the top-level `beemboxes`, plus the ones
 * listed under a battery (a Beem Battery installation), each id once.
 * @param {object} devicesPayload
 * @returns {Array<object>} raw boxes
 */
export function rawBoxesOf(devicesPayload) {
  const seen = new Set();
  const boxes = [];
  const add = (box) => {
    const id = boxIdOf(box);
    if (id !== '' && !seen.has(id)) {
      seen.add(id);
      boxes.push(box);
    }
  };
  for (const box of devicesPayload?.beemboxes ?? []) {
    add(box);
  }
  for (const battery of devicesPayload?.batteries ?? []) {
    for (const box of battery?.beemboxes ?? []) {
      add(box);
    }
  }
  return boxes;
}

/**
 * Static description of a box: name, serial, panels and peak power.
 * @param {object} raw one entry of `beemboxes`
 */
export function describeBox(raw) {
  const id = boxIdOf(raw);
  const equipments = Array.isArray(raw.solarEquipments) ? raw.solarEquipments : [];
  const panels = equipments.map((equipment) => ({
    peakPowerW: firstNumber(equipment, ['peakPower']),
    orientation: firstNumber(equipment, ['orientation']),
    tilt: firstNumber(equipment, ['tilt']),
    count:
      (firstNumber(equipment, ['solarPanelsInSeries']) ?? 1) *
      (firstNumber(equipment, ['solarPanelsInParallel']) ?? 1),
  }));
  const panelsPeak = panels.reduce((total, panel) => total + (panel.peakPowerW ?? 0), 0);
  // The box `power` is its nominal power; the panels give the peak power
  // installed behind it. The panels win: they are what the kit produces.
  const peakPowerW = panelsPeak > 0 ? panelsPeak : firstNumber(raw, ['power', 'peakPower']);
  const name = typeof raw.name === 'string' && raw.name.trim() !== '' ? raw.name.trim() : null;
  return {
    id,
    name: name ?? `Beem box ${id}`,
    serialNumber: typeof raw.serialNumber === 'string' ? raw.serialNumber.trim() : null,
    peakPowerW,
    panels,
    createdAt: toTimestamp(raw.createdAt),
  };
}

/**
 * Live readings of a box from its `/box/summary` entry.
 * @param {object|undefined} summary
 * @param {number} now timestamp (ms)
 */
export function readSummary(summary, now) {
  if (!summary) {
    return {
      reported: false,
      powerW: null,
      todayWh: null,
      monthWh: null,
      dbm: null,
      lastProductionAt: null,
      asleep: null,
    };
  }
  const lastProductionAt = toTimestamp(summary.lastProduction ?? summary.lastProductionDate);
  // The Beem application names the current power `wattHour`.
  const reportedPower = firstNumber(summary, ['wattHour', 'power', 'currentPower']);
  const asleep = lastProductionAt !== null && now - lastProductionAt > STALE_PRODUCTION_MS;
  return {
    reported: true,
    powerW: asleep ? 0 : reportedPower === null ? null : Math.max(0, Math.round(reportedPower)),
    todayWh: firstNumber(summary, ['totalDay', 'dayProduction']),
    monthWh: firstNumber(summary, ['totalMonth', 'monthProduction']),
    dbm: firstNumber(summary, ['lastDbm', 'dbm', 'rssi']),
    lastProductionAt,
    asleep,
  };
}

/** Index the summary entries by box id. */
export function summariesById(summaries) {
  const byId = new Map();
  for (const entry of summaries ?? []) {
    const id = boxIdOf(entry);
    if (id !== '') {
      byId.set(id, entry);
    }
  }
  return byId;
}

/**
 * Wi-Fi signal quality (0-100 %) from a dBm level: -100 dBm and below is 0 %,
 * -50 dBm and above is 100 %, linear in between (the usual Wi-Fi scale).
 * @param {number|null} dbm
 * @returns {number|null}
 */
export function signalQuality(dbm) {
  if (dbm === null || dbm === undefined || !Number.isFinite(dbm)) {
    return null;
  }
  return Math.max(0, Math.min(100, Math.round(2 * (dbm + 100))));
}

/**
 * Daily production of the boxes from a `/production/energy/intraday`
 * payload (hourly Wh per device), summed per local day of `timeZone`.
 *
 * The devices are matched to the boxes by cloud id (`boxId`, `deviceId`,
 * `id`) or serial number; a device matching no box (a battery, a house
 * total) is reported in `unmatched` by its keys only, so the diagnostic can
 * show the format without any value.
 * @param {object} payload
 * @param {Array<{ id: string, serialNumber: string|null }>} boxes
 * @param {(at: number) => string} dayOf instant -> `YYYY-MM-DD`
 * @returns {{ days: Map<string, Map<string, number>>, unmatched: Array<string> }}
 */
export function intradayDays(payload, boxes, dayOf) {
  const list = Array.isArray(payload)
    ? payload
    : (payload?.devices ?? payload?.beemboxes ?? payload?.houses ?? []);
  const byId = new Map(boxes.map((box) => [box.id, box.id]));
  for (const box of boxes) {
    if (box.serialNumber) {
      byId.set(box.serialNumber.toUpperCase(), box.id);
    }
  }
  const days = new Map();
  const unmatched = [];
  for (const device of Array.isArray(list) ? list : []) {
    const candidates = [
      device?.boxId,
      device?.deviceId,
      device?.beemboxId,
      device?.id,
      device?.serialNumber,
    ]
      .filter((value) => value !== undefined && value !== null)
      .map((value) => String(value).trim().toUpperCase());
    const id = candidates.map((candidate) => byId.get(candidate)).find(Boolean);
    if (!id) {
      unmatched.push(
        Object.keys(device ?? {})
          .sort()
          .join(','),
      );
      continue;
    }
    const totals = days.get(id) ?? new Map();
    for (const measure of device.measures ?? device.data ?? []) {
      const at = toTimestamp(measure?.startDate ?? measure?.date ?? measure?.start);
      const wh = firstNumber(measure, ['value', 'energy', 'wh']);
      if (at === null || wh === null || wh < 0) {
        continue;
      }
      const key = dayOf(at);
      totals.set(key, (totals.get(key) ?? 0) + wh);
    }
    days.set(id, totals);
  }
  return { days, unmatched };
}
