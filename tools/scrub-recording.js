/**
 * Retroactively scrub credential material out of an existing recording.
 *
 * Needed because an earlier `redactHeaders` bug let `Authorization: Bearer <jwt>`
 * through its cookie-name path, which preserved roughly a hundred characters of
 * live token. The bug is fixed for future recordings; this repairs files already
 * written. Rewrites in place after taking a `.bak`.
 *
 *   node tools/scrub-recording.js artifacts/recordings/progressive/recording.json
 */

import fs from 'node:fs/promises';

const target = process.argv[2];
if (!target) {
  console.error('usage: node tools/scrub-recording.js <recording.json>');
  process.exit(1);
}

/** JWTs, long opaque tokens, and anything that smells like a secret. */
const PATTERNS = [
  // JWT: three base64url segments.
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '<jwt-redacted>'],
  // Truncated JWT (header + partial payload), which is what the bug emitted.
  [/\beyJ[A-Za-z0-9_-]{20,}/g, '<jwt-redacted>'],
  [/\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/gi, 'Bearer <redacted>'],
  // Long opaque hex/base64 runs typical of api keys and session ids.
  [/\b[A-Fa-f0-9]{40,}\b/g, '<hex-redacted>'],
  [/[\w.+-]+@[\w-]+\.[\w.]+/g, '<email>'],
  [/\b\d{3}-\d{2}-\d{4}\b/g, '<ssn>'],
];

const raw = await fs.readFile(target, 'utf8');
let scrubbed = raw;
const counts = [];

for (const [pattern, replacement] of PATTERNS) {
  const matches = scrubbed.match(pattern);
  if (matches?.length) counts.push(`${matches.length} x ${pattern.source.slice(0, 44)}`);
  scrubbed = scrubbed.replace(pattern, replacement);
}

if (scrubbed === raw) {
  console.log('No credential material found. File left unchanged.');
  process.exit(0);
}

// Confirm we did not corrupt the JSON.
try {
  JSON.parse(scrubbed);
} catch (err) {
  console.error(`Refusing to write: scrubbing produced invalid JSON (${err.message})`);
  process.exit(1);
}

await fs.writeFile(`${target}.bak`, raw, { mode: 0o600 });
await fs.writeFile(target, scrubbed);

console.log(`Scrubbed ${target}`);
for (const c of counts) console.log(`  ${c}`);
console.log(`Original preserved at ${target}.bak (also gitignored — delete it once you are happy).`);
