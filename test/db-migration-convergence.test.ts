import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import SqliteDatabase from "../src/sqlite.ts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CURRENT_SCHEMA_VERSION, MINIMUM_SUPPORTED_SCHEMA_VERSION, migrate, openDb, type Db } from "../src/db.js";
import { artifactDescriptiveMetadataJson } from "../src/artifact-metadata.js";
import { MIGRATIONS } from "../src/db-migrations.js";
import { buildMetadataBackupSql } from "../src/ledger/backup.js";
import { insertRawLedgerIssue, insertRawLedgerProject } from "./helpers/ledger-fixtures.js";
import { addProject } from "../src/ledger/project-registry.js";
import { setupOperator } from "../src/users/store.js";
import {
  builtinAuthHooks,
  metaRows,
  schemaVersion,
  seededUsers,
  settingsRows,
  sqliteMaster,
  tableInfo,
} from "./helpers/schema-snapshot.js";

// The schema has two representations: src/db-baseline.ts creates it outright for
// a fresh database, and src/db-migrations.ts moves a supported existing database
// to the same shape. Nothing derives one from the other, so this is the check
// that keeps them from drifting: take the frozen floor-version fixture, migrate
// it, and require the result to be indistinguishable from a fresh database.

const FLOOR_FIXTURE = fs.readFileSync(
  path.join(process.cwd(), "test", "fixtures", `schema-v${MINIMUM_SUPPORTED_SCHEMA_VERSION}.sql`),
  "utf8",
);

let tempDir = "";

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-schema-converge-"));
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function createFloorDatabase(dbPath: string): void {
  const db = new SqliteDatabase(dbPath);
  try {
    db.exec(FLOOR_FIXTURE);
  } finally {
    db.close();
  }
}

function migrateFixtureThrough(db: SqliteDatabase, targetVersion: number): void {
  db.function("mandible_artifact_metadata", { deterministic: true }, artifactDescriptiveMetadataJson);
  for (const migration of MIGRATIONS.filter((candidate) => candidate.version > Number(schemaVersion(db)) && candidate.version <= targetVersion)) {
    db.transaction(() => {
      for (const statement of migration.statements) db.exec(statement);
      db.prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'").run(String(migration.version));
    }).immediate();
  }
}

it("preserves v187 reminder events while admitting truthful local attribution", () => {
  const db = new SqliteDatabase(":memory:");
  try {
    db.exec(FLOOR_FIXTURE);
    db.function("mandible_sha256", { deterministic: true }, (value: unknown) =>
      crypto.createHash("sha256").update(String(value)).digest("hex"));
    migrateFixtureThrough(db, 187);
    const project = addProject(db, { project_key: "reminder-upgrade", display_name: "Reminder upgrade" });
    const operator = setupOperator(db, { slug: "operator", display_name: "Operator" });
    db.transaction(() => {
      db.prepare(`INSERT INTO managed_tasks
        (id, project_id, kind, lifecycle, active_revision_id, created_by_user_id, created_at, updated_at)
        VALUES ('reminder', ?, 'mandible-reminder', 'armed', 'revision', ?, 1, 1)`)
        .run(project.id, operator.id);
      db.prepare(`INSERT INTO managed_task_revisions
        (id, task_id, revision_no, schema_id, payload_json, payload_digest, created_by_user_id, created_at)
        VALUES ('revision', 'reminder', 1, 'mandible-reminder@1', ?, ?, ?, 1)`)
        .run('{"schema":"mandible-reminder@1","effect":{"kind":"inbox_occurrence"}}', "a".repeat(64), operator.id);
      db.prepare(`INSERT INTO managed_task_events
        (id, task_id, revision_id, project_id, event_type, actor_user_id, evidence_method, occurred_at)
        VALUES ('old-event', 'reminder', 'revision', ?, 'created', ?, 'api_token', 1)`)
        .run(project.id, operator.id);
    })();
    migrate(db);
    expect(db.prepare("SELECT evidence_method FROM managed_task_events WHERE id = 'old-event'").get())
      .toEqual({ evidence_method: "api_token" });
    db.prepare(`INSERT INTO managed_task_events
      (id, task_id, revision_id, project_id, event_type, actor_user_id, evidence_method, occurred_at)
      VALUES ('local-event', 'reminder', 'revision', ?, 'cancelled', ?, 'session_claim', 2)`)
      .run(project.id, operator.id);
    expect(db.prepare("SELECT evidence_method FROM managed_task_events WHERE id = 'local-event'").get())
      .toEqual({ evidence_method: "session_claim" });
    expect(db.pragma("foreign_key_check")).toEqual([]);
  } finally { db.close(); }
});

function createLegacyMetadataDatabase(): Db {
  const dbPath = path.join(tempDir, "metadata-v182.db");
  createFloorDatabase(dbPath);
  const db = new SqliteDatabase(dbPath);
  db.function("mandible_sha256", { deterministic: true }, (value: unknown) =>
    crypto.createHash("sha256").update(String(value)).digest("hex"));
  migrateFixtureThrough(db, 182);
  insertRawLedgerProject(db, { id: "metadata-project", name: "Metadata" });
  insertRawLedgerIssue(db, { id: "parent", projectId: "metadata-project", kind: "feature" });
  insertRawLedgerIssue(db, { id: "child", projectId: "metadata-project", kind: "unknown" });
  return db;
}

describe("generic issue metadata upgrade", () => {
  it("migrates rules without installation-specific records and leaves v183 data unchanged on reopen", () => {
    const db = createLegacyMetadataDatabase();
    try {
      db.exec(`UPDATE ledger_issues SET status = 'closed', resolution = 'fixed' WHERE id = 'parent';
        INSERT INTO ledger_labels (issue_id, label, created_at) VALUES
          ('child', 'coordination', 1), ('child', 'parent:parent', 1),
          ('child', 'user-action-required', 1), ('child', 'general-topic', 1)`);
      migrate(db);
      expect(db.prepare("SELECT resolution FROM ledger_issues WHERE id = 'parent'").get())
        .toEqual({ resolution: "delivered" });
      expect(db.prepare("SELECT kind, work_notes FROM ledger_issues WHERE id = 'child'").get())
        .toEqual({ kind: "tracker", work_notes: "user action required" });
      expect(db.prepare("SELECT label FROM ledger_labels WHERE deleted_at IS NULL").all())
        .toEqual([{ label: "general-topic" }]);
      expect(db.prepare("SELECT source_issue_id, target_issue_id FROM ledger_relationship_edges WHERE link_type = 'parent_child'").all())
        .toEqual([{ source_issue_id: "parent", target_issue_id: "child" }]);
      expect(db.prepare("SELECT snapshot_body FROM ledger_body_revisions WHERE entity_type = 'issue_work_notes'").get())
        .toEqual({ snapshot_body: "user action required" });
      expect(db.pragma("foreign_key_check")).toEqual([]);
      const snapshot = db.serialize();
      migrate(db);
      expect(db.serialize().equals(snapshot)).toBe(true);
    } finally {
      db.close();
    }
  });

  it.each([
    "UPDATE ledger_issues SET status = 'closed', resolution = NULL WHERE id = 'child'",
    "INSERT INTO ledger_labels (issue_id, label, created_at) VALUES ('child', 'bug', 1), ('child', 'feature', 1)",
    "INSERT INTO ledger_labels (issue_id, label, created_at) VALUES ('child', 'parent:missing', 1)",
  ])("refuses unresolved legacy metadata without changing the database: %s", (seed) => {
    const db = createLegacyMetadataDatabase();
    try {
      db.exec(seed);
      const snapshot = db.serialize();
      expect(() => migrate(db)).toThrow("v183_metadata_requires_explicit_review");
      expect(schemaVersion(db)).toBe("182");
      expect(db.serialize().equals(snapshot)).toBe(true);
    } finally {
      db.close();
    }
  });
});

describe("issue priority upgrade", () => {
  it("v197 converts unknown priority to normal, keeps search rows, records events, and rejects unknown afterwards", () => {
    const dbPath = path.join(tempDir, "priority-v196.db");
    createFloorDatabase(dbPath);
    const db = new SqliteDatabase(dbPath);
    try {
      db.function("mandible_sha256", { deterministic: true }, (value: unknown) =>
        crypto.createHash("sha256").update(String(value)).digest("hex"));
      migrateFixtureThrough(db, 196);
      insertRawLedgerProject(db, { id: "priority-project", name: "Priority" });
      insertRawLedgerIssue(db, { id: "issue-gap", projectId: "priority-project", priority: "unknown" });
      insertRawLedgerIssue(db, { id: "issue-unknown", projectId: "priority-project", title: "Quokka unknown", priority: "unknown" });
      insertRawLedgerIssue(db, { id: "issue-high", projectId: "priority-project", title: "Wombat high", priority: "high" });
      db.prepare("DELETE FROM ledger_issues WHERE id = 'issue-gap'").run();
      const rowidsBefore = db.prepare("SELECT id, rowid FROM ledger_issues ORDER BY id").all();

      migrate(db);

      expect(schemaVersion(db)).toBe(String(CURRENT_SCHEMA_VERSION));
      expect(db.prepare("SELECT id, priority, updated_at FROM ledger_issues ORDER BY id").all()).toEqual([
        { id: "issue-high", priority: "high", updated_at: 1 },
        { id: "issue-unknown", priority: "normal", updated_at: 1 },
      ]);
      expect(db.prepare("SELECT id, rowid FROM ledger_issues ORDER BY id").all()).toEqual(rowidsBefore);
      expect(db.prepare(`SELECT i.id FROM issue_search JOIN ledger_issues i ON i.rowid = issue_search.rowid
        WHERE issue_search MATCH 'quokka'`).all()).toEqual([{ id: "issue-unknown" }]);
      expect(db.prepare(`SELECT e.entity_id, json_extract(e.payload_json, '$.patch.priority') AS priority, l.sequence
        FROM ledger_events e JOIN ledger_change_log l ON l.event_id = e.id
        WHERE e.actor_id = 'schema-migration-v197'`).all())
        .toEqual([{ entity_id: "issue-unknown", priority: "normal", sequence: 1 }]);
      expect(db.prepare("SELECT next_sequence FROM ledger_change_feed_state WHERE project_id = 'priority-project'").get())
        .toEqual({ next_sequence: 2 });

      insertRawLedgerIssue(db, { id: "issue-default", projectId: "priority-project", title: "Default" });
      expect(db.prepare("SELECT priority FROM ledger_issues WHERE id = 'issue-default'").get())
        .toEqual({ priority: "normal" });
      expect(db.prepare("SELECT 1 FROM issue_search WHERE issue_search MATCH 'default'").all()).toHaveLength(1);
      expect(() => db.prepare("UPDATE ledger_issues SET priority = 'unknown' WHERE id = 'issue-high'").run())
        .toThrow(/CHECK constraint failed/);
      expect(db.pragma("foreign_key_check")).toEqual([]);
    } finally {
      db.close();
    }
  });
});

describe("roundless legacy Briefing repair", () => {
  it("v199 archives only roundless Briefings held in v1 custody and records one event for each", () => {
    const dbPath = path.join(tempDir, "roundless-v198.db");
    createFloorDatabase(dbPath);
    const db = new SqliteDatabase(dbPath);
    try {
      db.function("mandible_sha256", { deterministic: true }, (value: unknown) =>
        crypto.createHash("sha256").update(String(value)).digest("hex"));
      migrateFixtureThrough(db, 198);
      const briefing = db.prepare(`INSERT INTO briefings
        (id, briefing_key, title, latest_round_id, round_count, created_at, updated_at, archived_at)
        VALUES (?, ?, ?, NULL, 0, 1, 1, ?)`);
      const custody = db.prepare(`INSERT INTO briefing_legacy_custody
        (id, briefing_id, source_profile, disposition, reason, packet_json, packet_digest, created_at)
        VALUES (?, ?, 'mandible-briefing.v1', 'sealed_verified', 'sealed', '{}', ?, 2)`);
      briefing.run("briefing:sealed", "legacy:sealed", "arxiv-scan", null);
      custody.run("custody-sealed", "briefing:sealed", "a".repeat(64));
      briefing.run("briefing:archived", "legacy:archived", "task-health", 5);
      custody.run("custody-archived", "briefing:archived", "b".repeat(64));
      briefing.run("quiet-feed", "quiet-feed", "Quiet feed", null);

      migrate(db);

      expect(schemaVersion(db)).toBe(String(CURRENT_SCHEMA_VERSION));
      const rows = db.prepare("SELECT id, archived_at FROM briefings ORDER BY id").all() as Array<{ id: string; archived_at: number | null }>;
      expect(rows.map((row) => [row.id, row.archived_at === null ? null : row.archived_at > 5 ? "migrated" : row.archived_at]))
        .toEqual([["briefing:archived", 5], ["briefing:sealed", "migrated"], ["quiet-feed", null]]);
      expect(db.prepare(`SELECT entity_type, entity_id, event_type, actor_type,
          json_extract(payload_json, '$.legacy_custody_id') AS custody_id, occurred_at
        FROM ledger_events WHERE actor_id = 'schema-migration-v199'`).all())
        .toEqual([{ entity_type: "briefing", entity_id: "briefing:sealed", event_type: "briefing.archived",
          actor_type: "system", custody_id: "custody-sealed",
          occurred_at: rows.find((row) => row.id === "briefing:sealed")?.archived_at }]);
      expect(db.prepare("SELECT COUNT(*) AS n FROM briefing_legacy_custody").get()).toEqual({ n: 2 });
      expect(db.pragma("foreign_key_check")).toEqual([]);
    } finally {
      db.close();
    }
  });
});

function seedBriefingLineage(db: SqliteDatabase, mixed: boolean): { rounds: unknown[] } {
  for (const [suffix, hash] of [["a", "a".repeat(64)], ["b", "b".repeat(64)]] as const) {
    db.prepare(`INSERT INTO artifact_blob
      (id, content_hash, size_bytes, metadata_json, custody_mode, availability,
       retention_json, reference_json, created_at)
      VALUES (?, ?, 1, '{}', 'managed', 'present', '{}', '{}', 1)`)
      .run(`artifact-blob:${suffix}`, hash);
    db.prepare(`INSERT INTO artifact
      (id, identity_key, source_kind, logical_name, latest_version_id, version_count,
       metadata_json, created_at, updated_at)
      VALUES (?, ?, 'managed', ?, ?, 1, '{}', 1, 1)`)
      .run(`artifact:${suffix}`, `lineage-${suffix}`, `${suffix}.md`, `artifact-version:${suffix}`);
    db.prepare(`INSERT INTO artifact_version
      (id, artifact_id, version_no, blob_id, source_kind, content_hash,
       source_locator_json, custody_mode, metadata_json, created_at)
      VALUES (?, ?, 1, ?, 'managed', ?, '{}', 'managed', '{}', 1)`)
      .run(`artifact-version:${suffix}`, `artifact:${suffix}`, `artifact-blob:${suffix}`, hash);
  }
  db.prepare(`INSERT INTO briefings
    (id, briefing_key, title, latest_round_id, round_count, created_at, updated_at)
    VALUES ('briefing-lineage', 'lineage', 'Lineage', 'round-2', 2, 1, 2)`).run();
  db.prepare(`INSERT INTO briefing_rounds
    (id, briefing_id, ordinal, artifact_version_id, comparison_base_artifact_version_id,
     previous_round_id, profile, binding_digest, created_at)
    VALUES ('round-1', 'briefing-lineage', 1, 'artifact-version:a', NULL, NULL,
      'mandible-briefing.v3', ?, 1)`).run("1".repeat(64));
  db.prepare(`INSERT INTO briefing_rounds
    (id, briefing_id, ordinal, artifact_version_id, comparison_base_artifact_version_id,
     previous_round_id, profile, binding_digest, created_at)
    VALUES ('round-2', 'briefing-lineage', 2, ?, NULL, 'round-1',
      'mandible-briefing.v3', ?, 2)`).run(mixed ? "artifact-version:b" : "artifact-version:a", "2".repeat(64));
  return { rounds: db.prepare("SELECT * FROM briefing_rounds ORDER BY ordinal").all() };
}

describe.sequential("schema convergence", () => {
  it("rolls v171 back completely when destination ownership is ambiguous", () => {
    const dbPath = path.join(tempDir, "ambiguous-destination.db");
    createFloorDatabase(dbPath);
    const db = new SqliteDatabase(dbPath);
    try {
      migrateFixtureThrough(db, 170);
      db.prepare(`INSERT INTO artifact (
        id, identity_key, source_kind, logical_name, latest_version_id, version_count,
        metadata_json, created_at, updated_at
      ) VALUES ('artifact:destination', 'destination', 'managed', 'Destination.md', NULL, 0, '{}', 1, 1)`).run();
      db.prepare(`INSERT INTO briefing_groups
        (id, name, current_bundle_id, created_at, updated_at, archived_at)
        VALUES (?, ?, NULL, 1, 1, NULL)`).run("group-one", "One");
      db.prepare(`INSERT INTO briefing_groups
        (id, name, current_bundle_id, created_at, updated_at, archived_at)
        VALUES (?, ?, NULL, 1, 1, NULL)`).run("group-two", "Two");
      const insertRoute = db.prepare(`INSERT INTO briefing_destination_routes (
        route_key, group_id, logical_artifact_id, heading, composer_kind, active_template_version,
        max_contributions, max_document_bytes, max_directives, created_at, updated_at
      ) VALUES (?, ?, 'artifact:destination', ?, 'deterministic', 1, 1, 1000, 0, 1, 1)`);
      insertRoute.run("destination.one", "group-one", "One");
      insertRoute.run("destination.two", "group-two", "Two");
      const migration = MIGRATIONS.find((candidate) => candidate.version === 171)!;
      expect(() => db.transaction(() => {
        for (const statement of migration.statements) db.exec(statement);
        db.prepare("UPDATE meta SET value = '171' WHERE key = 'schema_version'").run();
      }).immediate()).toThrow(/group_count/);
      expect(schemaVersion(db)).toBe("170");
      expect(db.prepare("SELECT COUNT(*) AS count FROM briefing_destination_routes").get()).toEqual({ count: 2 });
      expect(db.prepare("SELECT COUNT(*) AS count FROM pragma_table_info('briefing_groups') WHERE name = 'key'").get())
        .toEqual({ count: 0 });
      expect(db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'briefing_destination_owners'").get())
        .toEqual({ count: 0 });
      expect(db.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
    } finally {
      db.close();
    }
  });

  it("moves the schema-171 operator click preference into the canonical app setting", () => {
    const dbPath = path.join(tempDir, "chat-click-preference.db");
    createFloorDatabase(dbPath);
    const db = new SqliteDatabase(dbPath);
    try {
      migrateFixtureThrough(db, 171);
      const operator = db.prepare("SELECT id FROM users ORDER BY created_at LIMIT 1").get() as { id: string };
      db.prepare("INSERT INTO settings (key, value, updated_at) VALUES ('user.operator_id', ?, 1)").run(operator.id);
      db.prepare(`INSERT INTO user_settings (user_id, key, value, revision, updated_at)
        VALUES (?, 'chat_bottom_shelf', ?, 1, 9)`).run(operator.id, JSON.stringify({
        version: 1, visible: true, tab: "overview", clickAction: "open",
      }));

      const migration = MIGRATIONS.find((candidate) => candidate.version === 172)!;
      db.transaction(() => {
        for (const statement of migration.statements) db.exec(statement);
        db.prepare("UPDATE meta SET value = '172' WHERE key = 'schema_version'").run();
      }).immediate();

      expect(db.prepare("SELECT value FROM settings WHERE key = 'chat_entity_link_action'").get())
        .toEqual({ value: "open" });
      expect(db.prepare("SELECT 1 FROM user_settings WHERE key = 'chat_bottom_shelf'").get()).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it("backfills only missing canonical Artifact parent locators without changing identity", () => {
    const dbPath = path.join(tempDir, "artifact-parent-lineage.db");
    createFloorDatabase(dbPath);
    const db = new SqliteDatabase(dbPath);
    try {
      db.function("mandible_sha256", { deterministic: true }, (value: string) =>
        crypto.createHash("sha256").update(value).digest("hex"));
      migrateFixtureThrough(db, 173);
      for (const [suffix, hash] of [["1", "1".repeat(64)], ["2", "2".repeat(64)], ["3", "3".repeat(64)], ["4", "4".repeat(64)]] as const) {
        db.prepare(`INSERT INTO artifact_blob
          (id, content_hash, size_bytes, metadata_json, custody_mode, availability,
           retention_json, reference_json, created_at)
          VALUES (?, ?, 1, '{}', 'managed', 'present', '{}', '{}', 1)`)
          .run(`artifact-blob:${suffix}`, hash);
      }
      db.prepare(`INSERT INTO artifact
        (id, identity_key, source_kind, latest_version_id, version_count, metadata_json, created_at, updated_at)
        VALUES ('artifact:lineage', 'lineage', 'managed', 'artifact-version:4', 4, '{}', 1, 4)`).run();
      const insertVersion = db.prepare(`INSERT INTO artifact_version
        (id, artifact_id, version_no, blob_id, source_kind, content_hash,
         source_locator_json, custody_mode, metadata_json, created_at)
        VALUES (?, 'artifact:lineage', ?, ?, 'managed', ?, ?, 'managed', '{}', ?)`);
      insertVersion.run("artifact-version:1", 1, "artifact-blob:1", "1".repeat(64), '{"parent_version_id":null}', 1);
      insertVersion.run("artifact-version:2", 2, "artifact-blob:2", "2".repeat(64), '{}', 2);
      insertVersion.run("artifact-version:3", 3, "artifact-blob:3", "3".repeat(64), '{"parent_version_id":"artifact-version:explicit"}', 3);
      insertVersion.run("artifact-version:4", 4, "artifact-blob:4", "4".repeat(64), '{"parent_version_id":null}', 4);
      db.prepare(`INSERT INTO briefings
        (id, briefing_key, title, logical_artifact_id, latest_round_id, round_count, created_at, updated_at)
        VALUES ('briefing:lineage', 'lineage', 'Lineage', 'artifact:lineage', 'round:lineage', 1, 1, 1)`).run();
      db.prepare(`INSERT INTO briefing_rounds
        (id, briefing_id, ordinal, artifact_version_id, profile, binding_digest, created_at)
        VALUES ('round:lineage', 'briefing:lineage', 1, 'artifact-version:4',
          'mandible-briefing.v3', ?, 1)`).run("a".repeat(64));

      const migration = MIGRATIONS.find((candidate) => candidate.version === 174)!;
      db.transaction(() => {
        for (const statement of migration.statements) db.exec(statement);
        db.prepare("UPDATE meta SET value = '174' WHERE key = 'schema_version'").run();
      }).immediate();

      const locators = db.prepare(
        "SELECT id, source_locator_json FROM artifact_version ORDER BY version_no",
      ).all().map((row) => ({
        id: (row as { id: string }).id,
        parent: JSON.parse((row as { source_locator_json: string }).source_locator_json).parent_version_id ?? null,
      }));
      expect(locators).toEqual([
        { id: "artifact-version:1", parent: null },
        { id: "artifact-version:2", parent: "artifact-version:1" },
        { id: "artifact-version:3", parent: "artifact-version:explicit" },
        { id: "artifact-version:4", parent: "artifact-version:3" },
      ]);
      expect(db.prepare(
        "SELECT id, latest_version_id, version_count FROM artifact WHERE id = 'artifact:lineage'",
      ).get()).toEqual({ id: "artifact:lineage", latest_version_id: "artifact-version:4", version_count: 4 });
      expect(db.prepare(
        "SELECT briefing_id, artifact_version_id FROM briefing_rounds WHERE id = 'round:lineage'",
      ).get()).toEqual({ briefing_id: "briefing:lineage", artifact_version_id: "artifact-version:4" });
    } finally {
      db.close();
    }
  });

  it("migrates the frozen floor fixture to the same schema a fresh database gets", () => {
    const freshPath = path.join(tempDir, "fresh.db");
    const migratedPath = path.join(tempDir, "migrated.db");
    createFloorDatabase(migratedPath);

    const fresh = openDb(freshPath);
    const migrated = openDb(migratedPath);
    try {
      for (const db of [fresh, migrated]) {
        expect(schemaVersion(db)).toBe(String(CURRENT_SCHEMA_VERSION));
        expect(db.pragma("foreign_key_check")).toEqual([]);
        expect(db.pragma("integrity_check")).toEqual([{ integrity_check: "ok" }]);
      }

      expect(sqliteMaster(migrated)).toEqual(sqliteMaster(fresh));
      expect(migrated.prepare("SELECT name FROM sqlite_master WHERE name = 'runtime_patches'").get()).toBeUndefined();
      expect(tableInfo(migrated)).toEqual(tableInfo(fresh));
      expect(metaRows(migrated)).toEqual(metaRows(fresh));
      expect(settingsRows(migrated)).toEqual(settingsRows(fresh));
      expect(builtinAuthHooks(migrated)).toEqual(builtinAuthHooks(fresh));
      expect(seededUsers(migrated)).toEqual(seededUsers(fresh));
    } finally {
      migrated.close();
      fresh.close();
    }
  });

  it("keeps nonempty retired patch history in place and in metadata backups", () => {
    const dbPath = path.join(tempDir, "patch-history.db");
    createFloorDatabase(dbPath);
    const seed = new SqliteDatabase(dbPath);
    try {
      seed.prepare(`INSERT INTO runtime_patches
        (id, fingerprint, commit_hash, diff_summary, applied_at, source, submitted)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run("historical-patch", "fingerprint", "commit", "unique patch history", 123, "manual", 1);
    } finally {
      seed.close();
    }

    const db = openDb(dbPath);
    try {
      expect(schemaVersion(db)).toBe(String(CURRENT_SCHEMA_VERSION));
      expect(db.prepare("SELECT id, diff_summary FROM runtime_patches").all())
        .toEqual([{ id: "historical-patch", diff_summary: "unique patch history" }]);
      const backup = buildMetadataBackupSql(db);
      expect(backup).toContain('INSERT INTO "runtime_patches"');
      expect(backup).toContain("unique patch history");
    } finally {
      db.close();
    }
  });

  it("drops the retired tables and column without disturbing surviving rows", () => {
    const migratedPath = path.join(tempDir, "retired.db");
    createFloorDatabase(migratedPath);

    const RETIRED_TABLES = [
      "ledger_external_refs", "ledger_sync_jobs", "ledger_outbox", "ledger_conflicts",
      "starred_chats", "presets", "preset_nodes", "preset_diffs", "session_presets",
      "convention_setting_links", "session_instruction_artifacts",
    ];

    const seed = new SqliteDatabase(migratedPath);
    try {
      // The floor fixture really does carry these tables and the chain's own
      // completion markers, so the drop below is doing work rather than passing
      // over an already-absent shape.
      for (const table of RETIRED_TABLES) {
        expect(seed.prepare(
          "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
        ).get(table)).toBeTruthy();
      }
      expect((seed.prepare(
        "SELECT count(*) AS n FROM meta WHERE key LIKE 'post_migration.%'",
      ).get() as { n: number }).n).toBeGreaterThan(0);

      seed.prepare(
        "INSERT INTO presets (id, name, created_at, updated_at) VALUES ('p1', 'Preset', 1, 1)",
      ).run();
      seed.prepare(
        `INSERT INTO preset_nodes (id, preset_id, created_at, updated_at)
         VALUES ('n1', 'p1', 1, 1)`,
      ).run();
      seed.prepare(
        `INSERT INTO message_params (session_id, message_index, model, preset_ids, created_at)
         VALUES ('s1', 0, 'opus', '["p1"]', 7)`,
      ).run();
    } finally {
      seed.close();
    }

    const migrated = openDb(migratedPath);
    try {
      for (const table of RETIRED_TABLES) {
        expect(migrated.prepare(
          "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
        ).get(table)).toBeUndefined();
      }
      expect(migrated.prepare("PRAGMA table_info(message_params)").all())
        .not.toContainEqual(expect.objectContaining({ name: "preset_ids" }));
      // Dropping a column must not disturb the rest of the row.
      expect(migrated.prepare(
        "SELECT session_id, message_index, model, created_at FROM message_params",
      ).all()).toEqual([{ session_id: "s1", message_index: 0, model: "opus", created_at: 7 }]);
      expect(migrated.prepare(
        "SELECT count(*) AS n FROM meta WHERE key LIKE 'post_migration.%'",
      ).get()).toEqual({ n: 0 });
      expect(migrated.pragma("foreign_key_check")).toEqual([]);
    } finally {
      migrated.close();
    }
  });

  it("preserves one-lineage Briefings and refuses mixed logical Artifact history at v161", () => {
    const validPath = path.join(tempDir, "briefing-valid.db");
    createFloorDatabase(validPath);
    const validSeed = new SqliteDatabase(validPath);
    migrateFixtureThrough(validSeed, 160);
    const before = seedBriefingLineage(validSeed, false);
    validSeed.close();

    // This fixture tests the v161 lineage transition; its synthetic blobs have no recoverable bytes.
    const migrated = new SqliteDatabase(validPath);
    migrateFixtureThrough(migrated, 161);
    expect(migrated.prepare("SELECT logical_artifact_id FROM briefings WHERE id = 'briefing-lineage'").get())
      .toEqual({ logical_artifact_id: "artifact:a" });
    expect(migrated.prepare("SELECT * FROM briefing_rounds ORDER BY ordinal").all()).toEqual(before.rounds);
    expect(migrated.pragma("foreign_key_check")).toEqual([]);
    migrated.close();

    const mixedPath = path.join(tempDir, "briefing-mixed.db");
    createFloorDatabase(mixedPath);
    const mixedSeed = new SqliteDatabase(mixedPath);
    migrateFixtureThrough(mixedSeed, 160);
    seedBriefingLineage(mixedSeed, true);
    mixedSeed.close();
    expect(() => openDb(mixedPath)).toThrow(/briefing_lineage_guard|CHECK constraint failed/);
    const refused = new SqliteDatabase(mixedPath);
    expect(schemaVersion(refused)).toBe("160");
    expect(refused.prepare("PRAGMA table_info(briefings)").all())
      .not.toContainEqual(expect.objectContaining({ name: "logical_artifact_id" }));
    expect(refused.prepare("SELECT COUNT(*) AS n FROM briefing_rounds").get()).toEqual({ n: 2 });
    refused.close();
  });
});

describe("derived in-progress worker status", () => {
  it("v200 clears stored in_progress to none with one event each and keeps explicit statuses", () => {
    const dbPath = path.join(tempDir, "in-progress-v199.db");
    createFloorDatabase(dbPath);
    const db = new SqliteDatabase(dbPath);
    try {
      db.function("mandible_sha256", { deterministic: true }, (value: unknown) =>
        crypto.createHash("sha256").update(String(value)).digest("hex"));
      migrateFixtureThrough(db, 199);
      insertRawLedgerProject(db, { id: "status-project", name: "status-project" });
      for (const [id, status] of [["issue-stale", "in_progress"], ["issue-done", "done"]]) {
        insertRawLedgerIssue(db, { id, projectId: "status-project" });
        db.prepare("UPDATE ledger_issues SET worker_status = ? WHERE id = ?").run(status, id);
      }

      migrate(db);

      expect(db.prepare("SELECT id, worker_status FROM ledger_issues ORDER BY id").all())
        .toEqual([{ id: "issue-done", worker_status: "done" }, { id: "issue-stale", worker_status: "none" }]);
      expect(db.prepare(`SELECT entity_id, event_type, json_extract(payload_json, '$.previous_worker_status') AS previous
        FROM ledger_events WHERE actor_id = 'schema-migration-v200'`).all())
        .toEqual([{ entity_id: "issue-stale", event_type: "issue.worker_status.updated", previous: "in_progress" }]);
    } finally {
      db.close();
    }
  });
});

describe("protected-root dirty action column", () => {
  it("v201 adds a nullable JSON-object column and leaves existing requests unset", () => {
    const dbPath = path.join(tempDir, "dirty-action-v200.db");
    createFloorDatabase(dbPath);
    const db = new SqliteDatabase(dbPath);
    try {
      db.function("mandible_sha256", { deterministic: true }, (value: unknown) =>
        crypto.createHash("sha256").update(String(value)).digest("hex"));
      migrateFixtureThrough(db, 200);
      db.prepare(`INSERT INTO auth_requests (id, command, title, status, created_at, updated_at, expires_at)
        VALUES ('existing', 'echo old', 'Old request', 'pending', 1, 1, 2)`).run();

      migrate(db);

      expect(db.prepare("SELECT protected_root_dirty_action_json AS action FROM auth_requests").get())
        .toEqual({ action: null });
      expect(() => db.prepare("UPDATE auth_requests SET protected_root_dirty_action_json = '[]'").run())
        .toThrow(/CHECK/);
    } finally {
      db.close();
    }
  });
});
