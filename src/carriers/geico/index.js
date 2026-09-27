/**
 * GEICO adapter.
 *
 * ------------------------------------------------------------------------
 * ISOLATION CONTRACT
 * ------------------------------------------------------------------------
 *   ALLOWED    extend BaseCarrier; import config, logger, and BaseCarrier's
 *              shared primitives (raceOutcomes, firstVisible, typeLikeHuman,
 *              assertNotBlocked, exportStorageState)
 *   FORBIDDEN  importing anything from ../progressive.js
 *   FORBIDDEN  editing ../baseCarrier.js to suit GEICO
 *
 * Override on this class if a shared primitive needs to differ. The Progressive
 * path is verified working against a real account; duplication is the accepted
 * price of not being able to regress it from here.
 * ------------------------------------------------------------------------
 *
 * WHAT GEICO IS, AND WHY THE SHAPE DIFFERS FROM PROGRESSIVE
 *
 * A Flutter Web application (HTML renderer) behind Imperva, at
 * `ecams.geico.com`. Three consequences that drive every decision below:
 *
 * 1. **It mounts late, and variably.** 2.2-6.2s after `domcontentloaded`,
 *    measured across eight loads. This is the single largest fixed cost in the
 *    flow, it is paid on every pull, and it is exactly what pre-warming exists
 *    to hide. See `static prewarm` below.
 *
 * 2. **There is no warm path at all** (F-33). GEICO's own documentation states
 *    2-Step Verification is required to access a policy and that the delivery
 *    method is chosen *each time you log in*. No trusted-device option is
 *    offered anywhere. So `supportsSessionReuse = false`: every pull pays a
 *    human MFA round-trip, and advertising otherwise in the UI would be a lie.
 *    This is the inverse of Progressive, where device trust at least could skip
 *    the SMS (F-30 found it never actually did).
 *
 * 3. **Controls are semantics nodes with unstable ids.** The "Log In" button was
 *    `flt-semantic-node-37` on one load and `flt-semantic-node-16` on the next,
 *    so it is matched on accessible text. Same class of trap as Progressive's
 *    minted input ids (F-08), which makes it a general rule rather than a quirk.
 *
 * WHAT IS VERIFIED AND WHAT IS NOT
 *
 * Verified against the live page by `tools/geico/probe-geico-typing.js`, with
 * values read back after typing: the login URL, the Flutter framework detection,
 * the mount behaviour, and both credential selectors.
 *
 * NOT yet verified, because it needs a real login that has not been spent: the
 * 2SV screens and the entire document flow. Those paths are written to fail with
 * a specific, honest error naming the recon tool to run, rather than to guess.
 * `fetchDocuments()` throws deliberately — see its comment.
 */

import config from '../../config.js';
import { BaseCarrier, CarrierError, ErrorCodes, MfaChannel } from '../baseCarrier.js';
import {
  LOGIN_URL,
  CREDENTIALS,
  BUTTON_TEXT,
  MFA,
  LOGIN_ERROR_TEXT,
  HOSTS,
  ENDPOINTS,
  ROUTES,
} from './selectors.js';
import {
  waitForFlutterMount,
  clickFlutterButton,
  findFlutterButton,
  dismissCookieBanner,
  visibleText,
  scrubUrl,
} from './flutterPage.js';
import { fetchDocumentList, selectDocument, downloadDocument } from './documents.js';

export class GeicoCarrier extends BaseCarrier {
  static id = 'geico';
  static displayName = 'GEICO';

  /**
   * TRUE — **this reverses F-33, which was wrong.**
   *
   * F-33 concluded from GEICO's public 2SV FAQ that 2-Step Verification is required
   * on every login with no trusted-device option, and set this to `false`. The FAQ
   * does say "you will be able to select your verification method each time you log
   * in", and it mentions no "remember this device" facility anywhere.
   *
   * A real completed login showed otherwise: GEICO does appear to remember the
   * browser, so a subsequent sign-in can skip the challenge entirely. Marketing copy
   * described the common case and was read as describing the mechanism — the same
   * mistake as F-32, where the absence of evidence became a statement about
   * capability.
   *
   * The consequence of leaving it `false` was not cosmetic. `pullSession` only
   * persists `storageState` when this is true, so the trusted-device cookie was
   * being thrown away at the end of every run and each pull paid a full human MFA
   * round-trip that GEICO was willing to skip.
   *
   * Set true so the session is persisted and the warm path can be *attempted*.
   * `isSessionValid()` decides whether it actually worked, and falls back to a cold
   * login when it has not — so being wrong in this direction costs one cheap probe
   * rather than a failed run.
   */
  static supportsSessionReuse = true;

  /**
   * TRUE — keep the saved state even when the session has expired.
   *
   * GEICO remembers a browser it has already challenged, so `storageState` carries two
   * cookies with very different lifetimes: a short-lived session cookie, and a
   * long-lived trusted-device cookie.
   *
   * Without this, `pullSession` cleared the whole saved state the moment
   * `isSessionValid()` failed and then opened a **fresh** context for the cold login.
   * The user is no longer challenged in their own browser, yet every automated pull
   * arrived as an unrecognised device and paid a full human 2SV round-trip GEICO was
   * willing to skip. A long-lived credential discarded because a short-lived one
   * expired.
   *
   * Safe for GEICO specifically because `/login` renders its form regardless of a
   * stale session cookie. Carriers with a "your session ended" interstitial — such as
   * Progressive's `/app/session-timeout` (F-18) — should not set this, and do not: the
   * flag is read with a fallback so not declaring it preserves the old behaviour
   * exactly.
   *
   * Cost, stated: hydrating a context means `adopt_prewarmed` is skipped on this path,
   * because a parked page has no cookies. Trading ~5ms of adoption for skipping a ~30s
   * human wait is not a close call.
   */
  static retainsDeviceTrust = true;

  /**
   * FALSE — keep stylesheets.
   *
   * Flutter Web positions everything through computed layout, and Playwright's
   * visibility checks are computed from layout too. Dropping stylesheets on this
   * carrier would make every selector unreliable in a way that looks like
   * anti-bot blocking. The latency is not worth the debugging.
   */
  static blockStylesheets = false;

  /**
   * Never block these.
   *
   * Imperva's sensor script mints the token that signs the login request. The
   * request you would most like to skip is the one you cannot — blocking it makes
   * the submit arrive unsigned, which fails in a way that looks like bad
   * credentials. Quantum Metric is included because GEICO's app boot waits on
   * more of its own bundle than is obvious, and the cost of being wrong here is
   * a silent, intermittent login failure.
   */
  static extraAllow = ['geico.com', 'incapsula', 'imperva', 'quantummetric'];

  /**
   * FALSE — pooled context, not a persistent Chrome profile.
   *
   * A persistent profile is keyed by username, which makes it impossible to
   * pre-warm anonymously (O-9/O-10). For Progressive that was a real tradeoff
   * because device trust theoretically rode on the profile. Here there is
   * nothing to trade: GEICO has no device trust to preserve (F-33), so the
   * profile would buy nothing and cost both a ~824ms browser launch per session
   * and the ability to pre-warm the mount.
   */
  static usePersistentProfile = false;

  /**
   * Pre-warm the login page.
   *
   * This matters more for GEICO than for any other carrier here, because the
   * cold path is the *only* path. Progressive can sometimes skip straight to a
   * warm session; GEICO cannot, so the 2.2-6.2s Flutter mount would otherwise be
   * paid by the user on every single pull.
   *
   * `readySelector` is the password field, not the glass pane: the pane appears
   * well before the form, and parking a page whose fields do not exist yet would
   * hand the user a tab that still has to finish booting.
   *
   * `readyTimeoutMs` is generous relative to the observed 6.2s worst case.
   * Nobody is waiting on background work, and a prepare that gives up early
   * silently forfeits the optimisation — the failure mode found in F-31.
   */
  static prewarm = {
    url: LOGIN_URL,
    readySelector: CREDENTIALS.password,
    readyTimeoutMs: 30_000,
  };

  /**
   * GEICO-local typing, overriding BaseCarrier.typeLikeHuman().
   *
   * ------------------------------------------------------------------------
   * WHY THIS IS OVERRIDDEN HERE AND NOT FIXED IN THE BASE
   * ------------------------------------------------------------------------
   * A real GEICO login failed with:
   *
   *     credential fields did not accept input (user 22/22, pass 12/13)
   *
   * The username arrived whole; the password was one character short, twice in a
   * row. The base implementation types with `locator.press(ch)` per character.
   *
   * What was ruled out, by measurement rather than reasoning:
   *
   *  - **Character mapping.** All 94 printable ASCII characters survive
   *    `press()` on a plain `<input>` (`npm run test:typing`). The initial
   *    hypothesis — that `press()` treats `+` as a modifier separator — is wrong.
   *  - **A deterministic method difference.** Against the live GEICO field, both
   *    `press()` per character and `pressSequentially()` typed 13/13 correctly on
   *    the run that was measured. So the loss is intermittent, and simply swapping
   *    methods would have "fixed" it by coincidence and regressed later.
   *
   * The remaining explanation is a Flutter Web race. Flutter synchronises a hidden
   * input against its own editing state, and a keystroke arriving during that sync
   * is dropped — invisible on ordinary DOM, which is why no fixture reproduces it.
   *
   * So rather than diagnose one character (which would require the user's password),
   * this verifies its own postcondition and repairs: type, read back, and on a
   * mismatch retry with a longer delay, escalating, then fall back to `fill()`.
   * Robust to a dropped keystroke, a mis-mapped character, or a framework race
   * without needing to know which occurred.
   *
   * `BaseCarrier` is deliberately NOT changed. Progressive is verified working
   * against a real account and must not be put at risk by GEICO's problem — the
   * isolation contract in ./selectors.js. **The latent defect does affect
   * Progressive too**, and that is recorded in F-39 rather than silently patched.
   *
   * Never logs the text or any part of it. Lengths only.
   */
  async typeLikeHuman(locator, text, { minDelay = config.TYPE_MIN_DELAY_MS, maxDelay = config.TYPE_MAX_DELAY_MS } = {}) {
    const canSeq = typeof locator.pressSequentially === 'function';

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      // Escalate the delay each attempt. If the cause is a sync race, slowing down
      // is the thing most likely to help, and only the retry pays the cost.
      const delay = Math.round((minDelay + maxDelay) / 2) * attempt;

      await locator.click({ timeout: 8000 });
      await locator.fill('').catch(() => {});

      if (canSeq) await locator.pressSequentially(text, { delay });
      else await locator.type(text, { delay });

      const got = await locator.inputValue().catch(() => '');
      if (got === text) {
        if (attempt > 1) {
          this.log.info({ attempt, chars: text.length, delay }, 'field accepted input after a retry');
        }
        return;
      }

      this.log.warn(
        { attempt, expectedChars: text.length, actualChars: got.length, delay },
        'field did not accept the full input; retrying more slowly'
      );
    }

    /**
     * Last resort: set the value directly.
     *
     * `fill()` is avoided as a primary method for a real reason — portals bind
     * validation to `input`/`keyup`, and a one-shot set can leave the submit button
     * disabled. But a disabled button is a better failure than a silently truncated
     * password, which presents to the user as "your credentials were rejected" and
     * sends them to re-type something that was already correct.
     *
     * Playwright's `fill()` does dispatch an `input` event, so Flutter's listener
     * has a reasonable chance of picking it up.
     */
    await locator.fill(text);
    const got = await locator.inputValue().catch(() => '');
    if (got !== text) {
      throw new CarrierError(
        `field would not accept input after 3 typed attempts and fill() (${got.length}/${text.length} chars)`,
        {
          code: ErrorCodes.SELECTOR_DRIFT,
          userMessage: 'GEICO\'s sign-in form would not accept the typed credentials. Please try again.',
        }
      );
    }
    this.log.warn({ chars: text.length }, 'used fill() fallback after typed attempts fell short');
  }

  /**
   * Watch GEICO's own API traffic.
   *
   * ------------------------------------------------------------------------
   * WHY THIS EXISTS
   * ------------------------------------------------------------------------
   * A run clicked "Log In" successfully — credentials verified 13/13, the right
   * button by label — and then sat on `/login` for the full 45s login timeout with
   * no navigation and no error text on the page. The failure bundle could say only
   * "still on /login", which is a symptom, not a cause.
   *
   * The page not changing has several possible explanations that look identical from
   * the DOM: the submit XHR was rejected by Imperva, it returned a validation error
   * the app rendered somewhere the text scrape missed, it never fired at all, or it
   * succeeded and the SPA failed to route. Only the network tells them apart.
   *
   * This is the technique that made the Progressive adapter tractable — drive the
   * DOM, read state from the network. GEICO's API is cleaner than Progressive's: a
   * small set of `/ws/` endpoints with a consistent envelope, so one status line
   * usually identifies the problem outright.
   *
   * Records status, method, path and `_messages` only. No bodies, no tokens, no
   * headers — these logs exist to be shared.
   */
  #installNetworkObserver() {
    this.page.on('response', async (res) => {
      const url = res.url();
      if (!/\/ws\//.test(url) || !/geico\.com/.test(url)) return;

      // Path only. Query strings on GEICO carry the policy token (F-37).
      let path = url;
      try { path = new URL(url).pathname; } catch { /* keep raw */ }

      const entry = { at: Date.now(), status: res.status(), method: res.request().method(), path };

      /**
       * Capture `_messages` when present, because that is where GEICO puts the
       * human-readable reason a call was refused — and a refusal is exactly the
       * case this observer exists for. Bounded, and never the payload.
       */
      if (/json/i.test(res.headers()['content-type'] || '')) {
        try {
          const body = await res.json();
          const msgs = body?._messages;
          if (Array.isArray(msgs) && msgs.length) entry.messages = msgs.slice(0, 4);
          if (body?._payload && typeof body._payload !== 'object') entry.payloadScalar = body._payload;
        } catch { /* streamed or consumed */ }
      }

      /**
       * Keep the request headers of any successful call to the documents host.
       *
       * ------------------------------------------------------------------------
       * WHY — a 401 that cookies alone cannot fix
       * ------------------------------------------------------------------------
       * `GET /ws/consolidated-documents` via `context.request` returned **401**, while
       * the same call from the app returned 200. The difference is the headers the
       * SPA sends:
       *
       *   edge-policy-token, sessionkey, x-xsrf-token,
       *   asd-current-state, asd-next-state, asd-source-application-id,
       *   geico-span-id, geico-root-span-id, geico-parent-span-id, ...
       *
       * `context.request` carries cookies and nothing else, which is F-10 on a second
       * carrier: cookies are not authentication. And `/ws/bootstrap` is called
       * separately on each host — `ecams`, `portfolio`, `edgecustomer` — so the
       * documents host has its own session that authenticating on `ecams` does not
       * confer.
       *
       * Rather than reverse-engineer how those values are minted, capture them from a
       * request the app itself made and reuse them. That is F-11's rule: copy
       * everything minus a small denylist, because an allowlist cannot guess a
       * vendor's private protocol — the Progressive adapter needed all 23 headers
       * including one nobody would have predicted.
       *
       * Values are held in memory only and NEVER logged. Only names are logged.
       */
      if (/edgecustomer\.geico\.com/.test(url) && res.status() < 400) {
        const raw = res.request().headers();
        const copied = {};
        for (const [k, v] of Object.entries(raw)) {
          // Denylist: values the transport must compute for the new request.
          if (/^(host|content-length|connection|accept-encoding|:|sec-fetch)/i.test(k)) continue;
          copied[k] = v;
        }
        this.#documentHeaders = copied;
      }

      /**
       * Harvest the document list the app fetched.
       *
       * The app does the auth work and we read the result — the same approach that
       * made Progressive tractable. Cheaper and more robust than replaying the call
       * ourselves, because it cannot drift from whatever the SPA decides to send.
       */
      if (/\/ws\/consolidated-documents(\?|$)/.test(url) && res.status() === 200) {
        try {
          const body = await res.json();
          if (body?._payload?.policyNumber) {
            this.#documentsPayload = body._payload;
            this.log.info(
              {
                policyDocuments: body._payload.policyDocuments?.length ?? 0,
                otherGroups: body._payload.otherPolicyDocuments?.length ?? 0,
                currentTerm: body._payload.currentTermEffectiveDate,
              },
              'harvested the document list from the app'
            );
          }
        } catch { /* consumed elsewhere; the poll will retry */ }
      }

      this.#apiCalls.push(entry);
      if (this.#apiCalls.length > 60) this.#apiCalls.shift();

      // Surface failures immediately; a 4xx here is usually the whole answer.
      if (res.status() >= 400) {
        this.log.warn(entry, 'GEICO API call failed');
      } else if (/login\/authenticate|mfa\/(options|otp)/.test(path)) {
        this.log.info(entry, 'GEICO auth API call');
      }
    });
  }

  /**
   * What the page shows, for a failure bundle.
   *
   * Captured on timeout because "still on /login" does not distinguish a rejected
   * submit from a rendered validation message the error-text patterns did not match.
   * Trimmed hard: Flutter's semantics tree duplicates content heavily.
   */
  async #pageSnapshotForDiagnostics() {
    try {
      const text = await visibleText(this.page, { limit: 1200 });
      const buttons = await this.page.evaluate(`(() => {
        const clean = (s) => (s || '').replace(/\\s+/g, ' ').trim();
        return [...document.querySelectorAll('flt-semantics[role="button"]')]
          .map((el) => clean(el.getAttribute('aria-label') || el.textContent))
          .filter((t) => t && t.length < 60).slice(0, 15);
      })()`).catch(() => []);
      return { text, buttons };
    } catch {
      return null;
    }
  }

  /** Populated as the flow progresses; surfaced in failure bundles. */
  #apiCalls = [];
  /**
   * Request headers observed on an authenticated documents-host call.
   *
   * Credential-equivalent — contains `cookie`, `sessionkey`, `edge-policy-token`
   * and `x-xsrf-token`. Held in memory for replay, never logged, never written to a
   * diagnostic bundle. Only the header NAMES ever appear in output.
   */
  #documentHeaders = null;
  /** The document list, harvested from the app's own fetch rather than replayed. */
  #documentsPayload = null;
  #mountMs = null;
  #mfaChannel = MfaChannel.UNKNOWN;
  #mfaMethodsOffered = [];
  #loginSubmittedAt = null;
  #documentDiagnostics = null;

  // -- login ----------------------------------------------------------------

  async login({ username, password } = {}) {
    const { page } = this;

    // Before any navigation, so the submit XHR cannot be missed.
    this.#installNetworkObserver();

    if (!username || !password) {
      throw new CarrierError('GEICO login called without credentials', {
        code: ErrorCodes.INVALID_CREDENTIALS,
        userMessage: 'A username and password are required.',
      });
    }

    /**
     * Skip the navigation when the page is already parked on the login form.
     *
     * Expressed as a question about the page rather than a flag passed down from
     * the orchestrator: "am I already where I need to be?" is true whether the
     * page came from the warm pool, a retry, or anywhere else. No plumbing, and
     * no way for a stale flag to disagree with reality.
     */
    await this.timings.measure('nav_login', async () => {
      const onLoginHost = /ecams\.geico\.com\/login/.test(page.url());
      const formPresent =
        onLoginHost &&
        (await page.locator(CREDENTIALS.password).count().catch(() => 0)) > 0;

      if (formPresent) {
        this.log.info({ url: scrubUrl(page.url()) }, 'login form already rendered; skipping navigation');
        // Internal: pre-warm adoption is a latency optimisation, not a user-visible step.
        this.notify('Reusing a pre-opened GEICO tab, skipping page load.', {}, { internal: true });
        return;
      }

      await page.goto(LOGIN_URL, {
        waitUntil: 'domcontentloaded',
        timeout: config.NAV_TIMEOUT_MS,
      });
    });

    /**
     * The Flutter mount, measured as its own phase.
     *
     * Named explicitly because it is the largest single controllable cost on
     * this carrier and because leaving it inside a composite is what hid the
     * equivalent Angular render on Progressive for most of the project (O-12).
     * An unmeasured cost cannot be argued about.
     */
    await this.timings.measure('await_login_form', async () => {
      const { mountMs } = await waitForFlutterMount(page, {
        readySelector: CREDENTIALS.password,
        timeout: 30_000,
        log: this.log,
      });
      this.#mountMs = mountMs;
      if (mountMs > 3000) {
        this.notify('GEICO\'s login app took a moment to load.', { mountMs });
      }
    });

    // Cheap, and converts a 20s selector timeout into an accurate error.
    await this.assertNotBlocked();

    // Before typing: an overlay that covers the form intercepts pointer events.
    await dismissCookieBanner(page, { log: this.log });

    await this.timings.measure('fill_credentials', async () => {
      const userField = await this.firstVisible(
        [CREDENTIALS.username, CREDENTIALS.usernameFallback],
        { timeout: 8000 }
      );
      const passField = await this.firstVisible(
        [CREDENTIALS.password, CREDENTIALS.passwordFallback],
        { timeout: 8000 }
      );

      if (!userField || !passField) {
        throw new CarrierError('GEICO credential fields not found after mount', {
          code: ErrorCodes.SELECTOR_DRIFT,
          userMessage: 'GEICO\'s sign-in form was not in the expected shape. Their page may have changed.',
        });
      }

      await this.typeLikeHuman(userField, username);
      await this.typeLikeHuman(passField, password);

      /**
       * Verify the fields actually hold what we typed.
       *
       * The O-5 lesson applied at the point it matters most. Flutter routes input
       * through its own event system, and a `type()` that resolves is not
       * evidence the framework accepted the text. Catching it here produces an
       * accurate error; not catching it produces a mysterious "invalid
       * credentials" from GEICO three seconds later.
       */
      const typedUser = await userField.inputValue().catch(() => '');
      const typedPass = await passField.inputValue().catch(() => '');
      if (typedUser.length !== username.length || typedPass.length !== password.length) {
        throw new CarrierError(
          `credential fields did not accept input (user ${typedUser.length}/${username.length}, `
            + `pass ${typedPass.length}/${password.length})`,
          {
            code: ErrorCodes.SELECTOR_DRIFT,
            userMessage: 'GEICO\'s sign-in form did not accept the typed credentials. Please try again.',
          }
        );
      }
      // Lengths only — never the values. These logs are written to be shared.
      this.log.info(
        { usernameChars: typedUser.length, passwordChars: typedPass.length },
        'credentials entered and verified'
      );
    });

    return this.timings.measure('submit_credentials', async () => {
      this.#loginSubmittedAt = Date.now();
      await clickFlutterButton(page, BUTTON_TEXT.login, { log: this.log });
      this.notify('Signing in to GEICO…');
      return this.#awaitPostLogin();
    });
  }

  /**
   * Work out what happened after the credential submit.
   *
   * Raced rather than waited on sequentially. After a submit the next screen is
   * genuinely non-deterministic — method chooser, code entry, an inline
   * credential error, a lockout, or a bot wall — and waiting for the hoped-for
   * one means every other branch costs a full timeout and then reports the wrong
   * cause.
   *
   * GEICO's ordering is documented but unverified, so this treats *both* the
   * method chooser and a direct code prompt as valid first screens rather than
   * assuming the chooser always appears.
   */
  async #awaitPostLogin() {
    const { page } = this;

    const { outcome, elapsedMs } = await this.raceOutcomes(
      {
        credentialError: async (p) => {
          const text = await visibleText(p, { limit: 2500 });
          return LOGIN_ERROR_TEXT.some((re) => re.test(text));
        },
        /**
         * Screens are identified by ROUTE, not by DOM presence.
         *
         * ------------------------------------------------------------------------
         * WHY — this cost a real failed run, and no code was ever sent
         * ------------------------------------------------------------------------
         * The first version detected the code screen by looking for the code field
         * via `MFA.codeInput`. That list was then changed (correctly) to lead with
         * `input[data-semantics-role="text-field"]`, because that is the only
         * attribute the code field keeps across Flutter's focus swap.
         *
         * But the LOGIN page's username and password inputs carry the same
         * attribute. So the instant credentials were submitted — while still on
         * `/login` — `codeEntry` matched:
         *
         *     post-login outcome  outcome:"codeEntry"  elapsedMs:126
         *
         * The adapter concluded the code screen was already up, skipped
         * `#chooseMfaMethod()`, and therefore never clicked "Next". GEICO was never
         * asked to send anything, and the run sat for 90 seconds waiting on a code
         * that had not been requested, then failed `MFA_REQUIRED_TIMEOUT`.
         *
         * This is the O-13 lesson exactly: a change was made for one reader
         * (`submitMfa`, where the generic selector is right because the code field
         * is the only text-field on `/mfa/pin`) without enumerating the other reader
         * (this race, where it is catastrophically ambiguous).
         *
         * GEICO gives unambiguous routes — `/mfa/options` and `/mfa/pin`, both
         * verified from the recording — so they are the discriminator. DOM checks
         * remain only as a secondary signal, and are scoped so they cannot match the
         * login form.
         */
        methodChooser: async (p) => {
          if (new RegExp(`${ROUTES.mfaOptions}(\\?|$|/)`).test(p.url())) return true;
          // Secondary: chooser copy. Deliberately not a field-presence check.
          const text = await visibleText(p, { limit: 2500 });
          return /how (would|do) you want|choose .*(verification|method)|where should we send/i.test(text);
        },

        codeEntry: async (p) => {
          if (new RegExp(`${ROUTES.mfaPin}(\\?|$|/)`).test(p.url())) return true;
          /**
           * Secondary signal, scoped so it cannot fire on the login form.
           *
           * `aria-label="Verification code"` is unique to the code screen in the
           * pre-focus state, and the "Submit Code" button is unique to it in both.
           * Neither exists on `/login`. The generic `text-field` selector is
           * deliberately NOT used here.
           */
          const aria = p.locator('input[aria-label="Verification code"]').first();
          if ((await aria.count().catch(() => 0)) > 0) return true;
          const id = p.locator('#one-time-code').first();
          if ((await id.count().catch(() => 0)) > 0) return true;
          return false;
        },

        /**
         * Authenticated means off the auth host entirely.
         *
         * The previous test — "not /login but still on ecams" — was satisfied by
         * `/mfa/options` and `/mfa/pin`, both of which live on `ecams.geico.com`.
         * It could therefore have reported success while sitting on a challenge
         * screen. The recording shows a real post-auth landing on
         * `portfolio.geico.com`, so that is the signal.
         */
        authenticated: async (p) =>
          /portfolio\.geico\.com|edgecustomer\.geico\.com/.test(p.url()),
      },
      { timeout: config.LOGIN_TIMEOUT_MS }
    ).catch(async (err) => {
      /**
       * Turn "nothing happened" into something actionable.
       *
       * The bare timeout said only "still on /login". These two additions name the
       * cause in most cases: a 4xx on `/ws/login/authenticate` means the submit was
       * refused, no such call at all means the click never reached Flutter, and a
       * 200 means the app accepted it and failed to route.
       */
      const snap = await this.#pageSnapshotForDiagnostics();
      const auth = this.#apiCalls.filter((c) => /login\/authenticate/.test(c.path));
      this.log.error(
        {
          url: scrubUrl(page.url()),
          apiCalls: this.#apiCalls.slice(-12),
          authenticateCalls: auth,
          pageButtons: snap?.buttons,
          pageText: snap?.text?.slice(0, 600),
        },
        'post-login raced to nothing — full evidence'
      );

      /**
       * Classify by status, including 3xx.
       *
       * The first version of this tested `status >= 400` for "refused" and called
       * everything else "accepted" — so a **302** was reported to the user as
       * "GEICO accepted the sign-in request". It had not. That is a diagnostic
       * naming an outcome it had not tested for, the F-32 rule broken inside the
       * very code written to diagnose a failure.
       *
       * A 3xx on this endpoint is specifically meaningful. In a captured manual
       * session that succeeded, `/ws/login/authenticate` returned **200**, and the
       * only 3xx responses anywhere in 677 captured responses were ad-tracking
       * pixels — never a GEICO `/ws/` endpoint. So a redirect here means GEICO is
       * treating this request differently from a browser it accepts, which on a
       * site fronted by Imperva points at the anti-bot layer rather than at
       * credentials.
       */
      const redirect = auth.find((c) => c.status >= 300 && c.status < 400);
      const refused = auth.find((c) => c.status >= 400);
      const diagnosis = auth.length === 0
        ? 'GEICO never received the sign-in request, so the button press did not reach their app.'
        : refused
          ? `GEICO refused the sign-in request (HTTP ${refused.status}).`
          : redirect
            ? `GEICO redirected the sign-in request (HTTP ${redirect.status}) instead of accepting it. `
              + 'A working session returns 200 here, so this is most likely their bot protection '
              + 'rather than your credentials.'
            : 'GEICO accepted the sign-in request (HTTP 200) but never moved to the next screen.';

      throw new CarrierError(
        `${err.message} | authenticate calls: ${JSON.stringify(auth)} | url: ${scrubUrl(page.url())}`,
        { code: ErrorCodes.TIMEOUT, userMessage: `${diagnosis} Please try again.`, cause: err }
      );
    });

    this.log.info({ outcome, elapsedMs }, 'post-login outcome');

    if (outcome === 'credentialError') {
      // Distinguish a lockout from a typo: they need different user actions.
      const text = await visibleText(page, { limit: 2500 });
      const locked = /locked|disabled/i.test(text);
      throw new CarrierError(locked ? 'GEICO account locked' : 'GEICO rejected the credentials', {
        code: locked ? ErrorCodes.ACCOUNT_LOCKED : ErrorCodes.INVALID_CREDENTIALS,
        userMessage: locked
          ? 'GEICO has locked this account. You will need to unlock it with GEICO directly.'
          : 'GEICO did not accept that username and password.',
      });
    }

    if (outcome === 'authenticated') {
      /**
       * Device trust: GEICO remembered this browser and skipped the challenge.
       *
       * This is a legitimate fast path, not an anomaly. An earlier version logged a
       * warning here claiming it "contradicts F-33" — F-33 was wrong, having read
       * GEICO's marketing FAQ as a statement about capability. See the note on
       * `supportsSessionReuse`.
       *
       * Worth a `notify` because the difference is dramatic from the user's side:
       * no code to wait for, which turns a ~30s human round-trip into nothing.
       */
      this.log.info({ url: scrubUrl(page.url()) }, 'GEICO skipped 2SV — this device is trusted');
      this.notify('GEICO recognised this device, so no verification code is needed.');
      return { mfaRequired: false };
    }

    if (outcome === 'methodChooser') {
      await this.#chooseMfaMethod();
    }

    // Ask GEICO which channel it actually used rather than assuming ours took.
    await this.#readActualChannel();

    return {
      mfaRequired: true,
      channel: this.#mfaChannel,
      hint: this.#mfaChannel === MfaChannel.EMAIL
        ? 'GEICO is emailing you a verification code.'
        : 'GEICO is texting you a verification code.',
    };
  }

  /**
   * Pick a 2SV delivery channel.
   *
   * GEICO asks every login (F-33). The choice is auto-made from
   * `GEICO_MFA_METHOD` rather than surfaced as a second modal — a deliberate
   * simplification recorded in F-33, not an oversight. Rationale: the flow
   * already carries one unavoidable human round-trip, and a second doubles the
   * places it can stall waiting on someone. The offered methods are captured
   * either way, so promoting this to a UI choice later is additive.
   *
   * The known failure mode is stated rather than hidden: if the account has only
   * an email on file and the configured preference is SMS, this reports what it
   * could not find instead of timing out on the code field.
   */
  async #chooseMfaMethod() {
    const { page } = this;
    const preferred = config.GEICO_MFA_METHOD;

    /**
     * Read the real destinations from the API, not the DOM.
     *
     * `/ws/mfa/options` returns them directly with GEICO's own masking:
     *   emails:       [{ label: "rc***@gmail.com",  value: "<uuid>" }]
     *   phoneNumbers: [{ label: "(XXX)XXX-5116",    value: "<uuid>" }]
     *
     * Far better than scraping: the labels are pre-masked so they are safe to log
     * and to show a user, and having the exact label is what makes finding the
     * matching DOM node reliable instead of a guess at a regex.
     */
    const destinations = await this.#fetchMfaDestinations();
    this.#mfaMethodsOffered = [
      ...destinations.phoneNumbers.map((d) => `sms:${d.label}`),
      ...destinations.emails.map((d) => `email:${d.label}`),
    ];
    this.log.info(
      { preferred, offered: this.#mfaMethodsOffered },
      'GEICO 2SV destinations, from /ws/mfa/options'
    );

    const wanted = preferred === 'email' ? destinations.emails : destinations.phoneNumbers;
    const fallback = preferred === 'email' ? destinations.phoneNumbers : destinations.emails;

    if (!wanted.length && !fallback.length) {
      throw new CarrierError('GEICO offered no 2SV destinations', {
        code: ErrorCodes.SELECTOR_DRIFT,
        userMessage: 'GEICO did not offer anywhere to send a verification code.',
      });
    }

    /**
     * Fall back to the other channel rather than failing.
     *
     * If the policy has no mobile on file and `GEICO_MFA_METHOD=sms`, sending to the
     * email on file is obviously better than an error. Announced in the status
     * stream so the user knows where to look.
     */
    const target = wanted.length ? wanted[0] : fallback[0];
    const usingPreferred = wanted.length > 0;
    if (!usingPreferred) {
      this.log.warn({ preferred }, 'preferred 2SV channel unavailable; using the other one');
    }

    /**
     * Wait for the options to actually render before trying to click one.
     *
     * ------------------------------------------------------------------------
     * WHY — a 14ms race that cost a full run
     * ------------------------------------------------------------------------
     * A run failed with "the choice could not be made automatically", and the DOM dump
     * showed why:
     *
     *   "MFA Options Page"
     *   "This could take up to a minute. Thanks for your patience!"
     *
     * The page was still loading. The log timing:
     *
     *   01:17:22.479  2SV destinations, from /ws/mfa/options
     *   01:17:22.493  could not select a 2SV destination      <- 14ms later
     *
     * All four strategies ran and found nothing because the radio list had not
     * rendered. The `methodChooser` outcome resolves on the URL matching
     * `/mfa/options`, which is true the instant navigation completes — long before
     * Flutter paints the options.
     *
     * This is F-32's lesson unapplied. `waitForFlutterMount()` exists precisely
     * because this app renders late, and it was wired into the login form and nowhere
     * else. Every Flutter screen needs the same treatment, and GEICO says so on the
     * page itself: "this could take up to a minute".
     *
     * The wait is generous for that reason, and it polls for the destination rather
     * than a fixed sleep, so a fast render costs nothing.
     */
    const ready = await this.#waitForChooserOptions(target.label, { timeout: 45_000 });
    if (!ready) {
      this.log.warn({ target: target.label }, 'chooser options never rendered; attempting selection anyway');
    }

    /**
     * Select it, then VERIFY via "Next" becoming enabled.
     *
     * The previous version attempted a click, could not tell whether it worked, and
     * clicked "Next" regardless — while "Next" was `aria-disabled="true"` because
     * nothing had been selected. The run then sat on the chooser until the MFA
     * timeout and the code was never sent. An action followed by an unverified claim
     * of success: the O-5 shape.
     *
     * GEICO disables "Next" until a destination is chosen, so its enabled state is a
     * true postcondition. Strategies are tried in order and each is checked.
     */
    const strategies = [
      { name: 'exact label match', run: () => this.#clickChooserOption({ exact: target.label }) },
      { name: 'label substring', run: () => this.#clickChooserOption({ contains: target.label }) },
      { name: 'last 4 digits', run: () => this.#clickChooserOption({ contains: target.label.replace(/\D/g, '').slice(-4) }) },
      { name: 'radio role, by index', run: () => this.#clickChooserOption({ radioIndex: usingPreferred && preferred === 'email' ? 0 : 0 }) },
    ];

    let selected = false;
    for (const s of strategies) {
      const clicked = await s.run().catch(() => false);
      if (!clicked) continue;
      await page.waitForTimeout(350);
      if (await this.#isAdvanceEnabled()) {
        selected = true;
        this.log.info({ strategy: s.name, label: target.label }, 'selected 2SV destination (Next enabled)');
        break;
      }
      this.log.warn({ strategy: s.name }, 'clicked a chooser option but Next stayed disabled');
    }

    if (!selected) {
      /**
       * Already enabled? Then GEICO pre-selected something and we can proceed.
       * Checked before failing so a pre-selected default is not treated as an error.
       */
      if (await this.#isAdvanceEnabled()) {
        this.log.info('Next already enabled; GEICO pre-selected a destination');
        selected = true;
      } else {
        // Dump the tree so the next run does not need another round of guessing.
        const controls = await this.#readChooserControls();
        this.log.error(
          { preferred, target: target.label, controls },
          'could not select a 2SV destination — full chooser DOM'
        );
        throw new CarrierError(
          `could not select a 2SV destination (wanted ${target.label}); Next remained disabled`,
          {
            code: ErrorCodes.SELECTOR_DRIFT,
            userMessage:
              'GEICO asked where to send the verification code and the choice could not be made '
              + 'automatically. Their page layout has probably changed.',
          }
        );
      }
    }

    this.#mfaChannel = (usingPreferred ? preferred : (preferred === 'email' ? 'sms' : 'email')) === 'email'
      ? MfaChannel.EMAIL
      : MfaChannel.SMS;

    // "Next" advances to /mfa/pin, and is only clicked once it is actually enabled.
    await clickFlutterButton(page, MFA.chooserAdvanceText[0], { log: this.log, timeout: 6000 });

    this.notify(
      this.#mfaChannel === MfaChannel.EMAIL
        ? `Asked GEICO to email a code to ${target.label}.`
        : `Asked GEICO to text a code to ${target.label}.`
    );
  }

  /**
   * Destinations from `/ws/mfa/options`, via the authenticated context.
   *
   * Labels are already masked by GEICO (`rc***@gmail.com`, `(XXX)XXX-5116`), so they
   * are safe to log and to show. The `value` UUIDs are never needed for a DOM click
   * and are deliberately not retained.
   */
  async #fetchMfaDestinations() {
    const empty = { emails: [], phoneNumbers: [] };
    try {
      const res = await this.context.request.get(
        `https://${HOSTS.auth}${ENDPOINTS.mfaOptions}`,
        { timeout: 10_000 }
      );
      if (!res.ok()) return empty;
      const p = (await res.json())?._payload ?? {};
      return {
        emails: Array.isArray(p.emails) ? p.emails.filter((x) => x?.label) : [],
        phoneNumbers: Array.isArray(p.phoneNumbers) ? p.phoneNumbers.filter((x) => x?.label) : [],
      };
    } catch {
      return empty;
    }
  }

  /**
   * Click a chooser option.
   *
   * Clicks by coordinate rather than `el.click()`. Flutter's semantics nodes are an
   * accessibility overlay above its own render surface, and a synthetic DOM click on
   * the overlay is not always routed into the framework's gesture system — the same
   * reason `clickFlutterButton` uses `page.mouse.click` on a verified rect.
   */
  async #clickChooserOption({ exact, contains, radioIndex }) {
    const spec = JSON.stringify({ exact: exact ?? null, contains: contains ?? null, radioIndex: radioIndex ?? null });
    const hit = await this.page
      .evaluate(`((spec) => {
        const clean = (s) => (s || '').replace(/\\s+/g, ' ').trim();
        const nodes = [...document.querySelectorAll(
          'flt-semantics, [role="radio"], [role="option"], [role="menuitemradio"], [role="checkbox"], label'
        )];
        const sized = nodes.filter((el) => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        });

        let el = null;
        if (spec.exact) {
          el = sized.find((n) => clean(n.getAttribute('aria-label') || n.textContent) === spec.exact);
        } else if (spec.contains) {
          el = sized.find((n) => clean(n.getAttribute('aria-label') || n.textContent).includes(spec.contains));
        } else if (spec.radioIndex !== null) {
          const radios = sized.filter((n) =>
            ['radio', 'option', 'menuitemradio', 'checkbox'].includes(n.getAttribute('role'))
            || n.hasAttribute('aria-checked'));
          el = radios[spec.radioIndex] ?? null;
        }
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return {
          label: clean(el.getAttribute('aria-label') || el.textContent).slice(0, 60),
          role: el.getAttribute('role'),
          x: r.x + r.width / 2,
          y: r.y + r.height / 2,
        };
      })(${spec})`)
      .catch(() => null);

    if (!hit) return false;
    await this.page.mouse.click(hit.x, hit.y);
    this.log.info({ label: hit.label, role: hit.role }, 'clicked chooser option');
    return true;
  }

  /**
   * Read the channel GEICO actually used.
   *
   * `/ws/mfa/otp/init` reports `mfaVerificationType` (observed: `"TextMessage"`).
   * Worth reading rather than assuming, because the chooser selection may not have
   * taken — this is how the adapter tells the user where to look, truthfully.
   */
  async #readActualChannel() {
    try {
      const res = await this.context.request.get(
        `https://${HOSTS.auth}${ENDPOINTS.otpInit}`,
        { timeout: 8000 }
      );
      if (!res.ok()) return null;
      const t = (await res.json())?._payload?.mfaVerificationType ?? null;
      if (!t) return null;
      this.#mfaChannel = /email/i.test(t) ? MfaChannel.EMAIL : MfaChannel.SMS;
      this.log.info({ mfaVerificationType: t }, 'GEICO reported the 2SV channel used');
      return t;
    } catch {
      return null;
    }
  }

  /**
   * Every candidate control on the chooser, with enough detail to pick one.
   *
   * The previous version queried only `flt-semantics[role="button"]` and therefore
   * reported `["Español", "Menu"]` — navigation chrome — while the actual phone and
   * email choices went unseen. Flutter does not render selectable options as
   * buttons; they carry radio-ish roles or none at all.
   *
   * So this enumerates the whole semantics tree with roles, checked state and
   * geometry. It is the diagnostic that makes the chooser solvable rather than
   * guessable, and it is logged when selection fails so a single run identifies the
   * right target.
   */
  async #readChooserControls() {
    return this.page
      .evaluate(`(() => {
        const clean = (s) => (s || '').replace(/\\s+/g, ' ').trim();
        const out = [];
        const nodes = document.querySelectorAll(
          'flt-semantics, [role="radio"], [role="option"], [role="menuitemradio"], [role="checkbox"], label, li'
        );
        for (const el of nodes) {
          const label = clean(el.getAttribute('aria-label') || el.textContent);
          if (!label || label.length > 90) continue;
          const r = el.getBoundingClientRect();
          out.push({
            tag: el.tagName.toLowerCase(),
            role: el.getAttribute('role') || null,
            label,
            ariaChecked: el.getAttribute('aria-checked'),
            ariaSelected: el.getAttribute('aria-selected'),
            ariaDisabled: el.getAttribute('aria-disabled'),
            hasSize: r.width > 0 || r.height > 0,
            x: Math.round(r.x + r.width / 2),
            y: Math.round(r.y + r.height / 2),
          });
        }
        return out.slice(0, 60);
      })()`)
      .catch(() => []);
  }

  /**
   * Bootstrap the documents host and read the list, without loading its app.
   *
   * Returns the payload, or `null` for any reason at all — the caller falls back to
   * navigation, so being wrong here is cheap and being right saves ~4.5s.
   *
   * Every failure path returns null rather than throwing. An optimisation that can turn a
   * working pull into a failed one is not worth having, and this one is strictly optional.
   */
  async #tryDirectDocumentList(handoff) {
    const started = Date.now();
    const qs = handoff.toString();

    /**
     * Snapshot the documents origin's own cookies so a failed probe can be undone.
     *
     * O-6's lesson, applied before it bites: `context.request` shares the browser's cookie
     * jar, so a probe that half-succeeds can leave `edgecustomer` holding a session the
     * page never asked for — and the page would then adopt it on navigation. That is the
     * one way this "free" optimisation could turn a working pull into a failed one, which
     * is precisely what the method promises it cannot do. Snapshot, then roll back on any
     * non-success, so the promise is enforced by code instead of assumed.
     *
     * Scoped deliberately to host-only cookies. Cookies on the parent `.geico.com` are
     * shared with the authenticated login host, so clearing those to tidy up a failed
     * probe would risk destroying the very session we are trying to protect. Restoring
     * less than everything, in the safe direction, beats restoring too much.
     */
    const hostPattern = new RegExp(`^\\.?${HOSTS.documents.replace(/\./g, '\\.')}$`);
    const isHostScoped = (c) => hostPattern.test(c.domain || '');
    let snapshot = null;
    try {
      snapshot = (await this.context.cookies(`https://${HOSTS.documents}`)).filter(isHostScoped);
    } catch {
      // No snapshot means no rollback. Still worth attempting the probe; we just lose the
      // undo, so record that the guarantee is weaker for this run.
      snapshot = null;
    }

    const rollback = async () => {
      if (!snapshot) return;
      try {
        const now = (await this.context.cookies(`https://${HOSTS.documents}`)).filter(isHostScoped);
        // Nothing changed: skip the clear entirely rather than churn the jar for no reason.
        if (JSON.stringify(now) === JSON.stringify(snapshot)) return;
        await this.context.clearCookies({ domain: hostPattern });
        if (snapshot.length) await this.context.addCookies(snapshot);
        this.log.info({ restored: snapshot.length }, 'rolled back the documents-host cookies left by the direct probe');
      } catch (err) {
        this.log.warn(
          { err: err.message.split('\n')[0] },
          'could not roll back the documents-host cookies; the page navigation below is now the recovery path'
        );
      }
    };

    try {
      /**
       * Bootstrap first. Every GEICO host calls `POST /ws/bootstrap` before anything else,
       * on `ecams`, `portfolio` and `edgecustomer` alike — it is how each origin establishes
       * its own session. Skipping it is why a cold `GET /ws/consolidated-documents`
       * previously returned 401.
       */
      const boot = await this.context.request.post(
        `https://${HOSTS.documents}/ws/bootstrap${qs ? `?${qs}` : ''}`,
        { timeout: 10_000, data: {} }
      );
      if (!boot.ok()) {
        this.log.info({ status: boot.status(), ms: Date.now() - started }, 'direct bootstrap declined; using the documents page');
        await rollback();
        return null;
      }

      const res = await this.context.request.get(
        `https://${HOSTS.documents}${ENDPOINTS.consolidatedDocuments}${qs ? `?${qs}` : ''}`,
        { timeout: 12_000 }
      );
      if (!res.ok()) {
        this.log.info({ status: res.status(), ms: Date.now() - started }, 'direct document list declined; using the documents page');
        await rollback();
        return null;
      }

      const payload = (await res.json())?._payload;
      /**
       * Require a `policyNumber`, not merely a 200.
       *
       * F-13's lesson generalised: a success status is not evidence of a useful body. A
       * bootstrap-only response could easily return 200 with an empty or partial payload,
       * and accepting it would produce a "no documents found" failure that looks like an
       * account problem rather than a shortcut that did not work.
       */
      if (!payload?.policyNumber) {
        this.log.info({ ms: Date.now() - started }, 'direct call returned 200 without a policy; using the documents page');
        await rollback();
        return null;
      }

      this.log.info(
        {
          ms: Date.now() - started,
          policyDocuments: payload.policyDocuments?.length ?? 0,
          savedApproxMs: 4500,
        },
        'DIRECT document list succeeded — skipped the documents app boot'
      );
      return payload;
    } catch (err) {
      this.log.info({ err: err.message.split('\n')[0], ms: Date.now() - started }, 'direct document list attempt failed; using the documents page');
      await rollback();
      return null;
    }
  }

  /**
   * Pull the cross-host hand-off parameters out of a URL.
   *
   * GEICO moves authority between `portfolio` and `edgecustomer` by query string. The
   * captured manual session carried `token`, `visitAppId` and `convToken`; only the
   * first is load-bearing, but all three are forwarded because reproducing the
   * browser's request exactly is cheaper than working out which ones matter.
   *
   * Returns a `URLSearchParams` so the caller cannot accidentally interpolate a raw
   * token into a string, and so the values are encoded correctly.
   */
  #extractHandoffParams(currentUrl) {
    const out = new URLSearchParams();
    try {
      const src = new URL(currentUrl).searchParams;
      for (const key of ['token', 'visitAppId', 'convToken']) {
        const v = src.get(key);
        // `convToken` is legitimately empty in captured traffic; forward it as seen.
        if (v !== null) out.set(key, v);
      }
    } catch {
      // Unparseable URL: return empty and let the caller navigate bare.
    }
    return out;
  }

  /**
   * Poll until the chooser's destination options have rendered.
   *
   * Readiness is "an element bearing the destination is on screen with a non-zero
   * box", which is the thing selection actually needs. Three weaker signals were
   * rejected:
   *
   *  - *The URL.* Already true on arrival — that is what caused the race.
   *  - *"Next" existing.* It renders with the page chrome, before the options.
   *  - *A fixed sleep.* GEICO's own copy says "up to a minute", so any sleep short
   *    enough to be acceptable is too short to be reliable.
   *
   * Matches on the last four digits rather than the whole label, because GEICO's DOM
   * need not format a destination the way its API does — `(XXX)XXX-5116` in JSON could
   * render as `(XXX) XXX-5116` or with bullet masking. The last four digits are the
   * part that has to be shown to a human for the choice to be meaningful.
   *
   * Also watches for the loading message as an explicit negative, so the wait is
   * reported honestly rather than as an unexplained timeout.
   */
  async #waitForChooserOptions(label, { timeout = 45_000 } = {}) {
    const tail = String(label).replace(/\D/g, '').slice(-4);
    const needle = tail.length === 4 ? tail : String(label).slice(-6);
    const started = Date.now();
    let sawLoading = false;

    while (Date.now() - started < timeout) {
      const state = await this.page
        .evaluate(`((needle) => {
          const clean = (s) => (s || '').replace(/\\s+/g, ' ').trim();
          let found = false;
          let loading = false;
          const nodes = document.querySelectorAll(
            'flt-semantics, [role="radio"], [role="option"], [role="menuitemradio"], [role="checkbox"], label'
          );
          for (const el of nodes) {
            const t = clean(el.getAttribute('aria-label') || el.textContent);
            if (!t) continue;
            if (/take up to a minute|thanks for your patience/i.test(t)) loading = true;
            const r = el.getBoundingClientRect();
            // Require a leaf-ish node: Flutter's parents concatenate all child text,
            // so a huge label containing the needle is the page, not the option.
            if (t.includes(needle) && t.length < 60 && (r.width > 0 || r.height > 0)) found = true;
          }
          return { found, loading };
        })(${JSON.stringify(needle)})`)
        .catch(() => ({ found: false, loading: false }));

      if (state.found) {
        this.log.info(
          { waitedMs: Date.now() - started, needle, sawLoading },
          'chooser destinations rendered'
        );
        return true;
      }
      if (state.loading && !sawLoading) {
        sawLoading = true;
        this.log.info('GEICO is still preparing the verification options');
        this.notify('GEICO is preparing your verification options…');
      }
      await this.page.waitForTimeout(400);
    }

    this.log.warn(
      { timeout, needle, sawLoading },
      sawLoading
        ? 'chooser still showed a loading message when the wait expired'
        : 'chooser destinations never appeared and no loading message was seen'
    );
    return false;
  }

  /**
   * Is the chooser's "Next" enabled?
   *
   * GEICO disables it until a destination is selected — observed as
   * `aria-disabled="true"` on a run where nothing had been chosen. That makes it a
   * genuine postcondition for "did the selection take", which is exactly what the
   * previous implementation lacked: it clicked Next regardless, logged a warning,
   * and left the run parked on the chooser for the full MFA timeout.
   */
  async #isAdvanceEnabled() {
    const btn = await findFlutterButton(this.page, MFA.chooserAdvanceText[0]);
    if (!btn) return false;
    return btn.ariaDisabled !== 'true';
  }

  // -- MFA ------------------------------------------------------------------

  async submitMfa(code) {
    const { page } = this;

    /**
     * NOT wrapped in a `mfa_submit` phase.
     *
     * `pullSession` already measures this exact span as `mfa_submit_${attempt}`, and the
     * metrics store normalises that attempt suffix back to `mfa_submit`. Wrapping it here
     * too produced **two identical 1,949ms entries** in one run — the same span counted
     * twice, inflating the leaf sum by 1.9s and doubling the sample count for that phase
     * in the aggregates.
     *
     * Progressive does not wrap it, which is why only GEICO showed the duplicate. The
     * outer measurement is the right one: it covers the retry loop, so it survives a
     * rejected code where an inner phase would record only the last attempt.
     *
     * The body is written INLINE, deliberately. Removing the `#timings.measure()` call
     * left the `(async () => { … })` closure it used to receive, and the invoking `()`
     * went with the wrapper — so this method returned a *function object* instead of
     * running anything. No field lookup, no typing, no submit, no log lines, and
     * `#runMfaLoop` read the non-null return as a rejected code. See F-53. A bare IIFE
     * that wraps an entire method body earns nothing and hides that failure mode, so
     * there is no wrapper here to lose parentheses from.
     */

    /**
     * Generous, for the same reason as the chooser wait.
     *
     * 8s was the original ceiling and it is the same mistake the chooser race made:
     * this is a Flutter screen that renders late, and GEICO tells you so on the
     * page — "this could take up to a minute". By the time this runs the user has
     * already received a code and is typing it, so a short timeout here fails a run
     * that was seconds from succeeding, which is the worst possible moment to give
     * up.
     *
     * Polling means a fast render still costs nothing.
     */
    const field = await this.firstVisible(MFA.codeInput, { timeout: 45_000 });
    if (!field) {
      throw new CarrierError('GEICO 2SV code field not found', {
        code: ErrorCodes.SELECTOR_DRIFT,
        userMessage: 'GEICO\'s verification screen did not finish loading. Please try again.',
      });
    }

    await field.fill('').catch(() => {});
    await this.typeLikeHuman(field, code);

    /**
     * Snapshot the page text BEFORE submitting.
     *
     * F-16 and O-6 are the same mistake in two directions: resolving a wait, or
     * a decision, against state that predates the action. If a rejection
     * message from a previous attempt is already on screen, matching it after
     * this submit would report a correct code as wrong. So the pre-submit text
     * is captured and only *new* rejection copy counts.
     */
    const before = await visibleText(page, { limit: 2500 });

    // Some layouts submit on Enter without a visible button; try the button
    // first, fall back to Enter, and do not treat a missing button as fatal.
    let clicked = false;
    for (const re of MFA.submitText) {
      try {
        await clickFlutterButton(page, re, { log: this.log, timeout: 2000 });
        clicked = true;
        break;
      } catch {
        /* fall through */
      }
    }
    if (!clicked) {
      this.log.info('no 2SV submit button matched; pressing Enter');
      await field.press('Enter');
    }

    this.log.info({ clicked, codeChars: code.length }, 'GEICO 2SV code submitted; awaiting outcome');
    return this.#awaitMfaOutcome(before);
  }

  /**
   * Decide whether the code was accepted.
   *
   * Both branches are evaluated on every tick rather than checking one first.
   * Checking acceptance first means a rejected code waits out the whole timeout
   * before the user is told; checking rejection first risks matching stale copy.
   * Racing them, against a pre-submit text snapshot, avoids both.
   */
  async #awaitMfaOutcome(textBeforeSubmit) {
    const { page } = this;

    const { outcome, elapsedMs } = await this.raceOutcomes(
      {
        rejected: async (p) => {
          const now = await visibleText(p, { limit: 2500 });
          if (now === textBeforeSubmit) return false;
          return MFA.rejectionText.some((re) => re.test(now) && !re.test(textBeforeSubmit));
        },
        /**
         * Accepted means we left the auth host, not merely that we left /login.
         *
         * The same defect as in `#awaitPostLogin`: `!/\/login/ && /ecams/` is TRUE
         * on `/mfa/pin`, which is where we are standing when this runs. It would
         * have reported the code accepted on the first poll, before GEICO had
         * validated anything — turning a wrong code into a silent failure two phases
         * later. Landing on `portfolio.geico.com` is the real evidence.
         */
        accepted: async (p) => /portfolio\.geico\.com|edgecustomer\.geico\.com/.test(p.url()),
      },
      { timeout: 30_000 }
    ).catch((err) => {
      this.log.warn({ err: err.message }, '2SV outcome undetermined within timeout');
      return { outcome: 'undetermined', elapsedMs: 30_000 };
    });

    this.log.info({ outcome, elapsedMs, url: scrubUrl(page.url()) }, '2SV outcome');

    if (outcome === 'rejected') {
      return { accepted: false, retryable: true };
    }
    if (outcome === 'undetermined') {
      throw new CarrierError('GEICO did not respond to the verification code', {
        code: ErrorCodes.MFA_REQUIRED_TIMEOUT,
        userMessage: 'GEICO did not respond after the code was submitted. Please start over.',
      });
    }
    return { accepted: true };
  }

  // -- documents ------------------------------------------------------------

  /**
   * Retrieve the policy document.
   *
   * Built from a recorded real session (F-37). Two things this deliberately does
   * NOT do, each because the obvious approach is wrong:
   *
   * - It does not navigate to the document and read the page. Chrome hands PDFs
   *   to its internal viewer and the response never surfaces to Playwright
   *   (F-36), so the bytes are fetched through `context.request`, which shares
   *   the session cookies.
   * - It does not use `submit-policy-document`, which is the *email* path and
   *   answers `_payload: true` with no document at all.
   */
  async fetchDocuments() {
    const payload = await this.timings.measure('list_documents', () =>
      this.#obtainDocumentList()
    );

    const { chosen, diagnostics } = selectDocument(payload, config.DOCUMENT_TARGET);
    this.#documentDiagnostics = diagnostics;
    this.log.info(diagnostics, 'GEICO document selection');

    if (!chosen.length) {
      throw new CarrierError(
        `no GEICO document matched target "${config.DOCUMENT_TARGET}" `
          + `(${diagnostics.totalInBuckets} in bucket, ${diagnostics.matchingDescription} by description)`,
        {
          code: ErrorCodes.NO_DOCUMENTS,
          userMessage: `GEICO did not list a ${config.DOCUMENT_TARGET} document for this policy.`,
        }
      );
    }

    /**
     * Say so when the chosen document is not from the in-force term.
     *
     * It can legitimately happen — a brand new policy may have no endorsement for
     * the current term yet — but it is also the exact shape of the F-28 defect, so
     * it is surfaced rather than passed off as a normal result.
     */
    if (!diagnostics.chosenIsInCurrentTerm) {
      this.log.warn(diagnostics, 'GEICO document is NOT from the current term');
      this.notify('The most recent document GEICO lists is from a previous policy term.');
    }

    this.notify(`Found ${chosen.length} document(s). Downloading…`);

    const docs = [];
    for (const doc of chosen) {
      docs.push(
        await this.timings.measure('document_download', () =>
          downloadDocument(this.context, payload, doc, {
            log: this.log,
            headers: this.#documentHeaders,
          })
        )
      );
    }
    return docs;
  }

  /**
   * Get the document list by letting the app fetch it.
   *
   * ------------------------------------------------------------------------
   * WHY NOT JUST CALL THE API
   * ------------------------------------------------------------------------
   * Calling `GET /ws/consolidated-documents` through `context.request` returns **401**.
   * The documents host runs its own `/ws/bootstrap` and requires headers the request
   * context does not have — `sessionkey`, `edge-policy-token`, `x-xsrf-token` and a
   * set of `asd-*` / `geico-*` state and tracing headers. Authenticating on
   * `ecams.geico.com` does not confer a session on `edgecustomer.geico.com`.
   *
   * So navigate to the documents page and harvest the response the SPA makes. The app
   * performs the bootstrap and header assembly; we read the result. Identical to the
   * Progressive approach and for an identical reason.
   *
   * The URL is deliberately the bare path. The recorded manual session navigated to
   * `/documents/consolidated-documents` with no query string, and the app then
   * re-navigated adding `?token=…&visitAppId=E01`, so it derives the policy token from
   * its own session. Supplying one would mean sourcing a value we do not need.
   */
  async #obtainDocumentList() {
    const { page } = this;

    // Already captured during the post-auth redirect? Then nothing to do.
    if (this.#documentsPayload) {
      this.log.info('document list already harvested during sign-in');
      return this.#documentsPayload;
    }

    /**
     * Carry the hand-off token from the current URL.
     *
     * ------------------------------------------------------------------------
     * WHY — a bare path is not enough
     * ------------------------------------------------------------------------
     * After 2SV the browser sits on `https://portfolio.geico.com/?token=…`. That token
     * is how GEICO passes authority between its hosts: every navigation to
     * `edgecustomer.geico.com` in a captured manual session carried it.
     *
     * A first attempt navigated to the bare `/documents/consolidated-documents`,
     * reasoning that the recording showed a bare navigation followed by a tokenised
     * one, so the app must add it itself. Wrong inference — that bare entry was an
     * internal SPA route push made *after* the app already held a token for that host.
     * Arriving without one produced no bootstrap, no document-list request, and a 45s
     * wait for something that was never going to happen.
     *
     * So take whatever the current URL carries and pass it on. This deliberately does
     * not model what the token *is* — only that GEICO puts it in the URL when moving
     * between hosts, which is observable and sufficient.
     *
     * The token is credential-equivalent and is never logged; only whether one was
     * found.
     */
    const handoff = this.#extractHandoffParams(page.url());
    const qs = handoff.toString();
    const url = `https://${HOSTS.documents}${ROUTES.documentsList}${qs ? `?${qs}` : ''}`;

    /**
     * Try the API directly first, and skip the page entirely if it works.
     *
     * ------------------------------------------------------------------------
     * WHY — `list_documents` is 39% of the machine time and most of it is app startup
     * ------------------------------------------------------------------------
     * Measured on the one complete GEICO run: `list_documents` took **4,948ms**, the single
     * largest item on a 12,605ms critical path. The comparison with Progressive is what
     * identifies the cause:
     *
     *     Progressive  nav_documents     302ms   SPA route change, app already booted
     *     GEICO        list_documents  4,948ms   navigation to a DIFFERENT ORIGIN
     *
     * GEICO serves documents from `edgecustomer.geico.com`, a separate origin from the
     * `ecams` login host, so arriving there forces a **cold Flutter boot** — measured
     * between 2,292ms and 6,177ms on the login host. We are starting an entire
     * single-page application in order to read one JSON response.
     *
     * So: attempt `POST /ws/bootstrap` followed by `GET /ws/consolidated-documents` through
     * `context.request`, which shares the session cookies. If the bootstrap establishes
     * enough of a session for that host, the whole app boot disappears.
     *
     * The trade is deliberately asymmetric. Two requests cost roughly 300-500ms when they
     * fail, against ~4,500ms saved when they succeed — worth it even at a low success rate.
     * And it is a **pure fallback**: on any failure the original navigation runs unchanged,
     * so the worst case is the current behaviour plus half a second.
     *
     * Why it may not work: a 401 was previously observed on this endpoint without the
     * app's own headers (`sessionkey`, `edge-policy-token`, `x-xsrf-token`), which are
     * minted during the app's bootstrap. Whether a bare `context.request` bootstrap
     * produces them is exactly the open question, and this is the cheapest way to find out
     * on a real session.
     */
    const direct = await this.#tryDirectDocumentList(handoff);
    if (direct) {
      this.log.info('document list retrieved without loading the documents app');
      return direct;
    }

    this.log.info(
      { hasToken: handoff.has('token'), params: [...handoff.keys()] },
      qs ? 'navigating to documents with the hand-off token' : 'no hand-off token in the URL; navigating bare'
    );
    this.notify('Opening your GEICO documents…');
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: config.NAV_TIMEOUT_MS });

    /**
     * Poll for the harvested payload rather than waiting on a selector.
     *
     * The observer fills `#documentsPayload` when the app's own request completes,
     * which is the actual readiness signal. Waiting for DOM instead would mean
     * guessing at a Flutter render, and the payload can arrive before or after any
     * particular element appears.
     */
    const deadline = Date.now() + config.DOCUMENT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (this.#documentsPayload) return this.#documentsPayload;
      await page.waitForTimeout(250);
    }

    /**
     * Second attempt: go the way the browser went.
     *
     * A captured manual session reached the document list via `/view-policy`, not
     * directly. If the direct route produced nothing, follow the observed path — the
     * intermediate page may be what establishes state the list page assumes.
     *
     * Only tried when we actually have a token, since without one it would fail for
     * the same reason the first attempt did.
     */
    if (handoff.has('token')) {
      const viaUrl = `https://${HOSTS.documents}${ROUTES.viewPolicy}?${handoff.toString()}`;
      this.log.info('document list not seen; retrying via /view-policy as the browser did');
      // Internal: which internal route we took to reach the document list is noise to a
      // user and meaningful only when debugging why the direct route produced nothing.
      this.notify('Retrying the document list via /view-policy.', {}, { internal: true });
      try {
        await page.goto(viaUrl, { waitUntil: 'domcontentloaded', timeout: config.NAV_TIMEOUT_MS });
        await page.waitForTimeout(2500);
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: config.NAV_TIMEOUT_MS });

        const second = Date.now() + 25_000;
        while (Date.now() < second) {
          if (this.#documentsPayload) return this.#documentsPayload;
          await page.waitForTimeout(250);
        }
      } catch (err) {
        this.log.warn({ err: err.message.split('\n')[0] }, '/view-policy route also failed');
      }
    }

    /**
     * Last resort: try the direct call anyway.
     *
     * By now the browser has visited the documents host, so its cookies exist and the
     * observer may have captured usable headers. It is a long shot — the 401 is what
     * started this — but it costs one request and turns a dead end into a possible
     * success. If it also fails, the error names what was actually tried.
     */
    this.log.warn('app never issued a document-list request; trying the API directly');
    try {
      return await fetchDocumentList(this.context, {
        log: this.log,
        headers: this.#documentHeaders,
      });
    } catch (err) {
      throw new CarrierError(
        `GEICO document list unavailable: app made no request and direct call failed (${err.message})`,
        {
          code: ErrorCodes.NO_DOCUMENTS,
          userMessage:
            'Signed in to GEICO, but the documents page did not load your document list. '
            + 'Please try again.',
          cause: err,
        }
      );
    }
  }

  /**
   * Is a rehydrated session still good?
   *
   * Probes the documents endpoint through `context.request`, which carries the
   * rehydrated cookies. A 200 with a payload is proof of authentication; anything
   * else means fall back to a cold login.
   *
   * Chosen over navigating to a page and inspecting it for three reasons:
   *
   *  - **It is the real question.** F-18's lesson is that a URL is not proof of
   *    authentication — a portal will happily render a shell and then 401 every API
   *    call behind it. The only reliable test is an authenticated request that
   *    succeeds, and this one is the exact request `fetchDocuments()` needs anyway.
   *  - **It is cheap.** One request against a Flutter app whose login page takes
   *    2.2-6.2s to mount, and no page load at all.
   *  - **It cannot half-succeed.** A navigation can leave the browser somewhere
   *    ambiguous; a status code cannot.
   *
   * Never throws. A warm-path probe that raises would turn a recoverable miss into a
   * failed run, and the whole point is that falling back is fine.
   */
  async isSessionValid() {
    try {
      const res = await this.context.request.get(
        `https://${HOSTS.documents}${ENDPOINTS.consolidatedDocuments}`,
        { timeout: 12_000 }
      );
      if (!res.ok()) {
        this.log.info({ status: res.status() }, 'GEICO session probe not authenticated');
        return false;
      }
      const payload = (await res.json())?._payload;
      const ok = Boolean(payload?.policyNumber);
      this.log.info(
        { status: res.status(), hasPolicy: ok, currentTerm: payload?.currentTermEffectiveDate ?? null },
        ok ? 'GEICO session is still valid — warm path available' : 'GEICO responded 200 but without a policy'
      );
      return ok;
    } catch (err) {
      this.log.info({ err: err.message.split('\n')[0] }, 'GEICO session probe failed; taking the cold path');
      return false;
    }
  }

  /**
   * Carrier state for failure bundles.
   *
   * Chosen to answer the questions that actually came up during recon: did the
   * Flutter app mount and how slowly, which 2SV methods were offered, and how
   * long since the credential submit. Contains no credentials, tokens or
   * cookies — these bundles exist to be shared.
   */
  get debugState() {
    return {
      carrier: GeicoCarrier.id,
      url: scrubUrl(this.page?.url?.() ?? null),
      flutterMountMs: this.#mountMs,
      mfaChannel: this.#mfaChannel,
      mfaMethodsOffered: this.#mfaMethodsOffered,
      msSinceCredentialSubmit: this.#loginSubmittedAt ? Date.now() - this.#loginSubmittedAt : null,
      documentSelection: this.#documentDiagnostics,
      apiCalls: this.#apiCalls.slice(-20),
    };
  }
}

export default GeicoCarrier;
