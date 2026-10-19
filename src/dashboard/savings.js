// -----------------------------------------------------------------------------
// The `savings` widget: what the panels are worth (src/savings.js).
//
// Tiles: saved today, this month, this year and since the first month known,
// a gauge of the payback (savings over the installation cost, when given).
// Status rows: the price used for one solar kWh (and the off-peak share of
// the production in peak / off-peak), the self-consumed and exported shares,
// the payback date at the pace of the last 12 months, the CO2 avoided. The
// chart: the savings of each of the last 12 months.
//
// Content budget of the core: 1 heading (a title of its own only), 1 chart, 5 tiles, 1 status.
// -----------------------------------------------------------------------------

import { WIDGET_COLORS } from '@gladysassistant/integration-sdk';

import { allMonths, monthlySeries, powerSeries, siteFigures } from '../production.js';
import { buildTariff, measuredSolarProfile, paybackOf, valueOf } from '../savings.js';
import { minuteOfDay } from '../time.js';
import {
  T,
  UNKNOWN,
  NO_BOX,
  NOT_CONNECTED,
  fitRows,
  kwhText,
  messageContent,
  money,
  monthInstant,
  monthLabel,
  round,
  siteSelection,
  tile,
  headingOf,
  titleOf,
} from './common.js';

export const SAVINGS_WIDGET = 'savings';

const NO_TARIFF = T(
  'Enter your electricity price in the Configuration tab of the integration to estimate the savings.',
  "Renseignez votre prix de l'électricité dans l'onglet Configuration de l'intégration pour estimer les économies.",
);

const INVALID_TARIFF = T(
  'The tariff of the Configuration tab is incomplete: see the integration logs.',
  "Le tarif de l'onglet Configuration est incomplet : voir les logs de l'intégration.",
);

/**
 * The production profile measured over the last two days (peak / off-peak
 * weighting), null when too little was measured.
 */
export function measuredProfile(site, boxes, now, timeZone) {
  const samples = powerSeries(site.store, boxes, now - 48 * 60 * 60 * 1000).map(({ t, w }) => ({
    minute: minuteOfDay(t, timeZone),
    w,
  }));
  return measuredSolarProfile(samples);
}

/** `14 months` / `2 years 3 months` from now. */
function etaText(months) {
  if (months === null) {
    return T('Not enough history yet', "Pas encore assez d'historique");
  }
  if (months === 0) {
    return T('Reached', 'Atteint');
  }
  const total = Math.ceil(months);
  const years = Math.floor(total / 12);
  const rest = total % 12;
  const en = [years > 0 ? `${years} yr` : null, rest > 0 ? `${rest} mo` : null]
    .filter(Boolean)
    .join(' ');
  const fr = [
    years > 0 ? `${years} an${years > 1 ? 's' : ''}` : null,
    rest > 0 ? `${rest} mois` : null,
  ]
    .filter(Boolean)
    .join(' ');
  return T(`In ${en}`, `Dans ${fr}`);
}

/**
 * Content of the savings widget.
 * @param {object} site
 * @param {Array<object>} boxes snapshots
 * @param {{ now: number, config: object, title: string|object }} options
 */
export function savingsContent(site, boxes, { now, config, title }) {
  const timeZone = config.timezone;
  const { tariff, error } = buildTariff(config, {
    profile: measuredProfile(site, boxes, now, timeZone),
  });
  if (!tariff) {
    return messageContent(error ? INVALID_TARIFF : NO_TARIFF);
  }
  const figures = siteFigures(boxes, now, timeZone);
  const value = (kwh) => (kwh === null ? null : valueOf(kwh, tariff).total);
  const lifetime = valueOf(figures.lifetimeKwh ?? 0, tariff);
  const months = allMonths(boxes, now, timeZone);
  const payback = paybackOf({
    cost: config.installation_cost,
    lifetimeSavings: lifetime.total,
    months,
    tariff,
  });

  const components = headingOf(title);
  const series = monthlySeries(boxes, now, timeZone, 12).filter((month) => month.kwh !== null);
  if (series.length > 0) {
    components.push({
      type: 'chart',
      series: [
        {
          name: T('Savings', 'Économies'),
          points: series.map((month) => ({
            t: monthInstant(month.key),
            v: round(value(month.kwh), 2),
          })),
        },
      ],
      chart_type: 'bar',
      title: T('Savings per month', 'Économies par mois'),
      unit: '€',
    });
  }
  components.push(
    tile(round(value(figures.todayKwh), 2), '€', T('Today', "Aujourd'hui"), 'trending-up'),
    tile(round(value(figures.monthKwh), 2), '€', T('This month', 'Ce mois-ci'), 'calendar'),
    tile(round(value(figures.yearKwh), 0), '€', T('This year', 'Cette année'), 'bar-chart-2'),
    tile(round(lifetime.total, 0), '€', T('In total', 'Au total'), 'award'),
  );
  if (payback) {
    components.push({
      type: 'gauge',
      value: Math.round(payback.progress * 100),
      min: 0,
      max: 100,
      unit: '%',
      label: T('Paid back', 'Amorti'),
      color: payback.progress >= 1 ? WIDGET_COLORS.SUCCESS : WIDGET_COLORS.INFO,
    });
  }

  const rows = [
    {
      label: T('Value of 1 solar kWh', "Valeur d'un kWh solaire"),
      icon: 'tag',
      value:
        tariff.mode === 'peak_offpeak'
          ? T(
              `${round(tariff.valuePerKwh, 4)} € · ${Math.round(tariff.offpeakShare * 100)} % off-peak`,
              `${round(tariff.valuePerKwh, 4)} € · ${Math.round(tariff.offpeakShare * 100)} % en creuses`,
            )
          : `${round(tariff.valuePerKwh, 4)} €`,
      color: WIDGET_COLORS.NEUTRAL,
    },
    {
      label: T(
        `Self-consumed (${Math.round(tariff.selfRate * 100)} %)`,
        `Autoconsommé (${Math.round(tariff.selfRate * 100)} %)`,
      ),
      icon: 'home',
      value: `${kwhText(lifetime.selfKwh)} · ${money(lifetime.avoided)}`,
      color: WIDGET_COLORS.SUCCESS,
    },
  ];
  if (tariff.selfRate < 1) {
    rows.push({
      label: tariff.resaleEnabled
        ? T('Sold', 'Revendu')
        : T('Given to the grid', 'Injecté sans revente'),
      icon: 'upload',
      value: tariff.resaleEnabled
        ? `${kwhText(lifetime.exportedKwh)} · ${money(lifetime.resale)}`
        : kwhText(lifetime.exportedKwh),
      color: tariff.resaleEnabled ? WIDGET_COLORS.INFO : WIDGET_COLORS.NEUTRAL,
    });
  }
  if (payback) {
    rows.push({
      label: T('Payback', 'Retour sur investissement'),
      icon: 'clock',
      value: etaText(payback.etaMonths),
      color: payback.progress >= 1 ? WIDGET_COLORS.SUCCESS : WIDGET_COLORS.INFO,
    });
    rows.push({
      label: T('Left to pay back', 'Reste à amortir'),
      icon: 'credit-card',
      value: `${money(payback.remaining)} / ${money(config.installation_cost)}`,
      color: WIDGET_COLORS.NEUTRAL,
    });
  }
  if (config.co2_factor > 0) {
    const kg = ((figures.lifetimeKwh ?? 0) * config.co2_factor) / 1000;
    rows.push({
      label: T('CO2 avoided', 'CO2 évité'),
      icon: 'wind',
      value: kg >= 1000 ? `${round(kg / 1000, 2)} t` : `${round(kg, 1)} kg`,
      color: WIDGET_COLORS.SUCCESS,
    });
  }
  const first = months.find((month) => month.kwh > 0);
  rows.push({
    label: T('Since', 'Depuis'),
    icon: 'calendar',
    value: first ? monthLabel(first.key) : UNKNOWN,
    color: WIDGET_COLORS.NEUTRAL,
  });
  components.push({ type: 'status', items: fitRows(rows) });
  return { ttl_seconds: 300, components };
}

export const savingsWidget = {
  async get(_gladys, { settings = {}, site }) {
    const config = site.config();
    const all = site.snapshots();
    if (all.length === 0) {
      return messageContent(site.lastRefreshAt() === null ? NOT_CONNECTED : NO_BOX);
    }
    const { boxes } = siteSelection(all, { devices: settings.devices });
    return savingsContent(site, boxes.length > 0 ? boxes : all, {
      now: Date.now(),
      config,
      title: titleOf(settings, null),
    });
  },
};
