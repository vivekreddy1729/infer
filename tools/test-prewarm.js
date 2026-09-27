/**
 * Tests the warm page pool against a real carrier login page.
 *
 * Read-only: it parks a login page, adopts it, and measures. No credentials are
 * typed and nothing is submitted.
 *
 * The properties that matter are not "does it go faster" — that part is easy —
 * but the safety ones, because a pre-warm that hands over a stale page fails
 * *after* the user has typed their password, which is strictly worse than no
 * pre-warm at all:
 *
 *   - adoption of a good page is near-instant
 *   - a second adoption without a replacement returns null rather than reusing
 *   - an expired TTL is refused
 *   - a page that navigated away is refused
 *   - a closed page is refused
 *   - every refusal falls back cleanly instead of throwing
 *
 *   node tools/test-prewarm.js
 *   node tools/test-prewarm.js --carrier demo    # loopback, no external traffic
 */

const useDemo = process.argv.includes('--carrier') && process.argv.includes('demo');

process.env.HEADLESS = process.env.HEADLESS ?? 'true';
process.env.PREWARM_ENABLED = 'true';

const { default: config } = await import('../src/config.js');
const { default: browserPool } = await import('../src/browser/browserPool.js');
const { default: warmPagePool } = await import('../src/browser/warmPagePool.js');
const { ProgressiveCarrier } = await import('../src/carriers/progressive.js');

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
  if (!ok) failures += 1;
};

/**
 * A loopback stand-in so the safety properties can be exercised without
 * repeatedly loading a real carrier's login page.
 */
class LoopbackCarrier {
  static id = 'prewarm-test';
  static usesProxy = false;
  static blockStylesheets = false;
  static extraAllow = [];
  static prewarm = {
    url: `http://127.0.0.1:${config.PORT}/mock-portal/login`,
    readySelector: 'input[type="password"]',
    readyTimeoutMs: 10_000,
    stalePattern: /verify|documents/i,
  };
}

const carrier = useDemo ? LoopbackCarrier : ProgressiveCarrier;
console.log(`Warm page pool — target: ${carrier.id}\n`);

await browserPool.warm();
await warmPagePool.start([carrier]);

// --- 1. it parks a page ----------------------------------------------------
{
  // start() does not await preparation, so wait for the parked page to appear.
  const deadline = Date.now() + 40_000;
  let parked = [];
  while (Date.now() < deadline) {
    parked = warmPagePool.stats().parked;
    if (parked.length) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  check('parks a login page', parked.length === 1, JSON.stringify(parked[0] ?? null));
  if (parked[0]) console.log(`        prepare cost: ${parked[0].prepareMs}ms  <-- this is what adoption saves`);
}

// --- 2. adoption is near-instant -------------------------------------------
let adopted = null;
{
  const t = Date.now();
  adopted = await warmPagePool.adopt(carrier);
  const elapsed = Date.now() - t;
  check('adopts a parked page', Boolean(adopted), adopted ? `after ${elapsed}ms` : 'got null');
  check('adoption is fast (validation only, no page load)', elapsed < 2500, `${elapsed}ms`);
  if (adopted) {
    const onForm = await adopted.page
      .locator(carrier.prewarm.readySelector)
      .first()
      .isVisible()
      .catch(() => false);
    check('adopted page is already showing the login form', onForm);
    check('adopted entry carries its own sticky proxy session', 'stickyId' in adopted);
    console.log(`        saved ~${adopted.prepareMs}ms of context + navigation + form render`);
  }
}

// --- 3. a second adoption must not hand over the same page -----------------
{
  const second = await warmPagePool.adopt(carrier);
  check(
    'immediate second adoption returns null rather than reusing the page',
    second === null || second.page !== adopted?.page,
    second === null ? 'null (replacement still preparing)' : 'a different page'
  );
  if (second) await second.lease.release().catch(() => {});
}

// --- 4. safety: every staleness case is refused, not used hopefully --------
{
  // Wait for the background replacement so there is a real entry to mutate.
  const deadline = Date.now() + 40_000;
  let fresh = null;
  while (Date.now() < deadline && !fresh) {
    fresh = await warmPagePool.adopt(carrier);
    if (!fresh) await new Promise((r) => setTimeout(r, 400));
  }

  if (!fresh) {
    check('a replacement page became available for staleness testing', false, 'none ready');
  } else {
    const spec = carrier.prewarm;

    check(
      'a healthy entry is accepted',
      (await warmPagePool.stalenessReasonForTest(fresh, spec)) === null
    );

    check(
      'expired TTL is refused',
      (await warmPagePool.stalenessReasonForTest({ ...fresh, expiresAt: Date.now() - 1 }, spec)) ===
        'ttl-expired'
    );

    check(
      'an entry whose URL matches stalePattern is refused',
      (await warmPagePool.stalenessReasonForTest(fresh, {
        ...spec,
        // Force the pattern to match whatever the page is currently showing.
        stalePattern: /./,
      })) === 'navigated-away'
    );

    check(
      'a form that is no longer present is refused',
      (await warmPagePool.stalenessReasonForTest(fresh, {
        ...spec,
        readySelector: '#definitely-not-on-this-page',
      })) === 'form-not-visible'
    );

    await fresh.page.close().catch(() => {});
    check(
      'a closed page is refused',
      (await warmPagePool.stalenessReasonForTest(fresh, spec)) === 'page-closed'
    );

    await fresh.lease.release().catch(() => {});
  }
}

// --- 5. adoption never throws for an unknown carrier -----------------------
{
  class NoPrewarm {
    static id = 'no-prewarm';
  }
  let threw = false;
  let result = 'unset';
  try {
    result = await warmPagePool.adopt(NoPrewarm);
  } catch {
    threw = true;
  }
  check('carrier without a prewarm block returns null and does not throw', !threw && result === null);
}

// --- 6. stats are coherent -------------------------------------------------
{
  const s = warmPagePool.stats();
  check('stats report adoption', s.adopted >= 1, JSON.stringify({ prepared: s.prepared, adopted: s.adopted, stale: s.staleDiscarded }));
}

if (adopted) await adopted.lease.release().catch(() => {});
await warmPagePool.shutdown();
await browserPool.shutdown();

console.log(`\n${failures === 0 ? 'ALL PREWARM CHECKS PASSED' : `${failures} PREWARM CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
