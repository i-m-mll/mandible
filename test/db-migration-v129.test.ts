import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { CURRENT_SCHEMA_VERSION, migrate } from "../src/db.js";
import { resolveProjectForCheckout } from "../src/ledger/projects.js";

describe("migration v129 auth merge success facts", () => {
  it("backfills retained successful merge requests and ignores unsuccessful rows", () => {
    const db = new Database(":memory:");
    try {
      migrate(db);
      const project = resolveProjectForCheckout(db, {
        root: "/tmp/mandible-v129-project",
        name: "v129-project",
        remoteUrl: "https://example.test/v129-project.git",
        defaultBranch: "main",
      }, 10);
      db.exec(`
        DROP TABLE auth_request_merge_succeeded_facts;
        DELETE FROM meta WHERE key = 'post_migration.v129_backfill_auth_merge_succeeded_facts.complete';
        UPDATE meta SET value = '128' WHERE key = 'schema_version';
      `);
      const insert = db.prepare(
        `INSERT INTO auth_requests (
           id, type, command, title, repo, cwd, base_branch, execution_mode,
           status, created_at, updated_at, resolved_at, expires_at, exit_code,
           output, approval_source, commit_message_digest
         ) VALUES (?, 'merge', 'git merge', 'Merge', ?, ?, ?, 'daemon', ?,
                   100, ?, ?, 1000, ?, '', 'manual', ?)`,
      );
      insert.run(
        "success-canonical",
        project.checkout.root,
        project.checkout.root,
        "develop",
        "completed",
        200,
        190,
        0,
        "b".repeat(64),
      );
      insert.run(
        "success-legacy",
        project.checkout.root,
        project.checkout.root,
        "main",
        "completed",
        300,
        290,
        0,
        null,
      );
      insert.run(
        "failed",
        project.checkout.root,
        project.checkout.root,
        "main",
        "completed",
        400,
        390,
        1,
        "c".repeat(64),
      );

      migrate(db);

      expect(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get())
        .toEqual({ value: String(CURRENT_SCHEMA_VERSION) });
      expect(db.prepare(
        `SELECT auth_request_id, project_id, base_branch, completed_at, canonical_message
           FROM auth_request_merge_succeeded_facts ORDER BY auth_request_id`,
      ).all()).toEqual([
        {
          auth_request_id: "success-canonical",
          project_id: project.project.id,
          base_branch: "develop",
          completed_at: 190,
          canonical_message: 1,
        },
        {
          auth_request_id: "success-legacy",
          project_id: project.project.id,
          base_branch: "main",
          completed_at: 290,
          canonical_message: 0,
        },
      ]);
    } finally {
      db.close();
    }
  });
});
