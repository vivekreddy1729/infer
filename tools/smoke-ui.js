/**
 * UI smoke test: loads the real page in a real browser and asserts it is usable.
 *
 * Exists because of a bug that no backend test could have caught. The MFA dialog
 * carries the `hidden` attribute, but `.overlay { display: flex }` has the same
 * specificity as the UA stylesheet's `[hidden] { display: none }`, and author
 * styles win ties. So the dialog rendered on every page load, and because it is
 * `position: fixed; inset: 0; z-index: 50` it also absorbed every click intended
 * for the credential form beneath it.
 *
 * Every API test passed throughout. The server was healthy, the state machine was
 * correct, the smoke test was green — and the app was completely unusable in a
 * browser. The lesson is that "the endpoints work" and "a person can use it" are
 * different claims needing different evidence, so this asserts the second one:
 * the overlay is hidden at rest, the form is actually clickable, and the dialog
 * appears only when the backend says MFA is required.
 *
 *   node tools/smoke-ui.js [baseUrl]
 */

const BASE = process.argv[2] ?? 'http://127.0.0.1:3000';

process.env.HEADLESS = process.env.HEADLESS ?? 'true';
const { default: browserPool } = await import('../src/browser/browserPool.js');

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  ${detail}` : ''}`);
  if (!ok) failures += 1;
};

const lease = await browserPool.acquireContext({});
const page = await lease.context.newPage();

console.log(`UI smoke test against ${BASE}\n`);

await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.waitForLoadState('networkidle', { timeout: 10_000 }).catch(() => {});

// -- at rest ----------------------------------------------------------------

const overlay = page.locator('#mfa-overlay');
check(
  'MFA overlay is NOT visible on page load',
  !(await overlay.isVisible().catch(() => true)),
  `hidden attr = ${await overlay.getAttribute('hidden').then((v) => JSON.stringify(v))}`
);

// The real test of the bug: computed display, not just the attribute.
const computed = await overlay.evaluate((n) => getComputedStyle(n).display).catch(() => 'unknown');
check('MFA overlay computed display is "none"', computed === 'none', `got "${computed}"`);

check(
  'documents panel is NOT visible on page load',
  !(await page.locator('#documents-panel').isVisible().catch(() => true))
);

// -- form is genuinely reachable --------------------------------------------

// `isVisible` is not enough: an overlay on top leaves the field visible but
// unclickable. Playwright's actionability check is what catches that.
for (const [label, selector] of [
  ['carrier dropdown', '#carrier'],
  ['username field', '#username'],
  ['password field', '#password'],
  ['submit button', '#submit-btn'],
]) {
  const loc = page.locator(selector);
  let clickable = false;
  try {
    // trial:true runs the actionability checks and then does not click.
    await loc.click({ trial: true, timeout: 4000 });
    clickable = true;
  } catch {
    clickable = false;
  }
  check(`${label} is clickable (nothing covering it)`, clickable);
}

// -- carriers populated -----------------------------------------------------

const options = await page.locator('#carrier option').allTextContents();
check('carrier dropdown is populated', options.length > 1, options.join(' | ').slice(0, 90));
const hasProgressive = options.some((o) => /progressive/i.test(o));
const hasDemo = options.some((o) => /demo/i.test(o));
check('Progressive present in dropdown', hasProgressive);
check('demo carrier present in dropdown', hasDemo);

// -- demo prefill is cleared when switching to a real carrier ---------------

await page.selectOption('#carrier', 'demo');
await page.waitForTimeout(150);
const demoUser = await page.inputValue('#username');
check('selecting demo prefills credentials', demoUser === 'demo@example.com', demoUser);

await page.selectOption('#carrier', 'progressive');
await page.waitForTimeout(150);
const afterSwitch = await page.inputValue('#username');
const afterSwitchPw = await page.inputValue('#password');
check(
  'switching to a real carrier clears the demo prefill',
  afterSwitch === '' && afterSwitchPw === '',
  `username=${JSON.stringify(afterSwitch)} password=${JSON.stringify(afterSwitchPw)}`
);

// -- the dialog still works when it is supposed to --------------------------

/**
 * Clear persisted sessions first to force the cold path.
 *
 * Without this the demo carrier legitimately takes the warm path, skips the
 * challenge, and the "does the dialog appear" assertion fails even though both
 * the app and the assertion are behaving correctly. A test that depends on
 * leftover state from a previous run is worse than no test, so the precondition
 * is established rather than assumed.
 */
const { rm } = await import('node:fs/promises');
const { default: config } = await import('../src/config.js');
const { join, resolve } = await import('node:path');
await rm(join(resolve(config.DATA_DIR), 'sessions'), { recursive: true, force: true });
console.log('\n  (cleared persisted sessions to force the cold path)');

// Drive the demo carrier far enough to prove the overlay does appear on cue.
await page.selectOption('#carrier', 'demo');
await page.waitForTimeout(150);
await page.click('#submit-btn');

const appeared = await overlay
  .waitFor({ state: 'visible', timeout: 45_000 })
  .then(() => true)
  .catch(() => false);
check('MFA overlay DOES appear when the backend requires MFA', appeared);

if (appeared) {
  const demoCodeShown = await page.locator('#mfa-demo').isVisible().catch(() => false);
  check('demo code is shown in the dialog for the practice carrier', demoCodeShown);
  const codeText = await page.locator('#mfa-demo strong').textContent().catch(() => '');
  check('demo code looks like 6 digits', /^\d{6}$/.test((codeText ?? '').trim()), codeText ?? '');

  // Complete the flow so the document viewer path is exercised too.
  if (/^\d{6}$/.test((codeText ?? '').trim())) {
    await page.fill('#mfa-code', codeText.trim());
    await page.click('#mfa-submit');
    const done = await page
      .locator('#documents-panel')
      .waitFor({ state: 'visible', timeout: 45_000 })
      .then(() => true)
      .catch(() => false);
    check('documents panel appears after submitting the code', done);
    if (done) {
      const src = await page.locator('#doc-viewer').getAttribute('src');
      check('PDF viewer has a document loaded', Boolean(src), src ?? '(no src)');
      const hidden = await overlay.isVisible().catch(() => true);
      check('MFA overlay is hidden again after success', !hidden);
    }
  }
}

console.log(`\n${failures === 0 ? 'ALL UI CHECKS PASSED' : `${failures} UI CHECK(S) FAILED`}`);

await lease.release();
await browserPool.shutdown();
process.exit(failures === 0 ? 0 : 1);
