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
  bindingDigest: string;
  recovery?: { digest: string };
}): 'accepted' | 'unaccepted' | 'inconsistent';
export function runtimeVerificationDisposition(
  run: Parameters<typeof runtimeObservationAcceptance>[0], journal: Parameters<typeof runtimeObservationAcceptance>[1] & { phase: string; launch?: unknown },
): 'inconsistent' | 'retired' | 'confirmed' | 'helper_pending' | 'acknowledge' | 'await_acceptance' | 'complete_accepted' | 'observe';
