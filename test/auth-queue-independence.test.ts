import { AUTH_MERGE_REVIEW } from "./helpers/auth-queue-fixtures.js";
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
import { authRequestSnapshot, authSnapshotDigest } from "../src/auth-request-snapshot.js";
import type { SseEvent } from "../src/types.js";
import { addCredential, getOperator } from "../src/users/store.js";
import { commitOnBranch, configureSigningCredential, createAuthCheckRepo, createLedgerIssue, createLedgerProject, createMigratedDb, createNoopHookManager, createQueue, git, registerWorkRepo, signedMergeIntoMain, uniqueMissingPath, waitForStatus, writeFile } from "./helpers/auth-queue-fixtures.js";

async function submitPausedSibling(queue: AuthQueue, db: Parameters<typeof registerWorkRepo>[0], repo: string, branch = 'feature/a') {
  registerWorkRepo(db, repo);
  const request = (await queue.submit({ ...AUTH_MERGE_REVIEW,  type: 'merge', command: `mandible auth merge ${branch} --into main`,
    title: 'Reviewed sibling', repo: path.basename(repo), cwd: repo, base_branch: 'main', head_branch: branch,
    merge_head_sha: git(repo, ['rev-parse', branch]) }));
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
      const pending = (await queue.submit({ ...AUTH_MERGE_REVIEW,
        type: "merge", command: "mandible auth merge feature/b --into main", title: "Merge b",
        repo: project.project.project_key, base_branch: "main", head_branch: "feature/b",
        merge_head_sha: git(repo, ["rev-parse", "feature/b"]), cwd: repo,
        requester_evidence_method: "api_token", requester_credential_id: credential.id,
        require_delivery_custody: true, issue_references: ["8420a44"],
      }, operator.id));
      const sibling = await submitPausedSibling(queue, db, repo);
      await completeFixturePublication(queue, sibling.id);
      const firstMerge = git(repo, ["rev-parse", "main"]);
      await queue.drainFinalizers();
      const historical = (await queue.getRequest(pending.id))!;
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
      const proof = (await queue.inspectPendingCandidateSnapshotRepair(pending.id, actor));
      expect(proof).toMatchObject({ lifecycle_revision: 1, custody_generation: 1,
        current_base_sha: firstMerge });
      await expect((async () => (await queue.repairPendingCandidateSnapshot(pending.id, actor, 1, 1, "0".repeat(64)))())).rejects
        .toThrow(AuthQueueError);
      const otherCredential = addCredential(db, operator.id, {
        type: "api_token", fingerprint: `candidate-repair-other-${crypto.randomUUID()}`,
      });
      await expect((async () => (await queue.inspectPendingCandidateSnapshotRepair(pending.id, {
        ...actor, credential_id: otherCredential.id,
      }))())).rejects.toThrow(AuthQueueError);
      db.prepare("UPDATE auth_requests SET title = 'Tampered' WHERE id = ?").run(pending.id);
      await expect((async () => (await queue.inspectPendingCandidateSnapshotRepair(pending.id, actor))())).rejects.toThrow(AuthQueueError);
      db.prepare("UPDATE auth_requests SET title = ? WHERE id = ?").run(pending.title, pending.id);
      db.prepare("UPDATE auth_requests SET merge_atomic_enabled = 1 WHERE id = ?").run(pending.id);
      await expect((async () => (await queue.inspectPendingCandidateSnapshotRepair(pending.id, actor))())).rejects.toThrow(AuthQueueError);
      db.prepare("UPDATE auth_requests SET merge_atomic_enabled = 0 WHERE id = ?").run(pending.id);
      (await queue.repairPendingCandidateSnapshot(pending.id, actor, 1, 1, proof.current_snapshot_sha256));
      expect(queue.listLifecycleEvents(pending.id).at(-1)).toMatchObject({
        revision: 2, event_type: "revised", credential_id: credential.id,
      });
      await expect((async () => (await queue.inspectPendingCandidateSnapshotRepair(pending.id, actor))())).rejects.toThrow(AuthQueueError);
    } finally {
      (await queue.dispose()); db.close(); fs.rmSync(repo, { recursive: true, force: true });
    }
  });
  it("accepts pairwise-independent pending merge requests", async () => {
    const repo = createAuthCheckRepo();
    const queue = createQueue();
    try {
      commitOnBranch(repo, "feature/a", { "a.txt": "a\n" });
      commitOnBranch(repo, "feature/b", { "b.txt": "b\n" });

      const first = (await queue.submit({ ...AUTH_MERGE_REVIEW,
        type: "merge",
        command: "mandible auth merge feature/a --into main",
        title: "Merge feature/a",
        repo: path.basename(repo),
        base_branch: "main",
        head_branch: "feature/a",
        cwd: repo,
      }));
      const check = (await queue.checkMergeIndependence({
        repo: path.basename(repo),
        base_branch: "main",
        head_branch: "feature/b",
        cwd: repo,
      }));
      expect(check.status).toBe("clean");
      expect(check.checked_requests).toBe(1);

      const second = (await queue.submit({ ...AUTH_MERGE_REVIEW,
        type: "merge",
        command: "mandible auth merge feature/b --into main",
        title: "Merge feature/b",
        repo: path.basename(repo),
        base_branch: "main",
        head_branch: "feature/b",
        cwd: repo,
      }));

      expect((await queue.getRequest(first.id))?.status).toBe("pending");
      expect((await queue.getRequest(second.id))?.status).toBe("pending");
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("rejects a pending merge request that conflicts with the queued simulation", async () => {
    const repo = createAuthCheckRepo();
    const queue = createQueue();
    try {
      commitOnBranch(repo, "feature/a", { "shared.txt": "a\n" });
      commitOnBranch(repo, "feature/b", { "shared.txt": "b\n" });

      const first = (await queue.submit({ ...AUTH_MERGE_REVIEW,
        type: "merge",
        command: "mandible auth merge feature/a --into main",
        title: "Merge feature/a",
        repo: path.basename(repo),
        base_branch: "main",
        head_branch: "feature/a",
        cwd: repo,
      }));

      const check = (await queue.checkMergeIndependence({
        repo: path.basename(repo),
        base_branch: "main",
        head_branch: "feature/b",
        cwd: repo,
      }));
      expect(check.status).toBe("conflict");
      expect(check.conflicts[0]?.request_id).toBe(first.id);
      expect(check.conflicts[0]?.files).toContain("shared.txt");

      await expect((async () => (await queue.submit({ ...AUTH_MERGE_REVIEW,
        type: "merge",
        command: "mandible auth merge feature/b --into main",
        title: "Merge feature/b",
        repo: path.basename(repo),
        base_branch: "main",
        head_branch: "feature/b",
        cwd: repo,
      }))())).rejects.toThrow(AuthQueueError);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("reports merge check infrastructure failures as errors, not conflicts", async () => {
    const queue = createQueue();
    const missingCwd = uniqueMissingPath("mandible-missing-auth-check-cwd");

    const check = (await queue.checkMergeIndependence({
      repo: "missing-fixture-repo",
      base_branch: "main",
      head_branch: "feature/demo",
      cwd: missingCwd,
    }));

    expect(check.status).toBe("error");
    expect(check.conflicts).toEqual([]);
    expect(check.reason).toContain("ENOENT");
  });

  it("reports tracked dirty worktree state as a merge preflight error", async () => {
    const repo = createAuthCheckRepo();
    const queue = createQueue();
    try {
      commitOnBranch(repo, "feature/demo", { "feature.txt": "feature\n" });
      writeFile(repo, "shared.txt", "dirty\n");

      const check = (await queue.checkMergeIndependence({
        repo: path.basename(repo),
        base_branch: "main",
        head_branch: "feature/demo",
        cwd: repo,
      }));

      expect(check.status).toBe("error");
      expect(check.reason).toContain("tracked worktree changes are present");
      expect(check.reason).toContain("shared.txt");
      expect(check.conflicts).toEqual([]);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("rejects merge request submission when shared preflight reports an error", async () => {
    const repo = createAuthCheckRepo();
    const queue = createQueue();
    try {
      commitOnBranch(repo, "feature/demo", { "feature.txt": "feature\n" });
      writeFile(repo, "shared.txt", "dirty\n");

      await expect((async () => (await queue.submit({ ...AUTH_MERGE_REVIEW,
        type: "merge",
        command: "mandible auth merge feature/demo --into main",
        title: "Merge feature/demo",
        repo: path.basename(repo),
        base_branch: "main",
        head_branch: "feature/demo",
        cwd: repo,
      }))())).rejects.toThrow(/merge preflight failed/);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("classifies a queued request whose head branch was torn down as stale, not a conflict (fbf2a58)", async () => {
    const repo = createAuthCheckRepo();
    const queue = createQueue();
    try {
      commitOnBranch(repo, "feature/gone", { "gone.txt": "gone\n" });
      commitOnBranch(repo, "feature/live", { "live.txt": "live\n" });

      const queued = (await queue.submit({ ...AUTH_MERGE_REVIEW,
        type: "merge",
        command: "mandible auth merge feature/gone --into main",
        title: "Merge feature/gone",
        repo: path.basename(repo),
        base_branch: "main",
        head_branch: "feature/gone",
        cwd: repo,
      }));

      // Simulate the incident: the merge landed and the head branch was torn
      // down, but the queue row was never finalized.
      git(repo, ["branch", "-D", "feature/gone"]);

      const check = (await queue.checkMergeIndependence({
        repo: path.basename(repo),
        base_branch: "main",
        head_branch: "feature/live",
        cwd: repo,
      }));

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

  it.each([false, true])('keeps an unreviewed out-of-band merge pending even when its branch is deleted: %s', async (deleteBranch) => {
    const repo = createAuthCheckRepo(); const db = createMigratedDb();
    const queue = new AuthQueue({ db, backgroundMaintenance: false });
    try {
      commitOnBranch(repo, 'feature/landed', { 'landed.txt': 'landed\n' });
      const request = (await queue.submit({ ...AUTH_MERGE_REVIEW,  type: 'merge', command: 'mandible auth merge feature/landed --into main', title: 'Unreviewed merge',
        repo: path.basename(repo), cwd: repo, base_branch: 'main', head_branch: 'feature/landed', merge_head_sha: git(repo, ['rev-parse', 'feature/landed']) }));
      git(repo, ['merge', '--no-ff', 'feature/landed', '-m', 'Out-of-band merge']);
      if (deleteBranch) git(repo, ['branch', '-D', 'feature/landed']);
      const events: SseEvent[] = [];
      const restarted = new AuthQueue({ db, broadcast: event => events.push(event) });
      try {
        expect((await restarted.getRequest(request.id))).toMatchObject({ status: 'pending', exit_code: null, merge_finalized_at: null, execution_evidence_id: null });
        expect(events.some(event => event.event === 'auth:merged' || event.event === 'auth:resolved')).toBe(false);
      } finally { (await restarted.dispose()); }
    } finally { (await queue.dispose()); db.close(); fs.rmSync(repo, { recursive: true, force: true }); }
  });

  it("leaves a pending merge whose head is not yet in target untouched (fbf2a58)", async () => {
    const repo = createAuthCheckRepo();
    const db = createMigratedDb();
    try {
      commitOnBranch(repo, "feature/unmerged", { "unmerged.txt": "unmerged\n" });
      const headSha = git(repo, ["rev-parse", "feature/unmerged"]);

      const queue = new AuthQueue({ db });
      const request = (await queue.submit({ ...AUTH_MERGE_REVIEW,
        type: "merge",
        command: "mandible auth merge feature/unmerged --into main",
        title: "Merge feature/unmerged",
        repo: path.basename(repo),
        base_branch: "main",
        head_branch: "feature/unmerged",
        merge_head_sha: headSha,
        cwd: repo,
        target_repo_root: repo,
      }));
      (await queue.dispose());

      // Nothing landed: the head is genuinely absent from main.
      const restarted = new AuthQueue({ db });
      try {
        const untouched = (await restarted.getRequest(request.id));
        expect(untouched?.status).toBe("pending");
        expect(untouched?.exit_code).toBeNull();
        expect(untouched?.merge_finalized_at ?? null).toBeNull();
      } finally {
        (await restarted.dispose());
      }
    } finally {
      db.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("does NOT reconcile when the head branch was recreated at the target sha, disagreeing with the recorded merge_head_sha (fbf2a58 round 2)", async () => {
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
      const request = (await queue.submit({ ...AUTH_MERGE_REVIEW,
        type: "merge",
        command: "mandible auth merge feature/recreated --into main",
        title: "Merge feature/recreated",
        repo: path.basename(repo),
        base_branch: "main",
        head_branch: "feature/recreated",
        merge_head_sha: originalHeadSha,
        cwd: repo,
        target_repo_root: repo,
      }));
      expect((await queue.getRequest(request.id))?.status).toBe("pending");

      // The branch is force-recreated at the target tip (T). The unmerged work at
      // A is now abandoned; the live ref points at T. A naive proof taken from the
      // live ref ("T is an ancestor of T") would falsely complete the request.
      git(repo, ["branch", "-f", "feature/recreated", "main"]);
      expect(git(repo, ["rev-parse", "feature/recreated"])).toBe(targetSha);
      (await queue.dispose());

      const restarted = new AuthQueue({ db });
      try {
        const row = (await restarted.getRequest(request.id));
        // Recorded sha is authoritative and disagrees with the live ref: the
        // request is NOT reconcilable and stays pending.
        expect(row?.status).toBe("pending");
        expect(row?.exit_code ?? null).toBeNull();
        expect(row?.merge_finalized_at ?? null).toBeNull();
      } finally {
        (await restarted.dispose());
      }
    } finally {
      db.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("fully drops approval attribution and execution evidence when parking a self-merge execution (fbf2a58 round 2)", async () => {
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

      const request = (await queue.submit({ ...AUTH_MERGE_REVIEW,
        type: "merge",
        command: "mandible auth merge feature/parked --into main",
        title: "Merge feature/parked",
        repo: path.basename(repo),
        base_branch: "main",
        head_branch: "feature/parked",
        cwd: repo,
        target_repo_root: repo,
      }));
      // Stage the row exactly as it would look mid-execution: executing, with the
      // approver and execution evidence attached.
      db.prepare(
        "UPDATE auth_requests SET status = 'executing', approved_at = ?, approved_by_user_id = ?, execution_evidence_id = ? WHERE id = ?"
      ).run(Date.now(), operator.id, "evidence-parked-1", request.id);

      (queue as unknown as { parkExecutionForRestart(r: unknown): void }).parkExecutionForRestart(
        (await queue.getRequest(request.id))!,
      );

      const parked = (await queue.getRequest(request.id));
      expect(parked?.status).toBe("pending");
      expect(parked?.approved_at ?? null).toBeNull();
      // The fix: stale approval attribution and evidence are fully cleared so a
      // later evidence-driven finalizer cannot mistake them for a live approval.
      expect(parked?.approved_by_user_id ?? null).toBeNull();
      expect(parked?.execution_evidence_id ?? null).toBeNull();
    } finally {
      (await queue.dispose());
      db.close();
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('does not turn ancestry and a raw approver ID into execution proof', async () => {
    const repo = createAuthCheckRepo(); const db = createMigratedDb();
    const queue = new AuthQueue({ db, backgroundMaintenance: false });
    try {
      commitOnBranch(repo, 'feature/oob', { 'oob.txt': 'out of band\n' });
      const request = (await queue.submit({ ...AUTH_MERGE_REVIEW,  type: 'merge', command: 'mandible auth merge feature/oob --into main', title: 'Unproved merge',
        repo: path.basename(repo), cwd: repo, base_branch: 'main', head_branch: 'feature/oob', merge_head_sha: git(repo, ['rev-parse', 'feature/oob']) }));
      git(repo, ['merge', '--no-ff', 'feature/oob', '-m', 'Out-of-band merge']);
      db.prepare('UPDATE auth_requests SET approved_by_user_id = ? WHERE id = ?').run(getOperator(db)!.id, request.id);
      const restarted = new AuthQueue({ db });
      try {
        await (restarted as unknown as { sweepSuccessfulMergeFinalizers(): Promise<void> }).sweepSuccessfulMergeFinalizers();
        await restarted.drainFinalizers();
        expect((await restarted.getRequest(request.id))).toMatchObject({ status: 'pending', exit_code: null, merge_finalized_at: null, execution_evidence_id: null });
      } finally { (await restarted.dispose()); }
    } finally { (await queue.dispose()); db.close(); fs.rmSync(repo, { recursive: true, force: true }); }
  });

  it('refuses a conflicting request while the reviewed sibling is executing', async () => {
    const repo = createAuthCheckRepo(); const db = createMigratedDb();
    const queue = new AuthQueue({ db, hookManager: createNoopHookManager(), backgroundMaintenance: false });
    try {
      commitOnBranch(repo, 'feature/a', { 'shared.txt': 'a\n' });
      commitOnBranch(repo, 'feature/b', { 'shared.txt': 'b\n' });
      const sibling = await submitPausedSibling(queue, db, repo);
      await expect(Promise.resolve().then(async () => (await queue.submit({ ...AUTH_MERGE_REVIEW,  type: 'merge', command: 'mandible auth merge feature/b --into main',
        title: 'Conflicting sibling', repo: path.basename(repo), cwd: repo, base_branch: 'main', head_branch: 'feature/b',
        merge_head_sha: git(repo, ['rev-parse', 'feature/b']) })))).rejects.toThrow(/conflicts with pending request/);
      expect((await queue.getRequest(sibling.id))?.status).toBe('executing');
      await completeFixturePublication(queue, sibling.id); await queue.drainFinalizers();
      expect(git(repo, ['rev-parse', 'main'])).not.toBe(sibling.merge_preflight_base_sha);
    } finally { (await queue.dispose()); db.close(); fs.rmSync(repo, { recursive: true, force: true }); }
  });

  // After an authorized sibling merge, pending siblings are re-pinned onto the
  // new base (dependents of the merged request first) and approval takes the
  // exact-candidate fast path; a sibling whose head moved stays strict.
  it("re-pins pending siblings after a sibling merge, dependents first, never a drifted head", async () => {
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
      for (const branch of ["a", "other", "dep", "drifted"]) {
        commitOnBranch(repo, `feature/${branch}`, { [`${branch}.txt`]: `${branch}\n` });
      }
      registerWorkRepo(db, repo);
      configureSigningCredential(db, repo, "ssh_key");
      const submit = async (branch: string, extra: { depends_on_ids?: string[] } = {}) => (await queue.submit({ ...AUTH_MERGE_REVIEW,
        type: "merge",
        command: `mandible auth merge feature/${branch} --into main`,
        title: `Merge feature/${branch}`,
        repo: path.basename(repo),
        base_branch: "main",
        head_branch: `feature/${branch}`,
        merge_head_sha: git(repo, ["rev-parse", `feature/${branch}`]),
        cwd: repo,
        ...extra,
      }));

      // Review F1 — the sibling merge is a genuine authorized queue merge.
      const sibling = await submitPausedSibling(queue, db, repo);
      // Submitted first: without prioritization `other` would be revalidated first.
      const other = (await submit("other"));
      const dep = (await submit("dep", { depends_on_ids: [sibling.id] }));
      const drifted = (await submit("drifted"));
      for (const request of [other, dep, drifted]) expect(request.merge_candidate_pin_sha).toMatch(/^[0-9a-f]{40,64}$/);

      git(repo, ["checkout", "feature/drifted"]);
      writeFile(repo, "drifted2.txt", "revised\n");
      git(repo, ["add", "."]);
      git(repo, ["commit", "-m", "revise feature/drifted"]);
      git(repo, ["checkout", "main"]);

      await completeFixturePublication(queue, sibling.id);
      await queue.drainFinalizers();
      const newBase = git(repo, ["rev-parse", "main"]);

      const updatedIds = events
        .filter((event) => event.event === "auth:updated")
        .map((event) => ((event.data as Record<string, unknown>).request as Record<string, unknown> | undefined)?.id);
      expect(updatedIds.indexOf(dep.id)).toBeGreaterThanOrEqual(0);
      expect(updatedIds.indexOf(dep.id)).toBeLessThan(updatedIds.indexOf(other.id));
      expect(updatedIds).not.toContain(drifted.id);

      const refreshed = (await queue.getRequest(other.id))!;
      expect(refreshed.status).toBe("pending");
      expect(refreshed.merge_preflight_base_sha).toBe(newBase);
      expect(refreshed.merge_candidate_pin_sha).not.toBe(other.merge_candidate_pin_sha);
      expect((await queue.getRequest(dep.id))?.merge_preflight_base_sha).toBe(newBase);
      const lifecycle = db.prepare(
        "SELECT revision, snapshot_sha256 FROM auth_request_lifecycle_events WHERE auth_request_id = ? ORDER BY revision DESC LIMIT 1",
      ).get(other.id) as { revision: number; snapshot_sha256: string };
      expect(lifecycle.revision).toBe(2);
      expect(lifecycle.snapshot_sha256).toBe(authSnapshotDigest(authRequestSnapshot(db, other.id)));
      expect(git(repo, ["rev-parse", `refs/mandible/auth-candidates/${other.id}`])).toBe(refreshed.merge_candidate_pin_sha);
      expect(git(repo, ["rev-parse", `${refreshed.merge_candidate_pin_sha}^1`])).toBe(newBase);
      expect(git(repo, ["rev-parse", `${refreshed.merge_candidate_pin_sha}^2`])).toBe(other.merge_head_sha);

      // Head drift stays strict: the stale candidate is never re-attested.
      expect((await queue.getRequest(drifted.id))).toMatchObject({
        status: "pending",
        merge_preflight_base_sha: drifted.merge_preflight_base_sha,
        merge_candidate_pin_sha: drifted.merge_candidate_pin_sha,
      });

      // Approval of a re-pinned sibling takes the exact-candidate fast path.
      await approveFixtureRequest(queue, other.id);
      await waitForStatus(queue, other.id, "failed");
      expect(envs.at(-1)).toMatchObject({
        MANDIBLE_AUTH_SKIP_MERGE_PREFLIGHT: "1",
        MANDIBLE_AUTH_PREFLIGHT_BASE_SHA: newBase,
        MANDIBLE_AUTH_CANDIDATE_PIN_SHA: refreshed.merge_candidate_pin_sha,
      });
    } finally {
      (await queue.dispose());
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
      const request = async (branch: string) => (await queue.submit({ ...AUTH_MERGE_REVIEW,  type: 'merge', command: `mandible auth merge feature/${branch} --into main`,
        title: branch, repo: path.basename(repo), cwd: repo, base_branch: 'main', head_branch: `feature/${branch}`,
        merge_head_sha: git(repo, ['rev-parse', `feature/${branch}`]) }));
      const execRequest = (await request('exec')); const pending = (await request('c'));
      const staleBase = pending.merge_preflight_base_sha;
      // Lose only admission to the finalizer queue; the signed publication and normal result remain durable.
      const finalizers = (queue as unknown as { finalizerQueue: { enqueue(id: string): boolean } }).finalizerQueue;
      const admission = vi.spyOn(finalizers, 'enqueue').mockReturnValue(false);
      await completeFixturePublication(queue, sibling.id);
      admission.mockRestore();
      await approveFixtureRequest(queue, execRequest.id); await started;
      void (queue as unknown as { sweepSuccessfulMergeFinalizers(): Promise<void> }).sweepSuccessfulMergeFinalizers();
      expect((await queue.getRequest(pending.id))?.merge_preflight_base_sha).toBe(staleBase);
      await expect(approveFixtureRequest(queue, pending.id)).rejects.toThrow(/Refusal: execution_chain_busy/);
      releaseExec(); await waitForStatus(queue, execRequest.id, 'failed'); await queue.drainFinalizers();
      expect((await queue.getRequest(pending.id))).toMatchObject({ status: 'pending', merge_preflight_base_sha: git(repo, ['rev-parse', 'main']) });
      expect((await queue.getRequest(pending.id))?.merge_candidate_pin_sha).toMatch(/^[0-9a-f]{40,64}$/);
    } finally { releaseExec?.(); (await queue.dispose()); db.close(); fs.rmSync(repo, { recursive: true, force: true }); }
  });
});
