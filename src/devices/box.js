// -----------------------------------------------------------------------------
// Device type: BEEM BOX (one solar kit micro-inverter).
//
// One Gladys device per box of the account, keyed on its Beem cloud id (the
// `id` of /devices, the `boxId` of /box/summary): a name or a serial could
// change or be missing, the cloud id never does.
//
// Features (their keys are forever: Gladys keys the history on them):
//   - power   current production (W)
//   - energy  lifetime production INDEX (kWh): the feature Gladys' energy
//             monitoring turns into thirty-minute production (src/store.js)
//   - today   production of the day so far (kWh), reset by the cloud at
//             local midnight
//   - wifi    Wi-Fi signal quality (%), from the dBm level of the box
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES,
  DEVICE_FEATURE_TYPES,
  DEVICE_FEATURE_UNITS,
} from '@gladysassistant/integration-sdk';

import { signalQuality } from '../beem/boxes.js';

export const DEVICE_TYPE = 'box';

export const FEATURE = {
  POWER: 'power',
  ENERGY: 'energy',
  TODAY: 'today',
  WIFI: 'wifi',
};

// Upper bound of the production index: far above what kits ever produce.
const ENERGY_INDEX_MAX_KWH = 1_000_000;
// Without a known peak power, the power range of the biggest Beem box.
const DEFAULT_MAX_POWER_W = 2000;

const FEATURE_NAMES = {
  en: {
    [FEATURE.POWER]: 'Solar power',
    [FEATURE.ENERGY]: 'Solar production (index)',
    [FEATURE.TODAY]: 'Production today',
    [FEATURE.WIFI]: 'Wi-Fi signal',
  },
  fr: {
    [FEATURE.POWER]: 'Puissance solaire',
    [FEATURE.ENERGY]: 'Production solaire (index)',
    [FEATURE.TODAY]: "Production aujourd'hui",
    [FEATURE.WIFI]: 'Signal Wi-Fi',
  },
};

/** External ids of a box. */
export const boxIds = (gladys, boxId) => gladys.externalIds(DEVICE_TYPE, boxId);

/** The box id of a device external id, null when it is not a box. */
export function boxIdOfDevice(gladys, externalId) {
  const prefix = gladys.externalIds(DEVICE_TYPE, '').device;
  return typeof externalId === 'string' && externalId.startsWith(prefix)
    ? externalId.slice(prefix.length) || null
    : null;
}

/**
 * Discovery payload of a box.
 * @param {object} gladys SDK instance
 * @param {ReturnType<typeof import('../beem/boxes.js').describeBox>} box
 * @param {object} config normalized config
 */
export function buildBoxDevice(gladys, box, config) {
  const ids = boxIds(gladys, box.id);
  const names = FEATURE_NAMES[config.feature_names] ?? FEATURE_NAMES.en;
  const maxPower =
    box.peakPowerW > 0 ? Math.ceil((box.peakPowerW * 1.25) / 50) * 50 : DEFAULT_MAX_POWER_W;
  const params = [{ name: 'BEEM_BOX_ID', value: box.id }];
  if (box.serialNumber) {
    params.push({ name: 'BEEM_SERIAL_NUMBER', value: box.serialNumber });
  }
  if (box.peakPowerW > 0) {
    params.push({ name: 'BEEM_PEAK_POWER_W', value: String(box.peakPowerW) });
  }
  return {
    name: box.name,
    external_id: ids.device,
    model: 'Beem box',
    params,
    features: [
      {
        name: names[FEATURE.POWER],
        external_id: ids.feature(FEATURE.POWER),
        category: DEVICE_FEATURE_CATEGORIES.ENERGY_PRODUCTION_SENSOR,
        type: DEVICE_FEATURE_TYPES.ENERGY_PRODUCTION_SENSOR.POWER,
        unit: DEVICE_FEATURE_UNITS.WATT,
        min: 0,
        max: maxPower,
        read_only: true,
        has_feedback: false,
        keep_history: true,
      },
      {
        name: names[FEATURE.ENERGY],
        external_id: ids.feature(FEATURE.ENERGY),
        category: DEVICE_FEATURE_CATEGORIES.ENERGY_PRODUCTION_SENSOR,
        type: DEVICE_FEATURE_TYPES.ENERGY_PRODUCTION_SENSOR.INDEX,
        unit: DEVICE_FEATURE_UNITS.KILOWATT_HOUR,
        min: 0,
        max: ENERGY_INDEX_MAX_KWH,
        read_only: true,
        has_feedback: false,
        keep_history: true,
      },
      {
        name: names[FEATURE.TODAY],
        external_id: ids.feature(FEATURE.TODAY),
        category: DEVICE_FEATURE_CATEGORIES.ENERGY_PRODUCTION_SENSOR,
        type: DEVICE_FEATURE_TYPES.ENERGY_PRODUCTION_SENSOR.DAILY_PRODUCTION,
        unit: DEVICE_FEATURE_UNITS.KILOWATT_HOUR,
        min: 0,
        max: 100,
        read_only: true,
        has_feedback: false,
        keep_history: true,
      },
      {
        name: names[FEATURE.WIFI],
        external_id: ids.feature(FEATURE.WIFI),
        category: DEVICE_FEATURE_CATEGORIES.SIGNAL,
        type: DEVICE_FEATURE_TYPES.SIGNAL.QUALITY,
        unit: DEVICE_FEATURE_UNITS.PERCENT,
        min: 0,
        max: 100,
        read_only: true,
        has_feedback: false,
        keep_history: true,
      },
    ],
  };
}

const round = (value, digits) => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

/**
 * The states of a box to publish: only the values known (a box the summary
 * does not list keeps its last states).
 * @param {object} gladys SDK instance
 * @param {string} boxId
 * @param {ReturnType<typeof import('../beem/boxes.js').readSummary>} reading
 * @param {number|null} indexKwh lifetime index of the store
 */
export function boxStates(gladys, boxId, reading, indexKwh) {
  const ids = boxIds(gladys, boxId);
  const states = [];
  const push = (feature, value) => {
    if (value !== null && value !== undefined && Number.isFinite(value)) {
      states.push({ device_feature_external_id: ids.feature(feature), state: value });
    }
  };
  push(FEATURE.POWER, reading.powerW);
  push(FEATURE.ENERGY, indexKwh === null ? null : round(indexKwh, 3));
  push(FEATURE.TODAY, reading.todayWh === null ? null : round(reading.todayWh / 1000, 3));
  push(FEATURE.WIFI, signalQuality(reading.dbm));
  return states;
}
