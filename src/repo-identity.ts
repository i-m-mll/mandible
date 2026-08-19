import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";

import type { Db } from "./db.js";
import { canonicalProjectRepoId } from "./ledger/project-registry.js";

/**
 * Issue ded17e6 — canonical Git repo identity.
 *
 * A physical repository can be named many ways: its checkout root, a linked
 * worktree path, a symlinked alias (e.g. `~/.dotfiles`), or a free-form repo
 * string (`dotfiles` vs `.dotfiles`). The one identity that unifies all of
 * these without a schema migration is the realpath of the Git *common dir*
 * (`git rev-parse --git-common-dir`): every worktree of a repo shares one
 * common dir, and realpath collapses symlink aliases onto it.
 *
 * These keys are used to (a) serialize auth-merge execution per physical repo
 * while letting distinct repos run concurrently, and (b) match work units to
 * completed auth requests across repo-string aliases.
 */

interface CacheEntry {
  key: string | null;
  at: number;
}

// Common-dir identity is stable; the TTL only bounds `git` spawn cost.
const SUCCESS_TTL_MS = 5 * 60 * 1000;
const FAILURE_TTL_MS = 30 * 1000;
const GIT_TIMEOUT_MS = 5000;

// Process-level memo keyed on the raw input path.
const pathKeyCache = new Map<string, CacheEntry>();

// Issue ded17e6 hardening — last successfully resolved key per exact input
// path, never overwritten with null. A path that once resolved to a canonical
// key keeps that key available as a stable fallback when a later resolution
// transiently fails (git timeout, momentary permission error). Without this,
// one alias of a physical repo failing resolution while another alias still
// resolves would route two same-repo merges onto different execution chains
// (canonical vs. unresolved) and run them concurrently.
const lastGoodKeyCache = new Map<string, string>();

/** Test hook — reset the process-level identity memo. */
export function clearRepoIdentityCache(): void {
  pathKeyCache.clear();
  lastGoodKeyCache.clear();
}

/**
 * Realpath'd Git common-dir for a checkout path. Returns null when the path is
 * missing or is not inside a Git checkout.
 */
export function canonicalRepoKeyForPath(inputPath: string | null | undefined): string | null {
  if (!inputPath) {
    return null;
  }
  const now = Date.now();
  const cached = pathKeyCache.get(inputPath);
  if (cached) {
    const ttl = cached.key === null ? FAILURE_TTL_MS : SUCCESS_TTL_MS;
    if (now - cached.at < ttl) {
      // A fresh failure still prefers the last-known-good key over unresolved.
      return cached.key ?? lastGoodKeyCache.get(inputPath) ?? null;
    }
  }
  const key = computeCanonicalKey(inputPath);
  pathKeyCache.set(inputPath, { key, at: now });
  if (key !== null) {
    lastGoodKeyCache.set(inputPath, key);
    return key;
  }
  // Transient resolution failure: reuse the last successfully memoized key for
  // this exact path (stale-but-stable beats unresolved). Only paths that never
  // resolved fall through to null and share the conservative unresolved chain.
  return lastGoodKeyCache.get(inputPath) ?? null;
}

function computeCanonicalKey(inputPath: string): string | null {
  let commonDir: string;
  try {
    commonDir = execFileSync(
      "git",
      ["rev-parse", "--path-format=absolute", "--git-common-dir"],
      {
        cwd: inputPath,
        encoding: "utf-8",
        timeout: GIT_TIMEOUT_MS,
        // Suppress git's stderr (e.g. "not a git repository") — a null key is
        // the intended signal, not console noise.
        stdio: ["ignore", "pipe", "ignore"],
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
      }
    ).trim();
  } catch {
    return null;
  }
  if (!commonDir) {
    return null;
  }
  try {
    return realpathSync(commonDir);
  } catch {
    // The common dir path exists per git but realpath failed (race/permission);
    // fall back to the absolute path git reported.
    return commonDir;
  }
}

/**
 * All canonical keys reachable from a free-form repo ref. Tries, in order:
 *   (a) the ref as a checkout path,
 *   (b) `work_repos` rows matching id | name | root,
 *   (c) `ledger_projects` rows matching project_key | display_name, joined to
 *       their `ledger_project_checkouts.root`.
 * Missing tables/columns are silently skipped, so registry-less DBs simply
 * yield the path-based attempt (usually empty for bare strings).
 */
export function canonicalRepoKeysForRef(db: Db, ref: string | null | undefined): Set<string> {
  const keys = new Set<string>();
  if (!ref) {
    return keys;
  }
  const add = (key: string | null): void => {
    if (key) {
      keys.add(key);
    }
  };

  // The project registry is the durable semantic identity. Prefix it so it
  // cannot collide with a physical common-dir path key.
  const projectRepoId = canonicalProjectRepoId(db, ref);
  if (projectRepoId) {
    keys.add(`project:${projectRepoId}`);
  }

  // (a) ref as a path.
  add(canonicalRepoKeyForPath(ref));

  // (b) work_repos by id | name | root.
  try {
    const rows = db
      .prepare("SELECT root FROM work_repos WHERE id = ? OR name = ? OR root = ?")
      .all(ref, ref, ref) as Array<{ root: string }>;
    for (const row of rows) {
      add(canonicalRepoKeyForPath(row.root));
    }
  } catch {
    // work_repos absent in lightweight DBs.
  }

  // (c) ledger_projects.project_key -> checkout roots.
  try {
    const rows = db
      .prepare(
        `SELECT c.root FROM ledger_project_checkouts c
         JOIN ledger_projects p ON p.id = c.project_id
         WHERE p.project_key = ?`
      )
      .all(ref) as Array<{ root: string }>;
    for (const row of rows) {
      add(canonicalRepoKeyForPath(row.root));
    }
  } catch {
    // ledger tables absent, or project_key column absent in older schemas.
  }

  // (c') ledger_projects.display_name -> checkout roots (separate query so a
  // missing project_key column does not also skip display_name matching).
  try {
    const rows = db
      .prepare(
        `SELECT c.root FROM ledger_project_checkouts c
         JOIN ledger_projects p ON p.id = c.project_id
         WHERE p.display_name = ?`
      )
      .all(ref) as Array<{ root: string }>;
    for (const row of rows) {
      add(canonicalRepoKeyForPath(row.root));
    }
  } catch {
    // ledger tables absent.
  }

  return keys;
}
