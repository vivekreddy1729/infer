# Carrier Policy Puller

Web app that signs into a personal-lines insurance portal on the user's behalf, handles the
step-up MFA challenge interactively, pulls the policy declaration documents, and renders them
in the browser.

```
Browser  ──POST /api/sessions──▶  Fastify
   │                                 │
   │◀────── WebSocket ──────────▶  Session state machine
   │   state + MFA round-trip        │
   │                            Browser pool (Patchright / real Chrome)
   │                                 │
   │                            Sticky residential proxy
   │                                 │
   └──GET /documents/:id──▶     Carrier portal
        (native PDF viewer)
```

---

## Run it

Two commands. The first takes a few minutes because it downloads a browser.

```bash
npm run setup     # deps, browsers, .env, session key, preflight
npm start         # then open http://localhost:3000
```

Then pick **Demo Mutual (practice portal)** in the dropdown. It needs no credentials, runs
entirely against a portal this repo hosts itself, and exercises the whole pipeline — login,
MFA round-trip, document fetch, PDF render. If that works, everything works.

For a real carrier, select **Progressive** or **GEICO** and use your own credentials. The
verification code goes to your phone; enter it **in the app**, not in the browser window
that opens.

Something wrong?

```bash
npm run doctor    # checks Node, browsers, .env, port, disk — and prints the fix
```

`npm run setup` is idempotent and never overwrites an existing `.env`.

### The three things worth knowing before a real carrier

**1. `HEADLESS=false` is required, and a browser window will open.** GEICO's login POST
returns `302` under headless and `200` headed — same machine, same IP, same binary. The SPA
cannot follow that redirect, so login stalls with no error. Measured, not preference; see
[F-40](docs/ENGINEERING-LOG.md#f-40--geico-redirects-the-login-post-under-headless-and-the-diagnostic-called-it-success).

In Docker this runs **headed under Xvfb** — a virtual display — so it is a full real Chrome
with no window anywhere. You only see windows locally, because your machine has a real
display.

**2. Enter the MFA code in the app, not the carrier window.** Headed mode means you can see
and type into the carrier's own page. If you do, the carrier accepts the code and the app
times out waiting for its own modal, because the state machine expects it over the
WebSocket.

**3. Set `SESSION_ENCRYPTION_KEY`** (`npm run setup` does). Saved sessions carry the
carrier's trusted-device cookie, which is what lets a repeat pull skip the MFA challenge
entirely. Without a stable key the store is unreadable after a restart and every pull costs
a human round-trip. Required in production — the app refuses to boot without it.

### Everything else

| Command | What it does |
|---|---|
| `npm run smoke:all` | Every check — 14 suites, no credentials needed |
| `npm run restart` | Restart and **verify** it took (config is read once at boot) |
| `npm run doctor` | Preflight |
| `npm run logs:tail` | Follow the log |
| `npm run audit:secrets` | Scan everything written to disk for credential material |
| `npm run proxy:verify` | **Prove your proxy is sticky before spending a real login on it** |

There are ~35 npm scripts; the rest are carrier reconnaissance and single-purpose
diagnostics, catalogued in [`docs/DEBUGGING-TOOLKIT.md`](docs/DEBUGGING-TOOLKIT.md).

---

## Documentation

| Document | What it is for |
|---|---|
| [`docs/ENGINEERING-LOG.md`](docs/ENGINEERING-LOG.md) | **Read this before changing an adapter.** Every failure encountered, its root cause, how it was diagnosed, and what changed. 55 entries. Several fixes look arbitrary until you know what they defend against. |
| [`docs/OPTIMISATION-LOG.md`](docs/OPTIMISATION-LOG.md) | **Read this before optimising anything.** Why each performance approach was chosen, in what order, what it measured, and why two of them failed. Includes a [rejected-approaches table](docs/OPTIMISATION-LOG.md#rejected-approaches-and-why) so experiments are not re-run. 17 entries. |
| [`docs/CARRIER-ONBOARDING.md`](docs/CARRIER-ONBOARDING.md) | The repeatable playbook for adding a carrier, sequenced so the cheapest checks eliminate the most candidates and no real login is spent on an unanswered question. |
| [`docs/windows-ec2-deployment.html`](docs/windows-ec2-deployment.html) | **Deploying on Windows EC2 — the current target.** Leads with the constraint that decides everything: the app *cannot* run as a Windows Service, because GEICO needs a headed browser, headed Chrome needs an interactive desktop, and Session 0 has none. Covers auto-logon, Task Scheduler in Session 1, the `tscon` problem, `icacls` on the credential-bearing directories, and why proxy IP whitelisting becomes the right choice here when it was wrong on Fargate. Served at `/deploy`. |
| [`docs/aws-deployment.html`](docs/aws-deployment.html) | **Deploying on ECS Fargate.** Superseded as the target, kept because the service-elimination reasoning still holds — why not Lambda, App Runner, EKS or Beanstalk — and the Windows guide cites it. Served at `/deploy/fargate`. |
| [`docs/DEBUGGING-TOOLKIT.md`](docs/DEBUGGING-TOOLKIT.md) | Every diagnostic tool, the question it answers, and when to reach for it. Starts with a symptom → tool decision table. |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | Verified map of the codebase: state machine, adapter contract, timing phases, routes, and the non-obvious decisions with their reasons. |

Both logs are append-only, numbered (`F-NN`, `O-NN`), and carry an entry template plus update rules
at the top. The split is deliberate: the engineering log answers *what broke*, the optimisation log
answers *why this approach and not that one* — including the order attempts were made in, which is
usually the part that has to be re-derived otherwise.

Three things keep them from decaying:

- [`.kiro/steering/engineering-process.md`](.kiro/steering/engineering-process.md) — always-on
  steering, so any agent working in this repo gets the process without being told.
- [`.kiro/hooks/update-engineering-log.json`](.kiro/hooks/update-engineering-log.json) — prompts for
  an `F-NN` entry when an adapter, the session core, or the logging/security layer changes.
- [`.kiro/hooks/update-optimisation-log.json`](.kiro/hooks/update-optimisation-log.json) — prompts
  for an `O-NN` entry when timing, browser-pool, pre-warming, config tunables, or adapter code
  changes.

---

## Status, honestly

| Carrier | Adapter | End-to-end verified | Notes |
|---|---|---|---|
| **Progressive** | ✅ implemented | ✅ **yes, with real credentials** | Login, SMS MFA, device trust, document retrieval. Returns the Policy Contract for the in-force policy. |
| Demo Mutual (self-hosted practice portal) | ✅ implemented | ✅ yes, automated | Runs with no credentials; `npm run smoke` |
| **GEICO** | 🔨 near complete | login + 2SV + document selection verified | Flutter Web behind Imperva. Earlier "closed shadow root" verdict was **wrong** — no shadow DOM exists; it mounts 2.3–6.2s late. Selectors verified by read-back (F-32). Device trust works, so a warm path exists — F-33 said otherwise and was wrong (F-41). Requires headed mode: the login POST gets a 302 under headless (F-40). |
| Travelers | ⬜ not started | — | Fallback candidate: Okta IdP, stable `#okta-signin-*` ids |

Progressive works end to end against a real account: PingFederate login → SMS challenge → device
trust → the Policy Contract PDF for the in-force policy, **12,736ms of machine time** excluding the
human MFA wait.

Getting the *right* document took two attempts. The first selected by title text and recency, which
returned a declarations page from a **lapsed** policy because its archived copy carried a newer date
([F-28](docs/ENGINEERING-LOG.md#f-28--wrong-declarations-document-selected)). The fix reads
Progressive's own taxonomy instead — `categories.includes('Contract')`, ranked by policy status
([F-29](docs/ENGINEERING-LOG.md#f-29--document-target-was-hardcoded-and-ranking-ignored-policy-status)).

A second working carrier is still required for submission. Travelers is the recommended candidate.

The orchestration layer — state machine, MFA round-trip, session reuse, stealth browser, proxy
routing, document extraction, latency instrumentation, durable logging — is complete and verified by
seven automated suites. See [Why a practice portal exists](#why-a-practice-portal-exists) for why the
demo carrier was built first.

---

## Quick start

### Local

```bash
npm install
npm run browsers          # downloads Chromium + real Chrome for Patchright
cp .env.example .env
openssl rand -hex 32      # paste into SESSION_ENCRYPTION_KEY in .env
npm start
```

Open <http://localhost:3000>, pick **Demo Mutual (practice portal)**, and submit. The
credential fields prefill with `demo@example.com` / `demo1234`. The verification code is
shown in the MFA dialog (practice portal only) and printed to the server log.

### Verify it works

```bash
npm run smoke:all      # race regression + API + UI + metrics page
```

Or individually:

| command | what it proves |
|---|---|
| `npm run test:race` | the OTP stale-read race cannot regress (no browser, ~1s) |
| `npm run smoke` | full flow over the real transport, PDF bytes validated |
| `npm run smoke:ui` | the page is actually *usable* in a browser, not merely served |
| `npm run smoke:metrics` | metrics render, chart geometry sane, stats invariants hold |

`smoke:ui` exists because of a bug that no API test could catch: the MFA dialog carried
`hidden`, but `.overlay { display: flex }` has the same specificity as the UA stylesheet's
`[hidden] { display: none }` and author styles win ties, so the dialog rendered on every page
load — and being `position: fixed; inset: 0; z-index: 50`, it silently swallowed every click
meant for the credential form beneath it. Every backend test passed throughout while the app
was unusable. "The endpoints work" and "a person can use this" are different claims requiring
different evidence.

Drives the real flow over the real transport — HTTP start, WebSocket attach, MFA challenge,
code submit, document fetch — then asserts the returned bytes are genuinely a PDF, and runs a
second time to prove the warm path skips login and MFA entirely.

```
=== Run 1 ===
  → AUTHENTICATING → MFA_REQUIRED → MFA_SUBMITTED → EXTRACTING_DOCS → COMPLETED
  PASS  "Auto Policy Declarations" is a valid PDF   %PDF- 1.8KB application/pdf
  PASS  machine time within 8s budget              3107ms

=== Run 2 (expect warm path) ===
  → AUTHENTICATING → EXTRACTING_DOCS → COMPLETED
  PASS  used warm path (no login, no MFA)
  PASS  machine time within 8s budget               420ms
ALL CHECKS PASSED
```

### Docker

```bash
docker compose up --build
```

---

## Latency

There is a metrics page at **`/metrics.html`**. Every run — successful or failed — appends its
per-phase timings to `data/metrics.jsonl`, and the page aggregates **min / median / average /
max / p95** per step across all runs.

### Four measurement windows, not one number

Two phases of this flow are not attributable to this system, and quoting a single figure means
either silently hiding them or silently including them:

| Phase | Why it is not ours |
|---|---|
| `mfa_wait` | A person reading an SMS and typing six digits. Unbounded; nothing here can influence it. |
| `document_download` | Raw PDF byte transfer. Dominated by link speed and, in production, by residential-proxy throughput. |

So all four windows are computed over the same run set and shown side by side, with one selected
as the headline:

| Window | Excludes |
|---|---|
| Wall clock | nothing |
| Excluding MFA wait | `mfa_wait` |
| Excluding document transfer | `document_download` |
| Excluding MFA wait + transfer | both |

Measured on real demo-carrier cold runs: wall **3,819ms** → −402ms (MFA) → −63ms (transfer) →
**3,353ms**. The gap between the first and last is the share of the experience this code is not
responsible for.

**The arithmetic here is easy to get quietly wrong**, so it has its own test
(`npm run test:windows`). Phase records include *composite* entries: `login` wraps `nav_login` +
`fill_credentials` + `submit_credentials`, and `documents` wraps the list and download steps.
Summing every phase therefore exceeds wall clock — 48,594ms of phases against 40,158ms of wall
clock on a real Progressive run. Each window's `subtract` list contains only non-overlapping
**leaf** phases, and a test asserts no window ever subtracts a composite. Get that wrong and the
reported latency comes out *lower* than reality, which is the worst possible direction for a
number whose job is to substantiate a performance claim.

### Multi-select filtering

Carrier, auth path and outcome are all multi-select, because the useful questions are
comparative — "Progressive cold versus warm", "everything except the practice portal". A
single-value filter forces those to be answered by flipping between views and remembering
numbers.

**Outcome is a filter rather than a hardcoded "successes only".** That was a real defect: phase
statistics were drawn from completed runs, so a carrier whose every run had failed showed no
phases at all. It read as "no data" when the truth was "plenty of data, all of it failures" —
exactly when you most want to see how far the flow got and how long each step took before it
died. The carrier list is likewise built from all runs, so a carrier appears as soon as it has
produced one of anything.

```
/api/metrics?carrierId=progressive,demo&path=cold,warm&outcome=COMPLETED,ERROR&window=exclBoth
```

So the numbers below are not a one-off measurement that happened to look good; they are a
running distribution that grows with every pull, and anyone can re-derive them from the raw
file. `GET /api/metrics` returns the same aggregation as JSON, `GET /api/metrics/raw` the
individual records.

Two design notes on that store. It is **JSONL, not a JSON array**: an array would need a
read-parse-mutate-rewrite cycle per run, which is O(n) per append and leaves a window where a
crash produces a file that no longer parses at all — losing the entire history. One object per
line appends in O(1), and a torn final line costs exactly one record because the reader skips
what it cannot parse. And it holds **no PII**: phase names and durations only, no usernames, no
document titles, no policy numbers. It accumulates indefinitely and is exactly the sort of file
that gets copied around by accident.

The chart is built from `div`s rather than a charting library. Four numbers on a shared axis
does not justify adding a dependency to an image whose whole purpose is running unattended in a
container, and it works with no network access.

### Why two clocks

The brief asks for under 8 seconds from login to document on screen. Taken literally that
number is unmeasurable, because the flow contains a mandatory human step: nobody controls how
long someone takes to read an SMS and type six digits. Reporting a single figure would either
quietly exclude the human wait without saying so, or include it and be meaningless.

So the app tracks two clocks and the UI shows both:

- **`machineMs`** — everything the system is responsible for. This is what the 8s budget is
  measured against.
- **`wallMs`** — total elapsed, including the human.

Measured on the practice portal, loopback, no proxy:

| Phase | Cold | Warm |
|---|---|---|
| `acquire_context` | 14 ms | 55 ms |
| `nav_login` | 45 ms | — |
| `fill_credentials` | 1,572 ms | — |
| `submit_credentials` | 267 ms | — |
| `warm_validate` | — | 30 ms |
| `mfa_submit` | 677 ms | — |
| `documents` | 84 ms | 132 ms |
| `persist_session` | 11 ms | 5 ms |
| **machine total** | **3,107 ms** | **420 ms** |
| *(human MFA wait, excluded)* | *403 ms* | *n/a* |

Four things worth noting:

**`fill_credentials` is the single largest machine cost at 1.57s.** That is per-character
typing with 24–92ms jitter, and it is a deliberate trade. Portals commonly bind validation to
`input`/`keyup` events, so a one-shot `fill()` leaves the submit button disabled and the run
fails for a reason that looks nothing like the real cause. It also clears the crudest
behavioural check, "entire field populated in one event-loop tick". Dropping the delays would
buy back ~1.4s of the budget; the jitter range is the tunable if a live carrier proves
indifferent.

**Browser cold launch was 6,931 ms on first run** — most of a whole budget, before touching
the network. Hence one browser is launched at boot and kept warm, with sessions taking cheap
isolated contexts off it (14–55ms). Pre-warming is the difference between meeting the budget
and blowing it on request one.

**Add real-world network.** These figures are loopback. A live carrier over a residential
proxy adds real RTT, proxy hops, and heavyweight portal pages. The blocker and the warm path
exist because of that headroom, not despite it.

**Documents are fetched with `context.request.get()`, not by clicking download links.** That
shares the browser's cookie jar and TLS session so the carrier sees the same authenticated
client, while skipping renderer work, download-manager plumbing and temp-file I/O, and it
parallelises across documents cleanly.

---

## Session reuse

Cold path 3,107ms, warm path 420ms — **7.4× faster**, and it skips the entire human MFA
round-trip, which is the part users actually resent.

On success, the context's cookies and `localStorage` are exported and persisted. On the next
run for the same carrier and username, the context is hydrated from that state and the adapter
navigates straight to the documents page.

Validation is a real navigation to an authenticated-only page, not a cookie-expiry check,
because carriers invalidate server-side without touching the cookie. If it does not hold up,
the context is discarded and the flow falls back to a cold login — a stale context is never
reused for credential entry.

Because that blob is live session state for someone's insurance account, it is treated as
credential-equivalent: **AES-256-GCM**, filenames are keyed HMACs rather than usernames so a
directory listing cannot be dictionary-attacked back to identities, `0600` on disk,
write-then-rename so a crash cannot leave a truncated session, and a TTL.

This is a file store on a mounted volume rather than Redis. One container, one volume, one
fewer thing to deploy and get wrong in a short build window. The interface is narrow enough
that swapping in Redis is a contained change.

---

## Anti-bot: what I tried, what worked, what I traded

### Reconnaissance first

Before writing an adapter I fingerprinted what actually sits in front of each portal, because
the answer determines which carriers are even worth attempting. Reproduce with:

```bash
npm run recon                                          # HTTP-layer: which vendor is in front
npm run recon:deep                                     # headers, cookies, script hosts
node tools/probe-carrier.js                            # drive the real stack at the real page
node tools/probe-locators.js <url>                     # can Playwright actually reach the fields?
```

All four are read-only. They navigate, observe, and screenshot. Nothing types a credential or
submits a form.

**Layer 1 — which vendor is in front** (`recon-carriers.sh`, plain HTTP):

| Carrier | Edge / bot layer |
|---|---|
| Progressive | nginx + CloudFront, no bot cookies on the login shell |
| GEICO | **Imperva** (`X-CDN: Imperva`, `visid_incap`/`incap_ses`/`nlbi`) + Quantum Metric replay |
| Travelers | **F5 BIG-IP ASM** (`TS*` cookies) + Dynatrace, **Okta** IdP |
| State Farm | **Akamai** — returned **503 to a plain curl** |
| Allstate, Nationwide | Akamai Bot Manager |
| Lemonade | Cloudflare |
| Hugo | CloudFront, nothing detected |

**Layer 2 — what our actual browser stack gets served** (`probe-carrier.js`, real Patchright
Chrome, residential IP). This is the layer that changed decisions, because the HTTP-level
answer turned out to be a poor predictor:

| Carrier | Verdict | Detail |
|---|---|---|
| **Travelers** | ✅ **login form served** | `#okta-signin-username`, `#okta-signin-password`. Stable IDs. `TS*` + `__cf_bm` cookies set, but not blocking. |
| **Progressive** | ✅ **login form served** | `#inputPassword` stable; username id is **randomly generated per load** (`#input0489363666071094`) so it must not be used. No bot cookies at all. |
| Lemonade | ⚠️ partial | Email-first multi-step. Input id is a random float — same trap. |
| Hugo | ⚠️ partial | Email-first multi-step; may be magic-link, which has no password to automate. |
| **GEICO** | ✅ **login form served** | Originally recorded ❌ not selectable. **That was wrong** — see below. Flutter Web, mounts 2.3–6.2s late; `input[autocomplete="email"]` + `input[type="password"]` verified by read-back. |

Three findings from this layer that no amount of HTTP probing would have surfaced:

1. **Progressive's login is at `/access/login`, not `/access/ez/login`.** The latter returns a
   404 "Looks like something's missing" page. Encouragingly, a 404 rather than a wall — and
   worth noting that a naive run would have read the empty page as "we got blocked" and written
   off the most tractable major carrier on the list.

2. **Two of these carriers generate random DOM ids per page load.** Progressive's username
   field and Lemonade's email field both do. An adapter built by copying ids out of devtools
   would work once and then fail forever, in a way that looks like anti-bot but isn't.

3. **GEICO was ruled out, and the ruling was wrong.** This is the most useful thing the probing
   produced, though not in the way originally claimed.

   The recorded verdict was that `input[type="password"]` had a count of **zero** to both
   `page.evaluate` and Playwright's locator engine while a screenshot showed the form plainly, and
   that the form therefore lived in a **closed** shadow root. It was written down as "verified, not
   assumed".

   It was assumed. What had been measured was an *absence*, and at least four causes produce that
   same observable: a closed shadow root, a cross-origin iframe, a late mount, or a wrong entry
   point. No test had been run that could distinguish them.

   The test that can: patch `Element.prototype.attachShadow` from an init script, which runs before
   any page script, and record every root as it is created — a closed root is only unreachable if you
   did not hold the reference at creation. Result: **zero shadow roots of any kind**, and
   `input[type="password"]` at count 1. GEICO is a **Flutter Web** app that mounts 2.3–6.2s after
   `domcontentloaded` behind Imperva. It is automatable with ordinary attribute selectors, verified
   by typing into both fields and reading the values back.

   The transferable lesson is about tooling, and it is the fourth instance of the same failure in
   this project: **a tool must not report a conclusion it has no test for.** "No password field
   found" is a measurement; "closed shadow root" is a diagnosis. The probes now refuse to name a
   mechanism they did not test. Full account in
   [F-32](docs/ENGINEERING-LOG.md#f-32--geico-was-ruled-out-for-a-reason-that-was-wrong).

Conclusion: **pick carriers by what the stack can actually reach, not by brand recognition or by
what the HTTP headers imply** — and hold a *negative* verdict to the same standard, since this one
cost a carrier for most of the project. GEICO + Progressive is now the pairing being built.

### The stealth posture is subtractive, and that is the point

The standard recipe is `playwright-extra` + `puppeteer-extra-plugin-stealth`: patch
`navigator.webdriver`, spoof WebGL vendor strings, invent a plugin array, pick a user agent.
I did not use it, for two reasons.

1. **The patches are injected, and injecting is detectable.** Anything applied via
   `addInitScript` runs in the page's main world where detection code can see the seams —
   property descriptor order, `toString` of patched natives, timing.

2. **Hand-rolled overrides create internal contradictions, which are a stronger signal than
   the default they replaced.** A macOS user agent alongside a Linux platform string, a
   SwiftShader WebGL renderer, and a 1920×1080 viewport with no scrollbar width is a
   combination no real browser produces. Detection vendors stopped grepping for
   `navigator.webdriver` years ago. They look for combinations that cannot physically coexist.

Instead: **Patchright**, which patches the leaks below the page rather than inside it — it runs
its own JS in isolated execution contexts and disables the Console API, closing the
`Runtime.enable` CDP leak that detectors actually fingerprint. Per
[its own documentation](https://www.npmjs.com/package/patchright) the most undetectable
configuration is real Google Chrome, a persistent context, and **no** custom headers or user
agent. So nothing is injected and a real Chrome is left to be a real Chrome.

Concretely, in `src/browser/stealth.js`:

- **`channel: 'chrome'`, falling back to `'chromium'`, and only then to unset.** This is
  load-bearing in a non-obvious way. With no channel and `headless: true`, Playwright launches
  `chrome-headless-shell` — a separate stripped binary, not Chrome in headless mode. It reports
  `HeadlessChrome` in its UA, has no `chrome.runtime`, and omits the extension and PDF-viewer
  plumbing. It is identifiable with no fingerprinting effort at all. Naming a channel forces
  the full browser binary. **This one option does more for detectability than every JS patch
  combined.**
- **`viewport: null`.** A fixed viewport is a cheap headless tell: automation defaults
  (1280×720, 800×600) are over-represented and, more tellingly, produce an inner/outer
  dimension relationship no windowed browser has.
- **Locale and timezone are set, not spoofed.** They are the two values the server already
  knows from the proxy exit IP, so a US residential IP driving a UTC/en-GB browser is a
  contradiction. These track the proxy's geography.
- **`--disable-gpu` is deliberately omitted.** It forces a SwiftShader WebGL renderer, a
  well-known headless signal.
- **`--disable-blink-features=AutomationControlled` is deliberately omitted.** Redundant once
  the driver patches below Blink, and it changes behaviour we would rather leave stock.
- **Headed under Xvfb in production** (`HEADLESS=false`). Real windowed Chrome on a virtual
  display differs from new-headless in ways vendors probe — `outerHeight` vs `innerHeight`,
  screen dimensions, whether a compositor reports a real display. Costs ~80–150MB RSS.

### IP reputation is the precondition, not an optimisation

Carrier portals score IP reputation before they score anything else. Every mainstream host —
AWS, GCP, Fly, Render, Railway — egresses from ASNs that are published, well-known, and
pre-flagged. **A flawless browser fingerprint on a datacenter IP still loses.**

Traffic is routed through **sticky residential proxies**. Sticky specifically, because the flow
spans login → challenge → code submit → document fetch, which is 30 seconds to several minutes
of human time. A rotating proxy changes IP mid-flow, the carrier sees the session jump
geography, and it invalidates the session or forces a fresh challenge. Every request in one
pull must leave from one IP.

Providers encode stickiness in the proxy username and each does it differently, so it is
configuration rather than code:

```env
RESIDENTIAL_PROXY_URL=http://USER:PASS@gate.decodo.com:7000
PROXY_USERNAME_TEMPLATE=USER-session-{session}-sessionduration-10   # Decodo
# PROXY_USERNAME_TEMPLATE=USER_session-{session}_lifetime-10m       # IPRoyal
# PROXY_USERNAME_TEMPLATE=USER-session-{session}                    # Bright Data
```

Pay-as-you-go with instant signup is around $4/GB (Decodo, IPRoyal, Proxy-Cheap); Bright Data
and Oxylabs gate residential behind KYC, which is a poor fit for a short clock.

One subtlety in `browserPool.js`: Playwright only honours per-context proxy overrides if the
browser was launched with *some* proxy, so a sentinel is passed at launch to unlock that.
But it is a real setting, not a no-op — any context that does not override it inherits an
unroutable proxy and every navigation dies with `ERR_PROXY_CONNECTION_FAILED`. So the sentinel
is installed only when a proxy is configured, and contexts that must not be proxied get an
explicit `direct://` override. (This cost me a debugging cycle; the practice portal is on
loopback and was being dutifully routed to a dead proxy.)

### The trap in asset blocking

Blocking images, media and fonts is where most of the latency budget comes from — 40–60% fewer
requests. But the commonly-copied snippet
`page.route('**/*.{png,jpg,css,analytics}', r => r.abort())` quietly makes things **worse**,
for two reasons.

**Never block the bot-detection script.** Akamai, Imperva and DataDome all work by serving JS
that profiles the browser and mints a token which must accompany the auth request — Akamai's
`_abck`, Imperva's `___utmvc`. Block that script and the token is never minted, so the login
POST arrives unsigned and is rejected. *The request you most want to skip is the one you
cannot.* `src/browser/resourceBlocker.js` keeps a hard allowlist (`/akam/`, `bmak`, `___utmvc`,
`datadome`, `perimeterx`, `recaptcha`, `kasada`, OneTrust…) that is fetched regardless of every
other rule.

**Be careful with stylesheets.** Playwright's visibility checks are computed from layout. An
element in a container whose stylesheet never loaded can resolve differently than it would in a
real browser, so selectors that pass locally fail in production looking like flakiness. CSS
stays on by default and is opt-in per carrier once that carrier's selectors are proven.

Third-party analytics *is* dropped, including Quantum Metric. It observes; it does not gate.

### What this does not defend against

Stated plainly rather than buried:

- **TLS/JA3 fingerprinting.** Real Chrome produces a genuine Chrome ClientHello, so this is
  handled incidentally rather than by design. A carrier correlating JA3 against HTTP/2 SETTINGS
  order would beat us.
- **Behavioural biometrics.** Typing has per-character jitter, which defeats "populated
  instantly" and nothing more. GEICO's Quantum Metric models mouse paths and keystroke cadence;
  we do not simulate either.
- **Proof-of-work interstitials and CAPTCHAs** (Kasada, hard Cloudflare, reCAPTCHA). No solver
  is wired in. These **fail closed with an explicit message** rather than hanging — `baseCarrier`
  detects challenge frames and bot-wall copy and reports `BOT_WALL`/`CAPTCHA`, because
  otherwise the symptom is a 20s timeout and a misleading "selector not found".

---

## Hosting: why this cannot be your laptop

The brief calls this out, and it is the right thing to call out. A Playwright run against your
own Chrome profile works because your laptop has a residential IP the carrier already trusts
and cookies it has already seen. None of that survives contact with a server.

What this repo does about it:

- **Containerised on the pinned Playwright base image** (`v1.63.0-noble`, matching the
  `patchright` dependency exactly — a driver/browser revision mismatch fails at launch, so
  those two version numbers move together).
- **Real Chrome installed in the image**, not only Chromium, so the preferred stealth path is
  available in production and not just locally. Installing only Chromium would silently
  degrade prod while local stayed fine — precisely the class of bug this task is about.
- **Residential egress via configured proxy**, because the container's own IP is disqualifying.
- **Persistent volume** for encrypted session state, so a redeploy does not force every user
  back onto the cold path.
- **`shm_size: 1gb`.** Chrome crashes on content-heavy pages with Docker's default 64MB
  `/dev/shm`.
- **Runs as unprivileged `pwuser`.** It is a browser loading untrusted remote pages.
- **Healthcheck asserts the browser launched**, not merely that the port is listening. A
  process serving 200s that cannot launch Chrome is not healthy for this workload.
- **`auto_stop_machines = false`** on Fly. A session sits blocked on human MFA input with the
  browser context in machine memory; suspending mid-flow would destroy it. A deliberate cost
  decision, not an oversight.
- **2GB RAM.** Chrome + Xvfb + Node sits at 700–900MB with one active context, and the OOM
  killer takes the machine, not the tab.

```bash
fly launch --no-deploy --copy-config
fly volumes create session_data --size 1 --region ewr
fly secrets set SESSION_ENCRYPTION_KEY=$(openssl rand -hex 32)
fly secrets set RESIDENTIAL_PROXY_URL='http://user:pass@gate.provider.com:7000'
fly secrets set PROXY_USERNAME_TEMPLATE='user-session-{session}-sessionduration-10'
fly deploy --remote-only
```

---

## Logs and diagnostics

Logs are written to disk **by the application**, not by shell redirection. That
distinction matters: piping to `tee` works right up until someone starts the process
a different way — a `CMD` in a Dockerfile, a process manager, a one-off
`node src/server.js` while debugging — and then the logs for the run you care about
simply do not exist. This cost me a debugging round on the Progressive adapter, so
it is now owned in-process where it cannot be forgotten.

Two destinations, always:

| | |
|---|---|
| **stdout** | what the platform aggregates (`fly logs`, `docker logs`). Ephemeral: bounded retention, gone when the machine is replaced. |
| **`logs/app.log`** | durable NDJSON on the mounted volume, rotating at 20MB × 10 files. This is the copy you can hand to someone. |

Process-level faults are captured too — `uncaughtException`, `unhandledRejection`
and process warnings all route into the log, because the most serious failures are
otherwise the ones that leave no trace.

### Getting logs off a deployed instance

```bash
curl -H "Authorization: Bearer $DIAGNOSTICS_TOKEN" \
  https://your-app/api/diagnostics                                   # index + environment
curl -H "Authorization: Bearer $DIAGNOSTICS_TOKEN" \
  "https://your-app/api/diagnostics/logs.txt?limit=2000" -o app.log  # plain text
curl -H "Authorization: Bearer $DIAGNOSTICS_TOKEN" \
  "https://your-app/api/diagnostics/logs?sessionId=<id>&level=warn"   # one run, JSON
curl -H "Authorization: Bearer $DIAGNOSTICS_TOKEN" \
  https://your-app/api/diagnostics/sessions/<sessionId> -o bundle.json
```

**Access control.** These serve application logs. They are redacted, but they still
describe a specific person's session with their insurance carrier. So:
`DIAGNOSTICS_TOKEN` set ⇒ bearer token required; unset ⇒ **loopback only**. A
deployment that forgets to set the token is locked down rather than silently
exposed — it fails closed. Token comparison is constant-time, since a
length-dependent early return leaks the token to anyone willing to measure.

### Failure bundles

Every failed run automatically writes a self-contained document to
`logs/failures/<timestamp>_<carrier>_<errorCode>.json`, containing the state-machine
timeline, per-phase timings, carrier internals (PingFederate flow history, whether an
authenticated API call succeeded), an environment snapshot, and every log line for
that session.

Written unprompted, because the evidence has to exist before anyone knows they need
it: sessions are reaped within a minute of settling, so by the time a user says "it
failed" the in-memory state is long gone. Filenames are sortable and self-describing,
so a directory listing is already a summary:

```
logs/failures/2026-09-26T14-41-32-676Z_demo_INVALID_CREDENTIALS.json
```

### Redaction is tested, not assumed

`npm run audit:secrets` scans everything the app writes for JWTs, bearer tokens,
OAuth parameters, password fields, SSNs and private keys, and fails the build on a
hit. It has caught real leaks three times:

1. **The flow recorder leaked bearer tokens two ways.** The `authorization` header
   went down a cookie-name code path that split on `[;,]` and took everything before
   the first `=` — fine for cookies, but a JWT contains none of those until its
   trailing padding, so ~100 characters of live token survived "redaction".
   Separately, every request URL was logged while Progressive's OAuth flow puts its
   access token in a URL **fragment**. Redacting headers and forgetting URLs leaks
   the same secret by a different route.
2. **The diagnostics endpoints accept `?token=`,** and request logging is on — so
   every authenticated diagnostics fetch would have written the diagnostics token
   into the very log file it was protecting. Now scrubbed in place:
   `/api/diagnostics?token=<redacted>`.
3. **An error message echoed the demo password.** Harmless in itself — it is public
   and documented — but a password-shaped literal in a shared log file is a bad
   habit regardless of whether that particular secret matters.

The audit also has a negative control in its test path: planting a real secret must
make it fail. An audit that always passes is indistinguishable from no audit.

**One honest caveat it reports rather than hides.** `data/profiles/` holds Chrome
profiles, and those contain live session cookies — that is what makes the warm path
work — *and* the carrier's OAuth access token, because the token arrives in a URL
fragment and Chrome records visited URLs in `History` and its session-restore files.
Nothing this app writes puts it there; Chrome does. Consequences: `data/` is
gitignored and must stay so, a profile directory is credential-bearing and must never
be attached to a bug report, and `npm run profiles:clear` removes them (the next run
falls back to a cold login). Diagnostic bundles never include profile contents, so
logs remain safe to share.

---

## Handling someone's credentials

The app asks users to type their insurance portal password into a form. That deserves an
explicit answer rather than silence.

- **Never written to disk.** Held in a `Buffer` in a single-use vault, zeroed immediately after
  the portal has them — before the MFA wait, which is the longest phase of the session.
- **Never logged.** Redaction is declared once at the logger, the only exit logs have, with
  `remove: true` so the key is dropped entirely rather than printed as `[Redacted]` — a leaked
  field cannot even be confirmed to exist. The vault also overrides `toJSON` and
  `util.inspect` so it cannot be accidentally serialised into a response.
- **Never sent anywhere but the carrier.** No third-party calls with credentials in scope.
- **Documents are held in memory only**, with a 10-minute TTL, and served `no-store`. They
  contain full name, address, VIN, coverage limits and premium. Nothing hits disk, so there is
  no cleanup job to get wrong.
- **Rate limited**, because every accepted request spawns a browser, burns metered residential
  bandwidth, and pushes login attempts at a third party that will lock the account.

Honest limitation: `reveal()` must hand Playwright a JS string, and V8 strings are immutable
and GC-managed, so that copy cannot be forcibly wiped. Zeroing the Buffer shrinks the window,
it does not eliminate it. Eliminating it entirely would mean never having the plaintext in the
process, which this flow rules out.

---

## Why a practice portal exists

`src/mockPortal/` serves a fake carrier portal from this same app. It is not a stub or a mock
object: a real HTTP login form, a real one-time-code step, a real authenticated document list,
and real generated PDF bytes. Playwright drives it in a real browser over the network, through
the same pool, blocker, state machine and WebSocket transport a live carrier uses.

Three reasons it was the first thing built:

1. **It decouples pipeline risk from portal risk.** Live-carrier work has genuinely unbounded
   variance — a selector changes, an IP gets burned, an account locks out. That risk should not
   be able to take the whole system to zero. With this in place the orchestration is provably
   working and deployed before a single real portal is attempted.
2. **It makes the repo runnable by a reviewer with no credentials**, which is otherwise
   impossible for a project whose entire purpose is logging into someone's insurance account.
3. **It is a better development harness than a live portal:** no rate limits, no lockouts, no
   waiting on a real SMS, and it can be made to fail on demand to exercise the error paths.

It deliberately reproduces the behaviours that break naive automation rather than being a
friendly happy path: submit stays disabled until real `input` events fire, the auth POST has
server-side latency, a wrong code is rejected but retryable, and document URLs are generated so
they must be scraped.

---

## Architecture notes

```
src/
  server.js                  Fastify, HTTP API, WebSocket transport, static UI
  config.js                  zod-validated env; fails at boot, not mid-login
  logger.js                  pino with hard credential redaction
  session/
    stateMachine.js          Explicit whitelisted transitions
    pullSession.js           Orchestrates one pull; owns context + vault lifetime
    sessionManager.js        Registry, TTL reaping, concurrency ceiling
    credentialVault.js       Buffer-backed, zeroed, single-use
  browser/
    browserPool.js           Warm browser, per-session contexts, sticky proxy
    stealth.js               Fingerprint posture (and what it deliberately omits)
    proxy.js                 Sticky residential session routing
    resourceBlocker.js       Asset blocking + anti-bot sensor allowlist
  carriers/
    baseCarrier.js           Contract + shared primitives
    mockCarrier.js           Reference implementation
    registry.js              Add a carrier in one place
  storage/
    storageStateStore.js     AES-256-GCM session persistence
    documentStore.js         In-memory documents, TTL
  telemetry/timings.js       Two-clock latency instrumentation
  mockPortal/routes.js       Self-hosted practice portal
```

**WebSocket, not SSE.** The MFA step needs a client→server message mid-flow. SSE would handle
the status stream but need a separate POST for the code, reintroducing the correlation problem
the socket solves for free.

**The state machine whitelists transitions and throws on illegal ones.** The failure mode that
matters most is a context the system believes is authenticated when it is actually sitting on a
captcha wall. Two edges are easy to miss and both are load-bearing:
`AUTHENTICATING → EXTRACTING_DOCS` is the warm path that skips MFA, and
`MFA_SUBMITTED → MFA_REQUIRED` is the retry after a mistyped code — the single most likely
failure in the flow.

**`raceOutcomes()` in `baseCarrier` is the key primitive.** After a credential submit the next
screen is genuinely non-deterministic: MFA challenge, straight to dashboard, inline validation
error, device-trust interstitial, or a bot wall. Sequentially waiting for the one you hope for
means every other branch costs a full timeout and then reports the wrong cause.

**Events are buffered until the socket attaches.** `run()` starts immediately and a fast
failure can reach `ERROR` before the client finishes opening the WebSocket. Without buffering,
the UI would hang on "Authenticating…" for exactly the failures that are quickest to diagnose.
Socket close resumes buffering rather than cancelling, so a laptop that sleeps during the MFA
wait can reconnect and resume.

**Adding a carrier** is: implement `BaseCarrier`, add it to `registry.js`. No frontend change —
the dropdown and the MFA modal are driven entirely by backend state.

---

## Configuration

See `.env.example`. The ones that matter:

| Variable | Why |
|---|---|
| `SESSION_ENCRYPTION_KEY` | 32-byte hex. Absent ⇒ ephemeral key ⇒ persisted sessions die on restart. |
| `RESIDENTIAL_PROXY_URL` | Required for real carriers. Warns loudly at boot if unset in production. |
| `PROXY_USERNAME_TEMPLATE` | Sticky-session encoding. Warns if `{session}` is missing. |
| `BROWSER_DRIVER` | `patchright` (default) or `playwright` as an escape hatch. |
| `HEADLESS` | `false` runs headed under Xvfb in the container. Better stealth, more RAM. |
| `BLOCK_RESOURCES` | Asset blocking. Turn off to debug selector problems. |

`GET /api/health` reports the driver, the resolved Chrome channel, whether the browser
actually launched, proxy configuration, and the boot warnings — enough to tell whether a
deployment is genuinely functional rather than merely listening.

---

## Known gaps

- Real carrier adapters are not implemented; the pipeline they plug into is.
- No CAPTCHA or proof-of-work solving. Fails closed with a clear message.
- Concurrency ceiling is a fixed 12 with a single warm browser. Beyond that needs a real
  browser-per-machine pool with a queue.
- Chrome profiles are machine-local, so device-trust markers do not survive a redeploy; the
  encrypted `storageState` store is the portable counterpart and does.
- Documents are in-memory, so they do not survive a restart mid-session. Intentional, given
  what they contain.
