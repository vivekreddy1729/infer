#!/usr/bin/env node
/**
 * GEICO screen-detection tests.
 *
 * ISOLATION: GEICO-local. No Progressive imports.
 *
 * ------------------------------------------------------------------------
 * THE BUG THIS EXISTS TO PREVENT
 * ------------------------------------------------------------------------
 * A real run failed with no code ever being sent. The log:
 *
 *     post-login outcome   outcome:"codeEntry"   elapsedMs:126
 *
 * The post-login race detected the code-entry screen 126ms after submitting
 * credentials — while still on `/login`. It therefore skipped the delivery-method
 * chooser, never clicked "Next", and GEICO was never asked to send anything. The
 * run waited 90 seconds for a code that had not been requested and failed
 * `MFA_REQUIRED_TIMEOUT`.
 *
 * Cause: the code screen was detected by looking for the code field via
 * `MFA.codeInput`, whose first entry is `input[data-semantics-role="text-field"]`
 * — necessary there because it is the only attribute that survives Flutter's
 * focus swap. But the login page's own username and password inputs carry the
 * same attribute, so it matched immediately.
 *
 * One selector list, two readers, opposite requirements: `submitMfa` needs the
 * generic selector (on `/mfa/pin` the code field is the only text-field), and the
 * race needs a specific one. That is the O-13 lesson — a change made for one
 * reader without enumerating the others.
 *
 * These tests assert screens are told apart by ROUTE, and that no screen predicate
 * can fire on a page it does not describe. Pure string/regex logic, no browser.
 *
 *   node tools/geico/test-geico-screens.js
 */

import { MFA, CREDENTIALS, ROUTES, HOSTS, DOCUMENT_ACTIONS, BUTTON_TEXT } from '../../src/carriers/geico/selectors.js';

let failures = 0;
const pass = (m, d = '') => console.log(`  PASS  ${m}${d ? `  ${d}` : ''}`);
const fail = (m, d = '') => { failures += 1; console.log(`  FAIL  ${m}${d ? `  ${d}` : ''}`); };

/** Every screen the flow passes through, by URL. */
const URLS = {
  login: `https://${HOSTS.auth}${ROUTES.login}`,
  mfaOptions: `https://${HOSTS.auth}${ROUTES.mfaOptions}`,
  mfaPin: `https://${HOSTS.auth}${ROUTES.mfaPin}`,
  dashboard: `https://${HOSTS.portfolio}${ROUTES.dashboard}`,
  documents: `https://${HOSTS.documents}${ROUTES.documentsHome}`,
};

/** The predicates as the adapter builds them. Kept in sync deliberately. */
const routeMatch = (route) => (url) => new RegExp(`${route}(\\?|$|/)`).test(url);
const isMethodChooser = routeMatch(ROUTES.mfaOptions);
const isCodeEntry = routeMatch(ROUTES.mfaPin);
const isAuthenticated = (url) => /portfolio\.geico\.com|edgecustomer\.geico\.com/.test(url);

function exactlyMatches(predicate, name, expected) {
  const hits = Object.entries(URLS).filter(([, u]) => predicate(u)).map(([k]) => k);
  const same = hits.length === expected.length && expected.every((e) => hits.includes(e));
  if (same) pass(`${name} matches exactly ${JSON.stringify(expected)}`);
  else fail(`${name} matched ${JSON.stringify(hits)}`, `expected ${JSON.stringify(expected)}`);
}

console.log('GEICO screen detection\n');

// -- 1. each screen predicate fires on exactly one screen --------------------
exactlyMatches(isMethodChooser, 'methodChooser', ['mfaOptions']);
exactlyMatches(isCodeEntry, 'codeEntry', ['mfaPin']);
exactlyMatches(isAuthenticated, 'authenticated', ['dashboard', 'documents']);

// -- 2. the specific regressions that broke a real run ----------------------
if (!isCodeEntry(URLS.login)) {
  pass('codeEntry does NOT fire on /login', 'the 126ms false positive');
} else {
  fail('codeEntry fires on /login — this is the bug that sent no code');
}

if (!isAuthenticated(URLS.mfaPin) && !isAuthenticated(URLS.mfaOptions)) {
  pass('authenticated does NOT fire on either 2SV screen');
} else {
  fail('authenticated fires on a challenge screen', 'would report a wrong code as accepted');
}

if (!isMethodChooser(URLS.mfaPin) && !isCodeEntry(URLS.mfaOptions)) {
  pass('the two 2SV screens are not confusable with each other');
} else {
  fail('mfa/options and mfa/pin predicates overlap');
}

// -- 3. prove the collision that caused it still exists ---------------------
/**
 * The negative control. If this stops being true, the generic selector is no
 * longer ambiguous and this whole test has lost its reason to exist — which is
 * worth being told about rather than silently passing.
 */
const generic = MFA.codeInput[0];
const loginFieldsShareIt =
  generic.includes('data-semantics-role') &&
  (CREDENTIALS.usernameFallback.includes('data-semantics-role') ||
    CREDENTIALS.passwordFallback.includes('data-semantics-role'));
if (loginFieldsShareIt) {
  pass('the DOM collision still exists', 'so route-based detection remains required');
} else {
  fail('login fields no longer share data-semantics-role — re-verify why route detection is needed');
}

// -- 4. the code-field selector must survive the focus swap -----------------
/**
 * Modelled from the recorded snapshots of /mfa/pin: three pre-focus states with
 * an aria-label and no id, two post-focus states with an id and no aria-label.
 */
const preFocus = { type: 'text', id: null, name: null, ariaLabel: 'Verification code', semanticsRole: 'text-field' };
const postFocus = { type: 'text', id: 'one-time-code', name: 'one-time-code', ariaLabel: null, semanticsRole: 'text-field' };
const matchesField = (sel, f) => {
  if (sel === 'input[data-semantics-role="text-field"]') return f.semanticsRole === 'text-field';
  if (sel === '#one-time-code') return f.id === 'one-time-code';
  if (sel === 'input[name="one-time-code"]') return f.name === 'one-time-code';
  if (sel === 'input[aria-label="Verification code"]') return f.ariaLabel === 'Verification code';
  return false;
};
const survivesBoth = MFA.codeInput.filter((s) => matchesField(s, preFocus) && matchesField(s, postFocus));
if (survivesBoth.length > 0 && survivesBoth[0] === MFA.codeInput[0]) {
  pass('the FIRST codeInput selector survives the focus swap', survivesBoth[0]);
} else {
  fail('the primary codeInput selector does not match both states',
    'typing would time out mid-code after the click changes the attributes');
}

// -- 5. verified button labels ----------------------------------------------
const labelChecks = [
  ['Submit Code', MFA.submitText, true, 'the real submit label'],
  ['Submit', MFA.submitText, true, 'generic fallback still matches'],
  ['Next', MFA.chooserAdvanceText, true, 'the real chooser advance label'],
  ['Log In', [BUTTON_TEXT.login], true, 'login button'],
  ['Log In with Existing Passkey', [BUTTON_TEXT.login], false, 'must NOT match the passkey button'],
  ['View Declaration Page', [DOCUMENT_ACTIONS.viewDeclarationPage], true, 'the document view action'],
  ['Submit', [DOCUMENT_ACTIONS.viewDeclarationPage], false, 'view action must not match the email Submit'],
];
for (const [label, patterns, shouldMatch, why] of labelChecks) {
  const got = patterns.some((re) => re.test(label));
  if (got === shouldMatch) pass(`${JSON.stringify(label)} ${shouldMatch ? 'matches' : 'does not match'}`, why);
  else fail(`${JSON.stringify(label)} matched=${got}, expected ${shouldMatch}`, why);
}

// -- 6. the resend countdown must not be exact-matched ----------------------
const resendVariants = ['Resend Code In 60 Seconds', 'Resend Code In 9 Seconds', 'Resend Code In 1 Second'];
if (resendVariants.every((v) => MFA.resendText.test(v))) {
  pass('resend pattern tolerates the live countdown', `${resendVariants.length} variants`);
} else {
  fail('resend pattern is too rigid for a changing countdown');
}

console.log('');
if (failures) {
  console.log(`${failures} GEICO SCREEN DETECTION CHECK(S) FAILED`);
  process.exit(1);
}
console.log('ALL GEICO SCREEN DETECTION CHECKS PASSED');
