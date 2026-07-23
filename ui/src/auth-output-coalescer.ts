/**
 * Coalesces high-frequency `auth:output` SSE chunks into batched reducer
 * dispatches. During a protected-branch merge the executor streams many small
 * output chunks; dispatching each one separately triggers a full app re-render
 * per chunk exactly while the user is waiting on the YubiKey. This buffers
 * chunks per request and flushes them on a single animation frame (or a short
 * timer fallback), so N chunks collapse into one dispatch per frame.
 *
 * Terminal correctness: `flush(requestId)` drains a single request
 * synchronously. The SSE layer calls it before dispatching that request's
 * `auth:resolved` event, guaranteeing the final buffered chunk lands in state
 * before resolution — never dropped, never delivered after the request already
 * resolved.
 */

/** Upper bound on a single request's pending (pre-dispatch) buffer, in chars. */
export const MAX_PENDING_OUTPUT_CHARS = 262_144;

export interface AuthOutputCoalescer {
  /** Buffer a chunk for a request and schedule a batched flush. */
  push(requestId: string, chunk: string): void;
  /** Drain one request synchronously, or all pending requests when omitted. */
  flush(requestId?: string): void;
  /** Cancel any scheduled flush and discard pending buffers. */
  dispose(): void;
}

type ScheduleFn = (cb: () => void) => number;
type CancelFn = (handle: number) => void;

function defaultSchedule(cb: () => void): number {
  if (typeof requestAnimationFrame === 'function') {
    return requestAnimationFrame(() => cb());
  }
  return setTimeout(cb, 50) as unknown as number;
}

function defaultCancel(handle: number): void {
  if (typeof cancelAnimationFrame === 'function') {
    cancelAnimationFrame(handle);
  }
  clearTimeout(handle as unknown as ReturnType<typeof setTimeout>);
}

/**
 * @param emit     Called with a coalesced chunk to dispatch into the reducer.
 * @param schedule Frame/timer scheduler (injectable for tests).
 * @param cancel   Matching canceller for a scheduled flush.
 */
export function createAuthOutputCoalescer(
  emit: (requestId: string, chunk: string) => void,
  schedule: ScheduleFn = defaultSchedule,
  cancel: CancelFn = defaultCancel,
): AuthOutputCoalescer {
  const pending = new Map<string, string>();
  let handle: number | null = null;

  const emitOne = (requestId: string): void => {
    const buffered = pending.get(requestId);
    if (buffered === undefined) return;
    pending.delete(requestId);
    emit(requestId, buffered);
  };

  const flushAll = (): void => {
    if (handle !== null) {
      cancel(handle);
      handle = null;
    }
    // Snapshot ids first: emit() may re-enter push() and mutate `pending`.
    for (const requestId of Array.from(pending.keys())) {
      emitOne(requestId);
    }
  };

  return {
    push(requestId, chunk) {
      if (!requestId || !chunk) return;
      const existing = pending.get(requestId) ?? '';
      let combined = existing + chunk;
      if (combined.length > MAX_PENDING_OUTPUT_CHARS) {
        combined = combined.slice(combined.length - MAX_PENDING_OUTPUT_CHARS);
      }
      pending.set(requestId, combined);
      if (handle === null) {
        handle = schedule(() => {
          handle = null;
          flushAll();
        });
      }
    },
    flush(requestId) {
      if (requestId === undefined) {
        flushAll();
        return;
      }
      // Terminal flush for one request: drain it now, leave any scheduled
      // flush in place for other in-flight requests.
      emitOne(requestId);
    },
    dispose() {
      if (handle !== null) {
        cancel(handle);
        handle = null;
      }
      pending.clear();
    },
  };
}
