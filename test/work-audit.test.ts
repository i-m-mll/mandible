import SqliteDatabase from "../src/sqlite.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/sse", () => ({ broadcast: vi.fn() }));

import { migrate, setDb, type Db } from "../src/db";
import { buildWorkAudit } from "../src/work-audit";
import {
  deriveReapingSafety,
  type BranchData,
  type RepoInfo,
  type WorkScanner,
} from "../src/work-scanner";
import { registerWorkRoutes } from "../src/routes/work";
import { Router } from "../src/server";

// The audit route resolves repo access through the process-global DB singleton
// (getDb()), which falls through to opening the real database when nothing has
// been registered. These tests drive the route with mocked scanners and never
// otherwise need a database, so register an isolated in-memory one per test.
let db: Db;

beforeEach(() => {
  db = new SqliteDatabase(":memory:");
  migrate(db);
  setDb(db);
});

afterEach(() => {
  db.close();
});

const repo: RepoInfo = {
  id: "repo-1",
  name: "Example",
  root: "/repos/example with space",
  exists: true,
  default_branch: "trunk",
  excluded: false,
  user_modified: false,
  last_scanned_at: "2026-07-19T12:00:00.000Z",
};

function makeBranch(
  branch: string,
  overrides: Partial<BranchData> = {},
  context: { protectedBranches?: string[]; projectIds?: string[] } = {},
): BranchData {
  const row: BranchData = {
    repo_root: repo.root,
    branch,
    is_current: false,
    is_worktree: false,
    worktree_path: null,
    is_dirty: false,
    ahead: 0,
    behind: 0,
    has_upstream: false,
    ahead_default: 0,
    behind_default: 0,
    default_branch: "trunk",
    worktree_inventory_known: true,
    worktree_status_known: true,
    default_comparison_known: true,
    last_commit: null,
    diff_stat: null,
    ...overrides,
  };
  row.reaping = deriveReapingSafety(row, {
    protectedBranches: context.protectedBranches ?? ["trunk"],
    projectIds: context.projectIds ?? ["project-canonical"],
  });
  return row;
}

describe("work audit projection", () => {
  it("classifies authoritative branch states and only enables safe candidates", () => {
    const branches = [
      makeBranch("safe"),
      makeBranch("dirty", {
        is_worktree: true,
        worktree_path: "/repos/wt-dirty",
        is_dirty: true,
      }),
      makeBranch("unique", { ahead_default: 2, behind_default: 1 }),
      makeBranch("trunk"),
      makeBranch("release", {}, { protectedBranches: ["trunk", "release"] }),
      makeBranch("current", { is_current: true }),
      makeBranch("codex", {
        is_worktree: true,
        worktree_path: "/repos/example/.codex/worktrees/task",
      }),
      makeBranch("unknown", {
        worktree_inventory_known: false,
        worktree_status_known: false,
        default_comparison_known: false,
      }),
      makeBranch("ambiguous", {}, { projectIds: ["project-a", "project-b"] }),
    ];

    const audit = buildWorkAudit(repo, branches, { known: true, worktrees: [] });
    const byBranch = new Map(audit.entries.map((entry) => [entry.branch, entry]));

    expect(byBranch.get("safe")).toMatchObject({
      classification: "safe_candidate",
      preserve_by_default: false,
      blockers: [],
      proof: { kind: "reachable", merged: true, default_branch: "trunk" },
      trash_request: {
        project: "project-canonical",
        checkout_root: repo.root,
        branch: "safe",
        reason: "manual",
        issue_refs: [],
      },
    });
    expect(byBranch.get("safe")?.trash_command).toBe(
      "mandible trash create --project 'project-canonical' "
      + "--checkout-root '/repos/example with space' --branch 'safe' --reason manual",
    );
    expect(byBranch.get("dirty")).toMatchObject({
      classification: "dirty_worktree",
      preserve_by_default: true,
      dirty: true,
      blockers: ["dirty"],
      trash_request: null,
    });
    expect(byBranch.get("unique")).toMatchObject({
      classification: "unique_commits",
      preserve_by_default: true,
      ahead_default: 2,
      behind_default: 1,
      proof: { kind: "none", merged: false },
    });
    expect(byBranch.get("trunk")?.classification).toBe("protected");
    expect(byBranch.get("release")?.classification).toBe("protected");
    expect(byBranch.get("current")?.classification).toBe("current");
    expect(byBranch.get("codex")?.classification).toBe("app_managed");
    expect(byBranch.get("unknown")).toMatchObject({
      classification: "unknown",
      status_known: false,
      dirty: null,
      ahead_default: null,
      proof: { kind: "unknown", merged: null },
    });
    expect(byBranch.get("ambiguous")).toMatchObject({
      classification: "unknown",
      canonical_project: false,
      ambiguous_project: true,
      trash_request: null,
    });
  });

  it("includes detached worktrees as deterministic preserve-only entries", () => {
    const audit = buildWorkAudit(repo, [makeBranch("zeta"), makeBranch("alpha")], {
      known: true,
      worktrees: [
        { path: "/repos/example/.codex/worktrees/detached", branch: null, is_current: false },
        { path: "/repos/plain-detached", branch: null, is_current: false },
        { path: "/repos/branched", branch: "alpha", is_current: false },
      ],
    });

    expect(audit.entries.map((entry) => [entry.kind, entry.branch, entry.worktree_path])).toEqual([
      ["detached_worktree", null, "/repos/example/.codex/worktrees/detached"],
      ["detached_worktree", null, "/repos/plain-detached"],
      ["branch", "alpha", null],
      ["branch", "zeta", null],
    ]);
    expect(audit.entries[0]).toMatchObject({
      classification: "app_managed",
      preserve_by_default: true,
      blockers: ["app_managed", "missing_branch"],
      trash_request: null,
      trash_command: null,
    });
    expect(audit.entries[1]).toMatchObject({
      classification: "unknown",
      reason: "This detached worktree has no branch to trash.",
      blockers: ["missing_branch"],
    });
  });

  it("exposes unknown worktree inventory without inventing detached rows", () => {
    // Even a branch whose cached scan was previously safe must fail closed
    // when the live inventory probe cannot establish current worktree state.
    const audit = buildWorkAudit(repo, [makeBranch("unknown-inventory")], {
      known: false,
      worktrees: [],
    });

    expect(audit.worktree_inventory_known).toBe(false);
    expect(audit.entries[0]).toMatchObject({
      classification: "unknown",
      blockers: ["unknown_worktree_inventory"],
      preserve_by_default: true,
      status_known: false,
      dirty: null,
      trash_request: null,
    });
  });
});

describe("GET /api/work/repos/:id/audit", () => {
  it("is denied to file RPC and returns 404 for a missing repository", async () => {
    const scanner = {
      scanAll: vi.fn().mockResolvedValue(undefined),
      getRepoById: vi.fn().mockReturnValue(undefined),
      getRepos: vi.fn().mockReturnValue([]),
    } as unknown as WorkScanner;
    const router = new Router();
    registerWorkRoutes(router, scanner);

    expect(router.resolveFileRpcPolicy("GET", "/api/work/repos/missing/audit")).toBe(false);
    const response = await router.invoke({ method: "GET", url: "/api/work/repos/missing/audit" });
    expect(response).toEqual({ status: 404, body: { error: "repo not found" } });
  });

  it("returns the projection envelope for a known repository", async () => {
    const safe = makeBranch("safe");
    let refreshed = false;
    const scanAll = vi.fn().mockResolvedValue(undefined);
    const scanner = {
      scanAll,
      getRepoById: vi.fn().mockReturnValue(repo),
      getRepos: vi.fn().mockReturnValue([repo]),
      refreshRepoAsync: vi.fn().mockImplementation(async () => {
        refreshed = true;
        return repo;
      }),
      getBranches: vi.fn().mockImplementation(() => {
        expect(refreshed).toBe(true);
        return [safe];
      }),
      getWorktreeInventory: vi.fn().mockReturnValue({ known: true, worktrees: [] }),
    } as unknown as WorkScanner;
    const router = new Router();
    registerWorkRoutes(router, scanner);

    const response = await router.invoke({ method: "GET", url: "/api/work/repos/repo-1/audit" });
    expect(response.status).toBe(200);
    expect(scanAll).not.toHaveBeenCalled();
    expect(response.body).toMatchObject({
      repo: { id: "repo-1", name: "Example", root: repo.root, default_branch: "trunk" },
      maintenance_issue_ref: null,
      worktree_inventory_known: true,
      entries: [{ branch: "safe", classification: "safe_candidate" }],
    });
  });

  it("does not project stale actionable rows when targeted refresh fails", async () => {
    const getBranches = vi.fn().mockReturnValue([makeBranch("stale-safe")]);
    const scanner = {
      getRepoById: vi.fn().mockReturnValue(repo),
      getRepos: vi.fn().mockReturnValue([repo]),
      refreshRepoAsync: vi.fn().mockImplementation(async () => {
        throw new Error("git status failed");
      }),
      getBranches,
      getWorktreeInventory: vi.fn().mockReturnValue({ known: true, worktrees: [] }),
    } as unknown as WorkScanner;
    const router = new Router();
    registerWorkRoutes(router, scanner);

    const response = await router.invoke({ method: "GET", url: "/api/work/repos/repo-1/audit" });
    expect(response).toEqual({
      status: 503,
      body: {
        error: "repository audit refresh failed",
        code: "audit_refresh_failed",
        detail: "git status failed",
      },
    });
    expect(getBranches).not.toHaveBeenCalled();
  });
});
