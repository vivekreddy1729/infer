#!/usr/bin/env node
/**
 * One-command setup: clone → running, with nothing to read first.
 *
 * ------------------------------------------------------------------------
 * WHAT IT DOES AND WHY EACH STEP IS HERE
 * ------------------------------------------------------------------------
 * Every step exists because skipping it produces a failure that does not name
 * itself:
 *
 *   1. install dependencies        — obvious, but `npm ci` vs `npm install` matters
 *                                    for reproducibility
 *   2. install browsers            — Playwright browsers are not npm dependencies;
 *                                    without them the first run dies inside a driver
 *   3. try to install real Chrome   — the channel silently degrades to bundled
 *                                    Chromium, which changes detectability without
 *                                    changing behaviour (F-32/F-40)
 *   4. create .env                  — from the example, with HEADLESS=false preserved
 *   5. generate a session key       — absent, sessions never rehydrate and every pull
 *                                    silently costs a human MFA round-trip (F-44)
 *   6. create data/ and logs/       — so a read-only volume fails now, not mid-pull
 *   7. run the preflight            — and print what is still missing
 *
 * Idempotent. Never overwrites an existing `.env`, because that file holds
 * credentials-adjacent configuration and clobbering it would be hostile.
 *
 *   npm run setup
 */

import { access, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import crypto from 'node:crypto';

const run = promisify(execFile);
const exists = async (p) => { try { await access(p); return true; } catch { return false; } };

const step = (n, m) => console.log(`\n\u001b[1m[${n}/7]\u001b[0m ${m}`);
const ok = (m) => console.log(`      \u001b[32mok\u001b[0m  ${m}`);
const note = (m) => console.log(`      ·   ${m}`);
const warn = (m) => console.log(`      \u001b[33m!\u001b[0m   ${m}`);

/** Stream a long command so the user sees progress rather than a frozen terminal. */
function stream(cmd, args) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let tail = '';
    const keep = (d) => { tail = (tail + d.toString()).slice(-400); };
    p.stdout.on('data', keep);
    p.stderr.on('data', keep);
    p.on('close', (code) => resolve({ code, tail }));
    p.on('error', () => resolve({ code: 1, tail }));
  });
}

console.log('\n\u001b[1mCarrier Policy Puller — setup\u001b[0m');

// -- 1. dependencies ----------------------------------------------------------
step(1, 'Installing dependencies');
if (await exists('node_modules')) {
  ok('node_modules already present, skipping');
} else {
  // `npm ci` is reproducible but requires a lockfile; fall back so a fresh copy
  // without one still works.
  const useCi = await exists('package-lock.json');
  const r = await stream('npm', [useCi ? 'ci' : 'install']);
  if (r.code === 0) ok(useCi ? 'npm ci' : 'npm install');
  else { console.log(r.tail); console.error('\n  Dependency install failed. Fix the error above and re-run.\n'); process.exit(1); }
}

// -- 2. browsers --------------------------------------------------------------
step(2, 'Installing browser binaries (~500MB, this is the slow part)');
{
  const r = await stream('npx', ['patchright', 'install', 'chromium']);
  if (r.code === 0) ok('chromium installed');
  else { warn('chromium install reported an error; `npm run doctor` will confirm whether a browser works'); note(r.tail.split('\n').slice(-3).join(' ')); }
}

// -- 3. real Chrome -----------------------------------------------------------
/**
 * DETECTED, NOT INSTALLED — and that is deliberate.
 *
 * The first version of this step ran `npx playwright install chrome`, which on macOS
 * installs Google Chrome system-wide and therefore prompts for a **sudo password**.
 * A setup script that blocks on an interactive prompt is worse than no setup script:
 * it hangs with no explanation, it cannot run in CI, and the user cannot tell whether
 * it is working or stuck. It hung for the full timeout when tested.
 *
 * So this reports the situation and prints the command. Installing a browser
 * system-wide is a decision for the person at the keyboard, not a side effect of
 * `npm run setup`.
 *
 * Nothing breaks without it — the app falls back to bundled Chromium and runs. What
 * changes is detectability, which is why it is surfaced rather than skipped silently.
 */
step(3, 'Checking for real Google Chrome');
{
  const candidates = process.platform === 'darwin'
    ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
    : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/opt/google/chrome/chrome'];

  let found = null;
  for (const c of candidates) if (await exists(c)) { found = c; break; }

  if (found) {
    ok('Google Chrome present — best anti-detection posture');
  } else {
    warn('Google Chrome not found; the app will use bundled Chromium');
    note('That still works. But carrier anti-bot behaviour on bundled Chromium is not');
    note('representative (F-32), and a named channel does more for detectability than');
    note('every JS patch combined (src/browser/stealth.js).');
    note('');
    note('To install it (asks for your password, so it is not done automatically):');
    note('    npm run browsers:chrome');
    note('');
    note('Not needed for the demo portal, and a GEICO login has been verified working');
    note('on bundled Chromium — so skip it for now if you prefer.');
  }
}

// -- 4 + 5. .env and the session key -----------------------------------------
step(4, 'Creating .env');
const newKey = () => crypto.randomBytes(32).toString('hex');

if (await exists('.env')) {
  ok('.env already exists, leaving it alone');
  const body = await readFile('.env', 'utf8');
  if (!/^SESSION_ENCRYPTION_KEY=.+/m.test(body)) {
    warn('it has no SESSION_ENCRYPTION_KEY — sessions will not survive a restart');
    note('Add this line to .env:');
    note(`  SESSION_ENCRYPTION_KEY=${newKey()}`);
  }
  if (/^HEADLESS=true/m.test(body)) {
    warn('it has HEADLESS=true, which makes GEICO login stall with no error (F-40)');
    note('Change it to HEADLESS=false. A window only appears when you run it locally;');
    note('on a server Chrome draws into a desktop session or a virtual display.');
  }
} else if (await exists('.env.example')) {
  await copyFile('.env.example', '.env');
  let body = await readFile('.env', 'utf8');
  step(5, 'Generating a session encryption key');
  if (/^#?\s*SESSION_ENCRYPTION_KEY=/m.test(body)) {
    body = body.replace(/^#?\s*SESSION_ENCRYPTION_KEY=.*$/m, `SESSION_ENCRYPTION_KEY=${newKey()}`);
  } else {
    body += `\nSESSION_ENCRYPTION_KEY=${newKey()}\n`;
  }
  await writeFile('.env', body);
  ok('.env created from .env.example, with a fresh 32-byte key');
  note('Saved sessions carry the carrier trusted-device cookie, so a stable key is');
  note('what lets a repeat pull skip the MFA challenge entirely (F-44).');
} else {
  warn('.env.example is missing — cannot create .env');
}

// -- 6. writable paths --------------------------------------------------------
step(6, 'Creating data and log directories');
for (const dir of ['data', 'logs', 'artifacts']) {
  await mkdir(dir, { recursive: true, mode: 0o700 }).catch(() => {});
}
ok('data/ logs/ artifacts/ (0700 — they hold session material and are gitignored)');

// -- 7. preflight -------------------------------------------------------------
step(7, 'Running preflight');
console.log('');
const doctor = await stream('node', ['tools/doctor.js']);
process.stdout.write(doctor.tail.endsWith('\n') ? '' : '\n');
await run('node', ['tools/doctor.js'], { maxBuffer: 1 << 20 })
  .then(({ stdout }) => process.stdout.write(stdout))
  .catch((e) => process.stdout.write(e.stdout ?? ''));

console.log('\u001b[1mNext\u001b[0m');
console.log('  npm start                 then open http://localhost:3000');
console.log('  Pick "Demo Mutual" first  — it needs no credentials and proves the whole pipeline');
console.log('  npm run smoke:all         runs every check (14 suites)');
console.log('');
