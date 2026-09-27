import config from '../config.js';
import { BaseCarrier, CarrierError, ErrorCodes, MfaChannel } from './baseCarrier.js';

/**
 * Progressive adapter.
 *
 * ---------------------------------------------------------------------------
 * DESIGN: drive the DOM, but read state from the network
 * ---------------------------------------------------------------------------
 *
 * Progressive's login is a PingFederate authentication flow. The SPA talks to
 * `/pf-ws/authn/flows/{flowId}` and that endpoint returns an explicit,
 * machine-readable state on every step:
 *
 *   CREDENTIALS_REQUIRED        username/password form is up
 *   AUTHENTICATION_REQUIRED     credentials accepted, evaluating
 *   OTP_REQUIRED                step-up challenge issued
 *                               + devices[{ type:'SMS', target:'*******16' }]
 *   MFA_COMPLETED               code accepted
 *   DEVICE_PROPERTIES_REQUIRED  offering "remember this device"
 *
 * So this adapter types into the DOM (there is no supported way around that)
 * but determines *what is happening* by observing those responses. That split
 * matters for two concrete reasons.
 *
 * 1. Progressive regenerates DOM ids on every page load. The username field
 *    came back as `#input2973408885337655` and the OTP field as
 *    `#input7764162441832154`. An adapter keyed on those ids passes review and
 *    then fails permanently on the next deploy. Only `#inputPassword` is
 *    stable. So all locators here are placeholder-, label- or type-based, and
 *    ids are never used.
 *
 * 2. DOM polling cannot distinguish "wrong password" from "slow page" from
 *    "silent redirect" without racing several selectors and guessing. The flow
 *    status says it outright, which turns a heuristic into a fact.
 *
 * Same idea for documents: rather than reimplementing Progressive's OAuth
 * bearer-token handling to call their API directly, the adapter navigates to the
 * documents page and *reads the response the SPA already made* to
 * `/policypro/v1/account/documents`. The app does the auth work; we harvest the
 * result. That yields the full document list with its `_links` and avoids
 * scraping a table whose markup we do not control.
 *
 * Verified against a real account on 2026-09-26; see
 * `artifacts/recordings/progressive/` for the capture this was written from.
 */

const LOGIN_URL = 'https://account.apps.progressive.com/access/login?fd=accountHome';
const ACCOUNT_HOME_URL = 'https://policyservicing.apps.progressive.com/app/account-home';
/** Only used by the fallback path; the fast path never loads a page. */
const DOCUMENTS_URL = 'https://policyservicing.apps.progressive.com/app/documents-hub/find-document';
/** Bearer-guarded REST API the portal's SPA talks to. */
const API_BASE = 'https://api.progressive.com/policypro';

/** PingFederate flow states we branch on. */
const Flow = Object.freeze({
  CREDENTIALS_REQUIRED: 'CREDENTIALS_REQUIRED',
  AUTHENTICATION_REQUIRED: 'AUTHENTICATION_REQUIRED',
  OTP_REQUIRED: 'OTP_REQUIRED',
  MFA_COMPLETED: 'MFA_COMPLETED',
  DEVICE_PROPERTIES_REQUIRED: 'DEVICE_PROPERTIES_REQUIRED',
  FAILED: 'FAILED',
});

/**
 * What to retrieve, keyed by `DOCUMENT_TARGET`.
 *
 * `categoryKey` values are Progressive's own `filterCategories` keys — the same
 * ones behind the portal's "Filter view:" dropdown — so choosing a target here
 * is the server-side equivalent of choosing that option in the UI:
 *
 *   All | Billing | DecPage | Contract | SentBy | Forms
 *
 * `types` is ordered by preference. For contracts, `POLICYCONTRACT` is the
 * current contract form while `POLICYCONTRACTEASIER` is an older plain-language
 * booklet ("Your Auto Policy: Easier"), so the former wins when both exist.
 */
const DOCUMENT_TARGETS = Object.freeze({
  contract: {
    categoryKey: 'Contract',
    types: ['POLICYCONTRACT', 'POLICYCONTRACTEASIER'],
    titlePattern: /policy\s*contract/i,
    kind: 'policy_contract',
    fallbackTitle: 'Policy Contract',
  },
  declarations: {
    categoryKey: 'DecPage',
    types: ['DECPAGE'],
    titlePattern: /declarations?\s*page/i,
    kind: 'declarations',
    fallbackTitle: 'Declarations Page',
  },
  idcard: {
    categoryKey: 'IdCard',
    types: ['IDCARD'],
    titlePattern: /id\s*card|insurance\s*id/i,
    kind: 'id_card',
    fallbackTitle: 'Insurance ID Cards',
  },
});

/** User-facing names for each target, used in status messages and errors. */
const TARGET_LABELS = Object.freeze({
  contract: 'policy contract',
  declarations: 'declarations page',
  idcard: 'insurance ID cards',
});

/** Maps Progressive's device type onto our channel vocabulary. */
const CHANNEL_BY_DEVICE = {
  SMS: MfaChannel.SMS,
  TEXT: MfaChannel.SMS,
  VOICE: MfaChannel.VOICE,
  EMAIL: MfaChannel.EMAIL,
  TOTP: MfaChannel.APP,
  PINGID: MfaChannel.APP,
};

export class ProgressiveCarrier extends BaseCarrier {
  static id = 'progressive';
  static displayName = 'Progressive';
  static supportsSessionReuse = true;
  static usesProxy = true;

  /**
   * Pooled context rather than an on-disk Chrome profile. This is a deliberate
   * reversal, and worth explaining.
   *
   * It was `true`, so that the MFA screen's "Remember this device" tick had
   * somewhere durable to land. Three things changed that calculus:
   *
   * 1. **Device trust never actually worked** (F-30). The checkbox click was
   *    silently failing, so the profile was preserving a trust marker that was
   *    never set. The benefit being protected did not exist.
   * 2. **`storageState` is the better carrier for it anyway.** Device trust rides
   *    on cookies, which `storageState` captures, encrypts, and — unlike a
   *    profile directory — keeps portable across redeploys. Profiles are
   *    machine-local, so any deploy that replaces the host destroys them.
   *    (Weaker on a long-lived EC2 instance, where profiles on EBS do survive;
   *    reasons 1 and 3 still stand there. See F-55.)
   * 3. **It blocked pre-warming.** `launchPersistentContext` needs a profile key,
   *    and ours is derived from the username, which is unknown until the user
   *    submits. A pooled context can be opened anonymously in advance; a
   *    per-user profile cannot. That is ~8.4s of the cold path.
   *
   * It also removes a full browser launch (~824ms) per session, since pooled
   * contexts come off the already-warm browser.
   *
   * The cost: Patchright documents persistent contexts as its most undetectable
   * mode. We give that up. Mitigated by still running real Chrome via `channel`,
   * and it is revisitable — if a carrier turns out to need an on-disk profile,
   * flip this back and lose pre-warming for that carrier only.
   */
  static usePersistentProfile = false;

  /**
   * Stylesheets stay on. The documents list is an Angular component and its
   * rows are only considered visible once laid out, so dropping CSS makes
   * document discovery flaky for reasons that look like anti-bot but are not.
   */
  static blockStylesheets = false;

  /**
   * Pre-warm declaration, consumed by `warmPagePool`.
   *
   * Everything up to "the login form is on screen and interactive" is independent
   * of what the user types, and on this carrier it costs ~8.4s: a browser context,
   * a navigation, and then roughly six seconds of Angular bootstrapping that
   * `domcontentloaded` gives no visibility into.
   *
   * `stalePattern` matters because a parked page can drift. Progressive mints a
   * PingFederate `flowId` per login-page load, and a page that has been sitting
   * long enough to be bounced to a timeout screen must be discarded rather than
   * typed into — failing after the user has entered credentials is worse than not
   * pre-warming at all.
   */
  static prewarm = {
    url: LOGIN_URL,
    readySelector: 'input[type="password"]',
    readyTimeoutMs: 25_000,
    stalePattern: /session-timeout|error|signed-out/i,
  };

  /** Never block the auth flow, the OAuth hop, or the policy API. */
  static extraAllow = [
    'pf-ws/authn/flows',
    'login.progressive.com',
    'authorization.oauth2',
    'api.progressive.com',
    'policypro',
    'policyservicing',
  ];

  #latestFlow = null;
  #flowHistory = [];
  /**
   * Monotonic counter of observed flow responses.
   *
   * Load-bearing. Without it, a wait that names the current status matches the
   * *previous* response instantly and the adapter draws a conclusion about an
   * event that has not happened yet. See `#waitForFlow`.
   */
  #flowSeq = 0;
  #documentsPayload = null;
  #apiHeaders = null;
  /** Set once an authenticated API call has returned success. See the observer. */
  #apiAuthOk = false;
  #observersInstalled = false;

  /**
   * Process-wide memo: has the direct documents-list call been seen to fail?
   *
   * Static because it is a property of the deployment and the account, not of one
   * session, and every session would otherwise rediscover it at ~400ms a time.
   */
  static #directListKnownBad = false;

  // -- network observation --------------------------------------------------

  /**
   * Watch the PingFederate flow and the documents API.
   *
   * Registered once, before the first navigation, because the credential POST
   * response can land before a DOM-based check would even start polling.
   */
  #installObservers() {
    if (this.#observersInstalled) return;
    this.#observersInstalled = true;

    /**
     * Harvest the API credentials from the SPA's own outbound requests.
     *
     * `api.progressive.com` is a bearer-token API, not a cookie API. This was an
     * expensive assumption to get wrong: `context.request` shares the browser's
     * cookie jar, so replaying a document URL through it *looks* like it should
     * work, and instead returns `401 {"error":"Authentication denied."}` on every
     * strategy. Cookies are simply not what guards that endpoint.
     *
     * The token itself is minted by an OAuth implicit flow and attached by an
     * Angular HTTP interceptor, so it lives in the page's JS memory. Rather than
     * reverse-engineering where it is stashed, or re-implementing the OAuth hop
     * and having to track token refresh, we watch a request the app makes anyway
     * and reuse its headers verbatim.
     *
     * This is strictly more robust than extracting the token: if Progressive
     * adds another required header, rotates `api_key`, or changes the token
     * format, we inherit the change for free because we are copying whatever the
     * real client sends rather than reconstructing it.
     */
    this.page.on('request', (request) => {
      const url = request.url();
      if (!url.includes('api.progressive.com/policypro')) return;
      const headers = request.headers();
      if (!headers.authorization) return;

      /**
       * Copy every header, minus a denylist — rather than picking the ones that
       * look important.
       *
       * An allowlist was the first attempt and it failed in an instructive way.
       * It carried `authorization`, `api_key` and `x-pgrclient`, which got us
       * from `401 Authentication denied` to `400 "AccountSession header
       * missing"`. The header being asked for was `x-prgaccountsessionid`, which
       * no reasonable allowlist would have guessed: it is a per-session
       * identifier the SPA mints and threads through every call, and it is
       * required *in addition* to the bearer token.
       *
       * There are also `x-pgrotg`, `x-siteserverpgrid`, `x-prgsessiondatalocation`
       * and `x-exdcontext` in the same family. Enumerating a vendor's private
       * header protocol is a losing game, so the rule is inverted: carry
       * everything the real client sent and drop only what must not be replayed.
       *
       * Worth noting `api_key` is per-sub-app — `policyservicing` and the
       * `account` login app use different values. Scoping the observer to
       * `/policypro` requests means we always capture the documents app's key
       * rather than the login app's.
       */
      const DENY = new Set([
        // Supplied by the cookie jar; duplicating it conflicts.
        'cookie',
        // Must be recomputed for the new body.
        'content-length',
        // Connection-level, not ours to forward.
        'host',
        'connection',
        'keep-alive',
        'transfer-encoding',
        'upgrade',
        'proxy-authorization',
        'proxy-connection',
        // Let the HTTP client negotiate compression, or we may receive bytes we
        // do not decode and mistake a valid PDF for garbage.
        'accept-encoding',
      ]);

      const carried = {};
      for (const [name, value] of Object.entries(headers)) {
        const lower = name.toLowerCase();
        if (DENY.has(lower) || lower.startsWith(':')) continue;
        carried[lower] = value;
      }
      this.#apiHeaders = carried;
    });

    this.page.on('response', async (response) => {
      const url = response.url();

      if (url.includes('/pf-ws/authn/flows/')) {
        try {
          if (!(response.headers()['content-type'] ?? '').includes('json')) return;
          const body = await response.json();
          if (!body?.status) return;
          this.#latestFlow = body;
          this.#flowSeq += 1;
          this.#flowHistory.push(body.status);
          this.log.info(
            { flowStatus: body.status, seq: this.#flowSeq },
            'progressive auth flow state'
          );
        } catch {
          // Body already consumed or streamed. The next poll will pick it up.
        }
      }

      if (url.includes('api.progressive.com/policypro')) {
        /**
         * Positive proof of a live session.
         *
         * An authenticated request that came back under 400 is the only reliable
         * evidence that this session actually works. Everything cheaper is
         * misleading: the URL can read `/app/account-home` for a moment before
         * Angular fails its handshake and redirects to `/app/session-timeout`,
         * and a rendered dashboard shell says nothing about whether the token
         * behind it is valid.
         */
        if (response.request().headers().authorization && response.status() < 400) {
          this.#apiAuthOk = true;
        }
      }

      if (url.includes('/policypro/v1/account/documents')) {
        try {
          this.#documentsPayload = await response.json();
          this.log.info(
            { policies: this.#documentsPayload?.accountDocuments?.length ?? 0 },
            'captured documents payload'
          );
        } catch {
          /* ignore */
        }
      }
    });
  }

  /**
   * Wait until the flow reports one of `statuses` in a response newer than
   * `afterSeq`.
   *
   * The `afterSeq` guard is the whole point. An earlier version compared against
   * the cached status only, which produced a subtle and damaging bug: after
   * submitting an OTP, the adapter waited for
   * `[MFA_COMPLETED, OTP_REQUIRED, ...]` and matched the *stale* `OTP_REQUIRED`
   * left over from when the challenge was first issued. It therefore concluded
   * the code had been rejected roughly instantly, while Progressive's real
   * `MFA_COMPLETED` arrived ~470ms later and confirmed the code was correct.
   *
   * The visible consequence was worse than a spurious retry prompt. The state
   * machine had already returned to MFA_REQUIRED, so by the time the user typed
   * a second code the page had navigated on to the dashboard, and the run died
   * with "OTP field not found" — an error pointing at selectors when the actual
   * fault was reading a value that predated the action.
   *
   * Callers snapshot `flowSeq` *before* the interaction and pass it here, so only
   * genuinely new information can satisfy the wait.
   */
  async #waitForFlow(statuses, { timeout = config.LOGIN_TIMEOUT_MS, afterSeq = -1 } = {}) {
    const wanted = new Set(statuses);
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (
        this.#flowSeq > afterSeq &&
        this.#latestFlow?.status &&
        wanted.has(this.#latestFlow.status)
      ) {
        return this.#latestFlow;
      }
      // A challenge page can also mean we never get another flow response.
      await this.page.waitForTimeout(150);
    }
    return null;
  }

  /** Current flow sequence, snapshotted by callers before they act. */
  get #flowMark() {
    return this.#flowSeq;
  }

  // -- login ----------------------------------------------------------------

  async login(credentials) {
    const { page } = this;
    this.#installObservers();

    /**
     * Skip the navigation when the page is already sitting on the login form.
     *
     * This is how an adopted pre-warmed page is used. Deliberately expressed as a
     * property of the page rather than as a flag passed down from the
     * orchestrator: the adapter asks "am I already where I need to be?", which is
     * true whether the page came from the warm pool, a retry, or anywhere else.
     * No plumbing, and no way for a stale flag to disagree with reality.
     */
    await this.timings.measure('nav_login', async () => {
      const alreadyOnForm =
        /account\.apps\.progressive\.com\/access\/login/.test(page.url()) &&
        (await page
          .locator('input[type="password"]')
          .first()
          .isVisible({ timeout: 1000 })
          .catch(() => false));

      if (alreadyOnForm) {
        this.log.info({ url: page.url() }, 'login form already rendered; skipping navigation');
        return;
      }
      await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' });
    });
    await this.assertNotBlocked();

    /**
     * Before reaching for credentials, check whether Progressive is offering to
     * resume instead. With a persistent profile this happens often, and skipping
     * it would throw away the cheapest path available.
     */
    if (await this.#resumeIfOffered()) {
      this.log.info('resumed via existing SSO session; no credentials needed');
      this.notify('Progressive resumed your existing session. No sign-in needed.');
      return { mfaRequired: false, resumed: true };
    }

    /**
     * Waiting for the login form to render, measured as its own phase.
     *
     * This was previously unattributed and it is large. `nav_login` only covers
     * `page.goto(..., { waitUntil: 'domcontentloaded' })`, which returns as soon
     * as the HTML shell parses — but Progressive's login is an Angular app, and
     * the form does not exist for several seconds after that. On a measured run,
     * `nav_login` was 1,563ms and `fill_credentials` 719ms, yet the status line
     * covering this whole stretch read 8,350ms: roughly **6 seconds** of the login
     * phase was the form rendering, invisible to the metrics.
     *
     * Naming it matters for two reasons. It is the largest single controllable
     * cost in the cold path, and it is the part that pre-warming would remove
     * entirely — you cannot justify that work against a number nobody can see.
     *
     * Locators are deliberately id-free: Progressive regenerates the username
     * input's id on every load; its placeholder and label are stable (F-08).
     */
    const { userField, passField } = await this.timings.measure('await_login_form', async () => ({
      userField: await this.firstVisible(
        [
          'input[placeholder="User ID"]',
          'input[autocomplete="username"]',
          'input[type="text"][maxlength="255"]',
        ],
        { timeout: 20_000 }
      ),
      // `#inputPassword` is the one stable id on the page, kept as a last resort
      // behind the type selector rather than relied upon.
      passField: await this.firstVisible(
        ['input[type="password"]', 'input[placeholder="Password"]', '#inputPassword'],
        { timeout: 20_000 }
      ),
    }));

    if (!userField || !passField) {
      throw new CarrierError('Progressive login form not found', {
        code: ErrorCodes.SELECTOR_DRIFT,
        userMessage:
          'Could not find the Progressive sign-in form. The portal layout may have changed.',
      });
    }

    await this.timings.measure('fill_credentials', async () => {
      await this.typeLikeHuman(userField, credentials.username);
      await this.typeLikeHuman(passField, credentials.password);
    });

    // "Save User ID" is harmless and makes the profile look more like a
    // returning user's, which is consistent with the persistent profile.
    const saveUserId = await this.firstVisible(['input[type="checkbox"]'], { timeout: 1500 });
    await saveUserId?.check({ timeout: 2000 }).catch(() => {});

    this.notify('Submitting credentials to Progressive…');

    // Snapshot before the click for the same reason as in submitMfa: the flow is
    // already sitting on CREDENTIALS_REQUIRED, and a wait that could match a
    // pre-existing status is a wait that can answer before anything happened.
    const mark = this.#flowMark;

    await this.timings.measure('submit_credentials', async () => {
      const submit = await this.firstVisible(
        ['button:has-text("Log In")', 'button[type="submit"]'],
        { timeout: 8000 }
      );
      if (!submit) {
        throw new CarrierError('Log In button not found', {
          code: ErrorCodes.SELECTOR_DRIFT,
          userMessage: 'Could not find the sign-in button.',
        });
      }
      await submit.click();
    });

    /**
     * Resolve the outcome from the flow status first, and only fall back to the
     * DOM if no flow response arrived — which usually means we were served an
     * interstitial rather than the app.
     */
    const flow = await this.#waitForFlow(
      [Flow.OTP_REQUIRED, Flow.MFA_COMPLETED, Flow.DEVICE_PROPERTIES_REQUIRED, Flow.FAILED],
      { afterSeq: mark }
    );

    if (!flow) {
      await this.assertNotBlocked();
      return this.#resolveOutcomeFromDom();
    }

    if (flow.status === Flow.FAILED) {
      throw new CarrierError('Progressive rejected the credentials', {
        code: ErrorCodes.INVALID_CREDENTIALS,
        userMessage: 'Progressive did not accept that user ID and password.',
      });
    }

    if (flow.status === Flow.OTP_REQUIRED) {
      const device =
        flow.devices?.find((d) => d.id === flow.selectedDeviceRef?.id) ?? flow.devices?.[0];
      const channel = CHANNEL_BY_DEVICE[String(device?.type ?? '').toUpperCase()] ?? MfaChannel.UNKNOWN;
      this.log.info({ channel, devices: flow.devices?.length }, 'progressive issued a challenge');
      return {
        mfaRequired: true,
        channel,
        // `target` arrives pre-masked by Progressive (e.g. "*******16"), so it
        // is safe to show and genuinely helps the user know where to look.
        hint: device?.target ? `number ending ${String(device.target).replace(/\*/g, '')}` : undefined,
      };
    }

    // MFA_COMPLETED or DEVICE_PROPERTIES_REQUIRED without an OTP step means the
    // device was already trusted. This is the warm-ish path on a cold context.
    this.log.info({ status: flow.status }, 'progressive skipped the challenge (device trusted)');
    // Same gating as in submitMfa: only probe for the interstitial when the flow
    // says it exists, rather than spending a selector timeout discovering it does not.
    if (flow.status === Flow.DEVICE_PROPERTIES_REQUIRED) {
      await this.#clearDevicePropertiesPrompt();
    }
    return { mfaRequired: false };
  }

  /** Fallback when no flow response was observed. */
  async #resolveOutcomeFromDom() {
    const { outcome } = await this.raceOutcomes(
      {
        mfa: 'input[placeholder="XXXXXX"], input[maxlength="6"]',
        badCredentials: 'text=/incorrect|does not match|try again|unable to log/i',
        authenticated: 'text=/Good (morning|afternoon|evening)/i',
      },
      { timeout: 25_000 }
    );

    if (outcome === 'badCredentials') {
      throw new CarrierError('Progressive rejected the credentials', {
        code: ErrorCodes.INVALID_CREDENTIALS,
        userMessage: 'Progressive did not accept that user ID and password.',
      });
    }
    if (outcome === 'authenticated') return { mfaRequired: false };
    return { mfaRequired: true, channel: MfaChannel.UNKNOWN };
  }

  // -- MFA ------------------------------------------------------------------

  async submitMfa(code) {
    const { page } = this;

    const field = await this.firstVisible(
      [
        'input[placeholder="XXXXXX"]',
        'input[autocomplete="one-time-code"]',
        'input[maxlength="6"]',
        'input[inputmode="numeric"]',
      ],
      { timeout: 15_000 }
    );
    if (!field) {
      throw new CarrierError('Progressive OTP field not found', {
        code: ErrorCodes.SELECTOR_DRIFT,
        userMessage: 'The verification step is no longer on screen. Please start over.',
      });
    }

    /**
     * Tick "Remember this device" before submitting.
     *
     * Highest-leverage line in the adapter: with the device trusted and a
     * persistent profile behind it, later pulls skip the SMS entirely.
     *
     * The lookup is deliberately impatient. We only reach here once the OTP field
     * is already visible, so the screen is rendered — if this checkbox is not
     * present within a few hundred milliseconds it is not on the page, and a
     * generous timeout buys nothing but latency. It was 2500ms and measurably
     * part of why `mfa_submit` ran to 8s.
     *
     * The `input[type="checkbox"]` fallback was also removed. It was never a
     * useful widening — on a screen with more than one checkbox it would tick an
     * arbitrary one, and silently opting a user into something unrelated is a far
     * worse outcome than missing the optimisation. `name` is stable here; the id
     * is not (F-08).
     */
    const remembered = await this.#rememberThisDevice();
    if (remembered) {
      this.notify('Asked Progressive to remember this device, so future pulls can skip the code.');
    }

    await field.fill('');
    await this.typeLikeHuman(field, code);

    const submit = await this.firstVisible(
      ['button:has-text("Continue")', 'button[type="submit"]'],
      { timeout: 8000 }
    );
    if (!submit) {
      throw new CarrierError('Continue button not found on OTP screen', {
        code: ErrorCodes.SELECTOR_DRIFT,
        userMessage: 'Could not find the button to submit your code.',
      });
    }

    // Snapshot before acting, so only responses caused by this click can satisfy
    // the waits below.
    const mark = this.#flowMark;
    await submit.click();

    /**
     * Resolve acceptance and rejection in one loop rather than sequentially.
     *
     * Waiting the full success timeout first and only then checking for
     * rejection would be correct but unkind: a mistyped digit would sit there for
     * 30 seconds before the user was told. Equally, checking rejection first
     * reintroduces the original bug, because `OTP_REQUIRED` is the state we were
     * already in.
     *
     * So both are evaluated on every tick, and only events newer than `mark`
     * count. Success and rejection are then detected as fast as the carrier
     * reports them, without either verdict being reachable from stale data.
     */
    const deadline = Date.now() + 30_000;
    let sawNewChallengeAt = null;

    while (Date.now() < deadline) {
      const fresh = this.#flowSeq > mark;
      const status = this.#latestFlow?.status;

      if (fresh && (status === Flow.MFA_COMPLETED || status === Flow.DEVICE_PROPERTIES_REQUIRED)) {
        this.log.info({ status }, 'progressive accepted the code');
        await this.#settleAfterMfa();
        return { accepted: true };
      }

      if (fresh && status === Flow.FAILED) {
        throw new CarrierError('Progressive failed the challenge', {
          code: ErrorCodes.MFA_REJECTED,
          userMessage: 'Progressive rejected the verification. Please start a new session.',
        });
      }

      /**
       * A re-issued OTP_REQUIRED means rejection, but hold it for a moment
       * before acting. Observed timing has success landing ~470ms after the
       * click, and if the carrier ever emits a transient challenge state on the
       * way to success, concluding instantly would flip the original bug around
       * and report a good code as bad again. A short grace costs nothing and
       * removes that whole class of mistake.
       */
      if (fresh && status === Flow.OTP_REQUIRED) {
        sawNewChallengeAt ??= Date.now();
        if (Date.now() - sawNewChallengeAt > 1500) {
          this.log.warn({ seq: this.#flowSeq, mark }, 'progressive re-issued the challenge');
          return {
            accepted: false,
            retryable: true,
            message: 'Progressive did not accept that code. Check it and try again.',
          };
        }
      }

      const errorVisible = await page
        .locator('text=/incorrect|invalid|not match|try again|expired|didn.t work/i')
        .first()
        .isVisible()
        .catch(() => false);
      if (errorVisible) {
        this.log.warn('progressive showed an inline OTP error');
        return {
          accepted: false,
          retryable: true,
          message: 'Progressive did not accept that code. Check it and try again.',
        };
      }

      await page.waitForTimeout(150);
    }

    // Neither success nor an identifiable rejection. Do not silently retry and
    // burn another SMS; report honestly instead.
    throw new CarrierError('No flow response after submitting the OTP', {
      code: ErrorCodes.TIMEOUT,
      userMessage:
        'Progressive stopped responding after the verification code was submitted. Please try again.',
    });
  }

  /**
   * Handle Progressive's "Log back in" resume interstitial.
   *
   * There are two distinct kinds of session here and conflating them costs a
   * full login plus an SMS:
   *
   *   - the *application* session at policyservicing.apps.progressive.com,
   *     which is short-lived and backed by the bearer token
   *   - the *SSO* session at login.progressive.com, held by PingFederate,
   *     which lives considerably longer
   *
   * When the app session lapses but SSO is still good, Progressive does not show
   * a credentials form. It shows an interstitial with a single "Log back in"
   * button, and clicking it runs the PF authorization hop against the surviving
   * SSO cookie, mints a fresh token, and lands on the account home — no user ID,
   * no password, no verification code.
   *
   * So this is a third path alongside cold and warm, and it is nearly as fast as
   * a rehydrated storageState while surviving situations storageState does not.
   *
   * The important safety property: it must never mistake a real login screen for
   * a resume prompt. A visible password field means credentials are genuinely
   * required, so that is checked first and short-circuits.
   */
  async #resumeIfOffered({ timeout = 12_000 } = {}) {
    const { page } = this;

    // A visible password field means this is a real login, not a resume.
    const passwordVisible = await page
      .locator('input[type="password"]')
      .first()
      .isVisible({ timeout: 2500 })
      .catch(() => false);
    if (passwordVisible) return false;

    /**
     * Progressive serves this on a dedicated route, `/app/session-timeout`,
     * carrying a single `<a>Log back in</a>` pointing at
     * `account.apps.progressive.com` and zero password fields — captured live,
     * see `artifacts/recordings/progressive/documents-structure.json`.
     *
     * The route is the primary signal because it is structural. Button copy is
     * user-facing text on a portal with a Spanish toggle one click away, so
     * matching on "Log back in" alone would break for a Spanish-locale user
     * while passing every test we run.
     */
    const onTimeoutRoute = /\/app\/session-timeout/.test(page.url());

    const resume = await this.firstVisible(
      [
        // Structural first: any link out to the access app from the timeout page.
        ...(onTimeoutRoute ? ['a[href*="account.apps.progressive.com"]'] : []),
        'a:has-text("Log back in")',
        'button:has-text("Log back in")',
        'a:has-text("Log Back In")',
        'button:has-text("Log Back In")',
        'button:has-text("Log In Again")',
        'button:has-text("Resume")',
        // Spanish equivalents, since the portal offers the toggle.
        'a:has-text("Vuelve a iniciar")',
        'a:has-text("Iniciar sesión")',
      ],
      { timeout: onTimeoutRoute ? 6000 : 3000 }
    );
    if (!resume) return false;

    this.log.info({ onTimeoutRoute, url: page.url() }, 'resume affordance found');

    this.notify('Progressive offered to resume your session…');
    await resume.click({ timeout: 5000 }).catch(() => {});

    /**
     * Resolve where the click actually landed. Three outcomes matter, and
     * racing them beats waiting for the hoped-for one: the resume can succeed,
     * it can bounce to a credentials form because SSO had also expired, or it
     * can land on the OTP screen if the device is not trusted.
     */
    const { outcome } = await this.raceOutcomes(
      {
        resumed: (p) => /\/app\/(account-home|policy-hub|documents-hub)/.test(p.url()),
        credentialsRequired: 'input[type="password"]',
        otpRequired: 'input[placeholder="XXXXXX"], input[maxlength="6"]',
      },
      { timeout }
    ).catch(() => ({ outcome: 'unknown' }));

    if (outcome === 'resumed') return true;

    this.log.info({ outcome }, 'resume attempt did not complete; continuing normally');
    return false;
  }

  /**
   * Dismiss the post-MFA "remember this device" interstitial if it appears as
   * its own screen. Harmless when absent; leaving it unhandled strands the flow
   * one click short of the dashboard.
   */
  /**
   * Tick "Remember this device", and verify it actually got ticked.
   *
   * This was both the slowest and the least honest part of the MFA step.
   *
   * The original implementation was `check({ timeout: 3000 }).catch(() => {})`
   * followed unconditionally by a message telling the user the device would be
   * remembered. Progressive renders this control the way most design systems do:
   * the real `<input type="checkbox">` is visually hidden (`opacity: 0` or
   * zero-sized) behind a styled proxy element. Playwright's `check()` waits for
   * actionability, the hidden input never becomes actionable, and the call burned
   * its full timeout — measured at 3,029ms of a 8,285ms `mfa_submit`.
   *
   * The expensive part was not the wasted time. The `.catch(() => {})` swallowed
   * the timeout and the message claimed success regardless, so the single biggest
   * latency optimisation in this adapter — skipping the SMS on later runs —
   * appears to have silently never worked. Every Progressive run took the cold
   * path with a fresh challenge, and nothing said otherwise.
   *
   * Now: `force: true` to skip the actionability wait, then read `isChecked()` to
   * find out what actually happened, then fall back to clicking the label (which
   * is what a person clicks) before reporting honestly either way.
   */
  async #rememberThisDevice() {
    const { page } = this;
    const selector = 'input[name="rememberThisDevice"]';

    // Impatient by design: the OTP field is already visible, so the screen is
    // rendered. If this is not here now, it is not here.
    const box = await this.firstVisible([selector], { timeout: 700 });
    const exists = box ?? (await page.locator(selector).count().catch(() => 0)) > 0
      ? page.locator(selector).first()
      : null;

    if (!exists) {
      this.log.info('no remember-device checkbox on this screen');
      return false;
    }

    const isChecked = () => exists.isChecked().catch(() => false);
    if (await isChecked()) return true;

    // `force` bypasses the actionability wait that a visually hidden input can
    // never satisfy. Short timeout: it either dispatches or it does not.
    await exists.check({ timeout: 1200, force: true }).catch(() => {});
    if (await isChecked()) {
      this.log.info('device trust checkbox ticked');
      return true;
    }

    /**
     * Fall back to the label. A styled checkbox is normally wrapped in, or
     * associated with, a `<label>` that carries the click handler — so clicking
     * the label is both what a user does and what the component expects.
     */
    const id = await exists.getAttribute('id').catch(() => null);
    const labelCandidates = [
      ...(id ? [`label[for="${id}"]`] : []),
      `label:has(${selector})`,
    ];
    for (const sel of labelCandidates) {
      const label = page.locator(sel).first();
      if ((await label.count().catch(() => 0)) === 0) continue;
      await label.click({ timeout: 1200 }).catch(() => {});
      if (await isChecked()) {
        this.log.info({ via: sel }, 'device trust checkbox ticked via label');
        return true;
      }
    }

    // Report the failure rather than claiming the optimisation was applied.
    this.log.warn(
      'could not tick the remember-device checkbox; future pulls will still require an SMS'
    );
    return false;
  }

  /**
   * Finish the authentication flow after the code is accepted.
   *
   * ---------------------------------------------------------------------------
   * WHY THIS IS NOT A SIMPLE `if (status === DEVICE_PROPERTIES_REQUIRED)`
   * ---------------------------------------------------------------------------
   *
   * It was, briefly, and it broke authentication outright.
   *
   * PingFederate emits `MFA_COMPLETED` *before* `DEVICE_PROPERTIES_REQUIRED`.
   * Checking the status at the instant the code is accepted therefore always sees
   * `MFA_COMPLETED`, concludes no interstitial is coming, and returns — skipping
   * the click that advances the flow through `setDeviceProperties`. The observed
   * result was a flow history ending
   * `… OTP_REQUIRED → MFA_COMPLETED → CREDENTIALS_REQUIRED`: the session was never
   * completed, Progressive tore it down about a second later, and the run failed
   * in the document phase with a misleading "session timed out".
   *
   * That is the same mistake as F-16 in the opposite direction — resolving a
   * decision against state that predates the event it is about. The earlier
   * version of this code called the prompt handler unconditionally, which was
   * correct but paid a 3.5s selector timeout on every run that had no prompt.
   *
   * So neither snapshot nor blind poll: wait for whichever happens first.
   *
   *   - `DEVICE_PROPERTIES_REQUIRED` appears  → handle the interstitial
   *   - an authenticated API call succeeds    → already through, nothing to do
   *   - we land on an app route              → ditto
   *   - nothing within the cap               → return and let the document phase
   *                                             diagnose it properly
   *
   * Fast in the common case (exits as soon as either signal lands) and correct in
   * the case that matters.
   */
  async #settleAfterMfa({ timeout = 8000 } = {}) {
    const { page } = this;
    const deadline = Date.now() + timeout;

    while (Date.now() < deadline) {
      if (this.#latestFlow?.status === Flow.DEVICE_PROPERTIES_REQUIRED) {
        await this.#clearDevicePropertiesPrompt();
        return;
      }

      // Definitive evidence we are already authenticated; no interstitial came.
      if (this.#apiAuthOk) {
        this.log.info('post-MFA: authenticated without a device-trust step');
        return;
      }

      const url = page.url();
      if (
        /policyservicing\.apps\.progressive\.com\/app\//.test(url) &&
        !/\/app\/session-timeout/.test(url)
      ) {
        this.log.info({ url }, 'post-MFA: reached an app route');
        return;
      }

      await page.waitForTimeout(120);
    }

    this.log.warn(
      { flowStatus: this.#latestFlow?.status, url: page.url() },
      'post-MFA settle timed out; continuing to the document phase'
    );
  }

  async #clearDevicePropertiesPrompt() {
    const { page } = this;

    /**
     * Wait for the OTP screen to go away before looking for a Continue button.
     *
     * `button:has-text("Continue")` matches the OTP form's own submit button as
     * well as this interstitial's. Without this guard, a page that has not yet
     * navigated hands back the button we just clicked, and we click it a second
     * time — resubmitting the verification code. That is not a latency bug but it
     * is a real one, and the two selectors being identical makes it invisible.
     *
     * The OTP field disappearing is the cheap, reliable signal that we are
     * looking at a different screen.
     */
    await page
      .locator('input[placeholder="XXXXXX"], input[maxlength="6"]')
      .first()
      .waitFor({ state: 'hidden', timeout: 4000 })
      .catch(() => {});

    /**
     * Short timeout on purpose: this only runs when the flow has already reported
     * `DEVICE_PROPERTIES_REQUIRED`, so the screen is expected rather than hoped
     * for. If the control is not there within a second, something else is going
     * on and waiting longer will not discover it.
     */
    const proceed = await this.firstVisible(
      [
        'button:has-text("Continue")',
        'button:has-text("Yes")',
        'button:has-text("Remember")',
        'button:has-text("Done")',
      ],
      { timeout: 1200 }
    );
    if (proceed) {
      await proceed.click({ timeout: 3000 }).catch(() => {});
      this.notify('Finishing up so future pulls can skip the code…');
    } else {
      this.log.info('device-properties screen resolved without interaction');
    }
  }

  // -- documents ------------------------------------------------------------

  /**
   * Retrieve the declarations documents.
   *
   * ---------------------------------------------------------------------------
   * WHY THIS DOES NOT NAVIGATE TO THE DOCUMENTS PAGE
   * ---------------------------------------------------------------------------
   *
   * The obvious implementation — `page.goto('/app/documents-hub/find-document')`
   * and read the list the SPA fetches — fails, and fails in a way that looks like
   * a session problem rather than a navigation one.
   *
   * Progressive's portal is an Angular SPA that holds its OAuth access token in
   * memory. The token arrives in a URL *fragment* during login
   * (`/app/account-entry-headless#access_token=...`), is picked up by JS, and is
   * thereafter attached to API calls by an HTTP interceptor. It is not in a
   * cookie and it is not in storage we can rely on.
   *
   * A hard navigation destroys that JS context. The app reloads with no token,
   * cannot complete its handshake, and redirects to `/app/session-timeout`
   * showing "Time's up! Your session timed out." So the symptom is an expired
   * session, but nothing expired — we threw the credential away ourselves by
   * navigating. Observed directly: after a hard `goto`, the page made *zero* API
   * requests and rendered the timeout screen, while the same profile driven by
   * in-app clicks worked fine.
   *
   * Rather than replicate a click path through the UI (account home → policy hub
   * → account options → documents), which is several navigations of fragile
   * selectors, this skips the page entirely. The document list and the documents
   * themselves are both plain REST endpoints; all they need is the bearer token
   * and its companion headers, which are harvested from the requests the app
   * makes on its own. So: land on an authenticated route once, let the app mint
   * and use a token, borrow those headers, and talk to the API directly.
   *
   * That is fewer moving parts, no selector dependency, and materially faster —
   * it removes two page loads from the critical path.
   */
  async fetchDocuments() {
    const { context } = this;

    this.notify('Opening your account…');

    // Land on an authenticated route so the SPA bootstraps and mints a token.
    await this.timings.measure('nav_documents', () => this.#ensureAuthenticatedAppRoute());
    await this.assertNotBlocked();

    // Borrow the app's own API credentials.
    const headers = await this.timings.measure('capture_api_auth', () =>
      this.#waitForApiHeaders()
    );
    if (!headers) {
      throw new CarrierError('Never observed an authenticated API call', {
        code: ErrorCodes.NO_DOCUMENTS,
        userMessage:
          'Signed in, but could not read your documents. Progressive may have signed this session out.',
      });
    }
    this.log.info({ headerCount: Object.keys(headers).length }, 'captured API credentials');

    /**
     * Use the payload the app already fetched if we happened to see it; ask the
     * API directly otherwise. The direct call is the normal path now, since we no
     * longer visit the page that would have triggered it.
     */
    let payload = this.#documentsPayload;

    /**
     * Skip the direct API call once it is known to fail for this process.
     *
     * Some of Progressive's API headers are route-scoped (F-19), so the direct
     * `/v1/account/documents` call returns 400 with credentials harvested on
     * account-home and 200 with credentials harvested on the documents page.
     * Which side of that an account falls on does not change between runs.
     *
     * Retrying a call we have already watched fail costs ~400ms of every
     * subsequent pull to learn nothing. Memoised per process rather than
     * persisted: cheap to relearn after a restart, and it self-corrects if
     * Progressive changes the behaviour.
     */
    if (!payload && !ProgressiveCarrier.#directListKnownBad) {
      payload = await this.timings.measure('list_documents', () =>
        this.#fetchDocumentsPayload(headers)
      );
      if (!payload) {
        ProgressiveCarrier.#directListKnownBad = true;
        this.log.info('direct list call marked unusable for this process; future runs skip it');
      }
    } else if (!payload) {
      this.log.info('skipping direct list call (known to fail for this deployment)');
    }

    /**
     * Fallback: load the documents page and let the app fetch its own list.
     *
     * Needed because some of Progressive's API headers are route-scoped. Calling
     * `/v1/account/documents` with credentials harvested on `/app/account-home`
     * returns 400, while the identical URL with credentials harvested on
     * `/app/documents-hub/find-document` returns 200. Something in the
     * `x-prg*`/`x-pgr*` family is established by the documents route itself.
     *
     * Rather than reverse-engineer which header and how it is minted, this asks
     * the application to do it: navigate to the page, let it issue the call with
     * whatever it considers correct, and capture the response through the
     * observer already in place. A hard navigation is safe *here* — it costs the
     * in-memory token, but the app re-bootstraps from cookies, which the earlier
     * inspection runs confirmed works.
     *
     * Ordering is deliberate. The direct call is tried first because it is ~400ms
     * and needs no page load; this path is the slower, more reliable one. It also
     * refreshes `#apiHeaders` to the route-scoped set as a side effect, which is
     * what the document download itself then needs.
     */
    if (!payload) {
      this.log.info('direct API list failed; falling back to the documents page');
      payload = await this.timings.measure('list_documents_via_page', () =>
        this.#loadDocumentsPageAndCapture()
      );
    }

    if (!payload) {
      throw new CarrierError('Documents payload never arrived', {
        code: ErrorCodes.NO_DOCUMENTS,
        userMessage:
          'Signed in, but Progressive did not return a document list. Please try again.',
      });
    }

    const targetName = TARGET_LABELS[config.DOCUMENT_TARGET] ?? config.DOCUMENT_TARGET;

    const candidates = this.#selectDocuments(payload);
    if (candidates.length === 0) {
      /**
       * Report what was looked for and what the account actually holds. A bare
       * "no documents" is unhelpful when the cause is usually a target/account
       * mismatch rather than a failure — e.g. asking for ID cards on an account
       * that files none.
       */
      const seen = [
        ...new Set(
          (payload.accountDocuments ?? []).flatMap((a) =>
            (a.documents ?? []).flatMap((d) => (Array.isArray(d.categories) ? d.categories : []))
          )
        ),
      ].filter((c) => c !== 'All');

      this.log.warn(
        { target: config.DOCUMENT_TARGET, categoriesAvailable: seen },
        'no documents matched the configured target'
      );

      throw new CarrierError(`No ${config.DOCUMENT_TARGET} document in payload`, {
        code: ErrorCodes.NO_DOCUMENTS,
        userMessage: `Signed in, but no ${targetName} was listed on this account.${
          seen.length ? ` Available document categories: ${seen.join(', ')}.` : ''
        }`,
      });
    }

    this.notify(
      candidates.length === 1
        ? `Found your ${targetName}. Downloading…`
        : `Found ${candidates.length} matching documents. Downloading…`
    );

    /**
     * Timed separately as `document_download`.
     *
     * This is the one phase dominated by raw transfer speed rather than by
     * anything the system decides, so it has to be isolatable: a 90KB PDF over a
     * residential proxy on a bad link is not a latency regression in this code,
     * and a latency budget that cannot distinguish the two is not measuring
     * engineering quality.
     *
     * Kept as a single phase covering the whole loop rather than one per
     * document, so the metric stays comparable between accounts that have
     * different numbers of documents.
     */
    const documents = await this.timings.measure('document_download', async () => {
      const out = [];
      for (const candidate of candidates) {
        const fetched = await this.#downloadDocument(context, candidate);
        if (fetched) out.push(fetched);
      }
      return out;
    });

    if (documents.length === 0) {
      throw new CarrierError('Document links resolved but no PDF could be fetched', {
        code: ErrorCodes.NO_DOCUMENTS,
        userMessage:
          'Found your documents but could not download them. Progressive may have changed how documents are served.',
      });
    }
    return documents;
  }

  /**
   * Put the browser on an authenticated app route without discarding the token.
   *
   * If we are already inside the app, stay put — that is the whole point. Only
   * navigate when we are somewhere useless, and treat `/app/session-timeout` as
   * recoverable rather than terminal, because the SSO session usually outlives
   * the app session.
   */
  async #ensureAuthenticatedAppRoute() {
    const { page } = this;

    const inApp = () =>
      /policyservicing\.apps\.progressive\.com\/app\//.test(page.url()) &&
      !/\/app\/session-timeout/.test(page.url());

    // Already authenticated and inside the app: the token is live in this JS
    // context, so leave it alone.
    if (inApp() && this.#apiAuthOk) {
      this.log.info({ url: page.url() }, 'already authenticated inside the app; not navigating');
      return;
    }

    if (!inApp()) {
      await page.goto(ACCOUNT_HOME_URL, { waitUntil: 'domcontentloaded' });
    }

    if (await this.#confirmAuthenticated({ timeout: 15_000 })) return;

    // Not authenticated. A timeout screen is recoverable via SSO; anything else
    // is not something this method can fix.
    this.notify('Progressive timed the session out. Resuming…');
    if (
      (await this.#resumeIfOffered({ timeout: 15_000 })) &&
      (await this.#confirmAuthenticated({ timeout: 15_000 }))
    ) {
      return;
    }

    throw new CarrierError('Session timed out and could not be resumed', {
      code: ErrorCodes.NO_DOCUMENTS,
      userMessage:
        'Progressive signed this session out before the documents could be read. Please sign in again.',
    });
  }

  /**
   * Navigate to the documents page and wait for the app's own list request.
   *
   * The observer installed at login captures `/v1/account/documents` responses
   * wherever they come from, so this needs no scraping — the page is only being
   * used to make the app issue a correctly-credentialled request on our behalf.
   */
  async #loadDocumentsPageAndCapture() {
    const { page } = this;
    this.notify('Opening the documents page…');

    await page.goto(DOCUMENTS_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});

    // A hard navigation drops the in-memory token; if the app cannot re-establish
    // it from cookies we land on the timeout screen, which SSO can recover.
    if (/\/app\/session-timeout/.test(page.url())) {
      this.log.info('documents page bounced to session-timeout; attempting resume');
      if (await this.#resumeIfOffered({ timeout: 15_000 })) {
        await page.goto(DOCUMENTS_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
      }
    }

    const deadline = Date.now() + config.DOCUMENT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (this.#documentsPayload) {
        this.log.info(
          { headerCount: this.#apiHeaders ? Object.keys(this.#apiHeaders).length : 0 },
          'captured documents payload from the page, with route-scoped headers'
        );
        return this.#documentsPayload;
      }
      if (/\/access\/login|login\.progressive\.com/.test(page.url())) {
        this.log.warn('documents page bounced to login; session is gone');
        return null;
      }
      await page.waitForTimeout(150);
    }

    this.log.warn({ url: page.url() }, 'documents page never issued a list request');
    return null;
  }

  /** Poll until an authenticated `/policypro` request has been observed. */
  async #waitForApiHeaders({ timeout = 20_000 } = {}) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (this.#apiHeaders) return this.#apiHeaders;
      await this.page.waitForTimeout(150);
    }
    return null;
  }

  /**
   * Ask the documents API directly, using the app's borrowed credentials.
   *
   * A 401 here means the token went stale between harvest and use, which is worth
   * distinguishing from "no documents" so the error message is honest.
   */
  async #fetchDocumentsPayload(headers) {
    const url = `${API_BASE}/v1/account/documents`;
    const response = await this.context.request.get(url, {
      headers,
      timeout: config.DOCUMENT_TIMEOUT_MS,
    });

    if (response.status() === 401 || response.status() === 403) {
      throw new CarrierError(`Documents API rejected the borrowed token (${response.status()})`, {
        code: ErrorCodes.NO_DOCUMENTS,
        userMessage: 'Progressive signed this session out while reading your documents. Please try again.',
      });
    }

    if (!response.ok()) {
      /**
       * Log the response body, not just the status.
       *
       * Progressive's 400s are genuinely helpful — previous ones read
       * `"AccountSession header missing"` and `"policyInfoKey missing"`, each of
       * which named the fix exactly. Recording only the status code throws that
       * away and turns a one-line fix into another round of guessing.
       *
       * The header *names* go in too: comparing the set harvested here against a
       * set known to work is how a route-scoped header gets spotted.
       */
      const body = await response.text().catch(() => '');
      this.log.warn(
        {
          status: response.status(),
          contentType: response.headers()['content-type'],
          body: body.slice(0, 300),
          sentHeaderNames: Object.keys(headers ?? {}).sort(),
        },
        'documents list request failed'
      );
      return null;
    }

    try {
      const payload = await response.json();
      this.#documentsPayload = payload;
      this.log.info(
        { policies: payload?.accountDocuments?.length ?? 0 },
        'fetched documents list directly from the API'
      );
      return payload;
    } catch {
      return null;
    }
  }

  /**
   * Is this policy currently in force?
   *
   * Progressive says so explicitly at the account level, and the adapter used to
   * ignore it entirely. `account.terms` holds one entry per document type, each
   * with a `documentTerms` array of policy periods:
   *
   *   active   → documentTerms: [{ effectiveDate, expirationDate,
   *                                isEligibleForRealTimeDocument }]
   *   inactive → documentTerms: [], messageKey: 'Readonly',
   *              message: "This policy isn't active, so a current Declarations
   *                        Page isn't available…"
   *
   * Without this check a document from a lapsed policy is returned as a peer of
   * one from the live policy, which is how the wrong document got picked (F-28).
   */
  #policyStatus(account) {
    const terms = Array.isArray(account.terms) ? account.terms : [];
    const readonly = terms.some((t) => /readonly/i.test(t.messageKey ?? ''));
    const periods = terms.flatMap((t) => (Array.isArray(t.documentTerms) ? t.documentTerms : []));
    const newest = periods
      .slice()
      .sort((a, b) => Date.parse(b.effectiveDate ?? 0) - Date.parse(a.effectiveDate ?? 0))[0];

    return {
      active: periods.length > 0 && !readonly,
      readonly,
      termEffective: newest?.effectiveDate ?? null,
      termExpiration: newest?.expirationDate ?? null,
      realTimeAvailable: Boolean(newest?.isEligibleForRealTimeDocument),
    };
  }

  /**
   * Select the document(s) to retrieve.
   *
   * ---------------------------------------------------------------------------
   * HOW THIS RELATES TO THE PORTAL'S "FILTER VIEW" DROPDOWN
   * ---------------------------------------------------------------------------
   *
   * The documents page has a "Filter view:" `<select>` whose options come
   * straight from the API's own `filterCategories`:
   *
   *   All | Billing | DecPage | Contract | SentBy | Forms
   *   ("All Documents", "Billing Statements", "Declarations Page",
   *    "Policy Contracts", "Received By Progressive", "Signature Forms")
   *
   * Choosing "Policy Contracts" in that dropdown filters the already-fetched
   * list client-side by `categories.includes('Contract')`. This applies the same
   * category key to the same payload server-side, which is equivalent and
   * strictly more reliable: the `<select>` carries a machine-generated id that
   * changes on every page load (F-08), and there are two of them on screen — one
   * per policy — so driving the control means picking the right one first.
   *
   * ---------------------------------------------------------------------------
   * RANKING
   * ---------------------------------------------------------------------------
   *
   * Ordering is explicit rather than incidental, because the previous version
   * sorted on `archiveDate` as a *string* and then fell through to payload
   * order — i.e. list position, the exact thing its own comment claimed to
   * avoid. Two candidates on this test account share type, title, categories
   * AND archiveDate, so ties were resolved by nothing at all.
   *
   *   1. active policy before lapsed      (see #policyStatus)
   *   2. preferred document type          (the current form before older variants)
   *   3. newest archive date              (parsed as a date, not compared as text)
   *   4. highest archive index            (deterministic final tie-break)
   */
  #selectDocuments(payload, { targetKey = config.DOCUMENT_TARGET, limit = config.DOCUMENT_LIMIT } = {}) {
    const target = DOCUMENT_TARGETS[targetKey] ?? DOCUMENT_TARGETS.contract;
    const picked = [];

    for (const account of payload.accountDocuments ?? []) {
      const status = this.#policyStatus(account);

      for (const doc of account.documents ?? []) {
        const categories = Array.isArray(doc.categories) ? doc.categories : [];
        const type = String(doc.type ?? '').toUpperCase();

        /**
         * Match on the carrier's own taxonomy, not on title text. `categories`
         * and `type` are Progressive's identifiers; titles are user-facing copy
         * and localisable — "Español" is one click away on every page.
         */
        const matches =
          categories.includes(target.categoryKey) ||
          target.types.includes(type) ||
          (target.titlePattern?.test(`${doc.title ?? ''} ${doc.type ?? ''}`) ?? false);
        if (!matches) continue;

        picked.push({
          policyNumber: account.policyNumber,
          policyActive: status.active,
          policyReadonly: status.readonly,
          termEffective: status.termEffective,
          termExpiration: status.termExpiration,
          type: doc.type,
          title: doc.title ?? target.fallbackTitle,
          kind: target.kind,
          index: doc.index,
          archiveDate: doc.archiveDate,
          links: doc._links ?? {},
          actions: account.actions ?? [],
          // Lower is better; -1 means "not a preferred type".
          typeRank: target.types.indexOf(type),
        });
      }
    }

    picked.sort((a, b) => {
      if (a.policyActive !== b.policyActive) return a.policyActive ? -1 : 1;

      const rank = (c) => (c.typeRank === -1 ? Number.MAX_SAFE_INTEGER : c.typeRank);
      if (rank(a) !== rank(b)) return rank(a) - rank(b);

      const date = (c) => Date.parse(c.archiveDate ?? '') || 0;
      if (date(a) !== date(b)) return date(b) - date(a);

      return (Number(b.index) || 0) - (Number(a.index) || 0);
    });

    this.log.info(
      {
        target: targetKey,
        categoryKey: target.categoryKey,
        candidates: picked.length,
        limit,
        ranked: picked
          .slice(0, 5)
          .map((c) => `${c.type}#${c.index}@${c.archiveDate}${c.policyActive ? '' : ' (lapsed)'}`),
      },
      'document candidates ranked'
    );

    return picked.slice(0, Math.max(1, limit));
  }

  /**
   * Test seam for document selection.
   *
   * Selection is pure — payload in, ranked candidates out — and it is where the
   * wrong-document bug lived (F-28). Testing it directly means the ranking rules
   * can be verified in milliseconds against the real captured payload shape,
   * rather than by a live run that costs a login and an SMS and would pass
   * anyway: the run succeeds, the PDFs are valid, they are merely the wrong ones.
   *
   * Takes explicit overrides so a test can exercise every target without
   * reaching into frozen config or juggling environment variables.
   */
  selectDocumentsForTest(payload, overrides) {
    return this.#selectDocuments(payload, overrides);
  }

  /**
   * Fetch one document's bytes.
   *
   * Tries the HAL link the payload supplies, then the `Detail` action the
   * payload advertises. Both go through `context.request`, which shares the
   * browser's cookie jar and any Authorization header the SPA established, so
   * Progressive sees the same authenticated client without us reimplementing
   * its OAuth handling.
   */
  async #downloadDocument(context, candidate) {
    const attempts = [];

    /**
     * Only `_links.target` is a document. `_links.self` points back at
     * `/v1/account/documents`, the list endpoint — following it returns the
     * catalogue again, which then fails the PDF magic-byte check after a wasted
     * round trip. Filtering by rel here rather than trying everything keeps the
     * document phase inside its latency budget.
     */
    const target = candidate.links?.target;
    const targetHref = typeof target === 'string' ? target : target?.href;
    if (targetHref) {
      attempts.push({ how: 'link:target', method: 'GET', url: this.#absolute(targetHref) });
    }

    /**
     * `policyInfoKey` rides in the query string of the target href (e.g.
     * `WA-AA`, a state/product code). The POST variant rejected the request with
     * `400 "policyInfoKey missing"` until it was threaded through the body too,
     * so it is lifted out of the link rather than hardcoded — it differs per
     * policy and per state.
     */
    const policyInfoKey = (() => {
      try {
        return new URL(this.#absolute(targetHref ?? '')).searchParams.get('policyInfoKey');
      } catch {
        return null;
      }
    })();

    /**
     * POST fallback, used only if the GET link fails.
     *
     * `policyInfoKey` goes in the query string *and* the body: supplying it only
     * in the body still returned `400 "policyInfoKey missing"`, so the endpoint
     * evidently reads it from the query. Sending both costs nothing and removes
     * the guess.
     */
    const detail = (candidate.actions ?? []).find((a) => /^detail$/i.test(a.actionType ?? ''));
    if (detail?.serviceEndpointUrl) {
      const base = this.#absolute(
        detail.serviceEndpointUrl.replace('{policyNumber}', candidate.policyNumber)
      );
      const url = policyInfoKey
        ? `${base}${base.includes('?') ? '&' : '?'}policyInfoKey=${encodeURIComponent(policyInfoKey)}`
        : base;
      attempts.push({
        how: `action:${detail.actionType}`,
        method: (detail.httpMethod ?? 'POST').toUpperCase(),
        url,
        body: {
          documentType: candidate.type,
          index: candidate.index,
          policyNumber: candidate.policyNumber,
          ...(policyInfoKey ? { policyInfoKey } : {}),
        },
      });
    }

    if (!this.#apiHeaders) {
      // Should not happen: the documents page cannot render without the SPA
      // making at least one authenticated call. Worth stating explicitly, since
      // the alternative symptom is three confusing 401s.
      this.log.warn('no API headers captured; document fetch will likely 401');
    }

    for (const attempt of attempts) {
      try {
        const response = await context.request.fetch(attempt.url, {
          method: attempt.method,
          headers: this.#apiHeaders ?? undefined,
          ...(attempt.body ? { data: attempt.body } : {}),
          timeout: config.DOCUMENT_TIMEOUT_MS,
        });
        if (!response.ok()) {
          // Body included for the same reason as the list request: Progressive's
          // 4xx responses name the missing header or parameter.
          const body = await response.text().catch(() => '');
          this.log.warn(
            { how: attempt.how, status: response.status(), body: body.slice(0, 300) },
            'document attempt failed'
          );
          continue;
        }

        const contentType = (response.headers()['content-type'] ?? '').toLowerCase();
        let bytes = await response.body();

        // Some endpoints wrap the PDF in JSON as a base64 blob or hand back
        // another URL. Unwrap one level rather than surfacing JSON to the viewer.
        if (contentType.includes('json')) {
          const unwrapped = await this.#unwrapJsonDocument(context, bytes);
          if (!unwrapped) continue;
          bytes = unwrapped;
        }

        if (bytes.subarray(0, 5).toString('latin1') !== '%PDF-') {
          this.log.warn({ how: attempt.how, contentType }, 'response was not a PDF');
          continue;
        }

        this.log.info(
          { how: attempt.how, bytes: bytes.length, type: candidate.type, index: candidate.index },
          'document fetched'
        );

        /**
         * Make the returned document self-describing.
         *
         * Previously every candidate came back as `Declarations Page.pdf` with
         * label `Declarations Page`, so three genuinely different documents —
         * two same-day copies plus one from a lapsed policy — were
         * indistinguishable in the UI (F-28). The policy reference and archive
         * date are the two things that actually separate them.
         *
         * Policy number is truncated to its last four digits in the label, since
         * labels surface in the UI and in document metadata; the full value stays
         * in `meta` for correlation.
         */
        const policyRef = String(candidate.policyNumber ?? '').slice(-4);
        const descriptor = [
          policyRef ? `policy ••${policyRef}` : null,
          candidate.archiveDate ? `issued ${candidate.archiveDate}` : null,
          candidate.policyActive ? null : 'lapsed policy',
        ]
          .filter(Boolean)
          .join(' · ');

        return {
          name: `${candidate.title.replace(/[^\w -]+/g, '')}${policyRef ? ` ${policyRef}` : ''}.pdf`,
          label: descriptor ? `${candidate.title} — ${descriptor}` : candidate.title,
          kind: candidate.kind,
          mime: 'application/pdf',
          bytes,
          meta: {
            policyNumber: candidate.policyNumber,
            policyActive: candidate.policyActive,
            documentType: candidate.type,
            archiveIndex: candidate.index,
            archiveDate: candidate.archiveDate,
            termEffective: candidate.termEffective,
            termExpiration: candidate.termExpiration,
            via: attempt.how,
          },
        };
      } catch (err) {
        this.log.warn({ how: attempt.how, err: err.message }, 'document attempt threw');
      }
    }

    this.log.error(
      { title: candidate.title, attempted: attempts.map((a) => a.how) },
      'all document strategies failed'
    );
    return null;
  }

  /**
   * Unwrap Progressive's JSON document envelope.
   *
   * The document endpoint returns HTTP 200 with `application/json`, not
   * `application/pdf`. The actual file is base64 in a wrapper:
   *
   *   { "mimeType": "pdf", "document": "JVBERi0xLjcK..." }
   *
   * (`JVBERi0x` is base64 for `%PDF-1.`)
   *
   * This is why a naive implementation reports failure on a completely
   * successful request: the status is 200, the bytes are all there, and a
   * magic-byte check on the raw response sees `{"mim` and concludes it is not a
   * PDF. The envelope has to be opened first.
   *
   * `document` is the real key here. An earlier version of this method guessed
   * at `content` / `documentContent` / `data` / `fileContent` / `pdf` and missed,
   * so all the candidates are kept and the verified one is listed first.
   */
  async #unwrapJsonDocument(context, bytes) {
    try {
      const body = JSON.parse(bytes.toString('utf8'));

      const base64 =
        body.document ?? // verified: Progressive's actual key
        body.content ??
        body.documentContent ??
        body.data ??
        body.fileContent ??
        body.pdf;

      if (typeof base64 === 'string' && base64.length > 100) {
        // Tolerate a data: URI prefix and stray whitespace from pretty-printing.
        const cleaned = base64.replace(/^data:[^,]+,/, '').replace(/\s+/g, '');
        const decoded = Buffer.from(cleaned, 'base64');
        if (decoded.subarray(0, 5).toString('latin1') === '%PDF-') {
          this.log.info(
            { mimeType: body.mimeType, bytes: decoded.length },
            'unwrapped base64 PDF from JSON envelope'
          );
          return decoded;
        }
        this.log.warn(
          { mimeType: body.mimeType, decodedPrefix: decoded.subarray(0, 8).toString('latin1') },
          'envelope decoded but is not a PDF'
        );
      }

      // Some endpoints hand back a URL instead of bytes.
      const nested =
        body.url ?? body.documentUrl ?? body.downloadUrl ?? body._links?.document?.href;
      if (typeof nested === 'string') {
        const response = await context.request.get(this.#absolute(nested), {
          headers: this.#apiHeaders ?? undefined,
          timeout: config.DOCUMENT_TIMEOUT_MS,
        });
        if (response.ok()) return await response.body();
      }
    } catch (err) {
      this.log.warn({ err: err.message }, 'could not parse document envelope');
    }
    return null;
  }

  /** Progressive's payloads mix absolute URLs with API-relative ones. */
  #absolute(href) {
    if (/^https?:\/\//i.test(href)) return href;
    return `${API_BASE}/${String(href).replace(/^\/+/, '')}`;
  }

  // -- warm path ------------------------------------------------------------

  /**
   * Warm-path probe.
   *
   * Deliberately tolerant of the resume interstitial. A strict check here — "are
   * we on account-home with a greeting?" — reports false for a session that is
   * one click away from being usable, and the cost of that false negative is a
   * full credential login plus an SMS to the user's phone. Given the whole point
   * of the warm path is avoiding exactly that, it is worth spending a click to
   * find out.
   */
  async isSessionValid() {
    this.#installObservers();
    this.#apiAuthOk = false;
    try {
      await this.page.goto(ACCOUNT_HOME_URL, {
        waitUntil: 'domcontentloaded',
        timeout: config.NAV_TIMEOUT_MS,
      });

      if (await this.#confirmAuthenticated()) return true;

      // Not obviously in, but possibly resumable against the SSO session, which
      // normally outlives the app session.
      if (await this.#resumeIfOffered({ timeout: 15_000 })) {
        this.log.info('attempting to confirm session after SSO resume');
        return this.#confirmAuthenticated();
      }

      return false;
    } catch {
      return false;
    }
  }

  /**
   * Wait for definitive evidence about whether this session works.
   *
   * Resolves true only when an authenticated API call has succeeded, and false as
   * soon as the app lands somewhere that proves it has not.
   *
   * The previous version of this check matched the URL against a list of app
   * routes, and it produced confident false positives. Progressive's SPA serves
   * `/app/account-home`, *then* discovers it has no usable token, *then*
   * redirects to `/app/session-timeout`. Sampling the URL inside that window
   * reports a healthy session that is about to evaporate — and the caller then
   * skips the login it actually needed, failing later with a misleading
   * "no documents found".
   *
   * Waiting for a real 2xx on an authenticated request costs a second or two on
   * the warm path and removes an entire class of phantom failure.
   */
  async #confirmAuthenticated({ timeout = 18_000 } = {}) {
    const deadline = Date.now() + timeout;

    while (Date.now() < deadline) {
      if (this.#apiAuthOk) {
        this.log.info({ url: this.page.url() }, 'session confirmed by a successful API call');
        return true;
      }

      const url = this.page.url();
      // Definitive negatives: no point waiting out the timeout for these.
      if (/\/app\/session-timeout/.test(url)) {
        this.log.info('app redirected to session-timeout; session is dead');
        return false;
      }
      if (/\/access\/login|login\.progressive\.com/.test(url)) {
        this.log.info('bounced to the login app; session is dead');
        return false;
      }

      await this.page.waitForTimeout(150);
    }

    this.log.info({ url: this.page.url() }, 'no authenticated API call within timeout');
    return false;
  }

  /** Surfaced in logs and the repro tool to aid live debugging. */
  get debugState() {
    return {
      flowHistory: this.#flowHistory,
      flowSeq: this.#flowSeq,
      latestFlowStatus: this.#latestFlow?.status ?? null,
      // The distinction that matters: headers observed vs an authenticated call
      // that actually succeeded.
      apiHeaderCount: this.#apiHeaders ? Object.keys(this.#apiHeaders).length : 0,
      apiAuthOk: this.#apiAuthOk,
      documentsCaptured: Boolean(this.#documentsPayload),
      url: this.page?.url?.() ?? null,
    };
  }
}

export default ProgressiveCarrier;
