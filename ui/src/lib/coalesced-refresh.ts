/** Shortest gap between the starts of two refreshes of one live view. */
export const LIVE_REFRESH_MIN_INTERVAL_MS = 1_000;

export interface CoalescedRefresh {
  /** Ask for a refresh. Requests made while one is in flight or too recent collapse into one. */
  request(): void;
  /** Drop any pending refresh; later requests do nothing. */
  stop(): void;
}

/**
 * Runs `run` for a stream of refresh requests with at most one refresh in flight and at most
 * one pending. A request while idle runs at once if the last start is `minIntervalMs` old;
 * otherwise it waits for that gap and for the in-flight refresh (a returned promise) to settle.
 * Any number of requests in that wait produce one refresh.
 */
export function createCoalescedRefresh(
  run: () => unknown,
  minIntervalMs = LIVE_REFRESH_MIN_INTERVAL_MS,
): CoalescedRefresh {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let pending = false;
  let stopped = false;
  let lastStartedAt = Number.NEGATIVE_INFINITY;

  const start = (): void => {
    timer = null;
    pending = false;
    running = true;
    lastStartedAt = Date.now();
    let settled: unknown;
    try {
      settled = run();
    } catch (error) {
      running = false;
      throw error;
    }
    void Promise.resolve(settled).catch(() => undefined).then(() => {
      running = false;
      if (pending) schedule();
    });
  };

  const schedule = (): void => {
    if (stopped || running || timer !== null) return;
    const wait = lastStartedAt + minIntervalMs - Date.now();
    if (wait <= 0) start();
    else timer = setTimeout(start, wait);
  };

  return {
    request() {
      if (stopped) return;
      pending = true;
      schedule();
    },
    stop() {
      stopped = true;
      pending = false;
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
  };
}
