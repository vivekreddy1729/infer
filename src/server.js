import crypto from 'node:crypto';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import fastifyFormbody from '@fastify/formbody';
import fastifyCookie from '@fastify/cookie';
import fastifyRateLimit from '@fastify/rate-limit';
import { z } from 'zod';

import config from './config.js';
import logger, { installCrashHandlers, fileSink } from './logger.js';
import diagnostics from './diagnostics/diagnostics.js';
import browserPool from './browser/browserPool.js';
import warmPagePool from './browser/warmPagePool.js';
import { checkEgressIp, buildProxyConfig, newStickySessionId } from './browser/proxy.js';
import { describeProxyConfig } from './browser/proxyHealth.js';
import { getEgressStatus } from './browser/egressStatus.js';
import { KNOWN_GAPS } from './browser/stealth.js';
import { carriers, getCarrier, listCarriers } from './carriers/registry.js';
import sessionManager from './session/sessionManager.js';
import storageStateStore from './storage/storageStateStore.js';
import metricsStore from './telemetry/metricsStore.js';
import { getDocument, stats as documentStats } from './storage/documentStore.js';
import mockPortalRoutes from './mockPortal/routes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

installCrashHandlers();

const app = Fastify({
  loggerInstance: logger,
  bodyLimit: 64 * 1024,
  /**
   * Deployed behind a load balancer (an AWS ALB on the current target), so trust the
   * edge's forwarding headers to get real client IPs in logs and in rate limiting.
   *
   * Without this every request appears to come from the load balancer, which would make
   * the `/api/sessions` rate limit global rather than per-client — one user's retries
   * would lock out everyone.
   */
  trustProxy: true,
  /**
   * Request logging is ON.
   *
   * It is verbose, but it is what turns a pile of log lines into a timeline, and
   * a timeline is the thing that makes a failure debuggable after the fact by
   * someone who was not watching. Set LOG_REQUESTS=false to quieten it.
   *
   * Also assigns a request id to every line, so a browser-side failure can be
   * correlated with the server work that caused it.
   */
  disableRequestLogging: !config.LOG_REQUESTS,
  genReqId: () => crypto.randomBytes(8).toString('hex'),
});

await app.register(fastifyFormbody);
await app.register(fastifyCookie);
await app.register(fastifyWebsocket, { options: { maxPayload: 32 * 1024 } });

/**
 * Rate limiting matters more than usual here. Every accepted request spawns a
 * browser context and, on real carriers, burns metered residential bandwidth and
 * pushes login attempts at a third party that will lock the account. Cheap to
 * add, expensive to omit.
 */
await app.register(fastifyRateLimit, {
  global: false,
  max: 10,
  timeWindow: '1 minute',
});

// -- Validation ---------------------------------------------------------------

const startSchema = z.object({
  carrierId: z.string().min(1).max(64),
  username: z.string().min(1).max(320),
  password: z.string().min(1).max(512),
});

/**
 * Flatten a state-machine timeline entry into a wire message.
 *
 * The machine keeps state-specific payload nested under `detail` so the core
 * fields stay a fixed shape internally. Clients would rather not reach through
 * two levels for every field, so the nesting is collapsed exactly once, here at
 * the transport boundary, giving `msg.documents`, `msg.timings`, `msg.channel`
 * and so on directly.
 */
const toWire = (entry) => ({
  state: entry.state,
  message: entry.message,
  at: entry.at,
  elapsedMs: entry.elapsedMs,
  ...(entry.detail ?? {}),
});

// -- API ----------------------------------------------------------------------

app.get('/api/carriers', async () => ({ carriers: listCarriers() }));

/**
 * Signal that a user is about to sign in to a carrier.
 *
 * Called by the UI when a carrier is selected, so a login page can be parked
 * while the user types. Takes **no credentials** — the whole point of the warm
 * pool is that everything before "type into the form" is anonymous.
 *
 * Deliberately demand-driven rather than a background timer: continuously
 * reloading carrier login pages from one residential IP with no logins is a
 * recognisable pattern, and the opposite of what the rest of the anti-bot work
 * is for. Rate limited for the same reason.
 *
 * Returns immediately; preparation continues in the background. A caller never
 * needs to wait, and a failure here cannot affect a subsequent pull.
 */
app.post(
  '/api/prewarm',
  { config: { rateLimit: { max: 12, timeWindow: '1 minute' } } },
  async (request, reply) => {
    const carrierId = String(request.body?.carrierId ?? '');
    const carrierClass = getCarrier(carrierId);
    if (!carrierClass) return reply.code(400).send({ error: 'Unsupported carrier.' });
    const result = await warmPagePool.ensureFresh(carrierClass);

    /**
     * Log which carrier was asked for.
     *
     * This was missing, and its absence made a user question unanswerable: they
     * reported seeing a Progressive login window open when they wanted GEICO, and
     * the logs recorded only that `/api/prewarm` had been called — never for what.
     * Under headed mode every prewarm is a visible window, so "which carrier
     * requested this" went from a detail to the first thing you need to know.
     */
    request.log.info(
      { carrierId, outcome: result?.reason ?? (result?.ready ? 'ready' : 'requested') },
      'pre-warm requested'
    );
    return reply.send({ carrierId, ...result });
  }
);

/**
 * Aggregated phase timings across every recorded run.
 *
 * Filters exist because mixing workloads produces a number that describes none
 * of them: a warm run skips login and MFA entirely, so averaging it with a cold
 * run understates the cold path and overstates the warm one.
 *
 *   /api/metrics
 *   /api/metrics?carrierId=progressive,demo&path=cold,warm
 *   /api/metrics?outcome=COMPLETED,ERROR         (failures included)
 *   /api/metrics?window=exclBoth                 (drop MFA wait + transfer)
 *   /api/metrics?sinceHours=24
 */
app.get('/api/metrics', async (request) => {
  const { carrierId, path: pathFilter, outcome, window, sinceHours } = request.query ?? {};
  const sinceMs = sinceHours ? Date.now() - Number(sinceHours) * 3_600_000 : undefined;
  return metricsStore.aggregate({
    // Comma-separated or repeated params; the store normalises both.
    carrierId: carrierId || undefined,
    path: pathFilter || undefined,
    outcome: outcome || undefined,
    window: window || undefined,
    sinceMs: Number.isFinite(sinceMs) ? sinceMs : undefined,
  });
});

/** Raw records, for ad-hoc analysis outside the browser. */
app.get('/api/metrics/raw', async () => ({ runs: await metricsStore.readAll() }));

// -- Diagnostics --------------------------------------------------------------

/**
 * Access control for the diagnostics endpoints.
 *
 * These serve application logs. Logs are redacted at the logger — no passwords,
 * codes, cookies or tokens — but they still describe a specific person's session
 * with their insurance carrier, including timings and portal URLs. That is not
 * public information, so the endpoints are not public.
 *
 *   DIAGNOSTICS_TOKEN set    -> bearer token required (use this in production)
 *   DIAGNOSTICS_TOKEN unset  -> loopback only, so local development just works
 *
 * Defaulting to loopback-only rather than open is the important part: a deployment
 * that forgets to set the token is locked down, not silently exposed. It fails
 * closed.
 */
function assertDiagnosticsAllowed(request, reply) {
  if (config.DIAGNOSTICS_TOKEN) {
    const header = request.headers.authorization ?? '';
    const bearer = header.startsWith('Bearer ') ? header.slice(7) : null;
    const supplied = bearer ?? request.query?.token;
    // Constant-time comparison: a length-dependent early return would leak the
    // token a character at a time to anyone willing to measure.
    const ok =
      typeof supplied === 'string' &&
      supplied.length === config.DIAGNOSTICS_TOKEN.length &&
      crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(config.DIAGNOSTICS_TOKEN));
    if (!ok) {
      reply.code(401).send({ error: 'Diagnostics require a valid token.' });
      return false;
    }
    return true;
  }

  const ip = request.ip ?? '';
  const loopback = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
  if (!loopback) {
    reply.code(403).send({
      error:
        'Diagnostics are restricted to loopback. Set DIAGNOSTICS_TOKEN to enable remote access.',
    });
    return false;
  }
  return true;
}

app.get('/api/diagnostics', async (request, reply) => {
  if (!assertDiagnosticsAllowed(request, reply)) return reply;
  return {
    ...(await diagnostics.index()),
    environment: diagnostics.environmentSnapshot({ browserPool }),
  };
});

app.get('/api/diagnostics/logs', async (request, reply) => {
  if (!assertDiagnosticsAllowed(request, reply)) return reply;
  const { limit, level, sessionId, sinceHours } = request.query ?? {};
  return diagnostics.readLogLines({
    limit: Math.min(Number(limit) || 500, 10_000),
    level: level || undefined,
    sessionId: sessionId || undefined,
    since: sinceHours ? Date.now() - Number(sinceHours) * 3_600_000 : undefined,
  });
});

/** Plain-text download, for pasting into a bug report. */
app.get('/api/diagnostics/logs.txt', async (request, reply) => {
  if (!assertDiagnosticsAllowed(request, reply)) return reply;
  const { limit, level, sessionId } = request.query ?? {};
  const { lines } = await diagnostics.readLogLines({
    limit: Math.min(Number(limit) || 2000, 20_000),
    level: level || undefined,
    sessionId: sessionId || undefined,
  });
  return reply
    .type('text/plain; charset=utf-8')
    .header('content-disposition', `attachment; filename="carrier-puller-${Date.now()}.log"`)
    .send(diagnostics.linesToText(lines));
});

/** Everything about one run, in one shareable document. */
app.get('/api/diagnostics/sessions/:sessionId', async (request, reply) => {
  if (!assertDiagnosticsAllowed(request, reply)) return reply;
  const { sessionId } = request.params;
  const bundle = await diagnostics.buildSessionBundle(sessionId, {
    session: sessionManager.get(sessionId),
    browserPool,
  });
  return reply
    .header('content-disposition', `attachment; filename="session-${sessionId.slice(0, 8)}.json"`)
    .send(bundle);
});

app.get('/api/diagnostics/failures/:filename', async (request, reply) => {
  if (!assertDiagnosticsAllowed(request, reply)) return reply;
  const bundle = await diagnostics.readFailureBundle(request.params.filename);
  if (!bundle) return reply.code(404).send({ error: 'No such failure bundle.' });
  return bundle;
});

/**
 * The egress IP, for the badge shown on every page.
 *
 * Separate from `/api/health` because every open tab polls it, so it has to stay cheap.
 * `getEgressStatus()` serves from a 5-minute cache and prefers a running pull's pinned
 * IP over probing at all — measuring the browser's exit costs an HTTPS request *through
 * the proxy*, and residential bandwidth is metered at roughly $4/GB. A badge that
 * refreshed on every page load would quietly bill for the privilege of telling you
 * something that changes every few minutes at most.
 *
 * `?probe=0` lets the UI render instantly from cache and ask for a real measurement
 * only when the user clicks refresh.
 */
app.get(
  '/api/egress',
  { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
  async (request) => {
    const allowProbe = request.query?.probe !== '0';
    return getEgressStatus({
      allowProbe,
      /**
       * Opening a proxied context is the only way to see what a carrier sees.
       *
       * Passed as a factory so the status module never imports the pool, and so the
       * lease is released through the same object it hands back — a leaked context
       * holds a browser process and, on a metered proxy, an idle sticky session.
       */
      browserFactory: async () => {
        const lease = await browserPool.acquireContext({
          proxy: buildProxyConfig(newStickySessionId()),
        });
        return { request: lease.context.request, close: () => lease.release() };
      },
    });
  }
);

/**
 * Serve the deployment guides.
 *
 * Reachable on a deployed instance on purpose: the document explains how the thing you
 * are looking at was deployed, and the moment you need it is usually while logged into
 * something that is misbehaving — not while you have the repo open.
 *
 * `/deploy` is the **current** target, Windows EC2. The ECS Fargate guide stays reachable
 * at `/deploy/fargate` rather than being deleted, because its service-elimination
 * reasoning (F-49) still holds and the Windows document cites it. Serving the current one
 * at the short path matters: someone reaching for this while debugging should not have to
 * work out which of two guides describes the box they are on.
 */
const DEPLOY_GUIDES = {
  '/deploy': 'windows-ec2-deployment.html',
  '/deploy/fargate': 'aws-deployment.html',
};

for (const [route, filename] of Object.entries(DEPLOY_GUIDES)) {
  app.get(route, async (request, reply) => {
    const file = path.join(process.cwd(), 'docs', filename);
    try {
      return reply.type('text/html; charset=utf-8').send(await readFile(file, 'utf8'));
    } catch {
      /**
       * A 404 here is expected, not broken.
       *
       * `docs/` is deliberately not in the public repository, so a plain `git clone`
       * has no guide to serve. The route stays because the directory may be copied
       * onto a host by an operator who wants it reachable while debugging — which is
       * the whole reason for serving it over HTTP. Saying so beats a bare 404 that
       * reads like a routing bug.
       */
      return reply.code(404).send({
        error: `docs/${filename} is not present on this host.`,
        why: 'docs/ is not published in the repository. Copy it onto the host to serve it here.',
      });
    }
  });
}

app.get('/api/health', async () => {
  const egress = await checkEgressIp();
  return {
    ok: true,
    uptimeSec: Math.round(process.uptime()),
    browser: {
      ready: browserPool.isReady,
      driver: browserPool.driverName,
      channel: browserPool.channel,
      openContexts: browserPool.openContextCount,
    },
    sessions: { live: sessionManager.size },
    prewarm: warmPagePool.stats(),
    // Reports configuration shape and is explicit that stickiness is unverified
    // until `npm run proxy:verify` is run. Never credentials.
    proxy: describeProxyConfig(),
    documents: documentStats(),
    egress,
    config: {
      proxyConfigured: Boolean(config.RESIDENTIAL_PROXY_URL),
      proxyStickyConfigured: Boolean(config.PROXY_USERNAME_TEMPLATE),
      resourceBlocking: config.BLOCK_RESOURCES,
      headless: config.HEADLESS,
      mockCarrier: config.ENABLE_MOCK_CARRIER,
      // Surfaced on the unauthenticated health endpoint too: it is not sensitive,
      // and it answers "which document will this fetch" without needing the
      // diagnostics token.
      documentTarget: config.DOCUMENT_TARGET,
      documentLimit: config.DOCUMENT_LIMIT,
    },
    knownGaps: KNOWN_GAPS,
    warnings: config.warnings,
  };
});

/**
 * Kick off a pull.
 *
 * Returns immediately with a session id; all progress arrives over the
 * WebSocket. Credentials are accepted here, handed straight to the session's
 * vault, and never logged, echoed, or persisted.
 */
app.post(
  '/api/sessions',
  { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
  async (request, reply) => {
    const parsed = startSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Carrier, username and password are all required.' });
    }

    const { carrierId, username, password } = parsed.data;
    const carrierClass = getCarrier(carrierId);
    if (!carrierClass) {
      return reply.code(400).send({ error: `Unsupported carrier: ${carrierId}` });
    }

    let session;
    try {
      session = sessionManager.create({ carrierClass, credentials: { username, password } });
    } catch (err) {
      return reply.code(err.statusCode ?? 500).send({ error: err.message });
    }

    /**
     * Buffer events that land before the socket attaches.
     *
     * There is a genuine race here: `run()` starts immediately, and a fast
     * failure (bad proxy, portal unreachable) can reach ERROR before the client
     * has finished opening the WebSocket. Without this, the UI would sit on
     * "Authenticating…" forever for the failures that are quickest to diagnose.
     *
     * `attached` gates the writes instead of nulling the array, because the
     * handlers stay subscribed for the session's whole life and a nulled buffer
     * would throw on the next transition.
     */
    session.buffer = [];
    session.attached = false;
    session.on('transition', (e) => {
      if (!session.attached) session.buffer.push({ type: 'state', ...toWire(e) });
    });
    session.on('note', (e) => {
      if (!session.attached) session.buffer.push({ type: 'note', ...toWire(e) });
    });

    // Fire and forget: run() resolves on terminal state and never rejects.
    session.run().catch((err) => app.log.error({ err: err.message }, 'unhandled session error'));

    return reply.code(202).send({
      sessionId: session.id,
      carrierId,
      wsUrl: `/api/sessions/${session.id}/stream`,
    });
  }
);

app.get('/api/sessions/:sessionId', async (request, reply) => {
  const session = sessionManager.get(request.params.sessionId);
  if (!session) return reply.code(404).send({ error: 'Unknown session.' });
  return {
    sessionId: session.id,
    carrierId: session.carrierId,
    state: session.state,
    timeline: session.machine.timeline,
    result: session.result,
  };
});

/** Serves a retrieved PDF so the browser's native viewer can render it. */
app.get('/api/sessions/:sessionId/documents/:docId', async (request, reply) => {
  const { sessionId, docId } = request.params;
  const doc = getDocument(sessionId, docId);
  if (!doc) return reply.code(404).send({ error: 'Document not found or expired.' });

  return reply
    .type(doc.mime ?? 'application/pdf')
    .header('content-disposition', `inline; filename="${encodeURIComponent(doc.name)}"`)
    // Someone's declarations page. Never cached by an intermediary.
    .header('cache-control', 'no-store, private')
    .header('x-content-type-options', 'nosniff')
    .send(doc.bytes);
});

app.delete('/api/sessions/:sessionId', async (request, reply) => {
  const session = sessionManager.get(request.params.sessionId);
  if (!session) return reply.code(404).send({ error: 'Unknown session.' });
  session.cancel('Cancelled by user.');
  sessionManager.delete(session.id);
  return reply.code(204).send();
});

/** Clears a persisted carrier session, to force-test the cold path. */
app.post('/api/sessions/:sessionId/forget', async (request, reply) => {
  const session = sessionManager.get(request.params.sessionId);
  if (!session) return reply.code(404).send({ error: 'Unknown session.' });
  return reply.send({ ok: true, note: 'Saved session cleared on next run.' });
});

// -- WebSocket transport ------------------------------------------------------

/**
 * Bidirectional channel for one session.
 *
 * WebSocket rather than SSE specifically because the MFA step needs a client to
 * server message mid-flow. SSE would work for the status stream but would need a
 * separate POST for the code, which reintroduces the correlation problem the
 * socket solves for free.
 */
app.register(async (scope) => {
  scope.get('/api/sessions/:sessionId/stream', { websocket: true }, (socket, request) => {
    const { sessionId } = request.params;
    const session = sessionManager.get(sessionId);

    const send = (payload) => {
      if (socket.readyState === 1) socket.send(JSON.stringify(payload));
    };

    if (!session) {
      send({ type: 'error', message: 'Unknown or expired session.' });
      socket.close();
      return;
    }

    // Replay anything that happened before the socket attached, then switch the
    // session from buffering to live delivery.
    for (const event of session.buffer ?? []) send(event);
    session.buffer = [];
    session.attached = true;

    const onTransition = (e) => send({ type: 'state', ...toWire(e) });
    const onNote = (e) => send({ type: 'note', ...toWire(e) });
    session.on('transition', onTransition);
    session.on('note', onNote);

    // A session that settled before this socket attached still needs its result
    // delivered; the replay above covers the transitions, this covers the payload.
    if (session.machine.isTerminal && session.result) {
      send({
        type: 'state',
        state: session.state,
        message: 'Session already finished.',
        ...session.result,
      });
    }

    socket.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return send({ type: 'error', message: 'Malformed message.' });
      }

      if (msg.type === 'mfa_code') {
        const outcome = session.submitMfaCode(msg.code);
        if (!outcome.ok) send({ type: 'mfa_rejected', message: outcome.error });
        return;
      }
      if (msg.type === 'cancel') {
        session.cancel('Cancelled by user.');
        return;
      }
      if (msg.type === 'ping') {
        return send({ type: 'pong', at: Date.now() });
      }
      send({ type: 'error', message: `Unknown message type: ${msg.type}` });
    });

    socket.on('close', () => {
      session.machine.off('transition', onTransition);
      session.machine.off('note', onNote);
      // Resume buffering so a reconnect replays whatever it missed.
      session.attached = false;
      // Intentionally does NOT cancel the session. A user whose laptop sleeps
      // during the MFA wait can reconnect and pick the flow back up.
    });
  });
});

// -- Demo portal & static UI --------------------------------------------------

if (config.ENABLE_MOCK_CARRIER) {
  await app.register(mockPortalRoutes);
}

await app.register(fastifyStatic, {
  root: path.join(__dirname, '..', 'public'),
  prefix: '/',
});

// -- Lifecycle ----------------------------------------------------------------

for (const warning of config.warnings) app.log.warn(warning);

await storageStateStore.init();
await metricsStore.init();
sessionManager.start();

// Pre-warm so the first user does not pay Chrome's start-up cost. Non-fatal:
// the server still boots and reports the failure via /api/health.
if (config.BROWSER_POOL_SIZE > 0) {
  browserPool
    .warm()
    .then(() => {
      /**
       * Park a login page per eligible carrier once the browser is up.
       *
       * Sequenced after `warm()` rather than alongside it, because every parked
       * page needs a context off that browser. Not awaited: boot must not depend
       * on a carrier portal being reachable.
       */
      return warmPagePool.start([...carriers.values()]);
    })
    .catch((err) => app.log.error({ err: err.message }, 'browser pre-warm failed'));
}

const shutdown = async (signal) => {
  app.log.info({ signal }, 'shutting down');
  try {
    await sessionManager.shutdown();
    // Before browserPool: parked pages hold contexts off that browser.
    await warmPagePool.shutdown();
    await browserPool.shutdown();
    await app.close();
  } finally {
    // Flush the log sink last, so the shutdown sequence itself is on disk. A
    // container that dies during a deploy is exactly when you want these lines.
    await fileSink?.close?.().catch?.(() => {});
    process.exit(0);
  }
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

try {
  await app.listen({ port: config.PORT, host: config.HOST });
  app.log.info(
    { port: config.PORT, carriers: listCarriers().map((c) => c.id) },
    'carrier-policy-puller ready'
  );
} catch (err) {
  app.log.fatal({ err: err.message }, 'failed to start');
  process.exit(1);
}
