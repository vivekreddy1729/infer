/**
 * Decisive reachability test using Playwright locators rather than page.evaluate.
 *
 * `probe-carrier.js` inspects the DOM from inside the page, which cannot see into
 * closed shadow roots and is subject to layout quirks. Playwright's locator
 * engine resolves differently, so a control that is invisible to `evaluate` may
 * still be perfectly driveable by an adapter.
 *
 * This asks the only question that actually matters before committing to a
 * carrier: can the automation layer see, and type into, the login fields?
 *
 * Read-only. Fills nothing, submits nothing.
 *
 *   node tools/probe-locators.js <url>
 */

import config from '../src/config.js';
import browserPool from '../src/browser/browserPool.js';
import { buildProxyConfig, newStickySessionId } from '../src/browser/proxy.js';

const url = process.argv[2];
if (!url) {
  console.error('usage: node tools/probe-locators.js <url>');
  process.exit(1);
}

/** Selectors an adapter would realistically reach for, most robust first. */
const CANDIDATES = {
  'password (type)': 'input[type="password"]',
  'password (autocomplete)': 'input[autocomplete="current-password"]',
  'username (autocomplete)': 'input[autocomplete="username"]',
  'username (type=text)': 'input[type="text"]',
  'email (type=email)': 'input[type="email"]',
  'any visible input': 'input:not([type="hidden"])',
  'submit button': 'button[type="submit"], input[type="submit"]',
  'login by role': 'role=button[name=/log ?in|sign ?in/i]',
  'password by label': 'role=textbox[name=/password/i]',
  'user by label': 'role=textbox[name=/email|user|username/i]',
};

const proxy = config.RESIDENTIAL_PROXY_URL ? buildProxyConfig(newStickySessionId()) : null;
const lease = await browserPool.acquireContext({ proxy });
const page = await lease.context.newPage();

console.log(`\nProbing locator reachability: ${url}`);
console.log(`  proxy: ${proxy ? 'residential' : 'direct from this host'}\n`);

await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 35_000 });
await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});

// Give a challenge-gated SPA time to mount.
await page
  .locator('input[type="password"], input[autocomplete="current-password"]')
  .first()
  .waitFor({ state: 'visible', timeout: 25_000 })
  .then(() => console.log('  password field became visible\n'))
  .catch(() => console.log('  password field never became visible within 25s\n'));

let reachable = 0;
for (const [label, selector] of Object.entries(CANDIDATES)) {
  const loc = page.locator(selector);
  const count = await loc.count().catch(() => 0);
  let visible = false;
  let editable = null;
  if (count > 0) {
    visible = await loc.first().isVisible().catch(() => false);
    // Whether Playwright considers it actionable is the real test: it is what
    // `fill()` and `press()` check before touching anything.
    editable = await loc.first().isEditable().catch(() => null);
  }
  if (visible) reachable += 1;
  const mark = visible ? 'YES' : count > 0 ? 'dom-only' : ' no';
  console.log(
    `  ${mark.padEnd(9)} ${label.padEnd(26)} count=${String(count).padEnd(3)} ${
      editable === null ? '' : `editable=${editable}`
    }  ${selector}`
  );
}

const frames = page.frames();
if (frames.length > 1) {
  console.log(`\n  ${frames.length - 1} child frame(s):`);
  for (const f of frames.slice(1)) {
    const pw = await f.locator('input[type="password"]').count().catch(() => 0);
    console.log(`    ${pw > 0 ? '>> HAS PASSWORD FIELD' : '   '} ${f.url().slice(0, 100)}`);
  }
}

console.log(
  `\nVERDICT: ${
    reachable > 0
      ? 'Playwright CAN reach login controls. Adapter is viable.'
      : 'Playwright CANNOT reach login controls from the main frame. Check child frames above.'
  }`
);

await lease.release();
await browserPool.shutdown();
