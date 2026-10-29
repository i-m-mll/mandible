import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { Db } from './db.js';
import type { AuthLifecycleActor, AuthRequest } from './types.js';
import { authRequestSnapshot } from './auth-request-snapshot.js';
import { appendAuthLifecycleEvent } from './auth-lifecycle.js';
import { readAcceptedReleaseEvidenceSelection } from './accepted-release-selection.js';
import { findRuntimeDeliveryIntents } from './runtime-handoff-proof.js';
import { disposeAcceptedRelease, acceptedReleaseFilesystemReferences } from '../scripts/accepted-release.mjs';
import { acceptedReleaseDatabaseReferences } from '../scripts/accepted-release-retention.mjs';
import { ownedRunReceipt, inspectRunConsumersAsync } from '../scripts/owned-run.mjs';

const rebuild = 'builtin-mandible-rebuild';
const fail = (reason: string): never => { throw new Error(`Failed delivery retirement refused: ${reason}`); };

function binding(db: Db, request: AuthRequest) {
  if (request.type !== 'merge' || request.status !== 'completed' || request.exit_code !== 0 || !request.merge_finalized_at) fail('requires a successful finalized merge');
  const hook = db.prepare('SELECT * FROM auth_hook_executions WHERE auth_request_id = ? AND hook_id = ?').get(request.id, rebuild) as Record<string, any> | undefined;
  if (!hook || !hook.required || !['failed', 'retired'].includes(hook.state) || !hook.finished_at || hook.attempts < 1) fail('requires a failed terminal builtin delivery');
  const history = JSON.parse(hook!.attempt_history);
  if (!Number.isInteger(hook!.exit_code) || hook!.exit_code === 0 || !Array.isArray(history) || history.length !== hook!.attempts
      || history.some((attempt: any, index: number) => attempt.attempt !== index + 1 || attempt.outcome !== 'failed' || !Number.isInteger(attempt.exit_code)
        || attempt.exit_code === 0 || !Number.isFinite(attempt.finished_at))) fail('attempt settlement is uncertain; timeout or interrupted work cannot be retired');
  if (createHash('sha256').update(hook!.command).digest('hex') !== hook!.command_digest) fail('hook command digest differs');
  const actions = db.prepare("SELECT id, state, payload FROM auth_request_actions WHERE auth_request_id = ? AND kind = 'checkpoint_add' AND json_extract(payload, '$.kind') = 'accepted-release'").all(request.id) as Array<{ id: string; state: string; payload: string }>;
  if (actions.length !== 1 || !['staged', 'applied'].includes(actions[0].state)) fail('requires one unchanged selected acceptance');
  const selection = JSON.parse(actions[0].payload).payload;
  const frozen = db.prepare("SELECT snapshot_json, snapshot_sha256 FROM auth_request_lifecycle_events WHERE auth_request_id = ? AND next_status IN ('approved', 'executing') ORDER BY revision DESC LIMIT 1").get(request.id) as { snapshot_json: string; snapshot_sha256: string } | undefined;
  if (!frozen || createHash('sha256').update(frozen.snapshot_json).digest('hex') !== frozen.snapshot_sha256) fail('frozen approval is missing or corrupt');
  const snapshot = JSON.parse(frozen!.snapshot_json);
  if (snapshot.request.id !== request.id || snapshot.request.approved_by_user_id !== request.approved_by_user_id) fail('approval identity changed');
  const approved = snapshot.actions.filter((action: any) => action.kind === 'checkpoint_add' && action.payload?.kind === 'accepted-release');
  if (approved.length !== 1 || approved[0].id !== actions[0].id || JSON.stringify(approved[0].payload.payload) !== JSON.stringify(selection)) fail('selected acceptance differs from approval');
  for (const key of ['merge_candidate_pin_sha', 'merge_candidate_tree_sha', 'merge_preflight_base_sha', 'merge_head_sha']) {
    if (!request[key as keyof AuthRequest] || request[key as keyof AuthRequest] !== snapshot.request[key]) fail('reviewed candidate changed');
  }
  const intents = findRuntimeDeliveryIntents(db, [{ requestId: request.id, executionId: hook!.id, hookId: rebuild, commandDigest: hook!.command_digest }]);
  if (intents.size) fail('publication was admitted; use handoff lifecycle');
  return { hook: hook!, selection, fingerprint: JSON.stringify({ hook, actions }) };
}

export async function retireFailedDelivery(db: Db, request: AuthRequest, reason: string, actor: AuthLifecycleActor,
  { home, authorize, now = Date.now, inspect = inspectRunConsumersAsync }: { home: string; authorize: () => AuthRequest; now?: () => number; inspect?: typeof inspectRunConsumersAsync }) {
  if (!reason.trim()) fail('a reason is required');
  authorize();
  const initial = binding(db, request);
  const { receipt } = readAcceptedReleaseEvidenceSelection(db, request, initial.selection);
  const root = receipt.package.handle.root;
  const journal = path.join(home, 'config/local-sessions/handoff', `${request.id}-${initial.hook.id}`);
  if (fs.existsSync(journal) && (!fs.lstatSync(journal).isDirectory() || fs.lstatSync(journal).isSymbolicLink() || fs.readdirSync(journal).length)) fail('handoff material exists; use handoff lifecycle');
  const recheck = () => {
    const current = authorize();
    const observed = binding(db, current);
    if (observed.fingerprint !== initial.fingerprint) fail('hook or selection changed during observation');
    if (fs.existsSync(journal) && fs.readdirSync(journal).length) fail('handoff material appeared during observation');
    return current;
  };
  if (!fs.existsSync(root) || !fs.existsSync(path.join(root, 'metadata.json'))) {
    if (initial.hook.state !== 'retired') fail('payload disappeared without a retirement disposition');
    const outcome = ownedRunReceipt(receipt.package.handle);
    if (!outcome?.generatedRecovery) fail('interrupted cleanup has no recovery authority');
    recheck();
    const refs = [...acceptedReleaseDatabaseReferences(db, initial.selection.reference, receipt), ...acceptedReleaseFilesystemReferences(home, initial.selection.reference)];
    if (refs.length) fail(`operational references remain: ${refs.join(', ')}`);
    return { state: 'retired' as const, execution_id: initial.hook.id, cleanup: outcome!.cleanup === 'completed' && !fs.existsSync(root) ? 'completed' : 'pending' };
  }
  const claim = (mark: () => void) => db.transaction(() => {
    const current = recheck();
    if (initial.hook.state !== 'retired') {
      const priorSnapshot = authRequestSnapshot(db, request.id);
      const result = db.prepare("UPDATE auth_hook_executions SET state = 'retired' WHERE id = ? AND state = 'failed'").run(initial.hook.id);
      if (result.changes !== 1) fail('hook changed before retirement');
      const refs = acceptedReleaseDatabaseReferences(db, initial.selection.reference, receipt);
      if (refs.length) fail(`operational references remain: ${refs.join(', ')}`);
      mark();
      appendAuthLifecycleEvent(db, { requestId: request.id, eventType: 'revised', priorStatus: current.status, nextStatus: current.status,
        actor, priorSnapshot, occurredAt: now(), reason: `Retired failed pre-install execution ${initial.hook.id}; command ${initial.hook.command_digest}; accepted receipt ${initial.selection.reference}. ${reason.trim()}` });
    } else {
      const refs = acceptedReleaseDatabaseReferences(db, initial.selection.reference, receipt);
      if (refs.length) fail(`operational references remain: ${refs.join(', ')}`);
      mark();
    }
  }).immediate();
  const result = await disposeAcceptedRelease(initial.selection.reference, receipt.candidate, reason, { home, claim, deferCleanup: true, inspect });
  return { state: 'retired' as const, execution_id: initial.hook.id, cleanup: result.action === 'delete-owned' ? 'completed' : 'pending' };
}
