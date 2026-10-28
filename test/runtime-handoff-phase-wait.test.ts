// @vitest-environment node
import { expect, it } from 'vitest';
import { HANDOFF_PHASE_BUDGET_MS, waitForHandoffPhases } from './helpers/runtime-handoff-phase-wait.js';

it('waits for admission, completion, and final acknowledgment with separate budgets', async () => {
  let time = 0;
  await waitForHandoffPhases({ now: () => time, wait: async milliseconds => { time += milliseconds; },
    read: () => ({ admitted: time >= 50_000, phase: time >= 210_000 ? 'acknowledged' : time >= 170_000 ? 'complete' : 'observing' }),
  });
  expect(time).toBe(210_000);
});

it.each(['admission', 'completion', 'acknowledgment'] as const)('bounds an unfinished %s phase', async phase => {
  let time = 0;
  await expect(waitForHandoffPhases({ now: () => time, wait: async milliseconds => { time += milliseconds; },
    read: () => ({ admitted: phase !== 'admission', phase: phase === 'acknowledgment' ? 'complete' : 'observing' }),
  })).rejects.toThrow(`Runtime handoff ${phase} did not complete within ${HANDOFF_PHASE_BUDGET_MS[phase]}ms`);
  expect(time).toBe(HANDOFF_PHASE_BUDGET_MS[phase]);
});

it('reports a concrete refusal immediately', async () => {
  let waits = 0;
  await expect(waitForHandoffPhases({ read: () => ({ admitted: true, phase: 'failed', failure: 'Exact package ownership changed.' }),
    wait: async () => { waits++; },
  })).rejects.toThrow('Exact package ownership changed.');
  expect(waits).toBe(0);
});
