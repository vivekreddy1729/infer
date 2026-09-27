/**
 * Captures the full structure of Progressive's documents API, and then actually
 * tries to download a declarations PDF.
 *
 * Why this exists separately from the recorder: the recorder's redaction
 * summariser truncates nested objects at depth 4 so it cannot accidentally spill
 * a payload full of PII. That is the right default, but it also discarded the one
 * thing needed to finish the adapter — the `_links` object on each document,
 * which carries the download URL.
 *
 * This tool reads the same payload with full depth, then prints it with URLs
 * reduced to path *templates* (policy numbers and ids replaced by placeholders)
 * so the structure is legible without exposing account identifiers.
 *
 * It reuses the browser profile the recorder created, so if that session is still
 * valid — or the device is trusted from ticking "remember this device" — no new
 * login and no new SMS is required.
 *
 *   node tools/inspect-documents.js
 *   node tools/inspect-documents.js --download   # also try fetching the PDF
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';

process.env.HEADLESS = 'false';
process.env.BLOCK_RESOURCES = 'false';

const { default: config } = await import('../src/config.js');
const { default: browserPool } = await import('../src/browser/browserPool.js');
const { buildProxyConfig, newStickySessionId } = await import('../src/browser/proxy.js');

const tryDownload = process.argv.includes('--download');
const DOCUMENTS_URL = 'https://policyservicing.apps.progressive.com/app/documents-hub/find-document';
const OUT = path.resolve('artifacts/recordings/progressive');

/** Replace account identifiers with placeholders, keeping the URL shape. */
function templatise(url) {
  return String(url)
    .replace(/\b\d{9,}\b/g, '{policyNumber}')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '{uuid}')
    .replace(/([?&](?:token|access_token|sig|signature)=)[^&]+/gi, '$1{redacted}');
}

/** Keep structure and link shapes; drop anything that identifies a person. */
function safeView(value, depth = 0) {
  if (depth > 8) return '<deep>';
  if (Array.isArray(value)) return value.map((v) => safeView(v, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (/name|address|street|city|zip|phone|email|dob|birth|vin|licen[cs]e|ssn/i.test(k)) {
        out[k] = `<redacted:${typeof v}>`;
      } else if (typeof v === 'string') {
        out[k] = templatise(v).slice(0, 220);
      } else {
        out[k] = safeView(v, depth + 1);
      }
    }
    return out;
  }
  return typeof value === 'string' ? templatise(value).slice(0, 220) : value;
}

const proxy = config.RESIDENTIAL_PROXY_URL ? buildProxyConfig(newStickySessionId()) : null;

// Same profileKey the recorder used, so the same on-disk profile is reused.
const lease = await browserPool.acquirePersistentContext({
  profileKey: 'recorder:progressive',
  proxy,
  blockStylesheets: false,
});
const page = lease.context.pages()[0] ?? (await lease.context.newPage());

let payload = null;
let apiHeaders = null;
const pdfSeen = [];

// Harvest the bearer token and friends from the SPA's own calls. api.progressive.com
// is bearer-guarded, not cookie-guarded, so replaying a URL without these yields
// 401 "Authentication denied."
// Carry everything minus a denylist. An allowlist missed `x-prgaccountsessionid`,
// which the API requires alongside the bearer token, and there is a whole family
// of `x-pgr*` / `x-prg*` headers in the same protocol. Copying what the real
// client sent beats guessing which ones matter.
const DENY = new Set([
  'cookie',
  'content-length',
  'host',
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'proxy-authorization',
  'proxy-connection',
  'accept-encoding',
]);

page.on('request', (request) => {
  const url = request.url();
  if (!url.includes('api.progressive.com/policypro')) return;
  const h = request.headers();
  if (!h.authorization) return;
  const carried = {};
  for (const [k, v] of Object.entries(h)) {
    const lower = k.toLowerCase();
    if (DENY.has(lower) || lower.startsWith(':')) continue;
    carried[lower] = v;
  }
  if (!apiHeaders) console.log(`  captured ${Object.keys(carried).length} API headers`);
  apiHeaders = carried;
});

page.on('response', async (response) => {
  const url = response.url();
  if (url.includes('/policypro/v1/account/documents')) {
    try {
      payload = await response.json();
      console.log('  captured documents payload');
    } catch {
      /* ignore */
    }
  }
  const ct = (response.headers()['content-type'] ?? '').toLowerCase();
  if (ct.includes('pdf') || /\.pdf(\?|$)/i.test(url)) {
    let bytes = null;
    try {
      bytes = (await response.body()).length;
    } catch {
      /* ignore */
    }
    pdfSeen.push({ url: templatise(url), method: response.request().method(), status: response.status(), bytes });
    console.log(`  *** PDF: ${response.request().method()} ${response.status()} ${bytes ?? '?'}B  ${templatise(url).slice(0, 120)}`);
  }
});

// Declared here rather than further down because the resume probe below writes
// into it from a timer callback; a `const` declared later would be in its
// temporal dead zone and throw on the first tick.
const report = { capturedAt: new Date().toISOString(), accounts: [] };

console.log(`
Reusing the recorder's Progressive profile.
A browser window will open at your documents page.

Three things can happen:
  - it lands on the documents list            -> nothing to do, just wait
  - it shows a "Log back in" resume screen    -> click it, no credentials needed
  - it asks for your user ID and password     -> sign in there and it continues
`);

await page.goto(DOCUMENTS_URL, { waitUntil: 'domcontentloaded' }).catch((e) => {
  console.log(`  navigation warning: ${e.message.split('\n')[0]}`);
});

/**
 * Capture the resume interstitial if it shows up.
 *
 * When the app session has lapsed but Progressive's SSO session has not, it
 * serves a "Log back in" screen instead of a credentials form. That is a
 * distinct and much cheaper warm path, so the exact button text and route are
 * worth recording rather than guessing at.
 */
const resumeProbe = setInterval(async () => {
  try {
    const found = await page.evaluate(() => {
      const deep = (sel) => {
        const out = [];
        const walk = (r) => {
          out.push(...r.querySelectorAll(sel));
          for (const n of r.querySelectorAll('*')) if (n.shadowRoot) walk(n.shadowRoot);
        };
        walk(document);
        return out;
      };
      const rx = /log ?back ?in|log in again|resume|welcome back/i;
      const hits = deep('button, a, [role=button]')
        .filter((n) => rx.test(n.innerText || n.getAttribute('aria-label') || ''))
        .map((n) => ({
          tag: n.tagName.toLowerCase(),
          text: (n.innerText || '').trim().slice(0, 60),
          ariaLabel: n.getAttribute('aria-label') || undefined,
          id: n.id || undefined,
          href: n.getAttribute('href') || undefined,
        }));
      const pw = deep('input[type="password"]').length;
      return hits.length ? { url: location.href, hits, passwordFieldsVisible: pw } : null;
    });
    if (found && !report.resumeInterstitial) {
      report.resumeInterstitial = {
        url: templatise(found.url),
        candidates: found.hits,
        passwordFieldsPresent: found.passwordFieldsVisible,
      };
      console.log(`\n  *** RESUME INTERSTITIAL DETECTED ***`);
      console.log(`      url: ${templatise(found.url).slice(0, 110)}`);
      for (const h of found.hits) {
        console.log(`      ${h.tag} "${h.text}"${h.id ? ` id=${h.id}` : ''}${h.href ? ` href=${h.href.slice(0, 50)}` : ''}`);
      }
      console.log(`      password fields present: ${found.passwordFieldsVisible}`);
      console.log(`      -> click it in the browser; no credentials should be required\n`);
      await page.screenshot({ path: path.join(OUT, 'resume-interstitial.png') }).catch(() => {});
    }
  } catch {
    /* navigation in flight */
  }
}, 1200);

// Generous window so a manual re-login (or a resume click) can happen.
const deadline = Date.now() + 120_000;
while (!payload && Date.now() < deadline) {
  await page.waitForTimeout(500);
}
clearInterval(resumeProbe);

if (!payload) {
  console.log('\nNo documents payload captured within 2 minutes.');
  console.log('The session has probably expired. Re-run `npm run record progressive` instead.');
  await lease.release().catch(() => {});
  await browserPool.shutdown().catch(() => {});
  process.exit(1);
}

await fs.mkdir(OUT, { recursive: true });

// ---------------------------------------------------------------------------
// Structure report
// ---------------------------------------------------------------------------

for (const account of payload.accountDocuments ?? []) {
  const docs = account.documents ?? [];
  const decs = docs.filter((d) => /declaration|dec\s*page|policy\s*contract/i.test(`${d.title ?? ''} ${d.type ?? ''}`));
  const ids = docs.filter((d) => /id\s*card|insurance\s*id/i.test(`${d.title ?? ''} ${d.type ?? ''}`));

  console.log(`\n${'='.repeat(72)}`);
  console.log(`POLICY (masked)  documents=${docs.length}  declarations=${decs.length}  idCards=${ids.length}`);
  console.log(`  isEligibleForDecPreview: ${account.isEligibleForDecPreview}`);

  console.log('\n  --- account.actions (how documents are fetched) ---');
  for (const a of account.actions ?? []) {
    console.log(`    ${String(a.actionType).padEnd(16)} ${String(a.httpMethod).padEnd(6)} ${templatise(a.serviceEndpointUrl ?? '')}`);
  }

  console.log('\n  --- filterCategories ---');
  for (const f of account.filterCategories ?? []) console.log(`    ${f.key} = ${f.description}`);

  const sample = decs[0] ?? docs[0];
  if (sample) {
    console.log('\n  --- sample document, FULL structure ---');
    console.log(
      JSON.stringify(safeView(sample), null, 4)
        .split('\n')
        .map((l) => `    ${l}`)
        .join('\n')
    );
  }

  console.log('\n  --- declarations titles ---');
  for (const d of decs.slice(0, 6)) {
    console.log(`    type=${String(d.type).padEnd(12)} idx=${String(d.index).padEnd(4)} ${d.archiveDate}  ${d.title}`);
  }

  report.accounts.push({
    documentCount: docs.length,
    isEligibleForDecPreview: account.isEligibleForDecPreview,
    actions: safeView(account.actions ?? []),
    filterCategories: account.filterCategories ?? [],
    declarations: safeView(decs.slice(0, 6)),
    idCards: safeView(ids.slice(0, 3)),
    sampleDocumentFull: safeView(sample ?? null),
    termsShape: safeView((account.terms ?? []).slice(0, 2)),
  });
}

// ---------------------------------------------------------------------------
// Download attempt
// ---------------------------------------------------------------------------

if (tryDownload) {
  console.log(`\n${'='.repeat(72)}\nATTEMPTING DOWNLOAD via context.request\n`);
  const account = (payload.accountDocuments ?? [])[0];
  const doc = (account?.documents ?? []).find((d) =>
    /declaration|dec\s*page|policy\s*contract/i.test(`${d.title ?? ''} ${d.type ?? ''}`)
  );

  const absolute = (href) =>
    /^https?:\/\//i.test(href)
      ? href
      : `https://api.progressive.com/policypro/${String(href).replace(/^\/+/, '')}`;

  console.log(`  selected: type=${doc?.type} index=${doc?.index} title=${doc?.title}`);
  console.log(`  apiHeaders: ${apiHeaders ? Object.keys(apiHeaders).join(', ') : 'NONE CAPTURED'}\n`);

  const attempts = [];
  for (const [rel, v] of Object.entries(doc?._links ?? {})) {
    const href = typeof v === 'string' ? v : v?.href;
    if (href) attempts.push({ how: `link:${rel}`, method: 'GET', url: absolute(href) });
  }
  // policyInfoKey lives in the target href's query string; the POST needs it in
  // the body as well ("policyInfoKey missing").
  let policyInfoKey = null;
  try {
    const t = doc?._links?.target;
    policyInfoKey = new URL(absolute(typeof t === 'string' ? t : t?.href ?? '')).searchParams.get('policyInfoKey');
  } catch {
    /* ignore */
  }
  console.log(`  policyInfoKey: ${policyInfoKey ?? '(not found)'}`);

  const detail = (account?.actions ?? []).find((a) => /^detail$/i.test(a.actionType ?? ''));
  if (detail?.serviceEndpointUrl) {
    attempts.push({
      how: `action:${detail.actionType}`,
      method: (detail.httpMethod ?? 'POST').toUpperCase(),
      url: absolute(String(detail.serviceEndpointUrl).replace('{policyNumber}', account?.policyNumber ?? '')),
      body: {
        documentType: doc?.type,
        index: doc?.index,
        policyNumber: account?.policyNumber,
        ...(policyInfoKey ? { policyInfoKey } : {}),
      },
    });
  }

  // Run each strategy twice: once with the harvested bearer headers and once
  // without, so the report proves *why* the bare-cookie approach fails rather
  // than just that it does.
  const variants = apiHeaders
    ? [
        { tag: 'with-bearer', headers: apiHeaders },
        { tag: 'cookies-only', headers: undefined },
      ]
    : [{ tag: 'cookies-only', headers: undefined }];

  for (const a of attempts) {
    for (const v of variants) {
      try {
        const res = await lease.context.request.fetch(a.url, {
          method: a.method,
          headers: v.headers,
          ...(a.body ? { data: a.body } : {}),
          timeout: 30_000,
        });
        const raw = await res.body().catch(() => Buffer.alloc(0));

        /**
         * Open the JSON envelope before judging the bytes.
         *
         * Progressive returns 200 `application/json` shaped
         * `{"mimeType":"pdf","document":"JVBERi0x..."}`. Checking magic bytes on
         * the raw response sees `{"mim` and reports "not a PDF" for a completely
         * successful request.
         */
        let body = raw;
        let envelope = null;
        if ((res.headers()['content-type'] ?? '').includes('json')) {
          try {
            const parsed = JSON.parse(raw.toString('utf8'));
            const b64 =
              parsed.document ?? parsed.content ?? parsed.documentContent ?? parsed.data ?? parsed.pdf;
            if (typeof b64 === 'string' && b64.length > 100) {
              const decoded = Buffer.from(b64.replace(/^data:[^,]+,/, '').replace(/\s+/g, ''), 'base64');
              if (decoded.subarray(0, 5).toString('latin1') === '%PDF-') {
                body = decoded;
                envelope = { key: parsed.document ? 'document' : 'other', mimeType: parsed.mimeType };
              }
            }
          } catch {
            /* not an envelope */
          }
        }

        const magic = body.subarray(0, 5).toString('latin1');
        const isPdf = magic === '%PDF-';
        console.log(
          `  ${a.how.padEnd(16)} ${v.tag.padEnd(13)} ${a.method.padEnd(5)} ${res.status()}  ${(res.headers()['content-type'] ?? '').slice(0, 30).padEnd(30)} ${String(raw.length).padStart(8)}B  ${isPdf ? `<-- PDF ${(body.length / 1024).toFixed(0)}KB${envelope ? ` (base64 in "${envelope.key}")` : ''}` : magic.replace(/[^\x20-\x7e]/g, '.')}`
        );
        report.downloadAttempts = report.downloadAttempts ?? [];
        report.downloadAttempts.push({
          how: a.how,
          auth: v.tag,
          method: a.method,
          url: templatise(a.url),
          status: res.status(),
          contentType: res.headers()['content-type'],
          rawBytes: raw.length,
          pdfBytes: isPdf ? body.length : undefined,
          envelope,
          isPdf,
          bodyPreview: isPdf ? undefined : templatise(raw.subarray(0, 300).toString('utf8')),
        });

        // Save the first real PDF so the bytes can be eyeballed. artifacts/ is
        // gitignored; this is a real declarations page with real PII on it.
        if (isPdf && !report.savedPdf) {
          const out = path.join(OUT, 'declarations-sample.pdf');
          await fs.writeFile(out, body);
          report.savedPdf = { file: 'declarations-sample.pdf', bytes: body.length, via: a.how, auth: v.tag };
          console.log(`      saved ${path.relative(process.cwd(), out)} (${(body.length / 1024).toFixed(1)}KB)`);
        }
      } catch (err) {
        console.log(`  ${a.how.padEnd(16)} ${v.tag.padEnd(13)} ERROR ${err.message.split('\n')[0].slice(0, 70)}`);
      }
    }
  }
}

report.pdfResponsesObserved = pdfSeen;
await fs.writeFile(path.join(OUT, 'documents-structure.json'), JSON.stringify(report, null, 2));
console.log(`\nWrote artifacts/recordings/progressive/documents-structure.json`);

/**
 * Hold the browser open until told to quit.
 *
 * The original version exited as soon as the documents payload arrived, which
 * meant the browser vanished mid-click while the user was still navigating to a
 * document. An inspection tool that closes the thing being inspected is worse
 * than useless, because the disappearance looks like a portal or anti-bot
 * problem rather than a bug in the harness.
 *
 * PDF responses continue to be recorded while it waits, so anything clicked in
 * the browser from here on still gets captured.
 */
console.log(`
Browser is staying open. Click around freely — any PDF response is still recorded.
Press q<Enter> here when you are done.`);

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
await new Promise((resolve) => {
  rl.on('line', (line) => {
    if (line.trim().toLowerCase() === 'q') resolve();
  });
  rl.on('close', resolve);
  lease.context.on('close', resolve);
});
rl.close();

// Re-persist in case more PDFs were seen during the interactive window.
report.pdfResponsesObserved = pdfSeen;
await fs.writeFile(path.join(OUT, 'documents-structure.json'), JSON.stringify(report, null, 2));
if (pdfSeen.length) console.log(`  recorded ${pdfSeen.length} PDF response(s) during the interactive window`);

await lease.release().catch(() => {});
await browserPool.shutdown().catch(() => {});
process.exit(0);
