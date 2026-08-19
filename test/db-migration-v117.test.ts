import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { migrate, openDb, type Db } from "../src/db.js";
import {
  RESIDUAL_LOCAL_DEFAULT_CUTOFF_MS,
  RESIDUAL_MISATTRIBUTION_OPERATOR_ID,
} from "../src/db-migrations.js";

// Issue be2ab49: migration v117 is a one-shot corrective follow-up to v115.
// v115 was consumed prematurely against the live DB (issue 07edc0d), so the
// post-merge restart skipped it and the old daemon kept writing rows stamped
// evidence_method='local_default' until the corrected restart. v117 clears that
// residual operator misattribution, but only when THREE conditions hold, so it
// touches only this deployment's residue:
//   1. evidence_method = 'local_default';
//   2. the attribution user column equals this deployment's operator id
//      (deployment-history scoping: a restored backup or other install at v115
//      with a different operator id is left untouched); and
//   3. the attribution-write timestamp is strictly before the v115-merge cutoff
//      (edges use COALESCE(updated_at, created_at) because relinks overwrite
//      attribution in place while preserving created_at).
describe("migration v117: clear residual local_default ledger misattribution", () => {
  let tempDir: string;
  let db: Db;
  const PROJECT = "proj-fixture";
  const OPERATOR = RESIDUAL_MISATTRIBUTION_OPERATOR_ID;
  const OTHER_OPERATOR = "01OTHERDEPLOYMENTOPERATORXYZ";
  const AGENT = "user-agent-fixture";

  const CUTOFF_MS = RESIDUAL_LOCAL_DEFAULT_CUTOFF_MS;
  const PRE = CUTOFF_MS - 1;
  const BOUNDARY = CUTOFF_MS;
  const POST = CUTOFF_MS + 1;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-db-v117-"));
    db = openDb(path.join(tempDir, "mandible.db"));
    db.pragma("foreign_keys = ON");
    // Rewind to just before v117 so migrate() applies ONLY the residual sweep
    // (not v115, which would clear every local_default row regardless of user or
    // timestamp and defeat the scoping/boundary assertions). v116 is the
    // additive identity-columns DDL and is already applied on this fresh DB.
    db.exec("UPDATE meta SET value = '116' WHERE key = 'schema_version'");

    const insertUser = db.prepare(
      `INSERT INTO users (id, slug, kind, display_name, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'active', 0, 0)`,
    );
    insertUser.run(OPERATOR, "operator-fixture", "human", "Operator");
    insertUser.run(OTHER_OPERATOR, "other-operator-fixture", "human", "Other Operator");
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

  // Each affected table with its user-attribution column.
  const AFFECTED = [
    { table: "ledger_issues", idPrefix: "issue", userColumn: "author_user_id" },
    { table: "ledger_comments", idPrefix: "comment", userColumn: "author_user_id" },
    { table: "ledger_issue_checkpoints", idPrefix: "checkpoint", userColumn: "author_user_id" },
    { table: "ledger_events", idPrefix: "event", userColumn: "actor_user_id" },
    { table: "ledger_body_revisions", idPrefix: "revision", userColumn: "actor_user_id" },
    { table: "ledger_relationship_edges", idPrefix: "edge", userColumn: "actor_user_id" },
  ] as const;

  // Scenarios seeded into every table. Only the matching-operator + local_default
  // + pre-cutoff scenario is cleared.
  const SCENARIOS = [
    { key: "pre_default_op", method: "local_default", user: OPERATOR, ts: PRE, expectCleared: true },
    { key: "boundary_default_op", method: "local_default", user: OPERATOR, ts: BOUNDARY, expectCleared: false },
    { key: "post_default_op", method: "local_default", user: OPERATOR, ts: POST, expectCleared: false },
    // Deployment-history scoping (F3): local_default + pre-cutoff but a DIFFERENT
    // operator id must be preserved.
    { key: "pre_default_other_op", method: "local_default", user: OTHER_OPERATOR, ts: PRE, expectCleared: false },
    { key: "pre_session", method: "session_claim", user: AGENT, ts: PRE, expectCleared: false },
    { key: "pre_api", method: "api_token", user: AGENT, ts: PRE, expectCleared: false },
  ] as const;

  function seedIssue(suffix: string, user: string, method: string, ev: string, ts: number): void {
    db.prepare(
      `INSERT INTO ledger_issues
        (id, short_id, project_id, title, body, status, author_actor_type,
         author_display, author_user_id, evidence_method, evidence_id, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, '', 'open', 'mandible_user', 'Mandible', ?, ?, ?, 'mandible', ?, ?)`,
    ).run(`issue-${suffix}`, `i-${suffix}`, PROJECT, `Issue ${suffix}`, user, method, ev, ts, ts);
  }

  function seedEdge(
    suffix: string,
    user: string,
    method: string,
    ev: string,
    createdAt: number,
    updatedAt: number,
    linkType = "related",
    issueId = `issue-${suffix}`,
  ): void {
    db.prepare(
      `INSERT INTO ledger_relationship_edges
        (id, source_entity_type, source_entity_id, source_project_id, source_issue_id,
         target_entity_type, target_entity_id, target_project_id, target_issue_id,
         link_type, action_id, actor_type, actor_user_id, evidence_method, evidence_id,
         source, created_at, updated_at)
       VALUES (?, 'issue', ?, ?, ?, 'issue', ?, ?, ?, ?, ?, 'mandible_user',
               ?, ?, ?, 'mandible', ?, ?)`,
    ).run(
      `edge-${suffix}`,
      `src-${suffix}`, PROJECT, issueId,
      `tgt-${suffix}`, PROJECT, issueId,
      linkType, `act-${suffix}`, user, method, ev, createdAt, updatedAt,
    );
  }

  // Seed one row per table for a scenario. created_at == updated_at == occurred_at
  // == ts (the edge relink hazard is exercised separately).
  function seed(suffix: string, method: string, user: string, ts: number): void {
    const ev = evidenceId(suffix);
    db.prepare(
      `INSERT INTO attribution_evidence (id, evidence_method, verified_at) VALUES (?, ?, 0)`,
    ).run(ev, method);
    seedIssue(suffix, user, method, ev, ts);
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
    // Edge in the shared scenario set uses created_at == updated_at == ts.
    seedEdge(suffix, user, method, ev, ts, ts);
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

  function edgeRow(suffix: string) {
    return db.prepare(
      `SELECT actor_user_id AS userId, evidence_method AS evidenceMethod, evidence_id AS evidenceId
         FROM ledger_relationship_edges WHERE id = ?`,
    ).get(`edge-${suffix}`) as {
      userId: string | null;
      evidenceMethod: string | null;
      evidenceId: string | null;
    };
  }

  it("clears only matching-operator pre-cutoff local_default rows; preserves other operator, boundary, post-cutoff, and other evidence classes", () => {
    seedAll();

    migrate(db);

    // A rewind to 116 replays the v117 sweep and the later v118 data correction.
    expect(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()).toEqual({
value: "144",
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

    expect(db.prepare("SELECT COUNT(*) AS n FROM attribution_evidence").get()).toEqual({
      n: SCENARIOS.length,
    });
    expect(db.pragma("foreign_key_check")).toEqual([]);
  });

  it("uses COALESCE(updated_at, created_at) for edges so a post-cutoff relink is preserved (F4)", () => {
    // Two edges, same operator + local_default, both created before the cutoff.
    // One was relinked after the cutoff (updated_at >= cutoff) and must survive;
    // the other was never relinked (updated_at < cutoff) and must be cleared.
    db.prepare(
      `INSERT INTO attribution_evidence (id, evidence_method, verified_at) VALUES (?, 'local_default', 0)`,
    ).run("ev-edge-relinked");
    db.prepare(
      `INSERT INTO attribution_evidence (id, evidence_method, verified_at) VALUES (?, 'local_default', 0)`,
    ).run("ev-edge-old");
    // Edges reference source/target issues; create one issue to satisfy the FKs.
    seedIssue("edge-base", OPERATOR, "local_default", "ev-edge-relinked", PRE);

    seedEdge("relinked", OPERATOR, "local_default", "ev-edge-relinked", PRE, POST, "related", "issue-edge-base");
    seedEdge("old", OPERATOR, "local_default", "ev-edge-old", PRE, PRE, "duplicate_of", "issue-edge-base");

    migrate(db);

    // Relinked-after-cutoff edge survives (COALESCE(updated_at, created_at) = POST).
    expect(edgeRow("relinked")).toEqual({
      userId: OPERATOR,
      evidenceMethod: "local_default",
      evidenceId: "ev-edge-relinked",
    });
    // Never-relinked edge is cleared (COALESCE = PRE < cutoff).
    expect(edgeRow("old")).toEqual({ userId: null, evidenceMethod: null, evidenceId: null });
  });

  it("is idempotent: a second migrate() over already-swept rows changes nothing", () => {
    seedAll();
    migrate(db);

    db.exec("UPDATE meta SET value = '116' WHERE key = 'schema_version'");
    expect(() => migrate(db)).not.toThrow();

    for (const { table, idPrefix, userColumn } of AFFECTED) {
      expect(rowFor(table, idPrefix, userColumn, "pre_default_op")).toEqual({
        userId: null,
        evidenceMethod: null,
        evidenceId: null,
      });
      expect(rowFor(table, idPrefix, userColumn, "post_default_op")).toEqual({
        userId: OPERATOR,
        evidenceMethod: "local_default",
        evidenceId: evidenceId("post_default_op"),
      });
      expect(rowFor(table, idPrefix, userColumn, "pre_default_other_op")).toEqual({
        userId: OTHER_OPERATOR,
        evidenceMethod: "local_default",
        evidenceId: evidenceId("pre_default_other_op"),
      });
    }
  });

  it("is a no-op on a database whose local_default rows belong to a different operator (restored backup / other install)", () => {
    // No rows carry this deployment's operator id, so nothing is cleared even
    // though these are pre-cutoff local_default rows.
    seed("foreign_pre", "local_default", OTHER_OPERATOR, PRE);
    seed("session_only", "session_claim", AGENT, PRE);

    migrate(db);

    for (const { table, idPrefix, userColumn } of AFFECTED) {
      expect(rowFor(table, idPrefix, userColumn, "foreign_pre")).toEqual({
        userId: OTHER_OPERATOR,
        evidenceMethod: "local_default",
        evidenceId: evidenceId("foreign_pre"),
      });
      expect(rowFor(table, idPrefix, userColumn, "session_only")).toEqual({
        userId: AGENT,
        evidenceMethod: "session_claim",
        evidenceId: evidenceId("session_only"),
      });
    }
  });
});
