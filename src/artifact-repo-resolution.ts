import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Db } from "./db.js";
import { normalizeRemoteIdentity } from "./ledger/projects.js";

type MatchKind = "project_ref" | "checkout_root" | "git_common_dir" | "remote_identity" | "checkout_ancestry";

export interface CanonicalArtifactRepo {
  project_id: string;
  project_key: string;
  checkout_root: string | null;
  checkout_name: string | null;
  default_branch: string | null;
  matched_by: MatchKind;
}

export type CanonicalArtifactRepoResolution =
  | ({ ok: true } & CanonicalArtifactRepo)
  | { ok: false; reason: "unknown_repo" | "ambiguous_repo"; candidates?: string[] };

interface ProjectCheckoutRow {
  project_id: string;
  project_key: string | null;
  display_name: string | null;
  checkout_root: string | null;
  checkout_name: string | null;
  default_branch: string | null;
  work_repo_id: string | null;
  remote_identity: string | null;
  upstream_identity: string | null;
  remote_url: string | null;
}

function tableExists(db: Db, name: string): boolean {
  const row = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
  return Boolean(row);
}

function columnExists(db: Db, table: string, column: string): boolean {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return columns.some((entry) => entry.name === column);
}

function projectKeyExpr(db: Db): string {
  return columnExists(db, "ledger_projects", "project_key") ? "p.project_key" : "''";
}

function canonicalKey(row: ProjectCheckoutRow): string {
  return row.project_key?.trim() || row.display_name?.trim() || row.project_id;
}

function toCanonical(row: ProjectCheckoutRow, matchedBy: MatchKind): CanonicalArtifactRepo {
  return {
    project_id: row.project_id,
    project_key: canonicalKey(row),
    checkout_root: row.checkout_root,
    checkout_name: row.checkout_name,
    default_branch: row.default_branch,
    matched_by: matchedBy,
  };
}

function uniqueResolution(rows: ProjectCheckoutRow[], matchedBy: MatchKind): CanonicalArtifactRepoResolution {
  const byProject = new Map<string, ProjectCheckoutRow>();
  for (const row of rows) {
    if (!byProject.has(row.project_id)) byProject.set(row.project_id, row);
  }
  if (byProject.size === 1) {
    return { ok: true, ...toCanonical(Array.from(byProject.values())[0], matchedBy) };
  }
  if (byProject.size > 1) {
    return {
      ok: false,
      reason: "ambiguous_repo",
      candidates: Array.from(byProject.values()).map(canonicalKey).sort(),
    };
  }
  return { ok: false, reason: "unknown_repo" };
}

function allProjectCheckoutRows(db: Db): ProjectCheckoutRow[] {
  if (!tableExists(db, "ledger_projects")) return [];
  const keyExpr = projectKeyExpr(db);
  const hasCheckouts = tableExists(db, "ledger_project_checkouts");
  const checkoutJoin = hasCheckouts
    ? "LEFT JOIN ledger_project_checkouts c ON c.project_id = p.id"
    : "";
  const checkoutSelect = hasCheckouts
    ? "c.root AS checkout_root, c.name AS checkout_name, c.default_branch, c.work_repo_id, c.remote_url"
    : "NULL AS checkout_root, NULL AS checkout_name, NULL AS default_branch, NULL AS work_repo_id, NULL AS remote_url";
  const orderBy = hasCheckouts ? "c.updated_at DESC, c.root, p.id" : "p.id";
  return db.prepare(
    `SELECT p.id AS project_id, ${keyExpr} AS project_key, p.display_name,
            ${checkoutSelect}, p.remote_identity, p.upstream_identity
       FROM ledger_projects p
       ${checkoutJoin}
      ORDER BY ${orderBy}`,
  ).all() as ProjectCheckoutRow[];
}

function safeRealpath(target: string): string {
  try {
    return fs.realpathSync(target);
  } catch {
    return path.resolve(target);
  }
}

function runGit(cwd: string, args: string[]): string | null {
  try {
    return execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

function gitCommonDir(root: string): string | null {
  const common = runGit(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  return common ? safeRealpath(common) : null;
}

function gitRemoteIdentity(root: string): string {
  return normalizeRemoteIdentity(runGit(root, ["remote", "get-url", "origin"]));
}

function isPathInside(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

export function resolveCanonicalArtifactRepoForRoot(db: Db, root: string): CanonicalArtifactRepoResolution {
  const resolvedRoot = path.resolve(root);
  const realRoot = safeRealpath(resolvedRoot);
  const rows = allProjectCheckoutRows(db);
  if (rows.length === 0) return { ok: false, reason: "unknown_repo" };

  const exact = rows.filter((row) => {
    if (!row.checkout_root) return false;
    const checkoutRoot = path.resolve(row.checkout_root);
    const checkoutReal = safeRealpath(checkoutRoot);
    return checkoutRoot === resolvedRoot || checkoutRoot === realRoot || checkoutReal === realRoot;
  });
  const exactResolution = uniqueResolution(exact, "checkout_root");
  if (exactResolution.ok || exactResolution.reason === "ambiguous_repo") return exactResolution;

  const common = gitCommonDir(resolvedRoot);
  if (common) {
    const commonRows = rows.filter((row) => row.checkout_root && gitCommonDir(row.checkout_root) === common);
    const commonResolution = uniqueResolution(commonRows, "git_common_dir");
    if (commonResolution.ok || commonResolution.reason === "ambiguous_repo") return commonResolution;
  }

  const remoteIdentity = gitRemoteIdentity(resolvedRoot);
  if (remoteIdentity) {
    const remoteRows = rows.filter((row) => {
      const identities = [
        row.remote_identity,
        row.upstream_identity,
        row.remote_url,
      ].map((value) => normalizeRemoteIdentity(value));
      return identities.includes(remoteIdentity);
    });
    const remoteResolution = uniqueResolution(remoteRows, "remote_identity");
    if (remoteResolution.ok || remoteResolution.reason === "ambiguous_repo") return remoteResolution;
  }

  const ancestryRows = rows.filter((row) => {
    if (!row.checkout_root) return false;
    const checkoutReal = safeRealpath(path.resolve(row.checkout_root));
    return isPathInside(realRoot, checkoutReal);
  });
  return uniqueResolution(ancestryRows, "checkout_ancestry");
}

export function resolveCanonicalArtifactRepoRef(db: Db, repoRef: string): CanonicalArtifactRepoResolution {
  const ref = repoRef.trim();
  if (!ref || !tableExists(db, "ledger_projects")) return { ok: false, reason: "unknown_repo" };
  const rows = allProjectCheckoutRows(db);
  const normalizedRemote = normalizeRemoteIdentity(ref);
  const matches = rows.filter((row) => {
    const keys = [
      row.project_id,
      row.project_key,
      row.display_name,
      row.work_repo_id,
      row.checkout_name,
      row.checkout_root,
    ].filter((value): value is string => Boolean(value && value.trim()));
    if (keys.includes(ref)) return true;
    if (normalizedRemote) {
      return [row.remote_identity, row.upstream_identity, row.remote_url]
        .map((value) => normalizeRemoteIdentity(value))
        .includes(normalizedRemote);
    }
    return false;
  });
  return uniqueResolution(matches, "project_ref");
}

export function checkoutRootForCanonicalArtifactRepo(db: Db, repoRef: string): string | null {
  const resolved = resolveCanonicalArtifactRepoRef(db, repoRef);
  if (!resolved.ok) return null;
  if (!tableExists(db, "ledger_project_checkouts")) return null;
  const row = db.prepare(
    `SELECT root
       FROM ledger_project_checkouts
      WHERE project_id = ?
      ORDER BY updated_at DESC, root
      LIMIT 1`,
  ).get(resolved.project_id) as { root: string | null } | undefined;
  return row?.root ?? null;
}
