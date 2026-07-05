import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { parse as parseToml } from "smol-toml";
import { getDaemonLogger } from "./daemon-log.js";
import { getDb } from "./db.js";
import { ensureMandibleConfigFile } from "./platform-paths.js";
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
  excluded: boolean;
  user_modified: boolean;
  last_scanned_at: string | null;
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

const workScannerLog = getDaemonLogger();

interface WorktreeInfo {
  path: string;
  branch: string | null;
}

const DEFAULT_REPO_ROOT = path.join(os.homedir(), ".dotfiles");

// Issue 70cf59d — ephemeral sandbox/container mount prefixes.
//
// A Mandible daemon running INSIDE a sandboxed session (Cowork/Codex container)
// sees the host's repositories through a per-session bind mount such as
// `/sessions/<session-id>/mnt/...`. If discovery scans those mounted roots and
// the legacy git-bug sync then resolves them, it mints duplicate `local:`
// projects for repos that already exist canonically on the host (this is what
// produced the feedbax-2/-3/-4, humbleb-2 and dotfiles-2 duplicates).
//
// These patterns are DELIBERATELY narrow: they match only the known sandbox
// session-mount shape, never a user's real `~/...` checkout. A path is excluded
// from WorkScanner discovery AND from sync root selection if it lives under one
// of these prefixes. Keep this list conservative — broadening it risks hiding a
// legitimate repository.
const EPHEMERAL_MOUNT_PATTERNS: RegExp[] = [
  // Cowork/Codex per-session bind mount: /sessions/<session-id>/mnt[/...]
  /^\/sessions\/[^/]+\/mnt(?:\/|$)/,
  // Generic container session-mount root occasionally used for the same purpose.
  /^\/mnt\/sessions\/[^/]+(?:\/|$)/,
];

/**
 * True when `root` lives under an ephemeral sandbox/container session mount.
 * Such roots are host repositories seen through a session bind mount and must
 * not be discovered or synced (see issue 70cf59d). Exported for reuse by the
 * git-bug sync runner's root-selection guard.
 */
export function isEphemeralMountPath(root: string): boolean {
  if (!root) return false;
  const resolved = path.resolve(root);
  return EPHEMERAL_MOUNT_PATTERNS.some((pattern) => pattern.test(resolved));
}

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

// Bug: 7ed20d0 — read repos.toml to discover repos nested deeper than depth-2
// (e.g. ~/Main/10 Projects/10 PhD/20 Feedbax/feedbax) that the directory scan misses.
function readReposToml(monorepoRoot: string): string[] {
  const tomlPath = path.join(monorepoRoot, ".projects", "repos.toml");
  try {
    const content = fs.readFileSync(tomlPath, "utf8");
    const parsed = parseToml(content);
    const repos = (parsed["repos"] ?? {}) as Record<string, unknown>;
    const roots: string[] = [];
    for (const [, entry] of Object.entries(repos)) {
      if (!entry || typeof entry !== "object") continue;
      const repoPath = (entry as Record<string, unknown>)["path"];
      if (typeof repoPath !== "string") continue;
      const resolved = path.resolve(monorepoRoot, repoPath);
      if (isGitDirectory(resolved)) {
        roots.push(resolved);
      }
    }
    return roots;
  } catch (err) {
    workScannerLog("warn", "work_scanner_repos_toml_read_failed", {
      subsystem: "work-scanner",
      path: tomlPath,
      error: String(err),
    });
    return [];
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
  // Supplement depth-2 scan with repos registered in repos.toml, which captures
  // repos nested deeper than 2 levels (e.g. ~/Main/10 Projects/10 PhD/20 Feedbax/feedbax).
  const mainDir = path.join(os.homedir(), "Main");
  if (fs.existsSync(mainDir)) {
    const tomlRepos = readReposToml(mainDir);
    for (const r of tomlRepos) {
      if (!roots.includes(r)) roots.push(r);
    }
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

/**
 * Compute a unique slug-based ID for a repo root, deduplicating against existingIds.
 * Exported for reuse by API routes.
 */
export function computeRepoId(root: string, existingIds: string[]): string {
  const existingSet = new Set(existingIds);
  const baseName = path.basename(root);
  const nameBase = stripLeadingDot(baseName) || baseName;
  const baseSlug = slugify(nameBase || baseName);
  const parentName = stripLeadingDot(path.basename(path.dirname(root)));
  const parentSlug = parentName ? slugify(parentName) : "";

  // Check if a conflict exists (another repo with same baseSlug in existingIds)
  const needsParent = existingSet.has(baseSlug) || parentSlug;
  const baseId = needsParent && parentSlug
    ? `${parentSlug}-${baseSlug}`
    : baseSlug;

  if (!existingSet.has(baseId)) {
    return baseId;
  }
  // Dedup with numeric suffix
  let i = 1;
  while (existingSet.has(`${baseId}-${i}`)) {
    i += 1;
  }
  return `${baseId}-${i}`;
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
    this.configPath = path.resolve(
      resolveHome(options.config_path ?? ensureMandibleConfigFile("repos.json")),
    );
    this.repoRootsOverride = options.repo_roots
      ? normalizeRoots(options.repo_roots)
      : null;
    this.emit = options.on_event ?? ((event) => broadcast(event));
  }

  getRepos(): RepoInfo[] {
    if (this.repoInfos.length > 0) {
      return this.repoInfos;
    }
    // Phase 2: try DB cold-start
    const dbRows = this.db.prepare(
      "SELECT id, root, name, default_branch, dir_exists, excluded, user_modified, last_scanned_at FROM work_repos WHERE dir_exists = 1"
    ).all() as Array<{
      id: string; root: string; name: string; default_branch: string;
      dir_exists: number; excluded: number; user_modified: number; last_scanned_at: string | null;
    }>;
    if (dbRows.length > 0) {
      this.repoInfos = dbRows.map((row) => ({
        id: row.id,
        name: row.name,
        root: row.root,
        exists: row.dir_exists === 1,
        default_branch: row.default_branch,
        excluded: row.excluded === 1,
        user_modified: row.user_modified === 1,
        last_scanned_at: row.last_scanned_at,
      }));
      return this.repoInfos;
    }
    // Phase 3: full discovery
    this.refreshRepoInfos();
    return this.repoInfos;
  }

  hasCachedData(): boolean {
    const row = this.db.prepare("SELECT 1 FROM branches LIMIT 1").get();
    return Boolean(row);
  }

  getRepoById(idOrPath: string): RepoInfo | undefined {
    const resolvedPath = path.resolve(resolveHome(idOrPath));
    const found = this.repoInfos.find(
      (repo) =>
        repo.id === idOrPath ||
        repo.root === idOrPath ||
        path.resolve(repo.root) === resolvedPath,
    );
    if (found) return found;
    // DB fallback when repoInfos is not yet populated
    if (this.repoInfos.length === 0) {
      const row = this.db.prepare(
        "SELECT id, root, name, default_branch, dir_exists, excluded, user_modified, last_scanned_at FROM work_repos WHERE id = ? OR root = ? LIMIT 1"
      ).get(idOrPath, resolvedPath) as {
        id: string; root: string; name: string; default_branch: string;
        dir_exists: number; excluded: number; user_modified: number; last_scanned_at: string | null;
      } | undefined;
      if (row) {
        return {
          id: row.id,
          name: row.name,
          root: row.root,
          exists: row.dir_exists === 1,
          default_branch: row.default_branch,
          excluded: row.excluded === 1,
          user_modified: row.user_modified === 1,
          last_scanned_at: row.last_scanned_at,
        };
      }
    }
    return undefined;
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
  scanAll(): ScanSummary {
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
      if (repo.excluded) {
        // Skip scanning excluded repos but still track them in missingRepos check above
        continue;
      }
      scannedRepos += 1;
      try {
        const scanResult = this.scanRepo(repo.root, repo.id);
        branchesUpdated += scanResult.updated;
        branchesRemoved += scanResult.removed;
        // Update last_scanned_at after successful scan
        const scanNow = new Date().toISOString();
        this.db.prepare(
          "UPDATE work_repos SET last_scanned_at = ?, updated_at = ? WHERE root = ?"
        ).run(scanNow, scanNow, repo.root);
        // Sync in-memory
        const idx = this.repoInfos.findIndex((r) => r.root === repo.root);
        if (idx >= 0) {
          this.repoInfos[idx] = { ...this.repoInfos[idx], last_scanned_at: scanNow };
        }
      } catch (_error) {
        // Log but continue scanning remaining repos
        workScannerLog("error", "work_scanner_repo_scan_failed", {
          subsystem: "work-scanner",
          repo_id: repo.id,
          path: repo.root,
          error: String(_error),
        });
      }
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

  async scanAllAsync(): Promise<ScanSummary> {
    return this.scanAll();
  }

  updateRepo(id: string, patch: { name?: string; excluded?: boolean }): RepoInfo | null {
    const row = this.db.prepare(
      "SELECT id, root, name, default_branch, dir_exists, excluded, user_modified, last_scanned_at FROM work_repos WHERE id = ?"
    ).get(id) as {
      id: string; root: string; name: string; default_branch: string;
      dir_exists: number; excluded: number; user_modified: number; last_scanned_at: string | null;
    } | undefined;
    if (!row) return null;

    const now = new Date().toISOString();
    let newName = row.name;
    let userModified = row.user_modified;

    if (patch.name !== undefined) {
      if (patch.name.trim() === '') {
        // Reset to derived name
        const baseName = path.basename(row.root);
        newName = stripLeadingDot(baseName) || baseName;
        userModified = 0;
      } else {
        newName = patch.name.trim();
        userModified = 1;
      }
    }

    const newExcluded = patch.excluded !== undefined ? (patch.excluded ? 1 : 0) : row.excluded;

    this.db.prepare(
      "UPDATE work_repos SET name = ?, excluded = ?, user_modified = ?, updated_at = ? WHERE id = ?"
    ).run(newName, newExcluded, userModified, now, id);

    // Sync in-memory
    const idx = this.repoInfos.findIndex((r) => r.id === id);
    const updated: RepoInfo = {
      id: row.id,
      name: newName,
      root: row.root,
      exists: row.dir_exists === 1,
      default_branch: row.default_branch,
      excluded: newExcluded === 1,
      user_modified: userModified === 1,
      last_scanned_at: row.last_scanned_at,
    };
    if (idx >= 0) {
      this.repoInfos[idx] = updated;
    }
    return updated;
  }

  async addRepo(root: string, options?: { name?: string }): Promise<RepoInfo | null> {
    const resolved = path.resolve(resolveHome(root));
    if (!this.isGitDirectory(resolved)) {
      throw new Error(`Not a git directory: ${resolved}`);
    }
    // Check not already tracked
    const existing = this.db.prepare(
      "SELECT id FROM work_repos WHERE root = ?"
    ).get(resolved) as { id: string } | undefined;
    if (existing) return null;

    // Compute ID
    const existingIds = (this.db.prepare("SELECT id FROM work_repos").all() as Array<{ id: string }>)
      .map((r) => r.id);
    const newId = computeRepoId(resolved, existingIds);

    const baseName = path.basename(resolved);
    const derivedName = stripLeadingDot(baseName) || baseName;
    const name = options?.name?.trim() || derivedName;
    const userModified = options?.name?.trim() ? 1 : 0;
    const defaultBranch = this.isGitRepo(resolved) ? this.detectDefaultBranch(resolved) : "";
    const now = new Date().toISOString();

    this.db.prepare(`
      INSERT INTO work_repos (id, root, name, default_branch, dir_exists, excluded, user_modified, created_at, updated_at)
      VALUES (?, ?, ?, ?, 1, 0, ?, ?, ?)
    `).run(newId, resolved, name, defaultBranch, userModified, now, now);

    // Write to repos.json
    try {
      let config: { repos: string[] } = { repos: [] };
      try {
        const raw = fs.readFileSync(this.configPath, "utf8");
        config = JSON.parse(raw) as { repos: string[] };
        if (!Array.isArray(config.repos)) config.repos = [];
      } catch {
        // File missing or invalid — start fresh with all current roots + new one
        const allRows = this.db.prepare("SELECT root FROM work_repos WHERE dir_exists = 1").all() as Array<{ root: string }>;
        config.repos = allRows.map((r) => r.root);
      }
      if (!config.repos.includes(resolved)) {
        config.repos.push(resolved);
      }
      const dir = path.dirname(this.configPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.configPath, JSON.stringify(config, null, 2), "utf8");
    } catch (err) {
      workScannerLog("error", "work_scanner_repo_config_write_failed", {
        subsystem: "work-scanner",
        path: this.configPath,
        error: String(err),
      });
    }

    const newRepo: RepoInfo = {
      id: newId,
      name,
      root: resolved,
      exists: true,
      default_branch: defaultBranch,
      excluded: false,
      user_modified: userModified === 1,
      last_scanned_at: null,
    };
    this.repoInfos.push(newRepo);

    // Fire-and-forget scan
    void (async () => {
      try {
        this.scanRepo(resolved, newId);
        const scanNow = new Date().toISOString();
        this.db.prepare(
          "UPDATE work_repos SET last_scanned_at = ?, updated_at = ? WHERE root = ?"
        ).run(scanNow, scanNow, resolved);
        const idx = this.repoInfos.findIndex((r) => r.root === resolved);
        if (idx >= 0) {
          this.repoInfos[idx] = { ...this.repoInfos[idx], last_scanned_at: scanNow };
        }
      } catch (err) {
        workScannerLog("error", "work_scanner_add_repo_background_scan_failed", {
          subsystem: "work-scanner",
          repo_id: newId,
          path: resolved,
          error: String(err),
        });
      }
    })();

    return newRepo;
  }

  removeRepo(id: string): boolean {
    const row = this.db.prepare(
      "SELECT root FROM work_repos WHERE id = ?"
    ).get(id) as { root: string } | undefined;
    if (!row) return false;

    const { root } = row;
    this.db.prepare("DELETE FROM work_repos WHERE id = ?").run(id);
    this.db.prepare("DELETE FROM branches WHERE repo_root = ?").run(root);

    // Remove from repos.json
    try {
      const raw = fs.readFileSync(this.configPath, "utf8");
      const config = JSON.parse(raw) as { repos: string[] };
      if (Array.isArray(config.repos)) {
        config.repos = config.repos.filter((r) => path.resolve(resolveHome(r)) !== root);
        fs.writeFileSync(this.configPath, JSON.stringify(config, null, 2), "utf8");
      }
    } catch {
      // If file doesn't exist or parse error, ignore
    }

    this.repoInfos = this.repoInfos.filter((r) => r.id !== id);
    return true;
  }

  private isGitDirectory(candidate: string): boolean {
    return isGitDirectory(candidate);
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
        excluded: false,
        user_modified: false,
        last_scanned_at: null,
      };
    });

    // Upsert each repo into work_repos table
    const now = new Date().toISOString();
    const upsertStmt = this.db.prepare(`
      INSERT INTO work_repos (id, root, name, default_branch, dir_exists, updated_at)
      VALUES (@id, @root, @name, @default_branch, @exists, @now)
      ON CONFLICT(root) DO UPDATE SET
        default_branch = excluded.default_branch,
        dir_exists     = excluded.dir_exists,
        updated_at     = excluded.updated_at,
        name = CASE WHEN user_modified = 0 THEN excluded.name ELSE name END
    `);
    for (const repo of this.repoInfos) {
      upsertStmt.run({
        id: repo.id,
        root: repo.root,
        name: repo.name,
        default_branch: repo.default_branch,
        exists: repo.exists ? 1 : 0,
        now,
      });
    }

    // Mark repos not in current candidate list as non-existent
    if (sortedRoots.length > 0) {
      const placeholders = sortedRoots.map(() => "?").join(",");
      this.db.prepare(
        `UPDATE work_repos SET dir_exists = 0, updated_at = ? WHERE root NOT IN (${placeholders})`
      ).run(now, ...sortedRoots);
    } else {
      this.db.prepare(
        "UPDATE work_repos SET dir_exists = 0, updated_at = ?"
      ).run(now);
    }

    // Reload excluded/user_modified/last_scanned_at from DB (preserved across refreshes)
    const dbRows = this.db.prepare(
      "SELECT root, excluded, user_modified, last_scanned_at FROM work_repos"
    ).all() as Array<{ root: string; excluded: number; user_modified: number; last_scanned_at: string | null }>;
    const dbByRoot = new Map(dbRows.map((r) => [r.root, r]));
    this.repoInfos = this.repoInfos.map((repo) => {
      const dbRow = dbByRoot.get(repo.root);
      if (!dbRow) return repo;
      return {
        ...repo,
        excluded: dbRow.excluded === 1,
        user_modified: dbRow.user_modified === 1,
        last_scanned_at: dbRow.last_scanned_at,
        name: dbRow.user_modified === 1
          ? (this.db.prepare("SELECT name FROM work_repos WHERE root = ?").get(repo.root) as { name: string } | undefined)?.name ?? repo.name
          : repo.name,
      };
    });
  }

  private resolveRepoRoots(): string[] {
    // Issue 70cf59d: drop ephemeral sandbox/container mount roots at the single
    // root-resolution chokepoint, so they are excluded whether they arrive via
    // an explicit override, the repos.json config, or filesystem discovery. A
    // mounted-session Mandible must not even consider host mount roots.
    return this.rawRepoRoots().filter((root) => !isEphemeralMountPath(root));
  }

  private rawRepoRoots(): string[] {
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
