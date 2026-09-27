import config from '../config.js';
import logger from '../logger.js';

/**
 * Proxy-Cheap management API client.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS AND IS NOT
 * ---------------------------------------------------------------------------
 * Two completely different sets of credentials are involved in using this
 * provider, and conflating them is the first mistake available:
 *
 *   1. `PROXYCHEAP_API_KEY` / `PROXYCHEAP_API_SECRET` — authenticate to
 *      `api.proxy-cheap.com`. They read the account: which proxies exist, their
 *      connection details, when they expire. They are used by tooling only.
 *
 *   2. `authentication.username` / `authentication.password` on a proxy object —
 *      what the *browser* presents to the proxy itself. These end up inside
 *      `RESIDENTIAL_PROXY_URL` and are the only ones on the request path.
 *
 * Nothing in the serving path calls this module. The app must run with no
 * management API access at all, because in production it has no business
 * holding a credential that can spend money. This exists so `.env` can be
 * derived from the account instead of transcribed by hand, and so expiry can be
 * checked before a run rather than discovered during one.
 *
 * ---------------------------------------------------------------------------
 * CONTRACT
 * ---------------------------------------------------------------------------
 * Derived from the published Postman collection (docs.proxy-cheap.com, collection
 * 36507349). Auth is two headers, not a bearer token:
 *
 *     X-Api-Key: <key>
 *     X-Api-Secret: <secret>
 *
 * Read endpoints used here:
 *     GET /proxies              -> array of proxy objects
 *     GET /proxies/{id}         -> one proxy, plus autoExtendEnabled + bandwidth
 *     GET /account/balance      -> { balance }
 *
 * Write endpoints deliberately NOT wrapped:
 *     POST /v2/order/{id}/execute      buys a proxy
 *     POST /proxies/{id}/extend-period buys time
 *     POST /proxies/{id}/buy-bandwidth buys bandwidth
 *     POST /proxies/{id}/rotate-ip     changes the exit IP mid-flight
 *
 * The first three spend money and the fourth breaks the stickiness the whole
 * design depends on. `setAutoExtend()` is the single exception and is described
 * at its own definition.
 */

const log = logger.child({ module: 'proxy-cheap-api' });

const BASE = 'https://api.proxy-cheap.com';

export class ProxyCheapError extends Error {
  constructor(message, { status, body } = {}) {
    super(message);
    this.name = 'ProxyCheapError';
    this.status = status;
    this.body = body;
  }
}

export function hasApiCredentials() {
  return Boolean(config.PROXYCHEAP_API_KEY && config.PROXYCHEAP_API_SECRET);
}

/**
 * One request, with the failure modes named.
 *
 * 401/403 are called out separately because they mean different things here and
 * the remedies differ: 401 is a bad key pair, 403 is a key pair that is valid but
 * not permitted (the collection documents a 403 on `/account/balance`
 * specifically, so a key can exist and still not read billing).
 */
async function call(path, { method = 'GET', body, timeoutMs = 15_000 } = {}) {
  if (!hasApiCredentials()) {
    throw new ProxyCheapError(
      'PROXYCHEAP_API_KEY and PROXYCHEAP_API_SECRET are not set; cannot reach the management API'
    );
  }

  let res;
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        'X-Api-Key': config.PROXYCHEAP_API_KEY,
        'X-Api-Secret': config.PROXYCHEAP_API_SECRET,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new ProxyCheapError(`${method} ${path} did not complete: ${err.message}`);
  }

  const text = await res.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    // Keep the raw text — an HTML error page is itself the diagnostic.
    parsed = null;
  }

  if (res.status === 401) {
    throw new ProxyCheapError(
      `${method} ${path} rejected the credentials (401). Check PROXYCHEAP_API_KEY / PROXYCHEAP_API_SECRET.`,
      { status: 401, body: parsed ?? text }
    );
  }
  if (res.status === 403) {
    throw new ProxyCheapError(
      `${method} ${path} was forbidden (403). The key pair is recognised but lacks permission for this endpoint.`,
      { status: 403, body: parsed ?? text }
    );
  }
  if (!res.ok) {
    throw new ProxyCheapError(`${method} ${path} failed with HTTP ${res.status}`, {
      status: res.status,
      body: parsed ?? text.slice(0, 400),
    });
  }

  return parsed;
}

/** All proxies on the account. */
export async function listProxies() {
  const out = await call('/proxies');
  /**
   * The live API returns `{ proxies: [...] }`. The published example shows a bare
   * array. Both are accepted, and the mismatch is worth recording: the documented
   * response for this endpoint does not match what it actually sends, so the
   * examples in that collection are a starting point and not a contract. The live
   * objects also carry fields the examples omit (`connection.ipVersion`,
   * `connection.hostnames`).
   *
   * Still throws on an unrecognised shape rather than returning `[]`. An empty
   * array here would read as "no proxies on the account", which is a completely
   * different situation from "the response changed" and would send someone to
   * the dashboard to buy a proxy they already own.
   */
  if (Array.isArray(out)) return out;
  if (Array.isArray(out?.proxies)) return out.proxies;
  if (Array.isArray(out?.data)) return out.data;
  throw new ProxyCheapError('GET /proxies returned a shape that is not an array', { body: out });
}

/** One proxy, including `autoExtendEnabled` and `bandwidth`, which the list omits. */
export function getProxy(id) {
  return call(`/proxies/${encodeURIComponent(id)}`);
}

/** Account balance. May 403 on a key pair without billing permission. */
export function getBalance() {
  return call('/account/balance');
}

/**
 * Current and available authentication modes for a proxy.
 *
 * Returns `{ currentAuthenticationType, availableAuthenticationTypes }`. Verified
 * live: `["IP_WHITELIST", "USERNAME_PASSWORD"]`.
 *
 * The important word is *available*, not *additional*. These are mutually exclusive
 * modes, so switching to `IP_WHITELIST` REVOKES username/password rather than adding
 * a second way in. That makes the switch a one-way door in practice: if the
 * whitelisted address is wrong or changes, the proxy stops answering and the only way
 * back is this same management API.
 *
 * Which is why nothing in this repo switches it. See the note in
 * `tools/proxy-cheap-discover.js` for when whitelisting is the better choice, and why
 * it is not the better choice on ECS Fargate without a fixed NAT address.
 */
export function getAuthType(id) {
  return call(`/proxies/${encodeURIComponent(id)}/change-authentication-type`);
}

/**
 * Turn auto-extend on or off.
 *
 * The one write this module exposes, and it is gated on an explicit argument at
 * every call site rather than defaulted, because it is not free: auto-extend
 * means the provider will charge the account to renew the proxy without asking.
 *
 * It is wrapped at all because the alternative is worse for this use case. A
 * proxy that lapses mid-pull does not degrade, it drops the exit IP, and the
 * carrier sees the session move — which is the exact failure the sticky-session
 * design exists to prevent. Paying for renewal is cheaper than a carrier
 * invalidating a session and re-challenging a human.
 *
 * Never called by the app. Only by `npm run proxy:autoextend`, which requires a
 * confirmation flag.
 */
export function setAutoExtend(id, enabled) {
  if (typeof enabled !== 'boolean') {
    throw new ProxyCheapError('setAutoExtend requires an explicit boolean');
  }
  const action = enabled ? 'enable' : 'disable';
  log.info({ id, action }, 'changing auto-extend on a proxy');
  return call(`/proxies/${encodeURIComponent(id)}/auto-extend/${action}`, { method: 'POST' });
}

/**
 * Build the `RESIDENTIAL_PROXY_URL` a proxy object implies.
 *
 * Port choice follows `proxyType` rather than picking the first port present.
 * The object can carry `httpPort`, `httpsPort` and `socks5Port` simultaneously,
 * and they are not interchangeable: Playwright's `proxy.server` scheme has to
 * match the port, or the connection fails in a way that looks like a blocked IP.
 *
 * Returns `{ url, scheme, port, warnings }`. Credentials are included because
 * the caller's whole purpose is to write them into `.env`; every caller in this
 * repo masks them unless explicitly asked to reveal.
 */
export function toProxyUrl(proxy) {
  const warnings = [];
  const conn = proxy?.connection ?? {};
  const auth = proxy?.authentication ?? {};

  const host = conn.connectIp || conn.publicIp;
  if (!host) warnings.push('no connectIp or publicIp on this proxy');

  const type = String(proxy?.proxyType || '').toUpperCase();
  let scheme = 'http';
  let port = conn.httpPort;
  if (type === 'SOCKS5') {
    scheme = 'socks5';
    port = conn.socks5Port;
  } else if (type === 'HTTPS') {
    /**
     * `HTTPS` here describes the proxy's own listener, and Playwright expects
     * `http://` for a CONNECT-style HTTP proxy. Using `https://` for the server
     * scheme is a common misread that fails at connect time.
     */
    scheme = 'http';
    port = conn.httpsPort ?? conn.httpPort;
  }
  if (!port) warnings.push(`proxyType ${type || '(none)'} has no matching port on the object`);

  if (!auth.username || !auth.password) {
    warnings.push(
      'no username/password: this proxy is probably IP-whitelist authenticated, so the deployment egress IP must be whitelisted'
    );
  }

  const cred =
    auth.username && auth.password
      ? `${encodeURIComponent(auth.username)}:${encodeURIComponent(auth.password)}@`
      : '';

  return {
    url: host && port ? `${scheme}://${cred}${host}:${port}` : null,
    scheme,
    port: port ?? null,
    host: host ?? null,
    warnings,
  };
}

/**
 * Does this proxy need a `{session}` username template to be sticky?
 *
 * This is the question that decides whether `PROXY_USERNAME_TEMPLATE` should be
 * set at all, and it was previously answered by guessing. The two products
 * behave oppositely:
 *
 *   - `RESIDENTIAL_STATIC` / `DATACENTER` / `MOBILE` with a dedicated IP: the
 *     proxy *is* one exit IP. Stickiness is a property of the product, and there
 *     is no session concept to encode. A template here is worse than useless —
 *     it mangles a username the provider expects verbatim, and authentication
 *     fails.
 *
 *   - a rotating `RESIDENTIAL` gateway: one hostname fronts a pool, and the only
 *     way to hold an IP is a provider-specific username suffix. Without a
 *     template every request may exit from a different IP.
 *
 * Returns `{ sticky, needsTemplate, reason }` so callers can explain themselves.
 */
export function stickinessFor(proxy) {
  const net = String(proxy?.networkType || '').toUpperCase();
  const dedicated = Boolean(proxy?.connection?.publicIp);

  if (net === 'RESIDENTIAL_STATIC' || net === 'DATACENTER' || net === 'MOBILE') {
    return {
      sticky: true,
      needsTemplate: false,
      reason: `${net} is a dedicated exit IP; stickiness is inherent and PROXY_USERNAME_TEMPLATE must stay unset`,
    };
  }
  if (net === 'RESIDENTIAL' && !dedicated) {
    return {
      sticky: false,
      needsTemplate: true,
      reason:
        'rotating RESIDENTIAL gateway; a provider-specific sticky-session username suffix is required or the IP can change mid-pull',
    };
  }
  return {
    sticky: dedicated,
    needsTemplate: false,
    reason: dedicated
      ? `networkType ${net || '(unknown)'} exposes a dedicated publicIp, so treating it as sticky`
      : `networkType ${net || '(unknown)'} is unrecognised; verify stickiness with npm run proxy:verify before trusting it`,
  };
}

export default {
  hasApiCredentials,
  listProxies,
  getProxy,
  getBalance,
  setAutoExtend,
  toProxyUrl,
  stickinessFor,
  ProxyCheapError,
};
