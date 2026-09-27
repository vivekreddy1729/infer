# Architecture Reference

A verified map of what exists. Generated from reading the source, not from memory — if it disagrees
with the code, the code wins and this file needs updating.

Node ≥20, ESM. 43 source files: `src/` (22), `public/` (5), `tools/` (16).

---

## Request flow

```
Browser
  │  POST /api/sessions {carrierId, username, password}          → 202 {sessionId, wsUrl}
  │  WS   /api/sessions/:id/stream                               ↔ state + MFA round-trip
  │  GET  /api/sessions/:id/documents/:docId                     → application/pdf
  ▼
server.js ──> sessionManager ──> PullSession
                                    │
                                    ├── SessionStateMachine   (whitelisted transitions)
                                    ├── CredentialVault       (Buffer-backed, zeroed)
                                    ├── Timings               (two clocks)
                                    └── browserPool ──> context ──> CarrierAdapter
                                                          │
                                                   resourceBlocker
                                                          │
                                                  sticky residential proxy
                                                          │
                                                    carrier portal
```

On terminal state, `PullSession` writes to `metricsStore` (always) and `diagnostics` (on failure).

---

## Directory map

### `src/` — application

| File | Responsibility |
|---|---|
| `server.js` | Fastify instance, all routes, WebSocket transport, diagnostics access control, lifecycle |
| `config.js` | Single zod-validated source for all 27 env vars; `process.exit(1)` on invalid |
| `logger.js` | Pino, dual destination (stdout + rotating file), hard redaction, crash handlers |
| `logging/rotatingFile.js` | Size-based rotating sink on the main thread (not a worker — see below) |
| `session/stateMachine.js` | `States`, whitelisted `TRANSITIONS`, `IllegalTransitionError` |
| `session/pullSession.js` | Orchestrates one pull; owns lease, adapter, vault, timings |
| `session/sessionManager.js` | Bounded registry (`MAX_CONCURRENT = 12`), TTL reaper |
| `session/credentialVault.js` | Buffer-backed credentials, zeroed, single-use, unserialisable |
| `browser/browserPool.js` | Warm shared browser, per-session contexts, persistent-profile path |
| `browser/stealth.js` | Fingerprint posture — subtractive, injects nothing |
| `browser/proxy.js` | Sticky residential proxy session builder |
| `browser/resourceBlocker.js` | Asset blocking + anti-bot sensor allowlist |
| `carriers/baseCarrier.js` | Adapter contract + shared primitives |
| `carriers/registry.js` | `ALL = [ProgressiveCarrier, MockCarrier]`; add a carrier here |
| `carriers/progressive.js` | Progressive adapter (~1350 lines, heavily annotated) |
| `carriers/mockCarrier.js` | Reference adapter for the self-hosted demo portal |
| `storage/storageStateStore.js` | AES-256-GCM `storageState`, HMAC filenames, 0600 |
| `storage/documentStore.js` | In-memory PDFs, 10-minute TTL, never on disk |
| `telemetry/timings.js` | Per-phase timing, `machineMs` = wall − human phases |
| `telemetry/metricsStore.js` | Append-only JSONL + aggregation, windows, composites |
| `diagnostics/diagnostics.js` | Log reader, environment snapshot, shareable bundles |
| `mockPortal/routes.js` | A real fake carrier portal: login, OTP, generated PDFs |

### `public/` — frontend

`index.html`, `app.js` (WS-driven state renderer, holds no flow logic), `metrics.html`,
`metrics.js` (hand-built div charts, no charting dependency), `styles.css`.

### `tools/` — diagnostics and tests

See `docs/DEBUGGING-TOOLKIT.md`. Summary: `recon-carriers.sh`, `recon-deep.sh`, `probe-carrier.js`,
`probe-locators.js`, `lib/domInventory.js`, `record-flow.js`, `scrub-recording.js`,
`inspect-documents.js`, `repro-documents.js`, `trace-documents-page.js`, `smoke.js`, `smoke-ui.js`,
`smoke-metrics.js`, `test-flow-race.js`, `test-windows.js`, `audit-secrets.js`.

---

## Session state machine

```
INIT ──> AUTHENTICATING ──┬──> MFA_REQUIRED ──> MFA_SUBMITTED ──┬──> EXTRACTING_DOCS ──> COMPLETED
                          │         ▲                           │
                          │         └───────────────────────────┘   (wrong code, retry)
                          └──────────────────────────────────────>  (warm path, skips MFA)

any state ──> ERROR
```

| From | Allowed next |
|---|---|
| `INIT` | `AUTHENTICATING`, `ERROR` |
| `AUTHENTICATING` | `MFA_REQUIRED`, `EXTRACTING_DOCS`, `ERROR` |
| `MFA_REQUIRED` | `MFA_SUBMITTED`, `ERROR` |
| `MFA_SUBMITTED` | `EXTRACTING_DOCS`, `MFA_REQUIRED`, `ERROR` |
| `EXTRACTING_DOCS` | `COMPLETED`, `ERROR` |
| `COMPLETED`, `ERROR` | terminal |

Two edges are load-bearing and easy to miss:

- **`AUTHENTICATING → EXTRACTING_DOCS`** is the warm path — a rehydrated session skips MFA entirely.
- **`MFA_SUBMITTED → MFA_REQUIRED`** is the retry after a mistyped code, the single most likely
  failure in the flow.

Illegal transitions **throw** `IllegalTransitionError`. The failure mode this guards against is a
context the system believes is authenticated when it is actually on a captcha wall. `fail()` is the
exception: it is safe from any state, setting `ERROR` directly if no legal edge exists, so cleanup
paths never throw while unwinding.

---

## Carrier adapter contract

### Statics

| Static | Default | Notes |
|---|---|---|
| `id` | `'base'` | Used in API, dropdown, session keying |
| `displayName` | `'Base Carrier'` | UI label |
| `supportsSessionReuse` | `true` | False for carriers that invalidate cookies each login |
| `blockStylesheets` | `false` | Opt in only once selectors are proven not to need layout |
| `extraAllow` | `[]` | URL fragments the resource blocker must never drop |
| `usePersistentProfile` | `false` | Required for device-trust to survive |
| `usesProxy` | `true` | False for loopback targets like the demo portal |

### Required overrides

```js
async login(credentials)  // → { mfaRequired, channel?, hint? }
async submitMfa(code)     // → { accepted } | { accepted:false, retryable:true, message? }
async fetchDocuments()    // → [{ name, label, kind, mime, bytes }]
async isSessionValid()    // → boolean   (base returns false rather than throwing)
```

### Shared primitives

| Method | Purpose |
|---|---|
| `raceOutcomes(outcomes, opts)` | Race several possible next screens; returns which won |
| `firstVisible(selectors, opts)` | First visible locator from candidates, or null |
| `typeLikeHuman(locator, text)` | Per-character with jitter — **functional**, not theatre |
| `assertNotBlocked()` | Detect captcha/bot walls and fail with an honest message |
| `exportStorageState()` | For the encrypted session store |
| `get debugState()` | Captured into failure bundles; override and extend |

`ErrorCodes`: `INVALID_CREDENTIALS`, `MFA_REQUIRED_TIMEOUT`, `MFA_REJECTED`, `BOT_WALL`, `CAPTCHA`,
`ACCOUNT_LOCKED`, `NO_DOCUMENTS`, `SELECTOR_DRIFT`, `NAVIGATION`, `TIMEOUT`.

---

## Timing phases

15 distinct phases. `mfa_submit_N` is normalised to `mfa_submit` on record.

| Phase | Emitted by | Notes |
|---|---|---|
| `acquire_context` | pullSession | |
| `warm_validate` | pullSession | warm path only |
| `login` | pullSession | **composite** |
| `nav_login` | adapters | child of `login` |
| `fill_credentials` | adapters | child of `login`; largest machine cost |
| `submit_credentials` | adapters | child of `login` |
| `mfa_wait` | pullSession | **human**, excluded from `machineMs` |
| `mfa_submit` | pullSession | |
| `documents` | pullSession | **composite** |
| `nav_documents` | progressive | child of `documents` |
| `capture_api_auth` | progressive | child of `documents` |
| `list_documents` | progressive | child of `documents`; fast path |
| `list_documents_via_page` | progressive | child of `documents`; fallback (F-19) |
| `document_download` | adapters | child of `documents`; **excludable** |
| `persist_session` | pullSession | |

**Composites overlap their children.** Summing all phases exceeds wall clock — 48,594 ms against
40,158 ms on a real run. Any exclusion arithmetic must subtract leaves only; `npm run test:windows`
enforces this (F-27).

---

## Routes

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/carriers` | Dropdown contents |
| POST | `/api/sessions` | Start a pull → `202 {sessionId, wsUrl}`; rate limited 10/min |
| GET | `/api/sessions/:id` | State, timeline, result |
| GET | `/api/sessions/:id/documents/:docId` | PDF bytes, `no-store` |
| DELETE | `/api/sessions/:id` | Cancel |
| WS | `/api/sessions/:id/stream` | State stream + MFA code inbound |
| GET | `/api/health` | Browser/session stats, egress, config booleans, known gaps |
| GET | `/api/metrics` | Aggregated phase timings; multi-value filters |
| GET | `/api/metrics/raw` | Raw JSONL records |
| GET | `/api/diagnostics` | Index + environment · **guarded** |
| GET | `/api/diagnostics/logs` | Filtered log lines · **guarded** |
| GET | `/api/diagnostics/logs.txt` | Plain-text download · **guarded** |
| GET | `/api/diagnostics/sessions/:id` | Session bundle · **guarded** |
| GET | `/api/diagnostics/failures/:file` | Persisted failure bundle · **guarded** |

Plus `@fastify/static` on `/` and, when `ENABLE_MOCK_CARRIER`, the six `/mock-portal/*` routes.

**Guarded** = `DIAGNOSTICS_TOKEN` bearer or `?token=` (constant-time compare), else loopback only.
Fails closed.

---

## Non-obvious decisions

Each of these looks like it could be simplified. Each is defending against something.

| Decision | Why |
|---|---|
| WebSocket, not SSE | MFA needs a client→server message mid-flow; SSE would need a separate POST and reintroduce correlation |
| Rotating log sink on the main thread, not pino `transport` | A worker-thread sink loses queued lines on abrupt exit — exactly the crashes whose last lines matter |
| Logging owned in-process, not shell redirection | Piping to `tee` works until the process starts differently, and then the log you need does not exist (F-21) |
| `viewport: null`, no user-agent override | Hand-rolled fingerprints create contradictions that are easier to detect than the defaults they replace |
| A `channel` is always named | With no channel, `headless: true` launches `chrome-headless-shell` — a stripped binary reporting `HeadlessChrome` |
| Anti-bot sensor scripts are never blocked | Akamai/Imperva mint the auth token; block the script and the login POST arrives unsigned |
| Stylesheets on by default | Playwright visibility is computed from layout; dropping CSS makes selectors flaky in ways that look like anti-bot |
| Documents in memory, 10-min TTL | They are someone's declarations page: name, address, VIN, premium |
| File store, not Redis | One container, one volume, one fewer thing to deploy; interface is narrow enough to swap |
| JSONL metrics, not a JSON array | O(1) append; a torn line costs one record instead of the whole history |
| `[hidden] { display: none !important }` | `hidden` is a semantic assertion no layout rule should override (F-15) |
| `scrubDeep` skips class instances | Rebuilding them strips prototype getters and silently empties request logs (F-22) |
