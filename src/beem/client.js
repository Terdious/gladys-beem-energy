// -----------------------------------------------------------------------------
// Beem Energy cloud client (REST).
//
// Beem publishes no official API: these are the endpoints of the Beem mobile
// application, as documented by the community (the Home Assistant integration
// CharlesP44/Beem_Energy, MIT License). Only the facts are reused (base URL,
// paths, field names); the code is our own.
//
//   POST /user/login            { email, password } -> { accessToken, userId }
//   GET  /devices               -> { beemboxes: [...], batteries: [...], energySwitches: [...] }
//   POST /box/summary           { month, year } -> [{ boxId, wattHour, totalDay, totalMonth,
//                                                    lastDbm, lastProduction }]
//   GET  /production/energy/intraday?from&to&scale=PT60M
//                               -> { devices: [{ ..., measures: [{ startDate, value }] }] }
//                                  (Wh per hour, the history the Beem application charts)
//
// Rate limit: the Beem API answers 429 to bursts of logins and then refuses
// every login for a while. The client therefore keeps its access token (about
// one hour), logs in again only on expiry or on a 401, and after a 429 stops
// calling the API for LOCK_AFTER_429_MS instead of hammering it.
//
// The password and the tokens are never logged.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';

const logger = createLogger({ name: 'beem-api' });

export const BEEM_API_URL = 'https://api-x.beem.energy/beemapp';

// The access token lives about one hour: renewed a little before.
export const TOKEN_LIFETIME_MS = 55 * 60 * 1000;
// After a 429, the Beem API keeps refusing for several minutes.
export const LOCK_AFTER_429_MS = 20 * 60 * 1000;
export const REQUEST_TIMEOUT_MS = 20 * 1000;
// The hourly production of a week is a slow answer for the Beem cloud.
export const INTRADAY_TIMEOUT_MS = 60 * 1000;

/** Error of the Beem API, with a stable `code` the callers branch on. */
export class BeemApiError extends Error {
  /**
   * @param {'auth'|'rate_limited'|'unavailable'|'network'|'invalid_response'|'missing_credentials'} code
   * @param {string} message
   * @param {{ status?: number, retryAt?: number }} [details]
   */
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'BeemApiError';
    this.code = code;
    this.status = details.status;
    this.retryAt = details.retryAt;
  }
}

/**
 * Create a Beem client for one account.
 * @param {{ email: string, password: string, fetchImpl?: typeof fetch, now?: () => number, baseUrl?: string }} options
 */
export function createBeemClient({
  email,
  password,
  fetchImpl = globalThis.fetch,
  now = Date.now,
  baseUrl = BEEM_API_URL,
}) {
  let token = null;
  let tokenExpiresAt = 0;
  let userId = null;
  let lockedUntil = 0;
  let loginInFlight = null;

  function assertNotLocked() {
    if (now() < lockedUntil) {
      const minutes = Math.ceil((lockedUntil - now()) / 60000);
      throw new BeemApiError(
        'rate_limited',
        `Beem API rate limit: next attempt in about ${minutes} min`,
        { retryAt: lockedUntil },
      );
    }
  }

  async function send(method, path, { body, auth = true, timeout = REQUEST_TIMEOUT_MS } = {}) {
    assertNotLocked();
    const headers = { Accept: 'application/json' };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json; charset=UTF-8';
    }
    if (auth) {
      headers.Authorization = `Bearer ${token}`;
    }
    let response;
    try {
      response = await fetchImpl(`${baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeout),
      });
    } catch (err) {
      throw new BeemApiError('network', `Beem API unreachable (${err.name ?? 'error'})`);
    }
    if (response.status === 429) {
      lockedUntil = now() + LOCK_AFTER_429_MS;
      throw new BeemApiError('rate_limited', 'Beem API rate limit (429)', {
        status: 429,
        retryAt: lockedUntil,
      });
    }
    if (response.status === 401 || response.status === 403) {
      throw new BeemApiError('auth', `Beem API refused the credentials (${response.status})`, {
        status: response.status,
      });
    }
    if (response.status >= 500) {
      throw new BeemApiError('unavailable', `Beem API unavailable (${response.status})`, {
        status: response.status,
      });
    }
    if (response.status < 200 || response.status >= 300) {
      throw new BeemApiError('invalid_response', `Beem API answered ${response.status}`, {
        status: response.status,
      });
    }
    const text = await response.text();
    if (text.trim() === '') {
      return null;
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new BeemApiError('invalid_response', 'Beem API answered something else than JSON');
    }
  }

  async function login() {
    if (!email || !password) {
      throw new BeemApiError('missing_credentials', 'Beem e-mail or password missing');
    }
    const data = await send('POST', '/user/login', { body: { email, password }, auth: false });
    if (!data?.accessToken) {
      throw new BeemApiError('invalid_response', 'Beem login answered without an access token');
    }
    token = data.accessToken;
    userId = data.userId === undefined || data.userId === null ? null : String(data.userId);
    tokenExpiresAt = now() + TOKEN_LIFETIME_MS;
    logger.info('Logged in to the Beem cloud');
  }

  async function ensureToken() {
    if (token && now() < tokenExpiresAt) {
      return;
    }
    // Concurrent callers (poll + widget action) share one login.
    if (!loginInFlight) {
      loginInFlight = login().finally(() => {
        loginInFlight = null;
      });
    }
    await loginInFlight;
  }

  /** Authenticated request, logging in again once on an expired token. */
  async function request(method, path, body, { timeout } = {}) {
    await ensureToken();
    try {
      return await send(method, path, { body, timeout });
    } catch (err) {
      if (err instanceof BeemApiError && err.code === 'auth') {
        token = null;
        await ensureToken();
        return send(method, path, { body, timeout });
      }
      throw err;
    }
  }

  return {
    /** Log in now (even with a valid token): the "test the connection" action. */
    async login() {
      token = null;
      await ensureToken();
      return { userId };
    },

    /** The account topology: { beemboxes, batteries, energySwitches }. */
    async getDevices() {
      const data = await request('GET', '/devices');
      return data && typeof data === 'object' ? data : {};
    },

    /**
     * Production summary of every box for a calendar month.
     * @param {{ month: number, year: number }} period month 1-12
     * @returns {Promise<Array<object>>}
     */
    async getBoxSummary({ month, year }) {
      const data = await request('POST', '/box/summary', { month, year });
      return Array.isArray(data) ? data : [];
    },

    /**
     * Hourly production of the account's devices over [from, to).
     * @param {{ from: string, to: string, scale?: string }} range ISO instants
     * @returns {Promise<object>}
     */
    async getProductionIntraday({ from, to, scale = 'PT60M' }) {
      const query = new URLSearchParams({ from, to, scale });
      const data = await request('GET', `/production/energy/intraday?${query}`, undefined, {
        timeout: INTRADAY_TIMEOUT_MS,
      });
      return data && typeof data === 'object' ? data : {};
    },

    /** Forget the token and the 429 lock (credentials changed). */
    reset() {
      token = null;
      tokenExpiresAt = 0;
      lockedUntil = 0;
    },

    /** Instant (ms) until which the client refuses to call the API, 0 when not locked. */
    lockedUntil() {
      return lockedUntil > now() ? lockedUntil : 0;
    },
  };
}
