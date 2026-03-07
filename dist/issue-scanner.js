import { spawn, spawnSync } from "child_process";
const CACHE_TTL_MS = 60_000;
// Bug: e139954 — retry on non-zero exit to handle git-bug lock contention
// when Claude Code and Mandible both call git-bug concurrently.
const GITBUG_RETRY_COUNT = 3;
const GITBUG_RETRY_BASE_MS = 100;
function runGitBug(args, cwd) {
    for (let attempt = 0; attempt < GITBUG_RETRY_COUNT; attempt++) {
        const result = spawnSync("git-bug", args, {
            cwd,
            encoding: "utf8",
            env: process.env,
            timeout: 15_000,
        });
        if (result.status === 0) {
            return result.stdout.trimEnd();
        }
        if (attempt < GITBUG_RETRY_COUNT - 1) {
            // Synchronous sleep with jitter to back off before retry.
            // spawnSync is inherently blocking so a busy-wait is acceptable here —
            // we're already on the blocking path.
            const delayMs = GITBUG_RETRY_BASE_MS * (attempt + 1) + Math.floor(Math.random() * 100);
            const deadline = Date.now() + delayMs;
            while (Date.now() < deadline) { /* busy-wait */ }
        }
    }
    return null;
}
function runCommandAsync(command, args, cwd, timeoutMs) {
    return new Promise((resolve) => {
        const child = spawn(command, args, {
            cwd,
            env: process.env,
            stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        if (child.stdout) {
            child.stdout.on("data", (chunk) => {
                stdout += chunk.toString();
            });
        }
        let finished = false;
        const finish = (status) => {
            if (finished)
                return;
            finished = true;
            resolve({ status, stdout: stdout.trimEnd() });
        };
        const timer = setTimeout(() => {
            child.kill("SIGKILL");
            finish(null);
        }, timeoutMs);
        if (typeof timer === "object" && "unref" in timer) {
            timer.unref();
        }
        child.on("close", (code) => {
            clearTimeout(timer);
            finish(code);
        });
        child.on("error", () => {
            clearTimeout(timer);
            finish(null);
        });
    });
}
// Bug: e139954 — retry with jitter for async path to handle lock contention
async function runGitBugAsync(args, cwd) {
    for (let attempt = 0; attempt < GITBUG_RETRY_COUNT; attempt++) {
        const result = await runCommandAsync("git-bug", args, cwd, 15_000);
        if (result.status === 0) {
            return result.stdout;
        }
        if (attempt < GITBUG_RETRY_COUNT - 1) {
            const delayMs = GITBUG_RETRY_BASE_MS * (attempt + 1) + Math.floor(Math.random() * 100);
            await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
    }
    return null;
}
function hasGitBugRefs(repoRoot) {
    const result = spawnSync("git", ["for-each-ref", "--count=1", "refs/bugs/"], {
        cwd: repoRoot,
        encoding: "utf8",
        timeout: 5_000,
    });
    if (result.status !== 0) {
        return false;
    }
    return result.stdout.trim().length > 0;
}
async function hasGitBugRefsAsync(repoRoot) {
    const result = await runCommandAsync("git", ["for-each-ref", "--count=1", "refs/bugs/"], repoRoot, 5_000);
    if (result.status !== 0) {
        return false;
    }
    return result.stdout.trim().length > 0;
}
/**
 * Parse the JSON output of `git-bug bug show <id> --format=json`.
 *
 * JSON schema (git-bug v0.10.1):
 *   { id, human_id, title, status, labels, author: { name },
 *     create_time: { time }, comments: [{ id, human_id, author: { name }, message }] }
 *
 * The first comment is the issue description; remaining are actual comments.
 */
function parseIssueDetailJson(jsonStr, repoId, repoName) {
    try {
        const data = JSON.parse(jsonStr);
        if (!data || !data.title) {
            return null;
        }
        const allComments = Array.isArray(data.comments) ? data.comments : [];
        // git-bug stores the description as the first comment
        const description = allComments.length > 0
            ? (allComments[0].message ?? "")
            : "";
        const restComments = allComments.slice(1).map((c) => ({
            id: c.human_id ?? c.id ?? "",
            author: c.author?.name ?? "",
            date: "",
            body: c.message ?? "",
        }));
        return {
            id: data.human_id ?? data.id ?? "",
            repo_id: repoId,
            repo_name: repoName,
            title: data.title,
            status: data.status === "closed" ? "closed" : "open",
            labels: data.labels ?? [],
            author: data.author?.name ?? "",
            created_at: data.create_time?.time ?? "",
            description,
            comments: restComments,
        };
    }
    catch {
        return null;
    }
}
export class IssueScanner {
    cache = new Map();
    workScanner;
    scanPromise = null;
    constructor(workScanner) {
        this.workScanner = workScanner;
    }
    getRepoSummaries() {
        this.ensureScan();
        const summaries = [];
        for (const entry of this.cache.values()) {
            summaries.push(entry.summary);
        }
        // Sort by repo name
        summaries.sort((a, b) => a.repo_name.localeCompare(b.repo_name));
        return summaries;
    }
    getIssueDetail(repoId, issueId) {
        const repo = this.workScanner.getRepoById(repoId);
        if (!repo || !repo.exists) {
            return null;
        }
        const output = runGitBug(["bug", "show", issueId, "--format=json"], repo.root);
        if (!output) {
            return null;
        }
        return parseIssueDetailJson(output, repo.id, repo.name);
    }
    /** Look up an issue's status from the cache. Returns null if unknown. */
    getIssueStatus(repoId, issueId) {
        this.ensureScan();
        const cached = this.cache.get(repoId);
        if (!cached) {
            return null;
        }
        const issue = cached.summary.issues.find((i) => i.id === issueId);
        return issue ? issue.status : null;
    }
    /** Search all scanned repos for an issue matching the given ID prefix. */
    findIssueAcrossRepos(issueId) {
        this.ensureScan();
        for (const summary of this.getRepoSummaries()) {
            // Check cache first to avoid shelling out for every repo
            const cached = this.cache.get(summary.repo_id);
            if (cached) {
                const match = cached.summary.issues.find((i) => i.id === issueId || i.id.startsWith(issueId));
                if (!match)
                    continue;
            }
            const detail = this.getIssueDetail(summary.repo_id, issueId);
            if (detail)
                return detail;
        }
        return null;
    }
    scanAll() {
        // Ensure WorkScanner has refreshed its repo list before we iterate it
        const repos = this.workScanner.getRepos();
        for (const repo of repos) {
            if (!repo.exists) {
                continue;
            }
            this.scanRepo(repo.id, repo.name, repo.root);
        }
        return this.getRepoSummaries();
    }
    scanAllAsync() {
        if (!this.scanPromise) {
            this.scanPromise = this.scanAllInternalAsync().finally(() => {
                this.scanPromise = null;
            });
        }
        return this.scanPromise;
    }
    /**
     * Force-scan a single repo by its repo ID.
     * Returns true if the repo was found and scanned, false otherwise.
     * Used by the /api/issues/:repoId/scan endpoint to unblock deep-link 404s.
     */
    scanRepoById(repoId) {
        const repo = this.workScanner.getRepoById(repoId);
        if (!repo || !repo.exists) {
            return false;
        }
        // Invalidate cache so scanRepo runs unconditionally
        this.invalidateRepo(repoId);
        this.scanRepo(repo.id, repo.name, repo.root);
        return true;
    }
    async scanRepoByIdAsync(repoId) {
        const repo = this.workScanner.getRepoById(repoId);
        if (!repo || !repo.exists) {
            return false;
        }
        this.invalidateRepo(repoId);
        await this.scanRepoAsync(repo.id, repo.name, repo.root);
        return true;
    }
    closeIssue(repoId, issueId) {
        const repo = this.workScanner.getRepoById(repoId);
        if (!repo || !repo.exists) {
            return false;
        }
        const result = spawnSync("git-bug", ["bug", "status", "close", issueId], {
            cwd: repo.root,
            encoding: "utf8",
            timeout: 10_000,
        });
        if (result.status === 0) {
            this.invalidateRepo(repoId);
        }
        return result.status === 0;
    }
    reopenIssue(repoId, issueId) {
        const repo = this.workScanner.getRepoById(repoId);
        if (!repo || !repo.exists) {
            return false;
        }
        const result = spawnSync("git-bug", ["bug", "status", "open", issueId], {
            cwd: repo.root,
            encoding: "utf8",
            timeout: 10_000,
        });
        if (result.status === 0) {
            this.invalidateRepo(repoId);
        }
        return result.status === 0;
    }
    addComment(repoId, issueId, message) {
        const repo = this.workScanner.getRepoById(repoId);
        if (!repo || !repo.exists) {
            return false;
        }
        const result = spawnSync("git-bug", ["bug", "comment", "new", issueId, "-m", message, "--non-interactive"], {
            cwd: repo.root,
            encoding: "utf8",
            timeout: 10_000,
        });
        return result.status === 0;
    }
    addLabel(repoId, issueId, label) {
        const repo = this.workScanner.getRepoById(repoId);
        if (!repo || !repo.exists) {
            return false;
        }
        const result = spawnSync("git-bug", ["bug", "label", "new", issueId, label], {
            cwd: repo.root,
            encoding: "utf8",
            timeout: 10_000,
        });
        if (result.status === 0) {
            this.invalidateRepo(repoId);
        }
        return result.status === 0;
    }
    removeLabel(repoId, issueId, label) {
        const repo = this.workScanner.getRepoById(repoId);
        if (!repo || !repo.exists) {
            return false;
        }
        const result = spawnSync("git-bug", ["bug", "label", "rm", issueId, label], {
            cwd: repo.root,
            encoding: "utf8",
            timeout: 10_000,
        });
        if (result.status === 0) {
            this.invalidateRepo(repoId);
        }
        return result.status === 0;
    }
    ensureScan() {
        if (this.scanPromise) {
            return;
        }
        const repos = this.workScanner.getRepos();
        const now = Date.now();
        let hasStale = false;
        for (const repo of repos) {
            if (!repo.exists) {
                continue;
            }
            const cached = this.cache.get(repo.id);
            if (cached && now - cached.scannedAt < CACHE_TTL_MS) {
                continue;
            }
            hasStale = true;
            break;
        }
        if (hasStale) {
            void this.scanAllAsync();
        }
    }
    async scanAllInternalAsync() {
        const repos = this.workScanner.getRepos();
        for (const repo of repos) {
            if (!repo.exists) {
                continue;
            }
            await this.scanRepoAsync(repo.id, repo.name, repo.root);
            await new Promise((resolve) => setImmediate(resolve));
        }
        return this.getRepoSummaries();
    }
    scanRepo(repoId, repoName, repoRoot) {
        if (!hasGitBugRefs(repoRoot)) {
            // No git-bug issues in this repo — skip it, remove stale cache
            this.cache.delete(repoId);
            return;
        }
        const output = runGitBug(["bug", "--format=json"], repoRoot);
        if (output === null) {
            // git-bug not available or command failed
            this.cache.delete(repoId);
            return;
        }
        const issues = [];
        let openCount = 0;
        let mergedCount = 0;
        let closedCount = 0;
        let parsed;
        try {
            parsed = JSON.parse(output || "[]");
        }
        catch {
            // JSON parse failure — clear cache so next scan retries
            this.cache.delete(repoId);
            return;
        }
        for (const entry of parsed) {
            const status = entry.status === "closed" ? "closed" : "open";
            const labels = entry.labels ?? [];
            const issue = {
                id: entry.human_id,
                repo_id: repoId,
                repo_name: repoName,
                title: entry.title,
                status,
                labels,
                author: entry.actors?.[0]?.name ?? "",
                created_at: entry.create_time?.time ?? "",
                description: "",
            };
            issues.push(issue);
            if (status === "open") {
                openCount++;
            }
            else if (labels.includes("merged")) {
                // Bug: e32ee8b — three-state lifecycle: closed + "merged" label = merged
                mergedCount++;
            }
            else {
                closedCount++;
            }
        }
        this.cache.set(repoId, {
            summary: {
                repo_id: repoId,
                repo_name: repoName,
                repo_root: repoRoot,
                open_count: openCount,
                merged_count: mergedCount,
                closed_count: closedCount,
                issues,
            },
            scannedAt: Date.now(),
        });
    }
    async scanRepoAsync(repoId, repoName, repoRoot) {
        if (!await hasGitBugRefsAsync(repoRoot)) {
            this.cache.delete(repoId);
            return;
        }
        const output = await runGitBugAsync(["bug", "--format=json"], repoRoot);
        if (output === null) {
            this.cache.delete(repoId);
            return;
        }
        const issues = [];
        let openCount = 0;
        let mergedCount = 0;
        let closedCount = 0;
        let parsed;
        try {
            parsed = JSON.parse(output || "[]");
        }
        catch {
            this.cache.delete(repoId);
            return;
        }
        for (const entry of parsed) {
            const status = entry.status === "closed" ? "closed" : "open";
            const labels = entry.labels ?? [];
            const issue = {
                id: entry.human_id,
                repo_id: repoId,
                repo_name: repoName,
                title: entry.title,
                status,
                labels,
                author: entry.actors?.[0]?.name ?? "",
                created_at: entry.create_time?.time ?? "",
                description: "",
            };
            issues.push(issue);
            if (status === "open") {
                openCount++;
            }
            else if (labels.includes("merged")) {
                mergedCount++;
            }
            else {
                closedCount++;
            }
        }
        this.cache.set(repoId, {
            summary: {
                repo_id: repoId,
                repo_name: repoName,
                repo_root: repoRoot,
                open_count: openCount,
                merged_count: mergedCount,
                closed_count: closedCount,
                issues,
            },
            scannedAt: Date.now(),
        });
    }
    invalidateRepo(repoId) {
        this.cache.delete(repoId);
    }
}
