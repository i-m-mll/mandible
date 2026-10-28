// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { SweepBudget, sweepBudgetForEnvironment, writeSweepProgress, runSweepWorker } from '../scripts/route-cost-budget.ts';

it('inherits the original work and cleanup deadlines without adding a sweep cap or reserve', () => {
  let now = 31_000;
  const env = { MANDIBLE_SWEEP_STARTED_AT: '1000', MANDIBLE_SWEEP_WORK_DEADLINE: '56000', MANDIBLE_SWEEP_CLEANUP_DEADLINE: '61000' };
  const parent = sweepBudgetForEnvironment(900_000, env, () => now);
  const worker = sweepBudgetForEnvironment(900_000, env, () => now);
  const standalone = sweepBudgetForEnvironment(45_000, {}, () => now);
  try {
    expect(standalone.remaining()).toBe(40_000);
    expect(standalone.deadline).toBe(76_000);
    expect(parent.remaining()).toBe(25_000);
    expect(worker.remaining()).toBe(25_000);
    now = 52_000;
    expect(worker.remaining()).toBe(4000);
    expect(worker.deadline).toBe(parent.deadline);
    now = 56_000;
    expect(() => worker.remaining()).toThrow('deadline');
    expect(worker.remaining(true)).toBe(5000);
    now = 61_000;
    expect(() => worker.remaining(true)).toThrow('deadline');
  } finally { parent.close(); worker.close(); standalone.close(); }
});

it('keeps one deadline across phases and reserves cleanup while retaining partial evidence', async () => {
  let now = 0;
  const budget = new SweepBudget(45_000, 5_000, () => now);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-budget-'));
  const file = path.join(root, 'progress.json');
  const checkpoint = () => writeSweepProgress(file, { complete: false, progress: budget.progress(), measured: ['completed reading'] });
  try {
    await budget.measure('snapshot', checkpoint, () => { now = 15_000; });
    expect(budget.remaining()).toBe(25_000);
    await expect(budget.measure('startup', checkpoint, () => { now = 40_000; })).rejects.toThrow('deadline');
    expect(budget.remaining(true)).toBe(5_000);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toMatchObject({ complete: false, measured: ['completed reading'],
      progress: { elapsed_ms: 40_000, completed_phases: ['snapshot'], phase_ms: { snapshot: 15_000, startup: 25_000 } } });
    expect(fs.existsSync(`${file}.partial`)).toBe(false);
  } finally { budget.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

it('joins a blocked preparation process and preserves its last checkpoint at the absolute deadline', async () => {
  const budget = new SweepBudget(1_000, 500);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-blocked-preparation-'));
  const progress = path.join(root, 'progress.json');
  const pidFile = path.join(root, 'pid');
  try {
    await expect(runSweepWorker(budget, process.execPath, ['--eval', `
      const fs = require('node:fs');
      fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
      fs.writeFileSync(${JSON.stringify(progress)}, JSON.stringify({complete:false, phase:'cache_preparation', measured:['completed reading']}));
      process.on('SIGTERM', () => {});
      while (true) {}
    `], { stdio: 'ignore' })).rejects.toThrow('stage deadline');
    expect(() => process.kill(Number(fs.readFileSync(pidFile, 'utf8')), 0)).toThrow();
    expect(JSON.parse(fs.readFileSync(progress, 'utf8'))).toEqual({ complete: false, phase: 'cache_preparation', measured: ['completed reading'] });
    expect(() => budget.remaining()).toThrow('deadline');
  } finally { budget.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
