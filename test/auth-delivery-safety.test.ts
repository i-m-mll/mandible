import { createInstalledServiceHookManager, AUTH_COMMAND_REVIEW, AUTH_MERGE_REVIEW } from "./helpers/auth-queue-fixtures.js";
import fs from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthQueue } from "../src/auth-queue.js";
import type { RuntimeHandoffJournal } from "../src/auth-hooks.js";
import { validateRuntimeSource, verifyRuntimeHandoffPublication, freezeRuntimeHandoffPublication, verifyRuntimeHandoffAuthority } from "../src/runtime-handoff-proof.js";
import { addOrUpdateCheckout } from "../src/ledger/project-registry.js";
import { getAttributionEvidence } from "../src/users/store.js";
import {
  commitOnBranch, configureSigningCredential, tamperLooseGitObject, createAuthCheckRepo, createLedgerIssue,
  createLedgerProject, createMigratedDb, createNoopHookManager, git, recordPassingCandidateAcceptance, registerWorkRepo,
} from "./helpers/auth-queue-fixtures.js";
import { publishTestCandidate } from "./helpers/auth-delivery-fixtures.js";
import { runtimeObservationAcceptance } from "../scripts/runtime-observation.mjs";
import { waitUntil } from "./helpers/wait-until.js";

let repo: string;
let db: ReturnType<typeof createMigratedDb>;
let queue: AuthQueue;
let operatorId: string;
let hookCalls: number;
let executorCalls: number;

beforeEach(() => {
  repo = createAuthCheckRepo();
  db = createMigratedDb();
  operatorId = configureSigningCredential(db, repo, "ssh_key").operatorId;
  fs.appendFileSync(path.join(repo, ".git", "info", "exclude"), "\n.mandible-test-signing-key*\n");
  hookCalls = 0;
  executorCalls = 0;
  const hooks = createNoopHookManager();
  hooks.executeHooks = async () => { hookCalls += 1; return []; };
  queue = new AuthQueue({ db, hookManager: hooks, backgroundMaintenance: false,
    executor: async () => { executorCalls += 1; return new Promise(() => {}); },
  });
});
afterEach(async () => { vi.unstubAllEnvs(); (await queue.dispose()); db.close(); fs.rmSync(repo, { recursive: true, force: true }); });

function prepareMergeFixture() {
  commitOnBranch(repo, "feature/delivery", { "delivered.txt": "reviewed bytes\n" });
  registerWorkRepo(db, repo);
  createLedgerProject(db, repo);
  git(repo, ["config", "core.hooksPath", ".git/hooks"]);
}

async function submitMerge(issueClosures: string[] = []) {
  const request = (await queue.submit({ ...AUTH_MERGE_REVIEW,  type: "merge", title: "Publish exact delivery", command: "mandible auth merge feature/delivery --into main",
    repo: path.basename(repo), cwd: repo, head_branch: "feature/delivery", merge_head_sha: git(repo, ["rev-parse", "feature/delivery"]), base_branch: "main", execution_mode: "local", issue_closures: issueClosures }));
  recordPassingCandidateAcceptance(db, request.id, queue.candidateAcceptanceForRequest(request) !== null);
  return request;
}

function protectedState() {
  return { ref: git(repo, ["rev-parse", "main"]), index: git(repo, ["write-tree"]),
    files: fs.readFileSync(path.join(repo, "shared.txt"), "utf8"), merge: fs.existsSync(path.join(repo, ".git", "MERGE_HEAD")) };
}

/** Approve, then wait until the execution reaches its executor: only a running execution posts a result. */
async function approveToExecutor(id: string) {
  await queue.approveWithOperatorProof(id, operatorId);
  await waitUntil(() => (db.prepare("SELECT last_executed_at FROM auth_requests WHERE id = ?").get(id) as { last_executed_at: number | null }).last_executed_at, "the approved execution to reach its executor");
}

describe("protected delivery evidence", () => {
  beforeEach(prepareMergeFixture);
  it("retains durable delivery ownership and accepts its exact receipt independently of cleanup", async () => {
    await queue.dispose();
    vi.stubEnv("MANDIBLE_HOME", path.join(repo, ".git", "private-installation"));
    let journal: RuntimeHandoffJournal | null = null;
    let corrupt = false;
    let active = true;
    let duringProbe: () => void | Promise<void> = () => {};
    const probe = vi.fn(async () => { await duringProbe(); return {}; });
    const release = vi.fn(async () => {
      if (release.mock.calls.length === 1) throw new Error('Active pointer release interrupted');
      active = false; return { release: 'complete' };
    });
    const cleanupJobs: Array<ReturnType<typeof Promise.withResolvers<{ cleanup: 'complete' | 'pending' }>>> = [];
    const cleanup = vi.fn(async () => {
      const job = Promise.withResolvers<{ cleanup: 'complete' | 'pending' }>();
      cleanupJobs.push(job);
      const result = await job.promise;
      if (result.cleanup === 'complete') journal!.cleanup = { state: 'complete' };
      return result;
    });
    const hooks = createInstalledServiceHookManager(db, { handoffClient: {
      readRuntimeHandoff: () => { if (corrupt) throw new Error('Corrupt referenced journal'); return journal; },
      readRuntimeHandoffPhase: () => journal?.phase,
      verifyRuntimeHandoffReceipt: probe,
      runtimeHandoffNeedsAcknowledgment: () => active,
      acknowledgeRuntimeHandoff: release,
      scheduleRuntimeHandoffCleanup: cleanup,
    } });
    db.prepare("UPDATE auth_hooks SET repo_pattern = ?, command = ? WHERE id = ?").run("*", "exit 75", "builtin-mandible-rebuild");
    queue = new AuthQueue({ db, hookManager: hooks, backgroundMaintenance: false, executor: async () => new Promise(() => {}) });
    const issue = createLedgerIssue(db, createLedgerProject(db, repo).project.id, "handoff-close");
    const request = await submitMerge([issue.id]);
    await approveToExecutor(request.id);
    const publication = publishTestCandidate(repo, (await queue.getRequest(request.id))!);
    const legacyOutput = publication.output.split("\n").find(line => line.startsWith("MANDIBLE_MERGE_RESULT "))!;
    db.prepare("UPDATE auth_requests SET output = ?, merge_candidate_tree_sha = NULL, merge_candidate_pin_sha = NULL, merge_atomic_enabled = 0 WHERE id = ?").run(legacyOutput, request.id);
    let run = hooks.getRun(request.id, "builtin-mandible-rebuild")!;
    expect(run.runtime_delivery).toBeNull();
    const identity = { requestId: request.id, executionId: run.id, hookId: run.hook_id, commandDigest: run.command_digest, root: repo };
    // The producer appends intent while its original hook execution is running.
    db.prepare("UPDATE auth_hook_executions SET state = 'running', attempts = 1, exit_code = 75 WHERE id = ?").run(run.id);
    const proof = await freezeRuntimeHandoffPublication(db, identity);
    const binding = { ...identity, ...proof };
    await hooks.runPending((await queue.getRequest(request.id))!);
    run = hooks.getRun(request.id, run.hook_id)!;
    const history = run.attempt_history;
    expect(run).toMatchObject({ state: "running", exit_code: 75, attempts: 1, output: "", runtime_delivery: { publicationEvidence: proof.publicationEvidence } });
    // Discovery does not depend on journal files, output markers, or current signer permission.
    db.prepare("UPDATE user_credentials SET status = 'revoked' WHERE id = ?").run(proof.frozenCandidate.signerCredentialId);
    const restarted = createInstalledServiceHookManager(db);
    expect(restarted.runtimeHandoffOwnsRequest(request.id)).toBe(true);
    expect(hooks.grantRetry(request.id)).toBe(0);
    expect(await hooks.runPending((await queue.getRequest(request.id))!)).toEqual([]);
    db.prepare("UPDATE auth_hook_executions SET state = 'running' WHERE id = ?").run(run.id);
    hooks.reclaimInterruptedRuns(request.id);
    expect(hooks.getRun(request.id, run.hook_id)?.state).toBe("running");
    const stuck = vi.fn();
    const failed = vi.fn();
    const adopt = vi.fn(async () => () => {});
    await hooks.reconcileRuntimeHandoffs(adopt, failed, stuck);
    expect(stuck).toHaveBeenLastCalledWith(request.id, expect.stringContaining('journal is unavailable'));
    corrupt = true;
    await hooks.reconcileRuntimeHandoffs(adopt, failed, stuck);
    expect(stuck).toHaveBeenLastCalledWith(request.id, 'Corrupt referenced journal');
    corrupt = false;
    const receipt = { schema: 'mandible-runtime-receipt@2', bindingDigest: 'a'.repeat(64), attemptId: 'current-attempt',
      approved: { reference: 'fixture-accepted-release', packageSha256: 'b'.repeat(64), publicationEvidence: proof.publicationEvidence },
      installed: { root: '/fixture/Mandible.app', identity: { dev: 1, ino: 2 } },
      services: { backend: { pid: 41, startedAt: 'backend-start', runs: 1 }, gateway: { pid: 42, startedAt: 'gateway-start', runs: 1 } },
      startup: { epoch: 'startup-epoch', generation: publication.mergeSha, database: '/fixture/mandible.db' },
      desktop: { required: false }, completedAt: 1 };
    journal = { schema: "mandible-runtime-handoff@1", binding, bindingDigest: receipt.bindingDigest, phase: "failed", error: "historical prelaunch failure",
      attempt: { id: receipt.attemptId, actor: {}, enteredAt: 1, deadline: 2, state: "complete", fence: { closedAt: 1 }, effects: {}, receipt,
        receiptDigest: createHash("sha256").update(JSON.stringify(receipt)).digest("hex") }, cleanup: { state: "pending" } };
    await hooks.reconcileRuntimeHandoffs(adopt, failed, stuck);
    expect(stuck).toHaveBeenLastCalledWith(request.id, expect.stringContaining('signer is no longer authorized'));
    expect(failed).not.toHaveBeenCalled();
    expect(adopt).not.toHaveBeenCalled();
    expect(probe).not.toHaveBeenCalled();
    db.prepare("UPDATE user_credentials SET status = 'active' WHERE id = ?").run(proof.frozenCandidate.signerCredentialId);
    expect(runtimeObservationAcceptance({ ...run, state: 'complete', output: `MANDIBLE_RUNTIME_HANDOFF_ACCEPTED:${journal.bindingDigest}` }, journal)).toBe('inconsistent');
    const receiptDigest = journal.attempt!.receiptDigest!;
    journal.attempt!.receiptDigest = 'f'.repeat(64);
    await hooks.reconcileRuntimeHandoffs(adopt, failed, stuck);
    expect(stuck).toHaveBeenLastCalledWith(request.id, expect.stringContaining('receipt identity is unavailable or corrupt'));
    expect(probe).not.toHaveBeenCalled();
    journal.attempt!.receiptDigest = receiptDigest;
    // Receipt verification may yield; both hook identity and signer authority must still hold at CAS.
    duringProbe = () => { db.prepare('UPDATE auth_hook_executions SET attempts = 2 WHERE id = ?').run(run.id); };
    await hooks.reconcileRuntimeHandoffs(adopt, failed, stuck);
    expect(stuck).toHaveBeenLastCalledWith(request.id, expect.stringContaining('hook changed'));
    expect(hooks.getRun(request.id, run.hook_id)?.state).toBe('running');
    db.prepare('UPDATE auth_hook_executions SET attempts = 1 WHERE id = ?').run(run.id);
    duringProbe = () => { db.prepare("UPDATE user_credentials SET status = 'revoked' WHERE id = ?").run(proof.frozenCandidate.signerCredentialId); };
    await queue.resumeHookConvergence();
    expect(hooks.getRun(request.id, run.hook_id)?.state).toBe('running');
    db.prepare("UPDATE user_credentials SET status = 'active' WHERE id = ?").run(proof.frozenCandidate.signerCredentialId);
    const entered = Promise.withResolvers<void>();
    const resume = Promise.withResolvers<void>();
    duringProbe = async () => { if (probe.mock.calls.length === 3) { entered.resolve(); await resume.promise; } };
    const competingCommit = vi.fn();
    const verifying = hooks.verifyCurrentRuntimeHandoff(request, {}, () => {}, async () => competingCommit);
    await entered.promise;
    // The queue commits publication and exact receipt together, then closes the requested issue.
    await queue.resumeHookConvergence();
    expect(hooks.getRun(request.id, run.hook_id)).toMatchObject({ state: 'complete', exit_code: 0, attempts: 1, attempt_history: history });
    expect(await queue.getRequest(request.id)).toMatchObject({ status: 'completed', exit_code: 0 });
    expect(db.prepare("SELECT status FROM ledger_issues WHERE id = ?").get(issue.id)).toEqual({ status: 'closed' });
    expect(getAttributionEvidence(db, (await queue.getRequest(request.id))!.execution_evidence_id!)?.details.publication_verified).toBe(true);
    expect(probe).toHaveBeenCalledTimes(4);
    expect(release).toHaveBeenCalledTimes(1);
    expect(cleanup).not.toHaveBeenCalled();
    // Accepted replay has no current-authority/probe dependency and cleanup remains independent debt.
    db.prepare("UPDATE user_credentials SET status = 'revoked' WHERE id = ?").run(proof.frozenCandidate.signerCredentialId);
    // A competing verifier observes the exact committed receipt and does not adopt twice.
    resume.resolve();
    expect(await verifying).toEqual({ outcome: 'confirmed' });
    expect(competingCommit).not.toHaveBeenCalled();
    await queue.resumeHookConvergence();
    await queue.resumeHookConvergence();
    expect(probe).toHaveBeenCalledTimes(4);
    expect(release).toHaveBeenCalledTimes(2);
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(await hooks.verifyCurrentRuntimeHandoff(request, {}, () => {}, adopt)).toEqual({ outcome: 'confirmed' });
    expect(cleanup).toHaveBeenCalledTimes(1); // An explicit check cannot duplicate the running child.
    cleanupJobs[0].reject(new Error('Cleanup child failed to spawn'));
    await new Promise<void>(resolve => setImmediate(resolve));
    await queue.resumeHookConvergence();
    expect(cleanup).toHaveBeenCalledTimes(1); // Ordinary sweeps respect the short retry cooldown.
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 2000);
    try { await queue.resumeHookConvergence(); } finally { clock.mockRestore(); }
    expect(cleanup).toHaveBeenCalledTimes(2);
    expect(await hooks.verifyCurrentRuntimeHandoff(request, {}, () => {}, adopt)).toEqual({ outcome: 'confirmed' });
    expect(cleanup).toHaveBeenCalledTimes(2);
    cleanupJobs[1].resolve({ cleanup: 'pending' }); // A completed child can leave transient disposal debt.
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(await hooks.verifyCurrentRuntimeHandoff(request, {}, () => {}, adopt)).toEqual({ outcome: 'confirmed' });
    expect(cleanup).toHaveBeenCalledTimes(3); // Explicit reconciliation can retry before the cooldown expires.
    cleanupJobs[2].resolve({ cleanup: 'complete' });
    await new Promise<void>(resolve => setImmediate(resolve));
    await queue.resumeHookConvergence();
    expect(cleanup).toHaveBeenCalledTimes(3);
    expect(hooks.getRun(request.id, run.hook_id)?.state).toBe('complete');
    expect(await queue.getRequest(request.id)).toMatchObject({ status: 'completed', exit_code: 0 });
    expect(probe).toHaveBeenCalledTimes(4);
    journal = null;
    await queue.resumeHookConvergence();
    expect(hooks.getRun(request.id, run.hook_id)?.state).toBe('complete');
    expect(await queue.getRequest(request.id)).toMatchObject({ status: 'completed', exit_code: 0 });
    expect(git(repo, ['rev-parse', 'main'])).toBe(publication.mergeSha);
  });

  it("runs frozen native post-hooks once with original arguments and refuses changed hook bytes", async () => {
    (await queue.dispose());
    const hooks = createInstalledServiceHookManager(db);
    queue = new AuthQueue({ db, hookManager: hooks, backgroundMaintenance: false, executor: async () => new Promise(() => {}) });
    for (const name of ["post-commit", "post-merge"]) fs.writeFileSync(path.join(repo, ".git", "hooks", name), `#!/bin/sh\nprintf '${name}:%s:%s:%s\\n' "$#" "\${1-}" "$(git rev-parse ORIG_HEAD)" >> .git/native-audit\n`, { mode: 0o755 });
    const request = (await submitMerge());
    await approveToExecutor(request.id);
    const publication = publishTestCandidate(repo, (await queue.getRequest(request.id))!);
    (await queue.setResult(request.id, 0, publication.output));
    await hooks.runPending((await queue.getRequest(request.id))!);
    expect(fs.readFileSync(path.join(repo, ".git", "native-audit"), "utf8")).toBe(`post-commit:0::${request.merge_preflight_base_sha}\npost-merge:1:0:${request.merge_preflight_base_sha}\n`);
    await hooks.runPending((await queue.getRequest(request.id))!);
    expect(hooks.listRuns(request.id).every(run => run.state === "complete" && run.attempts === 1)).toBe(true);
    commitOnBranch(repo, "feature/changed-hook", { "other.txt": "next bytes\n" });
    const next = (await queue.submit({ ...AUTH_MERGE_REVIEW,  type: "merge", title: "Changed hook", command: "mandible auth merge feature/changed-hook --into main", cwd: repo, repo: path.basename(repo), base_branch: "main", head_branch: "feature/changed-hook", merge_head_sha: git(repo, ["rev-parse", "feature/changed-hook"]), execution_mode: "local" }));
    await queue.approveWithOperatorProof(next.id, operatorId);
    fs.appendFileSync(path.join(repo, ".git", "hooks", "post-merge"), "# changed after review\n");
    (await queue.setResult(next.id, 0, publishTestCandidate(repo, (await queue.getRequest(next.id))!).output));
    await hooks.runPending((await queue.getRequest(next.id))!);
    expect(hooks.getRun(next.id, "native-git-post-merge")?.exit_code).not.toBe(0);
    expect(hooks.convergence(next.id).state).toBe("pending");
  });

  it("settles frozen publication evidence after the real checkout disappears while initial admission and corrupt proof refuse", async () => {
    (await queue.dispose());
    const hooks = createInstalledServiceHookManager(db);
    db.prepare("UPDATE auth_hooks SET repo_pattern = ?, command = ? WHERE id = ?").run("*", "exit 75", "builtin-mandible-rebuild");
    queue = new AuthQueue({ db, hookManager: hooks, backgroundMaintenance: false, executor: async () => new Promise(() => {}) });
    const request = (await submitMerge());
    await approveToExecutor(request.id);
    const publication = publishTestCandidate(repo, (await queue.getRequest(request.id))!);
    const run = hooks.getRun(request.id, "builtin-mandible-rebuild")!;
    const legacyOutput = publication.output.split("\n").find(line => line.startsWith("MANDIBLE_MERGE_RESULT "))!;
    db.prepare("UPDATE auth_requests SET output = ?, merge_preflight_base_sha = NULL, merge_candidate_tree_sha = NULL, merge_candidate_pin_sha = NULL, merge_atomic_enabled = 0 WHERE id = ?").run(legacyOutput, request.id);
    const binding = { requestId: request.id, executionId: run.id, hookId: run.hook_id, commandDigest: run.command_digest, root: repo };
    const originalRequest = db.prepare("SELECT status, execution_evidence_id FROM auth_requests WHERE id = ?").get(request.id);
    const proof = (await freezeRuntimeHandoffPublication(db, binding));
    expect(db.prepare("SELECT status, execution_evidence_id FROM auth_requests WHERE id = ?").get(request.id)).toEqual(originalRequest);
    expect((await freezeRuntimeHandoffPublication(db, { ...binding, ...proof })).publicationEvidence).toEqual(proof.publicationEvidence);
    expect(proof).toMatchObject({ mergeCommit: publication.mergeSha, mergeBase: request.merge_preflight_base_sha, mergeHead: request.merge_head_sha, frozenCandidate: { tree: request.merge_candidate_tree_sha } });
    const restore = tamperLooseGitObject(repo, publication.mergeSha, object => { object[object.indexOf(Buffer.from("\n\n")) + 2]! ^= 1; });
    try { await expect((async () => (await verifyRuntimeHandoffPublication(db, { ...binding, ...proof }))())).rejects.toThrow("does not match its object id"); }
    finally { restore(); }
    await expect((async () => (await verifyRuntimeHandoffPublication(db, { ...binding, commandDigest: "f".repeat(64) }))())).rejects.toThrow("binding differs");
    // An executor checkout never gains destination authority from matching runtime bytes.
    await expect((async () => (await verifyRuntimeHandoffPublication(db, { ...binding, source: { root: repo, commonGitDir: git(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"]), head: request.merge_head_sha!, buildRevision: request.merge_head_sha!, compiledDigest: "f".repeat(64), dependencies: { root: repo, digest: "f".repeat(64) }, files: {}, runtime: { path: process.execPath, sha256: "f".repeat(64) } } }))())).rejects.toThrow("unregistered");
    git(repo, ["update-ref", "refs/heads/main", request.merge_preflight_base_sha!, publication.mergeSha]);
    await expect((async () => (await verifyRuntimeHandoffPublication(db, { ...binding, ...proof }))())).rejects.toThrow("checkout differs");
    const moved = `${repo}-unavailable`;
    fs.renameSync(repo, moved);
    try {
      expect(fs.existsSync(repo)).toBe(false);
      await expect(verifyRuntimeHandoffPublication(db, { ...binding, ...proof })).rejects.toThrow();
      await expect(verifyRuntimeHandoffAuthority(db, { ...binding, ...proof })).resolves.toMatchObject(proof);
      await expect(verifyRuntimeHandoffAuthority(db, binding)).rejects.toThrow("frozen publication");
      await expect(verifyRuntimeHandoffAuthority(db, { ...binding, ...proof,
        publicationEvidence: { ...proof.publicationEvidence, digest: "f".repeat(64) } })).rejects.toThrow("frozen publication evidence differs");
      await expect(verifyRuntimeHandoffAuthority(db, { ...binding, ...proof,
        publicationEvidence: { ...proof.publicationEvidence, evidenceId: "missing-publication-record" } })).rejects.toThrow("frozen publication evidence differs");
      await expect(verifyRuntimeHandoffAuthority(db, { ...binding, ...proof,
        frozenCandidate: { ...proof.frozenCandidate, snapshotDigest: "f".repeat(64) } })).rejects.toThrow("frozen proof binding differs");
      db.prepare("UPDATE user_credentials SET status = 'revoked' WHERE id = ?").run(proof.frozenCandidate.signerCredentialId);
      await expect(verifyRuntimeHandoffAuthority(db, { ...binding, ...proof })).rejects.toThrow("signer is no longer authorized");
      db.prepare("UPDATE user_credentials SET status = 'active' WHERE id = ?").run(proof.frozenCandidate.signerCredentialId);
      const adoption = queue as unknown as { adoptRuntimePublication: (retained: typeof binding, frozen: typeof proof) => Promise<() => void> };
      const commitAdoption = await adoption.adoptRuntimePublication({ ...binding, ...proof }, proof);
      db.transaction(commitAdoption).immediate();
      expect(await queue.getRequest(request.id)).toMatchObject({ status: "completed", exit_code: 0,
        execution_evidence_id: proof.publicationEvidence.evidenceId, merge_candidate_tree_sha: proof.frozenCandidate.tree });
      const adopted = db.prepare("SELECT * FROM auth_requests WHERE id = ?").get(request.id);
      db.transaction(await adoption.adoptRuntimePublication({ ...binding, ...proof }, proof)).immediate();
      expect(db.prepare("SELECT * FROM auth_requests WHERE id = ?").get(request.id)).toEqual(adopted);
    } finally { fs.renameSync(moved, repo); }
  });


  it.each(["base", "head", "pin", "hook"] as const)("revalidates %s after asynchronous operator signing", async (changed) => {
    const request = (await submitMerge());
    const approving = queue.approveWithOperatorProof(request.id, operatorId);
    if (changed === "base") git(repo, ["update-ref", "refs/heads/main", request.merge_head_sha!]);
    if (changed === "head") {
      const moved = git(repo, ["commit-tree", request.merge_candidate_tree_sha!, "-p", request.merge_head_sha!, "-m", "Moved source"]);
      git(repo, ["update-ref", "refs/heads/feature/delivery", moved]);
    }
    if (changed === "pin") git(repo, ["update-ref", "-d", `refs/mandible/auth-candidates/${request.id}`]);
    if (changed === "hook") fs.writeFileSync(path.join(repo, ".git", "hooks", "pre-merge-commit"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const expectedBase = git(repo, ["rev-parse", "main"]);
    await expect(approving).rejects.toThrow();
    expect((await queue.getRequest(request.id))?.status).toBe("pending");
    expect(executorCalls).toBe(0);
    expect(hookCalls).toBe(0);
    expect(git(repo, ["rev-parse", "main"])).toBe(expectedBase);
  });


  it("refuses native preparation hooks before proof or protected mutation", async () => {
    const request = (await submitMerge());
    const before = protectedState();
    fs.writeFileSync(path.join(repo, ".git", "hooks", "pre-merge-commit"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    await expect(queue.approveWithOperatorProof(request.id, operatorId)).rejects.toThrow("unsupported native hooks");
    expect(protectedState()).toEqual(before);
    expect((await queue.getRequest(request.id))?.status).toBe("pending");
    expect(executorCalls).toBe(0);
  });

  it("does not close an issue or run hooks when an executor claims zero without a publication receipt", async () => {
    const project = createLedgerProject(db, repo);
    const issue = createLedgerIssue(db, project.project.id, "closure-proof");
    const request = (await submitMerge([issue.id]));
    await approveToExecutor(request.id);
    const before = protectedState();
    const result = (await queue.setResult(request.id, 0, "ok"));
    expect(result.exit_code).not.toBe(0);
    expect(result.error).toContain("publication receipt");
    expect(db.prepare("SELECT status FROM ledger_issues WHERE id = ?").get(issue.id)).toMatchObject({ status: "open" });
    expect(hookCalls).toBe(0);
    expect(protectedState()).toEqual(before);
  });

  it("retains applied publication state when its result is missing and completes on exact recovered evidence", async () => {
    const request = (await submitMerge());
    await queue.approveWithOperatorProof(request.id, operatorId);
    await waitUntil(() => executorCalls === 1, "the approved executor to start");
    const callsBeforeResult = executorCalls;
    const publication = publishTestCandidate(repo, (await queue.getRequest(request.id))!);
    const withoutReceipt = publication.output.split("MANDIBLE_MERGE_RESULT")[0]!;
    const stuck = (await queue.setResult(request.id, 0, withoutReceipt));
    expect(stuck.status).toBe("executing");
    expect(stuck.merge_atomic_enabled).toBe(true);
    await expect((async () => (await queue.update(request.id, { status: "pending" }))())).rejects.toThrow();
    const recovered = (await queue.setResult(request.id, 0, publication.output));
    expect(recovered).toMatchObject({ status: "completed", exit_code: 0 });
    const evidence = getAttributionEvidence(db, recovered.execution_evidence_id!);
    expect(evidence?.details).toMatchObject({ publication_verified: true, verified: true, commit_sha: publication.mergeSha, signer_user_id: operatorId });
    expect(git(repo, ["rev-parse", "main"])).toBe(publication.mergeSha);
    await expect((async () => (await queue.setResult(request.id, 0, publication.output))())).rejects.toThrow();
    expect(executorCalls).toBe(callsBeforeResult);
  });

  it("keeps nonzero post-publication result reports recoverable", async () => {
    const request = (await submitMerge());
    await queue.approveWithOperatorProof(request.id, operatorId);
    await waitUntil(() => executorCalls === 1, "the approved executor to start");
    const callsBeforeResult = executorCalls;
    const publication = publishTestCandidate(repo, (await queue.getRequest(request.id))!);
    const reported = (await queue.setResult(request.id, 75, publication.output.split("MANDIBLE_MERGE_RESULT")[0]!, "checkout cleanup interrupted"));
    expect(reported).toMatchObject({ status: "executing", exit_code: null, merge_atomic_enabled: true });
    await expect((async () => (await queue.retry(request.id))())).rejects.toThrow();
    const completed = (await queue.setResult(request.id, 0, publication.output));
    expect(completed).toMatchObject({ status: "completed", exit_code: 0 });
    expect(git(repo, ["rev-parse", "main"])).toBe(publication.mergeSha);
    expect(executorCalls).toBe(callsBeforeResult);
  });

  it("recovers the original receipt after a later signed publication without changing its checkout", async () => {
    const request = (await submitMerge());
    await queue.approveWithOperatorProof(request.id, operatorId);
    const first = publishTestCandidate(repo, (await queue.getRequest(request.id))!);
    (await queue.setResult(request.id, 75, first.output.split("MANDIBLE_MERGE_RESULT")[0]!));
    commitOnBranch(repo, "feature/later", { "later.txt": "later bytes\n" });
    const later = (await queue.submit({ ...AUTH_MERGE_REVIEW,  type: "merge", title: "Later publication", command: "mandible auth merge feature/later --into main", repo: path.basename(repo), cwd: repo, base_branch: "main", head_branch: "feature/later", merge_head_sha: git(repo, ["rev-parse", "feature/later"]), execution_mode: "local" }));
    await queue.approveWithOperatorProof(later.id, operatorId);
    const second = publishTestCandidate(repo, (await queue.getRequest(later.id))!);
    const before = protectedState();
    const internals = queue as unknown as { inspectStaleMerge(request: unknown): Promise<unknown>; finishRecoveredAtomicMerge(request: unknown, sha: string): Promise<void> };
    expect(await internals.inspectStaleMerge((await queue.getRequest(request.id))!)).toEqual({ outcome: "atomic_applied", mergeSha: first.mergeSha });
    const callsBeforeRecovery = executorCalls;
    await internals.finishRecoveredAtomicMerge((await queue.getRequest(request.id))!, first.mergeSha);
    const completed = (await queue.getRequest(request.id))!;
    expect(completed).toMatchObject({ status: "completed", exit_code: 0 });
    expect(getAttributionEvidence(db, completed.execution_evidence_id!)?.details.commit_sha).toBe(first.mergeSha);
    expect(git(repo, ["rev-parse", "main"])).toBe(second.mergeSha);
    expect(protectedState()).toEqual(before);
    expect(fs.readFileSync(path.join(repo, "later.txt"), "utf8")).toBe("later bytes\n");
    expect(executorCalls).toBe(callsBeforeRecovery);
  });

  it("preserves terminal requests rather than inferring delivery from branch ancestry", async () => {
    const request = (await submitMerge());
    git(repo, ["merge", "--no-ff", "--no-edit", "feature/delivery"]);
    (await queue.dispose());
    queue = new AuthQueue({ db, hookManager: createNoopHookManager(), backgroundMaintenance: false });
    expect((await queue.getRequest(request.id))?.status).toBe("pending");
    expect(hookCalls).toBe(0);
  });
});

describe('runtime convergence recovery', () => {
  beforeEach(prepareMergeFixture);
  it('refuses absent or conflicting source registration before accepting repository identity', async () => {
    const destination = createLedgerProject(db, fs.realpathSync(repo)).project;
    const source = createAuthCheckRepo();
    expect((await validateRuntimeSource(db, repo, repo))).toMatchObject({ ok: true, projectId: destination.id });
    expect((await validateRuntimeSource(db, source, repo))).toMatchObject({ ok: false, reason: expect.stringContaining('mandible project add-checkout') });
    const conflicting = createLedgerProject(db, fs.realpathSync(source)).project;
    expect((await validateRuntimeSource(db, source, repo))).toMatchObject({ ok: false, reason: expect.stringContaining('different canonical projects') });
    addOrUpdateCheckout(db, destination.id, { root: fs.realpathSync(source) });
    expect((await validateRuntimeSource(db, source, repo))).toMatchObject({ ok: false, reason: expect.stringContaining('different Git repositories') });
    expect(conflicting.id).not.toBe(destination.id);
  });

  it('refuses unregistered runtime source during preparation before approval or execution', async () => {
    const source = createAuthCheckRepo();
    try {
      createLedgerProject(db, fs.realpathSync(repo));
      vi.stubEnv('MANDIBLE_PRODUCTION_ROOT', source);
      const input = { repo: 'mandible', cwd: repo, base_branch: 'main', head_branch: 'feature/delivery' };
      expect((await queue.checkMergeIndependence(input))).toMatchObject({ status: 'error', reason: expect.stringContaining('mandible project add-checkout') });
      expect(executorCalls).toBe(0);
      expect(hookCalls).toBe(0);
      vi.stubEnv('MANDIBLE_PRODUCTION_ROOT', repo);
      expect((await queue.checkMergeIndependence(input))).toMatchObject({ status: 'clean' });
    } finally { fs.rmSync(source, { recursive: true, force: true }); }
  });

});

describe("consequential non-Git approval", () => {
  it("keeps missing, cancelled, and drifted proof pending without starting execution", async () => {
    const request = (await queue.submit({ ...AUTH_COMMAND_REVIEW,  type: "config-change", title: "Change configuration", command: "echo approved", cwd: repo }));
    const before = protectedState();
    await expect((async () => (await queue.approve(request.id))())).rejects.toThrow("signing proof");
    const cancelled = queue.approveWithOperatorProof(request.id, operatorId);
    queue.cancelOperatorProof(request.id, operatorId);
    await expect(cancelled).rejects.toThrow("cancelled");
    expect((await queue.getRequest(request.id))?.status).toBe("pending");
    const drifted = queue.approveWithOperatorProof(request.id, operatorId);
    (await queue.update(request.id, { title: "Changed reviewed action" }));
    await expect(drifted).rejects.toMatchObject({ code: "lifecycle_conflict" });
    expect((await queue.getRequest(request.id))?.status).toBe("pending");
    expect(executorCalls).toBe(0);
    expect(hookCalls).toBe(0);
    expect(protectedState()).toEqual(before);
  });
  it("records verified action-bound proof for consequential non-Git approval", async () => {
    const request = (await queue.submit({ ...AUTH_COMMAND_REVIEW,  type: "config-change", title: "Change configuration", command: "echo approved", cwd: repo }));
    const approved = await queue.approveWithOperatorProof(request.id, operatorId);
    expect(approved.status).toBe("executing");
    const evidence = getAttributionEvidence(db, approved.execution_evidence_id!);
    expect(evidence?.evidence_method).toBe("credential_signature");
    expect(evidence?.details).toMatchObject({ verified: true, signer_user_id: operatorId, auth_request_id: request.id });
    expect(JSON.parse(String(evidence?.details.challenge))).toMatchObject({ request_id: request.id });
    expect(queue.listLifecycleEvents(request.id).find((event) => event.event_type === "approved")?.evidence_method).toBe("credential_signature");
  });

});
