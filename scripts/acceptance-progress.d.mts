import type { AcceptanceStage } from './acceptance-failure.mjs';
export type AcceptancePhaseName = Exclude<AcceptanceStage, 'startup'>;
export interface AcceptanceStageConfig { readonly expectedMs: number; readonly idleMs: number | null; readonly stepIdleMs?: number }
export const ACCEPTANCE_EXPECTED_TOTAL_MS: number;
export const ACCEPTANCE_CLEANUP_MS: number;
export const ACCEPTANCE_RELAY_MS: number;
export const ACCEPTANCE_RELAY_MARGIN_MS: number;
export const ACCEPTANCE_BACKSTOP_MS: number;
export const ACCEPTANCE_STAGES: Readonly<Record<AcceptancePhaseName | 'script', AcceptanceStageConfig>>;
export function scriptIdleMs(stage: string): number;
export interface HungError extends Error {
  code: 'HUNG'; stage: string; idleMs: number; silentMs: number; lastProgressAt: number; last: string | null;
}
export class ProgressWatch {
  constructor(options: { stage: string; idleMs?: number | null; now?: () => number; onProgress?: (kind: 'output' | 'state', description: string) => void });
  stage: string;
  readonly startedAt: number;
  threshold(idleMs: number | null): void;
  output(bytes: number): void;
  size(name: string, size: number): void;
  advance(state: string): boolean;
  assert(): void;
  onHung(callback: (error: HungError) => void): () => void;
  close(): void;
}
export function stageWarning(name: AcceptancePhaseName, elapsedMs: number, expectedMs: number): string;
export function totalWarning(elapsedMs: number): string;
export interface AcceptancePhaseEvent { name: string; status: 'running' | 'passed' | 'failed'; elapsed_ms: number | null }
export function parsePhaseLine(line: string): AcceptancePhaseEvent | null;
export interface AcceptancePhaseRecord {
  status: 'running' | 'passed' | 'failed'; started_at: number; elapsed_ms: number | null; expected_ms: number; over_expected: boolean; error?: string;
}
export interface AcceptancePhaseHandle { watch: ProgressWatch; record: AcceptancePhaseRecord; pass(): void; fail(error: unknown): void }
export function acceptancePhases(result: { phases?: Record<string, AcceptancePhaseRecord>; warnings?: string[]; timing?: unknown },
  options?: { startedAt?: number; now?: () => number; write?: (line: string) => void }): {
  begin(name: AcceptancePhaseName): AcceptancePhaseHandle;
  run<T>(name: AcceptancePhaseName, operation: (watch: ProgressWatch) => Promise<T> | T): Promise<T>;
  failRunning(error: string): void;
  timing(): void;
  current(): AcceptanceStage;
};
export interface AcceptanceBackstop {
  readonly signal: AbortSignal;
  enter(stage: AcceptancePhaseName): void;
  readonly stage: AcceptancePhaseName;
  explain(error: unknown): unknown;
  close(): void;
}
export function acceptanceBackstop(signal: AbortSignal, options?: { startedAt?: number; backstopMs?: number; stage?: AcceptancePhaseName }): AcceptanceBackstop;
