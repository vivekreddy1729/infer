import config from '../config.js';
import logger from '../logger.js';
import browserPool from './browserPool.js';
import { buildProxyConfig, newStickySessionId } from './proxy.js';

/**
 * A pool of browser pages already parked on carrier login forms.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS BUYS
 * ---------------------------------------------------------------------------
 *
 * On a cold Progressive pull, three phases happen *after* the user submits
 * credentials but depend on nothing the user typed:
 *
 *   acquire_context     ~0.8s
 *   nav_login           ~1.6s
 *   await_login_form    ~6.1s   (Angular bootstrapping; `domcontentloaded`
 *                                returns long before the form exists)
 *   ────────────────────────
 *   ~8.4s of a ~12.7s machine path
 *
 * None of it needs the username or password. Doing it in advance and adopting the
 * result turns the cold path into: type, submit, wait for the carrier.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS ONLY APPLIES TO THE COLD PATH
 * ---------------------------------------------------------------------------
 *
 * The warm path hydrates an encrypted `storageState` keyed by carrier *and*
 * username, so it cannot be prepared before the username is known. That is fine:
 * the warm path already runs in ~0.4s. The path that cannot be pre-warmed is the
 * one that does not need it, and the path that needs it requires no user data —
 * a pre-warmed page here is deliberately **anonymous**.
 *
 * ---------------------------------------------------------------------------
 * DESIGN CONSTRAINTS THIS RESPECTS
 * ---------------------------------------------------------------------------
 *
 * 1. **Never make a pull fail.** Adoption is strictly opportunistic. Every
 *    failure path falls back to a normal cold acquire. A parked page that has
 *    gone stale is discarded, not used hopefully.
 *
 * 2. **Staleness is real.** Progressive's login page mints a PingFederate
 *    `flowId` per load. Park a page too long and credentials submit against an
 *    expired flow — which would be worse than not pre-warming, because it fails
 *    *after* the user has typed. Entries carry a TTL and are re-validated
 *    immediately before adoption.
 *
 * 3. **Do not become a beacon.** Refreshing parked pages on a timer would mean
 *    dozens of login-page loads per hour from one residential IP with zero
 *    logins — a distinctive pattern, and the opposite of what the rest of the
 *    anti-bot work is for. So replenishment is **lazy**: one page per carrier,
 *    replaced only after it is consumed or found stale. Page loads stay
 *    proportional to real pulls rather than to wall-clock time.
 *
 * 4. **Sticky egress is preserved.** Each entry is created with its own sticky
 *    proxy session, and adopting it hands that session to the pull — so login,
 *    MFA and document fetch still leave from one IP.
 */

const log = logger.child({ module: 'warmPagePool' });

class WarmPagePool {
  /** carrierId -> entry */
  #entries = new Map();
  /** carrierId -> in-flight preparation, so bursts do not prepare twice. */
  #preparing = new Map();
  #enabled = false;
  #stats = { prepared: 0, adopted: 0, staleDiscarded: 0, prepareFailed: 0, missed: 0 };

  get enabled() {
    return this.#enabled;
  }

  /** Carriers that declare a `prewarm` block are eligible. */
  #spec(carrierClass) {
    const spec = carrierClass?.prewarm;
    if (!spec?.url || !spec?.readySelector) return null;
    return { ttlMs: config.PREWARM_TTL_MS, ...spec };
  }

  async start(carrierClasses) {
    if (!config.PREWARM_ENABLED) {
      log.info('pre-warming disabled');
      return;
    }
    this.#enabled = true;

    /**
     * Do not park a page at boot when running headed.
     *
     * Two reasons, and the first came from a user noticing it:
     *
     * 1. **It opens a visible window per carrier before anyone has done anything.**
     *    With two real carriers registered that is two browser windows appearing on
     *    the operator's screen at server start, which is alarming and looks broken.
     *    GEICO now requires headed mode (F-40), so this stopped being theoretical.
     *
     * 2. **It is the beacon pattern this design already rejected.** O-10 declined to
     *    refresh parked pages on a timer because repeatedly loading carrier login
     *    pages with no login following is a distinctive traffic signature. Parking
     *    at boot is a smaller version of the same thing: a page load caused by a
     *    process starting rather than by a user arriving.
     *
     * Nothing is lost. `POST /api/prewarm` is called by the UI when a carrier is
     * selected, which parks the page 15-30s before submission — earlier than needed
     * and strictly demand-driven. Boot parking only ever helped a pull that arrived
     * within the first TTL window, and F-31 found those pages had usually expired
     * before anyone got there anyway.
     *
     * Headless keeps the old behaviour so nothing changes for a deployed
     * configuration that is not driven interactively.
     */
    if (!config.HEADLESS) {
      log.info(
        { carriers: carrierClasses.filter((c) => this.#spec(c)).map((c) => c.id) },
        'headed mode: skipping boot-time page parking; pre-warm is demand-driven via POST /api/prewarm'
      );
      return;
    }

    for (const carrierClass of carrierClasses) {
      if (!this.#spec(carrierClass)) continue;
      // Deliberately not awaited: boot should not block on carrier reachability.
      this.prepare(carrierClass).catch(() => {});
    }
  }

  /**
   * Create a context, navigate to the login page, and wait for the form.
   *
   * Idempotent per carrier while in flight.
   */
  async prepare(carrierClass, attempt = 0) {
    const spec = this.#spec(carrierClass);
    if (!spec || !this.#enabled) return null;

    const id = carrierClass.id;
    if (this.#entries.has(id)) return this.#entries.get(id);
    if (this.#preparing.has(id)) return this.#preparing.get(id);

    const task = (async () => {
      const started = performance.now();
      let lease = null;
      try {
        const stickyId = newStickySessionId();
        const proxy =
          carrierClass.usesProxy && config.RESIDENTIAL_PROXY_URL ? buildProxyConfig(stickyId) : null;

        lease = await browserPool.acquireContext({
          proxy,
          // Anonymous on purpose: no storageState, so nothing user-specific is
          // baked into a page that any user's cold pull may adopt.
          storageState: null,
          blockStylesheets: carrierClass.blockStylesheets,
          extraAllow: carrierClass.extraAllow,
        });

        const page = await lease.context.newPage();
        /**
         * More generous than `NAV_TIMEOUT_MS`, on purpose.
         *
         * That timeout is sized for a navigation a user is waiting on, where
         * failing fast is the kind thing to do. Nobody is waiting on this one —
         * it is background work whose only job is to be ready later. A 20s
         * ceiling here was observed timing out against Progressive on a slow
         * load, which then left nothing parked and silently forfeited the whole
         * optimisation.
         */
        await page.goto(spec.url, {
          waitUntil: 'domcontentloaded',
          timeout: config.PREWARM_TIMEOUT_MS,
        });
        await page
          .locator(spec.readySelector)
          .first()
          .waitFor({ state: 'visible', timeout: spec.readyTimeoutMs ?? 25_000 });

        const entry = {
          carrierId: id,
          lease,
          page,
          proxy,
          stickyId,
          createdAt: Date.now(),
          expiresAt: Date.now() + spec.ttlMs,
          prepareMs: Math.round(performance.now() - started),
        };
        this.#entries.set(id, entry);
        this.#preparing.delete(id);
        this.#stats.prepared += 1;
        log.info(
          { carrierId: id, prepareMs: entry.prepareMs, ttlMs: spec.ttlMs },
          'parked a pre-warmed login page'
        );
        return entry;
      } catch (err) {
        this.#stats.prepareFailed += 1;
        await lease?.release?.().catch(() => {});
        // Never fatal: the cold path still works without us.
        log.warn(
          { carrierId: id, attempt, err: err.message.split('\n')[0] },
          'could not pre-warm login page'
        );

        /**
         * Retry with backoff, but only a couple of times.
         *
         * Without a retry, one slow page load forfeits the optimisation until the
         * next pull happens to trigger a fresh prepare — so the first real user
         * pays full price for a transient network blip.
         *
         * Bounded deliberately. Unbounded retrying against a carrier login page
         * is exactly the beacon pattern this pool is built to avoid: repeated
         * loads from one residential IP with no logins. Two retries keeps total
         * loads proportional to pulls plus failures.
         */
        if (attempt < 2 && this.#enabled) {
          const delay = 5_000 * (attempt + 1);
          setTimeout(() => {
            this.#preparing.delete(id);
            this.prepare(carrierClass, attempt + 1).catch(() => {});
          }, delay).unref?.();
        }
        return null;
      } finally {
        // Leave the slot claimed when a retry is scheduled, so a concurrent
        // adopt() does not start a competing prepare.
        if (!(attempt < 2)) this.#preparing.delete(id);
      }
    })();

    this.#preparing.set(id, task);
    return task;
  }

  /**
   * Hand over a ready page, or null.
   *
   * Ownership transfers to the caller, which becomes responsible for releasing
   * the lease. A replacement is prepared in the background.
   */
  async adopt(carrierClass) {
    const spec = this.#spec(carrierClass);
    if (!spec || !this.#enabled) return null;

    const id = carrierClass.id;
    const entry = this.#entries.get(id);
    if (!entry) {
      this.#stats.missed += 1;
      // Nothing parked — start one for next time.
      this.prepare(carrierClass).catch(() => {});
      return null;
    }

    this.#entries.delete(id);

    const reason = await this.#stalenessReason(entry, spec);
    if (reason) {
      this.#stats.staleDiscarded += 1;
      log.info({ carrierId: id, reason, ageMs: Date.now() - entry.createdAt }, 'discarding stale pre-warmed page');
      await entry.lease.release().catch(() => {});
      this.prepare(carrierClass).catch(() => {});
      return null;
    }

    this.#stats.adopted += 1;
    log.info(
      { carrierId: id, ageMs: Date.now() - entry.createdAt, prepareMs: entry.prepareMs },
      'adopted pre-warmed login page'
    );

    /**
     * Replace it so the next cold pull is also fast — but not while headed.
     *
     * Reported by a user: selecting GEICO opened one window, and submitting
     * credentials opened a *second* one while the work continued in the first. The
     * second window is this line. Adoption hands over the parked page, and the pool
     * immediately prepares a replacement, which under headed mode is a visible
     * browser window appearing mid-run for no reason the operator can see.
     *
     * Deferring it costs nothing real. The replacement exists for a *subsequent*
     * pull, and `POST /api/prewarm` already parks one when the user next selects a
     * carrier — earlier than this would have, and demand-driven. Preparing here as
     * well is redundant in the interactive case and actively confusing.
     *
     * Headless keeps the eager replacement, where there is no window to see and a
     * back-to-back pull is plausible.
     */
    if (config.HEADLESS) {
      this.prepare(carrierClass).catch(() => {});
    } else {
      log.info(
        { carrierId: id },
        'headed mode: not replacing the parked page now; the next carrier selection will'
      );
    }
    return entry;
  }

  /**
   * Why this entry must not be used, or null if it is fine.
   *
   * Checked at adoption rather than on a timer: the only moment staleness matters
   * is the moment before credentials are typed, and a timer-driven refresh is the
   * traffic pattern constraint 3 exists to avoid.
   */
  async #stalenessReason(entry, spec) {
    if (Date.now() > entry.expiresAt) return 'ttl-expired';
    if (entry.page.isClosed()) return 'page-closed';
    if (!entry.lease.context) return 'context-gone';

    try {
      // The form still has to be there and still has to be interactive. A page
      // that drifted to a timeout or error screen is worse than no page at all.
      const ready = await entry.page
        .locator(spec.readySelector)
        .first()
        .isVisible({ timeout: 1500 })
        .catch(() => false);
      if (!ready) return 'form-not-visible';

      if (spec.stalePattern && spec.stalePattern.test(entry.page.url())) return 'navigated-away';
    } catch (err) {
      return `probe-failed:${err.message.slice(0, 40)}`;
    }
    return null;
  }

  /**
   * Ensure a usable page is parked, refreshing one that is close to expiry.
   *
   * Called when a user signals intent — selecting a carrier in the UI — rather
   * than on a timer. That distinction is the whole point of constraint 3: a
   * timer would load carrier login pages continuously regardless of demand,
   * which is a recognisable pattern from a single residential IP. Demand-driven
   * refresh keeps page loads proportional to actual use.
   *
   * It also fixes the timing problem that lazy replenishment alone has. A page
   * parked at boot has usually expired by the time anyone arrives, so the first
   * real pull pays full price. Parking one when the carrier is selected puts it
   * ~15-30s ahead of the credentials being submitted — comfortably inside the
   * TTL, and comfortably inside the carrier's own per-load token lifetime.
   */
  async ensureFresh(carrierClass) {
    const spec = this.#spec(carrierClass);
    if (!spec || !this.#enabled) return { ready: false, reason: 'not-eligible' };

    const id = carrierClass.id;

    /**
     * Headed: keep at most one parked page, for the carrier last asked about.
     *
     * A user reported seeing a **Progressive** login window when they were trying to
     * use GEICO. Under headed mode every parked page is a visible browser window, so
     * a page held for a carrier the operator has moved on from is not a harmless
     * optimisation — it is a window they did not ask for, showing a carrier they are
     * not using, which reads as the app doing something wrong.
     *
     * Selecting a carrier is an unambiguous statement of intent, so anything parked
     * for a different one is now released at that moment. It also cuts idle carrier
     * sessions, which is the same argument as O-10's rejection of timer-based
     * refresh.
     *
     * Headless keeps every carrier parked: there is no window to confuse anyone, and
     * a server may legitimately serve concurrent pulls for different carriers.
     */
    if (!config.HEADLESS) {
      for (const [otherId, other] of [...this.#entries.entries()]) {
        if (otherId === id) continue;
        this.#entries.delete(otherId);
        log.info({ released: otherId, selected: id }, 'headed mode: releasing the parked page for a carrier no longer selected');
        await other.lease.release().catch(() => {});
      }
    }

    const entry = this.#entries.get(id);

    if (entry) {
      // Keep it only if it will still be valid after a plausible typing delay.
      const headroomMs = 30_000;
      const usable = Date.now() + headroomMs < entry.expiresAt && !entry.page.isClosed();
      if (usable) return { ready: true, reason: 'already-parked', ageMs: Date.now() - entry.createdAt };

      this.#entries.delete(id);
      await entry.lease.release().catch(() => {});
      log.info({ carrierId: id }, 'replacing a parked page that would expire mid-use');
    }

    // Not awaited: the caller is a UI hint, not a dependency.
    this.prepare(carrierClass).catch(() => {});
    return { ready: false, reason: 'preparing' };
  }

  /**
   * Test seam for the staleness validator.
   *
   * Exposed because this is the safety-critical part: every other failure mode
   * here costs latency, but handing over a stale page costs a failed login
   * *after* the user has typed their password. The refusal cases need to be
   * assertable directly rather than inferred from timing.
   */
  stalenessReasonForTest(entry, spec) {
    return this.#stalenessReason(entry, spec);
  }

  stats() {
    return {
      ...this.#stats,
      enabled: this.#enabled,
      parked: [...this.#entries.entries()].map(([carrierId, e]) => ({
        carrierId,
        ageMs: Date.now() - e.createdAt,
        expiresInMs: Math.max(0, e.expiresAt - Date.now()),
        prepareMs: e.prepareMs,
      })),
    };
  }

  async shutdown() {
    this.#enabled = false;
    for (const entry of this.#entries.values()) {
      await entry.lease.release().catch(() => {});
    }
    this.#entries.clear();
    this.#preparing.clear();
    log.info('warm page pool shut down');
  }
}

export const warmPagePool = new WarmPagePool();
export default warmPagePool;
