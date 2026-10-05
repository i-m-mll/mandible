import { approveFixtureRequest, approvePausedFixtureRequest, completeFixturePublication } from "./helpers/auth-queue-fixtures.js";
/**
 * @vitest-environment node
 *
 * Merge independence, reconciliation, and sibling re-pinning.
 *
 * Signed candidate publication exercises merge authority. Historical rows may
 * describe past execution but cannot authorize a new merge or finalization.
 * Shared private-repository fixtures keep queue interactions deterministic.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AuthQueue, AuthQueueError } from "../src/auth-queue.js";
import { authRequestSnapshot, authSnapshotDigest } from "../src/auth-lifecycle.js";
import type { SseEvent } from "../src/types.js";
import { addCredential, getOperator } from "../src/users/store.js";
import { commitOnBranch, configureSigningCredential, createAuthCheckRepo, createLedgerIssue, createLedgerProject, createMigratedDb, createNoopHookManager, createQueue, git, registerWorkRepo, signedMergeIntoMain, uniqueMissingPath, waitForStatus, writeFile } from "./helpers/auth-queue-fixtures.js";

async function submitPausedSibling(queue: AuthQueue, db: Parameters<typeof registerWorkRepo>[0], repo: string, branch = 'feature/a') {
  registerWorkRepo(db, repo);
  const request = queue.submit({ type: 'merge', command: `mandible auth merge ${branch} --into main`,
    title: 'Reviewed sibling', repo: path.basename(repo), cwd: repo, base_branch: 'main', head_branch: branch,
    merge_head_sha: git(repo, ['rev-parse', branch]) });
  await approvePausedFixtureRequest(queue, request.id);
  return request;
}

describe("auth queue", () => {
  it("repairs only historical candidate drift after branch and main advance", async () => {
    const repo = createAuthCheckRepo();
    const db = createMigratedDb();
    const queue = new AuthQueue({ db });
    try {
      commitOnBranch(repo, "feature/a", { "a.txt": "a\n" });
      commitOnBranch(repo, "feature/b", { "b.txt": "b\n" });
      commitOnBranch(repo, "feature/c", { "c.txt": "c\n" });
      registerWorkRepo(db, repo);
      configureSigningCredential(db, repo, "ssh_key");
      const project = createLedgerProject(db, repo);
      const issue = createLedgerIssue(db, project.project.id, "8420a44");
      const operator = getOperator(db)!;
      const credential = addCredential(db, operator.id, {
        type: "api_token", fingerprint: `candidate-repair-${crypto.randomUUID()}`,
      });
      const actor = { user_id: operator.id, evidence_method: "api_token" as const,
        credential_id: credential.id, authority_path: "custodian" as const };
      db.prepare(`INSERT INTO work_units
        (id, issue_id, repo_id, branch, kind, state, created_at, activated_at,
         ledger_issue_id, owner_user_id, owner_credential_id, custody_generation)
        VALUES (?, '8420a44', ?, 'feature/b', 'solo', 'committed', 1, 1, ?, ?, ?, 1)`)
        .run(crypto.randomUUID(), project.project.project_key, issue.id, operator.id, credential.id);
      const pending = queue.submit({
        type: "merge", command: "mandible auth merge feature/b --into main", title: "Merge b",
        repo: project.project.project_key, base_branch: "main", head_branch: "feature/b",
        merge_head_sha: git(repo, ["rev-parse", "feature/b"]), cwd: repo,
        requester_evidence_method: "api_token", requester_credential_id: credential.id,
        require_delivery_custody: true, issue_references: ["8420a44"],
      }, operator.id);
      const sibling = await submitPausedSibling(queue, db, repo);
      await completeFixturePublication(queue, sibling.id);
      const firstMerge = git(repo, ["rev-parse", "main"]);
      await queue.drainFinalizers();
      const historical = queue.getRequest(pending.id)!;
      expect(historical.merge_preflight_base_sha).toBe(firstMerge);
      // Reproduce the old daemon's missing receipt while preserving its actual
      // refreshed row and candidate ref. This database is disposable test state.
      db.exec("DROP TRIGGER auth_request_lifecycle_events_immutable_delete");
      db.prepare("DELETE FROM auth_request_lifecycle_events WHERE auth_request_id = ? AND revision = 2")
        .run(pending.id);
      git(repo, ["checkout", "feature/b"]);
      writeFile(repo, "later.txt", "later\n");
      git(repo, ["add", "later.txt"]);
      git(repo, ["commit", "-m", "Advance reviewed branch"]);
      git(repo, ["checkout", "main"]);
      const secondMerge = signedMergeIntoMain(repo, "feature/c");
      expect(secondMerge).not.toBe(firstMerge);
      const proof = queue.inspectPendingCandidateSnapshotRepair(pending.id, actor);
      expect(proof).toMatchObject({ lifecycle_revision: 1, custody_generation: 1,
        current_base_sha: firstMerge });
      expect(() => queue.repairPendingCandidateSnapshot(pending.id, actor, 1, 1, "0".repeat(64)))
        .toThrow(AuthQueueError);
      const otherCredential = addCredential(db, operator.id, {
        type: "api_token", fingerprint: `candidate-repair-other-${crypto.randomUUID()}`,
      });
      expect(() => queue.inspectPendingCandidateSnapshotRepair(pending.id, {
        ...actor, credential_id: otherCredential.id,
      })).toThrow(AuthQueueError);
      db.prepare("UPDATE auth_requests SET title = 'Tampered' WHERE id = ?").run(pending.id);
      expect(() => queue.inspectPendingCandidateSnapshotRepair(pending.id, actor)).toThrow(AuthQueueError);
      db.prepare("UPDATE auth_requests SET title = ? WHERE id = ?").run(pending.title, pending.id);
      db.prepare("UPDATE auth_requests SET merge_atomic_enabled = 1 WHERE id = ?").run(pending.id);
      expect(() => queue.inspectPendingCandidateSnapshotRepair(pending.id, actor)).toThrow(AuthQueueError);
      db.prepare("UPDATE auth_requests SET merge_atomic_enabled = 0 WHERE id = ?").run(pending.id);
      queue.repairPendingCandidateSnapshot(pending.id, actor, 1, 1, proof.current_snapshot_sha256);
      expect(queue.listLifecycleEvents(pending.id).at(-1)).toMatchObject({
        revision: 2, event_type: "revised", credential_id: credential.id,
      });
      expect(() => queue.inspectPendingCandidateSnapshotRepair(pending.id, actor)).toThrow(AuthQueueError);
    } finally {
      queue.dispose(); db.close(); fs.rmSync(repo, { recursive: true, force: true });
    }
  });
  it("accepts pairwise-independent pending merge requests", () => {
    const repo = createAuthCheckRepo();
    const queue = createQueue();
    try {
      commitOnBranch(repo, "feature/a", { "a.txt": "a\n" });
      commitOnBranch(repo, "feature/b", { "b.txt": "b\n" });

      const first = queue.submit({
        type: "merge",
        command: "mandible auth merge feature/a --into main",
        title: "Merge feature/a",
        repo: path.basename(repo),
        base_branch: "main",
        head_branch: "feature/a",
        cwd: repo,
      });
      const check = queue.checkMergeIndependence({
        repo: path.basename(repo),
        base_branch: "main",
        head_branch: "feature/b",
        cwd: repo,
      });
      expect(check.status).toBe("clean");
      expect(check.checked_requests).toBe(1);

      const second = queue.submit({
        type: "merge",
        command: "mandible auth merge feature/b --into main",
        title: "Merge feature/b",
        repo: path.basename(repo),
        base_branch: "main",
        head_branch: "feature/b",
        cwd: repo,
      });

      expect(queue.getRequest(first.id)?.status).toBe("pending");
      expect(queue.getRequest(second.id)?.status).toBe("pending");
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("rejects a pending merge request that conflicts with the queued simulation", () => {
    const repo = createAuthCheckRepo();
    const queue = createQueue();
    try {
      commitOnBranch(repo, "feature/a", { "shared.txt": "a\n" });
      commitOnBranch(repo, "feature/b", { "shared.txt": "b\n" });

      const first = queue.submit({
        type: "merge",
        command: "mandible auth merge feature/a --into main",
        title: "Merge feature/a",
        repo: path.basename(repo),
        base_branch: "main",
        head_branch: "feature/a",
        cwd: repo,
      });

      const check = queue.checkMergeIndependence({
        repo: path.basename(repo),
        base_branch: "main",
        head_branch: "feature/b",
        cwd: repo,
      });
      expect(check.status).toBe("conflict");
      expect(check.conflicts[0]?.request_id).toBe(first.id);
      expect(check.conflicts[0]?.files).toContain("shared.txt");

      expect(() => queue.submit({
        type: "merge",
        command: "mandible auth merge feature/b --into main",
        title: "Merge feature/b",
        repo: path.basename(repo),
        base_branch: "main",
        head_branch: "feature/b",
        cwd: repo,
      })).toThrow(AuthQueueError);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("reports merge check infrastructure failures as errors, not conflicts", () => {
    const queue = createQueue();
    const missingCwd = uniqueMissingPath("mandible-missing-auth-check-cwd");

    const check = queue.checkMergeIndependence({
      repo: "missing-fixture-repo",
      base_branch: "main",
      head_branch: "feature/demo",
      cwd: missingCwd,
    });

    expect(check.status).toBe("error");
    expect(check.conflicts).toEqual([]);
    expect(check.reason).toContain("ENOENT");
  });

  it("reports tracked dirty worktree state as a merge preflight error", () => {
    const repo = createAuthCheckRepo();
    const queue = createQueue();
    try {
      commitOnBranch(repo, "feature/demo", { "feature.txt": "feature\n" });
      writeFile(repo, "shared.txt", "dirty\n");

      const check = queue.checkMergeIndependence({
        repo: path.basename(repo),
        base_branch: "main",
        head_branch: "feature/demo",
        cwd: repo,
      });

      expect(check.status).toBe("error");
      expect(check.reason).toContain("tracked worktree changes are present");
      expect(check.reason).toContain("shared.txt");
      expect(check.conflicts).toEqual([]);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("rejects merge request submission when shared preflight reports an error", () => {
    const repo = createAuthCheckRepo();
    const queue = createQueue();
    try {
      commitOnBranch(repo, "feature/demo", { "feature.txt": "feature\n" });
      writeFile(repo, "shared.txt", "dirty\n");

      expect(() => queue.submit({
        type: "merge",
        command: "mandible auth merge feature/demo --into main",
        title: "Merge feature/demo",
        repo: path.basename(repo),
        base_branch: "main",
        head_branch: "feature/demo",
        cwd: repo,
      })).toThrow(/merge preflight failed/);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("classifies a queued request whose head branch was torn down as stale, not a conflict (fbf2a58)", () => {
    const repo = createAuthCheckRepo();
    const queue = createQueue();
    try {
      commitOnBranch(repo, "feature/gone", { "gone.txt": "gone\n" });
      commitOnBranch(repo, "feature/live", { "live.txt": "live\n" });

      const queued = queue.submit({
        type: "merge",
        command: "mandible auth merge feature/gone --into main",
        title: "Merge feature/gone",
        repo: path.basename(repo),
        base_branch: "main",
        head_branch: "feature/gone",
        cwd: repo,
      });

      // Simulate the incident: the merge landed and the head branch was torn
      // down, but the queue row was never finalized.
      git(repo, ["branch", "-D", "feature/gone"]);

      const check = queue.checkMergeIndependence({
        repo: path.basename(repo),
        base_branch: "main",
        head_branch: "feature/live",
        cwd: repo,
      });

      expect(check.status).toBe("stale_request");
      expect(check.conflicts).toEqual([]);
      expect(check.stale_requests).toHaveLength(1);
      expect(check.stale_requests?.[0]?.request_id).toBe(queued.id);
      expect(check.stale_requests?.[0]?.head_branch).toBe("feature/gone");
      expect(check.stale_requests?.[0]?.message).toContain(queued.id);
      expect(check.reason).toContain("no longer exists");
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it.each([false, true])('keeps an unreviewed out-of-band merge pending even when its branch is deleted: %s', (deleteBranch) => {
    const repo = createAuthCheckRepo(); const db = createMigratedDb();
    const queue = new AuthQueue({ db, backgroundMaintenance: false });
    try {
      commitOnBranch(repo, 'feature/landed', { 'landed.txt': 'landed\n' });
      const request = queue.submit({ type: 'merge', command: 'mandible auth merge feature/landed --into main', title: 'Unreviewed merge',
        repo: path.basename(repo), cwd: repo, base_branch: 'main', head_branch: 'feature/landed', merge_head_sha: git(repo, ['rev-parse', 'feature/landed']) });
      git(repo, ['merge', '--no-ff', 'feature/landed', '-m', 'Out-of-band merge']);
      if (deleteBranch) git(repo, ['branch', '-D', 'feature/landed']);
      const events: SseEvent[] = [];
      const restarted = new AuthQueue({ db, broadcast: event => events.push(event) });
      try {
        expect(restarted.getRequest(request.id)).toMatchObject({ status: 'pending', exit_code: null, merge_finalized_at: null, execution_evidence_id: null });
        expect(events.some(event => event.event === 'auth:merged' || event.event === 'auth:resolved')).toBe(false);
      } finally { restarted.dispose(); }
    } finally { queue.dispose(); db.close(); fs.rmSync(repo, { recursive: true, force: true }); }
  });

  it("leaves a pending merge whose head is not yet in target untouched (fbf2a58)", () => {
    const repo = createAuthCheckRepo();
    const db = createMigratedDb();
    try {
      commitOnBranch(repo, "feature/unmerged", { "unmerged.txt": "unmerged\n" });
      const headSha = git(repo, ["rev-parse", "feature/unmerged"]);

      const queue = new AuthQueue({ db });
      const request = queue.submit({
        type: "merge",
        command: "mandible auth merge feature/unmerged --into main",
        title: "Merge feature/unmerged",
        repo: path.basename(repo),
        base_branch: "main",
        head_branch: "feature/unmerged",
        merge_head_sha: headSha,
        cwd: repo,
        target_repo_root: repo,
      });
      queue.dispose();

      // Nothing landed: the head is genuinely absent from main.
      const restarted = new AuthQueue({ db });
      try {
        const untouched = restarted.getRequest(request.id);
        expect(untouched?.status).toBe("pending");
        expect(untouched?.exit_code).toBeNull();
        expect(untouched?.merge_finalized_at ?? null).toBeNull();
      } finally {
        restarted.dispose();
      }
    } finally {
      db.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("does NOT reconcile when the head branch was recreated at the target sha, disagreeing with the recorded merge_head_sha (fbf2a58 round 2)", () => {
    const repo = createAuthCheckRepo();
    const db = createMigratedDb();
    try {
      // The original head branch commit (A). This is the sha that would have been
      // recorded on the request when it was submitted, and it is NOT merged.
      commitOnBranch(repo, "feature/recreated", { "recreated.txt": "orig\n" });
      const originalHeadSha = git(repo, ["rev-parse", "feature/recreated"]);
      const targetSha = git(repo, ["rev-parse", "main"]);
      expect(originalHeadSha).not.toBe(targetSha);

      const queue = new AuthQueue({ db });
      const request = queue.submit({
        type: "merge",
        command: "mandible auth merge feature/recreated --into main",
        title: "Merge feature/recreated",
        repo: path.basename(repo),
        base_branch: "main",
        head_branch: "feature/recreated",
        merge_head_sha: originalHeadSha,
        cwd: repo,
        target_repo_root: repo,
      });
      expect(queue.getRequest(request.id)?.status).toBe("pending");

      // The branch is force-recreated at the target tip (T). The unmerged work at
      // A is now abandoned; the live ref points at T. A naive proof taken from the
      // live ref ("T is an ancestor of T") would falsely complete the request.
      git(repo, ["branch", "-f", "feature/recreated", "main"]);
      expect(git(repo, ["rev-parse", "feature/recreated"])).toBe(targetSha);
      queue.dispose();

      const restarted = new AuthQueue({ db });
      try {
        const row = restarted.getRequest(request.id);
        // Recorded sha is authoritative and disagrees with the live ref: the
        // request is NOT reconcilable and stays pending.
        expect(row?.status).toBe("pending");
        expect(row?.exit_code ?? null).toBeNull();
        expect(row?.merge_finalized_at ?? null).toBeNull();
      } finally {
        restarted.dispose();
      }
    } finally {
      db.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("fully drops approval attribution and execution evidence when parking a self-merge execution (fbf2a58 round 2)", () => {
    const repo = createAuthCheckRepo();
    const db = createMigratedDb();
    const queue = new AuthQueue({ db });
    try {
      commitOnBranch(repo, "feature/parked", { "parked.txt": "p\n" });
      const operator = getOperator(db)!;
      // A real attribution_evidence row so the execution_evidence_id FK is
      // satisfied while we stage an in-flight, approved execution.
      db.prepare(
        "INSERT INTO attribution_evidence (id, evidence_method, verified_at, details_json) VALUES (?, ?, ?, '{}')"
      ).run("evidence-parked-1", "credential_signature", Date.now());

      const request = queue.submit({
        type: "merge",
        command: "mandible auth merge feature/parked --into main",
        title: "Merge feature/parked",
        repo: path.basename(repo),
        base_branch: "main",
        head_branch: "feature/parked",
        cwd: repo,
        target_repo_root: repo,
      });
      // Stage the row exactly as it would look mid-execution: executing, with the
      // approver and execution evidence attached.
      db.prepare(
        "UPDATE auth_requests SET status = 'executing', approved_at = ?, approved_by_user_id = ?, execution_evidence_id = ? WHERE id = ?"
      ).run(Date.now(), operator.id, "evidence-parked-1", request.id);

      (queue as unknown as { parkExecutionForRestart(r: unknown): void }).parkExecutionForRestart(
        queue.getRequest(request.id)!,
      );

      const parked = queue.getRequest(request.id);
      expect(parked?.status).toBe("pending");
      expect(parked?.approved_at ?? null).toBeNull();
      // The fix: stale approval attribution and evidence are fully cleared so a
      // later evidence-driven finalizer cannot mistake them for a live approval.
      expect(parked?.approved_by_user_id ?? null).toBeNull();
      expect(parked?.execution_evidence_id ?? null).toBeNull();
    } finally {
      queue.dispose();
      db.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('does not turn ancestry and a raw approver ID into execution proof', async () => {
    const repo = createAuthCheckRepo(); const db = createMigratedDb();
    const queue = new AuthQueue({ db, backgroundMaintenance: false });
    try {
      commitOnBranch(repo, 'feature/oob', { 'oob.txt': 'out of band\n' });
      const request = queue.submit({ type: 'merge', command: 'mandible auth merge feature/oob --into main', title: 'Unproved merge',
        repo: path.basename(repo), cwd: repo, base_branch: 'main', head_branch: 'feature/oob', merge_head_sha: git(repo, ['rev-parse', 'feature/oob']) });
      git(repo, ['merge', '--no-ff', 'feature/oob', '-m', 'Out-of-band merge']);
      db.prepare('UPDATE auth_requests SET approved_by_user_id = ? WHERE id = ?').run(getOperator(db)!.id, request.id);
      const restarted = new AuthQueue({ db });
      try {
        (restarted as unknown as { sweepSuccessfulMergeFinalizers(): void }).sweepSuccessfulMergeFinalizers();
        await restarted.drainFinalizers();
        expect(restarted.getRequest(request.id)).toMatchObject({ status: 'pending', exit_code: null, merge_finalized_at: null, execution_evidence_id: null });
      } finally { restarted.dispose(); }
    } finally { queue.dispose(); db.close(); fs.rmSync(repo, { recursive: true, force: true }); }
  });

  it('refuses a conflicting request while the reviewed sibling is executing', async () => {
    const repo = createAuthCheckRepo(); const db = createMigratedDb();
    const queue = new AuthQueue({ db, hookManager: createNoopHookManager(), backgroundMaintenance: false });
    try {
      commitOnBranch(repo, 'feature/a', { 'shared.txt': 'a\n' });
      commitOnBranch(repo, 'feature/b', { 'shared.txt': 'b\n' });
      const sibling = await submitPausedSibling(queue, db, repo);
      await expect(Promise.resolve().then(() => queue.submit({ type: 'merge', command: 'mandible auth merge feature/b --into main',
        title: 'Conflicting sibling', repo: path.basename(repo), cwd: repo, base_branch: 'main', head_branch: 'feature/b',
        merge_head_sha: git(repo, ['rev-parse', 'feature/b']) }))).rejects.toThrow(/conflicts with pending request/);
      expect(queue.getRequest(sibling.id)?.status).toBe('executing');
      await completeFixturePublication(queue, sibling.id); await queue.drainFinalizers();
      expect(git(repo, ['rev-parse', 'main'])).not.toBe(sibling.merge_preflight_base_sha);
    } finally { queue.dispose(); db.close(); fs.rmSync(repo, { recursive: true, force: true }); }
  });

  it("re-pins pending siblings after a sibling merge and broadcasts auth:updated", async () => {
    const repo = createAuthCheckRepo();
    const db = createMigratedDb();
    const events: SseEvent[] = [];
    const envs: Array<NodeJS.ProcessEnv | undefined> = [];
    const queue = new AuthQueue({
      db,
      broadcast: (event) => events.push(event),
      executor: async (options) => {
        envs.push(options.env);
        return {
          exit_code: 1,
          signal: null,
          stdout: "",
          stderr: "fixture stop\n",
          output: "fixture stop\n",
          started_at: Date.now(),
          finished_at: Date.now(),
        };
      },
      hookManager: createNoopHookManager(),
    });
    try {
      commitOnBranch(repo, "feature/a", { "a.txt": "a\n" });
      commitOnBranch(repo, "feature/b", { "b.txt": "b\n" });
      registerWorkRepo(db, repo);
      configureSigningCredential(db, repo, "ssh_key");
      const repoName = path.basename(repo);

      const pendingB = queue.submit({
        type: "merge",
        command: "mandible auth merge feature/b --into main",
        title: "Merge feature/b",
        repo: repoName,
        base_branch: "main",
        head_branch: "feature/b",
        merge_head_sha: git(repo, ["rev-parse", "feature/b"]),
        cwd: repo,
      });
      const originalPin = pendingB.merge_candidate_pin_sha;
      expect(originalPin).toMatch(/^[0-9a-f]{40,64}$/);

      // Review F1 — the sibling merge is a genuine authorized queue merge:
      // signed, and recorded with its merge SHA by the completed request.
      const sibling = await submitPausedSibling(queue, db, repo);
      await completeFixturePublication(queue, sibling.id);
      const siblingMergeSha = git(repo, ["rev-parse", "main"]);
      await queue.drainFinalizers();

      const newBase = git(repo, ["rev-parse", "main"]);
      const refreshed = queue.getRequest(pendingB.id);
      expect(refreshed?.status).toBe("pending");
      expect(refreshed?.merge_preflight_base_sha).toBe(newBase);
      expect(refreshed?.merge_candidate_pin_sha).toMatch(/^[0-9a-f]{40,64}$/);
      expect(refreshed?.merge_candidate_pin_sha).not.toBe(originalPin);
      const lifecycle = db.prepare(
        "SELECT revision, snapshot_sha256 FROM auth_request_lifecycle_events WHERE auth_request_id = ? ORDER BY revision DESC LIMIT 1",
      ).get(pendingB.id) as { revision: number; snapshot_sha256: string };
      expect(lifecycle.revision).toBe(2);
      expect(lifecycle.snapshot_sha256).toBe(authSnapshotDigest(authRequestSnapshot(db, pendingB.id)));
      expect(git(repo, ["rev-parse", `refs/mandible/auth-candidates/${pendingB.id}`]))
        .toBe(refreshed!.merge_candidate_pin_sha);
      expect(git(repo, ["rev-parse", `${refreshed!.merge_candidate_pin_sha}^1`])).toBe(newBase);
      expect(git(repo, ["rev-parse", `${refreshed!.merge_candidate_pin_sha}^2`]))
        .toBe(pendingB.merge_head_sha);
      expect(events.some((event) => {
        const data = event.data as Record<string, unknown>;
        const request = data.request as Record<string, unknown> | undefined;
        return event.event === "auth:updated" && request?.id === pendingB.id;
      })).toBe(true);

      // Approval now hits the exact-candidate fast path.
      await approveFixtureRequest(queue, pendingB.id);
      await waitForStatus(queue, pendingB.id, "completed");
      expect(envs).toHaveLength(1);
      expect(envs[0]?.MANDIBLE_AUTH_SKIP_MERGE_PREFLIGHT).toBe("1");
      expect(envs[0]?.MANDIBLE_AUTH_PREFLIGHT_BASE_SHA).toBe(newBase);
      expect(envs[0]?.MANDIBLE_AUTH_CANDIDATE_PIN_SHA).toBe(refreshed!.merge_candidate_pin_sha);
    } finally {
      queue.dispose();
      db.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("revalidates and re-pins dependents of the merged request first", async () => {
    const repo = createAuthCheckRepo();
    const db = createMigratedDb();
    const events: SseEvent[] = [];
    const queue = new AuthQueue({ db, broadcast: (event) => events.push(event) });
    try {
      commitOnBranch(repo, "feature/a", { "a.txt": "a\n" });
      commitOnBranch(repo, "feature/other", { "other.txt": "other\n" });
      commitOnBranch(repo, "feature/dep", { "dep.txt": "dep\n" });
      registerWorkRepo(db, repo);
      configureSigningCredential(db, repo, "ssh_key");
      const repoName = path.basename(repo);

      const sibling = await submitPausedSibling(queue, db, repo);

      // Submitted first: without prioritization this request would be
      // revalidated first (created_at order).
      const other = queue.submit({
        type: "merge",
        command: "mandible auth merge feature/other --into main",
        title: "Merge feature/other",
        repo: repoName,
        base_branch: "main",
        head_branch: "feature/other",
        merge_head_sha: git(repo, ["rev-parse", "feature/other"]),
        cwd: repo,
      });
      const dep = queue.submit({
        type: "merge",
        command: "mandible auth merge feature/dep --into main",
        title: "Merge feature/dep",
        repo: repoName,
        base_branch: "main",
        head_branch: "feature/dep",
        merge_head_sha: git(repo, ["rev-parse", "feature/dep"]),
        cwd: repo,
        depends_on_id: sibling.id,
      });
      expect(other.merge_candidate_pin_sha).toMatch(/^[0-9a-f]{40,64}$/);
      expect(dep.merge_candidate_pin_sha).toMatch(/^[0-9a-f]{40,64}$/);

      await completeFixturePublication(queue, sibling.id);
      const siblingMergeSha = git(repo, ["rev-parse", "main"]);
      await queue.drainFinalizers();

      const newBase = git(repo, ["rev-parse", "main"]);
      expect(queue.getRequest(dep.id)?.merge_preflight_base_sha).toBe(newBase);
      expect(queue.getRequest(other.id)?.merge_preflight_base_sha).toBe(newBase);
      const updatedIds = events
        .filter((event) => event.event === "auth:updated")
        .map((event) => {
          const data = event.data as Record<string, unknown>;
          return (data.request as Record<string, unknown> | undefined)?.id;
        });
      const depIndex = updatedIds.indexOf(dep.id);
      const otherIndex = updatedIds.indexOf(other.id);
      expect(depIndex).toBeGreaterThanOrEqual(0);
      expect(otherIndex).toBeGreaterThanOrEqual(0);
      expect(depIndex).toBeLessThan(otherIndex);
    } finally {
      queue.dispose();
      db.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("leaves a sibling whose head moved after review un-repinned", async () => {
    const repo = createAuthCheckRepo();
    const db = createMigratedDb();
    const events: SseEvent[] = [];
    const queue = new AuthQueue({ db, broadcast: (event) => events.push(event) });
    try {
      commitOnBranch(repo, "feature/a", { "a.txt": "a\n" });
      commitOnBranch(repo, "feature/b", { "b.txt": "b\n" });
      registerWorkRepo(db, repo);
      const repoName = path.basename(repo);

      const sibling = await submitPausedSibling(queue, db, repo);
      const pendingB = queue.submit({
        type: "merge",
        command: "mandible auth merge feature/b --into main",
        title: "Merge feature/b",
        repo: repoName,
        base_branch: "main",
        head_branch: "feature/b",
        merge_head_sha: git(repo, ["rev-parse", "feature/b"]),
        cwd: repo,
      });
      const originalPin = pendingB.merge_candidate_pin_sha;
      const originalBase = pendingB.merge_preflight_base_sha;
      expect(originalPin).toMatch(/^[0-9a-f]{40,64}$/);

      // Head drift: the reviewed content changed after submission.
      git(repo, ["checkout", "feature/b"]);
      writeFile(repo, "b2.txt", "b2\n");
      git(repo, ["add", "."]);
      git(repo, ["commit", "-m", "revise feature/b"]);
      git(repo, ["checkout", "main"]);

      await completeFixturePublication(queue, sibling.id);
      await queue.drainFinalizers();

      // Head drift stays strict: the stale candidate is never re-attested.
      const untouched = queue.getRequest(pendingB.id);
      expect(untouched?.status).toBe("pending");
      expect(untouched?.merge_preflight_base_sha).toBe(originalBase);
      expect(untouched?.merge_candidate_pin_sha).toBe(originalPin);
      expect(events.some((event) => {
        const data = event.data as Record<string, unknown>;
        const request = data.request as Record<string, unknown> | undefined;
        return event.event === "auth:updated" && request?.id === pendingB.id;
      })).toBe(false);
    } finally {
      queue.dispose();
      db.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("defers sibling revalidation until a same-repo merge execution finishes", async () => {
    const repo = createAuthCheckRepo(); const db = createMigratedDb();
    let releaseExec!: () => void; let markStarted!: () => void;
    const gate = new Promise<void>(resolve => { releaseExec = resolve; });
    const started = new Promise<void>(resolve => { markStarted = resolve; });
    const queue = new AuthQueue({ db, hookManager: createNoopHookManager(), backgroundMaintenance: false,
      executor: async () => { markStarted(); await gate;
        return { exit_code: 1, signal: null, stdout: '', stderr: 'fixture stop', output: 'fixture stop', started_at: Date.now(), finished_at: Date.now() };
      } });
    try {
      for (const branch of ['a', 'exec', 'c']) commitOnBranch(repo, `feature/${branch}`, { [`${branch}.txt`]: `${branch}\n` });
      const sibling = await submitPausedSibling(queue, db, repo);
      const request = (branch: string) => queue.submit({ type: 'merge', command: `mandible auth merge feature/${branch} --into main`,
        title: branch, repo: path.basename(repo), cwd: repo, base_branch: 'main', head_branch: `feature/${branch}`,
        merge_head_sha: git(repo, ['rev-parse', `feature/${branch}`]) });
      const execRequest = request('exec'); const pending = request('c');
      const staleBase = pending.merge_preflight_base_sha;
      // Lose only admission to the finalizer queue; the signed publication and normal result remain durable.
      const finalizers = (queue as unknown as { finalizerQueue: { enqueue(id: string): boolean } }).finalizerQueue;
      const admission = vi.spyOn(finalizers, 'enqueue').mockReturnValue(false);
      await completeFixturePublication(queue, sibling.id);
      admission.mockRestore();
      await approveFixtureRequest(queue, execRequest.id); await started;
      (queue as unknown as { sweepSuccessfulMergeFinalizers(): void }).sweepSuccessfulMergeFinalizers();
      expect(queue.getRequest(pending.id)?.merge_preflight_base_sha).toBe(staleBase);
      await expect(approveFixtureRequest(queue, pending.id)).rejects.toThrow(/Refusal: execution_chain_busy/);
      releaseExec(); await waitForStatus(queue, execRequest.id, 'completed'); await queue.drainFinalizers();
      expect(queue.getRequest(pending.id)).toMatchObject({ status: 'pending', merge_preflight_base_sha: git(repo, ['rev-parse', 'main']) });
      expect(queue.getRequest(pending.id)?.merge_candidate_pin_sha).toMatch(/^[0-9a-f]{40,64}$/);
    } finally { releaseExec?.(); queue.dispose(); db.close(); fs.rmSync(repo, { recursive: true, force: true }); }
  });
});
