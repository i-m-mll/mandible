import { AUTH_MERGE_REVIEW } from "./helpers/auth-queue-fixtures.js";
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
import { AuthHookManager } from "../src/auth-hooks.js";
import { AuthAutoApproveManager } from "../src/auth-auto-approve.js";
import { collectAuthMergeReview } from "../src/auth-change-report.js";
import { latestCandidateAcceptance, type CandidateAcceptanceInput, type CandidateAcceptanceOutcome } from "../src/candidate-acceptance.js";
import { setDb } from "../src/db.js";
import { registerAuthRoutes } from "../src/routes/auth.js";
import type { AuthRequestInput, SseEvent } from "../src/types.js";
import { addCredential, createUser, getOperator } from "../src/users/store.js";
import { bindingDigest, retireFailedRuntimeHandoff } from "../scripts/runtime-handoff.mjs";
import { readRuntimeHandoffLock } from "../scripts/runtime-handoff-lock.mjs";
import { authenticatedTestRouter } from "./helpers/authenticated-router.js";
import { longestEventLoopBlockMs, useSlowCommand } from "./helpers/event-loop-blocking.js";
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
  });
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
    executor: async () => new Promise(() => {}), candidateAcceptanceExecutor: acceptanceExecutor });
});

afterEach(async () => {
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
    expect(queue.publicationBlockerForRequest(original)).toEqual(check.publication_blocker);
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

describe("candidate acceptance gate", () => {
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

    const slow = useSlowCommand("git", 0.3);
    try {
      const blocked = await longestEventLoopBlockMs(() => queue.refreshPendingCandidates());
      expect(blocked).toBeLessThan(150);
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
    queue = new AuthQueue({ db, hookManager: new AuthHookManager(db), executor: async () => new Promise(() => {}), candidateAcceptanceExecutor: acceptanceExecutor });
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
    queue = new AuthQueue({ db, hookManager: new AuthHookManager(db), backgroundMaintenance: false, restartFn: restart,
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
    const request = await submit();
    expect(runs).toHaveLength(0);
    const agent = createUser(db, { slug: "retire-agent", display_name: "Retire agent", kind: "agent" });
    const agentRouter = authenticatedTestRouter(agent);
    registerAuthRoutes(agentRouter, queue, new AuthAutoApproveManager({ db }));
    const refused = await agentRouter.invoke({ method: "POST", url: "/api/runtime-handoff/retire", body: { binding_digest: held.digest, reason: "stale" } });
    expect(refused.status).toBe(403);
    expect(fs.existsSync(held.lockPath)).toBe(true);

    const operatorRouter = authenticatedTestRouter(getOperator(db)!);
    registerAuthRoutes(operatorRouter, queue, new AuthAutoApproveManager({ db }));
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
