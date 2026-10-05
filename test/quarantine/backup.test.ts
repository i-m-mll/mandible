// Quarantined: 2b5f92d — the briefings round-trip writes 7 values into 9 columns.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import SqliteDatabase from "../../src/sqlite.ts";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RequestLike, ResponseLike, RouteHandler, RouteRegistrar } from "../../src/server.js";
import { createUser } from "../../src/users/store.js";

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

describe("backup routes", () => {
  const originalHome = process.env.HOME;
  let tempHome = "";
  let db: import("../../src/db.js").Db | undefined;

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

    const { openDb, setDb } = await import("../../src/db.js");
    db = openDb(path.join(tempHome, "mandible.db"));
    setDb(db);

    const { registerBackupRoutes } = await import("../../src/routes/backup.js");
    const routes = new TestRoutes();
    registerBackupRoutes(routes);
    return { routes, db };
  }

  // Issue 24f0316 — backups are durable state, so they are written under the
  // durable root rather than the disposable cache root. The read side stays
  // aware of the old location: the existing backup directory holds gigabytes,
  // and relocating it at startup would be a large unrequested copy.

  it("round-trips artifact-backed Briefing rounds, run provenance, and frozen submissions", async () => {
    const { db } = await setupBackupRoutes();
    const { buildMetadataBackupSql } = await import("../../src/ledger/backup.js");
    const human = createUser(db, { slug: "backup-human", kind: "human", display_name: "Backup Human" });
    db.exec(`
      INSERT INTO artifact_blob (id,content_hash,created_at) VALUES ('artifact-blob:briefing','${"a".repeat(64)}',1);
      INSERT INTO artifact (id,identity_key,latest_version_id,version_count,created_at,updated_at)
        VALUES ('artifact:briefing','briefing','artifact-version:briefing',1,1,1);
      INSERT INTO artifact_version (id,artifact_id,version_no,blob_id,source_kind,content_hash,created_at)
        VALUES ('artifact-version:briefing','artifact:briefing',1,'artifact-blob:briefing','managed','${"a".repeat(64)}',1);
      INSERT INTO briefings VALUES ('briefing-backup','backup','Backup','round-backup',1,1,2);
      INSERT INTO briefing_members VALUES ('briefing-backup','${human.id}',1);
      INSERT INTO briefing_rounds
        (id,briefing_id,ordinal,artifact_version_id,previous_round_id,profile,binding_digest,created_at)
        VALUES ('round-backup','briefing-backup',1,'artifact-version:briefing',NULL,'mandible-briefing.v2','${"b".repeat(64)}',1);
      INSERT INTO briefing_directive_definitions
        VALUES ('definition-backup','artifact-version:briefing','ship','${"c".repeat(64)}','verdict',1,'Ship it','[]','[]',0,36,26,33,1);
      INSERT INTO briefing_directive_instances
        (id,round_id,briefing_id,artifact_version_id,definition_id,directive_key,position,created_at)
        VALUES ('instance-backup','round-backup','briefing-backup','artifact-version:briefing','definition-backup','ship',0,1);
      INSERT INTO briefing_runs
        (id,briefing_id,round_id,artifact_version_id,publisher_user_id,task_identity,run_id,run_key,
         request_digest,evidence_series_ref,evidence_version,evidence_digest,source_health_json,quiet,quiet_reason,received_at)
        VALUES ('run-receipt','briefing-backup','round-backup','artifact-version:briefing','${human.id}',
        'task','run-1','key-1','${"d".repeat(64)}','series',1,'${"e".repeat(64)}','{"source":"test"}',0,NULL,1);
      INSERT INTO briefing_response_events
        (id,round_id,briefing_id,directive_instance_id,operation,value_json,retracts_event_id,actor_user_id,created_at)
        VALUES ('response-backup','round-backup','briefing-backup','instance-backup','set','{"verdict":"keep"}',NULL,'${human.id}',2);
      INSERT INTO briefing_submissions
        (id,round_id,briefing_id,ordinal,supersedes_submission_id,actor_user_id,created_at)
        VALUES ('submission-backup','round-backup','briefing-backup',1,NULL,'${human.id}',2);
      INSERT INTO briefing_submission_answers
        (submission_id,round_id,actor_user_id,directive_instance_id,response_event_id,position)
        VALUES ('submission-backup','round-backup','${human.id}','instance-backup','response-backup',0);
    `);

    const restored = new SqliteDatabase(":memory:");
    try {
      restored.exec(buildMetadataBackupSql(db));
      expect(restored.prepare("SELECT briefing_id, round_id, artifact_version_id, quiet FROM briefing_runs").get())
        .toEqual({ briefing_id: "briefing-backup", round_id: "round-backup",
          artifact_version_id: "artifact-version:briefing", quiet: 0 });
      expect(restored.prepare("SELECT response_event_id FROM briefing_submission_answers").get())
        .toEqual({ response_event_id: "response-backup" });
      expect(() => restored.prepare(
        `INSERT INTO briefing_directive_instances
          (id,round_id,briefing_id,artifact_version_id,definition_id,directive_key,position,created_at)
         VALUES ('instance-duplicate','round-backup','briefing-backup','artifact-version:briefing',
           'definition-backup','ship',1,2)`,
      ).run()).toThrow(/UNIQUE constraint failed: briefing_directive_instances\.round_id, briefing_directive_instances\.directive_key/);
      expect(restored.pragma("foreign_key_check")).toEqual([]);
    } finally {
      restored.close();
    }
  });
});
