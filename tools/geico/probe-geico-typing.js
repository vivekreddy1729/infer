#!/usr/bin/env node
/**
 * GEICO typing probe -- the only question that actually decides viability.
 *
 * ISOLATION: self-contained. Never import from progressive.js.
 *
 * ------------------------------------------------------------------------
 * WHY A THIRD PROBE
 * ------------------------------------------------------------------------
 * probe-geico-flutter.js reported "Selector typing FAILED -- fall back to
 * keyboard traversal". That conclusion was an artefact of a bug in the probe,
 * not a property of GEICO, and it is worth being explicit about because it is
 * the third time in this project a tool has produced a confident wrong verdict
 * (F-06, and the "closed shadow root" call this whole GEICO thread is undoing).
 *
 * The bug: the probe tabbed to materialise Flutter's authored ids on page `p2`,
 * then tried to type into `#username` on page `page`, where no focus had ever
 * landed and the id therefore did not exist. `locator.fill` waited the full 30s
 * for a node with a count of 0 and reported a timeout. The selector was absent
 * because the probe put it on the wrong page.
 *
 * WHAT IS ACTUALLY TRUE, from the first two probes
 *
 *   - login is a Flutter Web app, HTML renderer (0 canvas elements,
 *     40 flt-semantics nodes already in the DOM)
 *   - it mounts ~6.2s after domcontentloaded, behind Imperva
 *   - `flt-semantics-placeholder` is ABSENT, so there is nothing to click to
 *     "enable accessibility" -- that hypothesis is dead
 *   - authored ids `#username` / `#current-password` DO appear, but only once
 *     focus enters the field: count 0 -> 1 after tabbing
 *
 * THE INSIGHT THIS PROBE TESTS
 * We do not need the authored ids at all. Two selectors are present *before*
 * any focus, straight after mount:
 *
 *     input[autocomplete="email"]   -> count 1   (username)
 *     input[type="password"]        -> count 1   (password)
 *
 * If we can type into those, the adapter needs no focus dance, no placeholder
 * activation, and no keyboard traversal -- just a long enough mount wait. That
 * is a far more robust adapter than the alternative.
 *
 * This probe also deliberately checks the *post-focus* ids as a second route,
 * so we know whether they are a usable fallback rather than assuming.
 *
 * Public login page only. Types throwaway text into the fields. NEVER submits,
 * so no login attempt is consumed and no account is touched.
 *
 *   node tools/geico/probe-geico-typing.js [--headed]
 */

import { chromium } from 'patchright';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { launchOptions, contextOptions } from '../../src/browser/stealth.js';

const URL = 'https://ecams.geico.com/login';
const OUT_DIR = 'artifacts/probes/geico';
const HEADED = process.argv.includes('--headed');

/**
 * Obviously-fake values. They are typed into the live form but NEVER submitted,
 * so no login attempt is consumed and no account is touched. Kept as named
 * constants so the read-back comparison cannot drift from what was typed.
 */
const PROBE_USERNAME = 'probe.user@example.com';
const PROBE_PASSWORD = 'not-a-real-secret';

/**
 * Candidate selector pairs, best-first.
 *
 * Deliberately excludes anything keyed on `flt-semantic-node-N`. Those numbers
 * are assigned by Flutter's semantics tree in mount order and will move the
 * moment the page changes -- the same trap as Progressive's minted input ids
 * (F-08), which is the single most expensive selector mistake available here.
 */
const STRATEGIES = [
  {
    name: 'attribute-based (no focus required)',
    username: 'input[autocomplete="email"]',
    password: 'input[type="password"]',
    needsFocus: false,
  },
  {
    name: 'authored ids (materialise on focus)',
    username: '#username',
    password: '#current-password',
    needsFocus: true,
  },
  {
    name: 'semantics-role attribute',
    username: 'input[data-semantics-role="text-field"][type="text"]',
    password: 'input[data-semantics-role="text-field"][type="password"]',
    needsFocus: false,
  },
];

async function dismissCookieBanner(page, log) {
  /**
   * OneTrust banner. It is not just cosmetic: an overlay that covers the form
   * intercepts pointer events, and Playwright's actionability check then waits
   * for a node that will never become hittable. That failure looks exactly like
   * anti-bot blocking and is the cheapest possible thing to rule out first.
   */
  for (const sel of [
    '#onetrust-reject-all-handler',
    '#onetrust-accept-btn-handler',
    'button:has-text("Reject Optional Cookies")',
  ]) {
    try {
      const loc = page.locator(sel).first();
      if (await loc.count() && await loc.isVisible()) {
        await loc.click({ timeout: 3000 });
        log.push(`dismissed cookie banner via ${sel}`);
        await page.waitForTimeout(400);
        return true;
      }
    } catch { /* next */ }
  }
  log.push('no cookie banner needed dismissing');
  return false;
}

async function waitForFlutterMount(page) {
  const started = Date.now();
  const deadline = started + 45_000;
  while (Date.now() < deadline) {
    const n = await page.locator('input[type="password"]').count();
    if (n > 0) return Date.now() - started;
    await page.waitForTimeout(300);
  }
  return null;
}

async function tryStrategy(context, strat) {
  const page = await context.newPage();
  const log = [];
  /**
   * Keys are named `...Selector`, not `username`/`password`.
   *
   * Not cosmetic. `npm run audit:secrets` scans artifacts for JSON fields named
   * `password` and flagged this file as a high-severity finding on its first
   * run -- correctly, because it cannot tell a CSS selector or a throwaway
   * string from a real credential, and it should not try. Naming the keys for
   * what they hold keeps the guard meaningful instead of teaching people to
   * add exceptions to it. Cf. F-09, where the redaction code was itself the leak.
   */
  const result = { strategy: strat.name, usernameSelector: strat.username, passwordSelector: strat.password, log };

  try {
    await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    result.mountMs = await waitForFlutterMount(page);
    log.push(`flutter mounted in ${result.mountMs}ms`);
    await dismissCookieBanner(page, log);

    if (strat.needsFocus) {
      /**
       * Focus the field the way a user would -- click the visible shell -- rather
       * than tabbing blindly. Tab order depends on the cookie banner and the
       * nav, so counting tabs is not reproducible.
       */
      const shell = page.locator('input[type="password"]').first();
      await shell.click({ timeout: 8000 });
      await page.waitForTimeout(500);
      log.push('clicked password shell to materialise authored ids');
    }

    result.counts = {
      username: await page.locator(strat.username).count(),
      password: await page.locator(strat.password).count(),
    };
    log.push(`counts username=${result.counts.username} password=${result.counts.password}`);

    if (!result.counts.username || !result.counts.password) {
      result.ok = false;
      result.reason = 'selector count 0 -- field not present with this strategy';
      await page.close();
      return result;
    }

    // Type with a short per-character delay, matching the adapter's posture.
    const u = page.locator(strat.username).first();
    const p = page.locator(strat.password).first();

    const t0 = Date.now();
    await u.click({ timeout: 8000 });
    await u.type(PROBE_USERNAME, { delay: 18 });
    result.usernameMs = Date.now() - t0;

    const t1 = Date.now();
    await p.click({ timeout: 8000 });
    await p.type(PROBE_PASSWORD, { delay: 18 });
    result.passwordMs = Date.now() - t1;

    /**
     * Read the values back. This is the postcondition check, and it is the whole
     * point -- O-5 found an action in this codebase that appeared to succeed for
     * the project's entire history while doing nothing, because nobody verified
     * the result. `type()` resolving is not evidence the field holds the text,
     * especially on a framework that may route input elsewhere.
     *
     * The comparison happens here and only the OUTCOME is persisted. The field
     * contents are never written to the artifact: this probe uses throwaway
     * strings, but a future edit that points it at real credentials must not
     * turn an artifact into a credential store. Record the verdict, not the
     * payload.
     */
    const readUser = await u.inputValue();
    const readPass = await p.inputValue();
    result.verified = {
      usernameMatched: readUser === PROBE_USERNAME,
      passwordMatched: readPass === PROBE_PASSWORD,
      usernameLength: readUser.length,
      passwordLength: readPass.length,
    };
    result.ok = result.verified.usernameMatched && result.verified.passwordMatched;

    // Is the submit affordance now enabled? Flutter renders it as a semantics node.
    result.submit = await page.evaluate(`(() => {
      const nodes = [...document.querySelectorAll('flt-semantics[role=button]')];
      const hit = nodes.find(n => /^log in$/i.test((n.getAttribute('aria-label') || n.textContent || '').trim()));
      if (!hit) return null;
      return {
        found: true,
        ariaLabel: hit.getAttribute('aria-label'),
        ariaDisabled: hit.getAttribute('aria-disabled'),
        generatedId: hit.id,
        rect: hit.getBoundingClientRect().toJSON(),
      };
    })()`);

    await page.screenshot({ path: path.join(OUT_DIR, `typing-${strat.name.split(' ')[0]}.png`) });
  } catch (err) {
    result.ok = false;
    result.error = err.message.split('\n')[0];
  }

  await page.close();
  return result;
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const base = launchOptions({ headless: !HEADED });
  let browser;
  for (const ch of ['chrome', 'chromium', undefined]) {
    try { browser = await chromium.launch({ ...base, channel: ch }); console.log(`channel: ${ch ?? 'bundled'}\n`); break; }
    catch { /* next */ }
  }
  if (!browser) throw new Error('no browser channel available');

  const context = await browser.newContext(contextOptions());
  const results = [];

  for (const strat of STRATEGIES) {
    console.log(`--- ${strat.name} ---`);
    console.log(`    username: ${strat.username}`);
    console.log(`    password: ${strat.password}`);
    const r = await tryStrategy(context, strat);
    results.push(r);
    for (const l of r.log) console.log(`    · ${l}`);
    if (r.error) console.log(`    ERROR ${r.error}`);
    else if (!r.ok && r.reason) console.log(`    NOT VIABLE  ${r.reason}`);
    else {
      console.log(`    typed username in ${r.usernameMs}ms, password in ${r.passwordMs}ms`);
      console.log(`    read back  username matched=${r.verified.usernameMatched} (${r.verified.usernameLength} chars)`);
      console.log(`               password matched=${r.verified.passwordMatched} (${r.verified.passwordLength} chars)`);
      console.log(`    POSTCONDITION ${r.ok ? 'VERIFIED -- field holds the text' : 'FAILED -- text did not land'}`);
      if (r.submit) {
        console.log(`    submit: aria-label=${JSON.stringify(r.submit.ariaLabel)} aria-disabled=${r.submit.ariaDisabled} `
          + `(generated id ${r.submit.generatedId} -- do NOT select on this)`);
      }
    }
    console.log('');
  }

  await writeFile(path.join(OUT_DIR, 'typing-probe.json'),
    JSON.stringify({ probedAt: new Date().toISOString(), url: URL, results }, null, 2));

  const winners = results.filter((r) => r.ok);
  console.log('================ VERDICT ================');
  if (winners.length) {
    console.log(`  GEICO IS AUTOMATABLE. ${winners.length}/${results.length} strategies verified.`);
    console.log(`  Recommended: ${winners[0].strategy}`);
    console.log(`     username  ${winners[0].usernameSelector}`);
    console.log(`     password  ${winners[0].passwordSelector}`);
    console.log(`  Mount wait needed: ~${winners[0].mountMs}ms (Imperva + Flutter boot)`);
    console.log('  The earlier "closed shadow root" verdict was WRONG.');
  } else {
    console.log('  No selector strategy could type into the form.');
    console.log('  Keyboard traversal remains the fallback (proven to reach the field).');
  }
  console.log('=========================================');

  await browser.close();
  console.log(`\nwrote ${path.join(OUT_DIR, 'typing-probe.json')}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
