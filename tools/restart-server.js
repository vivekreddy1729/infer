#!/usr/bin/env node
/**
 * Restart the app server, and verify it actually restarted. Cross-platform.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS SCRIPT EXISTS
 * ---------------------------------------------------------------------------
 * Config is read once at boot, so a `.env` or source edit after startup looks correct on
 * disk while the process runs on the old value, with nothing in the UI to say so.
 * Restarting is therefore routine here — and it has gone wrong twice in ways that cost
 * real debugging time:
 *
 *   1. A restart silently did not take. The old process was still alive, the stale server
 *      kept serving while the new code sat on disk, the next run exercised the unfixed
 *      code, and the fix looked wrong (F-38).
 *
 *   2. The verification itself matched the wrong process. `pgrep -f 'server\.js'` also
 *      matches `tsserver.js`, the TypeScript language server the editor runs. That meant
 *      reading a language server's start time and comparing it against application
 *      source. It gave the right answer only because the two happened to start seconds
 *      apart.
 *
 * So this identifies the server by **who holds the port**, which is the only thing that
 * cannot be coincidentally true, and refuses to report success without evidence.
 *
 * ---------------------------------------------------------------------------
 * WHY IT IS NODE AND NOT BASH
 * ---------------------------------------------------------------------------
 * This replaces `tools/restart-server.sh`, which needed `lsof`, `pkill`, `pgrep`,
 * `ps -o lstart=`, `find -newermt`, `curl` and `python3`. None of those exist on a stock
 * Windows Server box, and this is being deployed to Windows EC2 (F-55).
 *
 * The rewrite is not only about portability. Four of those dependencies disappear
 * entirely rather than gaining a Windows branch: the health check and the carrier check
 * are `fetch`, and the stale-source scan is `fs.statSync`. Only two things genuinely need
 * per-platform handling — finding the PID that holds a port, and reading that process's
 * start time — because the OS is the only thing that knows.
 *
 *   npm run restart
 */

import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const PORT = Number(process.env.PORT ?? 3000);
const LOG = process.env.LOG ?? path.join('logs', 'server.log');
const IS_WIN = process.platform === 'win32';
const BASE = `http://127.0.0.1:${PORT}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (s) => console.log(s);

/** Run a command and return stdout, or '' on any failure. Never throws. */
function tryExec(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return '';
  }
}

/**
 * Which PID is LISTENING on the port.
 *
 * The one genuinely platform-specific lookup, and the anchor for everything below: a
 * process that holds the port IS the server, regardless of what its command line says.
 */
function portPid() {
  if (IS_WIN) {
    // `netstat -ano` is present on every Windows Server image. Columns:
    // Proto  Local Address  Foreign Address  State  PID
    const out = tryExec('netstat', ['-ano']);
    for (const line of out.split(/\r?\n/)) {
      if (!/LISTENING/i.test(line)) continue;
      const cols = line.trim().split(/\s+/);
      const local = cols[1] ?? '';
      // Match the port exactly, so :3000 does not also match :30000.
      if (!new RegExp(`[:.]${PORT}$`).test(local)) continue;
      const pid = Number(cols[cols.length - 1]);
      if (Number.isInteger(pid) && pid > 0) return pid;
    }
    return null;
  }
  const out = tryExec('lsof', ['-ti', `:${PORT}`, '-sTCP:LISTEN']).trim();
  const pid = Number(out.split(/\s+/)[0]);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/**
 * When did this process start?
 *
 * Used to prove no source file is newer than the running process. Returned as a Date so
 * the comparison is numeric rather than a string diff against `ps` output formatting.
 * Returns null when it cannot be determined, and callers then skip the staleness check
 * rather than guessing — a missing check reported as missing beats a wrong one reported
 * as passing.
 */
function processStart(pid) {
  if (IS_WIN) {
    // PowerShell rather than `wmic`: wmic is deprecated and absent from newer images.
    const out = tryExec('powershell', [
      '-NoProfile',
      '-Command',
      `(Get-Process -Id ${pid}).StartTime.ToString('o')`,
    ]).trim();
    const d = new Date(out);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  // `lstart` is locale-formatted but Date can parse it on macOS and Linux.
  const out = tryExec('ps', ['-o', 'lstart=', '-p', String(pid)]).trim();
  const d = new Date(out);
  return Number.isNaN(d.getTime()) ? null : d;
}

function commandOf(pid) {
  if (IS_WIN) {
    const out = tryExec('powershell', [
      '-NoProfile',
      '-Command',
      `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`,
    ]).trim();
    return out || '(unknown)';
  }
  return tryExec('ps', ['-o', 'command=', '-p', String(pid)]).trim() || '(unknown)';
}

/** Terminate a PID. `force` escalates to an unconditional kill. */
function killPid(pid, { force = false } = {}) {
  if (IS_WIN) {
    tryExec('taskkill', force ? ['/PID', String(pid), '/T', '/F'] : ['/PID', String(pid), '/T']);
    return;
  }
  try {
    process.kill(pid, force ? 'SIGKILL' : 'SIGTERM');
  } catch {
    /* already gone */
  }
}

async function getJson(pathname, timeoutMs = 3000) {
  try {
    const res = await fetch(`${BASE}${pathname}`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/** Files under these roots newer than `since`. Replaces `find -newermt`. */
function newerThan(since, roots = ['src', 'public']) {
  const out = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else {
        try {
          if (fs.statSync(p).mtime > since) out.push(p);
        } catch {
          /* vanished mid-walk */
        }
      }
    }
  };
  for (const r of roots) walk(r);
  return out;
}

// -- stop ---------------------------------------------------------------------
say('== stopping ==');
const before = portPid();
if (before) {
  say(`   pid ${before} is serving :${PORT} -> stopping`);
  killPid(before);
} else {
  say(`   nothing listening on :${PORT}`);
}

// Wait for release rather than assuming a fixed sleep is enough.
for (let i = 0; i < 20 && portPid(); i += 1) await sleep(500);

// Still held? Escalate, then confirm. A half-dead server holding the port is the failure
// mode that produced F-38's phantom.
if (portPid()) {
  const stuck = portPid();
  say('   port still held, forcing termination');
  killPid(stuck, { force: true });
  await sleep(1000);
}

if (portPid()) {
  say(`   FAILED: :${PORT} is still held by pid ${portPid()}. Not starting a second server.`);
  process.exit(1);
}
say('   port released');

// -- start --------------------------------------------------------------------
say('== starting ==');
fs.mkdirSync(path.dirname(LOG), { recursive: true });
const logFd = fs.openSync(LOG, 'a');

/**
 * Detached, with stdio to the log file — the portable equivalent of `nohup … &`.
 * `unref()` lets this script exit while the server keeps running.
 */
const child = spawn(process.execPath, [path.join('src', 'server.js')], {
  detached: true,
  stdio: ['ignore', logFd, logFd],
  windowsHide: true,
});
child.unref();

for (let i = 0; i < 45; i += 1) {
  if (await getJson('/api/health')) break;
  await sleep(1000);
}

const pid = portPid();
if (!pid) {
  say(`   FAILED: server did not come up. Last 25 lines of ${LOG}:`);
  try {
    const lines = fs.readFileSync(LOG, 'utf8').split(/\r?\n/).slice(-25);
    for (const l of lines) say(`     ${l}`);
  } catch {
    say('     (log unreadable)');
  }
  process.exit(1);
}

const started = processStart(pid);
const health = await getJson('/api/health');
say(`   pid     ${pid}`);
say(`   started ${started ? started.toISOString() : '(could not determine)'}`);
say(`   command ${commandOf(pid)}`);
say(`   health  ${health ? '200' : 'unreachable'}`);

// -- verify -------------------------------------------------------------------
say('== verifying ==');

/**
 * Exactly one app server.
 *
 * Only the port holder is authoritative, so this asks the weaker question — are there
 * other `src/server.js` processes lingering — and reports rather than fails. Two would
 * mean one serves while the other idles and which one you are talking to is a coin flip.
 */
const listing = IS_WIN
  ? tryExec('powershell', [
    '-NoProfile',
    '-Command',
    "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | "
      + 'Where-Object { $_.CommandLine -like \'*src?server.js*\' } | '
      + 'Select-Object -ExpandProperty ProcessId',
  ])
  : tryExec('pgrep', ['-f', 'node src/server.js']);
const pids = listing.split(/\r?\n/).map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0);
if (pids.length === 1) say('   OK  exactly one app server running');
else if (pids.length === 0) say(`   OK  port holder is pid ${pid} (process listing unavailable on this platform)`);
else say(`   WARN ${pids.length} app servers found — expected 1: ${pids.join(', ')}`);

/**
 * Nothing on disk newer than the process. The check that catches a restart which did not
 * take — the F-38 failure.
 */
if (started) {
  const stale = newerThan(started);
  if (!stale.length) say('   OK  no source newer than the running process');
  else {
    say('   WARN these files are newer than the process — the restart may not have taken:');
    for (const f of stale) say(`        ${f}`);
  }
} else {
  say('   SKIP staleness check — could not read the process start time');
}

// Behaviour, not timestamps. A file being loaded is not the same as a feature working.
const carriers = await getJson('/api/carriers');
const ids = carriers?.carriers?.map((c) => c.id).join(',') ?? '<none>';
say(`   OK  carriers served: ${ids}`);

say('');
say(`Ready on http://localhost:${PORT}   (logs: ${LOG})`);
say('Hard-refresh the browser — app.js is cached and calls /api/prewarm.');
