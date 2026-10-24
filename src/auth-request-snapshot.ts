/**
 * The canonical serialization of an auth request that lifecycle revisions hash.
 * Lifecycle compare-and-swap compares the latest revision's digest with this
 * serialization of the current row, so every writer of a revision, including
 * schema migrations, uses this one serializer.
 */
import { createHash } from "node:crypto";
import type { Db } from "./db.js";

export interface PublicationRow {
  id: string; space_id: string; source_revision: string; snapshot_ref: string; content: string;
  repo_id: string; path: string; expected_destination_sha256: string | null; expected_destination_mode: string | null;
  issue_id: string; message: string; branch: string; worktree: string; commit_sha: string; version_ref: string;
  auth_request_id: string | null; state: string;
}
function spacePublicationsExist(db: Db): boolean { return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='space_publications'").get(); }
export function authPublicationSnapshot(db: Db, requestId: string) {
  if (!spacePublicationsExist(db)) return null;
  const row = db.prepare("SELECT * FROM space_publications WHERE id = (SELECT space_publication_id FROM auth_requests WHERE id = ?)").get(requestId) as PublicationRow | undefined;
  if (!row) return null;
  return { id: row.id, space_id: row.space_id, source_revision: row.source_revision, snapshot_ref: row.snapshot_ref,
    repo_id: row.repo_id, path: row.path, expected_destination_sha256: row.expected_destination_sha256,
    expected_destination_mode: row.expected_destination_mode, issue_id: row.issue_id, message: row.message,
    branch: row.branch, worktree: row.worktree, commit_sha: row.commit_sha, version_ref: row.version_ref };
}
function parseJsonColumn(value: unknown): unknown {
  if (typeof value !== "string") return value ?? null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

export function authRequestSnapshot(db: Db, requestId: string): string {
  const row = db.prepare("SELECT * FROM auth_requests WHERE id = ?").get(requestId) as
    | Record<string, unknown>
    | undefined;
  if (!row) throw new Error(`Auth request '${requestId}' is missing.`);
  // Columns added after receipts existed appear only when set, so receipts
  // recorded before them keep verifying.
  const omittedWhenNull = ["space_publication_id", "protected_root_dirty_action_json"];
  const request = Object.fromEntries(Object.entries(row).filter(([key, value]) => !omittedWhenNull.includes(key) || value !== null).map(([key, value]) => [
    key,
    ["issue_ids", "issues", "issue_references", "issue_closures", "merge_finalizer_state", "change_report_json", "protected_root_dirty_action_json"].includes(key)
      ? parseJsonColumn(value)
      : value ?? null,
  ]));
  const actions = db.prepare(
    "SELECT * FROM auth_request_actions WHERE auth_request_id = ? ORDER BY ordinal, id",
  ).all(requestId).map((action) => {
    const record = action as Record<string, unknown>;
    return { ...record, payload: parseJsonColumn(record.payload) };
  });
  const publication = authPublicationSnapshot(db, requestId);
  return JSON.stringify({ request, actions, ...(publication ? { publication } : {}) });
}

export function authSnapshotDigest(snapshot: string): string {
  return createHash("sha256").update(snapshot).digest("hex");
}
