import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { getDb } from "./db.js";
import { broadcast, type SseEvent } from "./sse.js";

export interface LastCommit {
  hash: string;
  message: string;
  author: string;
  date: string;
}

export interface BranchData {
  repo_root: string;
  repo_id?: string;
  branch: string;
  is_current: boolean;
  is_worktree: boolean;
  worktree_path: string | null;
  is_dirty: boolean;
  ahead: number;
  behind: number;
  has_upstream: boolean;
  upstream?: string | null;
  ahead_default: number;
  behind_default: number;
  default_branch: string;
  last_commit: LastCommit | null;
  last_commit_date?: string | null;
  diff_stat: string | null;
}

export interface RepoInfo {
  id: string;
  name: string;
  root: string;
  exists: boolean;
  default_branch: string;
}

export interface ScanSummary {
  scanned_repos: number;
  branches_updated: number;
  branches_removed: number;
  missing_repos: string[];
  duration_ms: number;
}

export interface WorkScannerOptions {
  db?: SqliteDatabase;
  repo_roots?: string[];
  default_repo_root?: string;
  config_path?: string;
  on_event?: (event: SseEvent) => void;
}

export interface SqliteStatement {
  run(...args: unknown[]): { changes?: number };
  get(...args: unknown[]): unknown;
  all(...args: unknown[]): unknown[];
}

export interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
}

interface WorktreeInfo {
  path: string;
  branch: string | null;
}

const DEFAULT_REPO_ROOT = path.join(os.homedir(), ".dotfiles");
const DEFAULT_CONFIG_PATH = path.join(
  os.homedir(),
  ".config",
  "mandible",
  "repos.json",
);

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

function resolveHome(input: string): string {
  if (input.startsWith("~")) {
    return path.join(os.homedir(), input.slice(1));
  }
  return input;
}

function readRepoConfig(configPath: string): { repos: string[]; exists: boolean } {
  try {
    const raw = fs.readFileSync(configPath, "utf8");
    const parsed = JSON.parse(raw) as { repos?: string[] };
    if (!parsed.repos) {
      return { repos: [], exists: true };
    }
    return {
      repos: parsed.repos.filter((repo) => typeof repo === "string"),
      exists: true,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { repos: [], exists: false };
    }
    throw error;
  }
}

function normalizeRoots(roots: string[]): string[] {
  const unique = new Set<string>();
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
function isGitDirectory(candidate: string): boolean {
  const gitPath = path.join(candidate, ".git");
  try {
    return fs.statSync(gitPath).isDirectory();
  } catch {
    return false;
  }
}

function scanDirForRepos(dir: string, depth: number, roots: string[]): void {
  if (!fs.existsSync(dir)) {
    return;
  }
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const candidate = path.join(dir, entry.name);
    if (isGitDirectory(candidate)) {
      roots.push(candidate);
    } else if (depth > 1) {
      scanDirForRepos(candidate, depth - 1, roots);
    }
  }
}

function discoverRepos(defaultRepoRoot?: string): string[] {
  const roots: string[] = [];
  const dotfiles = path.join(os.homedir(), ".dotfiles");
  if (isGitDirectory(dotfiles)) {
    roots.push(dotfiles);
  }
  if (defaultRepoRoot) {
    const resolvedDefault = path.resolve(defaultRepoRoot);
    if (
      resolvedDefault !== path.resolve(dotfiles) &&
      isGitDirectory(resolvedDefault)
    ) {
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

function stripLeadingDot(value: string): string {
  return value.replace(/^\.+/, "");
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "repo";
}

function runGit(
  args: string[],
  options: { cwd: string; allow_failure?: boolean } = { cwd: process.cwd() },
): string | null {
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

function parseWorktreeList(output: string): WorktreeInfo[] {
  const worktrees: WorktreeInfo[] = [];
  const lines = output.split("\n");
  let current: Partial<WorktreeInfo> = {};

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
    } else if (key === "branch") {
      const normalized = value.startsWith("refs/heads/")
        ? value.slice("refs/heads/".length)
        : value;
      current.branch = normalized;
    }
  }
  flush();
  return worktrees;
}

function parseLastCommit(output: string | null): LastCommit | null {
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

function ensureSchema(db: SqliteDatabase): void {
  db.exec(BRANCH_TABLE_SCHEMA);
}

function toDbBool(value: boolean): number {
  return value ? 1 : 0;
}

function fromDbBool(value: number): boolean {
  return value === 1;
}

function compareValue(a: unknown, b: unknown): boolean {
  return a === b;
}

function rowChanged(existing: Record<string, unknown>, next: Record<string, unknown>): boolean {
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
  private readonly db: SqliteDatabase;
  private readonly defaultRepoRoot: string;
  private readonly configPath: string;
  private readonly repoRootsOverride: string[] | null;
  private readonly emit: (event: SseEvent) => void;
  private repoInfos: RepoInfo[] = [];

  constructor(options: WorkScannerOptions = {}) {
    this.db = options.db ?? getDb();
    this.defaultRepoRoot = path.resolve(
      resolveHome(options.default_repo_root ?? DEFAULT_REPO_ROOT),
    );
    this.configPath = path.resolve(resolveHome(options.config_path ?? DEFAULT_CONFIG_PATH));
    this.repoRootsOverride = options.repo_roots
      ? normalizeRoots(options.repo_roots)
      : null;
    this.emit = options.on_event ?? ((event) => broadcast(event));
    ensureSchema(this.db);
  }

  getRepos(): RepoInfo[] {
    if (this.repoInfos.length === 0) {
      this.refreshRepoInfos();
    }
    return this.repoInfos;
  }

  hasCachedData(): boolean {
    const row = this.db.prepare("SELECT 1 FROM branches LIMIT 1").get();
    return Boolean(row);
  }

  getRepoById(id: string): RepoInfo | undefined {
    return this.getRepos().find((repo) => repo.id === id);
  }

  getBranches(repoRoot: string): BranchData[] {
    const rows = this.db
      .prepare(
        `
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
        `,
      )
      .all(repoRoot) as Array<Record<string, unknown>>;

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

  getBranch(repoRoot: string, branch: string): BranchData | null {
    const rows = this.getBranches(repoRoot);
    return rows.find((row) => row.branch === branch) ?? null;
  }

  getWorktrees(repoRoot: string): Array<{ branch: string; path: string; is_current: boolean }> {
    const branches = this.getBranches(repoRoot);
    return branches
      .filter((branch) => branch.is_worktree && branch.worktree_path)
      .map((branch) => ({
        branch: branch.branch,
        path: branch.worktree_path as string,
        is_current: branch.is_current,
      }));
  }

  // Bug: d6f79a2 — async scanAll yields the event loop between repos so the HTTP
  // server stays responsive while the branch scan runs. spawnSync calls inside
  // scanRepo block the thread; without yielding, a full scan (85+ branches) can
  // hold the event loop for 3-5s, causing issue detail fetches to hang.
  async scanAll(): Promise<ScanSummary> {
    const start = Date.now();
    this.refreshRepoInfos();

    this.emit({
      event: "work:scan:started",
      type: "work:scan:started",
      data: { started_at: new Date(start).toISOString() },
    });

    let branchesUpdated = 0;
    let branchesRemoved = 0;
    const missingRepos: string[] = [];
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
      } catch (_error) {
        // Log but continue scanning remaining repos
        console.error(`[work-scanner] scanRepo failed for ${repo.root}: ${_error}`);
      }
      // Yield the event loop between repos so HTTP requests are not starved
      // while a large repo (many branches) is being scanned.
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    const durationMs = Date.now() - start;
    const summary: ScanSummary = {
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

  private refreshRepoInfos(): void {
    const roots = this.resolveRepoRoots();
    const sortedRoots = [...roots].sort((a, b) =>
      path.normalize(a).localeCompare(path.normalize(b)),
    );
    const candidates = sortedRoots.map((root) => {
      const baseName = path.basename(root);
      const nameBase = stripLeadingDot(baseName) || baseName;
      const name = nameBase || baseName || "repo";
      const baseSlug = slugify(nameBase || baseName);
      const parentName = stripLeadingDot(path.basename(path.dirname(root)));
      const parentSlug = parentName ? slugify(parentName) : "";
      return { root, name, baseSlug, parentSlug };
    });

    const slugCounts = new Map<string, number>();
    for (const candidate of candidates) {
      slugCounts.set(
        candidate.baseSlug,
        (slugCounts.get(candidate.baseSlug) ?? 0) + 1,
      );
    }

    const slugInstances = new Map<string, number>();
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

  private resolveRepoRoots(): string[] {
    if (this.repoRootsOverride) {
      return this.repoRootsOverride;
    }
    const config = readRepoConfig(this.configPath);
    if (config.exists) {
      return normalizeRoots(config.repos);
    }
    return normalizeRoots(discoverRepos(this.defaultRepoRoot));
  }

  private isGitRepo(repoRoot: string): boolean {
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
    } catch (_error) {
      return false;
    }
  }

  private scanRepo(repoRoot: string, repoId: string): { updated: number; removed: number } {
    const worktrees = this.listWorktrees(repoRoot);
    const worktreeByBranch = new Map<string, string>();
    let currentBranch: string | null = null;

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
        .prepare(
          `
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
          `,
        )
        .get(repoRoot, branch) as Record<string, unknown> | undefined;

      const changed = !existing || rowChanged(existing, row);
      this.db
        .prepare(
          `
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
          `,
        )
        .run(row);

      if (changed) {
        updated += 1;
        const branchData: BranchData = {
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
        .get(repoRoot) as { count?: number };
      removed = info?.count ? Number(info.count) : 0;
      this.db.prepare("DELETE FROM branches WHERE repo_root = ?").run(repoRoot);
    } else {
      const placeholders = branches.map(() => "?").join(",");
      const deleteSql = `DELETE FROM branches WHERE repo_root = ? AND branch NOT IN (${placeholders})`;
      const stmt = this.db.prepare(deleteSql);
      const result = stmt.run(repoRoot, ...branches);
      removed = Number(result.changes);
    }

    return { updated, removed };
  }

  private listBranches(repoRoot: string): string[] {
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

  private listWorktrees(repoRoot: string): WorktreeInfo[] {
    const output = runGit(["worktree", "list", "--porcelain"], {
      cwd: repoRoot,
      allow_failure: true,
    });
    if (!output) {
      return [];
    }
    return parseWorktreeList(output);
  }

  private getWorktreeStatus(
    worktreePath: string,
  ): { is_dirty: boolean; diff_stat: string | null } {
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

  private getLastCommit(repoRoot: string, branch: string): LastCommit | null {
    const output = runGit(
      ["log", "-1", "--format=%H%x1f%s%x1f%an%x1f%aI", branch],
      { cwd: repoRoot, allow_failure: true },
    );
    return parseLastCommit(output);
  }

  private getUpstreamInfo(
    repoRoot: string,
    branch: string,
  ): { has_upstream: boolean; upstream: string | null } {
    const upstream = runGit(["rev-parse", "--abbrev-ref", `${branch}@{upstream}`], {
      cwd: repoRoot,
      allow_failure: true,
    });
    if (!upstream) {
      return { has_upstream: false, upstream: null };
    }
    return { has_upstream: true, upstream };
  }

  private detectDefaultBranch(repoRoot: string): string {
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

  private getAheadBehindDefault(
    repoRoot: string,
    branch: string,
    defaultBranch: string,
  ): { ahead_default: number; behind_default: number; default_branch: string } {
    if (!defaultBranch || branch === defaultBranch) {
      return { ahead_default: 0, behind_default: 0, default_branch: defaultBranch || "\u2014" };
    }
    const output = runGit(
      ["rev-list", "--left-right", "--count", `${defaultBranch}...${branch}`],
      { cwd: repoRoot, allow_failure: true },
    );
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

  private getAheadBehind(
    repoRoot: string,
    branch: string,
  ): { ahead: number; behind: number; has_upstream: boolean; upstream: string | null } {
    const upstreamInfo = this.getUpstreamInfo(repoRoot, branch);
    if (!upstreamInfo.has_upstream || !upstreamInfo.upstream) {
      return { ahead: 0, behind: 0, has_upstream: false, upstream: null };
    }
    const output = runGit(
      ["rev-list", "--left-right", "--count", `${upstreamInfo.upstream}...${branch}`],
      {
      cwd: repoRoot,
      allow_failure: true,
      },
    );
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
