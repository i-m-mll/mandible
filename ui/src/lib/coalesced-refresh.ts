/** Shortest gap between the starts of two requested refreshes of one live view. */
export const LIVE_REFRESH_MIN_INTERVAL_MS = 1_000;
/** Longest a single refresh may run before it is aborted as failed. */
export const LIVE_REFRESH_DEADLINE_MS = 20_000;

/** The abort reason of a refresh that ran past its deadline: a failure to show, not a cancellation. */
export class RefreshDeadlineError extends Error {
  constructor(deadlineMs: number) {
    super(`The refresh did not finish within ${Math.round(deadlineMs / 1_000)} s.`);
    this.name = 'RefreshDeadlineError';
  }
}

/** True when `signal` was aborted because its refresh was superseded or its view went inactive. */
export function refreshAbandoned(signal: AbortSignal | undefined): boolean {
  return Boolean(signal?.aborted && !(signal.reason instanceof RefreshDeadlineError));
}

/** One refresh: receives an AbortSignal that is aborted when the run is superseded, stopped, or past its deadline. */
export type RefreshRun = (signal: AbortSignal) => unknown;

export interface CoalescedRefresh {
  /** Ask for a refresh. Requests while one is in flight or too recent collapse into one. */
  request(): void;
  /** Abort the in-flight refresh and start one now. Resolves when that refresh ends. */
  restart(): Promise<void>;
  /** Abort the in-flight refresh and drop any pending one; later calls do nothing. */
  stop(): void;
}

/**
 * Runs `run` with at most one refresh in flight and at most one pending. A request while
 * idle runs at once if the last start is `minIntervalMs` old; otherwise it waits for that gap
 * and for the in-flight refresh to end. A refresh ends when the promise `run` returns settles
 * or when its signal is aborted, whichever is first, so a refresh that ignores its signal
 * cannot hold the scheduler. A refresh still running after `deadlineMs` is aborted with a
 * `RefreshDeadlineError`, which is logged; `run` shows it as a failed load.
 * Set `deadlineMs` to null when `run` already owns its bounded read lifecycle.
 */
export function createCoalescedRefresh(
  run: RefreshRun,
  { minIntervalMs = LIVE_REFRESH_MIN_INTERVAL_MS, deadlineMs = LIVE_REFRESH_DEADLINE_MS }: {
    minIntervalMs?: number;
    deadlineMs?: number | null;
  } = {},
): CoalescedRefresh {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight: AbortController | null = null;
  let pending = false;
  let stopped = false;
  let lastStartedAt = Number.NEGATIVE_INFINITY;

  const start = (): Promise<void> => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    pending = false;
    lastStartedAt = Date.now();
    const controller = new AbortController();
    inFlight = controller;
    const deadline = deadlineMs === null ? null : setTimeout(() => {
      const error = new RefreshDeadlineError(deadlineMs);
      console.error(error);
      controller.abort(error);
    }, deadlineMs);
    const aborted = new Promise<void>((resolve) => {
      controller.signal.addEventListener('abort', () => resolve(), { once: true });
    });
    let result: unknown;
    try {
      result = run(controller.signal);
    } catch (error) {
      result = Promise.reject(error);
    }
    const settled = Promise.resolve(result).then(() => undefined, () => undefined);
    return Promise.race([settled, aborted]).then(() => {
      if (deadline !== null) clearTimeout(deadline);
      if (inFlight !== controller) return;
      inFlight = null;
      if (pending) schedule();
    });
  };

  const schedule = (): void => {
    if (stopped || inFlight !== null || timer !== null) return;
    const wait = lastStartedAt + minIntervalMs - Date.now();
    if (wait <= 0) void start();
    else timer = setTimeout(() => void start(), wait);
  };

  const abortInFlight = (): void => {
    const controller = inFlight;
    inFlight = null;
    controller?.abort(new DOMException('The refresh was superseded.', 'AbortError'));
  };

  return {
    request() {
      if (stopped) return;
      pending = true;
      schedule();
    },
    restart() {
      if (stopped) return Promise.resolve();
      abortInFlight();
      return start();
    },
    stop() {
      stopped = true;
      pending = false;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      abortInFlight();
    },
  };
}
