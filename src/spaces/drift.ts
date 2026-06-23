/**
 * Spaces document drift / status detection (Spaces child C13c, issue 21f36cb,
 * umbrella de56ffa).
 *
 * After `export-and-track` (C13b) moves a document into repo custody, the
 * docs-branch file can change outside Mandible — a manual edit, a newer commit,
 * a dirty working tree — and the Mandible-side authoring state can move too.
 * This module computes the `space_exports.status` drift state by inspecting the
 * **live** docs-branch worktree/HEAD/path, per `DOCUMENT-CUSTODY-DESIGN.md` §6.
 *
 * ## Why live inspection, not artifact materialization (custody-doc §6 / review A5)
 *
 * Artifact content resolution PINS a commit: `src/artifact-content.ts:473` runs
 * `git show <ref>:<relativePath>` for a recorded 40–64-hex `ref`. That returns
 * the bytes Mandible *already exported*, so it can never observe a later
 * external edit and would always report "clean". Drift detection must therefore
 * compare against the **live** repo HEAD and working tree — which is exactly
 * what {@link checkExportDrift} does. (It also uses `git show`, but against the
 * *current* docs-branch HEAD, not the pinned export commit.)
 *
 * ## The §6 four-step live comparison
 *
 *   1. Hash `git show <last_export_commit>:<path>` — the bytes we exported.
 *   2. Hash `git show <current HEAD>:<path>` — committed-but-newer bytes.
 *   3. Hash the working-tree file at `<path>` — uncommitted bytes.
 *   4. Inspect dirty/staged status of `<path>`.
 *
 * Plus a fifth Mandible-side observation: hash the document's CURRENT serialized
 * `spaces-doc.v1` bytes. A pending Mandible-side edit against a tracked export is
 * the `stale` state (§6 table, last row).
 *
 * ## Status mapping (custody-doc §6 table)
 *
 *   - `clean`         — HEAD path hash == last-export hash, working tree clean.
 *   - `repo_changed`  — HEAD path hash differs from last-export hash.
 *   - `worktree_dirty`— working-tree path hash differs from HEAD (dirty/staged).
 *   - `conflict`      — our content hash AND the repo's both moved divergently.
 *   - `stale`         — only Mandible-side edits pending against a tracked export.
 *
 * `last_seen_commit` / `last_seen_content_sha256` are recorded on EVERY check.
 *
 * Git/filesystem effects are injected through {@link DriftGitRunner} so the
 * decision logic is unit-testable without a real repo (mirroring C13b's
 * `ExportGitRunner` seam). The default runner shells out to git against the same
 * managed docs worktree C13b provisions.
 */

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { Db } from "../db.js";
import {
  ExportError,
  getProjectCheckout,
  getSpaceExport,
  listSpaceExportsForSpace,
  serializeSpaceDocument,
  type SpaceExportRow,
} from "./export.js";

/** The drift states a tracked export can be in (custody-doc §6). */
export type DriftStatus = "clean" | "stale" | "repo_changed" | "worktree_dirty" | "conflict";

function sha256Hex(text: string): string {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Strip the volatile `mandible_exported_at` frontmatter line that
 * `buildSpaceDocTree` stamps on every serialization (export.ts). Without this,
 * comparing the current Mandible serialization against the exported bytes would
 * ALWAYS differ on the timestamp and report a spurious `stale` even when no
 * authored block changed. The normalized hash compares the actual document
 * content, not the export instant.
 */
function normalizeVolatileFrontmatter(text: string): string {
  return text
    .split("\n")
    .filter((line) => !/^mandible_exported_at:\s/.test(line))
    .join("\n");
}

/** Content hash with the volatile export timestamp normalized out. */
function normalizedContentHash(text: string): string {
  return sha256Hex(normalizeVolatileFrontmatter(text));
}

/**
 * Locate the managed docs worktree C13b provisions for a (repoRoot, branch).
 * Mirrors `defaultExportGitRunner.ensureWorktree`'s path scheme so drift reads
 * inspect the SAME live checkout the export op writes to. This is a pure path
 * computation — it never provisions a worktree (drift is read-only).
 */
export function docsWorktreeDir(repoRoot: string, branch: string): string {
  const safeBranch = branch.replace(/[^A-Za-z0-9._-]+/g, "_");
  return path.join(repoRoot, ".git", "mandible-docs-worktrees", safeBranch);
}

/**
 * The injectable git/filesystem seam for drift detection. Every method observes
 * the **live** docs worktree — none of them pins the recorded export commit
 * (that is the whole point of §6). `worktreeDir` is the managed docs checkout
 * for the export's (repo, branch).
 */
export interface DriftGitRunner {
  /** True when the managed docs worktree exists on disk (provisioned by C13b). */
  worktreeExists(worktreeDir: string): boolean;
  /** Current docs-branch HEAD commit sha (null when unborn / unresolved). */
  headCommit(worktreeDir: string): string | null;
  /**
   * Raw text of the file at `<commit>:<path>` in the worktree's repo, returned
   * VERBATIM (no trailing-newline trim), or null when the path is absent at that
   * commit. Used for both the recorded export commit (step 1) and the live HEAD
   * (step 2). Returning text (not a hash) lets the caller hash it two ways: a
   * byte-exact hash for repo-vs-repo comparison, and a timestamp-normalized hash
   * for the Mandible-side `stale` comparison.
   */
  blobTextAt(worktreeDir: string, commit: string, relativePath: string): string | null;
  /** Raw working-tree text at `<path>` (step 3) VERBATIM, or null when missing. */
  worktreeFileText(worktreeDir: string, relativePath: string): string | null;
  /** True when `<path>` has uncommitted (dirty/staged) changes (step 4). */
  isPathDirty(worktreeDir: string, relativePath: string): boolean;
}

function runGit(cwd: string, args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
  return {
    ok: result.status === 0,
    // NOTE: stdout is returned VERBATIM. Trailing-newline trimming is the
    // caller's job — for `git show <commit>:<path>` we must hash the bytes
    // exactly as committed (a stripped trailing newline would make the
    // committed blob hash diverge from the working-tree file hash and falsely
    // report `worktree_dirty`).
    stdout: result.stdout ?? "",
    stderr: (result.stderr ?? "").trim(),
  };
}

/**
 * Default runner: real git reads against the managed docs worktree. Every read
 * targets the live repo state (current HEAD / working tree), never a pinned
 * artifact materialization (§6).
 */
export const defaultDriftGitRunner: DriftGitRunner = {
  worktreeExists(worktreeDir: string): boolean {
    return fs.existsSync(path.join(worktreeDir, ".git"));
  },

  headCommit(worktreeDir: string): string | null {
    const head = runGit(worktreeDir, ["rev-parse", "--verify", "--quiet", "HEAD"]);
    const sha = head.stdout.trim();
    return head.ok && sha ? sha : null;
  },

  blobTextAt(worktreeDir: string, commit: string, relativePath: string): string | null {
    const show = runGit(worktreeDir, ["show", `${commit}:${relativePath}`]);
    if (!show.ok) return null;
    return show.stdout;
  },

  worktreeFileText(worktreeDir: string, relativePath: string): string | null {
    const abs = path.join(worktreeDir, relativePath);
    if (!fs.existsSync(abs)) return null;
    return fs.readFileSync(abs, "utf8");
  },

  isPathDirty(worktreeDir: string, relativePath: string): boolean {
    const status = runGit(worktreeDir, ["status", "--porcelain", "--", relativePath]);
    if (!status.ok) {
      throw new ExportError("git_failed", `git status failed: ${status.stderr}`);
    }
    return status.stdout.trim().length > 0;
  },
};

// --- pure status decision ----------------------------------------------------

/**
 * The four §6 live observations plus the resolved Mandible-side move flag.
 *
 * The three byte hashes (`exportedHash` / `headHash` / `worktreeHash`) are
 * VERBATIM content hashes for repo-vs-repo comparison. `mandibleMoved` is the
 * caller-resolved Mandible-side signal: it is computed with the volatile
 * `mandible_exported_at` frontmatter timestamp normalized OUT on both sides, so
 * an unchanged document is not perpetually reported `stale` just because each
 * re-serialization stamps a new export time.
 */
export interface DriftObservation {
  /** Step 1: hash of the recorded `last_export_commit:<path>` bytes. */
  exportedHash: string | null;
  /** Step 2: hash of the live `HEAD:<path>` committed bytes. */
  headHash: string | null;
  /** Step 3: hash of the working-tree file at `<path>`. */
  worktreeHash: string | null;
  /** Step 4: `<path>` carries uncommitted (dirty/staged) changes. */
  dirty: boolean;
  /**
   * True when the document's CURRENT Mandible serialization differs from the
   * exported content (timestamp-normalized) — i.e. authored edits are pending
   * against the tracked export.
   */
  mandibleMoved: boolean;
}

/**
 * Map a {@link DriftObservation} to a {@link DriftStatus} per the custody-doc §6
 * table. This is the load-bearing decision; it is pure so every status
 * transition is directly unit-testable.
 *
 * Precedence (most-severe wins):
 *   1. `conflict`      — the repo moved (HEAD ≠ exported) AND Mandible moved
 *      (current serialization ≠ last export) divergently.
 *   2. `repo_changed`  — the committed repo bytes moved away from our export.
 *   3. `worktree_dirty`— the working tree differs from HEAD (uncommitted edit).
 *   4. `stale`         — only the Mandible side moved; the repo is unchanged.
 *   5. `clean`         — HEAD matches the export and the working tree is clean.
 */
export function decideDriftStatus(obs: DriftObservation): DriftStatus {
  const repoMoved =
    obs.headHash !== null && obs.exportedHash !== null && obs.headHash !== obs.exportedHash;
  const worktreeMoved =
    obs.worktreeHash !== null && obs.headHash !== null && obs.worktreeHash !== obs.headHash;
  const mandibleMoved = obs.mandibleMoved;

  // (1) Both sides moved divergently → conflict. A repo move plus a pending
  // Mandible-side edit means re-export and re-import would each clobber the
  // other; the user must reconcile explicitly (§6).
  if (repoMoved && mandibleMoved) return "conflict";

  // (2) The committed repo bytes moved away from what we exported.
  if (repoMoved) return "repo_changed";

  // (3) The working tree carries an uncommitted edit against HEAD. We trust a
  // hash divergence; we also honor an explicit dirty/staged signal even when the
  // committed HEAD bytes are unobservable (e.g. a path with no HEAD blob yet).
  if (worktreeMoved || (obs.dirty && obs.worktreeHash !== null && obs.headHash === null)) {
    return "worktree_dirty";
  }

  // (4) Only the Mandible authoring side moved; the repo is unchanged.
  if (mandibleMoved) return "stale";

  // (5) Nothing moved.
  return "clean";
}

// --- drift check (per `space_exports` row) -----------------------------------

export interface DriftCheckResult {
  export_id: string;
  status: DriftStatus;
  /** True when the persisted row's status/last_seen fields changed this check. */
  changed: boolean;
  /** Live docs-branch HEAD commit observed (recorded as `last_seen_commit`). */
  last_seen_commit: string | null;
  /** Live working-tree content hash observed (`last_seen_content_sha256`). */
  last_seen_content_sha256: string | null;
  /** The four §6 observations, surfaced for UI diff affordances + tests. */
  observation: DriftObservation;
}

/**
 * Run the §6 drift check against the LIVE docs worktree for one `space_exports`
 * row, persist `status` + `last_seen_commit` + `last_seen_content_sha256`, and
 * return the result. Read-with-side-effect: the check never mutates the repo,
 * only refreshes the tracking row's observed-state columns.
 *
 * Mandible-custody documents (no row) never reach here — there is nothing to
 * drift against until an explicit export (§2.2). A row with `authority` other
 * than `repo` is reported `clean` (it is not repo-tracked).
 */
export function checkExportDrift(
  db: Db,
  exportId: string,
  options: { git?: DriftGitRunner; now?: number } = {},
): DriftCheckResult {
  const git = options.git ?? defaultDriftGitRunner;
  const now = options.now ?? Date.now();

  const row = getSpaceExport(db, exportId);
  if (!row) throw new ExportError("space_not_found", `space export not found: ${exportId}`);

  const checkout = getProjectCheckout(db, row.repo_id);
  if (!checkout) {
    throw new ExportError("checkout_not_found", `repo checkout not found: ${row.repo_id}`);
  }

  const worktreeDir = docsWorktreeDir(checkout.root, row.branch);

  // The document's CURRENT Mandible serialization (the authoring side), with the
  // volatile export timestamp normalized out for `stale` comparison.
  const mandibleNormalized = normalizedContentHash(serializeSpaceDocument(db, row.space_id, now));

  // When the managed docs worktree was never provisioned the export's repo bytes
  // are unobservable. The recorded export still stands; Mandible-side edits can
  // still make it `stale`, but we cannot claim a repo move we cannot see. Without
  // the exported text we cannot normalize the export side, so we fall back to a
  // not-moved assumption (no false `stale` against an unreadable export).
  if (!git.worktreeExists(worktreeDir)) {
    const observation: DriftObservation = {
      exportedHash: row.last_export_content_sha256,
      headHash: null,
      worktreeHash: null,
      dirty: false,
      mandibleMoved: false,
    };
    const status = decideDriftStatus(observation);
    const persisted = persistDriftState(db, row, {
      status,
      lastSeenCommit: row.last_seen_commit,
      lastSeenContentSha: row.last_seen_content_sha256,
      now,
    });
    return {
      export_id: row.id,
      status,
      changed: persisted.changed,
      last_seen_commit: row.last_seen_commit,
      last_seen_content_sha256: row.last_seen_content_sha256,
      observation,
    };
  }

  const headCommit = git.headCommit(worktreeDir);

  // Step 1: bytes we exported (pinned to the recorded export commit).
  const exportedText = row.last_export_commit
    ? git.blobTextAt(worktreeDir, row.last_export_commit, row.path)
    : null;
  const exportedHash = exportedText !== null ? sha256Hex(exportedText) : row.last_export_content_sha256;
  // Step 2: committed-but-newer bytes at live HEAD.
  const headText = headCommit ? git.blobTextAt(worktreeDir, headCommit, row.path) : null;
  const headHash = headText !== null ? sha256Hex(headText) : null;
  // Step 3: uncommitted working-tree bytes.
  const worktreeText = git.worktreeFileText(worktreeDir, row.path);
  const worktreeHash = worktreeText !== null ? sha256Hex(worktreeText) : null;
  // Step 4: dirty/staged status of the path.
  const dirty = git.isPathDirty(worktreeDir, row.path);

  // Mandible-side move: compare the current serialization against the exported
  // content, both timestamp-normalized. Use the exported-commit text when we have
  // it (most precise); otherwise the live HEAD text as the repo's current view.
  const exportBaselineText = exportedText ?? headText;
  const mandibleMoved =
    exportBaselineText !== null
      ? mandibleNormalized !== normalizedContentHash(exportBaselineText)
      : false;

  const observation: DriftObservation = {
    exportedHash,
    headHash,
    worktreeHash,
    dirty,
    mandibleMoved,
  };
  const status = decideDriftStatus(observation);

  // `last_seen_*` reflects the live observation: the HEAD we saw and the bytes
  // currently on disk (working tree, the most "live" view of the path).
  const lastSeenCommit = headCommit;
  const lastSeenContentSha = worktreeHash ?? headHash ?? row.last_seen_content_sha256;

  const persisted = persistDriftState(db, row, {
    status,
    lastSeenCommit,
    lastSeenContentSha,
    now,
  });

  return {
    export_id: row.id,
    status,
    changed: persisted.changed,
    last_seen_commit: lastSeenCommit,
    last_seen_content_sha256: lastSeenContentSha,
    observation,
  };
}

/**
 * Persist the computed drift `status` and the `last_seen_*` observation onto the
 * tracking row. Returns whether anything actually changed (so the read path can
 * decide whether to broadcast). `last_seen_*` is recorded on EVERY check (§6),
 * even when the status is unchanged.
 */
function persistDriftState(
  db: Db,
  row: SpaceExportRow,
  input: { status: DriftStatus; lastSeenCommit: string | null; lastSeenContentSha: string | null; now: number },
): { changed: boolean } {
  const changed =
    row.status !== input.status ||
    row.last_seen_commit !== input.lastSeenCommit ||
    row.last_seen_content_sha256 !== input.lastSeenContentSha;
  db.prepare(
    `UPDATE space_exports SET
       status = @status,
       last_seen_commit = @last_seen_commit,
       last_seen_content_sha256 = @last_seen_content_sha256,
       updated_at = @updated_at
     WHERE id = @id`,
  ).run({
    id: row.id,
    status: input.status,
    last_seen_commit: input.lastSeenCommit,
    last_seen_content_sha256: input.lastSeenContentSha,
    updated_at: input.now,
  });
  return { changed };
}

/**
 * Check drift for every tracked export of a Space and return the refreshed
 * results. The Space's Mandible-serialized bytes are common to each row, so a
 * `stale` state is shared across that Space's exports while repo/worktree drift
 * is per-(repo,branch,path).
 */
export function checkSpaceDrift(
  db: Db,
  spaceId: string,
  options: { git?: DriftGitRunner; now?: number } = {},
): DriftCheckResult[] {
  return listSpaceExportsForSpace(db, spaceId).map((row) =>
    checkExportDrift(db, row.id, options),
  );
}
