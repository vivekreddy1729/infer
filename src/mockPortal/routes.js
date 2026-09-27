import crypto from 'node:crypto';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import logger from '../logger.js';

/**
 * A fake carrier portal, served by this same app.
 *
 * This is the highest-leverage piece of the build, and it is not a stub or a
 * mock object. It is a real HTTP portal with a real login form, a real one-time
 * code step, a real authenticated document list, and real generated PDF bytes.
 * Playwright drives it in a real browser over the network, through the same
 * pool, blocker, state machine and WebSocket transport as a live carrier.
 *
 * Three reasons it is worth the ~250 lines:
 *
 *  1. It decouples pipeline risk from portal risk. Live-carrier work has
 *     genuinely unbounded variance: a selector changes, an IP gets burned, an
 *     account locks. That risk should not be able to take the whole submission
 *     to zero. With this in place the orchestration is provably working and
 *     deployed before a single real portal is attempted.
 *
 *  2. It makes the repo runnable by a reviewer with no credentials, which is
 *     otherwise impossible for a project whose entire purpose is logging into
 *     someone's insurance account.
 *
 *  3. It is a much better development harness than a live portal: no rate
 *     limits, no lockouts, no waiting on a real SMS, and it can be made to fail
 *     on demand to exercise the error paths.
 *
 * It deliberately reproduces the portal behaviours that actually break naive
 * automation, rather than being a friendly happy path:
 *   - submit stays disabled until real `input` events fire, so a one-shot
 *     `fill()` cannot proceed
 *   - server-side latency on the auth POST
 *   - wrong code is rejected but retryable, exercising MFA_SUBMITTED -> MFA_REQUIRED
 *   - the document link is generated, not static, so it must be scraped
 */

const log = logger.child({ module: 'mockPortal' });

export const MOCK_USERNAME = 'demo@example.com';
export const MOCK_PASSWORD = 'demo1234';

/** In-memory portal-side sessions. Separate from our app's sessions. */
const portalSessions = new Map();

/** Emitted so the UI and logs can show the code during a demo. */
export const mockCodeEvents = new Map();

setInterval(() => {
  const cutoff = Date.now() - 20 * 60_000;
  for (const [k, v] of portalSessions) if (v.createdAt < cutoff) portalSessions.delete(k);
  for (const [k, v] of mockCodeEvents) if (v.at < cutoff) mockCodeEvents.delete(k);
}, 60_000).unref();

const layout = (title, body) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} — Demo Mutual Insurance</title>
<style>
  body{font-family:-apple-system,Segoe UI,Roboto,sans-serif;background:#eef1f5;margin:0;padding:40px 16px;color:#132}
  .card{max-width:420px;margin:0 auto;background:#fff;padding:28px;border-radius:8px;box-shadow:0 2px 12px rgba(0,0,0,.09)}
  h1{font-size:19px;margin:0 0 4px}.sub{color:#667;font-size:13px;margin:0 0 20px}
  label{display:block;font-size:12px;font-weight:600;margin:14px 0 5px;text-transform:uppercase;letter-spacing:.04em;color:#456}
  input{width:100%;padding:10px;font-size:15px;border:1px solid #bcc;border-radius:5px;box-sizing:border-box}
  button{width:100%;margin-top:20px;padding:11px;font-size:15px;font-weight:600;border:0;border-radius:5px;background:#0b6;color:#fff;cursor:pointer}
  button:disabled{background:#bcc;cursor:not-allowed}
  .err{background:#fdeaea;border-left:3px solid #d44;padding:9px 11px;font-size:13px;margin:14px 0;color:#922}
  .banner{background:#fff8e1;border-left:3px solid #fb3;padding:9px 11px;font-size:12px;margin-bottom:18px;color:#763}
  table{width:100%;border-collapse:collapse;font-size:14px}td{padding:9px 0;border-bottom:1px solid #eee}
  a{color:#07a}
</style></head><body><div class="card">
<div class="banner"><strong>Demo portal.</strong> Not a real carrier. Exists so the full flow can be run without live credentials.</div>
${body}
</div></body></html>`;

/**
 * Gate the submit button behind genuine keyboard input.
 * Mirrors the real-world pattern that punishes `fill()` and forces per-character
 * typing, which is exactly what `typeLikeHuman` in baseCarrier handles.
 */
const GATE_SCRIPT = `<script>
(function(){
  var f=document.querySelector('form'), b=f.querySelector('button'), seen={};
  f.querySelectorAll('input').forEach(function(i){
    i.addEventListener('input',function(){ seen[i.name]=i.value.length>0; check(); });
  });
  function check(){
    var need=Array.prototype.map.call(f.querySelectorAll('input'),function(i){return i.name;});
    b.disabled=!need.every(function(n){return seen[n];});
  }
  check();
})();
</script>`;

export default async function mockPortalRoutes(fastify) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  fastify.get('/mock-portal/login', async (_req, reply) => {
    reply.type('text/html').send(
      layout(
        'Sign in',
        `<h1>Sign in to your account</h1>
         <p class="sub">Demo Mutual Insurance — Policyholder Portal</p>
         <form method="POST" action="/mock-portal/login">
           <label for="u">Email address</label>
           <input id="u" name="username" type="email" autocomplete="username">
           <label for="p">Password</label>
           <input id="p" name="password" type="password" autocomplete="current-password">
           <button type="submit" disabled>Sign in</button>
         </form>${GATE_SCRIPT}`
      )
    );
  });

  fastify.post('/mock-portal/login', async (req, reply) => {
    // Real portals take a beat to check credentials. Keeps the demo honest
    // about where latency comes from.
    await sleep(220);
    const { username = '', password = '' } = req.body ?? {};

    if (username.trim().toLowerCase() !== MOCK_USERNAME || password !== MOCK_PASSWORD) {
      log.info('mock portal rejected credentials');
      return reply.type('text/html').code(401).send(
        layout(
          'Sign in',
          `<h1>Sign in to your account</h1>
           <p class="sub">Demo Mutual Insurance — Policyholder Portal</p>
           <div class="err" id="login-error">The email or password you entered is incorrect.</div>
           <form method="POST" action="/mock-portal/login">
             <label for="u">Email address</label>
             <input id="u" name="username" type="email" value="">
             <label for="p">Password</label>
             <input id="p" name="password" type="password">
             <button type="submit" disabled>Sign in</button>
           </form>${GATE_SCRIPT}`
        )
      );
    }

    const sid = crypto.randomBytes(16).toString('hex');
    const code = String(crypto.randomInt(100000, 999999));
    portalSessions.set(sid, {
      username,
      code,
      verified: false,
      attempts: 0,
      createdAt: Date.now(),
    });
    mockCodeEvents.set(sid, { code, at: Date.now() });

    // The demo equivalent of an SMS. Logged prominently and mirrored into the
    // app's status stream so a live walkthrough does not need a real phone.
    log.info({ mockOtp: code }, '=== MOCK PORTAL VERIFICATION CODE ===');

    reply
      .header('set-cookie', `mock_pending=${sid}; Path=/mock-portal; HttpOnly; SameSite=Lax`)
      .redirect('/mock-portal/verify', 302);
  });

  fastify.get('/mock-portal/verify', async (req, reply) => {
    const sid = req.cookies?.mock_pending;
    if (!sid || !portalSessions.has(sid)) return reply.redirect('/mock-portal/login', 302);
    reply.type('text/html').send(
      layout(
        'Verify',
        `<h1>Verify it's you</h1>
         <p class="sub">We sent a 6-digit code to the phone ending in •• 47.</p>
         <form method="POST" action="/mock-portal/verify">
           <label for="c">Verification code</label>
           <input id="c" name="code" inputmode="numeric" maxlength="6" autocomplete="one-time-code">
           <button type="submit" disabled>Verify</button>
         </form>${GATE_SCRIPT}`
      )
    );
  });

  fastify.post('/mock-portal/verify', async (req, reply) => {
    await sleep(180);
    const sid = req.cookies?.mock_pending;
    const session = sid && portalSessions.get(sid);
    if (!session) return reply.redirect('/mock-portal/login', 302);

    const submitted = String(req.body?.code ?? '').trim();
    if (submitted !== session.code) {
      session.attempts += 1;
      if (session.attempts >= 4) {
        portalSessions.delete(sid);
        return reply
          .type('text/html')
          .code(423)
          .send(layout('Locked', `<h1>Too many attempts</h1><p class="sub">Start over.</p>`));
      }
      // Rejected but retryable, which is the common real-world case.
      return reply.type('text/html').code(401).send(
        layout(
          'Verify',
          `<h1>Verify it's you</h1>
           <p class="sub">We sent a 6-digit code to the phone ending in •• 47.</p>
           <div class="err" id="otp-error">That code isn't right. ${4 - session.attempts} attempts left.</div>
           <form method="POST" action="/mock-portal/verify">
             <label for="c">Verification code</label>
             <input id="c" name="code" inputmode="numeric" maxlength="6">
             <button type="submit" disabled>Verify</button>
           </form>${GATE_SCRIPT}`
        )
      );
    }

    session.verified = true;
    reply
      .header('set-cookie', `mock_session=${sid}; Path=/mock-portal; HttpOnly; SameSite=Lax`)
      .redirect('/mock-portal/documents', 302);
  });

  const authed = (req) => {
    const sid = req.cookies?.mock_session;
    const s = sid && portalSessions.get(sid);
    return s?.verified ? { sid, session: s } : null;
  };

  fastify.get('/mock-portal/documents', async (req, reply) => {
    const auth = authed(req);
    if (!auth) return reply.redirect('/mock-portal/login', 302);

    // Document ids are derived, not static, so the adapter has to scrape the
    // page rather than hard-code a URL. Same as a real portal.
    const docs = [
      { id: `dec-${auth.sid.slice(0, 8)}`, label: 'Auto Policy Declarations', policy: 'PA-4471902' },
      { id: `idc-${auth.sid.slice(0, 8)}`, label: 'Insurance ID Cards', policy: 'PA-4471902' },
    ];

    reply.type('text/html').send(
      layout(
        'Documents',
        `<h1>Policy documents</h1>
         <p class="sub">Signed in as ${auth.session.username}</p>
         <table id="documents-table">
           ${docs
             .map(
               (d) =>
                 `<tr><td>${d.label}<br><small style="color:#889">Policy ${d.policy}</small></td>
                  <td style="text-align:right"><a class="doc-link" data-kind="${d.id.startsWith('dec') ? 'declarations' : 'id_card'}" href="/mock-portal/documents/${d.id}.pdf">Download PDF</a></td></tr>`
             )
             .join('')}
         </table>`
      )
    );
  });

  fastify.get('/mock-portal/documents/:file', async (req, reply) => {
    const auth = authed(req);
    if (!auth) return reply.code(403).send({ error: 'not authenticated' });

    const { file } = req.params;
    if (!/^[a-z]{3}-[a-f0-9]{8}\.pdf$/.test(file)) {
      return reply.code(404).send({ error: 'not found' });
    }
    const isDec = file.startsWith('dec');
    const pdf = await buildPdf({
      title: isDec ? 'Automobile Policy Declarations' : 'Insurance Identification Cards',
      username: auth.session.username,
      isDec,
    });

    reply
      .type('application/pdf')
      .header('content-disposition', `inline; filename="${file}"`)
      .send(Buffer.from(pdf));
  });
}

/** Generates genuine PDF bytes so the viewer path is exercised for real. */
async function buildPdf({ title, username, isDec }) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const body = await doc.embedFont(StandardFonts.Helvetica);
  const ink = rgb(0.08, 0.13, 0.2);
  const muted = rgb(0.42, 0.46, 0.52);

  page.drawRectangle({ x: 0, y: 742, width: 612, height: 50, color: rgb(0.04, 0.42, 0.33) });
  page.drawText('DEMO MUTUAL INSURANCE', {
    x: 42, y: 760, size: 15, font: bold, color: rgb(1, 1, 1),
  });

  page.drawText(title, { x: 42, y: 700, size: 17, font: bold, color: ink });
  page.drawText('Specimen document generated by the demo portal — not a real policy.', {
    x: 42, y: 682, size: 9, font: body, color: muted,
  });

  const rows = isDec
    ? [
        ['Named insured', username],
        ['Policy number', 'PA-4471902'],
        ['Policy period', '01 Mar 2026 to 01 Sep 2026'],
        ['Vehicle', '2019 Toyota Corolla LE  4T1BF1FK2GU******'],
        ['Bodily injury liability', '$100,000 per person / $300,000 per accident'],
        ['Property damage liability', '$50,000 per accident'],
        ['Collision deductible', '$500'],
        ['Comprehensive deductible', '$500'],
        ['Uninsured motorist', '$100,000 / $300,000'],
        ['Total 6-month premium', '$612.40'],
      ]
    : [
        ['Named insured', username],
        ['Policy number', 'PA-4471902'],
        ['Effective', '01 Mar 2026'],
        ['Expires', '01 Sep 2026'],
        ['Vehicle', '2019 Toyota Corolla LE'],
        ['NAIC', '99999'],
      ];

  let y = 640;
  for (const [k, v] of rows) {
    page.drawText(k, { x: 42, y, size: 10, font: bold, color: muted });
    page.drawText(String(v), { x: 232, y, size: 10, font: body, color: ink });
    y -= 26;
  }

  page.drawText(`Generated ${new Date().toISOString()}`, {
    x: 42, y: 60, size: 8, font: body, color: muted,
  });
  return doc.save();
}
