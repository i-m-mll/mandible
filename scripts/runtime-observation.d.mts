export class RuntimeObservationError extends Error {
  readonly code: string;
  readonly evidence: unknown;
  readonly outcome: 'pending' | 'failed';
  constructor(code: string, message: string, evidence?: unknown, outcome?: 'pending' | 'failed');
  toJSON(): { schema: string; outcome: 'pending' | 'failed'; code: string; message: string; evidence: unknown };
}
export function observationPending(error: unknown): error is RuntimeObservationError;
export function runtimeObservationTimeout(until: number | undefined, maximumMs: number): number;
export interface RuntimeProcessIdentity { pid: number; startedAt: string | null; runs: number }
export interface RuntimeTerminalReceipt {
  schema: 'mandible-runtime-receipt@2';
  bindingDigest: string;
  attemptId: string;
  approved: { reference: string; packageSha256: string; publicationEvidence: { evidenceId: string; digest: string } };
  installed: { root: string; identity: { dev: number; ino: number } };
  services: { backend: RuntimeProcessIdentity; gateway: RuntimeProcessIdentity };
  startup: { epoch: string; generation: string; database: string };
  desktop: { required?: boolean; identity?: { pid: number; startedAt: string; [key: string]: unknown }; [key: string]: unknown };
  completedAt: number;
  diagnostics?: { daemonLog?: unknown };
}
export function runtimeProcessChanged(expected: RuntimeProcessIdentity | null | undefined, current: RuntimeProcessIdentity | null): boolean;
export function decodeObservationError(text: string): RuntimeObservationError | null;
export function runtimeObservationAcceptance(run: {
  id: string; auth_request_id: string; hook_id: string; command_digest: string; state: string; output: string;
} | null | undefined, journal: {
  binding: { executionId: string; requestId: string; hookId: string; commandDigest: string };
  bindingDigest: string;
  recovery?: { digest: string };
  attempt?: { id: string; state: 'running' | 'complete' | 'failed'; receipt?: unknown; receiptDigest?: string; fence?: unknown };
  cleanup?: { state: 'pending' | 'complete' | 'failed' };
}): 'accepted' | 'unaccepted' | 'inconsistent';
export function runtimeHandoffDisposition(journal: {
  attempt?: { id: string; state: 'running' | 'complete' | 'failed'; receipt?: unknown; receiptDigest?: string; fence?: unknown };
  cleanup?: { state: 'pending' | 'complete' | 'failed' };
}): { attemptId: string; mutation: 'active' | 'quiescent' | 'fenced'; runtime: 'pending' | 'complete' | 'failed';
  receipt?: unknown; receiptDigest?: string; cleanup: { state: 'pending' | 'complete' | 'failed' } } | null;
export function runtimeReceiptAcceptanceMarker(journal: Parameters<typeof runtimeObservationAcceptance>[1]): string | null;
