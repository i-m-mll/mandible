import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { Db } from "./db.js";
import { columnExists, tableExists } from "./db-introspection.js";
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
      timeout: 15_000,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

function gitWorktreeRoots(root: string): Set<string> {
  // Git owns the shared repository identity. Ask only the requested repository;
  // probing registered checkouts would let an unrelated mount or OS access gate
  // block artifact saving on the daemon's main thread.
  const listing = runGit(root, ["worktree", "list", "--porcelain", "-z"]);
  const roots = new Set((listing ?? "").split("\0")
    .filter((field) => field.startsWith("worktree "))
    .map((field) => path.resolve(field.slice("worktree ".length))));
  // A separate Git directory can explicitly record its main working tree.
  // Without that metadata, its unlisted main path cannot be inferred safely.
  if (listing) {
    const common = runGit(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    // Git can list the object directory as its main path for bare or separate
    // Git directories. That is not evidence of a checkout at that path.
    if (common) roots.delete(path.resolve(common));
    const main = runGit(root, ["config", "--path", "--get", "core.worktree"]);
    if (main && common) roots.add(path.resolve(common, main));
  }
  return roots;
}

function gitRemoteIdentity(root: string): string {
  return normalizeRemoteIdentity(runGit(root, ["remote", "get-url", "origin"]));
}

function isPathInside(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

/** The primary root identifies the checkout; additional paths only supply prefix aliases. */
function requestedPathEvidence(roots: string[]): { roots: Set<string>; canonicalize: (root: string) => string } {
  const requested = new Set<string>();
  const aliases = new Map<string, string>();
  const realPaths = new Map<string, string>();
  for (const [index, root] of roots.entries()) {
    const resolved = path.resolve(root);
    if (index === 0) requested.add(resolved);
    // Preserve prefix aliases such as /tmp -> /private/tmp and aliases supplied
    // by the caller. Ancestors belong to this request's filesystem traversal.
    for (let ancestor = resolved; !realPaths.has(ancestor); ancestor = path.dirname(ancestor)) {
      const real = safeRealpath(ancestor);
      realPaths.set(ancestor, real);
      if (real !== ancestor) aliases.set(ancestor, real);
      if (ancestor === path.dirname(ancestor)) break;
    }
    if (index === 0) requested.add(realPaths.get(resolved)!);
  }
  const prefixes = [...aliases].sort(([a], [b]) => b.length - a.length);
  return {
    roots: requested,
    canonicalize(root) {
      const resolved = path.resolve(root);
      const alias = prefixes.find(([prefix]) => isPathInside(resolved, prefix));
      return alias ? path.resolve(alias[1], path.relative(alias[0], resolved)) : resolved;
    },
  };
}

export function resolveCanonicalArtifactRepoForRoot(db: Db, root: string, observedRoot?: string): CanonicalArtifactRepoResolution {
  const resolvedRoot = path.resolve(root);
  const rows = allProjectCheckoutRows(db);
  if (rows.length === 0) return { ok: false, reason: "unknown_repo" };

  // Registry paths are explicit identity evidence, not filesystem discovery
  // seeds. Only requested paths and their ancestors supply filesystem aliases.
  const evidence = requestedPathEvidence(observedRoot ? [resolvedRoot, observedRoot] : [resolvedRoot]);
  const exact = rows.filter((row) => row.checkout_root && evidence.roots.has(evidence.canonicalize(row.checkout_root)));
  const exactResolution = uniqueResolution(exact, "checkout_root");
  if (exactResolution.ok || exactResolution.reason === "ambiguous_repo") return exactResolution;

  const worktreeRoots = gitWorktreeRoots(resolvedRoot);
  const commonRows = rows.filter((row) => row.checkout_root && worktreeRoots.has(evidence.canonicalize(row.checkout_root)));
  const commonResolution = uniqueResolution(commonRows, "git_common_dir");
  if (commonResolution.ok || commonResolution.reason === "ambiguous_repo") return commonResolution;

  const remoteIdentity = gitRemoteIdentity(resolvedRoot);
  if (remoteIdentity) {
    const remoteRows = rows.filter((row) => {
      const identities = [row.remote_identity, row.upstream_identity, row.remote_url]
        .map((value) => normalizeRemoteIdentity(value));
      return identities.includes(remoteIdentity);
    });
    const remoteResolution = uniqueResolution(remoteRows, "remote_identity");
    if (remoteResolution.ok || remoteResolution.reason === "ambiguous_repo") return remoteResolution;
  }

  const ancestryRows = rows.filter((row) => row.checkout_root &&
    [...evidence.roots].some((requested) => isPathInside(requested, evidence.canonicalize(row.checkout_root!))));
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

export interface CommittedArtifactFile {
  project_id: string;
  project_key: string;
  commit: string;
  path: string;
  bytes: Buffer;
}

/** Resolve the ref once, then read all requested blobs without touching the checkout. */
export function readCommittedArtifactFiles(db: Db, input: {
  project?: string; cwd?: string; commit: string; paths: string[];
}): CommittedArtifactFile[] {
  if (typeof input.commit !== 'string' || !input.commit.trim()) throw new Error('A nonempty commit ref is required');
  const repo = input.project
    ? resolveCanonicalArtifactRepoRef(db, input.project)
    : resolveCanonicalArtifactRepoForRoot(db, input.cwd ?? process.cwd());
  if (!repo.ok) throw new Error(`Committed source repository is ${repo.reason}`);
  const roots = allProjectCheckoutRows(db).filter(r => r.project_id === repo.project_id && r.checkout_root)
    .map(r => r.checkout_root!);
  const root = roots.find(r => fs.existsSync(r) && runGit(r, ['rev-parse','--verify','--end-of-options',`${input.commit}^{commit}`]));
  if (!root) throw new Error('Committed source requires an available registered repository object store');
  const git = (args: string[], stdin?: string) => execFileSync('git', ['--no-optional-locks', '-C', root, ...args], {
    input: stdin, timeout: 15_000, maxBuffer: 128 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const commit = git(['rev-parse', '--verify', '--end-of-options', `${input.commit}^{commit}`]).toString().trim();
  const paths = input.paths.map(p => {
    const relative = p;
    if (path.isAbsolute(relative)) throw new Error('Committed paths must be repository-relative');
    if (!relative || relative.includes('\\') || relative.includes('\n') || relative.includes('\0')
      || relative.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Committed paths must be normalized repository-relative paths');
    return relative;
  });
  const tree = git(['--literal-pathspecs', 'ls-tree', '-rz', commit, '--', ...paths]).toString();
  const entries = new Map(tree.split('\0').filter(Boolean).map(entry => {
    const match = /^(\d+) (\w+) ([a-f0-9]+)\t([\s\S]+)$/.exec(entry)!;
    return [match[4], { mode: match[1], type: match[2], oid: match[3] }];
  }));
  const ids = paths.map(p => {
    const entry = entries.get(p);
    if (!entry || entry.type !== 'blob' || !['100644', '100755'].includes(entry.mode)) throw new Error(`Not a tracked regular file at ${commit}: ${p}`);
    return entry.oid;
  });
  const output = git(['cat-file', '--batch'], ids.join('\n') + '\n');
  let offset = 0;
  return paths.map((p, i) => {
    const end = output.indexOf(10, offset);
    const header = output.subarray(offset, end).toString().split(' ');
    const size = Number(header[2]);
    if (header[0] !== ids[i] || header[1] !== 'blob' || !Number.isSafeInteger(size) || size < 0) throw new Error('Invalid Git blob response');
    const bytes = output.subarray(end + 1, end + 1 + size);
    if (bytes.length !== size) throw new Error('Truncated Git blob response');
    offset = end + size + 2;
    return { project_id: repo.project_id, project_key: repo.project_key, commit, path: p, bytes };
  });
}

/** Pin a verified committed source against branch removal and ordinary Git GC. */
export function retainArtifactCommit(db: Db, input: {
  project: string; commit: string; path: string; sha256: string;
}): string {
  const file = readCommittedArtifactFiles(db, {project:input.project,commit:input.commit,paths:[input.path]})[0];
  if (createHash('sha256').update(file.bytes).digest('hex') !== input.sha256) throw new Error('Git artifact bytes do not match registered sha256');
  const roots = allProjectCheckoutRows(db).filter(r => r.project_id === file.project_id && r.checkout_root).map(r => r.checkout_root!);
  const ref = `refs/mandible/artifacts/${file.commit}`;
  for (const root of roots) {
    if (runGit(root, ['rev-parse','--verify',`${file.commit}^{commit}`]) !== file.commit) continue;
    if (runGit(root,['symbolic-ref','-q',ref])) throw new Error('Artifact retention ref must not be symbolic');
    const existing=runGit(root,['rev-parse','--verify',ref]);
    if (existing && existing !== file.commit) throw new Error('Artifact retention ref points to an unexpected commit');
    execFileSync('git',['--no-optional-locks','-C',root,'update-ref','--no-deref',ref,file.commit,existing ?? '0'.repeat(file.commit.length)],{timeout:15000,stdio:['ignore','pipe','pipe']});
    return ref;
  }
  throw new Error('No available repository can retain artifact commit');
}
