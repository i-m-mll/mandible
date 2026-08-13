import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrate } from "../src/db.js";

describe("migration v118: canonical project repo ids", () => {
  let db: InstanceType<typeof Database>;

  beforeEach(() => {
    db = new Database(":memory:");
    migrate(db);
  });

  afterEach(() => {
    db.close();
  });

  it("canonicalizes numbered checkout ids and collision-prone operational links", () => {
    const now = Date.now();
    db.exec(`
      INSERT INTO ledger_projects (
        id, project_key, display_name, remote_identity, upstream_identity,
        namespace_policy, created_at, updated_at
      ) VALUES (
        'project-widgets', 'feedbax', 'feedbax', 'github.com/example/feedbax',
        '', 'remote', ${now}, ${now}
      );

      INSERT INTO ledger_project_checkouts (
        id, project_id, work_repo_id, root, name, default_branch,
        remote_url, created_at, updated_at
      ) VALUES
        ('checkout-main', 'project-widgets', '20-widgets-widgets',
         '/projects/20 Widgets/widgets', 'widgets', 'main', '', ${now}, ${now}),
        ('checkout-dev', 'project-widgets', 'dev-widgets',
         '/dev/widgets', 'widgets', 'main', '', ${now}, ${now});

      INSERT INTO work_repos (
        id, root, name, default_branch, dir_exists, excluded,
        user_modified, created_at, updated_at
      ) VALUES
        ('20-widgets-widgets', '/projects/20 Widgets/widgets', 'widgets', 'main', 1, 0, 0, datetime('now'), datetime('now')),
        ('feedbax', '/dev/widgets', 'widgets', 'main', 1, 0, 0, datetime('now'), datetime('now'));

      INSERT INTO work_units (
        id, issue_id, repo_id, kind, state, created_at
      ) VALUES
        ('work-old', 'issue-a', '20-widgets-widgets', 'solo', 'open', ${now});

      INSERT INTO session_issues (session_id, issue_id, repo_id, created_at)
      VALUES
        ('session-a', 'issue-a', '20-widgets-widgets', ${now}),
        ('session-a', 'issue-a', 'feedbax', ${now + 1});

      INSERT INTO session_projects (session_id, repo_id, repo_name, created_at)
      VALUES
        ('session-a', '20-widgets-widgets', 'widgets', ${now}),
        ('session-a', 'feedbax', 'widgets', ${now + 1});

      DROP INDEX work_repos_id_idx;
      INSERT INTO work_repos (
        id, root, name, default_branch, dir_exists, excluded,
        user_modified, created_at, updated_at
      ) VALUES
        ('unrelated-duplicate', '/unrelated/a', 'a', 'main', 1, 0, 0, datetime('now'), datetime('now')),
        ('unrelated-duplicate', '/unrelated/b', 'b', 'main', 1, 0, 0, datetime('now'), datetime('now'));

      UPDATE meta SET value = '117' WHERE key = 'schema_version';
    `);

    migrate(db);

    expect(db.prepare(
      "SELECT value FROM meta WHERE key = 'schema_version'",
    ).get()).toEqual({ value: "124" });
    expect(db.prepare(
      "SELECT work_repo_id FROM ledger_project_checkouts WHERE id = 'checkout-main'",
    ).get()).toEqual({ work_repo_id: "feedbax" });
    expect(db.prepare(
      "SELECT id FROM work_repos WHERE root = '/projects/20 Widgets/widgets'",
    ).get()).toEqual({ id: "feedbax" });
    expect(db.prepare(
      "SELECT id FROM work_repos WHERE root = '/dev/widgets'",
    ).get()).toEqual({ id: "dev-widgets" });
    expect(db.prepare(
      "SELECT repo_id FROM work_units WHERE id = 'work-old'",
    ).get()).toEqual({ repo_id: "feedbax" });
    expect(db.prepare(
      "SELECT count(*) AS count FROM session_issues WHERE repo_id = '20-widgets-widgets'",
    ).get()).toEqual({ count: 0 });
    expect(db.prepare(
      "SELECT count(*) AS count FROM session_issues WHERE repo_id = 'feedbax'",
    ).get()).toEqual({ count: 1 });
    expect(db.prepare(
      "SELECT created_at FROM session_issues WHERE repo_id = 'feedbax'",
    ).get()).toEqual({ created_at: now });
    expect(db.prepare(
      "SELECT count(*) AS count FROM session_projects WHERE repo_id = '20-widgets-widgets'",
    ).get()).toEqual({ count: 0 });
    expect(db.prepare(
      "SELECT count(*) AS count FROM session_projects WHERE repo_id = 'feedbax'",
    ).get()).toEqual({ count: 1 });
    expect(db.prepare(
      "SELECT created_at, repo_name FROM session_projects WHERE repo_id = 'feedbax'",
    ).get()).toEqual({ created_at: now, repo_name: "widgets" });
    expect(db.prepare(
      "SELECT count(*) AS count FROM work_repos WHERE id = 'unrelated-duplicate'",
    ).get()).toEqual({ count: 2 });

    const scannerState = db.prepare(
      "SELECT id, root, updated_at FROM work_repos ORDER BY root",
    ).all();
    db.exec("UPDATE meta SET value = '117' WHERE key = 'schema_version'");
    migrate(db);
    expect(db.prepare(
      "SELECT id, root, updated_at FROM work_repos ORDER BY root",
    ).all()).toEqual(scannerState);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });
});
