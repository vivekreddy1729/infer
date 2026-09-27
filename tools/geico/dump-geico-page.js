#!/usr/bin/env node
/**
 * Render any GEICO page in a real browser and dump its text, controls and
 * network activity.
 *
 * ISOLATION: self-contained. Never import from progressive.js.
 *
 * WHY THIS EXISTS
 * GEICO serves Flutter Web and JS-rendered marketing pages, so `curl` and
 * plain HTTP fetches return a shell with no readable content -- an attempt to
 * fetch the 2-Step Verification FAQ returned 53 bytes and no text at all. Any
 * question about what GEICO's pages actually say has to be answered by a
 * browser that runs their JS.
 *
 * Used for two things:
 *   1. public pages, to learn the flow vocabulary without spending a login
 *   2. LATER, the authenticated documents page during a guided walkthrough,
 *      which is why it records the network -- the document endpoint will show
 *      up there, and that is usually a far better integration point than
 *      clicking through a UI
 *
 *   node tools/geico/dump-geico-page.js <url> [--headed] [--wait 20000]
 */

import { chromium } from 'patchright';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { launchOptions, contextOptions } from '../../src/browser/stealth.js';

const OUT_DIR = 'artifacts/probes/geico/pages';
const url = process.argv[2];
const HEADED = process.argv.includes('--headed');
const waitIdx = process.argv.indexOf('--wait');
const EXTRA_WAIT = waitIdx > -1 ? Number(process.argv[waitIdx + 1]) : 12_000;

if (!url) {
  console.error('usage: node tools/geico/dump-geico-page.js <url> [--headed] [--wait ms]');
  process.exit(1);
}

const slug = url.replace(/^https?:\/\//, '').replace(/[^a-z0-9]+/gi, '-').replace(/-+$/, '').slice(0, 80);

async function main() {
  await mkdir(OUT_DIR, { recursive: true });

  const base = launchOptions({ headless: !HEADED });
  let browser;
  for (const ch of ['chrome', 'chromium', undefined]) {
    try { browser = await chromium.launch({ ...base, channel: ch }); break; } catch { /* next */ }
  }
  if (!browser) throw new Error('no browser channel available');

  const context = await browser.newContext(contextOptions());
  const page = await context.newPage();

  const api = [];
  page.on('response', async (r) => {
    const u = r.url();
    if (/\.(png|jpe?g|gif|svg|woff2?|ttf|css|js)(\?|$)/i.test(u)) return;
    const ct = r.headers()['content-type'] || '';
    const isInteresting = /json/i.test(ct) || /\/api\/|document|policy|auth|verif|otp|mfa/i.test(u);
    if (!isInteresting) return;
    const rec = { status: r.status(), method: r.request().method(), url: u.slice(0, 260), contentType: ct.split(';')[0] };
    // Capture small JSON bodies -- the shape of a document list is exactly the
    // kind of thing that saves hours of DOM scraping later.
    if (/json/i.test(ct)) {
      try {
        const body = await r.text();
        if (body.length < 12_000) rec.body = JSON.parse(body);
        else rec.bodyTruncated = body.slice(0, 2000);
      } catch { /* non-JSON or consumed */ }
    }
    api.push(rec);
  });

  console.log(`loading ${url}`);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });

  // Dismiss OneTrust so it does not cover the content we came to read.
  for (const sel of ['#onetrust-reject-all-handler', '#onetrust-accept-btn-handler']) {
    try {
      const l = page.locator(sel).first();
      if (await l.count() && await l.isVisible()) { await l.click({ timeout: 2500 }); break; }
    } catch { /* fine */ }
  }

  // Flutter and lazy marketing widgets both mount late; give them room.
  await page.waitForTimeout(EXTRA_WAIT);

  const dump = await page.evaluate(`(() => {
    const vis = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
    const clean = (s) => (s || '').replace(/\\s+/g, ' ').trim();
    return {
      title: document.title,
      url: location.href,
      // Visible text, which on Flutter pages lives in the semantics tree.
      text: clean(document.body.innerText).slice(0, 20000),
      headings: [...document.querySelectorAll('h1,h2,h3,h4')].filter(vis).map(h => clean(h.textContent)).filter(Boolean).slice(0, 60),
      links: [...document.querySelectorAll('a[href]')].filter(vis)
        .map(a => ({ text: clean(a.textContent).slice(0, 80), href: a.getAttribute('href') }))
        .filter(l => l.text).slice(0, 80),
      inputs: [...document.querySelectorAll('input, select, textarea')].map(el => ({
        tag: el.tagName.toLowerCase(), type: el.getAttribute('type'), id: el.id || null,
        name: el.getAttribute('name') || null, autocomplete: el.getAttribute('autocomplete') || null,
        ariaLabel: el.getAttribute('aria-label') || null,
        semanticsRole: el.getAttribute('data-semantics-role') || null, visible: vis(el),
      })),
      // Flutter renders buttons as semantics nodes, not <button>.
      buttons: [...document.querySelectorAll('button,[role=button],flt-semantics[role=button]')]
        .map(el => ({ tag: el.tagName.toLowerCase(), id: el.id || null,
                      label: clean(el.getAttribute('aria-label') || el.textContent).slice(0, 80) }))
        .filter(b => b.label).slice(0, 50),
      isFlutter: !!document.querySelector('flt-glass-pane, flutter-view'),
      semanticsNodes: document.querySelectorAll('flt-semantics').length,
    };
  })()`);

  dump.api = api;
  dump.cookies = (await context.cookies()).map((c) => c.name);

  console.log(`\ntitle      ${dump.title}`);
  console.log(`final url  ${dump.url}`);
  console.log(`flutter    ${dump.isFlutter} (${dump.semanticsNodes} semantics nodes)`);
  console.log(`\n--- headings ---`);
  for (const h of dump.headings) console.log(`  ${h}`);
  console.log(`\n--- buttons / actions ---`);
  for (const b of dump.buttons) console.log(`  [${b.tag}] ${b.label}`);
  console.log(`\n--- visible inputs ---`);
  for (const i of dump.inputs.filter((x) => x.visible)) {
    console.log(`  type=${i.type} id=${i.id} name=${i.name} autocomplete=${i.autocomplete} aria=${i.ariaLabel}`);
  }
  if (api.length) {
    console.log(`\n--- API / JSON responses (${api.length}) ---`);
    for (const a of api) console.log(`  ${a.status} ${a.method} ${a.url}`);
  }
  console.log(`\n--- text (first 3000 chars) ---\n${dump.text.slice(0, 3000)}`);

  const out = path.join(OUT_DIR, `${slug}.json`);
  await writeFile(out, JSON.stringify(dump, null, 2));
  await page.screenshot({ path: path.join(OUT_DIR, `${slug}.png`), fullPage: true });
  await browser.close();
  console.log(`\nwrote ${out}`);
}

main().catch((err) => { console.error(err); process.exit(1); });
