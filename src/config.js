import 'dotenv/config';
import crypto from 'node:crypto';
import { z } from 'zod';

/**
 * Centralised, validated configuration.
 *
 * Every knob the automation layer needs is declared here so that a
 * misconfigured deployment fails at boot with a readable message rather
 * than halfway through someone's login attempt.
 */

const bool = (def) =>
  z
    .enum(['true', 'false', '1', '0'])
    .default(def)
    .transform((v) => v === 'true' || v === '1');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().default('0.0.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  /**
   * AES-256-GCM key for the persisted storageState. 64 hex chars = 32 bytes.
   * Generated ephemerally when absent, which means persisted sessions become
   * unreadable across restarts. Fine for local dev, flagged loudly in prod.
   */
  SESSION_ENCRYPTION_KEY: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, 'must be 64 hex characters (32 bytes)')
    .optional(),

  /**
   * Residential egress. Carrier portals reject datacenter ASNs, so in
   * production this is effectively mandatory; see README.
   *   e.g. http://user:pass@gate.decodo.com:7000
   */
  RESIDENTIAL_PROXY_URL: z.string().url().optional(),

  /**
   * Sticky-session encoding differs per provider. `{session}` is substituted
   * with a per-session identifier so login -> MFA -> document all egress from
   * one IP.
   *   Decodo    user-session-{session}-sessionduration-10
   *   IPRoyal   user_session-{session}_lifetime-10m
   *   BrightData user-session-{session}
   */
  PROXY_USERNAME_TEMPLATE: z.string().optional(),
  /**
   * Loopback is bypassed by default so the self-hosted demo portal is never
   * routed out through a metered residential proxy and back.
   */
  PROXY_BYPASS: z.string().default('localhost,127.0.0.1,::1'),

  /**
   * Proxy-Cheap **management API** credentials — deliberately not on the request
   * path.
   *
   * These authenticate `api.proxy-cheap.com`, which can order proxies, extend
   * periods and buy bandwidth. That is a credential that spends money, so the
   * serving process must never need it: only `tools/proxy-cheap-*.js` read these,
   * and `npm run doctor` treats their absence as fine.
   *
   * What the browser actually authenticates with lives in
   * `RESIDENTIAL_PROXY_URL`. Keeping the two apart means a compromised
   * deployment leaks proxy access, not billing access.
   */
  PROXYCHEAP_API_KEY: z.string().optional(),
  PROXYCHEAP_API_SECRET: z.string().optional(),

  /**
   * Which kind of proxy product `RESIDENTIAL_PROXY_URL` points at.
   *
   *   dedicated — one fixed exit IP (Proxy-Cheap `RESIDENTIAL_STATIC`, ISP, mobile
   *               with a pinned IP). Stickiness is a property of the product.
   *               `PROXY_USERNAME_TEMPLATE` must stay UNSET: it would rewrite a
   *               username the provider expects verbatim and authentication fails
   *               in a way that looks like an IP block.
   *   rotating  — a gateway hostname fronting a pool. The only way to hold one IP
   *               for a pull is a provider-specific sticky-session username, so
   *               `PROXY_USERNAME_TEMPLATE` is required.
   *
   * Why this is configuration and not detected at runtime: the only reliable source
   * is the provider's management API, and that credential can spend money. The app
   * must not hold it (see `PROXYCHEAP_API_KEY` above). So `npm run proxy:discover`
   * establishes the answer once and writes it here, and the serving process reads a
   * fact instead of either guessing or holding a billing key.
   *
   * Left optional so an unset value means "unknown" rather than a wrong default.
   * Both models have a failure mode the other does not, and picking one silently
   * would guarantee bad advice for half of all users.
   */
  PROXY_MODEL: z.enum(['dedicated', 'rotating']).optional(),

  /** `patchright` is the stealth-patched driver; `playwright` is the escape hatch. */
  BROWSER_DRIVER: z.enum(['patchright', 'playwright']).default('patchright'),
  HEADLESS: bool('true'),
  BROWSER_POOL_SIZE: z.coerce.number().int().min(0).max(8).default(1),
  BLOCK_RESOURCES: bool('true'),

  /** Wall-clock ceilings. Every one of these surfaces as a user-facing ERROR. */
  NAV_TIMEOUT_MS: z.coerce.number().int().default(20_000),
  LOGIN_TIMEOUT_MS: z.coerce.number().int().default(45_000),
  MFA_WAIT_TIMEOUT_MS: z.coerce.number().int().default(180_000),
  DOCUMENT_TIMEOUT_MS: z.coerce.number().int().default(45_000),
  SESSION_TTL_MS: z.coerce.number().int().default(15 * 60_000),

  /** Where encrypted storageState blobs live. Mount a volume here in prod. */
  DATA_DIR: z.string().default('./data'),
  STORAGE_STATE_TTL_MS: z.coerce.number().int().default(12 * 60 * 60_000),

  // -------------------------------------------------------------------------
  // Durable logging
  //
  // Logs are written to disk by the application itself rather than relying on
  // shell redirection, because the thing you most need a log for is the failure
  // you did not anticipate, on a host you cannot attach a terminal to.
  // -------------------------------------------------------------------------
  LOG_DIR: z.string().default('./logs'),
  LOG_TO_FILE: bool('true'),
  /** Rotation. 20MB x 10 keeps roughly a week of moderate traffic. */
  LOG_MAX_BYTES: z.coerce.number().int().default(20 * 1024 * 1024),
  LOG_MAX_FILES: z.coerce.number().int().min(1).max(50).default(10),
  /** HTTP request/response logging. Verbose, but it is what makes a timeline. */
  LOG_REQUESTS: bool('true'),
  /**
   * Automatically write a self-contained diagnostic bundle for every failed run,
   * so a report can be handed over without anyone having to reproduce anything.
   */
  LOG_FAILURE_BUNDLES: bool('true'),
  /**
   * Bearer token guarding the diagnostics endpoints. When unset, those endpoints
   * are reachable only from loopback — see the note in server.js.
   */
  DIAGNOSTICS_TOKEN: z.string().min(16).optional(),

  /** The self-hosted practice portal. Keep on in prod; it is the live demo path. */
  ENABLE_MOCK_CARRIER: bool('true'),

  // -------------------------------------------------------------------------
  // Pre-warming
  //
  // Keeps one anonymous page per carrier parked on the login form, so a cold
  // pull skips the context launch, the navigation, and the SPA's form render —
  // ~8.4s on Progressive. Purely opportunistic: adoption falls back to a normal
  // cold acquire on any doubt.
  // -------------------------------------------------------------------------
  PREWARM_ENABLED: bool('true'),
  /**
   * How long a parked page stays adoptable.
   *
   * Bounded because carriers mint per-load tokens — Progressive issues a
   * PingFederate `flowId` per login-page load — and submitting credentials
   * against an expired one fails *after* the user has typed, which is worse than
   * not pre-warming. Two minutes is comfortably inside observed flow lifetimes
   * while still covering the gap between a user opening the page and submitting.
   */
  PREWARM_TTL_MS: z.coerce.number().int().min(15_000).max(900_000).default(120_000),
  /**
   * Navigation ceiling for background pre-warming.
   *
   * Separate from NAV_TIMEOUT_MS because nobody is waiting on this load. A 20s
   * ceiling was observed timing out against Progressive, which silently
   * forfeited the optimisation and made the next real user pay full price.
   */
  PREWARM_TIMEOUT_MS: z.coerce.number().int().min(5_000).max(120_000).default(45_000),

  // -------------------------------------------------------------------------
  // Which document to retrieve
  //
  // Carriers file many documents per policy — this test account has 40 and 43 —
  // and "the policy document" is genuinely ambiguous between the contract (the
  // terms), the declarations page (the coverage summary) and ID cards. Rather
  // than hardcode one interpretation, the target maps onto the carrier's own
  // document-category taxonomy, which is the same thing the portal's
  // "Filter view:" dropdown uses.
  // -------------------------------------------------------------------------
  /**
   * Per-character typing delay, in ms.
   *
   * This exists for a functional reason, not a stealth one: portals bind
   * validation to `input`/`keyup`, and a value set in one shot leaves the submit
   * button disabled. Any non-zero delay satisfies that.
   *
   * It was 24-92ms (~58ms average), which across a username, a password and a
   * six-digit code cost roughly 1.4s of an 8s budget — the largest controllable
   * slice of the machine path. Lowered to 10-35ms (~22ms average), still well
   * above the "populated within one event-loop tick" threshold that naive
   * behavioural checks look for. Raise it if a carrier proves sensitive; there is
   * no evidence any of these are.
   */
  TYPE_MIN_DELAY_MS: z.coerce.number().int().min(0).max(500).default(10),
  TYPE_MAX_DELAY_MS: z.coerce.number().int().min(1).max(1000).default(35),

  DOCUMENT_TARGET: z.enum(['contract', 'declarations', 'idcard']).default('contract'),
  /**
   * How many documents to return. Default 1: returning a handful of same-titled
   * PDFs and letting the user work out which is which is not an answer.
   */
  DOCUMENT_LIMIT: z.coerce.number().int().min(1).max(10).default(1),

  /**
   * Which 2-Step Verification channel to request from GEICO.
   *
   * GEICO asks how to send the code on *every* login and offers no
   * trusted-device option (F-33), so this choice is made on every pull. Auto
   * -selecting from config rather than surfacing a second modal is a deliberate
   * simplification: the flow already carries one unavoidable human round-trip,
   * and a second doubles the places it can stall waiting on a person.
   *
   * The tradeoff is real and fails closed. If the policy has only an email on
   * file and this is set to `sms`, the adapter reports which methods GEICO
   * actually offered instead of timing out on a code field that never appears.
   *
   * GEICO-specific and named so. Progressive sends its SMS without asking.
   */
  GEICO_MFA_METHOD: z.enum(['sms', 'email']).default('sms'),
});

/**
 * Treat an empty env var as absent.
 *
 * `.env.example` ships keys with empty values as documentation, and a copied
 * `.env` therefore yields `RESIDENTIAL_PROXY_URL=''`. An empty string is not a
 * valid URL, so without this the app refuses to boot on the exact path every
 * new user takes.
 */
const present = Object.fromEntries(
  Object.entries(process.env).filter(([, v]) => v !== undefined && String(v).trim() !== '')
);

const parsed = schema.safeParse(present);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
    .join('\n');
  // eslint-disable-next-line no-console
  console.error(`Invalid configuration:\n${issues}`);
  process.exit(1);
}

const env = parsed.data;

const warnings = [];

let sessionKey;
if (env.SESSION_ENCRYPTION_KEY) {
  sessionKey = Buffer.from(env.SESSION_ENCRYPTION_KEY, 'hex');
} else if (env.NODE_ENV === 'production') {
  /**
   * Hard failure in production, not a warning.
   *
   * An ephemeral key was tolerable when the only consequence was "warm sessions do not
   * survive a restart" — a latency regression. It is worse than that now.
   *
   * Saved `storageState` also carries the carrier's **trusted-device** cookie, and for
   * GEICO that is what lets a login skip the 2SV challenge (F-44). An unreadable store
   * means every deploy silently reverts every user to a full human MFA round-trip —
   * 12-24s of someone's attention, on every pull, with nothing in the logs connecting
   * it to a missing variable.
   *
   * A warning is the wrong instrument for that. Warnings are read once during setup and
   * never again, and this fault produces no error: sessions simply never rehydrate.
   * Failing at boot makes it impossible to deploy into that state by accident.
   *
   * Development still gets an ephemeral key — requiring a secret to run the demo portal
   * would be a setup obstacle for no security gain.
   */
  throw new Error(
    'SESSION_ENCRYPTION_KEY is required when NODE_ENV=production.\n\n'
      + 'Saved sessions are encrypted with it, and they carry the carrier trusted-device\n'
      + 'cookie that lets a login skip MFA. Without a stable key the store is unreadable\n'
      + 'after every restart, so every pull silently costs a human MFA round-trip.\n\n'
      + 'Generate one:\n'
      + '  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"\n\n'
      /**
       * Platform-neutral remediation, deliberately.
       *
       * This used to say `fly secrets set …`. That was wrong twice over: the project is
       * AWS-only, and the current target is a Windows EC2 instance where `fly` does not
       * exist. A hard-fail message is read by someone who is already stuck, so a command
       * that cannot work is worse than no command — it sends them to install a CLI for a
       * platform they are not using.
       */
      /**
       * Self-contained on purpose. This used to point at a file in `docs/`, which is not
       * published in the repository — so for anyone working from a clone it named
       * something they do not have. A hard-fail message is read by someone already
       * stuck; every line of it has to stand on its own.
       */
      + 'Then make it available to the process:\n'
      + '  - put it in .env (simplest, works everywhere)\n'
      + '  - or set it as an environment variable before starting\n'
      + '  - on AWS: store it in Secrets Manager and write it into .env at boot, so it\n'
      + '    is not baked into an image or an instance'
  );
} else {
  sessionKey = crypto.randomBytes(32);
  warnings.push(
    'SESSION_ENCRYPTION_KEY not set; generated an ephemeral key. Persisted sessions will not '
      + 'survive a restart, so every run takes the cold path and pays a full MFA round-trip. '
      + 'Fine for the demo portal; set a key before testing a real carrier more than once.'
  );
}

if (env.NODE_ENV === 'production' && !env.RESIDENTIAL_PROXY_URL) {
  warnings.push(
    'RESIDENTIAL_PROXY_URL not set in production. Carrier portals routinely block datacenter IP ranges; real-carrier logins are expected to fail.'
  );
}

if (env.PROXY_USERNAME_TEMPLATE && !env.PROXY_USERNAME_TEMPLATE.includes('{session}')) {
  warnings.push(
    'PROXY_USERNAME_TEMPLATE has no {session} placeholder, so proxy sessions will not be sticky. Login and document fetch may egress from different IPs.'
  );
}
/**
 * Warn on the template/model combinations that are actively wrong.
 *
 * The two mistakes are opposite, which is why the model has to be known before either
 * can be diagnosed. Warning unconditionally about a missing template — as this file
 * used to, in effect, by treating "no template" as the only risk — is wrong advice on
 * a dedicated IP, where setting one is the defect.
 */
if (env.RESIDENTIAL_PROXY_URL && env.PROXY_MODEL === 'dedicated' && env.PROXY_USERNAME_TEMPLATE) {
  warnings.push(
    'PROXY_MODEL=dedicated but PROXY_USERNAME_TEMPLATE is set. A dedicated exit IP has no session concept; the template rewrites a username the provider expects verbatim, so authentication will fail and will look like a blocked IP. Unset it.'
  );
}
if (env.RESIDENTIAL_PROXY_URL && env.PROXY_MODEL === 'rotating' && !env.PROXY_USERNAME_TEMPLATE) {
  warnings.push(
    'PROXY_MODEL=rotating but no PROXY_USERNAME_TEMPLATE is set. Every connection may exit from a different IP, so login, MFA and document fetch can each leave from a different address and the carrier will invalidate the session.'
  );
}
if (env.RESIDENTIAL_PROXY_URL && !env.PROXY_MODEL) {
  warnings.push(
    'PROXY_MODEL is not set, so whether PROXY_USERNAME_TEMPLATE should be set cannot be checked. Run `npm run proxy:discover` to determine it.'
  );
}

export const config = Object.freeze({
  ...env,
  sessionEncryptionKey: sessionKey,
  isProd: env.NODE_ENV === 'production',
  warnings,
});

export default config;
