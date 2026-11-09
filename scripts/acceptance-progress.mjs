import { acceptanceFailure, stageActivity } from './acceptance-failure.mjs';

/**
 * Candidate acceptance never fails a candidate on elapsed time. Each stage has
 * an expected duration, which only produces a warning, and a hang threshold:
 * the longest it may go without observable progress before it is stopped.
 * A stage with `idleMs: null` has no progress-based hang detection. The one
 * time limit is the run-wide backstop, which only a run that keeps producing
 * output without finishing reaches.
 */
export const ACCEPTANCE_EXPECTED_TOTAL_MS = 60_000;
export const ACCEPTANCE_CLEANUP_MS = 10_000;
/** A run still producing output this long after it started is looping; it fails. */
export const ACCEPTANCE_BACKSTOP_MS = 10 * ACCEPTANCE_EXPECTED_TOTAL_MS;
/** Output progress is relayed as a script line at most this often. */
export const ACCEPTANCE_RELAY_MS = 1_000;
/** The executor's silence allowance beyond the script's phase threshold, so the script's own hung report comes first. */
export const ACCEPTANCE_RELAY_MARGIN_MS = 5_000;
export const ACCEPTANCE_STAGES = Object.freeze({
  checkout: Object.freeze({ expectedMs: 6_000, idleMs: 60_000 }),
  package_build: Object.freeze({ expectedMs: 36_000, idleMs: 120_000 }),
  package_verification: Object.freeze({ expectedMs: 12_000, idleMs: 60_000 }),
  readiness: Object.freeze({ expectedMs: 4_000, idleMs: 30_000 }),
  desktop_interaction: Object.freeze({ expectedMs: 4_000, idleMs: 60_000, stepIdleMs: 30_000 }),
  health_coverage: Object.freeze({ expectedMs: 2_000, idleMs: null }),
  finalization: Object.freeze({ expectedMs: 5_000, idleMs: null }),
  script: Object.freeze({ expectedMs: ACCEPTANCE_EXPECTED_TOTAL_MS, idleMs: 60_000 }),
});

/** How long the executor lets the acceptance script stay silent while it is in `stage`. */
export function scriptIdleMs(stage) {
  return (ACCEPTANCE_STAGES[stage]?.idleMs ?? ACCEPTANCE_STAGES.script.idleMs) + ACCEPTANCE_RELAY_MARGIN_MS;
}

const seconds = ms => `${(ms / 1000).toFixed(1)} s`;

/**
 * The last progress of one stage. Progress is only something observed:
 * output bytes, growth of a watched file, or a change of observed state.
 * The `onHung` callback runs once the stage has been silent for `idleMs`.
 */
export class ProgressWatch {
  #idleMs; #now; #onProgress; #sizes = new Map(); #state; #bytes = 0; #last = null; #lastProgressAt; #hung; #timer;

  constructor({ stage, idleMs = null, now = Date.now, onProgress }) {
    this.stage = stage;
    this.#idleMs = ProgressWatch.#valid(idleMs);
    this.#now = now;
    this.#onProgress = onProgress;
    this.startedAt = now();
    this.#lastProgressAt = this.startedAt;
  }

  static #valid(idleMs) {
    if (idleMs !== null && !(idleMs > 0 && Number.isFinite(idleMs))) throw new Error('Invalid progress idle threshold.');
    return idleMs;
  }

  /** Change the threshold; a pending `onHung` applies the new one. */
  threshold(idleMs) {
    this.#idleMs = ProgressWatch.#valid(idleMs);
    this.#arm();
  }

  #progress(kind, description) {
    this.#lastProgressAt = this.#now();
    this.#last = description;
    this.#onProgress?.(kind, description);
  }

  /** Bytes of output arrived. */
  output(bytes) {
    if (!(bytes > 0)) return;
    this.#bytes += bytes;
    this.#progress('output', `${this.#bytes} bytes of output`);
  }

  /** A watched file reached `size`; only growth counts. */
  size(name, size) {
    const previous = this.#sizes.get(name);
    this.#sizes.set(name, size);
    if (previous !== undefined && size > previous) this.output(size - previous);
  }

  /** An observed state; only a change counts. */
  advance(state) {
    if (state === this.#state) return false;
    this.#state = state;
    this.#progress('state', state);
    return true;
  }

  #hungError() {
    const silentMs = this.#now() - this.#lastProgressAt;
    const last = this.#last === null ? 'none since it started' : `${this.#last}, ${seconds(silentMs)} ago`;
    return Object.assign(new Error(`${this.stage} made no progress for ${seconds(silentMs)}, and acceptance treats ${seconds(this.#idleMs)} without progress as hung; last progress: ${last}`),
      { code: 'HUNG', stage: this.stage, idleMs: this.#idleMs, silentMs, lastProgressAt: this.#lastProgressAt, last: this.#last });
  }

  #silent() { return this.#idleMs !== null && this.#now() - this.#lastProgressAt >= this.#idleMs; }

  /** Throw the hung error when the stage has been silent for its threshold. */
  assert() {
    if (this.#silent()) throw this.#hungError();
  }

  #arm() {
    clearTimeout(this.#timer);
    if (!this.#hung || this.#idleMs === null) return;
    if (!this.#silent()) { this.#timer = setTimeout(() => this.#arm(), this.#idleMs - (this.#now() - this.#lastProgressAt)); return; }
    const callback = this.#hung;
    this.#hung = undefined;
    callback(this.#hungError());
  }

  /** Call `callback` once with the hung error when the stage goes silent for its threshold. Returns a canceller. */
  onHung(callback) {
    this.#hung = callback;
    this.#arm();
    return () => { if (this.#hung === callback) this.close(); };
  }

  close() {
    this.#hung = undefined;
    clearTimeout(this.#timer);
  }
}

export function stageWarning(name, elapsedMs, expectedMs) {
  return `${stageActivity(name)} took ${seconds(elapsedMs)}, longer than the ${seconds(expectedMs)} it usually takes.`;
}

export function totalWarning(elapsedMs) {
  return `The whole acceptance run took ${seconds(elapsedMs)}, longer than the ${seconds(ACCEPTANCE_EXPECTED_TOTAL_MS)} it usually takes.`;
}

const phaseLine = /^\[acceptance\] ([a-z_]+) (?:(started)|(passed) in (\d+) ms|(failed) after (\d+) ms)/;

/** A phase start or end line the script writes to stderr; null for any other line, progress lines included. */
export function parsePhaseLine(line) {
  const match = phaseLine.exec(line);
  if (!match) return null;
  const [, name, started, passed, passedMs, failed, failedMs] = match;
  const status = started ? 'running' : passed ?? failed;
  return { name, status, elapsed_ms: started ? null : Number(passedMs ?? failedMs) };
}

/**
 * Records every acceptance stage into `result.phases` and collects warnings
 * for stages over their expected durations. It writes one stderr
 * line per phase transition and per observed progress (output progress at
 * most once per ACCEPTANCE_RELAY_MS), never on a timer: the executor treats
 * these lines as the script's signs of life.
 */
export function acceptancePhases(result, { startedAt = Date.now(), now = Date.now,
  write = line => process.stderr.write(`${line}\n`) } = {}) {
  result.phases ??= {};
  result.warnings ??= [];
  let lastLineAt = -Infinity;
  const line = text => { lastLineAt = now(); write(`[acceptance] ${text}`); };
  const ended = (name, record) => line(record.status === 'passed'
    ? `${name} passed in ${record.elapsed_ms} ms (expected ${record.expected_ms} ms)`
    : `${name} failed after ${record.elapsed_ms} ms: ${String(record.error ?? '').split('\n')[0].slice(0, 300)}`);
  const settle = (name, record, status, error) => {
    record.status = status;
    record.elapsed_ms = now() - record.started_at;
    record.over_expected = record.elapsed_ms > record.expected_ms;
    if (error !== undefined) record.error = error instanceof Error ? error.message : String(error);
    if (record.over_expected) result.warnings.push(stageWarning(name, record.elapsed_ms, record.expected_ms));
    ended(name, record);
  };
  const begin = name => {
    const config = ACCEPTANCE_STAGES[name];
    if (!config) throw new Error(`Unknown acceptance stage ${name}.`);
    const watch = new ProgressWatch({ stage: stageActivity(name), idleMs: config.idleMs, now,
      onProgress: (kind, description) => { if (kind === 'state' || now() - lastLineAt >= ACCEPTANCE_RELAY_MS) line(`${name} progress: ${description}`); } });
    const record = { status: 'running', started_at: watch.startedAt, elapsed_ms: null, expected_ms: config.expectedMs, over_expected: false };
    result.phases[name] = record;
    line(`${name} started`);
    const end = (status, error) => {
      watch.close();
      if (record.status === 'running') settle(name, record, status, error);
    };
    return { watch, record, pass: () => end('passed'), fail: error => end('failed', error) };
  };
  const run = async (name, operation) => {
    const phase = begin(name);
    try {
      const value = await operation(phase.watch);
      phase.pass();
      return value;
    } catch (error) {
      phase.fail(error);
      throw error;
    }
  };
  /** Fail every phase still running, for a run that ended early. */
  const failRunning = error => {
    for (const [name, record] of Object.entries(result.phases)) if (record.status === 'running') settle(name, record, 'failed', error);
  };
  /** Bring `result.timing` up to date. */
  const timing = () => {
    result.timing = { started_at: startedAt, elapsed_ms: now() - startedAt, expected_ms: ACCEPTANCE_EXPECTED_TOTAL_MS };
  };
  const current = () => Object.keys(result.phases).at(-1) ?? 'startup';
  return { begin, run, failRunning, timing, current };
}

/**
 * The run-wide backstop. Its signal aborts the run's commands once the run
 * has lasted `backstopMs` since `startedAt`; `explain` turns the resulting
 * abort into the backstop failure, naming the stage the run was in.
 */
export function acceptanceBackstop(signal, { startedAt = Date.now(), backstopMs = ACCEPTANCE_BACKSTOP_MS, stage = 'checkout' } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(0, startedAt + backstopMs - Date.now()));
  let current = stage;
  return {
    signal: AbortSignal.any([signal, controller.signal]),
    enter(name) { current = name; },
    get stage() { return current; },
    explain(error) {
      if (!controller.signal.aborted) return error;
      const minutes = backstopMs >= 60_000 ? `${backstopMs / 60_000} minutes` : `${seconds(backstopMs)}`;
      return Object.assign(acceptanceFailure('either', `Acceptance was still producing output after ${minutes} but never finished, which usually means a step is looping, such as an install retrying. It was in this stage: ${stageActivity(current)}`,
        { stage: current, backstop_ms: backstopMs }), { code: 'BACKSTOP', cause: error });
    },
    close() { clearTimeout(timer); },
  };
}
