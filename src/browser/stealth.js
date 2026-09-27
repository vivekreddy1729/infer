import config from '../config.js';

/**
 * Fingerprint posture.
 *
 * The guiding principle here is subtractive, not additive, and it is the
 * opposite of what most stealth write-ups recommend.
 *
 * The classic `puppeteer-extra-plugin-stealth` approach bolts on dozens of JS
 * patches: fake `navigator.webdriver`, spoofed WebGL vendor strings, invented
 * plugin arrays, a hand-picked user agent. That made sense in 2020. Today it is
 * actively harmful for two reasons:
 *
 *   1. The patches are applied from an injected script, and the act of
 *      injecting is itself detectable. Anything reachable via `addInitScript`
 *      runs in the page's main world where detection code can see the seams
 *      (property descriptor order, `toString` of patched natives, timing).
 *
 *   2. Hand-rolled overrides create *internal inconsistency*, which is a
 *      stronger bot signal than the default they replaced. Claiming a macOS
 *      user agent while reporting a Linux platform, a SwiftShader WebGL
 *      renderer, and a 1920x1080 viewport with no scrollbar width is a
 *      contradiction no real browser produces. Detection vendors stopped
 *      looking for `navigator.webdriver` years ago; they look for combinations
 *      that cannot physically coexist.
 *
 * Patchright instead patches the leaks at the driver level, below the page: it
 * runs its own JS in isolated execution contexts and disables the Console API,
 * which closes the `Runtime.enable` CDP leak that most detectors actually
 * fingerprint. Per its own documentation the highest-undetectability config is
 * real Google Chrome, a persistent context, and *no* custom headers or user
 * agent. So we inject nothing and let a real Chrome be a real Chrome.
 *
 * Refs: https://www.npmjs.com/package/patchright
 */

/**
 * Args we pass, and the ones we pointedly do not.
 *
 * Included:
 *   --disable-dev-shm-usage  Containers get a 64MB /dev/shm by default and
 *                            Chrome will crash on heavy pages without this.
 *                            Behavioural, not fingerprintable.
 *   --no-sandbox             Required under most container runtimes. Acceptable
 *                            here because the browser only ever visits carrier
 *                            domains we selected, but it is a real tradeoff and
 *                            called out in the README.
 *
 * Deliberately omitted:
 *   --disable-blink-features=AutomationControlled
 *                            Redundant. Patchright removes the automation
 *                            signal below Blink; setting the flag as well adds
 *                            nothing and changes behaviour we would rather
 *                            leave stock.
 *   --disable-gpu            Forces a SwiftShader WebGL renderer, which is a
 *                            well-known headless tell. We keep the GPU stack
 *                            on and, where possible, run headed under Xvfb.
 *   --window-size            Viewport is left to the real browser; see below.
 */
const BASE_ARGS = Object.freeze(['--no-sandbox', '--disable-dev-shm-usage']);

/** Suppresses Chrome's first-run UI without touching anything fingerprintable. */
const QUIET_ARGS = Object.freeze([
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-features=Translate,MediaRouter',
  '--hide-crash-restore-bubble',
]);

export function launchArgs() {
  return [...BASE_ARGS, ...QUIET_ARGS];
}

/**
 * Launch options shared by both the pooled and persistent paths.
 *
 * `channel: 'chrome'` selects real Google Chrome over bundled Chromium. This
 * matters more than any JS patch: Chromium ships different codec support, a
 * different `navigator.userAgentData` brand list, and no widevine, all of which
 * are trivially checked. Falls back to Chromium when Chrome is absent so local
 * dev and CI still run.
 *
 * Setting a channel at all is load-bearing for a reason that is easy to miss.
 * With no channel and `headless: true`, Playwright launches
 * `chrome-headless-shell`, a separate stripped binary, not Chrome in headless
 * mode. It reports "HeadlessChrome" in its user agent, omits the extension and
 * PDF-viewer plumbing, and has no `chrome.runtime`, so it is identifiable
 * without any clever fingerprinting at all. Naming a channel forces the full
 * browser binary running new-headless, which shares the real browser's surface.
 * This single option does more for detectability than every JS patch combined,
 * which is why the launch fallback chain never degrades to "no channel" until
 * both named channels have failed.
 */
export function launchOptions({ proxy = null, headless = config.HEADLESS } = {}) {
  return {
    channel: 'chrome',
    headless,
    args: launchArgs(),
    ...(proxy ? { proxy } : {}),
    // Chrome's own timeout for coming up. Distinct from navigation timeouts.
    timeout: 60_000,
  };
}

/**
 * Context options.
 *
 * `viewport: null` is the important line. A fixed viewport is one of the
 * cheapest headless signals going, because automation defaults (1280x720,
 * 800x600) are over-represented and, more tellingly, produce an inner/outer
 * dimension relationship no windowed browser has. `null` hands sizing to the
 * actual browser window.
 *
 * Locale and timezone are set, not spoofed: they are the only two values where
 * the *server* already knows the truth from the proxy exit IP, so a mismatch
 * between a US residential IP and a UTC/en-GB browser is a contradiction. These
 * should track the proxy's geography.
 */
export function contextOptions({ storageState = null, locale = 'en-US', timezoneId = 'America/New_York' } = {}) {
  return {
    viewport: null,
    locale,
    timezoneId,
    // Matches a normal consumer Chrome on a typical display. Left coarse on
    // purpose; over-specifying invites contradiction.
    deviceScaleFactor: undefined,
    ignoreHTTPSErrors: false,
    acceptDownloads: true,
    ...(storageState ? { storageState } : {}),
  };
}

/**
 * What we are NOT defending against, stated plainly so the README does not
 * overclaim:
 *
 *  - TLS/JA3 fingerprinting. Real Chrome's TLS stack produces a genuine Chrome
 *    ClientHello, so this is handled incidentally rather than by design. If a
 *    carrier fingerprinted at the TLS layer *and* correlated it against the
 *    HTTP/2 SETTINGS order we would have no additional answer.
 *  - Behavioural biometrics. GEICO runs Quantum Metric, which records mouse
 *    paths and keystroke cadence. We type with per-character delays, which
 *    defeats naive "input appeared instantly" checks and nothing more
 *    sophisticated than that.
 *  - Proof-of-work / interstitial challenges (Kasada, hard Cloudflare). No
 *    solver is wired in. These fail closed with a clear user-facing error
 *    rather than hanging.
 */
export const KNOWN_GAPS = Object.freeze([
  'TLS/JA3 correlation',
  'behavioural biometrics (mouse/keystroke modelling)',
  'proof-of-work interstitials',
  'image/audio CAPTCHA',
]);

export default { launchOptions, contextOptions, launchArgs, KNOWN_GAPS };
