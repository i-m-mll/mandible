import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { getDb } from "./db.js";
import { broadcast } from "./sse.js";
const DEFAULT_REPO_ROOT = path.join(os.homedir(), ".dotfiles");
const DEFAULT_CONFIG_PATH = path.join(os.homedir(), ".config", "mandible", "repos.json");
const BRANCH_TABLE_SCHEMA = `
  CREATE TABLE IF NOT EXISTS branches (
    repo_root TEXT NOT NULL,
    branch TEXT NOT NULL,
    is_current INTEGER NOT NULL,
    is_worktree INTEGER NOT NULL,
    worktree_path TEXT,
    is_dirty INTEGER NOT NULL,
    ahead INTEGER NOT NULL,
    behind INTEGER NOT NULL,
    ahead_default INTEGER DEFAULT 0,
    behind_default INTEGER DEFAULT 0,
    default_branch TEXT DEFAULT '',
    last_commit_hash TEXT,
    last_commit_message TEXT,
    last_commit_author TEXT,
    last_commit_date TEXT,
    diff_stat TEXT,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (repo_root, branch)
  );
`;
function resolveHome(input) {
    if (input.startsWith("~")) {
        return path.join(os.homedir(), input.slice(1));
    }
    return input;
}
function readRepoConfig(configPath) {
    try {
        const raw = fs.readFileSync(configPath, "utf8");
        const parsed = JSON.parse(raw);
        if (!parsed.repos) {
            return { repos: [], exists: true };
        }
        return {
            repos: parsed.repos.filter((repo) => typeof repo === "string"),
            exists: true,
        };
    }
    catch (error) {
        if (error.code === "ENOENT") {
            return { repos: [], exists: false };
        }
        throw error;
    }
}
function normalizeRoots(roots) {
    const unique = new Set();
    for (const root of roots) {
        const resolved = path.resolve(resolveHome(root));
        unique.add(resolved);
    }
    return Array.from(unique.values());
}
// Bug: b81c3e4 — scan one extra level of nesting so repos under ~/Main/subdir/repo
// are discovered. The depth-2 scan only applies to the ~/Main tree (which uses
// category subdirectories); ~/dev and ~/projects remain depth-1 as before.
// Only adds entries where .git is a directory (not a worktree gitfile).
function isGitDirectory(candidate) {
    const gitPath = path.join(candidate, ".git");
    try {
        return fs.statSync(gitPath).isDirectory();
    }
    catch {
        return false;
    }
}
function scanDirForRepos(dir, depth, roots) {
    if (!fs.existsSync(dir)) {
        return;
    }
    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    }
    catch {
        return;
    }
    for (const entry of entries) {
        if (!entry.isDirectory()) {
            continue;
        }
        const candidate = path.join(dir, entry.name);
        if (isGitDirectory(candidate)) {
            roots.push(candidate);
        }
        else if (depth > 1) {
            scanDirForRepos(candidate, depth - 1, roots);
        }
    }
}
function discoverRepos(defaultRepoRoot) {
    const roots = [];
    const dotfiles = path.join(os.homedir(), ".dotfiles");
    if (isGitDirectory(dotfiles)) {
        roots.push(dotfiles);
    }
    if (defaultRepoRoot) {
        const resolvedDefault = path.resolve(defaultRepoRoot);
        if (resolvedDefault !== path.resolve(dotfiles) &&
            isGitDirectory(resolvedDefault)) {
            roots.push(resolvedDefault);
        }
    }
    // Depth-1 scan for flat repo directories
    const depth1Dirs = [
        path.join(os.homedir(), "dev"),
        path.join(os.homedir(), "projects"),
    ];
    for (const dir of depth1Dirs) {
        scanDirForRepos(dir, 1, roots);
    }
    // Depth-2 scan for category-organised directories (e.g. ~/Main/15 WWW/mll.bio)
    const depth2Dirs = [
        path.join(os.homedir(), "Main"),
    ];
    for (const dir of depth2Dirs) {
        scanDirForRepos(dir, 2, roots);
    }
    return roots;
}
function stripLeadingDot(value) {
    return value.replace(/^\.+/, "");
}
function slugify(value) {
    const slug = value
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "");
    return slug || "repo";
}
function runGit(args, options = { cwd: process.cwd() }) {
    const result = spawnSync("git", args, {
        cwd: options.cwd,
        encoding: "utf8",
        env: process.env,
    });
    if (result.status !== 0) {
        if (options.allow_failure) {
            return null;
        }
        const stderr = result.stderr ? String(result.stderr) : "";
        const message = `git ${args.join(" ")} failed: ${stderr}`.trim();
        throw new Error(message);
    }
    return result.stdout.trimEnd();
}
function parseWorktreeList(output) {
    const worktrees = [];
    const lines = output.split("\n");
    let current = {};
    const flush = () => {
        if (current.path) {
            worktrees.push({
                path: current.path,
                branch: current.branch ?? null,
            });
        }
        current = {};
    };
    for (const line of lines) {
        if (!line.trim()) {
            flush();
            continue;
        }
        const [key, ...rest] = line.split(" ");
        const value = rest.join(" ");
        if (key === "worktree") {
            current.path = value;
        }
        else if (key === "branch") {
            const normalized = value.startsWith("refs/heads/")
                ? value.slice("refs/heads/".length)
                : value;
            current.branch = normalized;
        }
    }
    flush();
    return worktrees;
}
function parseLastCommit(output) {
    if (!output) {
        return null;
    }
    const parts = output.split("\u001f");
    if (parts.length < 4) {
        return null;
    }
    const [hash, message, author, date] = parts;
    return {
        hash,
        message,
        author,
        date,
    };
}
function ensureSchema(db) {
    db.exec(BRANCH_TABLE_SCHEMA);
}
function toDbBool(value) {
    return value ? 1 : 0;
}
function fromDbBool(value) {
    return value === 1;
}
function compareValue(a, b) {
    return a === b;
}
function rowChanged(existing, next) {
    for (const [key, value] of Object.entries(next)) {
        if (key === "updated_at") {
            continue;
        }
        if (!compareValue(existing[key], value)) {
            return true;
        }
    }
    return false;
}
export class WorkScanner {
    db;
    defaultRepoRoot;
    configPath;
    repoRootsOverride;
    emit;
    repoInfos = [];
    constructor(options = {}) {
        this.db = options.db ?? getDb();
        this.defaultRepoRoot = path.resolve(resolveHome(options.default_repo_root ?? DEFAULT_REPO_ROOT));
        this.configPath = path.resolve(resolveHome(options.config_path ?? DEFAULT_CONFIG_PATH));
        this.repoRootsOverride = options.repo_roots
            ? normalizeRoots(options.repo_roots)
            : null;
        this.emit = options.on_event ?? ((event) => broadcast(event));
        ensureSchema(this.db);
    }
    getRepos() {
        if (this.repoInfos.length === 0) {
            this.refreshRepoInfos();
        }
        return this.repoInfos;
    }
    hasCachedData() {
        const row = this.db.prepare("SELECT 1 FROM branches LIMIT 1").get();
        return Boolean(row);
    }
    getRepoById(id) {
        return this.getRepos().find((repo) => repo.id === id);
    }
    getBranches(repoRoot) {
        const rows = this.db
            .prepare(`
        SELECT
          repo_root,
          branch,
          is_current,
          is_worktree,
          worktree_path,
          is_dirty,
          ahead,
          behind,
          ahead_default,
          behind_default,
          default_branch,
          last_commit_hash,
          last_commit_message,
          last_commit_author,
          last_commit_date,
          diff_stat
        FROM branches
        WHERE repo_root = ?
        ORDER BY branch ASC
        `)
            .all(repoRoot);
        return rows.map((row) => {
            const branchName = String(row.branch);
            const upstreamInfo = this.getUpstreamInfo(repoRoot, branchName);
            return {
                repo_root: String(row.repo_root),
                branch: branchName,
                is_current: fromDbBool(Number(row.is_current)),
                is_worktree: fromDbBool(Number(row.is_worktree)),
                worktree_path: row.worktree_path ? String(row.worktree_path) : null,
                is_dirty: fromDbBool(Number(row.is_dirty)),
                ahead: Number(row.ahead),
                behind: Number(row.behind),
                has_upstream: upstreamInfo.has_upstream,
                upstream: upstreamInfo.upstream,
                ahead_default: Number(row.ahead_default ?? 0),
                behind_default: Number(row.behind_default ?? 0),
                default_branch: row.default_branch ? String(row.default_branch) : "\u2014",
                last_commit: row.last_commit_hash
                    ? {
                        hash: String(row.last_commit_hash),
                        message: String(row.last_commit_message ?? ""),
                        author: String(row.last_commit_author ?? ""),
                        date: String(row.last_commit_date ?? ""),
                    }
                    : null,
                last_commit_date: row.last_commit_date ? String(row.last_commit_date) : null,
                diff_stat: row.diff_stat ? String(row.diff_stat) : null,
            };
        });
    }
    getBranch(repoRoot, branch) {
        const rows = this.getBranches(repoRoot);
        return rows.find((row) => row.branch === branch) ?? null;
    }
    getWorktrees(repoRoot) {
        const branches = this.getBranches(repoRoot);
        return branches
            .filter((branch) => branch.is_worktree && branch.worktree_path)
            .map((branch) => ({
            branch: branch.branch,
            path: branch.worktree_path,
            is_current: branch.is_current,
        }));
    }
    // Bug: d6f79a2 — async scanAll yields the event loop between repos so the HTTP
    // server stays responsive while the branch scan runs. spawnSync calls inside
    // scanRepo block the thread; without yielding, a full scan (85+ branches) can
    // hold the event loop for 3-5s, causing issue detail fetches to hang.
    async scanAll() {
        const start = Date.now();
        this.refreshRepoInfos();
        this.emit({
            event: "work:scan:started",
            type: "work:scan:started",
            data: { started_at: new Date(start).toISOString() },
        });
        let branchesUpdated = 0;
        let branchesRemoved = 0;
        const missingRepos = [];
        let scannedRepos = 0;
        for (const repo of this.repoInfos) {
            if (!repo.exists || !this.isGitRepo(repo.root)) {
                missingRepos.push(repo.root);
                continue;
            }
            scannedRepos += 1;
            try {
                const scanResult = this.scanRepo(repo.root, repo.id);
                branchesUpdated += scanResult.updated;
                branchesRemoved += scanResult.removed;
            }
            catch (_error) {
                // Log but continue scanning remaining repos
                console.error(`[work-scanner] scanRepo failed for ${repo.root}: ${_error}`);
            }
            // Yield the event loop between repos so HTTP requests are not starved
            // while a large repo (many branches) is being scanned.
            await new Promise((resolve) => setImmediate(resolve));
        }
        const durationMs = Date.now() - start;
        const summary = {
            scanned_repos: scannedRepos,
            branches_updated: branchesUpdated,
            branches_removed: branchesRemoved,
            missing_repos: missingRepos,
            duration_ms: durationMs,
        };
        this.emit({
            event: "work:scan:completed",
            type: "work:scan:completed",
            data: summary,
        });
        return summary;
    }
    refreshRepoInfos() {
        const roots = this.resolveRepoRoots();
        const sortedRoots = [...roots].sort((a, b) => path.normalize(a).localeCompare(path.normalize(b)));
        const candidates = sortedRoots.map((root) => {
            const baseName = path.basename(root);
            const nameBase = stripLeadingDot(baseName) || baseName;
            const name = nameBase || baseName || "repo";
            const baseSlug = slugify(nameBase || baseName);
            const parentName = stripLeadingDot(path.basename(path.dirname(root)));
            const parentSlug = parentName ? slugify(parentName) : "";
            return { root, name, baseSlug, parentSlug };
        });
        const slugCounts = new Map();
        for (const candidate of candidates) {
            slugCounts.set(candidate.baseSlug, (slugCounts.get(candidate.baseSlug) ?? 0) + 1);
        }
        const slugInstances = new Map();
        this.repoInfos = candidates.map((candidate) => {
            const needsParent = (slugCounts.get(candidate.baseSlug) ?? 0) > 1;
            const baseId = needsParent && candidate.parentSlug
                ? `${candidate.parentSlug}-${candidate.baseSlug}`
                : candidate.baseSlug;
            const seen = slugInstances.get(baseId) ?? 0;
            const id = seen === 0 ? baseId : `${baseId}-${seen}`;
            slugInstances.set(baseId, seen + 1);
            const repoExists = fs.existsSync(candidate.root);
            const defaultBranch = repoExists && this.isGitRepo(candidate.root)
                ? this.detectDefaultBranch(candidate.root)
                : "";
            return {
                id,
                name: candidate.name,
                root: candidate.root,
                exists: repoExists,
                default_branch: defaultBranch,
            };
        });
    }
    resolveRepoRoots() {
        if (this.repoRootsOverride) {
            return this.repoRootsOverride;
        }
        const config = readRepoConfig(this.configPath);
        if (config.exists) {
            return normalizeRoots(config.repos);
        }
        return normalizeRoots(discoverRepos(this.defaultRepoRoot));
    }
    isGitRepo(repoRoot) {
        const output = runGit(["rev-parse", "--show-toplevel"], {
            cwd: repoRoot,
            allow_failure: true,
        });
        if (!output) {
            return false;
        }
        try {
            const resolvedRepo = fs.realpathSync(repoRoot);
            const resolvedOutput = fs.realpathSync(output);
            return resolvedOutput === resolvedRepo;
        }
        catch (_error) {
            return false;
        }
    }
    scanRepo(repoRoot, repoId) {
        const worktrees = this.listWorktrees(repoRoot);
        const worktreeByBranch = new Map();
        let currentBranch = null;
        for (const worktree of worktrees) {
            if (worktree.branch) {
                worktreeByBranch.set(worktree.branch, worktree.path);
            }
            if (path.resolve(worktree.path) === path.resolve(repoRoot) && worktree.branch) {
                currentBranch = worktree.branch;
            }
        }
        const branches = this.listBranches(repoRoot);
        const defaultBranch = this.detectDefaultBranch(repoRoot);
        const now = new Date().toISOString();
        let updated = 0;
        for (const branch of branches) {
            const worktreePath = worktreeByBranch.get(branch) ?? null;
            const isWorktree = worktreePath !== null;
            const isCurrent = currentBranch === branch;
            const status = worktreePath
                ? this.getWorktreeStatus(worktreePath)
                : { is_dirty: false, diff_stat: null };
            const lastCommit = this.getLastCommit(repoRoot, branch);
            const aheadBehind = this.getAheadBehind(repoRoot, branch);
            const aheadBehindDefault = this.getAheadBehindDefault(repoRoot, branch, defaultBranch);
            const row = {
                repo_root: repoRoot,
                branch,
                is_current: toDbBool(isCurrent),
                is_worktree: toDbBool(isWorktree),
                worktree_path: worktreePath,
                is_dirty: toDbBool(status.is_dirty),
                ahead: aheadBehind.ahead,
                behind: aheadBehind.behind,
                ahead_default: aheadBehindDefault.ahead_default,
                behind_default: aheadBehindDefault.behind_default,
                default_branch: aheadBehindDefault.default_branch,
                last_commit_hash: lastCommit?.hash ?? null,
                last_commit_message: lastCommit?.message ?? null,
                last_commit_author: lastCommit?.author ?? null,
                last_commit_date: lastCommit?.date ?? null,
                diff_stat: status.diff_stat,
                updated_at: now,
            };
            const existing = this.db
                .prepare(`
          SELECT
            repo_root,
            branch,
            is_current,
            is_worktree,
            worktree_path,
            is_dirty,
            ahead,
            behind,
            ahead_default,
            behind_default,
            default_branch,
            last_commit_hash,
            last_commit_message,
            last_commit_author,
            last_commit_date,
            diff_stat
          FROM branches
          WHERE repo_root = ? AND branch = ?
          `)
                .get(repoRoot, branch);
            const changed = !existing || rowChanged(existing, row);
            this.db
                .prepare(`
          INSERT INTO branches (
            repo_root,
            branch,
            is_current,
            is_worktree,
            worktree_path,
            is_dirty,
            ahead,
            behind,
            ahead_default,
            behind_default,
            default_branch,
            last_commit_hash,
            last_commit_message,
            last_commit_author,
            last_commit_date,
            diff_stat,
            updated_at
          ) VALUES (
            @repo_root,
            @branch,
            @is_current,
            @is_worktree,
            @worktree_path,
            @is_dirty,
            @ahead,
            @behind,
            @ahead_default,
            @behind_default,
            @default_branch,
            @last_commit_hash,
            @last_commit_message,
            @last_commit_author,
            @last_commit_date,
            @diff_stat,
            @updated_at
          )
          ON CONFLICT(repo_root, branch) DO UPDATE SET
            is_current = excluded.is_current,
            is_worktree = excluded.is_worktree,
            worktree_path = excluded.worktree_path,
            is_dirty = excluded.is_dirty,
            ahead = excluded.ahead,
            behind = excluded.behind,
            ahead_default = excluded.ahead_default,
            behind_default = excluded.behind_default,
            default_branch = excluded.default_branch,
            last_commit_hash = excluded.last_commit_hash,
            last_commit_message = excluded.last_commit_message,
            last_commit_author = excluded.last_commit_author,
            last_commit_date = excluded.last_commit_date,
            diff_stat = excluded.diff_stat,
            updated_at = excluded.updated_at
          `)
                .run(row);
            if (changed) {
                updated += 1;
                const branchData = {
                    repo_root: repoRoot,
                    branch,
                    is_current: isCurrent,
                    is_worktree: isWorktree,
                    worktree_path: worktreePath,
                    is_dirty: status.is_dirty,
                    ahead: aheadBehind.ahead,
                    behind: aheadBehind.behind,
                    has_upstream: aheadBehind.has_upstream,
                    upstream: aheadBehind.upstream,
                    ahead_default: aheadBehindDefault.ahead_default,
                    behind_default: aheadBehindDefault.behind_default,
                    default_branch: aheadBehindDefault.default_branch,
                    last_commit: lastCommit,
                    last_commit_date: lastCommit?.date ?? null,
                    diff_stat: status.diff_stat,
                };
                this.emit({
                    event: "work:branch:updated",
                    type: "work:branch:updated",
                    data: { ...branchData, repo_id: repoId },
                });
            }
        }
        let removed = 0;
        if (branches.length === 0) {
            const info = this.db
                .prepare("SELECT COUNT(*) as count FROM branches WHERE repo_root = ?")
                .get(repoRoot);
            removed = info?.count ? Number(info.count) : 0;
            this.db.prepare("DELETE FROM branches WHERE repo_root = ?").run(repoRoot);
        }
        else {
            const placeholders = branches.map(() => "?").join(",");
            const deleteSql = `DELETE FROM branches WHERE repo_root = ? AND branch NOT IN (${placeholders})`;
            const stmt = this.db.prepare(deleteSql);
            const result = stmt.run(repoRoot, ...branches);
            removed = Number(result.changes);
        }
        return { updated, removed };
    }
    listBranches(repoRoot) {
        const output = runGit(["branch", "-a", "--format=%(refname:short)"], {
            cwd: repoRoot,
            allow_failure: true,
        });
        if (!output) {
            return [];
        }
        return output
            .split("\n")
            .map((line) => line.trim())
            .filter((line) => line.length > 0)
            .filter((line) => !line.startsWith("remotes/"));
    }
    listWorktrees(repoRoot) {
        const output = runGit(["worktree", "list", "--porcelain"], {
            cwd: repoRoot,
            allow_failure: true,
        });
        if (!output) {
            return [];
        }
        return parseWorktreeList(output);
    }
    getWorktreeStatus(worktreePath) {
        const output = runGit(["status", "--porcelain"], {
            cwd: worktreePath,
            allow_failure: true,
        });
        if (output === null) {
            return { is_dirty: false, diff_stat: null };
        }
        const isDirty = output.trim().length > 0;
        if (!isDirty) {
            return { is_dirty: false, diff_stat: null };
        }
        const diffStat = runGit(["diff", "--stat"], {
            cwd: worktreePath,
            allow_failure: true,
        });
        return {
            is_dirty: true,
            diff_stat: diffStat ? diffStat.trim() : null,
        };
    }
    getLastCommit(repoRoot, branch) {
        const output = runGit(["log", "-1", "--format=%H%x1f%s%x1f%an%x1f%aI", branch], { cwd: repoRoot, allow_failure: true });
        return parseLastCommit(output);
    }
    getUpstreamInfo(repoRoot, branch) {
        const upstream = runGit(["rev-parse", "--abbrev-ref", `${branch}@{upstream}`], {
            cwd: repoRoot,
            allow_failure: true,
        });
        if (!upstream) {
            return { has_upstream: false, upstream: null };
        }
        return { has_upstream: true, upstream };
    }
    detectDefaultBranch(repoRoot) {
        const candidates = ["main", "develop"];
        for (const candidate of candidates) {
            const result = runGit(["rev-parse", "--verify", candidate], {
                cwd: repoRoot,
                allow_failure: true,
            });
            if (result !== null) {
                return candidate;
            }
        }
        return "";
    }
    getAheadBehindDefault(repoRoot, branch, defaultBranch) {
        if (!defaultBranch || branch === defaultBranch) {
            return { ahead_default: 0, behind_default: 0, default_branch: defaultBranch || "\u2014" };
        }
        const output = runGit(["rev-list", "--left-right", "--count", `${defaultBranch}...${branch}`], { cwd: repoRoot, allow_failure: true });
        if (!output) {
            return { ahead_default: 0, behind_default: 0, default_branch: "\u2014" };
        }
        const [behindRaw, aheadRaw] = output.trim().split(/\s+/);
        const behind = Number.parseInt(behindRaw ?? "0", 10);
        const ahead = Number.parseInt(aheadRaw ?? "0", 10);
        return {
            ahead_default: Number.isNaN(ahead) ? 0 : ahead,
            behind_default: Number.isNaN(behind) ? 0 : behind,
            default_branch: defaultBranch,
        };
    }
    getAheadBehind(repoRoot, branch) {
        const upstreamInfo = this.getUpstreamInfo(repoRoot, branch);
        if (!upstreamInfo.has_upstream || !upstreamInfo.upstream) {
            return { ahead: 0, behind: 0, has_upstream: false, upstream: null };
        }
        const output = runGit(["rev-list", "--left-right", "--count", `${upstreamInfo.upstream}...${branch}`], {
            cwd: repoRoot,
            allow_failure: true,
        });
        if (!output) {
            return { ahead: 0, behind: 0, ...upstreamInfo };
        }
        const [behindRaw, aheadRaw] = output.trim().split(/\s+/);
        const behind = Number.parseInt(behindRaw ?? "0", 10);
        const ahead = Number.parseInt(aheadRaw ?? "0", 10);
        return {
            ahead: Number.isNaN(ahead) ? 0 : ahead,
            behind: Number.isNaN(behind) ? 0 : behind,
            ...upstreamInfo,
        };
    }
}
