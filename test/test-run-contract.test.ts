import { describe, expect, it } from 'vitest';
import { checkoutViolation, completeTimingPacket } from '../scripts/test-run-contract.mjs';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { scratchDir } from './helpers/cli-process.js';

function sample(intervals: number[][]) {
  const files = intervals.map((_, i) => ({ file: `test/${i}.test.ts`, absolute_file: `/repo/test/${i}.test.ts`, diagnostic_occupancy_ms: 1 }));
  const lifecycles = intervals.map(([start, end], i) => ({ file: files[i].absolute_file, environment: 'node', worker_id: String(i), status: 'complete', start_ms: start, end_ms: end }));
  return { packet: { files, violations: [] }, lifecycles };
}

describe('complete command timing contract', () => {
  const qualifiedGit = process.env.MANDIBLE_TEST_GIT_EXECUTABLE;
  if (process.platform === 'darwin' && qualifiedGit) {
    it('preserves the selected Git prefix, init templates and explicit tool overrides', () => {
      const native = qualifiedGit;
      const run = (command: string, args: string[], env = process.env) => spawnSync(command, args, { env, encoding: 'utf8', timeout: 10_000 });
      const expected = run(native, ['--exec-path']);
      const actual = run('git', ['--exec-path']);
      expect(expected.status).toBe(0);
      expect(actual.status).toBe(0);
      expect(actual.stdout).toBe(expected.stdout);
      const root = scratchDir('git-prefix');
      for (const [label, command] of [['native', native], ['qualified', 'git']]) {
        const initialized = run(command, ['init', '--quiet', path.join(root, label)]);
        expect(initialized.status, initialized.stderr).toBe(0);
        expect(initialized.stderr).toBe('');
      }
      const hooks = (label: string) => fs.readdirSync(path.join(root, label, '.git', 'hooks')).sort();
      expect(hooks('qualified')).toEqual(hooks('native'));
      const override = path.join(root, 'explicit-exec-path');
      expect(run('git', ['--exec-path'], { ...process.env, GIT_EXEC_PATH: override }).stdout.trim()).toBe(override);
    });
  }

  it('counts overlapping worker lifetimes and uncovered shared work exactly once', () => {
    const { packet, lifecycles } = sample([[10, 40], [20, 50]]);
    expect(completeTimingPacket(packet, { wall_ms: 45 }, lifecycles, false)).toMatchObject({
      wall_ms: 45, file_sum_ms: 60, lifecycle_union_ms: 40, shared_ms: 5, sum_ms: 65, peak_live_workers: 2,
    });
  });

  it('enforces unchanged budgets after startup and cleanup have been charged', () => {
    const { packet, lifecycles } = sample(Array.from({ length: 24 }, () => [0, 25_000]));
    expect(completeTimingPacket(packet, { wall_ms: 25_000 }, lifecycles, true).violations).toEqual([]);
    expect(completeTimingPacket(packet, { wall_ms: 25_001 }, lifecycles, true).violations).toHaveLength(1);
    const completed = completeTimingPacket(packet, { wall_ms: 61_000 }, lifecycles, true);
    expect(completed).toMatchObject({ sum_ms: 636_000, shared_ms: 36_000 });
    expect(completed.violations).toHaveLength(2);
    expect(completed.violations.join('\n')).toContain('command wall');
    expect(completed.violations.join('\n')).toContain('including shared command work');
    expect(packet.violations).toEqual([]);
  });

  it('refuses missing, duplicate, failed, or impossible lifecycle receipts', () => {
    const { packet, lifecycles } = sample([[0, 10]]);
    expect(() => completeTimingPacket(packet, { wall_ms: 20 }, [], false)).toThrow('Missing completed worker');
    expect(() => completeTimingPacket(packet, { wall_ms: 20 }, [...lifecycles, ...lifecycles], false)).toThrow('duplicate');
    expect(() => completeTimingPacket(packet, { wall_ms: 20 }, [{ ...lifecycles[0], status: 'stop-failed' }], false)).toThrow('failed');
    expect(() => completeTimingPacket(packet, { wall_ms: 5 }, lifecycles, false)).toThrow('union exceeds');
    expect(() => completeTimingPacket(packet, { wall_ms: 20 }, [{ ...lifecycles[0], end_ms: -1 }], false)).toThrow('Invalid worker');
  });

  it('retains existing violations and refuses checkout writes or an unreadable checkout', () => {
    const { packet, lifecycles } = sample([[0, 10]]);
    expect(completeTimingPacket({ ...packet, violations: ['inventory'] }, { wall_ms: 20 }, lifecycles, false).violations).toEqual(['inventory']);
    const before = { ok: true, entries: [' M existing.ts'] };
    expect(checkoutViolation(before, { ok: true, entries: [' M existing.ts', '?? leaked.db'] })).toContain('+ ?? leaked.db');
    expect(checkoutViolation(before, { ok: true, entries: [] })).toContain('-  M existing.ts');
    expect(checkoutViolation(before, before)).toBeNull();
    expect(checkoutViolation(before, { ok: false, error: 'git failed' })).toContain('cannot read checkout');
  });
});
