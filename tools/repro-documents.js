/**
 * Reproduce the document phase against an existing logged-in profile.
 *
 * The adapter runs with a persistent Chrome profile, so a run that got past MFA
 * leaves a profile on disk that is still authenticated. This drives the *real*
 * `ProgressiveCarrier.fetchDocuments()` against that profile, which means a
 * document-phase failure can be diagnosed without spending another login and
 * another SMS.
 *
 * It deliberately mirrors the adapter's own runtime conditions rather than the
 * inspection tool's. `tools/inspect-documents.js` forces
 * `BLOCK_RESOURCES=false` and a headed browser, and those differences are
 * exactly the kind of thing that makes a bug reproduce in production and not in
 * the harness, so they are configurable here and default to matching the server.
 *
 *   node tools/repro-documents.js                  # like the server: headless, blocking on
 *   node tools/repro-documents.js --headed         # watch it
 *   node tools/repro-documents.js --no-blocking    # rule the blocker in or out
 *   node tools/repro-documents.js --list           # show profiles and exit
 */

import fs from 'node:fs/promises';
import path from 'node:path';

const argv = process.argv.slice(2);
const headed = argv.includes('--headed');
const noBlocking = argv.includes('--no-blocking');
const listOnly = argv.includes('--list');

process.env.HEADLESS = headed ? 'false' : 'true';
process.env.BLOCK_RESOURCES = noBlocking ? 'false' : 'true';

const { default: config } = await import('../src/config.js');
const logger = (await import('../src/logger.js')).default;
const { contextOptions, launchOptions } = await import('../src/browser/stealth.js');
const { installResourceBlocking } = await import('../src/browser/resourceBlocker.js');
const { default: Timings } = await import('../src/telemetry/timings.js');
const { ProgressiveCarrier } = await import('../src/carriers/progressive.js');

const PROFILES_DIR = path.resolve(config.DATA_DIR, 'profiles');

/** Most recently used profile is the one the failing run left behind. */
async function pickProfile() {
  const entries = await fs.readdir(PROFILES_DIR).catch(() => []);
  const stats = [];
  for (const name of entries) {
    const dir = path.join(PROFILES_DIR, name);
    const st = await fs.stat(dir).catch(() => null);
    if (st?.isDirectory()) stats.push({ name, dir, mtime: st.mtimeMs });
  }
  stats.sort((a, b) => b.mtime - a.mtime);
  return stats;
}

const profiles = await pickProfile();
if (profiles.length === 0) {
  console.error(`No profiles under ${PROFILES_DIR}. Run a real pull first.`);
  process.exit(1);
}

console.log('Profiles on disk (newest first):');
for (const p of profiles) {
  console.log(`  ${p.name}  last used ${new Date(p.mtime).toLocaleTimeString()}`);
}
if (listOnly) process.exit(0);

const chosen = profiles[0];
console.log(`\nUsing ${chosen.name}`);
console.log(`  headless: ${config.HEADLESS}   resource blocking: ${config.BLOCK_RESOURCES}\n`);

const { chromium } = await import(config.BROWSER_DRIVER);

let context;
for (const channel of ['chrome', 'chromium', undefined]) {
  try {
    context = await chromium.launchPersistentContext(chosen.dir, {
      ...launchOptions({ headless: config.HEADLESS }),
      ...contextOptions(),
      channel,
    });
    console.log(`  launched with channel=${channel ?? 'bundled'}`);
    break;
  } catch {
    /* try next */
  }
}
if (!context) {
  console.error('Could not launch a persistent context.');
  process.exit(1);
}

context.setDefaultTimeout(config.NAV_TIMEOUT_MS);
context.setDefaultNavigationTimeout(config.NAV_TIMEOUT_MS);

let blocking = { stats: () => ({}) };
if (config.BLOCK_RESOURCES) {
  blocking = await installResourceBlocking(context, {
    blockStylesheets: ProgressiveCarrier.blockStylesheets,
    extraAllow: ProgressiveCarrier.extraAllow,
  });
}

const page = context.pages()[0] ?? (await context.newPage());
const timings = new Timings({ tool: 'repro-documents' });

/**
 * Verbose API trace.
 *
 * The adapter's observer only records requests that already carry an
 * `authorization` header, which is correct for its purpose but useless for
 * diagnosis: when nothing is captured you cannot tell whether the app made no
 * calls, made calls to a different host, or made calls without a token. This logs
 * everything so that distinction is visible.
 */
const apiTrace = [];
const maskUrl = (u) =>
  u.replace(/\b\d{9,}\b/g, '{policyNumber}').replace(/((?:access_token|token)=)[^&]+/gi, '$1{redacted}');

page.on('request', (r) => {
  const u = r.url();
  if (!/api\.progressive\.com|policypro|pf-ws/.test(u)) return;
  const h = r.headers();
  apiTrace.push({
    t: Date.now(),
    method: r.method(),
    url: maskUrl(u),
    auth: h.authorization ? 'BEARER' : 'none',
    headerCount: Object.keys(h).length,
  });
});
// Also watch every page in the context, in case a click opens a new tab and the
// app continues its lifecycle somewhere our page-scoped listeners cannot see.
context.on('page', (p) => {
  console.log(`  [context] new page opened: ${maskUrl(p.url())}`);
  p.on('request', (r) => {
    const u = r.url();
    if (!/api\.progressive\.com|policypro/.test(u)) return;
    apiTrace.push({
      t: Date.now(),
      method: r.method(),
      url: maskUrl(u),
      auth: r.headers().authorization ? 'BEARER' : 'none',
      onOtherPage: true,
    });
  });
});

const notes = [];
const carrier = new ProgressiveCarrier({
  page,
  context,
  timings,
  log: logger,
  notify: (msg) => {
    notes.push(msg);
    console.log(`  note: ${msg}`);
  },
});

/**
 * Confirm the profile is still authenticated before blaming the document code.
 * `isSessionValid` also installs the network observers that the document phase
 * depends on, which `fetchDocuments` does not do for itself.
 */
console.log('Checking the saved session is still valid…');
const valid = await carrier.isSessionValid();
console.log(`  session valid: ${valid}`);
console.log(`  flow state: ${JSON.stringify(carrier.debugState)}`);

if (!valid) {
  console.log(`
The saved session has expired, so this cannot isolate the document phase.
Re-run the pull from the UI, or use \`npm run record progressive\` to refresh
the profile.`);
  await context.close();
  process.exit(1);
}

console.log('\nRunning the real fetchDocuments()…\n');

let result = null;
let failure = null;
try {
  result = await carrier.fetchDocuments();
} catch (err) {
  failure = err;
}

console.log(`\n${'='.repeat(72)}`);
if (result) {
  console.log(`SUCCESS — ${result.length} document(s)`);
  for (const d of result) {
    const magic = d.bytes.subarray(0, 5).toString('latin1');
    console.log(
      `  ${d.label.padEnd(26)} ${String(d.bytes.length).padStart(8)}B  ${magic === '%PDF-' ? 'valid PDF' : `NOT A PDF (${magic})`}  via ${d.meta?.via ?? '?'}`
    );
  }
  await fs.mkdir('artifacts', { recursive: true });
  const out = path.join('artifacts', 'repro-declarations.pdf');
  await fs.writeFile(out, result[0].bytes);
  console.log(`  wrote ${out}`);
} else {
  console.log(`FAILED — ${failure?.code ?? 'UNKNOWN'}: ${failure?.message}`);
  console.log(`  userMessage: ${failure?.userMessage}`);
}

console.log(`\ndebugState: ${JSON.stringify(carrier.debugState, null, 2)}`);
console.log(`blocking:   ${JSON.stringify(blocking.stats())}`);
console.log(`timings:    ${JSON.stringify(timings.summary().phases)}`);
console.log(`final url:  ${maskUrl(page.url())}`);
console.log(`open pages: ${context.pages().length}`);

console.log(`\nAPI TRACE (${apiTrace.length} calls to api.progressive.com / policypro / pf-ws):`);
if (apiTrace.length === 0) {
  console.log('  (nothing — the app made no API calls at all)');
}
for (const e of apiTrace) {
  console.log(
    `  ${e.method.padEnd(5)} auth=${e.auth.padEnd(6)}${e.onOtherPage ? ' [other page]' : ''} ${e.url.slice(0, 118)}`
  );
}

// What the page is actually showing, which explains an idle app.
const visible = await page
  .evaluate(() => ({
    title: document.title,
    text: (document.body?.innerText ?? '').replace(/\s+/g, ' ').trim().slice(0, 300),
  }))
  .catch(() => null);
if (visible) {
  console.log(`\npage title: ${visible.title}`);
  console.log(`page text:  ${visible.text}`);
}
console.log(`${'='.repeat(72)}\n`);

await context.close();
process.exit(result ? 0 : 1);
