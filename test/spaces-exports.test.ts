// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { type Db } from "../src/db.js";
import { migratedMemoryDb } from "./helpers/ledger-fixtures.js";

// Issue 9041bb3 (umbrella de56ffa): Spaces document-custody tracking — the
// space_exports table (THIRD serial-chain migration, per
// docs/spaces/DOCUMENT-CUSTODY-DESIGN.md §2.1), keyed to the BACKED-UP
// ledger_project_checkouts.id (NOT work_repos.id), with an inline
// UNIQUE(repo_id, branch, path) that survives backup/restore. Schema + backup
// only — no export/commit backend (C13b), drift (C13c), or UI (C13d) here.

function now(): number {
  return Date.now();
}

// ============================================================================
// Schema / migration (direct DB)
// ============================================================================

describe("space_exports schema (issue 9041bb3)", () => {
  let db: Db;

  function seedProject(id = "proj-1"): string {
    db.prepare(
      `INSERT INTO ledger_projects (id, display_name, remote_identity, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(id, "Test Project", `github.com/test/${id}`, now(), now());
    return id;
  }
  function seedSpace(projectId: string, id = "space-1"): string {
    db.prepare(
      `INSERT INTO spaces (id, project_id, title, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(id, projectId, "Space One", now(), now());
    return id;
  }
  function seedCheckout(projectId: string, id = "checkout-1", root = "/tmp/repo-1"): string {
    db.prepare(
      `INSERT INTO ledger_project_checkouts (id, project_id, root, name, default_branch, remote_url, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, projectId, root, "repo-1", "main", "github.com/test/repo-1", now(), now());
    return id;
  }
  function seedBlob(contentHash: string): string {
    const id = `artifact-blob:${contentHash}`;
    db.prepare(
      `INSERT INTO artifact_blob (id, algorithm, content_hash, storage_uri, created_at)
       VALUES (?, 'sha256', ?, ?, ?)`,
    ).run(id, contentHash, `artifact://${id}`, now());
    return id;
  }
  function insertExport(
    spaceId: string,
    repoId: string,
    opts: {
      id?: string;
      branch?: string;
      path?: string;
      authority?: string;
      status?: string;
      lastExportBlobId?: string | null;
      preExportSnapshotBlobId?: string | null;
    } = {},
  ): void {
    db.prepare(
      `INSERT INTO space_exports (
         id, space_id, repo_id, branch, path, authority, status,
         last_export_blob_id, pre_export_snapshot_blob_id,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      opts.id ?? "exp-1",
      spaceId,
      repoId,
      opts.branch ?? "docs",
      opts.path ?? "docs/spaces/one.md",
      opts.authority ?? "mandible",
      opts.status ?? "clean",
      opts.lastExportBlobId ?? null,
      opts.preExportSnapshotBlobId ?? null,
      now(),
      now(),
    );
  }

  beforeEach(() => {
    db = migratedMemoryDb();
  });
  afterEach(() => {
    db.close();
  });

  it("keys repo_id to ledger_project_checkouts (backed-up), NOT work_repos", () => {
    const projectId = seedProject();
    const spaceId = seedSpace(projectId);
    // A work_repos id is NOT a valid repo_id: the FK target is the BACKED-UP
    // checkout table, not the excluded runtime work_repos table. Even though this
    // id exists in work_repos, it is rejected because the FK points at the checkout.
    db.prepare(
      `INSERT INTO work_repos (id, root, name, created_at, updated_at)
       VALUES ('wr-1', '/tmp/wr', 'wr', ?, ?)`,
    ).run(now(), now());
    expect(() => insertExport(spaceId, "wr-1")).toThrow();
    // The repo identity must be a backed-up checkout id.
    const repoId = seedCheckout(projectId);
    expect(() => insertExport(spaceId, repoId)).not.toThrow();
  });

  it("enforces the inline UNIQUE(repo_id, branch, path) identity", () => {
    const projectId = seedProject();
    const spaceId = seedSpace(projectId);
    const repoId = seedCheckout(projectId);
    insertExport(spaceId, repoId, { id: "exp-1", branch: "docs", path: "a.md" });
    // Same (repo_id, branch, path) → rejected.
    expect(() =>
      insertExport(spaceId, repoId, { id: "exp-dup", branch: "docs", path: "a.md" }),
    ).toThrow();
    // Different branch is fine.
    expect(() =>
      insertExport(spaceId, repoId, { id: "exp-2", branch: "main", path: "a.md" }),
    ).not.toThrow();
    // Different path is fine.
    expect(() =>
      insertExport(spaceId, repoId, { id: "exp-3", branch: "docs", path: "b.md" }),
    ).not.toThrow();
  });

  it("CASCADEs exports on space deletion; RESTRICTs deleting a tracked checkout", () => {
    const projectId = seedProject();
    const spaceId = seedSpace(projectId);
    const repoId = seedCheckout(projectId);
    insertExport(spaceId, repoId);
    // The checkout cannot be deleted while a tracking row references it (RESTRICT).
    expect(() =>
      db.prepare("DELETE FROM ledger_project_checkouts WHERE id = ?").run(repoId),
    ).toThrow();
    // Deleting the Space tears down its export tracking rows (CASCADE).
    db.prepare("DELETE FROM spaces WHERE id = ?").run(spaceId);
    const remaining = db
      .prepare("SELECT COUNT(*) AS n FROM space_exports WHERE space_id = ?")
      .get(spaceId) as { n: number };
    expect(remaining.n).toBe(0);
  });

  it("nulls blob links on blob deletion (ON DELETE SET NULL)", () => {
    const projectId = seedProject();
    const spaceId = seedSpace(projectId);
    const repoId = seedCheckout(projectId);
    const lastBlob = seedBlob("a".repeat(64));
    const snapBlob = seedBlob("b".repeat(64));
    insertExport(spaceId, repoId, {
      lastExportBlobId: lastBlob,
      preExportSnapshotBlobId: snapBlob,
    });
    db.prepare("DELETE FROM artifact_blob WHERE id = ?").run(lastBlob);
    const row = db
      .prepare(
        "SELECT last_export_blob_id, pre_export_snapshot_blob_id FROM space_exports WHERE id = 'exp-1'",
      )
      .get() as { last_export_blob_id: string | null; pre_export_snapshot_blob_id: string | null };
    // The mutable tracking row survives; only the blob link is nulled.
    expect(row.last_export_blob_id).toBeNull();
    expect(row.pre_export_snapshot_blob_id).toBe(snapBlob);
  });
});

// ============================================================================
// Backup classification + restore round trip
// ============================================================================

