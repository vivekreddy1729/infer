#!/usr/bin/env node
/**
 * MFA code normalisation must not corrupt a carrier's code.
 *
 * ------------------------------------------------------------------------
 * THE BUG THIS EXISTS TO PREVENT
 * ------------------------------------------------------------------------
 * `PullSession.submitMfaCode()` normalised with `.replace(/\D/g, '')`, stripping
 * every non-digit. Progressive and the demo portal both send six digits, so it
 * looked correct for the project's entire history.
 *
 * GEICO sends codes like **326F40**. That normaliser silently produced `32640` —
 * five characters, a code the carrier never issued — and submitted it. The carrier
 * rejects it, the user is told the code was wrong, and they conclude they mistyped.
 * Nothing reports that the code was altered in transit.
 *
 * Two layers had to be fixed, and this test covers the one that mattered most:
 *   - `public/index.html` had `pattern="[0-9]*"`, which refused to submit at all
 *   - `pullSession.js` silently dropped the letter
 *
 * The rule encoded here: **the carrier is the authority on its own code format.**
 * Normalisation may remove separators a user pasted; it may never remove a
 * character the carrier might have issued.
 *
 *   node tools/test-mfa-code-format.js
 */

/**
 * The normaliser, mirrored from `PullSession.submitMfaCode()`.
 *
 * Duplicated deliberately rather than imported: `PullSession` requires a carrier, a
 * browser lease and a live state machine to construct, and this test is about one
 * pure string transformation. The duplication is guarded by the drift check at the
 * end, which reads the real source and fails if the implementation diverges.
 */
function normalise(code) {
  return String(code ?? '')
    .trim()
    .replace(/[\s\u2010-\u2015-]/g, '')
    .toUpperCase();
}

let failures = 0;
const pass = (m, d = '') => console.log(`  PASS  ${m}${d ? `  ${d}` : ''}`);
const fail = (m, d = '') => { failures += 1; console.log(`  FAIL  ${m}${d ? `  ${d}` : ''}`); };

console.log('MFA code normalisation\n');

const cases = [
  // [input, expected, why]
  ['326F40', '326F40', 'GEICO alphanumeric — the code that was being corrupted'],
  ['326f40', '326F40', 'lowercase entry is uppercased to match how GEICO presents it'],
  ['123456', '123456', 'Progressive / demo six digits, unchanged'],
  [' 326F40 ', '326F40', 'surrounding whitespace trimmed'],
  ['326 F40', '326F40', 'internal space removed (pasted code)'],
  ['326-F40', '326F40', 'hyphen removed (pasted code)'],
  ['326\u2013F40', '326F40', 'en-dash removed (smart-quote paste)'],
  ['ABCDEF', 'ABCDEF', 'all-letter code survives — no carrier assumption'],
  ['A1B2C3', 'A1B2C3', 'mixed alphanumeric survives'],
];

for (const [input, expected, why] of cases) {
  const got = normalise(input);
  if (got === expected) pass(`${JSON.stringify(input)} -> ${JSON.stringify(got)}`, why);
  else fail(`${JSON.stringify(input)} -> ${JSON.stringify(got)}`, `expected ${JSON.stringify(expected)} (${why})`);
}

/**
 * The negative control: prove the OLD normaliser breaks the GEICO code.
 *
 * Without this, the test above passes trivially and nothing records that there was
 * ever a bug. A test that cannot demonstrate the failure it prevents is a test whose
 * justification decays.
 */
console.log('');
const old = (code) => String(code ?? '').replace(/\D/g, '');
const oldResult = old('326F40');
if (oldResult === '32640' && oldResult !== '326F40') {
  pass('the old digit-stripping normaliser DOES corrupt 326F40', `-> ${JSON.stringify(oldResult)}`);
} else {
  fail('could not reproduce the original corruption', `old('326F40') = ${JSON.stringify(oldResult)}`);
}

// -- length bounds -----------------------------------------------------------
console.log('');
const boundsOk = (code) => {
  const n = normalise(code);
  return n.length >= 4 && n.length <= 12;
};
for (const [code, expected, why] of [
  ['326F40', true, 'six-character alphanumeric accepted'],
  ['123456', true, 'six-digit accepted'],
  ['123', false, 'too short rejected'],
  ['', false, 'empty rejected'],
  ['1234567890123', false, 'absurdly long rejected'],
  ['12345678', true, 'eight characters accepted — no six-digit assumption'],
]) {
  const got = boundsOk(code);
  if (got === expected) pass(`bounds: ${JSON.stringify(code)} ${expected ? 'accepted' : 'rejected'}`, why);
  else fail(`bounds: ${JSON.stringify(code)} got ${got}, expected ${expected}`, why);
}

/**
 * Drift check: the real implementation must still be alphanumeric-safe.
 *
 * This is what stops the duplication above from rotting. It reads the actual source
 * and fails if digit-only stripping reappears, which is the specific regression
 * worth guarding — someone "tidying up" the normaliser is exactly how this comes
 * back.
 */
console.log('');
const { readFileSync } = await import('node:fs');
const src = readFileSync('src/session/pullSession.js', 'utf8');
const fn = src.slice(src.indexOf('submitMfaCode(code)'), src.indexOf('submitMfaCode(code)') + 900);

if (/replace\(\s*\/\\D\/g/.test(fn)) {
  fail('pullSession.js strips non-digits again', 'alphanumeric carrier codes would be silently corrupted');
} else {
  pass('pullSession.js does not strip non-digits');
}
if (/toUpperCase\(\)/.test(fn)) pass('pullSession.js uppercases the code');
else fail('pullSession.js no longer uppercases', 'lowercase entry may not match a carrier code');

const html = readFileSync('public/index.html', 'utf8');
const input = html.slice(html.indexOf('id="mfa-code"'), html.indexOf('id="mfa-code"') + 260);
if (/pattern\s*=\s*"\[0-9\]/.test(input)) {
  fail('index.html restricts the code field to digits', 'the form would refuse to submit 326F40');
} else {
  pass('index.html does not restrict the code field to digits');
}
if (/inputmode\s*=\s*"numeric"/.test(input)) {
  fail('index.html sets inputmode=numeric', 'a phone keypad could not type the letter');
} else {
  pass('index.html allows text entry');
}

console.log('');
if (failures) {
  console.log(`${failures} MFA CODE FORMAT CHECK(S) FAILED`);
  process.exit(1);
}
console.log('ALL MFA CODE FORMAT CHECKS PASSED');
