/**
 * Regression test for the OTP stale-read race.
 *
 * The bug: `#waitForFlow` matched against the cached flow status, so after
 * submitting an OTP the adapter matched the `OTP_REQUIRED` left over from when
 * the challenge was first issued, declared the code rejected within
 * milliseconds, and looped. Progressive's real `MFA_COMPLETED` arrived ~470ms
 * later, by which point the state machine had already gone back to asking for a
 * code and the page had navigated away — surfacing as "OTP field not found".
 *
 * A correct code was reported as wrong. That is the worst class of bug here,
 * because the user has no way to tell it is not their mistake, and each retry
 * costs a real SMS.
 *
 * This exercises the waiter in isolation, with no browser and no network, by
 * driving a fake response timeline. Runs in about a second.
 *
 *   node tools/test-flow-race.js
 */

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
  if (!ok) failures += 1;
};

/**
 * Mirrors the real waiter's semantics exactly: cached latest status, a monotonic
 * sequence, and an `afterSeq` guard.
 */
class FlowWaiter {
  latest = null;
  seq = 0;

  observe(status) {
    this.latest = { status };
    this.seq += 1;
  }

  get mark() {
    return this.seq;
  }

  async waitFor(statuses, { timeout = 2000, afterSeq = -1 } = {}) {
    const wanted = new Set(statuses);
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (this.seq > afterSeq && this.latest?.status && wanted.has(this.latest.status)) {
        return this.latest;
      }
      await new Promise((r) => setTimeout(r, 10));
    }
    return null;
  }

  /** The buggy version, kept to prove the test would have caught it. */
  async waitForIgnoringSeq(statuses, { timeout = 2000 } = {}) {
    const wanted = new Set(statuses);
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (this.latest?.status && wanted.has(this.latest.status)) return this.latest;
      await new Promise((r) => setTimeout(r, 10));
    }
    return null;
  }
}

const OTP = 'OTP_REQUIRED';
const DONE = 'MFA_COMPLETED';
const DEVICE = 'DEVICE_PROPERTIES_REQUIRED';

console.log('OTP stale-read race regression test\n');

// --- Scenario 1: correct code. Success arrives 300ms after submit. ----------
{
  const f = new FlowWaiter();
  f.observe(OTP); // challenge issued, before the user types anything

  const mark = f.mark;
  setTimeout(() => f.observe(DONE), 300); // Progressive replies, late

  const success = await f.waitFor([DONE, DEVICE], { timeout: 2000, afterSeq: mark });
  check('correct code is recognised as accepted', success?.status === DONE, `got ${success?.status}`);
}

// --- Scenario 2: the original bug, to prove this test detects it ------------
{
  const f = new FlowWaiter();
  f.observe(OTP);

  setTimeout(() => f.observe(DONE), 300);

  // The old code waited on success AND OTP_REQUIRED together, with no seq guard.
  const started = Date.now();
  const result = await f.waitForIgnoringSeq([DONE, DEVICE, OTP], { timeout: 2000 });
  const elapsed = Date.now() - started;

  check(
    'buggy waiter returns the STALE OTP_REQUIRED immediately',
    result?.status === OTP && elapsed < 100,
    `got ${result?.status} after ${elapsed}ms — this is the bug`
  );
}

// --- Scenario 3: genuinely wrong code -> a NEW OTP_REQUIRED ----------------
{
  const f = new FlowWaiter();
  f.observe(OTP);

  const mark = f.mark;
  setTimeout(() => f.observe(OTP), 200); // rejected, challenge re-issued

  const success = await f.waitFor([DONE, DEVICE], { timeout: 700, afterSeq: mark });
  check('wrong code does not produce a false success', success === null);

  const sawNewChallenge = f.seq > mark && f.latest?.status === OTP;
  check('wrong code is detected as a new challenge', sawNewChallenge, `seq ${f.seq} > mark ${mark}`);
}

// --- Scenario 4: carrier goes silent -> neither success nor rejection ------
{
  const f = new FlowWaiter();
  f.observe(OTP);
  const mark = f.mark;

  const success = await f.waitFor([DONE, DEVICE], { timeout: 300, afterSeq: mark });
  const newChallenge = f.seq > mark && f.latest?.status === OTP;
  check(
    'silence is reported as neither accepted nor rejected',
    success === null && newChallenge === false,
    'adapter throws TIMEOUT rather than burning another SMS'
  );
}

// --- Scenario 5: device-trust path counts as success -----------------------
{
  const f = new FlowWaiter();
  f.observe(OTP);
  const mark = f.mark;
  setTimeout(() => f.observe(DEVICE), 150);

  const success = await f.waitFor([DONE, DEVICE], { timeout: 1000, afterSeq: mark });
  check('DEVICE_PROPERTIES_REQUIRED is treated as accepted', success?.status === DEVICE);
}

// ---------------------------------------------------------------------------
// Scenario 6: the post-MFA settle ordering bug (F-30)
//
// PingFederate emits MFA_COMPLETED *before* DEVICE_PROPERTIES_REQUIRED. Gating
// the interstitial handler on a status snapshot taken at the moment of
// acceptance therefore always sees MFA_COMPLETED, skips the click that advances
// `setDeviceProperties`, and the session is never completed — observed flow
// history ended `MFA_COMPLETED → CREDENTIALS_REQUIRED` and Progressive tore the
// session down.
//
// The correct shape waits for whichever arrives first: the interstitial, or
// evidence of authentication.
// ---------------------------------------------------------------------------
{
  const DEVICE = 'DEVICE_PROPERTIES_REQUIRED';

  /** Mirrors #settleAfterMfa: race the interstitial against auth evidence. */
  const settle = async (f, state, { timeout = 1500 } = {}) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (f.latest?.status === DEVICE) return 'handled-interstitial';
      if (state.apiAuthOk) return 'already-authenticated';
      await new Promise((r) => setTimeout(r, 20));
    }
    return 'timed-out';
  };

  // 6a: the real Progressive sequence — DEVICE arrives 250ms after MFA_COMPLETED.
  {
    const f = new FlowWaiter();
    const state = { apiAuthOk: false };
    f.observe(OTP);
    f.observe(DONE);
    setTimeout(() => f.observe(DEVICE), 250);

    // The buggy snapshot check, for contrast.
    const snapshot = f.latest.status === DEVICE ? 'handled-interstitial' : 'skipped';
    check(
      'buggy snapshot check SKIPS the interstitial (this is the bug)',
      snapshot === 'skipped',
      `saw ${f.latest.status}`
    );

    const outcome = await settle(f, state);
    check(
      'settle waits and DOES handle the late interstitial',
      outcome === 'handled-interstitial',
      outcome
    );
  }

  // 6b: no interstitial at all — must exit fast on auth evidence, not stall.
  {
    const f = new FlowWaiter();
    const state = { apiAuthOk: false };
    f.observe(OTP);
    f.observe(DONE);
    setTimeout(() => {
      state.apiAuthOk = true;
    }, 150);

    const t = Date.now();
    const outcome = await settle(f, state);
    const elapsed = Date.now() - t;
    check(
      'no interstitial: exits on auth evidence without burning the timeout',
      outcome === 'already-authenticated' && elapsed < 600,
      `${outcome} after ${elapsed}ms`
    );
  }

  // 6c: neither signal — bounded, and reports honestly rather than claiming success.
  {
    const f = new FlowWaiter();
    f.observe(OTP);
    f.observe(DONE);
    const outcome = await settle(f, { apiAuthOk: false }, { timeout: 300 });
    check('neither signal: returns timed-out rather than a false success', outcome === 'timed-out', outcome);
  }
}

console.log(
  `\n${failures === 0 ? 'ALL RACE CHECKS PASSED (incl. post-MFA settle)' : `${failures} RACE CHECK(S) FAILED`}`
);
process.exit(failures === 0 ? 0 : 1);
