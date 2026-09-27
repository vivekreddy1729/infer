/**
 * Read-only carrier login-page probe.
 *
 * Answers two questions that otherwise cost hours of guesswork per carrier:
 *
 *   1. Does our browser stack get served the real login form, or a bot wall?
 *      This is the go/no-go signal. There is no point mapping selectors for a
 *      carrier that hands us an Akamai interstitial.
 *
 *   2. What are the actual selectors? It dumps every visible input and button
 *      with the attributes that make a good locator, so writing the adapter
 *      becomes transcription rather than archaeology.
 *
 * Strictly non-destructive: it navigates, observes, screenshots, and leaves.
 * It never types credentials and never submits a form. Nothing here does
 * anything a person opening the page in Chrome would not do.
 *
 * Usage:
 *   node tools/probe-carrier.js                       # probe the shortlist
 *   node tools/probe-carrier.js https://example.com/login
 *   HEADLESS=false node tools/probe-carrier.js        # watch it happen
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import config from '../src/config.js';
import browserPool from '../src/browser/browserPool.js';
import { buildProxyConfig, newStickySessionId } from '../src/browser/proxy.js';

/** Shortlist from tools/recon-carriers.sh, ordered lightest bot layer first. */
const SHORTLIST = [
  ['hugo', 'https://app.withhugo.com/login'],
  ['progressive', 'https://account.apps.progressive.com/access/ez/login'],
  ['travelers', 'https://signin.travelers.com/'],
  ['lemonade', 'https://www.lemonade.com/login'],
  ['geico', 'https://ecams.geico.com/login'],
];

const OUT_DIR = path.resolve('artifacts/probes');

/** Signatures that mean we were challenged rather than served the form. */
const WALL_SELECTORS = [
  ['reCAPTCHA', 'iframe[src*="recaptcha"]'],
  ['hCaptcha', 'iframe[src*="hcaptcha"]'],
  ['PerimeterX', '#px-captcha'],
  ['DataDome', '[id*="datadome"]'],
  ['generic challenge frame', 'iframe[title*="challenge" i]'],
];

const WALL_PHRASES = [
  'access denied',
  'request unsuccessful',
  'unusual activity',
  'automated traffic',
  'incapsula incident',
  'pardon our interruption',
  'verify you are a human',
  'are you a robot',
];

/**
 * Attributes worth recording, in rough order of selector quality.
 *
 * Traverses open shadow roots. This is not optional: GEICO builds its login
 * form from web components, so a plain `document.querySelectorAll('input')`
 * returns nothing and the page looks empty even though the form is right there
 * on screen. The first version of this tool reported "NO FORM FOUND" for a page
 * that had rendered perfectly, which is a far more dangerous failure than a
 * crash — it would have led to writing off a carrier that actually works.
 *
 * Worth noting the asymmetry: Playwright's own CSS locators *do* pierce open
 * shadow roots, so an adapter would have worked where this probe did not.
 */
async function describeControls(page) {
  return page.evaluate(() => {
    const visible = (node) => {
      const r = node.getBoundingClientRect();
      const s = getComputedStyle(node);
      return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
    };

    /** Collect matches across the document and every open shadow root. */
    const deepQuery = (selector) => {
      const found = [];
      const walk = (root) => {
        found.push(...root.querySelectorAll(selector));
        for (const node of root.querySelectorAll('*')) {
          if (node.shadowRoot) walk(node.shadowRoot);
        }
      };
      walk(document);
      return found;
    };

    const attrs = (node) => ({
      tag: node.tagName.toLowerCase(),
      type: node.getAttribute('type') ?? undefined,
      id: node.id || undefined,
      name: node.getAttribute('name') ?? undefined,
      autocomplete: node.getAttribute('autocomplete') ?? undefined,
      testid:
        node.getAttribute('data-testid') ??
        node.getAttribute('data-test-id') ??
        node.getAttribute('data-qa') ??
        undefined,
      ariaLabel: node.getAttribute('aria-label') ?? undefined,
      placeholder: node.getAttribute('placeholder') ?? undefined,
      text: (node.innerText || node.value || '').trim().slice(0, 40) || undefined,
    });

    const inputs = deepQuery('input, select')
      .filter(visible)
      .filter((n) => n.getAttribute('type') !== 'hidden')
      .map(attrs);

    const buttons = deepQuery('button, input[type=submit], a[role=button]')
      .filter(visible)
      .map(attrs);

    return {
      title: document.title,
      inputs,
      buttons,
      formCount: deepQuery('form').length,
      // Flags when controls were only reachable through a shadow root, which
      // tells the adapter author to avoid raw DOM evaluation.
      shadowRootsSeen: [...document.querySelectorAll('*')].filter((n) => n.shadowRoot).length,
      iframeSrcs: deepQuery('iframe')
        .map((f) => f.src)
        .filter(Boolean)
        .slice(0, 8),
    };
  });
}

/** Suggest a Playwright locator from the recorded attributes. */
function suggestSelector(control) {
  if (control.testid) return `[data-testid="${control.testid}"]`;
  if (control.id) return `#${control.id}`;
  if (control.name) return `${control.tag}[name="${control.name}"]`;
  if (control.autocomplete) return `${control.tag}[autocomplete="${control.autocomplete}"]`;
  if (control.ariaLabel) return `${control.tag}[aria-label="${control.ariaLabel}"]`;
  if (control.placeholder) return `${control.tag}[placeholder="${control.placeholder}"]`;
  if (control.text) return `${control.tag}:has-text("${control.text}")`;
  return `${control.tag}${control.type ? `[type="${control.type}"]` : ''}`;
}

async function probe(name, url) {
  console.log(`\n${'='.repeat(74)}\n### ${name}  ${url}`);

  const proxy = config.RESIDENTIAL_PROXY_URL ? buildProxyConfig(newStickySessionId()) : null;
  const lease = await browserPool.acquireContext({ proxy, blockStylesheets: false });
  const page = await lease.context.newPage();

  const consoleErrors = [];
  page.on('console', (m) => {
    if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 120));
  });

  const started = performance.now();
  let status = null;
  try {
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 35_000 });
    status = response?.status() ?? null;

    // Let client-rendered forms mount. These are SPAs; domcontentloaded fires
    // long before the inputs exist.
    await page.waitForLoadState('networkidle', { timeout: 12_000 }).catch(() => {});

    /**
     * Poll for a password field rather than sampling the DOM once.
     *
     * Sampling once produced a genuinely misleading result on GEICO: the form
     * had not mounted when the query ran, but had by the time the screenshot was
     * taken, so the tool reported "NO FORM FOUND" for a page that was visibly
     * fine. The cause is that Imperva serves a JS challenge which must execute
     * and settle before the app renders, and that can land several seconds after
     * networkidle. Any carrier behind an interstitial challenge will behave this
     * way, so waiting for the thing we care about is the only correct approach.
     */
    const formAppeared = await page
      .waitForFunction(
        () => {
          const deep = (sel) => {
            const out = [];
            const walk = (root) => {
              out.push(...root.querySelectorAll(sel));
              for (const n of root.querySelectorAll('*')) if (n.shadowRoot) walk(n.shadowRoot);
            };
            walk(document);
            return out;
          };
          return deep('input[type="password"], input[autocomplete="current-password"]').length > 0
            ? true
            : deep('input:not([type="hidden"])').length > 0
              ? 'partial'
              : false;
        },
        { timeout: 25_000, polling: 500 }
      )
      .then((h) => h.jsonValue())
      .catch(() => false);

    // Small settle so late-mounting siblings (submit button, checkbox) are present.
    await page.waitForTimeout(formAppeared ? 600 : 1200);

    const loadMs = Math.round(performance.now() - started);
    if (formAppeared) console.log(`  form mounted after ${loadMs}ms (${formAppeared})`);

    // Did we get a wall?
    const walls = [];
    for (const [label, sel] of WALL_SELECTORS) {
      if ((await page.locator(sel).count().catch(() => 0)) > 0) walls.push(label);
    }
    const bodyText = (await page.locator('body').innerText().catch(() => '')).toLowerCase();
    for (const phrase of WALL_PHRASES) {
      if (bodyText.slice(0, 6000).includes(phrase)) walls.push(`text:"${phrase}"`);
    }

    const info = await describeControls(page);
    const cookies = await lease.context.cookies();

    const passwordField = info.inputs.find(
      (i) => i.type === 'password' || i.autocomplete === 'current-password'
    );
    const verdict = walls.length
      ? 'BLOCKED'
      : passwordField
        ? 'LOGIN FORM SERVED'
        : info.inputs.length
          ? 'PARTIAL (inputs but no password field — likely multi-step)'
          : 'NO FORM FOUND';

    console.log(`  http=${status}  load=${loadMs}ms  final=${page.url()}`);
    console.log(`  title: ${info.title}`);
    console.log(`  VERDICT: ${verdict}`);
    if (walls.length) console.log(`  walls: ${walls.join(', ')}`);
    console.log(
      `  forms=${info.formCount} inputs=${info.inputs.length} buttons=${info.buttons.length} shadowRoots=${info.shadowRootsSeen}`
    );

    if (info.inputs.length) {
      console.log('  --- candidate inputs ---');
      for (const i of info.inputs.slice(0, 10)) {
        console.log(
          `    ${suggestSelector(i).padEnd(46)} type=${i.type ?? '-'} autocomplete=${i.autocomplete ?? '-'}`
        );
      }
    }
    if (info.buttons.length) {
      console.log('  --- candidate buttons ---');
      for (const b of info.buttons.slice(0, 8)) {
        console.log(`    ${suggestSelector(b).padEnd(46)} "${b.text ?? ''}"`);
      }
    }
    if (info.iframeSrcs.length) {
      console.log(`  iframes: ${info.iframeSrcs.map((s) => s.slice(0, 70)).join('\n           ')}`);
    }

    const botCookies = cookies
      .map((c) => c.name)
      .filter((n) => /_abck|bm_sz|ak_bmsc|visid_incap|incap_ses|nlbi|datadome|_px|__cf_bm|TS[0-9a-f]{6}/i.test(n));
    console.log(`  bot cookies: ${botCookies.length ? botCookies.join(', ') : '(none)'}`);
    console.log(`  requests blocked: ${lease.blockingStats().blocked ?? 0} (${lease.blockingStats().blockedPct ?? 0}%)`);

    await fs.mkdir(OUT_DIR, { recursive: true });
    await page.screenshot({ path: path.join(OUT_DIR, `${name}.png`), fullPage: false });
    await fs.writeFile(
      path.join(OUT_DIR, `${name}.json`),
      JSON.stringify(
        { name, url, finalUrl: page.url(), status, loadMs, verdict, walls, botCookies, ...info },
        null,
        2
      )
    );
    console.log(`  saved: artifacts/probes/${name}.png and ${name}.json`);

    return { name, verdict, walls, loadMs };
  } catch (err) {
    console.log(`  ERROR: ${err.message.split('\n')[0]}`);
    return { name, verdict: 'ERROR', error: err.message.split('\n')[0] };
  } finally {
    await lease.release();
  }
}

const targets = process.argv.length > 2
  ? process.argv.slice(2).map((u) => [new URL(u).hostname.replace(/\W+/g, '-'), u])
  : SHORTLIST;

console.log(
  `Probing ${targets.length} target(s)\n` +
    `  proxy: ${config.RESIDENTIAL_PROXY_URL ? 'residential (configured)' : 'NONE — egressing from this host'}\n` +
    `  headless: ${config.HEADLESS}`
);

const results = [];
for (const [name, url] of targets) {
  results.push(await probe(name, url));
}

console.log(`\n${'='.repeat(74)}\nSUMMARY`);
for (const r of results) {
  console.log(`  ${String(r.name).padEnd(14)} ${r.verdict}${r.walls?.length ? `  [${r.walls.join(', ')}]` : ''}`);
}

await browserPool.shutdown();
