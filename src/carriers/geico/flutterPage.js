/**
 * Flutter Web page helpers, specific to GEICO.
 *
 * ISOLATION: see the contract in ./selectors.js. These live here rather than on
 * BaseCarrier on purpose — they are Flutter-specific, Progressive is an Angular
 * app, and putting them on the shared base would mean GEICO work could change
 * behaviour on a carrier that is already verified working.
 *
 * WHAT MAKES FLUTTER WEB DIFFERENT FROM AN ORDINARY SPA
 *
 * Two properties drive everything in this file:
 *
 *   1. It mounts late, and "late" is wide. Measured across six loads of GEICO's
 *      login page: 2246, 2286, 2292, 2339, 4022, 4591, 5985, 6177ms after
 *      `domcontentloaded`, behind an Imperva JS challenge. A fixed sleep is
 *      either too short (flaky) or too long (wastes most of the latency budget),
 *      so everything here polls for a concrete readiness signal instead.
 *
 *   2. Controls are not real elements. Buttons are `flt-semantics[role=button]`
 *      nodes whose ids are assigned in semantics-tree mount order — the same
 *      "Log In" button was `flt-semantic-node-37` on one load and
 *      `flt-semantic-node-16` on the next. So they must be matched on accessible
 *      text, and clicked in a way that survives Flutter's event routing.
 */

import { CarrierError, ErrorCodes } from '../baseCarrier.js';
import { FLUTTER, FLUTTER_BUTTON, COOKIE_BANNER } from './selectors.js';

/**
 * Wait for the Flutter app to render a usable login form.
 *
 * Polls for the password field rather than for the glass pane, because the pane
 * appears well before the form does — waiting on the shell would hand back a
 * page whose fields do not exist yet, which is precisely the mistake that got
 * GEICO wrongly ruled out (F-32).
 *
 * Returns `{ mountMs, framework }`. Throws a *distinguishable* error on timeout:
 * "the app never mounted" is a different problem from "the field is not there",
 * and the diagnostic value is in not conflating them.
 */
export async function waitForFlutterMount(page, { timeout = 30_000, readySelector, log } = {}) {
  const started = Date.now();
  const deadline = started + timeout;
  let sawGlassPane = false;

  while (Date.now() < deadline) {
    if (!sawGlassPane) {
      sawGlassPane = (await page.locator(FLUTTER.glassPane).count().catch(() => 0)) > 0;
    }
    const ready = await page.locator(readySelector).count().catch(() => 0);
    if (ready > 0) {
      const mountMs = Date.now() - started;
      log?.info({ mountMs, sawGlassPane }, 'flutter app mounted');
      return { mountMs, sawGlassPane };
    }
    await page.waitForTimeout(250);
  }

  /**
   * Report which of the two failure modes happened. If the glass pane never
   * appeared, Flutter itself did not boot — that points at a block or a network
   * failure. If the pane is there but the field is not, the app booted and the
   * page is genuinely different from what we expect, which points at selector
   * drift. Same timeout, completely different next step.
   */
  const diagnosis = sawGlassPane
    ? 'The Flutter app booted but the login form never appeared. The page layout may have changed.'
    : 'GEICO never finished loading its login application. This usually means the request was '
      + 'intercepted before the app could boot.';

  throw new CarrierError(
    `GEICO login form did not appear within ${timeout}ms (glassPane=${sawGlassPane})`,
    {
      code: sawGlassPane ? ErrorCodes.SELECTOR_DRIFT : ErrorCodes.NAVIGATION,
      userMessage: diagnosis,
    }
  );
}

/**
 * Find a Flutter semantics button by its accessible text.
 *
 * Reads `aria-label` first, then `textContent`. Returns a bounding box rather
 * than a locator because the ids are unusable as selectors and Playwright has no
 * stable handle to hand back — a coordinate click on a verified rect is more
 * robust here than any selector we could construct.
 */
export async function findFlutterButton(page, textPattern) {
  const source = textPattern instanceof RegExp ? textPattern.source : String(textPattern);
  const flags = textPattern instanceof RegExp ? textPattern.flags : 'i';

  return page.evaluate(
    ({ sel, source: src, flags: f }) => {
      const re = new RegExp(src, f);
      const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
      for (const el of document.querySelectorAll(sel)) {
        const label = clean(el.getAttribute('aria-label') || el.textContent);
        if (!label || !re.test(label)) continue;
        const r = el.getBoundingClientRect();
        if (r.width === 0 && r.height === 0) continue;
        return {
          label,
          // Recorded only for logging. Never select on it; see selectors.js.
          unstableId: el.id || null,
          ariaDisabled: el.getAttribute('aria-disabled'),
          rect: { x: r.x, y: r.y, width: r.width, height: r.height },
        };
      }
      return null;
    },
    { sel: FLUTTER_BUTTON, source, flags }
  );
}

/**
 * Click a Flutter semantics button by text, and verify something happened.
 *
 * Two-stage by necessity. Flutter's semantics nodes sit above a canvas-style
 * event surface, and `locator.click()` on a node the framework does not consider
 * the real target can resolve without the app registering anything. That is the
 * exact shape of the O-5 defect: an action that reports success while doing
 * nothing, hidden behind a swallowed error.
 *
 * So: click the centre of the verified rect, then let the CALLER confirm the
 * postcondition. This function deliberately does not claim success — it returns
 * what it clicked so the caller can check the consequence.
 */
export async function clickFlutterButton(page, textPattern, { log, timeout = 8000 } = {}) {
  const deadline = Date.now() + timeout;
  let found = null;

  while (Date.now() < deadline) {
    found = await findFlutterButton(page, textPattern);
    if (found) break;
    await page.waitForTimeout(150);
  }

  if (!found) {
    throw new CarrierError(`No Flutter button matching ${textPattern} within ${timeout}ms`, {
      code: ErrorCodes.SELECTOR_DRIFT,
      userMessage: 'GEICO\'s page did not offer the control we expected. Their layout may have changed.',
    });
  }

  if (found.ariaDisabled === 'true') {
    log?.warn({ label: found.label }, 'flutter button is aria-disabled; clicking anyway');
  }

  const cx = found.rect.x + found.rect.width / 2;
  const cy = found.rect.y + found.rect.height / 2;
  await page.mouse.click(cx, cy);

  log?.info(
    { label: found.label, unstableId: found.unstableId, x: Math.round(cx), y: Math.round(cy) },
    'clicked flutter button by text'
  );
  return found;
}

/**
 * Dismiss the OneTrust consent banner if present.
 *
 * Not cosmetic. An overlay that covers the form intercepts pointer events, and
 * Playwright's actionability check then waits for a node that will never become
 * hittable — a failure that looks exactly like anti-bot blocking and is the
 * cheapest possible thing to rule out first.
 *
 * Rejecting rather than accepting: fewer third-party scripts loaded means less
 * to interfere, and it is the more defensible default for someone else's data.
 * Never throws — its absence is the common case.
 */
export async function dismissCookieBanner(page, { log } = {}) {
  for (const sel of [COOKIE_BANNER.reject, COOKIE_BANNER.accept]) {
    try {
      const loc = page.locator(sel).first();
      if ((await loc.count()) > 0 && (await loc.isVisible().catch(() => false))) {
        await loc.click({ timeout: 3000 });
        await page.waitForTimeout(300);
        log?.info({ sel }, 'dismissed OneTrust banner');
        return true;
      }
    } catch {
      // Next candidate. A banner we cannot dismiss is not fatal on its own.
    }
  }
  return false;
}

/**
 * Read visible page text once, for matching error copy.
 *
 * Capped, because Flutter's semantics tree duplicates a lot of content and an
 * uncapped `innerText` on these pages is large enough to make regex matching
 * measurably slow.
 */
export async function visibleText(page, { limit = 4000 } = {}) {
  const t = await page.locator('body').innerText().catch(() => '');
  return t.slice(0, limit);
}

/**
 * Query parameters that are credential-equivalent on GEICO.
 *
 * `token` is the 44-character opaque policy identifier, and it grants document
 * access. GEICO's own session-replay masking rewrites it as `token=*****`, which is
 * the carrier stating plainly that it is sensitive.
 */
const URL_SECRET_PARAMS = /^(token|convtoken|sid|ssotoken|authtoken|sessionid|jwt|access_token|id_token|code)$/i;

/**
 * Redact secrets from a URL before it is logged.
 *
 * ------------------------------------------------------------------------
 * WHY EVERY LOGGED URL MUST GO THROUGH THIS
 * ------------------------------------------------------------------------
 * `npm run audit:secrets` has now caught this class of leak **four** times in this
 * project, each in a place the previous fix did not cover:
 *
 *   1. a JSON field literally named `password` in a probe artefact
 *   2. `?token=…` in a flow recording's own `url` fields
 *   3. `?token=…` nested inside JSON response bodies (`_goto.externalUrl`)
 *   4. `?token=…` reaching a **failure diagnostic bundle** via `page.url()`
 *
 * The fourth is the one this function exists for. Diagnostic bundles are written
 * expressly to be shared, and `page.url()` on the documents host carries the token
 * in its query string. The adapter logs the URL in several places — the timeout
 * evidence block, `debugState`, the 2SV outcome line — and every one of them was a
 * leak.
 *
 * The pattern across all four: redaction was written against the shapes imagined at
 * the time, and a real payload had a shape that was not imagined. Hence one function,
 * applied at every logging site, rather than a check per site.
 */
export function scrubUrl(raw) {
  if (typeof raw !== 'string' || !raw) return raw;
  try {
    const u = new URL(raw);
    let changed = false;
    for (const [k, v] of [...u.searchParams.entries()]) {
      if (v && URL_SECRET_PARAMS.test(k)) {
        u.searchParams.set(k, `[REDACTED ${v.length} chars]`);
        changed = true;
      }
    }
    return changed ? u.toString() : raw;
  } catch {
    // Not parseable. Substitute textually rather than returning it untouched —
    // failing open on a secret is not an acceptable default.
    return raw.replace(
      /([?&](?:token|convToken|sid|ssoToken|authToken|sessionId|jwt)=)([^&\s"]{8,})/gi,
      (_m, p, v) => `${p}[REDACTED ${v.length} chars]`
    );
  }
}

export default {
  waitForFlutterMount,
  findFlutterButton,
  clickFlutterButton,
  dismissCookieBanner,
  visibleText,
};
