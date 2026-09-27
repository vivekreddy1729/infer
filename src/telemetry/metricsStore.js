import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import config from '../config.js';
import logger from '../logger.js';

/**
 * Append-only store of per-run phase timings, plus aggregation for the metrics
 * page.
 *
 * WHY JSONL RATHER THAN A JSON ARRAY
 *
 * A single JSON array would have to be read, parsed, mutated and rewritten on
 * every run: O(n) work per append, and a window where a crash mid-write leaves
 * a truncated file that no longer parses — taking the entire history with it.
 * One JSON object per line appends in O(1) with a single `O_APPEND` write, and a
 * torn final line costs exactly one record because the reader skips lines it
 * cannot parse. Same data, same tooling, strictly better failure mode.
 *
 * WHAT IS DELIBERATELY NOT IN HERE
 *
 * No usernames, no document names, no policy numbers, no URLs. A run is reduced
 * to phase names and durations. This file accumulates indefinitely and is the
 * kind of thing that gets copied around or committed by accident, so it holds
 * nothing worth leaking.
 */

const log = logger.child({ module: 'metricsStore' });

/** Keeps the file bounded; oldest records are dropped on rotation. */
const MAX_RECORDS = 5000;
const MAX_BYTES = 4 * 1024 * 1024;

/**
 * Collapse attempt-numbered phases so they aggregate together.
 *
 * The orchestrator emits `mfa_submit_1`, `mfa_submit_2`, … per retry. Left
 * as-is, every retry creates a new phase with a sample size of one, which is
 * useless for statistics and clutters the chart. The attempt number is still
 * recoverable from the raw records.
 */
export function normalisePhase(phase) {
  return String(phase).replace(/_(\d+)$/, '');
}

/**
 * Phases that are wrappers around other phases.
 *
 * This matters for any arithmetic over phase durations. `login` wraps
 * `nav_login` + `fill_credentials` + `submit_credentials`; `documents` wraps
 * `nav_documents` + `capture_api_auth` + `list_documents` + `document_download`.
 * Summing every phase in a run therefore exceeds its wall-clock time — measured
 * at 45,394ms of phases against 40,158ms of wall clock on a real Progressive run.
 *
 * Recorded explicitly so the exclusion windows below can subtract durations
 * without double-counting, and so the chart can mark which bars are totals rather
 * than leaves.
 */
export const COMPOSITE_PHASES = Object.freeze({
  login: ['nav_login', 'await_login_form', 'fill_credentials', 'submit_credentials'],
  documents: ['nav_documents', 'capture_api_auth', 'list_documents', 'list_documents_via_page', 'document_download'],
});

export const isComposite = (phase) => Object.hasOwn(COMPOSITE_PHASES, phase);

/**
 * Measurement windows.
 *
 * The brief's "under 8 seconds" needs saying precisely, because two phases are
 * not attributable to this system:
 *
 *   mfa_wait          — a person reading an SMS and typing six digits. Unbounded,
 *                       and nothing here can influence it.
 *   document_download — raw byte transfer for the PDFs. Dominated by link speed
 *                       and, in production, by the residential proxy's throughput.
 *
 * Rather than pick one definition and defend it, all four are computed and
 * reported side by side. Each `subtract` list contains only non-overlapping leaf
 * phases, so `wallMs - Σ(subtract)` is arithmetically sound.
 */
export const WINDOWS = Object.freeze({
  wall: { label: 'Wall clock (everything)', subtract: [] },
  exclHuman: { label: 'Excluding MFA wait', subtract: ['mfa_wait'] },
  exclDownload: { label: 'Excluding document transfer', subtract: ['document_download'] },
  exclBoth: { label: 'Excluding MFA wait + transfer', subtract: ['mfa_wait', 'document_download'] },
});

/** Sum of the named phases within one run, tolerating repeats. */
function phaseTotal(run, names) {
  let total = 0;
  for (const p of run.phases ?? []) {
    if (names.includes(p.phase)) total += p.durationMs;
  }
  return total;
}

/** Wall clock for a run minus the phases a window excludes. */
export function windowedDuration(run, windowKey) {
  const window = WINDOWS[windowKey] ?? WINDOWS.wall;
  return Math.max(0, (run.wallMs ?? 0) - phaseTotal(run, window.subtract));
}

/** Accepts `a,b` or `['a','b']`; returns null when nothing was requested. */
function toSet(value) {
  if (value === undefined || value === null || value === '') return null;
  const list = Array.isArray(value)
    ? value
    : String(value)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
  return list.length ? new Set(list) : null;
}

export class MetricsStore {
  constructor({ dir = config.DATA_DIR } = {}) {
    this.file = path.resolve(dir, 'metrics.jsonl');
  }

  async init() {
    await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
  }

  /**
   * Append one run. Never throws: losing a metrics line must not fail a pull the
   * user actually cares about.
   */
  async record(entry) {
    try {
      await this.init();
      const record = {
        runId: entry.runId ?? crypto.randomUUID(),
        at: Date.now(),
        carrierId: entry.carrierId,
        outcome: entry.outcome,
        errorCode: entry.errorCode ?? null,
        // "How did we authenticate" is the single most important dimension: a
        // warm run and a cold run are different workloads and averaging them
        // together produces a number that describes neither.
        path: entry.warmPath ? 'warm' : entry.resumed ? 'resumed' : 'cold',
        wallMs: Math.round(entry.wallMs ?? 0),
        machineMs: Math.round(entry.machineMs ?? 0),
        humanMs: Math.round(entry.humanMs ?? 0),
        documents: entry.documents ?? 0,
        phases: (entry.phases ?? []).map((p) => ({
          phase: normalisePhase(p.phase),
          durationMs: Math.round(p.durationMs),
          human: Boolean(p.human),
        })),
        transport: entry.transport
          ? {
              driver: entry.transport.driver ?? null,
              channel: entry.transport.channel ?? null,
              proxied: Boolean(entry.transport.proxied),
              requestsBlocked: entry.transport.requestsBlocked ?? 0,
            }
          : null,
      };

      await fs.appendFile(this.file, `${JSON.stringify(record)}\n`, { mode: 0o600 });
      await this.#rotateIfNeeded();
      log.debug({ carrierId: record.carrierId, path: record.path }, 'recorded run metrics');
      return record;
    } catch (err) {
      log.warn({ err: err.message }, 'could not record metrics');
      return null;
    }
  }

  /** Read every parseable record, newest last. */
  async readAll() {
    try {
      const raw = await fs.readFile(this.file, 'utf8');
      const out = [];
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        try {
          out.push(JSON.parse(line));
        } catch {
          // A torn last line from an interrupted write. Skip it; the rest is fine.
        }
      }
      return out;
    } catch (err) {
      if (err.code !== 'ENOENT') log.warn({ err: err.message }, 'could not read metrics');
      return [];
    }
  }

  async #rotateIfNeeded() {
    try {
      const { size } = await fs.stat(this.file);
      if (size < MAX_BYTES) return;
      const records = await this.readAll();
      const kept = records.slice(-Math.floor(MAX_RECORDS / 2));
      const tmp = `${this.file}.${process.pid}.tmp`;
      await fs.writeFile(tmp, kept.map((r) => JSON.stringify(r)).join('\n') + '\n', { mode: 0o600 });
      await fs.rename(tmp, this.file);
      log.info({ from: records.length, to: kept.length }, 'rotated metrics file');
    } catch (err) {
      log.warn({ err: err.message }, 'metrics rotation failed');
    }
  }

  async clear() {
    await fs.rm(this.file, { force: true });
  }

  /**
   * Aggregate into per-phase statistics.
   *
   * All identity filters accept multiple values, because the interesting
   * questions are comparative: "Progressive cold versus warm", "everything except
   * the demo portal". A single-value filter forces those to be answered by
   * flipping between views and remembering numbers.
   *
   * @param {object} opts
   * @param {string|string[]=} opts.carrierId  e.g. 'progressive,demo'
   * @param {string|string[]=} opts.path       'cold' | 'warm' | 'resumed'
   * @param {string|string[]=} opts.outcome    'COMPLETED' | 'ERROR'
   * @param {string=}          opts.window     key of WINDOWS, drives the headline
   * @param {number=}          opts.sinceMs
   */
  async aggregate({ carrierId, path: pathFilter, outcome, window = 'exclHuman', sinceMs } = {}) {
    const all = await this.readAll();

    const carriers = toSet(carrierId);
    const paths = toSet(pathFilter);
    /**
     * Outcome is a filter rather than a hardcoded "successes only".
     *
     * Restricting phase stats to completed runs hides the most useful data while
     * an adapter is being built: a carrier whose every run fails then shows no
     * phases at all, which reads as "no data" when the truth is "lots of data,
     * all of it failures". Being able to select ERROR runs shows how far the flow
     * got and how long each step took before it died.
     */
    const outcomes = toSet(outcome) ?? new Set(['COMPLETED']);

    const inScope = all.filter(
      (r) =>
        (!carriers || carriers.has(r.carrierId)) &&
        (!paths || paths.has(r.path)) &&
        (!sinceMs || r.at >= sinceMs)
    );
    const runs = inScope.filter((r) => outcomes.has(r.outcome));

    /** Per-phase samples over the selected runs. */
    const byPhase = new Map();
    for (const run of runs) {
      for (const p of run.phases ?? []) {
        if (!byPhase.has(p.phase)) byPhase.set(p.phase, { samples: [], human: p.human });
        byPhase.get(p.phase).samples.push(p.durationMs);
      }
    }

    const phases = [...byPhase.entries()]
      .map(([phase, { samples, human }]) => ({
        phase,
        human,
        // Flagged so the chart can show totals differently from leaves, rather
        // than implying a composite bar is directly comparable to its children.
        composite: isComposite(phase),
        excludable:
          WINDOWS.exclBoth.subtract.includes(phase) ? true : undefined,
        ...summarise(samples),
      }))
      // Slowest first: the chart should lead with what actually costs time.
      .sort((a, b) => b.avg - a.avg);

    /** Every window, so they can be compared rather than chosen blind. */
    const windows = {};
    for (const [key, def] of Object.entries(WINDOWS)) {
      windows[key] = {
        key,
        label: def.label,
        subtract: def.subtract,
        stats: summarise(runs.map((r) => windowedDuration(r, key))),
      };
    }

    const selected = windows[window] ? window : 'exclHuman';
    const headline = windows[selected].stats;

    return {
      generatedAt: Date.now(),
      filters: {
        carrierId: carriers ? [...carriers] : null,
        path: paths ? [...paths] : null,
        outcome: [...outcomes],
        window: selected,
        sinceMs: sinceMs ?? null,
      },
      /** Option lists built from the whole file so filters never orphan themselves. */
      available: {
        carriers: Object.keys(tally(all.map((r) => r.carrierId))),
        paths: Object.keys(tally(all.map((r) => r.path))),
        outcomes: Object.keys(tally(all.map((r) => r.outcome))),
        windows: Object.entries(WINDOWS).map(([key, d]) => ({ key, label: d.label })),
      },
      runs: {
        total: inScope.length,
        matched: runs.length,
        completed: inScope.filter((r) => r.outcome === 'COMPLETED').length,
        failed: inScope.filter((r) => r.outcome === 'ERROR').length,
        // Failure reasons are as interesting as timings when tuning an adapter.
        errorCodes: tally(
          inScope.filter((r) => r.outcome === 'ERROR').map((r) => r.errorCode ?? 'UNKNOWN')
        ),
        byCarrier: tally(inScope.map((r) => r.carrierId)),
        byPath: tally(inScope.map((r) => r.path)),
        byOutcome: tally(inScope.map((r) => r.outcome)),
      },
      windows,
      headline,
      /** Share of matched runs meeting the 8s budget *in the selected window*. */
      withinBudget: headline.count
        ? Math.round(
            (runs.filter((r) => windowedDuration(r, selected) <= 8000).length / runs.length) * 100
          )
        : null,
      phases,
      recent: runs
        .slice(-25)
        .reverse()
        .map((r) => ({
          at: r.at,
          carrierId: r.carrierId,
          path: r.path,
          outcome: r.outcome,
          errorCode: r.errorCode,
          wallMs: r.wallMs,
          humanMs: r.humanMs,
          downloadMs: phaseTotal(r, ['document_download']),
          selectedMs: windowedDuration(r, selected),
          documents: r.documents,
        })),
    };
  }
}

/** count / min / max / avg / median / p95 for a sample set. */
export function summarise(values) {
  const nums = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (nums.length === 0) {
    return { count: 0, min: null, max: null, avg: null, median: null, p95: null };
  }
  return {
    count: nums.length,
    min: nums[0],
    max: nums[nums.length - 1],
    avg: Math.round(nums.reduce((a, b) => a + b, 0) / nums.length),
    median: percentile(nums, 50),
    // Included alongside the requested stats because an average hides the tail,
    // and the tail is what a user actually experiences on a bad run.
    p95: percentile(nums, 95),
  };
}

/** Linear-interpolated percentile over a pre-sorted array. */
function percentile(sorted, p) {
  if (sorted.length === 1) return sorted[0];
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return Math.round(sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo));
}

function tally(values) {
  const out = {};
  for (const v of values) out[v] = (out[v] ?? 0) + 1;
  return out;
}

export const metricsStore = new MetricsStore();
export default metricsStore;
