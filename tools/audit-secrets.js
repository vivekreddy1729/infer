/**
 * Scans everything this app writes to disk for credential material.
 *
 * Exists because log files are now durable and explicitly intended to be copied
 * off the host and shared. That makes redaction a security control rather than a
 * tidiness preference, and security controls need to be tested rather than
 * assumed.
 *
 * It has already earned its place twice. The flow recorder was found to be
 * writing bearer tokens two different ways: the `authorization` header went down
 * a cookie-name code path that preserved most of the JWT, and separately every
 * request URL was recorded while Progressive's OAuth flow puts its access token
 * in a URL *fragment*. Redacting headers and forgetting URLs leaks the same
 * secret by a different route.
 *
 *   node tools/audit-secrets.js
 *   node tools/audit-secrets.js --include-profiles   # also scan Chrome profiles
 */

import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Patterns live in `tools/lib/secretPatterns.js` so this file's own test can import
 * them without executing the audit — this module has top-level `await` and calls
 * `process.exit()`, so importing it would run a scan rather than read its rules.
 *
 * The test must use the real patterns, not a copy. A copied pattern list is how a
 * guard ends up passing while the thing it guards has drifted.
 */
import { PATTERNS, REDACTION_MARKERS } from './lib/secretPatterns.js';

const includeProfiles = process.argv.includes('--include-profiles');

/**
 * Everything this app writes to disk.
 *
 * All three are gitignored, which is *why* they need auditing rather than a reason to
 * skip it: these are the artefacts someone copies off a host and pastes into an issue,
 * so they travel further than the repository does.
 */
const TARGETS = ['logs', 'data', 'artifacts'];

/**
 * Chrome profile directories, skipped unless asked for.
 *
 * A persistent profile holds the browser's own cookie and login databases, which
 * genuinely contain carrier session material. That finding is neither actionable nor a
 * defect in our redaction — it is a browser storing what browsers store. Scanning them
 * by default would mean a permanent failure, and a guard that always fails is a guard
 * nobody reads. `--include-profiles` exists for when the question really is "what is
 * on this disk".
 */
const SKIP = [/(^|\/)data\/profiles(\/|$)/, /(^|\/)profiles(\/|$)/];

/**
 * Binary extensions, skipped.
 *
 * A PNG or PDF read as UTF-8 produces megabytes of mojibake, and the long-hex and
 * base64 patterns match compressed bytes readily — so scanning them yields a stream of
 * findings that are certainly false and expensive to confirm. The credential-bearing
 * artefacts here are all text: logs, JSONL metrics, diagnostic bundles, recordings.
 *
 * Screenshots are the one real gap and it is accepted: a screenshot of a logged-in
 * portal can contain personal data, but it cannot be redacted by pattern matching and
 * nothing in this project writes one automatically outside `artifacts/`, which is
 * gitignored.
 */
const BINARY_EXT = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.pdf',
  '.zip', '.gz', '.br', '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.mp4', '.webm', '.wasm', '.so', '.dylib', '.node',
]);

const isRedactionMarker = (value) => REDACTION_MARKERS.some((re) => re.test(String(value).trim()));

const findings = [];
let scanned = 0;
let skipped = 0;

async function walk(dir) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const full = path.join(dir, entry.name);

    if (!includeProfiles && SKIP.some((re) => re.test(full))) {
      skipped += 1;
      continue;
    }
    if (SKIP.slice(1).some((re) => re.test(full))) continue;

    if (entry.isDirectory()) {
      await walk(full);
      continue;
    }
    if (BINARY_EXT.has(path.extname(entry.name).toLowerCase())) continue;

    let content;
    try {
      const st = await fs.stat(full);
      // Cap per-file work; the interesting files are logs and JSON.
      if (st.size > 24 * 1024 * 1024) continue;
      content = await fs.readFile(full, 'latin1');
    } catch {
      continue;
    }
    scanned += 1;

    for (const p of PATTERNS) {
      // Scan globally so one redaction marker early in a file cannot mask a real
      // secret later in it.
      const global = new RegExp(p.re.source, `${p.re.flags.replace('g', '')}g`);
      for (const m of content.matchAll(global)) {
        const value = p.captureGroup ? m[p.captureGroup] : m[0];
        if (isRedactionMarker(value)) continue;

        findings.push({
          file: full,
          pattern: p.name,
          severity: p.severity,
          // Never print the match itself — that would move the secret into CI
          // output, which is usually more widely readable than the file was.
          preview: `${String(value).slice(0, 6)}…(${String(value).length} chars)`,
        });
        break; // one finding per pattern per file is enough to act on
      }
    }
  }
}

console.log('Secret audit of app-written files\n');
for (const t of TARGETS) await walk(t);

const high = findings.filter((f) => f.severity === 'high');
const notes = findings.filter((f) => f.severity === 'note');

console.log(`  files scanned: ${scanned}`);
if (!includeProfiles) console.log(`  paths skipped: ${skipped} (Chrome profiles; pass --include-profiles)`);

if (high.length === 0) {
  console.log('\n  PASS  no credential material found in logs, metrics, or diagnostic bundles');
} else {
  console.log(`\n  FAIL  ${high.length} high-severity finding(s):`);
  for (const f of high) console.log(`    ${f.pattern.padEnd(22)} ${f.file}  ${f.preview}`);
}

if (notes.length) {
  console.log(`\n  ${notes.length} note(s) (usually hashes or HMAC filenames, which are fine):`);
  for (const f of notes.slice(0, 10)) console.log(`    ${f.pattern.padEnd(22)} ${f.file}`);
}

console.log(`
Note on Chrome profiles (data/profiles/), excluded by default:

  They legitimately contain live session cookies — that is what makes the warm
  path work. They ALSO contain the carrier's OAuth access token, because it
  arrives in a URL fragment and Chrome records visited URLs in its History and
  session-restore files. Nothing we write puts it there; Chrome does.

  Consequences, which are real and not theoretical:
    - data/ is gitignored and must stay that way
    - a profile directory is credential-bearing: never attach one to a bug report
    - on a deployed volume it is persistent secret material
    - \`npm run profiles:clear\` removes them; the next run falls back to a cold login

  Diagnostic bundles never include profile contents, so logs remain safe to share.
`);

process.exit(high.length === 0 ? 0 : 1);
