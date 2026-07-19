import { execSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import Database from "better-sqlite3";
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";

vi.mock("../src/sse", () => ({
  broadcast: vi.fn(),
}));

import { WorkScanner, type BranchData } from "../src/work-scanner";
import { filterAndSortBranches, registerWorkRoutes } from "../src/routes/work";
import { migrate } from "../src/db";
import { Router } from "../src/server";

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

function createMigratedDb(): InstanceType<typeof Database> {
  const db = new Database(":memory:");
  migrate(db);
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

  it("creates schema with last_commit_date column", () => {
    const db = createMigratedDb();
    new WorkScanner({ db, repo_roots: [repoRoot] });
    const columns = db
      .prepare("PRAGMA table_info(branches)")
      .all() as Array<{ name: string }>;
    const columnNames = columns.map((column) => column.name);
    expect(columnNames).toContain("last_commit_date");
  });

  it("scans a repo with known branch state", () => {
    const db = createMigratedDb();
    const scanner = new WorkScanner({ db, repo_roots: [repoRoot] });
    scanner.scanAll();

    const branches = scanner.getBranches(repoRoot).map((branch) => branch.branch);
    expect(branches).toContain("main");
    expect(branches).toContain("feature");
    expect(branches).toContain("no-upstream");
  });

  it("detects dirty worktrees", () => {
    const db = createMigratedDb();
    const scanner = new WorkScanner({ db, repo_roots: [repoRoot] });
    scanner.scanAll();

    const feature = scanner.getBranch(repoRoot, "feature");
    expect(feature).not.toBeNull();
    expect(feature?.is_worktree).toBe(true);
    expect(feature?.is_dirty).toBe(true);
    expect(feature?.diff_stat).toMatch(/feature\.txt/);
  });

  it("preserves detached worktrees in the explicit inventory adapter", () => {
    const db = createMigratedDb();
    const scanner = new WorkScanner({ db, repo_roots: [repoRoot] });
    scanner.scanAll();

    const inventory = scanner.getWorktreeInventory(repoRoot);
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

  it("computes ahead/behind counts", () => {
    const db = createMigratedDb();
    const scanner = new WorkScanner({ db, repo_roots: [repoRoot] });
    scanner.scanAll();

    const feature = scanner.getBranch(repoRoot, "feature");
    expect(feature).not.toBeNull();
    expect(feature?.ahead).toBeGreaterThan(0);
    expect(feature?.behind).toBe(0);
  });

  it("handles repos with no upstream", () => {
    const db = createMigratedDb();
    const scanner = new WorkScanner({ db, repo_roots: [repoRoot] });
    scanner.scanAll();

    const branch = scanner.getBranch(repoRoot, "no-upstream");
    expect(branch).not.toBeNull();
    expect(branch?.ahead).toBe(0);
    expect(branch?.behind).toBe(0);
    expect(branch?.has_upstream).toBe(false);
  });

  it("handles missing repos gracefully", () => {
    const db = createMigratedDb();
    const scanner = new WorkScanner({ db, repo_roots: [repoRoot, missingRepo] });
    const summary = scanner.scanAll();

    expect(summary.missing_repos).toContain(path.resolve(missingRepo));
  });

  it("auto-discovers repos when config is missing", () => {
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

  it("targeted repo refresh updates cached data", () => {
    const db = createMigratedDb();
    const scanner = new WorkScanner({ db, repo_roots: [repoRoot] });
    scanner.scanAll();

    let feature = scanner.getBranch(repoRoot, "feature");
    expect(feature?.is_dirty).toBe(true);

    run("git reset --hard", worktreePath);

    scanner.refreshRepo(repoRoot);
    feature = scanner.getBranch(repoRoot, "feature");
    expect(feature?.is_dirty).toBe(false);
  });

  it("serves encoded branch commit pages with classification metadata", async () => {
    const db = createMigratedDb();
    const scanner = new WorkScanner({ db, repo_roots: [repoRoot] });
    scanner.scanAll();
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
    scanner.scanAll();
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
