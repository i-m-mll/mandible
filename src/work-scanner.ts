import { DOMAIN_EVENTS, WORK_SCAN_SKIP_WINDOW_MS } from "./contracts.js";
import { execFile } from "child_process";
import { randomUUID } from "node:crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { promisify } from "util";
import { parse as parseToml } from "smol-toml";
import { getDaemonLogger } from "./daemon-log.js";
import { getDb } from "./db.js";
import { DEFAULT_PROTECTED_BRANCHES_SETTING, parseProtectedBranchSetting, readProtectedBranchSetting } from "./protected-branches.js";
import { ensureMandibleConfigFile } from "./platform-paths.js";
import { broadcast, type SseEvent } from "./sse.js";
import { canonicalizeCheckoutWorkRepoId } from "./ledger/projects.js";
import { isPreservedAppWorktreePath } from "./worktree-preservation.js";

function localBranchRef(branch: string): string {
  return `refs/heads/${branch}`;
}

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
  transaction(callback: () => void): () => void;
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
function isAbsentPath(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

function pathExists(candidate: string): boolean {
  try { fs.statSync(candidate); return true; }
  catch (error) { if (isAbsentPath(error)) return false; throw error; }
}

function isGitDirectory(candidate: string): boolean {
  try { return fs.statSync(path.join(candidate, ".git")).isDirectory(); }
  catch (error) { if (isAbsentPath(error)) return false; throw error; }
}

function scanDirForRepos(dir: string, depth: number, roots: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if (isAbsentPath(error)) return;
    throw error;
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
    if (isAbsentPath(err)) return [];
    workScannerLog("warn", "work_scanner_repos_toml_read_failed", {
      subsystem: "work-scanner",
      path: tomlPath,
      error: String(err),
    });
    throw err;
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
  } catch (error) {
    if (isAbsentPath(error)) return [];
    throw error;
  }
  const roots: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const candidate = path.join(home, entry.name);
    if (pathExists(path.join(candidate, MONOREPO_MANIFEST_RELATIVE_PATH))) {
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
    if (!pathExists(path.join(root.path, MONOREPO_MANIFEST_RELATIVE_PATH))) continue;
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

const execFileAsync = promisify(execFile);

// Expected absent refs may return null; process failures must never become
// fabricated empty inventories or fresh branch state.
async function runGit(
  args: string[],
  options: { cwd: string; absent_exit_codes?: readonly number[]; signal?: AbortSignal },
): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd: options.cwd,
      signal: options.signal,
      timeout: 5000,
      killSignal: "SIGKILL",
      encoding: "utf8",
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
      maxBuffer: 64 * 1024 * 1024,
    });
    return stdout.trimEnd();
  } catch (error) {
    const failure = error as { code?: string | number; killed?: boolean; signal?: string };
    if (typeof failure.code === "number" && options.absent_exit_codes?.includes(failure.code) && !failure.killed && !failure.signal) return null;
    throw new Error(`git ${args.join(" ")} failed in ${options.cwd}: ${String(error)}`, { cause: error });
  }
}

/** Local branch names in `repoRoot`, read from Git itself; throws when Git cannot answer. */
export async function listLocalBranches(repoRoot: string, signal?: AbortSignal): Promise<string[]> {
  const output = await runGit(["for-each-ref", "--format=%(refname)", "refs/heads"], { cwd: repoRoot, signal });
  return (output ?? "")
    .split("\n")
    .filter((line) => line.startsWith("refs/heads/"))
    .map((line) => line.slice("refs/heads/".length));
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

interface BranchRef {
  branch: string;
  last_commit: LastCommit;
  upstream: string | null;
  ahead: number;
  behind: number;
  default_comparison: { ahead: number; behind: number } | null;
}

const BRANCH_REF_FIELDS = [
  "%(refname)",
  "%(objectname)",
  "%(subject)",
  "%(authorname)",
  "%(authordate:iso-strict)",
  "%(upstream:short)",
  "%(upstream:track,nobracket)",
];

function countIn(track: string, label: "ahead" | "behind"): number {
  const match = new RegExp(`\\b${label} (\\d+)`).exec(track);
  return match ? Number.parseInt(match[1], 10) : 0;
}

/**
 * Every local branch with its tip, upstream divergence, and divergence from
 * `defaultBranch`, read in one Git process rather than several per branch.
 */
async function readBranchRefs(
  repoRoot: string,
  defaultBranch: string | null,
  signal: AbortSignal,
): Promise<BranchRef[]> {
  const fields = defaultBranch
    ? [...BRANCH_REF_FIELDS, `%(ahead-behind:${localBranchRef(defaultBranch)})`]
    : BRANCH_REF_FIELDS;
  const output = await runGit(["for-each-ref", `--format=${fields.join("%1f")}`, "refs/heads"], { cwd: repoRoot, signal });
  const refs: BranchRef[] = [];
  for (const line of (output ?? "").split("\n")) {
    const [refname, hash, message, author, date, upstream, track, defaultCounts] = line.split("\u001f");
    if (!refname?.startsWith("refs/heads/")) continue;
    const [aheadDefault, behindDefault] = (defaultCounts ?? "").split(" ").map((value) => Number.parseInt(value, 10));
    refs.push({
      branch: refname.slice("refs/heads/".length),
      last_commit: { hash, message, author, date },
      upstream: upstream || null,
      ahead: countIn(track ?? "", "ahead"),
      behind: countIn(track ?? "", "behind"),
      default_comparison: Number.isInteger(aheadDefault) && Number.isInteger(behindDefault)
        ? { ahead: aheadDefault, behind: behindDefault }
        : null,
    });
  }
  return refs;
}

const BRANCH_COLUMNS = [
  "repo_root",
  "branch",
  "is_current",
  "is_worktree",
  "worktree_path",
  "is_dirty",
  "ahead",
  "behind",
  "ahead_default",
  "behind_default",
  "default_branch",
  "worktree_inventory_known",
  "worktree_status_known",
  "default_comparison_known",
  "has_upstream",
  "upstream",
  "last_commit_hash",
  "last_commit_message",
  "last_commit_author",
  "last_commit_date",
  "diff_stat",
] as const;

type BranchRow = Record<(typeof BRANCH_COLUMNS)[number] | "updated_at", string | number | null>;

function branchRow(data: BranchData, updatedAt: string): BranchRow {
  return {
    repo_root: data.repo_root,
    branch: data.branch,
    is_current: toDbBool(data.is_current),
    is_worktree: toDbBool(data.is_worktree),
    worktree_path: data.worktree_path,
    is_dirty: toDbBool(data.is_dirty),
    ahead: data.ahead,
    behind: data.behind,
    ahead_default: data.ahead_default,
    behind_default: data.behind_default,
    default_branch: data.default_branch,
    worktree_inventory_known: toDbBool(data.worktree_inventory_known === true),
    worktree_status_known: toDbBool(data.worktree_status_known === true),
    default_comparison_known: toDbBool(data.default_comparison_known === true),
    has_upstream: toDbBool(data.has_upstream),
    upstream: data.upstream ?? null,
    last_commit_hash: data.last_commit?.hash ?? null,
    last_commit_message: data.last_commit?.message ?? null,
    last_commit_author: data.last_commit?.author ?? null,
    last_commit_date: data.last_commit?.date ?? null,
    diff_stat: data.diff_stat,
    updated_at: updatedAt,
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
  private readonly repoRefreshes = new Map<string, Promise<RepoInfo>>();
  private readonly scanSnapshots = new Map<string, { scannedAt: number; inventory: WorktreeInventory }>();
  private repoDiscoveryStatus: "pending" | "ready" | "failed" = "pending";
  private repoInfoRefresh: Promise<void> | null = null;
  private readonly repoScans = new Map<string, Promise<{ updated: number; removed: number }>>();
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
    this.scanSkipWindowMs = Math.max(0, options.scan_skip_window_ms ?? WORK_SCAN_SKIP_WINDOW_MS);
  }

  getRepos(): RepoInfo[] {
    if (this.repoInfos.length > 0) {
      return this.repoInfos;
    }
    const cachedRepos = this.getCachedRepos();
    if (cachedRepos.length > 0) return cachedRepos;
    return cachedRepos;
  }

  async getReposAsync(): Promise<RepoInfo[]> {
    if (this.stopped) throw new Error("Work scanner is stopped");
    const cached = this.getRepos();
    if (cached.length > 0) return cached;
    await this.refreshRepoInfos();
    return this.repoInfos;
  }

  getRepoDiscoveryStatus(): "pending" | "ready" | "failed" {
    return this.repoDiscoveryStatus;
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
      .prepare(`SELECT ${BRANCH_COLUMNS.join(", ")} FROM branches WHERE repo_root = ? ORDER BY branch ASC`)
      .all(repoRoot) as Array<Record<string, unknown>>;

    let configuredProtected = parseProtectedBranchSetting(DEFAULT_PROTECTED_BRANCHES_SETTING);
    let projectIds: string[] = [];
    try {
      configuredProtected = readProtectedBranchSetting(this.db);
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

  async getCommits(
    repoRoot: string,
    branch: string,
    options: { limit?: number; offset?: number } = {},
  ): Promise<WorkCommitPage> {
    const limit = Math.min(Math.max(Math.trunc(options.limit ?? 50), 1), 200);
    const offset = Math.max(Math.trunc(options.offset ?? 0), 0);
    const defaultBranch = await this.detectDefaultBranch(repoRoot);
    const mergeBase = defaultBranch && defaultBranch !== branch
      ? await runGit(["merge-base", localBranchRef(defaultBranch), localBranchRef(branch)], { cwd: repoRoot, absent_exit_codes: [1], signal: this.scanAbort.signal })
      : null;
    const cherryStatus = await this.getCherryStatus(repoRoot, defaultBranch, branch);
    const format = [
      "%H",
      "%h",
      "%an",
      "%aI",
      "%P",
      "%s",
    ].join("%x1f");
    const output = await runGit([
      "log",
      `--max-count=${limit}`,
      `--skip=${offset}`,
      `--pretty=format:${format}%x1e`,
      localBranchRef(branch),
    ], {
      cwd: repoRoot,
      signal: this.scanAbort.signal,

    }) ?? "";
    const totalRaw = await runGit(["rev-list", "--count", localBranchRef(branch)], {
      cwd: repoRoot,
      signal: this.scanAbort.signal,

    });
    const total = Number.parseInt(totalRaw ?? "0", 10);
    const commits: WorkCommit[] = [];
    for (const record of output.split("\u001e").map(value => value.trim()).filter(Boolean)) {
      const commit = parseCommitRecord(record, () => "unique");
      if (!commit) continue;
      const classification = await this.classifyCommit(repoRoot, commit.hash, mergeBase, cherryStatus);
      commits.push({ ...commit, classification, is_pre_branch_point: classification === "pre-branch-point", is_merged_elsewhere: classification === "merged-elsewhere" });
    }

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

  async compareRefs(
    repoRoot: string,
    from: string,
    to: string,
    mode: WorkCompareMode = "merge-base",
  ): Promise<WorkCompareResult> {
    const normalizedMode: WorkCompareMode = mode === "range" ? "range" : "merge-base";
    const range = normalizedMode === "range" ? `${from}..${to}` : `${from}...${to}`;
    const raw = await runGit(["diff", range], {
      cwd: repoRoot,
      signal: this.scanAbort.signal,

    }) ?? "";
    const stat = await runGit(["diff", "--stat", range], {
      cwd: repoRoot,
      signal: this.scanAbort.signal,

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
    const results = await Promise.allSettled([this.activeScan?.promise, this.repoInfoRefresh, ...this.repoRefreshes.values()]);
    for (const result of results) {
      if (result.status === "rejected" && (result.reason?.cause?.code ?? result.reason?.code) !== "ABORT_ERR") {
        workScannerLog("warn", "work_scanner_drain_failed", { error: String(result.reason) });
      }
    }
  }

  private emptyScan(): ScanSummary {
    return { scanned_repos: 0, branches_updated: 0, branches_removed: 0, missing_repos: [], duration_ms: 0 };
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
      if (this.stopped) return this.emptyScan();
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
    if (skipRecent && cachedRepos.length > 0 && !cachedRepos.some((repo) => this.repoNeedsScan(repo, start))) {
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

    await this.refreshRepoInfos();
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
      if (!repo.exists || !(await this.isGitRepo(repo.root))) {
        missingRepos.push(repo.root);
        continue;
      }
      if (repo.excluded || (skipRecent && !this.repoNeedsScan(repo, start))) {
        continue;
      }
      scannedRepos += 1;
      try {
        const result = await this.scanRepo(repo.root, repo.id);
        if (this.stopped) return this.emptyScan();
        branchesUpdated += result.updated;
        branchesRemoved += result.removed;
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

  /**
   * The repository's stored scan and the worktree inventory it was taken
   * against. A scan this process completed within the skip window is served
   * as stored; otherwise, or when `refresh` is set, the repository is rescanned.
   */
  async getRepoScan(idOrPath: string, options: { refresh: boolean }): Promise<{ repo: RepoInfo; inventory: WorktreeInventory }> {
    const repo = this.getRepoById(idOrPath);
    const snapshot = repo && this.scanSnapshots.get(repo.root);
    if (repo && snapshot && !options.refresh && Date.now() - snapshot.scannedAt < this.scanSkipWindowMs) {
      return { repo, inventory: snapshot.inventory };
    }
    const refreshed = await this.refreshRepoAsync(idOrPath);
    const inventory = this.scanSnapshots.get(refreshed.root)?.inventory;
    if (!inventory) throw new Error("Work scanner is stopped");
    return { repo: refreshed, inventory };
  }

  /** Rescan one repository; concurrent callers for the same repository share one refresh. */
  refreshRepoAsync(idOrPath: string): Promise<RepoInfo> {
    if (this.stopped) return Promise.reject(new Error("Work scanner is stopped"));
    const repo = this.getRepoById(idOrPath);
    if (!repo) return Promise.reject(new Error("repo not found"));
    const active = this.repoRefreshes.get(repo.root);
    if (active) return active;
    const refresh = this.runRepoRefresh(repo);
    this.repoRefreshes.set(repo.root, refresh);
    const clear = () => { if (this.repoRefreshes.get(repo.root) === refresh) this.repoRefreshes.delete(repo.root); };
    void refresh.then(clear, clear);
    return refresh;
  }

  private async runRepoRefresh(repo: RepoInfo): Promise<RepoInfo> {
    if (!fs.existsSync(repo.root) || !(await this.isGitRepo(repo.root))) {
      throw new Error("repository is unavailable or is not a Git repository");
    }

    await this.scanRepo(repo.root, repo.id);
    if (this.stopped) return repo;

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
    if (this.stopped) throw new Error("Work scanner is stopped");
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
    const defaultBranch = await this.isGitRepo(resolved) ? await this.detectDefaultBranch(resolved) : "";
    if (this.stopped) throw new Error("Work scanner is stopped");
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

    // Use the same tracked refresh and shutdown drain as explicit requests.
    void this.refreshRepoAsync(newId).catch((error) => {
      workScannerLog("error", "work_scanner_add_repo_background_scan_failed", {
        subsystem: "work-scanner", repo_id: newId, path: resolved, error: String(error),
      });
    });

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

  // Cold discovery uses the same bounded Git probes as branch refresh.
  private refreshRepoInfos(): Promise<void> {
    if (this.repoInfoRefresh) return this.repoInfoRefresh;
    const refresh = this.runRepoInfoRefresh().catch(error => {
      if (!this.stopped) this.repoDiscoveryStatus = "failed";
      throw error;
    });
    this.repoInfoRefresh = refresh;
    const clear = () => { if (this.repoInfoRefresh === refresh) this.repoInfoRefresh = null; };
    void refresh.then(clear, clear);
    return refresh;
  }

  private async runRepoInfoRefresh(): Promise<void> {
    const sortedRoots = this.resolveSortedRoots();
    const probes = new Map<string, { exists: boolean; defaultBranch: string }>();
    for (const root of sortedRoots) {
      if (this.stopped) return;
      const exists = pathExists(root);
      const defaultBranch = exists && (await this.isGitRepo(root))
        ? await this.detectDefaultBranch(root)
        : "";
      probes.set(root, { exists, defaultBranch });
      await yieldToEventLoop();
    }
    if (!this.stopped) {
      this.applyRepoInfos(sortedRoots, probes);
      this.repoDiscoveryStatus = "ready";
    }
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

  private async isGitRepo(repoRoot: string): Promise<boolean> {
    const output = await runGit(["rev-parse", "--show-toplevel"], { cwd: repoRoot, signal: this.scanAbort.signal, absent_exit_codes: pathExists(path.join(repoRoot, ".git")) ? [] : [128] });
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

  private scanRepo(repoRoot: string, repoId: string): Promise<{ updated: number; removed: number }> {
    const active = this.repoScans.get(repoRoot);
    if (active) return active;
    const scanning = this.runRepoScan(repoRoot, repoId);
    this.repoScans.set(repoRoot, scanning);
    const clear = () => { if (this.repoScans.get(repoRoot) === scanning) this.repoScans.delete(repoRoot); };
    void scanning.then(clear, clear);
    return scanning;
  }

  private async runRepoScan(
    repoRoot: string,
    repoId: string,
  ): Promise<{ updated: number; removed: number }> {
    const worktreeInventory = await this.listWorktrees(repoRoot);
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

    const canonicalDefaultBranch = this.getCanonicalCheckoutDefaultBranch(repoRoot);
    const defaultBranch = canonicalDefaultBranch.branch || await this.detectDefaultBranch(repoRoot);
    const defaultBranchKnown = canonicalDefaultBranch.known && Boolean(await runGit(
      ["rev-parse", "--verify", "--quiet", `refs/heads/${defaultBranch}^{commit}`],
      { cwd: repoRoot, absent_exit_codes: [1], signal: this.scanAbort.signal },
    ));
    const refs = await readBranchRefs(repoRoot, defaultBranchKnown ? defaultBranch : null, this.scanAbort.signal);
    const now = new Date().toISOString();

    const rows: Array<{ row: BranchRow; data: BranchData }> = [];
    for (const ref of refs) {
      const branch = ref.branch;
      const worktreePath = worktreeByBranch.get(branch) ?? null;
      const status = worktreePath
        ? await this.getWorktreeStatus(worktreePath)
        : { is_dirty: false, diff_stat: null, known: worktreeInventory.known };
      const defaultComparison = ref.default_comparison;
      const data: BranchData = {
        repo_root: repoRoot,
        branch,
        is_current: currentBranch === branch,
        is_worktree: worktreePath !== null,
        worktree_path: worktreePath,
        is_dirty: status.is_dirty,
        ahead: ref.ahead,
        behind: ref.behind,
        has_upstream: ref.upstream !== null,
        upstream: ref.upstream,
        ahead_default: defaultComparison?.ahead ?? 0,
        behind_default: defaultComparison?.behind ?? 0,
        default_branch: defaultBranch || "—",
        worktree_inventory_known: worktreeInventory.known,
        worktree_status_known: status.known,
        default_comparison_known: defaultComparison !== null,
        last_commit: ref.last_commit,
        last_commit_date: ref.last_commit.date,
        diff_stat: status.diff_stat,
      };
      rows.push({ data, row: branchRow(data, now) });
    }
    if (this.stopped) return { updated: 0, removed: 0 };

    const select = this.db.prepare(`SELECT ${BRANCH_COLUMNS.join(", ")} FROM branches WHERE repo_root = ? AND branch = ?`);
    const upsert = this.db.prepare(`
      INSERT INTO branches (${[...BRANCH_COLUMNS, "updated_at"].join(", ")})
      VALUES (${[...BRANCH_COLUMNS, "updated_at"].map((column) => `@${column}`).join(", ")})
      ON CONFLICT(repo_root, branch) DO UPDATE SET
        ${[...BRANCH_COLUMNS.slice(2), "updated_at"].map((column) => `${column} = excluded.${column}`).join(",\n        ")}
    `);
    const changed: BranchData[] = [];
    let removed = 0;
    this.db.transaction(() => {
      for (const { row, data } of rows) {
        const existing = select.get(repoRoot, row.branch) as Record<string, unknown> | undefined;
        upsert.run(row);
        if (!existing || rowChanged(existing, row)) changed.push(data);
      }
      const names = refs.map((ref) => ref.branch);
      const result = names.length === 0
        ? this.db.prepare("DELETE FROM branches WHERE repo_root = ?").run(repoRoot)
        : this.db.prepare(`DELETE FROM branches WHERE repo_root = ? AND branch NOT IN (${names.map(() => "?").join(",")})`).run(repoRoot, ...names);
      removed = Number(result.changes ?? 0);
    })();
    this.scanSnapshots.set(repoRoot, {
      scannedAt: Date.now(),
      inventory: {
        known: worktreeInventory.known,
        worktrees: worktrees.map((worktree) => ({
          path: worktree.path,
          branch: worktree.branch,
          is_current: pathsReferToSameLocation(worktree.path, repoRoot),
        })),
      },
    });
    for (const data of changed) {
      this.emit({
        event: DOMAIN_EVENTS.WORK_BRANCH_UPDATED,
        type: DOMAIN_EVENTS.WORK_BRANCH_UPDATED,
        data: { ...data, repo_id: repoId },
      });
    }
    return { updated: changed.length, removed };
  }

  private async listWorktrees(repoRoot: string, signal?: AbortSignal): Promise<{ worktrees: WorktreeInfo[]; known: boolean }> {
    const output = await runGit(["worktree", "list", "--porcelain"], {
      cwd: repoRoot,
      signal: signal ? AbortSignal.any([signal, this.scanAbort.signal]) : this.scanAbort.signal,

    });
    if (output === null) {
      return { worktrees: [], known: false };
    }
    return { worktrees: parseWorktreeList(output), known: true };
  }

  private async getWorktreeStatus(
    worktreePath: string,
  ): Promise<{ is_dirty: boolean; diff_stat: string | null; known: boolean }> {
    const output = await runGit([
      "status", "--porcelain", "--untracked-files=all", "--ignore-submodules=none",
    ], {
      cwd: worktreePath,
      signal: this.scanAbort.signal,

    });
    if (output === null) {
      return { is_dirty: true, diff_stat: null, known: false };
    }
    const isDirty = output.trim().length > 0;
    if (!isDirty) {
      return { is_dirty: false, diff_stat: null, known: true };
    }
    const diffStat = await runGit(["diff", "--stat"], {
      cwd: worktreePath,
      signal: this.scanAbort.signal,

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

  private async getCherryStatus(
    repoRoot: string,
    defaultBranch: string,
    branch: string,
  ): Promise<Map<string, WorkCommitClassification>> {
    const statusByHash = new Map<string, WorkCommitClassification>();
    if (!defaultBranch || defaultBranch === branch) {
      return statusByHash;
    }
    const output = await runGit(["cherry", localBranchRef(defaultBranch), localBranchRef(branch)], {
      cwd: repoRoot,
      signal: this.scanAbort.signal,

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

  private async classifyCommit(
    repoRoot: string,
    hash: string,
    mergeBase: string | null,
    cherryStatus: Map<string, WorkCommitClassification>,
  ): Promise<WorkCommitClassification> {
    const cherryClassification = cherryStatus.get(hash);
    if (cherryClassification === "merged-elsewhere") {
      return cherryClassification;
    }
    if (mergeBase) {
      const ancestor = await runGit(["merge-base", "--is-ancestor", hash, mergeBase], { cwd: repoRoot, absent_exit_codes: [1], signal: this.scanAbort.signal });
      if (ancestor !== null) {
        return "pre-branch-point";
      }
    }
    return "unique";
  }

  private async detectDefaultBranch(repoRoot: string): Promise<string> {
    const candidates = ["main", "develop"];
    for (const candidate of candidates) {
      if (this.stopped) return "";
      const result = await runGit(["rev-parse", "--verify", "--quiet", `refs/heads/${candidate}^{commit}`], { cwd: repoRoot, signal: this.scanAbort.signal, absent_exit_codes: [1] });
      if (result !== null) {
        return candidate;
      }
    }
    return "";
  }
}
