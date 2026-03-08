import { WorkScanner } from "../work-scanner.js";
function getParam(req, key) {
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
function getQueryParam(req, key) {
    if (!req || !req.query) {
        return undefined;
    }
    const value = req.query[key];
    if (Array.isArray(value)) {
        return typeof value[0] === "string" ? value[0] : undefined;
    }
    return typeof value === "string" ? value : undefined;
}
function sendJson(res, status, payload) {
    if (typeof res.status === "function") {
        res.status(status);
    }
    else if (typeof res.code === "function") {
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
function parseBranchSort(value) {
    if (value === "name" || value === "activity") {
        return value;
    }
    return "recency";
}
function getBranchName(branch) {
    return branch.branch || "";
}
function getBranchTimestamp(branch) {
    const raw = branch.last_commit?.date || branch.last_commit_date || "";
    const parsed = Date.parse(raw);
    return Number.isNaN(parsed) ? 0 : parsed;
}
export function filterAndSortBranches(branches, options) {
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
export function registerWorkRoutes(server, scanner) {
    const workScanner = scanner ?? new WorkScanner();
    const resolveRepo = (repoId) => {
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
    server.get("/api/work/repos", (req, res) => {
        ensureScan();
        const includeExcluded = getQueryParam(req, "include_excluded") === "true";
        const repos = workScanner.getRepos();
        const filtered = includeExcluded ? repos : repos.filter((r) => !r.excluded);
        sendJson(res, 200, filtered);
    });
    server.put("/api/work/repos/:id", (req, res) => {
        const id = getParam(req, "id");
        if (!id) {
            sendJson(res, 400, { error: "missing repo id" });
            return;
        }
        const body = req.body;
        const updated = workScanner.updateRepo(id, body ?? {});
        if (!updated) {
            sendJson(res, 404, { error: "repo not found" });
            return;
        }
        sendJson(res, 200, updated);
    });
    server.post("/api/work/repos/add", async (req, res) => {
        const body = req.body;
        if (!body?.root) {
            sendJson(res, 400, { error: "root required" });
            return;
        }
        try {
            const repo = await workScanner.addRepo(body.root, { name: body.name });
            if (!repo) {
                sendJson(res, 409, { error: "already tracked" });
                return;
            }
            sendJson(res, 201, repo);
        }
        catch (e) {
            sendJson(res, 400, { error: e.message });
        }
    });
    server.delete("/api/work/repos/:id", (req, res) => {
        const id = getParam(req, "id");
        const ok = workScanner.removeRepo(id ?? "");
        if (!ok) {
            sendJson(res, 404, { error: "repo not found" });
            return;
        }
        sendJson(res, 200, { ok: true });
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
