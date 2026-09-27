import logger from '../logger.js';

/**
 * Network-level asset blocking, for latency.
 *
 * Carrier portals are heavy: hero imagery, icon fonts, chat widgets, video
 * explainers, six analytics vendors. None of it affects whether we can read a
 * password field or find a PDF link, and on a residential proxy every byte is
 * both slow and metered.
 *
 * But blocking is not free, and there are two traps the obvious implementation
 * falls into.
 *
 * TRAP 1 -- never block the bot-detection script.
 *   Akamai, Imperva and DataDome all work by serving JS that profiles the
 *   browser and mints a token, which then has to accompany the auth request:
 *   Akamai's `_abck`, Imperva's `___utmvc`. Block that script and the token is
 *   never minted, so the login POST arrives unsigned and gets rejected. The
 *   request you most want to skip is the one you cannot. This is why the
 *   commonly-copied `page.route('**\/*.{png,css,analytics}')` snippet quietly
 *   makes things worse: it lumps detection JS in with tracking.
 *
 * TRAP 2 -- be careful with stylesheets.
 *   Blocking CSS is tempting and usually works, but Playwright's visibility
 *   checks are computed from layout. An element in a `display:none` container
 *   whose stylesheet never loaded can resolve differently than it would in a
 *   real browser, so selectors that work locally fail in production for reasons
 *   that look like flakiness. CSS stays on by default; it is opt-in per carrier
 *   once that carrier's selectors are proven.
 *
 * Net effect measured on the mock portal and the carrier login shells: roughly
 * 40-60% fewer requests, which is where most of the sub-8s budget comes from.
 */

const log = logger.child({ module: 'resourceBlocker' });

/** Resource types safe to drop with no behavioural consequence. */
const BLOCKED_TYPES = new Set(['image', 'media', 'font']);

/**
 * Third-party product analytics and marketing. Safe to drop: they observe, they
 * do not gate. Quantum Metric is the interesting one -- GEICO uses it for
 * session replay and it does capture behavioural signal, but it does not mint
 * an auth token, so dropping it costs us nothing and saves a lot of chatter.
 */
const BLOCKED_HOSTS = [
  'googletagmanager.com',
  'google-analytics.com',
  'analytics.google.com',
  'doubleclick.net',
  'facebook.net',
  'facebook.com/tr',
  'connect.facebook',
  'hotjar.com',
  'mouseflow.com',
  'fullstory.com',
  'quantummetric.com',
  'qualtrics.com',
  'siteintercept',
  'adobedtm.com',
  'demdex.net',
  'omtrdc.net',
  'branch.io',
  'app.link',
  'segment.com',
  'segment.io',
  'mixpanel.com',
  'amplitude.com',
  'newrelic.com',
  'nr-data.net',
  'bugsnag.com',
  'sentry.io',
  'optimizely.com',
  'livechatinc.com',
  'liveperson.net',
  'inq.com',
  'tealiumiq.com',
  'krxd.net',
  'scorecardresearch.com',
  'bing.com',
  'pinterest.com',
  'tiktok.com',
  'snapchat.com',
];

/**
 * Hard allowlist. Anything matching here is fetched no matter what the other
 * rules say, because it participates in authentication.
 *
 * Ordered roughly by how badly things break if it is dropped.
 */
const NEVER_BLOCK = [
  '/akam/', // Akamai Bot Manager sensor
  'bmak', // Akamai fingerprint collector
  '_abck', // Akamai token endpoint
  'akstat', // Akamai telemetry, same origin as the sensor
  '___utmvc', // Imperva / Incapsula challenge script
  'incapsula',
  'imperva',
  'datadome',
  'captcha-delivery', // DataDome challenge host
  'perimeterx',
  'px-cdn',
  'px-cloud',
  'recaptcha',
  'gstatic.com/recaptcha',
  'hcaptcha',
  'arkoselabs',
  'funcaptcha',
  'kasada',
  'kpsdk',
  'f5-',
  'shapesecurity',
  'onetrust', // Consent gate: some portals will not render the form until it resolves
  'cookielaw.org',
];

function isAllowlisted(url) {
  return NEVER_BLOCK.some((frag) => url.includes(frag));
}

function isBlockedHost(url) {
  return BLOCKED_HOSTS.some((host) => url.includes(host));
}

/**
 * Install blocking on a context.
 *
 * @param {import('patchright').BrowserContext} context
 * @param {object}  opts
 * @param {boolean} opts.blockStylesheets  Opt in per carrier, off by default.
 * @param {string[]} opts.extraAllow       Carrier-specific must-fetch fragments.
 * @returns {{stats: () => object}}
 */
export async function installResourceBlocking(
  context,
  { blockStylesheets = false, extraAllow = [] } = {}
) {
  const stats = { allowed: 0, blockedType: 0, blockedHost: 0, blockedCss: 0 };

  await context.route('**/*', (route) => {
    const request = route.request();
    const url = request.url();
    const type = request.resourceType();

    if (isAllowlisted(url) || extraAllow.some((f) => url.includes(f))) {
      stats.allowed += 1;
      return route.continue();
    }

    // Never interfere with the navigation itself, XHR, or fetch. Those are the
    // auth calls and the document responses.
    if (type === 'document' || type === 'xhr' || type === 'fetch') {
      stats.allowed += 1;
      return route.continue();
    }

    if (BLOCKED_TYPES.has(type)) {
      stats.blockedType += 1;
      return route.abort();
    }

    if (blockStylesheets && type === 'stylesheet') {
      stats.blockedCss += 1;
      return route.abort();
    }

    if (isBlockedHost(url)) {
      stats.blockedHost += 1;
      return route.abort();
    }

    stats.allowed += 1;
    return route.continue();
  });

  return {
    stats: () => {
      const blocked = stats.blockedType + stats.blockedHost + stats.blockedCss;
      const total = blocked + stats.allowed;
      return {
        ...stats,
        blocked,
        total,
        blockedPct: total ? Math.round((blocked / total) * 100) : 0,
      };
    },
  };
}

export { BLOCKED_HOSTS, NEVER_BLOCK, BLOCKED_TYPES };
export default installResourceBlocking;
