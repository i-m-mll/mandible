import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { migrate, openDb, type Db } from "../src/db.js";

// Issue be2ab49: migration v116 is a one-shot corrective follow-up to v115.
// v115 was consumed prematurely against the live DB (issue 07edc0d), so the
// post-merge restart skipped it and the old daemon kept writing rows stamped
// evidence_method='local_default' until the corrected restart. v116 clears that
// residual operator misattribution, but ONLY on 'local_default' rows whose own
// timestamp is strictly before the v115-merge cutoff, so any legitimate
// post-restart operator attribution is preserved. Every other evidence class is
// untouched regardless of timestamp.
describe("migration v116: clear residual local_default ledger misattribution", () => {
  let tempDir: string;
  let db: Db;
  const PROJECT = "proj-fixture";
  const OPERATOR = "user-operator-fixture";
  const AGENT = "user-agent-fixture";

  // The exact commit timestamp of the v115 merge commit 08bcc7c on main
  // ("2026-07-23 20:29:16 -0400") in epoch milliseconds — the hard-coded cutoff
  // the migration uses. Rows strictly before this instant are in the residual
  // window; rows at or after it are preserved.
  const CUTOFF_MS = 1784852956000;
  const PRE = CUTOFF_MS - 1;
  const BOUNDARY = CUTOFF_MS;
  const POST = CUTOFF_MS + 1;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-db-v116-"));
    db = openDb(path.join(tempDir, "mandible.db"));
    db.pragma("foreign_keys = ON");
    // Rewind to just before v116 so migrate() applies ONLY the residual sweep
    // (not v115, which would clear every local_default row regardless of
    // timestamp and defeat the boundary assertions).
    db.exec("UPDATE meta SET value = '115' WHERE key = 'schema_version'");

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

  const evidenceId = (suffix: string) => `ev-${suffix}`;

  // Each affected table with its user-attribution column and the timestamp
  // column the migration filters on (created_at vs occurred_at).
  const AFFECTED = [
    { table: "ledger_issues", idPrefix: "issue", userColumn: "author_user_id", tsColumn: "created_at" },
    { table: "ledger_comments", idPrefix: "comment", userColumn: "author_user_id", tsColumn: "created_at" },
    { table: "ledger_issue_checkpoints", idPrefix: "checkpoint", userColumn: "author_user_id", tsColumn: "created_at" },
    { table: "ledger_events", idPrefix: "event", userColumn: "actor_user_id", tsColumn: "occurred_at" },
    { table: "ledger_body_revisions", idPrefix: "revision", userColumn: "actor_user_id", tsColumn: "occurred_at" },
    { table: "ledger_relationship_edges", idPrefix: "edge", userColumn: "actor_user_id", tsColumn: "created_at" },
  ] as const;

  // Scenarios seeded into every table. Only pre-cutoff local_default is cleared.
  const SCENARIOS = [
    { key: "pre_default", method: "local_default", user: OPERATOR, ts: PRE, expectCleared: true },
    { key: "boundary_default", method: "local_default", user: OPERATOR, ts: BOUNDARY, expectCleared: false },
    { key: "post_default", method: "local_default", user: OPERATOR, ts: POST, expectCleared: false },
    { key: "pre_session", method: "session_claim", user: AGENT, ts: PRE, expectCleared: false },
    { key: "pre_api", method: "api_token", user: AGENT, ts: PRE, expectCleared: false },
    { key: "post_session", method: "session_claim", user: AGENT, ts: POST, expectCleared: false },
  ] as const;

  function seed(suffix: string, method: string, user: string, ts: number): void {
    const ev = evidenceId(suffix);
    db.prepare(
      `INSERT INTO attribution_evidence (id, evidence_method, verified_at) VALUES (?, ?, 0)`,
    ).run(ev, method);
    db.prepare(
      `INSERT INTO ledger_issues
        (id, short_id, project_id, title, body, status, author_actor_type,
         author_display, author_user_id, evidence_method, evidence_id, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, '', 'open', 'mandible_user', 'Mandible', ?, ?, ?, 'mandible', ?, ?)`,
    ).run(`issue-${suffix}`, `i-${suffix}`, PROJECT, `Issue ${suffix}`, user, method, ev, ts, ts);
    db.prepare(
      `INSERT INTO ledger_comments
        (id, issue_id, ordinal, body, author_actor_type, author_display,
         author_user_id, evidence_method, evidence_id, source, created_at)
       VALUES (?, ?, 0, 'c', 'mandible_user', 'Mandible', ?, ?, ?, 'mandible', ?)`,
    ).run(`comment-${suffix}`, `issue-${suffix}`, user, method, ev, ts);
    db.prepare(
      `INSERT INTO ledger_issue_checkpoints
        (id, issue_id, kind, payload_json, author_actor_type, author_display,
         author_user_id, evidence_method, evidence_id, source, created_at)
       VALUES (?, ?, 'note', '{}', 'mandible_user', 'Mandible', ?, ?, ?, 'mandible', ?)`,
    ).run(`checkpoint-${suffix}`, `issue-${suffix}`, user, method, ev, ts);
    db.prepare(
      `INSERT INTO ledger_events
        (id, entity_type, entity_id, event_type, actor_type, actor_user_id,
         evidence_method, evidence_id, source, occurred_at, observed_at)
       VALUES (?, 'issue', ?, 'created', 'mandible_user', ?, ?, ?, 'mandible', ?, ?)`,
    ).run(`event-${suffix}`, `issue-${suffix}`, user, method, ev, ts, ts);
    db.prepare(
      `INSERT INTO ledger_body_revisions
        (id, entity_type, entity_id, issue_id, project_id, revision_no,
         actor_type, actor_user_id, evidence_method, evidence_id, source, reason,
         occurred_at, observed_at, new_hash, snapshot_body)
       VALUES (?, 'issue_body', ?, ?, ?, 1, 'mandible_user', ?, ?, ?, 'mandible',
               'create', ?, ?, 'h', 'body')`,
    ).run(`revision-${suffix}`, `issue-${suffix}-rev`, `issue-${suffix}`, PROJECT, user, method, ev, ts, ts);
    db.prepare(
      `INSERT INTO ledger_relationship_edges
        (id, source_entity_type, source_entity_id, source_project_id, source_issue_id,
         target_entity_type, target_entity_id, target_project_id, target_issue_id,
         link_type, action_id, actor_type, actor_user_id, evidence_method, evidence_id,
         source, created_at, updated_at)
       VALUES (?, 'issue', ?, ?, ?, 'issue', ?, ?, ?, 'related', ?, 'mandible_user',
               ?, ?, ?, 'mandible', ?, ?)`,
    ).run(
      `edge-${suffix}`,
      `src-${suffix}`, PROJECT, `issue-${suffix}`,
      `tgt-${suffix}`, PROJECT, `issue-${suffix}`,
      `act-${suffix}`, user, method, ev, ts, ts,
    );
  }

  function seedAll(): void {
    for (const scenario of SCENARIOS) {
      seed(scenario.key, scenario.method, scenario.user, scenario.ts);
    }
  }

  function rowFor(table: string, idPrefix: string, userColumn: string, suffix: string) {
    return db.prepare(
      `SELECT ${userColumn} AS userId, evidence_method AS evidenceMethod,
              evidence_id AS evidenceId
         FROM ${table} WHERE id = ?`,
    ).get(`${idPrefix}-${suffix}`) as {
      userId: string | null;
      evidenceMethod: string | null;
      evidenceId: string | null;
    };
  }

  it("clears only pre-cutoff local_default rows and preserves boundary, post-cutoff, and other evidence classes", () => {
    seedAll();

    migrate(db);

    expect(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()).toEqual({
      value: "116",
    });

    for (const { table, idPrefix, userColumn } of AFFECTED) {
      for (const scenario of SCENARIOS) {
        const row = rowFor(table, idPrefix, userColumn, scenario.key);
        if (scenario.expectCleared) {
          expect(row).toEqual({ userId: null, evidenceMethod: null, evidenceId: null });
        } else {
          expect(row).toEqual({
            userId: scenario.user,
            evidenceMethod: scenario.method,
            evidenceId: evidenceId(scenario.key),
          });
        }
      }
    }

    // attribution_evidence rows are never deleted; only FK references on cleared
    // rows are nulled.
    expect(db.prepare("SELECT COUNT(*) AS n FROM attribution_evidence").get()).toEqual({
      n: SCENARIOS.length,
    });
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });

  it("is idempotent: a second migrate() over already-swept rows changes nothing", () => {
    seedAll();
    migrate(db);

    db.exec("UPDATE meta SET value = '115' WHERE key = 'schema_version'");
    expect(() => migrate(db)).not.toThrow();

    for (const { table, idPrefix, userColumn } of AFFECTED) {
      const cleared = rowFor(table, idPrefix, userColumn, "pre_default");
      expect(cleared).toEqual({ userId: null, evidenceMethod: null, evidenceId: null });

      const preservedPost = rowFor(table, idPrefix, userColumn, "post_default");
      expect(preservedPost).toEqual({
        userId: OPERATOR,
        evidenceMethod: "local_default",
        evidenceId: evidenceId("post_default"),
      });
    }
  });

  it("is a no-op when there are no pre-cutoff local_default rows", () => {
    // Only post-cutoff local_default and non-default rows exist.
    seed("post_only", "local_default", OPERATOR, POST);
    seed("session_only", "session_claim", AGENT, PRE);

    migrate(db);

    for (const { table, idPrefix, userColumn } of AFFECTED) {
      expect(rowFor(table, idPrefix, userColumn, "post_only")).toEqual({
        userId: OPERATOR,
        evidenceMethod: "local_default",
        evidenceId: evidenceId("post_only"),
      });
      expect(rowFor(table, idPrefix, userColumn, "session_only")).toEqual({
        userId: AGENT,
        evidenceMethod: "session_claim",
        evidenceId: evidenceId("session_only"),
      });
    }
  });
});
