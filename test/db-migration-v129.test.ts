import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { CURRENT_SCHEMA_VERSION, migrate } from "../src/db.js";
import { resolveProjectForCheckout } from "../src/ledger/projects.js";

describe("migration v129 auth merge success facts", () => {
  it("keeps fresh databases and fully resolvable replays on the completed path", () => {
    const db = new Database(":memory:");
    try {
      migrate(db);
      expect(db.prepare(
        `SELECT value FROM meta
          WHERE key = 'post_migration.v129_backfill_auth_merge_succeeded_facts.complete'`,
      ).get()).toEqual({ value: "done" });
      expect(db.prepare(
        `SELECT value FROM meta
          WHERE key = 'post_migration.v129_backfill_auth_merge_succeeded_facts.deferred_auth_request_ids'`,
      ).get()).toBeUndefined();

      const project = resolveProjectForCheckout(db, {
        root: "/tmp/mandible-v129-normal-replay",
        name: "v129-normal-replay",
        remoteUrl: "https://example.test/v129-normal-replay.git",
        defaultBranch: "main",
      }, 10);
      db.exec(`
        DROP TABLE auth_request_merge_succeeded_facts;
        DELETE FROM meta WHERE key = 'post_migration.v129_backfill_auth_merge_succeeded_facts.complete';
        UPDATE meta SET value = '128' WHERE key = 'schema_version';
      `);
      db.prepare(
        `INSERT INTO auth_requests (
           id, type, command, title, repo, cwd, base_branch, execution_mode,
           status, created_at, updated_at, resolved_at, expires_at, exit_code,
           output, approval_source, commit_message_digest
         ) VALUES ('success-normal', 'merge', 'git merge', 'Merge', ?, ?, 'develop',
                   'daemon', 'completed', 100, 200, 190, 1000, 0, '', 'manual', ?)`,
      ).run(project.checkout.root, project.checkout.root, "a".repeat(64));

      migrate(db);

      expect(db.prepare(
        `SELECT auth_request_id, project_id, base_branch, completed_at, canonical_message
           FROM auth_request_merge_succeeded_facts`,
      ).get()).toEqual({
        auth_request_id: "success-normal",
        project_id: project.project.id,
        base_branch: "develop",
        completed_at: 190,
        canonical_message: 1,
      });
      expect(db.prepare(
        `SELECT value FROM meta
          WHERE key = 'post_migration.v129_backfill_auth_merge_succeeded_facts.complete'`,
      ).get()).toEqual({ value: "done" });
      expect(db.prepare(
        `SELECT value FROM meta
          WHERE key = 'post_migration.v129_backfill_auth_merge_succeeded_facts.deferred_auth_request_ids'`,
      ).get()).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it("backfills resolvable requests and defers successful requests from unregistered repos", () => {
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
        "success-unregistered",
        "/Users/mll/Main",
        "/Users/mll/Main",
        "main",
        "completed",
        350,
        340,
        0,
        "d".repeat(64),
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
      expect(db.prepare(
        `SELECT value FROM meta
          WHERE key = 'post_migration.v129_backfill_auth_merge_succeeded_facts.deferred_auth_request_ids'`,
      ).get()).toEqual({ value: JSON.stringify(["success-unregistered"]) });
      expect(db.prepare(
        `SELECT value FROM meta
          WHERE key = 'post_migration.v129_backfill_auth_merge_succeeded_facts.complete'`,
      ).get()).toBeUndefined();

      // The incomplete post-migration pass remains replay-safe and converges if
      // the historical repository is registered later.
      const registered = resolveProjectForCheckout(db, {
        root: "/Users/mll/Main",
        name: "personal-writing",
        remoteUrl: null,
        defaultBranch: "main",
      }, 500);
      migrate(db);

      expect(db.prepare(
        `SELECT auth_request_id, project_id FROM auth_request_merge_succeeded_facts
          WHERE auth_request_id = 'success-unregistered'`,
      ).get()).toEqual({
        auth_request_id: "success-unregistered",
        project_id: registered.project.id,
      });
      expect(db.prepare(
        `SELECT value FROM meta
          WHERE key = 'post_migration.v129_backfill_auth_merge_succeeded_facts.deferred_auth_request_ids'`,
      ).get()).toBeUndefined();
      expect(db.prepare(
        `SELECT value FROM meta
          WHERE key = 'post_migration.v129_backfill_auth_merge_succeeded_facts.complete'`,
      ).get()).toEqual({ value: "done" });
    } finally {
      db.close();
    }
  });

  it("cleans stale deferred residue when facts and the completion marker already exist", () => {
    const db = new Database(":memory:");
    try {
      migrate(db);
      const project = resolveProjectForCheckout(db, {
        root: "/tmp/mandible-v129-stale-residue",
        name: "v129-stale-residue",
        remoteUrl: null,
        defaultBranch: "main",
      }, 10);
      db.prepare(
        `INSERT INTO auth_requests (
           id, type, command, title, repo, cwd, base_branch, execution_mode,
           status, created_at, updated_at, resolved_at, expires_at, exit_code,
           output, approval_source
         ) VALUES ('success-runtime-filled', 'merge', 'git merge', 'Merge', ?, ?, 'main',
                   'daemon', 'completed', 100, 200, 190, 1000, 0, '', 'manual')`,
      ).run(project.checkout.root, project.checkout.root);
      db.prepare(
        `INSERT INTO auth_request_merge_succeeded_facts (
           auth_request_id, project_id, base_branch, completed_at,
           canonical_message, recorded_at
         ) VALUES ('success-runtime-filled', ?, 'main', 190, 0, 190)`,
      ).run(project.project.id);
      db.prepare(
        `INSERT OR REPLACE INTO meta (key, value) VALUES (
           'post_migration.v129_backfill_auth_merge_succeeded_facts.deferred_auth_request_ids',
           ?
         )`,
      ).run(JSON.stringify(["success-runtime-filled"]));

      migrate(db);

      expect(db.prepare(
        `SELECT value FROM meta
          WHERE key = 'post_migration.v129_backfill_auth_merge_succeeded_facts.complete'`,
      ).get()).toEqual({ value: "done" });
      expect(db.prepare(
        `SELECT value FROM meta
          WHERE key = 'post_migration.v129_backfill_auth_merge_succeeded_facts.deferred_auth_request_ids'`,
      ).get()).toBeUndefined();
      expect(db.prepare(
        `SELECT auth_request_id FROM auth_request_merge_succeeded_facts`,
      ).all()).toEqual([{ auth_request_id: "success-runtime-filled" }]);
    } finally {
      db.close();
    }
  });
});
