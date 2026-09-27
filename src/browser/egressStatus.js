/**
 * What IP the carrier sees, cached, for display on every page.
 *
 * ------------------------------------------------------------------------
 * THERE ARE TWO IPs AND ONLY ONE OF THEM MATTERS
 * ------------------------------------------------------------------------
 *   the Node process egress   — `proxy.js#checkEgressIp()`, does NOT traverse the
 *                               proxy, reports the host's own address
 *   the browser exit IP        — what carrier traffic actually leaves from
 *
 * Only the second is worth showing. A badge reading "we are using 73.x.x.x" while the
 * carrier sees a different address is worse than no badge: it would be consulted
 * during exactly the debugging session where being wrong is most expensive.
 *
 * ------------------------------------------------------------------------
 * WHY THIS IS CACHED HARD
 * ------------------------------------------------------------------------
 * Establishing the browser's exit IP costs a browser context and an HTTPS request
 * **through the proxy**, and residential proxy bandwidth is metered — roughly $4/GB.
 * A badge that refreshes on every page load, in every open tab, would quietly bill for
 * the privilege of telling you something that changes every few minutes at most.
 *
 * So: one probe per TTL, shared by every caller and every page, and a live pull's
 * pinned IP is preferred over probing at all because it is both free and more
 * authoritative — it is the address the carrier is being shown right now.
 */

import config from '../config.js';
import logger from '../logger.js';
import { probeExitIp } from './proxyHealth.js';
import { checkEgressIp } from './proxy.js';

const log = logger.child({ module: 'egressStatus' });

/**
 * How long a probed IP is considered current.
 *
 * Five minutes. Residential sticky sessions commonly last 10-30 minutes, so this is
 * short enough to notice a rotation reasonably soon and long enough that an idle
 * dashboard costs almost nothing. The badge shows the age, so a stale value is visibly
 * stale rather than silently wrong.
 */
const TTL_MS = 5 * 60_000;

/** Cheap, and stops N tabs from triggering N probes on the same cold cache. */
let cached = null;
let inFlight = null;

/**
 * The IP of the pull currently running, if any.
 *
 * Set by `PullSession` when it pins, cleared when it ends. Preferred over a probe:
 * free, and it is the address the carrier is looking at rather than one we measured a
 * few minutes ago.
 */
let liveSession = null;

export function setLiveSessionEgress({ ip, carrierId, sessionId }) {
  liveSession = ip ? { ip, carrierId, sessionId, at: Date.now() } : null;
}

export function clearLiveSessionEgress(sessionId) {
  if (liveSession && (!sessionId || liveSession.sessionId === sessionId)) liveSession = null;
}

/** Mask for logs. The UI shows the full address; logs are shared far more widely. */
const mask = (ip) => (ip ? String(ip).replace(/^(\d+)\.(\d+)\..*/, '$1.$2.x.x') : null);

/**
 * Current egress status for the UI.
 *
 * `browserFactory` opens a proxied browser context. Injected rather than imported so
 * this module does not depend on the pool's lifecycle, and so a caller can decline to
 * pay for a probe by not passing one.
 */
export async function getEgressStatus({ browserFactory = null, allowProbe = true } = {}) {
  const proxyConfigured = Boolean(config.RESIDENTIAL_PROXY_URL);

  // 1. A live pull's pinned IP wins: free, and authoritative.
  if (liveSession) {
    return {
      mode: proxyConfigured ? 'proxy' : 'direct',
      ip: liveSession.ip,
      source: 'live-session',
      carrierId: liveSession.carrierId,
      checkedAt: liveSession.at,
      ageMs: Date.now() - liveSession.at,
      stale: false,
      note: proxyConfigured
        ? 'Exit IP of the pull running now — this is the address the carrier sees.'
        : 'Direct egress from this host. No proxy configured.',
    };
  }

  // 2. A recent probe.
  if (cached && Date.now() - cached.checkedAt < TTL_MS) {
    return { ...cached, ageMs: Date.now() - cached.checkedAt, stale: false };
  }

  /**
   * 3. No proxy: report the host's own egress and label it plainly.
   *
   * Still worth showing. "Direct egress" is the single most likely reason a real
   * carrier pull fails once deployed, and a badge that says so continuously is more
   * useful than a warning buried in a startup log nobody re-reads.
   */
  if (!proxyConfigured) {
    /**
     * No proxy: the host's own address IS the answer.
     *
     * This is the one case where the Node process egress is the right number to show.
     * With no proxy the browser egresses the same way the process does, so
     * `checkEgressIp()` — normally the misleading one — reports exactly what the
     * carrier sees. Returning null here would withhold the single most useful fact on
     * the screen.
     *
     * Cheap and safe to call: it does not traverse a proxy, so it costs no metered
     * bandwidth, and it is cached like everything else.
     */
    const host = await checkEgressIp({ timeoutMs: 8000 }).catch(() => ({ ok: false }));
    const status = {
      mode: 'direct',
      ip: host.ok ? host.processEgressIp : null,
      source: 'host-egress',
      checkedAt: Date.now(),
      ageMs: 0,
      stale: false,
      note: host.ok
        ? 'No proxy configured, so carrier traffic leaves from this host at this address. '
          + 'Fine from a home connection; expect real carriers to block it once deployed to a datacenter.'
        : 'No proxy configured, and this host\'s own IP could not be determined.',
    };
    cached = status;
    return status;
  }

  if (!allowProbe || !browserFactory) {
    // Return whatever we have, honestly labelled, rather than paying for a probe.
    return cached
      ? { ...cached, ageMs: Date.now() - cached.checkedAt, stale: true }
      : {
        mode: 'proxy', ip: null, source: 'unknown', checkedAt: null, ageMs: null, stale: true,
        note: 'Proxy configured but the exit IP has not been measured yet.',
      };
  }

  // 4. Probe, once, shared.
  if (inFlight) return inFlight;

  inFlight = (async () => {
    let context = null;
    try {
      context = await browserFactory();
      const probe = await probeExitIp(context, { timeoutMs: 12_000 });
      if (probe.ok) {
        cached = {
          mode: 'proxy',
          ip: probe.ip,
          source: 'probe',
          service: probe.service,
          checkedAt: Date.now(),
          ageMs: 0,
          stale: false,
          note: 'Measured through the browser proxy — the address carrier traffic leaves from.',
        };
        log.info({ exitIp: mask(probe.ip), via: probe.service }, 'egress IP probed for display');
      } else {
        cached = {
          mode: 'proxy',
          ip: null,
          source: 'probe-failed',
          checkedAt: Date.now(),
          ageMs: 0,
          stale: false,
          note: `Proxy configured but the exit IP could not be measured: ${probe.error}.`,
        };
        log.warn({ err: probe.error }, 'could not probe egress IP for display');
      }
      return { ...cached };
    } catch (err) {
      log.warn({ err: err.message }, 'egress probe threw');
      return {
        mode: 'proxy', ip: null, source: 'probe-error', checkedAt: Date.now(), ageMs: 0,
        stale: false, note: `Could not open a proxied context: ${err.message.slice(0, 80)}`,
      };
    } finally {
      // Always release: a leaked context holds a browser process and, on a metered
      // proxy, potentially an idle sticky session.
      await context?.close?.().catch(() => {});
      inFlight = null;
    }
  })();

  return inFlight;
}

/** Force the next read to probe. Called after a pull, since the session may have rotated. */
export function invalidateEgressCache() {
  cached = null;
}

export default {
  getEgressStatus,
  setLiveSessionEgress,
  clearLiveSessionEgress,
  invalidateEgressCache,
};
