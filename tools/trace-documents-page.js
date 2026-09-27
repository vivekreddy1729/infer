/**
 * Trace exactly what the documents page does on load, with no interaction.
 *
 * `repro-documents.js` showed the adapter never sees a `/policypro` request at
 * all, which means the failure is upstream of header harvesting and document
 * selection: the SPA simply is not fetching the list when we think it is.
 *
 * This lists every API call the page makes after navigation, what it renders, and
 * where it ended up, so the difference between "we navigated wrong" and "the app
 * needs a nudge before it loads data" is settled by observation.
 *
 *   node tools/trace-documents-page.js
 *   node tools/trace-documents-page.js --headed
 */

import fs from 'node:fs/promises';
import path from 'node:path';

const headed = process.argv.includes('--headed');
process.env.HEADLESS = headed ? 'false' : 'true';
process.env.BLOCK_RESOURCES = 'true';

const { default: config } = await import('../src/config.js');
const { contextOptions, launchOptions } = await import('../src/browser/stealth.js');
const { installResourceBlocking } = await import('../src/browser/resourceBlocker.js');
const { ProgressiveCarrier } = await import('../src/carriers/progressive.js');

const CANDIDATE_URLS = [
  'https://policyservicing.apps.progressive.com/app/documents-hub/find-document',
  'https://policyservicing.apps.progressive.com/app/documents-hub',
  'https://policyservicing.apps.progressive.com/app/account-home',
];

const PROFILES = path.resolve(config.DATA_DIR, 'profiles');
const dirs = [];
for (const name of await fs.readdir(PROFILES).catch(() => [])) {
  const dir = path.join(PROFILES, name);
  const st = await fs.stat(dir).catch(() => null);
  if (st?.isDirectory()) dirs.push({ dir, mtime: st.mtimeMs, name });
}
dirs.sort((a, b) => b.mtime - a.mtime);
if (!dirs.length) {
  console.error('No profiles. Run a pull first.');
  process.exit(1);
}

const { chromium } = await import(config.BROWSER_DRIVER);
let context;
for (const channel of ['chrome', 'chromium', undefined]) {
  try {
    context = await chromium.launchPersistentContext(dirs[0].dir, {
      ...launchOptions({ headless: config.HEADLESS }),
      ...contextOptions(),
      channel,
    });
    break;
  } catch {
    /* next */
  }
}
context.setDefaultTimeout(25_000);
context.setDefaultNavigationTimeout(25_000);
await installResourceBlocking(context, {
  blockStylesheets: ProgressiveCarrier.blockStylesheets,
  extraAllow: ProgressiveCarrier.extraAllow,
});

const page = context.pages()[0] ?? (await context.newPage());

const api = [];
const mask = (u) =>
  u.replace(/\b\d{9,}\b/g, '{policyNumber}').replace(/([?&](?:access_token|token)=)[^&]+/gi, '$1{redacted}');

page.on('request', (r) => {
  const u = r.url();
  if (!u.includes('api.progressive.com') && !u.includes('/policypro')) return;
  api.push({ kind: 'req', method: r.method(), url: mask(u), hasAuth: Boolean(r.headers().authorization) });
});
page.on('response', (r) => {
  const u = r.url();
  if (!u.includes('api.progressive.com') && !u.includes('/policypro')) return;
  api.push({ kind: 'res', status: r.status(), url: mask(u), ct: (r.headers()['content-type'] ?? '').split(';')[0] });
});

await fs.mkdir('artifacts/probes', { recursive: true });

for (const url of CANDIDATE_URLS) {
  api.length = 0;
  console.log(`\n${'='.repeat(74)}\nNavigating to ${url}`);

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded' });
  } catch (err) {
    console.log(`  navigation error: ${err.message.split('\n')[0]}`);
    continue;
  }

  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {});
  await page.waitForTimeout(3500);

  console.log(`  landed on: ${mask(page.url())}`);

  const view = await page.evaluate(() => {
    const deep = (sel) => {
      const out = [];
      const walk = (r) => {
        out.push(...r.querySelectorAll(sel));
        for (const n of r.querySelectorAll('*')) if (n.shadowRoot) walk(n.shadowRoot);
      };
      walk(document);
      return out;
    };
    const vis = (n) => {
      const b = n.getBoundingClientRect();
      return b.width > 0 && b.height > 0;
    };
    return {
      title: document.title,
      text: (document.body?.innerText ?? '').replace(/\s+/g, ' ').trim().slice(0, 500),
      selects: deep('select').filter(vis).map((s) => ({
        id: s.id || undefined,
        options: [...s.options].map((o) => `${o.value}|${o.text.trim().slice(0, 30)}`).slice(0, 10),
        value: s.value,
      })),
      buttons: deep('button').filter(vis).map((b) => (b.innerText || '').trim().slice(0, 34)).filter(Boolean).slice(0, 14),
      rows: deep('tr, [role=row], .document-row, li').filter(vis).length,
      docLinks: deep('a[href]').filter(vis)
        .map((a) => ({ text: (a.innerText || '').trim().slice(0, 40), href: a.getAttribute('href') }))
        .filter((l) => /document|pdf|declaration|dec/i.test(`${l.text} ${l.href}`))
        .slice(0, 10),
    };
  });

  console.log(`  title: ${view.title}`);
  console.log(`  visible rows: ${view.rows}`);
  console.log(`  text: ${view.text.slice(0, 260)}`);
  if (view.selects.length) {
    console.log('  SELECTS:');
    for (const s of view.selects) {
      console.log(`    #${s.id ?? '(no id)'} value="${s.value}"`);
      for (const o of s.options) console.log(`        ${o}`);
    }
  }
  if (view.buttons.length) console.log(`  buttons: ${view.buttons.join(' | ')}`);
  if (view.docLinks.length) {
    console.log('  DOC LINKS:');
    for (const l of view.docLinks) console.log(`    "${l.text}" -> ${l.href}`);
  }

  console.log(`  API CALLS (${api.length}):`);
  if (api.length === 0) {
    console.log('    (none — the page made no API request on load)');
  }
  for (const e of api) {
    if (e.kind === 'req') console.log(`    -> ${e.method} ${e.hasAuth ? '[auth]' : '[no-auth]'} ${e.url.slice(0, 110)}`);
    else console.log(`    <- ${e.status} ${e.ct} ${e.url.slice(0, 110)}`);
  }

  const shot = path.join('artifacts/probes', `docpage-${url.split('/app/')[1].replace(/\W+/g, '-')}.png`);
  await page.screenshot({ path: shot, fullPage: false }).catch(() => {});
  console.log(`  screenshot: ${shot}`);
}

await context.close();
