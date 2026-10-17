// @vitest-environment node
// Issue a09b4d2 — a stale runtime handoff lock let approvals proceed while it
// blocked every rebuild, and the failure looked like a manual restart. These
// tests pin the gates that now fail visibly instead.
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthQueue } from "../src/auth-queue.js";
import { AuthHookManager } from "../src/auth-hooks.js";
import { AuthAutoApproveManager } from "../src/auth-auto-approve.js";
import type { CandidateAcceptanceInput, CandidateAcceptanceOutcome } from "../src/candidate-acceptance.js";
import { setDb } from "../src/db.js";
import { RestartAvailabilityStore } from "../src/restart-availability.js";
import { registerAuthRoutes } from "../src/routes/auth.js";
import type { AuthRequestInput, SseEvent } from "../src/types.js";
import { addCredential, createUser, getOperator } from "../src/users/store.js";
import { bindingDigest, retireFailedRuntimeHandoff } from "../scripts/runtime-handoff.mjs";
import { readRuntimeHandoffLock } from "../scripts/runtime-handoff-lock.mjs";
import { authenticatedTestRouter } from "./helpers/authenticated-router.js";
import { daemonRebuildFailure } from "../ui/src/daemon-readiness.js";
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

/** One acceptance run the test decides; a cancelled run settles when its signal aborts. */
interface AcceptanceRun { input: CandidateAcceptanceInput; settle: (outcome: CandidateAcceptanceOutcome) => void }

/** Submit a self-update with durable custody of its delivery work unit, which names the acceptance owner. */
function submit(branch = "feature/self-update", patch: Partial<AuthRequestInput> = {}) {
  if (!patch.supersedes_request_id) {
    db.prepare(`INSERT INTO work_units (id, issue_id, ledger_issue_id, repo_id, branch, kind, state, created_at, owner_user_id, owner_credential_id, custody_generation)
      VALUES (?, ?, ?, ?, ?, 'solo', 'committed', 1, ?, ?, 1)`).run(`wu-${branch}`, issue.id, issue.id, path.basename(repo), branch, operatorId, credentialId);
  }
  return queue.submit({ type: "merge", title: "Self-update", command: `mandible auth merge ${branch} --into main`,
    repo: path.basename(repo), cwd: repo, base_branch: "main", head_branch: branch,
    merge_head_sha: git(repo, ["rev-parse", branch]), execution_mode: "local",
    requester_evidence_method: "api_token", requester_credential_id: credentialId, require_delivery_custody: true,
    issue_references: ["5e1f0d0"], ...patch }, operatorId);
}

function acceptanceOf(id: string) {
  return queue.candidateAcceptanceForRequest(queue.getRequest(id)!);
}

beforeEach(() => {
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
  queue = new AuthQueue({ db, hookManager: new AuthHookManager(db), backgroundMaintenance: false,
    executor: async () => new Promise(() => {}),
    candidateAcceptanceExecutor: (input) => new Promise((settle) => {
      runs.push({ input, settle });
      input.signal.addEventListener("abort", () => settle({ status: "failed", result: null, error: "stopped" }));
    }) });
});

afterEach(() => {
  vi.unstubAllEnvs();
  queue.dispose();
  db.close();
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(home, { recursive: true, force: true });
});

describe("runtime handoff lock gate", () => {
  it("refuses check, submission and approval of a self-update while a lock is held", async () => {
    const request = submit();
    holdHandoffLock();
    const check = queue.checkMergeIndependence({ repo: path.basename(repo), cwd: repo, base_branch: "main", head_branch: "feature/other" });
    expect(check).toMatchObject({ status: "error", reason: expect.stringMatching(/Runtime handoff lock .* phase failed \(Candidate runtime readiness failed\)/) });
    expect(check.reason).toContain("mandible auth handoff retire --binding-digest");
    expect(() => submit("feature/other")).toThrow(/Runtime handoff lock/);
    await expect(queue.approveWithOperatorProof(request.id, operatorId)).rejects.toThrow(/Runtime handoff lock/);
    expect(queue.getRequest(request.id)?.status).toBe("pending");
    // Other repositories do not self-update the installation and stay unaffected.
    db.prepare("UPDATE auth_hooks SET repo_pattern = 'mandible' WHERE id = 'builtin-mandible-rebuild'").run();
    expect(queue.checkMergeIndependence({ repo: path.basename(repo), cwd: repo, base_branch: "main", head_branch: "feature/other" }).status).toBe("clean");
  });
});

describe("candidate acceptance gate", () => {
  it("runs acceptance on submission and approves only after the exact current candidate passes", async () => {
    const request = submit();
    await vi.waitFor(() => expect(runs).toHaveLength(1));
    const current = queue.getRequest(request.id)!;
    expect(runs[0]!.input).toMatchObject({ repoRoot: repo, pinSha: current.merge_candidate_pin_sha, workUnitId: "wu-feature/self-update", projectId });
    const record = queue.candidateAcceptance(request.id)!;
    expect(record).toMatchObject({ status: "running", pin_sha: current.merge_candidate_pin_sha, tree_sha: current.merge_candidate_tree_sha,
      base_sha: current.merge_preflight_base_sha, head_sha: current.merge_head_sha });
    // The manual command joins the open run instead of starting a second one.
    expect(queue.startCandidateAcceptance(request.id.slice(0, 8)).id).toBe(record.id);
    await expect(queue.approveWithOperatorProof(request.id, operatorId)).rejects.toThrow(/still running/);

    runs[0]!.settle({ status: "failed", result: null, error: "Daemon readiness timed out" });
    await queue.drainCandidateAcceptances();
    expect(acceptanceOf(request.id)).toMatchObject({ state: "failed", reason: "Daemon readiness timed out" });
    await expect(queue.approveWithOperatorProof(request.id, operatorId)).rejects.toThrow(/failed: Daemon readiness timed out/);

    queue.startCandidateAcceptance(request.id);
    await vi.waitFor(() => expect(runs).toHaveLength(2));
    runs[1]!.settle({ status: "passed", result: { status: "passed" }, error: null });
    await queue.drainCandidateAcceptances();
    expect(acceptanceOf(request.id)).toMatchObject({ state: "passed" });

    await queue.approveWithOperatorProof(request.id, operatorId);
    expect(queue.getRequest(request.id)?.status).toBe("executing");
  });

  it("cancels the superseded request's run and runs the replacement's candidate", async () => {
    const original = submit();
    await vi.waitFor(() => expect(runs).toHaveLength(1));
    git(repo, ["checkout", "feature/self-update"]);
    fs.writeFileSync(path.join(repo, "runtime.txt"), "revised\n");
    git(repo, ["commit", "-am", "revise candidate"]);
    git(repo, ["checkout", "main"]);
    const replacement = submit("feature/self-update", { supersedes_request_id: original.id, expected_revision: 1, expected_custody_generation: 1 });

    expect(runs[0]!.input.signal.aborted).toBe(true);
    expect(queue.candidateAcceptance(original.id)).toMatchObject({ status: "cancelled", error: "The request is superseded." });
    await vi.waitFor(() => expect(runs).toHaveLength(2));
    const open = db.prepare("SELECT auth_request_id FROM auth_candidate_acceptances WHERE status IN ('queued', 'running')").all();
    expect(open).toEqual([{ auth_request_id: replacement.id }]);
    expect(runs[1]!.input.pinSha).toBe(queue.getRequest(replacement.id)!.merge_candidate_pin_sha);
  });

  it("re-runs acceptance when approval re-pins the candidate onto a moved base", async () => {
    commitOnBranch(repo, "feature/sibling", { "sibling.txt": "sibling\n" });
    const request = submit();
    await vi.waitFor(() => expect(runs).toHaveLength(1));
    runs[0]!.settle({ status: "passed", result: { status: "passed" }, error: null });
    await queue.drainCandidateAcceptances();

    advanceMainViaAuthorizedMerge(db, repo, "feature/sibling", "merge-sibling");
    // The re-pinned candidate needs its own pass; the earlier one is stale.
    await expect(queue.approveWithOperatorProof(request.id, operatorId)).rejects.toThrow(/still running/);
    const repinned = queue.getRequest(request.id)!;
    expect(repinned.merge_candidate_pin_sha).not.toBe(runs[0]!.input.pinSha);
    expect(runs).toHaveLength(2);
    expect(runs[1]!.input.pinSha).toBe(repinned.merge_candidate_pin_sha);
    runs[1]!.settle({ status: "passed", result: { status: "passed" }, error: null });
    await queue.drainCandidateAcceptances();
    await queue.approveWithOperatorProof(request.id, operatorId);
    expect(queue.getRequest(request.id)?.status).toBe("executing");
  });

  it("records runs a restart interrupted as cancelled", () => {
    const request = submit();
    expect(queue.candidateAcceptance(request.id)?.status).toMatch(/queued|running/);
    queue.dispose();
    queue = new AuthQueue({ db, hookManager: new AuthHookManager(db), backgroundMaintenance: false,
      candidateAcceptanceExecutor: async () => ({ status: "passed", result: null, error: null }) });
    expect(acceptanceOf(request.id)).toMatchObject({ state: "cancelled", reason: "Interrupted by a daemon restart." });
  });
});

describe("rebuild failure", () => {
  it("reports a refused rebuild with its reason and clears the restart window", async () => {
    queue.dispose();
    const events: SseEvent[] = [];
    const failed: string[] = [];
    const restart = vi.fn();
    db.prepare("UPDATE auth_hooks SET repo_pattern = '*', command = ? WHERE id = 'builtin-mandible-rebuild'")
      .run("printf 'Another handoff owns this installation; preserving it.\\n' >&2; exit 1");
    queue = new AuthQueue({ db, hookManager: new AuthHookManager(db), backgroundMaintenance: false, restartFn: restart,
      broadcast: (event) => { events.push(event); },
      restartAvailability: { markRebuildStarted: (id = "") => id, markShutdownStarted: () => true, markRebuildFailed: (id) => { failed.push(id); return true; } },
      executor: async (options) => publishFixtureExecution(queue, options) });
    const request = queue.submit({ type: "merge", command: "mandible auth merge feature/self-update --into main", title: "Self-update",
      repo: "mandible", cwd: repo, base_branch: "main", head_branch: "feature/self-update",
      merge_head_sha: git(repo, ["rev-parse", "feature/self-update"]), execution_mode: "daemon" });
    await approveFixtureRequest(queue, request.id);
    await waitForStatus(queue, request.id, "completed");
    await vi.waitFor(() => expect(events.some((event) => event.event === "mandible:rebuild-failed")).toBe(true));
    const event = events.find((candidate) => candidate.event === "mandible:rebuild-failed")!;
    expect(event.data).toMatchObject({ request_id: request.id, reason: expect.stringContaining("Another handoff owns this installation") });
    expect(events.findIndex((candidate) => candidate.event === "mandible:rebuilding")).toBeLessThan(events.indexOf(event));
    expect(queue.isRebuilding).toBe(false);
    expect(queue.rebuildFailure).toMatchObject({ request_id: request.id });
    expect(failed).toEqual([request.id]);
    expect(restart).not.toHaveBeenCalled();
  });

  it("lets the splash report the failure only once the daemon stops rebuilding", () => {
    const failure = { request_id: "r", reason: "Another handoff owns this installation." };
    expect(daemonRebuildFailure({ ready: true, rebuilding: true, rebuild_failure: failure })).toBeNull();
    expect(daemonRebuildFailure({ ready: true, rebuild_failure: failure })).toBe("Another handoff owns this installation.");
    expect(daemonRebuildFailure({ ready: true })).toBeNull();
  });

  it("retires the blocking availability window without recording a sample", () => {
    let now = 1_000;
    const store = new RestartAvailabilityStore({ instanceKey: "http://127.0.0.1:1", filePath: path.join(home, "restart-availability.json"), now: () => now });
    store.markRebuildStarted("request-1");
    expect(store.currentNotice()).toMatchObject({ phase: "rebuilding" });
    now += 500;
    expect(store.markRebuildFailed("other")).toBe(false);
    expect(store.markRebuildFailed("request-1")).toBe(true);
    expect(store.currentNotice()).toBeNull();
    expect(store.read()).toMatchObject({ active: null, blocked_window: { sample_count: 0 } });
  });
});

describe("failed handoff retirement", () => {
  it("retires only the exact failed lock and preserves its journal as evidence", () => {
    const armed = holdHandoffLock("armed");
    expect(() => retireFailedRuntimeHandoff(home, { bindingDigest: armed.digest, actor: { user_id: "operator" }, reason: "stale" })).toThrow(/Only a failed handoff/);
    fs.rmSync(path.join(home, "config"), { recursive: true });

    const held = holdHandoffLock();
    const lockBytes = fs.readFileSync(held.lockPath);
    const journalBytes = fs.readFileSync(held.journalPath);
    expect(() => retireFailedRuntimeHandoff(home, { bindingDigest: "e".repeat(64), actor: {}, reason: "stale" })).toThrow(/different binding digest/);
    const retirement = retireFailedRuntimeHandoff(home, { bindingDigest: held.digest, actor: { user_id: "operator" }, reason: "Superseded by later merges" });
    expect(retirement).toMatchObject({ requestId: expect.stringMatching(/^f3ecce00/), failure: { phase: "failed", error: "Candidate runtime readiness failed" }, reason: "Superseded by later merges" });
    expect(readRuntimeHandoffLock(home)).toBeNull();
    expect(fs.readFileSync(path.join(held.dir, "retired-active.json"))).toEqual(lockBytes);
    expect(fs.readFileSync(held.journalPath)).toEqual(journalBytes);
    expect(JSON.parse(fs.readFileSync(path.join(held.dir, "retirement.json"), "utf8"))).toMatchObject({ bindingDigest: held.digest, actor: { user_id: "operator" } });
  });

  it("requires the operator at the retirement route", async () => {
    setDb(db);
    const held = holdHandoffLock();
    const agent = createUser(db, { slug: "retire-agent", display_name: "Retire agent", kind: "agent" });
    const agentRouter = authenticatedTestRouter(agent);
    registerAuthRoutes(agentRouter, queue, new AuthAutoApproveManager({ db }));
    const refused = await agentRouter.invoke({ method: "POST", url: "/api/runtime-handoff/retire", body: { binding_digest: held.digest, reason: "stale" } });
    expect(refused.status).toBe(403);
    expect(fs.existsSync(held.lockPath)).toBe(true);

    const operatorRouter = authenticatedTestRouter(getOperator(db)!);
    registerAuthRoutes(operatorRouter, queue, new AuthAutoApproveManager({ db }));
    const status = await operatorRouter.invoke({ method: "GET", url: "/api/runtime-handoff/lock" });
    expect(status.body).toMatchObject({ lock: { phase: "failed", bindingDigest: held.digest } });
    const retired = await operatorRouter.invoke({ method: "POST", url: "/api/runtime-handoff/retire", body: { binding_digest: held.digest, reason: "stale" } });
    expect(retired.status).toBe(200);
    expect(retired.body).toMatchObject({ retirement: { actor: { user_id: operatorId } } });
    expect(fs.existsSync(held.lockPath)).toBe(false);
  });
});
