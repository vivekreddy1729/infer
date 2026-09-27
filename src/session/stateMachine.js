import { EventEmitter } from 'node:events';

/**
 * Session lifecycle state machine.
 *
 * Transitions are whitelisted explicitly. An illegal transition throws rather
 * than silently corrupting session state, because the failure mode we care
 * about most is a browser context that the machine believes is logged in when
 * it is actually sitting on a captcha wall.
 */

export const States = Object.freeze({
  INIT: 'INIT',
  AUTHENTICATING: 'AUTHENTICATING',
  MFA_REQUIRED: 'MFA_REQUIRED',
  MFA_SUBMITTED: 'MFA_SUBMITTED',
  EXTRACTING_DOCS: 'EXTRACTING_DOCS',
  COMPLETED: 'COMPLETED',
  ERROR: 'ERROR',
});

/**
 * Two edges here are worth calling out because they are easy to miss:
 *
 *  AUTHENTICATING -> EXTRACTING_DOCS
 *    The warm path. A rehydrated storageState skips MFA entirely; this is the
 *    edge that makes repeat runs fast.
 *
 *  MFA_SUBMITTED -> MFA_REQUIRED
 *    The user fat-fingered the code. Carriers allow retries, so the machine
 *    has to as well instead of dumping the whole session into ERROR.
 */
const TRANSITIONS = Object.freeze({
  [States.INIT]: [States.AUTHENTICATING, States.ERROR],
  [States.AUTHENTICATING]: [States.MFA_REQUIRED, States.EXTRACTING_DOCS, States.ERROR],
  [States.MFA_REQUIRED]: [States.MFA_SUBMITTED, States.ERROR],
  [States.MFA_SUBMITTED]: [States.EXTRACTING_DOCS, States.MFA_REQUIRED, States.ERROR],
  [States.EXTRACTING_DOCS]: [States.COMPLETED, States.ERROR],
  [States.COMPLETED]: [],
  [States.ERROR]: [],
});

export const TERMINAL_STATES = Object.freeze([States.COMPLETED, States.ERROR]);

/** Human-readable copy surfaced directly in the UI status stream. */
const DEFAULT_MESSAGES = Object.freeze({
  [States.INIT]: 'Session created.',
  [States.AUTHENTICATING]: 'Opening carrier portal and signing in…',
  [States.MFA_REQUIRED]: 'Carrier sent a verification code. Enter it to continue.',
  [States.MFA_SUBMITTED]: 'Submitting verification code…',
  [States.EXTRACTING_DOCS]: 'Signed in. Locating policy documents…',
  [States.COMPLETED]: 'Documents retrieved.',
  [States.ERROR]: 'Something went wrong.',
});

export class IllegalTransitionError extends Error {
  constructor(from, to) {
    super(`Illegal state transition: ${from} -> ${to}`);
    this.name = 'IllegalTransitionError';
    this.from = from;
    this.to = to;
  }
}

export class SessionStateMachine extends EventEmitter {
  #state = States.INIT;
  #timeline = [];
  #startedAt = Date.now();

  constructor({ sessionId, carrierId }) {
    super();
    this.sessionId = sessionId;
    this.carrierId = carrierId;
    this.#record(States.INIT, DEFAULT_MESSAGES[States.INIT], {});
  }

  get state() {
    return this.#state;
  }

  get isTerminal() {
    return TERMINAL_STATES.includes(this.#state);
  }

  /** Ordered list of `{ state, message, at, elapsedMs }` for this session. */
  get timeline() {
    return [...this.#timeline];
  }

  get elapsedMs() {
    return Date.now() - this.#startedAt;
  }

  canTransitionTo(next) {
    return (TRANSITIONS[this.#state] ?? []).includes(next);
  }

  /**
   * Move to `next`, emitting a `transition` event the transport layer forwards
   * to the browser. `detail` carries state-specific payload: the MFA channel
   * hint, the document list, the error code.
   */
  transition(next, { message, ...detail } = {}) {
    if (!this.canTransitionTo(next)) {
      throw new IllegalTransitionError(this.#state, next);
    }
    const previous = this.#state;
    this.#state = next;
    const entry = this.#record(next, message ?? DEFAULT_MESSAGES[next], detail);

    this.emit('transition', { ...entry, previous });
    this.emit(next, entry);
    if (this.isTerminal) this.emit('settled', entry);
    return entry;
  }

  /**
   * Terminal failure. Safe to call from any state, including a state that has
   * no legal edge to ERROR, so that cleanup paths never throw while unwinding.
   */
  fail(error, { code = 'UNKNOWN', message } = {}) {
    if (this.isTerminal) return null;
    const userMessage = message ?? error?.userMessage ?? DEFAULT_MESSAGES[States.ERROR];
    if (!this.canTransitionTo(States.ERROR)) {
      this.#state = States.ERROR;
      const entry = this.#record(States.ERROR, userMessage, { code });
      this.emit('transition', entry);
      this.emit('settled', entry);
      return entry;
    }
    return this.transition(States.ERROR, { message: userMessage, code });
  }

  /** Progress note that does not change state, e.g. "found 3 documents". */
  /**
   * Add a progress line.
   *
   * ------------------------------------------------------------------------
   * `internal: true` — kept in the timeline, withheld from the UI
   * ------------------------------------------------------------------------
   * Two audiences read these notes and they want different things.
   *
   * A **user** wants a story they can follow: opening the portal, signing in, waiting
   * for a code, found the document. Lines like "Reusing a pre-opened carrier tab,
   * skipping page load" describe a latency optimisation they did not ask about and
   * cannot act on. Worse, it reads like something went sideways — "reusing" and
   * "skipping" both sound like corner-cutting when they are the opposite.
   *
   * An **operator** wants exactly that line. Pre-warm adoption has been confirmed from
   * it repeatedly while debugging, and deleting it would remove the only evidence that
   * the optimisation fired at all.
   *
   * So internal notes stay in the timeline — which means they still reach the logs, the
   * failure bundle and `/api/sessions/:id`, all of which an operator reads — and are
   * simply not emitted to the live UI stream. One call site, one flag, both audiences
   * served, and no duplicated messaging to drift apart.
   */
  note(message, detail = {}, { internal = false } = {}) {
    const entry = {
      state: this.#state,
      message,
      at: Date.now(),
      elapsedMs: this.elapsedMs,
      detail,
      note: true,
      internal,
    };
    this.#timeline.push(entry);
    // Withheld from the live stream only. Still in the timeline for diagnostics.
    if (!internal) this.emit('note', entry);
    return entry;
  }

  #record(state, message, detail) {
    const entry = {
      state,
      message,
      at: Date.now(),
      elapsedMs: this.elapsedMs,
      detail,
    };
    this.#timeline.push(entry);
    return entry;
  }
}

export default SessionStateMachine;
