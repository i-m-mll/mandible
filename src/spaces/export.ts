import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Db } from "../db.js";
import type { Space } from "../contracts.js";
import { getSpace } from "../ledger/spaces.js";
import { listSpaceBlocks, toDocBlock } from "../ledger/space-blocks.js";
import { exportDocument, type DocBlock, type DocTree } from "./serialize.js";
// --- doc tree assembly -------------------------------------------------------

/**
 * Build the canonical {@link DocTree} for a Space from its `space_blocks` rows
 * plus document-level frontmatter. The serialized text is the lossless source
 * of truth; this is the export-side projection (C11 owns the table, C12 owns the
 * format).
 */
export function buildSpaceDocTree(db: Db, spaceId: string): DocTree {
  const space = getSpace(db, spaceId);
  if (!space) throw new ExportError("space_not_found", `space not found: ${spaceId}`);
  const storedBlocks = listSpaceBlocks(db, spaceId);
  const blocks: DocBlock[] = storedBlocks.map(toDocBlock);
  const frontmatter: Record<string, string> = {
    mandible_space: space.id,
    mandible_space_title: space.title,
    mandible_document_state: Buffer.from(JSON.stringify({
      description: space.description, metadata: space.metadata,
      blocks: Object.fromEntries(storedBlocks.map(block => [block.id,{ metadata:block.metadata,item_snapshot:block.item_snapshot }])),
    })).toString('base64'),
  };
  return { frontmatter, blocks };
}

/** Serialize a Space directly to canonical `spaces-doc.v1` text. */
export function serializeSpaceDocument(db: Db, spaceId: string): string {
  return exportDocument(buildSpaceDocTree(db, spaceId));
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
  | "locked"
  | "stale_destination"
  | "invalid_publication";

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
  space: Space,
  explicitRepoId?: string | null,
): ProjectCheckout {
  if (explicitRepoId) {
    const checkout = getProjectCheckout(db, explicitRepoId);
    if (!checkout) throw new ExportError("checkout_not_found", `repo checkout not found: ${explicitRepoId}`);
    if (space.project_id !== null && checkout.project_id !== space.project_id) {
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
): UntrackedExportResult {
  const space = getSpace(db, input.spaceId);
  if (!space) throw new ExportError("space_not_found", `space not found: ${input.spaceId}`);
  if (!path.isAbsolute(input.destPath)) {
    throw new ExportError("invalid_path", "untracked export destPath must be absolute");
  }
  const docText = serializeSpaceDocument(db, space.id);
  const contentSha = sha256Hex(docText);
  fs.mkdirSync(path.dirname(input.destPath), { recursive: true });
  fs.writeFileSync(input.destPath, docText, "utf8");

  let warning: "local_only" | null = null;
  if (input.repoId) {
    const checkout = getProjectCheckout(db, input.repoId);
    if (checkout && isInsideRepoUntracked(checkout.root, input.destPath)) {
      warning = "local_only";
    }
  }
  return { path: input.destPath, bytes: Buffer.byteLength(docText, "utf8"), content_sha256: contentSha, warning };
}


function isInsideRepoUntracked(repoRoot: string, destPath: string): boolean {
  const rel = path.relative(path.resolve(repoRoot), path.resolve(destPath));
  if (rel.startsWith("..") || path.isAbsolute(rel)) return false;
  const result = spawnSync("git", ["ls-files", "--error-unmatch", "--", rel], {
    cwd: repoRoot, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" }, encoding: "utf8",
  });
  return result.status !== 0;
}
function sha256Hex(text: string): string {
  return crypto.createHash("sha256").update(text).digest("hex");
}
