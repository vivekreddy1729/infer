import fs from 'node:fs';
import path from 'node:path';

/**
 * Size-based rotating file sink for pino.
 *
 * Hand-rolled rather than using a transport package, for one specific reason:
 * pino's `transport` option runs the sink in a **worker thread**, and on an
 * abrupt exit — an uncaught exception, an OOM kill, a `SIGKILL` from a container
 * runtime — log lines still queued for that worker are lost. Those are precisely
 * the crashes whose final few lines matter most.
 *
 * This writes on the main thread through an append-mode stream, so a line that
 * has been handed to the OS survives the process dying immediately afterwards.
 * The cost is that a very high log rate could add backpressure to the event loop.
 * For a service whose throughput ceiling is a dozen concurrent browser sessions,
 * that is a trade worth making in favour of not losing the crash.
 *
 * Rotation is `app.log` -> `app.log.1` -> `app.log.2` ... up to `maxFiles`, with
 * the oldest discarded. Deliberately not time-based: "the last N megabytes" is
 * what you want when chasing a failure, whereas daily files leave you guessing
 * which day, and produce empty files on idle days.
 */
export class RotatingFileStream {
  #stream = null;
  #bytes = 0;
  #rotating = false;
  #pending = [];

  constructor({ dir, filename = 'app.log', maxBytes = 20 * 1024 * 1024, maxFiles = 10 }) {
    this.dir = path.resolve(dir);
    this.filename = filename;
    this.maxBytes = maxBytes;
    this.maxFiles = maxFiles;
    this.filePath = path.join(this.dir, this.filename);
    this.#open();
  }

  #open() {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    // Pick up the existing size so a restart does not reset the rotation clock
    // and let the file grow without bound.
    try {
      this.#bytes = fs.statSync(this.filePath).size;
    } catch {
      this.#bytes = 0;
    }
    this.#stream = fs.createWriteStream(this.filePath, { flags: 'a', mode: 0o600 });
    // A logging failure must never take down the process it is observing.
    this.#stream.on('error', () => {});
  }

  /**
   * Called by pino for every line. Must not throw.
   */
  write(chunk) {
    const size = Buffer.byteLength(chunk);

    if (this.#rotating) {
      // Hold lines emitted mid-rotation rather than dropping them or writing
      // them to a file that is about to be renamed out from under us.
      this.#pending.push(chunk);
      return true;
    }

    if (this.#bytes + size > this.maxBytes) {
      this.#rotate();
      this.#pending.push(chunk);
      return true;
    }

    this.#bytes += size;
    try {
      return this.#stream.write(chunk);
    } catch {
      return true;
    }
  }

  #rotate() {
    this.#rotating = true;
    const finish = () => {
      try {
        // Shift the numbered generations up, dropping the oldest.
        const oldest = `${this.filePath}.${this.maxFiles}`;
        if (fs.existsSync(oldest)) fs.rmSync(oldest, { force: true });
        for (let i = this.maxFiles - 1; i >= 1; i -= 1) {
          const from = `${this.filePath}.${i}`;
          if (fs.existsSync(from)) fs.renameSync(from, `${this.filePath}.${i + 1}`);
        }
        if (fs.existsSync(this.filePath)) fs.renameSync(this.filePath, `${this.filePath}.1`);
      } catch {
        // If rotation fails, keep logging to the current file rather than
        // silently stopping. An oversized log beats no log.
      }

      this.#open();
      this.#rotating = false;

      const queued = this.#pending;
      this.#pending = [];
      for (const line of queued) this.write(line);
    };

    try {
      this.#stream.end(finish);
    } catch {
      finish();
    }
  }

  /** Flush and close. Called on shutdown so the last lines are not lost. */
  async close() {
    await new Promise((resolve) => {
      try {
        this.#stream.end(resolve);
      } catch {
        resolve();
      }
    });
  }

  /** Newest-first list of log files, for the diagnostics reader. */
  files() {
    const out = [];
    if (fs.existsSync(this.filePath)) out.push(this.filePath);
    for (let i = 1; i <= this.maxFiles; i += 1) {
      const p = `${this.filePath}.${i}`;
      if (fs.existsSync(p)) out.push(p);
    }
    return out;
  }

  stats() {
    return this.files().map((p) => {
      let size = 0;
      let mtime = null;
      try {
        const st = fs.statSync(p);
        size = st.size;
        mtime = st.mtimeMs;
      } catch {
        /* ignore */
      }
      return { file: path.basename(p), bytes: size, modifiedAt: mtime };
    });
  }
}

export default RotatingFileStream;
