import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Db } from "../db.js";
import { notifyProtectionInputsChanged } from "../protection-inputs.js";
import { tableExists } from "../db-introspection.js";
import { createLedgerId } from "./ids.js";
import { deriveProjectKeyBase, dedupeProjectKey, slugifyProjectKey } from "./project-key.js";
import { canonicalizeCheckoutWorkRepoId, normalizeRemoteIdentity } from "./projects.js";
import type { LedgerNamespacePolicy, LedgerProject, LedgerProjectCheckout } from "./types.js";

export { deriveProjectKeyBase, slugifyProjectKey } from "./project-key.js";

// Issue: 3d85f43 (umbrella ce690eb) — canonical project registry.
//
// This module is the single resolution surface between the canonical project
// namespace (ledger_projects) and the path-derived WorkScanner ids
// (ledger_project_checkouts.work_repo_id). `project_key` is the stable,
// human-meaningful slug that is independent of the free-text display name AND of
// the path-derived WorkScanner id. WorkScanner ids are treated as LOCAL
// DISCOVERY METADATA ONLY and never become the canonical project identity here.

export interface RegistryCheckout {
  id: string;
  project_id: string;
  work_repo_id: string | null;
  root: string;
  name: string;
  default_branch: string;
  remote_url: string;
}

export interface RegistryProject {
  id: string;
  project_key: string;
  display_name: string;
  remote_identity: string;
  upstream_identity: string;
  namespace_policy: LedgerNamespacePolicy;
  created_at: number;
  updated_at: number;
  checkouts: RegistryCheckout[];
  open_issue_count: number;
  closed_issue_count: number;
  issue_count: number;
}

interface ProjectRow extends LedgerProject {
  project_key: string;
}

// ---------------------------------------------------------------------------
// Key derivation (pure helpers live in ./project-key.ts and are re-exported)
// ---------------------------------------------------------------------------

function projectKeyColumnExists(db: Db): boolean {
  const columns = db.prepare("PRAGMA table_info(ledger_projects)").all() as Array<{ name: string }>;
  return columns.some((column) => column.name === "project_key");
}

function representativeCheckoutRoot(db: Db, projectId: string): string | null {
  if (!tableExists(db, "ledger_project_checkouts")) return null;
  const row = db
    .prepare(
      `SELECT root FROM ledger_project_checkouts
       WHERE project_id = ?
       ORDER BY updated_at DESC, root
       LIMIT 1`,
    )
    .get(projectId) as { root: string } | undefined;
  return row?.root ?? null;
}

/**
 * Backfill deterministic, collision-free `project_key` slugs for every
 * ledger_projects row still missing one. Idempotent: rows that already have a
 * key are left untouched and contribute to the taken-set. Ordered by created_at
 * so the assignment is stable across runs.
 */
export function backfillProjectKeys(db: Db): number {
  if (!projectKeyColumnExists(db)) return 0;
  const taken = new Set<string>(
    (db.prepare("SELECT project_key FROM ledger_projects WHERE project_key != ''").all() as Array<{
      project_key: string;
    }>).map((row) => row.project_key),
  );
  const missing = db
    .prepare(
      `SELECT id, display_name, remote_identity
       FROM ledger_projects
       WHERE project_key = ''
       ORDER BY created_at, id`,
    )
    .all() as Array<{ id: string; display_name: string; remote_identity: string }>;
  if (missing.length === 0) return 0;

  const update = db.prepare("UPDATE ledger_projects SET project_key = ?, updated_at = ? WHERE id = ?");
  const now = Date.now();
  const run = db.transaction(() => {
    for (const project of missing) {
      const base =
        deriveProjectKeyBase({
          remote_identity: project.remote_identity,
          display_name: project.display_name,
          root: representativeCheckoutRoot(db, project.id),
        }) || "project";
      const key = dedupeProjectKey(base, taken);
      taken.add(key);
      update.run(key, now, project.id);
    }
  });
  run();
  return missing.length;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

function mapCheckouts(db: Db, projectId: string): RegistryCheckout[] {
  return (
    db
      .prepare(
        `SELECT id, project_id, work_repo_id, root, name, default_branch, remote_url
         FROM ledger_project_checkouts
         WHERE project_id = ?
         ORDER BY updated_at DESC, root`,
      )
      .all(projectId) as RegistryCheckout[]
  );
}

function issueCounts(db: Db, projectId: string): { open: number; closed: number } {
  const row = db
    .prepare(
      `SELECT
         SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) AS open_count,
         SUM(CASE WHEN status = 'closed' THEN 1 ELSE 0 END) AS closed_count
       FROM ledger_issues
       WHERE project_id = ? AND deleted_at IS NULL`,
    )
    .get(projectId) as { open_count: number | null; closed_count: number | null } | undefined;
  return { open: row?.open_count ?? 0, closed: row?.closed_count ?? 0 };
}

function toRegistryProject(db: Db, row: ProjectRow): RegistryProject {
  const counts = issueCounts(db, row.id);
  return {
    id: row.id,
    project_key: row.project_key ?? "",
    display_name: row.display_name,
    remote_identity: row.remote_identity,
    upstream_identity: row.upstream_identity,
    namespace_policy: row.namespace_policy,
    created_at: row.created_at,
    updated_at: row.updated_at,
    checkouts: mapCheckouts(db, row.id),
    open_issue_count: counts.open,
    closed_issue_count: counts.closed,
    issue_count: counts.open + counts.closed,
  };
}

export function listProjects(db: Db): RegistryProject[] {
  const rows = db
    .prepare(
      `SELECT id, project_key, display_name, remote_identity, upstream_identity,
              namespace_policy, created_at, updated_at
       FROM ledger_projects
       ORDER BY project_key, display_name, id`,
    )
    .all() as ProjectRow[];
  return rows.map((row) => toRegistryProject(db, row));
}

function getProjectRowById(db: Db, id: string): ProjectRow | undefined {
  return db
    .prepare(
      `SELECT id, project_key, display_name, remote_identity, upstream_identity,
              namespace_policy, created_at, updated_at
       FROM ledger_projects WHERE id = ?`,
    )
    .get(id) as ProjectRow | undefined;
}

export type ProjectRefMatch =
  | "id"
  | "checkout_id"
  | "project_key"
  | "work_repo_id"
  | "checkout_name"
  | "remote_identity"
  | "display_name"
  | "checkout_root"
  | "git_common_dir"
  | "git_remote"
  | "checkout_ancestry";

/**
 * `checkout` is the registered checkout the ref named or contains it, and is
 * null when the ref named the project itself.
 */
export type ProjectRefResolution =
  | { ok: true; project: RegistryProject; checkout: RegistryCheckout | null; matched_by: ProjectRefMatch }
  | { ok: false; reason: "unknown" }
  | { ok: false; reason: "ambiguous"; candidates: string[] };

interface RefRow {
  project_id: string;
  project_key: string;
  display_name: string;
  remote_identity: string;
  upstream_identity: string;
  checkout_id: string | null;
  work_repo_id: string | null;
  root: string | null;
  checkout_name: string | null;
  remote_url: string | null;
}

function refRows(db: Db): RefRow[] {
  return db.prepare(
    `SELECT p.id AS project_id, p.project_key, p.display_name, p.remote_identity, p.upstream_identity,
            c.id AS checkout_id, c.work_repo_id, c.root, c.name AS checkout_name, c.remote_url
       FROM ledger_projects p
       LEFT JOIN ledger_project_checkouts c ON c.project_id = p.id
      ORDER BY c.updated_at DESC, c.root, p.id`,
  ).all() as RefRow[];
}

function settle(db: Db, rows: RefRow[], matchedBy: ProjectRefMatch, checkoutLevel: boolean): ProjectRefResolution | null {
  const byProject = new Map<string, RefRow>();
  for (const row of rows) if (!byProject.has(row.project_id)) byProject.set(row.project_id, row);
  if (byProject.size === 0) return null;
  if (byProject.size > 1) {
    return {
      ok: false,
      reason: "ambiguous",
      candidates: [...byProject.values()].map((row) => row.project_key || row.project_id).sort(),
    };
  }
  const row = byProject.values().next().value!;
  const project = toRegistryProject(db, getProjectRowById(db, row.project_id)!);
  const checkout = checkoutLevel ? project.checkouts.find((entry) => entry.id === row.checkout_id) ?? null : null;
  return { ok: true, project, checkout, matched_by: matchedBy };
}

function runGit(cwd: string, args: string[]): string | null {
  try {
    return execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      timeout: 15_000,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

interface GitPathEvidence {
  at: number;
  /** Every working tree of the repository containing the path, main checkout included. */
  worktrees: Set<string>;
  origin: string;
}

// A path's repository identity is stable; the TTL only bounds git spawn cost
// for callers that resolve the same path in a loop.
const GIT_EVIDENCE_TTL_MS = 60_000;
const gitEvidenceCache = new Map<string, GitPathEvidence>();

function gitPathEvidence(target: string): GitPathEvidence {
  const now = Date.now();
  const cached = gitEvidenceCache.get(target);
  if (cached && now - cached.at < GIT_EVIDENCE_TTL_MS) return cached;
  // Ask only the requested repository; probing registered checkouts would let
  // an unrelated mount or OS access gate block resolution.
  const listing = runGit(target, ["worktree", "list", "--porcelain", "-z"]);
  const worktrees = new Set((listing ?? "").split("\0")
    .filter((field) => field.startsWith("worktree "))
    .map((field) => path.resolve(field.slice("worktree ".length))));
  if (listing) {
    // Bare or separate Git directories list the object store as their main
    // path, which is not a checkout; an explicit core.worktree names the real one.
    const common = runGit(target, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    if (common) worktrees.delete(path.resolve(common));
    const main = runGit(target, ["config", "--path", "--get", "core.worktree"]);
    if (main && common) worktrees.add(path.resolve(common, main));
  }
  const origin = listing ? normalizeRemoteIdentity(runGit(target, ["remote", "get-url", "origin"])) : "";
  const evidence = { at: now, worktrees, origin };
  gitEvidenceCache.set(target, evidence);
  return evidence;
}

function isPathInside(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function safeRealpath(target: string): string {
  try {
    return fs.realpathSync(target);
  } catch {
    return path.resolve(target);
  }
}

/**
 * Symlink evidence for the requested paths only: the primary path and its
 * realpath identify the target, and every ancestor's realpath is a prefix
 * alias. Registered roots are never realpath'd, so an unrelated registered
 * mount cannot block resolution.
 */
function requestedPathEvidence(paths: string[]): { targets: Set<string>; canonicalize: (root: string) => string } {
  const targets = new Set<string>();
  const aliases = new Map<string, string>();
  const realPaths = new Map<string, string>();
  for (const [index, entry] of paths.entries()) {
    const resolved = path.resolve(entry);
    for (let ancestor = resolved; !realPaths.has(ancestor); ancestor = path.dirname(ancestor)) {
      const real = safeRealpath(ancestor);
      realPaths.set(ancestor, real);
      if (real !== ancestor) aliases.set(ancestor, real);
      if (ancestor === path.dirname(ancestor)) break;
    }
    if (index === 0) targets.add(resolved).add(realPaths.get(resolved)!);
  }
  const prefixes = [...aliases].sort(([a], [b]) => b.length - a.length);
  return {
    targets,
    canonicalize(root) {
      const resolved = path.resolve(root);
      const alias = prefixes.find(([prefix]) => isPathInside(resolved, prefix));
      return alias ? path.resolve(alias[1], path.relative(alias[0], resolved)) : resolved;
    },
  };
}

function resolveProjectPath(db: Db, rows: RefRow[], target: string, observedPath?: string): ProjectRefResolution | null {
  const checkouts = rows.filter((row) => row.root);
  const evidence = requestedPathEvidence(observedPath ? [target, observedPath] : [target]);
  const exact = checkouts.filter((row) => evidence.targets.has(evidence.canonicalize(row.root!)));
  const exactResolution = settle(db, exact, "checkout_root", true);
  if (exactResolution) return exactResolution;

  const { worktrees, origin } = gitPathEvidence(target);
  const sameRepo = checkouts.filter((row) => worktrees.has(evidence.canonicalize(row.root!)));
  const sameRepoResolution = settle(db, sameRepo, "git_common_dir", true);
  if (sameRepoResolution) return sameRepoResolution;

  if (origin) {
    const sameRemote = rows.filter((row) =>
      [row.remote_identity, row.upstream_identity, row.remote_url]
        .some((value) => normalizeRemoteIdentity(value) === origin));
    const remoteResolution = settle(db, sameRemote, "git_remote", true);
    if (remoteResolution) return remoteResolution;
  }

  const containing = checkouts
    .map((row) => ({ row, root: evidence.canonicalize(row.root!) }))
    .filter(({ root }) => [...evidence.targets].some((requested) => isPathInside(requested, root)));
  const deepest = Math.max(...containing.map(({ root }) => root.length));
  return settle(db, containing.filter(({ root }) => root.length === deepest).map(({ row }) => row), "checkout_ancestry", true);
}

/**
 * The one resolver from a project reference to a registered project. A ref
 * resolves to exactly one project or is refused as unknown or ambiguous; at
 * each tier, a ref naming several projects is refused rather than passed to a
 * weaker tier.
 *
 * An absolute path resolves through the checkout it names or lies in: an
 * exact registered root, any working tree of a registered checkout's Git
 * repository (linked worktrees included), a clone of a registered remote, and
 * finally the deepest registered root containing it. `observedPath` supplies
 * extra symlink evidence for a path the caller reached through an alias.
 *
 * Any other ref is tried, in order, as a project or checkout id, project key,
 * WorkScanner repo id, checkout name, remote identity, and display name. Keys,
 * names, and display names compare case-insensitively.
 */
export function resolveProjectRef(
  db: Db,
  ref: string | null | undefined,
  options: { observedPath?: string } = {},
): ProjectRefResolution {
  const trimmed = ref?.trim() ?? "";
  if (!trimmed) return { ok: false, reason: "unknown" };
  const rows = refRows(db);
  if (path.isAbsolute(trimmed)) {
    return resolveProjectPath(db, rows, trimmed, options.observedPath) ?? { ok: false, reason: "unknown" };
  }
  const folded = trimmed.toLowerCase();
  const remote = normalizeRemoteIdentity(trimmed);
  const tiers: Array<[ProjectRefMatch, boolean, (row: RefRow) => boolean]> = [
    ["id", false, (row) => row.project_id === trimmed],
    ["checkout_id", true, (row) => row.checkout_id === trimmed],
    ["project_key", false, (row) => row.project_key !== "" && row.project_key.toLowerCase() === folded],
    ["work_repo_id", true, (row) => row.work_repo_id === trimmed],
    ["checkout_name", true, (row) => row.checkout_name?.toLowerCase() === folded],
    ["remote_identity", false, (row) => remote !== "" &&
      [row.remote_identity, row.upstream_identity].includes(remote)],
    ["remote_identity", true, (row) => remote !== "" && normalizeRemoteIdentity(row.remote_url) === remote],
    ["display_name", false, (row) => row.display_name.toLowerCase() === folded],
  ];
  for (const [matchedBy, checkoutLevel, matches] of tiers) {
    const resolution = settle(db, rows.filter(matches), matchedBy, checkoutLevel);
    if (resolution) return resolution;
  }
  return { ok: false, reason: "unknown" };
}

/** Resolve every ref to its project; any unresolved ref fails the whole set. */
export function resolveProjectIds(db: Db, refs: string[]): Set<string> {
  const projectIds = new Set<string>();
  for (const ref of refs) {
    const resolved = resolveProjectRef(db, ref);
    if (!resolved.ok) throw new Error(`Unable to resolve ledger project ref '${ref}': ${resolved.reason}`);
    projectIds.add(resolved.project.id);
  }
  return projectIds;
}

/** A registered ref's canonical project key, or the ref itself for an unregistered repo. */
export function normalizeProjectRepoId(db: Db, ref: string): string {
  const resolved = resolveProjectRef(db, ref);
  return resolved.ok ? resolved.project.project_key : ref.trim();
}

/** Near-match project keys/display names for unknown-ref error help. */
export function suggestProjectRefs(db: Db, ref: string, limit = 5): string[] {
  const needle = slugifyProjectKey(ref);
  const rows = db
    .prepare("SELECT project_key, display_name FROM ledger_projects WHERE project_key != ''")
    .all() as Array<{ project_key: string; display_name: string }>;
  const scored = rows
    .map((row) => {
      const key = row.project_key;
      let score = 0;
      if (needle && key.includes(needle)) score += 3;
      if (needle && needle.includes(key)) score += 2;
      if (needle && key.startsWith(needle.slice(0, 3))) score += 1;
      return { key, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.key.localeCompare(b.key))
    .map((entry) => entry.key);
  if (scored.length > 0) return scored.slice(0, limit);
  // No fuzzy hits — return the alphabetically-first keys as a directory.
  return rows
    .map((row) => row.project_key)
    .sort((a, b) => a.localeCompare(b))
    .slice(0, limit);
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export interface AddOrUpdateProjectInput {
  project_key?: string;
  display_name?: string;
  remote_identity?: string | null;
  upstream_identity?: string | null;
  namespace_policy?: LedgerNamespacePolicy;
}

export class ProjectRegistryError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ProjectRegistryError";
  }
}

function takenKeys(db: Db, excludeId?: string): Set<string> {
  const rows = db
    .prepare("SELECT id, project_key FROM ledger_projects WHERE project_key != ''")
    .all() as Array<{ id: string; project_key: string }>;
  return new Set(rows.filter((row) => row.id !== excludeId).map((row) => row.project_key));
}

/** Intentionally create a canonical project. The key is required (explicit). */
export function addProject(db: Db, input: AddOrUpdateProjectInput, now = Date.now()): RegistryProject {
  const rawKey = slugifyProjectKey(input.project_key);
  if (!rawKey) {
    throw new ProjectRegistryError("project_key is required", "missing_key");
  }
  if (takenKeys(db).has(rawKey)) {
    throw new ProjectRegistryError(`project_key already in use: ${rawKey}`, "key_conflict", {
      project_key: rawKey,
    });
  }
  const remoteIdentity = normalizeRemoteIdentity(input.remote_identity);
  if (remoteIdentity) {
    const existing = db
      .prepare("SELECT id FROM ledger_projects WHERE remote_identity = ? AND remote_identity != ''")
      .get(remoteIdentity) as { id: string } | undefined;
    if (existing) {
      throw new ProjectRegistryError(
        `remote identity already registered: ${remoteIdentity}`,
        "remote_conflict",
        { remote_identity: remoteIdentity, project_id: existing.id },
      );
    }
  }
  const upstreamIdentity = normalizeRemoteIdentity(input.upstream_identity);
  const policy: LedgerNamespacePolicy =
    input.namespace_policy ?? (remoteIdentity ? "remote" : "local");
  const id = createLedgerId("prj", { now });
  db.prepare(
    `INSERT INTO ledger_projects (
       id, project_key, display_name, remote_identity, upstream_identity,
       namespace_policy, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    rawKey,
    input.display_name?.trim() || rawKey,
    remoteIdentity,
    upstreamIdentity,
    policy,
    now,
    now,
  );
  return toRegistryProject(db, getProjectRowById(db, id)!);
}

/** Update an existing project's key/display/remote/namespace. */
export function updateProject(
  db: Db,
  ref: string,
  input: AddOrUpdateProjectInput,
  now = Date.now(),
): RegistryProject {
  const resolved = resolveProjectRef(db, ref);
  if (!resolved.ok) {
    throw new ProjectRegistryError(`project not found: ${ref}`, "not_found", {
      suggestions: suggestProjectRefs(db, ref),
    });
  }
  const project = resolved.project;
  const fields: string[] = [];
  const values: unknown[] = [];

  if (input.project_key !== undefined) {
    const key = slugifyProjectKey(input.project_key);
    if (!key) throw new ProjectRegistryError("project_key cannot be empty", "missing_key");
    if (key !== project.project_key && takenKeys(db, project.id).has(key)) {
      throw new ProjectRegistryError(`project_key already in use: ${key}`, "key_conflict", {
        project_key: key,
      });
    }
    fields.push("project_key = ?");
    values.push(key);
  }
  if (input.display_name !== undefined) {
    fields.push("display_name = ?");
    values.push(input.display_name.trim() || project.display_name);
  }
  if (input.remote_identity !== undefined) {
    const identity = normalizeRemoteIdentity(input.remote_identity);
    if (identity && identity !== project.remote_identity) {
      const existing = db
        .prepare(
          "SELECT id FROM ledger_projects WHERE remote_identity = ? AND remote_identity != '' AND id != ?",
        )
        .get(identity, project.id) as { id: string } | undefined;
      if (existing) {
        throw new ProjectRegistryError(
          `remote identity already registered: ${identity}`,
          "remote_conflict",
          { remote_identity: identity, project_id: existing.id },
        );
      }
    }
    fields.push("remote_identity = ?");
    values.push(identity);
  }
  if (input.upstream_identity !== undefined) {
    fields.push("upstream_identity = ?");
    values.push(normalizeRemoteIdentity(input.upstream_identity));
  }
  if (input.namespace_policy !== undefined) {
    fields.push("namespace_policy = ?");
    values.push(input.namespace_policy);
  }
  if (fields.length === 0) return project;
  fields.push("updated_at = ?");
  values.push(now);
  values.push(project.id);
  db.prepare(`UPDATE ledger_projects SET ${fields.join(", ")} WHERE id = ?`).run(...values);
  return toRegistryProject(db, getProjectRowById(db, project.id)!);
}

export interface AddOrUpdateCheckoutInput {
  root: string;
  work_repo_id?: string | null;
  name?: string;
  default_branch?: string;
  remote_url?: string | null;
}

/** Intentionally register or update a checkout for a project. */
export function addOrUpdateCheckout(
  db: Db,
  projectRef: string,
  input: AddOrUpdateCheckoutInput,
  now = Date.now(),
): { project: RegistryProject; checkout: RegistryCheckout } {
  const resolved = resolveProjectRef(db, projectRef);
  if (!resolved.ok) {
    throw new ProjectRegistryError(`project not found: ${projectRef}`, "not_found", {
      suggestions: suggestProjectRefs(db, projectRef),
    });
  }
  const project = resolved.project;
  // Validate the RAW trimmed root before path.resolve — path.resolve("") returns
  // the daemon's cwd, so a blank/whitespace root would silently register the
  // process working directory as a checkout.
  const trimmedRoot = input.root?.trim() ?? "";
  if (!trimmedRoot) throw new ProjectRegistryError("root is required", "missing_root");
  const root = path.resolve(trimmedRoot);

  const existing = db
    .prepare("SELECT * FROM ledger_project_checkouts WHERE root = ?")
    .get(root) as LedgerProjectCheckout | undefined;
  const workRepoId = canonicalizeCheckoutWorkRepoId(
    root,
    project.project_key,
    input.work_repo_id ?? existing?.work_repo_id,
  );

  if (existing) {
    db.prepare(
      `UPDATE ledger_project_checkouts
       SET project_id = ?, work_repo_id = ?, name = ?, default_branch = ?, remote_url = ?, updated_at = ?
       WHERE id = ?`,
    ).run(
      project.id,
      workRepoId,
      input.name?.trim() || existing.name,
      input.default_branch ?? existing.default_branch,
      input.remote_url ?? existing.remote_url,
      now,
      existing.id,
    );
    if ((input.default_branch ?? existing.default_branch) !== existing.default_branch) {
      notifyProtectionInputsChanged("checkout:default_branch");
    }
  } else {
    const id = createLedgerId("chk", { now });
    db.prepare(
      `INSERT INTO ledger_project_checkouts (
         id, project_id, work_repo_id, root, name, default_branch, remote_url, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      project.id,
      workRepoId,
      root,
      input.name?.trim() || project.display_name,
      input.default_branch ?? "",
      input.remote_url ?? "",
      now,
      now,
    );
    notifyProtectionInputsChanged("checkout:add");
  }
  const checkout = db
    .prepare(
      `SELECT id, project_id, work_repo_id, root, name, default_branch, remote_url
       FROM ledger_project_checkouts WHERE root = ?`,
    )
    .get(root) as RegistryCheckout;
  return { project: toRegistryProject(db, getProjectRowById(db, project.id)!), checkout };
}

// ---------------------------------------------------------------------------
// Audit (read-only)
// ---------------------------------------------------------------------------

export interface RegistryAudit {
  duplicate_display_names: Array<{ display_name: string; project_keys: string[] }>;
  local_projects: Array<{ project_key: string; display_name: string; remote_identity: string }>;
  numbered_repo_ids: Array<{ project_key: string; work_repo_id: string; root: string }>;
  ambiguous_roots: Array<{ root: string; project_keys: string[] }>;
  missing_keys: Array<{ id: string; display_name: string }>;
  // Local projects that share a display name with EXACTLY ONE remote-backed
  // project — safe consolidation candidates (e.g. sandbox-mount copies of a
  // real repo). The suggested `merge_into` target is the remote-backed project.
  mergeable_local_projects: Array<{
    project_key: string;
    display_name: string;
    merge_into: string;
  }>;
  // Local projects that CANNOT be safely auto-merged: their display name maps
  // to zero remote-backed projects (purely local) or to more than one (target
  // is ambiguous). The operator must decide explicitly.
  unmergeable_local_projects: Array<{
    project_key: string;
    reason: string;
  }>;
}

const NUMBERED_REPO_ID = /(^\d+-)|(-\d+$)/;

// Issue 70cf59d — normalize a display name for duplicate detection so that
// case-only and leading-dot-only differences collapse together. This makes
// `HumbleB`/`humbleb` and `.dotfiles`/`dotfiles` (the sandbox-mount duplicate
// shapes) group as duplicates / mergeable candidates instead of being missed by
// an exact-string GROUP BY. This is DETECTION-ONLY normalization: it never
// rewrites a stored display name and is not used by the merge/repair machinery.
function normalizeDisplayNameForDuplicateDetection(name: string): string {
  return (name ?? "").trim().replace(/^\.+/, "").toLowerCase();
}

export function auditRegistry(db: Db): RegistryAudit {
  // Group display names case-insensitively and leading-dot-insensitively. The
  // reported `display_name` is the lexicographically-first literal variant in
  // each group, and `project_keys` falls back to the project id when a row has
  // no key (preserving the previous GROUP_CONCAT(COALESCE(...)) behavior).
  const allProjectRows = db
    .prepare(
      `SELECT id, project_key, display_name, remote_identity, namespace_policy
       FROM ledger_projects
       ORDER BY display_name, project_key, id`,
    )
    .all() as Array<{
      id: string;
      project_key: string;
      display_name: string;
      remote_identity: string;
      namespace_policy: LedgerNamespacePolicy;
    }>;

  const groupedByDisplay = new Map<string, { display_name: string; keys: string[] }>();
  for (const row of allProjectRows) {
    const norm = normalizeDisplayNameForDuplicateDetection(row.display_name);
    if (!norm) continue;
    const key = row.project_key || row.id;
    const existing = groupedByDisplay.get(norm);
    if (existing) {
      existing.keys.push(key);
    } else {
      groupedByDisplay.set(norm, { display_name: row.display_name, keys: [key] });
    }
  }
  const duplicateDisplay = Array.from(groupedByDisplay.values())
    .filter((group) => group.keys.length > 1)
    .sort((a, b) => a.display_name.localeCompare(b.display_name))
    .map((group) => ({ display_name: group.display_name, keys: group.keys.join(",") }));
  const duplicateNorms = new Set(
    Array.from(groupedByDisplay.entries())
      .filter(([, group]) => group.keys.length > 1)
      .map(([norm]) => norm),
  );

  const localProjects = db
    .prepare(
      `SELECT project_key, display_name, remote_identity
       FROM ledger_projects
       WHERE namespace_policy = 'local' OR remote_identity = '' OR remote_identity LIKE 'local:%'
       ORDER BY project_key, display_name`,
    )
    .all() as Array<{ project_key: string; display_name: string; remote_identity: string }>;

  const checkoutRows = db
    .prepare(
      `SELECT c.work_repo_id, c.root, p.project_key, p.id AS project_id
       FROM ledger_project_checkouts c
       JOIN ledger_projects p ON p.id = c.project_id`,
    )
    .all() as Array<{
      work_repo_id: string | null;
      root: string;
      project_key: string;
      project_id: string;
    }>;
  const numberedRepoIds = checkoutRows
    .filter((row) => row.work_repo_id && NUMBERED_REPO_ID.test(row.work_repo_id))
    .map((row) => ({
      project_key: row.project_key || row.project_id,
      work_repo_id: row.work_repo_id as string,
      root: row.root,
    }));

  const rootMap = new Map<string, Set<string>>();
  for (const row of checkoutRows) {
    const set = rootMap.get(row.root) ?? new Set<string>();
    set.add(row.project_key || row.project_id);
    rootMap.set(row.root, set);
  }
  const ambiguousRoots = Array.from(rootMap.entries())
    .filter(([, keys]) => keys.size > 1)
    .map(([root, keys]) => ({ root, project_keys: Array.from(keys).sort() }));

  const missingKeys = db
    .prepare("SELECT id, display_name FROM ledger_projects WHERE project_key = '' ORDER BY created_at, id")
    .all() as Array<{ id: string; display_name: string }>;

  // Classify each local project by how many remote-backed projects share its
  // (normalized) display name: exactly one => a safe consolidation target; zero
  // or many => not safely auto-mergeable (operator must decide). Matching uses
  // the same case-/leading-dot-insensitive normalization as duplicate detection
  // so a local `humbleb` consolidates into a remote `HumbleB`.
  const remoteByDisplay = new Map<string, string[]>();
  for (const row of allProjectRows) {
    const isLocal =
      row.namespace_policy === "local" ||
      row.remote_identity === "" ||
      row.remote_identity.startsWith("local:");
    if (isLocal) continue;
    const norm = normalizeDisplayNameForDuplicateDetection(row.display_name);
    const keys = remoteByDisplay.get(norm) ?? [];
    keys.push(row.project_key);
    remoteByDisplay.set(norm, keys);
  }
  const localSet = new Set(localProjects.map((row) => row.project_key));
  const mergeable: RegistryAudit["mergeable_local_projects"] = [];
  const unmergeable: RegistryAudit["unmergeable_local_projects"] = [];
  // Only local projects whose display name is SHARED look like duplicates worth
  // consolidating; a unique-named local project is a legitimate project, not a
  // merge candidate, and is not flagged.
  for (const row of localProjects) {
    const norm = normalizeDisplayNameForDuplicateDetection(row.display_name);
    if (!duplicateNorms.has(norm)) continue;
    // A target sharing the display name that is itself local does not count.
    const remoteTargets = (remoteByDisplay.get(norm) ?? []).filter(
      (key) => key !== row.project_key && !localSet.has(key),
    );
    if (remoteTargets.length === 1) {
      mergeable.push({
        project_key: row.project_key,
        display_name: row.display_name,
        merge_into: remoteTargets[0],
      });
    } else if (remoteTargets.length > 1) {
      unmergeable.push({
        project_key: row.project_key,
        reason: `display name "${row.display_name}" maps to ${remoteTargets.length} remote projects; target is ambiguous`,
      });
    } else {
      unmergeable.push({
        project_key: row.project_key,
        reason: `display name "${row.display_name}" has no remote-backed project to merge into`,
      });
    }
  }

  return {
    duplicate_display_names: duplicateDisplay.map((row) => ({
      display_name: row.display_name,
      project_keys: row.keys.split(","),
    })),
    local_projects: localProjects,
    numbered_repo_ids: numberedRepoIds,
    ambiguous_roots: ambiguousRoots,
    missing_keys: missingKeys,
    mergeable_local_projects: mergeable,
    unmergeable_local_projects: unmergeable,
  };
}

// ---------------------------------------------------------------------------
// Repair (guarded)
// ---------------------------------------------------------------------------

// (table, column) pairs that carry a project id and MUST be repointed on merge.
// This is the authoritative list — every project-id-bearing column in the schema
// is either here or in HISTORICAL_PROJECT_ID_COLUMNS below; the schema-audit test
// (test/project-registry.test.ts) enumerates the live schema and fails if a
// future table adds a project-id column that is in neither list. Columns with a
// real `REFERENCES ledger_projects(id) ON DELETE RESTRICT` FK (ledger_issues,
// ledger_issue_aliases, ledger_body_revisions, ledger_relationship_edges,
// ledger_project_checkouts, ledger_commit_issue_links, spaces) would otherwise
// THROW at the source-project delete; the non-FK ones
// (ledger_reconciliation_mismatches) would silently dangle. Moving them all keeps
// the merge orphan-free and FK-clean.
export const PROJECT_ID_COLUMNS: ReadonlyArray<{ table: string; columns: string[] }> = [
  { table: "ledger_issues", columns: ["project_id"] },
  { table: "ledger_issue_aliases", columns: ["project_id"] },
  { table: "ledger_body_revisions", columns: ["project_id"] },
  { table: "ledger_relationship_edges", columns: ["source_project_id", "target_project_id"] },
  { table: "ledger_commit_issue_links", columns: ["project_id"] },
  { table: "ledger_reconciliation_mismatches", columns: ["project_id"] },
  { table: "ledger_project_checkouts", columns: ["project_id"] },
  { table: "artifact", columns: ["source_project_id"] },
  { table: "artifact_version", columns: ["source_project_id"] },
  { table: "project_artifact_associations", columns: ["project_id"] },
  { table: "spaces", columns: ["project_id"] },
  { table: "trash_entries", columns: ["project_id"] },
  { table: "auth_request_merge_succeeded_facts", columns: ["project_id"] },
  { table: "managed_tasks", columns: ["project_id"] },
  { table: "managed_task_events", columns: ["project_id"] },
  { table: "ledger_change_feed_state", columns: ["project_id"] },
  { table: "ledger_change_log", columns: ["project_id"] },
  { table: "conversation_spawn_requests", columns: ["project_id"] },
  { table: "briefing_destination_mutations", columns: ["project_id"] },
];

const PROJECT_MERGE_SPECIAL_TABLES = new Set([
  "ledger_change_feed_state",
  "ledger_change_log",
]);

// Project-id-bearing columns that are DELIBERATELY not repointed on merge: the
// row is immutable provenance whose project id is part of the record. Such a row
// pins its project, so a source project that any of them references cannot be
// merged away; detectMergeConflicts reports it and force does not override it.
// Merge clearances are immutable scoped authority (auth_clearances_scope_immutable)
// and cannot be deleted, so re-scoping one to another project is refused.
export const HISTORICAL_PROJECT_ID_COLUMNS: ReadonlyArray<{ table: string; column: string }> = [
  { table: "auth_clearances", column: "project_id" },
];

const PROJECT_ID_COLUMN_NAMES = new Set(["project_id", "source_project_id", "target_project_id"]);

/**
 * Enumerate every (table, column) in the LIVE schema whose column name is a
 * project-id column (`project_id`, `source_project_id`, `target_project_id`).
 * Used by the schema-audit test to prove the merge move list stays exhaustive as
 * the schema grows. Excludes SQLite internal and temp rebuild tables.
 */
export function discoverProjectIdColumns(db: Db): Array<{ table: string; column: string }> {
  const tables = db
    .prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%_v'`,
    )
    .all() as Array<{ name: string }>;
  const found: Array<{ table: string; column: string }> = [];
  for (const { name } of tables) {
    const columns = db.prepare(`PRAGMA table_info(${name})`).all() as Array<{ name: string }>;
    for (const col of columns) {
      if (PROJECT_ID_COLUMN_NAMES.has(col.name)) found.push({ table: name, column: col.name });
    }
  }
  return found;
}

function tableHasColumn(db: Db, table: string, column: string): boolean {
  if (!tableExists(db, table)) return false;
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return columns.some((c) => c.name === column);
}

export interface MergeConflict {
  kind: "short_id" | "alias" | "historical_reference";
  value: string;
  detail?: string;
}

export interface MergePlan {
  source_project_id: string;
  target_project_id: string;
  moves: Array<{ table: string; column: string; rows: number }>;
  conflicts: MergeConflict[];
  applied: boolean;
  foreign_key_violations: number;
}

export interface RepairReport {
  keys_backfilled: number;
  audit: RegistryAudit;
  merge?: MergePlan;
  applied: boolean;
}

function detectMergeConflicts(db: Db, sourceId: string, targetId: string): MergeConflict[] {
  const conflicts: MergeConflict[] = [];
  for (const { table, column } of HISTORICAL_PROJECT_ID_COLUMNS) {
    if (!tableHasColumn(db, table, column)) continue;
    const row = db
      .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`)
      .get(sourceId) as { n: number };
    if (row.n > 0) {
      conflicts.push({
        kind: "historical_reference",
        value: `${table}.${column}`,
        detail: `${row.n} immutable row(s) pin the source project`,
      });
    }
  }
  if (tableExists(db, "ledger_issues")) {
    const shortIdClashes = db
      .prepare(
        `SELECT s.short_id AS value
         FROM ledger_issues s
         JOIN ledger_issues d
           ON d.project_id = ? AND d.short_id = s.short_id AND d.id != s.id
         WHERE s.project_id = ? AND s.short_id != ''`,
      )
      .all(targetId, sourceId) as Array<{ value: string }>;
    for (const row of shortIdClashes) {
      conflicts.push({ kind: "short_id", value: row.value });
    }
  }
  if (tableExists(db, "ledger_issue_aliases")) {
    const aliasClashes = db
      .prepare(
        `SELECT a.alias_kind || ':' || a.alias AS value
         FROM ledger_issue_aliases a
         JOIN ledger_issue_aliases b
           ON b.project_id = ? AND b.alias_kind = a.alias_kind AND b.alias = a.alias
              AND b.issue_id != a.issue_id
         WHERE a.project_id = ?`,
      )
      .all(targetId, sourceId) as Array<{ value: string }>;
    for (const row of aliasClashes) {
      conflicts.push({ kind: "alias", value: row.value });
    }
  }
  return conflicts;
}

function countMoves(db: Db, sourceId: string): Array<{ table: string; column: string; rows: number }> {
  const moves: Array<{ table: string; column: string; rows: number }> = [];
  for (const { table, columns } of PROJECT_ID_COLUMNS) {
    for (const column of columns) {
      if (!tableHasColumn(db, table, column)) continue;
      const row = db
        .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`)
        .get(sourceId) as { n: number };
      if (row.n > 0) moves.push({ table, column, rows: row.n });
    }
  }
  return moves;
}

function mergeLedgerChangeFeed(db: Db, sourceId: string, targetId: string, now: number): void {
  if (!tableExists(db, "ledger_change_feed_state") || !tableExists(db, "ledger_change_log")) return;
  const readState = db.prepare(
    `SELECT next_sequence, retained_from_sequence
       FROM ledger_change_feed_state WHERE project_id = ?`,
  );
  const readRows = db.prepare(
    `SELECT sequence, event_id FROM ledger_change_log
      WHERE project_id = ? ORDER BY sequence`,
  );
  const sourceState = readState.get(sourceId) as
    | { next_sequence: number; retained_from_sequence: number }
    | undefined;
  const targetState = readState.get(targetId) as
    | { next_sequence: number; retained_from_sequence: number }
    | undefined;
  const sourceRows = readRows.all(sourceId) as Array<{ sequence: number; event_id: string }>;
  const targetRows = readRows.all(targetId) as Array<{ sequence: number; event_id: string }>;

  const assertContiguous = (
    label: string,
    state: { next_sequence: number; retained_from_sequence: number } | undefined,
    rows: Array<{ sequence: number }>,
  ): void => {
    if (!state) {
      if (rows.length > 0) {
        throw new ProjectRegistryError(`${label} change feed has rows without state`, "foreign_key_violation");
      }
      return;
    }
    const expectedCount = state.next_sequence - state.retained_from_sequence;
    if (rows.length !== expectedCount
      || rows.some((row, index) => row.sequence !== state.retained_from_sequence + index)) {
      throw new ProjectRegistryError(`${label} change feed is not contiguous`, "foreign_key_violation");
    }
  };
  assertContiguous("source", sourceState, sourceRows);
  assertContiguous("target", targetState, targetRows);

  const targetNext = targetState?.next_sequence ?? 1;
  const moveRow = db.prepare(
    `UPDATE ledger_change_log SET project_id = ?, sequence = ?
      WHERE project_id = ? AND event_id = ?`,
  );
  sourceRows.forEach((row, index) => {
    moveRow.run(targetId, targetNext + index, sourceId, row.event_id);
  });

  if (sourceState) {
    if (targetState) {
      db.prepare(
        `UPDATE ledger_change_feed_state
            SET next_sequence = ?, updated_at = ?
          WHERE project_id = ?`,
      ).run(targetNext + sourceRows.length, now, targetId);
    } else {
      db.prepare(
        `INSERT INTO ledger_change_feed_state (
           project_id, next_sequence, retained_from_sequence, updated_at
         ) VALUES (?, ?, 1, ?)`,
      ).run(targetId, 1 + sourceRows.length, now);
    }
    db.prepare("DELETE FROM ledger_change_feed_state WHERE project_id = ?").run(sourceId);
  }
}

/**
 * Guarded normalization. Always backfills missing keys (safe). When `merge` is
 * provided, plans (and, with `apply`, executes) moving every project-scoped row
 * from source to target. The merge:
 *   - pre-checks short-id/alias collisions BEFORE moving any rows (aborts with a
 *     report if any are found and `force` is not set),
 *   - runs inside a single transaction with foreign_keys ON,
 *   - runs PRAGMA foreign_key_check after the move and rolls back on any
 *     violation.
 * `apply` defaults to false (dry run).
 */
export function repairRegistry(
  db: Db,
  options: {
    apply?: boolean;
    merge?: { source: string; target: string };
    force?: boolean;
  } = {},
): RepairReport {
  const apply = options.apply ?? false;
  const keysBackfilled = apply ? backfillProjectKeys(db) : 0;

  let merge: MergePlan | undefined;
  if (options.merge) {
    const source = resolveProjectRef(db, options.merge.source);
    const target = resolveProjectRef(db, options.merge.target);
    if (!source.ok) {
      throw new ProjectRegistryError(`merge source not found: ${options.merge.source}`, "not_found");
    }
    if (!target.ok) {
      throw new ProjectRegistryError(`merge target not found: ${options.merge.target}`, "not_found");
    }
    const sourceId = source.project.id;
    const targetId = target.project.id;
    if (sourceId === targetId) {
      throw new ProjectRegistryError("merge source and target are the same project", "same_project");
    }

    const conflicts = detectMergeConflicts(db, sourceId, targetId);
    const moves = countMoves(db, sourceId);
    merge = {
      source_project_id: sourceId,
      target_project_id: targetId,
      moves,
      conflicts,
      applied: false,
      foreign_key_violations: 0,
    };

    if (apply) {
      const pinned = conflicts.filter((conflict) => conflict.kind === "historical_reference");
      if (pinned.length > 0) {
        throw new ProjectRegistryError(
          `merge blocked: immutable rows pin the source project (${pinned.map((c) => c.value).join(", ")})`,
          "merge_conflict",
          { conflicts: pinned },
        );
      }
      if (conflicts.length > 0 && !options.force) {
        throw new ProjectRegistryError(
          `merge blocked by ${conflicts.length} conflict(s); resolve or pass force`,
          "merge_conflict",
          { conflicts },
        );
      }
      const now = Date.now();
      const run = db.transaction(() => {
        db.pragma("foreign_keys = ON");
        mergeLedgerChangeFeed(db, sourceId, targetId, now);
        for (const { table, columns } of PROJECT_ID_COLUMNS) {
          if (PROJECT_MERGE_SPECIAL_TABLES.has(table)) continue;
          for (const column of columns) {
            if (!tableHasColumn(db, table, column)) continue;
            db.prepare(`UPDATE ${table} SET ${column} = ? WHERE ${column} = ?`).run(targetId, sourceId);
          }
        }
        db.prepare("DELETE FROM ledger_projects WHERE id = ?").run(sourceId);
        db.prepare("UPDATE ledger_projects SET updated_at = ? WHERE id = ?").run(now, targetId);
        const violations = db.prepare("PRAGMA foreign_key_check").all() as unknown[];
        if (violations.length > 0) {
          merge!.foreign_key_violations = violations.length;
          throw new ProjectRegistryError(
            `merge rolled back: ${violations.length} foreign-key violation(s)`,
            "foreign_key_violation",
            { violations: violations.length },
          );
        }
      });
      run();
      merge.applied = true;
    }
  }

  return {
    keys_backfilled: keysBackfilled,
    audit: auditRegistry(db),
    merge,
    applied: apply,
  };
}
