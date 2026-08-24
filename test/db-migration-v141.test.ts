import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CURRENT_SCHEMA_VERSION, migrate, type Db } from "../src/db.js";

describe("migration v141: canonical work-unit repo ids", () => {
  let db: Db;

  beforeEach(() => {
    db = new Database(":memory:");
    migrate(db);
  });

  afterEach(() => {
    db.close();
  });

  it("canonicalizes only registry-resolvable rows while preserving identity and history", () => {
    const now = Date.now();
    db.prepare(
      `INSERT INTO ledger_projects (
        id, project_key, display_name, remote_identity, upstream_identity,
        namespace_policy, created_at, updated_at
      ) VALUES ('project-dotfiles', 'dotfiles', 'dotfiles', 'example/dotfiles', '', 'remote', ?, ?)`,
    ).run(now, now);
    db.prepare(
      `INSERT INTO ledger_project_checkouts (
        id, project_id, work_repo_id, root, name, default_branch, remote_url,
        created_at, updated_at
      ) VALUES ('checkout-dotfiles', 'project-dotfiles', '.dotfiles', '/registered/dotfiles',
                '.dotfiles', 'main', '', ?, ?)`,
    ).run(now, now);
    db.exec(`
      INSERT INTO ledger_projects (
        id, project_key, display_name, remote_identity, upstream_identity,
        namespace_policy, created_at, updated_at
      ) VALUES
        ('project-alpha', 'alpha', 'alpha', 'example/alpha', '', 'remote', ${now}, ${now}),
        ('project-beta', 'beta', 'beta', 'example/beta', '', 'remote', ${now}, ${now});
      INSERT INTO ledger_project_checkouts (
        id, project_id, work_repo_id, root, name, default_branch, remote_url,
        created_at, updated_at
      ) VALUES
        ('checkout-alpha', 'project-alpha', 'shared-local-id', '/registered/alpha', 'alpha', 'main', '', ${now}, ${now}),
        ('checkout-beta', 'project-beta', 'shared-local-id', '/registered/beta', 'beta', 'main', '', ${now}, ${now});
    `);
    db.prepare(
      `INSERT INTO work_units (
        id, issue_id, repo_id, branch, kind, state, created_at, activated_at,
        last_commit_at, resolved_at, auth_request_id
      ) VALUES
        ('wu-alias', 'issue-a', '.dotfiles', 'feature/a', 'solo', 'abandoned', 1, 2, 3, NULL, NULL),
        ('wu-root', 'issue-b', '/registered/dotfiles', 'feature/b', 'solo', 'resolved', 4, 5, 6, 7, 'auth-b'),
        ('wu-ambiguous', 'issue-c', 'shared-local-id', 'feature/c', 'solo', 'open', 8, NULL, NULL, NULL, NULL),
        ('wu-unknown', 'issue-d', 'unregistered', 'feature/d', 'solo', 'open', 9, NULL, NULL, NULL, NULL)`,
    ).run();
    db.prepare("UPDATE meta SET value = '140' WHERE key = 'schema_version'").run();

    migrate(db);

    expect(CURRENT_SCHEMA_VERSION).toBe(157);
    expect(db.prepare(
      `SELECT id, repo_id, state, created_at, activated_at, last_commit_at,
              resolved_at, auth_request_id
       FROM work_units ORDER BY id`,
    ).all()).toEqual([
      {
        id: "wu-alias", repo_id: "dotfiles", state: "abandoned", created_at: 1,
        activated_at: 2, last_commit_at: 3, resolved_at: null, auth_request_id: null,
      },
      {
        id: "wu-ambiguous", repo_id: "shared-local-id", state: "open", created_at: 8,
        activated_at: null, last_commit_at: null, resolved_at: null, auth_request_id: null,
      },
      {
        id: "wu-root", repo_id: "dotfiles", state: "resolved", created_at: 4,
        activated_at: 5, last_commit_at: 6, resolved_at: 7, auth_request_id: "auth-b",
      },
      {
        id: "wu-unknown", repo_id: "unregistered", state: "open", created_at: 9,
        activated_at: null, last_commit_at: null, resolved_at: null, auth_request_id: null,
      },
    ]);

    const snapshot = db.prepare(
      "SELECT id, repo_id, state, created_at, activated_at, last_commit_at, resolved_at, auth_request_id FROM work_units ORDER BY id",
    ).all();
    db.prepare("UPDATE meta SET value = '140' WHERE key = 'schema_version'").run();
    migrate(db);
    expect(db.prepare(
      "SELECT id, repo_id, state, created_at, activated_at, last_commit_at, resolved_at, auth_request_id FROM work_units ORDER BY id",
    ).all()).toEqual(snapshot);
  });
});
