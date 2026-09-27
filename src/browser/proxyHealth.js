/**
 * Prove the proxy is doing what it was configured to do.
 *
 * ------------------------------------------------------------------------
 * WHY THIS IS NECESSARY AND NOT PARANOIA
 * ------------------------------------------------------------------------
 * Every residential provider encodes stickiness in the proxy **username**, and every
 * provider spells it differently — `sid-x` plus `ttl-600`, `-session-x`, `session-x`,
 * `sessionid-x`. There is no standard and no negotiation: the gateway accepts any
 * username it can parse and silently ignores flags it does not recognise.
 *
 * So a wrong template does not produce an error. It produces a **working proxy that
 * rotates on every connection**. Login leaves from one IP, the MFA submit from
 * another, the document fetch from a third. The carrier sees a session hopping
 * geography mid-flow and invalidates it — and the failure surfaces as
 * "your session expired" or a fresh MFA challenge, pointing at the carrier rather
 * than at a typo in a username.
 *
 * That is the single most expensive class of misconfiguration in this system, because
 * it is invisible at the layer where it happens and misattributed at the layer where
 * it shows up.
 *
 * ------------------------------------------------------------------------
 * WHY THE PROBE GOES THROUGH THE BROWSER
 * ------------------------------------------------------------------------
 * `proxy.js#checkEgressIp()` uses Node's `fetch`, which does **not** go through the
 * proxy — it reports the host's own IP, and says so. Useful for contrast, useless for
 * verification.
 *
 * These probes use `context.request`, which shares the browser context's proxy
 * configuration. That is the same egress path the carrier traffic takes, so what it
 * measures is what the carrier sees. Checking a different path would be a tool that
 * lies, which this project has enough of already.
 */

import logger from '../logger.js';
import config from '../config.js';

const log = logger.child({ module: 'proxyHealth' });

/**
 * Services that echo the caller's IP.
 *
 * Several, tried in order, because any single one can be down, rate-limited, or —
 * more likely for a residential exit — blocked outright. A verification tool that
 * reports "proxy broken" when its own echo service is unreachable is worse than no
 * tool, so a failure to reach one is not a failure of the proxy.
 *
 * All are plain-text or minimal-JSON and cheap. `ipify` first because it is the most
 * reliable of them in practice.
 */
const IP_ECHO_SERVICES = [
  { url: 'https://api.ipify.org?format=json', pick: (b) => JSON.parse(b).ip },
  { url: 'https://ifconfig.me/ip', pick: (b) => b.trim() },
  { url: 'https://icanhazip.com', pick: (b) => b.trim() },
  { url: 'https://api64.ipify.org?format=json', pick: (b) => JSON.parse(b).ip },
];

const IPV4 = /^(?:\d{1,3}\.){3}\d{1,3}$/;

/**
 * The exit IP as the carrier would see it, via the browser context's proxy.
 *
 * Returns `{ ok, ip, service, latencyMs }` or `{ ok: false, error }`. Never throws:
 * a caller using this for a health gate must be able to distinguish "the proxy is
 * broken" from "this function blew up", and an exception conflates them.
 */
export async function probeExitIp(context, { timeoutMs = 12_000 } = {}) {
  const started = performance.now();
  const attempts = [];

  for (const svc of IP_ECHO_SERVICES) {
    try {
      const res = await context.request.get(svc.url, { timeout: timeoutMs });
      if (!res.ok()) {
        attempts.push(`${svc.url} -> HTTP ${res.status()}`);
        continue;
      }
      const ip = svc.pick(await res.text());
      if (!ip || !IPV4.test(ip)) {
        attempts.push(`${svc.url} -> unparseable`);
        continue;
      }
      return {
        ok: true,
        ip,
        service: new URL(svc.url).host,
        latencyMs: Math.round(performance.now() - started),
      };
    } catch (err) {
      attempts.push(`${new URL(svc.url).host} -> ${err.message.split('\n')[0].slice(0, 60)}`);
    }
  }

  return {
    ok: false,
    error: 'no IP echo service was reachable',
    attempts,
    latencyMs: Math.round(performance.now() - started),
  };
}

/**
 * Confirm the exit IP has not changed since it was pinned.
 *
 * ------------------------------------------------------------------------
 * WHAT THIS PROTECTS AND WHAT IT CANNOT
 * ------------------------------------------------------------------------
 * A pull spans login → MFA challenge → a human reading a text → code submit →
 * document fetch, which is 30 seconds to several minutes. Residential sticky sessions
 * expire (commonly 1–30 minutes depending on provider and plan) and the upstream node
 * can drop at any moment regardless of TTL. Either way the gateway quietly hands out a
 * different exit.
 *
 * This cannot *prevent* a rotation — no client can, the IP belongs to someone's home
 * connection. What it can do is convert an unattributable carrier failure into a named
 * one: "the proxy changed IP mid-session" instead of "the carrier signed this session
 * out". Given the same symptom otherwise points at selectors, cookies, or anti-bot,
 * naming it is most of the value.
 *
 * Deliberately returns a verdict rather than throwing, so the caller decides whether a
 * rotation is fatal for the phase it is in.
 */
export async function verifyStillPinned(context, pinnedIp, { timeoutMs = 10_000 } = {}) {
  if (!pinnedIp) return { checked: false, reason: 'no pinned IP to compare against' };

  const probe = await probeExitIp(context, { timeoutMs });
  if (!probe.ok) {
    /**
     * Could not check. NOT treated as a rotation.
     *
     * An unreachable echo service is a far more likely explanation than a rotation,
     * and failing a pull because a third-party endpoint was down would be its own
     * outage. Reported as unchecked so the caller can proceed.
     */
    log.warn({ err: probe.error, attempts: probe.attempts }, 'could not re-verify the proxy exit IP');
    return { checked: false, reason: probe.error };
  }

  if (probe.ip === pinnedIp) {
    return { checked: true, stable: true, ip: probe.ip };
  }

  log.error(
    { pinnedIp, currentIp: probe.ip },
    'PROXY ROTATED MID-SESSION — the carrier will see this as a session hijack'
  );
  return { checked: true, stable: false, pinnedIp, currentIp: probe.ip };
}

/**
 * Human-readable summary of how the proxy is configured, for `/api/health`.
 *
 * Reports the *shape* of the configuration, never its credentials, and is explicit
 * about the difference between "a sticky template is configured" and "stickiness is
 * known to work". The old health output said `sticky: true` purely because a template
 * string was present, which is a claim about a config file rather than about
 * behaviour — exactly the kind of reassuring-but-empty signal that lets a broken
 * setup look healthy.
 */
export function describeProxyConfig() {
  const configured = Boolean(config.RESIDENTIAL_PROXY_URL);
  if (!configured) {
    return {
      configured: false,
      note: 'No proxy. Real carriers routinely block datacenter IPs, so this is expected '
        + 'to work from a home connection and to fail once deployed.',
    };
  }

  let host = null;
  try {
    host = new URL(config.RESIDENTIAL_PROXY_URL).host;
  } catch {
    host = 'unparseable';
  }

  const template = config.PROXY_USERNAME_TEMPLATE ?? null;
  const model = config.PROXY_MODEL ?? null;

  /**
   * Describe stickiness in terms of the product, not the template.
   *
   * `stickyTemplateConfigured: false` was previously the whole story, and on a dedicated
   * exit IP it reads as a missing setting when it is the required one. Health output is
   * consulted while something is already wrong, so a field that looks like a defect and
   * is not costs real debugging time.
   */
  let stickiness;
  if (model === 'dedicated') {
    stickiness = template
      ? 'MISCONFIGURED — dedicated exit IP with a username template set; it will break authentication'
      : 'inherent — dedicated exit IP, no session token needed';
  } else if (model === 'rotating') {
    stickiness = template
      ? 'template configured; empirical result comes from `npm run proxy:verify`'
      : 'MISCONFIGURED — rotating gateway with no username template; the IP can change mid-pull';
  } else {
    stickiness = 'unknown — PROXY_MODEL unset; run `npm run proxy:discover`';
  }

  return {
    configured: true,
    host,
    model: model ?? 'unknown',
    stickiness,
    stickyTemplateConfigured: Boolean(template),
    stickyPlaceholderPresent: Boolean(template && template.includes('{session}')),
    // Deliberately not called "sticky". Whether it works is an empirical question and
    // `npm run proxy:verify` is what answers it.
    stickyVerified: 'unknown — run `npm run proxy:verify`',
    bypass: config.PROXY_BYPASS || null,
  };
}

export default { probeExitIp, verifyStillPinned, describeProxyConfig };
