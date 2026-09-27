#!/usr/bin/env node
/**
 * Proves the flow recorder can capture a document that opens in a NEW TAB.
 *
 * ISOLATION: self-contained, GEICO-local. No Progressive imports.
 *
 * WHY THIS TEST EXISTS
 *
 * The first version of `record-geico-flow.js` bound its listeners to the single
 * page it created. GEICO's "View Declaration Page" opens the PDF in a new tab,
 * which in Playwright is a separate `Page` object, so the document was never
 * observed. Worse, the resulting recording was then read as evidence that the
 * user had *emailed* the document instead of downloading it — a mechanism
 * inferred from an absence, which is exactly the error F-32 records.
 *
 * Fixing it revealed a second, subtler problem. Attaching listeners to the new
 * tab is not enough: Chrome hands PDFs to its internal plugin viewer and that
 * response is never surfaced as a Playwright `response` event. Measured against
 * this fixture, the popup's URL was correctly `…/declaration.pdf` while the only
 * responses on that tab were Chrome's own PDF-viewer bundles (288KB and 344KB of
 * JavaScript). So "no PDF response captured" says nothing about whether a PDF
 * arrived.
 *
 * The approach that works — and the one the adapter must use — is to take the
 * tab's URL and re-request it through `context.request`, which shares cookies and
 * returns the bytes.
 *
 * Runs entirely against routed fixtures. No network, no carrier, no credentials.
 *
 *   node tools/geico/test-newtab-capture.js
 */

import http from 'node:http';
import { chromium } from 'patchright';
import { launchOptions, contextOptions } from '../../src/browser/stealth.js';

/**
 * A real loopback server, not `context.route()` interception.
 *
 * Third thing learned building this: `context.request.get()` does NOT pass
 * through `context.route()` handlers. It is a separate request context that goes
 * to the network, so routed fixtures are invisible to it and the first version of
 * this test failed with `getaddrinfo ENOTFOUND example.test`.
 *
 * That is not a problem for the adapter — against real GEICO the host resolves
 * and the cookies are shared, which is the whole point — but it means any test of
 * this mechanism has to serve real HTTP.
 */
function startFixtureServer() {
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/host')) {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<a id="go" href="/declaration.pdf" target="_blank">View Declaration Page</a>');
    } else if (req.url.startsWith('/declaration.pdf')) {
      res.writeHead(200, { 'content-type': 'application/pdf' });
      res.end(PDF);
    } else if (req.url.startsWith('/broken.pdf')) {
      // Negative control: HTML wearing a PDF content-type (the F-13 shape).
      res.writeHead(200, { 'content-type': 'application/pdf' });
      res.end('<html><body>Your session has expired</body></html>');
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

let failures = 0;
const pass = (m, d = '') => console.log(`  PASS  ${m}${d ? `  ${d}` : ''}`);
const fail = (m, d = '') => { failures += 1; console.log(`  FAIL  ${m}${d ? `  ${d}` : ''}`); };

const PDF = Buffer.from(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF'
);

async function launch() {
  for (const ch of ['chrome', 'chromium', undefined]) {
    try {
      return await chromium.launch({ ...launchOptions({ headless: true }), channel: ch });
    } catch { /* next */ }
  }
  throw new Error('no browser channel available');
}

/** The recorder's verification step, reproduced exactly. */
async function verifyDocumentTab(context, pg, tab, hits) {
  const url = pg.url();
  if (!url || url === 'about:blank') return;

  const looksLikeDocUrl = /\.pdf(\?|$)|pdf|document|declarat|contract|render|view|preview|download/i.test(url);
  const hasPdfEmbed = await pg
    .evaluate('!!document.querySelector(\'embed[type="application/pdf"], object[type="application/pdf"]\')')
    .catch(() => false);
  if (!looksLikeDocUrl && !hasPdfEmbed) return;

  try {
    const res = await context.request.get(url, { timeout: 20_000 });
    const buf = await res.body();
    const magic = buf.subarray(0, 5).toString('latin1');
    hits.push({
      tab,
      status: res.status(),
      contentType: (res.headers()['content-type'] || '').split(';')[0],
      bytes: buf.length,
      magic,
      looksLikePdf: magic.startsWith('%PDF-'),
    });
  } catch (err) {
    hits.push({ tab, error: err.message.split('\n')[0] });
  }
}

async function main() {
  console.log('New-tab document capture\n');
  const { server, port } = await startFixtureServer();
  const base = `http://127.0.0.1:${port}`;
  const browser = await launch();
  const context = await browser.newContext({ ...contextOptions(), acceptDownloads: true });

  const pages = [];
  const hits = [];
  let doubleAttach = 0;

  context.on('page', async (pg) => {
    if (pages.includes(pg)) { doubleAttach += 1; return; }
    const tab = pages.length;
    pages.push(pg);
    await pg.waitForLoadState('domcontentloaded').catch(() => {});
    await new Promise((r) => setTimeout(r, 1200));
    await verifyDocumentTab(context, pg, tab, hits);
  });

  const page = await context.newPage();
  if (!pages.includes(page)) pages.push(page);

  await page.goto(`${base}/host`);
  await Promise.all([context.waitForEvent('page'), page.click('#go')]);
  await new Promise((r) => setTimeout(r, 2500));

  // -- assertions ----------------------------------------------------------
  if (pages.length === 2) pass('both tabs tracked', `${pages.length} tabs`);
  else fail('tab count wrong', `expected 2, got ${pages.length}`);

  if (doubleAttach === 0) pass('no duplicate attachment');
  else fail('page attached twice', `${doubleAttach} duplicate(s) — responses would be recorded twice`);

  const pdfHit = hits.find((h) => h.looksLikePdf);
  if (pdfHit) {
    pass('document in the second tab captured', `tab ${pdfHit.tab}, ${pdfHit.bytes} bytes, ${pdfHit.contentType}`);
    pass('magic bytes prove a real PDF', JSON.stringify(pdfHit.magic));
  } else {
    fail('no PDF captured from the new tab', JSON.stringify(hits));
  }

  /**
   * Negative control: a test that cannot fail is not a test.
   *
   * An HTML error page served with a PDF content-type must NOT be reported as a
   * valid document. This is the F-13 lesson — a 200 and a plausible content-type
   * are not evidence of a PDF.
   */
  const negHits = [];
  const p2 = await context.newPage();
  await p2.goto(`${base}/broken.pdf`).catch(() => {});
  await verifyDocumentTab(context, p2, 99, negHits);
  const neg = negHits[0];
  if (!neg) {
    fail('negative control produced no result — the check may not be running');
  } else if (neg.error) {
    fail('negative control errored instead of evaluating', neg.error);
  } else if (neg.looksLikePdf === false) {
    pass('HTML masquerading as a PDF is rejected', `magic=${JSON.stringify(neg.magic)}`);
  } else {
    fail('HTML served as application/pdf was accepted as a PDF');
  }

  await browser.close();
  server.close();

  console.log('');
  if (failures) {
    console.log(`${failures} CHECK(S) FAILED`);
    process.exit(1);
  }
  console.log('ALL NEW-TAB CAPTURE CHECKS PASSED');
}

main().catch((err) => { console.error(err); process.exit(1); });
