/**
 * Short-lived, in-memory credential holder.
 *
 * Portal credentials never touch disk, never enter a log line, and never leave
 * this process. They live in a Buffer so the bytes can be overwritten the
 * moment the login step is done, and the holder is single-use by default.
 *
 * Honest limitation: `reveal()` has to hand Playwright a JS string, and V8
 * strings are immutable and GC-managed, so that copy cannot be forcibly wiped.
 * Zeroing the Buffer shrinks the window, it does not eliminate it. Eliminating
 * it would mean never having the plaintext in this process at all, which the
 * task's "user types their password into our form" flow rules out.
 */

export class CredentialsConsumedError extends Error {
  constructor() {
    super('Credentials already consumed for this session.');
    this.name = 'CredentialsConsumedError';
  }
}

export class CredentialVault {
  #username = null;
  #password = null;
  #destroyed = false;

  constructor({ username, password }) {
    this.#username = Buffer.from(String(username), 'utf8');
    this.#password = Buffer.from(String(password), 'utf8');
  }

  get destroyed() {
    return this.#destroyed;
  }

  /**
   * Yield plaintext to a callback. Scoping it to a callback keeps the plaintext
   * off any long-lived object and gives one obvious place to audit.
   */
  async use(fn) {
    if (this.#destroyed) throw new CredentialsConsumedError();
    return fn({
      username: this.#username.toString('utf8'),
      password: this.#password.toString('utf8'),
    });
  }

  /** Non-secret identity used to key persisted sessions. Never the password. */
  get usernameForKeying() {
    if (this.#destroyed) throw new CredentialsConsumedError();
    return this.#username.toString('utf8');
  }

  /** Overwrite the buffers. Idempotent, safe to call from cleanup paths. */
  destroy() {
    if (this.#destroyed) return;
    this.#username?.fill(0);
    this.#password?.fill(0);
    this.#username = null;
    this.#password = null;
    this.#destroyed = true;
  }

  /** Defensive: make sure a vault can never be serialised into a log or response. */
  toJSON() {
    return { credentials: '[held in memory, not serialisable]' };
  }

  [Symbol.for('nodejs.util.inspect.custom')]() {
    return 'CredentialVault { <redacted> }';
  }
}

export default CredentialVault;
