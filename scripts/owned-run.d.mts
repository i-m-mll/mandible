export interface ConsumerInspection { idle: boolean; reason?: string }
export interface OwnedRunHandle { root: string; runId: string }
export interface OwnedRun {
  schema: string; runId: string; root: string; rootIdentity: { dev: number; ino: number };
  instanceId: string; project?: string; workUnit?: string; revision: number; state: string; disposable: boolean;
  outputs: Array<{ path: string; kind: string; disposition: string }>;
  processOwner: { pid: number; identity: string | null };
  receipt?: string;
  [key: string]: unknown;
}
export interface OwnedRunOutcome extends OwnedRunHandle { receipt: string; cleanup: string; generatedRecovery?: unknown }
export const OWNED_RUN_SCHEMA: string;
export function ownedRunReceipt(handle: OwnedRunHandle): OwnedRunOutcome | null;
export function inspectRunConsumers(root: string): ConsumerInspection;
export function inspectRunConsumersAsync(root: string): Promise<ConsumerInspection>;
export function withOwnedRunLock<T>(root: string, operation: () => T | Promise<T>, options?: { recoverStale?: boolean }): Promise<T>;
export function createOwnedRun(input: { root: string; instanceId: string; project?: string; workUnit?: string; outputs: Array<{ path: string; kind: string }>; disposable?: boolean; processOwned?: boolean; runId?: string }): OwnedRun;
export function saveOwnedMetadata(file: string, metadata: unknown): void;
export function ownedRunIdentityMatches(root: string, run: OwnedRun): boolean;
export function finalizeOwnedRun(file: string, input: { expectedRevision: number; outcome: string; summary: string; converged?: boolean; disposition?: string; destination?: string; reviewBy?: string; transferReference?: string }, options?: { inspect?: (root: string) => ConsumerInspection }): { ownership: OwnedRun };
export function cleanupOwnedRun(file: string, options?: { apply?: boolean; inspect?: (root: string) => ConsumerInspection }): { action: string; reason: string; remaining?: string[]; reclaimedBytes?: number; receipt?: string };
export function recoverGeneratedReceipt(file: string, options?: { apply?: boolean; inspect?: (root: string) => ConsumerInspection }): { action: string; reason?: string; remaining?: string[] };
export { processIdentity, recoverLifecycleLock } from './lifecycle-lock.mjs';
