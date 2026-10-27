export interface RuntimeHandoffLock {
  file: string;
  journalPath: string | null;
  bindingDigest: string | null;
  requestId: string | null;
  executionId: string | null;
  phase: string | null;
  error: string | null;
  lastObservation?: { outcome: 'pending'; code: string; reason: string; observedAt: number } | null;
}
export function runtimeHandoffLockFile(home: string): string;
export function readRuntimeHandoffLock(home: string): RuntimeHandoffLock | null;
export function runtimeHandoffLockRefusal(lock: RuntimeHandoffLock): string;
