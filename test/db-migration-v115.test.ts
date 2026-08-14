import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { migrate, openDb, type Db } from "../src/db.js";

// Issue a64d2de: migration v115 retroactively clears the operator
// misattribution that tokenless compat-mode writes left on ledger rows as
// evidence_method='local_default'. It nulls ONLY the parallel user-attribution
// columns and ONLY on 'local_default' rows; every other evidence class and the
// frozen legacy provenance columns must survive byte-for-byte.
describe("migration v115: clear local_default ledger misattribution", () => {
  let tempDir: string;
  let db: Db;
  const PROJECT = "proj-fixture";
  const OPERATOR = "user-operator-fixture";
  const AGENT = "user-agent-fixture";

  // One row per evidence class into every affected table, so the assertions can
  // prove that ONLY 'local_default' is cleared. Covers the full locked
  // vocabulary so every non-default class is exercised in the preservation
  // matrix.
  const EVIDENCE_CLASSES = [
    "local_default",
    "session_claim",
    "api_token",
    "credential_signature",
    "system_internal",
    "external_import",
    "hardware_presence",
    "delegated_lease",
  ] as const;

  const userFor = (method: string) => (method === "local_default" ? OPERATOR : AGENT);

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-db-v115-"));
    db = openDb(path.join(tempDir, "mandible.db"));
    db.pragma("foreign_keys = ON");
    // Rewind to just before v115 so migrate() re-applies the corrective pass.
    // The v108 user-attribution columns remain in place; their guarded hooks are
    // idempotent.
    db.exec("UPDATE meta SET value = '114' WHERE key = 'schema_version'");

    const insertUser = db.prepare(
      `INSERT INTO users (id, slug, kind, display_name, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'active', 0, 0)`,
    );
    insertUser.run(OPERATOR, "operator-fixture", "human", "Operator");
    insertUser.run(AGENT, "agent-fixture", "agent", "Agent");
    db.prepare(
      `INSERT INTO ledger_projects (id, display_name, created_at, updated_at)
       VALUES (?, 'Fixture', 0, 0)`,
    ).run(PROJECT);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  // Every seeded row points evidence_id at a per-method attribution_evidence row
  // so the migration's evidence_id clearing (local_default) and preservation
  // (everything else) is asserted, not just the method/user columns.
  const evidenceId = (method: string) => `ev-${method}`;

  function seedFixture(): void {
    const evidence = db.prepare(
      `INSERT INTO attribution_evidence (id, evidence_method, verified_at)
       VALUES (?, ?, 0)`,
    );
    const issue = db.prepare(
      `INSERT INTO ledger_issues
        (id, short_id, project_id, title, body, status, author_actor_type,
         author_display, author_user_id, evidence_method, evidence_id, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, '', 'open', 'mandible_user', 'Mandible', ?, ?, ?, 'mandible', 0, 0)`,
    );
    const comment = db.prepare(
      `INSERT INTO ledger_comments
        (id, issue_id, ordinal, body, author_actor_type, author_display,
         author_user_id, evidence_method, evidence_id, source, created_at)
       VALUES (?, ?, 0, 'c', 'mandible_user', 'Mandible', ?, ?, ?, 'mandible', 0)`,
    );
    const checkpoint = db.prepare(
      `INSERT INTO ledger_issue_checkpoints
        (id, issue_id, kind, payload_json, author_actor_type, author_display,
         author_user_id, evidence_method, evidence_id, source, created_at)
       VALUES (?, ?, 'note', '{}', 'mandible_user', 'Mandible', ?, ?, ?, 'mandible', 0)`,
    );
    const event = db.prepare(
      `INSERT INTO ledger_events
        (id, entity_type, entity_id, event_type, actor_type, actor_user_id,
         evidence_method, evidence_id, source, occurred_at, observed_at)
       VALUES (?, 'issue', ?, 'created', 'mandible_user', ?, ?, ?, 'mandible', 0, 0)`,
    );
    const revision = db.prepare(
      `INSERT INTO ledger_body_revisions
        (id, entity_type, entity_id, issue_id, project_id, revision_no,
         actor_type, actor_user_id, evidence_method, evidence_id, source, reason,
         occurred_at, observed_at, new_hash, snapshot_body)
       VALUES (?, 'issue_body', ?, ?, ?, 1, 'mandible_user', ?, ?, ?, 'mandible',
               'create', 0, 0, 'h', 'body')`,
    );
    const edge = db.prepare(
      `INSERT INTO ledger_relationship_edges
        (id, source_entity_type, source_entity_id, source_project_id, source_issue_id,
         target_entity_type, target_entity_id, target_project_id, target_issue_id,
         link_type, action_id, actor_type, actor_user_id, evidence_method, evidence_id,
         source, created_at, updated_at)
       VALUES (?, 'issue', ?, ?, ?, 'issue', ?, ?, ?, 'related', ?, 'mandible_user',
               ?, ?, ?, 'mandible', 0, 0)`,
    );
    for (const method of EVIDENCE_CLASSES) {
      const user = userFor(method);
      const ev = evidenceId(method);
      evidence.run(ev, method);
      issue.run(`issue-${method}`, `i-${method}`, PROJECT, `Issue ${method}`, user, method, ev);
      comment.run(`comment-${method}`, `issue-${method}`, user, method, ev);
      checkpoint.run(`checkpoint-${method}`, `issue-${method}`, user, method, ev);
      event.run(`event-${method}`, `issue-${method}`, user, method, ev);
      // revision_no is UNIQUE per (entity_type, entity_id); give each row its
      // own entity_id so the seed does not collide on that index.
      revision.run(`revision-${method}`, `issue-${method}-rev`, `issue-${method}`, PROJECT, user, method, ev);
      edge.run(
        `edge-${method}`,
        `src-${method}`, PROJECT, `issue-${method}`,
        `tgt-${method}`, PROJECT, `issue-${method}`,
        `act-${method}`, user, method, ev,
      );
    }
  }

  const AFFECTED = [
    { table: "ledger_issues", idPrefix: "issue", userColumn: "author_user_id", legacyType: "author_actor_type" },
    { table: "ledger_comments", idPrefix: "comment", userColumn: "author_user_id", legacyType: "author_actor_type" },
    { table: "ledger_issue_checkpoints", idPrefix: "checkpoint", userColumn: "author_user_id", legacyType: "author_actor_type" },
    { table: "ledger_events", idPrefix: "event", userColumn: "actor_user_id", legacyType: "actor_type" },
    { table: "ledger_body_revisions", idPrefix: "revision", userColumn: "actor_user_id", legacyType: "actor_type" },
    { table: "ledger_relationship_edges", idPrefix: "edge", userColumn: "actor_user_id", legacyType: "actor_type" },
  ] as const;

  it("nulls exactly the local_default rows and preserves other evidence classes and legacy columns", () => {
    seedFixture();

    migrate(db);

    expect(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()).toEqual({
      value: "128",
    });

    for (const { table, idPrefix, userColumn, legacyType } of AFFECTED) {
      for (const method of EVIDENCE_CLASSES) {
        const row = db.prepare(
          `SELECT ${userColumn} AS userId, evidence_method AS evidenceMethod,
                  evidence_id AS evidenceId, ${legacyType} AS legacyType
             FROM ${table} WHERE id = ?`,
        ).get(`${idPrefix}-${method}`) as {
          userId: string | null;
          evidenceMethod: string | null;
          evidenceId: string | null;
          legacyType: string;
        };
        // Legacy provenance is untouched for every row regardless of evidence class.
        expect(row.legacyType).toBe("mandible_user");
        if (method === "local_default") {
          expect(row.userId).toBeNull();
          expect(row.evidenceMethod).toBeNull();
          expect(row.evidenceId).toBeNull();
        } else {
          expect(row.userId).toBe(AGENT);
          expect(row.evidenceMethod).toBe(method);
          expect(row.evidenceId).toBe(evidenceId(method));
        }
      }
    }

    // The attribution_evidence rows themselves are never deleted; only the FK
    // reference on local_default ledger rows is nulled.
    expect(db.prepare("SELECT COUNT(*) AS n FROM attribution_evidence").get()).toEqual({
      n: EVIDENCE_CLASSES.length,
    });
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });

  it("is idempotent: a second migrate() over already-cleared rows changes nothing", () => {
    seedFixture();
    migrate(db);

    // Rewind the version only (not the data) and re-run: nothing left to clear.
    db.exec("UPDATE meta SET value = '114' WHERE key = 'schema_version'");
    expect(() => migrate(db)).not.toThrow();

    const cleared = db.prepare(
      "SELECT author_user_id AS u, evidence_method AS e FROM ledger_issues WHERE id = 'issue-local_default'",
    ).get() as { u: string | null; e: string | null };
    expect(cleared).toEqual({ u: null, e: null });

    const preserved = db.prepare(
      "SELECT author_user_id AS u, evidence_method AS e FROM ledger_issues WHERE id = 'issue-session_claim'",
    ).get() as { u: string; e: string };
    expect(preserved).toEqual({ u: AGENT, e: "session_claim" });
  });
});
