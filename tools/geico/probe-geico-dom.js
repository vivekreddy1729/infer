#!/usr/bin/env node
/**
 * GEICO DOM probe -- settles the "closed shadow root" verdict.
 *
 * ------------------------------------------------------------------------
 * ISOLATION NOTE (read before editing)
 * ------------------------------------------------------------------------
 * Everything under tools/geico/ and src/carriers/geico/ is deliberately
 * self-contained. It imports only infrastructure that has no carrier-specific
 * behaviour (config, logger, stealth posture). It must never import from
 * progressive.js, and nothing Progressive touches may be edited to suit GEICO.
 * Duplication between the two adapters is an accepted, intentional cost: the
 * Progressive path is verified working end-to-end against a real account and
 * is worth more than the lines of code a shared helper would save.
 * ------------------------------------------------------------------------
 *
 * WHY THIS TOOL EXISTS
 *
 * GEICO was previously ruled out (engineering log F-06) on this
 * evidence: the login page renders a visible email/password form, a screenshot
 * proves it, and yet `input[type="password"]` has a count of ZERO to both
 * `page.evaluate` and Playwright's locator engine, even after polling and after
 * traversing *open* shadow roots. The conclusion recorded was "closed shadow
 * root".
 *
 * That conclusion was an *inference*, not a measurement. Four different causes
 * produce exactly the same observable:
 *
 *   1. closed shadow root      -- `attachShadow({ mode: 'closed' })`, no handle
 *                                 is exposed, so no traversal can reach it
 *   2. cross-origin iframe     -- needs frame targeting, not selectors
 *   3. late mount              -- the form arrives after the poll gave up
 *   4. wrong URL               -- the probed entry point is not the real form
 *
 * Only (1) is genuinely hostile. (2) and (3) are ordinary and cheap to handle,
 * and (4) means the verdict was about the wrong page. Ruling a carrier out for
 * the wrong reason is expensive in both directions, so this probe distinguishes
 * them instead of guessing.
 *
 * THE DECISIVE TRICK
 *
 * `Element.prototype.attachShadow` is patched from an init script, which runs
 * *before* any page script. Every shadow root the page creates -- open OR
 * closed -- is pushed into a global array as it is created. A closed root is
 * only unreachable if you did not hold the reference at creation time; if you
 * patched the constructor, you hold every reference.
 *
 * So this probe can answer, separately:
 *   - does the page create closed shadow roots at all?
 *   - are the login inputs inside one?
 *   - can Playwright's own locator engine reach them regardless?
 *
 * IMPORTANT: this patch is a RESEARCH INSTRUMENT, not a production technique.
 * Overriding a native prototype is observable from the page (`attachShadow
 * .toString()` no longer reads as native code), which is exactly the kind of
 * seam src/browser/stealth.js argues against injecting. Do not copy it into the
 * adapter. Its job is to tell us which automation strategy the adapter needs;
 * the adapter then uses that strategy without the patch.
 *
 * Runs against the public login page only. No credentials, no submit.
 *
 *   node tools/geico/probe-geico-dom.js
 *   node tools/geico/probe-geico-dom.js --headed
 */

import { chromium } from 'patchright';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { launchOptions, contextOptions } from '../../src/browser/stealth.js';

const OUT_DIR = 'artifacts/probes/geico';
const HEADED = process.argv.includes('--headed');

/**
 * Candidate entry points, in the order worth trying.
 *
 * `ecams.geico.com/login` is what the original recon probed. It is the Online
 * Service Center, which the public documentation names as the place policy
 * documents live -- so it is the right destination -- but GEICO has moved its
 * *authentication* between hosts over time, and a redirect chain to a separate
 * IdP would fully explain a form that selectors cannot see. Each candidate is
 * recorded with its final URL after redirects so the chain is visible.
 */
const CANDIDATES = [
  ['ecams', 'https://ecams.geico.com/login'],
  ['root', 'https://www.geico.com/'],
  ['login-alias', 'https://login.geico.com/'],
];

/**
 * Enumerate every input on the page through four independent routes.
 *
 * Runs entirely in the page. Returns plain data -- no handles -- because the
 * interesting output is a comparison between routes, and a route returning zero
 * while another returns fields is the whole finding.
 */
const ENUMERATE = `(() => {
  const describe = (el, route) => ({
    route,
    tag: el.tagName.toLowerCase(),
    type: el.getAttribute('type'),
    id: el.id || null,
    name: el.getAttribute('name') || null,
    autocomplete: el.getAttribute('autocomplete') || null,
    ariaLabel: el.getAttribute('aria-label') || null,
    placeholder: el.getAttribute('placeholder') || null,
    dataAttrs: Object.fromEntries(
      [...el.attributes].filter(a => a.name.startsWith('data-')).map(a => [a.name, a.value])
    ),
    // A generated id is a trap: it looks like a great selector in devtools and
    // then changes on the next page load. Flag anything that looks minted.
    idLooksGenerated: !!el.id && /^(input|mat-input|:r)?[0-9a-f]{6,}$/i.test(el.id),
    visible: !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length),
  });

  const out = { light: [], openShadow: [], closedShadow: [], iframes: [] };

  // route 1 -- plain document query
  for (const el of document.querySelectorAll('input, button[type=submit]')) {
    out.light.push(describe(el, 'light'));
  }

  // route 2 -- walk OPEN shadow roots, recursively
  const walkOpen = (root, depth = 0) => {
    if (depth > 12) return;
    for (const el of root.querySelectorAll('*')) {
      if (el.shadowRoot) {
        for (const i of el.shadowRoot.querySelectorAll('input, button[type=submit]')) {
          out.openShadow.push({ ...describe(i, 'openShadow'), host: el.tagName.toLowerCase(), depth });
        }
        walkOpen(el.shadowRoot, depth + 1);
      }
    }
  };
  walkOpen(document);

  // route 3 -- shadow roots captured at attachShadow() time, which includes CLOSED ones
  const captured = window.__probeShadowRoots || [];
  for (const { root, mode, host } of captured) {
    try {
      for (const i of root.querySelectorAll('input, button[type=submit]')) {
        out.closedShadow.push({ ...describe(i, 'captured'), mode, host });
      }
    } catch { /* detached root */ }
  }

  // route 4 -- iframes, which selectors on the top document never see
  for (const f of document.querySelectorAll('iframe')) {
    out.iframes.push({ src: f.getAttribute('src'), name: f.getAttribute('name'), id: f.id || null });
  }

  out.shadowSummary = {
    totalCaptured: captured.length,
    open: captured.filter(c => c.mode === 'open').length,
    closed: captured.filter(c => c.mode === 'closed').length,
    closedHosts: [...new Set(captured.filter(c => c.mode === 'closed').map(c => c.host))],
  };
  return out;
})()`;

async function probe(browser, [name, url]) {
  const context = await browser.newContext(contextOptions());

  /**
   * Patch attachShadow before any page script runs. This is the line that makes
   * closed roots observable -- see the header comment.
   */
  await context.addInitScript(() => {
    window.__probeShadowRoots = [];
    const native = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function (init) {
      const root = native.call(this, init);
      try {
        window.__probeShadowRoots.push({
          root,
          mode: init && init.mode,
          host: this.tagName ? this.tagName.toLowerCase() : '?',
        });
      } catch { /* ignore */ }
      return root;
    };
  });

  const page = await context.newPage();

  // Record the network so the auth endpoint and any document API show up.
  const requests = [];
  page.on('request', (r) => {
    const u = r.url();
    if (/\.(png|jpe?g|gif|svg|woff2?|ttf|css)(\?|$)/i.test(u)) return;
    requests.push({ method: r.method(), url: u.slice(0, 220), type: r.resourceType() });
  });
  const responses = [];
  page.on('response', (r) => {
    if (r.request().resourceType() === 'document' || /api|auth|login|token|session/i.test(r.url())) {
      responses.push({ status: r.status(), url: r.url().slice(0, 220) });
    }
  });

  const started = Date.now();
  const result = { name, url, error: null };

  try {
    const nav = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    result.status = nav?.status() ?? null;

    /**
     * Poll rather than sample once. This is the F-06 lesson: GEICO mounts its
     * app after an Imperva JS challenge settles, several seconds after
     * networkidle, and a single sample reported "NO FORM FOUND" for a page that
     * was visibly fine. Poll all four routes until a password field appears
     * anywhere, or the ceiling is hit.
     */
    const deadline = Date.now() + 30_000;
    let dom = null;
    let firstSeenMs = null;
    while (Date.now() < deadline) {
      dom = await page.evaluate(ENUMERATE);
      const anyPassword = [...dom.light, ...dom.openShadow, ...dom.closedShadow]
        .some((i) => i.type === 'password');
      if (anyPassword) { firstSeenMs = Date.now() - started; break; }
      await page.waitForTimeout(500);
    }

    result.finalUrl = page.url();
    result.redirected = page.url() !== url;
    result.title = await page.title();
    result.loadMs = Date.now() - started;
    result.passwordFirstSeenMs = firstSeenMs;
    result.dom = dom;

    /**
     * Ask Playwright's own locator engine, separately. It resolves differently
     * from page.evaluate -- it pierces open shadow roots natively -- and the gap
     * between the two routes is the actual signal about automatability.
     */
    result.locators = {};
    for (const sel of ['input[type="password"]', 'input[type="email"]', 'input[autocomplete="username"]', '#username', '#password']) {
      result.locators[sel] = await page.locator(sel).count();
    }

    /**
     * Fallback viability: can keyboard traversal reach a password field even
     * when selectors cannot? Tab through and read the focused element via
     * document.activeElement, which follows focus into closed roots. If this
     * works, the carrier is automatable without any selector at all -- more
     * brittle, but a real option rather than a dead end.
     */
    await page.keyboard.press('Tab');
    const focusTrail = [];
    for (let i = 0; i < 25; i++) {
      const active = await page.evaluate(`(() => {
        let el = document.activeElement;
        // descend through shadow roots to the genuinely focused node
        while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
        if (!el) return null;
        return {
          tag: el.tagName.toLowerCase(),
          type: el.getAttribute && el.getAttribute('type'),
          id: el.id || null,
          name: el.getAttribute && el.getAttribute('name'),
          autocomplete: el.getAttribute && el.getAttribute('autocomplete'),
          ariaLabel: el.getAttribute && el.getAttribute('aria-label'),
        };
      })()`);
      focusTrail.push(active);
      if (active && active.type === 'password') break;
      await page.keyboard.press('Tab');
    }
    result.focusTrail = focusTrail;
    result.reachableByKeyboard = focusTrail.some((f) => f && f.type === 'password');

    result.cookies = (await context.cookies()).map((c) => c.name);
    result.requests = requests.slice(0, 80);
    result.responses = responses.slice(0, 40);

    await page.screenshot({ path: path.join(OUT_DIR, `${name}.png`), fullPage: false });
  } catch (err) {
    result.error = err.message;
  }

  await context.close();
  return result;
}

function verdict(r) {
  if (r.error) return `ERROR -- ${r.error}`;
  const s = r.dom?.shadowSummary ?? {};
  const pwLight = r.dom?.light.some((i) => i.type === 'password');
  const pwOpen = r.dom?.openShadow.some((i) => i.type === 'password');
  const pwClosed = r.dom?.closedShadow.some((i) => i.type === 'password');
  const pwLocator = (r.locators?.['input[type="password"]'] ?? 0) > 0;

  if (pwLight && pwLocator) return 'STRAIGHTFORWARD -- password field in the light DOM, locators see it';
  if (pwOpen && pwLocator) return 'OPEN SHADOW -- Playwright pierces it natively, ordinary selectors work';
  if (pwClosed && !pwLocator) {
    return `CLOSED SHADOW CONFIRMED -- field exists only inside a closed root (hosts: ${s.closedHosts?.join(', ')}). `
      + `Selectors cannot reach it. Keyboard traversal ${r.reachableByKeyboard ? 'CAN' : 'cannot'}.`;
  }
  if (!pwLight && !pwOpen && !pwClosed && r.dom?.iframes.length) {
    return `IFRAME -- no field in this document, ${r.dom.iframes.length} iframe(s) present. Target the frame, not the page.`;
  }
  if (!pwLight && !pwOpen && !pwClosed) {
    return 'NO FIELD ANYWHERE -- wrong entry point, hard block, or mount beyond the 30s ceiling. '
      + 'Check the screenshot before concluding anything.';
  }
  return `MIXED -- light:${pwLight} open:${pwOpen} closed:${pwClosed} locator:${pwLocator}`;
}

/**
 * Mirrors the launch fallback chain in src/browser/browserPool.js rather than
 * importing it, to keep this tool free of shared mutable state.
 *
 * The chain matters and is not just defensive boilerplate: with no channel and
 * headless:true, Playwright launches `chrome-headless-shell`, a stripped binary
 * that announces "HeadlessChrome" in its UA. Degrading to that silently would
 * make a *detectability* finding look like a *DOM* finding. So the channel that
 * actually won is printed, and any result gathered on bundled Chromium should be
 * treated as provisional for anti-bot purposes.
 */
async function launchWithFallback() {
  const base = launchOptions({ headless: !HEADED });
  const attempts = [
    { ...base, channel: 'chrome' },
    { ...base, channel: 'chromium' },
    { ...base, channel: undefined },
  ];
  let lastErr;
  for (const opts of attempts) {
    try {
      const browser = await chromium.launch(opts);
      const used = opts.channel ?? 'bundled-chromium';
      console.log(`launched on channel: ${used}`);
      if (used !== 'chrome') {
        console.log('  NOTE: not real Chrome. DOM findings still valid; treat anti-bot behaviour as provisional.');
      }
      return browser;
    } catch (err) {
      lastErr = err;
      console.log(`  launch failed on channel=${opts.channel ?? 'none'}: ${err.message.split('\n')[0]}`);
    }
  }
  throw lastErr;
}

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  const browser = await launchWithFallback();
  const results = [];

  for (const cand of CANDIDATES) {
    process.stdout.write(`\nprobing ${cand[0]} -> ${cand[1]}\n`);
    const r = await probe(browser, cand);
    results.push(r);

    console.log(`  status        ${r.status ?? '-'}   loaded in ${r.loadMs ?? '-'}ms`);
    console.log(`  final url     ${r.finalUrl ?? '-'}${r.redirected ? '   (REDIRECTED)' : ''}`);
    console.log(`  title         ${r.title ?? '-'}`);
    if (r.dom) {
      const s = r.dom.shadowSummary;
      console.log(`  inputs        light:${r.dom.light.length}  openShadow:${r.dom.openShadow.length}  captured:${r.dom.closedShadow.length}  iframes:${r.dom.iframes.length}`);
      console.log(`  shadow roots  ${s.totalCaptured} total / ${s.open} open / ${s.closed} closed`);
      console.log(`  locator count input[type=password] = ${r.locators?.['input[type="password"]']}`);
      console.log(`  pw first seen ${r.passwordFirstSeenMs ?? 'never'}ms`);
      console.log(`  keyboard      password reachable by Tab: ${r.reachableByKeyboard}`);
    }
    console.log(`  VERDICT       ${verdict(r)}`);
  }

  await browser.close();
  const outFile = path.join(OUT_DIR, 'dom-probe.json');
  await writeFile(outFile, JSON.stringify({ probedAt: new Date().toISOString(), results }, null, 2));
  console.log(`\nwrote ${outFile}`);
  console.log(`screenshots in ${OUT_DIR}/`);
}

main().catch((err) => { console.error(err); process.exit(1); });
