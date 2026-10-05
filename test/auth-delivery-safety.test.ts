import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthQueue } from "../src/auth-queue.js";
import { AuthHookManager } from "../src/auth-hooks.js";
import { verifyRuntimeHandoffPublication } from "../src/runtime-handoff-proof.js";
import { getAttributionEvidence } from "../src/users/store.js";
import {
  commitOnBranch, configureSigningCredential, createAuthCheckRepo, createLedgerIssue,
  createLedgerProject, createMigratedDb, createNoopHookManager, git, registerWorkRepo,
} from "./helpers/auth-queue-fixtures.js";
import { publishTestCandidate } from "./helpers/auth-delivery-fixtures.js";

let repo: string;
let db: ReturnType<typeof createMigratedDb>;
let queue: AuthQueue;
let operatorId: string;
let hookCalls: number;
let executorCalls: number;

beforeEach(() => {
  repo = createAuthCheckRepo();
  db = createMigratedDb();
  commitOnBranch(repo, "feature/delivery", { "delivered.txt": "reviewed bytes\n" });
  operatorId = configureSigningCredential(db, repo, "ssh_key").operatorId;
  fs.appendFileSync(path.join(repo, ".git", "info", "exclude"), "\n.mandible-test-signing-key*\n");
  registerWorkRepo(db, repo);
  createLedgerProject(db, repo);
  git(repo, ["config", "core.hooksPath", ".git/hooks"]);
  hookCalls = 0;
  executorCalls = 0;
  const hooks = createNoopHookManager();
  hooks.executeHooks = async () => { hookCalls += 1; return []; };
  queue = new AuthQueue({ db, hookManager: hooks, backgroundMaintenance: false,
    executor: async () => { executorCalls += 1; return new Promise(() => {}); },
  });
});
afterEach(() => { queue.dispose(); db.close(); fs.rmSync(repo, { recursive: true, force: true }); });

function submitMerge(issueClosures: string[] = []) {
  return queue.submit({ type: "merge", title: "Publish exact delivery", command: "mandible auth merge feature/delivery --into main",
    repo: path.basename(repo), cwd: repo, head_branch: "feature/delivery", merge_head_sha: git(repo, ["rev-parse", "feature/delivery"]), base_branch: "main", execution_mode: "local", issue_closures: issueClosures });
}

function protectedState() {
  return { ref: git(repo, ["rev-parse", "main"]), index: git(repo, ["write-tree"]),
    files: fs.readFileSync(path.join(repo, "shared.txt"), "utf8"), merge: fs.existsSync(path.join(repo, ".git", "MERGE_HEAD")) };
}

describe("protected delivery evidence", () => {
  it("runs frozen native post-hooks once with original arguments and refuses changed hook bytes", async () => {
    queue.dispose();
    const hooks = new AuthHookManager(db);
    queue = new AuthQueue({ db, hookManager: hooks, backgroundMaintenance: false, executor: async () => new Promise(() => {}) });
    for (const name of ["post-commit", "post-merge"]) fs.writeFileSync(path.join(repo, ".git", "hooks", name), `#!/bin/sh\nprintf '${name}:%s:%s:%s\\n' "$#" "\${1-}" "$(git rev-parse ORIG_HEAD)" >> .git/native-audit\n`, { mode: 0o755 });
    const request = submitMerge();
    await queue.approveWithOperatorProof(request.id, operatorId);
    const publication = publishTestCandidate(repo, queue.getRequest(request.id)!);
    queue.setResult(request.id, 0, publication.output);
    await hooks.runPending(queue.getRequest(request.id)!);
    expect(fs.readFileSync(path.join(repo, ".git", "native-audit"), "utf8")).toBe(`post-commit:0::${request.merge_preflight_base_sha}\npost-merge:1:0:${request.merge_preflight_base_sha}\n`);
    await hooks.runPending(queue.getRequest(request.id)!);
    expect(hooks.listRuns(request.id).every(run => run.state === "complete" && run.attempts === 1)).toBe(true);
    commitOnBranch(repo, "feature/changed-hook", { "other.txt": "next bytes\n" });
    const next = queue.submit({ type: "merge", title: "Changed hook", command: "mandible auth merge feature/changed-hook --into main", cwd: repo, repo: path.basename(repo), base_branch: "main", head_branch: "feature/changed-hook", merge_head_sha: git(repo, ["rev-parse", "feature/changed-hook"]), execution_mode: "local" });
    await queue.approveWithOperatorProof(next.id, operatorId);
    fs.appendFileSync(path.join(repo, ".git", "hooks", "post-merge"), "# changed after review\n");
    queue.setResult(next.id, 0, publishTestCandidate(repo, queue.getRequest(next.id)!).output);
    await hooks.runPending(queue.getRequest(next.id)!);
    expect(hooks.getRun(next.id, "native-git-post-merge")?.exit_code).not.toBe(0);
    expect(hooks.convergence(next.id).state).toBe("pending");
  });

  it("reconstructs only the frozen signed first-upgrade candidate and refuses binding or checkout drift", async () => {
    queue.dispose();
    const hooks = new AuthHookManager(db);
    db.prepare("UPDATE auth_hooks SET repo_pattern = ?, command = ? WHERE id = ?").run("*", "exit 75", "builtin-mandible-rebuild");
    queue = new AuthQueue({ db, hookManager: hooks, backgroundMaintenance: false, executor: async () => new Promise(() => {}) });
    const request = submitMerge();
    await queue.approveWithOperatorProof(request.id, operatorId);
    const publication = publishTestCandidate(repo, queue.getRequest(request.id)!);
    const run = hooks.getRun(request.id, "builtin-mandible-rebuild")!;
    const legacyOutput = publication.output.split("\n").find(line => line.startsWith("MANDIBLE_MERGE_RESULT "))!;
    db.prepare("UPDATE auth_requests SET output = ?, merge_preflight_base_sha = NULL, merge_candidate_tree_sha = NULL, merge_candidate_pin_sha = NULL, merge_atomic_enabled = 0 WHERE id = ?").run(legacyOutput, request.id);
    const binding = { requestId: request.id, executionId: run.id, hookId: run.hook_id, commandDigest: run.command_digest, root: repo };
    const proof = verifyRuntimeHandoffPublication(db, binding);
    expect(proof).toMatchObject({ mergeCommit: publication.mergeSha, mergeBase: request.merge_preflight_base_sha, mergeHead: request.merge_head_sha, frozenCandidate: { tree: request.merge_candidate_tree_sha } });
    expect(() => verifyRuntimeHandoffPublication(db, { ...binding, commandDigest: "f".repeat(64) })).toThrow("binding differs");
    git(repo, ["update-ref", "refs/heads/main", request.merge_preflight_base_sha!, publication.mergeSha]);
    expect(() => verifyRuntimeHandoffPublication(db, { ...binding, ...proof })).toThrow("checkout differs");
  });

  it("keeps missing, cancelled, and drifted proof pending without starting execution", async () => {
    const request = queue.submit({ type: "config-change", title: "Change configuration", command: "echo approved", cwd: repo });
    const before = protectedState();
    expect(() => queue.approve(request.id)).toThrow("signing proof");
    const cancelled = queue.approveWithOperatorProof(request.id, operatorId);
    queue.cancelOperatorProof(request.id, operatorId);
    await expect(cancelled).rejects.toThrow("cancelled");
    expect(queue.getRequest(request.id)?.status).toBe("pending");
    const drifted = queue.approveWithOperatorProof(request.id, operatorId);
    queue.update(request.id, { title: "Changed reviewed action" });
    await expect(drifted).rejects.toThrow("reviewed request changed");
    expect(queue.getRequest(request.id)?.status).toBe("pending");
    expect(executorCalls).toBe(0);
    expect(hookCalls).toBe(0);
    expect(protectedState()).toEqual(before);
  });

  it("records verified action-bound proof for consequential non-Git approval", async () => {
    const request = queue.submit({ type: "config-change", title: "Change configuration", command: "echo approved", cwd: repo });
    const approved = await queue.approveWithOperatorProof(request.id, operatorId);
    expect(approved.status).toBe("executing");
    const evidence = getAttributionEvidence(db, approved.execution_evidence_id!);
    expect(evidence?.evidence_method).toBe("credential_signature");
    expect(evidence?.details).toMatchObject({ verified: true, signer_user_id: operatorId, auth_request_id: request.id });
    expect(JSON.parse(String(evidence?.details.challenge))).toMatchObject({ request_id: request.id });
    expect(queue.listLifecycleEvents(request.id).find((event) => event.event_type === "approved")?.evidence_method).toBe("credential_signature");
  });

  it("refuses native preparation hooks before proof or protected mutation", async () => {
    const request = submitMerge();
    const before = protectedState();
    fs.writeFileSync(path.join(repo, ".git", "hooks", "pre-merge-commit"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    await expect(queue.approveWithOperatorProof(request.id, operatorId)).rejects.toThrow("unsupported native hooks");
    expect(protectedState()).toEqual(before);
    expect(queue.getRequest(request.id)?.status).toBe("pending");
    expect(executorCalls).toBe(0);
  });

  it("does not close an issue or run hooks when an executor claims zero without a publication receipt", async () => {
    const project = createLedgerProject(db, repo);
    const issue = createLedgerIssue(db, project.project.id, "closure-proof");
    const request = submitMerge([issue.id]);
    await queue.approveWithOperatorProof(request.id, operatorId);
    const before = protectedState();
    const result = queue.setResult(request.id, 0, "ok");
    expect(result.exit_code).not.toBe(0);
    expect(result.error).toContain("publication receipt");
    expect(db.prepare("SELECT status FROM ledger_issues WHERE id = ?").get(issue.id)).toMatchObject({ status: "open" });
    expect(hookCalls).toBe(0);
    expect(protectedState()).toEqual(before);
  });

  it("retains applied publication state when its result is missing and completes on exact recovered evidence", async () => {
    const request = submitMerge();
    await queue.approveWithOperatorProof(request.id, operatorId);
    const publication = publishTestCandidate(repo, queue.getRequest(request.id)!);
    const withoutReceipt = publication.output.split("MANDIBLE_MERGE_RESULT")[0]!;
    const stuck = queue.setResult(request.id, 0, withoutReceipt);
    expect(stuck.status).toBe("executing");
    expect(stuck.merge_atomic_enabled).toBe(true);
    expect(() => queue.update(request.id, { status: "pending" })).toThrow();
    const recovered = queue.setResult(request.id, 0, publication.output);
    expect(recovered).toMatchObject({ status: "completed", exit_code: 0 });
    const evidence = getAttributionEvidence(db, recovered.execution_evidence_id!);
    expect(evidence?.details).toMatchObject({ publication_verified: true, verified: true, commit_sha: publication.mergeSha, signer_user_id: operatorId });
    expect(git(repo, ["rev-parse", "main"])).toBe(publication.mergeSha);
    expect(() => queue.setResult(request.id, 0, publication.output)).toThrow();
    expect(executorCalls).toBe(0);
  });

  it("keeps nonzero post-publication result reports recoverable", async () => {
    const request = submitMerge();
    await queue.approveWithOperatorProof(request.id, operatorId);
    const publication = publishTestCandidate(repo, queue.getRequest(request.id)!);
    const reported = queue.setResult(request.id, 75, publication.output.split("MANDIBLE_MERGE_RESULT")[0]!, "checkout cleanup interrupted");
    expect(reported).toMatchObject({ status: "executing", exit_code: null, merge_atomic_enabled: true });
    expect(() => queue.retry(request.id)).toThrow();
    const completed = queue.setResult(request.id, 0, publication.output);
    expect(completed).toMatchObject({ status: "completed", exit_code: 0 });
    expect(git(repo, ["rev-parse", "main"])).toBe(publication.mergeSha);
    expect(executorCalls).toBe(0);
  });

  it("recovers the original receipt after a later signed publication without changing its checkout", async () => {
    const request = submitMerge();
    await queue.approveWithOperatorProof(request.id, operatorId);
    const first = publishTestCandidate(repo, queue.getRequest(request.id)!);
    queue.setResult(request.id, 75, first.output.split("MANDIBLE_MERGE_RESULT")[0]!);
    commitOnBranch(repo, "feature/later", { "later.txt": "later bytes\n" });
    const later = queue.submit({ type: "merge", title: "Later publication", command: "mandible auth merge feature/later --into main", repo: path.basename(repo), cwd: repo, base_branch: "main", head_branch: "feature/later", merge_head_sha: git(repo, ["rev-parse", "feature/later"]), execution_mode: "local" });
    await queue.approveWithOperatorProof(later.id, operatorId);
    const second = publishTestCandidate(repo, queue.getRequest(later.id)!);
    const before = protectedState();
    const internals = queue as unknown as { inspectStaleMerge(request: unknown): unknown; finishRecoveredAtomicMerge(request: unknown, sha: string): Promise<void> };
    expect(internals.inspectStaleMerge(queue.getRequest(request.id)!)).toEqual({ outcome: "atomic_applied", mergeSha: first.mergeSha });
    const callsBeforeRecovery = executorCalls;
    await internals.finishRecoveredAtomicMerge(queue.getRequest(request.id)!, first.mergeSha);
    const completed = queue.getRequest(request.id)!;
    expect(completed).toMatchObject({ status: "completed", exit_code: 0 });
    expect(getAttributionEvidence(db, completed.execution_evidence_id!)?.details.commit_sha).toBe(first.mergeSha);
    expect(git(repo, ["rev-parse", "main"])).toBe(second.mergeSha);
    expect(protectedState()).toEqual(before);
    expect(fs.readFileSync(path.join(repo, "later.txt"), "utf8")).toBe("later bytes\n");
    expect(executorCalls).toBe(callsBeforeRecovery);
  });

  it("preserves terminal requests rather than inferring delivery from branch ancestry", () => {
    const request = submitMerge();
    git(repo, ["merge", "--no-ff", "--no-edit", "feature/delivery"]);
    queue.dispose();
    queue = new AuthQueue({ db, hookManager: createNoopHookManager(), backgroundMaintenance: false });
    expect(queue.getRequest(request.id)?.status).toBe("pending");
    expect(hookCalls).toBe(0);
  });
});
