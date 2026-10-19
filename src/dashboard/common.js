// -----------------------------------------------------------------------------
// Helpers shared by the dashboard widgets (src/widgets.js): bilingual texts,
// number formats, the status row bounds of the core and the phase assignment
// of the site widgets.
// -----------------------------------------------------------------------------

import { WIDGET_COLORS } from '@gladysassistant/integration-sdk';

import { dayKey } from '../time.js';

export const T = (en, fr) => ({ en, fr });

export const UNKNOWN = '—';

// Rows of a status component the core keeps (the SDK's MAX_STATUS_ITEMS).
export const MAX_STATUS_ROWS = 10;
// Bound of a status row label and value (characters).
const MAX_STATUS_TEXT = 40;

/** A number rounded to `digits` decimals, null kept. */
export const round = (value, digits = 0) =>
  value === null || value === undefined || !Number.isFinite(value)
    ? null
    : Math.round(value * 10 ** digits) / 10 ** digits;

/** kWh with a precision that fits a tile: 0.85 · 12.3 · 1234. */
export function kwhValue(value) {
  if (value === null || value === undefined) {
    return null;
  }
  return round(value, value < 10 ? 2 : value < 1000 ? 1 : 0);
}

/** `12.3 kWh`, or the unknown mark. */
export const kwhText = (value) => (value === null ? UNKNOWN : `${kwhValue(value)} kWh`);

/** `1.23 €`. */
export const money = (value) =>
  value === null ? UNKNOWN : `${(round(value, 2) ?? 0).toFixed(2)} €`;

/** Text-only content, when the widget cannot show anything else. */
export function messageContent(text) {
  return { ttl_seconds: 60, components: [{ type: 'text', variant: 'body', text }] };
}

/** A tile. */
export const tile = (value, unit, label, icon, color) => ({
  type: 'value',
  value: value ?? UNKNOWN,
  ...(unit ? { unit } : {}),
  label,
  icon,
  ...(color ? { color } : {}),
});

export const NO_BOX = T(
  'No Beem box found: check the Configuration tab of the integration.',
  "Aucune box Beem trouvée : vérifiez l'onglet Configuration de l'intégration.",
);

export const NOT_CONNECTED = T(
  'Not connected to the Beem cloud yet: see the Configuration tab.',
  "Pas encore connecté au cloud Beem : voir l'onglet Configuration.",
);

/** A text cut to a status bound, with an ellipsis. */
export function clip(text, max = MAX_STATUS_TEXT) {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * Status rows within the core's MAX_STATUS_ROWS: past it, the last row tells
 * how many are not shown instead of letting the core drop them silently.
 */
export function fitRows(rows) {
  if (rows.length <= MAX_STATUS_ROWS) {
    return rows;
  }
  const hidden = rows.length - (MAX_STATUS_ROWS - 1);
  return [
    ...rows.slice(0, MAX_STATUS_ROWS - 1),
    {
      label: T(`+${hidden} more`, `+${hidden} autres`),
      icon: 'more-horizontal',
      value: T('not shown', 'non affichées'),
      color: WIDGET_COLORS.NEUTRAL,
    },
  ];
}

/** The widget title setting, or a default. */
export const titleOf = (settings, fallback) =>
  (typeof settings?.title === 'string' && settings.title.trim()) || fallback;

/**
 * The heading of a content: none without a title, the card already shows
 * the widget label above the content (a default heading only repeated it).
 */
export const headingOf = (title) =>
  title ? [{ type: 'text', variant: 'heading', text: title }] : [];

// --- Site layout: single-phase or three-phase ---------------------------------

export const LAYOUTS = { SINGLE_PHASE: 'single_phase', THREE_PHASE: 'three_phase' };
// Setting key -> phase label. The keys are stored in the users' dashboards.
export const PHASE_SETTINGS = [
  { key: 'phase_l1', label: 'L1' },
  { key: 'phase_l2', label: 'L2' },
  { key: 'phase_l3', label: 'L3' },
];

const asList = (value) =>
  Array.isArray(value)
    ? value.filter((id) => typeof id === 'string')
    : typeof value === 'string' && value !== ''
      ? [value]
      : [];

/**
 * The boxes a site widget covers, from its settings. Single-phase: the
 * `devices` selected (none: every box). Three-phase: the boxes of
 * `phase_l1`, `phase_l2` and `phase_l3`; a box picked twice counts in its
 * first phase only (`duplicates`), a box picked nowhere is left out
 * (`unassigned`), a picked device that no longer exists is counted in
 * `missing`.
 * @param {Array<object>} all every box snapshot
 * @param {object} settings widget instance settings
 */
export function siteSelection(all, settings = {}) {
  const byId = new Map(all.map((box) => [box.externalId, box]));
  let missing = 0;
  if (settings.layout !== LAYOUTS.THREE_PHASE) {
    const ids = [...new Set(asList(settings.devices))];
    const found = ids.map((id) => byId.get(id)).filter(Boolean);
    missing = ids.length - found.length;
    return {
      layout: LAYOUTS.SINGLE_PHASE,
      boxes: ids.length === 0 ? all : found,
      phases: [],
      missing,
      duplicates: [],
      unassigned: [],
    };
  }
  const seen = new Set();
  const duplicates = new Map();
  const phases = PHASE_SETTINGS.map(({ key, label }) => {
    const boxes = [];
    for (const id of asList(settings[key])) {
      const box = byId.get(id);
      if (!box) {
        missing += 1;
      } else if (seen.has(id)) {
        duplicates.set(id, box);
      } else {
        seen.add(id);
        boxes.push(box);
      }
    }
    return { label, boxes };
  });
  return {
    layout: LAYOUTS.THREE_PHASE,
    boxes: phases.flatMap((phase) => phase.boxes),
    phases,
    missing,
    duplicates: [...duplicates.values()],
    unassigned: all.filter((box) => !seen.has(box.externalId)),
  };
}

export const ASSIGN_PHASES = T(
  'Assign the boxes of each phase (L1, L2, L3) in the settings of this widget.',
  'Attribuez les box de chaque phase (L1, L2, L3) dans les réglages de ce widget.',
);

/** The names of some boxes in one status value: `2: A, B`. */
export function namesOf(boxes) {
  return clip(`${boxes.length}: ${boxes.map((box) => box.name).join(', ')}`);
}

/** Alert rows about the selection itself (phase assignment, devices gone). */
export function selectionAlerts(selection) {
  const rows = [];
  if (selection.missing > 0) {
    const n = selection.missing;
    rows.push({
      label: T('Not found', 'Introuvables'),
      icon: 'alert-triangle',
      value: T(`${n} selected device(s)`, `${n} appareil(s) choisi(s)`),
      color: WIDGET_COLORS.WARNING,
    });
  }
  if (selection.duplicates.length > 0) {
    rows.push({
      label: T('In several phases', 'Dans plusieurs phases'),
      icon: 'copy',
      value: namesOf(selection.duplicates),
      color: WIDGET_COLORS.WARNING,
    });
  }
  if (selection.unassigned.length > 0) {
    rows.push({
      label: T('In no phase', 'Dans aucune phase'),
      icon: 'help-circle',
      value: namesOf(selection.unassigned),
      color: WIDGET_COLORS.INFO,
    });
  }
  return rows;
}

const MONTHS = {
  en: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
  fr: [
    'janv.',
    'févr.',
    'mars',
    'avr.',
    'mai',
    'juin',
    'juil.',
    'août',
    'sept.',
    'oct.',
    'nov.',
    'déc.',
  ],
};

/** `Oct 2026` / `oct. 2026` of a `YYYY-MM` key. */
export function monthLabel(key) {
  const [year, month] = key.split('-').map(Number);
  return T(`${MONTHS.en[month - 1]} ${year}`, `${MONTHS.fr[month - 1]} ${year}`);
}

/** `19/10` of a `YYYY-MM-DD` key. */
export const dayLabel = (key) => `${key.slice(8, 10)}/${key.slice(5, 7)}`;

/**
 * Midday UTC of a local date, for the inline chart points: the core places
 * a bar on its day whatever the viewer's timezone.
 */
export const dayInstant = (key) => `${key}T12:00:00.000Z`;
export const monthInstant = (key) => `${key}-15T12:00:00.000Z`;

/**
 * The first 5-minute bucket of the local day (the samples of the day start
 * there), DST-aware.
 */
export function startOfToday(now, timeZone) {
  const today = dayKey(now, timeZone);
  const step = 5 * 60 * 1000;
  let from = Math.floor((now - 24 * 60 * 60 * 1000) / step) * step;
  while (dayKey(from, timeZone) !== today) {
    from += step;
  }
  return from;
}
