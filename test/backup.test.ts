import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import SqliteDatabase from "../src/sqlite.ts";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RequestLike, ResponseLike, RouteHandler, RouteRegistrar } from "../src/server.js";
import { setupOperator } from "../src/users/store.js";
import { authenticatedTestIdentity } from "./helpers/authenticated-router.js";

class TestRoutes implements RouteRegistrar {
  private readonly handlers = new Map<string, RouteHandler>();

  get(routePath: string, handler: RouteHandler): void {
    this.handlers.set(`GET ${routePath}`, handler);
  }

  post(routePath: string, handler: RouteHandler): void {
    this.handlers.set(`POST ${routePath}`, handler);
  }

  put(routePath: string, handler: RouteHandler): void {
    this.handlers.set(`PUT ${routePath}`, handler);
  }

  patch(routePath: string, handler: RouteHandler): void {
    this.handlers.set(`PATCH ${routePath}`, handler);
  }

  delete(routePath: string, handler: RouteHandler): void {
    this.handlers.set(`DELETE ${routePath}`, handler);
  }

  handler(method: string, routePath: string): RouteHandler {
    const handler = this.handlers.get(`${method} ${routePath}`);
    if (!handler) {
      throw new Error(`Missing handler for ${method} ${routePath}`);
    }
    return handler;
  }
}

function createResponse(): ResponseLike & { statusCode: number; payload: unknown } {
  return {
    statusCode: 200,
    payload: undefined,
    status(code: number): ResponseLike {
      this.statusCode = code;
      return this;
    },
    json(payload: unknown): void {
      this.payload = payload;
    },
  };
}

let operator: ReturnType<typeof setupOperator>;

function request(method: string, url: string, body?: unknown): RequestLike {
  return {
    method,
    url,
    params: {},
    query: {},
    body,
    client_identity: authenticatedTestIdentity(operator),
  };
}

describe("backup routes", () => {
  const originalHome = process.env.HOME;
  let tempHome = "";
  let db: import("../src/db.js").Db | undefined;

  afterEach(() => {
    db?.close();
    db = undefined;
    process.env.HOME = originalHome;
    vi.resetModules();
    if (tempHome) {
      fs.rmSync(tempHome, { recursive: true, force: true });
      tempHome = "";
    }
  });

  async function setupBackupRoutes() {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-backup-home-"));
    process.env.HOME = tempHome;
    vi.resetModules();

    const { openDb, setDb } = await import("../src/db.js");
    db = openDb(path.join(tempHome, "mandible.db"));
    setDb(db);
    operator = setupOperator(db, { display_name: "Backup route test operator" });

    const { registerBackupRoutes } = await import("../src/routes/backup.js");
    const routes = new TestRoutes();
    registerBackupRoutes(routes);
    return { routes, db };
  }

  it("runs an in-process metadata dump and excludes reproducible or runtime rows", async () => {
    const { routes, db } = await setupBackupRoutes();
    const dotfilesBin = path.join(tempHome, ".dotfiles", "bin");
    const sentinel = path.join(tempHome, "external-script-ran");
    fs.mkdirSync(dotfilesBin, { recursive: true });
    fs.writeFileSync(
      path.join(dotfilesBin, "mandible-backup"),
      `#!/usr/bin/env bash\ntouch ${JSON.stringify(sentinel)}\nexit 73\n`,
      "utf8",
    );
    fs.chmodSync(path.join(dotfilesBin, "mandible-backup"), 0o755);

    db.prepare(
      `INSERT INTO ledger_projects
        (id, display_name, remote_identity, upstream_identity, namespace_policy, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run("prj_backup", "Backup Project", "local:backup", "", "local", 1000, 1000);
    db.prepare(
      `INSERT INTO conversations
        (id, source, source_path, source_hash, source_mtime, started_at, session_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run("conv_backup", "codex", "/tmp/conversation.jsonl", "hash", 1, "2026-06-13T00:00:00Z", "session");
    db.prepare(
      `INSERT INTO conversation_blocks
        (id, conversation_id, type, role, content, position)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("block_backup", "conv_backup", "message", "assistant", "large reproducible block", 1);
    db.prepare(
      `INSERT INTO daemon_log (id, ts, level, event, subsystem, fields_json)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      "log_backup",
      1,
      "debug",
      "backup_runtime_sentinel",
      "backup-test",
      '{"payload":"large operational telemetry"}',
    );

    const destination = path.join(tempHome, "configured", "mandible-metadata.sql");
    db.prepare("INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)").run(
      "backup.destination",
      destination,
      1,
    );

    const res = createResponse();
    await routes.handler("POST", "/api/backup/run")(request("POST", "/api/backup/run"), res);

    expect(res.statusCode).toBe(200);
    expect(res.payload).toMatchObject({
      ok: true,
      path: destination,
      size_bytes: expect.any(Number),
    });
    expect(fs.existsSync(sentinel)).toBe(false);

    const dump = fs.readFileSync(destination, "utf8");
    expect(dump).toContain("ledger_projects");
    expect(dump).toContain("Backup Project");
    expect(dump).not.toContain("conversation_blocks");
    expect(dump).not.toContain("large reproducible block");
    expect(dump).not.toContain("daemon_log");
    expect(dump).not.toContain("backup_runtime_sentinel");
    expect(dump).not.toContain("large operational telemetry");
  });

  // Issue 24f0316 — backups are durable state, so they are written under the
  // durable root rather than the disposable cache root. The read side stays
  // aware of the old location: the existing backup directory holds gigabytes,
  // and relocating it at startup would be a large unrequested copy.
  it("defaults the backup destination to the durable root", async () => {
    await setupBackupRoutes();
    const { getDefaultMetadataBackupPath, getLegacyMetadataBackupPath } = await import(
      "../src/ledger/backup.js"
    );

    expect(getDefaultMetadataBackupPath()).toBe(
      path.join(tempHome, ".mandible", "backups", "mandible-metadata.sql"),
    );
    expect(getLegacyMetadataBackupPath()).toBe(
      path.join(tempHome, ".cache", "mandible", "backups", "mandible-metadata.sql"),
    );
  });

  it("reports a backup left at the pre-split location without moving it", async () => {
    const { routes } = await setupBackupRoutes();
    const { getLegacyMetadataBackupPath } = await import("../src/ledger/backup.js");
    const legacyBackup = getLegacyMetadataBackupPath();
    fs.mkdirSync(path.dirname(legacyBackup), { recursive: true });
    fs.writeFileSync(legacyBackup, "-- legacy dump\n", "utf8");

    const statusRes = createResponse();
    await routes.handler("GET", "/api/backup/status")(
      request("GET", "/api/backup/status"),
      statusRes,
    );

    expect((statusRes.payload as { existing_backup_paths: string[] }).existing_backup_paths).toEqual(
      [legacyBackup],
    );
    // Report-only: the bytes stay exactly where they were found.
    expect(fs.readFileSync(legacyBackup, "utf8")).toBe("-- legacy dump\n");
  });

  it("writes new backups to the durable root and then reports both locations", async () => {
    const { routes } = await setupBackupRoutes();
    const { getDefaultMetadataBackupPath, getLegacyMetadataBackupPath } = await import(
      "../src/ledger/backup.js"
    );
    const legacyBackup = getLegacyMetadataBackupPath();
    fs.mkdirSync(path.dirname(legacyBackup), { recursive: true });
    fs.writeFileSync(legacyBackup, "-- legacy dump\n", "utf8");

    const runRes = createResponse();
    await routes.handler("POST", "/api/backup/run")(request("POST", "/api/backup/run"), runRes);
    expect(runRes.payload).toMatchObject({ ok: true, path: getDefaultMetadataBackupPath() });

    const statusRes = createResponse();
    await routes.handler("GET", "/api/backup/status")(
      request("GET", "/api/backup/status"),
      statusRes,
    );
    expect((statusRes.payload as { existing_backup_paths: string[] }).existing_backup_paths).toEqual(
      [getDefaultMetadataBackupPath(), legacyBackup],
    );
  });

  it("uses a non-dotfiles default destination and accepts a settings override", async () => {
    const { routes } = await setupBackupRoutes();

    const initialStatus = createResponse();
    await routes.handler("GET", "/api/backup/status")(
      request("GET", "/api/backup/status"),
      initialStatus,
    );
    expect(initialStatus.payload).toMatchObject({
      enabled: true,
      interval_hours: 6,
      destination: expect.any(String),
    });
    const defaultDestination = (initialStatus.payload as { destination: string }).destination;
    expect(defaultDestination).toContain(tempHome);
    expect(defaultDestination).not.toContain(".dotfiles");
    expect(path.basename(defaultDestination)).toBe("mandible-metadata.sql");

    const destination = path.join(tempHome, "override", "metadata.sql");
    const putRes = createResponse();
    await routes.handler("PUT", "/api/backup/settings")(
      request("PUT", "/api/backup/settings", { destination }),
      putRes,
    );
    expect(putRes.statusCode).toBe(200);

    const nextStatus = createResponse();
    await routes.handler("GET", "/api/backup/status")(
      request("GET", "/api/backup/status"),
      nextStatus,
    );
    expect(nextStatus.payload).toMatchObject({ destination });

    const runRes = createResponse();
    await routes.handler("POST", "/api/backup/run")(request("POST", "/api/backup/run"), runRes);
    expect(runRes.payload).toMatchObject({
      ok: true,
      path: destination,
      size_bytes: expect.any(Number),
    });
    expect(fs.existsSync(destination)).toBe(true);
  });

  it("includes artifact identity tables and secondary indexes in metadata backup", async () => {
    const { db } = await setupBackupRoutes();
    const { METADATA_BACKUP_TABLES, buildMetadataBackupSql } = await import("../src/ledger/backup.js");

    const idx = (table: string) => METADATA_BACKUP_TABLES.indexOf(table as never);
    expect(idx("artifact_blob")).toBeGreaterThan(idx("artifacts"));
    expect(idx("artifact")).toBeGreaterThan(idx("artifact_blob"));
    expect(idx("artifact_version")).toBeGreaterThan(idx("artifact"));
    expect(idx("artifact_links")).toBeGreaterThan(idx("artifact_version"));
    expect(idx("project_artifact_associations")).toBeGreaterThan(idx("artifact_versions"));

    db.prepare(
      `INSERT INTO artifact_blob (id, algorithm, content_hash, storage_uri, created_at)
       VALUES ('artifact-blob:hash-bk', 'sha256', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'file:///tmp/hash-bk', 1)`,
    ).run();
    db.prepare(
      `INSERT INTO artifact (id, identity_key, source_kind, title, version_count, created_at, updated_at)
       VALUES ('artifact:bk', 'managed:test:bk', 'managed', 'Backup artifact', 1, 1, 1)`,
    ).run();
    db.prepare(
      `INSERT INTO artifact_version (
        id, artifact_id, version_no, blob_id, source_kind, content_hash, custody_mode, created_at
      ) VALUES ('artifact-version:bk-v1', 'artifact:bk', 1, 'artifact-blob:hash-bk', 'managed', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'managed', 1)`,
    ).run();

    const dump = buildMetadataBackupSql(db);
    expect(dump).toContain("-- Table: artifact_blob");
    expect(dump).toContain("-- Table: artifact");
    expect(dump).toContain("-- Table: artifact_version");
    expect(dump).toContain("-- Table: project_artifact_associations");
    expect(dump).toContain("idx_artifact_version_blob");
    expect(dump).toContain("idx_project_artifact_assoc_target");
  });

  it("streams the same restorable SQL through an atomic backup file", async () => {
    const { db } = await setupBackupRoutes();
    const { buildMetadataBackupSql, writeMetadataBackup } = await import("../src/ledger/backup.js");
    const destination = path.join(tempHome, "streamed-metadata.sql");
    fs.writeFileSync(destination, "previous backup", "utf8");

    const result = writeMetadataBackup(db, destination);
    const streamed = fs.readFileSync(destination, "utf8");
    const expected = buildMetadataBackupSql(db);
    const withoutTimestamp = (sql: string) => sql.replace(/^-- Generated: .*$/m, "-- Generated: <timestamp>");
    expect(withoutTimestamp(streamed)).toBe(withoutTimestamp(expected));
    expect(result.size_bytes).toBe(Buffer.byteLength(streamed));
    expect(fs.readdirSync(tempHome).some((name) => name.endsWith(".tmp"))).toBe(false);

    const restored = new SqliteDatabase(":memory:");
    try {
      restored.exec(streamed);
      expect(restored.pragma("foreign_key_check")).toEqual([]);
    } finally {
      restored.close();
    }
  });

  it("round-trips an actual trash custody row with canonical parents", async () => {
    const { db } = await setupBackupRoutes();
    const { buildMetadataBackupSql } = await import("../src/ledger/backup.js");
    db.prepare(
      `INSERT INTO ledger_projects
        (id, project_key, display_name, remote_identity, upstream_identity,
         namespace_policy, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("prj_trash_backup", "trash-backup", "Trash Backup", "local:trash", "", "local", 1, 1);
    db.prepare(
      `INSERT INTO ledger_project_checkouts
        (id, project_id, work_repo_id, root, name, default_branch, remote_url, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "checkout_trash_backup",
      "prj_trash_backup",
      "trash-backup-local",
      "/registered/trash-backup",
      "trash-backup",
      "main",
      "",
      1,
      1,
    );
    db.prepare(
      `INSERT INTO trash_entries (
        id, project_id, checkout_id, repo_root, branch, issue_refs_json,
        reason, actor, snapshot_ref, snapshot_oid, original_oid,
        retention_policy, retention_days, state, created_at, expires_at, outcome_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "trash-backup-row",
      "prj_trash_backup",
      "checkout_trash_backup",
      "/registered/trash-backup",
      "feature/custodied",
      '["5cb1eb3"]',
      "superseded",
      "backup-test",
      "refs/mandible/trash/trash-backup-row",
      "a".repeat(40),
      "b".repeat(40),
      "trash-retention.v1",
      30,
      "gc_pending",
      1,
      2,
      '{"worktree_removed":true,"branch_removed":true}',
    );

    const restored = new SqliteDatabase(":memory:");
    try {
      restored.exec(buildMetadataBackupSql(db));
      expect(restored.prepare(
        `SELECT project_id, checkout_id, branch, snapshot_ref, state, outcome_json
           FROM trash_entries WHERE id = ?`,
      ).get("trash-backup-row")).toEqual({
        project_id: "prj_trash_backup",
        checkout_id: "checkout_trash_backup",
        branch: "feature/custodied",
        snapshot_ref: "refs/mandible/trash/trash-backup-row",
        state: "gc_pending",
        outcome_json: '{"worktree_removed":true,"branch_removed":true}',
      });
      expect(restored.pragma("foreign_key_check")).toEqual([]);
    } finally {
      restored.close();
    }
  });

});
