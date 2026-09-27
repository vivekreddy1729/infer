import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import config from '../config.js';
import logger from '../logger.js';

/**
 * Encrypted persistence for Playwright `storageState` (cookies + localStorage).
 *
 * This is the single biggest latency win in the system. A cold login is a page
 * load, a credential POST, an MFA round-trip through a human, and a redirect
 * chain. A warm login is none of those: hydrate the context from a saved state
 * and navigate straight to the documents page.
 *
 * The contents are live session cookies for someone's insurance account, which
 * is a credential-equivalent. So: AES-256-GCM, filename is an HMAC rather than
 * the username, and 0600 on disk.
 *
 * Deliberately a file store and not Redis. One container, one volume, one fewer
 * moving part to deploy. The interface is narrow enough that swapping in Redis
 * later is a contained change.
 */

const ALGO = 'aes-256-gcm';
const VERSION = 1;
const log = logger.child({ module: 'storageStateStore' });

/**
 * Derive a filename without leaking identity. HMAC (keyed) rather than a bare
 * hash, so a stolen directory listing cannot be dictionary-attacked back to
 * usernames.
 */
function keyFor(carrierId, username) {
  const mac = crypto
    .createHmac('sha256', config.sessionEncryptionKey)
    .update(`${carrierId}\u0000${username.trim().toLowerCase()}`)
    .digest('hex');
  return `${carrierId}.${mac.slice(0, 32)}.enc`;
}

export class StorageStateStore {
  /**
   * In-flight saves, keyed by target path.
   *
   * Exists to close a race created by moving session persistence off the
   * critical path (OPTIMISATION-LOG O-7). That change was correct — a save
   * benefits *future* runs and should not be on the path the current user waits
   * on — but it had a consequence nobody looked for: the client is told
   * `COMPLETED` while the save is still in flight, so a pull started immediately
   * afterwards reads the store before the previous one has written to it and
   * takes a needless cold path, MFA round-trip and all.
   *
   * `load()` awaits any pending save for the same key. The waiting is therefore
   * paid only by a caller who would otherwise have read a stale or missing file,
   * which is exactly when waiting is the right answer. The first pull's
   * user-facing path is still never blocked, so O-7's benefit is retained.
   *
   * Scope, stated honestly: this is per-process. Two containers writing the same
   * volume would still race, and the write-then-rename below is what keeps that
   * case merely slow rather than corrupting.
   */
  #inFlight = new Map();

  constructor({ dir = config.DATA_DIR, ttlMs = config.STORAGE_STATE_TTL_MS } = {}) {
    this.dir = path.resolve(dir, 'sessions');
    this.ttlMs = ttlMs;
  }

  async init() {
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 });
  }

  #pathFor(carrierId, username) {
    return path.join(this.dir, keyFor(carrierId, username));
  }

  /**
   * Publish the save as in-flight before awaiting it, so a concurrent `load()`
   * can wait on it. Registration must happen synchronously relative to the
   * caller — doing it inside the async body would leave a window where the save
   * has started but is not yet discoverable, which is the bug being fixed.
   */
  save(carrierId, username, storageState) {
    return this.reserve(carrierId, username, () => storageState);
  }

  /**
   * Reserve the key *before* the state exists, then produce it and save it.
   *
   * ------------------------------------------------------------------------
   * WHY `save()` ALONE WAS NOT ENOUGH
   * ------------------------------------------------------------------------
   * `#inFlight` closes the read-during-write race only from the moment `save()` is
   * called — and a caller cannot call it until it is holding the state, which on a real
   * carrier means a round-trip into the browser to export cookies. Everything before
   * that is still an open window.
   *
   * That window is not theoretical. Measured on the demo suite:
   *
   *     12:14:00.610  session created            <- second pull starts
   *     12:14:00.615  persisted carrier session  <- first pull's save lands, 5ms later
   *
   * The second pull read the store 5ms early, found the file absent (the expired one
   * had just been cleared), logged nothing because `ENOENT` is the silent path, and
   * took a full cold login including a human MFA round-trip. The guard was in place and
   * did not fire, because `#inFlight` was still empty. See ENGINEERING-LOG F-50.
   *
   * So the reservation has to happen where the *intent* to save is formed, not where
   * the bytes arrive. `produceState` runs inside the reserved slot, so a concurrent
   * `load()` waits for the export as well as the write — which is the whole window
   * rather than its tail end.
   *
   * The caller is still never blocked: this returns a promise nobody has to await, and
   * the waiting is paid only by a `load()` that would otherwise have read the gap.
   */
  reserve(carrierId, username, produceState) {
    const target = this.#pathFor(carrierId, username);
    const pending = (async () => {
      const state = await produceState();
      return this.#doSave(carrierId, username, state, target);
    })().finally(() => {
      // Only clear our own entry; a later save for the same key owns it now.
      if (this.#inFlight.get(target) === pending) this.#inFlight.delete(target);
    });
    this.#inFlight.set(target, pending);
    return pending;
  }

  async #doSave(carrierId, username, storageState, target) {
    try {
      await this.init();
      const plaintext = Buffer.from(JSON.stringify(storageState), 'utf8');
      const iv = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv(ALGO, config.sessionEncryptionKey, iv);
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      const envelope = {
        v: VERSION,
        carrierId,
        savedAt: Date.now(),
        iv: iv.toString('base64'),
        tag: cipher.getAuthTag().toString('base64'),
        data: ciphertext.toString('base64'),
      };
      // Write-then-rename so a crash mid-write cannot leave a truncated session.
      const tmp = `${target}.${process.pid}.tmp`;
      await fs.writeFile(tmp, JSON.stringify(envelope), { mode: 0o600 });
      await fs.rename(tmp, target);
      log.info({ carrierId }, 'persisted carrier session');
      return true;
    } catch (err) {
      // A failed save costs a slow next run, nothing more. Never fatal.
      log.warn({ carrierId, err: err.message }, 'could not persist carrier session');
      return false;
    }
  }

  /** Returns `storageState` or null when absent, expired, or unreadable. */
  async load(carrierId, username) {
    const target = this.#pathFor(carrierId, username);

    /**
     * Wait for a save to this key that is still in flight.
     *
     * Without this, a pull started the instant the previous one reported
     * COMPLETED reads the store during the window between the old session being
     * cleared and the new one being written, finds nothing, and takes a full cold
     * path — a second login and a second MFA round-trip that were both avoidable.
     * See the note on `#inFlight`.
     */
    const pending = this.#inFlight.get(target);
    if (pending) {
      log.info({ carrierId }, 'waiting for an in-flight session save before reading');
      await pending.catch(() => {});
    }

    try {
      const envelope = JSON.parse(await fs.readFile(target, 'utf8'));
      if (envelope.v !== VERSION) return null;

      const ageMs = Date.now() - envelope.savedAt;
      if (ageMs > this.ttlMs) {
        log.info({ carrierId, ageMs }, 'persisted session expired, discarding');
        await this.clear(carrierId, username);
        return null;
      }

      const decipher = crypto.createDecipheriv(
        ALGO,
        config.sessionEncryptionKey,
        Buffer.from(envelope.iv, 'base64')
      );
      decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
      const plaintext = Buffer.concat([
        decipher.update(Buffer.from(envelope.data, 'base64')),
        decipher.final(),
      ]);
      log.info({ carrierId, ageMs }, 'rehydrating persisted carrier session');
      return { storageState: JSON.parse(plaintext.toString('utf8')), ageMs };
    } catch (err) {
      if (err.code !== 'ENOENT') {
        // Most likely cause: SESSION_ENCRYPTION_KEY changed between restarts.
        log.warn({ carrierId, err: err.message }, 'persisted session unreadable, ignoring');
      }
      return null;
    }
  }

  async clear(carrierId, username) {
    try {
      await fs.unlink(this.#pathFor(carrierId, username));
      return true;
    } catch {
      return false;
    }
  }
}

export const storageStateStore = new StorageStateStore();
export default storageStateStore;
