import { describe, expect, it, vi } from 'vitest';
import { createAuthProjectionRefresh } from '../ui/src/auth-projection-refresh';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
}

describe('auth projection refresh', () => {
  it('discards reads overtaken by a newer read or local lifecycle resolution', async () => {
    const first = deferred<Array<{ status: string }>>();
    const second = deferred<Array<{ status: string }>>();
    const third = deferred<Array<{ status: string }>>();
    const reads = [first, second, third];
    const apply = vi.fn();
    const refresh = createAuthProjectionRefresh(() => reads.shift()!.promise, apply);

    const older = refresh.refresh();
    const newer = refresh.refresh();
    second.resolve([{ status: 'pending' }]);
    await expect(newer).resolves.toBe(true);
    first.resolve([{ status: 'blocked' }]);
    await expect(older).resolves.toBe(false);
    expect(apply).toHaveBeenCalledOnce();
    expect(apply).toHaveBeenLastCalledWith([{ status: 'pending' }]);

    const overtakenByPush = refresh.refresh();
    refresh.notePush();
    third.resolve([{ status: 'pending' }]);
    await expect(overtakenByPush).resolves.toBe(false);
    expect(apply).toHaveBeenCalledOnce();
  });
});
