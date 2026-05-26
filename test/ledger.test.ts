import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrate, openDb, type Db } from "../src/db.js";
import { LEDGER_BACKUP_TABLES } from "../src/ledger/backup.js";
import { createLedgerId } from "../src/ledger/ids.js";
import { normalizeRemoteIdentity, resolveProjectForCheckout } from "../src/ledger/projects.js";
import { LedgerStore } from "../src/ledger/store.js";
import type { LedgerEventSource } from "../src/ledger/types.js";

let tempDir = "";
let dbPath = "";
let db: Db;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-ledger-"));
  dbPath = path.join(tempDir, "mandible.db");
  db = openDb(dbPath);
});

afterEach(() => {
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function createProject(root = path.join(tempDir, "repo")) {
  fs.mkdirSync(root, { recursive: true });
  return resolveProjectForCheckout(db, {
    root,
    name: path.basename(root),
    defaultBranch: "main",
    remoteUrl: "git@github.com:mll/mandible.git",
  });
}

function createIssue(store: LedgerStore, projectId: string, title = "Ledger issue") {
  return store.createIssue({
    project_id: projectId,
    title,
    body: "Body",
    kind: "feature",
    priority: "normal",
    actor_type: "agent",
    author_display: "Codex",
    aliases: [{ alias_kind: "git_bug_short", alias: title.slice(0, 4).toLowerCase() }],
  });
}

describe("ledger schema", () => {
  it("creates ledger tables, indexes, and enables foreign keys on fresh DBs", () => {
    const tables = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'ledger_%' ORDER BY name",
    ).all() as Array<{ name: string }>;
    expect(tables.map((row) => row.name)).toEqual([
      "ledger_auth_issue_links",
      "ledger_comments",
      "ledger_commit_issue_links",
      "ledger_conflicts",
      "ledger_events",
      "ledger_external_refs",
      "ledger_issue_aliases",
      "ledger_issue_relationships",
      "ledger_issues",
      "ledger_labels",
      "ledger_operational_link_mismatches",
      "ledger_operational_link_reports",
      "ledger_outbox",
      "ledger_project_checkouts",
      "ledger_projects",
      "ledger_reconciliation_mismatches",
      "ledger_reconciliation_reports",
      "ledger_session_issue_links",
      "ledger_sync_jobs",
      "ledger_work_unit_issue_links",
    ]);

    const indexes = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_ledger_%'",
    ).all() as Array<{ name: string }>;
    expect(indexes.map((row) => row.name)).toContain("idx_ledger_issues_project_status_updated");
    expect(indexes.map((row) => row.name)).toContain("idx_ledger_outbox_adapter_status");
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
  });

  it("upgrades a v54 database by applying only the ledger migration", () => {
    const upgradePath = path.join(tempDir, "upgrade.db");
    const upgradeDb = new Database(upgradePath);
    upgradeDb.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO meta (key, value) VALUES ('schema_version', '54');
    `);

    migrate(upgradeDb);

    const version = upgradeDb.prepare(
      "SELECT value FROM meta WHERE key = 'schema_version'",
    ).get() as { value: string };
    expect(version.value).toBe("60");
    expect(upgradeDb.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'ledger_issues'",
    ).get()).toBeTruthy();
    upgradeDb.close();
  });

  it("enforces canonical ledger foreign keys", () => {
    expect(() => {
      db.prepare(
        `INSERT INTO ledger_comments (
          id, issue_id, body, author_actor_type, author_display, source, created_at
        ) VALUES ('com_missing', 'iss_missing', 'bad', 'system', '', 'system', 1)`,
      ).run();
    }).toThrow();
  });
});

describe("ledger IDs and project identity", () => {
  it("generates prefixed chronological IDs without path-derived material", () => {
    const first = createLedgerId("iss", {
      now: 1000,
      random: Buffer.from("11111111111111111111", "hex"),
    });
    const second = createLedgerId("iss", {
      now: 1001,
      random: Buffer.from("22222222222222222222", "hex"),
    });

    expect(first).toMatch(/^iss_[0-9a-z]{10}_[0-9a-f]{20}$/);
    expect(first < second).toBe(true);
    expect(first).not.toContain("mandible");
  });

  it("normalizes common SSH and HTTPS remotes to the same identity", () => {
    expect(normalizeRemoteIdentity("git@github.com:mll/mandible.git")).toBe("github.com/mll/mandible");
    expect(normalizeRemoteIdentity("https://github.com/mll/mandible.git")).toBe("github.com/mll/mandible");
    expect(normalizeRemoteIdentity("ssh://git@github.com/mll/mandible.git")).toBe("github.com/mll/mandible");
  });

  it("maps multiple checkouts of the same remote to one project", () => {
    const first = createProject(path.join(tempDir, "one"));
    const second = createProject(path.join(tempDir, "two"));

    expect(second.project.id).toBe(first.project.id);
    expect(second.checkout.id).not.toBe(first.checkout.id);
  });

  it("keeps no-remote local projects separate", () => {
    const one = resolveProjectForCheckout(db, {
      root: path.join(tempDir, "local-one"),
      remoteUrl: "",
    });
    const two = resolveProjectForCheckout(db, {
      root: path.join(tempDir, "local-two"),
      remoteUrl: "",
    });

    expect(one.project.id).not.toBe(two.project.id);
    expect(one.project.namespace_policy).toBe("local");
  });
});

describe("ledger store", () => {
  it("writes issue current state, alias, event, and SSE atomically without default outbox", () => {
    const project = createProject();
    const broadcasts: string[] = [];
    const store = new LedgerStore(db, {
      broadcaster: (type) => broadcasts.push(type),
    });

    const issue = createIssue(store, project.project.id);

    expect(issue.id).toMatch(/^[0-9a-f]{64}$/);
    expect(issue.short_id).toBe(issue.id.slice(0, 7));
    expect(store.listAliases(issue.id).map((alias) => alias.alias_kind)).toContain("canonical");
    expect(store.listEvents({ entity_type: "issue", entity_id: issue.id })).toHaveLength(1);
    expect(store.listOutbox({ status: "pending" })).toHaveLength(0);
    expect(broadcasts).toEqual(["ledger:issue:created", "ledger:event:created"]);
  });

  it("enqueues outbox rows only when an adapter is explicitly configured", () => {
    const project = createProject();
    const store = new LedgerStore(db, { outboxAdapters: ["git_bug"] });

    createIssue(store, project.project.id);

    expect(store.listOutbox({ status: "pending" })).toHaveLength(1);
  });

  it("does not enqueue outbox rows for imported adapter-sourced events", () => {
    const project = createProject();
    const store = new LedgerStore(db, { outboxAdapters: ["git_bug"] });

    store.createIssue({
      project_id: project.project.id,
      title: "Imported",
      source: "git_bug" satisfies LedgerEventSource,
      aliases: [{ alias_kind: "git_bug_short", alias: "abc123" }],
    });

    expect(store.listOutbox()).toHaveLength(0);
  });

  it("writes comments with events without default outbox rows", () => {
    const project = createProject();
    const store = new LedgerStore(db);
    const issue = createIssue(store, project.project.id);

    const comment = store.addComment(issue.id, {
      body: "A comment",
      actor_type: "mandible_user",
      author_display: "Mandible User",
    });

    expect(comment.id).toMatch(/^[0-9a-f]{64}$/);
    expect(comment.ordinal).toBe(1);
    expect(store.listEvents({ entity_type: "comment", entity_id: comment.id })).toHaveLength(1);
    expect(store.listOutbox({ status: "pending" })).toHaveLength(0);
  });

  it("sets labels idempotently and records only state-changing events", () => {
    const project = createProject();
    const store = new LedgerStore(db);
    const issue = createIssue(store, project.project.id);

    expect(store.setLabel(issue.id, "umbrella", true).changed).toBe(true);
    expect(store.setLabel(issue.id, "umbrella", true).changed).toBe(false);
    expect(store.setLabel(issue.id, "umbrella", false).changed).toBe(true);

    const events = store
      .listEvents({ entity_type: "issue", entity_id: issue.id })
      .filter((event) => event.event_type === "label.updated");
    expect(events).toHaveLength(2);
  });

  it("resolves canonical IDs, aliases, prefixes, not-found, and ambiguity", () => {
    const project = createProject();
    const store = new LedgerStore(db);
    const first = store.createIssue({
      project_id: project.project.id,
      title: "First",
      aliases: [{ alias_kind: "git_bug_short", alias: "abcd111" }],
    });
    store.createIssue({
      project_id: project.project.id,
      title: "Second",
      aliases: [{ alias_kind: "git_bug_short", alias: "abcd222" }],
    });

    expect(store.resolveIssueRef(first.id)).toEqual({ ok: true, id: first.id });
    expect(store.resolveIssueRef("abcd111")).toEqual({ ok: true, id: first.id });
    expect(store.resolveIssueRef(first.id.slice(0, 25))).toEqual({ ok: true, id: first.id });
    expect(store.resolveIssueRef("missing")).toEqual({ ok: false, error: "not_found" });
    expect(store.resolveIssueRef("abc")).toEqual({ ok: false, error: "not_found" });
    const ambiguousPrefix = store.resolveIssueRef("abcd");
    expect(ambiguousPrefix.ok).toBe(false);
  });

  it("upserts relationships, external refs, conflicts, and outbox status", () => {
    const project = createProject();
    const store = new LedgerStore(db, { outboxAdapters: ["git_bug"] });
    const parent = createIssue(store, project.project.id, "Parent");
    const child = createIssue(store, project.project.id, "Child");

    const relationship = store.upsertIssueRelationship({
      source_issue_id: parent.id,
      target_issue_id: child.id,
      relationship_type: "parent_child",
      provenance: "manual",
      metadata: { order: 1 },
    });
    const ref = store.recordExternalRef({
      entity_type: "issue",
      entity_id: parent.id,
      adapter: "git_bug",
      project_id: project.project.id,
      external_kind: "git_bug_id",
      external_id: "abc123",
      remote_hash: "remote",
    });
    const conflict = store.recordConflict({
      adapter: "git_bug",
      project_id: project.project.id,
      entity_type: "issue",
      entity_id: parent.id,
      field: "title",
      local_value: "Local",
      remote_value: "Remote",
    });
    const outbox = store.markOutbox(store.listOutbox({ status: "pending" })[0].id, "processing", {
      attempt_count: 1,
      last_attempt_at: 100,
    });

    expect(relationship.id).toMatch(/^rel_/);
    expect(ref.id).toMatch(/^xref_/);
    expect(conflict.id).toMatch(/^cnf_/);
    expect(outbox.status).toBe("processing");
    expect(store.listConflicts({ status: "open" })).toHaveLength(1);
  });
});

describe("ledger backup contract", () => {
  it("lists every non-reproducible ledger table for backup tooling", () => {
    const tableNames = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'ledger_%'",
    ).all() as Array<{ name: string }>;
    const backedUp = new Set<string>(LEDGER_BACKUP_TABLES);

    for (const table of tableNames) {
      expect(backedUp.has(table.name)).toBe(true);
    }
  });
});
