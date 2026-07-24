import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { migrate, openDb, type Db } from "../src/db.js";
import { addProject } from "../src/ledger/project-registry.js";
import { createUser } from "../src/users/store.js";

describe("migration v111: user groups and project permissions", () => {
  let tempDir: string;
  let db: Db;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-db-v111-"));
    db = openDb(path.join(tempDir, "mandible.db"));
    addProject(db, { project_key: "legacy", display_name: "Legacy" });
    db.exec(`
      DROP TABLE permission_grants;
      DROP TABLE user_group_members;
      DROP TABLE user_groups;
      ALTER TABLE ledger_projects DROP COLUMN restricted;
      UPDATE meta SET value = '110' WHERE key = 'schema_version';
    `);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("adds opt-in restrictions, seeds only the agents group, and enrolls new agents", () => {
    migrate(db);

    expect(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()).toEqual({
      value: "115",
    });
    expect(db.prepare("SELECT project_key, restricted FROM ledger_projects").get()).toEqual({
      project_key: "legacy",
      restricted: 0,
    });
    expect(db.prepare("SELECT id, slug, kind FROM user_groups").get()).toEqual({
      id: "00000000000000000000000001",
      slug: "agents",
      kind: "system",
    });

    const agent = createUser(db, {
      slug: "new-agent",
      kind: "agent",
      display_name: "New Agent",
    });
    expect(db.prepare(
      "SELECT group_id, user_id FROM user_group_members WHERE user_id = ?",
    ).get(agent.id)).toEqual({
      group_id: "00000000000000000000000001",
      user_id: agent.id,
    });
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });
});
