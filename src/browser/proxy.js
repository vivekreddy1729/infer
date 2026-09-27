import crypto from 'node:crypto';
import config from '../config.js';
import logger from '../logger.js';

/**
 * Sticky residential proxy routing.
 *
 * Why this exists at all: carrier portals score IP reputation before they score
 * anything else. Every mainstream host (AWS, GCP, Fly, Render, Railway) egresses
 * from ASNs that are published, well-known, and pre-flagged. A flawless browser
 * fingerprint on a datacenter IP still loses. So the proxy is not an
 * optimisation, it is the precondition for the rest of the stack mattering.
 *
 * Why *sticky*: the flow is login -> MFA challenge -> code submit -> document
 * fetch, spanning 30 seconds to several minutes of human time. A rotating proxy
 * changes IP mid-flow, the carrier sees the session jump geography, and it
 * invalidates the session or forces a fresh challenge. Every request in one
 * pull has to leave from one IP.
 */

const log = logger.child({ module: 'proxy' });

/** Opaque, stable-per-session token the provider maps to one exit IP. */
export function newStickySessionId() {
  return crypto.randomBytes(6).toString('hex');
}

/**
 * Build the Playwright `proxy` option for a session.
 * Returns null when no proxy is configured, in which case the browser egresses
 * directly. Fine for the mock carrier, expected to fail on real ones.
 */
export function buildProxyConfig(stickySessionId) {
  if (!config.RESIDENTIAL_PROXY_URL) return null;

  let parsed;
  try {
    parsed = new URL(config.RESIDENTIAL_PROXY_URL);
  } catch {
    log.error('RESIDENTIAL_PROXY_URL is not a valid URL; egressing directly');
    return null;
  }

  const baseUsername = decodeURIComponent(parsed.username || '');
  const password = decodeURIComponent(parsed.password || '');

  // Providers encode stickiness in the username, and each one does it
  // differently, so the shape is configuration rather than code.
  let username = baseUsername;
  if (config.PROXY_USERNAME_TEMPLATE) {
    username = config.PROXY_USERNAME_TEMPLATE.replaceAll('{session}', stickySessionId).replaceAll(
      '{user}',
      baseUsername
    );
  }

  const proxy = {
    server: `${parsed.protocol}//${parsed.host}`,
    ...(username ? { username } : {}),
    ...(password ? { password } : {}),
    ...(config.PROXY_BYPASS ? { bypass: config.PROXY_BYPASS } : {}),
  };

  // Host and stickiness are safe to log. Credentials are not, and the logger
  // redacts them regardless.
  log.debug(
    { server: proxy.server, sticky: Boolean(config.PROXY_USERNAME_TEMPLATE) },
    'proxy configured for session'
  );
  return proxy;
}

/** Best-effort egress check, surfaced in /api/health for deploy verification. */
export async function checkEgressIp({ timeoutMs = 8000 } = {}) {
  const started = performance.now();
  try {
    const res = await fetch('https://api.ipify.org?format=json', {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const { ip } = await res.json();
    // Note: this is the *Node process* egress, not the browser's. The browser
    // goes through the proxy; this call does not. Useful for showing the
    // contrast between host IP and proxied IP in the demo.
    return { ok: true, processEgressIp: ip, latencyMs: Math.round(performance.now() - started) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

export default { buildProxyConfig, newStickySessionId, checkEgressIp };
