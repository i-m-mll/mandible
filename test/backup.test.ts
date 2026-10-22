import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import SqliteDatabase from "../src/sqlite.ts";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RequestLike, ResponseLike, RouteHandler, RouteRegistrar } from "../src/server.js";
import {
  buildMetadataBackupSql,
  getUnclassifiedBackupTables,
  listUserTables,
  METADATA_BACKUP_TABLES,
  REPRODUCIBLE_OR_RUNTIME_TABLES,
} from "../src/ledger/backup.js";
import { addProject } from "../src/ledger/project-registry.js";
import { LedgerStore } from "../src/ledger/store.js";
import { createUser, setupOperator } from "../src/users/store.js";
import { authenticatedTestIdentity } from "./helpers/authenticated-router.js";
import { migratedMemoryDb, SYSTEM_ACTOR } from "./helpers/ledger-fixtures.js";

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

});

describe("metadata backup coverage", () => {
  const backedUp = new Set<string>(METADATA_BACKUP_TABLES);

  it("classifies every table at head once and backs up every parent a backed-up table references", () => {
    const db = migratedMemoryDb();
    try {
      const tables = new Set(listUserTables(db));
      expect(getUnclassifiedBackupTables(db)).toEqual([]);
      expect(METADATA_BACKUP_TABLES.filter((table) => (REPRODUCIBLE_OR_RUNTIME_TABLES as readonly string[]).includes(table))).toEqual([]);
      expect([...METADATA_BACKUP_TABLES, ...REPRODUCIBLE_OR_RUNTIME_TABLES].filter((table) => !tables.has(table))).toEqual([]);
      const danglingParents = METADATA_BACKUP_TABLES.flatMap((table) =>
        (db.prepare('SELECT DISTINCT "table" AS parent FROM pragma_foreign_key_list(?)').all(table) as Array<{ parent: string }>)
          .filter(({ parent }) => !backedUp.has(parent))
          .map(({ parent }) => `${table} -> ${parent}`));
      expect(danglingParents).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("restores the schema, triggers and rows of every backed-up table exactly", () => {
    const db = migratedMemoryDb();
    const restored = new SqliteDatabase(":memory:");
    try {
      const operator = setupOperator(db, { display_name: "Backup operator" });
      const peer = createUser(db, { slug: "peer", kind: "human", display_name: "Peer" }, 100);
      const settings = db.prepare("INSERT INTO user_settings (user_id, key, value, revision, updated_at) VALUES (?, ?, ?, ?, ?)");
      settings.run(operator.id, "app_rail_order", '["spaces","tasks"]', 7, 1_787_200_001_001);
      settings.run(peer.id, "ui_font_face", "it's quoted", 2, 1_787_200_002_001);
      const project = addProject(db, { project_key: "backup", display_name: "Backup" });
      const store = new LedgerStore(db);
      const issue = store.createIssue({ ...SYSTEM_ACTOR, project_id: project.id, title: "Backed up", body: "line one\nline two" });
      store.addComment(issue.id, { ...SYSTEM_ACTOR, body: "a comment with 'quotes' and unicode \u00e9" });

      const schema = (target: SqliteDatabase) => (target.prepare(
        "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY type, name",
      ).all() as Array<{ type: string; name: string; tbl_name: string; sql: string }>)
        .filter((row) => backedUp.has(row.tbl_name));
      const rows = (target: SqliteDatabase, table: string) =>
        target.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all();

      restored.exec(buildMetadataBackupSql(db));

      expect(schema(restored)).toEqual(schema(db));
      for (const table of METADATA_BACKUP_TABLES) expect(rows(restored, table), table).toEqual(rows(db, table));
      expect(rows(restored, "ledger_comments")).toHaveLength(1);
      expect(restored.pragma("foreign_key_check")).toEqual([]);
      expect(restored.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
    } finally {
      restored.close();
      db.close();
    }
  });
});
