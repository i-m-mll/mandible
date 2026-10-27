import { createInstalledServiceHookManager, AUTH_COMMAND_REVIEW, AUTH_MERGE_REVIEW } from "./helpers/auth-queue-fixtures.js";
import fs from "node:fs";
import SqliteDatabase from "../src/sqlite.js";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthQueue } from "../src/auth-queue.js";
import type { RuntimeHandoffJournal } from "../src/auth-hooks.js";
import { validateRuntimeSource, verifyRuntimeHandoffPublication } from "../src/runtime-handoff-proof.js";
import { mintApiToken } from "../src/client-auth/tokens.js";
import { addOrUpdateCheckout } from "../src/ledger/project-registry.js";
import { getAttributionEvidence } from "../src/users/store.js";
import {
  commitOnBranch, configureSigningCredential, tamperLooseGitObject, createAuthCheckRepo, createLedgerIssue,
  createLedgerProject, createMigratedDb, createNoopHookManager, git, recordPassingCandidateAcceptance, registerWorkRepo,
} from "./helpers/auth-queue-fixtures.js";
import { publishTestCandidate } from "./helpers/auth-delivery-fixtures.js";
import { RuntimeObservationError } from "../scripts/runtime-observation.mjs";
import { assessRuntimeLogs } from "../scripts/runtime-log-assessment.mjs";
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
  recordPassingCandidateAcceptance(db, request.id);
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
  it("preserves reserved handoff attempts and accepts only an independently verified receipt", async () => {
    (await queue.dispose());
    const installationHome = path.join(repo, ".git", "private-installation");
    vi.stubEnv("MANDIBLE_HOME", installationHome);
    let journal: RuntimeHandoffJournal | null = null;
    let receiptValid = false;
    let acknowledgements = 0;
    const hooks = createInstalledServiceHookManager(db, { handoffClient: {
      readRuntimeHandoff: async (home) => home === installationHome ? journal : null,
      readRuntimeHandoffPhase: async (home) => home === installationHome ? journal?.phase : undefined,
      verifyRuntimeHandoffReceipt: async () => { if (!receiptValid) throw new Error("candidate readiness differs"); },
      acknowledgeRuntimeHandoff: async () => { acknowledgements += 1; if (acknowledgements === 1) throw new Error("acknowledgment interrupted"); if (journal) journal.phase = "acknowledged"; },
    } });
    db.prepare("UPDATE auth_hooks SET repo_pattern = ?, command = ? WHERE id = ?").run("*", `printf 'MANDIBLE_RUNTIME_HANDOFF_PENDING:${"a".repeat(64)}\\n'; exit 75`, "builtin-mandible-rebuild");
    queue = new AuthQueue({ db, hookManager: hooks, backgroundMaintenance: false, executor: async () => new Promise(() => {}) });
    const issue = createLedgerIssue(db, createLedgerProject(db, repo).project.id, "handoff-close");
    const request = (await submitMerge([issue.id]));
    await approveToExecutor(request.id);
    const publication = publishTestCandidate(repo, (await queue.getRequest(request.id))!);
    const legacyOutput = publication.output.split("\n").find(line => line.startsWith("MANDIBLE_MERGE_RESULT "))!;
    db.prepare("UPDATE auth_requests SET output = ?, merge_candidate_tree_sha = NULL, merge_candidate_pin_sha = NULL, merge_atomic_enabled = 0 WHERE id = ?").run(legacyOutput, request.id);
    await hooks.runPending((await queue.getRequest(request.id))!);
    let run = hooks.getRun(request.id, "builtin-mandible-rebuild")!;
    const attemptHistory = run.attempt_history;
    expect(run).toMatchObject({ state: "pending", exit_code: 75, attempts: 1 });
    expect(await hooks.runPending((await queue.getRequest(request.id))!)).toEqual([]);
    expect(hooks.grantRetry(request.id)).toBe(0);
    db.prepare("UPDATE auth_hook_executions SET state = 'running' WHERE id = ?").run(run.id);
    hooks.reclaimInterruptedRuns(request.id);
    expect(hooks.getRun(request.id, run.hook_id)?.state).toBe("running");
    const binding = { requestId: request.id, executionId: run.id, hookId: run.hook_id, commandDigest: run.command_digest, root: repo };
    journal = { schema: "mandible-runtime-handoff@1", binding: { ...binding, ...(await verifyRuntimeHandoffPublication(db, binding)) }, bindingDigest: "a".repeat(64), phase: "complete", receipt: { health: "candidate" } };
    await queue.resumeHookConvergence();
    expect((await queue.getRequest(request.id))?.status).toBe("executing");
    expect(hooks.getRun(request.id, run.hook_id)?.state).toBe("failed");
    expect(acknowledgements).toBe(0);
    expect(db.prepare("SELECT status FROM ledger_issues WHERE id = ?").get(issue.id)).toMatchObject({ status: "open" });
    receiptValid = true;
    await queue.resumeHookConvergence();
    run = hooks.getRun(request.id, run.hook_id)!;
    expect(run).toMatchObject({ state: "complete", exit_code: 0, attempts: 1 });
    expect(run.attempt_history).toEqual(attemptHistory);
    expect((await queue.getRequest(request.id))).toMatchObject({ status: "completed", exit_code: 0 });
    expect(getAttributionEvidence(db, (await queue.getRequest(request.id))!.execution_evidence_id!)?.details.publication_verified).toBe(true);
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

  it("reconstructs only the frozen signed first-upgrade candidate and refuses binding or checkout drift", async () => {
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
    const proof = (await verifyRuntimeHandoffPublication(db, binding));
    expect(proof).toMatchObject({ mergeCommit: publication.mergeSha, mergeBase: request.merge_preflight_base_sha, mergeHead: request.merge_head_sha, frozenCandidate: { tree: request.merge_candidate_tree_sha } });
    const restore = tamperLooseGitObject(repo, publication.mergeSha, object => { object[object.indexOf(Buffer.from("\n\n")) + 2]! ^= 1; });
    try { await expect((async () => (await verifyRuntimeHandoffPublication(db, { ...binding, ...proof }))())).rejects.toThrow("does not match its object id"); }
    finally { restore(); }
    await expect((async () => (await verifyRuntimeHandoffPublication(db, { ...binding, commandDigest: "f".repeat(64) }))())).rejects.toThrow("binding differs");
    // An executor checkout never gains destination authority from matching runtime bytes.
    await expect((async () => (await verifyRuntimeHandoffPublication(db, { ...binding, source: { root: repo, commonGitDir: git(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"]), head: request.merge_head_sha!, buildRevision: request.merge_head_sha!, compiledDigest: "f".repeat(64), dependencies: { root: repo, digest: "f".repeat(64) }, files: {}, runtime: { path: process.execPath, sha256: "f".repeat(64) } } }))())).rejects.toThrow("unregistered");
    git(repo, ["update-ref", "refs/heads/main", request.merge_preflight_base_sha!, publication.mergeSha]);
    await expect((async () => (await verifyRuntimeHandoffPublication(db, { ...binding, ...proof }))())).rejects.toThrow("checkout differs");
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

  async function recoveryFixture(interruptAck = false, fileBacked = false) {
    (await queue.dispose());
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
      expect(['failed', 'verification-pending']).toContain(current.phase);
      return { ...current, recovery: { digest: 'b'.repeat(64), failureDigest: 'original-failure', receipt: { healthy: true }, actor, observedAt: Date.now() } };
    });
    const recheck = vi.fn(() => {});
    const persist = vi.fn((current: RuntimeHandoffJournal) => { Object.assign(journal!, current); });
    const hooks = createInstalledServiceHookManager(db, { handoffClient: {
      readRuntimeHandoff: () => journal,
      readRuntimeHandoffPhase: () => journal?.phase,
      verifyRuntimeHandoffReceipt: async () => {},
      acknowledgeRuntimeHandoff: ack,
      observeFailedRuntimeHandoff: observation,
      persistRuntimeRecoveryObservation: persist,
      recheckRuntimeObservation: recheck,
      completeRuntimeHandoffRecovery: async current => {
        expect(hooks.getRun(current.binding.requestId, current.binding.hookId)?.state).toBe('complete');
        expect(['failed', 'verification-pending']).toContain(current.phase);
        journal!.phase = 'complete'; return journal!;
      },
    } });
    const restart = vi.fn();
    queue = new AuthQueue({ db, hookManager: hooks, backgroundMaintenance: false, restartFn: restart, executor: async () => new Promise(() => {}) });
    vi.spyOn(queue as any, 'runBackgroundFinalizers').mockImplementation(async (id: string) => { db.prepare('UPDATE auth_requests SET merge_finalized_at = ? WHERE id = ?').run(Date.now(), id); });
    db.prepare('UPDATE auth_hooks SET repo_pattern = ?, command = ? WHERE id = ?').run('*', `printf 'MANDIBLE_RUNTIME_HANDOFF_PENDING:${'a'.repeat(64)}\\n'; exit 75`, 'builtin-mandible-rebuild');
    const issue = createLedgerIssue(db, createLedgerProject(db, repo).project.id, 'recover-close');
    const request = (await submitMerge([issue.id]));
    await approveToExecutor(request.id);
    const publication = publishTestCandidate(repo, (await queue.getRequest(request.id))!);
    (await queue.setResult(request.id, 0, publication.output));
    await (queue as any).finalizerQueue.drain();
    await hooks.runPending((await queue.getRequest(request.id))!);
    const run = hooks.getRun(request.id, 'builtin-mandible-rebuild')!;
    db.prepare("UPDATE auth_hook_executions SET state = 'failed' WHERE id = ?").run(run.id);
    const binding = { requestId: request.id, executionId: run.id, hookId: run.hook_id, commandDigest: run.command_digest, root: repo };
    journal = { schema: 'mandible-runtime-handoff@1', binding: { ...binding, ...(await verifyRuntimeHandoffPublication(db, binding)) }, bindingDigest: 'a'.repeat(64), phase: 'failed' };
    const credential = mintApiToken(db, 'private-pepper', operatorId).credential;
    const actor = { user_id: operatorId, credential_id: credential.id, evidence_method: 'api_token' as const, authority_path: 'operator_recovery' as const };
    return { hooks, request, run, issue, actor, observation, recheck, ack, restart, journal, persist };
  }

  function automaticRecovery(f: Awaited<ReturnType<typeof recoveryFixture>>) {
    const owner = { file: '/private/active.json', journalPath: '/private/journal.json',
      bindingDigest: f.journal.bindingDigest, requestId: f.request.id, executionId: f.run.id,
      phase: 'failed', error: 'retained failure' };
    vi.spyOn(f.hooks, 'runtimeHandoffLock').mockImplementation(() => f.journal.phase === 'acknowledged' ? null : { ...owner, phase: f.journal.phase });
    const evidence = vi.fn(async () => ({ outcome: 'confirmed' as const, key: 'healthy-generation-1' }));
    Object.assign((f.hooks as any).handoffClient, { runtimeRecoveryEvidenceKey: evidence });
    return { owner, evidence };
  }

  it.each(['failed', 'verification-pending'] as const)('retains an incomplete %s verification without failing or replaying convergence, then accepts fresh evidence', async phase => {
    const f = await recoveryFixture();
    f.journal.phase = phase;
    if (phase === 'verification-pending') {
      f.journal.launch = { enteredAt: Date.now() - 60_000 };
      db.prepare("UPDATE auth_hook_executions SET state = 'pending', exit_code = 75 WHERE id = ?").run(f.run.id);
    }
    const run = f.hooks.getRun(f.request.id, f.run.hook_id)!;
    const before = { ...run };
    const { evidence } = automaticRecovery(f);
    f.observation.mockRejectedValueOnce(new RuntimeObservationError('observation_deadline', 'probe has not answered', { lastSample: null }, 'pending'));
    const result = await queue.retryHookConvergence(f.request.id, undefined, { mode: 'verify-current', actor: f.actor });
    expect(result).toMatchObject({ state: phase === 'failed' ? 'failed' : 'pending', verification: {
      outcome: 'pending', reason: 'probe has not answered', retainedFailure: phase === 'failed',
    } });
    expect(f.hooks.getRun(f.request.id, f.run.hook_id)).toMatchObject(before);
    expect(f.journal.phase).toBe(phase);
    expect(f.persist).not.toHaveBeenCalled();
    expect(f.ack).not.toHaveBeenCalled();
    expect(f.restart).not.toHaveBeenCalled();
    expect(db.prepare('SELECT status FROM ledger_issues WHERE id = ?').get(f.issue.id)).toMatchObject({ status: 'open' });
    evidence.mockResolvedValueOnce({ outcome: 'pending', key: 'still-starting' });
    f.observation.mockRejectedValueOnce(new RuntimeObservationError('observation_deadline', 'still waiting', null, 'pending'));
    const failed = vi.fn(); const stuck = vi.fn();
    await f.hooks.reconcileRuntimeHandoffs(vi.fn(), failed, stuck);
    expect(f.observation).toHaveBeenCalledTimes(2);
    expect(failed).not.toHaveBeenCalled();
    expect(stuck).not.toHaveBeenCalled();
    evidence.mockResolvedValue({ outcome: 'confirmed', key: 'now-serving' });
    await queue.resumeHookConvergence();
    expect(f.journal.phase).toBe('acknowledged');
    expect(f.hooks.getRun(f.request.id, f.run.hook_id)).toMatchObject({ state: 'complete', attempts: before.attempts, attempt_history: before.attempt_history });
    expect(f.persist).toHaveBeenCalledOnce();
    expect(f.ack).toHaveBeenCalledOnce();
    expect(db.prepare('SELECT status FROM ledger_issues WHERE id = ?').get(f.issue.id)).toMatchObject({ status: 'closed' });
    await queue.resumeHookConvergence();
    expect(f.observation).toHaveBeenCalledTimes(3);
    expect(f.ack).toHaveBeenCalledOnce();
  });

  it('keeps a retired pending handoff terminal after an interrupted DB disposition', async () => {
    const f = await recoveryFixture();
    f.journal.phase = 'retired';
    db.prepare("UPDATE auth_hook_executions SET state = 'pending', exit_code = 75 WHERE id = ?").run(f.run.id);
    const failed = vi.fn();
    const stuck = vi.fn();
    expect(await f.hooks.reconcileRuntimeHandoffs(vi.fn(), failed, stuck)).toEqual([]);
    expect(f.hooks.getRun(f.request.id, f.run.hook_id)?.state).toBe('failed');
    expect(f.observation).not.toHaveBeenCalled();
    expect(f.ack).not.toHaveBeenCalled();
    expect(failed).not.toHaveBeenCalled();
    expect(stuck).not.toHaveBeenCalled();
    expect(db.prepare('SELECT status FROM ledger_issues WHERE id = ?').get(f.issue.id)).toMatchObject({ status: 'open' });
  });

  it('automatically verifies the exact healthy failed owner and wakes deferred acceptance without another hook attempt', async () => {
    const f = await recoveryFixture();
    automaticRecovery(f);
    const refresh = vi.spyOn(queue, 'refreshPendingCandidates').mockResolvedValue();
    const head = git(repo, ['rev-parse', 'main']);
    const attempts = f.hooks.getRun(f.request.id, f.run.hook_id)!;
    await queue.resumeHookConvergence();
    expect(f.journal.phase).toBe('acknowledged');
    expect(f.journal.recovery?.actor).toMatchObject({ kind: 'daemon_reconciliation', pid: process.pid });
    expect(f.journal.recovery?.actor).not.toHaveProperty('user_id');
    expect(f.hooks.getRun(f.request.id, f.run.hook_id)).toMatchObject({ state: 'complete', attempts: attempts.attempts, attempt_history: attempts.attempt_history });
    expect(refresh).toHaveBeenCalledOnce();
    expect(f.observation).toHaveBeenCalledOnce();
    expect(f.ack).toHaveBeenCalledOnce();
    expect(f.restart).not.toHaveBeenCalled();
    expect(git(repo, ['rev-parse', 'main'])).toBe(head);
  });

  it('bounds automatic observation and retries only changed healthy evidence', async () => {
    const f = await recoveryFixture();
    const { evidence } = automaticRecovery(f);
    let rejectObservation!: (error: Error) => void;
    f.observation.mockImplementationOnce(() => new Promise((_, reject) => { rejectObservation = reject; }));
    const first = f.hooks.reconcileRuntimeHandoffs(vi.fn(), vi.fn());
    await waitUntil(() => f.observation.mock.calls.length === 1, 'automatic recovery observation');
    await f.hooks.reconcileRuntimeHandoffs(vi.fn(), vi.fn());
    expect(evidence).toHaveBeenCalledOnce();
    rejectObservation(new Error('retained unhealthy window'));
    await first;
    await f.hooks.reconcileRuntimeHandoffs(vi.fn(), vi.fn());
    expect(f.observation).toHaveBeenCalledOnce();
    expect(f.journal.phase).toBe('failed');
    evidence.mockResolvedValue({ outcome: 'confirmed', key: 'healthy-generation-2' });
    await f.hooks.reconcileRuntimeHandoffs(vi.fn(), vi.fn());
    expect(f.observation).toHaveBeenCalledTimes(2);
    expect(f.journal.phase).toBe('acknowledged');
  });

  it('retries an unchanged generation after a failed health window and bounded backoff', async () => {
    const f = await recoveryFixture();
    automaticRecovery(f);
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    try {
      f.observation.mockRejectedValueOnce(new Error('transient health window failure'));
      await f.hooks.reconcileRuntimeHandoffs(vi.fn(), vi.fn());
      expect(f.observation).toHaveBeenCalledOnce();
      clock.mockReturnValue(now + 30_000);
      await f.hooks.reconcileRuntimeHandoffs(vi.fn(), vi.fn());
      expect(f.observation).toHaveBeenCalledOnce();
      clock.mockReturnValue(now + 5 * 60_000);
      await f.hooks.reconcileRuntimeHandoffs(vi.fn(), vi.fn());
      expect(f.observation).toHaveBeenCalledTimes(2);
      expect(f.journal.phase).toBe('acknowledged');
    } finally { clock.mockRestore(); }
  });

  it('automatically recovers after a failed observation without poisoning the same daemon log', async () => {
    const f = await recoveryFixture();
    const { evidence } = automaticRecovery(f);
    const lines: string[] = [];
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: any) => { lines.push(String(chunk)); return true; });
    const observe = f.observation.getMockImplementation()!;
    f.observation.mockRejectedValueOnce(new Error('transient health window failure'));
    try {
      await queue.resumeHookConvergence();
      expect(f.journal.phase).toBe('failed');
      expect(lines.join('')).toContain('auth_runtime_handoff_reconcile_stuck');
      expect(db.prepare("SELECT resolved_at FROM operational_incidents WHERE task = ?").get(`runtime-handoff-reconcile/${f.request.id}`)).toMatchObject({ resolved_at: null });
      f.observation.mockImplementation(async (journal, actor) => {
        expect(assessRuntimeLogs(lines.join('')).failures).toEqual([]);
        return observe(journal, actor);
      });
      evidence.mockResolvedValue({ outcome: 'confirmed', key: 'healthy-generation-2' });
      await queue.resumeHookConvergence();
      expect(f.journal.phase).toBe('acknowledged');
      expect(f.observation).toHaveBeenCalledTimes(2);
      expect(f.ack).toHaveBeenCalledOnce();
    } finally { stderr.mockRestore(); }
  });

  it('never observes a historical failed handoff while another execution owns the lock', async () => {
    const f = await recoveryFixture();
    const { owner, evidence } = automaticRecovery(f);
    owner.executionId = 'another-execution';
    await f.hooks.reconcileRuntimeHandoffs(vi.fn(), vi.fn());
    expect(evidence).not.toHaveBeenCalled();
    expect(f.observation).not.toHaveBeenCalled();
    expect(f.journal.phase).toBe('failed');
    expect(f.ack).not.toHaveBeenCalled();
  });

  it('preserves a changed owner during automatic observation', async () => {
    const f = await recoveryFixture();
    const { owner } = automaticRecovery(f);
    const observe = f.observation.getMockImplementation()!;
    f.observation.mockImplementationOnce(async (journal, actor) => {
      const result = await observe(journal, actor);
      owner.bindingDigest = 'c'.repeat(64);
      return result;
    });
    await queue.resumeHookConvergence();
    expect(f.journal.phase).toBe('failed');
    expect(f.hooks.getRun(f.request.id, f.run.hook_id)?.state).toBe('failed');
    expect(f.persist).not.toHaveBeenCalled();
    expect(f.ack).not.toHaveBeenCalled();
  });

  it('does not accept a changed publication generation during automatic observation', async () => {
    const f = await recoveryFixture();
    automaticRecovery(f);
    const observe = f.observation.getMockImplementation()!;
    f.observation.mockImplementationOnce(async (journal, actor) => {
      const result = await observe(journal, actor);
      git(repo, ['commit', '--allow-empty', '-m', 'different generation']);
      return result;
    });
    await f.hooks.reconcileRuntimeHandoffs(vi.fn(), vi.fn());
    expect(f.journal.phase).toBe('failed');
    expect(f.persist).not.toHaveBeenCalled();
    expect(f.ack).not.toHaveBeenCalled();
  });

  it('resumes interrupted automatic acknowledgment without another observation, merge or build', async () => {
    const f = await recoveryFixture(true);
    automaticRecovery(f);
    const head = git(repo, ['rev-parse', 'main']);
    await queue.resumeHookConvergence();
    expect(f.journal.phase).toBe('complete');
    await queue.resumeHookConvergence();
    expect(f.journal.phase).toBe('acknowledged');
    expect(f.observation).toHaveBeenCalledOnce();
    expect(f.ack).toHaveBeenCalledTimes(2);
    expect(f.hooks.getRun(f.request.id, f.run.hook_id)).toMatchObject({ state: 'complete', attempts: f.run.attempts });
    expect(f.restart).not.toHaveBeenCalled();
    expect(git(repo, ['rev-parse', 'main'])).toBe(head);
  });

  it('accepts the hook before exposing completion, preserves terminal history and replays interrupted acknowledgment once', async () => {
    const f = await recoveryFixture(true);
    const before = (await queue.getRequest(f.request.id))!;
    const history = queue.listLifecycleEvents(f.request.id);
    // Verification-only recovery leaves unrelated requests alone, expired or not.
    const unrelated = (await queue.submit({ ...AUTH_COMMAND_REVIEW,  type: 'config-change', title: 'Unrelated pending request', command: 'true', cwd: repo }));
    db.prepare('UPDATE auth_requests SET expires_at = 0 WHERE id = ?').run(unrelated.id);
    const unrelatedBefore = db.prepare('SELECT * FROM auth_requests WHERE id = ?').get(unrelated.id);
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
    expect((await queue.getRequest(f.request.id))).toMatchObject({ output: before.output, status: before.status, approved_at: before.approved_at, resolved_at: before.resolved_at });
    expect(db.prepare('SELECT status FROM ledger_issues WHERE id = ?').get(f.issue.id)).toMatchObject({ status: 'closed' });
    expect(git(repo, ['rev-parse', 'main'])).toBe(f.journal.binding.mergeCommit);
    expect(db.prepare('SELECT * FROM auth_requests WHERE id = ?').get(unrelated.id)).toEqual(unrelatedBefore);
  });

  it('leaves settled handoffs alone on the idle tick instead of re-verifying them with Git', async () => {
    const f = await recoveryFixture();
    await queue.retryHookConvergence(f.request.id, undefined, { mode: 'verify-current', actor: f.actor });
    expect(f.journal.phase).toBe('acknowledged');
    expect(f.hooks.getRun(f.request.id, f.run.hook_id)?.state).toBe('complete');
    const adopt = vi.fn();
    const trace = path.join(repo, '.git', 'idle-git-calls.log');
    const shimDir = fs.mkdtempSync(path.join(path.dirname(repo), 'mandible-git-trace-'));
    const realGit = (process.env.PATH ?? '').split(path.delimiter).map(dir => path.join(dir, 'git')).find(candidate => fs.existsSync(candidate))!;
    fs.writeFileSync(path.join(shimDir, 'git'), `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(trace)}\nexec ${JSON.stringify(realGit)} "$@"\n`, { mode: 0o755 });
    vi.stubEnv('PATH', `${shimDir}${path.delimiter}${process.env.PATH ?? ''}`);
    try {
      await f.hooks.reconcileRuntimeHandoffs(adopt, vi.fn());
    } finally {
      fs.rmSync(shimDir, { recursive: true, force: true });
    }
    expect(fs.existsSync(trace) ? fs.readFileSync(trace, 'utf8') : '').toBe('');
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

  it('serializes current-runtime requests without accepting an incomplete competing observation', async () => {
    const f = await recoveryFixture();
    let finish!: (journal: RuntimeHandoffJournal) => void;
    const observe = f.observation.getMockImplementation()!;
    f.observation.mockImplementationOnce(async current => new Promise(resolve => { finish = resolve; }));
    const first = queue.retryHookConvergence(f.request.id, undefined, { mode: 'verify-current', actor: f.actor });
    await waitUntil(() => f.observation.mock.calls.length === 1, 'the first recovery observation');
    const competing = await queue.retryHookConvergence(f.request.id, undefined, { mode: 'verify-current', actor: f.actor });
    expect(competing.verification).toMatchObject({ outcome: 'pending' });
    expect(f.persist).not.toHaveBeenCalled();
    expect(f.ack).not.toHaveBeenCalled();
    finish(await observe(f.journal, f.actor));
    await expect(first).resolves.toMatchObject({ verification: { outcome: 'confirmed' }, state: 'complete' });
    expect(f.persist).toHaveBeenCalledOnce();
    expect(f.observation).toHaveBeenCalledOnce();
    const accepted = f.journal.recovery!.digest;
    await queue.retryHookConvergence(f.request.id, undefined, { mode: 'verify-current', actor: f.actor });
    expect(f.journal.recovery!.digest).toBe(accepted);
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
    await expect(drifted).rejects.toThrow("Observed request version is no longer current");
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
