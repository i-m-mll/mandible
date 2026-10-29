import { resolveAcceptedRelease, readAcceptedReleaseReceipt, assertAcceptedReleaseAvailable } from '../scripts/accepted-release.mjs';
import type { AcceptedReleaseCandidate } from '../scripts/accepted-release.mjs';
import type { Db } from './db.js';
import type { AuthRequest } from './types.js';
import { addAuthRequestAction, updateAuthRequestAction, listAuthRequestActions } from './auth-actions.js';
import { appendAuthLifecycleEvent, listAuthLifecycleEvents } from './auth-lifecycle.js';
import { authRequestSnapshot } from './auth-request-snapshot.js';
import { systemAction } from './identity/resolver.js';

export const ACCEPTED_RELEASE_CHECKPOINT = 'accepted-release';
export interface AcceptedReleaseSelection { acceptanceId: string; reference: string }
const AUTOMATIC_BINDING_REASON = 'Bind accepted package from candidate acceptance.';
const selectionsIn = (snapshot: string) => JSON.parse(snapshot).actions.filter((action: Record<string, any>) =>
  action.kind === 'checkpoint_add' && action.payload?.kind === ACCEPTED_RELEASE_CHECKPOINT);

/** Called inside the verdict transaction, after its exact acceptance row passes. */
export function bindAcceptedRelease(db: Db, request: AuthRequest, recordId: string, targetIssue: string, now: number): void {
  const row = db.prepare('SELECT result_json FROM auth_candidate_acceptances WHERE id = ?').get(recordId) as { result_json: string };
  const selection = { acceptanceId: recordId, reference: JSON.parse(row.result_json ?? 'null')?.receipt };
  validateAcceptedReleaseSelection(db, request, selection, false);
  const priorSnapshot = authRequestSnapshot(db, request.id);
  const selections = selectionsIn(priorSnapshot);
  if (selections.length > 1 || selections.some((action: Record<string, any>) => action.state !== 'staged')) {
    throw new Error('Accepted-release selection is duplicated or vetoed.');
  }
  const existing = selections[0];
  if (existing?.target_issue_ref === targetIssue && existing.payload.payload?.acceptanceId === recordId
      && existing.payload.payload?.reference === selection.reference) return;

  // Lifecycle snapshots are the provenance of this ordinary action. A manual
  // edit/deletion is intent, including one made after the run started.
  const events = listAuthLifecycleEvents(db, request.id);
  const lastChange = events.filter((event, index) => JSON.stringify(selectionsIn(event.snapshot_json)) !==
    JSON.stringify(event.prior_snapshot_json ? selectionsIn(event.prior_snapshot_json)
      : index > 0 ? selectionsIn(events[index - 1].snapshot_json) : [])).at(-1);
  if (existing) {
    if (!lastChange || lastChange.authority_path !== 'system' || lastChange.evidence_method !== 'system_internal'
        || lastChange.reason !== AUTOMATIC_BINDING_REASON
        || JSON.stringify(selectionsIn(lastChange.snapshot_json)) !== JSON.stringify(selections)) {
      throw new Error('Accepted-release selection was explicitly staged or edited; preserve it.');
    }
  } else if (events.some(event => selectionsIn(event.snapshot_json).length ||
    (event.prior_snapshot_json && selectionsIn(event.prior_snapshot_json).length))) {
    throw new Error('Accepted-release selection was explicitly deleted; preserve it.');
  }
  const input = { kind: 'checkpoint_add', target_issue_ref: targetIssue,
    payload: { kind: ACCEPTED_RELEASE_CHECKPOINT, payload: selection } };
  if (existing) updateAuthRequestAction(db, request, existing.id, input, now);
  else addAuthRequestAction(db, request, input, now);
  acceptedReleaseSelection(db, request, listAuthRequestActions(db, request.id), false);
  appendAuthLifecycleEvent(db, { requestId: request.id, eventType: 'revised', priorStatus: request.status,
    nextStatus: request.status, actor: { ...systemAction(), authority_path: 'system' }, priorSnapshot,
    reason: AUTOMATIC_BINDING_REASON, occurredAt: now });
}

/** Selection is an ordinary checkpoint action covered by the existing approval signature. */
export function acceptedReleaseSelection(db: Db, request: Record<string, any>, actions: readonly Record<string, any>[], verifyPackage = true) {
  const selections = actions.filter(action => action.kind === 'checkpoint_add' && action.payload?.kind === ACCEPTED_RELEASE_CHECKPOINT);
  if (selections.length !== 1 || selections[0].state !== 'staged') throw new Error('Exactly one non-vetoed accepted-release selection must be frozen before approval.');
  const selection = selections[0].payload.payload as AcceptedReleaseSelection;
  return validateAcceptedReleaseSelection(db, request, selection, verifyPackage);
}

export function validateAcceptedReleaseSelection(db: Db, request: Record<string, any>, selection: AcceptedReleaseSelection, verifyPackage = true) {
  const selected = readAcceptedReleaseEvidenceSelection(db, request, selection);
  assertAcceptedReleaseAvailable(selection.reference);
  return verifyPackage ? { ...selected, ...resolveAcceptedRelease(selection.reference, selected.receipt.candidate) } : selected;
}

/** Historical selection remains verifiable after its executable custody was disposed. */
export function readAcceptedReleaseEvidenceSelection(db: Db, request: Record<string, any>, selection: AcceptedReleaseSelection) {
  if (!selection || typeof selection.acceptanceId !== 'string' || typeof selection.reference !== 'string') throw new Error('Invalid accepted-release selection.');
  const row = db.prepare('SELECT * FROM auth_candidate_acceptances WHERE id = ?').get(selection.acceptanceId) as Record<string, any> | undefined;
  const candidate: AcceptedReleaseCandidate = { pin_sha: request.merge_candidate_pin_sha, tree_sha: request.merge_candidate_tree_sha,
    base_sha: request.merge_preflight_base_sha, head_sha: request.merge_head_sha };
  if (!row || row.auth_request_id !== request.id || row.status !== 'passed'
      || Object.entries(candidate).some(([key, value]) => !value || row[key] !== value)
      || JSON.parse(row.result_json ?? 'null')?.receipt !== selection.reference) throw new Error('Selected acceptance does not pass for this exact request and candidate.');
  const resolved = { receipt: readAcceptedReleaseReceipt(selection.reference, candidate) };
  if (resolved.receipt.acceptance.record_id && resolved.receipt.acceptance.record_id !== row.id
      || resolved.receipt.acceptance.request_id && resolved.receipt.acceptance.request_id !== request.id) throw new Error('Retained receipt names another acceptance or request.');
  if (request.custody_work_unit_id && resolved.receipt.retention.work_unit !== request.custody_work_unit_id) {
    throw new Error('Retained package belongs to another delivery work unit.');
  }
  return { selection: { acceptanceId: row.id, reference: selection.reference }, ...resolved };
}
