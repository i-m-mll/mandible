import { extractAtomicMergeState } from './auth-signature-verification.js';
import type { AuthRequest } from './types.js';

export function authRequestHasRetryableStatus(request: Pick<AuthRequest, 'status'>): boolean {
  return request.status === 'failed' || request.status === 'expired' || request.status === 'needs_rebase';
}

export function authRequestCanRepeatExecution(request: Pick<AuthRequest, 'output'>, ownsRuntimeHandoff: boolean): boolean {
  return !ownsRuntimeHandoff && !extractAtomicMergeState(request.output ?? '').prepared;
}
