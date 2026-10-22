import SqliteDatabase from "../src/sqlite.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CURRENT_SCHEMA_VERSION, openDb, type Db } from "../src/db.js";
import {
  buildMetadataBackupSql,
  METADATA_BACKUP_TABLES,
  REPRODUCIBLE_OR_RUNTIME_TABLES,
} from "../src/ledger/backup.js";

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
  let tempDir = "";
  let dbPath = "";
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
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-exports-"));
    dbPath = path.join(tempDir, "mandible.db");
    db = openDb(dbPath);
  });
  afterEach(() => {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("creates the space_exports table at the head migration version", () => {
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'space_exports'")
      .get() as { name: string } | undefined;
    expect(row?.name).toBe("space_exports");
    // Third serial-chain link: contiguous version after C11's space_blocks (v84).
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(85);
  });

  it("inserts a tracking row keyed to a project checkout", () => {
    const projectId = seedProject();
    const spaceId = seedSpace(projectId);
    const repoId = seedCheckout(projectId);
    expect(() => insertExport(spaceId, repoId)).not.toThrow();
    const stored = db
      .prepare("SELECT authority, status FROM space_exports WHERE id = 'exp-1'")
      .get() as { authority: string; status: string };
    // Defaults applied.
    expect(stored.authority).toBe("mandible");
    expect(stored.status).toBe("clean");
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

  it("rejects invalid authority and status via CHECK", () => {
    const projectId = seedProject();
    const spaceId = seedSpace(projectId);
    const repoId = seedCheckout(projectId);
    expect(() => insertExport(spaceId, repoId, { id: "bad-auth", authority: "nobody" })).toThrow();
    expect(() => insertExport(spaceId, repoId, { id: "bad-status", status: "weird" })).toThrow();
    // Every documented authority/status value is accepted.
    let n = 0;
    for (const authority of ["mandible", "repo"]) {
      expect(() =>
        insertExport(spaceId, repoId, { id: `auth-${n}`, path: `auth-${n}.md`, authority }),
      ).not.toThrow();
      n += 1;
    }
    for (const status of ["clean", "stale", "repo_changed", "worktree_dirty", "conflict"]) {
      expect(() =>
        insertExport(spaceId, repoId, { id: `st-${n}`, path: `st-${n}.md`, status }),
      ).not.toThrow();
      n += 1;
    }
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

describe("space_exports metadata backup classification (issue 9041bb3)", () => {
  let tempDir = "";
  let db: Db;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-exports-bk-"));
    db = openDb(path.join(tempDir, "mandible.db"));
  });
  afterEach(() => {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("includes space_exports in METADATA_BACKUP_TABLES (drift guard fails if omitted)", () => {
    expect(METADATA_BACKUP_TABLES).toContain("space_exports");
    // It is a backed-up table, NOT classified as reproducible/runtime.
    expect((REPRODUCIBLE_OR_RUNTIME_TABLES as readonly string[]).includes("space_exports")).toBe(
      false,
    );
  });

  it("lists space_exports AFTER its space parent and the checkout identity table", () => {
    const idx = (t: string) => METADATA_BACKUP_TABLES.indexOf(t as never);
    expect(idx("space_exports")).toBeGreaterThan(idx("spaces"));
    // repo_id keys a backed-up checkout identity, so that table is in the set too.
    expect(idx("ledger_project_checkouts")).toBeGreaterThanOrEqual(0);
  });

  it("emits space_exports DDL in the backup", () => {
    db.prepare(
      `INSERT INTO ledger_projects (id, display_name, remote_identity, created_at, updated_at)
       VALUES ('p', 'P', 'github.com/test/p', ?, ?)`,
    ).run(now(), now());
    const sql = buildMetadataBackupSql(db);
    expect(sql).toContain("-- Table: space_exports");
    expect(sql).toContain("CREATE TABLE");
  });

  it("inline UNIQUE(repo_id, branch, path) survives a DDL-only restore round trip", () => {
    db.prepare(
      `INSERT INTO ledger_projects (id, display_name, remote_identity, created_at, updated_at)
       VALUES ('p', 'P', 'github.com/test/p', ?, ?)`,
    ).run(now(), now());
    db.prepare(
      `INSERT INTO spaces (id, project_id, title, created_at, updated_at)
       VALUES ('s', 'p', 'S', ?, ?)`,
    ).run(now(), now());
    db.prepare(
      `INSERT INTO ledger_project_checkouts (id, project_id, root, name, default_branch, remote_url, created_at, updated_at)
       VALUES ('c', 'p', '/tmp/r', 'r', 'main', 'github.com/test/r', ?, ?)`,
    ).run(now(), now());
    db.prepare(
      `INSERT INTO space_exports (id, space_id, repo_id, branch, path, created_at, updated_at)
       VALUES ('e1', 's', 'c', 'docs', 'docs/one.md', ?, ?)`,
    ).run(now(), now());

    const sql = buildMetadataBackupSql(db);
    const restorePath = path.join(tempDir, "restored.db");
    const restored = new SqliteDatabase(restorePath);
    restored.pragma("foreign_keys = ON");
    restored.exec(sql);

    // The original row round-trips.
    const restoredRow = restored
      .prepare("SELECT branch, path, authority, status FROM space_exports WHERE id = 'e1'")
      .get() as { branch: string; path: string; authority: string; status: string };
    expect(restoredRow).toMatchObject({ branch: "docs", path: "docs/one.md" });

    // The inline UNIQUE(repo_id, branch, path) survives: a duplicate identity is rejected.
    expect(() =>
      restored
        .prepare(
          `INSERT INTO space_exports (id, space_id, repo_id, branch, path, created_at, updated_at)
           VALUES ('e-dup', 's', 'c', 'docs', 'docs/one.md', ?, ?)`,
        )
        .run(now(), now()),
    ).toThrow();

    // A non-duplicate (different path) is still accepted post-restore.
    expect(() =>
      restored
        .prepare(
          `INSERT INTO space_exports (id, space_id, repo_id, branch, path, created_at, updated_at)
           VALUES ('e-ok', 's', 'c', 'docs', 'docs/two.md', ?, ?)`,
        )
        .run(now(), now()),
    ).not.toThrow();

    // The authority CHECK survives restore too.
    expect(() =>
      restored
        .prepare(
          `INSERT INTO space_exports (id, space_id, repo_id, branch, path, authority, created_at, updated_at)
           VALUES ('e-bad', 's', 'c', 'docs', 'docs/three.md', 'bogus', ?, ?)`,
        )
        .run(now(), now()),
    ).toThrow();

    restored.close();
  });
});
