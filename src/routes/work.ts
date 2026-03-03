import { WorkScanner, type BranchData } from "../work-scanner.js";

export interface RouteHandler<Request = any, Response = any> {
  (req: Request, res: Response): void | Promise<void>;
}

export interface WorkServer {
  get(path: string, handler: RouteHandler): void;
  post(path: string, handler: RouteHandler): void;
}

function getParam(req: any, key: string): string | undefined {
  if (!req) {
    return undefined;
  }
  if (req.params && typeof req.params[key] === "string") {
    return req.params[key];
  }
  if (typeof req.param === "function") {
    const value = req.param(key);
    return typeof value === "string" ? value : undefined;
  }
  return undefined;
}

function getQueryParam(req: any, key: string): string | undefined {
  if (!req || !req.query) {
    return undefined;
  }
  const value = req.query[key];
  if (Array.isArray(value)) {
    return typeof value[0] === "string" ? value[0] : undefined;
  }
  return typeof value === "string" ? value : undefined;
}

function sendJson(res: any, status: number, payload: unknown): void {
  if (typeof res.status === "function") {
    res.status(status);
  } else if (typeof res.code === "function") {
    res.code(status);
  }

  if (typeof res.json === "function") {
    res.json(payload);
    return;
  }
  if (typeof res.send === "function") {
    res.send(payload);
    return;
  }
  if (typeof res.end === "function") {
    res.end(JSON.stringify(payload));
  }
}

type BranchSort = "recency" | "name" | "activity";

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

export function registerWorkRoutes(server: WorkServer, scanner?: WorkScanner): WorkScanner {
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
  const ensureScan = () => {
    if (!hasScannedThisSession) {
      hasScannedThisSession = true;
      void workScanner.scanAll();
    }
  };

  server.get("/api/work/repos", (_req, res) => {
    ensureScan();
    sendJson(res, 200, workScanner.getRepos());
  });

  server.get("/api/work/repos/:id/branches", (req, res) => {
    ensureScan();
    const repoId = getParam(req, "id");
    if (!repoId) {
      sendJson(res, 400, { error: "missing repo id" });
      return;
    }
    const repo = resolveRepo(repoId);
    if (!repo) {
      sendJson(res, 404, { error: "repo not found" });
      return;
    }
    const sort = getQueryParam(req, "sort");
    const filter = getQueryParam(req, "filter");
    const branches = workScanner.getBranches(repo.root);
    sendJson(res, 200, filterAndSortBranches(branches, { sort, filter }));
  });

  server.get("/api/work/repos/:id/worktrees", (req, res) => {
    ensureScan();
    const repoId = getParam(req, "id");
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
  });

  server.get("/api/work/repos/:id/branch/:name", (req, res) => {
    ensureScan();
    const repoId = getParam(req, "id");
    const branchName = getParam(req, "name");
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
  });

  server.post("/api/work/scan", async (_req, res) => {
    const summary = await workScanner.scanAll();
    sendJson(res, 200, summary);
  });

  return workScanner;
}
