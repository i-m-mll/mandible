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
  error: string | null;
  lastObservation?: { outcome: 'pending'; code: string; reason: string; observedAt: number } | null;
  verification?: RuntimePendingVerification;
}
export function runtimeHandoffLockFile(home: string): string;
export function readRuntimeHandoffLock(home: string): RuntimeHandoffLock | null;
export function runtimeHandoffLockRefusal(lock: RuntimeHandoffLock): string;
export function runtimeHandoffBindingDigest(binding: unknown): string;
