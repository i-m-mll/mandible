import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RequestLike, ResponseLike, RouteHandler, RouteRegistrar } from "../src/server.js";

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

function request(method: string, url: string, body?: unknown): RequestLike {
  return {
    method,
    url,
    params: {},
    query: {},
    body,
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
      `INSERT INTO artifact_blob (id, algorithm, content_hash, storage_uri, custody_mode, created_at)
       VALUES ('artifact-blob:hash-bk', 'sha256', 'hash-bk', 'file:///tmp/hash-bk', 'managed', 1)`,
    ).run();
    db.prepare(
      `INSERT INTO artifact (id, identity_key, source_kind, title, version_count, created_at, updated_at)
       VALUES ('artifact:bk', 'managed:test:bk', 'managed', 'Backup artifact', 1, 1, 1)`,
    ).run();
    db.prepare(
      `INSERT INTO artifact_version (
        id, artifact_id, version_no, blob_id, source_kind, content_hash, created_at
      ) VALUES ('artifact-version:bk-v1', 'artifact:bk', 1, 'artifact-blob:hash-bk', 'managed', 'hash-bk', 1)`,
    ).run();

    const dump = buildMetadataBackupSql(db);
    expect(dump).toContain("-- Table: artifact_blob");
    expect(dump).toContain("-- Table: artifact");
    expect(dump).toContain("-- Table: artifact_version");
    expect(dump).toContain("-- Table: project_artifact_associations");
    expect(dump).toContain("idx_artifact_version_blob");
    expect(dump).toContain("idx_project_artifact_assoc_target");
  });
});
