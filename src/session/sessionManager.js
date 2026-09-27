import config from '../config.js';
import logger from '../logger.js';
import PullSession from './pullSession.js';

/**
 * Registry of live pull sessions.
 *
 * Exists because a session outlives the HTTP request that created it: it sits
 * blocked on human MFA input, then finishes, and the socket that delivers the
 * code may reconnect in between. So sessions are addressed by id and reaped on
 * a timer rather than being tied to a connection.
 *
 * Bounded on purpose. Every live session holds a browser context, and contexts
 * hold real memory; an unbounded map is how this falls over in production.
 */

const log = logger.child({ module: 'sessionManager' });
const MAX_CONCURRENT = 12;

class SessionManager {
  #sessions = new Map();
  #reaper = null;

  start() {
    if (this.#reaper) return;
    this.#reaper = setInterval(() => this.#reap(), 30_000);
    this.#reaper.unref();
  }

  stop() {
    clearInterval(this.#reaper);
    this.#reaper = null;
  }

  get size() {
    return this.#sessions.size;
  }

  create({ carrierClass, credentials }) {
    if (this.#sessions.size >= MAX_CONCURRENT) {
      // Try to make room from settled-but-not-yet-reaped sessions first.
      this.#reap(true);
      if (this.#sessions.size >= MAX_CONCURRENT) {
        const err = new Error('Server is at capacity. Try again in a moment.');
        err.statusCode = 503;
        throw err;
      }
    }
    const session = new PullSession({ carrierClass, credentials });
    this.#sessions.set(session.id, session);
    log.info({ sessionId: session.id, carrierId: session.carrierId, live: this.#sessions.size }, 'session created');
    return session;
  }

  get(id) {
    return this.#sessions.get(id) ?? null;
  }

  delete(id) {
    const session = this.#sessions.get(id);
    if (!session) return false;
    session.dispose();
    this.#sessions.delete(id);
    return true;
  }

  /**
   * Evict sessions past TTL. Terminal sessions get a short grace window so the
   * client can still fetch the documents it was just told about.
   */
  #reap(aggressive = false) {
    const now = Date.now();
    const graceMs = aggressive ? 0 : 60_000;

    for (const [id, session] of this.#sessions) {
      const age = now - session.createdAt;
      const settled = session.machine.isTerminal;

      if (settled && age > graceMs) {
        this.delete(id);
        continue;
      }
      if (!settled && age > config.SESSION_TTL_MS) {
        log.warn({ sessionId: id, ageMs: age }, 'reaping stalled session');
        session.cancel('Session timed out.');
        this.delete(id);
      }
    }
  }

  async shutdown() {
    this.stop();
    for (const [id, session] of this.#sessions) {
      session.cancel('Server shutting down.');
      this.delete(id);
    }
  }
}

export const sessionManager = new SessionManager();
export default sessionManager;
