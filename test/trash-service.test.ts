import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { openDb, type Db } from "../src/db.js";
import { addOrUpdateCheckout, addProject } from "../src/ledger/project-registry.js";
import { registerTrashRoutes } from "../src/routes/trash.js";
import { Router } from "../src/server.js";
import {
  createTrashEntry,
  gcTrashEntries,
  listTrashEntries,
  restoreTrashEntry,
  startTrashGcScheduler,
  stopTrashGcScheduler,
} from "../src/trash-service.js";
import { deriveReapingSafety, WorkScanner } from "../src/work-scanner.js";

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim();
}

describe.sequential("trash custody", () => {
  let tempDir: string;
  let repoRoot: string;
  let featureWorktree: string;
  let db: Db;
  let projectId: string;
  let checkoutId: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-trash-"));
    repoRoot = path.join(tempDir, "repo");
    featureWorktree = path.join(repoRoot, "worktrees", "feature-trash");
    fs.mkdirSync(repoRoot, { recursive: true });
    git(repoRoot, ["init", "-b", "main"]);
    git(repoRoot, ["config", "user.name", "Trash Test"]);
    git(repoRoot, ["config", "user.email", "trash-test@example.invalid"]);
    fs.writeFileSync(path.join(repoRoot, "tracked.txt"), "base\n");
    git(repoRoot, ["add", "tracked.txt"]);
    git(repoRoot, ["commit", "-m", "base"]);
    git(repoRoot, ["branch", "feature/trash"]);
    fs.mkdirSync(path.dirname(featureWorktree), { recursive: true });
    git(repoRoot, ["worktree", "add", featureWorktree, "feature/trash"]);

    db = openDb(path.join(tempDir, "mandible.db"));
    projectId = addProject(db, { project_key: "trash-test", display_name: "Trash Test" }, 1).id;
    checkoutId = addOrUpdateCheckout(db, "trash-test", {
      root: repoRoot,
      work_repo_id: "path-derived-local-id",
      name: "repo",
      default_branch: "main",
    }, 2).checkout.id;
  });

  afterEach(() => {
    stopTrashGcScheduler();
    vi.useRealTimers();
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("snapshots tracked and untracked bytes, removes local refs, and restores them", () => {
    const expectedWorktreePath = fs.realpathSync(featureWorktree);
    fs.writeFileSync(path.join(featureWorktree, "tracked.txt"), "dirty tracked\n");
    fs.writeFileSync(path.join(featureWorktree, "untracked.bin"), Buffer.from([0, 1, 2, 255]));

    const created = createTrashEntry(db, {
      project: "trash-test",
      branch: "feature/trash",
      reason: "superseded",
      actor: "test-worker",
      issue_refs: ["5cb1eb3"],
    }, 1_000);

    expect(created.outcome).toEqual({
      worktree_removed: true,
      branch_removed: true,
      worktree_path: expectedWorktreePath,
    });
    expect(db.prepare(
      `SELECT project_id, checkout_id, repo_root, branch, issue_refs_json,
              reason, actor, snapshot_ref, snapshot_oid, original_oid,
              retention_policy, retention_days, state, created_at, expires_at
         FROM trash_entries WHERE id = ?`,
    ).get(created.entry.id)).toEqual({
      project_id: projectId,
      checkout_id: checkoutId,
      repo_root: repoRoot,
      branch: "feature/trash",
      issue_refs_json: '["5cb1eb3"]',
      reason: "superseded",
      actor: "test-worker",
      snapshot_ref: created.entry.snapshot_ref,
      snapshot_oid: created.entry.snapshot_oid,
      original_oid: created.entry.original_oid,
      retention_policy: "trash-retention.v1",
      retention_days: 30,
      state: "active",
      created_at: 1_000,
      expires_at: 2_592_001_000,
    });
    expect(fs.existsSync(featureWorktree)).toBe(false);
    expect(git(repoRoot, ["show-ref", "--verify", created.entry.snapshot_ref])).toContain(
      created.entry.snapshot_oid,
    );
    expect(spawnSync("git", ["rev-parse", "--verify", "refs/heads/feature/trash"], {
      cwd: repoRoot,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    }).status).not.toBe(0);
    expect(git(repoRoot, ["show", `${created.entry.snapshot_ref}:tracked.txt`])).toBe("dirty tracked");
    const restoredBytes = spawnSync("git", ["show", `${created.entry.snapshot_ref}:untracked.bin`], {
      cwd: repoRoot,
      encoding: "buffer",
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    }).stdout as Buffer;
    expect([...restoredBytes]).toEqual([0, 1, 2, 255]);

    const restoredPath = path.join(repoRoot, "worktrees", "feature-restored");
    const restored = restoreTrashEntry(db, created.entry.id, {
      worktree_path: restoredPath,
      actor: "test-worker",
    }, 2_000);
    expect(restored.entry.state).toBe("restored");
    expect(fs.readFileSync(path.join(restoredPath, "tracked.txt"), "utf8")).toBe("dirty tracked\n");
    expect([...fs.readFileSync(path.join(restoredPath, "untracked.bin"))]).toEqual([0, 1, 2, 255]);
  });

  it("exposes the thin versioned route and list envelope", async () => {
    const router = new Router();
    registerTrashRoutes(router, db);
    const created = await router.invoke({
      method: "POST",
      url: "/api/v1/trash",
      body: {
        project: "trash-test",
        branch: "feature/trash",
        reason: "manual",
        issue_refs: ["50d4a6b"],
      },
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      entry: { project_key: "trash-test", branch: "feature/trash", issue_refs: ["50d4a6b"] },
      outcome: { worktree_removed: true, branch_removed: true },
    });
    const createdEntry = (created.body as { entry: Record<string, unknown> }).entry;
    expect(createdEntry.issue_refs_json).toBeUndefined();
    expect(createdEntry.outcome_json).toBeUndefined();

    const listed = await router.invoke({ method: "GET", url: "/api/v1/trash?project=trash-test" });
    expect(listed.status).toBe(200);
    expect(listed.body).toMatchObject({ entries: [{ branch: "feature/trash" }] });
  });

  it("expires only an exact matching immutable ref and reports missing refs", () => {
    const created = createTrashEntry(db, {
      project: "trash-test",
      branch: "feature/trash",
      reason: "merged",
      retention_days: 1,
    }, 1_000);
    git(repoRoot, ["update-ref", "-d", created.entry.snapshot_ref, created.entry.snapshot_oid]);

    const failed = gcTrashEntries(db, { now: 86_401_001 });
    expect(failed).toMatchObject({ expired: 0, failed: 1 });
    expect(failed.outcomes[0]).toMatchObject({ id: created.entry.id, status: "failed" });
  });

  it("fails closed on protected branches, path-derived project ids, and restore collisions", () => {
    expect(() => createTrashEntry(db, {
      project: "trash-test",
      branch: "main",
      reason: "manual",
    })).toThrow(/protected\/default branch/);
    expect(() => createTrashEntry(db, {
      project: "path-derived-local-id",
      branch: "feature/trash",
      reason: "manual",
    })).toThrow(/path-derived work_repo_id/);

    const created = createTrashEntry(db, {
      project: "trash-test",
      branch: "feature/trash",
      reason: "manual",
    });
    git(repoRoot, ["branch", "feature/trash", "main"]);
    expect(() => restoreTrashEntry(db, created.entry.id)).toThrow(/branch already exists/);
    expect(git(repoRoot, ["show-ref", "--verify", created.entry.snapshot_ref])).toContain(
      created.entry.snapshot_oid,
    );
  });

  it("fails closed when a dirty submodule or embedded repository cannot be captured losslessly", () => {
    const submoduleRepo = path.join(tempDir, "submodule-source");
    fs.mkdirSync(submoduleRepo);
    git(submoduleRepo, ["init", "-b", "main"]);
    git(submoduleRepo, ["config", "user.name", "Trash Test"]);
    git(submoduleRepo, ["config", "user.email", "trash-test@example.invalid"]);
    fs.writeFileSync(path.join(submoduleRepo, "nested.txt"), "committed\n");
    git(submoduleRepo, ["add", "nested.txt"]);
    git(submoduleRepo, ["commit", "-m", "nested base"]);
    git(featureWorktree, [
      "-c", "protocol.file.allow=always", "submodule", "add", submoduleRepo, "module",
    ]);
    git(featureWorktree, ["commit", "-am", "add submodule"]);
    fs.writeFileSync(path.join(featureWorktree, "module", "nested.txt"), "dirty nested\n");

    expect(() => createTrashEntry(db, {
      project: "trash-test",
      branch: "feature/trash",
      reason: "manual",
    })).toThrow(/dirty submodule/);
    expect(fs.existsSync(featureWorktree)).toBe(true);
    expect(listTrashEntries(db)).toEqual([]);
  });

  it("rejects a clean tracked submodule advanced to an uncustodied local commit", () => {
    const submoduleRepo = path.join(tempDir, "advanced-submodule-source");
    fs.mkdirSync(submoduleRepo);
    git(submoduleRepo, ["init", "-b", "main"]);
    git(submoduleRepo, ["config", "user.name", "Trash Test"]);
    git(submoduleRepo, ["config", "user.email", "trash-test@example.invalid"]);
    fs.writeFileSync(path.join(submoduleRepo, "nested.txt"), "base\n");
    git(submoduleRepo, ["add", "nested.txt"]);
    git(submoduleRepo, ["commit", "-m", "nested base"]);
    git(featureWorktree, [
      "-c", "protocol.file.allow=always", "submodule", "add", submoduleRepo, "module",
    ]);
    git(featureWorktree, ["commit", "-am", "add submodule"]);

    const modulePath = path.join(featureWorktree, "module");
    git(modulePath, ["config", "user.name", "Trash Test"]);
    git(modulePath, ["config", "user.email", "trash-test@example.invalid"]);
    fs.writeFileSync(path.join(modulePath, "nested.txt"), "local commit only\n");
    git(modulePath, ["add", "nested.txt"]);
    git(modulePath, ["commit", "-m", "uncustodied local commit"]);
    expect(git(modulePath, ["status", "--porcelain"])).toBe("");

    expect(() => createTrashEntry(db, {
      project: "trash-test",
      branch: "feature/trash",
      reason: "manual",
    })).toThrow(/advanced tracked gitlinks/);
    expect(fs.existsSync(featureWorktree)).toBe(true);
    expect(listTrashEntries(db)).toEqual([]);
  });

  it("rejects an untracked embedded repository before removing the worktree", () => {
    const embedded = path.join(featureWorktree, "embedded");
    fs.mkdirSync(embedded);
    git(embedded, ["init", "-b", "main"]);
    git(embedded, ["config", "user.name", "Trash Test"]);
    git(embedded, ["config", "user.email", "trash-test@example.invalid"]);
    fs.writeFileSync(path.join(embedded, "nested.txt"), "nested\n");
    git(embedded, ["add", "nested.txt"]);
    git(embedded, ["commit", "-m", "embedded base"]);

    expect(() => createTrashEntry(db, {
      project: "trash-test",
      branch: "feature/trash",
      reason: "manual",
    })).toThrow(/embedded repositories/);
    expect(fs.existsSync(featureWorktree)).toBe(true);
    expect(listTrashEntries(db)).toEqual([]);
  });

  it("restores a remove_failed entry from live Git facts without overwriting a moved branch", () => {
    fs.writeFileSync(path.join(featureWorktree, "tracked.txt"), "custodied\n");
    const created = createTrashEntry(db, {
      project: "trash-test",
      branch: "feature/trash",
      reason: "manual",
    });
    db.prepare("UPDATE trash_entries SET state = 'remove_failed' WHERE id = ?").run(created.entry.id);
    git(repoRoot, ["update-ref", "refs/heads/feature/trash", created.entry.original_oid]);

    const restored = restoreTrashEntry(db, created.entry.id);
    expect(restored.entry).toMatchObject({ state: "restored" });
    expect(git(repoRoot, ["rev-parse", "refs/heads/feature/trash"])).toBe(created.entry.snapshot_oid);

    const secondBranch = "feature/moved";
    git(repoRoot, ["branch", secondBranch, "main"]);
    const secondWorktree = path.join(repoRoot, "worktrees", "feature-moved");
    git(repoRoot, ["worktree", "add", secondWorktree, secondBranch]);
    const second = createTrashEntry(db, {
      project: "trash-test",
      branch: secondBranch,
      reason: "manual",
    });
    db.prepare("UPDATE trash_entries SET state = 'remove_failed' WHERE id = ?").run(second.entry.id);
    git(repoRoot, ["branch", secondBranch, "main"]);
    fs.writeFileSync(path.join(repoRoot, "moved.txt"), "moved\n");
    git(repoRoot, ["add", "moved.txt"]);
    git(repoRoot, ["commit", "-m", "move branch authority"]);
    git(repoRoot, ["update-ref", `refs/heads/${secondBranch}`, "HEAD"]);
    expect(() => restoreTrashEntry(db, second.entry.id)).toThrow(/moved after custody/);
  });

  it("reports exact removal finality even when outcome persistence also fails", () => {
    db.exec(`CREATE TRIGGER fail_all_trash_updates
      BEFORE UPDATE ON trash_entries
      BEGIN
        SELECT RAISE(ABORT, 'recording unavailable');
      END`);

    let failure: unknown;
    try {
      createTrashEntry(db, {
        project: "trash-test",
        branch: "feature/trash",
        reason: "manual",
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({
      code: "remove_failed",
      detail: {
        outcome: {
          worktree_removed: true,
          branch_removed: true,
          worktree_path: fs.realpathSync(path.dirname(featureWorktree)) + "/feature-trash",
        },
        recording_error: expect.stringContaining("recording unavailable"),
      },
    });
    expect(fs.existsSync(featureWorktree)).toBe(false);
    expect(spawnSync("git", ["rev-parse", "--verify", "refs/heads/feature/trash"], {
      cwd: repoRoot,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    }).status).not.toBe(0);
  });

  it("rejects restore paths whose existing parent escapes through a symlink", () => {
    const created = createTrashEntry(db, {
      project: "trash-test",
      branch: "feature/trash",
      reason: "manual",
    });
    const outside = path.join(tempDir, "outside");
    fs.mkdirSync(outside);
    const link = path.join(repoRoot, "outside-link");
    fs.symlinkSync(outside, link, "dir");
    expect(() => restoreTrashEntry(db, created.entry.id, {
      worktree_path: path.join(link, "restored"),
    })).toThrow(/resolving symlinks/);
    expect(fs.existsSync(path.join(outside, "restored"))).toBe(false);
  });

  it("preserves Mandible docs and Codex app-managed worktrees at the public service boundary", () => {
    const managed = [
      {
        branch: "feature/docs-managed",
        worktree: path.join(repoRoot, ".git", "mandible-docs-worktrees", "feature-docs-managed"),
      },
      {
        branch: "feature/codex-managed",
        worktree: path.join(tempDir, ".codex", "worktrees", "feature-codex-managed"),
      },
    ];
    for (const candidate of managed) {
      git(repoRoot, ["branch", candidate.branch, "main"]);
      fs.mkdirSync(path.dirname(candidate.worktree), { recursive: true });
      git(repoRoot, ["worktree", "add", candidate.worktree, candidate.branch]);
      expect(() => createTrashEntry(db, {
        project: "trash-test",
        branch: candidate.branch,
        reason: "manual",
      })).toThrow(/app-managed worktree/);
      expect(fs.existsSync(candidate.worktree)).toBe(true);
      expect(git(repoRoot, ["rev-parse", "--verify", `refs/heads/${candidate.branch}`])).not.toBe("");
    }
    expect(listTrashEntries(db)).toEqual([]);
  });

  it("runs deferred GC automatically in the daemon scheduler", () => {
    const created = createTrashEntry(db, {
      project: "trash-test",
      branch: "feature/trash",
      reason: "merged",
      retention_days: 1,
    }, 1_000);
    vi.useFakeTimers();
    vi.setSystemTime(86_401_001);
    startTrashGcScheduler(db, () => {}, { startupDelayMs: 1, intervalMs: 3_600_000 });
    vi.advanceTimersByTime(1);

    expect(listTrashEntries(db)[0]).toMatchObject({ id: created.entry.id, state: "expired" });
    expect(spawnSync("git", ["rev-parse", "--verify", created.entry.snapshot_ref], {
      cwd: repoRoot,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    }).status).not.toBe(0);
  });

  it("durably replays gc_pending when final DB recording fails after ref deletion", () => {
    const created = createTrashEntry(db, {
      project: "trash-test",
      branch: "feature/trash",
      reason: "merged",
      retention_days: 1,
    }, 1_000);
    db.exec(`CREATE TRIGGER fail_trash_expire
      BEFORE UPDATE OF state ON trash_entries
      WHEN NEW.state = 'expired'
      BEGIN
        SELECT RAISE(ABORT, 'finalize failed');
      END`);

    expect(gcTrashEntries(db, { now: 86_401_001 })).toMatchObject({ expired: 0, failed: 1 });
    expect(listTrashEntries(db)[0]).toMatchObject({ state: "gc_pending" });
    expect(spawnSync("git", ["rev-parse", "--verify", created.entry.snapshot_ref], {
      cwd: repoRoot,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    }).status).not.toBe(0);
    db.exec("DROP TRIGGER fail_trash_expire");

    expect(gcTrashEntries(db, { now: 86_401_001 })).toMatchObject({ expired: 1, failed: 0 });
    expect(listTrashEntries(db)[0]).toMatchObject({
      state: "expired",
      outcome: { replayed_pending: true },
    });
  });

  it("preserves gc_pending when the exact snapshot ref cannot be inspected", () => {
    const created = createTrashEntry(db, {
      project: "trash-test",
      branch: "feature/trash",
      reason: "merged",
      retention_days: 1,
    }, 1_000);
    const nonRepoRoot = path.join(tempDir, "not-a-repository");
    fs.mkdirSync(nonRepoRoot);
    db.prepare("UPDATE trash_entries SET state = 'gc_pending', repo_root = ? WHERE id = ?")
      .run(nonRepoRoot, created.entry.id);

    expect(gcTrashEntries(db, { now: 86_401_001 })).toMatchObject({ expired: 0, failed: 1 });
    expect(listTrashEntries(db)[0]).toMatchObject({
      state: "gc_pending",
      expired_at: null,
      last_error: expect.stringContaining("cannot inspect trash snapshot ref"),
    });
    expect(git(repoRoot, ["show-ref", "--verify", created.entry.snapshot_ref])).toContain(
      created.entry.snapshot_oid,
    );
  });

  it("uses the canonical checkout default for scanner reaping facts", async () => {
    git(repoRoot, ["branch", "-m", "main", "trunk"]);
    db.prepare("UPDATE ledger_project_checkouts SET default_branch = 'trunk' WHERE id = ?")
      .run(checkoutId);
    const scanner = new WorkScanner({ db, repo_roots: [repoRoot] });
    await scanner.scanAllAsync();

    expect(scanner.getBranch(repoRoot, "feature/trash")).toMatchObject({
      default_branch: "trunk",
      worktree_inventory_known: true,
      worktree_status_known: true,
      default_comparison_known: true,
      reaping: { facts_known: true },
    });
  });
});

describe("scanner reaping safety", () => {
  const base = {
    branch: "feature/done",
    repo_root: "/repo",
    is_dirty: false,
    is_current: false,
    is_worktree: true,
    worktree_path: "/repo/worktrees/feature__done",
    ahead_default: 0,
    default_branch: "main",
    worktree_inventory_known: true,
    worktree_status_known: true,
    default_comparison_known: true,
  };

  it("requires clean+merged, app-managed, canonical, non-current, non-protected facts", () => {
    expect(deriveReapingSafety(base, { projectIds: ["prj-one"] })).toMatchObject({
      candidate: true,
      clean: true,
      merged: true,
      app_managed: false,
      canonical_project: true,
      ambiguous: false,
      blockers: [],
    });
    expect(deriveReapingSafety(
      {
        ...base,
        is_dirty: true,
        is_current: true,
        worktree_path: "/repo/.codex/worktrees/feature__done",
      },
      { projectIds: ["prj-one", "prj-two"] },
    )).toMatchObject({
      candidate: false,
      app_managed: true,
      ambiguous: true,
      blockers: expect.arrayContaining(["dirty", "current", "app_managed", "ambiguous_project"]),
    });
  });

  it("blocks candidates whenever a destructive Git fact is unknown", () => {
    expect(deriveReapingSafety({
      ...base,
      worktree_inventory_known: false,
      worktree_status_known: false,
      default_comparison_known: false,
    }, { projectIds: ["prj-one"] })).toMatchObject({
      candidate: false,
      clean: false,
      merged: false,
      facts_known: false,
      blockers: expect.arrayContaining([
        "unknown_worktree_inventory",
        "unknown_worktree_status",
        "unknown_default_comparison",
      ]),
    });
  });
});
