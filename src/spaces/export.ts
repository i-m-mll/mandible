import { linkCommitToLedgerIssue, resolveOperationalIssueRef } from "../ledger/operational-links.js";
/**
 * Spaces document export/custody backend (Spaces child C13b, issue 8730bf9,
 * umbrella de56ffa).
 *
 * This module implements the deterministic `export-and-track` operation
 * (`docs/spaces/DOCUMENT-CUSTODY-DESIGN.md` §3) plus untracked export-of-copy
 * (§3.3), the docs-branch worktree lifecycle (§5.2 — provisioning, a
 * serialized-write lock, dirty-rejection, path identity), and the export
 * settings storage (§5.1 — global default + per-repo override). It consumes the
 * FROZEN surfaces of its dependencies and owns the new export surface:
 *
 *   - C12 serialization (`./serialize.ts`): `exportDocument(tree)` produces the
 *     canonical `spaces-doc.v1` bytes. This module never re-implements the
 *     format; it builds a {@link DocTree} from `space_blocks` and serializes.
 *   - C13a schema (`space_exports`, `src/db.ts` v85): the mutable tracking row.
 *     There is NO row until an explicit user commit — Mandible custody is the
 *     default (§2.2).
 *   - Signed Git commits and explicit ledger issue links.
 *
 * ## Custody contract (FROZEN for C13c drift / C13d UI / C16 promotion)
 *
 *   - `exportAndTrack` is the ONLY path that creates/refreshes a `space_exports`
 *     row. It writes the serialized document to the managed docs-branch
 *     worktree, commits it with the document commit path, retains an immutable
 *     pre-export snapshot artifact, and records `authority='repo'` +
 *     `status='clean'` + the export pointers.
 *   - `exportUntrackedCopy` writes a one-shot copy and NEVER touches
 *     `space_exports`; it surfaces a `local_only` warning when the copy lands
 *     untracked inside a repo working tree.
 *   - The docs worktree is provisioned once per (repo, branch); writes are
 *     serialized through {@link withWorktreeLock}; a commit is REJECTED when the
 *     worktree carries dirty unrelated changes.
 *
 * Git/filesystem effects are injected through {@link ExportGitRunner} so the
 * custody + locking + tracking logic is unit-testable without a real repo. The
 * default runner shells out to git and to the signed Git commit path.
 */

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { Db } from "../db.js";
import { getArtifact, ingestArtifact, projectArtifactPublicValue } from "../provider-artifacts.js";
import { getSpace, type SpaceRecord } from "../ledger/spaces.js";
import { listSpaceBlocks, toDocBlock } from "../ledger/space-blocks.js";
import { exportDocument, SPACES_DOC_VERSION, type DocBlock, type DocTree } from "./serialize.js";

// --- doc tree assembly -------------------------------------------------------

/**
 * Build the canonical {@link DocTree} for a Space from its `space_blocks` rows
 * plus document-level frontmatter. The serialized text is the lossless source
 * of truth; this is the export-side projection (C11 owns the table, C12 owns the
 * format).
 */
export function buildSpaceDocTree(db: Db, spaceId: string, now = Date.now()): DocTree {
  const space = getSpace(db, spaceId);
  if (!space) throw new ExportError("space_not_found", `space not found: ${spaceId}`);
  const blocks: DocBlock[] = listSpaceBlocks(db, spaceId).map(toDocBlock);
  const frontmatter: Record<string, string> = {
    mandible_space: space.id,
    mandible_space_title: space.title,
    mandible_exported_at: new Date(now).toISOString(),
  };
  return { frontmatter, blocks };
}

/** Serialize a Space directly to canonical `spaces-doc.v1` text. */
export function serializeSpaceDocument(db: Db, spaceId: string, now = Date.now()): string {
  return exportDocument(buildSpaceDocTree(db, spaceId, now));
}

// --- errors ------------------------------------------------------------------

export type ExportErrorCode =
  | "invalid_issue"
  | "issue_link_failed"
  | "space_not_found"
  | "checkout_not_found"
  | "invalid_path"
  | "worktree_dirty"
  | "commit_failed"
  | "git_failed"
  | "locked";

/** Structured export failure with a stable machine code for route mapping. */
export class ExportError extends Error {
  constructor(public readonly code: ExportErrorCode, message: string) {
    super(message);
    this.name = "ExportError";
  }
}

// --- repo checkout resolution ------------------------------------------------

/** The backed-up project-checkout identity `space_exports.repo_id` references. */
export interface ProjectCheckout {
  id: string;
  project_id: string;
  root: string;
  name: string;
  default_branch: string;
}

/** Resolve a `ledger_project_checkouts` row by id. */
export function getProjectCheckout(db: Db, checkoutId: string): ProjectCheckout | null {
  const row = db
    .prepare(
      `SELECT id, project_id, root, name, default_branch
         FROM ledger_project_checkouts WHERE id = ?`,
    )
    .get(checkoutId) as ProjectCheckout | undefined;
  return row ?? null;
}

/**
 * Pick the project checkout to export into for a Space. An explicit `repo_id`
 * wins; otherwise the first checkout registered for the Space's project is used
 * (single-checkout projects are the common case).
 */
export function resolveCheckoutForSpace(
  db: Db,
  space: SpaceRecord,
  explicitRepoId?: string | null,
): ProjectCheckout {
  if (explicitRepoId) {
    const checkout = getProjectCheckout(db, explicitRepoId);
    if (!checkout) throw new ExportError("checkout_not_found", `repo checkout not found: ${explicitRepoId}`);
    if (checkout.project_id !== space.project_id) {
      throw new ExportError("checkout_not_found", "repo checkout belongs to a different project than the space");
    }
    return checkout;
  }
  const row = db
    .prepare(
      `SELECT id, project_id, root, name, default_branch
         FROM ledger_project_checkouts
        WHERE project_id = ?
        ORDER BY created_at ASC, id ASC
        LIMIT 1`,
    )
    .get(space.project_id) as ProjectCheckout | undefined;
  if (!row) throw new ExportError("checkout_not_found", `no repo checkout registered for project: ${space.project_id}`);
  return row;
}

// --- export settings (global default + per-repo override) --------------------

const DEFAULT_DOCS_BRANCH = "docs/spaces";
const GLOBAL_DOCS_PATH_KEY = "spaces.docs.default_path";
const GLOBAL_DOCS_BRANCH_KEY = "spaces.docs.default_branch";
const DEFAULT_DOCS_PATH_PREFIX = "docs/spaces";

function settingsGet(db: Db, key: string): string | null {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row ? row.value : null;
}

function settingsSet(db: Db, key: string, value: string, now = Date.now()): void {
  db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, value, now);
}

function repoDocsPathKey(checkoutId: string): string {
  return `spaces.docs.path.${checkoutId}`;
}
function repoDocsBranchKey(checkoutId: string): string {
  return `spaces.docs.branch.${checkoutId}`;
}

export interface DocsSettings {
  /** Resolved repo-relative default export path for this checkout. */
  path: string;
  /** Resolved docs branch for this checkout. */
  branch: string;
  /** Whether a per-repo override path was set. */
  pathFromOverride: boolean;
}

/**
 * Resolve the docs settings for a checkout: per-repo override, then global
 * default, then a built-in `docs/spaces/<space>.md` default. Path is always the
 * confirmable default — `exportAndTrack` accepts an explicit override that wins.
 */
export function resolveDocsSettings(db: Db, checkoutId: string, spaceId: string): DocsSettings {
  const override = settingsGet(db, repoDocsPathKey(checkoutId));
  const globalPath = settingsGet(db, GLOBAL_DOCS_PATH_KEY);
  const branchOverride = settingsGet(db, repoDocsBranchKey(checkoutId));
  const globalBranch = settingsGet(db, GLOBAL_DOCS_BRANCH_KEY);
  const basePath = override ?? globalPath ?? `${DEFAULT_DOCS_PATH_PREFIX}/${spaceId}.md`;
  return {
    path: basePath,
    branch: branchOverride ?? globalBranch ?? DEFAULT_DOCS_BRANCH,
    pathFromOverride: override !== null,
  };
}

/** Persist the global default export path (and optional default branch). */
export function setGlobalDocsDefault(
  db: Db,
  input: { path?: string; branch?: string },
  now = Date.now(),
): void {
  if (input.path !== undefined) settingsSet(db, GLOBAL_DOCS_PATH_KEY, normalizeRepoRelativePath(input.path), now);
  if (input.branch !== undefined) settingsSet(db, GLOBAL_DOCS_BRANCH_KEY, input.branch.trim(), now);
}

/** Persist a per-repo export path/branch override. */
export function setRepoDocsOverride(
  db: Db,
  checkoutId: string,
  input: { path?: string; branch?: string },
  now = Date.now(),
): void {
  if (input.path !== undefined) settingsSet(db, repoDocsPathKey(checkoutId), normalizeRepoRelativePath(input.path), now);
  if (input.branch !== undefined) settingsSet(db, repoDocsBranchKey(checkoutId), input.branch.trim(), now);
}

// --- path identity / safety --------------------------------------------------

/**
 * Normalize a repo-relative export path: reject absolute paths and any `..`
 * traversal so an export can never escape the repo working tree (standing AC #6
 * path identity). Returns a POSIX-style repo-relative path.
 */
export function normalizeRepoRelativePath(input: string): string {
  const raw = (input ?? "").trim();
  if (!raw) throw new ExportError("invalid_path", "export path is required");
  if (path.isAbsolute(raw)) throw new ExportError("invalid_path", "export path must be repo-relative, not absolute");
  const normalized = path.posix.normalize(raw.replace(/\\/g, "/"));
  if (normalized === ".." || normalized.startsWith("../") || normalized.includes("/../")) {
    throw new ExportError("invalid_path", "export path must not traverse outside the repo");
  }
  if (normalized.startsWith("/")) {
    throw new ExportError("invalid_path", "export path must be repo-relative");
  }
  return normalized;
}

// --- git runner (injectable for tests) ---------------------------------------

export interface ExportGitRunner {
  /** Resolve (provision if needed) the worktree dir for (repoRoot, branch). */
  ensureWorktree(repoRoot: string, branch: string): string;
  /** True when the worktree has uncommitted changes outside `ignorePath`. */
  hasDirtyUnrelated(worktreeDir: string, ignorePath: string): boolean;
  /** Run an agent-key linked commit in `worktreeDir` for `path`/`issues`. */
  commitDocument(args: {
    worktreeDir: string;
    relativePath: string;
    message: string;
    issues: string[];
  }): { commit: string; blobSha: string };
  /** Current HEAD commit sha of the worktree (null when no commits yet). */
  headCommit(worktreeDir: string): string | null;
}

function runGit(cwd: string, args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
  return {
    ok: result.status === 0,
    stdout: (result.stdout ?? "").trim(),
    stderr: (result.stderr ?? "").trim(),
  };
}

/**
 * Default runner: real git + the the signed Git commit path document commit operation.
 * Worktrees live under `<repoRoot>/.git/mandible-docs-worktrees/<branch>` so the
 * managed checkout is stable and isolated from feature worktrees.
 */
export const defaultExportGitRunner: ExportGitRunner = {
  ensureWorktree(repoRoot: string, branch: string): string {
    const safeBranch = branch.replace(/[^A-Za-z0-9._-]+/g, "_");
    const worktreeDir = path.join(repoRoot, ".git", "mandible-docs-worktrees", safeBranch);
    if (fs.existsSync(path.join(worktreeDir, ".git"))) return worktreeDir;
    fs.mkdirSync(path.dirname(worktreeDir), { recursive: true });
    const branchExists = runGit(repoRoot, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).ok;
    const args = branchExists
      ? ["worktree", "add", worktreeDir, branch]
      : ["worktree", "add", "-b", branch, worktreeDir];
    const added = runGit(repoRoot, args);
    if (!added.ok) {
      throw new ExportError("git_failed", `failed to provision docs worktree: ${added.stderr || added.stdout}`);
    }
    return worktreeDir;
  },

  hasDirtyUnrelated(worktreeDir: string, ignorePath: string): boolean {
    const status = runGit(worktreeDir, ["status", "--porcelain"]);
    if (!status.ok) throw new ExportError("git_failed", `git status failed: ${status.stderr}`);
    for (const line of status.stdout.split("\n")) {
      if (!line.trim()) continue;
      const file = line.slice(3).trim();
      if (file !== ignorePath) return true;
    }
    return false;
  },

  commitDocument(args) {
    const staged = runGit(args.worktreeDir, ["add", "--", args.relativePath]);
    if (!staged.ok) throw new ExportError("git_failed", "failed to stage exported document");
    const result = spawnSync("git", ["commit", "-m", args.message], {
      cwd: args.worktreeDir, encoding: "utf8",
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    });
    if (result.status !== 0) {
      throw new ExportError("commit_failed", `linked commit failed: ${(result.stderr || result.stdout || "").trim()}`);
    }
    const head = runGit(args.worktreeDir, ["rev-parse", "HEAD"]);
    const blob = runGit(args.worktreeDir, ["rev-parse", `HEAD:${args.relativePath}`]);
    if (!head.ok || !blob.ok) {
      throw new ExportError("git_failed", "failed to read commit/blob sha after linked commit");
    }
    return { commit: head.stdout, blobSha: blob.stdout };
  },

  headCommit(worktreeDir: string): string | null {
    const head = runGit(worktreeDir, ["rev-parse", "--verify", "--quiet", "HEAD"]);
    return head.ok && head.stdout ? head.stdout : null;
  },
};

// --- serialized writes: per-worktree lock ------------------------------------

const worktreeLocks = new Map<string, Promise<unknown>>();

/**
 * Serialize writes against a single managed worktree path (§5.2): concurrent
 * exports targeting the same checkout are queued, never raced. This is an
 * in-process async mutex keyed by the absolute worktree dir.
 */
export async function withWorktreeLock<T>(worktreeDir: string, fn: () => Promise<T>): Promise<T> {
  const key = path.resolve(worktreeDir);
  const prior = worktreeLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  worktreeLocks.set(key, prior.then(() => gate));
  try {
    await prior.catch(() => undefined);
    return await fn();
  } finally {
    release();
    // Drop the entry once this is the tail of the chain to avoid unbounded growth.
    void Promise.resolve().then(() => {
      if (worktreeLocks.get(key) === prior.then(() => gate)) worktreeLocks.delete(key);
    });
  }
}

// --- export-and-track --------------------------------------------------------

function sha256Hex(text: string): string {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

export interface ExportAndTrackInput {
  spaceId: string;
  /** Explicit project-checkout id; defaults to the Space's project checkout. */
  repoId?: string | null;
  /** Confirmed repo-relative export path (export-dialog output). */
  path?: string | null;
  /** Docs branch override; defaults to the resolved per-repo/global branch. */
  branch?: string | null;
  /** Issue refs linked to the exported commit in the ledger. */
  issues: string[];
  /** Commit subject; a deterministic default is used when omitted. */
  message?: string | null;
}

export interface ExportAndTrackResult {
  export: SpaceExportRow;
  document_content_sha256: string;
  commit: string;
  pre_export_snapshot_artifact_id: string;
  last_export_artifact_id: string;
}

/** Read-model of a `space_exports` row (the FROZEN tracking record). */
export interface SpaceExportRow {
  id: string;
  space_id: string;
  repo_id: string;
  branch: string;
  path: string;
  authority: "mandible" | "repo";
  status: "clean" | "stale" | "repo_changed" | "worktree_dirty" | "conflict";
  last_export_artifact_id: string | null;
  pre_export_snapshot_artifact_id: string | null;
  last_export_commit: string | null;
  last_export_blob_sha: string | null;
  last_export_content_sha256: string | null;
  last_seen_commit: string | null;
  last_seen_content_sha256: string | null;
  created_at: number;
  updated_at: number;
}

interface SpaceExportStoredRow extends SpaceExportRow {
  last_export_blob_id: string | null;
  pre_export_snapshot_blob_id: string | null;
}

/**
 * `last_export_artifact_id` and `pre_export_snapshot_artifact_id` are public
 * compatibility names computed from the canonical blob columns. Nothing stores
 * them.
 */
function projectSpaceExportRow(db: Db, row: SpaceExportStoredRow): SpaceExportRow {
  const compatibilityRef = (blobId: string | null): string | null => {
    const artifactId = blobId ? getArtifact(db, blobId)?.id ?? null : null;
    return artifactId ? projectArtifactPublicValue(db, artifactId) as string : null;
  };
  const {
    last_export_blob_id: lastExportBlobId,
    pre_export_snapshot_blob_id: preExportSnapshotBlobId,
    ...compatibility
  } = row;
  return {
    ...compatibility,
    last_export_artifact_id: compatibilityRef(lastExportBlobId),
    pre_export_snapshot_artifact_id: compatibilityRef(preExportSnapshotBlobId),
  };
}

export function getSpaceExport(db: Db, exportId: string): SpaceExportRow | null {
  const row = db.prepare("SELECT * FROM space_exports WHERE id = ?").get(exportId) as
    | SpaceExportStoredRow
    | undefined;
  return row ? projectSpaceExportRow(db, row) : null;
}

export function findSpaceExport(
  db: Db,
  repoId: string,
  branch: string,
  relativePath: string,
): SpaceExportRow | null {
  const row = db
    .prepare("SELECT * FROM space_exports WHERE repo_id = ? AND branch = ? AND path = ?")
    .get(repoId, branch, relativePath) as SpaceExportStoredRow | undefined;
  return row ? projectSpaceExportRow(db, row) : null;
}

export function listSpaceExportsForSpace(db: Db, spaceId: string): SpaceExportRow[] {
  const rows = db
    .prepare("SELECT * FROM space_exports WHERE space_id = ? ORDER BY created_at ASC")
    .all(spaceId) as SpaceExportStoredRow[];
  return rows.map((row) => projectSpaceExportRow(db, row));
}

/**
 * The deterministic `export-and-track` op (§3). Serializes the Space, writes it
 * to the managed docs-branch worktree, agent-key linked-commits it, retains a
 * pre-export snapshot artifact, and upserts the `space_exports` tracking row.
 *
 * This is the ONLY creator of a `space_exports` row: until this explicit action,
 * the document has no row and stays in Mandible custody (§2.2).
 */
export async function exportAndTrack(
  db: Db,
  input: ExportAndTrackInput,
  options: { git?: ExportGitRunner; now?: number } = {},
): Promise<ExportAndTrackResult> {
  const git = options.git ?? defaultExportGitRunner;
  const now = options.now ?? Date.now();

  const space = getSpace(db, input.spaceId);
  if (!space) throw new ExportError("space_not_found", `space not found: ${input.spaceId}`);
  const checkout = resolveCheckoutForSpace(db, space, input.repoId);
  for (const issue of input.issues) {
    if (!resolveOperationalIssueRef(db, issue, checkout.project_id).ok) {
      throw new ExportError("invalid_issue", `Cannot resolve issue: ${issue}`);
    }
  }
  const settings = resolveDocsSettings(db, checkout.id, space.id);
  const branch = (input.branch ?? settings.branch).trim() || settings.branch;
  const relativePath = normalizeRepoRelativePath(input.path ?? settings.path);

  // Serialize FIRST so a failure never touches the worktree.
  const docText = serializeSpaceDocument(db, space.id, now);
  const contentSha = sha256Hex(docText);

  const worktreeDir = git.ensureWorktree(checkout.root, branch);

  return withWorktreeLock(worktreeDir, async () => {
    // Reject dirty unrelated changes BEFORE writing (§5.2).
    if (git.hasDirtyUnrelated(worktreeDir, relativePath)) {
      throw new ExportError(
        "worktree_dirty",
        "docs worktree has dirty unrelated changes; commit or stash them before exporting",
      );
    }

    // Retain an immutable pre-export snapshot of the authoring revision (the
    // current serialized form before this export lands). This is the recovery
    // artifact (§3 step 5); it is a content-addressed `artifacts` row.
    const preExport = ingestArtifact(
      db,
      {
        content: docText,
        media_type: "text/markdown",
        role: "spaces-doc-snapshot",
        filename: path.basename(relativePath),
        logical_name: `${space.id}:pre-export`,
        metadata: {
          mandible_format: SPACES_DOC_VERSION,
          space_id: space.id,
          repo_id: checkout.id,
          branch,
          path: relativePath,
          snapshot_kind: "pre_export",
        },
      },
      now,
    );

    // Write the serialized document into the managed worktree.
    const absPath = path.join(worktreeDir, relativePath);
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, docText, "utf8");

    const message = (input.message ?? "").trim() || `Export Spaces document ${space.title} (${space.id})`;
    const { commit, blobSha } = git.commitDocument({
      worktreeDir,
      relativePath,
      message,
      issues: input.issues,
    });

    for (const issue of input.issues) {
      const linked = linkCommitToLedgerIssue(db, {
        commit_sha: commit, issue_ref: issue, repo_ref: checkout.project_id,
        link_type: "references", source: "spaces_export", recordEvent: true,
      });
      if (!linked.ok) throw new ExportError("issue_link_failed", `Cannot link committed export to issue: ${issue}`);
    }

    // The committed bytes become an immutable "last export" artifact too.
    const lastExport = ingestArtifact(
      db,
      {
        content: docText,
        media_type: "text/markdown",
        role: "spaces-doc-export",
        filename: path.basename(relativePath),
        logical_name: `${space.id}:export`,
        metadata: {
          mandible_format: SPACES_DOC_VERSION,
          space_id: space.id,
          repo_id: checkout.id,
          branch,
          path: relativePath,
          commit,
          snapshot_kind: "last_export",
        },
      },
      now,
    );

    const row = upsertSpaceExport(db, {
      space_id: space.id,
      repo_id: checkout.id,
      branch,
      path: relativePath,
      authority: "repo",
      status: "clean",
      last_export_blob_id: `artifact-blob:${lastExport.content_hash}`,
      pre_export_snapshot_blob_id: `artifact-blob:${preExport.content_hash}`,
      last_export_commit: commit,
      last_export_blob_sha: blobSha,
      last_export_content_sha256: contentSha,
      last_seen_commit: commit,
      last_seen_content_sha256: contentSha,
      now,
    });

    return {
      export: row,
      document_content_sha256: contentSha,
      commit,
      pre_export_snapshot_artifact_id: projectArtifactPublicValue(db, preExport.id) as string,
      last_export_artifact_id: projectArtifactPublicValue(db, lastExport.id) as string,
    };
  });
}

/**
 * Insert-or-refresh the `space_exports` tracking row keyed by the inline-UNIQUE
 * `(repo_id, branch, path)` identity. Re-exporting the same document to the same
 * confirmed path is idempotent on identity (§5.2).
 */
function upsertSpaceExport(
  db: Db,
  input: Omit<
    SpaceExportStoredRow,
    "id" | "created_at" | "updated_at" |
    "last_export_artifact_id" | "pre_export_snapshot_artifact_id"
  > & { now: number },
): SpaceExportRow {
  const existing = findSpaceExport(db, input.repo_id, input.branch, input.path);
  const now = input.now;
  const stored = input;
  if (existing) {
    db.prepare(
      `UPDATE space_exports SET
         space_id = @space_id,
         authority = @authority,
         status = @status,
         last_export_blob_id = @last_export_blob_id,
         pre_export_snapshot_blob_id = @pre_export_snapshot_blob_id,
         last_export_commit = @last_export_commit,
         last_export_blob_sha = @last_export_blob_sha,
         last_export_content_sha256 = @last_export_content_sha256,
         last_seen_commit = @last_seen_commit,
         last_seen_content_sha256 = @last_seen_content_sha256,
         updated_at = @updated_at
       WHERE id = @id`,
    ).run({ ...stored, id: existing.id, updated_at: now });
    return getSpaceExport(db, existing.id)!;
  }
  const id = `spxp_${crypto.randomUUID().replace(/-/g, "").slice(0, 20)}`;
  db.prepare(
    `INSERT INTO space_exports (
       id, space_id, repo_id, branch, path, authority, status,
       last_export_blob_id, pre_export_snapshot_blob_id,
       last_export_commit, last_export_blob_sha, last_export_content_sha256,
       last_seen_commit, last_seen_content_sha256, created_at, updated_at
     ) VALUES (
       @id, @space_id, @repo_id, @branch, @path, @authority, @status,
       @last_export_blob_id, @pre_export_snapshot_blob_id,
       @last_export_commit, @last_export_blob_sha, @last_export_content_sha256,
       @last_seen_commit, @last_seen_content_sha256, @created_at, @updated_at
     )`,
  ).run({ ...stored, id, created_at: now, updated_at: now });
  return getSpaceExport(db, id)!;
}

// --- untracked export-of-copy ------------------------------------------------

export interface UntrackedExportInput {
  spaceId: string;
  /** Absolute destination path for the one-shot copy. */
  destPath: string;
  /** Optional repo checkout to detect the local_only-inside-repo case. */
  repoId?: string | null;
}

export interface UntrackedExportResult {
  path: string;
  bytes: number;
  content_sha256: string;
  /** Set when the copy lands untracked inside a repo working tree (§3.3). */
  warning: "local_only" | null;
}

/**
 * One-shot export-of-copy (§3.3): write the rendered `spaces-doc.v1` to a path
 * with NO ongoing custody — never creates a `space_exports` row, never snapshots
 * a recovery artifact. Surfaces a `local_only` warning when the copy is written
 * untracked inside a repo working tree (the bytes are not a durable Git object).
 */
export function exportUntrackedCopy(
  db: Db,
  input: UntrackedExportInput,
  options: { git?: ExportGitRunner; now?: number } = {},
): UntrackedExportResult {
  const now = options.now ?? Date.now();
  const space = getSpace(db, input.spaceId);
  if (!space) throw new ExportError("space_not_found", `space not found: ${input.spaceId}`);
  if (!path.isAbsolute(input.destPath)) {
    throw new ExportError("invalid_path", "untracked export destPath must be absolute");
  }
  const docText = serializeSpaceDocument(db, space.id, now);
  const contentSha = sha256Hex(docText);
  fs.mkdirSync(path.dirname(input.destPath), { recursive: true });
  fs.writeFileSync(input.destPath, docText, "utf8");

  let warning: "local_only" | null = null;
  if (input.repoId) {
    const checkout = getProjectCheckout(db, input.repoId);
    if (checkout && isInsideRepoUntracked(checkout.root, input.destPath, options.git)) {
      warning = "local_only";
    }
  }
  return { path: input.destPath, bytes: Buffer.byteLength(docText, "utf8"), content_sha256: contentSha, warning };
}

/** True when `destPath` is inside `repoRoot` and not a tracked, clean file. */
function isInsideRepoUntracked(repoRoot: string, destPath: string, git?: ExportGitRunner): boolean {
  const rel = path.relative(path.resolve(repoRoot), path.resolve(destPath));
  if (rel.startsWith("..") || path.isAbsolute(rel)) return false;
  // Inside the repo. If git can confirm the path is tracked-and-clean, no
  // warning is needed; otherwise it is untracked/dirty → local_only.
  if (git) {
    try {
      return git.hasDirtyUnrelated(repoRoot, "__never_matches__") ? true : !pathIsTrackedClean(repoRoot, rel);
    } catch {
      return true;
    }
  }
  return !pathIsTrackedClean(repoRoot, rel);
}

function pathIsTrackedClean(repoRoot: string, relativePath: string): boolean {
  const tracked = runGit(repoRoot, ["ls-files", "--error-unmatch", relativePath]);
  if (!tracked.ok) return false;
  const status = runGit(repoRoot, ["status", "--porcelain", "--", relativePath]);
  return status.ok && status.stdout.trim() === "";
}
