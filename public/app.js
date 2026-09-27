/* eslint-env browser */

/**
 * Client-side state renderer.
 *
 * Holds no logic of its own about what should happen next: the backend state
 * machine is the single source of truth and this file just reacts to the
 * transitions it publishes. That is why the MFA modal can appear at the right
 * moment without the frontend knowing anything about how a given carrier
 * challenges, and why adding a carrier needs no frontend change at all.
 */

const el = (id) => document.getElementById(id);

const ui = {
  form: el('pull-form'),
  carrier: el('carrier'),
  carrierHint: el('carrier-hint'),
  username: el('username'),
  password: el('password'),
  submit: el('submit-btn'),
  cancel: el('cancel-btn'),
  badge: el('state-badge'),
  log: el('status-log'),
  timings: el('timings'),
  docsPanel: el('documents-panel'),
  docTabs: el('doc-tabs'),
  viewer: el('doc-viewer'),
  overlay: el('mfa-overlay'),
  mfaForm: el('mfa-form'),
  mfaCode: el('mfa-code'),
  mfaHint: el('mfa-hint'),
  mfaDemo: el('mfa-demo'),
  mfaError: el('mfa-error'),
  mfaCountdown: el('mfa-countdown'),
  mfaSubmit: el('mfa-submit'),
  mfaCancel: el('mfa-cancel'),
};

let socket = null;
let sessionId = null;
let countdownTimer = null;
let carriers = [];

// -- carriers -----------------------------------------------------------------

async function loadCarriers() {
  try {
    const res = await fetch('/api/carriers');
    const data = await res.json();
    carriers = data.carriers ?? [];
    ui.carrier.innerHTML =
      '<option value="">Select a carrier…</option>' +
      carriers.map((c) => `<option value="${c.id}">${c.displayName}</option>`).join('');
  } catch {
    ui.carrier.innerHTML = '<option value="">Could not load carriers</option>';
  }
}

/** Credentials the demo option prefills, so they can be recognised and cleared. */
const DEMO_CREDENTIALS = { username: 'demo@example.com', password: 'demo1234' };

ui.carrier.addEventListener('change', () => {
  const c = carriers.find((x) => x.id === ui.carrier.value);
  if (!c) return (ui.carrierHint.textContent = '');

  if (c.isDemo) {
    ui.carrierHint.textContent = 'Practice portal. The verification code is shown on screen.';
    ui.username.value = DEMO_CREDENTIALS.username;
    ui.password.value = DEMO_CREDENTIALS.password;
    return;
  }

  /**
   * Clear the demo prefill when switching to a real carrier.
   *
   * Without this, selecting the practice portal and then switching to
   * Progressive leaves `demo@example.com` sitting in the form, and the user
   * submits it to a live carrier. That burns a real failed login attempt against
   * a real account — carriers count those and lock accounts. Only clear values we
   * put there, so anything typed by hand is preserved.
   */
  if (ui.username.value === DEMO_CREDENTIALS.username) ui.username.value = '';
  if (ui.password.value === DEMO_CREDENTIALS.password) ui.password.value = '';

  ui.carrierHint.textContent = `Your real ${c.displayName} sign-in. The code goes to your phone, not to this screen.`;

  /**
   * Ask the server to park a login page while the user types.
   *
   * Everything up to "the form is on screen" is independent of the credentials —
   * a browser context, the navigation, and the carrier SPA bootstrapping, which
   * on Progressive is several seconds. Starting it at carrier-selection time
   * means it is finished before the password is even typed.
   *
   * Sends only the carrier id. Fire-and-forget: a failure here just means the
   * pull takes the normal cold path.
   */
  fetch('/api/prewarm', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ carrierId: c.id }),
  }).catch(() => {});
});

// -- logging ------------------------------------------------------------------

/**
 * Elapsed time at the previous status line, so each row can show how long *that
 * step* took rather than only how far into the run it happened.
 */
let lastElapsedMs = 0;

/**
 * Render one status line with both clocks.
 *
 * Previously this showed only cumulative elapsed, which reads exactly like a step
 * duration — a line reading `37.3s` was understandably taken to mean "this step
 * took 37.3 seconds" when it meant "this happened 37.3 seconds in". That sends
 * you optimising the wrong step.
 *
 * Now the prominent figure is the delta since the previous line (what this step
 * cost) with cumulative elapsed shown quietly beside it.
 */
function addLine(message, cls = '', elapsedMs) {
  const li = document.createElement('li');
  if (cls) li.className = cls;
  li.textContent = message;

  if (typeof elapsedMs === 'number') {
    const deltaMs = Math.max(0, elapsedMs - lastElapsedMs);
    lastElapsedMs = elapsedMs;

    const t = document.createElement('span');
    t.className = 't';
    // Highlight steps that dominate, so slow ones are findable at a glance.
    if (deltaMs >= 3000) t.classList.add('slow');
    t.innerHTML =
      `<strong title="time this step took">+${(deltaMs / 1000).toFixed(1)}s</strong>` +
      `<span class="cum" title="elapsed since the run started">${(elapsedMs / 1000).toFixed(1)}s</span>`;
    li.appendChild(t);
  }

  ui.log.appendChild(li);
  ui.log.parentElement.scrollTop = ui.log.parentElement.scrollHeight;
}

const BADGES = {
  INIT: 'active',
  AUTHENTICATING: 'active',
  MFA_REQUIRED: 'waiting',
  MFA_SUBMITTED: 'active',
  EXTRACTING_DOCS: 'active',
  COMPLETED: 'ok',
  ERROR: 'err',
};

function setBadge(state) {
  ui.badge.textContent = state.replace(/_/g, ' ');
  ui.badge.className = `badge ${BADGES[state] ?? 'idle'}`;
}

// -- run ----------------------------------------------------------------------

ui.form.addEventListener('submit', async (event) => {
  event.preventDefault();
  resetView();

  ui.submit.disabled = true;
  ui.submit.textContent = 'Working…';
  ui.cancel.hidden = false;

  try {
    const res = await fetch('/api/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        carrierId: ui.carrier.value,
        username: ui.username.value,
        password: ui.password.value,
      }),
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);

    sessionId = data.sessionId;
    // Password is no longer needed client-side either.
    ui.password.value = '';
    openSocket(data.wsUrl);
  } catch (err) {
    addLine(err.message, 'err');
    setBadge('ERROR');
    finish();
  }
});

ui.cancel.addEventListener('click', () => {
  send({ type: 'cancel' });
  addLine('Cancelling…', 'note');
});

function openSocket(wsPath) {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  socket = new WebSocket(`${proto}//${location.host}${wsPath}`);

  socket.addEventListener('message', (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    handle(msg);
  });

  socket.addEventListener('error', () => addLine('Connection problem.', 'err'));

  socket.addEventListener('close', () => {
    const wasRunning =
      ui.badge.classList.contains('active') || ui.badge.classList.contains('waiting');
    if (!wasRunning) return;

    /**
     * If the MFA dialog is open when the connection drops, say so in the dialog.
     *
     * Otherwise it sits there looking perfectly usable while being wired to a
     * session that no longer exists, and the code the user carefully types goes
     * nowhere with no feedback. That is a genuinely confusing failure: the
     * carrier did send a code, the box does accept input, and nothing happens.
     * Sessions are reaped on a TTL, so this is a normal occurrence, not an edge
     * case.
     */
    if (!ui.overlay.hidden) {
      ui.mfaError.textContent =
        'This session expired before your code was submitted. Close this and start again.';
      ui.mfaError.hidden = false;
      ui.mfaCode.disabled = true;
      ui.mfaSubmit.disabled = true;
      ui.mfaCancel.hidden = false;
    }

    addLine('Connection closed before the run finished.', 'err');
    setBadge('ERROR');
    finish();
  });
}

function send(payload) {
  if (socket?.readyState === 1) socket.send(JSON.stringify(payload));
}

function handle(msg) {
  if (msg.type === 'note') {
    addLine(msg.message, 'note', msg.elapsedMs);
    return;
  }
  if (msg.type === 'mfa_rejected') {
    ui.mfaError.textContent = msg.message;
    ui.mfaError.hidden = false;
    ui.mfaCode.disabled = false;
    ui.mfaCode.select();
    return;
  }
  if (msg.type === 'error') {
    addLine(msg.message, 'err');
    return;
  }
  if (msg.type !== 'state') return;

  setBadge(msg.state);

  const cls = msg.state === 'ERROR' ? 'err' : msg.state === 'COMPLETED' ? 'ok' : '';
  addLine(msg.message, cls, msg.elapsedMs);

  if (msg.state === 'MFA_REQUIRED') showMfa(msg);
  if (msg.state === 'MFA_SUBMITTED') hideMfa();

  if (msg.state === 'COMPLETED') {
    renderTimings(msg.timings, msg.warmPath, msg.transport);
    renderDocuments(msg.documents);
    finish();
  }
  if (msg.state === 'ERROR') {
    hideMfa();
    finish();
  }
}

function finish() {
  ui.submit.disabled = false;
  ui.submit.textContent = 'Pull my documents';
  ui.cancel.hidden = true;
  clearInterval(countdownTimer);
  ui.mfaCountdown.textContent = '';
}

function resetView() {
  lastElapsedMs = 0;
  ui.log.innerHTML = '';
  ui.timings.hidden = true;
  ui.docsPanel.hidden = true;
  ui.docTabs.innerHTML = '';
  ui.viewer.removeAttribute('src');
  ui.mfaError.hidden = true;
  ui.mfaDemo.hidden = true;
  setBadge('INIT');
  if (socket) {
    socket.close();
    socket = null;
  }
}

// -- MFA ----------------------------------------------------------------------

function showMfa(msg) {
  const d = msg.detail ?? msg;
  const channel = (d.channel ?? 'your device').toString().toLowerCase();
  ui.mfaHint.textContent = d.hint
    ? `Sent by ${channel} to ${d.hint}.`
    : `Check your ${channel} for the code.`;

  ui.mfaSubmit.disabled = false;
  ui.mfaCancel.hidden = true;

  if (d.demoCode) {
    ui.mfaDemo.innerHTML = `Demo portal code: <strong>${d.demoCode}</strong><br><small>Shown because this is the practice carrier. Real carriers send this to your phone.</small>`;
    ui.mfaDemo.hidden = false;
  } else {
    // Be explicit that no code will appear here for a real carrier, so an empty
    // dialog does not read as "something failed to load".
    ui.mfaDemo.hidden = true;
  }

  if (d.attempt > 1) {
    ui.mfaError.textContent = `Attempt ${d.attempt}. ${d.attemptsRemaining} left.`;
    ui.mfaError.hidden = false;
  }

  ui.overlay.hidden = false;
  ui.mfaCode.value = '';
  ui.mfaCode.disabled = false;
  ui.mfaCode.focus();

  // The carrier's challenge expires; make that visible rather than letting the
  // user sit on a dead form.
  let remaining = 180;
  clearInterval(countdownTimer);
  countdownTimer = setInterval(() => {
    remaining -= 1;
    ui.mfaCountdown.textContent =
      remaining > 0 ? `Code expires in ${remaining}s.` : 'Code window expired.';
    if (remaining <= 0) clearInterval(countdownTimer);
  }, 1000);
}

function hideMfa() {
  ui.overlay.hidden = true;
  clearInterval(countdownTimer);
  ui.mfaCountdown.textContent = '';
}

ui.mfaForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const code = ui.mfaCode.value.trim();
  if (!code) return;

  // Never let a code disappear into a dead socket without saying so.
  if (socket?.readyState !== 1) {
    ui.mfaError.textContent =
      'The connection to this session is closed. Close this and start again.';
    ui.mfaError.hidden = false;
    ui.mfaCancel.hidden = false;
    return;
  }

  ui.mfaError.hidden = true;
  ui.mfaCode.disabled = true;
  send({ type: 'mfa_code', code });
});

ui.mfaCancel.addEventListener('click', () => {
  hideMfa();
  resetView();
  ui.badge.textContent = 'IDLE';
  ui.badge.className = 'badge idle';
});

// -- results ------------------------------------------------------------------

/**
 * Renders both clocks. `machineMs` is what the 8s budget is measured against;
 * wall-clock includes however long the person took to read their SMS, which is
 * reported but not counted.
 */
function renderTimings(timings, warmPath, transport) {
  if (!timings) return;

  const machine = timings.machineMs ?? 0;
  const withinBudget = machine <= 8000;

  const rows = (timings.phases ?? [])
    .map(
      (p) =>
        `<tr><td class="${p.human ? 'human' : ''}">${p.phase}${p.human ? ' (human)' : ''}</td>
         <td class="v">${p.durationMs} ms</td></tr>`
    )
    .join('');

  ui.timings.innerHTML = `
    <h3>Latency</h3>
    <div class="headline ${withinBudget ? 'ok' : 'over'}">${(machine / 1000).toFixed(2)}s
      <span style="font-size:12px;font-weight:400;color:var(--muted)">machine time
      ${withinBudget ? '· within 8s budget' : '· over budget'}</span>
    </div>
    <table>
      <tr><td>Wall clock (incl. human)</td><td class="v">${((timings.wallMs ?? 0) / 1000).toFixed(2)}s</td></tr>
      <tr><td>Waiting on the person</td><td class="v">${((timings.humanMs ?? 0) / 1000).toFixed(2)}s</td></tr>
      ${rows}
    </table>
    <div class="meta">
      ${warmPath ? 'Warm path: resumed a saved session, no sign-in or code needed.' : 'Cold path: full sign-in.'}
      ${transport ? `<br>${transport.driver}/${transport.channel}${transport.proxied ? ' · residential proxy' : ' · direct egress'}${transport.requestsBlocked ? ` · blocked ${transport.requestsBlocked} requests (${transport.requestsBlockedPct}%)` : ''}` : ''}
    </div>`;
  ui.timings.hidden = false;
}

function renderDocuments(documents) {
  if (!documents?.length) return;
  ui.docsPanel.hidden = false;
  ui.docTabs.innerHTML = '';

  documents.forEach((doc, index) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = `${doc.label} (${Math.round(doc.bytes / 1024)} KB)`;
    btn.addEventListener('click', () => {
      [...ui.docTabs.children].forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      ui.viewer.src = doc.url;
    });
    ui.docTabs.appendChild(btn);
    if (index === 0) btn.click();
  });
}

loadCarriers();
