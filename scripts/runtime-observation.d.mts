export class RuntimeObservationError extends Error {
  readonly code: string;
  readonly evidence: unknown;
  readonly outcome: 'pending' | 'failed';
  constructor(code: string, message: string, evidence?: unknown, outcome?: 'pending' | 'failed');
  toJSON(): { schema: string; outcome: 'pending' | 'failed'; code: string; message: string; evidence: unknown };
}
export function observationPending(error: unknown): error is RuntimeObservationError;
export function decodeObservationError(text: string): RuntimeObservationError | null;
export function runtimeObservationAcceptance(run: {
  id: string; auth_request_id: string; hook_id: string; command_digest: string; state: string; output: string;
} | null | undefined, journal: {
  binding: { executionId: string; requestId: string; hookId: string; commandDigest: string };
  recovery?: { digest: string };
}): 'accepted' | 'unaccepted' | 'inconsistent';
