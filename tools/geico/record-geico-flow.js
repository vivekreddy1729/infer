#!/usr/bin/env node
/**
 * Record a real GEICO session while a human drives it.
 *
 * ISOLATION: self-contained. Never imports from progressive.js or the
 * Progressive-era tools/record-flow.js. See src/carriers/geico/selectors.js.
 *
 * ------------------------------------------------------------------------
 * WHAT THIS IS FOR
 * ------------------------------------------------------------------------
 * Two things in the GEICO adapter are currently unverified, and both need one
 * real login to settle:
 *
 *   1. **The 2-Step Verification screens.** `selectors.js` MFA entries are
 *      candidate lists written from GEICO's public FAQ, not from the DOM. The
 *      delivery-method chooser in particular is known to exist (F-33) but its
 *      markup has never been seen.
 *
 *   2. **The entire document flow.** `fetchDocuments()` deliberately throws
 *      rather than guess. F-28 is the reason: a guess that ranked by title text
 *      and recency returned a declarations page from a *lapsed* policy and
 *      reported success. On an insurance document, confidently wrong is worse
 *      than honestly broken.
 *
 * ------------------------------------------------------------------------
 * WHAT IT DOES NOT CAPTURE, AND WHY
 * ------------------------------------------------------------------------
 * **No HAR file. Ever.** A HAR from a real login contains the password in
 * plaintext in the POST body, every session cookie, and every bearer token. It
 * is the single most dangerous artefact this project could produce, and asking a
 * user for one would be asking them to email their credentials.
 *
 * So this records, deliberately narrowly:
 *   - URLs and status codes
 *   - RESPONSE bodies for JSON only, with credential-shaped keys redacted
 *   - DOM structure: selectors, labels, aria attributes
 *   - which request headers were PRESENT, by name only, never their values
 *
 * It never records: request bodies, cookie values, Authorization values, or
 * anything typed into a field.
 *
 * ------------------------------------------------------------------------
 * F-14: THIS TOOL MUST NOT CLOSE THE BROWSER THE USER IS USING
 * ------------------------------------------------------------------------
 * An earlier inspection tool in this project closed the browser mid-inspection,
 * which destroyed the thing being inspected and looked like a carrier failure.
 * This one holds the browser open until you press Enter, and every capture is
 * appended to disk as it happens — so if anything does die, whatever was recorded
 * up to that point survives.
 *
 * ------------------------------------------------------------------------
 * USAGE
 * ------------------------------------------------------------------------
 *   node tools/geico/record-geico-flow.js
 *
 * Then, in the browser window that opens:
 *   1. Sign in normally with your own credentials.
 *   2. Complete 2-Step Verification.
 *   3. Navigate to the policy documents section.
 *   4. Apply whatever filter selects the policy document you actually want.
 *   5. Click through to the document so the download/view request fires.
 *   6. Come back to this terminal and press Enter.
 *
 * Type nothing into this terminal. Your credentials go into the browser only.
 */

import { chromium } from 'patchright';
import { mkdir, writeFile, appendFile } from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { launchOptions, contextOptions } from '../../src/browser/stealth.js';
import { LOGIN_URL } from '../../src/carriers/geico/selectors.js';

const OUT_DIR = 'artifacts/recordings/geico';
const EVENTS_FILE = path.join(OUT_DIR, 'events.jsonl');

/**
 * Keys whose values are never written, at any nesting depth.
 *
 * F-09 is the cautionary entry here: the redaction code was itself the leak. So
 * this errs toward over-redaction, and `audit-secrets.js` is run against the
 * output afterwards rather than trusted to be unnecessary.
 */
const REDACT_KEYS = /pass(word|code)?|secret|token|auth|cookie|session|ssn|dob|credential|bearer|otp|pin|cvv/i;

/** Values that look like secrets regardless of their key. */
const REDACT_VALUE = [
  /^eyJ[A-Za-z0-9_-]{10,}/,           // JWT
  /^Bearer\s+\S{12,}/i,
  /^[A-Za-z0-9+/]{120,}={0,2}$/,      // long base64 blob
];

/**
 * Query-string parameters whose values are credential-equivalent.
 *
 * This exists because the first version of this recorder wrote a live 48-character
 * GEICO session token to disk in `?token=…`, and `npm run audit:secrets` passed
 * on the file. Every rule in that audit examined JSON field names, header values,
 * or token *formats* — none looked at URLs, so a credential in a query string was
 * invisible to all of them. Both sides are now fixed; this is the write side.
 *
 * GEICO's own session-replay masking rewrites the same parameter as `token=*****`,
 * which is the carrier stating plainly that it is sensitive.
 *
 * URL-borne tokens are worse than they look: they reach server access logs,
 * `Referer` headers sent to third parties, and browser history — places a cookie
 * never goes.
 */
const URL_SECRET_PARAMS = /^(token|convtoken|sid|ssotoken|authtoken|sessionid|jwt|access_token|id_token|code)$/i;

function scrubUrl(raw) {
  if (typeof raw !== 'string') return raw;
  try {
    const u = new URL(raw);
    let changed = false;
    for (const [k, v] of [...u.searchParams.entries()]) {
      if (v && URL_SECRET_PARAMS.test(k)) {
        u.searchParams.set(k, `[REDACTED ${v.length} chars]`);
        changed = true;
      }
    }
    return changed ? u.toString() : raw;
  } catch {
    // Not a parseable URL. Fall back to a textual substitution rather than
    // returning it untouched — failing open on a secret is not acceptable.
    return raw.replace(
      /([?&](?:token|convToken|sid|ssoToken|authToken|sessionId|jwt)=)([^&\s"]{8,})/gi,
      (_m, p, v) => `${p}[REDACTED ${v.length} chars]`
    );
  }
}

function scrub(value, depth = 0) {
  if (depth > 12) return '[depth-capped]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    if (REDACT_VALUE.some((re) => re.test(value))) return `[REDACTED ${value.length} chars]`;
    /**
     * A URL nested inside a JSON body gets the same treatment as a top-level one.
     *
     * This is where the second leak came from. `scrubUrl` was being applied to the
     * event's own `url` field, but GEICO's payloads carry URLs *inside* them —
     * `_goto.externalUrl` is a redirect target complete with `?token=…`. Neither
     * the key-name check nor the value-format check catches that: the key is
     * `externalUrl`, and a 44-character base64 token is well under the
     * long-blob threshold.
     *
     * Found by `npm run audit:secrets` on the second recording, after the first
     * fix. Handling it here rather than adding another special case means any
     * URL-shaped string is covered wherever it appears, at any depth.
     */
    if (/^https?:\/\//i.test(value) || /[?&][a-z_]+=/i.test(value)) return scrubUrl(value);
    // A base64 PDF is not a secret but it is enormous; keep the shape only.
    if (value.length > 400) return `[long string, ${value.length} chars, starts "${value.slice(0, 12)}"]`;
    return value;
  }
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.slice(0, 40).map((v) => scrub(v, depth + 1));

  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = REDACT_KEYS.test(k) ? '[REDACTED]' : scrub(v, depth + 1);
  }
  return out;
}

async function record(event) {
  await appendFile(EVENTS_FILE, `${JSON.stringify({ at: Date.now(), ...event })}\n`);
}

/**
 * Snapshot the structure of whatever page is currently open.
 *
 * Built to answer the F-29 question: **does GEICO expose its own taxonomy?** A
 * category, document-type or policy-status field is the carrier telling you which
 * document is which. Title text and list position are not — they are localisable
 * copy and render order.
 */
const STRUCTURE = `(() => {
  const clean = (s) => (s || '').replace(/\\s+/g, ' ').trim();
  const vis = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);

  return {
    url: location.href,
    title: document.title,
    isFlutter: !!document.querySelector('flt-glass-pane, flutter-view'),
    headings: [...document.querySelectorAll('h1,h2,h3,h4,[role=heading]')]
      .filter(vis).map(h => clean(h.textContent)).filter(Boolean).slice(0, 40),

    // Flutter renders controls as semantics nodes; capture both kinds.
    buttons: [...document.querySelectorAll('button,[role=button],flt-semantics[role=button],a[href]')]
      .filter(vis)
      .map(el => ({
        tag: el.tagName.toLowerCase(),
        label: clean(el.getAttribute('aria-label') || el.textContent).slice(0, 90),
        href: el.getAttribute('href') || null,
        // Recorded so the instability is visible in the artefact, NOT for use.
        unstableId: el.id || null,
        ariaDisabled: el.getAttribute('aria-disabled'),
      }))
      .filter(b => b.label).slice(0, 60),

    // Filter/dropdown controls -- the "Policy Contracts" equivalent.
    selects: [...document.querySelectorAll('select')].map(s => ({
      id: s.id || null, name: s.getAttribute('name'),
      ariaLabel: s.getAttribute('aria-label'),
      options: [...s.options].map(o => ({ value: o.value, text: clean(o.text) })).slice(0, 40),
    })),
    listboxes: [...document.querySelectorAll('[role=listbox],[role=combobox],[role=menu]')]
      .filter(vis)
      .map(l => ({
        role: l.getAttribute('role'),
        ariaLabel: l.getAttribute('aria-label'),
        options: [...l.querySelectorAll('[role=option],[role=menuitem]')]
          .map(o => clean(o.textContent)).filter(Boolean).slice(0, 40),
      })).slice(0, 10),

    inputs: [...document.querySelectorAll('input,textarea')].map(el => ({
      type: el.getAttribute('type'), id: el.id || null, name: el.getAttribute('name'),
      autocomplete: el.getAttribute('autocomplete'), inputmode: el.getAttribute('inputmode'),
      ariaLabel: el.getAttribute('aria-label'),
      semanticsRole: el.getAttribute('data-semantics-role'),
      visible: vis(el),
      // Never the value.
    })),

    // Anything that looks like a document row, for the taxonomy question.
    tables: [...document.querySelectorAll('table')].slice(0, 4).map(t => ({
      headers: [...t.querySelectorAll('th')].map(h => clean(h.textContent)).slice(0, 15),
      firstRows: [...t.querySelectorAll('tbody tr')].slice(0, 6)
        .map(r => [...r.querySelectorAll('td')].map(c => clean(c.textContent).slice(0, 60))),
    })),
    // Non-table list rows, which Flutter is more likely to produce.
    rowish: [...document.querySelectorAll('[role=row],[role=listitem],li')]
      .filter(vis).map(r => clean(r.textContent).slice(0, 140))
      .filter(t => t.length > 8).slice(0, 30),
  };
})()`;

async function main() {
  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(EVENTS_FILE, '');

  const base = launchOptions({ headless: false });
  let browser;
  for (const ch of ['chrome', 'chromium', undefined]) {
    try {
      browser = await chromium.launch({ ...base, channel: ch });
      console.log(`browser channel: ${ch ?? 'bundled-chromium'}`);
      if (ch !== 'chrome') {
        console.log('NOTE: not real Chrome. Fine for structure capture; anti-bot behaviour is not representative.');
      }
      break;
    } catch { /* next */ }
  }
  if (!browser) throw new Error('no browser channel available');

  const context = await browser.newContext({ ...contextOptions(), acceptDownloads: true });

  const apiSeen = [];
  const pages = [];
  const documentHits = [];
  let snapCount = 0;

  /**
   * Snapshot the structure of one page.
   *
   * Takes the page as an argument rather than closing over a single one, because
   * the document we are after opens in a SECOND TAB and the first version of this
   * recorder could not see it at all.
   */
  const snapshot = async (pg, reason, tab) => {
    try {
      const s = await pg.evaluate(STRUCTURE);
      snapCount += 1;
      s.url = scrubUrl(s.url);
      if (Array.isArray(s.buttons)) for (const b of s.buttons) if (b.href) b.href = scrubUrl(b.href);
      await record({ kind: 'structure', reason, tab, snapshot: s });
      return s;
    } catch {
      // A PDF rendered by Chrome's internal viewer has no useful DOM and
      // `evaluate` may reject outright. Not an error worth reporting: the
      // *response* capture is what matters for a PDF, not its DOM.
      return null;
    }
  };

  /**
   * Attach every listener to a page.
   *
   * ------------------------------------------------------------------------
   * WHY THIS IS A FUNCTION AND NOT INLINE
   * ------------------------------------------------------------------------
   * The first version of this recorder bound `page.on('response')` and
   * `page.on('framenavigated')` to the single page it created. GEICO's
   * "View Declaration Page" opens the PDF in a NEW TAB, which in Playwright is a
   * separate `Page` object on the context — so every request that actually
   * delivered the document was invisible.
   *
   * Worse than missing data: the recording then contained a `submit-policy-document`
   * call returning `_payload: true` and no PDF anywhere, and the conclusion drawn
   * was "the user emailed it to themselves". That was wrong. The PDF had been
   * fetched in a tab nobody was watching, and a *mechanism* was inferred from an
   * *absence* — the precise error F-32 records for the "closed shadow root"
   * verdict, repeated by the tool built to avoid it.
   *
   * So: listeners are attached per page, and `context.on('page')` ensures every
   * tab gets them, including ones the user opens by clicking a link.
   */
  const attachToPage = (pg, tab) => {
    pages.push(pg);

    pg.on('framenavigated', async (frame) => {
      if (frame !== pg.mainFrame()) return;
      await record({ kind: 'navigation', tab, url: scrubUrl(frame.url()) });
      console.log(`  [tab ${tab}] → ${scrubUrl(frame.url()).slice(0, 120)}`);
      setTimeout(() => snapshot(pg, 'navigation', tab), 2500);
    });

    pg.on('response', async (res) => {
      const url = res.url();
      if (/\.(png|jpe?g|gif|svg|woff2?|ttf|css|ico)(\?|$)/i.test(url)) return;

      const ct = (res.headers()['content-type'] || '').split(';')[0];

      /**
       * Binary document types are captured on content-type ALONE, with no URL
       * filter.
       *
       * The original filter required JSON or a keyword in the URL, which would
       * have dropped a PDF served from a path like `/ws/render/9f3c2a` — the
       * second reason the document was missed. The thing we most want to find is
       * exactly the thing least likely to advertise itself in its URL.
       */
      const isDocument = /pdf|octet-stream|msword|officedocument|image\/tiff/i.test(ct);
      const interesting = isDocument
        || /json/i.test(ct)
        || /\/api\/|\/ws\/|document|policy|declarat|contract|verif|otp|mfa|2sv|auth|render|view|download|preview/i.test(url);
      if (!interesting) return;

      const entry = {
        kind: 'response',
        tab,
        status: res.status(),
        method: res.request().method(),
        url: scrubUrl(url).slice(0, 300),
        contentType: ct,
        /**
         * Header NAMES only, never values.
         *
         * This is the F-11 lesson made safe. Progressive's API needed all 23
         * headers including a vendor-specific `x-prgaccountsessionid`, and an
         * allowlist could never have guessed it. Knowing which headers a request
         * carried is what makes that solvable; knowing their values would make
         * this file a credential store.
         */
        requestHeaderNames: Object.keys(res.request().headers()).sort(),
      };

      if (isDocument) {
        /**
         * Record that a document arrived, its size and its magic bytes -- never
         * its contents. Someone's declarations page holds their name, address,
         * VIN and premium. The magic bytes are what prove it is a real PDF rather
         * than an HTML error page served with the wrong content-type, which is
         * the F-13 lesson.
         */
        try {
          const buf = await res.body();
          entry.documentBytes = buf.length;
          entry.magic = buf.subarray(0, 5).toString('latin1');
          entry.looksLikePdf = entry.magic.startsWith('%PDF-');
        } catch {
          entry.note = 'document body unavailable (streamed)';
        }
        documentHits.push({ url: entry.url, ct, bytes: entry.documentBytes, pdf: entry.looksLikePdf, tab });
        console.log(`  ★★ [tab ${tab}] DOCUMENT ${entry.status} ${ct} ${entry.documentBytes ?? '?'} bytes `
          + `${entry.looksLikePdf ? '(valid PDF)' : ''}`);
        console.log(`       ${entry.url.slice(0, 150)}`);
      } else if (/json/i.test(ct)) {
        try {
          const text = await res.text();
          entry.bodyBytes = text.length;
          if (text.length < 200_000) entry.body = scrub(JSON.parse(text));
          else entry.note = 'body too large, shape not captured';
        } catch {
          entry.note = 'body unavailable (streamed or already consumed)';
        }
      }

      apiSeen.push({ status: entry.status, method: entry.method, url: entry.url, tab, isDocument });
      await record(entry);

      if (!isDocument && /document|declarat|contract|policy/i.test(url) && res.status() < 400) {
        console.log(`  ★ [tab ${tab}] ${entry.status} ${entry.method} ${scrubUrl(url).slice(0, 110)}`);
      }
    });

    /**
     * A PDF may open in a viewer tab OR trigger a download, depending on
     * Content-Disposition. Both paths have to be recorded or the same gap
     * reappears in a different shape.
     */
    pg.on('download', async (dl) => {
      const info = {
        kind: 'download',
        tab,
        suggestedFilename: dl.suggestedFilename(),
        url: scrubUrl(dl.url()).slice(0, 300),
      };
      await record(info);
      documentHits.push({ url: info.url, download: true, filename: info.suggestedFilename, tab });
      console.log(`  ★★ [tab ${tab}] DOWNLOAD ${info.suggestedFilename}`);
      // Do not save it -- it is someone's real policy document.
      await dl.cancel().catch(() => {});
    });

    pg.on('close', () => record({ kind: 'tabClosed', tab }).catch(() => {}));
  };

  /**
   * Identify and verify a document opened in a viewer tab.
   *
   * ------------------------------------------------------------------------
   * WHY THE OBVIOUS APPROACH DOES NOT WORK
   * ------------------------------------------------------------------------
   * Attaching `response` listeners to the new tab is necessary but NOT
   * sufficient, and this cost a round of debugging worth recording.
   *
   * When Chrome navigates to a PDF it hands the bytes to its internal plugin
   * viewer, and that response is never surfaced as a Playwright `response` event
   * on the page. Reproduced against a local fixture: the popup's URL was
   * correctly `…/fake.pdf`, yet the only responses observed on that tab were
   * Chrome's own PDF-viewer assets — two JavaScript bundles of 288KB and 344KB.
   * The `application/pdf` response itself does not appear at all.
   *
   * So "no PDF response was captured" means nothing about whether a PDF arrived.
   * That is the same trap as the first version of this recorder, one level
   * deeper: an absence of evidence being read as evidence of absence.
   *
   * What works, and what the ADAPTER will also have to do: take the tab's URL and
   * re-request it through `context.request`, which shares the context's cookies
   * and returns the bytes directly. A GET for a document is idempotent, so
   * re-requesting costs nothing and yields the proof the viewer tab hides.
   */
  const verifyDocumentTab = async (pg, tab) => {
    const url = pg.url();
    if (!url || url === 'about:blank') return;

    // Is this a document tab? Either the URL says so, or the DOM is a PDF embed.
    const looksLikeDocUrl = /\.pdf(\?|$)|pdf|document|declarat|contract|render|view|preview|download/i.test(url);
    const hasPdfEmbed = await pg
      .evaluate(`!!document.querySelector('embed[type="application/pdf"], object[type="application/pdf"]')`)
      .catch(() => false);

    if (!looksLikeDocUrl && !hasPdfEmbed) return;

    try {
      const res = await context.request.get(url, { timeout: 30_000 });
      const ct = (res.headers()['content-type'] || '').split(';')[0];
      const buf = await res.body();
      const magic = buf.subarray(0, 5).toString('latin1');
      const hit = {
        kind: 'documentVerified',
        tab,
        url: scrubUrl(url).slice(0, 300),
        status: res.status(),
        contentType: ct,
        bytes: buf.length,
        magic,
        looksLikePdf: magic.startsWith('%PDF-'),
        // Bytes are never written. A declarations page holds a name, address,
        // VIN and premium. Size and magic bytes prove it is a real PDF rather
        // than an HTML error page served with the wrong content-type (F-13),
        // which is all the adapter needs to know.
        viaContextRequest: true,
      };
      await record(hit);
      documentHits.push(hit);
      console.log(`\n  ★★ DOCUMENT VERIFIED on tab ${tab}`);
      console.log(`       ${ct}  ${buf.length} bytes  magic=${JSON.stringify(magic)}`
        + `${hit.looksLikePdf ? '  -> VALID PDF' : '  -> NOT a PDF'}`);
      console.log(`       ${hit.url.slice(0, 150)}`);
    } catch (err) {
      await record({ kind: 'documentVerifyFailed', tab, url: scrubUrl(url).slice(0, 300), error: err.message.split('\n')[0] });
      console.log(`  !! could not re-fetch tab ${tab} document: ${err.message.split('\n')[0]}`);
    }
  };

  /**
   * Catch every tab, including ones opened by a click.
   *
   * The missing piece in the first version. GEICO's "View Declaration Page" opens
   * the PDF in a new tab, which is a separate `Page` object, so none of its
   * activity was observed.
   */
  context.on('page', async (pg) => {
    // Guard against double-attach: `newPage()` also fires this event, and a
    // duplicated listener would record every response twice. Verified by
    // observing the initial page attached as both tab 0 and tab 1 before this.
    if (pages.includes(pg)) return;

    const tab = pages.length;
    console.log(`\n  ++ NEW TAB (tab ${tab}) -- recording it`);
    attachToPage(pg, tab);

    // Give the navigation time to settle, then snapshot and verify.
    await pg.waitForLoadState('domcontentloaded').catch(() => {});
    await new Promise((r) => setTimeout(r, 1500));
    await snapshot(pg, 'new-tab', tab);
    await verifyDocumentTab(pg, tab);
  });

  const page = await context.newPage();
  if (!pages.includes(page)) attachToPage(page, 0);

  // Periodic snapshots of EVERY open tab, because a Flutter SPA changes screens
  // without navigating and the 2SV chooser may never correspond to a URL change.
  const ticker = setInterval(() => {
    for (let i = 0; i < pages.length; i++) {
      if (!pages[i].isClosed()) snapshot(pages[i], 'periodic', i);
    }
  }, 4000);

  console.log(`\nOpening ${LOGIN_URL}`);
  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 });

  console.log(`
==========================================================================
  Drive the flow in the BROWSER WINDOW. Do not type anything here.

    1. Sign in with your own GEICO credentials
    2. Complete 2-Step Verification (note which method you pick)
    3. Go to the policy documents section
    4. Click "View Declaration Page" -- the one that OPENS the document.
       NOT "Submit" on the declaration-page-send screen: that emails it and
       returns no document at all.
    5. Let the PDF finish rendering. It opens in a NEW TAB; that is expected and
       this recorder now follows it.
    6. Come back here and press Enter

  Recording to ${EVENTS_FILE}
  Every tab is recorded, and captures are appended as they happen so nothing is
  lost if something goes wrong.

  NOT captured: request bodies, cookie values, tokens, URL tokens, anything you
  type, or the contents of any document. For a PDF only its size and magic bytes
  are recorded -- enough to prove it is a real PDF, not enough to read it.
  Header NAMES are recorded; header VALUES are not.
==========================================================================
`);

  await new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question('Press Enter once the declaration page PDF is open… ', () => {
      rl.close();
      resolve();
    });
  });

  clearInterval(ticker);

  /**
   * Final pass over EVERY open tab.
   *
   * Verification is re-run here, not only on tab open, because the user may have
   * navigated within the document tab after it appeared — and because on tab-open
   * the PDF may not have finished loading. Cheap, and it is the last chance to
   * capture the thing the whole recording exists for.
   */
  const finals = [];
  for (let i = 0; i < pages.length; i++) {
    if (pages[i].isClosed()) continue;
    finals.push({ tab: i, url: scrubUrl(pages[i].url()), structure: await snapshot(pages[i], 'final', i) });
    await verifyDocumentTab(pages[i], i);
    await pages[i]
      .screenshot({ path: path.join(OUT_DIR, `final-tab-${i}.png`), fullPage: true })
      .catch(() => {});
  }

  const summary = {
    recordedAt: new Date().toISOString(),
    tabsObserved: pages.length,
    tabs: finals.map((f) => ({ tab: f.tab, url: f.url })),
    structureSnapshots: snapCount,
    apiResponses: apiSeen.length,
    /**
     * The headline result. A real document arriving is the only thing that makes
     * this recording useful, so it is reported first and unambiguously — the
     * previous recording's `documentCandidates` list was 60 entries of Quantum
     * Metric telemetry that merely had "document" in the URL, which buried the
     * fact that no document had been captured at all.
     */
    documentsCaptured: documentHits,
    geicoApiCalls: apiSeen.filter(
      (a) => /geico\.com\/ws\//.test(a.url) && !/quantummetric|qualtrics/i.test(a.url)
    ),
    cookieNames: [...new Set((await context.cookies()).map((c) => c.name))],
  };
  await writeFile(path.join(OUT_DIR, 'summary.json'), JSON.stringify(summary, null, 2));

  console.log('\n--- summary -------------------------------------------------');
  console.log(`  tabs observed        ${summary.tabsObserved}`);
  for (const t of summary.tabs) console.log(`     tab ${t.tab}  ${t.url.slice(0, 110)}`);
  console.log(`  structure snapshots  ${summary.structureSnapshots}`);
  console.log(`  GEICO /ws/ calls     ${summary.geicoApiCalls.length}`);
  console.log('');
  if (documentHits.length) {
    console.log(`  DOCUMENTS CAPTURED   ${documentHits.length}`);
    for (const d of documentHits) {
      console.log(`     tab ${d.tab}  ${d.bytes ?? d.filename ?? '?'}  ${d.pdf ? 'valid PDF' : d.download ? 'download' : d.ct ?? ''}`);
      console.log(`       ${String(d.url).slice(0, 140)}`);
    }
  } else {
    console.log('  DOCUMENTS CAPTURED   0');
    console.log('     No PDF or download was observed on any tab.');
    console.log('     If you did open the declaration page, say so — that means this');
    console.log('     recorder still has a gap, not that GEICO did not serve it.');
  }
  console.log('-------------------------------------------------------------');
  console.log(`\nwrote ${EVENTS_FILE}`);
  console.log(`      ${path.join(OUT_DIR, 'summary.json')}`);
  console.log('\nNow run:  npm run audit:secrets');
  console.log('The redaction here is deliberately aggressive, but F-09 was a leak in the');
  console.log('redaction code itself — so verify rather than trust it.');

  // Only now, after everything is written. F-14.
  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
