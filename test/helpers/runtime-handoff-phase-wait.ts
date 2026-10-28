export const HANDOFF_PHASE_BUDGET_MS = {
  admission: 60_000,
  completion: 180_000,
  acknowledgment: 60_000,
} as const;

export interface HandoffProgress {
  admitted: boolean;
  phase: string | null;
  failure?: string | null;
}

/** Each asynchronous phase gets its own budget; concrete refusals never wait. */
export async function waitForHandoffPhases({ read, now = Date.now,
  wait = (milliseconds: number) => new Promise<void>(resolve => setTimeout(resolve, milliseconds)),
}: {
  read: () => HandoffProgress | Promise<HandoffProgress>;
  now?: () => number;
  wait?: (milliseconds: number) => Promise<void>;
}): Promise<void> {
  const phases = [
    ['admission', (state: HandoffProgress) => state.admitted],
    ['completion', (state: HandoffProgress) => ['complete', 'acknowledged'].includes(state.phase ?? '')],
    ['acknowledgment', (state: HandoffProgress) => state.phase === 'acknowledged'],
  ] as const;
  for (const [phase, complete] of phases) {
    const budget = HANDOFF_PHASE_BUDGET_MS[phase];
    const deadline = now() + budget;
    for (;;) {
      const state = await read();
      if (state.failure || state.phase === 'failed') throw new Error(state.failure || 'Runtime handoff failed.');
      if (complete(state)) break;
      const remaining = deadline - now();
      if (remaining <= 0) throw new Error(`Runtime handoff ${phase} did not complete within ${budget}ms`);
      await wait(Math.min(250, remaining));
    }
  }
}
