import { inlineLedgerReader } from "../src/ledger-reads/index.js";
import { createInstalledServiceHookManager, createServiceDefinitionInspector, AUTH_MERGE_REVIEW } from "./helpers/auth-queue-fixtures.js";
// @vitest-environment node
// Issue a09b4d2 — a runtime handoff lock blocks publication while preserving
// queue admission and the review work that can safely happen before release.
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { waitUntilPasses } from "./helpers/wait-until.js";
import { AuthQueue } from "../src/auth-queue.js";
import { acceptedReleaseReceiptFixture } from './helpers/accepted-release-fixture.js';
import { acceptedReleaseSelection, bindAcceptedRelease } from '../src/accepted-release-selection.js';
import { AuthAutoApproveManager } from "../src/auth-auto-approve.js";
import { collectAuthMergeReview } from "../src/auth-change-report.js";
import { CandidateAcceptanceRuns, latestCandidateAcceptance, type CandidateAcceptanceInput, type CandidateAcceptanceOutcome } from "../src/candidate-acceptance.js";
import { setDb } from "../src/db.js";
import { registerAuthRoutes } from "../src/routes/auth.js";
import type { AuthRequestInput, SseEvent } from "../src/types.js";
import { addCredential, createUser, getOperator } from "../src/users/store.js";
import { bindingDigest, retireFailedRuntimeHandoff } from "../scripts/runtime-handoff.mjs";
import * as serviceDefinitions from "../scripts/service-definitions.mjs";
import { readRuntimeHandoffLock } from "../scripts/runtime-handoff-lock.mjs";
import { authenticatedTestRouter } from "./helpers/authenticated-router.js";
import { longestEventLoopBlockMs, useSlowCommand, SYNCHRONOUS_WAIT_MS } from "./helpers/event-loop-blocking.js";
import {
  advanceMainViaAuthorizedMerge, approveFixtureRequest, commitOnBranch, configureSigningCredential, createAuthCheckRepo, createLedgerIssue, createLedgerProject,
  createMigratedDb, git, publishFixtureExecution, registerWorkRepo, waitForStatus,
} from "./helpers/auth-queue-fixtures.js";

let repo: string;
let home: string;
let db: ReturnType<typeof createMigratedDb>;
let queue: AuthQueue;
let operatorId: string;
let projectId: string;
let credentialId: string;
let issue: ReturnType<typeof createLedgerIssue>;
let runs: AcceptanceRun[];
let inspector: ReturnType<typeof createServiceDefinitionInspector>;

/** A failed handoff journal and the lock that names it, as the incident left them. */
function holdHandoffLock(phase = "failed") {
  const requestId = "f3ecce00-0000-4000-8000-000000000000";
  const executionId = "44059845-0000-4000-8000-000000000000";
  const dir = path.join(home, "config", "local-sessions", "handoff", `${requestId}-${executionId}`);
  fs.mkdirSync(dir, { recursive: true });
  const binding = { home, requestId, executionId, root: repo, hookId: "builtin-mandible-rebuild" };
  const journal = { schema: "mandible-runtime-handoff@1", binding, bindingDigest: bindingDigest(binding), phase, error: phase === "failed" ? "Candidate runtime readiness failed" : undefined, attempts: 1, updatedAt: 1 };
  const journalPath = path.join(dir, "journal.json");
  fs.writeFileSync(journalPath, `${JSON.stringify(journal)}\n`);
  const lockPath = path.join(home, "config", "local-sessions", "handoff-active.json");
  fs.writeFileSync(lockPath, JSON.stringify({ journal: journalPath, bindingDigest: journal.bindingDigest }));
  return { digest: journal.bindingDigest, journalPath, lockPath, dir };
}

/** One acceptance run the test decides; an aborted run settles when its signal aborts. */
interface AcceptanceRun { input: CandidateAcceptanceInput; settle: (outcome: CandidateAcceptanceOutcome) => void }

/** Submit a self-update with durable custody of its delivery work unit, which names the acceptance owner. */
async function submit(branch = "feature/self-update", patch: Partial<AuthRequestInput> = {}) {
  if (!patch.supersedes_request_id) {
    db.prepare(`INSERT INTO work_units (id, issue_id, ledger_issue_id, repo_id, branch, kind, state, created_at, owner_user_id, owner_credential_id, custody_generation)
      VALUES (?, ?, ?, ?, ?, 'solo', 'committed', 1, ?, ?, 1)`).run(`wu-${branch}`, issue.id, issue.id, path.basename(repo), branch, operatorId, credentialId);
  }
  return (await queue.submit({ ...AUTH_MERGE_REVIEW,  type: "merge", title: "Self-update", command: `mandible auth merge ${branch} --into main`,
    repo: path.basename(repo), cwd: repo, base_branch: "main", head_branch: branch,
    merge_head_sha: git(repo, ["rev-parse", branch]), execution_mode: "local",
    requester_evidence_method: "api_token", requester_credential_id: credentialId, require_delivery_custody: true,
    issue_references: ["5e1f0d0"], ...patch }, operatorId));
}

async function acceptanceOf(id: string) {
  return queue.candidateAcceptanceForRequest((await queue.getRequest(id))!);
}

async function reviewedChanges(branch: string) {
  const base = git(repo, ["rev-parse", "main"]);
  const head = git(repo, ["rev-parse", branch]);
  const result = await collectAuthMergeReview(repo, {
    base_sha: base, head_sha: head, merge_base_sha: git(repo, ["merge-base", base, head]),
  }, { report: true, diffSummary: false });
  if (!result.ok) throw new Error(result.error.message);
  return result.value.report!;
}

function acceptanceExecutor(input: CandidateAcceptanceInput) {
  return new Promise<CandidateAcceptanceOutcome>((settle) => {
    runs.push({ input, settle });
    input.signal.addEventListener("abort", () => settle({ status: "failed", result: null, error: "stopped" }));
  }).then(outcome => {
    if (outcome.status !== 'passed') return outcome;
    const row = db.prepare('SELECT pin_sha, tree_sha, base_sha, head_sha FROM auth_candidate_acceptances WHERE id = ?')
      .get(input.env.MANDIBLE_ACCEPTANCE_ID!) as import('../src/candidate-acceptance.js').CandidateAcceptanceCandidate;
    if (outcome.result && typeof outcome.result === 'object' && 'receipt' in outcome.result) return outcome;
    return { ...outcome, result: { ...outcome.result as object, receipt: acceptedReleaseReceiptFixture(home, row,
      { record_id: input.env.MANDIBLE_ACCEPTANCE_ID!, request_id: input.env.MANDIBLE_ACCEPTANCE_REQUEST! }, input.workUnitId) } };
  });
}

beforeEach(() => {
  inspector = createServiceDefinitionInspector();
  repo = createAuthCheckRepo();
  home = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-self-update-home-"));
  vi.stubEnv("MANDIBLE_HOME", home);
  db = createMigratedDb();
  commitOnBranch(repo, "feature/self-update", { "runtime.txt": "candidate\n" });
  commitOnBranch(repo, "feature/other", { "other.txt": "other\n" });
  operatorId = configureSigningCredential(db, repo, "ssh_key").operatorId;
  fs.appendFileSync(path.join(repo, ".git", "info", "exclude"), "\n.mandible-test-signing-key*\n");
  registerWorkRepo(db, repo);
  projectId = createLedgerProject(db, repo).project.id;
  git(repo, ["config", "core.hooksPath", ".git/hooks"]);
  // This repository self-updates the installation, as `mandible` does.
  db.prepare("UPDATE auth_hooks SET repo_pattern = ? WHERE id = 'builtin-mandible-rebuild'").run(path.basename(repo));
  credentialId = addCredential(db, operatorId, { type: "api_token", fingerprint: `self-update-${randomUUID()}` }).id;
  issue = createLedgerIssue(db, projectId, "5e1f0d0", "Self-update");
  runs = [];
  queue = new AuthQueue({ db, hookManager: createInstalledServiceHookManager(db, { serviceDefinitionInspector: inspector }), backgroundMaintenance: false,
    executor: async () => new Promise(() => {}), candidateAcceptanceExecutor: acceptanceExecutor });
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  (await queue.dispose());
  db.close();
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

describe("runtime handoff lock gate", () => {
  it("admits checks and supersession while exposing the publication blocker, then launches one acceptance after release", async () => {
    const lock = holdHandoffLock();
    const check = (await queue.checkMergeIndependence({ repo: path.basename(repo), cwd: repo, base_branch: "main", head_branch: "feature/other" }));
    expect(check).toMatchObject({
      status: "clean",
      publication_blocker: {
        code: "runtime_handoff_lock",
        message: expect.stringMatching(/Runtime handoff lock .* phase failed \(Candidate runtime readiness failed\)/),
      },
    });

    const original = await submit();
    expect(await queue.publicationBlockerForRequest(original)).toEqual(check.publication_blocker);
    expect(runs).toHaveLength(0);

    git(repo, ["checkout", "feature/self-update"]);
    fs.writeFileSync(path.join(repo, "runtime.txt"), "revised while publication is blocked\n");
    git(repo, ["commit", "-am", "revise blocked candidate"]);
    git(repo, ["checkout", "main"]);
    const replacement = await submit("feature/self-update", {
      supersedes_request_id: original.id,
      expected_revision: 1,
      expected_custody_generation: 1,
    });
    expect((await queue.getRequest(original.id))?.status).toBe("superseded");
    expect((await queue.getRequest(replacement.id))?.status).toBe("pending");
    expect(runs).toHaveLength(0);
    await expect(queue.approveWithOperatorProof(replacement.id, operatorId)).rejects.toThrow(/Runtime handoff lock/);

    // A request admitted to the repo chain before the lock appeared is parked
    // if publication is blocked by the time its execution turn begins.
    db.prepare("UPDATE auth_requests SET status = 'executing' WHERE id = ?").run(replacement.id);
    const execution = queue as unknown as { executeInBackground(request: unknown): Promise<void> };
    await execution.executeInBackground((await queue.getRequest(replacement.id))!);
    expect((await queue.getRequest(replacement.id))?.status).toBe("pending");

    // Other repositories do not self-update the installation and stay unaffected.
    db.prepare("UPDATE auth_hooks SET repo_pattern = 'mandible' WHERE id = 'builtin-mandible-rebuild'").run();
    expect((await queue.checkMergeIndependence({ repo: path.basename(repo), cwd: repo, base_branch: "main", head_branch: "feature/other" }))).toMatchObject({ status: "clean", publication_blocker: null });

    db.prepare("UPDATE auth_hooks SET repo_pattern = ? WHERE id = 'builtin-mandible-rebuild'").run(path.basename(repo));
    fs.unlinkSync(lock.lockPath);
    await queue.refreshPendingCandidates();
    await waitUntilPasses(() => expect(runs).toHaveLength(1));
    expect(runs[0]!.input.pinSha).toBe((await queue.getRequest(replacement.id))!.merge_candidate_pin_sha);
  });
});

describe('automatic accepted-package binding', () => {
  it('supports the one-time legacy custodian bridge, then selects the next delivery automatically', async () => {
    const first = await submit();
    await waitUntilPasses(() => expect(runs).toHaveLength(1));
    await queue.dispose();
    const candidate = { pin_sha: first.merge_candidate_pin_sha!, tree_sha: first.merge_candidate_tree_sha!,
      base_sha: first.merge_preflight_base_sha!, head_sha: first.merge_head_sha! };
    // The old authority records the compact reference but cannot bind it.
    const reference = acceptedReleaseReceiptFixture(home, candidate, undefined, first.custody_work_unit_id!);
    const legacy = new CandidateAcceptanceRuns(db, async () => ({ status: 'passed', result: { receipt: reference }, error: null }), Date.now, () => {}, () => false);
    legacy.start();
    legacy.enqueue(first.id, candidate, () => ({ repoRoot: repo, pinSha: candidate.pin_sha, projectId, workUnitId: first.custody_work_unit_id!, env: {} }));
    await legacy.idle();
    expect(db.prepare('SELECT id FROM auth_request_actions WHERE auth_request_id = ?').all(first.id)).toEqual([]);
    const accepted = db.prepare("SELECT id FROM auth_candidate_acceptances WHERE auth_request_id = ? AND status = 'passed'").get(first.id) as { id: string };
    queue = new AuthQueue({ db, hookManager: createInstalledServiceHookManager(db, { serviceDefinitionInspector: inspector }), backgroundMaintenance: false,
      executor: async () => new Promise(() => {}), candidateAcceptanceExecutor: acceptanceExecutor });
    await expect(queue.approveWithOperatorProof(first.id, operatorId)).rejects.toThrow('Accepted package selection is not ready');
    const revision = queue.listLifecycleEvents(first.id).at(-1)!.revision;
    queue.addAction(first.id, { kind: 'checkpoint_add', target_issue_ref: issue.id,
      payload: { kind: 'accepted-release', payload: { acceptanceId: accepted.id, reference } } },
      { user_id: operatorId, credential_id: credentialId, evidence_method: 'api_token' }, revision, 1);
    expect(acceptedReleaseSelection(db, (await queue.getRequest(first.id))!, queue.listActions(first.id), false).selection.reference).toBe(reference);
    expect(queue.listLifecycleEvents(first.id).at(-1)!.authority_path).toBe('custodian');
    await queue.approveWithOperatorProof(first.id, operatorId);
    expect((await queue.getRequest(first.id))!.approved_by_user_id).toBe(operatorId);
    // An upgraded authority's subsequent request requires no staging call.
    const second = await submit('feature/other');
    await waitUntilPasses(() => expect(runs).toHaveLength(2));
    runs[1].settle({ status: 'passed', result: {}, error: null });
    await queue.drainCandidateAcceptances();
    expect(await acceptanceOf(second.id)).toMatchObject({ state: 'passed' });
    expect(queue.listActions(second.id)).toHaveLength(1);
    expect(queue.listLifecycleEvents(second.id).at(-1)).toMatchObject({ authority_path: 'system', event_type: 'revised' });
    expect(queue.listActions(first.id)[0].payload.payload).toEqual({ acceptanceId: accepted.id, reference });
  });

  it('commits one selection and canonical revision with a compacted pass, then replays without revision', async () => {
    const request = await submit();
    await waitUntilPasses(() => expect(runs).toHaveLength(1));
    runs[0].settle({ status: 'passed', result: { diagnostics: 'x'.repeat(70_000) }, error: null });
    await queue.drainCandidateAcceptances();
    const accepted = db.prepare('SELECT id, status, result_json FROM auth_candidate_acceptances WHERE auth_request_id = ? ORDER BY rowid DESC LIMIT 1')
      .get(request.id) as { id: string; status: string; result_json: string };
    expect(accepted.status).toBe('passed');
    expect(accepted.result_json!.length).toBeLessThan(64 * 1024);
    const actions = queue.listActions(request.id);
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ target_issue_ref: issue.id, state: 'staged', payload: {
      kind: 'accepted-release', payload: { acceptanceId: accepted.id, reference: JSON.parse(accepted.result_json!).receipt },
    } });
    const revisions = queue.listLifecycleEvents(request.id);
    expect(revisions.at(-1)).toMatchObject({ event_type: 'revised', authority_path: 'system', evidence_method: 'system_internal' });
    expect(JSON.parse(revisions.at(-1)!.prior_snapshot_json!).actions).toEqual([]);
    bindAcceptedRelease(db, (await queue.getRequest(request.id))!, accepted.id, issue.id, Date.now());
    expect(queue.listLifecycleEvents(request.id)).toHaveLength(revisions.length);
    expect(queue.listActions(request.id)).toEqual(actions);
  });

  it.each(['custody', 'lifecycle', 'pin', 'receipt', 'package owner'] as const)('fails finalization on a changed %s without a passed or running orphan', async change => {
    const request = await submit();
    await waitUntilPasses(() => expect(runs).toHaveLength(1));
    if (change === 'custody') db.prepare('UPDATE work_units SET custody_generation = custody_generation + 1 WHERE id = ?').run(request.custody_work_unit_id);
    if (change === 'lifecycle') await queue.update(request.id, { title: 'Explicit pending revision' });
    if (change === 'pin') db.prepare('UPDATE auth_requests SET merge_candidate_pin_sha = ? WHERE id = ?').run('f'.repeat(40), request.id);
    const wrongOwner = change === 'package owner' ? { receipt: acceptedReleaseReceiptFixture(home, {
      pin_sha: request.merge_candidate_pin_sha!, tree_sha: request.merge_candidate_tree_sha!, base_sha: request.merge_preflight_base_sha!, head_sha: request.merge_head_sha!,
    }) } : {};
    runs[0].settle({ status: 'passed', result: change === 'receipt' ? { receipt: 'invalid' } : wrongOwner, error: null });
    await queue.drainCandidateAcceptances();
    expect(latestCandidateAcceptance(db, request.id)).toMatchObject({ status: 'failed', error: expect.stringContaining('finalization failed') });
    expect(queue.listActions(request.id)).toEqual([]);
    expect(db.prepare("SELECT id FROM auth_candidate_acceptances WHERE status IN ('running', 'passed')").all()).toEqual([]);
  });

  it('rolls back the selection and verdict when the canonical revision cannot be written', async () => {
    const request = await submit();
    await waitUntilPasses(() => expect(runs).toHaveLength(1));
    const revisions = queue.listLifecycleEvents(request.id);
    db.exec("CREATE TRIGGER refuse_binding_revision BEFORE INSERT ON auth_request_lifecycle_events BEGIN SELECT RAISE(ABORT, 'revision fixture failure'); END");
    runs[0].settle({ status: 'passed', result: {}, error: null });
    await queue.drainCandidateAcceptances();
    expect(latestCandidateAcceptance(db, request.id)).toMatchObject({ status: 'failed', error: expect.stringContaining('revision fixture failure') });
    expect(queue.listActions(request.id)).toEqual([]);
    expect(queue.listLifecycleEvents(request.id)).toEqual(revisions);
  });

  it.each(['unchanged', 'veto', 'edit', 'delete'] as const)('reconciles a new candidate while preserving an %s selection', async change => {
    const request = await submit();
    await waitUntilPasses(() => expect(runs).toHaveLength(1));
    runs[0].settle({ status: 'passed', result: {}, error: null });
    await queue.drainCandidateAcceptances();
    const initial = queue.listActions(request.id)[0];
    const actor = { user_id: operatorId, credential_id: credentialId, evidence_method: 'api_token' as const };
    const revision = queue.listLifecycleEvents(request.id).at(-1)!.revision;
    if (change === 'veto') queue.setActionVeto(request.id, initial.id, true, actor, revision, 1);
    if (change === 'edit') queue.updateAction(request.id, initial.id, { ...initial, payload: { kind: 'accepted-release', payload: { ...initial.payload.payload, reference: 'explicit selection' } } }, actor, revision, 1);
    if (change === 'delete') queue.deleteAction(request.id, initial.id, actor, revision, 1);
    const before = queue.listActions(request.id);
    advanceMainViaAuthorizedMerge(db, repo, 'feature/other', 'merge-other');
    await queue.refreshPendingCandidates();
    await waitUntilPasses(() => expect(runs).toHaveLength(2));
    runs[1].settle({ status: 'passed', result: {}, error: null });
    await queue.drainCandidateAcceptances();
    const latest = db.prepare('SELECT id, status FROM auth_candidate_acceptances WHERE auth_request_id = ? ORDER BY rowid DESC LIMIT 1')
      .get(request.id) as { id: string; status: string };
    if (change === 'unchanged') {
      expect(latest.status).toBe('passed');
      expect(queue.listActions(request.id)).toHaveLength(1);
      expect(queue.listActions(request.id)[0]).toMatchObject({ id: initial.id, payload: { payload: { acceptanceId: latest.id } } });
    } else {
      expect(latest.status).toBe('failed');
      expect(queue.listActions(request.id)).toEqual(before);
      await expect(queue.approveWithOperatorProof(request.id, operatorId)).rejects.toThrow('acceptance');
    }
  });
});

describe("candidate acceptance gate", () => {
  it("reports an absent backend before approval without invalidating candidate acceptance", async () => {
    const request = await submit();
    await waitUntilPasses(() => expect(runs).toHaveLength(1));
    runs[0]!.settle({ status: "passed", result: { status: "passed" }, error: null });
    await queue.drainCandidateAcceptances();
    const context = serviceDefinitions.serviceInstallationContext({ home });
    const absent = serviceDefinitions.assessServiceObservation(context, "backend", [], { loaded: false, pid: null });
    if (!absent.ok) throw new Error(absent.refusal.message);
    inspector.mockResolvedValue({ ok: true, observations: [absent.observation] });
    const message = "The production backend is not running, so its update cannot start yet.";
    expect(await queue.publicationBlockerForRequest((await queue.getRequest(request.id))!)).toEqual({ code: "missing_definition", message });
    await expect(queue.approveWithOperatorProof(request.id, operatorId)).rejects.toThrow(message);
    expect((await queue.getRequest(request.id))!.status).toBe("pending");
    expect(await acceptanceOf(request.id)).toMatchObject({ state: "passed" });
  });

  it("keeps acceptance valid and approves queued execution despite owned drift", async () => {
    const context = serviceDefinitions.serviceInstallationContext({ home });
    const record: serviceDefinitions.ServiceDefinition = {
      Label: context.backendLabel, ProgramArguments: ["/runtime/bun", `${context.runtimeDir}/production-runner.mjs`, "run"],
      EnvironmentVariables: { MANDIBLE_HOME: home, PATH: "/installed/tools" }, WorkingDirectory: context.runtimeDir,
      StandardOutPath: "/logs/backend.out", StandardErrorPath: "/logs/backend.err", KeepAlive: true,
    };
    const observation = serviceDefinitions.assessServiceObservation(context, "backend", [{ file: "/fixture/backend.plist", record, bytesBase64: "", sha256: "fixture" }], {
      loaded: true, pid: 42, program: record.ProgramArguments[0], argv: record.ProgramArguments,
      environment: { ...record.EnvironmentVariables, PATH: "/loaded/tools" }, workingDirectory: record.WorkingDirectory,
      stdoutPath: record.StandardOutPath, stderrPath: record.StandardErrorPath, keepAlive: true,
    });
    if (!observation.ok) throw new Error(observation.refusal.message);
    expect(observation.observation.differences[0]!.fields).toContain("EnvironmentVariables");
    const drift = { ok: true as const, observations: [observation.observation] };
    inspector.mockResolvedValue(drift);
    const request = await submit();
    await waitUntilPasses(() => expect(runs).toHaveLength(1));
    runs[0]!.settle({ status: "passed", result: { status: "passed" }, error: null });
    await queue.drainCandidateAcceptances();
    expect(await acceptanceOf(request.id)).toMatchObject({ state: "passed" });
    expect(await queue.publicationBlockerForRequest((await queue.getRequest(request.id))!)).toBeNull();
    await queue.runCandidateAcceptance((await queue.getRequest(request.id))!);
    expect(runs).toHaveLength(1);

    const execution = queue as unknown as {
      reserveRepoAdmission(request: unknown, install: (key: string) => void): Promise<void>;
      executionChains: Map<string, Promise<void>>;
      executor: ReturnType<typeof vi.fn>;
    };
    execution.executor = vi.fn(async () => new Promise(() => {}));
    let release!: () => void;
    const busy = new Promise<void>(resolve => { release = resolve; });
    await execution.reserveRepoAdmission((await queue.getRequest(request.id))!, key => { execution.executionChains.set(key, busy); });
    await queue.approveWithOperatorProof(request.id, operatorId);
    expect((await queue.getRequest(request.id))!.status).toBe("executing");
    expect(execution.executor).not.toHaveBeenCalled();
    // The state is observed again when this request reaches its execution turn.
    release();
    await waitUntilPasses(() => expect(execution.executor).toHaveBeenCalledTimes(1));
    expect((await queue.getRequest(request.id))!.last_executed_at).not.toBeNull();
  });

  it.each(["ownership_conflict", "unreadable_state"] as const)("reports %s before approval and queued execution without mutation", async (category) => {
    const request = await submit();
    await waitUntilPasses(() => expect(runs).toHaveLength(1));
    runs[0]!.settle({ status: "passed", result: { status: "passed" }, error: null });
    await queue.drainCandidateAcceptances();
    const sibling = await submit("feature/other");
    await waitUntilPasses(() => expect(runs).toHaveLength(2));
    const refusal: serviceDefinitions.ServiceOwnershipRefusal = {
      service: "backend", label: "private-backend", category, fields: [],
      message: category === "ownership_conflict" ? "Loaded service private-backend belongs to another installation; preserving it." : "Cannot read launchd state for private-backend.",
    };
    inspector.mockResolvedValue({ ok: false, refusal });
    // Production ownership never changes the verdict of an isolated candidate run.
    runs[1]!.settle({ status: "passed", result: { status: "passed" }, error: null });
    await queue.drainCandidateAcceptances();
    expect(await acceptanceOf(sibling.id)).toMatchObject({ state: "passed" });
    await queue.runCandidateAcceptance((await queue.getRequest(request.id))!);
    expect(runs).toHaveLength(2);
    expect(await acceptanceOf(request.id)).toMatchObject({ state: "passed" });

    setDb(db);
    const router = authenticatedTestRouter(getOperator(db)!);
    registerAuthRoutes(router, queue, new AuthAutoApproveManager({ db }), undefined, inlineLedgerReader(() => db));
    for (const url of [`/api/auth/request/${request.id}`, "/api/auth/queue", "/api/auth/history"]) {
      inspector.mockClear();
      if (url === "/api/auth/history") db.prepare("UPDATE auth_requests SET status = 'failed', resolved_at = 1").run();
      const response = await router.invoke({ method: "GET", url });
      if (url === "/api/auth/history") db.prepare("UPDATE auth_requests SET status = 'pending', resolved_at = NULL").run();
      expect(response.status).toBe(200);
      const body = response.body as { requests?: Array<{ publication_blocker: unknown }>; publication_blocker?: unknown };
      const blocker = { code: category, message: refusal.message };
      if (body.requests) expect(body.requests).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: request.id, publication_blocker: blocker }),
        expect.objectContaining({ id: sibling.id, publication_blocker: blocker }),
      ]));
      else expect(body.publication_blocker).toEqual(blocker);
      expect(inspector).toHaveBeenCalledTimes(1);
    }
    const protectedHead = git(repo, ["rev-parse", "main"]);
    await expect(queue.approveWithOperatorProof(request.id, operatorId)).rejects.toThrow(refusal.message);
    expect((await queue.getRequest(request.id))!.status).toBe("pending");

    inspector.mockResolvedValue(await createServiceDefinitionInspector()());
    db.prepare("UPDATE auth_requests SET status = 'executing' WHERE id = ?").run(request.id);
    const execution = queue as unknown as {
      reserveRepoAdmission(request: unknown, install: (key: string) => void): Promise<void>;
      executionChains: Map<string, Promise<void>>;
      executeInBackground(request: unknown): Promise<void>;
      inFlight: Map<string, Promise<void>>;
      executor: ReturnType<typeof vi.fn>;
    };
    execution.executor = vi.fn(async () => new Promise(() => {}));
    let release!: () => void;
    const busy = new Promise<void>(resolve => { release = resolve; });
    const current = (await queue.getRequest(request.id))!;
    await execution.reserveRepoAdmission(current, key => { execution.executionChains.set(key, busy); });
    await execution.executeInBackground(current);
    await waitUntilPasses(() => expect(execution.inFlight.has(request.id)).toBe(true));
    inspector.mockResolvedValue({ ok: false, refusal });
    release();
    await waitUntilPasses(async () => expect((await queue.getRequest(request.id))!.status).toBe("pending"));
    expect((await queue.getRequest(request.id))!.last_executed_at).toBeNull();
    expect(execution.executor).not.toHaveBeenCalled();
    expect(git(repo, ["rev-parse", "main"])).toBe(protectedHead);
  });

  it("retains a valid isolated pass when a handoff lock appears during acceptance", async () => {
    const request = await submit();
    await waitUntilPasses(() => expect(runs).toHaveLength(1));
    const lock = holdHandoffLock("complete");
    runs[0]!.settle({ status: "passed", result: { status: "passed" }, error: null });
    await queue.drainCandidateAcceptances();
    expect(await acceptanceOf(request.id)).toMatchObject({ state: "passed" });
    await expect(queue.approveWithOperatorProof(request.id, operatorId)).rejects.toThrow(/Runtime handoff lock/);
    fs.unlinkSync(lock.lockPath);
    await queue.refreshPendingCandidates();
    expect(runs).toHaveLength(1);
    expect(await queue.publicationBlockerForRequest((await queue.getRequest(request.id))!)).toBeNull();
  });

  it("skips documentation-only changes on submission, startup, manual runs, summaries, and approval", async () => {
    commitOnBranch(repo, "feature/docs", { "README.md": "# Mandible\n", "docs/images/screenshot.png": "image" });
    const request = await submit("feature/docs", { change_report: await reviewedChanges("feature/docs") });
    await queue.drainCandidateAcceptances();
    await queue.refreshPendingCandidates(true);
    expect(await queue.runCandidateAcceptance((await queue.getRequest(request.id))!)).toBeNull();
    expect(await acceptanceOf(request.id)).toBeNull();
    const { change_report: omittedReport, ...summary } = (await queue.getRequest(request.id))!;
    void omittedReport;
    expect(queue.candidateAcceptanceForRequest(summary)).toBeNull();
    expect(queue.candidateAcceptanceForRequest({ ...request, merge_head_sha: "f".repeat(40) })).not.toBeNull();
    expect(runs).toHaveLength(0);
    expect(latestCandidateAcceptance(db, request.id)).toBeNull();
    advanceMainViaAuthorizedMerge(db, repo, "feature/other", "merge-other");
    await queue.approveWithOperatorProof(request.id, operatorId);
    expect((await queue.getRequest(request.id))?.status).toBe("executing");
    expect(runs).toHaveLength(0);
  });

  it.each([
    "src/index.ts", "ui/header-logo.svg", "package.json", "bun.lock", ".bun-version",
    "tsconfig.json", "config/canonical-origin.json", "src-tauri/Cargo.toml", "scripts/candidate-acceptance.mjs",
  ])("requires exact-candidate acceptance when reviewed changes touch %s", async (file) => {
    commitOnBranch(repo, "feature/build-input", { [file]: "changed\n", "docs/note.md": "documentation\n" });
    const request = await submit("feature/build-input", { change_report: await reviewedChanges("feature/build-input") });
    await waitUntilPasses(() => expect(runs).toHaveLength(1));
    await expect(queue.approveWithOperatorProof(request.id, operatorId)).rejects.toThrow(/in progress/);
  });

  it("requires acceptance for a source renamed into documentation", async () => {
    commitOnBranch(repo, "feature/source", { "src/example.ts": "export const value = 1;\n" });
    git(repo, ["merge", "--ff-only", "feature/source"]);
    git(repo, ["checkout", "-b", "feature/rename"]);
    fs.mkdirSync(path.join(repo, "docs"), { recursive: true });
    git(repo, ["mv", "src/example.ts", "docs/example.md"]);
    git(repo, ["commit", "-m", "move source to docs"]);
    git(repo, ["checkout", "main"]);
    const report = await reviewedChanges("feature/rename");
    expect(report.files).toEqual([expect.objectContaining({ old_path: "src/example.ts", new_path: "docs/example.md", change_kind: "renamed" })]);
    await submit("feature/rename", { change_report: report });
    await waitUntilPasses(() => expect(runs).toHaveLength(1));
  });

  it("runs acceptance on submission and approves only after the exact current candidate passes", async () => {
    const request = (await submit());
    await waitUntilPasses(() => expect(runs).toHaveLength(1));
    const current = (await queue.getRequest(request.id))!;
    expect(runs[0]!.input).toMatchObject({ repoRoot: repo, pinSha: current.merge_candidate_pin_sha, workUnitId: "wu-feature/self-update", projectId });
    expect(latestCandidateAcceptance(db, request.id)).toMatchObject({ status: "running", pin_sha: current.merge_candidate_pin_sha,
      tree_sha: current.merge_candidate_tree_sha, base_sha: current.merge_preflight_base_sha, head_sha: current.merge_head_sha });
    // The manual command joins the open run instead of starting a second one.
    expect(await queue.runCandidateAcceptance(queue.getRequestReference(request.id.slice(0, 8))!)).toMatchObject({ state: "running" });
    expect(runs).toHaveLength(1);
    await expect(queue.approveWithOperatorProof(request.id, operatorId)).rejects.toThrow(/in progress/);

    runs[0]!.settle({ status: "failed", result: null, error: "Daemon readiness timed out" });
    await queue.drainCandidateAcceptances();
    expect((await acceptanceOf(request.id))).toMatchObject({ state: "failed", reason: "Daemon readiness timed out" });
    await expect(queue.approveWithOperatorProof(request.id, operatorId)).rejects.toThrow(/failed: Daemon readiness timed out/);

    await queue.runCandidateAcceptance((await queue.getRequest(request.id))!);
    await waitUntilPasses(() => expect(runs).toHaveLength(2));
    runs[1]!.settle({ status: "passed", result: { status: "passed" }, error: null });
    await queue.drainCandidateAcceptances();
    expect((await acceptanceOf(request.id))).toMatchObject({ state: "passed" });

    await queue.approveWithOperatorProof(request.id, operatorId);
    expect((await queue.getRequest(request.id))?.status).toBe("executing");
  });

  it("aborts the superseded request's run and runs the replacement's candidate", async () => {
    const original = (await submit());
    await waitUntilPasses(() => expect(runs).toHaveLength(1));
    git(repo, ["checkout", "feature/self-update"]);
    fs.writeFileSync(path.join(repo, "runtime.txt"), "revised\n");
    git(repo, ["commit", "-am", "revise candidate"]);
    git(repo, ["checkout", "main"]);
    const replacement = (await submit("feature/self-update", { supersedes_request_id: original.id, expected_revision: 1, expected_custody_generation: 1 }));

    expect(runs[0]!.input.signal.aborted).toBe(true);
    expect(latestCandidateAcceptance(db, original.id)).toMatchObject({ status: "failed", error: "The request is superseded." });
    await waitUntilPasses(() => expect(runs).toHaveLength(2));
    const open = db.prepare("SELECT auth_request_id FROM auth_candidate_acceptances WHERE status = 'running'").all();
    expect(open).toEqual([{ auth_request_id: replacement.id }]);
    expect(runs[1]!.input.pinSha).toBe((await queue.getRequest(replacement.id))!.merge_candidate_pin_sha);
  });

  it("re-pins a candidate the handoff lock left stale and runs its acceptance once the lock is released, with no approval", async () => {
    commitOnBranch(repo, "feature/sibling", { "sibling.txt": "sibling\n" });
    const request = (await submit());
    await waitUntilPasses(() => expect(runs).toHaveLength(1));
    runs[0]!.settle({ status: "passed", result: { status: "passed" }, error: null });
    await queue.drainCandidateAcceptances();

    // A self-update merge moves main while its handoff holds the lock. Safe
    // review work re-pins the sibling, but no candidate runtime may launch.
    const lock = holdHandoffLock("complete");
    advanceMainViaAuthorizedMerge(db, repo, "feature/sibling", "merge-sibling");
    const finalizer = queue as unknown as { revalidatePendingMergeRequestsSerialized(request: unknown): Promise<void> };
    await finalizer.revalidatePendingMergeRequestsSerialized((await queue.getRequest("merge-sibling")));
    await queue.refreshPendingCandidates();
    const blockedPin = (await queue.getRequest(request.id))!.merge_candidate_pin_sha;
    expect(blockedPin).not.toBe(runs[0]!.input.pinSha);
    expect((await queue.getRequest(request.id))!.merge_preflight_base_sha).toBe(git(repo, ["rev-parse", "main"]));
    expect(runs).toHaveLength(1);

    // The first idle tick after release launches the one missing acceptance.
    fs.unlinkSync(lock.lockPath);
    await queue.refreshPendingCandidates();
    const repinned = (await queue.getRequest(request.id))!;
    expect(repinned).toMatchObject({ status: "pending", merge_preflight_base_sha: git(repo, ["rev-parse", "main"]) });
    await waitUntilPasses(() => expect(runs).toHaveLength(2));
    expect(runs[1]!.input.pinSha).toBe(blockedPin);
    expect(runs[1]!.input.pinSha).toBe(repinned.merge_candidate_pin_sha);
    expect((await acceptanceOf(request.id))).toMatchObject({ state: "running" });
  });

  it("passes over an unchanged candidate on the idle tick without blocking the event loop on Git", async () => {
    const request = (await submit());
    await waitUntilPasses(() => expect(runs).toHaveLength(1));
    runs[0]!.settle({ status: "passed", result: { status: "passed" }, error: null });
    await queue.drainCandidateAcceptances();
    await queue.refreshPendingCandidates();
    const pin = (await queue.getRequest(request.id))!.merge_candidate_pin_sha;

    const slow = useSlowCommand("git");
    try {
      const blocked = await longestEventLoopBlockMs(() => queue.refreshPendingCandidates());
      expect(blocked).toBeLessThan(SYNCHRONOUS_WAIT_MS);
    } finally {
      fs.rmSync(slow.dir, { recursive: true, force: true });
    }
    expect((await queue.getRequest(request.id))!.merge_candidate_pin_sha).toBe(pin);
    expect(runs).toHaveLength(1);
  });

  it("runs a run a restart interrupted again at startup", async () => {
    const request = (await submit());
    await waitUntilPasses(() => expect(runs).toHaveLength(1));
    (await queue.dispose());
    queue = new AuthQueue({ db, hookManager: createInstalledServiceHookManager(db, { serviceDefinitionInspector: inspector }), executor: async () => new Promise(() => {}), candidateAcceptanceExecutor: acceptanceExecutor });
    await waitUntilPasses(() => expect(runs).toHaveLength(2));
    expect(runs[1]!.input.pinSha).toBe(runs[0]!.input.pinSha);
    expect(db.prepare("SELECT status, error FROM auth_candidate_acceptances WHERE auth_request_id = ? ORDER BY started_at, rowid").all(request.id))
      .toEqual([{ status: "failed", error: "Interrupted by a daemon restart." }, { status: "running", error: null }]);
  });
});

describe("rebuild failure", () => {
  it("reports a refused rebuild with its reason and clears the restart window", async () => {
    (await queue.dispose());
    const events: SseEvent[] = [];
    const failed: string[] = [];
    const restart = vi.fn();
    db.prepare("UPDATE auth_hooks SET repo_pattern = '*', command = ? WHERE id = 'builtin-mandible-rebuild'")
      .run("printf 'Another handoff owns this installation; preserving it.\\n' >&2; exit 1");
    queue = new AuthQueue({ db, hookManager: createInstalledServiceHookManager(db, { serviceDefinitionInspector: inspector }), backgroundMaintenance: false, restartFn: restart,
      broadcast: (event) => { events.push(event); },
      restartAvailability: { markRebuildStarted: (id = "") => id, markShutdownStarted: () => true, markRebuildFailed: (id) => { failed.push(id); return true; } },
      executor: async (options) => publishFixtureExecution(queue, options) });
    const request = (await queue.submit({ ...AUTH_MERGE_REVIEW,  type: "merge", command: "mandible auth merge feature/self-update --into main", title: "Self-update",
      repo: "mandible", cwd: repo, base_branch: "main", head_branch: "feature/self-update",
      merge_head_sha: git(repo, ["rev-parse", "feature/self-update"]), execution_mode: "daemon" }));
    await approveFixtureRequest(queue, request.id);
    await waitForStatus(queue, request.id, "completed");
    await waitUntilPasses(() => expect(events.some((event) => event.event === "mandible:rebuild-failed")).toBe(true));
    const event = events.find((candidate) => candidate.event === "mandible:rebuild-failed")!;
    expect(event.data).toMatchObject({ request_id: request.id, message: "The merge landed, but Mandible did not update: its rebuild hook exited 1." });
    expect(events.findIndex((candidate) => candidate.event === "mandible:rebuilding")).toBeLessThan(events.indexOf(event));
    expect(queue.isRebuilding).toBe(false);
    expect(queue.rebuildFailure).toMatchObject({ request_id: request.id });
    expect(failed).toEqual([request.id]);
    expect(restart).not.toHaveBeenCalled();
  });
});

describe("failed handoff retirement", () => {
  it("retires only the exact failed lock and preserves its journal as evidence", async () => {
    const armed = holdHandoffLock("armed");
    await expect(retireFailedRuntimeHandoff(home, { bindingDigest: armed.digest, actor: { user_id: "operator" }, reason: "stale" })).rejects.toThrow(/Only a failed/);
    fs.rmSync(path.join(home, "config"), { recursive: true });

    const held = holdHandoffLock();
    const lockBytes = fs.readFileSync(held.lockPath);
    const journalBytes = fs.readFileSync(held.journalPath);
    await expect(retireFailedRuntimeHandoff(home, { bindingDigest: "e".repeat(64), actor: {}, reason: "stale" })).rejects.toThrow(/different binding digest/);
    const retirement = await retireFailedRuntimeHandoff(home, { bindingDigest: held.digest, actor: { user_id: "operator" }, reason: "Superseded by later merges" });
    expect(retirement).toMatchObject({ requestId: expect.stringMatching(/^f3ecce00/), failure: { phase: "failed", error: "Candidate runtime readiness failed" }, reason: "Superseded by later merges" });
    expect(readRuntimeHandoffLock(home)).toBeNull();
    expect(fs.readFileSync(path.join(held.dir, "retired-active.json"))).toEqual(lockBytes);
    expect(fs.readFileSync(held.journalPath)).toEqual(journalBytes);
    expect(JSON.parse(fs.readFileSync(path.join(held.dir, "retirement.json"), "utf8"))).toMatchObject({ bindingDigest: held.digest, actor: { user_id: "operator" } });
  });

  it("requires the operator at the retirement route", async () => {
    setDb(db);
    const held = holdHandoffLock();
    const request = await submit();
    expect(runs).toHaveLength(0);
    const agent = createUser(db, { slug: "retire-agent", display_name: "Retire agent", kind: "agent" });
    const agentRouter = authenticatedTestRouter(agent);
    registerAuthRoutes(agentRouter, queue, new AuthAutoApproveManager({ db }), undefined, inlineLedgerReader(() => queue.db));
    const refused = await agentRouter.invoke({ method: "POST", url: "/api/runtime-handoff/retire", body: { binding_digest: held.digest, reason: "stale" } });
    expect(refused.status).toBe(403);
    expect(fs.existsSync(held.lockPath)).toBe(true);

    const operatorRouter = authenticatedTestRouter(getOperator(db)!);
    registerAuthRoutes(operatorRouter, queue, new AuthAutoApproveManager({ db }), undefined, inlineLedgerReader(() => queue.db));
    const detail = await operatorRouter.invoke({ method: "GET", url: `/api/auth/request/${request.id}` });
    expect(detail.body).toMatchObject({ publication_blocker: { code: "runtime_handoff_lock", message: expect.stringContaining("Candidate runtime readiness failed") } });
    const status = await operatorRouter.invoke({ method: "GET", url: "/api/runtime-handoff/lock" });
    expect(status.body).toMatchObject({ lock: { phase: "failed", bindingDigest: held.digest } });
    const retired = await operatorRouter.invoke({ method: "POST", url: "/api/runtime-handoff/retire", body: { binding_digest: held.digest, reason: "stale" } });
    expect(retired.status).toBe(200);
    expect(retired.body).toMatchObject({ retirement: { actor: { user_id: operatorId } } });
    expect(fs.existsSync(held.lockPath)).toBe(false);
    await waitUntilPasses(() => expect(runs).toHaveLength(1));
    expect(runs[0]!.input.pinSha).toBe((await queue.getRequest(request.id))!.merge_candidate_pin_sha);
  });
});
