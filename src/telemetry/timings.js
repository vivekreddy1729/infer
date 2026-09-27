/**
 * Per-phase latency instrumentation.
 *
 * The brief asks for "under 8 seconds from login to document render". Taken
 * literally that is unmeasurable, because the flow contains a mandatory human
 * step: nobody controls how long someone takes to read an SMS and type six
 * digits. So this tracks two clocks.
 *
 *   wallMs    -- everything, including the human.
 *   machineMs -- wallMs minus phases marked `human: true`.
 *
 * `machineMs` is the number the 8s budget is measured against, and the README
 * reports both so the claim is auditable rather than flattering.
 */

/** Phases that represent waiting on a person, excluded from the machine clock. */
export const HUMAN_PHASES = Object.freeze(['mfa_wait']);

export class Timings {
  #marks = new Map();
  #completed = [];
  #start = performance.now();

  constructor(labels = {}) {
    this.labels = labels;
  }

  start(phase) {
    this.#marks.set(phase, performance.now());
    return phase;
  }

  /** Close a phase and return its duration in ms. Unknown phases return null. */
  end(phase) {
    const started = this.#marks.get(phase);
    if (started === undefined) return null;
    this.#marks.delete(phase);
    const durationMs = performance.now() - started;
    this.#completed.push({
      phase,
      durationMs: Math.round(durationMs),
      human: HUMAN_PHASES.includes(phase),
    });
    return Math.round(durationMs);
  }

  /** Time an async fn as a phase, closing it even if the fn throws. */
  async measure(phase, fn) {
    this.start(phase);
    try {
      return await fn();
    } finally {
      this.end(phase);
    }
  }

  /** Fold in phases recorded by a nested Timings instance (e.g. a carrier adapter). */
  merge(other, prefix = '') {
    for (const p of other.phases) {
      this.#completed.push({ ...p, phase: prefix ? `${prefix}.${p.phase}` : p.phase });
    }
    return this;
  }

  get phases() {
    return [...this.#completed];
  }

  get wallMs() {
    return Math.round(performance.now() - this.#start);
  }

  get humanMs() {
    return this.#completed.filter((p) => p.human).reduce((a, p) => a + p.durationMs, 0);
  }

  /**
   * Work that happens after the user already has their documents.
   *
   * `persist_session` is backgrounded (OPTIMISATION-LOG O-7) and awaited during cleanup,
   * and metrics are sealed after cleanup so the phase appears with its real duration. The
   * side effect is that `wallMs` extends past the moment the COMPLETED payload was sent —
   * on a measured GEICO run, by 577ms.
   *
   * That made the headline figure **pessimistic about our own performance**: 13,285ms
   * reported for a run where documents were on screen at roughly 12,708ms. O-3 went to some
   * trouble to ensure the windows never report *lower* than reality; this is the same
   * concern in the opposite direction, and it is still a measurement that does not describe
   * what the user experienced.
   */
  static POST_DELIVERY_PHASES = new Set(['persist_session']);

  /** Total of phases that ran after the documents were delivered. */
  get postDeliveryMs() {
    return this.phases
      .filter((p) => Timings.POST_DELIVERY_PHASES.has(p.phase))
      .reduce((sum, p) => sum + p.durationMs, 0);
  }

  /**
   * Wall clock minus human wait, minus work the user never waited on.
   *
   * The figure the latency budget applies to. Subtracting post-delivery work is safe
   * against the double-counting trap O-3 documents, because these phases are leaves —
   * `persist_session` wraps no children, so removing it cannot remove time twice.
   */
  get machineMs() {
    return Math.max(0, this.wallMs - this.humanMs - this.postDeliveryMs);
  }

  summary() {
    return {
      ...this.labels,
      wallMs: this.wallMs,
      machineMs: this.machineMs,
      humanMs: this.humanMs,
      // Surfaced so the subtraction is auditable rather than invisible.
      postDeliveryMs: this.postDeliveryMs,
      phases: this.phases,
    };
  }
}

export default Timings;
