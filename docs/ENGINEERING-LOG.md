# Engineering Log

A running record of every failure encountered building this system, what caused it, how it was
diagnosed, and what changed. Written for the next person or agent to touch this code.

## Why this file exists

Most of the difficulty in this project was not writing code. It was discovering how three
specific insurance portals actually behave, and — more often — discovering that a plausible-looking
piece of my own code was quietly lying. Several bugs here presented as *carrier* problems and were
really *our* problems, and a couple presented as our problems and were really carrier behaviour.
Telling those apart consumed most of the time.

That knowledge is expensive and almost entirely invisible from reading the finished source. A
comment explains what the code does now; it does not tell you that the obvious alternative was
tried and produced a convincing false positive for two hours.

## How to use it

- **Before changing an adapter**, read the entries tagged for that carrier. Several fixes look
  arbitrary until you know what they are defending against.
- **Before "simplifying"** anything marked `LOAD-BEARING`, read the entry. Those are guards against
  failures that are silent when reintroduced.
- **When debugging**, check [Recurring patterns](#recurring-patterns) first. Three separate bugs
  here shared one root cause, and knowing the shape saves hours.

## How to update it

**Add an entry for anything that cost more than ~15 minutes to understand.** Not every bug: the
ones whose *cause was surprising*. If you would have to re-derive it, write it down.

Rules:

1. **Append, never rewrite.** Entries are immutable history. If a later fix supersedes an earlier
   one, add a new entry and cross-reference it. A wrong turn that was corrected is useful.
2. **Number sequentially** (`F-29`, `F-30`, …). Never reuse a number.
3. **Record the evidence, not just the conclusion.** Paste the actual error string, the status
   code, the log line. "It was a header problem" is useless; `400 "AccountSession header missing"`
   is a fix.
4. **State what you ruled out.** Most of the cost is in the wrong hypotheses.
5. **Say if it is still open.** An honest open item beats a fix that does not work.
6. **Never paste credentials.** Not even expired ones. See F-09.

### Entry template

```markdown
### F-NN · <one-line title>

| | |
|---|---|
| **Area** | adapter:progressive / core / frontend / tooling / infra / security |
| **Severity** | blocked-submission / wrong-results / misleading / cosmetic |
| **Status** | fixed / open / superseded by F-NN |

**Symptom.** What was observed, verbatim where possible.

**Diagnosis.** How it was narrowed down, including what was ruled out.

**Root cause.** The actual mechanism.

**Fix.** What changed, and where.

**Lesson.** The generalisable part, if any.

**Guard.** The test or check that stops it regressing, if one exists.
```

---

## Timeline

| ID | Title | Area | Status |
|---|---|---|---|
| F-01 | Empty env vars failed URL validation at boot | core | fixed |
| F-02 | Proxy sentinel leaked into non-proxied contexts | core | fixed |
| F-03 | Event buffer nulled while handlers still wrote to it | core | fixed |
| F-04 | `detail` payload not flattened onto the wire | core | fixed |
| F-05 | `chmod -R` in the Dockerfile killed the image build | infra | fixed |
| F-06 | Probe reported "NO FORM FOUND" for a page that rendered fine | tooling | fixed |
| F-07 | Progressive login URL was a 404, misread as a block | adapter:progressive | fixed |
| F-08 | Portal DOM ids are regenerated on every page load | adapter:progressive | fixed |
| F-09 | Flow recorder leaked bearer tokens two different ways | security | fixed |
| F-10 | Carrier API is bearer-guarded, not cookie-guarded | adapter:progressive | fixed |
| F-11 | Header allowlist could not guess a vendor's private protocol | adapter:progressive | fixed |
| F-12 | `policyInfoKey` required in query *and* body, varies per policy | adapter:progressive | fixed |
| F-13 | PDF arrives base64 inside a JSON envelope | adapter:progressive | fixed |
| F-14 | Inspection tool closed the browser it was inspecting | tooling | fixed |
| F-15 | `[hidden]` defeated by a class rule; modal swallowed every click | frontend | fixed |
| F-16 | OTP stale-read race rejected correct verification codes | adapter:progressive | fixed |
| F-17 | Hard navigation destroyed the SPA's in-memory OAuth token | adapter:progressive | fixed |
| F-18 | `isSessionValid()` returned confident false positives | adapter:progressive | fixed |
| F-19 | Some carrier API headers are route-scoped | adapter:progressive | worked around |
| F-20 | Logged HTTP status while discarding the explanatory body | tooling | fixed |
| F-21 | Server log lost to `/dev/null`, costing a debugging round | tooling | fixed |
| F-22 | Log scrubber silently emptied every request log entry | core | fixed |
| F-23 | Diagnostics token leaked into the log it protects | security | fixed |
| F-24 | `fly.toml` would have discarded all logs on deploy | infra | fixed |
| F-25 | Secret audit flagged its own redaction markers | security | fixed |
| F-26 | Metrics page hid a carrier whose runs had all failed | frontend | fixed |
| F-27 | Composite phases would double-count in exclusion windows | core | fixed |
| F-28 | Wrong declarations document selected | adapter:progressive | fixed by F-29 |
| F-29 | Document target hardcoded; ranking ignored policy status | adapter:progressive | fixed |
| F-30 | Latency pass: blind polls, a silently broken optimisation, and a self-inflicted regression | adapter:progressive / core / frontend | fixed |
| F-31 | Pre-warmed login pages; Progressive moved off persistent profiles | core / adapter:progressive | fixed |

---

## Core and infrastructure

### F-01 · Empty env vars failed URL validation at boot

| | |
|---|---|
| **Area** | core |
| **Severity** | blocked-submission |
| **Status** | fixed |

**Symptom.** Server refused to start:

```
Invalid configuration:
  - RESIDENTIAL_PROXY_URL: Invalid URL
```

**Root cause.** `.env.example` documents optional keys by shipping them empty. Copying it to
`.env` yields `RESIDENTIAL_PROXY_URL=''`, and an empty string is not a valid URL. The app failed
on the exact path every new user takes.

**Fix.** `src/config.js` strips empty and whitespace-only values before zod parsing, so an empty
assignment is treated as absent.

**Lesson.** Validate the first-run path, not just the configured one.

---

### F-02 · Proxy sentinel leaked into non-proxied contexts

| | |
|---|---|
| **Area** | core |
| **Severity** | blocked-submission |
| **Status** | fixed |

**Symptom.** Every demo-carrier run died instantly:
`page.goto: net::ERR_PROXY_CONNECTION_FAILED at http://127.0.0.1:3000/mock-portal/login`.

**Root cause.** Playwright only honours per-context proxy overrides if the browser was launched
with *some* proxy, so a sentinel `http://per-context` was passed at launch. But a sentinel is
still a real setting: any context that did not override it inherited an unroutable proxy. The demo
portal is on loopback and was being dutifully routed to a dead proxy.

**Fix.** `src/browser/browserPool.js` installs the sentinel only when `RESIDENTIAL_PROXY_URL` is
configured, and gives non-proxied contexts an explicit `{ server: 'direct://' }` rather than
letting them inherit.

**Lesson.** A placeholder that the runtime treats as real is not a placeholder.

---

### F-03 · Event buffer nulled while handlers still wrote to it

| | |
|---|---|
| **Area** | core |
| **Severity** | misleading |
| **Status** | fixed |

**Symptom.** `Cannot read properties of null (reading 'push')` after a session settled.

**Root cause.** Events are buffered until the WebSocket attaches, because a fast failure can reach
`ERROR` before the client finishes connecting. The socket handler set `session.buffer = null`
after replaying, but the transition handlers remained subscribed and kept pushing.

**Fix.** An `attached` boolean gates the writes instead of nulling the array, and it resets on
socket close so a reconnect replays what it missed.

---

### F-04 · `detail` payload not flattened onto the wire

| | |
|---|---|
| **Area** | core |
| **Severity** | wrong-results |
| **Status** | fixed |

**Symptom.** Smoke test reported `documents returned: 0 docs` on a run that had reached
`COMPLETED` and genuinely retrieved two PDFs.

**Root cause.** The state machine nests state-specific payload under `entry.detail` to keep its
core fields a fixed shape. The client read `msg.documents` at the top level.

**Fix.** A single `toWire()` helper collapses `detail` at the transport boundary in
`src/server.js`, so clients get `msg.documents` directly and the internal shape stays tidy.

---

### F-05 · `chmod -R` in the Dockerfile killed the image build

| | |
|---|---|
| **Area** | infra |
| **Severity** | blocked-submission |
| **Status** | fixed |

**Symptom.** Hundreds of lines of
`chmod: changing permissions of '/ms-playwright/…': Input/output error`, then build failure.

**Diagnosis.** Traced to Docker Desktop's VM disk having gone read-only
(`/var/lib/docker/tmp: read-only file system`) because the host had only 13 GiB free and the
sparse disk image could not grow.

**Root cause.** Two things. The environment was out of disk, *and* the Dockerfile contained a
`chmod -R a+rx /ms-playwright` that was both unnecessary and fragile — Playwright's installer
already writes world-readable browsers, and recursing over a ~500 MB tree fails outright on a
storage driver that reports EIO partway through.

**Fix.** Removed the `chmod`. For the disk, use `fly deploy --remote-only` so the ~2 GB Playwright
base image is built on Fly's builders rather than locally.

**Lesson.** Defensive commands that touch large trees are a liability, not insurance.

---

### F-22 · Log scrubber silently emptied every request log entry

| | |
|---|---|
| **Area** | core |
| **Severity** | misleading |
| **Status** | fixed |

**Symptom.** Request logging appeared to work but every entry was hollow:

```
incoming request   {"req": {"id": "24dbaff0d0879a1e"}}
request completed  {"res": {}, "responseTime": 1.03}
```

**Diagnosis.** Probed what object Fastify actually passes to the serialiser:

```
{"which":"req","ctor":"Request","keys":["id","params","raw","query","log","body"],
 "hasMethod":true,"hasUrl":true}
```

`method` and `url` exist, but not as *own* properties.

**Root cause.** pino runs `formatters.log` **before** serialisers. The scrubber walked the log
object rebuilding every object via `Object.entries` — which sees only own enumerable properties.
Fastify's `Request` exposes `method`, `url` and `ip` as prototype getters, so rebuilding stripped
them, and the serialiser that ran next found `undefined`.

**Fix.** `scrubDeep` now rebuilds only plain objects (`Object.getPrototypeOf(v) === Object.prototype`)
and passes class instances through untouched. Serialisers read defensively from `req` or `req.raw`.

**Lesson.** See [Recurring patterns](#1-blanket-transformations-damage-what-they-do-not-understand).

---

### F-24 · `fly.toml` would have discarded all logs on deploy

| | |
|---|---|
| **Area** | infra |
| **Severity** | misleading |
| **Status** | fixed |

**Symptom.** Caught by inspection, not by failure — which is the point.

**Root cause.** `fly.toml` mounted the persistent volume at `/data` and set `DATA_DIR=/data`, but
`LOG_DIR` kept its default of `./logs` — inside the ephemeral container filesystem. Fly replaces
the container on every deploy, so the entire log history would vanish precisely when someone went
looking for a past failure.

**Fix.** `LOG_DIR = '/data/logs'` in `fly.toml`, and `LOG_DIR: /app/data/logs` in
`docker-compose.yml`, both on the mounted volume.

**Lesson.** Durable storage is not durable unless every writer points at it. Check each path
independently.

---

### F-27 · Composite phases would double-count in exclusion windows

| | |
|---|---|
| **Area** | core |
| **Severity** | wrong-results |
| **Status** | fixed |

**Symptom.** Found while building the metrics windows: summing every phase in a real Progressive
run gave **48,594 ms** against a wall clock of **40,158 ms**.

**Root cause.** Some phases wrap others. `login` contains `nav_login` + `fill_credentials` +
`submit_credentials`; `documents` contains `nav_documents`, `capture_api_auth`, `list_documents`,
`list_documents_via_page` and `document_download`. Any feature that subtracts phase durations from
wall clock will double-count unless it subtracts only non-overlapping leaves.

**Fix.** `COMPOSITE_PHASES` in `src/telemetry/metricsStore.js` records the hierarchy explicitly.
Each window's `subtract` list contains leaves only. The chart tags composites as `total` with a
footnote that they are not additive.

**Guard.** `npm run test:windows` asserts no window ever subtracts a composite, and includes the
naive-sum-exceeds-wall-clock case to document why.

**Lesson.** The failure direction matters: this bug would have reported latency *lower* than
reality, which is the worst possible direction for a number whose job is to substantiate a
performance claim.

---

## Frontend

### F-15 · `[hidden]` defeated by a class rule; modal swallowed every click

| | |
|---|---|
| **Area** | frontend |
| **Severity** | blocked-submission |
| **Status** | fixed |

**Symptom.** The MFA dialog appeared on a fresh page load, before any run had started. The DOM
showed `hidden=""` present on the overlay, and the element rendered anyway.

**Diagnosis.** Audited every element using the `hidden` attribute against the stylesheet.
`#mfa-overlay` was the only one whose CSS also set `display`.

**Root cause.** `hidden` is implemented by the UA stylesheet as `[hidden] { display: none }` —
specificity (0,1,0). `.overlay { display: flex }` is a class selector, also **(0,1,0)**. At equal
specificity the author stylesheet wins, so `display: flex` beat `hidden`.

The second-order effect is what made it so confusing. The overlay is
`position: fixed; inset: 0; z-index: 50`, so it covered the page and **intercepted every click
meant for the credential form beneath it**. One CSS bug produced three symptoms I had been
misattributing across two debugging rounds: a phantom MFA prompt, a dialog that looked orphaned,
and — critically — *no Progressive session ever reaching the server*, because the form was
physically unreachable.

**Fix.** Global `[hidden] { display: none !important; }` in `public/styles.css`. `!important` is
justified: `hidden` is a semantic assertion that an element is not relevant, and no layout rule
should be able to contradict it. It also protects future components that pair `hidden` with a
`display` value.

**Guard.** `npm run smoke:ui` loads the real page in a real browser and asserts the overlay's
**computed** `display` is `none` (the attribute was correct all along, which is why nothing I
inspected caught it), and uses Playwright's click actionability (`{ trial: true }`) rather than
`isVisible()` — because a covering overlay leaves fields visible but unclickable, which is exactly
the failure that got me.

**Lesson.** Every backend test passed throughout. The server was healthy, the state machine
correct, all API smoke checks green — and the application was completely unusable in a browser.
*"The endpoints work"* and *"a person can use this"* are different claims requiring different
evidence.

---

### F-26 · Metrics page hid a carrier whose runs had all failed

| | |
|---|---|
| **Area** | frontend |
| **Severity** | misleading |
| **Status** | fixed |

**Symptom.** User: *"I don't see any filters or metrics for the progressive."*

**Root cause.** Phase statistics were drawn from `runs.filter(r => r.outcome === 'COMPLETED')`.
Progressive had only failed runs, so it contributed no phases. It read as "no data" when the truth
was "plenty of data, all of it failures" — exactly when you most want to see how far the flow got
and how long each step took before dying.

**Fix.** `outcome` became a first-class multi-select filter. The carrier and path option lists are
built from *all* runs, so a carrier appears as soon as it produces one record of any kind.

**Lesson.** A default that filters data out should be visible and reversible in the UI, not
hardcoded in the aggregation.

---

## Tooling and observability

### F-06 · Probe reported "NO FORM FOUND" for a page that rendered fine

| | |
|---|---|
| **Area** | tooling |
| **Severity** | misleading |
| **Status** | fixed |

**Symptom.** `tools/probe-carrier.js` reported `VERDICT: NO FORM FOUND` for GEICO. The screenshot
taken moments later showed a fully rendered login form with email and password fields.

**Root cause.** Two independent issues. The probe sampled the DOM once, and GEICO mounts its app
*after* an Imperva JS challenge settles — several seconds after `networkidle`. Separately, the
form is built from web components, and `document.querySelectorAll('input')` does not pierce shadow
roots.

**Fix.** The probe now polls for the field it cares about (`waitForFunction`, 25 s) and traverses
open shadow roots via a `deepQuery` helper in `tools/lib/domInventory.js`.

**Lesson.** This is a more dangerous bug than a crash: it would have written off a working carrier
for a reason that was entirely our own. A tool that reports false negatives about the outside world
is worse than no tool.

---

### F-14 · Inspection tool closed the browser it was inspecting

| | |
|---|---|
| **Area** | tooling |
| **Severity** | misleading |
| **Status** | fixed |

**Symptom.** User: *"when I have clicked on the document I need to download it is closing the
browser."*

**Root cause.** `tools/inspect-documents.js` waited for the documents payload, then ran its
download attempts and called `process.exit(0)`. The payload arrived while the user was still
navigating, so the browser vanished mid-click.

**Fix.** The tool now holds the browser open until `q` is entered, and keeps recording PDF
responses throughout.

**Lesson.** An inspection tool that closes the thing being inspected makes a harness bug look like
a portal or anti-bot problem — the most expensive kind of misdirection.

---

### F-20 · Logged HTTP status while discarding the explanatory body

| | |
|---|---|
| **Area** | tooling |
| **Severity** | misleading |
| **Status** | fixed |

**Symptom.** A failure bundle contained `documents list request failed { "status": 400 }` and
nothing else, costing a full round-trip with the user to learn more.

**Root cause.** The log recorded only the status code. Progressive's 4xx bodies are unusually
helpful — previous ones read `"AccountSession header missing"` and `"policyInfoKey missing"`, each
naming its own fix — and all of that was being thrown away.

**Fix.** Both the list and download paths now log the response body (truncated to 300 chars) plus
the sorted header names actually sent, so a route-scoped header can be found by diffing against a
known-good set.

**Lesson.** When an upstream tells you what is wrong, record it. A status code is a category; a
body is an answer.

---

### F-21 · Server log lost to `/dev/null`, costing a debugging round

| | |
|---|---|
| **Area** | tooling |
| **Severity** | misleading |
| **Status** | fixed |

**Symptom.** A real Progressive failure had to be diagnosed from metrics timings alone, because
the log did not exist.

**Root cause.** The server had been started with output redirected to `/dev/null` during an
unrelated command. Logging depended entirely on how the process happened to be launched.

**Fix.** Logging is now owned by the application (`src/logging/rotatingFile.js`), writing NDJSON to
`logs/app.log` with size-based rotation regardless of how the process starts. Plus:

- process-level faults (`uncaughtException`, `unhandledRejection`, warnings) route into the log
- every failed run automatically writes a self-contained bundle to `logs/failures/`
- token-gated HTTP endpoints serve logs off a deployed instance with no shell access

**Lesson.** Observability that depends on the invocation is not observability. Rotation was
hand-rolled rather than using pino's `transport` because that runs the sink in a worker thread, and
lines queued for that worker are lost on abrupt exit — exactly the crashes whose last lines matter
most.

---

### F-25 · Secret audit flagged its own redaction markers

| | |
|---|---|
| **Area** | security |
| **Severity** | cosmetic |
| **Status** | fixed |

**Symptom.** `npm run audit:secrets` failed on
`"password": "<redacted len11>"` — its own redaction marker.

**Fix.** Known-good placeholders are recognised explicitly (`isRedactionMarker`), and the password
pattern uses a capture group so the *value* is tested rather than the whole field.

**Lesson.** An audit that reports a finding on every run trains everyone to ignore it, at which
point it is worse than no audit — the one real leak arrives amid the noise and gets waved through.
The audit's own correctness is also now verified with a **negative control**: planting a real
secret must make it fail. An audit that always passes is indistinguishable from no audit.

---

## Security

### F-09 · Flow recorder leaked bearer tokens two different ways

| | |
|---|---|
| **Area** | security |
| **Severity** | wrong-results |
| **Status** | fixed |

**Symptom.** A secret sweep over `artifacts/` found **11 JWT occurrences** in
`recording.json` — a file explicitly designed to be safe to share.

**Root cause.** Two independent leaks, in a function whose entire purpose was redaction.

1. The `authorization` header was routed through the *cookie-name* branch, which splits on `[;,]`
   and takes everything before the first `=`. That is correct for cookies. Applied to
   `Bearer eyJhbGciOi...`, a JWT contains no `;`, no `,` and no `=` until its trailing padding — so
   roughly 100 characters of live token survived "redaction" intact.
2. Worse, and separately: **every request URL was recorded**, and Progressive completes login with
   an OAuth implicit flow that puts the access token in a URL *fragment*
   (`/app/account-entry-headless#access_token=eyJ...`). Eight full three-segment JWTs were captured
   that way. Redacting headers and forgetting URLs leaks the same secret by a different route.

**Fix.**

- Credential-bearing headers are reduced to their scheme (`Bearer <redacted len812>`); only
  actual cookie headers take the name-extraction path.
- The string scrubber catches JWT shapes and `*_token=` parameters wherever they appear, including
  inside URLs.
- `tools/scrub-recording.js` cleans files already written; all 11 occurrences were removed and the
  `.bak` holding the originals was deleted.

**Guard.** `npm run audit:secrets`, run as part of `npm run smoke:all`.

**Lesson.** Redaction is a security control, not a tidiness preference, and security controls must
be *tested* rather than assumed. Enumerate every channel a value can escape through — headers,
URLs, error messages, request bodies — not just the obvious one.

**Related finding (not a bug, but know about it).** `data/profiles/` holds Chrome profiles. They
contain live session cookies, which is what makes the warm path work, *and* the carrier's OAuth
access token — because the token arrives in a URL fragment and Chrome records visited URLs in
`History` and its session-restore files. Nothing this app writes puts it there; Chrome does.
Consequences: `data/` is gitignored and must stay so; a profile directory is credential-bearing and
must never be attached to a bug report; `npm run profiles:clear` purges them. Diagnostic bundles
never include profile contents, which is why logs remain shareable.

---

### F-23 · Diagnostics token leaked into the log it protects

| | |
|---|---|
| **Area** | security |
| **Severity** | wrong-results |
| **Status** | fixed |

**Symptom.** Found by inspection while enabling request logging.

**Root cause.** The diagnostics endpoints accept `?token=<DIAGNOSTICS_TOKEN>` as an alternative to
a bearer header, and request logging records URLs. Every authenticated diagnostics fetch would have
written the diagnostics token into the very log file it was guarding.

**Fix.** A `\b(token=)[^&\s#"]{8,}` scrub pattern in `src/logger.js`. Verified: the logged URL
reads `/api/diagnostics?token=<redacted>`.

**Lesson.** A credential that can travel in a query string will end up in a log. Assume it.

---

## Carrier: Progressive

Progressive's portal is an Angular SPA in front of **PingFederate** for authentication and a
**bearer-guarded REST API** (`api.progressive.com/policypro`) for data. Almost every entry below
follows from one of those two facts.

### F-07 · Progressive login URL was a 404, misread as a block

| | |
|---|---|
| **Area** | adapter:progressive |
| **Severity** | misleading |
| **Status** | fixed |

**Symptom.** Probing `https://account.apps.progressive.com/access/ez/login` returned HTTP 200 with
no form and no bot cookies. Easy to read as "anti-bot served us an empty shell".

**Diagnosis.** The screenshot showed *"Looks like something's missing…"* — an ordinary 404 page.

**Root cause.** Wrong URL. The real login is `/access/login`.

**Lesson.** Screenshot before concluding. A naive run would have written off the most tractable
major carrier on the shortlist as blocked.

---

### F-08 · Portal DOM ids are regenerated on every page load

| | |
|---|---|
| **Area** | adapter:progressive |
| **Severity** | wrong-results |
| **Status** | fixed |

**Symptom.** Captured selectors were `#input2973408885337655` (username) and
`#input7764162441832154` (OTP).

**Root cause.** Progressive generates DOM ids per page load. Only `#inputPassword` is stable.
An adapter built by copying ids out of devtools works once and then fails permanently, in a way
that looks like anti-bot but is not. Lemonade's email field does the same.

**Fix.** All locators are placeholder-, label-, `name`- or type-based. `tools/lib/domInventory.js`
flags machine-generated ids (`idLooksGenerated`) and `suggestSelector()` refuses to emit them.

**Lesson.** `LOAD-BEARING`: do not "tidy" these selectors into ids.

---

### F-16 · OTP stale-read race rejected correct verification codes

| | |
|---|---|
| **Area** | adapter:progressive |
| **Severity** | wrong-results |
| **Status** | fixed |

**Symptom.** A correct code was reported as wrong, then the run died with a misleading
`Progressive OTP field not found` 25 seconds later. The log sequence:

```
OTP_REQUIRED
MFA code rejected, retrying          <- us, ~0ms after submit
MFA_COMPLETED                        <- Progressive, 472ms later: the code was RIGHT
DEVICE_PROPERTIES_REQUIRED
…25s later: "Progressive OTP field not found"
```

**Root cause.** `#waitForFlow` compared against the **cached** PingFederate status, which already
held `OTP_REQUIRED` from when the challenge was issued. The instant the user's code was submitted,
the wait matched that stale value, concluded "still OTP_REQUIRED, therefore rejected", and looped
back for another code. The real `MFA_COMPLETED` arrived half a second later, by which point the
state machine had moved on and the page had navigated to the dashboard — hence the selector error
pointing at the wrong thing entirely.

**Fix.** A monotonic `#flowSeq` counter increments on every observed flow response. Callers
snapshot it before acting and pass `afterSeq`, so only genuinely new information can satisfy a
wait. Acceptance and rejection are then resolved in a single loop — asymmetric waiting would either
be slow for a typo or reintroduce the race — with a 1.5 s grace before treating a re-issued
`OTP_REQUIRED` as a rejection.

**Guard.** `npm run test:race` — no browser, no network, ~1 s. It includes the *buggy* waiter to
prove the test detects the original defect (it returns the stale value in 0 ms).

**Lesson.** Never resolve a wait against state that predates the action. This is the worst class of
bug in this system: the user has no way to tell it is not their mistake, and every retry costs a
real SMS.

---

### F-10 · Carrier API is bearer-guarded, not cookie-guarded

| | |
|---|---|
| **Area** | adapter:progressive |
| **Severity** | blocked-submission |
| **Status** | fixed |

**Symptom.** Every document strategy returned `401 {"error":"Authentication denied."}`.

**Root cause.** I had written that `context.request` "shares any Authorization header the SPA
established". It does not — it shares the **cookie jar**. `api.progressive.com` is guarded by a
bearer token minted through an OAuth implicit flow and attached by an Angular HTTP interceptor, so
it lives in page JS memory where the cookie jar cannot see it.

**Fix.** Observe a `/policypro` request the app makes anyway and **replay its headers verbatim**.
Strictly better than extracting the token: if Progressive rotates a key or adds a required header,
we inherit the change for free instead of reconstructing it.

**Lesson.** Verify which credential actually guards an endpoint before designing around it.

---

### F-11 · Header allowlist could not guess a vendor's private protocol

| | |
|---|---|
| **Area** | adapter:progressive |
| **Severity** | blocked-submission |
| **Status** | fixed |

**Symptom.** Progress from F-10's 401 to `400 "AccountSession header missing"`.

**Diagnosis.** Dumped every header name the SPA sends to `api.progressive.com`. The required header
is **`x-prgaccountsessionid`** — which my own recorder had been redacting, because the name matches
`session`. There is a whole family alongside it: `x-prgsessiondatalocation`, `x-pgrotg`,
`x-siteserverpgrid`, `x-exdcontext`.

**Fix.** Inverted the rule. Carry **all** headers the real client sent (23 of them), denying only
what must not be replayed: `cookie` (supplied by the jar), `content-length` (recomputed), and
connection-level headers. `accept-encoding` is also dropped — otherwise we may receive Brotli we do
not decode and mistake a valid PDF for garbage.

**Lesson.** Enumerating a vendor's internal header protocol by guessing is unwinnable. Copy what
the real client sends and subtract only what you know is wrong.

**Note.** `api_key` differs per sub-app (`account.apps` vs `policyservicing.apps`), so the observer
is scoped to `/policypro` requests to capture the documents app's key.

---

### F-12 · `policyInfoKey` required in query *and* body, varies per policy

| | |
|---|---|
| **Area** | adapter:progressive |
| **Severity** | wrong-results |
| **Status** | fixed |

**Symptom.** `400 "policyInfoKey missing"` on the POST `Detail` action even after it was included
in the request body.

**Root cause.** The endpoint reads it from the query string. And the value is per-policy: this test
account has `WA-AA` and `CA-AA`.

**Fix.** Parsed out of `_links.target.href` at runtime and sent in both query and body. Hardcoding
it would have broken the second policy.

---

### F-13 · PDF arrives base64 inside a JSON envelope

| | |
|---|---|
| **Area** | adapter:progressive |
| **Severity** | wrong-results |
| **Status** | fixed |

**Symptom.** A completely successful request looked like a failure. HTTP 200, 94,860 bytes, and the
magic-byte check reported "not a PDF".

**Root cause.** The document endpoint returns `application/json`:

```json
{"mimeType":"pdf","document":"JVBERi0xLjcKJeLjz9MK..."}
```

(`JVBERi0x` is base64 for `%PDF-1.`) A magic-byte check on the raw response sees `{"mim`. The
envelope has to be opened first — and my unwrapper guessed at `content`, `documentContent`, `data`,
`fileContent` and `pdf`, missing the actual key, which is `document`.

**Fix.** `document` is now checked first in `#unwrapJsonDocument`, with the other candidates
retained as fallbacks. Verified by decoding the captured prefix to `%PDF-1.7`.

**Lesson.** Do not infer failure from a content-type mismatch. Check whether the payload is wrapped.

---

### F-17 · Hard navigation destroyed the SPA's in-memory OAuth token

| | |
|---|---|
| **Area** | adapter:progressive |
| **Severity** | blocked-submission |
| **Status** | fixed |

**Symptom.** After a fully successful login, the document phase failed with `NO_DOCUMENTS`. The
page showed *"Time's up! Your session timed out because we haven't seen any activity in a while."*
and made **zero** API requests.

**Diagnosis.** `tools/trace-documents-page.js` navigated to three app routes with a valid profile
and logged every API call. All three landed on `/app/session-timeout` with `API CALLS (0)`.

**Root cause.** The access token lives in page JS memory (it arrives in a URL fragment and is
attached by an interceptor). `page.goto()` is a hard navigation: it destroys that JS context, the
app reloads with no token, cannot complete its handshake, and redirects to the timeout screen. **The
symptom is an expired session while nothing has expired — we threw the credential away ourselves.**

This is precisely why the user's manual recording worked and the adapter did not. They *clicked*
through the app and never left the JS context; the adapter teleported.

**Fix.** Do not navigate when already inside the app. Since the document list and the documents
themselves are plain REST endpoints, the adapter borrows the app's headers and calls the API
directly — removing two page loads from the critical path as a bonus.

**Lesson.** `LOAD-BEARING`: in an SPA that holds credentials in memory, `page.goto()` is
destructive. Treat in-app navigation and hard navigation as different operations.

---

### F-18 · `isSessionValid()` returned confident false positives

| | |
|---|---|
| **Area** | adapter:progressive |
| **Severity** | misleading |
| **Status** | fixed |

**Symptom.** The warm-path probe reported `session valid: true` for a session that was completely
dead. Same run, moments later: `final url: /app/session-timeout`, `API TRACE (0 calls)`.

**Root cause.** The check pattern-matched the URL against a list of app routes. Angular serves the
requested route, *then* discovers it has no usable token, *then* redirects. Sampling inside that
window reports a healthy session that is about to evaporate — and the caller then skips the login
it actually needed, failing later with a misleading "no documents found".

**Fix.** `#confirmAuthenticated()` waits for **an authenticated API call that returned 2xx**
(`#apiAuthOk`), which is the only real evidence, and short-circuits to `false` on
`/app/session-timeout` or a login bounce. Costs a second or two on the warm path and removes a whole
class of phantom failure.

**Lesson.** A URL is not proof of authentication. Neither is a rendered dashboard shell. Prove it
with a successful authenticated request.

---

### F-19 · Some carrier API headers are route-scoped

| | |
|---|---|
| **Area** | adapter:progressive |
| **Severity** | wrong-results |
| **Status** | worked around |

**Symptom.** `GET /v1/account/documents` returns **400** with headers harvested on
`/app/account-home`, and **200** with headers harvested on
`/app/documents-hub/find-document`. Identical URL.

**Root cause.** Not fully determined. Something in the `x-prg*` / `x-pgr*` family is established by
the documents route itself. The specific header has not been isolated.

**Workaround.** Rather than reverse-engineer which header and how it is minted, ask the application
to do it: if the direct call fails, load the documents page and let Progressive issue its own
correctly-credentialled request, captured through the observer already listening. A hard navigation
is safe *here* (unlike F-17) because the app re-bootstraps from cookies, which the inspection runs
confirmed works. It also refreshes the harvested headers to the route-scoped set, which the download
then needs.

Ordering is deliberate: direct call first (~400 ms, no page load), page fallback second (slower,
proven). Observed working: `list_documents` 351 ms fails through to `list_documents_via_page`
1,779 ms.

**Open question for a future pass.** Diff the header sets between the two routes — F-20's logging
now records `sentHeaderNames` — and identify the one that matters. That would let the fast path work
unconditionally and remove a page load.

---

### F-28 · Wrong declarations document selected

| | |
|---|---|
| **Area** | adapter:progressive |
| **Severity** | wrong-results |
| **Status** | fixed — see F-29 for the implementation |

**Symptom.** User: *"it is not pulling the right document"*. The run succeeds and returns 3 PDFs,
but not the one a person asking for "my declarations page" means.

**Diagnosis.** The account holds two policies, and the payload distinguishes them in a way the
adapter ignores.

`WA-AA` — **active**. `terms[].documentTerms[0]`:

```json
{ "effectiveDate": "2026-09-02T00:00:00-04:00",
  "expirationDate": "2027-03-02T00:00:00-05:00",
  "isEligibleForRealTimeDocument": true }
```

`CA-AA` — **not active**:

```json
{ "documentType": "Declarations", "documentTerms": [], "messageKey": "Readonly",
  "message": "This policy isn't active, so a current Declarations Page isn't available.
              But you can see other Declarations Pages that we've issued in the past." }
```

Declarations candidates found, all `type: "DECPAGE"`, all titled exactly `"Declarations Page"`:

| policy | index | archiveDate | active? |
|---|---|---|---|
| WA-AA | 25 | 2026-09-02 | yes |
| WA-AA | 22 | 2026-09-02 | yes |
| CA-AA | 8 | 2026-08-03 | **no** |
| CA-AA | 34 | 2026-03-05 | **no** |

Current `#selectDocuments` sorts declarations-first then `archiveDate` descending as a *string*,
then `.slice(0, 3)`. So it returns WA-25, WA-22, **CA-8** — a historical document from an inactive
policy presented as a peer of the live one. All three are named `Declarations Page.pdf` with label
`Declarations Page`, so a user cannot tell them apart.

Three distinct defects:

1. **No policy-level filtering.** Candidates from all accounts are concatenated and ranked
   together. `account.terms`, `isEligibleForDecPreview` and `fullListIndicator` are never read —
   `grep` for them in the adapter returns zero hits.
2. **Cannot disambiguate within a policy.** WA-25 and WA-22 share `type`, `title`, `categories`,
   `deliveryType` **and** `archiveDate`. The comparator returns 0 and stable sort falls back to
   payload order — i.e. list position, the exact thing the method's own docstring claims to avoid.
3. **Labels are not distinguishing.** `#downloadDocument` returns only `title`, dropping `index`,
   `archiveDate` and policy period, so three different documents surface identically.

Also noted: WA-AA's current term has `isEligibleForRealTimeDocument: true` and the account exposes
a `Detail` action — a live current-declarations path the adapter never uses. It only ever fetches
archived copies via `_links.target` → `/documents/Archive/{index}`. CA-AA has `actions: []`, so it
has no `Detail` fallback at all.

**Planned fix.** Read `account.terms` to identify the in-force term, prefer the active policy,
rank by term effective date rather than archive date, label documents with policy and term so they
are distinguishable, and investigate the real-time document path for the genuinely current page.

**Caveat on evidence.** `documents-structure.json` is a filtered capture: the accounts declare 40
and 43 documents but only 4 each were recorded. Additional `DECPAGE` rows may exist in the live
payload, so the fix must not assume exactly two per policy.

---

## Recurring patterns

Three separate bugs shared one root cause, and two more shared another. Worth internalising.

### 1. Blanket transformations damage what they do not understand

| Entry | The transformation | What it broke |
|---|---|---|
| F-05 | `chmod -R` over the browser tree | build failed with EIO |
| F-15 | `.overlay { display: flex }` over `[hidden]` | modal always visible, swallowed clicks |
| F-22 | `Object.entries` rebuild of every log object | prototype getters lost, `req={}` |

Each was written as a sweeping "apply X to everything" rule and each silently corrupted a case the
author had not considered. When reaching for a recursive or global operation, enumerate what it will
touch.

### 2. A tool that lies is worse than no tool

| Entry | The lie |
|---|---|
| F-06 | "NO FORM FOUND" for a page that rendered perfectly |
| F-14 | Closed the browser, making a harness bug look like anti-bot |
| F-18 | "session valid: true" for a dead session |
| F-25 | Failed on its own redaction markers |

A false negative about the outside world sends you debugging the wrong system. Every diagnostic in
this repo now has either a negative control or an explicit "what would prove this wrong" check.

### 3. Carrier 4xx bodies are documentation

Progressive's errors named their own fixes three times in a row: `"Authentication denied"` →
`"AccountSession header missing"` → `"policyInfoKey missing"`. Each moved the failure exactly one
layer deeper. Always log the body (F-20).

### 4. Distinguish "the endpoint works" from "the feature works"

F-15 is the canonical case: every API test green, application unusable. F-04 and F-26 are milder
versions. Test at the layer the user experiences.

---

## Still open

| Item | Blocker |
|---|---|
| **F-19** — identify the route-scoped header | needs a header diff between the two routes; F-20's logging now records `sentHeaderNames` |
| Real-time current document path unused | WA-AA reports `isEligibleForRealTimeDocument: true`; adapter only fetches archived copies (see F-29) |
| Residential proxy not configured | needs an account (~$4/GB pay-as-you-go) |
| Not yet deployed | needs `fly deploy --remote-only`; local Docker blocked by host disk (F-05) |
| GEICO adapter | ~~ruled out: login form is in a **closed** shadow root, automatable only via keyboard-focus traversal or coordinate clicks~~ **← SUPERSEDED BY F-32. This was wrong.** There is no shadow DOM on the page; it is a Flutter Web app that mounts 2.3–6.2s late. Ordinary attribute selectors work, verified by read-back. |
| Second carrier | ~~Travelers is the recommended candidate~~ **← superseded by F-32:** GEICO is viable and is being built instead. Travelers remains the fallback. |

---

### F-29 · Document target was hardcoded, and ranking ignored policy status

| | |
|---|---|
| **Area** | adapter:progressive |
| **Severity** | wrong-results |
| **Status** | fixed — resolves F-28 |

**Symptom.** Two related complaints. The adapter returned three PDFs when one was wanted, all
titled `Declarations Page`, one of them from a lapsed policy (F-28). And the target itself was
wrong: the user wanted the **Policy Contract**, which the previous code explicitly excluded.

**Diagnosis.** The payload carries three pieces of information the adapter never read:

1. `account.terms[].documentTerms` — the policy periods. Populated for the in-force policy; empty
   with `messageKey: 'Readonly'` for a lapsed one, alongside Progressive's own text: *"This policy
   isn't active, so a current Declarations Page isn't available."*
2. `filterCategories` — the carrier's document taxonomy, and the source of the portal's
   "Filter view:" dropdown options: `All | Billing | DecPage | Contract | SentBy | Forms`.
3. `doc.categories` — per-document membership in those categories.

`grep` for `terms|isEligibleForDecPreview` in the adapter returned zero hits before this change.

**Root cause.** Three separate defects:

- **Target hardcoded.** "The policy document" is genuinely ambiguous between the contract (the
  terms), the declarations page (the coverage summary) and ID cards. The adapter picked one
  interpretation in a regex and excluded another in a comment.
- **No policy-status awareness.** Candidates from all accounts were concatenated and ranked
  together, so a document from a dead policy could outrank one from the live policy.
- **Non-deterministic tie-break.** Sorting used `String(b.archiveDate).localeCompare(...)`. Two
  candidates shared type, title, categories *and* archiveDate, so the comparator returned 0 and
  stable sort fell through to payload order — i.e. list position, the exact thing the method's own
  docstring claimed to avoid.

**Fix.**

- `DOCUMENT_TARGETS` maps a target name onto the carrier's own `categoryKey` plus a
  preference-ordered `types` list. Selecting `contract` applies `categories.includes('Contract')`,
  which is exactly what choosing "Policy Contracts" in the dropdown does client-side.
- `DOCUMENT_TARGET` (`contract` | `declarations` | `idcard`, default `contract`) and
  `DOCUMENT_LIMIT` (default **1**) are configuration.
- `#policyStatus(account)` derives `{ active, readonly, termEffective, termExpiration,
  realTimeAvailable }` from `account.terms`.
- Ranking is now explicit and total: **active policy → preferred type → newest archive date (parsed
  as a Date, not compared as text) → highest archive index** as a deterministic final tie-break.
- Returned documents are self-describing: `Policy Contract - 9611 (07/16) — policy ••0482 · issued
  2016-08-31`, with `meta` carrying document type, archive index and date, term period and policy
  status. Policy number is truncated to four digits in the label (labels reach the UI and document
  metadata); the full value stays in `meta`.
- `NO_DOCUMENTS` for this target now reports which categories the account *does* hold, because the
  usual cause is a target/account mismatch rather than a failure.

**Why not drive the actual `<select>`.** It would be the literal reading of "select that option", and
it is worse. The element carries a machine-generated id that changes every page load (F-08), and
there are **two** of them on screen — one per policy — so driving the control means first solving
which one. The dropdown only filters an already-fetched client-side list by category key; applying
the same key to the same payload server-side is equivalent and has no selector surface.

**Guard.** `npm run test:documents` — no browser, no network, ~1 s. Runs the adapter's real
selection method against a fixture mirroring the captured payload (WA-AA active, CA-AA readonly) and
asserts: exactly one document returned; `POLICYCONTRACT` preferred over `POLICYCONTRACTEASIER`; the
active policy's contract (index 30) chosen over the lapsed one (index 38); every active-policy
candidate ranks above every lapsed one at higher limits; the declarations target still avoids the
lapsed policy; an unavailable target returns empty rather than something wrong; and selection is
deterministic across runs.

Selection needed a **test seam** (`selectDocumentsForTest`) because it is pure and is where the bug
lived, whereas an end-to-end run would have passed: the run succeeds, the PDFs are valid, they are
simply the wrong ones. Overrides are passed as parameters rather than via `process.env`, because
`config` is frozen at import time — mutating the environment between cases would silently have no
effect and every case would test the same target.

**Lesson.** When a carrier ships its own taxonomy — categories, types, term records — use it.
Title-matching and list position are guesses about a UI; `categories.includes('Contract')` and
`documentTerms.length > 0` are the carrier telling you the answer. Also: a bug that returns valid
data which is merely *wrong* cannot be caught by an end-to-end test, so it needs a unit test at the
decision point.

**Still worth a look.** WA-AA's in-force term reports `isEligibleForRealTimeDocument: true`, and the
account exposes a `Detail` action. That is a live current-document path the adapter never uses — it
only fetches archived copies via `_links.target` → `/documents/Archive/{index}`. For declarations
specifically, that may be the difference between the genuinely current page and the most recently
archived copy.

---

### F-30 · Latency work: two blind polls, one silently broken optimisation, one self-inflicted regression

| | |
|---|---|
| **Area** | adapter:progressive / core / frontend |
| **Severity** | wrong-results (the regression), misleading (the rest) |
| **Status** | fixed |

**Trigger.** User asked which steps could be made asynchronous or pre-processed, pointing at two
status lines: *"Asked Progressive to remember this device… 37.3s"* and *"Completing device trust…"*.

**Measurement first.** A completed Progressive run decomposed as:

| Block | Time | Accounted for by children |
|---|---|---|
| `acquire_context` | 824ms | — |
| `login` | 9,613ms | 3,205ms → **6.4s unattributed** |
| `mfa_submit` | 8,285ms | ~400ms typing → **~7.9s unattributed** |
| `documents` | 4,851ms | 405 + 2,251 + 2,124 |

Five separate findings came out of chasing those two gaps.

---

#### 1. The UI was reporting cumulative elapsed as if it were step duration

The status log showed one clock. A line reading `37.3s` meant "this happened 37.3 seconds into the
run", but reads exactly like "this step took 37.3 seconds" — which is how it was reported, and it
sends you optimising the wrong step.

**Fix.** Each line now leads with the delta since the previous line (`+2.1s`) with cumulative shown
quietly beside it, and anything over 3s is highlighted.

**Lesson.** If a number can be misread as a different quantity, it will be. Label the one that
drives decisions.

---

#### 2. The device-trust optimisation had never worked, and said it had

`check({ timeout: 3000 }).catch(() => {})` followed unconditionally by
`notify('Asked Progressive to remember this device…')`.

Progressive renders that checkbox the way most design systems do: the real input sits under a
styled proxy that intercepts pointer events. Playwright's `check()` waits for actionability, never
gets it, and burns the full ceiling. Reproduced in isolation:

| | elapsed | result |
|---|---|---|
| `check({ timeout: 3000 })` | **3,003ms** | `isChecked: false` |
| `check({ force: true })` then verify | **19ms** | `isChecked: true` |

3,029ms of the 8,285ms `mfa_submit` was this. But the wasted time was the lesser problem: the
`.catch(() => {})` swallowed the timeout and the message claimed success regardless. **The single
largest optimisation in this adapter — skipping the SMS on repeat runs — appears never to have
functioned**, and nothing in the logs said so. Every run took the cold path with a fresh challenge,
which is entirely consistent with what was observed and was attributed to session expiry.

**Fix.** `force: true` to bypass the actionability wait, `isChecked()` to find out what actually
happened, a `<label>` click as fallback, and an honest `log.warn` when it still fails.

**Lesson.** `.catch(() => {})` around an action, followed by a message asserting the action
succeeded, is a lie waiting to happen. Verify the postcondition or do not claim it.

---

#### 3. An unconditional 3.5s poll for a screen that usually is not there

`#clearDevicePropertiesPrompt()` ran after every accepted code, with a 3,500ms selector timeout.
On runs with no interstitial it waited the full duration for an element that would never appear.

Also latent: `button:has-text("Continue")` matches both the OTP form's submit button and the
interstitial's, so on a page that had not yet navigated it could re-click the OTP submit. Now it
waits for the OTP field to disappear first.

---

#### 4. The regression: gating on a status snapshot broke authentication outright

Fixing (3) by checking `status === DEVICE_PROPERTIES_REQUIRED` at the moment of acceptance looked
obviously right and was wrong. **PingFederate emits `MFA_COMPLETED` before
`DEVICE_PROPERTIES_REQUIRED`**, so the check always saw the former, skipped the click that advances
`setDeviceProperties`, and left the flow incomplete:

```
flowHistory: CREDENTIALS_REQUIRED → AUTHENTICATION_REQUIRED → OTP_REQUIRED
             → MFA_COMPLETED → CREDENTIALS_REQUIRED      <- flow restarted
apiAuthOk: false     url: …/access/login?fd=accountHome
```

Progressive tore the session down ~1s later and the run failed in the document phase with
`NO_DOCUMENTS` and the message *"Progressive signed this session out"* — pointing at the wrong
place entirely.

**This is F-16's lesson violated from the opposite direction.** F-16 was resolving a wait against
state that predated the action; this was resolving a *decision* against state that predated the
event it was about. Having written "never resolve a wait against state that predates the action"
did not prevent making the mirror-image mistake three days later.

**Fix.** `#settleAfterMfa()` waits for whichever comes first: `DEVICE_PROPERTIES_REQUIRED` (handle
it), an authenticated API call succeeding, or an app route — capped at 8s. Neither a snapshot nor a
blind poll.

**Guard.** `npm run test:race` scenario 6 asserts the buggy snapshot check skips the interstitial,
that the settle loop handles a late one, that it exits fast when none arrives, and that it reports
a timeout rather than a false success.

---

#### 5. ~6 seconds of the login phase was invisible

`nav_login` measures only `page.goto(..., { waitUntil: 'domcontentloaded' })`, which returns when
the HTML shell parses. Progressive's login is an Angular app and the form does not exist for several
seconds after that. The wait was happening inside an unmeasured `firstVisible` call:

```
nav_login 1,563ms + fill_credentials 719ms = 2,282ms
status line covering the whole stretch        = 8,350ms
                                      unattributed ≈ 6,068ms
```

**Fix.** Added an `await_login_form` phase, registered in `COMPOSITE_PHASES` under `login` and in
the metrics page labels.

**Lesson.** `domcontentloaded` is not "ready" for an SPA, and an unmeasured wait is an invisible
cost. This one is the largest controllable item in the cold path, and it could not have been argued
about — let alone justified pre-warming against — while nobody could see it.

---

#### Other changes in this pass

- **Typing delay** 24–92ms → 10–35ms (`TYPE_MIN_DELAY_MS` / `TYPE_MAX_DELAY_MS`). The requirement is
  firing `input`/`keyup` events; any non-zero delay satisfies it. Saves ~700ms across username,
  password and code.
- **`persist_session` off the critical path.** It is bookkeeping for future runs and has no bearing
  on the documents already in hand. Backgrounded, awaited at teardown so a fast shutdown cannot lose
  it, and metrics are now recorded *after* cleanup so its cost still appears.
- **Direct documents-list call memoised.** F-19 means it 400s for this deployment every time;
  skipping it after the first failure saves ~400ms per run. Static, self-correcting on restart.
- **Removed the `input[type="checkbox"]` fallback** from the remember-device lookup. On a screen with
  more than one checkbox it would tick an arbitrary one — silently opting a user into something
  unrelated is worse than missing an optimisation.

#### Results

| | before | after |
|---|---|---|
| Demo cold path (machine) | 3,560ms | **2,159ms** |
| Demo warm path | 495ms | **428ms** |
| `fill_credentials` | ~1,600ms | **719ms** |
| `mfa_submit` | 8,285ms | **1,008ms** |
| Progressive total (machine) | 23,760ms | **12,736ms** |

`mfa_submit` fell 8.2× because nearly all of it was the two blind polls, not work.

#### Still open

The `await_login_form` gap (~6s) plus `nav_login` (~1.6s) and `acquire_context` (~0.8s) is **~8.4s
that happens after the user submits but could happen while they are typing**. Pre-warming a context
and parking it on the login page would remove it. Progressive needs the username early, since its
persistent profile is keyed on it; the password would still arrive only at submit. Larger than the
~2.6s originally estimated, because that estimate predated measuring the form-render wait.

---

### F-31 · Pre-warmed login pages, and why only the cold path can have them

| | |
|---|---|
| **Area** | core / adapter:progressive |
| **Severity** | performance |
| **Status** | fixed |

**Idea (user's).** Open Playwright pages for each carrier in advance, park them on
the login form, and when credentials arrive type straight into the waiting page.

**The constraint that made it work.** My earlier proposal was to have the frontend
send the username early, so a per-user persistent profile could be pre-warmed. The
user declined — correctly. Thinking again produced a better framing:

| Path | Needs username? | Cost | Pre-warmable? |
|---|---|---|---|
| Warm (saved `storageState`) | yes, to locate the state | ~0.4s | no, and it does not matter |
| **Cold (fresh login)** | **no** | ~12.7s | **yes** |

The path that cannot be pre-warmed is the one that does not need it, and the path
that needs it requires nothing user-specific. So a parked page is **anonymous** by
design, and no credential ever has to arrive early.

**What it removes.** Everything up to "the login form is on screen and
interactive": a browser context, the navigation, and the carrier SPA's bootstrap.
Measured prepare cost for Progressive across runs: **2,703ms / 6,437ms /
19,063ms**. Adoption itself takes **4-6ms** — validation only. The variance is the
strongest argument for the feature: the user never pays it, whatever it happens to
be that minute.

**Design constraints, and why each exists.**

1. *Never make a pull fail.* Adoption is opportunistic; `adopt()` returns null for
   anything it is not certain about and the caller falls through to a normal cold
   acquire.
2. *Staleness is refused, not hoped over.* Progressive mints a PingFederate
   `flowId` per login-page load. A page parked too long submits against an expired
   flow, which fails **after** the user has typed — worse than no pre-warming.
   Entries carry a TTL and are re-validated immediately before handover.
3. *Do not become a beacon.* Refreshing parked pages on a timer would mean dozens
   of login-page loads per hour from one residential IP with zero logins — a
   distinctive pattern, and the opposite of the rest of the anti-bot work.
   Replenishment is lazy and demand-driven, so page loads stay proportional to
   real pulls.
4. *Sticky egress survives.* Each entry is created with its own sticky proxy
   session, inherited by the pull, so login → MFA → documents still leave from one
   IP.

**Consequential change: Progressive no longer uses a persistent profile.**
`launchPersistentContext` needs a profile key, ours is derived from the username,
and the username is unknown until submit — so a per-user profile is
fundamentally un-pre-warmable. Switching to a pooled context was justified by
three things: device trust never actually worked anyway (F-30), `storageState`
carries the same cookies while being encrypted *and* portable across redeploys
(profiles are machine-local and destroyed by every Fly deploy), and it removes a
full browser launch (~824ms) per session. The cost is Patchright's
persistent-context stealth recommendation, which we give up; still running real
Chrome via `channel` mitigates it, and it is revisitable per carrier.

**Two problems found while testing it.**

*Prepare borrowed the wrong timeout.* It used `NAV_TIMEOUT_MS` (20s), sized for a
navigation a user is waiting on. Observed `page.goto: Timeout 20000ms exceeded`
against Progressive on a slow load, which left nothing parked and silently
forfeited the optimisation. Now `PREWARM_TIMEOUT_MS` (45s) — nobody is waiting on
background work — plus two bounded retries with backoff, so one transient blip
does not make the next real user pay full price.

*Lazy replenishment alone had a timing hole.* A page parked at boot has usually
expired by the time anyone arrives (`expiresIn=0s` observed), so the first real
pull got no benefit. Fixed with `POST /api/prewarm`, which the UI calls when a
carrier is selected: the page is parked while the user types, landing ~15-30s
ahead of submission and well inside both the TTL and the carrier's token
lifetime. It takes only a carrier id — no credentials — and a repeat call
correctly reports `already-parked` rather than reloading.

**Guard.** `npm run test:prewarm` (add `--carrier demo` for a loopback-only run).
The assertions that matter are the safety ones, not the speed one: a healthy entry
is accepted; expired TTL, a page that navigated away, a missing form and a closed
page are each refused with the correct reason; a carrier with no `prewarm` block
returns null without throwing; and a second adoption never hands over the same
page. Kept out of `smoke:all` on purpose — it loads a real carrier login page, and
the whole point of constraint 3 is not doing that on a schedule.

**Lesson.** The obstacle that looked fatal — "we cannot pre-warm because we do not
know the user" — dissolved once the two paths were separated. Worth checking
whether a blocker applies to the whole problem or only to the half that does not
need solving.

---

### F-32 · GEICO was ruled out for a reason that was wrong

| | |
|---|---|
| **Area** | tooling / adapter:geico |
| **Severity** | blocked-submission (a whole carrier was written off) |
| **Status** | fixed — verdict overturned, GEICO is viable |

**Symptom.** GEICO had been recorded as **not automatable** in three places — `README.md`,
`docs/CARRIER-ONBOARDING.md`, and F-30's open-items table — on this stated evidence:

> Login form is in a **closed** shadow root, unreachable by CSS selectors in both `page.evaluate`
> and Playwright locators. Verified, not assumed.

The carrier was abandoned and Travelers was recommended in its place.

**Diagnosis.** The words "verified, not assumed" were doing more work than the evidence supported.
What had actually been *measured* was an absence: `input[type="password"]` had a count of zero to
both resolution routes, while a screenshot showed the form plainly. "Closed shadow root" was the
**inference** drawn from that absence, and at least four distinct causes produce exactly the same
observable:

| Cause | Hostile? | Distinguishing test |
|---|---|---|
| closed shadow root | yes | intercept `attachShadow` at creation time |
| cross-origin iframe | no | enumerate frames |
| late mount | no | poll for longer |
| wrong entry point | no | follow redirects, try siblings |

No test had been run that could tell them apart. So `tools/geico/probe-geico-dom.js` was written to
do exactly that, and the decisive step is one the original probe could not have taken: patch
`Element.prototype.attachShadow` from an `addInitScript`, which runs *before* any page script, and
record every shadow root as it is created. A closed root is only unreachable if you did not hold the
reference at creation; if you patched the constructor, you hold all of them.

**Root cause.** There is no shadow DOM on GEICO's login page at all.

```
shadow roots  0 total / 0 open / 0 closed
inputs        light:10  openShadow:0  captured:0  iframes:2
locator count input[type=password] = 1
pw first seen 5985ms
keyboard      password reachable by Tab: true
VERDICT       STRAIGHTFORWARD -- password field in the light DOM, locators see it
```

The field is in the ordinary light DOM and Playwright's locator engine sees it. The real cause was
**late mount**: the form appears ~2.3–6.2s after `domcontentloaded` (measured across five loads:
2292, 2339, 4022, 5985, 6177ms), behind an Imperva JS challenge. The earlier probe sampled before
the app had mounted.

This is **F-06 recurring**. F-06 is the entry titled "probe reported NO FORM FOUND for a page that
rendered perfectly", and its recorded fix was to make the probe poll. The probe did then poll — and
still produced a wrong verdict, because polling was added while the specific conclusion the tool was
allowed to draw was never constrained. The tool was fixed; the *class* of error was not.

**What GEICO actually is.** A **Flutter Web** application, HTML renderer:

| Signal | Value |
|---|---|
| `flt-glass-pane` | present |
| `canvas` elements | **0** (so HTML renderer, not CanvasKit) |
| `flt-semantics` nodes | 40 |
| `data-semantics-role="text-field"` | on both credential inputs |
| `flt-semantics-placeholder` | **absent** |

And one contradiction that had to be resolved before any selector could be trusted:

```
light-DOM scan  ->  <input type=password  id=None  name=None>
keyboard Tab    ->  <input type=password  id='current-password'
                           autocomplete='current-password'>
```

Same element, different attributes depending on whether focus had entered it. Flutter does not
maintain a real accessible DOM until it believes assistive technology is present, so the field is a
bare shell until focused. An adapter written from what devtools shows *after a human clicks the
field* would pass review and then fail in production, because automation arrives before any focus
event. That is F-08's generated-id trap wearing a different hat.

The "click `flt-semantics-placeholder` to enable accessibility" hypothesis was tested and is **dead**
— the element does not exist on this page.

**Fix.** Three selector strategies were raced, each verified by reading the value back rather than
trusting `type()` to resolve (the O-5 lesson):

| Strategy | Result |
|---|---|
| `input[autocomplete="email"]` + `input[type="password"]` | **works, no focus needed** |
| `input[data-semantics-role="text-field"][type=…]` | **works, no focus needed** |
| `#username` + `#current-password` | **not viable** — `#username` stayed at count 0 even after clicking the password shell |

Chosen: the attribute-based pair. It needs no focus dance, no placeholder activation, and no
keyboard traversal — just a mount wait. Typing measured at ~686ms (username) and ~447–524ms
(password), with both values read back intact.

**LOAD-BEARING — do not select the submit button by id.** GEICO's "Log In" control is a
`flt-semantics[role=button]`, and its id is assigned in Flutter's semantics-tree mount order. The
same button was observed as `flt-semantic-node-37` on one load and `flt-semantic-node-16` on the
next. Select it by text. This is the identical trap as Progressive's minted input ids (F-08), now
confirmed on a second carrier and a second framework, which makes it a general rule rather than a
Progressive quirk.

**Guard.** `node tools/geico/probe-geico-typing.js` re-runs all three strategies against the live
page and verifies by read-back. It is deliberately kept out of `smoke:all` — it loads a real carrier
login page, and doing that on a schedule is the beacon pattern `OPTIMISATION-LOG.md` O-10 rejects.

**A fourth wrong verdict, produced while fixing the third.** `probe-geico-flutter.js` initially
reported `Selector typing FAILED -- fall back to keyboard traversal`. That was a bug in the probe:
it tabbed to materialise the authored ids on one page object, then tried to type into `#username` on
a *different* page where no focus had ever landed, so `fill()` waited the full 30s for a node with a
count of zero. Four confident-but-wrong tool verdicts now exist in this project (F-06, F-14, the
closed-shadow-root call, and this one). The pattern is stable enough to state as a rule:

> **A tool must not be allowed to report a conclusion it has no test for.** "No password field
> found" is a measurement. "Closed shadow root" is a diagnosis, and a tool should only emit it if it
> ran the test that distinguishes it from the alternatives — otherwise it must say "no field found,
> cause undetermined".

`probe-geico-dom.js` now enforces this: its `verdict()` prints `NO FIELD ANYWHERE -- wrong entry
point, hard block, or mount beyond the ceiling. Check the screenshot before concluding anything`
rather than naming a mechanism it did not test.

**Also established.**

- Entry point is `https://ecams.geico.com/login`. `login.geico.com` does **not resolve**
  (`ERR_NAME_NOT_RESOLVED`); `www.geico.com` has no password field and four iframes.
- Anti-bot stack: **Imperva** (`visid_incap_*`, `nlbi_*`, `incap_ses_*`) plus **Quantum Metric**
  session replay, OneTrust consent, and Qualtrics site-intercept. XSRF cookies are present
  (`ASD-XSRF-TOKEN`, `XSRF-TOKEN`, `ApplicationSession`), which matters for any future direct API
  call.
- Only `ecams.geico.com` is Flutter. The `www.geico.com` marketing pages are ordinary DOM.
- A "Log In with Existing Passkey" affordance exists alongside the password form. Not useful here,
  but worth knowing it is a separate path that could change the default form layout.

**Caveat, stated rather than buried.** Real Google Chrome is not installed on this machine, so every
probe ran on bundled Chromium after the `channel: 'chrome'` attempt failed. DOM structure findings
are unaffected — a password input is in the light DOM regardless of binary. **Anti-bot behaviour is
provisional**: per `src/browser/stealth.js`, a named channel is the single highest-value
detectability decision, and Imperva may well treat bundled Chromium differently from Chrome. These
probes must be re-run on real Chrome before any claim is made about GEICO's tolerance of automation.

**Lesson.** Ruling a carrier out is a decision worth as much rigour as building one, and it was made
here on an inference presented as a verification. The phrase "verified, not assumed" in the original
note is the tell — it asserted confidence instead of naming the test. A negative verdict should have
to state the experiment that would overturn it; had it done so, the missing experiment would have
been obvious immediately.

---

### F-33 · GEICO has no warm path, and an extra interactive step Progressive does not have

| | |
|---|---|
| **Area** | adapter:geico / architecture |
| **Severity** | wrong-results if assumed away |
| **Status** | open — design settled, implementation pending a guided walkthrough |

**Symptom.** Not a failure. Recorded because the Progressive adapter's shape would be wrong for
GEICO in two specific ways, and both are the kind of thing that gets discovered late and expensively.

**Evidence.** GEICO's own 2-Step Verification FAQ, rendered in a browser because a plain fetch of
that URL returns 53 bytes of shell with no readable text:

> GEICO requires a 2-Step Verification to access your policy on GEICO Mobile or on geico.com
>
> You will be able to select your verification method each time you log in

**Consequence 1 — there is no warm path.** 2SV is mandatory on **every** login, and no
trusted-device or "remember this browser" option appears anywhere in the FAQ. So:

- `supportsSessionReuse` must be **`false`** for GEICO. Claiming otherwise would advertise a warm
  path in the UI that can never happen.
- Saved `storageState` cannot skip the challenge. It may still be worth keeping for the Imperva
  cookies, but not for auth.
- **Pre-warming matters more here than for Progressive**, not less: for GEICO the cold path is the
  only path, so the ~2.3–6.2s Flutter mount is paid on every single pull unless it is hidden.
- This is the inverse of Progressive, where device trust at least *could* skip the SMS (F-30 found
  that it never actually did).

**Consequence 2 — an extra interactive decision.** GEICO's flow has a step Progressive does not:

```
Progressive:  credentials -> SMS sent automatically -> code -> documents
GEICO:        credentials -> CHOOSE email or SMS    -> code -> documents
```

The method chooser sits between password submit and code entry. Options considered:

1. **Surface the choice in the UI.** Most faithful, and the only correct option if a user's
   available methods vary. Costs a new round-trip through the WebSocket protocol and a second modal.
2. **Auto-select a configured default** (`GEICO_MFA_METHOD`). One less human step on a flow already
   carrying an unavoidable one, and the human wait is the largest single cost in the budget.

Chosen: **(2), with the available methods logged and surfaced in the status stream.** Rationale: the
existing MFA modal and WebSocket protocol already handle one interactive round-trip well, and adding
a second doubles the places a flow can stall waiting on a human. Auto-selecting is reversible — the
method list is captured either way, so promoting it to a UI choice later is additive rather than a
rewrite. This is recorded as a **deliberate simplification**, not an oversight: if a user has only
an email on file and the default is SMS, this will fail, and the error must say so clearly rather
than timing out.

**Still unknown, pending the walkthrough.** The authenticated documents page DOM, the document
list/download endpoint, and how the correct policy document is identified. GEICO's public
documentation says only that documents live in "the policy documents section of our online service
center". Per F-29, the thing to look for is **the carrier's own taxonomy** — a category or document
type field — rather than matching title text or list position.

---

### F-34 · Backgrounding the session save silently killed the warm path

| | |
|---|---|
| **Area** | core / storage |
| **Severity** | wrong-results (a headline optimisation was dead) |
| **Status** | fixed |

**Symptom.** `npm run smoke` failed one assertion on its second run:

```
=== Run 2 (expect warm path) ===
  PASS  reached COMPLETED
  FAIL  used warm path (no login, no MFA)
  timings: machine=2.40s  wall=2.80s  warmPath=false
  phases: adopt_prewarmed=0ms acquire_context=20ms nav_login=96ms
          fill_credentials=799ms submit_credentials=287ms login=1366ms
          mfa_wait=401ms mfa_submit_1=568ms ...
```

Run 2 performed a full cold login and a full MFA round-trip when it should have
rehydrated the session saved moments earlier by Run 1.

**Diagnosis.** Found while verifying that the GEICO adapter had not regressed
Progressive, so the first question was whether the new carrier caused it. The
control was direct: GEICO was removed from the registry entirely, the session
store was cleared, and the suite re-run.

```
server up, GEICO absent: ['progressive', 'demo']
=== Run 2 (expect warm path) ===
  FAIL  used warm path (no login, no MFA)
```

**Pre-existing.** Worth stating because the instinct was to suspect the new code,
and acting on that instinct would have wasted the time on the wrong file.

Then the store itself was ruled out. Loading directly with the same credentials
the suite uses:

```
load(demo, "demo@example.com") -> FOUND ageMs=44648
```

So keying, the HMAC filename, encryption and the TTL were all fine. The
distinguishing evidence was the phase list. Run 1 contained `warm_validate=142ms`
— the warm path was attempted and rejected — while **Run 2 had no
`warm_validate` phase at all**, meaning its `load()` returned null and the warm
path was never even tried. Two different failures that both present as
`warmPath=false`.

**Root cause.** A race, created by moving session persistence off the critical
path (O-7), and visible only when two pulls run back to back.

```
pullSession.js:187   await storageStateStore.clear(...)   // stale session removed
pullSession.js:335   this.#persistPromise = ...           // save NOT awaited
pullSession.js:516   await Promise.race([#persistPromise, 3s])  // only at teardown
```

Sequence:

1. Run 1 loads the session left by the previous server process.
2. `isSessionValid()` returns false — correct, the in-process demo portal restarted
   with the server and has no memory of those cookies — so line 187 **deletes** it.
3. Run 1 logs in cold, and `COMPLETED` goes to the client **before** the new
   session is written, which is precisely what O-7 was designed to do.
4. The client immediately starts Run 2. Its `load()` lands in the window after the
   delete and before the write, finds nothing, and takes a cold path.
5. Run 1's save finally lands at teardown.

O-7's reasoning was sound: a save benefits *future* runs and has no value to the
user currently waiting. What was not considered is that "future runs" can begin
before the save completes, and the store had no way to express "a write for this
key is in flight". The cost was not the 107ms O-7 moved — it was a second login
and a second human MFA round-trip on every quick repeat pull.

**Fix.** `StorageStateStore` now tracks in-flight saves by target path, and
`load()` awaits any pending save for the same key before reading.

- `save()` is synchronous up to registering the promise. Registering inside the
  async body would leave a window where the save has started but is not yet
  discoverable — the same class of bug being fixed.
- Only the caller who would otherwise have read a missing file waits, which is
  exactly when waiting is correct. The first pull's user-facing path is still
  never blocked, so **O-7's benefit is kept**.
- The `.finally()` only removes its own entry, so a later save for the same key
  takes ownership rather than being clobbered.

**Guard.** Verified with a negative control, because a test that cannot fail is
not a test:

```
load() issued while a save was in flight          -> FOUND (race closed)
same instant, reading the directory directly      -> file ABSENT
```

The second line is what `load()` used to hit. End to end:

| | before fix | after fix |
|---|---|---|
| Run 2 machine time | 2,400ms | **623ms** |
| Run 2 warm path | false | **true** |
| Run 2 login + MFA | performed | **skipped** |

`npm run smoke:all` exits 0 with zero FAIL lines.

**Lesson.** Moving work off the critical path changes *when* it is visible, and
anything that reads it needs to know it is in flight. "Nobody is waiting on this"
was true of the user and false of the next request. Two entries in
`OPTIMISATION-LOG.md` now share this shape — O-6 read a status before the state
could advance, and O-7 wrote a file after a reader could look for it — which
generalises to: **an optimisation that changes ordering must be checked against
every reader of the thing reordered, not just the writer.**

Also worth noting how it was found. Not by the change that caused it — O-7 was
verified by confirming `persist_session` still appeared in the metrics, which it
did — but by an unrelated regression check two features later. The suite earned
its keep here.

---

### F-35 · The recorded GEICO walkthrough emailed the document instead of downloading it

> **CORRECTION — the title and central conclusion of this entry are WRONG. See F-36.**
> The user did click "View Declaration Page"; GEICO opened the PDF in a **new tab** that the
> recorder had no listener for. This entry inferred a mechanism ("emailed it") from an absence
> of captured evidence. Kept unedited below because the wrong turn is the useful part, and
> because everything else in it — the three-host journey, the 2SV API mapping, and the two
> security findings — is correct and still stands.

| | |
|---|---|
| **Area** | adapter:geico |
| **Severity** | would-have-been wrong-results |
| **Status** | **conclusion superseded by F-36**; API/security findings still valid |

**What the recording gave us.** A real session, credential-free artefact: 12
navigations, 256 responses, 44 structure snapshots. Most of it was immediately
useful — and one part was a trap worth documenting before anyone implements
against it.

**The three-host journey**, which no public documentation hints at and which an
adapter assuming a single origin would fail on at the first hop:

```
ecams.geico.com         /login → /mfa/options → /mfa/pin
portfolio.geico.com     /dashboard
edgecustomer.geico.com  /documents/proof-of-insurance-home
```

**2SV is now fully mapped at the API level**, which supersedes the DOM-scraping
plan. `GET /ws/mfa/options` returns the destinations directly:

```json
{ "_payload": {
    "emails":       [{ "label": "rc***@gmail.com", "value": "<uuid>" }],
    "phoneNumbers": [{ "label": "(XXX)XXX-5116",   "value": "<uuid>" }] } }
```

GEICO pre-masks the labels itself and identifies each channel by opaque UUID, so
the adapter can name the destination to a user without ever holding the raw phone
number or address. `GET /ws/mfa/otp/init` then reports the channel actually used
(`mfaVerificationType: "TextMessage"`). Endpoints: `/ws/login/authenticate`,
`/ws/mfa/options`, `/ws/mfa/otp/send`, `/ws/mfa/otp/init`,
`/ws/mfa/otp/authenticate`. F-33 confirmed twice over — the chooser is a genuine
separate screen, and neither payload offers a trusted-device option.

**The trap.** The walkthrough ended on `/documents/declaration-page-send` and the
final request was:

```
POST /ws/consolidated-documents/submit-policy-document  ->  200
{ "_payload": true, "_flags": { … } }
```

`_payload: true` is **not a document**. It is a confirmation that GEICO *emailed*
the declarations page. The route name (`declaration-page-send`), the sibling
endpoint `/ws/proof-of-insurance-email`, and the bare boolean all agree.

This matters because of how it fails. The request returns **200**, the payload is
**`true`**, and both read as success. An adapter written against this recording
would report a completed pull having retrieved nothing — the F-28 failure mode
exactly, where a confidently wrong result is worse than an honest error. It would
also have been near-impossible to spot in testing: the user *does* receive the
document, by email, so the flow looks like it works.

**What is actually needed.** The same page exposes the right affordance. From the
structure snapshots:

```
[View Declaration Page]        ← the document path
[View or Send ID Card (PDF)]
[Request Multiple Documents]
[Submit]                       ← the email path that was recorded
```

And the submit response itself contains
`_flags.SHOW_CONSOLIDATED_DOCUMENT_PREVIEW: true` — the app confirming a preview
path exists. One more recording, clicking **View Declaration Page**, captures it.

**Recorded in `selectors.js`** as `DOCUMENT_ACTIONS`, with `submitSend` explicitly
annotated *do not click expecting a document*, so the distinction survives in the
code rather than only here.

**Two security findings from the artefact, both fixed.**

*The secret audit passed on a file containing a live session token.* The recording
held a 48-character value in `?token=…`. Every rule in `audit-secrets.js` examined
JSON field names, header values, or recognisable token formats — **none looked at
URL query strings**, so a credential sitting in a URL was invisible to all of
them. GEICO's own session-replay masking rewrites that same parameter as
`token=*****` 154 times in the same file, which is the carrier stating plainly
that it is sensitive. URL-borne tokens are worse than they look: they reach access
logs, `Referer` headers sent to third parties, and browser history.

Fixed on both sides: `record-geico-flow.js` now scrubs query parameters at every
write point, and `audit-secrets.js` has a `session token in URL` rule with
`captureGroup: 1` so an already-masked value is distinguishable from a real one
(the F-25 mistake). Verified by confirming it fails on the real token and does
**not** fire on `token=*****`, `token=[REDACTED]`, or a short value. The existing
artefacts were scrubbed in place: 45 + 2 + 1 occurrences.

*Real PII is in the recording.* A VIN, vehicle make/model/year, and a lienholder
name. Not credentials, so it does not fail the audit, but these artefacts exist to
be shared. Added a `VIN (vehicle ID)` rule at `note` severity — the 17-character
format excludes I, O and Q, which keeps it from firing on ordinary base64.
`artifacts/` and `logs/` are both gitignored, so none of it reaches a commit; that
was verified rather than assumed.

**Lesson.** A recording is evidence of *what the user did*, not evidence of the
path the adapter needs. The walkthrough was performed correctly and still captured
the wrong branch, because "get my declarations page" has two implementations on
that page and only one of them hands over a file. Worth asking of any captured
flow: **did this produce the artefact we need, or a receipt for it?**

---

### F-36 · The recorder was blind to new tabs, and F-35's conclusion was wrong

| | |
|---|---|
| **Area** | tooling |
| **Severity** | misleading (produced a false conclusion about carrier behaviour) |
| **Status** | fixed — **supersedes F-35's finding** |

**Correction first.** F-35 concluded that the recorded GEICO walkthrough had
*emailed* the declarations page instead of downloading it. **That was wrong.** The
user clicked "View Declaration Page", GEICO opened the PDF in a **new tab**, and
the recorder could not see it. The user said so plainly, and they were right.

**Root cause.** Every listener was bound to the single `Page` object the recorder
created:

```js
page.on('framenavigated', …)
page.on('response', …)
```

A tab opened by `target="_blank"` is a separate `Page` on the `BrowserContext`.
There was **no `context.on('page')` handler at all**, so the document tab was
never observed — confirmed by grep after the fact: zero context-level listeners,
12 navigations all on one page's main frame, zero responses with a PDF
content-type.

**The reasoning failure, which matters more than the missing line.** Faced with a
recording containing a `submit-policy-document` call returning `_payload: true` and
no PDF anywhere, the conclusion drawn was a *mechanism*: "the user emailed it".
The actual evidence supported only an *absence*: "no document was captured". Those
are different claims, and the gap between them is where the error lived.

This is **F-32 repeated by the tool built to prevent it.** F-32's entire lesson is
that "closed shadow root" was a mechanism inferred from an absence of reachable
password fields, and its stated rule was:

> A tool must not be allowed to report a conclusion it has no test for.

The recorder had no test for "did a document arrive in a tab I am not watching",
and the conclusion was published anyway. Writing the rule down did not prevent
breaking it — the same observation F-34 and O-6 make about documented lessons only
protecting against the exact shape recorded.

**A second, subtler problem found while fixing the first.** Attaching listeners to
the new tab is necessary but **not sufficient**. Chrome hands PDFs to its internal
plugin viewer, and that response is never surfaced as a Playwright `response`
event. Measured against a local fixture:

```
popup url: http://127.0.0.1:PORT/declaration.pdf
responses observed on that tab:
  text/javascript   288,767 bytes     <- Chrome's PDF viewer
  text/javascript   343,993 bytes     <- Chrome's PDF viewer
  … css/js only. The application/pdf response never appears.
```

So "no PDF response was captured" still says nothing about whether a PDF arrived —
the same trap, one level deeper.

Also found: the response filter required JSON **or** a keyword in the URL, which
would have dropped a PDF served from a path like `/ws/render/9f3c2a`. The thing
most worth capturing is the thing least likely to advertise itself in its URL.

**Fix.** Three changes to `tools/geico/record-geico-flow.js`:

1. Listener attachment extracted into `attachToPage(pg, tab)`, applied via
   `context.on('page')` so **every** tab is recorded. Guarded against
   double-attach, which was observed real: `newPage()` also fires the event, and
   the initial page was briefly attached as both tab 0 and tab 1, which would have
   recorded every response twice.
2. Binary document types captured on **content-type alone**, with no URL filter.
   Plus a `download` handler, since a PDF may arrive as a download rather than a
   tab depending on `Content-Disposition`.
3. `verifyDocumentTab()` — the part that actually works. Take the tab's URL and
   re-request it through `context.request`, which shares the context's cookies and
   returns the bytes the viewer hides. A GET for a document is idempotent, so this
   costs nothing.

**This is also how the adapter must fetch the document.** The recorder and the
adapter face the identical obstacle, so the mechanism proven here transfers
directly.

**A third thing learned, worth its own note.** `context.request.get()` does **not**
pass through `context.route()` handlers — it is a separate request context that
goes to the network. The first version of the guard failed with
`getaddrinfo ENOTFOUND example.test` because it tried to verify against a routed
fixture. Harmless for the adapter, where the host resolves and cookies are shared,
but it means any test of this mechanism must serve real HTTP.

**Guard.** `npm run test:newtab` (`tools/geico/test-newtab-capture.js`), now in
`smoke:all` — nine suites. It serves a real loopback fixture whose link opens a
PDF in a new tab, and asserts:

```
PASS  both tabs tracked  2 tabs
PASS  no duplicate attachment
PASS  document in the second tab captured  tab 1, 80 bytes, application/pdf
PASS  magic bytes prove a real PDF  "%PDF-"
PASS  HTML masquerading as a PDF is rejected  magic="<html"
```

The last assertion is the negative control, and it is the F-13 lesson: a 200 plus
a plausible `content-type` is not evidence of a PDF. Without it the guard would
pass on a session-expired HTML page served as `application/pdf`.

**What is still needed.** One more recording with the fixed tool. The mechanism is
proven against a fixture; it has not yet run against GEICO. `DOCUMENT_ACTIONS` in
`selectors.js` already distinguishes `viewDeclarationPage` from `submitSend`, and
the note on `submitSend` — *do not click expecting a document* — stands, since
that endpoint genuinely does return a bare boolean.

**Lesson.** When a user contradicts a tool's finding, the tool is the more likely
suspect. Two of the four wrong verdicts in this project were resolved by taking
that seriously; this is the third, and in this case the user simply knew what they
had clicked.

---

### F-37 · The real GEICO document flow, and the two wrong pages before it

| | |
|---|---|
| **Area** | adapter:geico |
| **Severity** | blocked-submission (resolved) |
| **Status** | fixed — selection and download implemented and tested |

**Symptom.** Not a failure. This is the entry that closes the GEICO document work,
and it records two wrong pages found on the way, because both looked right.

**The two wrong turns.**

*Wrong page.* `/documents/proof-of-insurance-home` was assumed to be the documents
section. It is ID cards and proof of insurance — adjacent, plausible, and not where
declarations live. The real list is `/documents/consolidated-documents`, reached via
`/view-policy`.

*Wrong action.* On the page that IS reachable from there,
`POST /ws/consolidated-documents/submit-policy-document` returns `_payload: true`.
That is a confirmation GEICO **emailed** the document, not the document. Recorded
in F-35 with the wrong interpretation attached; F-36 corrected the interpretation,
and this entry records why the endpoint still matters: an adapter calling it gets a
200 and a truthy payload, which reads as success while retrieving nothing.

**The actual flow.**

```
GET /ws/consolidated-documents        -> the list, with GEICO's own taxonomy
GET /ws/consolidated-documents/view-document
      ?documentId=<uuid>
      &token=<44-char opaque>
      &documentName=Declaration Page
      &policyTerm=currentTerm
      &transactionType=Endorse
    -> 200  application/pdf  52,361 bytes  magic %PDF-
```

The list payload supplies everything needed, including the token:

```
policyNumber                 <44-char opaque>      <- IS the view-document token
currentTermEffectiveDate     2026-09-17
previousTermEffectiveDate    2026-03-17
policyDocuments        [17]  flat array
otherPolicyDocuments   [24]  transaction groups, each wrapping documents[]
billingDocuments       [31]  transaction groups
importantDocuments     [0]
```

`policyNumber` and the `token` query parameter are the same 44-character value —
confirmed by length and content — so the adapter never has to scrape a token out of
a URL.

**The taxonomy, which answers the F-29 question.** `description` is a closed
vocabulary, not free-form copy:

```
policyDocuments        Policy Contract (11), Automobile Policy Amendment (4),
                       Signature Page (2)
otherPolicyDocuments   Important Notice (12), Loss Payable Clause (12),
                       Declaration Page (11), Signature Page (10),
                       Insurance ID Card (9), Privacy Notice (8), …
```

"Declaration Page" appears **only** in `otherPolicyDocuments` and "Policy Contract"
**only** in `policyDocuments`, so the bucket is part of a target's identity rather
than an implementation detail. Encoded in `documents.js` as `TARGETS`.

**Selection.** Eleven documents are described "Declaration Page"; two belong to the
in-force term. The rule is: filter `effectiveDate === currentTermEffectiveDate`
first, then take the latest `transactionDate` within that term. Verified against
the recorded payload — it selects `85cf35bd…`, the exact document the user opened.

**An overclaim, corrected.** A first draft of this entry and of the comment in
`documents.js` asserted the fixture contained a live instance of the F-28 trap, with
this as evidence:

```
effectiveDate 2024-05-21  ->  transactionDate 2024-09-28    "older term, later txn"
effectiveDate 2024-11-21  ->  transactionDate 2024-10-18
```

That is wrong: September precedes October, so there is no inversion. Measured
across all eleven declarations pages, **zero** cases exist where an older term
carries a later transaction date, and on this account naive recency ranking would
have picked the correct document by coincidence. The test caught it by failing an
assertion I had written to be true.

So the term filter is **not** fixing a live failure here. It removes a dependency on
a coincidence, which is still worth doing for three reasons that do hold:

1. GEICO itself requires the distinction — `view-document` takes
   `policyTerm=currentTerm|previousTerm`, so selecting without deciding the term
   means guessing at a required parameter.
2. F-28 is this exact failure on Progressive, where recency returned a declarations
   page from a lapsed policy and the run reported success. Same shape; the ordering
   there was simply unlucky.
3. `transactionDate` is when paperwork was generated, `effectiveDate` is which term
   it governs. A late-processed endorsement for an old term can be written after a
   new term begins, which is normal at a renewal boundary.

Worth stating plainly because the distinction between "this guard prevents a bug we
observed" and "this guard removes reliance on luck" is exactly the kind of thing
that decays into the former when nobody writes it down.

**Guard.** `npm run test:geico-docs`, now in `smoke:all` (ten suites). Nineteen
assertions over the real 110-document payload. The load-bearing one is a negative
control: a previous-term document carrying the newest transaction date is planted,
then the test asserts both that the implementation does **not** pick it and that
naive recency ranking **does**. Without the second half the guard would be asserted
rather than demonstrated.

**Also verified**: buckets do not bleed, every in-term document outranks every
out-of-term one, missing term metadata degrades to recency *and reports
`chosenIsInCurrentTerm: false`* rather than lying, an empty payload returns nothing
instead of throwing, an unknown target throws instead of silently returning nothing,
and selection is deterministic.

**Download hardening.** `%PDF-` magic bytes are checked on every fetch. F-13: a 200
with `content-type: application/pdf` is not evidence of a PDF, and a session-expired
HTML page served that way produces a blank viewer pane and a bug report about the
viewer.

**A second security leak, found by the audit again.** The second recording leaked the
44-character token despite the fix from F-35, because GEICO's JSON payloads carry
URLs *inside* them:

```
body._goto.externalUrl = "https://portfolio.geico.com?token=…"
```

`scrubUrl` was applied to each event's own `url` field, but the body scrubber worked
on key names and value formats — and neither catches this: the key is `externalUrl`,
and a 44-character base64 token is far below the long-blob threshold. Fixed by
applying `scrubUrl` to **any URL-shaped string at any depth**, rather than adding a
special case. 108 further occurrences scrubbed from the artefact.

That is three times `audit:secrets` has caught something its author did not
anticipate — the `password` field in the typing probe, the URL token, and now the
nested URL token. The pattern in all three: redaction was written against the shapes
imagined, and real payloads had a shape that was not imagined. The audit is worth
more than the redaction it checks.

**Lesson.** The user said the document they had opened was not the real one, and
they were right twice over — wrong page first, then wrong action on the right page.
Both looked correct from the recording. When someone who can see the screen
contradicts an artefact, the artefact is the weaker evidence.

---

### F-38 · A selector fix broke screen detection, and GEICO was never asked to send a code

| | |
|---|---|
| **Area** | adapter:geico |
| **Severity** | blocked-submission |
| **Status** | fixed |

**Symptom.** User report: *"I am not receiving the GEICO code at all."* The run
failed after ~90 seconds with `MFA_REQUIRED_TIMEOUT`. No code ever arrived, and the
user was waiting on a text GEICO had not been asked to send.

**Diagnosis.** One log line:

```
[23:50:39.260] INFO: post-login outcome
    outcome: "codeEntry"   elapsedMs: 126
```

`codeEntry` won the post-login race **126ms** after the credential submit. GEICO's
login page has not even navigated in 126ms, so the adapter decided the code screen
was already displayed while still sitting on `/login`. Consequences, in order:

1. `#chooseMfaMethod()` was skipped, because the race reported `codeEntry` rather
   than `methodChooser`.
2. **"Next" was therefore never clicked**, and "Next" is what asks GEICO to send the
   code.
3. The state machine advanced to `MFA_REQUIRED` and waited for a code that had never
   been requested.
4. `MFA_WAIT_TIMEOUT_MS` elapsed and the run failed.

The error was accurate and the cause was two phases upstream.

**Root cause — a fix for one reader breaking another.** F-37 changed
`MFA.codeInput` to lead with:

```js
'input[data-semantics-role="text-field"]'
```

That change was correct *for typing*. The code field swaps attributes on focus —
`aria-label="Verification code"` before, `id="one-time-code"` after — and
`data-semantics-role` is the only attribute present in both states. Keying on
`aria-label` would have failed **mid-code-entry** when the attribute vanished.

But GEICO's *login* fields carry the same attribute. From `selectors.js`:

```
CREDENTIALS.usernameFallback  input[data-semantics-role="text-field"][type="text"]
CREDENTIALS.passwordFallback  input[data-semantics-role="text-field"][type="password"]
```

And `#awaitPostLogin()` detected the code screen by *looking for the code field*.
So the selector that had to be generic for one caller was catastrophically ambiguous
for the other.

**This is O-13's lesson, third occurrence.** O-6 read a status before the state
could advance. O-7 wrote a file after a reader could look for it. This changed a
selector for one reader without enumerating the others. The rule O-13 states —
*when a change alters something shared, enumerate every reader, not just the one you
are fixing* — would have caught it, and did not, because it was not applied.

**A second defect found in the same review.** `#awaitMfaOutcome()` had:

```js
accepted: (p) => !/\/login/.test(p.url()) && /ecams\.geico\.com/.test(p.url())
```

Both 2SV screens live on `ecams.geico.com`, so this is **true on `/mfa/pin`** — the
page it runs on. It would have reported any submitted code as accepted on the first
poll, before GEICO validated anything, turning a wrong code into a silent failure
two phases later. Never observed because the run never reached it.

**Fix.** Screens are identified by **route**, not by DOM presence. Both routes were
already verified from the recording:

| Screen | Predicate |
|---|---|
| method chooser | URL matches `/mfa/options` |
| code entry | URL matches `/mfa/pin` |
| authenticated | host is `portfolio.geico.com` or `edgecustomer.geico.com` |

DOM checks remain as secondary signals but are scoped so they cannot match the login
form: `input[aria-label="Verification code"]` and `#one-time-code` exist only on the
code screen. The generic `text-field` selector is no longer used for detection
anywhere — only for typing, where it is correct.

`authenticated` now keys on leaving the auth host entirely, which is what the
recording shows actually happens (`ecams` → `portfolio` → `edgecustomer`).

**Guard.** `npm run test:geico-screens`, now in `smoke:all` (eleven suites). Pure
regex logic, no browser. Sixteen assertions, the load-bearing ones being:

```
PASS  codeEntry does NOT fire on /login          the 126ms false positive
PASS  authenticated does NOT fire on either 2SV screen
PASS  the DOM collision still exists             so route-based detection remains required
PASS  the FIRST codeInput selector survives the focus swap
```

The third is a negative control on the *reason* for the design: if the login fields
ever stop sharing `data-semantics-role`, the test fails loudly rather than passing
while its justification has evaporated. It also asserts each predicate matches
**exactly** the screens it should — an `exactlyMatches` helper rather than a
one-directional check, since the bug was a predicate matching too much rather than
too little.

**Also caught by the same suite**, both pre-existing risks rather than live bugs:
`"Log In with Existing Passkey"` must not match the login pattern (it would open a
WebAuthn prompt nothing can satisfy), and `"Submit"` must not match the
`viewDeclarationPage` action (it is the email path, F-37).

**Lesson.** The fix and the bug were the same line. Making a selector robust against
one failure mode made it ambiguous against another, and the two requirements lived in
different functions reading one shared constant. Where a constant serves callers with
opposing needs — maximum generality for typing, maximum specificity for
identification — it should be two constants. Screen *identity* now comes from the
URL, which cannot be ambiguous, and only the *interaction* uses selectors.

**A process note.** The restart after this fix silently failed the first time:
`pkill` reported the old process still alive, and a stale pid 48692 was still serving
while the new code sat on disk. Caught by the `find src -newermt` check that has been
in the verification routine since F-31. Without it, the next run would have exercised
the unfixed code and the fix would have looked wrong.

---

### F-39 · Flutter dropped one keystroke, and the read-back check is the only reason we know

| | |
|---|---|
| **Area** | adapter:geico / core (latent) |
| **Severity** | blocked-submission |
| **Status** | fixed for GEICO; **latent defect remains in `BaseCarrier` — see the flag below** |

**Symptom.** User report: *"GEICO's sign-in form did not accept the typed
credentials."* That is the adapter's own message. The internal detail:

```
credential fields did not accept input (user 22/22, pass 12/13)
```

The username arrived whole. The password was **exactly one character short**, and
identically so on two consecutive attempts.

**Why this entry matters more than the fix.** The read-back check added in F-37 is
the only reason this was ever visible. Without it the run would have submitted a
truncated password, GEICO would have rejected it, and the user would have been told
*"GEICO did not accept that username and password"* — sending them to re-type a
password that was already correct. A silent one-character truncation presenting as a
credential error is close to undiagnosable from the outside. This is the O-5 lesson
paying off: verify the postcondition, do not trust the action.

**Diagnosis — two hypotheses, both wrong, both measured rather than argued.**

*Hypothesis 1: character mapping.* `BaseCarrier.typeLikeHuman()` types with
`locator.press(ch)` per character, and `press()` takes a **key name**, not a
character — its parser treats `+` as a modifier separator (`Shift+A`). A literal `+`
in a password seemed an obvious candidate.

Tested all 94 printable ASCII characters against a plain `<input>`
(`npm run test:typing`):

```
=== per-character press() ===
  all characters survived
```

**Wrong.** No character-mapping problem exists, `+` included.

*Hypothesis 2: a deterministic method difference.* `pressSequentially()` uses
`insertText` where `press()` sends discrete key events, so perhaps Flutter only
handles the former. Tested both against the live GEICO password field with a
13-character string:

```
press() per char       13/13  exact
pressSequentially()    13/13  exact
```

**Also wrong** — both worked. And this is the more valuable negative result: simply
swapping the method would have appeared to fix the bug, shipped, and regressed later.
It would have been a coincidence sold as a fix.

**Root cause (best supported explanation).** A Flutter Web race. Flutter synchronises
a hidden input against its own editing state, and a keystroke arriving mid-sync is
dropped. This is invisible on ordinary DOM, which is exactly why no fixture
reproduces it — and why the character-level test, which was the right test to run,
could not find it.

Stated honestly: this is **inferred**, not proven. What is proven is that neither
character mapping nor the typing method explains it, and that the loss is
intermittent. Per F-32's rule, the mechanism is named as a hypothesis rather than
asserted as a measurement.

**Fix — repair, rather than diagnose.** Diagnosing the specific character would
require the user's password, which is not an acceptable thing to ask for or log. So
`GeicoCarrier` overrides `typeLikeHuman()` with a loop that verifies its own result:

1. Click, clear, type with `pressSequentially()`.
2. Read the value back.
3. On a mismatch, retry with an **escalating delay** — if the cause is a sync race,
   slowing down is the most likely remedy, and only the retry pays the cost.
4. After three attempts, fall back to `fill()`, then verify again.
5. Only then fail.

This is robust to a dropped keystroke, a mis-mapped character, or a framework race
without needing to know which occurred. Logs record **lengths only**, never the text.

The `fill()` fallback is a deliberate reversal of the usual rule. `fill()` is avoided
as a primary method because portals bind validation to `input`/`keyup` and a one-shot
set can leave the submit button disabled. But a disabled button is a *better* failure
than a silently truncated password: one is obvious, the other masquerades as a
credential error.

**FLAG — the latent defect is still in `BaseCarrier` and affects Progressive.**
`BaseCarrier.typeLikeHuman()` is unchanged and still types per-character with no
read-back. Progressive is therefore exposed to the same class of silent truncation,
and it has no verification to catch it. It was left alone deliberately:

- The isolation contract exists precisely so GEICO's problems cannot destabilise a
  carrier that is verified working end-to-end against a real account.
- The failure has only ever been observed on Flutter. Changing a shared primitive to
  fix a framework-specific fault, on the carrier that currently works, is the wrong
  trade on a short clock.
- It is recorded here rather than silently patched, which is the point of the log.

**Recommended follow-up**, not done: add read-back verification to
`BaseCarrier.typeLikeHuman()` — not the retry loop, just the check — so Progressive
would *report* a truncation instead of presenting it as rejected credentials. That is
a small, safe change and it should be made before this ships anywhere real.

**Guard.** `npm run test:typing`, now in `smoke:all` (twelve suites), `--offline` so
the scheduled run does not touch a carrier. It sweeps all 94 printable characters
through both methods and asserts they survive, so a genuine character-mapping
regression would be caught. Run it bare (no `--offline`) for the live GEICO
comparison, which types into the real form and never submits.

**Lesson.** Two plausible causes, both eliminated by measurement, and the second
elimination was the important one — the "fix" it implied would have worked on the day
and failed later. When a failure is intermittent, a mechanism that verifies and
repairs beats one that is theorised to be correct. And the check that caught this cost
four lines: read back what you typed.

---

### F-40 · GEICO redirects the login POST under headless, and the diagnostic called it success

| | |
|---|---|
| **Area** | adapter:geico / infra |
| **Severity** | blocked-submission |
| **Status** | headless identified as the differentiator; awaiting confirmation on a headed run |

**Symptom.** Credentials typed and verified 13/13, the "Log In" button clicked by
label, then 45 seconds on `/login` with no navigation. The user-facing message was:

> GEICO accepted the sign-in request but never moved to the next screen.

**That message was wrong**, and it is worth leading with because a diagnostic that
misreports is worse than one that says nothing. The evidence:

```
POST /ws/login/authenticate  ->  302
```

The classifier tested `status >= 400` for "refused" and treated everything else as
accepted, so a **redirect** was reported as success. F-32's rule — *a tool must not
report a conclusion it has no test for* — broken inside the code written to diagnose
a failure. Fixed: 3xx is now classified separately and explicitly.

**Diagnosis.** The `#installNetworkObserver()` added for this produced the answer in
one comparison. Against the captured manual session that succeeded:

| | manual session (worked) | adapter (failed) |
|---|---|---|
| `GET /ws/login/init` | 200 | 200 |
| `POST /ws/login/authenticate` | **200** | **302** |

And the redirect is not incidental: across **677 captured responses** in the manual
recording, the only 3xx responses were DoubleClick ad pixels. A GEICO `/ws/` endpoint
never redirects on a working session.

After the 302, **no further API calls were made at all** and the page text still read
`Email / User ID / Policy Number … Password … Log In`. The form was simply still
sitting there.

**What differed between the two runs.** This is the useful part, because most of the
obvious variables were controlled by accident:

| | manual | adapter |
|---|---|---|
| machine / egress IP | same, no proxy | same, no proxy |
| browser binary | bundled Chromium | bundled Chromium |
| driver | patchright | patchright |
| **headless** | **false** | **true** |

The recorder launches with `headless: false`; the server ran `HEADLESS=true`. One
variable.

**The IP is exonerated, which matters.** The manual run authenticated successfully
from this same residential IP with no proxy configured. So the outstanding
"no residential proxy" gap is *not* what is blocking GEICO — a datacenter-IP theory
would have been the easy assumption and it is wrong here. The proxy is still needed
for deployment, but it is not this bug.

**Root cause (supported, not yet confirmed).** GEICO is fronted by Imperva, and a
302 on an authenticated POST is a characteristic anti-bot interception — redirect to
revalidation rather than an outright 403, which is why nothing in `assertNotBlocked()`
fires: the page never changes and no challenge markup appears. The SPA's fetch does
not follow it, so the app has nothing to route on.

Stated as a hypothesis because only one variable has been isolated, not proven
causal. Confirmation requires a headed run returning 200.

**Change.** `HEADLESS=false` in `.env`, with the reasoning recorded inline there
rather than left as a bare flag flip. This is not a preference — `src/browser/stealth.js`
already argued for headed where possible, and this is the first hard evidence for it
on a real carrier.

**Deployment consequence, and it is not small.** Headed means the container needs a
virtual display. `fly.toml` and the Dockerfile will need **Xvfb** (or
`xvfb-run node src/server.js`). Flipping `HEADLESS=true` to make deployment simpler
would reintroduce this exact failure, which is why the note lives in `.env` next to
the setting.

**Still open.** Real Google Chrome is not installed on this machine, so
`channel: 'chrome'` falls back to bundled Chromium every run. Per `stealth.js` that
single option "does more for detectability than every JS patch combined". If headed
alone does not fix it, `npx playwright install chrome` is the next lever, and it is a
one-command change. Worth noting both gaps were flagged as provisional in F-32 before
either was observed to matter.

**Lesson.** Two lessons, and the smaller one is about instrumentation. The observer
was added one turn before it was needed and it converted an unfalsifiable symptom
("stuck on the login page") into a single decisive number in one run. Before it, three
plausible causes were indistinguishable and a whole round of guessing had already been
spent on the wrong two.

The larger one: the answer came from **comparing against a known-good capture**, not
from reading the failure alone. The failure said "302". Only the recording of a
session that worked established that 200 is what should have appeared there, and that
GEICO's `/ws/` endpoints never redirect. A failure log describes a state; a
known-good baseline is what makes that state meaningful.

---

### F-41 · Headed mode confirmed, a second window, device trust, and the code typed in the wrong place

| | |
|---|---|
| **Area** | adapter:geico / core / UX |
| **Severity** | blocked-submission (chooser), misleading (window + PIN entry) |
| **Status** | fixed; device trust reverses F-33 |

**Confirmed first: headless was the cause of F-40.** With `HEADLESS=false` and nothing
else changed:

```
POST /ws/login/authenticate  ->  200      (was 302)
post-login outcome: methodChooser
```

One variable, isolated, confirmed. The residential-proxy gap is exonerated — the same
IP works headed. `src/browser/stealth.js` had argued for headed on principle; this is
the first measured evidence on a real carrier.

**Defect 1 — the 2SV chooser could not select a destination.**

```
2SV chooser reached, offered: ["Español", "Menu"]
WARN could not select a 2SV destination
WARN flutter button is aria-disabled; clicking anyway
```

Two mistakes. `#readOfferedMethods()` queried only `flt-semantics[role="button"]`, so
it enumerated navigation chrome and never saw the phone or email options — Flutter does
not render selectable options as buttons. And **"Next" was `aria-disabled="true"`**
because nothing had been selected; the code logged that and clicked anyway. An action
followed by an unverified claim of success, which is the O-5 shape, with the evidence
of failure sitting right there in the attribute.

*Fix.* Read the destinations from `/ws/mfa/options` rather than the DOM — GEICO returns
them pre-masked (`(XXX)XXX-5116`), which is both safe to log and the exact string to
match against. Then try four strategies in order (exact label, substring, last-4
digits, radio-by-index) and after each one **check whether "Next" became enabled**.
`aria-disabled` is a true postcondition because GEICO disables it until a choice is
made. "Next" is clicked only once that flips. If all strategies fail, the entire
semantics tree is dumped with roles, `aria-checked` and geometry, so one further run
would identify the target rather than requiring another round of guessing.

Also: falls back to the other channel when the preferred one is not on file, rather
than erroring over a preference, and the status line now names the destination.

Verified on a real run: `selected 2SV destination (Next enabled)` → `POST /ws/mfa/otp/send 200`.

**Defect 2 — a second browser window appeared mid-run.** Reported by the user:
selecting GEICO opened one window, submitting credentials opened another, and the work
continued in the first. The second window is `adopt()` eagerly preparing a replacement
parked page the moment one is consumed.

Harmless headless, confusing headed — a window appearing for no reason the operator can
connect to anything they did. Now deferred when headed: the replacement exists for a
*subsequent* pull, and `POST /api/prewarm` already parks one when a carrier is next
selected, earlier and demand-driven. Boot-time parking was removed for the same reason
in the same change, which is what had been opening two windows at startup.

Both are the O-10 beacon argument applied consistently: a carrier page load should be
caused by a user arriving, not by a process starting or by bookkeeping.

**Defect 3 — device trust, which reverses F-33.** F-33 concluded from GEICO's public
2SV FAQ that verification is required on every login with no trusted-device option, and
set `supportsSessionReuse = false`. The FAQ does say "select your verification method
each time you log in" and mentions no "remember this device" facility.

**It was wrong.** A completed login showed GEICO remembering the browser. Marketing copy
describing the common case was read as describing the mechanism — F-32's mistake again,
absence of mention treated as absence of capability.

The cost was not cosmetic: `pullSession` only persists `storageState` when
`supportsSessionReuse` is true, so the trusted-device cookie was being **discarded at
the end of every run**, and every pull paid a full human MFA round-trip that GEICO was
willing to skip.

*Fix.* `supportsSessionReuse = true`, and `isSessionValid()` now actually probes —
`GET /ws/consolidated-documents` through `context.request`, treating a 200 with a
`policyNumber` as proof. Chosen over navigating and inspecting because of F-18: a URL is
not proof of authentication, a portal will render a shell and then 401 everything behind
it. It is also the exact request `fetchDocuments()` needs, and one request beats a page
load on an app that takes 2.2–6.2s to mount. Never throws — a warm-path probe that
raised would turn a recoverable miss into a failed run.

The cold-path no-MFA branch also stopped logging a warning about "contradicting F-33"
and now notifies the user that no code is needed.

**Defect 4 — the PIN was entered in the wrong window.** The run reached
`MFA_REQUIRED` correctly and then failed after exactly 180s:

```
00:38:02  GEICO auth API call        (a code was submitted to GEICO)
00:40:30  session failed: MFA wait timed out
```

GEICO *accepted* a code at 00:38:02, yet the app timed out waiting for one. The user
typed it into the visible GEICO window rather than the app's modal, so the WebSocket
round-trip the state machine waits on never happened.

Not a code defect — an interaction hazard created by headed mode. Headless made this
impossible because there was no window to type into. **Open**: the robust answer is for
the MFA wait to also resolve when the carrier reports it has become authenticated by
other means, so a human completing the challenge directly in the window is detected
rather than timing out. Not implemented; recorded so it is not rediscovered as a
mystery timeout.

**Defect 5 — a fourth token leak, caught by the audit again.** The failure diagnostic
bundle contained the 48-character policy token, reaching it through `page.url()` in
`debugState`, the timeout evidence block, and the 2SV outcome line. Bundles exist to be
shared, which makes this the worst placement so far.

Fixed with a single `scrubUrl()` in `flutterPage.js` applied at all seven logging sites,
rather than a check per site. The running tally of this class of leak:

| # | Where | Why the previous fix missed it |
|---|---|---|
| 1 | `password` field in a probe artefact | audit had no rule for it |
| 2 | `?token=` in a recording's `url` fields | no rule examined URLs |
| 3 | `?token=` nested in a JSON body (`_goto.externalUrl`) | body scrubber keyed on field names |
| 4 | `?token=` in a failure bundle via `page.url()` | adapter logging sites unaudited |

The pattern every time: redaction written against the shapes imagined, and a real
payload having a shape that was not. `audit:secrets` has now found four leaks its own
author did not anticipate, which is a strong argument for keeping a guard that is
broader than the code it checks.

**Lesson.** The chooser fix and the `aria-disabled` observation were in the same log
line for a full run before being connected — the warning "flutter button is
aria-disabled; clicking anyway" *was* the diagnosis, logged and stepped over. When code
notices something is wrong and proceeds anyway, the log line it emits is worth more than
it looks.

---

### F-42 · Verification codes are alphanumeric, and the code was silently corrupting them

| | |
|---|---|
| **Area** | core / frontend |
| **Severity** | blocked-submission, and **silent** |
| **Status** | fixed |

**Symptom.** Reported by the user: GEICO's verification code looks like **`326F40`**.
Not six digits — six alphanumeric characters.

**Two layers rejected or corrupted it, and only one of them was visible.**

*Layer 1, visible.* `public/index.html`:

```html
<input id="mfa-code" inputmode="numeric" pattern="[0-9]*" maxlength="10" required>
```

`pattern="[0-9]*"` makes HTML5 validation refuse to submit the form at all, and
`inputmode="numeric"` offers a digits-only keypad on a phone, so on mobile the letter
could not even be typed.

*Layer 2, silent, and far worse.* `PullSession.submitMfaCode()`:

```js
const normalised = String(code ?? '').replace(/\D/g, '');
```

`\D` strips every non-digit. `326F40` became **`32640`** — five characters, a code the
carrier has never issued — and that was submitted to GEICO.

**Why the second one is the dangerous one.** Consider the failure from the user's
side: they read `326F40` off their phone, type it correctly, and the carrier rejects
it. The app reports "that verification code was not accepted". The obvious conclusion
is a typo, so they try again, and it fails again. Nothing anywhere — not the UI, not
the logs, not the failure bundle — records that the code was altered between the form
and the carrier. A run consumes real MFA attempts and real carrier lockout budget
chasing a fault that is entirely ours.

**Why it survived the whole project.** Progressive and the demo portal both issue six
numeric digits. For every carrier implemented before GEICO, `\D`-stripping was a no-op
on valid input, so it was not only untriggered but *unfalsifiable* by any test that
used a real code from a supported carrier. It was almost certainly written to tolerate
a pasted code containing a space or a dash — a reasonable intent, implemented by
deleting a character class instead of deleting separators.

**Fix.** Normalise by removing only what a user might have pasted, never a character a
carrier might have issued:

```js
String(code ?? '')
  .trim()
  .replace(/[\s\u2010-\u2015-]/g, '')   // whitespace, hyphens, unicode dashes
  .toUpperCase();
```

Uppercased because GEICO presents codes in uppercase and the field had no
`autocapitalize`. A no-op for digits, so Progressive and demo are unaffected.

Validation is now **length only** — 4 to 12 characters. Deliberately not a
character-class check: a carrier is free to use letters, digits or both, and
validating shape here would reject a valid code from a carrier nobody has onboarded.
**The carrier is the authority on its own code format; our job is to pass it through
unaltered.**

The input element is now `inputmode="text"` with `autocapitalize="characters"`,
`autocorrect="off"`, `spellcheck="false"`, and **no `pattern` at all`.
`autocomplete="one-time-code"` is kept — it still drives OS-level SMS autofill, which
is not restricted to numeric codes.

**Guard.** `npm run test:mfa-format`, now in `smoke:all` (thirteen suites). Twenty
assertions. Two are structural rather than behavioural, and they are the ones that
stop this returning:

- A **negative control** proving the old normaliser corrupts the code:
  `old('326F40') === '32640'`. Without it, the test passes trivially and nothing
  records that there was ever a bug.
- A **drift check** that reads `src/session/pullSession.js` and `public/index.html`
  and fails if `replace(/\D/g` or `pattern="[0-9]` reappears. The normaliser is
  duplicated in the test rather than imported — `PullSession` needs a carrier, a
  browser lease and a live state machine to construct, and this is one pure string
  transformation — so the drift check is what keeps the copy honest.

Also asserted: all-letter codes survive, mixed codes survive, en-dashes from a
smart-quote paste are stripped, and eight-character codes are accepted so no
six-digit assumption creeps back.

**Lesson.** A transformation that is a no-op on all currently-supported input is
invisible, untested and unfalsifiable — and it stays that way until a new carrier
walks into it. `\D`-stripping was not a bug when it was written; it became one the
moment a second carrier existed. Worth asking of any normaliser: *what legitimate
input would this destroy, and would I find out?* Here the answer to the second half
was no, which is the part that made it expensive.

The user found this by reading their own phone. No amount of instrumentation on our
side would have surfaced it, because both the sent and received values were internally
consistent — the corruption happened in between and was never compared against
anything.

---

### F-43 · The 2SV chooser was clicked 14ms after the API answered, while the page was still loading

| | |
|---|---|
| **Area** | adapter:geico |
| **Severity** | blocked-submission |
| **Status** | fixed |

**Symptom.** *"GEICO asked where to send the verification code and the choice could not
be made automatically. Their page layout has probably changed."* That is the adapter's
own message, and **the layout had not changed** — the diagnosis was wrong, and the
message said so with more confidence than it had earned.

**Diagnosis.** The chooser DOM dump added in F-41 answered it in one read. The page
contained:

```
"MFA Options Page"
"This could take up to a minute. Thanks for your patience!"
```

A loading screen. And the timing:

```
01:17:22.479  GEICO 2SV destinations, from /ws/mfa/options
01:17:22.493  could not select a 2SV destination — full chooser DOM
```

**Fourteen milliseconds.** All four selection strategies ran against a page that had
rendered nothing but a spinner, then reported that the layout must have changed.

**Root cause.** No wait between arriving at the chooser and trying to use it. The
`methodChooser` outcome resolves on the URL matching `/mfa/options` (F-38, correctly),
which is true the instant navigation completes — long before Flutter paints the radio
list. The API call to `/ws/mfa/options` returns fast, so having the destinations in
hand created a false sense that the screen was ready.

**This is F-32 unapplied.** `waitForFlutterMount()` exists precisely because this app
renders late — 2.2–6.2s measured on the login form — and it was wired into the login
form and nowhere else. Every Flutter screen in this flow needs the same treatment.
GEICO even says so on the page: *"this could take up to a minute"*.

Worth noting the shape: the lesson was not just recorded, it was **implemented as a
reusable helper**, and still not reached for on the next screen. A lesson learned in one
place does not generalise on its own.

**Fix.** `#waitForChooserOptions()` polls until an element bearing the destination is on
screen with a non-zero box, up to 45s. Three weaker readiness signals were rejected:

| Signal | Why not |
|---|---|
| the URL | already true on arrival — this is what caused the race |
| "Next" existing | renders with the page chrome, before the options |
| a fixed sleep | GEICO says "up to a minute"; any tolerable sleep is too short |

Two details matter. It matches on the **last four digits**, not the whole label, because
GEICO's DOM need not format a destination the way its API does — `(XXX)XXX-5116` in JSON
could render with a space or with bullet masking, and the last four digits are the part
that must be shown for the choice to mean anything. And it requires a **leaf-ish node**
(`label.length < 60`), because Flutter's parent semantics nodes concatenate all child
text — the dump showed
`"EspañolMenuThis could take up to a minute. Thanks for your patience!"` as a single
label, so a naive substring match would hit the whole page.

It also watches for the loading copy as an explicit negative, so a wait that expires
reports *"still showed a loading message"* rather than an unexplained timeout, and tells
the user *"GEICO is preparing your verification options…"* instead of appearing stuck.

**The same defect one screen later, fixed pre-emptively.** `submitMfa()` waited 8s for
the code field. Same class of bug, and a worse moment to hit it: by then the user has
received a code and is typing it, so a short ceiling fails a run that was seconds from
succeeding. Raised to 45s. It polls, so a fast render still costs nothing.

**Not the cause, but worth recording.** The user's hypothesis was that GEICO remembering
the account had changed the page. Reasonable, and it was not that. It is however the
right thing to be ready for, and F-41 enabled that path — `supportsSessionReuse = true`,
`isSessionValid()` probing the documents endpoint, and a cold-path branch that notifies
*"GEICO recognised this device"* when 2SV is skipped entirely. So a remembered device is
handled; it just was not what happened here.

**Lesson.** Two things.

The message was more confident than the evidence. "Their page layout has probably
changed" is a *mechanism*, asserted from a *failure to find an element* — the F-32 rule
broken in user-facing copy rather than in a tool's verdict. A failure to locate
something should say what was looked for and where, not name a cause. Fixed by the wait,
but the copy would have misdirected anyone reading it.

And: having a helper for a known problem is not the same as applying it. The late-mount
lesson had a name, an entry, a measured range and a function — and the next screen still
raced. Worth asking, on any screen in a late-rendering app: *what am I waiting for here,
and is arriving the same as being ready?*

---

### F-44 · Device trust was being thrown away because the session cookie expired

| | |
|---|---|
| **Area** | core / adapter:geico |
| **Severity** | wrong-results (a whole human round-trip paid unnecessarily, every run) |
| **Status** | fixed |

**Symptom.** Reported by the user, and it took a couple of exchanges to understand
properly: *"we need to enter the credentials and login but it does not ask for the MFA
things"*. They were describing GEICO's behaviour in **their own browser** — it no longer
challenges them, because it remembers the device. Yet every automated pull was still
getting a 2SV challenge.

**Root cause.** `storageState` holds two kinds of cookie with very different lifetimes:

| Cookie | Lifetime | Purpose |
|---|---|---|
| session | short | what `isSessionValid()` tests |
| trusted-device | long | lets the carrier skip its MFA challenge |

`pullSession` conflated them:

```js
this.#machine.note('Saved session expired. Signing in normally.');
await storageStateStore.clear(this.carrierId, username);   // deletes BOTH
...
async #coldLogin() {
  await this.#openContext({ storageState: null });          // fresh context, no trust
```

So the moment the short-lived session expired, the long-lived device-trust cookie was
deleted too, and the cold login opened a **fresh** context. GEICO saw an unrecognised
browser and challenged — every single run — while the same account in the user's own
browser sailed through. A long-lived credential discarded to punish a short-lived one.

The cost is the most expensive thing in the whole budget: a **human** MFA round-trip,
measured between 11.9s and 23.8s of wall clock, that the carrier was willing to skip.

**Why it went unnoticed.** Two reasons, both structural rather than careless.

Progressive's device trust never worked (F-30 found the "remember this device" checkbox
had never functioned), so on the only real carrier implemented before GEICO there was no
long-lived cookie to preserve. Clearing everything was lossless.

And F-33 had concluded GEICO had no trusted-device facility at all, so
`supportsSessionReuse` was `false` and the state was never persisted in the first place.
F-41 corrected that flag — which is what made this defect reachable. Fixing one wrong
conclusion exposed a second one behind it.

**Fix.** An opt-in static, read with a fallback so a carrier that does not declare it
behaves exactly as before:

```js
static retainsDeviceTrust = true;     // GeicoCarrier only
```

When set, a failed warm validation **keeps** the saved state instead of clearing it, and
`#coldLogin()` hydrates the context with it. The login is still a full credential submit;
it just may not need the challenge, which is the part a person waits on.

**Why opt-in rather than the default.** Hydrating a context with an expired session
cookie is not free: a portal may render a "your session ended" interstitial instead of a
clean login form. GEICO's `/login` renders its form regardless, so it is safe there.
Progressive has exactly that interstitial at `/app/session-timeout` and needs explicit
handling for it (F-18), and gains nothing since its device trust does not work. Making
this the default would have added risk to the one carrier verified working end-to-end,
for no benefit — the isolation principle applied to shared code rather than to a file.

Verified: `geico retainsDeviceTrust=true`, `progressive=false`, `demo=false`. The demo
run in `smoke:all` still logs the original `Saved session expired. Signing in normally.`
and its warm path still completes in 697ms, so the fallback genuinely preserves the old
behaviour.

**A cost, stated rather than buried.** Hydrating means `storageState` is non-null, and
`adopt_prewarmed` is skipped on that path because a parked page carries no cookies. So a
device-trusted cold login forfeits ~5ms of page adoption to save a ~30s human wait. Not
a close call, but it is a real trade and the metrics will show `prewarmed: false` on
those runs, which would otherwise look like a regression.

**Lesson.** Two lifetimes in one container, cleared as a unit. The bug was not in either
cookie's handling but in treating `storageState` as a single thing with a single validity
— and `isSessionValid()` returning false is a statement about *one* of its contents, not
about all of them. Worth asking of any cache invalidation: *what else is in here, and
does it expire on the same clock?*

Also worth noting how it surfaced. No log line showed it, no test caught it, and nothing
about the behaviour looked wrong from inside the system — a cold login after an expired
session is exactly what you would expect to see. It took a user comparing the automation
against their own browser, which is a comparison the system cannot make for itself.

---

### F-45 · The documents host needs the hand-off token from the URL

| | |
|---|---|
| **Area** | adapter:geico |
| **Severity** | blocked-submission |
| **Status** | fixed |

**Symptom.** Login and 2SV both succeeded — the furthest the flow has reached — then it
sat on the post-auth home page and never retrieved anything:

```
2SV outcome: accepted
url: "https://portfolio.geico.com/?token=<redacted>"
...45s later...
WARN  app never issued a document-list request; trying the API directly
ERROR GEICO document list unavailable: app made no request and direct call failed (401)
```

**Root cause.** The post-auth URL contains the answer: `portfolio.geico.com/?token=…`.
That token is how GEICO passes authority between its hosts, and
`#obtainDocumentList()` navigated to `edgecustomer.geico.com/documents/consolidated-documents`
**without it**. No token, no bootstrap, no document-list request — and then a 45s poll
for something that was never going to be issued.

**The wrong inference that caused it**, recorded because the reasoning looked sound.
F-37 observed this pair of navigations in a captured session:

```
https://edgecustomer.geico.com/documents/consolidated-documents
https://edgecustomer.geico.com/documents/consolidated-documents?token=…&visitAppId=E01
```

A bare navigation followed by a tokenised one, and the conclusion drawn was "the app adds
the token itself, so the bare path is enough". It is the opposite: the bare entry is an
internal SPA route push made *after* the app already held a token for that host. The
ordering in the recording was read as cause and effect when it was effect and cause.

Every single navigation to `edgecustomer` in that session carried a token. That was
visible in the same data and not checked, because one convenient-looking pair had already
supplied an answer.

**Fix.** `#extractHandoffParams()` lifts `token`, `visitAppId` and `convToken` out of
whatever URL the browser is currently on, and the documents navigation forwards them.
All three are forwarded rather than just `token`, because reproducing the browser's
request exactly is cheaper than determining which ones matter — and `convToken` is
legitimately empty in captured traffic, so it is forwarded as seen rather than dropped.

This deliberately does **not** model what the token is. Only that GEICO puts it in the
URL when moving between hosts, which is observable and sufficient. A `URLSearchParams` is
returned rather than a string so a raw token cannot be accidentally interpolated and
encoding is handled.

**A second route added, from the same recording.** The manual session reached the list
via `/view-policy`, not directly. If the direct route yields nothing, the adapter now
retries through `/view-policy` — the intermediate page may establish state the list page
assumes, and following the observed path is cheaper than deducing why it exists. Only
attempted when a token is present, since without one it would fail identically.

**Secret handling.** The token is credential-equivalent. Logs record only
`hasToken: true` and the key names, never a value, and `audit:secrets` passes.

**Lesson.** The evidence needed was in the recording the whole time, and in the failure
log too — `url: "https://portfolio.geico.com/?token=…"` was printed at the moment of
success, one line above the failure. Two separate places said "there is a token in the
URL" and the adapter navigated without one.

The specific error is worth naming: a sequence of two observations was read as *the app
supplies this itself* when it equally supported *the app already had it*. Ordering in a
capture shows what happened, not what caused what. Where a recording offers two readings,
the one that requires no additional work is the one to distrust — and the cheap check
here was available: **every** navigation to that host carried a token, and looking at all
of them rather than the convenient pair would have settled it in seconds.

---

### F-46 · Proxy stickiness was configured but never verified, and a wrong template fails silently

| | |
|---|---|
| **Area** | infra / core |
| **Severity** | would-be wrong-results, silent |
| **Status** | fixed — verification added; Proxy-Cheap template still unconfirmed |

**What prompted it.** A decision to use Proxy-Cheap, and a request to get stickiness and
session continuity right so nothing drops mid-pull.

**First finding: their published API is not the one needed.** `docs.proxy-cheap.com` is a
Postman collection for **ordering** — services, setup, price, execute, authenticated with
`X-Api-Key` / `X-Api-Secret`. It is a provisioning API and says nothing about the proxy
connection protocol. The gateway host, port and sticky syntax live in the dashboard.

Deliberately **not** integrated. Wiring a purchase API into a document-pulling app would
mean holding keys that can spend money, in a process whose job is unrelated, to solve a
problem nobody has — proxies get bought once. The boundary is worth stating because the
API being right there is an invitation to use it.

**The real defect, which predates this.** `buildProxyConfig()` already had the right
abstraction — `PROXY_USERNAME_TEMPLATE` with a `{session}` placeholder, so no vendor
syntax is hardcoded. What was missing is that **nothing checked it worked**, and this is
a configuration that fails without failing:

Residential gateways parse the username, apply the flags they recognise, and silently
ignore the rest. A wrong template therefore yields a perfectly working proxy that
**rotates on every connection**. Login egresses from one IP, the MFA submit from another,
the document fetch from a third. The carrier sees a session hopping between cities and
invalidates it — and the error arrives as "your session expired" or a repeated MFA
challenge, pointing at cookies, selectors or anti-bot. Three layers from the cause.

There is no standard to fall back on:

```
sid-<id> + ttl-<seconds>      -session-<id>       session-<id>
sessionid-<id>                <user>_session-<id>_lifetime-10m
```

And the health endpoint actively encouraged false confidence:

```js
sticky: Boolean(config.PROXY_USERNAME_TEMPLATE)
```

A claim about a config file presented as a claim about behaviour.

**Fix 1 — `npm run proxy:verify`.** Measures rather than assumes. Holds one sticky
session for 45s (configurable past the worst-case pull), probes the exit IP repeatedly,
and requires every probe to return the same address.

The second assertion is the one that makes it meaningful: **a different session must get
a different IP.** Without that control, "one session held one IP" is indistinguishable
from "this account has a single static exit and the template does nothing" — identical
from the first test, very different under load. Together they establish that the session
token is *causing* the stickiness rather than coinciding with it.

Probes go through `context.request`, which shares the browser context's proxy. The
pre-existing `checkEgressIp()` uses Node's `fetch`, which does **not** traverse the proxy
and reports the host's own IP — it says so in its own comment, but verifying on a
different path than the carrier traffic uses would be another tool that lies.

An unreachable echo service is reported as *unchecked*, never as a rotation. Failing a
pull because a third-party endpoint was down would be its own outage.

**Fix 2 — mid-pull rotation detection.** The exit IP is pinned when the context opens
(`proxy_pin` phase) and re-checked immediately before the document fetch. That placement
is the point of maximum exposure: everything earlier happens within seconds of the
context opening, while this runs *after* the human MFA wait — measured at 11.9–23.8s and
allowed up to 180s. Sticky sessions expire in that window, and the upstream node is
someone's home connection that can drop regardless of TTL.

This cannot prevent a rotation; no client can, the IP is not ours. It converts an
unattributable carrier failure into a named one, which given the alternative
attributions is most of the value.

**Deliberately not fatal.** A rotation does not guarantee rejection — the carrier may
not check, or may tolerate it — and aborting a pull that would have succeeded is worse
than proceeding with a warning. The user is told once, plainly: *"The proxy changed IP
while waiting for your code. If this fails, that is why."*

**Fix 3 — honest health reporting.** `/api/health` now reports
`stickyTemplateConfigured`, `stickyPlaceholderPresent`, and
`stickyVerified: 'unknown — run npm run proxy:verify'`. Nothing is called "sticky" on the
strength of a string being non-empty.

**What remains unconfirmed, and is labelled as such.** The Proxy-Cheap template in
`.env.example` is `{user}-session-{session}` — a **starting guess**, marked in the file
as needing verification, because their public documentation does not cover it. The
correct response to not knowing was to build the thing that finds out, not to pick the
most likely format and present it as configuration.

Also documented there: choose a session lifetime longer than the worst-case pull.
`MFA_WAIT_TIMEOUT_MS` allows 180s for a human, so a 10-minute lifetime is a sensible
floor and a 1-minute one will drop mid-flow.

**Lesson.** The abstraction was right and the verification was absent, and for this class
of setting those are not equally important. A configuration whose failure mode is *silent
and misattributed* needs an empirical check, not a well-chosen default — because the
default being wrong looks exactly like the default being right until a carrier rejects a
session for reasons it will never explain.

The negative control is the part worth keeping. It would have been easy to ship a
verifier that only checked "does one session hold one IP", declare success on a static-IP
account, and learn nothing.

---

### F-47 · Production readiness: the setup gaps were all silent-failure gaps

| | |
|---|---|
| **Area** | infra / setup |
| **Severity** | blocked-deployment |
| **Status** | fixed |

**Context.** A request to make the project production-ready and easy for anyone to run.

**What was actually wrong.** Not the Dockerfile — that already handled Xvfb correctly, with an
executable entrypoint and `chmod +x`. The gaps were in configuration, and every one of them
failed without saying so:

| Gap | How it failed |
|---|---|
| `.env.example` had `HEADLESS=true` | GEICO login stalls with a 302 and no error (F-40) |
| `docker-compose.yml` set no `HEADLESS` | inherited a developer's local `.env`, so a container could silently disable a carrier |
| `SESSION_ENCRYPTION_KEY` only warned | sessions never rehydrate; every pull pays a human MFA round-trip (F-44) |
| no preflight | each environment fault presented as something else |

**Decision: hard-fail production without `SESSION_ENCRYPTION_KEY`.** It used to push a warning
onto `config.warnings`. That was defensible when the only cost was "warm sessions do not survive
a restart" — a latency regression. It is not defensible now: saved state carries the carrier's
trusted-device cookie, so an unreadable store silently returns every user to a full human MFA
round-trip, 12–24s each, with nothing in the logs connecting it to a missing variable.

A warning is the wrong instrument. Warnings are read once during setup and never again, and this
fault produces no error at all. Development still gets an ephemeral key, because requiring a
secret to run the demo portal would be a setup obstacle for no security gain. Verified both
paths in a temp directory rather than by reading the code.

**Decision: `HEADLESS=false` set explicitly in compose, not inherited.** Leaving it to `.env`
means a container's behaviour depends on a file that is gitignored and differs per machine. The
one setting that silently disables a carrier should not be ambient.

**`npm run doctor`.** A preflight whose every check maps to a failure that actually happened
here and did not announce itself: silent Chromium fallback (F-32/F-40), `HEADLESS=true` stalling
GEICO, a missing key costing MFA (F-44), a stale process serving old code (F-38), a port held by
something else, a full disk surfacing as a read-only filesystem (F-05).

Browsers are checked by **launching** one, not by looking for a directory. A present
`ms-playwright` folder does not mean a working browser, and launching is also how the
`chrome → chromium → bundled` degradation becomes visible — that degradation changes
detectability without changing behaviour, which is exactly the kind of thing that should not be
inferred from a filesystem check.

**`npm run setup`, and a mistake worth recording.** The first version ran
`npx playwright install chrome`, which on macOS installs Chrome system-wide and therefore
prompts for a **sudo password**. It hung for the full 30-minute timeout when tested.

A setup script that blocks on an interactive prompt is worse than no setup script: it cannot run
in CI, gives no indication whether it is working or stuck, and the user has no way to know a
password prompt is what it is waiting for. It now *detects* Chrome and prints the command.
Installing a browser system-wide is a decision for the person at the keyboard, not a side effect
of `npm run setup`.

**Lesson.** Everything here was a silent-failure gap rather than a missing feature, and the
common shape is a setting whose wrong value produces working-but-degraded behaviour. Those need
either a hard failure or an explicit check — a default and a comment are not enough, because the
comment is read once and the default is never questioned.

---

### F-48 · The status stream was narrating our optimisations to the user

| | |
|---|---|
| **Area** | frontend / UX |
| **Severity** | cosmetic, but misleading |
| **Status** | fixed |

**Symptom.** User feedback: *"Reusing a pre-opened carrier tab, skipping page load"* should not
be shown to the end user, because it describes a technique used to reduce browser open time.

Correct, and the wording made it worse than merely irrelevant. **"Reusing"** and
**"skipping"** both read like corner-cutting to somebody watching their own login happen — the
line describes an optimisation working perfectly and sounds like something being bypassed.

**What an audit of every status line found.** Three leaked implementation, and several more were
written for an engineer rather than a person:

| Before | After |
|---|---|
| Reusing a pre-opened carrier tab, skipping page load | *hidden* |
| Reusing a pre-opened GEICO tab, skipping page load | *hidden* |
| Taking the long way round to your documents… | *hidden* (and renamed to name the actual route) |
| Found a saved session. Trying to resume… | Checking whether you are still signed in… |
| Saved session still valid. Skipping sign-in and verification. | Still signed in. No password or code needed. |
| Saved session expired. Signing in normally. | Your previous sign-in has expired. Signing in again. |
| Completing device trust… | Finishing up so future pulls can skip the code… |

"Saved session", "device trust" and "storageState" are our vocabulary, not the user's. The
rewrites say what it means for them — whether they need to type a password — rather than what the
system is doing internally.

**Decision: hide, do not delete.** Two audiences read these notes and want different things.

A user wants a followable story. An **operator** wants exactly the line that was removed —
pre-warm adoption has been confirmed from *"Reusing a pre-opened carrier tab"* repeatedly while
debugging, and it is the only evidence the optimisation fired at all.

So `note()` takes `{ internal: true }`. The entry still enters the timeline — which means it
still reaches the logs, the failure bundle and `/api/sessions/:id` — and is simply not emitted to
the live UI stream. One call site, one flag, both audiences served.

The alternative considered and rejected was two separate message sets, one for the UI and one for
logs. That doubles the places a message lives and guarantees they drift: the log line would
gradually stop describing what the UI shows, and the next person debugging would trust the wrong
one.

**Also removed:** `· pre-warmed page` from the results footer, same reasoning. `prewarmed`
remains in `/api/sessions/:id` and in the metrics, which is where anyone measuring the
optimisation actually looks.

**Verified** by running a demo pull end to end and reading the stream, plus a unit check that an
internal note stays in the timeline while not being emitted:

```
notes in timeline      : 2   (both retained)
emitted to the UI      : 1   (internal withheld)
internal flag preserved: true
```

The resulting user-visible stream, with nothing about pools, tabs or storage:

```
→ Opening carrier portal and signing in…
· Checking whether you are still signed in…
· Still signed in. No password or code needed.
→ Signed in. Locating policy documents…
· Found 2 documents. Downloading…
→ Documents retrieved using a saved session.
```

**Lesson.** Progress messages are a product surface, and these had been written as debug output
that happened to be rendered. The tell is vocabulary: any status line containing a word from the
architecture — pool, tab, cache, state, session store — is describing the implementation rather
than the user's situation. Worth asking of each one: *does this tell them something they can act
on or wait for?* Three of these told them about a performance technique they never asked about.

---

### F-49 · AWS deployment: three constraints that rule out the obvious services

| | |
|---|---|
| **Area** | infra / documentation |
| **Severity** | blocked-deployment |
| **Status** | documented; not yet deployed |

**Context.** A request to deploy on AWS and document the process as an HTML page. Written to
`docs/aws-deployment.html`, and served at `/deploy` on a running instance — the moment that
document is needed is usually while something is misbehaving, not while the repo is open.

**Chosen: ECS Fargate + ALB + EFS + Secrets Manager.** The reasoning is mostly elimination, and
the eliminations are the useful part:

| Rejected | Why |
|---|---|
| **Lambda** | No Xvfb and no way to add it. No long-lived WebSockets, and session state would have to leave the process — but an open browser context cannot go in DynamoDB. |
| **App Runner** | Closest miss. **No EFS**, so nowhere to persist the encrypted session store, and no `/dev/shm` control. |
| **EKS** | $73/month of control plane to schedule one container that must not be replicated. |
| **Elastic Beanstalk** | Wraps ECS in another layer whose defaults you then fight, the idle timeout especially. |

**Finding 1: Fargate cannot raise `/dev/shm`.** AWS's ECS documentation states that for the
Fargate launch type, `devices`, **`sharedMemorySize`** and `tmpfs` are not supported. So the
64MB default is fixed, and `docker-compose.yml`'s `shm_size: 1gb` has no Fargate equivalent.

Chrome normally crashes on content-heavy pages at 64MB. This app survives **only** because
`stealth.js` already passes `--disable-dev-shm-usage`, which redirects Chrome to `/tmp`. That
flag is therefore **load-bearing on Fargate specifically**: removing it as a cleanup would work
locally and in Compose, and fail in production under load. Noted in the document so the coupling
is visible from the deployment side, since nothing in the code says "Fargate".

**Finding 2: the ALB idle timeout defaults to 60s; `MFA_WAIT_TIMEOUT_MS` is 180s.** The
WebSocket carrying MFA state is idle while a human reads a text message. At the default the ALB
closes it mid-wait, and the failure presents as *"the connection to this session is closed"* —
pointing at the app, the browser or the carrier. Set to 300s, and documented as coupled to
`MFA_WAIT_TIMEOUT_MS`, because nothing enforces the relationship.

**Finding 3: `desiredCount = 1` is a correctness requirement.** Sessions live in an in-memory
`Map`, each owning an open browser context. With two tasks a user's WebSocket can land on the
container that is not running their pull, and the MFA code goes nowhere — intermittently, and
only under concurrency, which is the hardest failure to reproduce. Scaling past one task needs
ALB target-group stickiness or out-of-process session state; neither is built, and the document
says so rather than implying the design scales.

**Cost:** ~$92/month, with the NAT gateway deliberately avoided (~$33) by running the task in a
public subnet with `assignPublicIp`. Nothing inbound reaches it except through the ALB security
group, and the task's own public IP is irrelevant to carriers because all carrier traffic egresses
via Proxy-Cheap. A $32/month single-EC2 alternative is documented too, which sidesteps the ALB
timeout trap and permits `--shm-size`.

**One claim I could not verify, and labelled as such.** The EFS access point needs a POSIX uid
matching the container user. `pwuser` is conventionally uid 1000 in the Playwright image, but
Docker on this machine is still broken (the F-05 read-only VM fault), so I could not confirm it.
The document flags it as unverified and gives the one-line check, because a wrong uid produces a
*silent* unwritable mount: the app starts normally and every pull just quietly asks for MFA again,
since the session store is never written.

**Lesson.** The deployment target exposed a coupling the code does not mention: a browser flag
chosen for container memory behaviour is what makes a specific AWS launch type viable at all.
Neither file references the other, and the only place that relationship exists is this entry and
the deployment document. Worth scanning for others of that shape — a local default that a hosting
platform silently depends on.

---

### F-50 · The guard against a session-save race was installed 5ms too late to fire
| | |
|---|---|
| **Area** | session reuse / storage |
| **Severity** | silent cost — a full cold login and a human MFA round-trip, per occurrence |
| **Status** | fixed; verified by the log line that previously never appeared |

**Symptom.** `npm run smoke:all` reported one failure, in the second demo run:

```
FAIL  used warm path (no login, no MFA)
timings: machine=2.44s  warmPath=false
phases: adopt_prewarmed=0ms acquire_context=8ms nav_login=73ms fill_credentials=829ms …
```

The absence is the tell: no `warm_validate` phase at all. Run 2 did not try a saved session and
fail to validate it — it never found one to try.

**Diagnosis.** `load()` logs on every outcome except `ENOENT`, and the server log for that window
contained none of them, which narrows it to "the file was not there". Two lines explain why:

```
12:14:00.610  INFO: session created             <- run 2 starts
12:14:00.615  INFO: persisted carrier session   <- run 1's save lands, 5ms later
```

Run 1 had found its stored session expired and cleared it, so between the clear and the new write
the store was genuinely empty. Run 2 read it in that gap.

**The uncomfortable part: the guard for this already existed and did not fire.** `#inFlight` was
added precisely so a `load()` would wait for a save in progress (see the note on that field,
written when O-7 moved persistence off the critical path). Had it worked, the log would say
`waiting for an in-flight session save before reading`. It does not appear anywhere in the run.

**Root cause — the reservation was keyed to the wrong moment.** `save()` registers `#inFlight`
synchronously, which is correct as far as it goes. But the caller could not *call* `save()` until
it was holding the state:

```js
const state = await this.#carrier.exportStorageState();   // browser round-trip
await storageStateStore.save(carrierId, username, state); // guard starts here
```

`exportStorageState()` is a round-trip into the browser. For its whole duration the intent to
save exists and nothing records it, so `#inFlight` is empty and a concurrent `load()` sails
through. The guard covered the write and left the export — the slower half — exposed.

**Fix.** Added `reserve(carrierId, username, produceState)`, which registers the key synchronously
and then runs `produceState()` *inside* the reservation. `save()` is now a thin wrapper over it,
so the existing contract is unchanged. `pullSession` reserves instead of saving, which puts the
export inside the window a concurrent `load()` waits on. The reservation is still created before
the `COMPLETED` transition, so by the time a client is told it may start another pull, the key is
claimed.

**Verification — the line that had never appeared:**

```
12:16:54.990  session created
12:16:54.990  waiting for an in-flight session save before reading   <- guard fires
12:16:54.991  persisted carrier session
12:16:54.995  rehydrating persisted carrier session                  <- warm path taken
```

Same ~1ms window as the failure; the reader now waits instead of missing. Run 2: **765ms warm**
against **2,667ms cold with an MFA round-trip**. Reproduced deliberately by deleting
`data/sessions/demo.*.enc` first — with a valid session present both runs go warm and the race is
unreachable, which is why the suite had been passing.

**Lesson.** A guard against a race has its own race: it is only as early as the moment it is
installed. `#inFlight` was registered synchronously *relative to `save()`*, and that read as
correct because the synchronous registration was the deliberate part — the comment on it even says
so. The question that was not asked is when `save()` itself becomes reachable. For any
"register before awaiting" guard, the thing to check is not whether registration is synchronous
but whether anything slow happens between forming the intent and registering it.

**Related.** A second-order note on test design: this suite passed for days because the fixture
left a valid session behind, so run 1 went warm and never produced the clear-then-write gap the
bug needs. The failing case appeared only when the stored session happened to be expired. The
suite is not yet pinned to the cold-start precondition it means to test — flagged, not fixed,
because forcing it would make every `smoke:all` pay a cold login.

---

### F-51 · Configuring a real proxy broke every context that must not be proxied
| | |
|---|---|
| **Area** | browser pool / proxy |
| **Severity** | would have broken production — latent until a proxy was configured |
| **Status** | fixed by deleting the workaround it needed, verified by the full suite |

**Symptom.** The moment `RESIDENTIAL_PROXY_URL` was set to a real Proxy-Cheap proxy, every
demo pull failed:

```
net::ERR_PROXY_CONNECTION_FAILED at http://127.0.0.1:3000/mock-portal/login
```

Nothing about the demo carrier had changed. It uses `usesProxy = false` and talks to a
portal on loopback.

**Why it had never been seen.** `browserPool` launched Chromium with an unroutable
sentinel proxy, `http://per-context`, to unlock per-context proxy overrides — on the
Playwright rule that per-context proxy requires a browser-level proxy. The sentinel was
installed only when `RESIDENTIAL_PROXY_URL` was set. No proxy had ever been configured, so
`#proxyAtLaunch` was always `false`, the sentinel was never installed, and the code paths
that deal with it were never executed. They first ran on the day a proxy was configured,
which is the day they mattered.

**First diagnosis was incomplete, and the error message is why.** The counterpart to the
sentinel was `DIRECT_PROXY = { server: 'direct://' }`, applied to any context that must not
be proxied. Probing it directly:

```
UNPROXIED  direct://                       ERR_PROXY_CONNECTION_FAILED
UNPROXIED  direct:// + bypass=PROXY_BYPASS REACHED (HTTP 200)
UNPROXIED  direct:// + bypass=*            REACHED (HTTP 200)
UNPROXIED  (inherit sentinel)              ERR_PROXY_CONNECTION_FAILED
```

Lines 1 and 4 are identical: the override was doing nothing whatsoever. Adding `bypass: '*'`
fixed navigation, the suite got much further — login, MFA and the document list all passed —
and then died somewhere new:

```
apiRequestContext.get: getaddrinfo ENOTFOUND direct
```

`context.request` is a Node-side HTTP client, not the browser's network stack. It does not
consult the bypass list, and it read `direct://` as a host literally named `direct`. So
`bypass: '*'` fixed one of two transports and the fix looked complete because the first
failure moved rather than disappeared.

**Root cause: the sentinel is obsolete.** Rather than patch the workaround a second time,
the premise got tested. All four combinations on patchright 1.63:

```
WITH sentinel     context WITH proxy    page PASS   request PASS
                  context NO proxy      page FAIL   request FAIL
WITHOUT sentinel  context WITH proxy    page PASS   request PASS
                  context NO proxy      page PASS   request PASS
```

Per-context proxies work without a launch-time proxy. The sentinel bought nothing and cost
every unproxied context, on both transports.

**Fix.** Deleted `PER_CONTEXT_PROXY`, `DIRECT_PROXY` and `#proxyAtLaunch`. The browser
launches with no proxy; a context passes `proxy` when it has one and omits the key when it
does not. Net effect is less code than before the bug.

**Verification.** `npm run smoke:all` with the real proxy live: **184 PASS, 0 FAIL**,
including the warm-path check. `/api/egress` reports the proxy address for browser traffic,
and the demo portal on loopback is reached directly, so no metered bandwidth is spent on it.

**Lesson.** The fix for a workaround is often to check whether it is still needed. Two
rounds of patching `direct://` would have produced a more elaborate version of something
whose entire purpose had expired — the constraint it existed for was lifted by a library
upgrade years ago, and nothing re-examines a comment that cites a rule that used to be true.

**Second lesson, about the test suite.** A conditional guarded by config that is unset in
every test run is not covered, however many times the suite passes. `#proxyAtLaunch` was
`false` in all 184 checks. The suite could not have caught this, and still cannot: it runs
against the demo carrier, and the demo carrier's own breakage is what exposed it — by luck
of it being the thing that runs on loopback. Flagged: there is no test that exercises the
proxied and unproxied paths together.

---

### F-52 · The sticky-session template was a guess, and it was the wrong shape entirely
| | |
|---|---|
| **Area** | proxy configuration |
| **Severity** | would have broken every real carrier login once deployed |
| **Status** | resolved against the live account; the guess is now documented as wrong |

**What was assumed.** `PROXY_USERNAME_TEMPLATE={user}-session-{session}`, carried in `.env`
and `.env.example` with a comment admitting it was unverified. The reasoning was reasonable:
every residential proxy provider encodes sticky sessions in the username, the syntaxes differ,
and Proxy-Cheap's published docs appeared to cover ordering only. So a plausible shape was
written down with a note to confirm it.

**What the account actually contains.** With API credentials available, `GET /proxies`
answered it directly — three proxies, all:

```
networkType   RESIDENTIAL_STATIC
connection    dedicated publicIp, one http port each
authentication  fixed username + password, whitelistedIps: []
isp           Verizon Business
```

There is no session concept anywhere in the response, because this product does not have one.
A `RESIDENTIAL_STATIC` proxy **is** one exit IP. Stickiness is a property of the purchase.

**So the guess was not merely unconfirmed, it was actively harmful.** Interpolating
`{user}-session-{session}` would have rewritten a username the provider expects verbatim.
The proxy would have rejected the credentials, and the resulting failure — carrier
unreachable through the proxy — is indistinguishable at a glance from the IP being blocked,
which is the *expected* failure this whole subsystem exists to avoid. It would have been
debugged as an anti-bot problem.

**Also wrong: the claim that the docs do not cover connecting.** `.env.example` stated that
Proxy-Cheap's published API is the ordering API and "does not describe the proxy connection
protocol". It does. The docs are a Postman collection, and `GET /proxies` returns connection
IP, all three ports, and the proxy's own username and password. The connection details were
in the API the whole time; the docs were skimmed as a spec rather than read as a schema.

**Fix.**
- `PROXY_USERNAME_TEMPLATE` commented out, with the reason inline.
- New `PROXY_MODEL` setting, `dedicated` or `rotating`, because the two products fail
  oppositely and no single default is safe. `dedicated` here.
- `npm run proxy:discover` derives `RESIDENTIAL_PROXY_URL` and `PROXY_MODEL` from the
  account, including matching the port to `proxyType` — one proxy object can carry
  `httpPort`, `httpsPort` and `socks5Port` at once and they are not interchangeable.
- `doctor`, `config` warnings and `/api/health` all now judge the template against the model
  instead of assuming a rotating gateway.

**And the verifier was inverted.** `npm run proxy:verify` reported **two failures** on a
correctly configured proxy: a missing template, and a second session landing on the same IP.
Both are the required outcome for a dedicated IP. It even printed the correct caveat in prose
— *"If your plan is a single static residential IP this is expected and fine"* — and then
counted it as a failure and advised not spending a real login. It now asks the management API
what the product is and inverts the negative control accordingly: for a dedicated IP, a
second session getting a *different* address is the failure.

**Lesson.** The note saying "unverified, confirm this" was doing less work than it appeared
to. It marked the value as uncertain but left the surrounding design — a template exists,
therefore stickiness is encoded in the username — unquestioned, and that assumption was the
actual error. Flagging a value as unverified is not the same as flagging the shape as
unverified. Related: three separate tools (`config`, `doctor`, `verify-proxy`) all encoded
the rotating-gateway assumption independently, so one wrong premise produced three
confidently wrong verdicts.

---

### F-53 · `submitMfa` returned a function instead of calling it, and the user got blamed
| | |
|---|---|
| **Area** | GEICO adapter / MFA |
| **Severity** | broke every GEICO pull at the code-entry step |
| **Status** | fixed; guard added in shared code; regression test in `smoke:all` |

**Symptom.** GEICO reached the PIN screen, the user entered a correct code, and the pull
failed immediately with *"That verification code was not accepted."*

**Diagnosis was an ABSENCE, not an error.** The diagnostic bundle's API trace:

```
POST /ws/login/authenticate   200
GET  /ws/mfa/options          200
POST /ws/mfa/otp/send         200
GET  /ws/mfa/otp/init         200
```

`/ws/mfa/otp/authenticate` — the call that actually submits a code — is **not there**. GEICO
was never asked. So "rejected" was our own verdict about a code that never left the process.

The log was emptier still:

```
13:59:16.556  /ws/mfa/otp/init  200      code sent, PIN page ready
13:59:34.317  MFA rejected               17.8s later
```

Nothing in between. No code-field lookup, no typing, no submit click, no screen detection —
and those are all logged on the working path. A step that produces no output at all did not
run slowly or partially; it did not run.

**Root cause — two missing characters.**

```js
return (async () => {
  …45 lines: find field, type code, click submit, await outcome…
});          // <-- never invoked
```

`submitMfa()` returned the async arrow function itself, synchronously, having done nothing.

The IIFE was residue. It used to be the callback to `this.#timings.measure('mfa_submit', …)`,
removed when that wrapper was found to double-count the phase — the same span was already
measured by `pullSession` as `mfa_submit_${attempt}`, producing two identical 1,949ms entries
in one run. Deleting the wrapper left its argument behind, and the invoking `()` went with the
call.

**Why it presented as a rejected code.** `#runMfaLoop` reads the outcome structurally:

```js
outcome?.accepted    -> undefined   (a function has no .accepted)
!outcome?.retryable  -> true        -> throw MFA_REJECTED, no retry
```

A function object is truthy, so no null check fired. The loop concluded the code was wrong and
not worth retrying, and told the user so.

**Fixes, in order of how much they matter.**

1. **Inlined the body, no IIFE.** Not "added the missing `()`" — the wrapper has no purpose
   now that nothing measures around it, and a bare IIFE around a whole method body is exactly
   what made losing two characters invisible.
2. **Contract guard in `#runMfaLoop`.** `submitMfa()` must resolve to `{ accepted: boolean }`;
   anything else throws a new `ErrorCodes.ADAPTER_CONTRACT` with a message that says the
   problem is ours. Placed in shared code because that is where the contract is defined, so it
   covers every carrier including ones not yet written. Deliberately not retryable — a
   malformed return will be malformed again, and retrying spends the user's remaining carrier
   attempts on our bug.
3. **New error code `ADAPTER_CONTRACT`.** Every existing code describes something the
   *carrier* did. There was no way to say "we are broken", so an adapter bug had to borrow a
   carrier-shaped code, which is how a correct code came to be reported as rejected. Added to
   the frozen enum in `baseCarrier.js` — additive, so Progressive is untouched.
4. **`tools/test-mfa-contract.js`**, wired into `smoke:all`. Asserts the uninvoked-closure
   case classifies as `ADAPTER_CONTRACT` and not `MFA_REJECTED`, covers eight other malformed
   returns including a forgotten `await`, confirms valid shapes still behave, and greps the
   three adapters for a `submitMfa` that returns a closure. Negative control run: the buggy
   string matches, the fixed string does not.

**Verification.** `npm run smoke:all`: **202 PASS, 0 FAIL** (up from 184 — the new suite).

**Lesson — the error message pointed away from the bug.** "That verification code was not
accepted" is a sentence about the user's input, produced by code that had not sent the input
anywhere. Every diagnostic instinct it triggers is wrong: check the code format, check for
expiry, check the field selectors. The failure was two characters in a return statement, four
call frames away. Where an outcome is inferred from the *shape* of a return value, a malformed
return does not read as malformed, it reads as the negative case — so the negative case must be
proven rather than assumed. Concretely: `if (!outcome?.retryable)` treats "no such property"
and "property is false" as the same thing, and they are not remotely the same thing.

**Second lesson — deleting a wrapper is not a safe refactor.** Removing
`#timings.measure(…, cb)` correctly fixed a real double-counting bug (O-15). It also silently
changed the meaning of 45 lines, because the callback outlived the call. Nothing in the suite
covered it: reaching `submitMfa` needs a human MFA round-trip, and the mock adapter returns a
correct object so the guard branch was never taken. This is the third time in this project
that a fix to instrumentation broke the thing being instrumented.
