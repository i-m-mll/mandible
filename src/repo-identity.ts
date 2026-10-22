import { realpathSync } from "node:fs";
import { childOutput } from "./child-observation.js";

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
let cacheGeneration = 0;
interface PendingKey {
  controller: AbortController;
  consumers: number;
  result: Promise<string | null>;
}
const pendingKeys = new Map<string, PendingKey>();

/** Test hook — reset the process-level identity memo. */
export function clearRepoIdentityCache(): void {
  cacheGeneration++;
  pathKeyCache.clear();
  lastGoodKeyCache.clear();
  pendingKeys.clear();
}

/**
 * Realpath'd Git common-dir for a checkout path. Returns null when the path is
 * missing or is not inside a Git checkout.
 */
export async function canonicalRepoKeyForPath(inputPath: string | null | undefined, signal?: AbortSignal): Promise<string | null> {
  signal?.throwIfAborted();
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
  let pending = pendingKeys.get(inputPath);
  if (!pending || pending.controller.signal.aborted) {
    const generation = cacheGeneration;
    const controller = new AbortController();
    pending = { controller, consumers: 0, result: Promise.resolve(null) };
    const owned = pending;
    pending.result = computeCanonicalKey(inputPath, controller.signal).then((key) => {
      controller.signal.throwIfAborted();
      if (generation === cacheGeneration) {
        pathKeyCache.set(inputPath, { key, at: now });
        if (key !== null) lastGoodKeyCache.set(inputPath, key);
      }
      return key ?? (generation === cacheGeneration ? lastGoodKeyCache.get(inputPath) : null) ?? null;
    }).finally(() => {
      if (pendingKeys.get(inputPath) === owned) pendingKeys.delete(inputPath);
    });
    pendingKeys.set(inputPath, pending);
  }
  const owned = pending;
  owned.consumers++;
  return new Promise((resolve, reject) => {
    let aborted = false;
    const abort = () => {
      if (aborted) return;
      aborted = true;
      owned.consumers--;
      if (owned.consumers === 0) owned.controller.abort(signal?.reason);
      else reject(signal?.reason);
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    owned.result.then(
      (key) => aborted ? reject(signal?.reason) : resolve(key),
      (error) => reject(aborted ? signal?.reason : error),
    ).finally(() => {
      signal?.removeEventListener("abort", abort);
      if (!aborted) owned.consumers--;
    });
  });
}

async function computeCanonicalKey(inputPath: string, signal: AbortSignal): Promise<string | null> {
  let commonDir: string;
  try {
    commonDir = (await childOutput(
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
        signal,
      }
    )).trim();
  } catch {
    signal.throwIfAborted();
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
export async function canonicalRepoKeysForRef(db: Db, ref: string | null | undefined, signal?: AbortSignal): Promise<Set<string>> {
  const observed = await observeRepoIdentities(db, [ref], [], signal);
  observed.assertCurrent();
  return observed.keysForRef(ref);
}

function registryInput(db: Db, ref: string) {
  const project = registeredProject(db, ref);
  return { project: project?.project_key ?? null, projectId: project?.id ?? null,
    registeredRoots: project?.checkouts.map(checkout => checkout.root).sort() ?? [],
    roots: checkoutRootsForRef(db, ref).sort() };
}

export interface RepoIdentityObservation {
  keysForRef(ref: string | null | undefined): Set<string>;
  keyForPath(path: string | null | undefined): string | null;
  assertCurrent(): void;
}

export class RepoIdentityReadSetChanged extends Error {}

/** Capture registry inputs, observe Git outside mutation transactions, then compare synchronously. */
export async function observeRepoIdentities(db: Db, refs: readonly (string | null | undefined)[], paths: readonly (string | null | undefined)[] = [], signal?: AbortSignal): Promise<RepoIdentityObservation> {
  const inputs = new Map([...new Set(refs.filter((ref): ref is string => Boolean(ref)))].map(ref => [ref, registryInput(db, ref)]));
  const roots = [...new Set([...paths.filter((root): root is string => Boolean(root)), ...[...inputs.values()].flatMap(input => input.roots)])];
  const results = await Promise.allSettled(roots.map(async root => [root, await canonicalRepoKeyForPath(root, signal)] as const));
  const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
  if (failure) throw failure.reason;
  const keys = new Map(results.map(result => (result as PromiseFulfilledResult<readonly [string, string | null]>).value));
  signal?.throwIfAborted();
  return {
    keysForRef(ref) {
      if (!ref) return new Set();
      const input = inputs.get(ref);
      if (!input) throw new Error(`Repository identity was not observed: ${ref}`);
      return new Set([...(input.project ? [`project:${input.project}`] : []), ...input.roots.map(root => keys.get(root)).filter((key): key is string => Boolean(key))]);
    },
    keyForPath(root) {
      if (!root) return null;
      if (!keys.has(root)) throw new Error(`Repository path identity was not observed: ${root}`);
      return keys.get(root)!;
    },
    assertCurrent() {
      signal?.throwIfAborted();
      for (const [ref, input] of inputs) if (JSON.stringify(registryInput(db, ref)) !== JSON.stringify(input)) throw new RepoIdentityReadSetChanged("Repository registry changed during identity observation");
    },
  };
}
