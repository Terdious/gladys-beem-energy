// -----------------------------------------------------------------------------
// In-memory Beem cloud: a `fetch` replacement serving the endpoints the
// client calls, so the tests never touch the network.
//
//   const beem = createFakeBeem({ boxes: [...], summaries: { '2026-10': [...] } });
//   createBeemClient({ email, password, fetchImpl: beem.fetch });
//
// `beem.calls` records every request; `beem.failNext(status)` makes the next
// request answer that status.
// -----------------------------------------------------------------------------

export const EMAIL = 'owner@example.com';
export const PASSWORD = 'secret-password';

/** A raw box of /devices, as the Beem application returns it. */
export function rawBox({ id, name, panels = 3, panelPower = 300 }) {
  return {
    id,
    houseId: 1,
    name,
    serialNumber: `BB${id}`,
    power: panels * panelPower,
    createdAt: '2025-03-01T10:00:00.000Z',
    solarEquipments: Array.from({ length: panels }, (_, i) => ({
      id: id * 10 + i,
      type: 'panel',
      boxId: id,
      orientation: 180,
      tilt: 30,
      peakPower: panelPower,
    })),
  };
}

/** A /box/summary entry. */
export function summary({ boxId, power = 0, day = 0, month = 0, dbm = -60, at }) {
  return {
    boxId,
    wattHour: power,
    totalDay: day,
    totalMonth: month,
    lastDbm: dbm,
    lastProduction: new Date(at).toISOString(),
  };
}

/**
 * The installation of the issue: three phases, on each a BeemBox of three
 * 300 W kits and a Beem On of two 500 W kits.
 */
export function threePhaseBoxes() {
  return [
    rawBox({ id: 101, name: 'BeemBox L1', panels: 3, panelPower: 300 }),
    rawBox({ id: 102, name: 'BeemBox L2', panels: 3, panelPower: 300 }),
    rawBox({ id: 103, name: 'BeemBox L3', panels: 3, panelPower: 300 }),
    rawBox({ id: 201, name: 'Beem On L1', panels: 2, panelPower: 500 }),
    rawBox({ id: 202, name: 'Beem On L2', panels: 2, panelPower: 500 }),
    rawBox({ id: 203, name: 'Beem On L3', panels: 2, panelPower: 500 }),
  ];
}

/**
 * An intraday payload: `whPerHour` Wh every hour from 08:00 to 17:00 UTC of
 * each day of [from, to), for each box id.
 */
export function intraday(ids, whPerHour = 100) {
  return ({ from, to }) => ({
    devices: ids.map((id) => {
      const measures = [];
      for (let at = Date.parse(from); at < Date.parse(to); at += 3_600_000) {
        const hour = new Date(at).getUTCHours();
        if (hour >= 8 && hour < 18) {
          measures.push({ startDate: new Date(at).toISOString(), value: whPerHour });
        }
      }
      return { deviceId: id, type: 'beembox', measures };
    }),
  });
}

export function createFakeBeem({
  boxes = [],
  summaries = {},
  token = 'token-1',
  intraday = null,
} = {}) {
  const state = { boxes, summaries, token, tokens: 0, intraday };
  const calls = [];
  const failures = [];

  const json = (status, body) =>
    new Response(body === undefined ? '' : JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });

  async function fetchImpl(url, init = {}) {
    const parsed = new URL(url);
    const path = parsed.pathname.replace(/^\/beemapp/, '');
    const query = Object.fromEntries(parsed.searchParams);
    const body = init.body ? JSON.parse(init.body) : undefined;
    const authorization = init.headers?.Authorization ?? null;
    calls.push({ method: init.method ?? 'GET', path, query, body, authorization });
    if (failures.length > 0) {
      const failure = failures.shift();
      if (failure === 'network') {
        throw new TypeError('fetch failed');
      }
      return json(failure, { message: 'failure' });
    }
    if (path === '/user/login') {
      if (body?.email !== EMAIL || body?.password !== PASSWORD) {
        return json(401, { message: 'Unauthorized' });
      }
      state.tokens += 1;
      return json(201, { accessToken: state.token, userId: 42 });
    }
    if (authorization !== `Bearer ${state.token}`) {
      return json(401, { message: 'Unauthorized' });
    }
    if (path === '/devices') {
      return json(200, { beemboxes: state.boxes, batteries: [], energySwitches: [] });
    }
    if (path === '/box/summary') {
      const key = `${body.year}-${String(body.month).padStart(2, '0')}`;
      return json(201, state.summaries[key] ?? []);
    }
    if (path === '/production/energy/intraday' && state.intraday) {
      return json(200, state.intraday(query));
    }
    return json(404, { message: 'Not found' });
  }

  return {
    fetch: fetchImpl,
    calls,
    state,
    failNext(status) {
      failures.push(status);
    },
    /** Calls to one path. */
    callsTo(path) {
      return calls.filter((call) => call.path === path);
    },
  };
}
