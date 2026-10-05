import { execSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { beforeAll, afterAll, afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/sse", () => ({
  broadcast: vi.fn(),
}));

import { WorkScanner, type BranchData } from "../../src/work-scanner";
import { filterAndSortBranches, registerWorkRoutes } from "../../src/routes/work";
import type { Db } from "../../src/db";
import { resolveProjectForCheckout } from "../../src/ledger/projects";
import { Router } from "../../src/server";
import { createMigratedDb as createSharedMigratedDb } from "../helpers/ledger-fixtures.js";

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "Test User",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test User",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

function run(cmd: string, cwd: string): string {
  return execSync(cmd, { cwd, env: gitEnv, stdio: "pipe" }).toString("utf8");
}

function writeFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

// Databases opened by the current test, closed in afterEach.
const openDbs: Db[] = [];

function createMigratedDb(): Db {
  // Route handlers resolve repo access through the process-global DB singleton
  // (getDb()), which falls through to opening the real database when nothing
  // has been registered. Point the singleton at this same isolated in-memory
  // DB rather than a second one, so a test exercises exactly one database.
  const db = createSharedMigratedDb({ setGlobal: true });
  openDbs.push(db);
  return db;
}

describe.sequential("WorkScanner", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cp-work-"));
  const repoRoot = path.join(tempRoot, "repo");
  const remoteRoot = path.join(tempRoot, "remote.git");
  const worktreePath = path.join(tempRoot, "wt-feature");
  const detachedWorktreePath = path.join(tempRoot, ".codex", "worktrees", "detached");
  const missingRepo = path.join(tempRoot, "missing");

  beforeAll(() => {
    fs.mkdirSync(repoRoot, { recursive: true });
    run("git init -b main", repoRoot);

    writeFile(path.join(repoRoot, "README.md"), "hello\n");
    run("git add README.md", repoRoot);
    run("git -c commit.gpgsign=false commit -m \"init\"", repoRoot);

    run(`git init --bare ${remoteRoot}`, tempRoot);
    run(`git remote add origin ${remoteRoot}`, repoRoot);
    run("git push -u origin main", repoRoot);

    run("git checkout -b feature", repoRoot);
    writeFile(path.join(repoRoot, "feature.txt"), "feature\n");
    run("git add feature.txt", repoRoot);
    run("git -c commit.gpgsign=false commit -m \"feature base\"", repoRoot);
    run("git push -u origin feature", repoRoot);

    run("git checkout main", repoRoot);
    run("git worktree add " + worktreePath + " feature", repoRoot);
    run("git worktree add --detach " + detachedWorktreePath + " main", repoRoot);

    // Make feature branch ahead by one commit in its worktree
    writeFile(path.join(worktreePath, "feature.txt"), "feature\nlocal\n");
    run("git add feature.txt", worktreePath);
    run("git -c commit.gpgsign=false commit -m \"ahead commit\"", worktreePath);

    // Leave a dirty change on a tracked file
    writeFile(path.join(worktreePath, "feature.txt"), "feature\nlocal\nwip\n");

    // Create a branch without upstream
    run("git checkout -b no-upstream", repoRoot);
    writeFile(path.join(repoRoot, "no-upstream.txt"), "local\n");
    run("git add no-upstream.txt", repoRoot);
    run("git -c commit.gpgsign=false commit -m \"no upstream\"", repoRoot);
    run("git checkout main", repoRoot);

    run("git checkout -b topic/slash", repoRoot);
    writeFile(path.join(repoRoot, "slash.txt"), "slash\n");
    run("git add slash.txt", repoRoot);
    run("git -c commit.gpgsign=false commit -m \"slash branch\"", repoRoot);
    run("git checkout main", repoRoot);
  });

  afterAll(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  afterEach(() => {
    // Close every DB this test opened so no connection or singleton state
    // leaks into the next test. The singleton is re-pointed by the next
    // createMigratedDb() call; until then it holds a closed handle, which
    // fails loudly rather than silently reopening the real database.
    while (openDbs.length > 0) {
      openDbs.pop()?.close();
    }
  });

  it("creates schema with last_commit_date column", () => {
    const db = createMigratedDb();
    new WorkScanner({ db, repo_roots: [repoRoot] });
    const columns = db
      .prepare("PRAGMA table_info(branches)")
      .all() as Array<{ name: string }>;
    const columnNames = columns.map((column) => column.name);
    expect(columnNames).toContain("last_commit_date");
  });

  it("serves only the persisted repo projection without discovering or scanning on GET", async () => {
    const db = createMigratedDb();
    const scanner = new WorkScanner({
      db,
      repo_roots: [repoRoot],
      config_path: path.join(tempRoot, "preview", "repos.json"),
    });
    const scan = vi.spyOn(scanner, "scanAllAsync");
    const router = new Router();
    registerWorkRoutes(router, scanner);

    const empty = await router.invoke({ method: "GET", url: "/api/work/repos" });
    expect(empty.status).toBe(503);
    expect(empty.body).toMatchObject({ code: "repo_discovery_pending" });
    expect(scan).not.toHaveBeenCalled();

    db.prepare(
      `INSERT INTO work_repos (
         id, root, name, default_branch, dir_exists, excluded,
         user_modified, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 1, 0, 0, datetime('now'), datetime('now'))`,
    ).run("cached-repo", repoRoot, "Cached repo", "main");
    const cached = await router.invoke({ method: "GET", url: "/api/work/repos" });
    expect(cached.status).toBe(200);
    expect(cached.body).toEqual([expect.objectContaining({
      id: "cached-repo",
      root: repoRoot,
      name: "Cached repo",
    })]);
    expect(scan).not.toHaveBeenCalled();
  });

  it("distinguishes pending and failed cold discovery from a successfully empty inventory", async () => {
    const db = createMigratedDb();
    const scanner = new WorkScanner({ db, repo_roots: [] });
    const router = new Router();
    registerWorkRoutes(router, scanner);
    expect((await router.invoke({ method: "GET", url: "/api/work/repos" })).status).toBe(503);
    await scanner.scanAllAsync();
    expect(await router.invoke({ method: "GET", url: "/api/work/repos" })).toMatchObject({ status: 200, body: [] });
    const failing = new WorkScanner({ db, repo_roots: [repoRoot] });
    vi.spyOn(failing as unknown as { runRepoInfoRefresh(): Promise<void> }, "runRepoInfoRefresh").mockRejectedValue(new Error("Git unavailable"));
    const failedRouter = new Router();
    registerWorkRoutes(failedRouter, failing);
    await expect(failing.scanAllAsync()).rejects.toThrow("Git unavailable");
    expect(await failedRouter.invoke({ method: "GET", url: "/api/work/repos" })).toMatchObject({ status: 503, body: { code: "repo_discovery_failed" } });
  });

  it("preserves the previous repository projection when directory enumeration fails", async () => {
    const db = createMigratedDb();
    const initial = new WorkScanner({ db, repo_roots: [repoRoot] });
    await initial.scanAllAsync();
    const before = db.prepare("SELECT * FROM work_repos ORDER BY root").all();
    const home = fs.mkdtempSync(path.join(tempRoot, "discovery-failure-"));
    const originalRead = fs.readdirSync;
    const previousRoots = process.env.MANDIBLE_WORK_SCANNER_ROOTS;
    const homeSpy = vi.spyOn(os, "homedir").mockReturnValue(home);
    try {
      for (const configured of [false, true]) {
        if (configured) process.env.MANDIBLE_WORK_SCANNER_ROOTS = JSON.stringify([{ path: home, depth: 1 }]);
        else delete process.env.MANDIBLE_WORK_SCANNER_ROOTS;
        const readSpy = vi.spyOn(fs, "readdirSync").mockImplementation(((target: fs.PathLike, options: unknown) => {
          if (String(target) === home) throw Object.assign(new Error("enumeration unavailable"), { code: configured ? "EIO" : "EACCES" });
          return originalRead(target, options as never);
        }) as typeof fs.readdirSync);
        const scanner = new WorkScanner({ db, default_repo_root: repoRoot, config_path: path.join(home, "missing.json") });
        await expect(scanner.scanAllAsync()).rejects.toThrow("enumeration unavailable");
        expect(scanner.getRepoDiscoveryStatus()).toBe("failed");
        expect(db.prepare("SELECT * FROM work_repos ORDER BY root").all()).toEqual(before);
        expect(scanner.getCachedRepos()).toContainEqual(expect.objectContaining({ root: repoRoot }));
        readSpy.mockRestore();
      }
    } finally {
      homeSpy.mockRestore();
      if (previousRoots === undefined) delete process.env.MANDIBLE_WORK_SCANNER_ROOTS;
      else process.env.MANDIBLE_WORK_SCANNER_ROOTS = previousRoots;
    }
  });

  it("reports failed Git identity in a linked checkout without losing its prior projection", async () => {
    const db = createMigratedDb();
    const linked = path.join(tempRoot, "linked-probe");
    run(`git worktree add --detach ${linked} main`, repoRoot);
    const scanner = new WorkScanner({ db, repo_roots: [linked] });
    try {
      await scanner.scanAllAsync();
      expect(scanner.getRepoById(linked)?.last_scanned_at).not.toBeNull();
      expect(scanner.getBranches(linked).some(branch => branch.branch === "(no branch)")).toBe(false);
      const before = db.prepare("SELECT * FROM work_repos WHERE root = ?").get(linked);
      const metadata = path.join(linked, ".git");
      const original = fs.readFileSync(metadata, "utf8");
      fs.writeFileSync(metadata, "gitdir: /nonexistent/scanner-test-metadata\n");
      try {
        await expect(scanner.scanAllAsync()).rejects.toThrow("git rev-parse --show-toplevel");
        expect(scanner.getRepoDiscoveryStatus()).toBe("failed");
        expect(db.prepare("SELECT * FROM work_repos WHERE root = ?").get(linked)).toEqual(before);
        expect(scanner.getCachedRepos()).toContainEqual(expect.objectContaining({ root: linked, exists: true }));
      } finally { fs.writeFileSync(metadata, original); }
    } finally {
      await scanner.stop();
      run(`git worktree remove ${linked}`, repoRoot);
    }
  });

  it("removes repos through a preview-owned roots file and rejects symlink escapes", () => {
    const db = createMigratedDb();
    const previewRoot = path.join(tempRoot, "preview-work-copy");
    const configPath = path.join(previewRoot, "work", "repos.json");
    fs.mkdirSync(previewRoot, { recursive: true });
    db.prepare(
      `INSERT INTO work_repos (id, root, name, default_branch, dir_exists, excluded)
       VALUES (?, ?, ?, ?, 1, 0), (?, ?, ?, ?, 1, 0)`,
    ).run("remove-one", repoRoot, "one", "main", "keep-two", remoteRoot, "two", "main");

    const scanner = new WorkScanner({ db, config_path: configPath, config_root: previewRoot });
    expect(scanner.removeRepo("remove-one")).toBe(true);
    expect(JSON.parse(fs.readFileSync(configPath, "utf8"))).toEqual({ repos: [remoteRoot] });
    expect(db.prepare("SELECT id FROM work_repos ORDER BY id").all()).toEqual([{ id: "keep-two" }]);

    const escapedRoot = path.join(tempRoot, "preview-work-symlink");
    const outside = path.join(tempRoot, "preview-work-outside");
    fs.mkdirSync(escapedRoot, { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    fs.symlinkSync(outside, path.join(escapedRoot, "work"), "dir");
    db.prepare(
      `INSERT INTO work_repos (id, root, name, default_branch, dir_exists, excluded)
       VALUES (?, ?, ?, ?, 1, 0)`,
    ).run("escape-one", repoRoot, "one", "main");
    const escapedScanner = new WorkScanner({
      db,
      config_path: path.join(escapedRoot, "work", "repos.json"),
      config_root: escapedRoot,
    });
    expect(() => escapedScanner.removeRepo("escape-one")).toThrow("escapes its instance-owned root");
    expect(db.prepare("SELECT id FROM work_repos WHERE id = ?").get("escape-one")).toEqual({ id: "escape-one" });
    expect(fs.existsSync(path.join(outside, "repos.json"))).toBe(false);
  });

  it("scans a repo with known branch state", async () => {
    const db = createMigratedDb();
    const scanner = new WorkScanner({ db, repo_roots: [repoRoot] });
    await scanner.scanAllAsync();

    const branches = scanner.getBranches(repoRoot).map((branch) => branch.branch);
    expect(branches).toContain("main");
    expect(branches).toContain("feature");
    expect(branches).toContain("no-upstream");
  });

  it("preserves exact local branch names despite tag and remote ref collisions", async () => {
    const isolatedRepo = path.join(tempRoot, "ref-collisions");
    fs.mkdirSync(isolatedRepo);
    run("git init -b main", isolatedRepo);
    run('git -c commit.gpgsign=false commit --allow-empty -m "init"', isolatedRepo);
    run("git branch collision", isolatedRepo);
    run("git tag collision", isolatedRepo);
    run("git checkout collision", isolatedRepo);
    run('git -c commit.gpgsign=false commit --allow-empty -m "local branch commit"', isolatedRepo);
    const branchCommit = run("git rev-parse refs/heads/collision", isolatedRepo).trim();
    run("git checkout main", isolatedRepo);
    run("git branch origin/topic", isolatedRepo);
    run("git branch heads/legitimate", isolatedRepo);
    run("git update-ref refs/remotes/origin/topic HEAD", isolatedRepo);
    run("git update-ref refs/remotes/origin/remote-only HEAD", isolatedRepo);

    const db = createMigratedDb();
    const scanner = new WorkScanner({ db, repo_roots: [isolatedRepo] });
    try {
      await scanner.scanAllAsync();
      expect(scanner.getBranches(isolatedRepo).map(branch => branch.branch).sort()).toEqual([
        "collision", "heads/legitimate", "main", "origin/topic",
      ]);
      expect(scanner.getBranch(isolatedRepo, "collision")?.last_commit?.hash).toBe(branchCommit);
      const commits = await scanner.getCommits(isolatedRepo, "collision");
      expect(commits.commits[0]?.hash).toBe(branchCommit);
      expect(commits.total).toBe(2);
    } finally {
      await scanner.stop();
      fs.rmSync(isolatedRepo, { recursive: true, force: true });
    }
  });

  it("preserves the persisted repo id when refresh derives a different path id", async () => {
    const db = createMigratedDb();
    db.prepare(
      `INSERT INTO work_repos (
         id, root, name, default_branch, dir_exists, excluded,
         user_modified, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 1, 0, 0, datetime('now'), datetime('now'))`,
    ).run("canonical-widget", repoRoot, "repo", "main");

    const scanner = new WorkScanner({ db, repo_roots: [repoRoot] });
    await scanner.scanAllAsync();

    expect(scanner.getRepos()).toContainEqual(expect.objectContaining({
      id: "canonical-widget",
      root: repoRoot,
    }));
  });

  it("recreates canonical and deliberately disambiguated scanner rows without collapsing them", async () => {
    const db = createMigratedDb();
    resolveProjectForCheckout(db, {
      root: repoRoot,
      remoteUrl: "git@github.com:mll/repo.git",
      workRepoId: "repo",
    });
    const duplicateRoot = path.join(tempRoot, "dev", "repo");
    resolveProjectForCheckout(db, {
      root: duplicateRoot,
      remoteUrl: "git@github.com:mll/repo.git",
      workRepoId: "dev-repo",
    });

    const scanner = new WorkScanner({ db, repo_roots: [repoRoot, duplicateRoot] });
    await scanner.scanAllAsync();
    db.prepare("DELETE FROM work_repos WHERE root = ?").run(duplicateRoot);
    const recreated = new WorkScanner({ db, repo_roots: [repoRoot, duplicateRoot] });
    await recreated.scanAllAsync();

    expect(recreated.getRepos()).toContainEqual(expect.objectContaining({
      id: "repo",
      root: repoRoot,
    }));
    expect(recreated.getRepos()).toContainEqual(expect.objectContaining({
      id: "dev-repo",
      root: duplicateRoot,
    }));
    expect(
      db.prepare("SELECT id FROM work_repos WHERE root = ?").get(repoRoot),
    ).toEqual({ id: "repo" });
    expect(
      db.prepare("SELECT id FROM work_repos WHERE root = ?").get(duplicateRoot),
    ).toEqual({ id: "dev-repo" });
  });

  it("detects dirty worktrees", async () => {
    const db = createMigratedDb();
    const scanner = new WorkScanner({ db, repo_roots: [repoRoot] });
    await scanner.scanAllAsync();

    const feature = scanner.getBranch(repoRoot, "feature");
    expect(feature).not.toBeNull();
    expect(feature?.is_worktree).toBe(true);
    expect(feature?.is_dirty).toBe(true);
    expect(feature?.diff_stat).toMatch(/feature\.txt/);
  });

  it("preserves detached worktrees in the explicit inventory adapter", async () => {
    const db = createMigratedDb();
    const scanner = new WorkScanner({ db, repo_roots: [repoRoot] });
    await scanner.scanAllAsync();

    const inventory = await scanner.getWorktreeInventory(repoRoot);
    expect(inventory.known).toBe(true);
    expect(inventory.worktrees).toContainEqual({
      path: fs.realpathSync(repoRoot),
      branch: "main",
      is_current: true,
    });
    expect(inventory.worktrees).toContainEqual({
      path: fs.realpathSync(detachedWorktreePath),
      branch: null,
      is_current: false,
    });
  });

  it("computes ahead/behind counts", async () => {
    const db = createMigratedDb();
    const scanner = new WorkScanner({ db, repo_roots: [repoRoot] });
    await scanner.scanAllAsync();

    const feature = scanner.getBranch(repoRoot, "feature");
    expect(feature).not.toBeNull();
    expect(feature?.ahead).toBeGreaterThan(0);
    expect(feature?.behind).toBe(0);
  });

  it("handles repos with no upstream", async () => {
    const db = createMigratedDb();
    const scanner = new WorkScanner({ db, repo_roots: [repoRoot] });
    await scanner.scanAllAsync();

    const branch = scanner.getBranch(repoRoot, "no-upstream");
    expect(branch).not.toBeNull();
    expect(branch?.ahead).toBe(0);
    expect(branch?.behind).toBe(0);
    expect(branch?.has_upstream).toBe(false);
  });

  it("persists upstream tracking info during scans and serves it from the DB", async () => {
    const db = createMigratedDb();
    const scanner = new WorkScanner({ db, repo_roots: [repoRoot] });
    await scanner.scanAllAsync();

    // Persisted onto the branches row by the scan, not recomputed per GET.
    const row = db
      .prepare("SELECT has_upstream, upstream FROM branches WHERE repo_root = ? AND branch = ?")
      .get(repoRoot, "feature") as { has_upstream: number; upstream: string | null };
    expect(row.has_upstream).toBe(1);
    expect(row.upstream).toBe("origin/feature");

    const noUpstreamRow = db
      .prepare("SELECT has_upstream, upstream FROM branches WHERE repo_root = ? AND branch = ?")
      .get(repoRoot, "no-upstream") as { has_upstream: number; upstream: string | null };
    expect(noUpstreamRow.has_upstream).toBe(0);
    expect(noUpstreamRow.upstream).toBeNull();

    // getBranches reads the persisted columns rather than spawning git.
    const feature = scanner.getBranch(repoRoot, "feature");
    expect(feature?.has_upstream).toBe(true);
    expect(feature?.upstream).toBe("origin/feature");
  });

  it("serves upstream info from the DB even when the repo is gone", async () => {
    const db = createMigratedDb();
    const scanner = new WorkScanner({ db, repo_roots: [repoRoot] });
    await scanner.scanAllAsync();

    // Read via a scanner that never probes the on-disk repo (empty roots): the
    // upstream fields must come purely from the persisted branch rows.
    const dbOnlyScanner = new WorkScanner({ db, repo_roots: [] });
    const feature = dbOnlyScanner.getBranch(repoRoot, "feature");
    expect(feature?.has_upstream).toBe(true);
    expect(feature?.upstream).toBe("origin/feature");
  });

  it("refreshRepoAsync yields between branches and repopulates branch state", async () => {
    const db = createMigratedDb();
    const scanner = new WorkScanner({ db, repo_roots: [repoRoot] });
    // Prime repoInfos so refreshRepoAsync can resolve the repo id.
    await scanner.scanAllAsync();

    const refreshed = await scanner.refreshRepoAsync(repoRoot);
    expect(refreshed.exists).toBe(true);
    expect(refreshed.last_scanned_at).not.toBeNull();

    const branches = scanner.getBranches(repoRoot).map((branch) => branch.branch);
    expect(branches).toContain("main");
    expect(branches).toContain("feature");
  });

  it("handles missing repos gracefully", async () => {
    const db = createMigratedDb();
    const scanner = new WorkScanner({ db, repo_roots: [repoRoot, missingRepo] });
    const summary = await scanner.scanAllAsync();

    expect(summary.missing_repos).toContain(path.resolve(missingRepo));
  });

  it("yields between branch scans and deduplicates concurrent async scans", async () => {
    const db = createMigratedDb();
    const events: string[] = [];
    const branchEventTurns: number[] = [];
    let eventLoopTurns = 0;
    const scanner = new WorkScanner({
      db,
      repo_roots: [repoRoot],
      on_event: (event) => {
        events.push(event.type);
        if (event.type === "work:branch:updated") {
          branchEventTurns.push(eventLoopTurns);
          setImmediate(() => { eventLoopTurns += 1; });
        }
      },
    });

    const first = scanner.scanAllAsync();
    const second = scanner.scanAllAsync();

    expect(second).toBe(first);
    await first;
    expect(branchEventTurns.length).toBeGreaterThan(1);
    expect(branchEventTurns.slice(1).every(
      (turn, index) => turn > branchEventTurns[index],
    )).toBe(true);
    expect(events.filter((event) => event === "work:scan:started")).toHaveLength(1);
    expect(events.filter((event) => event === "work:scan:completed")).toHaveLength(1);
  });

  it("queues an explicit full scan behind an active freshness-skipping scan", async () => {
    const db = createMigratedDb();
    const initialScanner = new WorkScanner({ db, repo_roots: [repoRoot] });
    await initialScanner.scanAllAsync();
    const scanner = new WorkScanner({
      db,
      repo_roots: [repoRoot],
      scan_skip_window_ms: 60_000,
    });

    const skippedScan = scanner.scanAllAsync({ skip_recent: true });
    const forcedScan = scanner.scanAllAsync();
    const [skipped, forced] = await Promise.all([skippedScan, forcedScan]);

    expect(skipped.scanned_repos).toBe(0);
    expect(forced.scanned_repos).toBe(1);
  });

  it("reuses persisted scanner rows inside the async scan skip window", async () => {
    const db = createMigratedDb();
    const firstScanner = new WorkScanner({ db, repo_roots: [repoRoot] });
    const initial = await firstScanner.scanAllAsync({ skip_recent: true });
    expect(initial.scanned_repos).toBe(1);

    const restartedScanner = new WorkScanner({
      db,
      repo_roots: [repoRoot],
      scan_skip_window_ms: 60_000,
    });
    const cached = await restartedScanner.scanAllAsync({ skip_recent: true });

    expect(cached).toMatchObject({
      scanned_repos: 0,
      branches_updated: 0,
      branches_removed: 0,
      missing_repos: [],
    });
    expect(restartedScanner.getBranches(repoRoot).length).toBeGreaterThan(0);
  });

  it("auto-discovers repos when config is missing", async () => {
    const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "cp-home-"));
    const dotfilesRoot = path.join(tempHome, ".dotfiles");
    const devRoot = path.join(tempHome, "dev", "alpha");
    const projectsRoot = path.join(tempHome, "projects", "beta");

    fs.mkdirSync(dotfilesRoot, { recursive: true });
    fs.mkdirSync(devRoot, { recursive: true });
    fs.mkdirSync(projectsRoot, { recursive: true });
    run("git init -b main", dotfilesRoot);
    run("git init -b main", devRoot);
    run("git init -b main", projectsRoot);

    const homedirSpy = vi.spyOn(os, "homedir").mockReturnValue(tempHome);
    try {
      const db = createMigratedDb();
      const configPath = path.join(tempHome, ".config", "mandible", "repos.json");
      const scanner = new WorkScanner({ db, config_path: configPath, default_repo_root: dotfilesRoot });
      await scanner.scanAllAsync();
      const roots = scanner.getRepos().map((repo) => repo.root);
      expect(new Set(roots)).toEqual(new Set([dotfilesRoot, devRoot, projectsRoot]));
    } finally {
      homedirSpy.mockRestore();
      fs.rmSync(tempHome, { recursive: true, force: true });
    }
  });

  it("sorts branches by recency, name, and activity", () => {
    const base: Omit<BranchData, "branch"> = {
      repo_root: repoRoot,
      is_current: false,
      is_worktree: false,
      worktree_path: null,
      is_dirty: false,
      ahead: 0,
      behind: 0,
      has_upstream: true,
      last_commit: null,
      diff_stat: null,
    };

    const branches: BranchData[] = [
      {
        ...base,
        branch: "feature",
        is_dirty: true,
        last_commit: {
          hash: "a",
          message: "newest",
          author: "Test",
          date: "2024-01-03T10:00:00Z",
        },
      },
      {
        ...base,
        branch: "alpha",
        last_commit: {
          hash: "b",
          message: "middle",
          author: "Test",
          date: "2024-01-02T10:00:00Z",
        },
      },
      {
        ...base,
        branch: "zeta",
        last_commit: {
          hash: "c",
          message: "oldest",
          author: "Test",
          date: "2024-01-01T10:00:00Z",
        },
      },
    ];

    expect(filterAndSortBranches(branches, { sort: "recency" }).map((b) => b.branch)).toEqual([
      "feature",
      "alpha",
      "zeta",
    ]);
    expect(filterAndSortBranches(branches, { sort: "name" }).map((b) => b.branch)).toEqual([
      "alpha",
      "feature",
      "zeta",
    ]);
    expect(filterAndSortBranches(branches, { sort: "activity" }).map((b) => b.branch)).toEqual([
      "feature",
      "alpha",
      "zeta",
    ]);
  });

  it("targeted repo refresh updates cached data", async () => {
    const db = createMigratedDb();
    const scanner = new WorkScanner({ db, repo_roots: [repoRoot] });
    await scanner.scanAllAsync();

    let feature = scanner.getBranch(repoRoot, "feature");
    expect(feature?.is_dirty).toBe(true);

    run("git reset --hard", worktreePath);

    await scanner.refreshRepoAsync(repoRoot);
    feature = scanner.getBranch(repoRoot, "feature");
    expect(feature?.is_dirty).toBe(false);
  });

  it("serves encoded branch commit pages with classification metadata", async () => {
    const db = createMigratedDb();
    const scanner = new WorkScanner({ db, repo_roots: [repoRoot] });
    await scanner.scanAllAsync();
    const repoId = scanner.getRepos()[0].id;
    const router = new Router();
    registerWorkRoutes(router, scanner);

    const response = await router.invoke({
      method: "GET",
      url: `/api/work/repos/${encodeURIComponent(repoId)}/branches/topic%2Fslash/commits?limit=10&offset=0`,
    });

    expect(response.status).toBe(200);
    const body = response.body as {
      branch: string;
      total: number;
      commits: Array<{ message: string; classification: string }>;
    };
    expect(body.branch).toBe("topic/slash");
    expect(body.total).toBeGreaterThanOrEqual(2);
    expect(body.commits[0].message).toBe("slash branch");
    expect(body.commits.some((commit) => commit.classification === "pre-branch-point")).toBe(true);
  });

  it("serves Projects compare results as raw unified diff plus stat", async () => {
    const db = createMigratedDb();
    const scanner = new WorkScanner({ db, repo_roots: [repoRoot] });
    await scanner.scanAllAsync();
    const repoId = scanner.getRepos()[0].id;
    const router = new Router();
    registerWorkRoutes(router, scanner);

    const response = await router.invoke({
      method: "GET",
      url: `/api/work/repos/${encodeURIComponent(repoId)}/compare?from=main&to=topic%2Fslash&mode=merge-base`,
    });

    expect(response.status).toBe(200);
    const body = response.body as { raw: string; stat: string; range: string; mode: string };
    expect(body.mode).toBe("merge-base");
    expect(body.range).toBe("main...topic/slash");
    expect(body.raw).toContain("diff --git");
    expect(body.stat).toContain("slash.txt");
  });
});
