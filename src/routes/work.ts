import { WorkScanner, type BranchData } from "../work-scanner.js";
import { buildWorkAudit } from "../work-audit.js";
import { startPushSession, pushSingleRepo, getPushStatus, type PushScope } from "../push-manager.js";
import { getDb } from "../db.js";
import type { RequestLike, ResponseLike, RouteRegistrar } from "../server.js";
import { resolveWorkProject } from "../permissions/resources.js";
import {
  evaluateProjectAccess,
  PermissionError,
  requireProjectAccess,
  sendPermissionError,
  type ProjectRole,
} from "../permissions/store.js";
import { queryString, sendJson } from "./http.js";

type BranchSort = "recency" | "name" | "activity";
type CompareMode = "merge-base" | "range";

function parseBranchSort(value: string | undefined): BranchSort {
  if (value === "name" || value === "activity") {
    return value;
  }
  return "recency";
}

function getBranchName(branch: BranchData): string {
  return branch.branch || "";
}

function getBranchTimestamp(branch: BranchData): number {
  const raw = branch.last_commit?.date || branch.last_commit_date || "";
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback;
  }
  return parsed;
}

function parseCompareMode(value: string | undefined): CompareMode {
  return value === "range" ? "range" : "merge-base";
}

export function filterAndSortBranches(
  branches: BranchData[],
  options: { sort?: string; filter?: string },
): BranchData[] {
  const filterValue = (options.filter ?? "").trim().toLowerCase();
  const sort = parseBranchSort(options.sort);
  const filtered = filterValue
    ? branches.filter((branch) => getBranchName(branch).toLowerCase().includes(filterValue))
    : branches;

  const sorted = [...filtered];
  sorted.sort((a, b) => {
    if (sort === "name") {
      return getBranchName(a).localeCompare(getBranchName(b));
    }
    const aDirty = a.is_dirty ? 1 : 0;
    const bDirty = b.is_dirty ? 1 : 0;
    if (sort === "activity" && aDirty !== bDirty) {
      return bDirty - aDirty;
    }
    return getBranchTimestamp(b) - getBranchTimestamp(a);
  });
  return sorted;
}

export function registerWorkRoutes(server: RouteRegistrar, scanner?: WorkScanner): WorkScanner {
  const workScanner = scanner ?? new WorkScanner();
  const resolveRepo = (repoId: string) => {
    const repo = workScanner.getRepoById(repoId);
    if (repo) {
      return repo;
    }
    const index = Number(repoId);
    if (!Number.isInteger(index)) {
      return undefined;
    }
    const repos = workScanner.getCachedRepos();
    return repos[index];
  };
  const enforceRepoAccess = (
    req: RequestLike,
    res: ResponseLike,
    repo: { id: string; root: string },
    role: ProjectRole,
  ): boolean => {
    const db = getDb();
    const resolved = resolveWorkProject(db, repo.id);
    const project = resolved.ok ? resolved : resolveWorkProject(db, repo.root);
    // Unregistered work-scanner entries have no restriction state and retain
    // their historical behavior. Ambiguous registered identity fails closed.
    if (!project.ok && project.reason === "not_found") return true;
    if (!project.ok) {
      sendJson(res, 403, { error: "ambiguous work project", code: "ambiguous_project" });
      return false;
    }
    try {
      requireProjectAccess(db, req, project.project_id, role);
      return true;
    } catch (error) {
      if (error instanceof PermissionError) {
        sendPermissionError(res, error);
        return false;
      }
      throw error;
    }
  };
  const canRepoAccess = (req: RequestLike, repo: { id: string; root: string }, role: ProjectRole): boolean => {
    const db = getDb();
    const direct = resolveWorkProject(db, repo.id);
    const project = direct.ok ? direct : resolveWorkProject(db, repo.root);
    if (!project.ok) return project.reason === "not_found";
    return evaluateProjectAccess(db, {
      identity: req.client_identity ?? null,
      project_id: project.project_id,
      required_role: role,
    }).allowed;
  };

  server.get("/api/work/repos", (req, res) => {
    const includeExcluded = queryString(req, "include_excluded") === "true";
    const repos = workScanner.getCachedRepos();
    if (repos.length === 0 && workScanner.getRepoDiscoveryStatus() !== "ready") {
      const failed = workScanner.getRepoDiscoveryStatus() === "failed";
      sendJson(res, 503, {
        code: failed ? "repo_discovery_failed" : "repo_discovery_pending",
        error: failed ? "Project discovery failed; previous results are retained." : "Project discovery is still pending.",
      });
      return;
    }
    const visible = repos.filter((repo) => canRepoAccess(req, repo, "read"));
    const filtered = includeExcluded ? visible : visible.filter((r) => !r.excluded);
    sendJson(res, 200, filtered);
  }, { operation: { id: "get:/api/work/repos", effects: ["ledger:read"], requestSchema: null, reportingCategory: null }, fileRpc: "allow" });

  server.put("/api/work/repos/:id", (req, res) => {
    const id = req.params.id;
    if (!id) { sendJson(res, 400, { error: "missing repo id" }); return; }
    const repo = resolveRepo(id);
    if (!repo) { sendJson(res, 404, { error: "repo not found" }); return; }
    if (!enforceRepoAccess(req, res, repo, "write")) return;
    const body = req.body as { name?: string; excluded?: boolean } | undefined;
    const updated = workScanner.updateRepo(id, body ?? {});
    if (!updated) { sendJson(res, 404, { error: "repo not found" }); return; }
    sendJson(res, 200, updated);
  }, { operation: { id: "put:/api/work/repos/:id", effects: ["ledger:write"], requestSchema: null, reportingCategory: "work" }, fileRpc: "deny" });

  server.post("/api/work/repos/add", async (req, res) => {
    const body = req.body as { root?: string; name?: string } | undefined;
    if (!body?.root) { sendJson(res, 400, { error: "root required" }); return; }
    try {
      const repo = await workScanner.addRepo(body.root, { name: body.name });
      if (!repo) { sendJson(res, 409, { error: "already tracked" }); return; }
      sendJson(res, 201, repo);
    } catch (e) {
      sendJson(res, 400, { error: (e as Error).message });
    }
  }, { operation: { id: "post:/api/work/repos/add", effects: ({ instanceRole }) => instanceRole === "preview" ? ["ledger:write","files:preview","process:external"] : ["ledger:write","files:production","process:external"], requestSchema: null, reportingCategory: "work" }, fileRpc: "deny" });

  server.delete("/api/work/repos/:id", (req, res) => {
    const id = req.params.id;
    const repo = resolveRepo(id ?? "");
    if (!repo) { sendJson(res, 404, { error: "repo not found" }); return; }
    if (!enforceRepoAccess(req, res, repo, "write")) return;
    const ok = workScanner.removeRepo(id ?? "");
    if (!ok) { sendJson(res, 404, { error: "repo not found" }); return; }
    sendJson(res, 200, { ok: true });
  }, { operation: { id: "delete:/api/work/repos/:id", effects: ({ instanceRole }) => instanceRole === "preview" ? ["ledger:write","files:preview"] : ["ledger:write","files:production"], requestSchema: null, reportingCategory: "work" }, fileRpc: "deny" });

  server.get("/api/work/repos/:id/branches", (req, res) => {
    const repoId = req.params.id;
    if (!repoId) {
      sendJson(res, 400, { error: "missing repo id" });
      return;
    }
    const repo = resolveRepo(repoId);
    if (!repo) {
      sendJson(res, 404, { error: "repo not found" });
      return;
    }
    if (!enforceRepoAccess(req, res, repo, "read")) return;
    const sort = queryString(req, "sort");
    const filter = queryString(req, "filter");
    const branches = workScanner.getBranches(repo.root);
    sendJson(res, 200, filterAndSortBranches(branches, { sort, filter }));
  }, { operation: { id: "get:/api/work/repos/:id/branches", effects: ["ledger:read"], requestSchema: null, reportingCategory: null }, fileRpc: "deny" });

  server.get("/api/work/repos/:id/audit", async (req, res) => {
    const repoId = req.params.id;
    if (!repoId) {
      sendJson(res, 400, { error: "missing repo id" });
      return;
    }
    const repo = resolveRepo(repoId);
    if (!repo) {
      sendJson(res, 404, { error: "repo not found" });
      return;
    }
    if (!enforceRepoAccess(req, res, repo, "read")) return;
    const refresh = ["1", "true"].includes(queryString(req, "refresh") ?? "");
    let scan;
    try {
      scan = await workScanner.getRepoScan(repo.root, { refresh });
    } catch (error) {
      sendJson(res, 503, {
        error: "repository audit refresh failed",
        code: "audit_refresh_failed",
        detail: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    const branches = workScanner.getBranches(scan.repo.root);
    sendJson(res, 200, buildWorkAudit(scan.repo, branches, scan.inventory));
  }, { operation: { id: "get:/api/work/repos/:id/audit", effects: ["ledger:write","process:external"], requestSchema: null, reportingCategory: null }, fileRpc: "deny" });

  server.get("/api/work/repos/:id/branches/:branch/commits", async (req, res) => {
    const repoId = req.params.id;
    const branchName = req.params.branch;
    if (!repoId || !branchName) {
      sendJson(res, 400, { error: "missing repo id or branch" });
      return;
    }
    const repo = resolveRepo(repoId);
    if (!repo) {
      sendJson(res, 404, { error: "repo not found" });
      return;
    }
    if (!enforceRepoAccess(req, res, repo, "read")) return;
    const branch = branchName;
    if (!workScanner.getBranch(repo.root, branch)) {
      sendJson(res, 404, { error: "branch not found" });
      return;
    }
    const limit = parsePositiveInteger(queryString(req, "limit"), 50);
    const offset = parsePositiveInteger(queryString(req, "offset"), 0);
    sendJson(res, 200, await workScanner.getCommits(repo.root, branch, { limit, offset }));
  }, { operation: { id: "get:/api/work/repos/:id/branches/:branch/commits", effects: ["process:external"], requestSchema: null, reportingCategory: null }, fileRpc: "deny" });

  server.get("/api/work/repos/:id/compare", async (req, res) => {
    const repoId = req.params.id;
    if (!repoId) {
      sendJson(res, 400, { error: "missing repo id" });
      return;
    }
    const repo = resolveRepo(repoId);
    if (!repo) {
      sendJson(res, 404, { error: "repo not found" });
      return;
    }
    if (!enforceRepoAccess(req, res, repo, "read")) return;
    const from = queryString(req, "from");
    const to = queryString(req, "to");
    if (!from || !to) {
      sendJson(res, 400, { error: "missing compare endpoints" });
      return;
    }
    const mode = parseCompareMode(queryString(req, "mode"));
    sendJson(res, 200, await workScanner.compareRefs(repo.root, from, to, mode));
  }, { operation: { id: "get:/api/work/repos/:id/compare", effects: ["process:external"], requestSchema: null, reportingCategory: null }, fileRpc: "deny" });

  server.get("/api/work/repos/:id/worktrees", (req, res) => {
    const repoId = req.params.id;
    if (!repoId) {
      sendJson(res, 400, { error: "missing repo id" });
      return;
    }
    const repo = resolveRepo(repoId);
    if (!repo) {
      sendJson(res, 404, { error: "repo not found" });
      return;
    }
    if (!enforceRepoAccess(req, res, repo, "read")) return;
    sendJson(res, 200, workScanner.getWorktrees(repo.root));
  }, { operation: { id: "get:/api/work/repos/:id/worktrees", effects: ["ledger:read"], requestSchema: null, reportingCategory: null }, fileRpc: "deny" });

  server.get("/api/work/repos/:id/branch/:name", (req, res) => {
    const repoId = req.params.id;
    const branchName = req.params.name;
    if (!repoId || !branchName) {
      sendJson(res, 400, { error: "missing repo id or branch" });
      return;
    }
    const repo = resolveRepo(repoId);
    if (!repo) {
      sendJson(res, 404, { error: "repo not found" });
      return;
    }
    if (!enforceRepoAccess(req, res, repo, "read")) return;
    const branch = workScanner.getBranch(repo.root, decodeURIComponent(branchName));
    if (!branch) {
      sendJson(res, 404, { error: "branch not found" });
      return;
    }
    sendJson(res, 200, branch);
  }, { operation: { id: "get:/api/work/repos/:id/branch/:name", effects: ["ledger:read"], requestSchema: null, reportingCategory: null }, fileRpc: "deny" });

  server.post("/api/work/scan", async (_req, res) => {
    const summary = await workScanner.scanAllAsync();
    sendJson(res, 200, summary);
  }, { operation: { id: "post:/api/work/scan", effects: ["ledger:write","process:external"], requestSchema: null, reportingCategory: "work" }, fileRpc: "deny" });

  // --- Push routes (Bug: ea3102a) ---

  server.post("/api/work/push", (req, res) => {
    const body = req.body as { scope?: PushScope; repo_ids?: string[] } | undefined;
    const scope: PushScope = body?.scope === "all_ahead" ? "all_ahead" : "current";

    try {
      let repos = workScanner.getRepos().filter((r) => !r.excluded && r.exists);
      if (body?.repo_ids && body.repo_ids.length > 0) {
        const idSet = new Set(body.repo_ids);
        repos = repos.filter((r) => idSet.has(r.id));
      }
      if (repos.length === 0) {
        sendJson(res, 400, { error: "no repos to push" });
        return;
      }
      for (const repo of repos) {
        if (!enforceRepoAccess(req, res, repo, "write")) return;
      }
      const session = startPushSession(repos, scope, workScanner);
      sendJson(res, 202, session);
    } catch (err) {
      sendJson(res, 409, { error: (err as Error).message });
    }
  }, { operation: { id: "post:/api/work/push", effects: ["ledger:write","files:production","network:publish","process:external"], requestSchema: null, reportingCategory: "work" }, fileRpc: "deny" });

  server.post("/api/work/repos/:id/push", async (req, res) => {
    const repoId = req.params.id;
    if (!repoId) {
      sendJson(res, 400, { error: "missing repo id" });
      return;
    }
    const repo = resolveRepo(repoId);
    if (!repo) {
      sendJson(res, 404, { error: "repo not found" });
      return;
    }
    if (!enforceRepoAccess(req, res, repo, "write")) return;
    const body = req.body as { scope?: PushScope } | undefined;
    const scope: PushScope = body?.scope === "all_ahead" ? "all_ahead" : "current";

    try {
      const result = await pushSingleRepo(repo, scope, workScanner);
      sendJson(res, 200, result);
    } catch (err) {
      sendJson(res, 500, { error: (err as Error).message });
    }
  }, { operation: { id: "post:/api/work/repos/:id/push", effects: ["ledger:write","files:production","network:publish","process:external"], requestSchema: null, reportingCategory: "work" }, fileRpc: "deny" });

  server.get("/api/work/push/status", (_req, res) => {
    sendJson(res, 200, getPushStatus());
  }, { operation: { id: "get:/api/work/push/status", effects: ["ledger:read"], requestSchema: null, reportingCategory: null }, fileRpc: "deny" });

  return workScanner;
}
