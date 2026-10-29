export const ACCEPTANCE_TOTAL_MS: number;
export const ACCEPTANCE_CLEANUP_MS: number;
export type AcceptanceDeadlinePhase = 'preparation' | 'readiness' | 'work' | 'report' | 'total';
export function acceptanceDeadline(env?: NodeJS.ProcessEnv, now?: () => number): {
  started: number;
  deadline: number;
  cutoffs: Readonly<Record<AcceptanceDeadlinePhase, number>>;
  remaining(phase?: AcceptanceDeadlinePhase): number;
  env: { MANDIBLE_ACCEPTANCE_STARTED_AT: string; MANDIBLE_ACCEPTANCE_DEADLINE: string };
  reading(): { started_at: number; deadline: number; elapsed_ms: number; cleanup_reserve_ms: number;
    cutoffs: Readonly<Record<AcceptanceDeadlinePhase, number>>; remaining_ms: Record<AcceptanceDeadlinePhase, number>; scope: string };
};
