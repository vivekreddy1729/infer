import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import config from '../config.js';
import logger, { fileSink } from '../logger.js';

/**
 * Reads back what the logger wrote, and assembles hand-over-ready bundles.
 *
 * The problem this solves: when this runs somewhere you cannot attach a terminal
 * to, "please send me the logs" is a surprisingly hard request to satisfy. The
 * platform's log viewer has short retention, is hard to filter to one run, and
 * cannot be copied out as a file. So the app can produce, on demand, a single
 * self-contained JSON document describing one failed run — logs, state timeline,
 * timings, carrier internals, environment — that is enough to debug from without
 * access to the machine.
 */

const log = logger.child({ module: 'diagnostics' });

/**
 * Read log lines newest-first, optionally filtered.
 *
 * Reads whole files rather than streaming because the rotation cap bounds them
 * at `LOG_MAX_BYTES`, and simplicity is worth more here than saving memory on a
 * debugging path.
 */
export async function readLogLines({ limit = 500, sessionId, level, since } = {}) {
  if (!fileSink) return { available: false, lines: [], reason: 'file logging is disabled' };

  const wanted = level ? LEVELS[level] ?? 0 : 0;
  const collected = [];

  // Newest file first, so `limit` keeps the most recent lines.
  for (const file of fileSink.files()) {
    let raw;
    try {
      raw = await fs.readFile(file, 'utf8');
    } catch {
      continue;
    }

    const lines = raw.split('\n');
    // Walk backwards: recent entries are at the end of each file.
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const line = lines[i];
      if (!line.trim()) continue;

      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        // A torn line from a rotation boundary or an abrupt exit. Skip it.
        continue;
      }

      if (sessionId && entry.sessionId !== sessionId) continue;
      if (wanted && (entry.level ?? 0) < wanted) continue;
      if (since && (entry.time ?? 0) < since) continue;

      collected.push(entry);
      if (collected.length >= limit) {
        return { available: true, lines: collected.reverse(), truncated: true };
      }
    }
  }

  return { available: true, lines: collected.reverse(), truncated: false };
}

const LEVELS = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60 };

/** What the operator can fetch, and how big it is. */
export async function index() {
  const files = fileSink?.stats() ?? [];
  let failures = [];
  try {
    const dir = path.join(path.resolve(config.LOG_DIR), 'failures');
    failures = (await fs.readdir(dir)).sort().reverse().slice(0, 50);
  } catch {
    /* none yet */
  }

  return {
    fileLogging: Boolean(fileSink),
    logDir: path.resolve(config.LOG_DIR),
    files,
    totalBytes: files.reduce((a, f) => a + f.bytes, 0),
    failureBundles: failures,
    endpoints: {
      index: '/api/diagnostics',
      logsJson: '/api/diagnostics/logs?limit=500&level=warn&sessionId=<id>',
      logsText: '/api/diagnostics/logs.txt?limit=2000',
      sessionBundle: '/api/diagnostics/sessions/<sessionId>',
      failureBundle: '/api/diagnostics/failures/<filename>',
    },
  };
}

/**
 * Environment snapshot.
 *
 * Config values are reported as booleans and shapes, never values: the point is
 * to answer "was the proxy configured, was blocking on, which browser channel"
 * without putting a proxy URL or an encryption key into a file that is about to
 * be emailed.
 */
export function environmentSnapshot({ browserPool } = {}) {
  return {
    at: Date.now(),
    node: process.version,
    platform: `${os.platform()} ${os.release()} ${os.arch()}`,
    uptimeSec: Math.round(process.uptime()),
    memory: {
      rssMb: Math.round(process.memoryUsage().rss / 1048576),
      heapUsedMb: Math.round(process.memoryUsage().heapUsed / 1048576),
      systemFreeMb: Math.round(os.freemem() / 1048576),
    },
    browser: browserPool
      ? {
          driver: browserPool.driverName,
          channel: browserPool.channel,
          ready: browserPool.isReady,
          openContexts: browserPool.openContextCount,
        }
      : null,
    config: {
      nodeEnv: config.NODE_ENV,
      headless: config.HEADLESS,
      browserDriver: config.BROWSER_DRIVER,
      resourceBlocking: config.BLOCK_RESOURCES,
      proxyConfigured: Boolean(config.RESIDENTIAL_PROXY_URL),
      proxyStickyConfigured: Boolean(config.PROXY_USERNAME_TEMPLATE),
      mockCarrier: config.ENABLE_MOCK_CARRIER,
      logToFile: config.LOG_TO_FILE,
      sessionKeyProvided: Boolean(process.env.SESSION_ENCRYPTION_KEY),
      /**
       * Which document the process will fetch.
       *
       * Included because "it pulled the wrong document" is a question about
       * configuration, and the values are read once at boot — so a `.env` edited
       * after start looks correct on disk while the process runs on the old
       * setting. Reporting what is actually loaded makes that discrepancy
       * visible instead of leaving it to be inferred from file timestamps.
       */
      documentTarget: config.DOCUMENT_TARGET,
      documentLimit: config.DOCUMENT_LIMIT,
    },
    warnings: config.warnings,
  };
}

/**
 * Everything needed to debug one run, in one document.
 *
 * `session` may be null when the run has already been reaped, in which case the
 * log lines carry the story on their own — which is the main reason logs are
 * filtered by `sessionId` rather than only kept in memory.
 */
export async function buildSessionBundle(sessionId, { session, browserPool } = {}) {
  const { lines, available } = await readLogLines({ sessionId, limit: 2000 });

  return {
    kind: 'session-diagnostic-bundle',
    version: 1,
    generatedAt: new Date().toISOString(),
    sessionId,
    note:
      'Credential material is redacted at the logger. Safe to share for debugging. ' +
      'Contains portal URLs, timings and state transitions, but no passwords, codes, cookies or tokens.',
    session: session
      ? {
          carrierId: session.carrierId,
          state: session.state,
          createdAt: session.createdAt,
          warmPath: Boolean(session.warmPath),
          resumed: Boolean(session.resumed),
          timeline: session.machine.timeline,
          timings: session.timings?.summary?.() ?? null,
          result: session.result
            ? {
                // Metadata only: never the document bytes.
                documents: session.result.documents?.map((d) => ({
                  label: d.label,
                  kind: d.kind,
                  mime: d.mime,
                  bytes: d.bytes,
                })),
                transport: session.result.transport,
                warmPath: session.result.warmPath,
              }
            : null,
        }
      : { note: 'session no longer in memory; reconstructed from logs only' },
    environment: environmentSnapshot({ browserPool }),
    logs: { available, count: lines.length, lines },
  };
}

/**
 * Persist a bundle for a failed run.
 *
 * Written automatically so the evidence exists whether or not anyone thought to
 * collect it at the time. Filenames are sortable and describe the failure, so a
 * directory listing is already a useful summary.
 */
export async function writeFailureBundle(bundle) {
  if (!config.LOG_FAILURE_BUNDLES) return null;
  try {
    const dir = path.join(path.resolve(config.LOG_DIR), 'failures');
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const carrier = bundle.session?.carrierId ?? 'unknown';
    const code =
      bundle.session?.timeline?.findLast?.((t) => t.detail?.code)?.detail?.code ?? 'ERROR';
    const file = path.join(dir, `${stamp}_${carrier}_${code}.json`);

    await fs.writeFile(file, JSON.stringify(bundle, null, 2), { mode: 0o600 });
    await pruneFailureBundles(dir);
    log.info({ file: path.basename(file) }, 'wrote failure diagnostic bundle');
    return file;
  } catch (err) {
    log.warn({ err: err.message }, 'could not write failure bundle');
    return null;
  }
}

/** Keep the newest 100 bundles; they are small but unbounded otherwise. */
async function pruneFailureBundles(dir, keep = 100) {
  try {
    const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.json')).sort();
    for (const f of files.slice(0, Math.max(0, files.length - keep))) {
      await fs.rm(path.join(dir, f), { force: true });
    }
  } catch {
    /* ignore */
  }
}

export async function readFailureBundle(filename) {
  // Defend against traversal: this path is built from a URL parameter.
  const safe = path.basename(String(filename));
  if (!safe.endsWith('.json')) return null;
  const file = path.join(path.resolve(config.LOG_DIR), 'failures', safe);
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

/** Human-readable rendering, for pasting into an issue or a chat. */
export function linesToText(lines) {
  const names = { 10: 'TRACE', 20: 'DEBUG', 30: 'INFO', 40: 'WARN', 50: 'ERROR', 60: 'FATAL' };
  return lines
    .map((e) => {
      const ts = new Date(e.time ?? 0).toISOString();
      const lvl = (names[e.level] ?? String(e.level ?? '?')).padEnd(5);
      const scope = [e.module, e.carrierId, e.sessionId?.slice(0, 8)].filter(Boolean).join('/');
      const extra = Object.entries(e)
        .filter(
          ([k]) =>
            !['level', 'time', 'msg', 'service', 'pid', 'module', 'carrierId', 'sessionId', 'hostname'].includes(k)
        )
        .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`)
        .join(' ');
      return `${ts} ${lvl} ${scope ? `[${scope}] ` : ''}${e.msg ?? ''}${extra ? `  ${extra}` : ''}`;
    })
    .join('\n');
}

export default {
  readLogLines,
  index,
  environmentSnapshot,
  buildSessionBundle,
  writeFailureBundle,
  readFailureBundle,
  linesToText,
};
