import { describe, expect, it } from 'vitest';

import {
  createOrderedSettingSave,
  shouldFlushPendingSettingWrite,
  shouldPersistSettingValue,
} from '../ui/src/views/settings-behavior';

describe('Settings autosave ordering', () => {
  it('cancels a pending return to baseline and orders a revert behind an in-flight write', async () => {
    expect(shouldPersistSettingValue('A', 'A', 'A', null)).toBe(false);
    expect(shouldFlushPendingSettingWrite(true, 3, 4)).toBe(false);
    expect(shouldPersistSettingValue('A', 'A', 'A', 'B')).toBe(true);
    expect(shouldFlushPendingSettingWrite(true, 4, 4)).toBe(true);

    let releaseFirst!: () => void;
    const firstWrite = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let markFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
    const writes: string[] = [];
    const save = createOrderedSettingSave(async (_key, value) => {
      writes.push(value);
      if (value === 'B') {
        markFirstStarted();
        await firstWrite;
      }
    });

    const writeB = save('quiet_hours', 'B');
    const revertToA = save('quiet_hours', 'A');
    await firstStarted;
    expect(writes).toEqual(['B']);

    releaseFirst();
    await Promise.all([writeB, revertToA]);
    expect(writes).toEqual(['B', 'A']);
  });
});
