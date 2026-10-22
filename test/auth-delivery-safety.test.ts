import fs from "node:fs";
import SqliteDatabase from "../src/sqlite.js";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthQueue } from "../src/auth-queue.js";
import { AuthHookManager, type RuntimeHandoffJournal } from "../src/auth-hooks.js";
import { validateRuntimeSource, verifyRuntimeHandoffPublication } from "../src/runtime-handoff-proof.js";
import { mintApiToken } from "../src/client-auth/tokens.js";
import { addOrUpdateCheckout } from "../src/ledger/project-registry.js";
import { getAttributionEvidence } from "../src/users/store.js";
import {
  commitOnBranch, configureSigningCredential, createAuthCheckRepo, createLedgerIssue,
  createLedgerProject, createMigratedDb, createNoopHookManager, git, recordPassingCandidateAcceptance, registerWorkRepo,
} from "./helpers/auth-queue-fixtures.js";
import { publishTestCandidate } from "./helpers/auth-delivery-fixtures.js";
import { longestEventLoopBlockMs, useSlowGit } from "./helpers/event-loop-blocking.js";

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
afterEach(() => { vi.unstubAllEnvs(); queue.dispose(); db.close(); fs.rmSync(repo, { recursive: true, force: true }); });

function submitMerge(issueClosures: string[] = []) {
  const request = queue.submit({ type: "merge", title: "Publish exact delivery", command: "mandible auth merge feature/delivery --into main",
    repo: path.basename(repo), cwd: repo, head_branch: "feature/delivery", merge_head_sha: git(repo, ["rev-parse", "feature/delivery"]), base_branch: "main", execution_mode: "local", issue_closures: issueClosures });
  recordPassingCandidateAcceptance(db, request.id);
  return request;
}

function protectedState() {
  return { ref: git(repo, ["rev-parse", "main"]), index: git(repo, ["write-tree"]),
    files: fs.readFileSync(path.join(repo, "shared.txt"), "utf8"), merge: fs.existsSync(path.join(repo, ".git", "MERGE_HEAD")) };
}

describe("protected delivery evidence", () => {
  it("preserves reserved handoff attempts and accepts only an independently verified receipt", async () => {
    queue.dispose();
    const installationHome = path.join(repo, ".git", "private-installation");
    vi.stubEnv("MANDIBLE_HOME", installationHome);
    let journal: RuntimeHandoffJournal | null = null;
    let receiptValid = false;
    let acknowledgements = 0;
    const hooks = new AuthHookManager(db, { handoffClient: {
      readRuntimeHandoff: async (home) => home === installationHome ? journal : null,
      verifyRuntimeHandoffReceipt: async () => { if (!receiptValid) throw new Error("candidate readiness differs"); },
      acknowledgeRuntimeHandoff: async () => { acknowledgements += 1; if (acknowledgements === 1) throw new Error("acknowledgment interrupted"); if (journal) journal.phase = "acknowledged"; },
    } });
    db.prepare("UPDATE auth_hooks SET repo_pattern = ?, command = ? WHERE id = ?").run("*", `printf 'MANDIBLE_RUNTIME_HANDOFF_PENDING:${"a".repeat(64)}\\n'; exit 75`, "builtin-mandible-rebuild");
    queue = new AuthQueue({ db, hookManager: hooks, backgroundMaintenance: false, executor: async () => new Promise(() => {}) });
    const issue = createLedgerIssue(db, createLedgerProject(db, repo).project.id, "handoff-close");
    const request = submitMerge([issue.id]);
    await queue.approveWithOperatorProof(request.id, operatorId);
    const publication = publishTestCandidate(repo, queue.getRequest(request.id)!);
    const legacyOutput = publication.output.split("\n").find(line => line.startsWith("MANDIBLE_MERGE_RESULT "))!;
    db.prepare("UPDATE auth_requests SET output = ?, merge_candidate_tree_sha = NULL, merge_candidate_pin_sha = NULL, merge_atomic_enabled = 0 WHERE id = ?").run(legacyOutput, request.id);
    await hooks.runPending(queue.getRequest(request.id)!);
    let run = hooks.getRun(request.id, "builtin-mandible-rebuild")!;
    const attemptHistory = run.attempt_history;
    expect(run).toMatchObject({ state: "pending", exit_code: 75, attempts: 1 });
    expect(await hooks.runPending(queue.getRequest(request.id)!)).toEqual([]);
    expect(hooks.grantRetry(request.id)).toBe(0);
    db.prepare("UPDATE auth_hook_executions SET state = 'running' WHERE id = ?").run(run.id);
    hooks.reclaimInterruptedRuns(request.id);
    expect(hooks.getRun(request.id, run.hook_id)?.state).toBe("running");
    const binding = { requestId: request.id, executionId: run.id, hookId: run.hook_id, commandDigest: run.command_digest, root: repo };
    journal = { schema: "mandible-runtime-handoff@1", binding: { ...binding, ...verifyRuntimeHandoffPublication(db, binding) }, bindingDigest: "a".repeat(64), phase: "complete", receipt: { health: "candidate" } };
    await queue.resumeHookConvergence();
    expect(queue.getRequest(request.id)?.status).toBe("executing");
    expect(hooks.getRun(request.id, run.hook_id)?.state).toBe("failed");
    expect(acknowledgements).toBe(0);
    expect(db.prepare("SELECT status FROM ledger_issues WHERE id = ?").get(issue.id)).toMatchObject({ status: "open" });
    receiptValid = true;
    await queue.resumeHookConvergence();
    run = hooks.getRun(request.id, run.hook_id)!;
    expect(run).toMatchObject({ state: "complete", exit_code: 0, attempts: 1 });
    expect(run.attempt_history).toEqual(attemptHistory);
    expect(queue.getRequest(request.id)).toMatchObject({ status: "completed", exit_code: 0 });
    expect(getAttributionEvidence(db, queue.getRequest(request.id)!.execution_evidence_id!)?.details.publication_verified).toBe(true);
    expect(acknowledgements).toBe(1);
    expect(db.prepare("SELECT status FROM ledger_issues WHERE id = ?").get(issue.id)).toMatchObject({ status: "closed" });
    // The DB acceptance survived; startup retries only helper acknowledgment.
    await queue.resumeHookConvergence();
    expect(acknowledgements).toBe(2);
    expect(hooks.getRun(request.id, run.hook_id)?.attempt_history).toEqual(attemptHistory);
    await queue.resumeHookConvergence();
    expect(acknowledgements).toBe(2);
    expect(git(repo, ["rev-parse", "main"])).toBe(publication.mergeSha);
  });

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
    // An executor checkout never gains destination authority from matching runtime bytes.
    expect(() => verifyRuntimeHandoffPublication(db, { ...binding, source: { root: repo, commonGitDir: git(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"]), head: request.merge_head_sha!, buildRevision: request.merge_head_sha!, compiledDigest: "f".repeat(64), dependencies: { root: repo, digest: "f".repeat(64) }, files: {}, runtime: { path: process.execPath, sha256: "f".repeat(64) } } })).toThrow("unregistered");
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

describe('runtime convergence recovery', () => {
  it('refuses absent or conflicting source registration before accepting repository identity', () => {
    const destination = createLedgerProject(db, fs.realpathSync(repo)).project;
    const source = createAuthCheckRepo();
    expect(validateRuntimeSource(db, repo, repo)).toMatchObject({ ok: true, projectId: destination.id });
    expect(validateRuntimeSource(db, source, repo)).toMatchObject({ ok: false, reason: expect.stringContaining('mandible project add-checkout') });
    const conflicting = createLedgerProject(db, fs.realpathSync(source)).project;
    expect(validateRuntimeSource(db, source, repo)).toMatchObject({ ok: false, reason: expect.stringContaining('different canonical projects') });
    addOrUpdateCheckout(db, destination.id, { root: fs.realpathSync(source) });
    expect(validateRuntimeSource(db, source, repo)).toMatchObject({ ok: false, reason: expect.stringContaining('different Git repositories') });
    expect(conflicting.id).not.toBe(destination.id);
  });

  it('refuses unregistered runtime source during preparation before approval or execution', () => {
    const source = createAuthCheckRepo();
    try {
      createLedgerProject(db, fs.realpathSync(repo));
      vi.stubEnv('MANDIBLE_PRODUCTION_ROOT', source);
      const input = { repo: 'mandible', cwd: repo, base_branch: 'main', head_branch: 'feature/delivery' };
      expect(queue.checkMergeIndependence(input)).toMatchObject({ status: 'error', reason: expect.stringContaining('mandible project add-checkout') });
      expect(executorCalls).toBe(0);
      expect(hookCalls).toBe(0);
      vi.stubEnv('MANDIBLE_PRODUCTION_ROOT', repo);
      expect(queue.checkMergeIndependence(input)).toMatchObject({ status: 'clean' });
    } finally { fs.rmSync(source, { recursive: true, force: true }); }
  });

  async function recoveryFixture(interruptAck = false, fileBacked = false) {
    queue.dispose();
    if (fileBacked) {
      const filename = path.join(repo, '.git/recovery.db');
      fs.writeFileSync(filename, db.serialize()); db.close();
      db = new SqliteDatabase(filename, { timeout: 1 });
      db.pragma('journal_mode = WAL');
    }
    vi.stubEnv('MANDIBLE_HOME', path.join(repo, '.git/private-installation'));
    let journal: RuntimeHandoffJournal | null = null;
    const ack = vi.fn(async () => {
      if (interruptAck) { interruptAck = false; throw new Error('ack interrupted'); }
      journal!.phase = 'acknowledged';
    });
    const observation = vi.fn(async (current: RuntimeHandoffJournal, actor: unknown) => {
      expect(current.phase).toBe('failed');
      return { ...current, recovery: { digest: 'b'.repeat(64), failureDigest: 'original-failure', receipt: { healthy: true }, actor, observedAt: Date.now() } };
    });
    const recheck = vi.fn(() => {});
    const persist = vi.fn((current: RuntimeHandoffJournal) => { Object.assign(journal!, current); });
    const hooks = new AuthHookManager(db, { handoffClient: {
      readRuntimeHandoff: () => journal,
      verifyRuntimeHandoffReceipt: async () => {},
      acknowledgeRuntimeHandoff: ack,
      observeFailedRuntimeHandoff: observation,
      persistRuntimeRecoveryObservation: persist,
      recheckRuntimeObservation: recheck,
      completeRuntimeHandoffRecovery: async current => {
        expect(hooks.getRun(current.binding.requestId, current.binding.hookId)?.state).toBe('complete');
        expect(current.phase).toBe('failed');
        journal!.phase = 'complete'; return journal!;
      },
    } });
    const restart = vi.fn();
    queue = new AuthQueue({ db, hookManager: hooks, backgroundMaintenance: false, restartFn: restart, executor: async () => new Promise(() => {}) });
    vi.spyOn(queue as any, 'runBackgroundFinalizers').mockImplementation(async (id: string) => { db.prepare('UPDATE auth_requests SET merge_finalized_at = ? WHERE id = ?').run(Date.now(), id); });
    db.prepare('UPDATE auth_hooks SET repo_pattern = ?, command = ? WHERE id = ?').run('*', `printf 'MANDIBLE_RUNTIME_HANDOFF_PENDING:${'a'.repeat(64)}\\n'; exit 75`, 'builtin-mandible-rebuild');
    const issue = createLedgerIssue(db, createLedgerProject(db, repo).project.id, 'recover-close');
    const request = submitMerge([issue.id]);
    await queue.approveWithOperatorProof(request.id, operatorId);
    const publication = publishTestCandidate(repo, queue.getRequest(request.id)!);
    queue.setResult(request.id, 0, publication.output);
    await (queue as any).finalizerQueue.drain();
    await hooks.runPending(queue.getRequest(request.id)!);
    const run = hooks.getRun(request.id, 'builtin-mandible-rebuild')!;
    db.prepare("UPDATE auth_hook_executions SET state = 'failed' WHERE id = ?").run(run.id);
    const binding = { requestId: request.id, executionId: run.id, hookId: run.hook_id, commandDigest: run.command_digest, root: repo };
    journal = { schema: 'mandible-runtime-handoff@1', binding: { ...binding, ...verifyRuntimeHandoffPublication(db, binding) }, bindingDigest: 'a'.repeat(64), phase: 'failed' };
    const credential = mintApiToken(db, 'private-pepper', operatorId).credential;
    const actor = { user_id: operatorId, credential_id: credential.id, evidence_method: 'api_token' as const, authority_path: 'operator_recovery' as const };
    return { hooks, request, run, issue, actor, observation, recheck, ack, restart, journal, persist };
  }

  it('accepts the hook before exposing completion, preserves terminal history and replays interrupted acknowledgment once', async () => {
    const f = await recoveryFixture(true);
    const before = queue.getRequest(f.request.id)!;
    const history = queue.listLifecycleEvents(f.request.id);
    await expect(queue.retryHookConvergence(f.request.id, undefined, { mode: 'verify-current', actor: f.actor })).rejects.toMatchObject({ code: 'recovery_refused', message: expect.stringContaining('ack interrupted') });
    expect(f.hooks.getRun(f.request.id, f.run.hook_id)).toMatchObject({ state: 'complete', attempts: f.run.attempts, attempt_history: f.run.attempt_history });
    expect(f.journal.phase).toBe('complete');
    const adopt = vi.fn(() => { throw new Error('terminal publication must not be adopted'); });
    await f.hooks.reconcileRuntimeHandoffs(adopt);
    expect(adopt).not.toHaveBeenCalled();
    await queue.retryHookConvergence(f.request.id, undefined, { mode: 'verify-current', actor: f.actor });
    await queue.retryHookConvergence(f.request.id, undefined, { mode: 'verify-current', actor: f.actor });
    expect(f.observation).toHaveBeenCalledTimes(1);
    expect(f.restart).not.toHaveBeenCalled();
    expect(queue.listLifecycleEvents(f.request.id)).toEqual(history);
    expect(queue.getRequest(f.request.id)).toMatchObject({ output: before.output, status: before.status, approved_at: before.approved_at, resolved_at: before.resolved_at });
    expect(db.prepare('SELECT status FROM ledger_issues WHERE id = ?').get(f.issue.id)).toMatchObject({ status: 'closed' });
    expect(git(repo, ['rev-parse', 'main'])).toBe(f.journal.binding.mergeCommit);
  });

  it('leaves settled handoffs alone on the idle tick instead of re-verifying them with synchronous Git', async () => {
    const f = await recoveryFixture();
    await queue.retryHookConvergence(f.request.id, undefined, { mode: 'verify-current', actor: f.actor });
    expect(f.journal.phase).toBe('acknowledged');
    expect(f.hooks.getRun(f.request.id, f.run.hook_id)?.state).toBe('complete');
    const adopt = vi.fn();
    const slow = useSlowGit(0.3);
    try {
      expect(await longestEventLoopBlockMs(() => f.hooks.reconcileRuntimeHandoffs(adopt, vi.fn()))).toBeLessThan(150);
    } finally {
      fs.rmSync(slow.dir, { recursive: true, force: true });
    }
    expect(adopt).not.toHaveBeenCalled();
    expect(f.ack).toHaveBeenCalledTimes(1);
  });

  it('holds the SQLite writer lock before persisting external recovery evidence', async () => {
    const f = await recoveryFixture(false, true);
    const competing = new SqliteDatabase(path.join(repo, '.git/recovery.db'), { timeout: 1 });
    const foreignEffect = vi.fn();
    f.persist.mockImplementationOnce(current => {
      expect(() => competing.transaction(foreignEffect).immediate()).toThrow(/locked|busy/i);
      expect(foreignEffect).not.toHaveBeenCalled();
      Object.assign(f.journal, current);
    });
    try {
      await queue.retryHookConvergence(f.request.id, undefined, { mode: 'verify-current', actor: f.actor });
      expect(f.persist).toHaveBeenCalledOnce();
    } finally { competing.close(); }
  });

  it('does not replace an accepted receipt when concurrent observations finish out of order', async () => {
    const f = await recoveryFixture();
    let finishLate!: (journal: RuntimeHandoffJournal) => void;
    f.observation.mockImplementationOnce(async current => new Promise(resolve => { finishLate = resolve; }));
    const late = queue.retryHookConvergence(f.request.id, undefined, { mode: 'verify-current', actor: f.actor });
    await vi.waitFor(() => expect(f.observation).toHaveBeenCalledTimes(1));
    await queue.retryHookConvergence(f.request.id, undefined, { mode: 'verify-current', actor: f.actor });
    const accepted = f.journal.recovery!.digest;
    finishLate({ ...f.journal, phase: 'failed', recovery: { ...f.journal.recovery!, digest: 'c'.repeat(64) } });
    await expect(late).rejects.toThrow('hook changed');
    expect(f.journal.recovery!.digest).toBe(accepted);
    expect(f.hooks.getRun(f.request.id, f.run.hook_id)?.output).toContain(`MANDIBLE_RUNTIME_RECOVERY_ACCEPTED:${accepted}`);
    await queue.retryHookConvergence(f.request.id, undefined, { mode: 'verify-current', actor: f.actor });
  });

  it('keeps unrelated expired requests unchanged throughout verification-only recovery', async () => {
    const f = await recoveryFixture();
    const unrelated = queue.submit({ type: 'config-change', title: 'Unrelated pending request', command: 'true', cwd: repo });
    db.prepare('UPDATE auth_requests SET expires_at = 0 WHERE id = ?').run(unrelated.id);
    const before = db.prepare('SELECT * FROM auth_requests WHERE id = ?').get(unrelated.id);
    await queue.retryHookConvergence(f.request.id, undefined, { mode: 'verify-current', actor: f.actor });
    expect(db.prepare('SELECT * FROM auth_requests WHERE id = ?').get(unrelated.id)).toEqual(before);
  });

  it('drains once while foreign work runs and keeps admission closed through a second no-drain settlement', async () => {
    const f = await recoveryFixture();
    vi.useFakeTimers();
    try {
      vi.spyOn(queue as any, 'successfulMergeEvidenceFailure').mockReturnValue(null);
      const identity = vi.spyOn(f.hooks, 'admittedDrainIdentity').mockResolvedValue('exact-execution:current-process');
      let finishForeign!: () => void;
      (queue as any).inFlight.set('foreign', new Promise<void>(resolve => { finishForeign = resolve; }));
      const request = { ...queue.getRequestExact(f.request.id)!, repo: 'mandible' };
      await (queue as any).afterConvergenceHook(request);
      await (queue as any).afterConvergenceHook(request);
      identity.mockResolvedValue(null);
      await (queue as any).afterConvergenceHook(request);
      expect(queue.isRebuilding).toBe(true);
      await vi.advanceTimersByTimeAsync(2000);
      expect(f.restart).not.toHaveBeenCalled();
      identity.mockResolvedValue('exact-execution:current-process');
      finishForeign();
      await vi.advanceTimersByTimeAsync(2000);
      expect(f.restart).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });

  it('refuses changed credentials at acceptance and preserves failed ownership', async () => {
    const f = await recoveryFixture();
    f.observation.mockImplementationOnce(async current => {
      current.recovery = { digest: 'observed', failureDigest: 'original', receipt: {}, actor: f.actor, observedAt: Date.now() };
      db.prepare("UPDATE user_credentials SET status = 'revoked' WHERE id = ?").run(f.actor.credential_id);
      return current;
    });
    await expect(queue.retryHookConvergence(f.request.id, undefined, { mode: 'verify-current', actor: f.actor })).rejects.toThrow('inactive');
    expect(f.hooks.getRun(f.request.id, f.run.hook_id)?.state).toBe('failed');
    expect(f.journal.phase).toBe('failed');
    expect(f.ack).not.toHaveBeenCalled();
  });
});
