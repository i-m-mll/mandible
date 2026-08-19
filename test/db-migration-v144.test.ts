import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { setSetting } from "../src/client-auth/settings-kv.js";
import { migrate, type Db } from "../src/db.js";
import { recordArtifactVersion } from "../src/provider-artifacts.js";
import { createUser } from "../src/users/store.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function oldV143Graph(db: Db): void {
  db.pragma("foreign_keys = OFF");
  for (const table of [
    "briefing_submission_annotations", "briefing_submission_answers", "briefing_submissions",
    "briefing_annotation_events", "briefing_response_events", "briefing_run_occurrences",
    "briefing_runs", "briefing_directive_instances", "briefing_directive_definitions", "briefing_rounds",
    "briefing_legacy_custody",
  ]) db.exec(`DROP TABLE ${table}`);
  db.exec(`
    CREATE TABLE briefing_rounds (
      id TEXT PRIMARY KEY, briefing_id TEXT NOT NULL, ordinal INTEGER NOT NULL,
      artifact_version_id TEXT NOT NULL, previous_round_id TEXT,
      profile TEXT NOT NULL CHECK(profile = 'mandible-briefing.v1'),
      binding_digest TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE briefing_directive_definitions (
      id TEXT PRIMARY KEY, artifact_version_id TEXT NOT NULL, directive_key TEXT NOT NULL,
      definition_digest TEXT NOT NULL, response_type TEXT NOT NULL, required INTEGER NOT NULL,
      prompt TEXT NOT NULL, options_json TEXT NOT NULL, start_offset INTEGER NOT NULL,
      end_offset INTEGER NOT NULL, body_start_offset INTEGER NOT NULL,
      body_end_offset INTEGER NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE briefing_directive_instances (
      id TEXT PRIMARY KEY, round_id TEXT NOT NULL, definition_id TEXT NOT NULL,
      directive_key TEXT NOT NULL, position INTEGER NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE briefing_runs (
      id TEXT PRIMARY KEY, briefing_id TEXT NOT NULL, round_id TEXT, artifact_version_id TEXT,
      publisher_user_id TEXT NOT NULL, task_identity TEXT NOT NULL, run_id TEXT NOT NULL,
      run_key TEXT NOT NULL, request_digest TEXT NOT NULL, evidence_series_ref TEXT NOT NULL,
      evidence_version INTEGER NOT NULL, evidence_digest TEXT NOT NULL, source_health_json TEXT NOT NULL,
      quiet INTEGER NOT NULL, quiet_reason TEXT, received_at INTEGER NOT NULL
    );
    CREATE TABLE briefing_run_occurrences (
      id TEXT PRIMARY KEY, run_id TEXT NOT NULL, directive_instance_id TEXT,
      directive_key TEXT NOT NULL, evidence_digest TEXT NOT NULL, occurred_at INTEGER NOT NULL,
      metadata_json TEXT NOT NULL
    );
    CREATE TABLE briefing_response_events (
      id TEXT PRIMARY KEY, round_id TEXT NOT NULL, directive_instance_id TEXT NOT NULL,
      operation TEXT NOT NULL, value_json TEXT, retracts_event_id TEXT,
      actor_user_id TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE briefing_annotation_events (
      id TEXT PRIMARY KEY, round_id TEXT NOT NULL, operation TEXT NOT NULL, annotation_kind TEXT,
      start_offset INTEGER, end_offset INTEGER, quote TEXT, body TEXT, replacement_text TEXT,
      retracts_event_id TEXT, actor_user_id TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE briefing_submissions (
      id TEXT PRIMARY KEY, round_id TEXT NOT NULL, ordinal INTEGER NOT NULL,
      supersedes_submission_id TEXT, actor_user_id TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE briefing_submission_answers (
      submission_id TEXT NOT NULL, directive_instance_id TEXT NOT NULL,
      response_event_id TEXT NOT NULL, position INTEGER NOT NULL
    );
    CREATE TABLE briefing_submission_annotations (
      submission_id TEXT NOT NULL, annotation_event_id TEXT NOT NULL, position INTEGER NOT NULL
    );
  `);
  db.pragma("foreign_keys = ON");
  db.prepare("UPDATE meta SET value = '143' WHERE key = 'schema_version'").run();
}

function insertV1Round(db: Db, source: string, key: string, humanId: string): string {
  const briefingId = `briefing-${key}`;
  db.prepare(
    "INSERT INTO briefings (id, briefing_key, title, latest_round_id, round_count, created_at, updated_at) VALUES (?, ?, ?, NULL, 0, 1, 1)",
  ).run(briefingId, key, key);
  db.prepare("INSERT INTO briefing_members (briefing_id, user_id, created_at) VALUES (?, ?, 1)").run(briefingId, humanId);
  const artifact = recordArtifactVersion(db, {
    source_kind: "managed", content: source, series_key: `test:${key}`, logical_name: `${key}.md`,
    title: key, role: "briefing-document", media_type: "text/markdown", metadata: { profile: "mandible-briefing.v1" },
  }, 1);
  const openerEnd = source.indexOf("\n");
  const closeStart = source.indexOf("\n:::", openerEnd);
  const end = closeStart + 4;
  const bodyStart = openerEnd + 1;
  const bodyEnd = closeStart;
  const definitionDigest = createHash("sha256").update(Buffer.from(source.slice(0, end), "utf8")).digest("hex");
  const bindingDigest = createHash("sha256").update(JSON.stringify([["item", definitionDigest]])).digest("hex");
  const roundId = randomUUID();
  const definitionId = randomUUID();
  db.prepare(
    `INSERT INTO briefing_rounds
      (id, briefing_id, ordinal, artifact_version_id, previous_round_id, profile, binding_digest, created_at)
     VALUES (?, ?, 1, ?, NULL, 'mandible-briefing.v1', ?, 1)`,
  ).run(roundId, briefingId, artifact.version.id, bindingDigest);
  db.prepare(
    `INSERT INTO briefing_directive_definitions
      (id, artifact_version_id, directive_key, definition_digest, response_type, required, prompt,
       options_json, start_offset, end_offset, body_start_offset, body_end_offset, created_at)
     VALUES (?, ?, 'item', ?, 'verdict', 1, ?, '[]', 0, ?, ?, ?, 1)`,
  ).run(definitionId, artifact.version.id, definitionDigest, source.slice(bodyStart, bodyEnd), end, bodyStart, bodyEnd);
  db.prepare(
    "INSERT INTO briefing_directive_instances (id, round_id, definition_id, directive_key, position, created_at) VALUES (?, ?, ?, 'item', 0, 1)",
  ).run(randomUUID(), roundId, definitionId);
  db.prepare("UPDATE briefings SET latest_round_id = ?, round_count = 1 WHERE id = ?").run(roundId, briefingId);
  return briefingId;
}

describe("migration 144 typed Briefing cutover", () => {
  it("seals deployed old-column v143 rows and never verifies extra directive structure", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-v144-old-"));
    roots.push(root);
    const db = new Database(":memory:");
    try {
      migrate(db);
      setSetting(db, "artifact_root", root);
      const humanId = createUser(db, { slug: "reviewer", kind: "human", display_name: "Reviewer" }).id;
      oldV143Graph(db);
      expect((db.prepare("PRAGMA table_info(briefing_directive_instances)").all() as Array<{ name: string }>)
        .map((column) => column.name)).not.toContain("artifact_version_id");
      const good = insertV1Round(db, ':::spec-item{key="item" required="true"}\nPrompt\n:::\n', "good", humanId);
      const malformed = [
        ["extra", ':::spec-item{key="item" required="true"}\nPrompt\n:::\n\n::unknown[extra]\n'],
        ["nested", ':::spec-item{key="item" required="true"}\nPrompt\n:::spec-item{key="nested"}\nNested\n:::\n:::\n'],
        ["misplaced", ':::spec-item{key="item" required="true"}\nPrompt\n:::\n\n::option[orphan]{key="x"}\n'],
        ["malformed", ':::spec-item{key="item" required="true"}\nPrompt\n:::\n\n:::spec-item{broken}\n'],
      ].map(([key, source]) => insertV1Round(db, source, key, humanId));

      migrate(db);

      expect(db.prepare("SELECT disposition FROM briefing_legacy_custody WHERE briefing_id = ?").get(good))
        .toEqual({ disposition: "sealed_verified" });
      for (const briefingId of malformed) {
        expect(db.prepare("SELECT disposition, reason FROM briefing_legacy_custody WHERE briefing_id = ?").get(briefingId))
          .toMatchObject({ disposition: "sealed_ambiguous", reason: expect.stringMatching(/top-level|directive|definition/) });
      }
      expect(db.prepare("SELECT latest_round_id, round_count FROM briefings WHERE id = ?").get(good))
        .toEqual({ latest_round_id: null, round_count: 0 });
      expect(db.prepare("SELECT COUNT(*) AS n FROM briefing_rounds").get()).toEqual({ n: 0 });
      expect((db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'briefing_rounds'").get() as { sql: string }).sql)
        .toContain("mandible-briefing.v2");
      expect(db.pragma("foreign_key_check")).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("converges a rewound v142 shape through transient v143 and v144", () => {
    const db = new Database(":memory:");
    try {
      migrate(db);
      db.pragma("foreign_keys = OFF");
      for (const table of [
        "briefing_submission_annotations", "briefing_submission_answers", "briefing_submissions",
        "briefing_annotation_events", "briefing_response_events", "briefing_run_occurrences", "briefing_runs",
        "briefing_directive_instances", "briefing_directive_definitions", "briefing_rounds",
        "briefing_legacy_custody", "briefing_legacy_audit", "briefing_members", "briefings",
      ]) db.exec(`DROP TABLE ${table}`);
      db.pragma("foreign_keys = ON");
      db.prepare("UPDATE meta SET value = '142' WHERE key = 'schema_version'").run();

      migrate(db);

      expect(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()).toEqual({ value: "144" });
      const columns = (db.prepare("PRAGMA table_info(briefing_directive_instances)").all() as Array<{ name: string }>)
        .map((column) => column.name);
      expect(columns).toEqual(expect.arrayContaining(["briefing_id", "artifact_version_id"]));
      expect((db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'briefing_rounds'").get() as { sql: string }).sql)
        .toContain("mandible-briefing.v2");
      expect(db.pragma("foreign_key_check")).toEqual([]);
    } finally {
      db.close();
    }
  });
});
