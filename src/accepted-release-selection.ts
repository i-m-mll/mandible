import { resolveAcceptedRelease, readAcceptedReleaseReceipt } from '../scripts/accepted-release.mjs';
import type { AcceptedReleaseCandidate } from '../scripts/accepted-release.mjs';
import type { Db } from './db.js';

export const ACCEPTED_RELEASE_CHECKPOINT = 'accepted-release';
export interface AcceptedReleaseSelection { acceptanceId: string; reference: string }

/** Selection is an ordinary checkpoint action covered by the existing approval signature. */
export function acceptedReleaseSelection(db: Db, request: Record<string, any>, actions: readonly Record<string, any>[], verifyPackage = true) {
  const selections = actions.filter(action => action.kind === 'checkpoint_add' && action.payload?.kind === ACCEPTED_RELEASE_CHECKPOINT);
  if (selections.length !== 1 || selections[0].state !== 'staged') throw new Error('Exactly one non-vetoed accepted-release selection must be frozen before approval.');
  const selection = selections[0].payload.payload as AcceptedReleaseSelection;
  return validateAcceptedReleaseSelection(db, request, selection, verifyPackage);
}

export function validateAcceptedReleaseSelection(db: Db, request: Record<string, any>, selection: AcceptedReleaseSelection, verifyPackage = true) {
  if (!selection || typeof selection.acceptanceId !== 'string' || typeof selection.reference !== 'string') throw new Error('Invalid accepted-release selection.');
  const row = db.prepare('SELECT * FROM auth_candidate_acceptances WHERE id = ?').get(selection.acceptanceId) as Record<string, any> | undefined;
  const candidate: AcceptedReleaseCandidate = { pin_sha: request.merge_candidate_pin_sha, tree_sha: request.merge_candidate_tree_sha,
    base_sha: request.merge_preflight_base_sha, head_sha: request.merge_head_sha };
  if (!row || row.auth_request_id !== request.id || row.status !== 'passed'
      || Object.entries(candidate).some(([key, value]) => !value || row[key] !== value)
      || JSON.parse(row.result_json ?? 'null')?.receipt !== selection.reference) throw new Error('Selected acceptance does not pass for this exact request and candidate.');
  const resolved = verifyPackage ? resolveAcceptedRelease(selection.reference, candidate) : { receipt: readAcceptedReleaseReceipt(selection.reference, candidate) };
  if (resolved.receipt.acceptance.record_id && resolved.receipt.acceptance.record_id !== row.id
      || resolved.receipt.acceptance.request_id && resolved.receipt.acceptance.request_id !== request.id) throw new Error('Retained receipt names another acceptance or request.');
  return { selection: { acceptanceId: row.id, reference: selection.reference }, ...resolved };
}
