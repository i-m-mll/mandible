import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AuthQueue } from "../src/auth-queue.js";
import { migrate, openDb, type Db } from "../src/db.js";
import { setupOperator } from "../src/users/store.js";

describe("migration v109: auth request user attribution", () => {
  let tempDir: string;
  let db: Db;
  let legacyRequestId: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-db-v109-"));
    db = openDb(path.join(tempDir, "mandible.db"));
    setupOperator(db, { slug: "v109-operator", display_name: "V109 Operator" }, 1);
    legacyRequestId = new AuthQueue({ db }).submit({ command: "echo legacy", title: "Legacy" }).id;

    db.exec(`
      DROP INDEX idx_auth_requests_requested_by_user;
      DROP INDEX idx_auth_requests_approved_by_user;
      DROP INDEX idx_auth_requests_execution_evidence;
      ALTER TABLE auth_requests DROP COLUMN execution_evidence_id;
      ALTER TABLE auth_requests DROP COLUMN approved_by_user_id;
      ALTER TABLE auth_requests DROP COLUMN requested_by_user_id;
      UPDATE meta SET value = '108' WHERE key = 'schema_version';
    `);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("adds nullable requester, approver, and execution-evidence foreign keys without rewriting legacy rows", () => {
    migrate(db);

    expect(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()).toEqual({
value: "154",
    });
    const columns = db.prepare("PRAGMA table_info(auth_requests)").all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toEqual(expect.arrayContaining([
      "requested_by_user_id",
      "approved_by_user_id",
      "execution_evidence_id",
    ]));
    expect(
      db.prepare(
        `SELECT requested_by_user_id, approved_by_user_id, execution_evidence_id
         FROM auth_requests WHERE id = ?`,
      ).get(legacyRequestId),
    ).toEqual({
      requested_by_user_id: null,
      approved_by_user_id: null,
      execution_evidence_id: null,
    });

    const foreignKeys = db.prepare("PRAGMA foreign_key_list(auth_requests)").all() as Array<{
      from: string;
      table: string;
    }>;
    expect(foreignKeys).toEqual(expect.arrayContaining([
      expect.objectContaining({ from: "requested_by_user_id", table: "users" }),
      expect.objectContaining({ from: "approved_by_user_id", table: "users" }),
      expect.objectContaining({ from: "execution_evidence_id", table: "attribution_evidence" }),
    ]));
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });
});
