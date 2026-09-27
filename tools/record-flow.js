/**
 * Interactive flow recorder.
 *
 * Opens a real, headed browser at a carrier's login page and hands it to you.
 * You sign in yourself — typing your own password into the carrier's own page,
 * receiving your own MFA code on your own phone. Meanwhile this records the
 * information needed to write an adapter:
 *
 *   - every request and response: URL, method, status, content-type, timing
 *   - the *shape* of JSON payloads, so auth and challenge responses can be
 *     recognised programmatically
 *   - a DOM snapshot at each step of the flow, with suggested Playwright
 *     selectors and a warning on any id that looks machine-generated
 *   - which response actually delivered the PDF, and whether a plain
 *     cookie-authenticated GET was enough to fetch it
 *
 * WHY THIS INSTEAD OF A HAR FILE
 *
 * A HAR captured from a real login contains the password in plaintext in the
 * POST body, every session cookie, and any PII the pages rendered. It is a
 * credential dump. Sharing one to help someone write a scraper is a bad trade.
 *
 * This records the same structural information with redaction applied at
 * capture time, before anything reaches disk:
 *
 *   - request bodies are never stored, only their field names and value lengths
 *   - values under sensitive keys (password, token, ssn, otp, ...) are dropped
 *   - cookie and authorization headers are reduced to names
 *   - email addresses and long digit runs are masked wherever they appear
 *   - PDF bodies are not written to disk at all unless --save-pdfs is passed
 *
 * The redaction is verifiable: read `redactValue` and `summariseJson` below.
 *
 * USAGE
 *   node tools/record-flow.js progressive
 *   node tools/record-flow.js progressive --url https://.../access/login
 *   node tools/record-flow.js progressive --save-pdfs
 *
 * While it runs, in this terminal:
 *   <label><Enter>   force a labelled snapshot, e.g. "mfa screen"
 *   q<Enter>         finish and write the report
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';

// Must be set before config is imported: recording requires a visible browser.
process.env.HEADLESS = 'false';
// Asset blocking off while recording, so the capture shows the portal's real
// request profile rather than our optimised one.
process.env.BLOCK_RESOURCES = 'false';

const { default: config } = await import('../src/config.js');
const { default: browserPool } = await import('../src/browser/browserPool.js');
const { buildProxyConfig, newStickySessionId } = await import('../src/browser/proxy.js');
const { INVENTORY_FN, formatControl } = await import('./lib/domInventory.js');

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const carrier = args.find((a) => !a.startsWith('-')) ?? 'carrier';
const savePdfs = args.includes('--save-pdfs');
const urlArg = args.includes('--url') ? args[args.indexOf('--url') + 1] : null;

const KNOWN_ENTRY = {
  progressive: 'https://account.apps.progressive.com/access/login',
  geico: 'https://ecams.geico.com/login',
  travelers: 'https://signin.travelers.com/',
  lemonade: 'https://www.lemonade.com/login',
};

const startUrl = urlArg ?? KNOWN_ENTRY[carrier];
if (!startUrl) {
  console.error(`No known entry URL for "${carrier}". Pass --url <login page>.`);
  process.exit(1);
}

const OUT = path.resolve('artifacts/recordings', carrier);

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

/** Keys whose values are never recorded, at any nesting depth. */
const SENSITIVE_KEY = /pass|pwd|secret|token|auth|bearer|session|cookie|ssn|social|dob|birth|otp|code|answer|pin|cvv|account.?number|routing|licen[cs]e|vin|credential/i;

/**
 * Masks PII and credential material that can appear inside otherwise-harmless
 * string values.
 *
 * The JWT and `access_token` patterns are load-bearing, not belt-and-braces.
 * Progressive completes login with an OAuth implicit flow that puts the access
 * token in a URL *fragment*:
 *
 *   .../app/account-entry-headless#access_token=eyJhbGciOi...
 *
 * URLs are recorded for every request, so without this the recording captures
 * eight copies of a live bearer token even if every header is redacted
 * perfectly. Redacting headers and forgetting URLs leaks the same secret by a
 * different route.
 */
function scrubString(str) {
  return String(str)
    .replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/g, '<jwt>')
    .replace(/\beyJ[A-Za-z0-9_-]{20,}/g, '<jwt>')
    .replace(/((?:access_token|id_token|refresh_token|code|token)=)[^&\s#]{12,}/gi, '$1<redacted>')
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '<email>')
    .replace(/\b\d{9,}\b/g, '<long-number>')
    .replace(/\b\d{3}-\d{2}-\d{4}\b/g, '<ssn>')
    .slice(0, 160);
}

function redactValue(key, value) {
  if (SENSITIVE_KEY.test(key)) return `<redacted:${typeof value}:len${String(value ?? '').length}>`;
  if (value === null) return null;
  if (typeof value === 'string') return scrubString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  return value;
}

/**
 * Records the *structure* of a JSON payload plus non-sensitive values.
 *
 * Values matter here, not just keys: whether a login response says
 * `{"status":"CHALLENGE_REQUIRED","challengeType":"SMS"}` or
 * `{"status":"SUCCESS"}` is precisely what the adapter has to branch on. So
 * benign values are kept and sensitive ones are dropped by key, rather than
 * discarding everything.
 */
function summariseJson(value, depth = 0, key = '') {
  if (depth > 4) return '<deep>';
  if (Array.isArray(value)) {
    return value.length === 0
      ? []
      : [summariseJson(value[0], depth + 1, key), ...(value.length > 1 ? [`<+${value.length - 1} more>`] : [])];
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value).slice(0, 40)) {
      out[k] = SENSITIVE_KEY.test(k)
        ? `<redacted:${typeof v}>`
        : v && typeof v === 'object'
          ? summariseJson(v, depth + 1, k)
          : redactValue(k, v);
    }
    return out;
  }
  return redactValue(key, value);
}

/**
 * Header redaction.
 *
 * Cookie headers get "names only" treatment, because the *names* are genuinely
 * useful — they identify the bot-detection vendor — while the values are
 * credentials.
 *
 * Bearer tokens must NOT go down that path, and an earlier version of this
 * function made exactly that mistake. Splitting on `[;,]` then taking everything
 * before the first `=` is a sensible way to extract cookie names, but applied to
 * `Authorization: Bearer eyJhbGciOi...` it emits roughly a hundred characters of
 * live JWT, because a JWT contains no `;`, no `,` and no `=` until its trailing
 * padding. The "redaction" preserved the secret almost intact.
 *
 * So credential-bearing headers are now reduced to their scheme only, and the
 * cookie-name path is restricted to headers that actually carry cookies.
 */
const COOKIE_HEADERS = ['cookie', 'set-cookie'];
const CREDENTIAL_HEADERS = [
  'authorization',
  'proxy-authorization',
  'api_key',
  'apikey',
  'x-api-key',
  'rtds_key',
  'x-auth-token',
  'x-csrf-token',
];

function redactHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers ?? {})) {
    const lower = k.toLowerCase();

    if (COOKIE_HEADERS.includes(lower)) {
      const names = String(v)
        .split(/[;,]/)
        .map((p) => p.split('=')[0].trim())
        .filter(Boolean)
        .slice(0, 25);
      out[k] = `<cookie names only: ${[...new Set(names)].join(', ')}>`;
      continue;
    }

    if (CREDENTIAL_HEADERS.includes(lower) || SENSITIVE_KEY.test(lower)) {
      // Keep the scheme so the auth mechanism is still identifiable; drop the
      // secret entirely and record only its length.
      const scheme = String(v).trim().split(/\s+/)[0];
      const isScheme = /^(bearer|basic|digest|negotiate)$/i.test(scheme);
      out[k] = isScheme
        ? `${scheme} <redacted len${String(v).length}>`
        : `<redacted len${String(v).length}>`;
      continue;
    }

    out[k] = scrubString(v);
  }
  return out;
}

/** Field names and value lengths for a request body. Never the values. */
function describeRequestBody(request) {
  const raw = request.postData();
  if (!raw) return undefined;
  const contentType = (request.headers()['content-type'] ?? '').toLowerCase();
  try {
    if (contentType.includes('json')) {
      const parsed = JSON.parse(raw);
      const fields = {};
      for (const [k, v] of Object.entries(parsed).slice(0, 40)) {
        fields[k] = SENSITIVE_KEY.test(k)
          ? `<redacted len${String(v ?? '').length}>`
          : typeof v === 'object'
            ? summariseJson(v, 1, k)
            : redactValue(k, v);
      }
      return { encoding: 'json', fields };
    }
    if (contentType.includes('form-urlencoded')) {
      const params = new URLSearchParams(raw);
      const fields = {};
      for (const [k, v] of params) {
        fields[k] = SENSITIVE_KEY.test(k) ? `<redacted len${v.length}>` : scrubString(v);
      }
      return { encoding: 'form', fields };
    }
  } catch {
    /* fall through */
  }
  return { encoding: contentType || 'unknown', bytes: raw.length, note: 'body not parsed, not stored' };
}

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

const network = [];
const snapshots = [];
const pdfHits = [];
let lastFingerprint = '';

/** Requests we do not care about, to keep the log readable. */
const NOISE = /\.(png|jpe?g|gif|svg|webp|woff2?|ttf|eot|ico|css)(\?|$)/i;

async function main() {
  await fs.mkdir(OUT, { recursive: true });

  const proxy = config.RESIDENTIAL_PROXY_URL ? buildProxyConfig(newStickySessionId()) : null;

  // Persistent profile: if the login completes, the session survives so the
  // resulting cookie names can be inspected afterwards, and it is the same
  // mechanism the real adapter uses for its warm path.
  const lease = await browserPool.acquirePersistentContext({
    profileKey: `recorder:${carrier}`,
    proxy,
    blockStylesheets: false,
  });

  const page = lease.context.pages()[0] ?? (await lease.context.newPage());

  lease.context.on('request', (request) => {
    if (NOISE.test(request.url())) return;
    network.push({
      seq: network.length,
      at: Date.now(),
      phase: 'request',
      method: request.method(),
      url: scrubString(request.url()),
      resourceType: request.resourceType(),
      isNavigation: request.isNavigationRequest(),
      headers: redactHeaders(request.headers()),
      body: describeRequestBody(request),
    });
  });

  lease.context.on('response', async (response) => {
    const request = response.request();
    const url = response.url();
    if (NOISE.test(url)) return;

    const contentType = (response.headers()['content-type'] ?? '').toLowerCase();
    const entry = {
      seq: network.length,
      at: Date.now(),
      phase: 'response',
      method: request.method(),
      url: scrubString(url),
      status: response.status(),
      contentType,
      redirectedTo: response.headers()['location']
        ? scrubString(response.headers()['location'])
        : undefined,
      setCookieNames: response.headers()['set-cookie']
        ? [
            ...new Set(
              String(response.headers()['set-cookie'])
                .split('\n')
                .map((c) => c.split('=')[0].trim())
            ),
          ]
        : undefined,
    };

    // The payload we most want to understand: JSON from the auth endpoints.
    if (contentType.includes('json') && request.resourceType() !== 'document') {
      try {
        const text = await response.text();
        if (text.length < 200_000) entry.jsonShape = summariseJson(JSON.parse(text));
      } catch {
        /* streamed or already consumed */
      }
    }

    if (contentType.includes('pdf') || /\.pdf(\?|$)/i.test(url)) {
      let bytes = null;
      try {
        bytes = (await response.body()).length;
      } catch {
        /* not buffered */
      }
      const hit = {
        url: scrubString(url),
        method: request.method(),
        status: response.status(),
        contentType,
        bytes,
        requestHeaders: redactHeaders(request.headers()),
      };
      pdfHits.push(hit);
      console.log(`\n  *** PDF RESPONSE ***  ${request.method()} ${response.status()} ${bytes ?? '?'} bytes`);
      console.log(`      ${url.slice(0, 160)}\n`);

      if (savePdfs) {
        try {
          const body = await response.body();
          const name = `document-${pdfHits.length}.pdf`;
          await fs.writeFile(path.join(OUT, name), body);
          console.log(`      saved ${name} (contains real PII — artifacts/ is gitignored)`);
        } catch {
          /* ignore */
        }
      }
      entry.pdf = true;
    }

    network.push(entry);
  });

  // ---- snapshots ----------------------------------------------------------

  async function snapshot(label) {
    try {
      const inventory = await page.evaluate(INVENTORY_FN);
      // Fingerprint the step so SPA transitions are captured once each, rather
      // than on every poll. Progressive is a single-page app, so `framenavigated`
      // alone would miss most of the flow.
      const fingerprint = [
        inventory.url.split('?')[0],
        inventory.heading,
        inventory.inputs.map((i) => `${i.type}:${i.autocomplete}:${i.label}`).join('|'),
        inventory.bodyText.slice(0, 120),
      ].join('##');

      if (!label && fingerprint === lastFingerprint) return false;
      lastFingerprint = fingerprint;

      const index = snapshots.length + 1;
      const record = { index, label: label || `step-${index}`, at: Date.now(), ...inventory };
      record.bodyText = scrubString(record.bodyText);
      snapshots.push(record);

      console.log(`\n${'─'.repeat(72)}`);
      console.log(`SNAPSHOT ${index}${label ? ` — ${label}` : ''}`);
      console.log(`  url:     ${inventory.url.slice(0, 120)}`);
      console.log(`  heading: ${inventory.heading ?? '(none)'}`);
      if (inventory.shadowRootsSeen) console.log(`  shadowRoots: ${inventory.shadowRootsSeen}`);
      if (inventory.inputs.length) {
        console.log('  inputs:');
        for (const i of inventory.inputs.slice(0, 12)) console.log(`    ${formatControl(i)}`);
      }
      if (inventory.buttons.length) {
        console.log('  buttons:');
        for (const b of inventory.buttons.slice(0, 10)) console.log(`    ${formatControl(b)}`);
      }
      const docLinks = inventory.links.filter((l) =>
        /pdf|document|declaration|dec-?page|idcard|id-?card|policy/i.test(`${l.href} ${l.text ?? ''}`)
      );
      if (docLinks.length) {
        console.log('  DOCUMENT-LOOKING LINKS:');
        for (const l of docLinks.slice(0, 12)) {
          console.log(`    ${l.text ?? '(no text)'}  ->  ${l.href.slice(0, 110)}`);
        }
      }

      await page
        .screenshot({ path: path.join(OUT, `${String(index).padStart(2, '0')}-${(label || 'step').replace(/\W+/g, '-')}.png`) })
        .catch(() => {});
      return true;
    } catch (err) {
      if (!/Execution context was destroyed|Target closed/.test(err.message)) {
        console.log(`  (snapshot skipped: ${err.message.split('\n')[0]})`);
      }
      return false;
    }
  }

  // ---- drive -------------------------------------------------------------

  console.log(`\n${'='.repeat(72)}`);
  console.log(`Recording "${carrier}"`);
  console.log(`  entry:  ${startUrl}`);
  console.log(`  egress: ${proxy ? 'residential proxy' : 'DIRECT from this machine'}`);
  console.log(`  output: ${path.relative(process.cwd(), OUT)}/`);
  console.log(`  PDFs:   ${savePdfs ? 'will be saved' : 'metadata only (pass --save-pdfs to keep bytes)'}`);
  console.log(`${'='.repeat(72)}`);
  console.log(`
A browser window is opening. Sign in there as you normally would:

  1. Enter your Progressive username and password in the browser
  2. Complete the MFA challenge with the code on your phone
  3. Navigate to your policy documents and OPEN the declarations PDF
     (that last step is the important one — it reveals the document URL)

Your password goes into Progressive's page, not into this tool. Nothing
credential-bearing is written to disk; see the redaction notes at the top of
this file.

In THIS terminal:
  <label><Enter>   force a labelled snapshot, e.g. "mfa screen"
  q<Enter>         finish and write the report
`);

  await page.goto(startUrl, { waitUntil: 'domcontentloaded' }).catch((e) => {
    console.log(`  navigation warning: ${e.message.split('\n')[0]}`);
  });

  // Poll for step changes. Catches SPA transitions that fire no navigation event.
  const poller = setInterval(() => void snapshot(null), 1800);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: false });
  await new Promise((resolve) => {
    rl.on('line', async (line) => {
      const text = line.trim();
      if (text.toLowerCase() === 'q') return resolve();
      lastFingerprint = ''; // force capture even if the step looks unchanged
      await snapshot(text || undefined);
    });
    rl.on('close', resolve);
    lease.context.on('close', resolve);
  });

  clearInterval(poller);
  rl.close();

  // ---- report ------------------------------------------------------------

  let cookieNames = [];
  try {
    cookieNames = (await lease.context.cookies()).map((c) => c.name);
  } catch {
    /* context may already be closed */
  }

  const report = {
    carrier,
    entryUrl: startUrl,
    recordedAt: new Date().toISOString(),
    proxied: Boolean(proxy),
    redaction:
      'Request bodies stored as field names + lengths only. Sensitive keys dropped by pattern. ' +
      'Cookie/authorization headers reduced to names. Emails and long digit runs masked. ' +
      'PDF bytes not stored unless --save-pdfs.',
    snapshotCount: snapshots.length,
    pdfResponses: pdfHits,
    finalCookieNames: cookieNames,
    snapshots,
    network,
  };

  await fs.writeFile(path.join(OUT, 'recording.json'), JSON.stringify(report, null, 2));

  console.log(`\n${'='.repeat(72)}`);
  console.log(`Wrote ${path.relative(process.cwd(), path.join(OUT, 'recording.json'))}`);
  console.log(`  snapshots:     ${snapshots.length}`);
  console.log(`  network events: ${network.length}`);
  console.log(`  PDF responses: ${pdfHits.length}`);
  if (pdfHits.length) {
    console.log(`\n  Document URLs found:`);
    for (const p of pdfHits) console.log(`    ${p.method} ${p.status}  ${p.url.slice(0, 130)}`);
  } else {
    console.log(`\n  No PDF response captured. If the document opened in a new tab or a`);
    console.log(`  native viewer, re-run and use the in-page viewer, or note the URL manually.`);
  }
  console.log(`${'='.repeat(72)}\n`);

  await lease.release().catch(() => {});
  await browserPool.shutdown().catch(() => {});
  process.exit(0);
}

main().catch(async (err) => {
  console.error(`\nrecorder failed: ${err.message}`);
  await browserPool.shutdown().catch(() => {});
  process.exit(1);
});
