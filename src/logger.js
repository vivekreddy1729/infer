import pino from 'pino';
import config from './config.js';
import RotatingFileStream from './logging/rotatingFile.js';

/**
 * Structured logging, written to disk by the application itself.
 *
 * Two destinations, always:
 *
 *   stdout  — what the hosting platform aggregates (CloudWatch, `docker logs`).
 *             Ephemeral: bounded retention, and gone when the machine is replaced.
 *   file    — durable, rotating, on the mounted volume. This is the copy you can
 *             actually hand to someone after the fact.
 *
 * The file sink is deliberately *not* shell redirection. Piping to `tee` works
 * until someone starts the process a different way — a `CMD` in a Dockerfile, a
 * process manager, a one-off `node src/server.js` while debugging — and then the
 * logs for the run you care about simply do not exist. Owning it in-process means
 * it cannot be forgotten.
 *
 * REDACTION
 *
 * These files are intended to be copied off the host and shared, which raises the
 * stakes on redaction considerably. This process handles live insurance portal
 * credentials and bearer tokens. Redaction is declared once, here, at the only
 * exit logs have, and `remove: true` drops the key entirely rather than printing
 * `[Redacted]` — so a leaked field cannot even be confirmed to have existed.
 *
 * Learned the hard way: an earlier version of the recording tool redacted the
 * `authorization` *header* but still logged request URLs, and Progressive's OAuth
 * flow puts its access token in a URL fragment. The secret escaped by a different
 * route than the one being guarded. So the string scrubber below also catches
 * JWT-shaped values and `*_token=` query parameters wherever they appear.
 */

const REDACT_PATHS = [
  'password',
  'username',
  'otp',
  'code',
  'credentials',
  'credentials.username',
  'credentials.password',
  'mfaCode',
  'proxy.password',
  'proxyUrl',
  'RESIDENTIAL_PROXY_URL',
  'cookies',
  'storageState',
  'authorization',
  'apiHeaders',
  'headers.authorization',
  'headers.cookie',
  'req.headers.authorization',
  'req.headers.cookie',
  '*.password',
  '*.username',
  '*.otp',
  '*.mfaCode',
  '*.authorization',
];

/**
 * Catches credential material embedded inside otherwise-legitimate strings —
 * error messages, URLs, call logs — which key-based redaction cannot see.
 */
const SCRUB_PATTERNS = [
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+/g, '<jwt>'],
  [/\beyJ[A-Za-z0-9_-]{20,}/g, '<jwt>'],
  [/((?:access_token|id_token|refresh_token)=)[^&\s#"]{12,}/gi, '$1<redacted>'],
  /**
   * The bare `token=` parameter matters because of this app's own diagnostics
   * endpoints: they accept `?token=<DIAGNOSTICS_TOKEN>` as an alternative to a
   * bearer header, and request logging is on. Without this, every authenticated
   * diagnostics fetch would write the diagnostics token into the very log file it
   * was protecting.
   */
  [/\b(token=)[^&\s#"]{8,}/gi, '$1<redacted>'],
  [/\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/gi, 'Bearer <redacted>'],
  [/\b\d{3}-\d{2}-\d{4}\b/g, '<ssn>'],
];

function scrub(value) {
  if (typeof value !== 'string') return value;
  let out = value;
  for (const [pattern, replacement] of SCRUB_PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

/**
 * True only for `{}`-style objects, not class instances.
 *
 * The distinction is load-bearing. See `scrubDeep`.
 */
function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * Applied to every log object before serialisation, to catch secrets embedded in
 * string values that key-based redaction cannot see.
 *
 * Crucially, this only rebuilds **plain objects and arrays** and passes class
 * instances through untouched.
 *
 * The earlier version rebuilt everything via `Object.entries`, and that quietly
 * broke request logging. `formatters.log` runs *before* serialisers, so it
 * received Fastify's `Request` instance — whose `method`, `url` and `ip` are
 * prototype getters, not own properties. Rebuilding it produced a plain object
 * containing only the own keys, so the prototype accessors vanished and the
 * serialiser that ran next found `req.method === undefined`. Every request
 * logged as `req={}`: logging that appeared to be enabled and working while
 * carrying no information at all.
 *
 * Class instances are therefore left alone, and the serialisers below scrub the
 * specific fields that need it.
 */
function scrubDeep(value, depth = 0) {
  if (depth > 6) return value;
  if (typeof value === 'string') return scrub(value);
  if (Array.isArray(value)) return value.map((v) => scrubDeep(v, depth + 1));
  if (isPlainObject(value)) {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = scrubDeep(v, depth + 1);
    return out;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Destinations
// ---------------------------------------------------------------------------

const streams = [];

/** Pretty output for humans in dev, raw NDJSON everywhere else. */
let prettyStream = null;
if (!config.isProd && process.env.NO_PRETTY !== '1') {
  try {
    const { default: pretty } = await import('pino-pretty');
    prettyStream = pretty({
      colorize: true,
      translateTime: 'HH:MM:ss.l',
      ignore: 'pid,hostname,service',
    });
  } catch {
    // pino-pretty is a devDependency; absence is expected in production images.
  }
}
streams.push({ stream: prettyStream ?? process.stdout });

export let fileSink = null;
if (config.LOG_TO_FILE) {
  try {
    fileSink = new RotatingFileStream({
      dir: config.LOG_DIR,
      filename: 'app.log',
      maxBytes: config.LOG_MAX_BYTES,
      maxFiles: config.LOG_MAX_FILES,
    });
    // Always NDJSON on disk regardless of the console format, so the file stays
    // machine-readable and greppable by sessionId.
    streams.push({ stream: fileSink, level: 'trace' });
  } catch (err) {
    // Never let an unwritable log directory stop the service from starting.
    // eslint-disable-next-line no-console
    console.error(`file logging disabled: ${err.message}`);
  }
}

export const logger = pino(
  {
    level: config.LOG_LEVEL,
    redact: { paths: REDACT_PATHS, remove: true },
    base: { service: 'carrier-policy-puller', pid: process.pid },

    /**
     * Explicit serialisers for Fastify's request and response objects.
     *
     * Required, and the reason is subtle. Fastify normally installs its own
     * serialisers, but it does not when given a pre-built `loggerInstance` —
     * which this app does, so that file logging is owned here. Without them the
     * raw `Request` lands in the formatter below, and because its fields are
     * prototype getters rather than own properties, `Object.entries` sees nothing
     * and every request logs as `req={}`.
     *
     * That was the observed symptom: request logging looked enabled and produced
     * entries containing no information whatsoever. Picking the fields explicitly
     * also keeps headers out by default, which is the safer posture for files
     * intended to be shared.
     */
    serializers: {
      // Falls back to `.raw` so this works whether Fastify hands us its Request
      // wrapper or the underlying Node IncomingMessage.
      req: (req) => ({
        id: req?.id,
        method: req?.method ?? req?.raw?.method,
        // Scrubbed: query strings can carry the diagnostics token.
        url: scrub(req?.url ?? req?.raw?.url ?? ''),
        ip: req?.ip ?? req?.socket?.remoteAddress ?? req?.raw?.socket?.remoteAddress,
        userAgent: req?.headers?.['user-agent'] ?? req?.raw?.headers?.['user-agent'],
      }),
      res: (res) => ({ statusCode: res?.statusCode ?? res?.raw?.statusCode }),
      err: pino.stdSerializers.err,
    },

    // Runs over the merged log object, catching secrets embedded in strings that
    // key-based redaction cannot see.
    formatters: {
      log: (obj) => scrubDeep(obj),
    },
  },
  pino.multistream(streams, { dedupe: false })
);

/** Child logger scoped to one pull attempt. */
export function sessionLogger(sessionId, carrierId) {
  return logger.child({ sessionId, carrierId });
}

/**
 * Route process-level faults into the log.
 *
 * Without this, the most serious failures are the ones that leave no trace: an
 * uncaught exception prints to stderr and dies, and if stderr was not being
 * captured there is nothing left to read afterwards.
 */
export function installCrashHandlers() {
  process.on('uncaughtException', (err) => {
    logger.fatal({ err: err.message, stack: err.stack }, 'uncaught exception');
    // Give the file sink a moment to flush before the process goes away.
    setTimeout(() => process.exit(1), 250);
  });
  process.on('unhandledRejection', (reason) => {
    logger.error(
      { err: reason instanceof Error ? reason.message : String(reason), stack: reason?.stack },
      'unhandled promise rejection'
    );
  });
  process.on('warning', (warning) => {
    logger.warn({ name: warning.name, message: warning.message }, 'process warning');
  });
}

export { scrub };
export default logger;
