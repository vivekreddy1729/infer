import config from '../config.js';
import { BaseCarrier, CarrierError, ErrorCodes, MfaChannel } from './baseCarrier.js';

/**
 * Adapter for the self-hosted demo portal.
 *
 * Reference implementation of the BaseCarrier contract. Every technique the
 * real adapters use appears here in a form that can be run and debugged without
 * credentials: outcome racing after submit, per-character typing to satisfy an
 * input-gated button, retryable MFA, link scraping, and cookie-sharing document
 * download.
 */
export class MockCarrier extends BaseCarrier {
  static id = 'demo';
  static displayName = 'Demo Mutual (practice portal)';
  static supportsSessionReuse = true;

  /**
   * The demo portal is this same process. Sending loopback traffic out through a
   * residential proxy would fail, and paying metered proxy bandwidth to talk to
   * ourselves would be pointless.
   */
  static usesProxy = false;
  static usePersistentProfile = false;

  /** Layout-independent selectors, so dropping CSS is safe and saves a request. */
  static blockStylesheets = true;

  get baseUrl() {
    return `http://127.0.0.1:${config.PORT}/mock-portal`;
  }

  async login(credentials) {
    const { page } = this;

    await this.timings.measure('nav_login', async () => {
      await page.goto(`${this.baseUrl}/login`, { waitUntil: 'domcontentloaded' });
    });
    await this.assertNotBlocked();

    const user = await this.firstVisible(['#u', 'input[name="username"]']);
    const pass = await this.firstVisible(['#p', 'input[name="password"]']);
    if (!user || !pass) {
      throw new CarrierError('Login form not found on demo portal', {
        code: ErrorCodes.SELECTOR_DRIFT,
        userMessage: 'Could not find the sign-in form.',
      });
    }

    await this.timings.measure('fill_credentials', async () => {
      // Per-character: the portal keeps submit disabled until `input` fires.
      await this.typeLikeHuman(user, credentials.username);
      await this.typeLikeHuman(pass, credentials.password);
    });

    this.notify('Submitting credentials…');
    await this.timings.measure('submit_credentials', async () => {
      await page.locator('form button[type="submit"]').click();
    });

    /**
     * Race every branch rather than assuming success. Sequentially waiting for
     * the OTP field would make a rejected password cost a full timeout and then
     * report "OTP field missing", which is the wrong diagnosis.
     */
    const { outcome, elapsedMs } = await this.raceOutcomes(
      {
        mfa: '#c, input[name="code"]',
        badCredentials: '#login-error',
        authenticated: '#documents-table',
      },
      { timeout: config.LOGIN_TIMEOUT_MS }
    );
    this.log.info({ outcome, elapsedMs }, 'login outcome');

    if (outcome === 'badCredentials') {
      // Deliberately does not echo the expected credentials. They are public and
      // documented in the README, but error messages end up in log files that get
      // shared, and a password-shaped literal in a log is a bad habit regardless
      // of whether that particular secret matters.
      throw new CarrierError('Demo portal rejected credentials', {
        code: ErrorCodes.INVALID_CREDENTIALS,
        userMessage:
          'Incorrect email or password for the practice portal. The expected values are in the README.',
      });
    }

    if (outcome === 'authenticated') {
      // Warm path: a rehydrated session skipped the challenge entirely.
      return { mfaRequired: false };
    }

    return {
      mfaRequired: true,
      channel: MfaChannel.SMS,
      hint: 'phone ending in •• 47',
      // Demo affordance only. The portal's own session cookie identifies which
      // generated code belongs to this run, so a live walkthrough does not need
      // a real phone. Read from the browser's cookie jar, so it is race-free
      // even with concurrent demo sessions. Real adapters never set this.
      demoCode: await this.#lookupDemoCode(),
    };
  }

  async #lookupDemoCode() {
    try {
      const cookies = await this.context.cookies();
      const sid = cookies.find((c) => c.name === 'mock_pending')?.value;
      if (!sid) return undefined;
      const { mockCodeEvents } = await import('../mockPortal/routes.js');
      return mockCodeEvents.get(sid)?.code;
    } catch {
      return undefined;
    }
  }

  async submitMfa(code) {
    const { page } = this;

    const field = await this.firstVisible(['#c', 'input[name="code"]']);
    if (!field) {
      throw new CarrierError('Verification field missing', {
        code: ErrorCodes.SELECTOR_DRIFT,
        userMessage: 'The verification step is no longer on screen. Please start over.',
      });
    }

    await field.fill('');
    await this.typeLikeHuman(field, code);
    await page.locator('form button[type="submit"]').click();

    const { outcome } = await this.raceOutcomes(
      {
        authenticated: '#documents-table',
        rejected: '#otp-error',
        locked: 'text=Too many attempts',
      },
      { timeout: config.LOGIN_TIMEOUT_MS }
    );

    if (outcome === 'rejected') {
      // Retryable: the state machine loops back to MFA_REQUIRED.
      return { accepted: false, retryable: true, message: "That code wasn't right. Try again." };
    }
    if (outcome === 'locked') {
      throw new CarrierError('Demo portal locked the session', {
        code: ErrorCodes.ACCOUNT_LOCKED,
        userMessage: 'Too many incorrect codes. Please start a new session.',
      });
    }
    return { accepted: true };
  }

  async fetchDocuments() {
    const { page, context } = this;

    if (!page.url().includes('/documents')) {
      await page.goto(`${this.baseUrl}/documents`, { waitUntil: 'domcontentloaded' });
    }
    await page.waitForSelector('#documents-table', { timeout: config.DOCUMENT_TIMEOUT_MS });

    const links = await page.locator('a.doc-link').evaluateAll((nodes) =>
      nodes.map((n) => ({
        href: n.href,
        kind: n.dataset.kind ?? 'document',
        label: n.closest('tr')?.querySelector('td')?.innerText?.split('\n')[0]?.trim() ?? 'Document',
      }))
    );

    if (links.length === 0) {
      throw new CarrierError('No document links found', {
        code: ErrorCodes.NO_DOCUMENTS,
        userMessage: 'Signed in, but no policy documents were listed on the account.',
      });
    }

    this.notify(`Found ${links.length} document${links.length === 1 ? '' : 's'}. Downloading…`);

    /**
     * Fetch via the context's request API rather than clicking each link.
     *
     * `context.request` shares the browser's cookie jar and TLS session, so the
     * carrier sees the same authenticated client, but it skips renderer work,
     * download-manager plumbing and temp-file I/O entirely. It also parallelises
     * cleanly. This is consistently the largest single latency win in the
     * document phase.
     */
    /**
     * Timed as `document_download`, matching the real adapters so the metrics
     * page can exclude transfer time consistently across carriers.
     *
     * One phase for the whole batch rather than one per document: `Timings` keys
     * in-flight marks by phase name, so concurrent `measure()` calls sharing a
     * name would collide, and a per-document metric would not be comparable
     * between accounts holding different numbers of documents anyway.
     */
    const documents = await this.timings.measure('document_download', () =>
      Promise.all(
        links.map(async (link) => {
          const res = await context.request.get(link.href, {
            timeout: config.DOCUMENT_TIMEOUT_MS,
          });
          if (!res.ok()) {
            throw new CarrierError(`Document fetch failed: HTTP ${res.status()}`, {
              code: ErrorCodes.NO_DOCUMENTS,
              userMessage: 'The carrier returned an error when downloading the document.',
            });
          }
          const bytes = await res.body();
          return {
            name: `${link.label.replace(/[^\w -]+/g, '')}.pdf`,
            label: link.label,
            kind: link.kind,
            mime: res.headers()['content-type']?.split(';')[0] ?? 'application/pdf',
            bytes,
          };
        })
      )
    );

    return documents;
  }

  async isSessionValid() {
    try {
      await this.page.goto(`${this.baseUrl}/documents`, {
        waitUntil: 'domcontentloaded',
        timeout: config.NAV_TIMEOUT_MS,
      });
      // The portal redirects to /login when the cookie is missing or stale.
      return this.page.url().includes('/documents');
    } catch {
      return false;
    }
  }
}

export default MockCarrier;
