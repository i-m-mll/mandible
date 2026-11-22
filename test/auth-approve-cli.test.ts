/** @vitest-environment node */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { computeAuthMergeReviewMetadata } from "../src/auth-context.js";
import { readRequestReview } from "../src/feedback/request-review.js";
import { addGrant } from "../src/permissions/store.js";
import { createUser, listCredentials } from "../src/users/store.js";
import { AUTH_MERGE_REVIEW, commitOnBranch, git } from "./helpers/auth-queue-fixtures.js";
import { operatorCliRig, type OperatorCliRig } from "./helpers/operator-cli-rig.js";

let harness: OperatorCliRig;
beforeEach(async () => { harness = await operatorCliRig(); });
afterEach(async () => harness.close());

function revision(id: string): string {
  return String(harness.r.queue.lifecycleRevision(id));
}

function approve(args: string[], env?: Record<string, string>) {
  return harness.mandible(["auth", "approve", ...args], { env });
}

it("approves the saved frozen review with one touch, even when publication settles before the subscription", async () => {
  const { r } = harness;
  const repo = fs.realpathSync(r.repo);
  const branch = "feature/terminal-approve";
  const filename = "proposal.md";
  commitOnBranch(repo, branch, { [filename]: "# Proposed wording\n" });
  const { changeReport } = await computeAuthMergeReviewMetadata(repo, "main", branch);
  const request = await r.queue.submit({ ...AUTH_MERGE_REVIEW, type: "merge", cwd: repo, target_repo_root: repo,
    repo: path.basename(r.repo), head_branch: branch, base_branch: "main", merge_head_sha: changeReport.comparison.head_sha,
    command: `mandible auth merge ${branch} --into main`, title: "Terminal approval", change_report: changeReport,
    narrative: ':::spec-item{key="context" type="verdict" required="false"}\nKeep this explanation?\n:::\n',
  }, r.operatorId);
  const actor = { user_id: r.operatorId, evidence_method: "local_default", authority_path: "operator" as const };
  const precondition = () => ({ expected_revision: r.queue.lifecycleRevision(request.id)!,
    expected_custody_generation: r.queue.requestResponsibility(request).custody_generation });
  const first = await readRequestReview(r.db, request, actor.user_id);
  const text = "# Operator wording\n";
  const draft = await r.queue.mutateRequestReviewDraft(request.id, actor, {
    ...precondition(), round_id: first.round.id, path: filename, expected_generation: 0,
    mutation: { operation: "save", text },
  });
  const frozen = await r.queue.freezeRequestReview(request.id, actor, {
    ...precondition(), round_id: first.round.id, annotation_event_ids: [],
    draft_snapshot: [{ path: draft.path, generation: draft.generation }],
  });
  const reviewed = await readRequestReview(r.db, frozen, actor.user_id);
  const binding = reviewed.round.bindings.find(item => item.source.kind === "request_file" && item.source.side === "after")!;
  await r.queue.annotateRequestReview(request.id, actor, {
    ...precondition(), document_binding_id: binding.id,
    mutation: { operation: "set", kind: "comment", start_offset: 2, end_offset: text.trimEnd().length,
      quote: text.trimEnd().slice(2), body: "Use the reviewed wording." },
  });
  const name = request.id.slice(0, 8);
  const reviewFile = path.join(repo, ".git", "saved-review.json");
  const saveReview = async () => {
    const saved = await harness.mandible(["auth", "review", "approval", name]).done;
    expect(saved.code, saved.stderr).toBe(0);
    fs.writeFileSync(reviewFile, saved.stdout);
  };
  await saveReview();
  r.queue.answerRequestNarrative(request.id, actor, {
    ...precondition(), round_id: reviewed.round.id, directive_key: "context",
    mutation: { operation: "set", expected_response_event_id: null, value: { verdict: "keep" } },
  });
  const stale = await approve([name, "--review", reviewFile]).done;
  expect(stale.code).toBe(1);
  expect(stale.stderr).toContain("stale_answer");
  expect(r.signer.touches).toHaveLength(0);

  await saveReview();
  harness.holdSubscription(() => harness.resolvedBroadcast(request.id));
  const result = await approve([name, "--review", reviewFile]).done;
  expect(result.code, result.stderr).toBe(0);
  expect(r.signer.touches).toHaveLength(1);
  expect(git(r.repo, ["rev-parse", "main^2"])).toBe(frozen.merge_effective_head_sha);
  expect(git(r.repo, ["show", `main:${filename}`])).toBe(text.trimEnd());
  const approvalKey = listCredentials(r.db, r.operatorId).find((credential) => credential.id === r.enclaveCredentialId)!;
  const signers = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "approve-cli-signers-")), "allowed_signers");
  fs.writeFileSync(signers, `* ${approvalKey.public_material}\n`);
  git(r.repo, ["-c", "gpg.format=ssh", "-c", `gpg.ssh.allowedSignersFile=${signers}`, "verify-commit", "main"]);
});

it("refuses a stale revision without a touch", async () => {
  const { r } = harness;
  const request = await r.submit("feature/stale-revision");
  const result = await approve([request.id, "--revision", String(Number(revision(request.id)) - 1)]).done;
  expect(result.code).toBe(1);
  expect(r.signer.touches).toHaveLength(0);
  expect((await r.queue.getRequest(request.id))!.status).toBe("pending");
});

it("a cancelled touch leaves the request pending", async () => {
  const { r } = harness;
  const request = await r.submit("feature/cancelled-touch");
  r.signer.next.push({ result: "cancelled" });
  const result = await approve([request.id, "--revision", revision(request.id)]).done;
  expect(result.code).toBe(1);
  expect(r.signer.touches).toHaveLength(1);
  expect((await r.queue.getRequest(request.id))!.status).toBe("pending");
});

it("TERM while the sheet is up dismisses it and leaves the request pending", async () => {
  const { r } = harness;
  const request = await r.submit("feature/terminated");
  const held = r.signer.block();
  const run = approve([request.id, "--revision", revision(request.id)]);
  await held.entered;
  run.child.kill("SIGTERM");
  const result = await run.done;
  held.release();
  expect(result.code).toBe(130);
  expect(harness.posts("cancel-proof")).toBe(1);
  await expect.poll(() => (r.queue as unknown as { operatorProofInFlight: Map<string, unknown> }).operatorProofInFlight.size).toBe(0);
  expect((await r.queue.getRequest(request.id))!.status).toBe("pending");
});

it("an agent context is refused before any approval request", async () => {
  const { r } = harness;
  const request = await r.submit("feature/agent-context");
  const result = await approve([request.id, "--revision", revision(request.id)], { CLAUDE_CODE_SESSION_ID: "agent-session" }).done;
  expect(result.code).toBe(1);
  expect(harness.posts("approve")).toBe(0);
  expect(r.signer.touches).toHaveLength(0);
});

it("a non-operator holding approve_auth is refused with 403, not a server error", async () => {
  const { r } = harness;
  const request = await r.submit("feature/deputy");
  const deputy = createUser(r.db, { slug: "deputy", kind: "human", display_name: "Deputy" });
  addGrant(r.db, { subject_type: "user", subject: deputy.id, permission: "approve_auth" });
  const response = await fetch(`${harness.base}/api/auth/request/${request.id}/approve`, {
    method: "POST", headers: { Authorization: `Bearer ${harness.auth.mintApiToken(deputy.id).token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ lifecycle_revision: r.queue.lifecycleRevision(request.id) }),
  });
  expect(response.status).toBe(403);
  expect(r.signer.touches).toHaveLength(0);
});
