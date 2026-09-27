#!/usr/bin/env node
/**
 * Preflight: check this machine can actually run the app, and say what to fix.
 *
 * ------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ------------------------------------------------------------------------
 * Most of the failures in this project's history were environmental rather than
 * logical, and every one of them presented as something else:
 *
 *   - real Chrome absent      -> silently ran bundled Chromium (F-32/F-40)
 *   - HEADLESS=true           -> GEICO login stalls with a 302 and no error (F-40)
 *   - no SESSION_ENCRYPTION_KEY -> sessions never rehydrate, every pull pays MFA (F-44)
 *   - stale server process    -> new code never loaded, fixes look wrong (F-38)
 *   - port already held       -> a second server starts and serves nothing (F-38)
 *
 * None of those announce themselves. Each cost a debugging round, and each is a
 * two-second check. So they are checked up front, with the remedy printed rather
 * than implied.
 *
 * Exit code 0 means "nothing will silently misbehave". Warnings do not fail: a
 * missing residential proxy is expected in development and should not block anyone
 * from running the demo portal.
 *
 *   npm run doctor
 */

import { access, readFile, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';

const run = promisify(execFile);

let errors = 0;
let warns = 0;
const ok = (m, d = '') => console.log(`  \u001b[32mok\u001b[0m    ${m}${d ? `  ${d}` : ''}`);
const warn = (m, fix = '') => { warns += 1; console.log(`  \u001b[33mwarn\u001b[0m  ${m}`); if (fix) console.log(`        → ${fix}`); };
const bad = (m, fix = '') => { errors += 1; console.log(`  \u001b[31mFAIL\u001b[0m  ${m}`); if (fix) console.log(`        → ${fix}`); };

const exists = async (p) => { try { await access(p); return true; } catch { return false; } };

console.log('\nCarrier Policy Puller — preflight\n');

// -- 1. Node ------------------------------------------------------------------
/**
 * Report Node that is NEWER than the pinned version, not just older.
 *
 * `engines` allows `>=20` and this used to pass anything at or above it silently. A
 * production instance ended up on Node 24 because `winget` installs current LTS while
 * `.nvmrc` pins 20 — legal, and untested. Nothing said so, which makes it the last thing
 * anyone would suspect when behaviour differs from development (F-60..F-64 deployment
 * notes, item 6).
 *
 * A note rather than a warning: running ahead of the pin is usually fine and blocking on
 * it would be obstructive. The point is that it is *visible* before someone spends an hour
 * on a mystery.
 */
const PINNED_MAJOR = 20;
const major = Number(process.versions.node.split('.')[0]);
if (major < PINNED_MAJOR) {
  bad(`Node ${process.version} is too old; >=${PINNED_MAJOR} required`, 'Install Node 20+ (see .nvmrc)');
} else if (major > PINNED_MAJOR) {
  ok(
    'Node version',
    `${process.version} — newer than the pinned ${PINNED_MAJOR} in .nvmrc. Allowed by `
      + `engines, but ${PINNED_MAJOR} is what this project was verified against; suspect it `
      + 'first if behaviour differs from development.'
  );
} else {
  ok('Node version', `${process.version} — matches .nvmrc`);
}

// -- 2. Dependencies ----------------------------------------------------------
if (await exists('node_modules')) {
  ok('dependencies installed');
} else {
  bad('node_modules missing', 'npm run setup   (or: npm ci)');
}

// -- 3. Browser binaries ------------------------------------------------------
/**
 * Checked by launching, not by looking for a directory.
 *
 * A present `~/.cache/ms-playwright` folder does not mean a working browser — the
 * download can be partial, or the wrong platform build. Launching is the only test
 * that matches what the app does, and it is also how the channel fallback becomes
 * visible: this project silently degrades `chrome` -> `chromium` -> bundled, and that
 * degradation changes detectability without changing behaviour (F-32).
 */
try {
  const { chromium } = await import('patchright');
  let used = null;
  for (const channel of ['chrome', 'chromium', undefined]) {
    try {
      const b = await chromium.launch({ channel, headless: true, args: ['--no-sandbox'] });
      await b.close();
      used = channel ?? 'bundled-chromium';
      break;
    } catch { /* next */ }
  }
  if (!used) {
    bad('no browser could be launched', 'npm run browsers');
  } else if (used === 'chrome') {
    ok('browser', 'real Google Chrome — best anti-detection posture');
  } else {
    warn(
      `browser falls back to "${used}" — real Chrome is not installed`,
      'npm run browsers:chrome   (asks for your password — installs Chrome system-wide. '
        + 'stealth.js: a named channel does more for detectability than every JS patch '
        + 'combined; carrier behaviour on bundled Chromium is not representative)'
    );
  }
} catch (err) {
  bad(`could not load the browser driver: ${err.message.split('\n')[0]}`, 'npm run setup');
}

// -- 4. .env ------------------------------------------------------------------
const envPath = '.env';
if (!(await exists(envPath))) {
  bad('.env missing', 'npm run setup   (copies .env.example and generates a key)');
} else {
  const env = Object.fromEntries(
    (await readFile(envPath, 'utf8'))
      .split('\n')
      .filter((l) => l.trim() && !l.trim().startsWith('#') && l.includes('='))
      .map((l) => {
        const i = l.indexOf('=');
        return [l.slice(0, i).trim(), l.slice(i + 1).trim()];
      })
  );
  ok('.env present');

  // HEADLESS — the one that breaks a carrier with no error message.
  if (env.HEADLESS === 'false') {
    ok('HEADLESS=false', 'required for GEICO (F-40); on a server Chrome needs a desktop or Xvfb');
  } else {
    bad(
      `HEADLESS=${env.HEADLESS ?? '(unset, defaults true)'} — GEICO's login will stall`,
      'Set HEADLESS=false. Its POST /ws/login/authenticate returns 302 headless and '
        + '200 headed, and the SPA cannot follow the redirect, so login hangs with no error.'
    );
  }

  // Session key — silent MFA cost when absent.
  if (!env.SESSION_ENCRYPTION_KEY) {
    warn(
      'SESSION_ENCRYPTION_KEY not set — sessions will not survive a restart',
      'Every pull then pays a full human MFA round-trip, because the trusted-device '
        + 'cookie lives in the same store (F-44). Required in production; run '
        + '`npm run setup` to generate one.'
    );
  } else if (!/^[0-9a-f]{64}$/i.test(env.SESSION_ENCRYPTION_KEY)) {
    bad('SESSION_ENCRYPTION_KEY is not 64 hex characters', 'node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
  } else {
    ok('SESSION_ENCRYPTION_KEY', 'valid 32-byte key');
  }

  if (env.RESIDENTIAL_PROXY_URL) {
    ok('residential proxy configured');

    /**
     * Judge the template against the product, not in isolation.
     *
     * The two products fail oppositely: a rotating gateway needs a sticky username, a
     * dedicated IP is broken by one. Checking only for a missing `{session}` — as this
     * did — is silent on the more damaging case, a template set on a dedicated IP,
     * where it corrupts a username the provider expects verbatim and the resulting auth
     * failure looks like a blocked IP.
     */
    if (env.PROXY_MODEL === 'dedicated') {
      if (env.PROXY_USERNAME_TEMPLATE) {
        warn(
          'PROXY_USERNAME_TEMPLATE is set but PROXY_MODEL=dedicated',
          'A dedicated exit IP has no session concept. The template rewrites the username '
            + 'the provider expects, so authentication fails and looks like an IP block. Unset it.'
        );
      } else {
        ok('proxy model', 'dedicated exit IP; stickiness is inherent, no template needed');
      }
    } else if (env.PROXY_MODEL === 'rotating') {
      if (!env.PROXY_USERNAME_TEMPLATE) {
        warn(
          'PROXY_MODEL=rotating but no PROXY_USERNAME_TEMPLATE',
          'Every connection may exit from a different IP, so login, MFA and document fetch '
            + 'can each leave from a different address and the carrier will invalidate the session.'
        );
      } else if (!env.PROXY_USERNAME_TEMPLATE.includes('{session}')) {
        warn('PROXY_USERNAME_TEMPLATE has no {session} placeholder', 'Sessions will not be sticky, so login and document fetch may egress from different IPs.');
      } else {
        ok('proxy model', 'rotating gateway with a {session} template');
      }
    } else {
      warn(
        'PROXY_MODEL is not set',
        'Whether PROXY_USERNAME_TEMPLATE should be set depends on it, and the two answers '
          + 'are opposite. Run `npm run proxy:discover` to determine it.'
      );
    }

    /**
     * The management API key must not be present in production.
     *
     * It can order proxies and buy bandwidth. Nothing in the serving path reads it, so
     * its presence there is pure blast radius: a compromised container would leak
     * billing access on top of proxy access.
     */
    if (env.NODE_ENV === 'production' && (env.PROXYCHEAP_API_KEY || env.PROXYCHEAP_API_SECRET)) {
      warn(
        'PROXYCHEAP_API_* is set in production',
        'That key pair can spend money and the server never reads it. Keep it on the '
          + 'operator machine for `npm run proxy:discover`, and out of the deployment secret.'
      );
    }
  } else {
    warn(
      'no residential proxy — real carriers often block datacenter IPs',
      'Fine from a home connection: a GEICO login has been verified working with no '
        + 'proxy. Required once deployed, where the egress IP is a datacenter.'
    );
  }

  if (env.NODE_ENV === 'production' && !env.DIAGNOSTICS_TOKEN) {
    warn('NODE_ENV=production without DIAGNOSTICS_TOKEN', 'Diagnostic endpoints stay loopback-only without it, so logs are unreachable remotely.');
  }
}

// -- 5. Port ------------------------------------------------------------------
/**
 * A held port is worth checking because of how it fails: `npm start` appears to work,
 * a second process starts, and the one answering requests is whichever bound first —
 * which is how a stale server served old code while a fix sat on disk (F-38).
 */
const port = Number(process.env.PORT ?? 3000);
try {
  const { stdout } = await run('lsof', ['-ti', `:${port}`, '-sTCP:LISTEN']);
  const pid = stdout.trim().split('\n')[0];
  if (pid) {
    let cmd = '';
    try { cmd = (await run('ps', ['-o', 'command=', '-p', pid])).stdout.trim(); } catch { /* ignore */ }
    if (/node src\/server\.js/.test(cmd)) {
      warn(`port ${port} already served by this app (pid ${pid})`, 'npm run restart   (verifies the old process actually died)');
    } else {
      bad(`port ${port} is held by something else (pid ${pid})`, `Stop it, or set PORT. Holder: ${cmd.slice(0, 70) || 'unknown'}`);
    }
  } else {
    ok(`port ${port} free`);
  }
} catch {
  ok(`port ${port} free`);
}

// -- 6. Writable paths --------------------------------------------------------
for (const dir of ['data', 'logs']) {
  if (await exists(dir)) {
    ok(`${dir}/ exists`);
  } else {
    warn(`${dir}/ missing`, 'Created automatically on first run; only a problem if the volume is read-only.');
  }
}

// -- 7. Disk ------------------------------------------------------------------
/**
 * Checked because a full disk broke a Docker build in a way that read as a Docker
 * bug: `/var/lib/docker/tmp: read-only file system` (F-05). Browsers are ~500MB and
 * logs rotate at 200MB.
 */
try {
  const { stdout } = await run('df', ['-k', '.']);
  const freeKb = Number(stdout.trim().split('\n').pop().split(/\s+/)[3]);
  const freeGb = freeKb / 1024 / 1024;
  if (freeGb > 5) ok('disk space', `${freeGb.toFixed(1)}GB free`);
  else if (freeGb > 2) warn(`only ${freeGb.toFixed(1)}GB free`, 'Browsers need ~500MB and logs rotate at 200MB.');
  else bad(`only ${freeGb.toFixed(1)}GB free`, 'Free space before building an image — a full disk surfaces as a read-only filesystem error.');
} catch { /* df unavailable; not worth failing over */ }

// -- 8. Memory ----------------------------------------------------------------
const totalGb = os.totalmem() / 1024 ** 3;
if (totalGb >= 2) ok('memory', `${totalGb.toFixed(1)}GB total`);
else warn(`${totalGb.toFixed(1)}GB RAM`, 'Headed Chrome adds ~80-150MB RSS over headless; small hosts OOM and lose every live session.');

// -- summary ------------------------------------------------------------------
console.log('');
if (errors) {
  console.log(`\u001b[31m${errors} problem(s) will stop this working.\u001b[0m${warns ? `  ${warns} warning(s).` : ''}`);
  console.log('Fix the FAIL lines above, then re-run `npm run doctor`.\n');
  process.exit(1);
}
if (warns) {
  console.log(`\u001b[32mReady.\u001b[0m ${warns} warning(s) above — none block the demo portal.`);
  console.log('Start it:  npm start      then open http://localhost:' + port + '\n');
} else {
  console.log('\u001b[32mReady, no warnings.\u001b[0m');
  console.log('Start it:  npm start      then open http://localhost:' + port + '\n');
}
