import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";

import type { Db } from "./db.js";
import { tableExists } from "./db-introspection.js";
import { resolveProjectRef } from "./ledger/project-registry.js";

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
 * Every checkout path a free-form repo ref may name: the ref itself, the
 * WorkScanner repos matching id | name | root, then the registered checkout
 * roots of the project the ref resolves to. Absent tables are skipped, so
 * registry-less DBs yield only the ref itself.
 */
export function checkoutRootsForRef(db: Db, ref: string): string[] {
  const scanned = tableExists(db, "work_repos")
    ? db.prepare("SELECT root FROM work_repos WHERE id = ? OR name = ? OR root = ?").all(ref, ref, ref) as Array<{ root: string }>
    : [];
  const project = registeredProject(db, ref);
  return [...new Set([ref, ...scanned.map((row) => row.root), ...(project?.checkouts.map((checkout) => checkout.root) ?? [])])];
}

function registeredProject(db: Db, ref: string) {
  if (!tableExists(db, "ledger_projects") || !tableExists(db, "ledger_project_checkouts")) return null;
  const resolved = resolveProjectRef(db, ref);
  return resolved.ok ? resolved.project : null;
}

/**
 * All canonical keys reachable from a free-form repo ref: the project registry
 * identity plus the Git common dir of every {@link checkoutRootsForRef} path.
 */
export function canonicalRepoKeysForRef(db: Db, ref: string | null | undefined): Set<string> {
  const keys = new Set<string>();
  if (!ref) {
    return keys;
  }
  // The project registry is the durable semantic identity. Prefix it so it
  // cannot collide with a physical common-dir path key.
  const project = registeredProject(db, ref);
  if (project?.project_key) {
    keys.add(`project:${project.project_key}`);
  }
  for (const root of checkoutRootsForRef(db, ref)) {
    const key = canonicalRepoKeyForPath(root);
    if (key) keys.add(key);
  }
  return keys;
}
