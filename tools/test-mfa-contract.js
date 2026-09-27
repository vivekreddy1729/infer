#!/usr/bin/env node
/**
 * `submitMfa()` must resolve to `{ accepted: boolean }`, and a violation must be LOUD.
 *
 * ------------------------------------------------------------------------
 * THE BUG THIS PINS
 * ------------------------------------------------------------------------
 * GEICO's `submitMfa` was written as `return (async () => { … });` — a leftover IIFE
 * whose invoking `()` was lost when a `#timings.measure()` wrapper was removed. The
 * method returned a *function object* instantly. Nothing was typed, nothing was
 * submitted, no request reached the carrier.
 *
 * `#runMfaLoop` then read it as a rejected code, because a function has no `.accepted`
 * and no `.retryable`:
 *
 *     outcome?.accepted   -> undefined  -> not accepted
 *     !outcome?.retryable -> true       -> throw MFA_REJECTED, no retry
 *
 * So the user was told "That verification code was not accepted" about a code that was
 * never sent. The whole failure produced ZERO log lines, which is what made it
 * expensive to find — it had to be spotted as an absence in a diagnostic bundle.
 *
 * ------------------------------------------------------------------------
 * WHY A UNIT TEST AND NOT A FLOW TEST
 * ------------------------------------------------------------------------
 * Reaching this code against a real carrier costs a login and a human MFA round-trip,
 * and against the demo portal the mock adapter returns a correct object so the branch
 * is never taken. Neither exercises it. The guard is pure logic over a return value, so
 * it is tested directly with fake carriers.
 *
 *   node tools/test-mfa-contract.js
 */

import { ErrorCodes } from '../src/carriers/baseCarrier.js';

let failures = 0;
const check = (label, ok, extra = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${extra ? `  ${extra}` : ''}`);
  if (!ok) failures += 1;
};

/**
 * Mirror of the guard in `PullSession.#runMfaLoop`.
 *
 * Duplicated rather than imported because the real one lives inside a private method on
 * a class that needs a browser, a socket and a state machine to construct. The
 * duplication is the honest tradeoff and it is flagged: if the guard in `pullSession.js`
 * changes, this must change with it. The alternative — standing up a full session to
 * test a type check — would not get run.
 */
function classify(outcome) {
  if (typeof outcome !== 'object' || outcome === null || typeof outcome.accepted !== 'boolean') {
    return { verdict: 'ADAPTER_CONTRACT' };
  }
  if (outcome.accepted) return { verdict: 'ACCEPTED' };
  if (!outcome.retryable) return { verdict: 'MFA_REJECTED' };
  return { verdict: 'RETRY' };
}

console.log('\nsubmitMfa() return-value contract\n');

// --- the exact shape of the real bug ---------------------------------------
const uninvokedClosure = (async () => ({ accepted: true }));
check(
  'an uninvoked async closure is an ADAPTER_CONTRACT error, not a rejected code',
  classify(uninvokedClosure).verdict === 'ADAPTER_CONTRACT',
  `got ${classify(uninvokedClosure).verdict}`
);
console.log('        ^ this is F-53: it used to classify as MFA_REJECTED and blame the user');

// --- a pending promise is the same class of mistake -------------------------
check(
  'a forgotten await (bare Promise) is an ADAPTER_CONTRACT error',
  classify(Promise.resolve({ accepted: true })).verdict === 'ADAPTER_CONTRACT',
  `got ${classify(Promise.resolve({ accepted: true })).verdict}`
);

// --- other malformed returns ----------------------------------------------
for (const [label, value] of [
  ['undefined', undefined],
  ['null', null],
  ['a bare true', true],
  ['a string', 'accepted'],
  ['an empty object', {}],
  ['{ accepted: "yes" } (truthy non-boolean)', { accepted: 'yes' }],
  ['an array', [{ accepted: true }]],
]) {
  check(`${label} is an ADAPTER_CONTRACT error`, classify(value).verdict === 'ADAPTER_CONTRACT', `got ${classify(value).verdict}`);
}

// --- valid shapes must still behave normally -------------------------------
check('{ accepted: true } is ACCEPTED', classify({ accepted: true }).verdict === 'ACCEPTED');
check(
  '{ accepted: false, retryable: true } retries',
  classify({ accepted: false, retryable: true }).verdict === 'RETRY'
);
check(
  '{ accepted: false, retryable: false } is a genuine rejection',
  classify({ accepted: false, retryable: false }).verdict === 'MFA_REJECTED'
);
check(
  '{ accepted: false } with no retryable is a genuine rejection',
  classify({ accepted: false }).verdict === 'MFA_REJECTED'
);

// --- the error code has to exist and be distinct --------------------------
check('ErrorCodes.ADAPTER_CONTRACT exists', ErrorCodes.ADAPTER_CONTRACT === 'ADAPTER_CONTRACT');
check(
  'ADAPTER_CONTRACT is distinct from MFA_REJECTED',
  ErrorCodes.ADAPTER_CONTRACT !== ErrorCodes.MFA_REJECTED,
  'an adapter bug must not be reported as a carrier rejection'
);

/**
 * The real adapters must satisfy the contract statically.
 *
 * Catches the specific typo by reading the source: a `submitMfa` whose body returns a
 * closure. Backstop for the runtime guard, not a replacement — but it fails at
 * `npm run smoke:all` instead of during someone's MFA prompt.
 *
 * Stated plainly: this also flags a *correctly* invoked `})();`. That is intentional
 * rather than a limitation being excused. The pattern is banned outright in `submitMfa`,
 * because a bare IIFE wrapping an entire method body buys nothing and is precisely what
 * made losing two characters invisible. Verified both ways — the buggy shape matches, the
 * inline shape does not:
 *
 *     'return (async () => { … });'                -> flagged
 *     'return this.#awaitMfaOutcome(before);'      -> clean
 */
console.log('\n  adapter source check\n');
const fs = await import('node:fs/promises');
for (const file of ['src/carriers/geico/index.js', 'src/carriers/progressive.js', 'src/carriers/mockCarrier.js']) {
  const src = await fs.readFile(new URL(`../${file}`, import.meta.url), 'utf8');
  const idx = src.indexOf('async submitMfa(');
  if (idx === -1) {
    check(`${file} defines submitMfa`, false, 'not found');
    continue;
  }
  const body = src.slice(idx, idx + 8000);
  const returnsUninvokedClosure = /return\s*\((?:async\s*)?\(\s*\)\s*=>/.test(body);
  check(`${file} does not return an uninvoked closure`, !returnsUninvokedClosure);
}

console.log('');
if (failures) {
  console.log(`${failures} CHECK(S) FAILED\n`);
  process.exit(1);
}
console.log('ALL MFA CONTRACT CHECKS PASSED\n');
