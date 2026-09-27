/**
 * End-to-end smoke test against the demo portal.
 *
 * Drives the real flow over the real transport: POST /api/sessions, attach the
 * WebSocket, wait for the MFA challenge, submit the code, wait for COMPLETED,
 * then fetch the resulting PDF over HTTP and verify the bytes really are a PDF.
 *
 * Then does it a second time, to prove the warm path skips login and MFA.
 *
 * Run against a live server:  node tools/smoke.js [baseUrl]
 */

const BASE = process.argv[2] ?? 'http://127.0.0.1:3000';
const WS_BASE = BASE.replace(/^http/, 'ws');

const CREDS = { carrierId: 'demo', username: 'demo@example.com', password: 'demo1234' };

let failures = 0;
const check = (label, ok, extra = '') => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${label}${extra ? `  ${extra}` : ''}`);
  if (!ok) failures += 1;
};

async function runOnce(label, { expectWarm = null } = {}) {
  console.log(`\n=== ${label} ===`);
  const t0 = Date.now();

  const res = await fetch(`${BASE}/api/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(CREDS),
  });
  const started = await res.json();
  check('session accepted', res.status === 202 && Boolean(started.sessionId), `id=${started.sessionId?.slice(0, 8)}`);
  if (!started.sessionId) return null;

  const outcome = await new Promise((resolve, reject) => {
    const socket = new WebSocket(`${WS_BASE}${started.wsUrl}`);
    const states = [];
    let mfaPrompted = false;
    let demoCodeSeen = null;
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error('timed out after 90s'));
    }, 90_000);

    socket.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);

      if (msg.type === 'note') {
        console.log(`  · ${msg.message}`);
        return;
      }
      if (msg.type !== 'state') return;

      states.push(msg.state);
      console.log(`  → ${msg.state}  ${msg.message ?? ''}`);

      if (msg.state === 'MFA_REQUIRED') {
        mfaPrompted = true;
        const code = msg.detail?.demoCode ?? msg.demoCode;
        demoCodeSeen = code;
        if (!code) {
          clearTimeout(timer);
          socket.close();
          return reject(new Error('MFA_REQUIRED carried no demo code; cannot continue unattended'));
        }
        // Small pause so the timing split between machine and human is visible.
        setTimeout(() => socket.send(JSON.stringify({ type: 'mfa_code', code })), 400);
      }

      if (msg.state === 'COMPLETED' || msg.state === 'ERROR') {
        clearTimeout(timer);
        socket.close();
        resolve({ states, mfaPrompted, demoCodeSeen, final: msg });
      }
    });

    socket.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error('websocket error'));
    });
  });

  const { final, states, mfaPrompted } = outcome;
  check('reached COMPLETED', final.state === 'COMPLETED', final.state === 'ERROR' ? final.message : '');
  if (final.state !== 'COMPLETED') return outcome;

  check('state order is legal', states[0] === 'AUTHENTICATING', states.join(' -> '));
  check('documents returned', (final.documents?.length ?? 0) > 0, `${final.documents?.length ?? 0} docs`);

  if (expectWarm === true) {
    check('used warm path (no login, no MFA)', final.warmPath === true && !mfaPrompted);
  }
  if (expectWarm === false) {
    check('used cold path with MFA challenge', final.warmPath === false && mfaPrompted);
  }

  // Verify the served bytes are genuinely a PDF, not a stub or an error page.
  for (const doc of final.documents ?? []) {
    const pdfRes = await fetch(`${BASE}${doc.url}`);
    const buf = Buffer.from(await pdfRes.arrayBuffer());
    const magic = buf.subarray(0, 5).toString('latin1');
    const hasEof = buf.subarray(-1024).toString('latin1').includes('%%EOF');
    check(
      `"${doc.label}" is a valid PDF`,
      pdfRes.ok && magic === '%PDF-' && hasEof && buf.length > 800,
      `${magic} ${(buf.length / 1024).toFixed(1)}KB ${pdfRes.headers.get('content-type')}`
    );
  }

  const t = final.timings ?? {};
  console.log(
    `  timings: machine=${((t.machineMs ?? 0) / 1000).toFixed(2)}s  wall=${((t.wallMs ?? 0) / 1000).toFixed(2)}s  human=${((t.humanMs ?? 0) / 1000).toFixed(2)}s  warmPath=${final.warmPath}`
  );
  check('machine time within 8s budget', (t.machineMs ?? Infinity) <= 8000, `${t.machineMs}ms`);
  console.log(`  phases: ${(t.phases ?? []).map((p) => `${p.phase}=${p.durationMs}ms`).join(' ')}`);
  console.log(`  total observed by client: ${Date.now() - t0}ms`);

  return outcome;
}

console.log(`Smoke test against ${BASE}`);

const health = await fetch(`${BASE}/api/health`).then((r) => r.json());
console.log(
  `\nhealth: browser=${health.browser?.driver}/${health.browser?.channel} ready=${health.browser?.ready} proxy=${health.config?.proxyConfigured}`
);
if (health.warnings?.length) health.warnings.forEach((w) => console.log(`  warn: ${w}`));

// Cold run first: the store may already hold a session from a previous run, so
// this asserts nothing about which path was taken.
await runOnce('Run 1 (cold or warm, whichever the store holds)');

// Second run must be warm: run 1 persisted a session.
await runOnce('Run 2 (expect warm path)', { expectWarm: true });

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
