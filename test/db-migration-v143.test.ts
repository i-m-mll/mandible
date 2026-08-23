import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { setSetting } from "../src/client-auth/settings-kv.js";
import { BASELINE_SCHEMA_VERSION } from "../src/db-baseline.js";
import { migrate, type Db } from "../src/db.js";
import { CURRENT_SCHEMA_VERSION, MIGRATIONS } from "../src/db-migrations.js";
import { BRIEFING_SCHEMA_TABLES } from "../src/feedback/schema.js";
import { createUser } from "../src/users/store.js";

function installLegacyFeedback(db: Db): void {
  for (const version of [125, 127, 137, 142]) {
    for (const statement of MIGRATIONS.find((entry) => entry.version === version)!.statements) db.exec(statement);
  }
}

describe("migration v143: artifact-backed Briefing rounds", () => {
  it("keeps fresh baseline and migration head converged without obsolete feedback tables", () => {
    const db = new Database(":memory:");
    migrate(db);
    const transientRoundsSql = MIGRATIONS.find((entry) => entry.version === 143)?.statements
      .find((statement) => statement.startsWith("CREATE TABLE IF NOT EXISTS briefing_rounds"));
    expect(BASELINE_SCHEMA_VERSION).toBe(152);
    expect(CURRENT_SCHEMA_VERSION).toBe(152);
    expect(transientRoundsSql).toContain("CHECK(profile = 'mandible-briefing.v1')");
    expect(transientRoundsSql).not.toContain("mandible-briefing.v2");
    expect(transientRoundsSql).not.toContain("mandible-briefing.v3");
    expect(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()).toEqual({ value: "152" });
    expect(BRIEFING_SCHEMA_TABLES.every((table) => db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
    ).get(table))).toBe(true);
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'feedback_collections'").get())
      .toBeUndefined();
    expect(db.pragma("foreign_key_check")).toEqual([]);
    db.close();
  });

  it("seals reconstructed frozen submissions into v1 custody before activating v2", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-v143-"));
    const db = new Database(":memory:");
    migrate(db);
    setSetting(db, "artifact_root", root);
    db.pragma("foreign_keys = OFF");
    for (const table of [...BRIEFING_SCHEMA_TABLES].reverse()) db.exec(`DROP TABLE IF EXISTS ${table}`);
    db.pragma("foreign_keys = ON");
    installLegacyFeedback(db);
    const agent = createUser(db, { slug: "legacy-agent", kind: "agent", display_name: "Legacy Agent" }).id;
    const human = createUser(db, { slug: "legacy-human", kind: "human", display_name: "Legacy Human" }).id;
    db.prepare("INSERT INTO sessions (id, app, status, owner_user_id) VALUES ('legacy-session','codex','active',?)").run(agent);
    db.exec(`
      INSERT INTO feedback_collections
        (id, kind, interaction_mode, source, created_at, tombstoned_at)
      VALUES ('legacy-ask','bounded_ask','explicit_submit',NULL,10,NULL);
      INSERT INTO feedback_ask_sessions
        (collection_id, requester_user_id, requester_session_id, request_key, request_digest,
         responder_user_ids_json, expires_at, retention_expires_at, created_at)
      VALUES ('legacy-ask','${agent}','legacy-session','legacy request','${"a".repeat(64)}','["${human}"]',1000,NULL,10);
      INSERT INTO feedback_items
        (id, collection_id, parent_item_id, item_kind, identity_mode, external_key, client_item_key,
         current_revision_id, created_at, tombstoned_at)
      VALUES ('legacy-item','legacy-ask',NULL,'item','opaque',NULL,'decision',NULL,10,NULL);
      INSERT INTO feedback_item_revisions
        (id,item_id,ordinal,title,prompt,description,response_type,required,content_json,evidence_digest,publication_id,position,created_at)
      VALUES ('legacy-revision','legacy-item',1,'Decision','Keep it?',NULL,'verdict',1,'{}',NULL,NULL,0,10);
      UPDATE feedback_items SET current_revision_id = 'legacy-revision' WHERE id = 'legacy-item';
      INSERT INTO feedback_collection_events
        (id,collection_id,operation,previous_event_id,actor_user_id,metadata_json,created_at)
      VALUES ('legacy-open','legacy-ask','opened',NULL,NULL,'{}',10),
             ('legacy-submit','legacy-ask','submitted','legacy-open','${human}','{}',20);
      INSERT INTO feedback_response_events
        (id,collection_id,item_id,item_revision_id,operation,value_json,retracts_event_id,actor_user_id,created_at)
      VALUES ('legacy-response','legacy-ask','legacy-item','legacy-revision','set','{"verdict":"keep"}',NULL,'${human}',19);
      INSERT INTO feedback_submissions
        (id,collection_id,ordinal,supersedes_submission_id,lifecycle_event_id,actor_user_id,created_at)
      VALUES ('legacy-submission','legacy-ask',1,NULL,'legacy-submit','${human}',20);
      INSERT INTO feedback_submission_answers
        (submission_id,item_id,item_revision_id,response_event_id,position)
      VALUES ('legacy-submission','legacy-item','legacy-revision','legacy-response',0);
      INSERT INTO feedback_comments
        (id,collection_id,item_id,item_revision_id,body,actor_user_id,created_at)
      VALUES ('legacy-comment','legacy-ask','legacy-item','legacy-revision','range unknown','${human}',18);
      UPDATE meta SET value = '142' WHERE key = 'schema_version';
    `);
    migrate(db);
    expect(db.prepare("SELECT disposition, reason FROM briefing_legacy_audit").get())
      .toMatchObject({ disposition: "sealed_ambiguous", reason: expect.stringContaining("1 exact frozen") });
    expect(db.prepare("SELECT COUNT(*) AS n FROM briefing_submissions").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM briefing_submission_answers").get()).toEqual({ n: 0 });
    const custody = db.prepare(
      "SELECT disposition, packet_json, packet_digest FROM briefing_legacy_custody",
    ).get() as { disposition: string; packet_json: string; packet_digest: string };
    expect(custody.disposition).toBe("sealed_verified");
    expect(custody.packet_digest).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.parse(custody.packet_json)).toMatchObject({
      source_profile: "mandible-briefing.v1",
      row_counts: { submissions: 1, submission_answers: 1, prior_audit: 1 },
      verification_errors: [],
    });
    const audit = db.prepare("SELECT provenance_json FROM briefing_legacy_audit").get() as { provenance_json: string };
    expect(JSON.parse(audit.provenance_json)).toMatchObject({ comments: [{ body: "range unknown" }] });
    expect(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'feedback_collections'").get())
      .toBeUndefined();
    expect(db.pragma("foreign_key_check")).toEqual([]);
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("marks recurring decision history without a frozen boundary as sealed ambiguity", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-v143-ambiguous-"));
    const db = new Database(":memory:");
    migrate(db);
    setSetting(db, "artifact_root", root);
    db.pragma("foreign_keys = OFF");
    for (const table of [...BRIEFING_SCHEMA_TABLES].reverse()) db.exec(`DROP TABLE IF EXISTS ${table}`);
    db.pragma("foreign_keys = ON");
    installLegacyFeedback(db);
    const human = createUser(db, { slug: "legacy-reviewer", kind: "human", display_name: "Reviewer" }).id;
    db.exec(`
      INSERT INTO feedback_collections (id,kind,interaction_mode,source,created_at,tombstoned_at)
        VALUES ('legacy-feed','recurring_feed','immediate_per_item','arxiv-scan',10,NULL);
      INSERT INTO feedback_recurring_profiles VALUES ('legacy-feed','arxiv-scan',1000,10,10);
      INSERT INTO feedback_items
        (id,collection_id,parent_item_id,item_kind,identity_mode,external_key,client_item_key,current_revision_id,created_at,tombstoned_at)
        VALUES ('candidate','legacy-feed',NULL,'item','publisher_dedup','paper',NULL,NULL,10,NULL);
      INSERT INTO feedback_item_revisions
        (id,item_id,ordinal,title,prompt,description,response_type,required,content_json,evidence_digest,publication_id,position,created_at)
        VALUES ('revision','candidate',1,'Paper','Review paper',NULL,'verdict',0,'{}','${"b".repeat(64)}',NULL,0,10);
      UPDATE feedback_items SET current_revision_id = 'revision' WHERE id = 'candidate';
      INSERT INTO feedback_response_events
        (id,collection_id,item_id,item_revision_id,operation,value_json,retracts_event_id,actor_user_id,created_at)
        VALUES ('decision','legacy-feed','candidate','revision','set','{"verdict":"keep"}',NULL,'${human}',20);
      UPDATE meta SET value = '142' WHERE key = 'schema_version';
    `);
    migrate(db);
    expect(db.prepare("SELECT disposition FROM briefing_legacy_audit").get())
      .toEqual({ disposition: "sealed_ambiguous" });
    expect(db.prepare("SELECT COUNT(*) AS n FROM briefing_submissions").get()).toEqual({ n: 0 });
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
});
