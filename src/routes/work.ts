import { WorkScanner, type BranchData } from "../work-scanner.js";
import { buildWorkAudit } from "../work-audit.js";
import { startPushSession, pushSingleRepo, getPushStatus, type PushScope } from "../push-manager.js";
import type { RouteRegistrar } from "../server.js";
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
    const repos = workScanner.getRepos();
    return repos[index];
  };

  // Bug: d6f79a2 — fire-and-forget async scan; respond immediately with cached
  // repo list so the UI is not blocked while branches are scanned. The first
  // GET /api/work/repos used to call scanAll() synchronously, blocking the
  // event loop for 3-5s (85+ branches × spawnSync) and causing all concurrent
  // HTTP requests (including issue detail fetches) to queue up.
  let hasScannedThisSession = false;
  let startupScan: Promise<unknown> | null = null;
  const ensureScan = () => {
    if (hasScannedThisSession || startupScan) return;
    startupScan = workScanner.scanAllAsync({ skip_recent: true });
    void startupScan.then(
      () => { hasScannedThisSession = true; },
      () => { startupScan = null; },
    );
  };

  server.get("/api/work/repos", (req, res) => {
    ensureScan();
    const includeExcluded = queryString(req, "include_excluded") === "true";
    const repos = workScanner.getRepos();
    const filtered = includeExcluded ? repos : repos.filter((r) => !r.excluded);
    sendJson(res, 200, filtered);
  }, { fileRpc: "allow" });

  server.put("/api/work/repos/:id", (req, res) => {
    const id = req.params.id;
    if (!id) { sendJson(res, 400, { error: "missing repo id" }); return; }
    const body = req.body as { name?: string; excluded?: boolean } | undefined;
    const updated = workScanner.updateRepo(id, body ?? {});
    if (!updated) { sendJson(res, 404, { error: "repo not found" }); return; }
    sendJson(res, 200, updated);
  }, { fileRpc: "deny" });

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
  }, { fileRpc: "deny" });

  server.delete("/api/work/repos/:id", (req, res) => {
    const id = req.params.id;
    const ok = workScanner.removeRepo(id ?? "");
    if (!ok) { sendJson(res, 404, { error: "repo not found" }); return; }
    sendJson(res, 200, { ok: true });
  }, { fileRpc: "deny" });

  server.get("/api/work/repos/:id/branches", (req, res) => {
    ensureScan();
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
    const sort = queryString(req, "sort");
    const filter = queryString(req, "filter");
    const branches = workScanner.getBranches(repo.root);
    sendJson(res, 200, filterAndSortBranches(branches, { sort, filter }));
  }, { fileRpc: "deny" });

  server.get("/api/work/repos/:id/audit", (req, res) => {
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
    let refreshedRepo;
    try {
      refreshedRepo = workScanner.refreshRepo(repo.root);
    } catch (error) {
      sendJson(res, 503, {
        error: "repository audit refresh failed",
        code: "audit_refresh_failed",
        detail: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    const branches = workScanner.getBranches(refreshedRepo.root);
    const inventory = workScanner.getWorktreeInventory(refreshedRepo.root);
    sendJson(res, 200, buildWorkAudit(refreshedRepo, branches, inventory));
  }, { fileRpc: "deny" });

  server.get("/api/work/repos/:id/branches/:branch/commits", (req, res) => {
    ensureScan();
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
    const branch = branchName;
    if (!workScanner.getBranch(repo.root, branch)) {
      sendJson(res, 404, { error: "branch not found" });
      return;
    }
    const limit = parsePositiveInteger(queryString(req, "limit"), 50);
    const offset = parsePositiveInteger(queryString(req, "offset"), 0);
    sendJson(res, 200, workScanner.getCommits(repo.root, branch, { limit, offset }));
  }, { fileRpc: "deny" });

  server.get("/api/work/repos/:id/compare", (req, res) => {
    ensureScan();
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
    const from = queryString(req, "from");
    const to = queryString(req, "to");
    if (!from || !to) {
      sendJson(res, 400, { error: "missing compare endpoints" });
      return;
    }
    const mode = parseCompareMode(queryString(req, "mode"));
    sendJson(res, 200, workScanner.compareRefs(repo.root, from, to, mode));
  }, { fileRpc: "deny" });

  server.get("/api/work/repos/:id/worktrees", (req, res) => {
    ensureScan();
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
    sendJson(res, 200, workScanner.getWorktrees(repo.root));
  }, { fileRpc: "deny" });

  server.get("/api/work/repos/:id/branch/:name", (req, res) => {
    ensureScan();
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
    const branch = workScanner.getBranch(repo.root, decodeURIComponent(branchName));
    if (!branch) {
      sendJson(res, 404, { error: "branch not found" });
      return;
    }
    sendJson(res, 200, branch);
  }, { fileRpc: "deny" });

  server.post("/api/work/scan", async (_req, res) => {
    const summary = await workScanner.scanAllAsync();
    sendJson(res, 200, summary);
  }, { fileRpc: "deny" });

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
      const session = startPushSession(repos, scope, workScanner);
      sendJson(res, 202, session);
    } catch (err) {
      sendJson(res, 409, { error: (err as Error).message });
    }
  }, { fileRpc: "deny" });

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
    const body = req.body as { scope?: PushScope } | undefined;
    const scope: PushScope = body?.scope === "all_ahead" ? "all_ahead" : "current";

    try {
      const result = await pushSingleRepo(repo, scope, workScanner);
      sendJson(res, 200, result);
    } catch (err) {
      sendJson(res, 500, { error: (err as Error).message });
    }
  }, { fileRpc: "deny" });

  server.get("/api/work/push/status", (_req, res) => {
    sendJson(res, 200, getPushStatus());
  }, { fileRpc: "deny" });

  return workScanner;
}
