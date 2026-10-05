import { DOMAIN_EVENTS } from "./contracts.js";
import { execFile, spawnSync } from "child_process";
import { randomUUID } from "node:crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { promisify } from "util";
import { parse as parseToml } from "smol-toml";
import { getDaemonLogger } from "./daemon-log.js";
import { getDb } from "./db.js";
import { ensureMandibleConfigFile } from "./platform-paths.js";
import { broadcast, type SseEvent } from "./sse.js";
import { canonicalizeCheckoutWorkRepoId } from "./ledger/projects.js";
import { isPreservedAppWorktreePath } from "./worktree-preservation.js";

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
  worktree_inventory_known?: boolean;
  worktree_status_known?: boolean;
  default_comparison_known?: boolean;
  last_commit: LastCommit | null;
  last_commit_date?: string | null;
  diff_stat: string | null;
  reaping?: ReapingSafety;
}

export interface ReapingSafety {
  candidate: boolean;
  clean: boolean;
  merged: boolean;
  protected: boolean;
  default_branch: boolean;
  current: boolean;
  app_managed: boolean;
  canonical_project: boolean;
  ambiguous: boolean;
  canonical_project_id: string | null;
  facts_known: boolean;
  blockers: string[];
}

export function deriveReapingSafety(
  branch: Pick<BranchData,
    "branch" | "repo_root" | "is_dirty" | "is_current" | "is_worktree" |
    "worktree_path" | "ahead_default" | "default_branch" |
    "worktree_inventory_known" | "worktree_status_known" | "default_comparison_known">,
  context: { protectedBranches?: Iterable<string>; projectIds?: string[] } = {},
): ReapingSafety {
  const protectedSet = new Set(context.protectedBranches ?? ["main", "develop"]);
  const projectIds = [...new Set(context.projectIds ?? [])];
  const inventoryKnown = branch.worktree_inventory_known === true;
  const statusKnown = branch.worktree_status_known === true;
  const defaultComparisonKnown = branch.default_comparison_known === true;
  const clean = statusKnown && !branch.is_dirty;
  const merged = defaultComparisonKnown && branch.ahead_default === 0;
  const isDefault = branch.branch === branch.default_branch;
  const isProtected = protectedSet.has(branch.branch);
  const appManaged = Boolean(branch.worktree_path && isPreservedAppWorktreePath(branch.worktree_path));
  const ambiguous = projectIds.length > 1;
  const canonicalProject = projectIds.length === 1;
  const blockers: string[] = [];
  if (!inventoryKnown) blockers.push("unknown_worktree_inventory");
  if (!statusKnown) blockers.push("unknown_worktree_status");
  if (!defaultComparisonKnown) blockers.push("unknown_default_comparison");
  if (!clean) blockers.push("dirty");
  if (!merged) blockers.push("unmerged");
  if (isProtected) blockers.push("protected");
  if (isDefault) blockers.push("default_branch");
  if (branch.is_current) blockers.push("current");
  if (appManaged) blockers.push("app_managed");
  if (!canonicalProject) blockers.push(ambiguous ? "ambiguous_project" : "missing_project");
  return {
    candidate: blockers.length === 0,
    clean,
    merged,
    protected: isProtected,
    default_branch: isDefault,
    current: branch.is_current,
    app_managed: appManaged,
    canonical_project: canonicalProject,
    ambiguous,
    canonical_project_id: canonicalProject ? projectIds[0] : null,
    facts_known: inventoryKnown && statusKnown && defaultComparisonKnown,
    blockers,
  };
}

export type WorkCommitClassification = "unique" | "pre-branch-point" | "merged-elsewhere";

export interface WorkCommit {
  hash: string;
  short_hash: string;
  message: string;
  author: string;
  date: string;
  parents: string[];
  classification: WorkCommitClassification;
  is_pre_branch_point: boolean;
  is_merged_elsewhere: boolean;
}

export interface WorkCommitPage {
  repo_root: string;
  branch: string;
  default_branch: string;
  merge_base: string | null;
  commits: WorkCommit[];
  total: number;
  limit: number;
  offset: number;
}

export type WorkCompareMode = "merge-base" | "range";

export interface WorkCompareResult {
  repo_root: string;
  from: string;
  to: string;
  mode: WorkCompareMode;
  range: string;
  raw: string;
  stat: string;
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

export type ScanSummary = import("./contracts.js").WorkScanSummary;

export interface WorkScannerOptions {
  db?: SqliteDatabase;
  repo_roots?: string[];
  default_repo_root?: string;
  config_path?: string;
  config_root?: string;
  on_event?: (event: SseEvent) => void;
  scan_skip_window_ms?: number;
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

export interface WorktreeInventory {
  worktrees: Array<{
    path: string;
    branch: string | null;
    is_current: boolean;
  }>;
  known: boolean;
}

const DEFAULT_REPO_ROOT = path.join(os.homedir(), ".dotfiles");
const DEFAULT_SCAN_SKIP_WINDOW_MS = 30_000;

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

// Issue 70cf59d — ephemeral sandbox/container mount prefixes.
//
// A Mandible daemon running INSIDE a sandboxed session (Cowork/Codex container)
// sees the host's repositories through a per-session bind mount such as
// `/sessions/<session-id>/mnt/...`. If discovery scans those mounted roots and
// the retired compatibility sync then resolves them, it mints duplicate `local:`
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
 * retired sync runner's root-selection guard.
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

function pathIsWithin(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === ""
    || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
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

// Bug: b81c3e4 — scan roots carry their own depth so a category-organised
// monorepo (root/category/repo) is discovered without forcing every flat repo
// directory to the same nesting. See `defaultScanRoots` below for how depth is
// chosen when nothing is configured.
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

// Bug: 7ed20d0 — read repos.toml to discover repos nested deeper than the
// directory scan reaches (a monorepo root whose categories nest several levels).
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

/**
 * Issue 8aadf70 — repo scan roots are configuration, not hard-coded paths.
 *
 * `work_scanner_scan_roots` (settings table) or `MANDIBLE_WORK_SCANNER_ROOTS`
 * (environment) hold a JSON array of `{ path, depth }` entries, or a
 * newline/`:`-separated list of paths using the default depth. When neither is
 * set, Mandible falls back to the generic developer layouts below plus any
 * monorepo root discovered under `$HOME` by its `.projects/repos.toml`
 * manifest — which is what makes a category-organised monorepo keep working
 * without its owner's path being written into the source.
 */
const WORK_SCANNER_ROOTS_SETTING_KEY = "work_scanner_scan_roots";
const WORK_SCANNER_ROOTS_ENV_KEY = "MANDIBLE_WORK_SCANNER_ROOTS";
const DEFAULT_SCAN_DEPTH = 1;
const MONOREPO_MANIFEST_RELATIVE_PATH = path.join(".projects", "repos.toml");

/** Generic, layout-neutral places developers keep checkouts. */
const DEFAULT_FLAT_REPO_DIR_NAMES = [
  "dev",
  "code",
  "Code",
  "src",
  "git",
  "repos",
  "projects",
  "Projects",
  "Developer",
  "workspace",
];

export interface WorkScannerScanRoot {
  path: string;
  depth: number;
}

function coerceScanRoot(value: unknown): WorkScannerScanRoot | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? { path: path.resolve(trimmed), depth: DEFAULT_SCAN_DEPTH } : null;
  }
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const rawPath = typeof record.path === "string" ? record.path.trim() : "";
  if (!rawPath) return null;
  const rawDepth = record.depth;
  const depth = typeof rawDepth === "number" && Number.isInteger(rawDepth) && rawDepth > 0
    ? rawDepth
    : DEFAULT_SCAN_DEPTH;
  return { path: path.resolve(rawPath), depth };
}

export function parseWorkScannerScanRoots(raw: string | null | undefined): WorkScannerScanRoot[] {
  if (!raw || !raw.trim()) return [];
  const trimmed = raw.trim();
  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (Array.isArray(parsed)) {
        return parsed.map(coerceScanRoot).filter((r): r is WorkScannerScanRoot => r !== null);
      }
    } catch {
      // Fall through to the plain-list form below.
    }
    return [];
  }
  return trimmed
    .split(/[\n:,]/)
    .map((entry) => coerceScanRoot(entry))
    .filter((r): r is WorkScannerScanRoot => r !== null);
}

function configuredScanRoots(): WorkScannerScanRoot[] {
  const fromEnv = parseWorkScannerScanRoots(process.env[WORK_SCANNER_ROOTS_ENV_KEY]);
  if (fromEnv.length > 0) return fromEnv;
  try {
    const row = getDb()
      .prepare("SELECT value FROM settings WHERE key = ?")
      .get(WORK_SCANNER_ROOTS_SETTING_KEY) as { value: string } | undefined;
    return parseWorkScannerScanRoots(row?.value);
  } catch {
    return [];
  }
}

/**
 * Immediate `$HOME` subdirectories carrying a `.projects/repos.toml` manifest.
 * Treated as monorepo roots: scanned two levels deep for category layouts, and
 * supplemented by the manifest for repos nested deeper than the scan reaches.
 */
function discoverMonorepoRoots(home: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(home, { withFileTypes: true });
  } catch {
    return [];
  }
  const roots: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const candidate = path.join(home, entry.name);
    if (fs.existsSync(path.join(candidate, MONOREPO_MANIFEST_RELATIVE_PATH))) {
      roots.push(candidate);
    }
  }
  return roots;
}

/**
 * Collapse scan roots that name the same directory. Two default names can be the
 * same directory on a case-insensitive filesystem (`~/code` and `~/Code`), and a
 * configured root may be a symlink to another; identity comes from the inode, so
 * neither case produces a duplicate scan.
 */
export function dedupeScanRoots(roots: WorkScannerScanRoot[]): WorkScannerScanRoot[] {
  const byIdentity = new Map<string, WorkScannerScanRoot>();
  const unresolved: WorkScannerScanRoot[] = [];
  for (const root of roots) {
    let identity: string | null = null;
    try {
      const stat = fs.statSync(root.path);
      if (stat.isDirectory()) {
        identity = `${stat.dev}:${stat.ino}`;
      }
    } catch {
      identity = null;
    }
    if (identity === null) {
      unresolved.push(root);
      continue;
    }
    const existing = byIdentity.get(identity);
    // Keep the deepest scan requested for a directory named more than once.
    if (!existing || root.depth > existing.depth) {
      byIdentity.set(identity, root);
    }
  }
  return [...byIdentity.values(), ...unresolved];
}

function defaultScanRoots(home: string): WorkScannerScanRoot[] {
  const roots: WorkScannerScanRoot[] = DEFAULT_FLAT_REPO_DIR_NAMES.map((name) => ({
    path: path.join(home, name),
    depth: DEFAULT_SCAN_DEPTH,
  }));
  for (const monorepo of discoverMonorepoRoots(home)) {
    roots.push({ path: monorepo, depth: 2 });
  }
  return roots;
}

function discoverRepos(defaultRepoRoot?: string): string[] {
  const roots: string[] = [];
  const home = os.homedir();
  const dotfiles = path.join(home, ".dotfiles");
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

  const configured = configuredScanRoots();
  const scanRoots = dedupeScanRoots(
    configured.length > 0 ? configured : defaultScanRoots(home),
  );
  for (const root of scanRoots) {
    scanDirForRepos(root.path, root.depth, roots);
  }

  // Supplement the directory scan with repos registered in a `.projects/repos.toml`
  // manifest, which captures repos nested deeper than the configured depth.
  for (const root of scanRoots) {
    if (!fs.existsSync(path.join(root.path, MONOREPO_MANIFEST_RELATIVE_PATH))) continue;
    for (const repo of readReposToml(root.path)) {
      if (!roots.includes(repo)) roots.push(repo);
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
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
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

const execFileAsync = promisify(execFile);

// Async counterpart to runGit for event-loop-safe repo probing. Only the
// allow_failure semantics are needed by the async callers (repo discovery
// prefix and audit refresh), so a rejected spawn returns null rather than
// throwing.
async function runGitAsync(
  args: string[],
  options: { cwd: string; signal?: AbortSignal },
): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd: options.cwd,
      signal: options.signal,
      timeout: 5000,
      encoding: "utf8",
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
      maxBuffer: 64 * 1024 * 1024,
    });
    return stdout.trimEnd();
  } catch {
    return null;
  }
}

function runGitStatus(args: string[], cwd: string): number | null {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
  return typeof result.status === "number" ? result.status : null;
}

function parseCommitRecord(
  record: string,
  classify: (hash: string) => WorkCommitClassification,
): WorkCommit | null {
  const [hash, shortHash, author, date, parentsRaw, subject] = record.split("\u001f");
  if (!hash || !shortHash) {
    return null;
  }
  const classification = classify(hash);
  return {
    hash,
    short_hash: shortHash,
    message: subject ?? "",
    author: author ?? "",
    date: date ?? "",
    parents: parentsRaw ? parentsRaw.split(" ").filter(Boolean) : [],
    classification,
    is_pre_branch_point: classification === "pre-branch-point",
    is_merged_elsewhere: classification === "merged-elsewhere",
  };
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

function pathsReferToSameLocation(left: string, right: string): boolean {
  try {
    return fs.realpathSync(left) === fs.realpathSync(right);
  } catch {
    return path.resolve(left) === path.resolve(right);
  }
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
  private readonly configRoot: string | null;
  private readonly repoRootsOverride: string[] | null;
  private readonly emit: (event: SseEvent) => void;
  private readonly scanSkipWindowMs: number;
  private repoInfos: RepoInfo[] = [];
  private stopped = false;
  private readonly scanAbort = new AbortController();
  private readonly repoRefreshes = new Set<Promise<RepoInfo>>();
  private activeScan: { promise: Promise<ScanSummary>; skipsRecent: boolean } | null = null;

  constructor(options: WorkScannerOptions = {}) {
    this.db = options.db ?? getDb();
    this.defaultRepoRoot = path.resolve(
      resolveHome(options.default_repo_root ?? DEFAULT_REPO_ROOT),
    );
    this.configPath = path.resolve(
      resolveHome(options.config_path ?? ensureMandibleConfigFile("repos.json")),
    );
    this.configRoot = options.config_root ? path.resolve(options.config_root) : null;
    if (this.configRoot && !pathIsWithin(this.configRoot, this.configPath)) {
      throw new Error("Repository configuration path escapes its instance-owned root.");
    }
    this.repoRootsOverride = options.repo_roots
      ? normalizeRoots(options.repo_roots)
      : null;
    this.emit = options.on_event ?? ((event) => broadcast(event));
    this.scanSkipWindowMs = Math.max(0, options.scan_skip_window_ms ?? DEFAULT_SCAN_SKIP_WINDOW_MS);
  }

  getRepos(): RepoInfo[] {
    if (this.repoInfos.length > 0) {
      return this.repoInfos;
    }
    const cachedRepos = this.getCachedRepos();
    if (cachedRepos.length > 0) return cachedRepos;
    // Explicit scan/startup callers retain full discovery behavior. Request
    // handlers that need a projection use getCachedRepos() and never fall
    // through to host filesystem or Git discovery.
    this.refreshRepoInfos();
    return this.repoInfos;
  }

  getCachedRepos(): RepoInfo[] {
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
    this.repoInfos = [];
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
          worktree_inventory_known,
          worktree_status_known,
          default_comparison_known,
          has_upstream,
          upstream,
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

    let configuredProtected = ["main", "develop"];
    let projectIds: string[] = [];
    try {
      const setting = this.db.prepare("SELECT value FROM settings WHERE key = 'protected_branches'").get() as
        | { value: string }
        | undefined;
      configuredProtected = (setting?.value ?? "main,develop")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
      projectIds = (this.db.prepare(
        "SELECT DISTINCT project_id FROM ledger_project_checkouts WHERE root = ? ORDER BY project_id",
      ).all(repoRoot) as Array<{ project_id: string }>).map((row) => row.project_id);
    } catch {
      // Minimal scanner test doubles may not carry the canonical registry.
      // Missing identity remains an explicit fail-closed blocker below.
    }

    return rows.map((row) => {
      const branchName = String(row.branch);
      const branchData: BranchData = {
        repo_root: String(row.repo_root),
        branch: branchName,
        is_current: fromDbBool(Number(row.is_current)),
        is_worktree: fromDbBool(Number(row.is_worktree)),
        worktree_path: row.worktree_path ? String(row.worktree_path) : null,
        is_dirty: fromDbBool(Number(row.is_dirty)),
        ahead: Number(row.ahead),
        behind: Number(row.behind),
        has_upstream: fromDbBool(Number(row.has_upstream)),
        upstream: row.upstream ? String(row.upstream) : null,
        ahead_default: Number(row.ahead_default ?? 0),
        behind_default: Number(row.behind_default ?? 0),
        default_branch: row.default_branch ? String(row.default_branch) : "\u2014",
        worktree_inventory_known: fromDbBool(Number(row.worktree_inventory_known)),
        worktree_status_known: fromDbBool(Number(row.worktree_status_known)),
        default_comparison_known: fromDbBool(Number(row.default_comparison_known)),
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
      branchData.reaping = deriveReapingSafety(branchData, {
        protectedBranches: configuredProtected,
        projectIds,
      });
      return branchData;
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

  getWorktreeInventory(repoRoot: string): WorktreeInventory {
    const inventory = this.listWorktrees(repoRoot);
    return {
      known: inventory.known,
      worktrees: inventory.worktrees.map((worktree) => ({
        path: worktree.path,
        branch: worktree.branch,
        is_current: pathsReferToSameLocation(worktree.path, repoRoot),
      })),
    };
  }

  getCommits(
    repoRoot: string,
    branch: string,
    options: { limit?: number; offset?: number } = {},
  ): WorkCommitPage {
    const limit = Math.min(Math.max(Math.trunc(options.limit ?? 50), 1), 200);
    const offset = Math.max(Math.trunc(options.offset ?? 0), 0);
    const defaultBranch = this.detectDefaultBranch(repoRoot);
    const mergeBase = defaultBranch && defaultBranch !== branch
      ? runGit(["merge-base", defaultBranch, branch], { cwd: repoRoot, allow_failure: true })
      : null;
    const cherryStatus = this.getCherryStatus(repoRoot, defaultBranch, branch);
    const format = [
      "%H",
      "%h",
      "%an",
      "%aI",
      "%P",
      "%s",
    ].join("%x1f");
    const output = runGit([
      "log",
      `--max-count=${limit}`,
      `--skip=${offset}`,
      `--pretty=format:${format}%x1e`,
      branch,
    ], {
      cwd: repoRoot,
      allow_failure: true,
    }) ?? "";
    const totalRaw = runGit(["rev-list", "--count", branch], {
      cwd: repoRoot,
      allow_failure: true,
    });
    const total = Number.parseInt(totalRaw ?? "0", 10);
    const commits = output
      .split("\u001e")
      .map((record) => record.trim())
      .filter(Boolean)
      .map((record) => parseCommitRecord(record, (hash) =>
        this.classifyCommit(repoRoot, hash, mergeBase, cherryStatus),
      ))
      .filter((commit): commit is WorkCommit => commit !== null);

    return {
      repo_root: repoRoot,
      branch,
      default_branch: defaultBranch || "\u2014",
      merge_base: mergeBase,
      commits,
      total: Number.isNaN(total) ? commits.length : total,
      limit,
      offset,
    };
  }

  compareRefs(
    repoRoot: string,
    from: string,
    to: string,
    mode: WorkCompareMode = "merge-base",
  ): WorkCompareResult {
    const normalizedMode: WorkCompareMode = mode === "range" ? "range" : "merge-base";
    const range = normalizedMode === "range" ? `${from}..${to}` : `${from}...${to}`;
    const raw = runGit(["diff", range], {
      cwd: repoRoot,
      allow_failure: true,
    }) ?? "";
    const stat = runGit(["diff", "--stat", range], {
      cwd: repoRoot,
      allow_failure: true,
    }) ?? "";
    return {
      repo_root: repoRoot,
      from,
      to,
      mode: normalizedMode,
      range,
      raw,
      stat: stat.trim(),
    };
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.scanAbort.abort();
    const results = await Promise.allSettled([this.activeScan?.promise, ...this.repoRefreshes]);
    for (const result of results) {
      if (result.status === "rejected") {
        workScannerLog("warn", "work_scanner_drain_failed", { error: String(result.reason) });
      }
    }
  }

  private emptyScan(): ScanSummary {
    return { scanned_repos: 0, branches_updated: 0, branches_removed: 0, missing_repos: [], duration_ms: 0 };
  }

  scanAll(): ScanSummary {
    if (this.stopped) return this.emptyScan();
    const start = Date.now();
    this.refreshRepoInfos();

    this.emit({
      event: DOMAIN_EVENTS.WORK_SCAN_STARTED,
      type: DOMAIN_EVENTS.WORK_SCAN_STARTED,
      data: { started_at: new Date(start).toISOString() },
    });

    let branchesUpdated = 0;
    let branchesRemoved = 0;
    const missingRepos: string[] = [];
    let scannedRepos = 0;

    for (const repo of this.repoInfos) {
      if (this.stopped) break;
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
      event: DOMAIN_EVENTS.WORK_SCAN_COMPLETED,
      type: DOMAIN_EVENTS.WORK_SCAN_COMPLETED,
      data: summary,
    });

    return summary;
  }

  scanAllAsync(options: { skip_recent?: boolean } = {}): Promise<ScanSummary> {
    if (this.stopped) return Promise.resolve(this.emptyScan());
    const skipsRecent = options.skip_recent === true;
    if (this.activeScan) {
      if (skipsRecent || !this.activeScan.skipsRecent) {
        return this.activeScan.promise;
      }
      const activePromise = this.activeScan.promise;
      return activePromise.then(
        () => this.scanAllAsync(),
        () => this.scanAllAsync(),
      );
    }

    const scan = this.runAsyncScan(skipsRecent).catch((error) => {
      workScannerLog("error", "work_scanner_scan_failed", {
        subsystem: "work-scanner",
        error: String(error),
      });
      throw error;
    });
    this.activeScan = { promise: scan, skipsRecent };
    const clearActiveScan = () => {
      if (this.activeScan?.promise === scan) {
        this.activeScan = null;
      }
    };
    void scan.then(clearActiveScan, clearActiveScan);
    return scan;
  }

  private async runAsyncScan(skipRecent: boolean): Promise<ScanSummary> {
    const start = Date.now();
    const cachedRepos = this.getRepos();
    if (skipRecent && !cachedRepos.some((repo) => this.repoNeedsScan(repo, start))) {
      const summary: ScanSummary = {
        scanned_repos: 0,
        branches_updated: 0,
        branches_removed: 0,
        missing_repos: [],
        duration_ms: Date.now() - start,
      };
      this.emit({ event: DOMAIN_EVENTS.WORK_SCAN_COMPLETED, type: DOMAIN_EVENTS.WORK_SCAN_COMPLETED, data: summary });
      return summary;
    }

    await this.refreshRepoInfosAsync();
    if (this.stopped) return this.emptyScan();
    this.emit({
      event: DOMAIN_EVENTS.WORK_SCAN_STARTED,
      type: DOMAIN_EVENTS.WORK_SCAN_STARTED,
      data: { started_at: new Date(start).toISOString() },
    });

    let branchesUpdated = 0;
    let branchesRemoved = 0;
    const missingRepos: string[] = [];
    let scannedRepos = 0;

    for (const repo of this.repoInfos) {
      if (this.stopped) break;
      if (!repo.exists || !this.isGitRepo(repo.root)) {
        missingRepos.push(repo.root);
        continue;
      }
      if (repo.excluded || (skipRecent && !this.repoNeedsScan(repo, start))) {
        continue;
      }
      scannedRepos += 1;
      try {
        const steps = this.scanRepoSteps(repo.root, repo.id);
        let step = steps.next();
        while (!step.done) {
          await yieldToEventLoop();
          if (this.stopped) {
            steps.return({ updated: 0, removed: 0 });
            return this.emptyScan();
          }
          step = steps.next();
        }
        branchesUpdated += step.value.updated;
        branchesRemoved += step.value.removed;
        this.markRepoScanned(repo.root);
      } catch (_error) {
        workScannerLog("error", "work_scanner_repo_scan_failed", {
          subsystem: "work-scanner",
          repo_id: repo.id,
          path: repo.root,
          error: String(_error),
        });
      }
      await yieldToEventLoop();
    }

    const summary: ScanSummary = {
      scanned_repos: scannedRepos,
      branches_updated: branchesUpdated,
      branches_removed: branchesRemoved,
      missing_repos: missingRepos,
      duration_ms: Date.now() - start,
    };
    this.emit({ event: DOMAIN_EVENTS.WORK_SCAN_COMPLETED, type: DOMAIN_EVENTS.WORK_SCAN_COMPLETED, data: summary });
    return summary;
  }

  private repoNeedsScan(repo: RepoInfo, now: number): boolean {
    if (repo.excluded) return false;
    const lastScanned = repo.last_scanned_at ? Date.parse(repo.last_scanned_at) : Number.NaN;
    return !Number.isFinite(lastScanned) || now - lastScanned >= this.scanSkipWindowMs;
  }

  private markRepoScanned(repoRoot: string): void {
    const scanNow = new Date().toISOString();
    this.db.prepare(
      "UPDATE work_repos SET last_scanned_at = ?, updated_at = ? WHERE root = ?",
    ).run(scanNow, scanNow, repoRoot);
    const index = this.repoInfos.findIndex((repo) => repo.root === repoRoot);
    if (index >= 0) {
      this.repoInfos[index] = { ...this.repoInfos[index], last_scanned_at: scanNow };
    }
  }

  refreshRepo(idOrPath: string): RepoInfo {
    const repo = this.getRepoById(idOrPath);
    if (!repo) {
      throw new Error("repo not found");
    }
    if (!fs.existsSync(repo.root) || !this.isGitRepo(repo.root)) {
      throw new Error("repository is unavailable or is not a Git repository");
    }

    this.scanRepo(repo.root, repo.id);
    const scanNow = new Date().toISOString();
    this.db.prepare(
      "UPDATE work_repos SET last_scanned_at = ?, updated_at = ? WHERE root = ?",
    ).run(scanNow, scanNow, repo.root);
    const refreshed = { ...repo, exists: true, last_scanned_at: scanNow };
    const index = this.repoInfos.findIndex((candidate) => candidate.root === repo.root);
    if (index >= 0) {
      this.repoInfos[index] = refreshed;
    }
    return refreshed;
  }

  // Issue 651e820 — audit-endpoint refresh that yields between branches instead
  // of running the fully synchronous scanRepo, so the per-repo audit GET does
  // not block the event loop for the whole scan.
  refreshRepoAsync(idOrPath: string): Promise<RepoInfo> {
    if (this.stopped) return Promise.reject(new Error("Work scanner is stopped"));
    const refresh = this.runRepoRefresh(idOrPath);
    this.repoRefreshes.add(refresh);
    void refresh.then(() => this.repoRefreshes.delete(refresh), () => this.repoRefreshes.delete(refresh));
    return refresh;
  }

  private async runRepoRefresh(idOrPath: string): Promise<RepoInfo> {
    const repo = this.getRepoById(idOrPath);
    if (!repo) {
      throw new Error("repo not found");
    }
    if (!fs.existsSync(repo.root) || !this.isGitRepo(repo.root)) {
      throw new Error("repository is unavailable or is not a Git repository");
    }

    const steps = this.scanRepoSteps(repo.root, repo.id);
    let step = steps.next();
    while (!step.done) {
      await yieldToEventLoop();
      if (this.stopped) {
        steps.return({ updated: 0, removed: 0 });
        return repo;
      }
      step = steps.next();
    }

    const scanNow = new Date().toISOString();
    this.db.prepare(
      "UPDATE work_repos SET last_scanned_at = ?, updated_at = ? WHERE root = ?",
    ).run(scanNow, scanNow, repo.root);
    const refreshed = { ...repo, exists: true, last_scanned_at: scanNow };
    const index = this.repoInfos.findIndex((candidate) => candidate.root === repo.root);
    if (index >= 0) {
      this.repoInfos[index] = refreshed;
    }
    return refreshed;
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
    const derivedId = computeRepoId(resolved, existingIds);
    const registeredId = this.registeredWorkRepoId(resolved);
    const newId = registeredId ?? derivedId;
    if (existingIds.includes(newId)) {
      throw new Error(`Repository id already belongs to another checkout: ${newId}`);
    }

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
      this.writeRepoConfig(JSON.stringify(config, null, 2));
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
    let previousConfig: string | null = null;
    try {
      previousConfig = fs.readFileSync(this.configPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    let nextConfig: string | null = null;
    if (previousConfig !== null) {
      const config = JSON.parse(previousConfig) as { repos?: unknown };
      if (Array.isArray(config.repos)) {
        config.repos = config.repos.filter(
          (repo): repo is string => typeof repo === "string" && path.resolve(resolveHome(repo)) !== root,
        );
        nextConfig = JSON.stringify(config, null, 2);
      }
    } else if (this.configRoot) {
      const remaining = this.db.prepare(
        "SELECT root FROM work_repos WHERE id <> ? AND dir_exists = 1 ORDER BY root",
      ).all(id) as Array<{ root: string }>;
      nextConfig = JSON.stringify({ repos: remaining.map((repo) => repo.root) }, null, 2);
    }

    let configChanged = false;
    let transactionActive = false;
    try {
      this.db.exec("BEGIN IMMEDIATE");
      transactionActive = true;
      this.db.prepare("DELETE FROM work_repos WHERE id = ?").run(id);
      this.db.prepare("DELETE FROM branches WHERE repo_root = ?").run(root);
      if (nextConfig !== null && nextConfig !== previousConfig) {
        this.writeRepoConfig(nextConfig);
        configChanged = true;
      }
      this.db.exec("COMMIT");
      transactionActive = false;
    } catch (error) {
      if (transactionActive) {
        try { this.db.exec("ROLLBACK"); } catch (rollbackError) {
          workScannerLog("error", "work_scanner_repo_delete_rollback_failed", {
            subsystem: "work-scanner",
            repo_id: id,
            error: String(rollbackError),
          });
        }
      }
      if (configChanged) {
        try {
          if (previousConfig === null) {
            this.assertRepoConfigPathWithinRoot();
            fs.rmSync(this.configPath, { force: true });
          } else {
            this.writeRepoConfig(previousConfig);
          }
        } catch (restoreError) {
          workScannerLog("error", "work_scanner_repo_config_restore_failed", {
            subsystem: "work-scanner",
            path: this.configPath,
            error: String(restoreError),
          });
        }
      }
      throw error;
    }

    this.repoInfos = this.repoInfos.filter((r) => r.id !== id);
    return true;
  }

  private writeRepoConfig(content: string): void {
    const directory = path.dirname(this.configPath);
    fs.mkdirSync(directory, { recursive: true });
    this.assertRepoConfigPathWithinRoot();

    const temporary = path.join(directory, `.repos-${randomUUID()}.tmp`);
    try {
      fs.writeFileSync(temporary, content, { encoding: "utf8", flag: "wx" });
      fs.renameSync(temporary, this.configPath);
    } catch (error) {
      try { fs.rmSync(temporary, { force: true }); } catch { /* preserve the write error */ }
      throw error;
    }
  }

  private assertRepoConfigPathWithinRoot(): void {
    if (!this.configRoot) return;
    const root = fs.realpathSync.native(this.configRoot);
    const directory = path.dirname(this.configPath);
    if (fs.existsSync(directory)) {
      const realDirectory = fs.realpathSync.native(directory);
      if (!pathIsWithin(root, realDirectory)) {
        throw new Error("Repository configuration directory escapes its instance-owned root.");
      }
    }
    try {
      const stats = fs.lstatSync(this.configPath);
      if (stats.isSymbolicLink()) {
        throw new Error("Repository configuration file cannot be a symlink in a preview instance.");
      }
      if (stats.nlink > 1 || !pathIsWithin(root, fs.realpathSync.native(this.configPath))) {
        throw new Error("Repository configuration file escapes its instance-owned root.");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  private isGitDirectory(candidate: string): boolean {
    return isGitDirectory(candidate);
  }

  private resolveSortedRoots(): string[] {
    const roots = this.resolveRepoRoots();
    return [...roots].sort((a, b) =>
      path.normalize(a).localeCompare(path.normalize(b)),
    );
  }

  // Synchronous discovery prefix retained for explicit sync callers
  // (getRepos cold-start, scanAll, addRepo). Probes each root's git identity
  // with blocking spawns.
  private refreshRepoInfos(): void {
    const sortedRoots = this.resolveSortedRoots();
    const probes = new Map<string, { exists: boolean; defaultBranch: string }>();
    for (const root of sortedRoots) {
      if (this.stopped) return;
      const exists = fs.existsSync(root);
      const defaultBranch = exists && this.isGitRepo(root)
        ? this.detectDefaultBranch(root)
        : "";
      probes.set(root, { exists, defaultBranch });
    }
    if (!this.stopped) this.applyRepoInfos(sortedRoots, probes);
  }

  // Issue 651e820 — async discovery prefix for the yielding scan path. The
  // per-repo `git rev-parse` identity probes run via execFile and the loop
  // yields to the event loop between repos, so a cold-cache post-restart scan
  // no longer blocks for tens of seconds before its first yield.
  private async refreshRepoInfosAsync(): Promise<void> {
    const sortedRoots = this.resolveSortedRoots();
    const probes = new Map<string, { exists: boolean; defaultBranch: string }>();
    for (const root of sortedRoots) {
      if (this.stopped) return;
      const exists = fs.existsSync(root);
      const defaultBranch = exists && (await this.isGitRepoAsync(root))
        ? await this.detectDefaultBranchAsync(root)
        : "";
      probes.set(root, { exists, defaultBranch });
      await yieldToEventLoop();
    }
    if (!this.stopped) this.applyRepoInfos(sortedRoots, probes);
  }

  private applyRepoInfos(
    sortedRoots: string[],
    probes: Map<string, { exists: boolean; defaultBranch: string }>,
  ): void {
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
    const persistedRows = this.db
      .prepare("SELECT id, root FROM work_repos")
      .all() as Array<{ id: string; root: string }>;
    const persistedByRoot = new Map(persistedRows.map((row) => [row.root, row.id]));
    const persistedRootById = new Map(persistedRows.map((row) => [row.id, row.root]));
    const assignedIds = new Set<string>();
    this.repoInfos = candidates.map((candidate) => {
      const needsParent = (slugCounts.get(candidate.baseSlug) ?? 0) > 1;
      const baseId = needsParent && candidate.parentSlug
        ? `${candidate.parentSlug}-${candidate.baseSlug}`
        : candidate.baseSlug;
      const seen = slugInstances.get(baseId) ?? 0;
      const derivedId = seen === 0 ? baseId : `${baseId}-${seen}`;
      slugInstances.set(baseId, seen + 1);
      const persistedId = persistedByRoot.get(candidate.root);
      const registeredId = persistedId ? null : this.registeredWorkRepoId(candidate.root);
      const id = persistedId ?? registeredId ?? derivedId;
      const owner = persistedRootById.get(id);
      if ((owner && owner !== candidate.root) || assignedIds.has(id)) {
        throw new Error(`Repository id already belongs to another checkout: ${id}`);
      }
      assignedIds.add(id);
      const probe = probes.get(candidate.root) ?? { exists: false, defaultBranch: "" };
      return {
        id,
        name: candidate.name,
        root: candidate.root,
        exists: probe.exists,
        default_branch: probe.defaultBranch,
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
      if (this.stopped) break;
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

    // Reload the persisted id and mutable state from DB. The root is the
    // work_repos primary key, so ON CONFLICT(root) deliberately preserves an
    // existing id. Keeping the freshly derived in-memory id here would split
    // API identity from persisted identity after a registry migration.
    const dbRows = this.db.prepare(
      "SELECT id, root, name, excluded, user_modified, last_scanned_at FROM work_repos"
    ).all() as Array<{
      id: string;
      root: string;
      name: string;
      excluded: number;
      user_modified: number;
      last_scanned_at: string | null;
    }>;
    const dbByRoot = new Map(dbRows.map((r) => [r.root, r]));
    this.repoInfos = this.repoInfos.map((repo) => {
      const dbRow = dbByRoot.get(repo.root);
      if (!dbRow) return repo;
      return {
        ...repo,
        id: dbRow.id,
        excluded: dbRow.excluded === 1,
        user_modified: dbRow.user_modified === 1,
        last_scanned_at: dbRow.last_scanned_at,
        name: dbRow.user_modified === 1 ? dbRow.name : repo.name,
      };
    });
  }

  private registeredWorkRepoId(root: string): string | null {
    try {
      const row = this.db
        .prepare(
          `SELECT c.work_repo_id, p.project_key
           FROM ledger_project_checkouts c
           JOIN ledger_projects p ON p.id = c.project_id
           WHERE c.root = ?
           LIMIT 1`,
        )
        .get(root) as { work_repo_id: string | null; project_key: string } | undefined;
      if (!row) return null;
      return (
        canonicalizeCheckoutWorkRepoId(root, row.project_key, row.work_repo_id) ??
        row.project_key?.trim() ??
        null
      );
    } catch {
      // Lightweight scanner test databases can intentionally omit the project
      // registry. Discovery remains path-derived only in that legacy shape.
      return null;
    }
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
    return this.matchesToplevel(repoRoot, output);
  }

  private async isGitRepoAsync(repoRoot: string): Promise<boolean> {
    const output = await runGitAsync(["rev-parse", "--show-toplevel"], { cwd: repoRoot, signal: this.scanAbort.signal });
    return this.matchesToplevel(repoRoot, output);
  }

  private matchesToplevel(repoRoot: string, toplevel: string | null): boolean {
    if (!toplevel) {
      return false;
    }
    try {
      const resolvedRepo = fs.realpathSync(repoRoot);
      const resolvedOutput = fs.realpathSync(toplevel);
      return resolvedOutput === resolvedRepo;
    } catch (_error) {
      return false;
    }
  }

  private scanRepo(repoRoot: string, repoId: string): { updated: number; removed: number } {
    const steps = this.scanRepoSteps(repoRoot, repoId);
    let step = steps.next();
    while (!step.done) {
      step = steps.next();
    }
    return step.value;
  }

  private *scanRepoSteps(
    repoRoot: string,
    repoId: string,
  ): Generator<void, { updated: number; removed: number }, void> {
    const worktreeInventory = this.listWorktrees(repoRoot);
    const worktrees = worktreeInventory.worktrees;
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
    const canonicalDefaultBranch = this.getCanonicalCheckoutDefaultBranch(repoRoot);
    const defaultBranch = canonicalDefaultBranch.branch || this.detectDefaultBranch(repoRoot);
    const defaultBranchKnown = canonicalDefaultBranch.known && Boolean(runGit(
      ["rev-parse", "--verify", `refs/heads/${defaultBranch}^{commit}`],
      { cwd: repoRoot, allow_failure: true },
    ));
    const now = new Date().toISOString();

    let updated = 0;
    for (const branch of branches) {
      const worktreePath = worktreeByBranch.get(branch) ?? null;
      const isWorktree = worktreePath !== null;
      const isCurrent = currentBranch === branch;
      const status = worktreePath
        ? this.getWorktreeStatus(worktreePath)
        : { is_dirty: false, diff_stat: null, known: worktreeInventory.known };
      const lastCommit = this.getLastCommit(repoRoot, branch);
      const aheadBehind = this.getAheadBehind(repoRoot, branch);
      const aheadBehindDefault = this.getAheadBehindDefault(
        repoRoot,
        branch,
        defaultBranch,
        defaultBranchKnown,
      );

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
        worktree_inventory_known: toDbBool(worktreeInventory.known),
        worktree_status_known: toDbBool(status.known),
        default_comparison_known: toDbBool(aheadBehindDefault.known),
        has_upstream: toDbBool(aheadBehind.has_upstream),
        upstream: aheadBehind.upstream,
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
            worktree_inventory_known,
            worktree_status_known,
            default_comparison_known,
            has_upstream,
            upstream,
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
            worktree_inventory_known,
            worktree_status_known,
            default_comparison_known,
            has_upstream,
            upstream,
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
            @worktree_inventory_known,
            @worktree_status_known,
            @default_comparison_known,
            @has_upstream,
            @upstream,
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
            worktree_inventory_known = excluded.worktree_inventory_known,
            worktree_status_known = excluded.worktree_status_known,
            default_comparison_known = excluded.default_comparison_known,
            has_upstream = excluded.has_upstream,
            upstream = excluded.upstream,
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
          worktree_inventory_known: worktreeInventory.known,
          worktree_status_known: status.known,
          default_comparison_known: aheadBehindDefault.known,
          last_commit: lastCommit,
          last_commit_date: lastCommit?.date ?? null,
          diff_stat: status.diff_stat,
        };
        this.emit({
          event: DOMAIN_EVENTS.WORK_BRANCH_UPDATED,
          type: DOMAIN_EVENTS.WORK_BRANCH_UPDATED,
          data: { ...branchData, repo_id: repoId },
        });
      }
      yield;
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

  private listWorktrees(repoRoot: string): { worktrees: WorktreeInfo[]; known: boolean } {
    const output = runGit(["worktree", "list", "--porcelain"], {
      cwd: repoRoot,
      allow_failure: true,
    });
    if (output === null) {
      return { worktrees: [], known: false };
    }
    return { worktrees: parseWorktreeList(output), known: true };
  }

  private getWorktreeStatus(
    worktreePath: string,
  ): { is_dirty: boolean; diff_stat: string | null; known: boolean } {
    const output = runGit([
      "status", "--porcelain", "--untracked-files=all", "--ignore-submodules=none",
    ], {
      cwd: worktreePath,
      allow_failure: true,
    });
    if (output === null) {
      return { is_dirty: true, diff_stat: null, known: false };
    }
    const isDirty = output.trim().length > 0;
    if (!isDirty) {
      return { is_dirty: false, diff_stat: null, known: true };
    }
    const diffStat = runGit(["diff", "--stat"], {
      cwd: worktreePath,
      allow_failure: true,
    });
    return {
      is_dirty: true,
      diff_stat: diffStat ? diffStat.trim() : null,
      known: true,
    };
  }

  private getCanonicalCheckoutDefaultBranch(repoRoot: string): { branch: string; known: boolean } {
    try {
      const rows = this.db.prepare(
        `SELECT project_id, default_branch
           FROM ledger_project_checkouts
          WHERE root = ?
          ORDER BY project_id, id`,
      ).all(repoRoot) as Array<{ project_id: string; default_branch: string }>;
      const projectIds = new Set(rows.map((row) => row.project_id));
      const defaults = new Set(rows.map((row) => row.default_branch?.trim()).filter(Boolean));
      if (projectIds.size === 1 && defaults.size === 1) {
        return { branch: [...defaults][0], known: true };
      }
    } catch {
      // Minimal scanner databases may not include the canonical project registry.
    }
    return { branch: "", known: false };
  }

  private getLastCommit(repoRoot: string, branch: string): LastCommit | null {
    const output = runGit(
      ["log", "-1", "--format=%H%x1f%s%x1f%an%x1f%aI", branch],
      { cwd: repoRoot, allow_failure: true },
    );
    return parseLastCommit(output);
  }

  private getCherryStatus(
    repoRoot: string,
    defaultBranch: string,
    branch: string,
  ): Map<string, WorkCommitClassification> {
    const statusByHash = new Map<string, WorkCommitClassification>();
    if (!defaultBranch || defaultBranch === branch) {
      return statusByHash;
    }
    const output = runGit(["cherry", defaultBranch, branch], {
      cwd: repoRoot,
      allow_failure: true,
    });
    if (!output) {
      return statusByHash;
    }
    for (const line of output.split("\n")) {
      const match = line.trim().match(/^([+-])\s+([0-9a-f]{7,40})$/i);
      if (!match) {
        continue;
      }
      if (match[1] === "-") {
        statusByHash.set(match[2], "merged-elsewhere");
      } else {
        statusByHash.set(match[2], "unique");
      }
    }
    return statusByHash;
  }

  private classifyCommit(
    repoRoot: string,
    hash: string,
    mergeBase: string | null,
    cherryStatus: Map<string, WorkCommitClassification>,
  ): WorkCommitClassification {
    const cherryClassification = cherryStatus.get(hash);
    if (cherryClassification === "merged-elsewhere") {
      return cherryClassification;
    }
    if (mergeBase) {
      const ancestorStatus = runGitStatus(["merge-base", "--is-ancestor", hash, mergeBase], repoRoot);
      if (ancestorStatus === 0) {
        return "pre-branch-point";
      }
    }
    return "unique";
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

  private async detectDefaultBranchAsync(repoRoot: string): Promise<string> {
    const candidates = ["main", "develop"];
    for (const candidate of candidates) {
      if (this.stopped) return "";
      const result = await runGitAsync(["rev-parse", "--verify", candidate], { cwd: repoRoot, signal: this.scanAbort.signal });
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
    defaultBranchKnown = true,
  ): { ahead_default: number; behind_default: number; default_branch: string; known: boolean } {
    if (!defaultBranchKnown || !defaultBranch) {
      return {
        ahead_default: 0,
        behind_default: 0,
        default_branch: defaultBranch || "\u2014",
        known: false,
      };
    }
    if (branch === defaultBranch) {
      return { ahead_default: 0, behind_default: 0, default_branch: defaultBranch, known: true };
    }
    const output = runGit(
      ["rev-list", "--left-right", "--count", `${defaultBranch}...${branch}`],
      { cwd: repoRoot, allow_failure: true },
    );
    if (!output) {
      return { ahead_default: 0, behind_default: 0, default_branch: defaultBranch, known: false };
    }
    const [behindRaw, aheadRaw] = output.trim().split(/\s+/);
    const behind = Number.parseInt(behindRaw ?? "0", 10);
    const ahead = Number.parseInt(aheadRaw ?? "0", 10);
    return {
      ahead_default: Number.isNaN(ahead) ? 0 : ahead,
      behind_default: Number.isNaN(behind) ? 0 : behind,
      default_branch: defaultBranch,
      known: !Number.isNaN(ahead) && !Number.isNaN(behind),
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
