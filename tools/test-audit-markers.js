#!/usr/bin/env node
/**
 * The secret audit must ignore its own redaction markers — and still catch real ones.
 *
 * ------------------------------------------------------------------------
 * WHY
 * ------------------------------------------------------------------------
 * `audit-secrets.js` failed on a file whose token was already *redacted*. The
 * `session token in URL` rule matches `[A-Za-z0-9%._~+/-]{16,}` after `token=`, and
 * `scrubUrl()` writes `[REDACTED 44 chars]` — which percent-encodes inside a URL to
 * `%5BREDACTED+44+chars%5D`, where `%`, `+` and `-` are all in that class. The audit
 * flagged its own marker as a high-severity leak.
 *
 * That is F-25 recurring inside the rule added to prevent F-25. `captureGroup: 1` was
 * meant to make a marker distinguishable from a secret and is not sufficient alone:
 * the group still captures the encoded marker, so the marker has to be *recognised*
 * as well.
 *
 * The failure mode is worse than a nuisance. An audit that fails on every run stops
 * being read, and then a true positive arrives in the noise and gets waved through. So
 * both directions are asserted, because either alone is worthless:
 *
 *   - markers must NOT be flagged   (or the audit becomes noise and is ignored)
 *   - real tokens MUST be flagged   (or the audit is decoration)
 *
 * Imports the **live** patterns from `tools/lib/secretPatterns.js` rather than copying
 * them, so this cannot pass against rules that have drifted. That module exists
 * because `audit-secrets.js` has top-level `await` and calls `process.exit()`, so
 * importing it would run a scan instead of reading its rules. A first attempt tried to
 * parse the regex literals out of the source with a regex and broke on the `/` inside
 * `[A-Za-z0-9%._~+/-]` — parsing code with patterns is the wrong tool.
 *
 *   node tools/test-audit-markers.js
 */

import { PATTERNS, REDACTION_MARKERS } from './lib/secretPatterns.js';

let failures = 0;
const pass = (m, d = '') => console.log(`  PASS  ${m}${d ? `  ${d}` : ''}`);
const fail = (m, d = '') => { failures += 1; console.log(`  FAIL  ${m}${d ? `  ${d}` : ''}`); };

console.log('Secret-audit redaction markers\n');

const urlRule = PATTERNS.find((p) => p.name === 'session token in URL');
if (!urlRule) {
  fail('the "session token in URL" rule is gone', 'URL-borne tokens would go undetected');
  process.exit(1);
}
pass('live URL rule imported', `${REDACTION_MARKERS.length} markers, ${PATTERNS.length} patterns`);

/** Exactly how the audit decides: match the rule, then check the captured value. */
const isMarker = (v) => REDACTION_MARKERS.some((re) => re.test(String(v).trim()));
const flags = (text) => {
  const re = new RegExp(urlRule.re.source, urlRule.re.flags.replace('g', ''));
  const m = text.match(re);
  if (!m) return false;
  const value = urlRule.captureGroup ? m[urlRule.captureGroup] : m[0];
  return !isMarker(value);
};

console.log('');
const REAL = 'https://x.geico.com/d?token=lF6P4NiEucda0Va8cfVFOIh%2BNRo7XS4gdnhkm5tEmRI%3D';
const cases = [
  [REAL, true, 'a real 48-char token — the leak this rule exists for'],
  ['https://x.geico.com/d?token=[REDACTED 44 chars]', false, 'plain marker from scrubUrl()'],
  ['https://x.geico.com/d?token=%5BREDACTED+44+chars%5D', false, 'URL-encoded marker — the exact false positive'],
  ['https://x.geico.com/d?token=%5BREDACTED-23%5D', false, 'hyphenated encoded marker from bulk scrubbing'],
  ['https://x.geico.com/d?token=*****', false, "GEICO's own session-replay masking"],
  ['https://x.geico.com/d?sid=AbCdEf0123456789XYZ', true, 'sid is credential-equivalent too'],
  ['https://x.geico.com/d?documentName=Declaration+Page&policyTerm=currentTerm', false, 'non-secret parameters never flag'],
  ['https://x.geico.com/d?token=abc', false, 'too short to be a token'],
];

for (const [text, shouldFlag, why] of cases) {
  const got = flags(text);
  if (got === shouldFlag) pass(`${shouldFlag ? 'FLAGS  ' : 'ignores'} ${text.slice(22, 72)}`, why);
  else fail(`expected ${shouldFlag ? 'flag' : 'ignore'}, got ${got ? 'flag' : 'ignore'}`, `${text}  (${why})`);
}

/**
 * Negative control on the control.
 *
 * If markers were removed entirely, the real token must still match the rule. This
 * guards against someone "fixing" a false positive by loosening the pattern until it
 * matches nothing — which would silence the audit while appearing to repair it.
 */
console.log('');
const bareRe = new RegExp(urlRule.re.source, urlRule.re.flags.replace('g', ''));
if (bareRe.test(REAL)) pass('the rule itself still matches a real token', 'not loosened into uselessness');
else fail('the URL rule no longer matches a real token', 'the audit has been defanged');

/** Every high-severity rule should have something it demonstrably catches. */
console.log('');
const highs = PATTERNS.filter((p) => p.severity === 'high');
const probes = {
  'JWT (3-segment)': 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghij',
  'JWT fragment': 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9xxxx',
  'Bearer token': 'Bearer sk-abcdefghijklmnopqrstuv',
  'OAuth token param': 'access_token=abcdefghijklmnop',
  'session token in URL': REAL,
  'password JSON field': '"password":"hunter2"',
  SSN: '123-45-6789',
  'private key block': '-----BEGIN PRIVATE KEY-----',
};
let unprobed = 0;
for (const p of highs) {
  const probe = probes[p.name];
  if (!probe) { unprobed += 1; console.log(`  INFO  no probe for "${p.name}" — add one`); continue; }
  if (p.re.test(probe)) pass(`"${p.name}" catches its probe`);
  else fail(`"${p.name}" does NOT catch its own probe`, 'rule may be broken');
}
if (unprobed === 0) pass('every high-severity rule has a probe');

console.log('');
if (failures) {
  console.log(`${failures} AUDIT MARKER CHECK(S) FAILED`);
  process.exit(1);
}
console.log('ALL AUDIT MARKER CHECKS PASSED');
