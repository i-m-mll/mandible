import { describe, expect, it, vi } from 'vitest';
import {
  createAuthOutputCoalescer,
  MAX_PENDING_OUTPUT_CHARS,
} from '../../ui/src/auth-output-coalescer';

/**
 * A manual scheduler so tests control exactly when a batched flush runs.
 * schedule() stores the callback; run() invokes the pending one.
 */
function manualScheduler() {
  let pending: (() => void) | null = null;
  let nextHandle = 1;
  const cancelled: number[] = [];
  return {
    schedule: (cb: () => void): number => {
      pending = cb;
      return nextHandle++;
    },
    cancel: (handle: number): void => {
      cancelled.push(handle);
      pending = null;
    },
    run: (): void => {
      const cb = pending;
      pending = null;
      cb?.();
    },
    hasPending: (): boolean => pending !== null,
    cancelled,
  };
}

describe('auth output coalescer', () => {
  it('batches multiple chunks for one request into a single emit per frame', () => {
    const sched = manualScheduler();
    const emit = vi.fn();
    const coalescer = createAuthOutputCoalescer(emit, sched.schedule, sched.cancel);

    coalescer.push('a1', 'line1\n');
    coalescer.push('a1', 'line2\n');
    coalescer.push('a1', 'line3\n');
    expect(emit).not.toHaveBeenCalled(); // nothing emitted until the frame runs

    sched.run();
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith('a1', 'line1\nline2\nline3\n');
  });

  it('keeps separate buffers per request id', () => {
    const sched = manualScheduler();
    const emit = vi.fn();
    const coalescer = createAuthOutputCoalescer(emit, sched.schedule, sched.cancel);

    coalescer.push('a1', 'A');
    coalescer.push('a2', 'B');
    sched.run();

    expect(emit).toHaveBeenCalledTimes(2);
    expect(emit).toHaveBeenCalledWith('a1', 'A');
    expect(emit).toHaveBeenCalledWith('a2', 'B');
  });

  it('flush(requestId) drains that request synchronously before resolution', () => {
    const sched = manualScheduler();
    const emit = vi.fn();
    const coalescer = createAuthOutputCoalescer(emit, sched.schedule, sched.cancel);

    coalescer.push('a1', 'final chunk');
    // Terminal flush must deliver the buffered chunk immediately, without
    // waiting for the scheduled frame.
    coalescer.flush('a1');
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith('a1', 'final chunk');

    // The scheduled frame then finds nothing left for a1 and does not re-emit.
    sched.run();
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it('flush(requestId) leaves other requests buffered for the scheduled frame', () => {
    const sched = manualScheduler();
    const emit = vi.fn();
    const coalescer = createAuthOutputCoalescer(emit, sched.schedule, sched.cancel);

    coalescer.push('a1', 'one');
    coalescer.push('a2', 'two');
    coalescer.flush('a1');
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith('a1', 'one');

    sched.run();
    expect(emit).toHaveBeenCalledTimes(2);
    expect(emit).toHaveBeenCalledWith('a2', 'two');
  });

  it('ignores empty request ids and empty chunks', () => {
    const sched = manualScheduler();
    const emit = vi.fn();
    const coalescer = createAuthOutputCoalescer(emit, sched.schedule, sched.cancel);

    coalescer.push('', 'x');
    coalescer.push('a1', '');
    expect(sched.hasPending()).toBe(false); // nothing scheduled
    sched.run();
    expect(emit).not.toHaveBeenCalled();
  });

  it('bounds a single request buffer to the tail when it exceeds the cap', () => {
    const sched = manualScheduler();
    const emit = vi.fn();
    const coalescer = createAuthOutputCoalescer(emit, sched.schedule, sched.cancel);

    const head = 'H'.repeat(MAX_PENDING_OUTPUT_CHARS);
    const tail = 'T'.repeat(1000);
    coalescer.push('a1', head);
    coalescer.push('a1', tail);
    sched.run();

    expect(emit).toHaveBeenCalledTimes(1);
    const [, emitted] = emit.mock.calls[0];
    expect(emitted.length).toBe(MAX_PENDING_OUTPUT_CHARS);
    expect(emitted.endsWith(tail)).toBe(true); // newest bytes retained
  });

  it('dispose cancels a scheduled flush and discards pending output', () => {
    const sched = manualScheduler();
    const emit = vi.fn();
    const coalescer = createAuthOutputCoalescer(emit, sched.schedule, sched.cancel);

    coalescer.push('a1', 'buffered');
    coalescer.dispose();
    sched.run(); // no-op: the frame was cancelled and buffers cleared
    expect(emit).not.toHaveBeenCalled();
  });
});
