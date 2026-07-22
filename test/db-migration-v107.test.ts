import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { migrate, openDb, type Db } from "../src/db.js";
import { MIGRATIONS } from "../src/db-migrations.js";

describe("migration v107: user registry core", () => {
  let tempDir: string;
  let db: Db;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-db-v107-"));
    db = openDb(path.join(tempDir, "mandible.db"));
    // Rewind to v106: drop the user-registry tables and reset the version so the
    // migration path (not the fresh baseline) is exercised on the next migrate().
    db.pragma("foreign_keys = OFF");
    db.exec(`
      DROP TABLE IF EXISTS attribution_evidence;
      DROP TABLE IF EXISTS delegated_signing_leases;
      DROP TABLE IF EXISTS user_bindings;
      DROP TABLE IF EXISTS user_credentials;
      DROP TABLE IF EXISTS users;
      UPDATE meta SET value = '106' WHERE key = 'schema_version';
    `);
    db.pragma("foreign_keys = ON");
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("creates the five registry tables and seeds exactly the system user", () => {
    migrate(db);

    expect(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()).toEqual({
      value: "110",
    });

    const tables = db
      .prepare(
        `SELECT name FROM sqlite_master
          WHERE type='table'
            AND name IN ('users','user_credentials','user_bindings',
                         'attribution_evidence','delegated_signing_leases')
          ORDER BY name`,
      )
      .all();
    expect(tables).toEqual([
      { name: "attribution_evidence" },
      { name: "delegated_signing_leases" },
      { name: "user_bindings" },
      { name: "user_credentials" },
      { name: "users" },
    ]);

    // Exactly one seeded row: the system user.
    expect(
      db.prepare("SELECT id, slug, kind, created_at FROM users").all(),
    ).toEqual([
      { id: "00000000000000000000000000", slug: "system", kind: "system", created_at: 0 },
    ]);

    // Partial unique index for active credentials must be present.
    const idx = db
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_user_credentials_active_fingerprint'",
      )
      .get() as { sql: string } | undefined;
    expect(idx?.sql).toContain("WHERE status = 'active'");

    expect(db.pragma("foreign_key_check")).toEqual([]);
  });

  it("re-executing the v107 statements against a migrated DB is idempotent", () => {
    migrate(db);

    const v107 = MIGRATIONS.find((m) => m.version === 107);
    expect(v107).toBeDefined();
    // migrate() alone would short-circuit (version already 107), so exercise
    // idempotence by re-running the raw statements a second time. CREATE TABLE /
    // INDEX IF NOT EXISTS and INSERT OR IGNORE must all be safely repeatable.
    expect(() => {
      for (const statement of v107!.statements) db.exec(statement);
    }).not.toThrow();

    // Still exactly one system user, no duplicate rows.
    expect(db.prepare("SELECT COUNT(*) AS n FROM users").get()).toEqual({ n: 1 });
    expect(db.prepare("SELECT id, slug FROM users").all()).toEqual([
      { id: "00000000000000000000000000", slug: "system" },
    ]);
  });

  it("enforces at most one active credential per fingerprint via the partial index", () => {
    migrate(db);
    const now = Date.now();
    const insert = db.prepare(
      `INSERT INTO user_credentials (id, user_id, type, fingerprint, status, created_at, metadata_json)
       VALUES (?, '00000000000000000000000000', 'ssh_key', 'SHA256:aa', ?, ?, '{}')`,
    );
    insert.run("c1", "active", now);
    expect(() => insert.run("c2", "active", now)).toThrow();

    // Revoking the first frees the fingerprint for a new active credential.
    db.prepare("UPDATE user_credentials SET status='revoked', revoked_at=? WHERE id='c1'").run(now);
    expect(() => insert.run("c3", "active", now)).not.toThrow();
  });

  it("rejects unknown kind and binding_type values through CHECK constraints", () => {
    migrate(db);
    expect(() =>
      db
        .prepare(
          `INSERT INTO users (id, slug, kind, display_name, status, created_at, updated_at, metadata_json)
           VALUES ('u-bad','bad','robot','Bad','active',1,1,'{}')`,
        )
        .run(),
    ).toThrow();
    expect(() =>
      db
        .prepare(
          `INSERT INTO user_bindings (id, user_id, binding_type, value, status, created_at, updated_at)
           VALUES ('b-bad','00000000000000000000000000','not_a_type','x','active',1,1)`,
        )
        .run(),
    ).toThrow();
  });
});
