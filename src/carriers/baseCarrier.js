import config from '../config.js';
import logger from '../logger.js';

/**
 * Contract every carrier adapter implements, plus the shared primitives that
 * make writing one tractable.
 *
 * The abstraction earns its place because the *shape* of the problem is
 * identical across carriers even though every selector differs: navigate, fill
 * credentials, submit, then handle an outcome you cannot predict; if that
 * outcome is a challenge, round-trip a code through a human; then find and
 * download a PDF. The per-carrier work is selectors and URLs. The control flow,
 * the racing, the timing and the error taxonomy are shared and live here.
 */

/**
 * Error with a message intended for a human. Anything thrown without this gets
 * a generic message at the UI boundary, because raw Playwright errors leak
 * selectors and internal paths.
 */
export class CarrierError extends Error {
  constructor(message, { code = 'CARRIER_ERROR', userMessage, retryable = false, cause } = {}) {
    super(message, { cause });
    this.name = 'CarrierError';
    this.code = code;
    this.userMessage = userMessage ?? message;
    this.retryable = retryable;
  }
}

export const ErrorCodes = Object.freeze({
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  MFA_REQUIRED_TIMEOUT: 'MFA_REQUIRED_TIMEOUT',
  MFA_REJECTED: 'MFA_REJECTED',
  BOT_WALL: 'BOT_WALL',
  CAPTCHA: 'CAPTCHA',
  ACCOUNT_LOCKED: 'ACCOUNT_LOCKED',
  NO_DOCUMENTS: 'NO_DOCUMENTS',
  SELECTOR_DRIFT: 'SELECTOR_DRIFT',
  NAVIGATION: 'NAVIGATION',
  TIMEOUT: 'TIMEOUT',
  /**
   * An adapter returned something its interface does not allow.
   *
   * Distinct from every code above, all of which describe something the *carrier* did.
   * This one means our own code is wrong, and the distinction is not cosmetic: without
   * it, an adapter bug gets reported using the nearest carrier-shaped code and the user
   * is told their credentials or their verification code were rejected when neither was
   * ever sent. See F-53, where exactly that happened.
   */
  ADAPTER_CONTRACT: 'ADAPTER_CONTRACT',
});

/** MFA delivery channel, surfaced so the UI can say where to look. */
export const MfaChannel = Object.freeze({
  SMS: 'SMS',
  EMAIL: 'EMAIL',
  VOICE: 'VOICE',
  APP: 'APP',
  UNKNOWN: 'UNKNOWN',
});

export class BaseCarrier {
  /** Stable identifier used in the API, the dropdown, and session keying. */
  static id = 'base';
  static displayName = 'Base Carrier';

  /** Set false for carriers that hard-invalidate cookies on every login. */
  static supportsSessionReuse = true;

  /** Opt in once a carrier's selectors are proven not to need layout. */
  static blockStylesheets = false;

  /** Carrier-specific URL fragments the resource blocker must never drop. */
  static extraAllow = [];

  /** Persistent Chrome profile instead of a pooled context. */
  static usePersistentProfile = false;

  /**
   * Route this carrier through the residential proxy. Real carriers: true.
   * Loopback targets like the demo portal: false, since proxying traffic back to
   * ourselves would both fail and burn metered bandwidth.
   */
  static usesProxy = true;

  constructor({ page, context, timings, log = logger, notify = () => {} }) {
    this.page = page;
    this.context = context;
    this.timings = timings;
    this.log = log.child({ carrier: this.constructor.id });
    /** Push a progress line to the UI without changing state. */
    this.notify = notify;
  }

  // -- Required overrides ---------------------------------------------------

  /**
   * Navigate to the portal and submit credentials.
   * Must return `{ mfaRequired: boolean, channel?: string, hint?: string }`.
   */
  async login() {
    throw new Error(`${this.constructor.id}: login() not implemented`);
  }

  /**
   * Inject the user's code and submit.
   * Return `{ accepted: true }`, or `{ accepted: false, retryable: true }` when
   * the carrier says the code was wrong but will accept another.
   */
  async submitMfa(_code) {
    throw new Error(`${this.constructor.id}: submitMfa() not implemented`);
  }

  /**
   * Locate and download policy documents from an authenticated session.
   * Return `[{ name, mime, bytes: Buffer, kind, meta? }]`.
   */
  async fetchDocuments() {
    throw new Error(`${this.constructor.id}: fetchDocuments() not implemented`);
  }

  /**
   * Cheap authenticated-or-not probe used on the warm path. Should navigate to
   * a page that only renders when logged in and report whether it did, without
   * touching credentials.
   */
  async isSessionValid() {
    return false;
  }

  // -- Shared primitives ----------------------------------------------------

  /**
   * Race several possible page outcomes and report which happened first.
   *
   * This is the single most useful primitive in portal automation. After a
   * credential submit the next screen is genuinely non-deterministic: MFA
   * challenge, straight to the dashboard, inline validation error, device-trust
   * interstitial, "we texted you" upsell, or a bot wall. Sequentially waiting
   * for the one you hope for means every other branch costs a full timeout and
   * then reports the wrong cause.
   *
   * @param {Record<string, string|function>} outcomes  name -> selector or predicate
   * @param {object} opts
   * @returns {Promise<{ outcome: string, elapsedMs: number }>}
   */
  async raceOutcomes(outcomes, { timeout = 20_000, pollMs = 120 } = {}) {
    const started = performance.now();
    const entries = Object.entries(outcomes);
    const deadline = started + timeout;

    while (performance.now() < deadline) {
      for (const [name, matcher] of entries) {
        try {
          if (typeof matcher === 'function') {
            if (await matcher(this.page)) {
              return { outcome: name, elapsedMs: Math.round(performance.now() - started) };
            }
          } else {
            // count() then isVisible() avoids Playwright's auto-wait, which
            // would serialise what we are trying to parallelise.
            const loc = this.page.locator(matcher).first();
            if ((await loc.count()) > 0 && (await loc.isVisible().catch(() => false))) {
              return { outcome: name, elapsedMs: Math.round(performance.now() - started) };
            }
          }
        } catch {
          // Navigation mid-poll invalidates locators. Expected; retry.
        }
      }
      await this.page.waitForTimeout(pollMs);
    }

    throw new CarrierError(`No expected outcome within ${timeout}ms`, {
      code: ErrorCodes.TIMEOUT,
      userMessage: 'The carrier portal stopped responding as expected. Please try again.',
    });
  }

  /** First visible locator from a list of candidate selectors, or null. */
  async firstVisible(selectors, { timeout = 8000 } = {}) {
    const deadline = performance.now() + timeout;
    while (performance.now() < deadline) {
      for (const sel of selectors) {
        try {
          const loc = this.page.locator(sel).first();
          if ((await loc.count()) > 0 && (await loc.isVisible().catch(() => false))) return loc;
        } catch {
          /* retry */
        }
      }
      await this.page.waitForTimeout(100);
    }
    return null;
  }

  /**
   * Type with per-character delay and a click first.
   *
   * Not theatre. Portals commonly bind validation to `input`/`keyup`, and a
   * value set in one shot fires neither, so the submit button stays disabled and
   * the run fails for a reason that looks nothing like the actual cause. The
   * jitter also clears the crudest behavioural check, which is "entire field
   * populated within one event-loop tick". It does not defeat real keystroke
   * biometrics and is not claimed to.
   */
  async typeLikeHuman(
    locator,
    text,
    { minDelay = config.TYPE_MIN_DELAY_MS, maxDelay = config.TYPE_MAX_DELAY_MS } = {}
  ) {
    await locator.click({ timeout: 8000 });
    for (const ch of text) {
      await locator.press(ch === ' ' ? 'Space' : ch, {
        delay: minDelay + Math.random() * (maxDelay - minDelay),
      });
    }
  }

  /**
   * Detect a bot wall or captcha and fail fast with an honest message.
   *
   * Worth doing explicitly: a challenge page has none of our selectors, so
   * without this check the symptom is a 20s timeout and a misleading
   * "selector not found". Naming the real cause is the difference between a
   * debuggable failure and a mysterious one.
   */
  async assertNotBlocked() {
    const signals = [
      { sel: 'iframe[src*="recaptcha"]', code: ErrorCodes.CAPTCHA, label: 'reCAPTCHA' },
      { sel: 'iframe[src*="hcaptcha"]', code: ErrorCodes.CAPTCHA, label: 'hCaptcha' },
      { sel: 'iframe[title*="challenge" i]', code: ErrorCodes.CAPTCHA, label: 'challenge frame' },
      { sel: '#px-captcha', code: ErrorCodes.BOT_WALL, label: 'PerimeterX' },
      { sel: '[id*="datadome"]', code: ErrorCodes.BOT_WALL, label: 'DataDome' },
    ];

    for (const { sel, code, label } of signals) {
      const loc = this.page.locator(sel).first();
      if ((await loc.count().catch(() => 0)) > 0) {
        throw new CarrierError(`Blocked by ${label}`, {
          code,
          userMessage:
            'The carrier flagged this sign-in as automated. This usually means the residential proxy is not active or its IP is burned.',
        });
      }
    }

    // Text-level tells, checked on body copy rather than the whole DOM to keep
    // false positives down.
    const body = await this.page.locator('body').innerText().catch(() => '');
    const lowered = body.toLowerCase().slice(0, 4000);
    const phrases = [
      'access denied',
      'request unsuccessful',
      'unusual activity',
      'automated traffic',
      'incapsula incident',
      'reference #',
      'verify you are a human',
      'pardon our interruption',
    ];
    const hit = phrases.find((p) => lowered.includes(p));
    if (hit) {
      throw new CarrierError(`Bot wall text detected: "${hit}"`, {
        code: ErrorCodes.BOT_WALL,
        userMessage:
          'The carrier served an anti-bot interruption page instead of the login form. Check that residential egress is configured.',
      });
    }
  }

  /** Export cookies + localStorage for the encrypted session store. */
  async exportStorageState() {
    return this.context.storageState();
  }

  /**
   * Carrier-specific state captured into failure bundles.
   *
   * Defined on the base class so every adapter contributes something to a
   * diagnostic report rather than a bare `null`. Subclasses should override and
   * add whatever made their own debugging possible — for Progressive that is the
   * PingFederate flow history and whether an authenticated API call succeeded.
   *
   * Must never include credentials, tokens or cookies: these bundles are written
   * to disk expressly to be shared.
   */
  get debugState() {
    return {
      carrier: this.constructor.id,
      url: this.page?.url?.() ?? null,
    };
  }
}

export default BaseCarrier;
