import crypto from 'node:crypto';
import config from '../config.js';
import { sessionLogger } from '../logger.js';
import browserPool from '../browser/browserPool.js';
import warmPagePool from '../browser/warmPagePool.js';
import { buildProxyConfig, newStickySessionId } from '../browser/proxy.js';
import { probeExitIp, verifyStillPinned } from '../browser/proxyHealth.js';
import { setLiveSessionEgress, clearLiveSessionEgress, invalidateEgressCache } from '../browser/egressStatus.js';
import storageStateStore from '../storage/storageStateStore.js';
import { putDocuments, dropSession } from '../storage/documentStore.js';
import Timings from '../telemetry/timings.js';
import metricsStore from '../telemetry/metricsStore.js';
import CredentialVault from './credentialVault.js';
import SessionStateMachine, { States } from './stateMachine.js';
import { CarrierError, ErrorCodes } from '../carriers/baseCarrier.js';

/**
 * Orchestrates one end-to-end policy pull.
 *
 * Owns the browser context, the carrier adapter, the state machine and the
 * credential vault for the lifetime of a single attempt, and guarantees they are
 * all torn down exactly once. The transport layer (WebSocket) only ever
 * subscribes to state transitions and forwards an MFA code in; it has no direct
 * access to the browser.
 *
 * The interesting control-flow problem is that this is a long-running async
 * process that must block mid-flight on human input, without holding a request
 * open or losing the browser context. That is handled with a deferred promise
 * (`#mfaDeferred`) the transport resolves, bounded by a timeout.
 */

const MAX_MFA_ATTEMPTS = 3;

export class PullSession {
  #machine;
  #vault;
  #timings;
  #lease = null;
  #carrier = null;
  #mfaDeferred = null;
  #cancelled = false;
  #metricsRecorded = false;
  /** In-flight session persistence, awaited at teardown but not by the user. */
  #persistPromise = null;
  /**
   * Saved state kept across a failed warm validation, for carriers that retain device
   * trust. Null for every carrier that does not opt in, which is the default.
   */
  #retainedState = null;
  /**
   * The proxy exit IP as it was when this session's context opened.
   *
   * Pinned once, then re-checked before the document fetch. Null when not proxied, or
   * when the pin could not be established — in which case the later check reports
   * "unchecked" rather than inventing a comparison.
   */
  #pinnedExitIp = null;
  /** Recorded in `finally`, so it must be tracked rather than passed down. */
  #outcome = 'COMPLETED';
  #errorCode = null;
  #log;

  constructor({ carrierClass, credentials }) {
    this.id = crypto.randomUUID();
    this.carrierClass = carrierClass;
    this.carrierId = carrierClass.id;
    this.createdAt = Date.now();

    this.#log = sessionLogger(this.id, this.carrierId);
    this.#machine = new SessionStateMachine({ sessionId: this.id, carrierId: this.carrierId });
    this.#vault = new CredentialVault(credentials);
    this.#timings = new Timings({ sessionId: this.id, carrierId: this.carrierId });

    this.result = null;
  }

  get machine() {
    return this.#machine;
  }

  get state() {
    return this.#machine.state;
  }

  get timings() {
    return this.#timings;
  }

  /** Subscribe to transitions and progress notes. */
  on(event, handler) {
    this.#machine.on(event, handler);
    return this;
  }

  /**
   * Drive the full flow. Resolves when the session reaches a terminal state;
   * never rejects, because failure is a state, not an exception, as far as the
   * transport is concerned.
   */
  async run() {
    try {
      this.#machine.transition(States.AUTHENTICATING);

      const username = this.#vault.usernameForKeying;
      const warm = await this.#tryWarmPath(username);

      if (!warm) {
        await this.#coldLogin();
      }

      if (this.#cancelled) return this.#finishCancelled();

      await this.#extractDocuments(username);
      return this.result;
    } catch (err) {
      this.#outcome = 'ERROR';
      this.#errorCode = err instanceof CarrierError ? err.code : ErrorCodes.NAVIGATION;
      this.#fail(err);
      // Written before cleanup, while the carrier adapter and its debugState are
      // still alive and can be captured.
      await this.#writeFailureBundle();
      return null;
    } finally {
      /**
       * Order matters. `#cleanup()` awaits the backgrounded session save, so
       * recording metrics after it means `persist_session` appears in the metrics
       * file with its real duration.
       *
       * The user-facing COMPLETED payload was already sent from
       * `#extractDocuments` without waiting for that save — which is the point of
       * backgrounding it. Metrics are for us and can afford to be complete;
       * the person watching cannot.
       */
      await this.#cleanup();
      await this.#recordMetrics(this.#outcome, this.#errorCode);
    }
  }

  /**
   * Snapshot everything about a failed run to disk.
   *
   * Written unprompted, because the evidence has to exist before anyone knows
   * they need it. Sessions are reaped within a minute of settling, so by the time
   * a user reports "it failed", the in-memory state is long gone and only the log
   * file remains — and correlating that by hand is exactly the work this avoids.
   *
   * Deliberately runs before `#cleanup()`, while the carrier adapter and its
   * debug state are still alive and can be captured.
   */
  async #writeFailureBundle() {
    try {
      const { buildSessionBundle, writeFailureBundle } = await import(
        '../diagnostics/diagnostics.js'
      );
      const bundle = await buildSessionBundle(this.id, { session: this, browserPool });
      // Carrier-specific internals: flow states, header counts, current URL.
      bundle.carrierDebug = this.#carrier?.debugState ?? null;
      await writeFailureBundle(bundle);
    } catch (err) {
      this.#log.warn({ err: err.message }, 'could not write failure bundle');
    }
  }

  // -- Warm path ------------------------------------------------------------

  /**
   * Attempt to resume a persisted session.
   *
   * This is where the "reliability and session reuse on repeat runs" requirement
   * is met, and where the latency story is won: it skips the login page, the
   * credential POST, the redirect chain and, critically, the entire human MFA
   * round-trip.
   *
   * Validation is a real navigation to an authenticated-only page rather than a
   * cookie-expiry check, because carriers invalidate server-side without
   * touching the cookie. If it does not hold up, the context is discarded and we
   * fall through to a cold login; a stale context must never be reused for
   * credential entry.
   */
  async #tryWarmPath(username) {
    if (!this.carrierClass.supportsSessionReuse) return false;

    const saved = await storageStateStore.load(this.carrierId, username);
    if (!saved) return false;

    this.#machine.note('Checking whether you are still signed in…', { ageMs: saved.ageMs });

    try {
      await this.#openContext({ storageState: saved.storageState });
      const valid = await this.#timings.measure('warm_validate', () =>
        this.#carrier.isSessionValid()
      );

      if (valid) {
        this.#log.info('warm path succeeded, skipping login and MFA');
        this.#machine.note('Still signed in. No password or code needed.');
        this.warmPath = true;
        return true;
      }

      /**
       * The session expired — but that is not the only thing in the saved state.
       *
       * ------------------------------------------------------------------------
       * WHY THIS NO LONGER ALWAYS CLEARS
       * ------------------------------------------------------------------------
       * `storageState` holds two kinds of cookie with very different lifetimes:
       *
       *   - the **session** cookie, short-lived, and what `isSessionValid()` tests
       *   - a **trusted-device** cookie, long-lived, which is what lets a carrier skip
       *     its MFA challenge for a browser it recognises
       *
       * Clearing everything because the session expired throws away the second to
       * punish the first. On GEICO the consequence is concrete and expensive: the user
       * is no longer challenged in their own browser, yet every automated pull got a
       * fresh context, was unrecognised, and paid a full human 2SV round-trip that the
       * carrier was willing to skip.
       *
       * Opt-in per carrier, read with a fallback so a carrier that does not declare it
       * behaves exactly as before. Progressive is untouched — its device trust was
       * never observed working (F-30), so retaining state there would add risk for no
       * benefit.
       */
      const retainsDeviceTrust = this.carrierClass.retainsDeviceTrust === true;

      if (retainsDeviceTrust) {
        this.#retainedState = saved.storageState;
        this.#log.info(
          { carrierId: this.carrierId, ageMs: saved.ageMs },
          'session expired but keeping saved state: it may still carry device trust'
        );
        this.#machine.note('Your previous sign-in has expired. Signing in again — you may not need a code.');
      } else {
        this.#machine.note('Your previous sign-in has expired. Signing in again.');
        await storageStateStore.clear(this.carrierId, username);
      }

      await this.#closeContext();
      return false;
    } catch (err) {
      this.#log.warn({ err: err.message }, 'warm path failed, falling back to cold login');
      await this.#closeContext();
      return false;
    }
  }

  // -- Cold path ------------------------------------------------------------

  async #coldLogin() {
    this.warmPath = false;

    /**
     * Hydrate with the retained state when the carrier keeps device trust.
     *
     * This is what makes the retention above worth anything: the trusted-device cookie
     * has to actually be present in the browser for the carrier to recognise it. A
     * cold login with the cookie is still a full credential submit — it just may not
     * need the MFA challenge, which is the part a human waits on.
     *
     * Not free of consequence, and worth stating. Hydrating a context with an expired
     * session cookie means a portal may show a "your session ended" interstitial
     * rather than a clean login form. That is why this is opt-in per carrier rather
     * than the default: GEICO's login route renders its form regardless, whereas
     * Progressive has a `/app/session-timeout` screen that needs explicit handling
     * (F-18) and gains nothing here.
     */
    const hydrate = this.#retainedState ?? null;
    if (hydrate) {
      this.#log.info({ carrierId: this.carrierId }, 'cold login with retained state (device trust may apply)');
    }
    await this.#openContext({ storageState: hydrate });

    const loginResult = await this.#timings.measure('login', () =>
      this.#vault.use((creds) => this.#carrier.login(creds))
    );

    // Some carriers can resume an existing SSO session instead of accepting
    // credentials. Tracked separately from the warm path because it is a
    // distinct workload with its own latency profile.
    this.resumed = Boolean(loginResult?.resumed);

    // Credentials are no longer needed once the portal has them. Wipe now
    // rather than at teardown, so they are not resident during the MFA wait,
    // which is the longest phase of the session.
    this.#vault.destroy();

    if (this.#cancelled) return;

    if (!loginResult?.mfaRequired) {
      this.#log.info('carrier did not challenge; proceeding straight to documents');
      return;
    }

    await this.#runMfaLoop(loginResult);
  }

  /**
   * MFA round-trip, with retries.
   *
   * Loops because a mistyped code is the single most likely failure in the whole
   * flow and carriers permit retries. Dropping the session on the first wrong
   * digit would mean a fresh login and a fresh SMS, which is a much worse
   * experience than the two extra states this costs.
   */
  async #runMfaLoop(loginResult) {
    for (let attempt = 1; attempt <= MAX_MFA_ATTEMPTS; attempt += 1) {
      this.#machine.transition(States.MFA_REQUIRED, {
        channel: loginResult.channel,
        hint: loginResult.hint,
        attempt,
        attemptsRemaining: MAX_MFA_ATTEMPTS - attempt + 1,
        // Demo portal only: surfaces the generated code so a walkthrough does
        // not need a real phone. Never populated for real carriers.
        demoCode: loginResult.demoCode,
      });

      const code = await this.#timings.measure('mfa_wait', () => this.#awaitMfaCode());
      if (this.#cancelled) return;

      this.#machine.transition(States.MFA_SUBMITTED);

      const outcome = await this.#timings.measure(`mfa_submit_${attempt}`, () =>
        this.#carrier.submitMfa(code)
      );

      /**
       * Check the contract before interpreting the result.
       *
       * `submitMfa()` must resolve to `{ accepted, retryable?, message? }`. Anything else
       * is an adapter bug, and without this check it is silently read as a rejected code:
       * `outcome?.accepted` is `undefined`, `!outcome?.retryable` is `true`, and the user
       * is told their verification code was wrong.
       *
       * That is not hypothetical. GEICO's `submitMfa` returned an async *function* rather
       * than calling it — a leftover IIFE that lost its invoking `()` during a refactor —
       * so the code was never typed and never submitted, no request reached the carrier,
       * and the user was told the code they had correctly entered was not accepted (F-53).
       * Diagnosing it meant noticing an ABSENCE in a diagnostic bundle: no
       * `/ws/mfa/otp/authenticate` call, and no log lines whatsoever between the code
       * being sent and the rejection.
       *
       * The guard belongs in this shared loop rather than in one adapter: this is the only
       * place that defines the contract, it covers every carrier including ones not written
       * yet, and it turns a confidently wrong answer into a loud one. Deliberately NOT
       * retryable — a malformed return will be malformed again, and retrying would spend
       * the user's remaining carrier attempts on a bug in our own code.
       */
      if (typeof outcome !== 'object' || outcome === null || typeof outcome.accepted !== 'boolean') {
        this.#log.error(
          { returned: Array.isArray(outcome) ? 'array' : typeof outcome, attempt },
          'submitMfa violated its contract; it must resolve to { accepted: boolean }'
        );
        throw new CarrierError(
          `${this.carrierId} adapter bug: submitMfa() resolved to `
            + `${Array.isArray(outcome) ? 'array' : typeof outcome}, expected { accepted: boolean }`,
          {
            code: ErrorCodes.ADAPTER_CONTRACT,
            // Carrier-agnostic on purpose: this file must not name a carrier. The point
            // of the wording is to stop blaming the user for a code that never left us.
            userMessage:
              'Something went wrong on our side before your code reached the carrier. '
              + 'The code you entered was not the problem. Please try again.',
          }
        );
      }

      if (outcome.accepted) return;

      if (!outcome.retryable || attempt === MAX_MFA_ATTEMPTS) {
        throw new CarrierError('MFA rejected', {
          code: ErrorCodes.MFA_REJECTED,
          userMessage: outcome.message ?? 'That verification code was not accepted.',
        });
      }

      this.#log.warn({ attempt }, 'MFA code rejected, retrying');
      loginResult = { ...loginResult, hint: outcome.message ?? loginResult.hint };
    }
  }

  /** Block until the transport supplies a code, or time out. */
  #awaitMfaCode() {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#mfaDeferred = null;
        reject(
          new CarrierError('MFA wait timed out', {
            code: ErrorCodes.MFA_REQUIRED_TIMEOUT,
            userMessage:
              'Timed out waiting for the verification code. The carrier session has expired, please start again.',
          })
        );
      }, config.MFA_WAIT_TIMEOUT_MS);
      timer.unref?.();

      this.#mfaDeferred = {
        resolve: (code) => {
          clearTimeout(timer);
          this.#mfaDeferred = null;
          resolve(code);
        },
        reject: (err) => {
          clearTimeout(timer);
          this.#mfaDeferred = null;
          reject(err);
        },
      };
    });
  }

  /**
   * Called by the transport when the user submits a code.
   *
   * ------------------------------------------------------------------------
   * CODES ARE ALPHANUMERIC — do not reintroduce digit-only stripping
   * ------------------------------------------------------------------------
   * This previously normalised with `.replace(/\D/g, '')`, which removes every
   * non-digit. Progressive and the demo portal both send six digits, so it looked
   * correct for the project's entire history.
   *
   * GEICO sends codes like **`326F40`**. That normaliser silently turned it into
   * `32640` — a five-character string the carrier has never issued — and submitted
   * it. The failure mode is the nastiest available: the carrier rejects the code,
   * the user is told the code was wrong, and they conclude they mistyped. Nothing
   * anywhere reports that the code was altered in transit.
   *
   * Stripping was presumably meant to tolerate a pasted code with a space or dash.
   * That intent is preserved by removing only separators and whitespace, which
   * cannot destroy a legitimate character.
   *
   * Uppercased because GEICO presents codes in uppercase and a field without
   * `autocapitalize` invites lowercase entry. Both Progressive and demo are
   * unaffected — uppercasing digits is a no-op.
   */
  submitMfaCode(code) {
    const normalised = String(code ?? '')
      .trim()
      .replace(/[\s\u2010-\u2015-]/g, '')   // whitespace, hyphens and unicode dashes
      .toUpperCase();

    if (!this.#mfaDeferred) return { ok: false, error: 'Not waiting for a code right now.' };

    /**
     * Length only — never a character-class check.
     *
     * A carrier is free to use letters, digits, or both, and validating the shape
     * here would mean rejecting a valid code from a carrier nobody has onboarded
     * yet. The carrier is the authority on its own code format; our job is to pass
     * it through unaltered.
     */
    if (normalised.length < 4) return { ok: false, error: 'Enter the code from your phone or email.' };
    if (normalised.length > 12) return { ok: false, error: 'That code looks too long. Please re-check it.' };

    this.#mfaDeferred.resolve(normalised);
    return { ok: true };
  }

  // -- Documents ------------------------------------------------------------

  async #extractDocuments(username) {
    this.#machine.transition(States.EXTRACTING_DOCS);

    /**
     * Confirm the proxy has not rotated before fetching documents.
     *
     * ------------------------------------------------------------------------
     * WHY HERE SPECIFICALLY
     * ------------------------------------------------------------------------
     * This is the point of maximum exposure. Everything before it happened within
     * seconds of the context opening; this runs *after* the human MFA wait, which has
     * been measured between 11.9s and 23.8s and is allowed up to 180s. Residential
     * sticky sessions expire, and the upstream node — someone's actual home connection
     * — can drop at any moment regardless of TTL.
     *
     * If the exit IP changed while the user was reading a text, the carrier now sees a
     * session that logged in from one city and is requesting documents from another.
     * It invalidates the session, and the error arrives as "your session expired" or
     * an empty document list. That points at cookies, selectors or anti-bot — three
     * layers away from the cause.
     *
     * This cannot prevent a rotation. No client can; the IP is not ours. What it does
     * is name it, which given the alternative attributions is most of the value.
     *
     * Deliberately NOT fatal. A rotation does not guarantee failure — the carrier may
     * not check, or may tolerate it — and aborting a pull that would have succeeded is
     * worse than proceeding with a warning. The document fetch either works or fails
     * on its own merits, and if it fails the log already says why.
     */
    if (this.proxied) {
      const pinned = this.#pinnedExitIp;
      const verdict = await verifyStillPinned(this.#lease.context, pinned);
      if (verdict.checked && verdict.stable === false) {
        this.#log.error(
          { pinnedIp: verdict.pinnedIp, currentIp: verdict.currentIp },
          'proxy rotated between login and document fetch; the carrier may reject this session'
        );
        this.#machine.note(
          'The proxy changed IP while waiting for your code. If this fails, that is why.'
        );
        this.proxyRotated = true;
      } else if (verdict.checked) {
        this.#log.info({ ip: verdict.ip }, 'proxy exit IP still pinned');
      }
    }

    const documents = await this.#timings.measure('documents', () =>
      this.#carrier.fetchDocuments()
    );

    /**
     * Persist the authenticated session, but do not make the user wait for it.
     *
     * This is bookkeeping for *future* runs — it has no bearing on the documents
     * already in hand. Awaiting it put ~110ms of disk and crypto work between
     * retrieving the PDFs and showing them, for no benefit to the person waiting.
     *
     * Kicked off here rather than after the COMPLETED transition because the
     * browser context is still open; `#cleanup()` closes it, and
     * `exportStorageState()` needs it alive. The promise is captured so teardown
     * can await it, so "don't block the user" does not become "lose the session
     * on a fast shutdown".
     *
     * Still timed, so the metrics show its cost even though it is off the
     * critical path.
     */
    if (this.carrierClass.supportsSessionReuse) {
      /**
       * `reserve()`, not `save()` — the export is inside the reservation.
       *
       * `exportStorageState()` is a round-trip into the browser, and until it returns
       * there is nothing to hand `save()`. A pull started in that gap reads an empty
       * store and pays a cold login plus a human MFA round-trip; it was measured
       * happening with 5ms to spare (F-50). Reserving first puts the export inside the
       * window a concurrent `load()` waits on, which is the point.
       */
      this.#persistPromise = this.#timings
        .measure('persist_session', () =>
          storageStateStore.reserve(this.carrierId, username, () =>
            this.#carrier.exportStorageState()
          )
        )
        .catch((err) => {
          // A failed save costs a slow next run, nothing more.
          this.#log.warn({ err: err.message }, 'could not persist session');
        });
    }

    const meta = putDocuments(this.id, documents);
    const blocking = this.#lease?.blockingStats?.() ?? {};

    this.result = {
      documents: meta,
      timings: this.#timings.summary(),
      warmPath: Boolean(this.warmPath),
      transport: {
        driver: this.#lease?.driver,
        channel: this.#lease?.channel,
        persistentProfile: Boolean(this.#lease?.persistent),
        prewarmed: Boolean(this.prewarmed),
        proxied: Boolean(this.proxied),
        requestsBlocked: blocking.blocked ?? 0,
        requestsBlockedPct: blocking.blockedPct ?? 0,
      },
    };

    this.#machine.transition(States.COMPLETED, {
      message: this.warmPath
        ? 'Documents retrieved using a saved session.'
        : 'Documents retrieved.',
      ...this.result,
    });
  }

  /**
   * Persist this run's phase timings for the metrics page.
   *
   * Recorded for failures as well as successes. Where a run dies is often more
   * informative than how long a healthy one takes — a cluster of ERRORs at
   * `documents` says something quite different from a cluster at `login`, and
   * averaging only the successes would hide it entirely.
   *
   * Awaited rather than fired and forgotten, because the session is torn down
   * immediately afterwards and an unawaited append can lose the record.
   */
  async #recordMetrics(outcome, errorCode = null) {
    if (this.#metricsRecorded) return;
    this.#metricsRecorded = true;
    const summary = this.#timings.summary();
    await metricsStore.record({
      runId: this.id,
      carrierId: this.carrierId,
      outcome,
      errorCode,
      warmPath: Boolean(this.warmPath),
      resumed: Boolean(this.resumed),
      wallMs: summary.wallMs,
      machineMs: summary.machineMs,
      humanMs: summary.humanMs,
      phases: summary.phases,
      documents: this.result?.documents?.length ?? 0,
      transport: this.result?.transport ?? null,
    });
  }

  // -- Context plumbing -----------------------------------------------------

  async #openContext({ storageState }) {
    const useProxy = this.carrierClass.usesProxy && Boolean(config.RESIDENTIAL_PROXY_URL);
    const stickyId = newStickySessionId();
    const proxy = useProxy ? buildProxyConfig(stickyId) : null;
    this.proxied = Boolean(proxy);

    if (this.carrierClass.usesProxy && !proxy) {
      this.#machine.note(
        'No residential proxy configured. Real carriers usually block datacenter IPs.'
      );
    }

    const opts = {
      proxy,
      storageState,
      blockStylesheets: this.carrierClass.blockStylesheets,
      extraAllow: this.carrierClass.extraAllow,
    };

    /**
     * On the cold path, try to adopt a page already parked on the login form.
     *
     * Only the cold path, and only when no `storageState` is being hydrated: a
     * pre-warmed page is deliberately anonymous, so it is useless for resuming a
     * saved session and perfect for a fresh login. The warm path is ~0.4s anyway.
     *
     * Strictly opportunistic — `adopt()` returns null for anything it is not
     * certain about, and we fall through to a normal acquire. Pre-warming must
     * never be able to turn a working pull into a failed one.
     */
    let page = null;
    if (!storageState) {
      const adopted = await this.#timings.measure('adopt_prewarmed', () =>
        warmPagePool.adopt(this.carrierClass)
      );
      if (adopted) {
        this.#lease = adopted.lease;
        page = adopted.page;
        this.prewarmed = true;
        // The parked page carries its own sticky proxy session; the pull inherits
        // it so login, MFA and documents still egress from one IP.
        this.proxied = Boolean(adopted.proxy);
        /**
         * Internal: a latency optimisation, not a step the user took.
         *
         * "Reusing" and "skipping" both read like corner-cutting to someone watching
         * their own login happen. Still logged and still in the timeline, because it is
         * the only evidence pre-warm adoption fired.
         */
        this.#machine.note('Reusing a pre-opened carrier tab, skipping page load.', {}, { internal: true });
      }
    }

    if (!page) {
      this.#lease = await this.#timings.measure('acquire_context', () =>
        this.carrierClass.usePersistentProfile
          ? browserPool.acquirePersistentContext({
              profileKey: `${this.carrierId}:${this.#vault.destroyed ? this.id : this.#vault.usernameForKeying}`,
              ...opts,
            })
          : browserPool.acquireContext(opts)
      );
      page = await this.#lease.context.newPage();
    }
    /**
     * Pin the exit IP for this session.
     *
     * Done once, here, because everything that follows must leave from this address:
     * a carrier that sees login and document-fetch from different IPs treats it as a
     * hijacked session. Costs one request against an IP echo service.
     *
     * Failure to establish a pin is not fatal and is not retried. The pin is a
     * diagnostic aid, not a precondition — if the echo services are unreachable the
     * pull should still proceed, and the later check will simply report that it could
     * not compare.
     */
    if (this.proxied) {
      const probe = await this.#timings.measure('proxy_pin', () =>
        probeExitIp(this.#lease.context)
      );
      if (probe.ok) {
        this.#pinnedExitIp = probe.ip;
        // Publish it so every open page shows the address the carrier is actually
        // being shown, rather than a probe from minutes ago.
        setLiveSessionEgress({ ip: probe.ip, carrierId: this.carrierId, sessionId: this.id });
        this.#log.info(
          { exitIp: probe.ip, via: probe.service, latencyMs: probe.latencyMs },
          'proxy exit IP pinned for this session'
        );
      } else {
        this.#log.warn({ err: probe.error }, 'could not pin the proxy exit IP; rotation detection disabled for this run');
      }
    }

    this.#carrier = new this.carrierClass({
      page,
      context: this.#lease.context,
      timings: this.#timings,
      log: this.#log,
      notify: (msg, detail, opts) => this.#machine.note(msg, detail, opts),
    });
  }

  async #closeContext() {
    await this.#lease?.release?.();
    this.#lease = null;
    this.#carrier = null;
  }

  // -- Teardown -------------------------------------------------------------

  cancel(reason = 'Cancelled.') {
    if (this.#machine.isTerminal) return;
    this.#cancelled = true;
    this.#mfaDeferred?.reject(
      new CarrierError(reason, { code: 'CANCELLED', userMessage: reason })
    );
    this.#machine.fail(new Error(reason), { code: 'CANCELLED', message: reason });
  }

  #finishCancelled() {
    this.#log.info('session cancelled');
    return null;
  }

  #fail(err) {
    const isCarrierError = err instanceof CarrierError;
    this.#log.error(
      { err: err.message, code: isCarrierError ? err.code : 'UNEXPECTED', stack: err.stack },
      'session failed'
    );
    this.#machine.fail(err, {
      code: isCarrierError ? err.code : ErrorCodes.NAVIGATION,
      // Never surface a raw Playwright error: they leak selectors and paths.
      message: isCarrierError
        ? err.userMessage
        : 'The carrier portal did not respond as expected. Please try again.',
    });
  }

  async #cleanup() {
    this.#vault.destroy();

    /**
     * Stop advertising this session's exit IP.
     *
     * The badge would otherwise keep showing a dead session's address as if it were
     * live. The cache is invalidated too: this pull held a sticky session that is now
     * released, so the next probe should establish the current exit rather than serve
     * the one that just ended.
     */
    clearLiveSessionEgress(this.id);
    if (this.proxied) invalidateEgressCache();

    /**
     * Let the backgrounded session save finish before closing the context it
     * reads from. Bounded, because a hung save must not hold a browser context
     * open indefinitely — losing the warm path on one run is much cheaper than
     * leaking a Chrome process.
     */
    if (this.#persistPromise) {
      await Promise.race([
        this.#persistPromise,
        new Promise((resolve) => setTimeout(resolve, 3000)),
      ]).catch(() => {});
    }
    await this.#closeContext();
  }

  /** Called when the session is evicted; drops retrieved PDFs from memory. */
  dispose() {
    dropSession(this.id);
  }
}

export default PullSession;
