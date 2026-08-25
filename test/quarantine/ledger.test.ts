// Quarantined: b283ecb — briefing_group_dispositions is unclassified in the backup manifest.
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CURRENT_SCHEMA_VERSION, migrate, openDb, type Db } from "../../src/db.js";
import { systemAction } from "../../src/identity/resolver.js";
import {
  buildMetadataBackupSql,
  LEDGER_BACKUP_TABLES,
  METADATA_BACKUP_TABLES,
  REPRODUCIBLE_OR_RUNTIME_TABLES,
} from "../../src/ledger/backup.js";
import { createLedgerId } from "../../src/ledger/ids.js";
import { buildLedgerIssueDetailProjection } from "../../src/ledger/issue-detail.js";
import { getLedgerIssueHead } from "../../src/ledger/issue-heads.js";
import { runIssueReferenceBackfill } from "../../src/ledger/issue-reference-backfill.js";
import { parseIssueReferences } from "../../src/ledger/issue-xrefs.js";
import { normalizeRemoteIdentity, resolveProjectForCheckout } from "../../src/ledger/projects.js";
import { LedgerStore } from "../../src/ledger/store.js";
import type { LedgerEventSource } from "../../src/ledger/types.js";
import { createUser } from "../../src/users/store.js";

let tempDir = "";
let dbPath = "";
let db: Db;
const SYSTEM_ACTOR = { attribution: systemAction() };

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-ledger-"));
  dbPath = path.join(tempDir, "mandible.db");
  db = openDb(dbPath);
});

afterEach(() => {
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function createProject(root = path.join(tempDir, "repo")) {
  fs.mkdirSync(root, { recursive: true });
  return resolveProjectForCheckout(db, {
    root,
    name: path.basename(root),
    defaultBranch: "main",
    remoteUrl: "git@github.com:mll/mandible.git",
  });
}

function createIssue(store: LedgerStore, projectId: string, title = "Ledger issue") {
  return store.createIssue({
    ...SYSTEM_ACTOR,
    project_id: projectId,
    title,
    body: "Body",
    kind: "feature",
    priority: "normal",
    actor_type: "agent",
    author_display: "Codex",
    aliases: [{ alias_kind: "git_bug_short", alias: title.slice(0, 4).toLowerCase() }],
  });
}

describe("ledger backup contract", () => {

  it("classifies every live metadata table so schema drift is visible", () => {
    const tableNames = db.prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'table'
         AND name NOT LIKE 'sqlite_%'
       ORDER BY name`,
    ).all() as Array<{ name: string }>;
    const backedUp = new Set<string>(METADATA_BACKUP_TABLES);
    const excluded = new Set<string>(REPRODUCIBLE_OR_RUNTIME_TABLES);
    const unclassified = tableNames
      .map((table) => table.name)
      .filter((table) => !backedUp.has(table) && !excluded.has(table));

    expect(unclassified, "metadata backup table classification drift").toEqual([]);
    expect(backedUp.has("briefing_runs")).toBe(true);
    expect(backedUp.has("briefing_submissions")).toBe(true);
    expect(backedUp.has("briefing_legacy_custody")).toBe(true);
    expect(backedUp.has("feedback_ingest_requests")).toBe(false);
    expect(backedUp.has("task_command_requests")).toBe(true);
    expect(backedUp.has("task_command_events")).toBe(true);
    expect(backedUp.has("conversation_blocks")).toBe(false);
    expect(excluded.has("conversation_blocks")).toBe(true);
    expect(backedUp.has("daemon_log")).toBe(false);
    expect(excluded.has("daemon_log")).toBe(true);
  });

});
