import type { AuthRuntimeVerification } from '../src/types.js';
export interface RuntimePendingVerification extends AuthRuntimeVerification {
  requestId: string;
  executionId: string;
  hookId: string;
  commandDigest: string;
  bindingDigest: string;
}
export interface RuntimeHandoffLock {
  file: string;
  journalPath: string | null;
  bindingDigest: string | null;
  requestId: string | null;
  executionId: string | null;
  phase: string | null;
  /** Why the lock is held: an update going live, one awaiting confirmation, a failed one, or a lock Mandible cannot read. */
  state: 'installing' | 'verifying' | 'failed' | 'unreadable';
  error: string | null;
  lastObservation?: { outcome: 'pending'; code: string; reason: string; observedAt: number } | null;
  verification?: RuntimePendingVerification;
}
export function runtimeHandoffLockFile(home: string): string;
export function runtimeHandoffSettled(journal: unknown): boolean;
export function readRuntimeHandoffLock(home: string): RuntimeHandoffLock | null;
export function runtimeHandoffLockRefusal(lock: RuntimeHandoffLock): string;
export function runtimeHandoffBindingDigest(binding: unknown): string;
