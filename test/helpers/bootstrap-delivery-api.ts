import assert from 'node:assert/strict';
import { canonicalizeChangeMessage, changeMessageDigest, validateCanonicalChangeMessage } from '../../src/auth-change-message.js';
import type { AuthRequest, AuthRequestLifecycleEvent } from '../../src/types.js';

type Api = { baseUrl: string; headers: HeadersInit };
export type BootstrapDeliveryDetail = AuthRequest & { lifecycle_events: AuthRequestLifecycleEvent[] };
export type BootstrapDeliveryInputs = Api & {
  cwd: string;
  repo: string;
  headBranch: string;
  baseBranch: string;
  headSha: string;
  baseSha: string;
  issueRef: string;
  workUnitId: string;
  requesterCredentialId: string;
  commitMessage: string;
  verification: string;
};

async function jsonRequest(api: Api, route: string, method = 'GET', body?: unknown) {
  const headers = new Headers(api.headers);
  headers.set('Content-Type', 'application/json');
  const response = await fetch(new URL(route, api.baseUrl), {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(60_000),
  });
  const value = await response.json();
  assert.ok(response.ok, `${method} ${route} failed (${response.status}): ${JSON.stringify(value)}`);
  return value;
}

/** Establish committed custody through the normal durable-credential mechanism. */
export async function activateBootstrapWorkUnit(api: Api, issueRef: string, repo: string, branch: string): Promise<string> {
  const result = await jsonRequest(api, '/api/work-units/activate', 'POST', {
    issue_id: issueRef, repo_id: repo, branch,
  }) as { id: string; state: string; ledger_issue_id: string | null };
  assert.equal(result.state, 'committed');
  assert.ok(result.ledger_issue_id, `Delivery work unit must resolve its canonical issue: ${JSON.stringify(result)}`);
  assert.ok(result.id);
  return result.id;
}

/** Normal authenticated submission; the daemon owns custody, review and candidate preparation. */
export async function submitBootstrapDelivery(input: BootstrapDeliveryInputs): Promise<BootstrapDeliveryDetail> {
  const canonicalMessage = canonicalizeChangeMessage(input.commitMessage);
  assert.equal(validateCanonicalChangeMessage(canonicalMessage, { verification: input.verification }), null);
  const command = `mandible auth merge ${input.headBranch} --into ${input.baseBranch} --preserve-head-branch`;
  const result = await jsonRequest(input, '/api/auth/request', 'POST', {
    type: 'merge', title: 'Qualified candidate bootstrap delivery', command,
    cwd: input.cwd, target_repo_root: input.cwd, repo: input.repo,
    head_branch: input.headBranch, base_branch: input.baseBranch, execution_mode: 'daemon',
    issue_references: [input.issueRef], canonical_message: true,
    commit_message: input.commitMessage, verification: input.verification,
  }) as { request_id: string };
  assert.ok(result.request_id);
  const detail = await readBootstrapDelivery(input, result.request_id);
  assert.equal(detail.status, 'pending');
  assert.equal(detail.command, command);
  assert.equal(detail.merge_head_sha, input.headSha);
  assert.equal(detail.merge_preflight_base_sha, input.baseSha);
  assert.equal(detail.custody_work_unit_id, input.workUnitId);
  assert.equal(detail.requester_credential_id, input.requesterCredentialId);
  assert.equal(detail.requester_evidence_method, 'api_token');
  assert.equal(detail.commit_message, canonicalMessage);
  assert.equal(detail.commit_message_digest, changeMessageDigest(canonicalMessage));
  assert.ok(detail.merge_candidate_pin_sha, 'Submission must retain its exact candidate');
  assert.ok(detail.merge_candidate_tree_sha, 'Submission must retain its exact candidate tree');
  assert.equal(detail.merge_atomic_enabled, false, 'Atomic authority is decided by operator approval');
  return detail;
}

export async function readBootstrapDelivery(api: Api, requestId: string): Promise<BootstrapDeliveryDetail> {
  return await jsonRequest(api, `/api/auth/request/${encodeURIComponent(requestId)}`) as BootstrapDeliveryDetail;
}

/**
 * Runtime self-update approval requires a passing daemon-run acceptance of the
 * exact candidate. Run (or join) it through the real route and await its result.
 */
export async function acceptBootstrapDelivery(api: Api, requestId: string, timeoutMs = 15 * 60 * 1000): Promise<void> {
  const route = `/api/auth/request/${encodeURIComponent(requestId)}/candidate-acceptance`;
  await jsonRequest(api, route, 'POST', {});
  const end = Date.now() + timeoutMs;
  for (;;) {
    const { acceptance } = await jsonRequest(api, route) as { acceptance: { state: string; reason: string | null } | null };
    if (acceptance?.state === 'passed') return;
    assert.notEqual(acceptance?.state, 'failed', `Candidate acceptance failed: ${acceptance?.reason}`);
    assert.ok(Date.now() < end, `Candidate acceptance did not finish within ${timeoutMs}ms`);
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
}

/** Real operator route: no manual flags, clearance, injected approval environment, or row writes. */
export async function approveBootstrapDelivery(api: Api, requestId: string): Promise<void> {
  const result = await jsonRequest(api, `/api/auth/request/${encodeURIComponent(requestId)}/approve`, 'POST', {}) as { request_id: string };
  assert.equal(result.request_id, requestId);
}

/** May be checked before or after handoff; authority remains the original exact request. */
export function assertBootstrapOperatorProof(detail: BootstrapDeliveryDetail, operatorId: string, signingCredentialId: string): void {
  assert.equal(detail.merge_atomic_enabled, true, 'The new executor must select signed-candidate publication');
  const approval = detail.lifecycle_events.find(event => event.event_type === 'approved');
  assert.ok(approval, 'Approval must have an immutable lifecycle event');
  assert.equal(approval.actor_user_id, operatorId);
  assert.equal(approval.evidence_method, 'credential_signature');
  assert.equal(approval.credential_id, signingCredentialId);
  assert.ok(approval.evidence_id, 'Approval must retain verified action-bound signing evidence');
}
