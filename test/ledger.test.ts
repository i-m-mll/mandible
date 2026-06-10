import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CURRENT_SCHEMA_VERSION, migrate, openDb, type Db } from "../src/db.js";
import { LEDGER_BACKUP_TABLES } from "../src/ledger/backup.js";
import { createLedgerId } from "../src/ledger/ids.js";
import { getLedgerIssueHead } from "../src/ledger/issue-heads.js";
import { runIssueReferenceBackfill } from "../src/ledger/issue-reference-backfill.js";
import { parseIssueReferences } from "../src/ledger/issue-xrefs.js";
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
      "ledger_body_revisions",
      "ledger_comments",
      "ledger_commit_issue_links",
      "ledger_conflicts",
      "ledger_events",
      "ledger_external_refs",
      "ledger_issue_aliases",
      "ledger_issue_checkpoints",
      "ledger_issue_relationship_sources",
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
    expect(indexes.map((row) => row.name)).toContain("idx_ledger_body_revisions_entity");
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
    expect(version.value).toBe(String(CURRENT_SCHEMA_VERSION));
    expect(upgradeDb.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'ledger_issues'",
    ).get()).toBeTruthy();
    upgradeDb.close();
  });

  it("backfills current-only body revisions when upgrading an existing ledger", () => {
    const upgradePath = path.join(tempDir, "body-revisions-upgrade.db");
    const upgradeDb = new Database(upgradePath);
    upgradeDb.pragma("foreign_keys = ON");
    upgradeDb.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO meta (key, value) VALUES ('schema_version', '67');
      CREATE TABLE ledger_projects (
        id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        remote_identity TEXT NOT NULL,
        upstream_identity TEXT NOT NULL,
        namespace_policy TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE ledger_issues (
        id TEXT PRIMARY KEY,
        short_id TEXT NOT NULL DEFAULT '',
        project_id TEXT NOT NULL REFERENCES ledger_projects(id) ON DELETE RESTRICT,
        title TEXT NOT NULL,
        body TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL,
        resolution TEXT,
        kind TEXT NOT NULL DEFAULT 'unknown',
        priority TEXT NOT NULL DEFAULT 'unknown',
        author_actor_id TEXT,
        author_actor_type TEXT NOT NULL DEFAULT 'external_adapter',
        author_display TEXT NOT NULL DEFAULT '',
        source TEXT NOT NULL DEFAULT 'mandible',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        closed_at INTEGER,
        deleted_at INTEGER
      );
      CREATE TABLE ledger_comments (
        id TEXT PRIMARY KEY,
        issue_id TEXT NOT NULL REFERENCES ledger_issues(id) ON DELETE CASCADE,
        ordinal INTEGER NOT NULL DEFAULT 0,
        body TEXT NOT NULL,
        author_actor_id TEXT,
        author_actor_type TEXT NOT NULL,
        author_display TEXT NOT NULL DEFAULT '',
        source TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER,
        deleted_at INTEGER
      );
      CREATE TABLE ledger_events (
        id TEXT PRIMARY KEY,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        actor_id TEXT,
        actor_type TEXT NOT NULL,
        source TEXT NOT NULL,
        payload_json TEXT NOT NULL DEFAULT '{}',
        occurred_at INTEGER NOT NULL,
        observed_at INTEGER NOT NULL
      );
      INSERT INTO ledger_projects
        (id, display_name, remote_identity, upstream_identity, namespace_policy, created_at, updated_at)
        VALUES ('prj_test', 'test', 'local:test', 'local:test', 'local', 1000, 1000);
      INSERT INTO ledger_issues
        (id, short_id, project_id, title, body, status, kind, priority, author_actor_type, source, created_at, updated_at)
        VALUES ('issue_test', 'issue_tes', 'prj_test', 'Issue', 'Issue body', 'open', 'feature', 'normal', 'agent', 'mandible', 1000, 1000);
      INSERT INTO ledger_comments
        (id, issue_id, ordinal, body, author_actor_type, source, created_at)
        VALUES ('com_test', 'issue_test', 1, 'Comment body', 'agent', 'mandible', 1100);
    `);

    migrate(upgradeDb);

    expect(upgradeDb.prepare(
      "SELECT entity_type, entity_id, revision_no, reason, snapshot_body FROM ledger_body_revisions ORDER BY entity_type",
    ).all()).toEqual([
      {
        entity_type: "comment_body",
        entity_id: "com_test",
        revision_no: 1,
        reason: "migration_snapshot",
        snapshot_body: "Comment body",
      },
      {
        entity_type: "issue_body",
        entity_id: "issue_test",
        revision_no: 1,
        reason: "migration_snapshot",
        snapshot_body: "Issue body",
      },
    ]);
    upgradeDb.close();
  });

  it("enforces canonical ledger foreign keys", () => {
    expect(() => {
      db.prepare(
        `INSERT INTO ledger_comments (
          id, issue_id, body, author_actor_type, author_display, source, created_at
        ) VALUES ('com_missing', 'issue_missing', 'bad', 'system', '', 'system', 1)`,
      ).run();
    }).toThrow();
  });

  it("migrates legacy event IDs and outbox references to SHA-256", () => {
    const project = createProject();
    const store = new LedgerStore(db, { outboxAdapters: ["git_bug"] });
    const issue = createIssue(store, project.project.id);
    const event = store.listEvents({ entity_type: "issue", entity_id: issue.id })[0];
    const outbox = store.listOutbox({ status: "pending" })[0];
    db.pragma("foreign_keys = OFF");
    db.prepare("UPDATE ledger_events SET id = 'evt_00legacy00_00112233445566778899', event_type = 'issue.updated', payload_json = ? WHERE id = ?")
      .run(JSON.stringify({ issue_id: issue.id, patch: { status: "closed", resolution: "merged" } }), event.id);
    db.prepare("UPDATE ledger_outbox SET event_id = 'evt_00legacy00_00112233445566778899' WHERE id = ?")
      .run(outbox.id);
    db.prepare("UPDATE ledger_body_revisions SET event_id = 'evt_00legacy00_00112233445566778899' WHERE event_id = ?")
      .run(event.id);
    db.pragma("foreign_keys = ON");
    db.prepare("UPDATE meta SET value = '60' WHERE key = 'schema_version'").run();

    migrate(db);

    const migrated = store.listEvents({ entity_type: "issue", entity_id: issue.id })[0];
    const migratedOutbox = store.listOutbox({ status: "pending" })[0];
    expect(migrated.id).toMatch(/^[0-9a-f]{64}$/);
    expect(migrated.event_type).toBe("issue.closed");
    expect(JSON.parse(migrated.payload_json)).toMatchObject({
      legacy_event_id: "evt_00legacy00_00112233445566778899",
    });
    expect(migratedOutbox.event_id).toBe(migrated.id);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });
});

describe("ledger IDs and project identity", () => {
  it("generates prefixed chronological IDs without path-derived material", () => {
    const first = createLedgerId("issue", {
      now: 1000,
      random: Buffer.from("11111111111111111111", "hex"),
    });
    const second = createLedgerId("issue", {
      now: 1001,
      random: Buffer.from("22222222222222222222", "hex"),
    });

    expect(first).toMatch(/^issue_[0-9a-z]{10}_[0-9a-f]{20}$/);
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

describe("ledger issue heads", () => {
  it("changes the digest when an issue comment is added", () => {
    const project = createProject();
    const store = new LedgerStore(db);
    const issue = createIssue(store, project.project.id, "Digest target");
    const before = getLedgerIssueHead(db, issue.id);

    store.addComment(issue.id, {
      body: "New digest-affecting comment",
      actor_type: "agent",
      author_display: "Codex",
      source: "mandible",
      created_at: (before.last_event_at ?? Date.now()) + 1,
    });

    const after = getLedgerIssueHead(db, issue.id);
    expect(before.short_id).toBe(issue.short_id);
    expect(before.digest).not.toBe(after.digest);
    expect(after.last_event_kind).toBe("comment.created");
    expect(after.last_event_at).not.toBeNull();
  });

  it("changes the digest when an issue checkpoint is added", () => {
    const project = createProject();
    const store = new LedgerStore(db);
    const issue = createIssue(store, project.project.id, "Checkpoint digest target");
    const before = getLedgerIssueHead(db, issue.id);

    store.addIssueCheckpoint(issue.id, {
      kind: "delegation-manifest",
      payload: [{ issue: issue.short_id, digest: before.digest, branch: "feature/demo", scope: "demo" }],
      actor_type: "agent",
      author_display: "Codex",
      source: "mandible",
      created_at: (before.last_event_at ?? Date.now()) + 1,
    });

    const after = getLedgerIssueHead(db, issue.id);
    expect(before.digest).not.toBe(after.digest);
    expect(after.last_event_kind).toBe("issue.checkpoint.created");
    expect(after.last_event_at).not.toBeNull();
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
    const events = store.listEvents({ entity_type: "issue", entity_id: issue.id });

    expect(issue.id).toMatch(/^[0-9a-f]{64}$/);
    expect(issue.short_id).toBe(issue.id.slice(0, 7));
    expect(store.listAliases(issue.id).map((alias) => alias.alias_kind)).toContain("canonical");
    expect(events).toHaveLength(1);
    expect(events[0].id).toMatch(/^[0-9a-f]{64}$/);
    expect(events[0].id).not.toMatch(/^evt_/);
    const revisions = store.listBodyRevisions({ entity_type: "issue_body", entity_id: issue.id });
    expect(revisions).toHaveLength(1);
    expect(revisions[0]).toMatchObject({
      revision_no: 1,
      reason: "create",
      snapshot_body: "Body",
      event_id: events[0].id,
    });
    expect(JSON.parse(events[0].payload_json)).toMatchObject({ body_revision_id: revisions[0].id });
    expect(store.listOutbox({ status: "pending" })).toHaveLength(0);
    expect(broadcasts).toEqual(["ledger:issue:created", "ledger:event:created"]);
  });

  it("enqueues outbox rows only when an adapter is explicitly configured", () => {
    const project = createProject();
    const store = new LedgerStore(db, { outboxAdapters: ["git_bug"] });

    const issue = createIssue(store, project.project.id);
    const event = store.listEvents({ entity_type: "issue", entity_id: issue.id })[0];
    const outbox = store.listOutbox({ status: "pending" })[0];

    expect(store.listOutbox({ status: "pending" })).toHaveLength(1);
    expect(outbox.event_id).toBe(event.id);
    expect(outbox.event_id).toMatch(/^[0-9a-f]{64}$/);
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
    const events = store.listEvents({ entity_type: "comment", entity_id: comment.id });
    expect(events).toHaveLength(1);
    expect(events[0].id).toMatch(/^[0-9a-f]{64}$/);
    const revisions = store.listBodyRevisions({ entity_type: "comment_body", entity_id: comment.id });
    expect(revisions).toHaveLength(1);
    expect(revisions[0]).toMatchObject({
      revision_no: 1,
      reason: "create",
      snapshot_body: "A comment",
      event_id: events[0].id,
    });
    expect(store.listOutbox({ status: "pending" })).toHaveLength(0);
  });

  it("records body edit revisions, omits body text from event patches, and skips no-op bodies", () => {
    const project = createProject();
    const store = new LedgerStore(db);
    const issue = createIssue(store, project.project.id);

    const updated = store.updateIssue(issue.id, { title: "Renamed", body: "After" });
    const noOp = store.updateIssue(issue.id, { body: "After" });
    const issueEvents = store.listEvents({ entity_type: "issue", entity_id: issue.id });
    const revisions = store.listBodyRevisions({ entity_type: "issue_body", entity_id: issue.id });

    expect(updated.body).toBe("After");
    expect(noOp.body).toBe("After");
    expect(issueEvents.map((event) => event.event_type)).toEqual(["issue.created", "issue.updated"]);
    expect(revisions.map((revision) => revision.snapshot_body)).toEqual(["Body", "After"]);
    expect(revisions[1]).toMatchObject({
      revision_no: 2,
      reason: "edit",
      base_revision_id: revisions[0].id,
      event_id: issueEvents[1].id,
    });
    const payload = JSON.parse(issueEvents[1].payload_json);
    expect(payload).toMatchObject({
      body_revision_id: revisions[1].id,
      changed_fields: ["title", "body"],
      patch: { title: "Renamed" },
    });
    expect(payload.patch).not.toHaveProperty("body");
  });

  it("records comment edit revisions and rejects stale bases", () => {
    const project = createProject();
    const store = new LedgerStore(db);
    const issue = createIssue(store, project.project.id);
    const comment = store.addComment(issue.id, { body: "Before" });
    const base = store.listBodyRevisions({ entity_type: "comment_body", entity_id: comment.id })[0];

    store.updateComment(comment.id, { body: "After" }, { base_body_revision_id: base.id });
    expect(() => {
      store.updateComment(comment.id, { body: "Again" }, { base_body_revision_id: base.id });
    }).toThrow(/stale body revision/);

    const revisions = store.listBodyRevisions({ entity_type: "comment_body", entity_id: comment.id });
    const events = store.listEvents({ entity_type: "comment", entity_id: comment.id });
    expect(revisions.map((revision) => revision.snapshot_body)).toEqual(["Before", "After"]);
    expect(JSON.parse(events[1].payload_json)).toMatchObject({
      body_revision_id: revisions[1].id,
      changed_fields: ["body"],
    });
  });

  it("records issue close and reopen as lifecycle events", () => {
    const project = createProject();
    const broadcasts: string[] = [];
    const store = new LedgerStore(db, {
      broadcaster: (type) => broadcasts.push(type),
    });
    const issue = createIssue(store, project.project.id);

    const closed = store.setIssueStatus(issue.id, "closed", "merged");
    const reopened = store.setIssueStatus(issue.id, "open", null);
    const events = store.listEvents({ entity_type: "issue", entity_id: issue.id });

    expect(closed).toMatchObject({ status: "closed", resolution: "merged" });
    expect(closed.closed_at).not.toBeNull();
    expect(reopened).toMatchObject({ status: "open", resolution: null, closed_at: null });
    expect(events.map((event) => event.event_type)).toEqual([
      "issue.created",
      "issue.closed",
      "issue.reopened",
    ]);
    expect(events.every((event) => /^[0-9a-f]{64}$/.test(event.id))).toBe(true);
    expect(broadcasts).toContain("ledger:issue:closed");
    expect(broadcasts).toContain("ledger:issue:reopened");
  });

  it("does not emit lifecycle events when status and resolution are unchanged", () => {
    const project = createProject();
    const broadcasts: string[] = [];
    const store = new LedgerStore(db, {
      broadcaster: (type) => broadcasts.push(type),
    });
    const issue = createIssue(store, project.project.id);

    store.setIssueStatus(issue.id, "closed", "merged");
    store.setIssueStatus(issue.id, "closed", "merged");

    const events = store.listEvents({ entity_type: "issue", entity_id: issue.id });
    expect(events.map((event) => event.event_type)).toEqual([
      "issue.created",
      "issue.closed",
    ]);
    expect(broadcasts.filter((event) => event === "ledger:issue:closed")).toHaveLength(1);
  });

  it("sets worker status and issue branches with mirrored labels", () => {
    const project = createProject();
    const store = new LedgerStore(db);
    const issue = createIssue(store, project.project.id);

    const updated = store.setWorkerStatus(issue.id, "in_progress");
    const branch = store.addIssueBranch(issue.id, "feature/demo");

    expect(updated.worker_status).toBe("in_progress");
    expect(branch).toMatchObject({
      issue_id: issue.id,
      branch: "feature/demo",
      role: "primary",
    });
    expect(store.listIssueBranches(issue.id)).toMatchObject([
      { branch: "feature/demo", role: "primary" },
    ]);
    expect(store.getIssueDetail(issue.id).labels
      .filter((label) => label.deleted_at === null)
      .map((label) => label.label)
      .sort()).toContain("mandible:status:in_progress");
    expect(store.getIssueDetail(issue.id).labels
      .filter((label) => label.deleted_at === null)
      .map((label) => label.label)
      .sort()).toContain("mandible:branch:feature/demo");
    expect(store.listEvents({ entity_type: "issue", entity_id: issue.id })
      .map((event) => event.event_type)).toEqual([
        "issue.created",
        "issue.worker_status.updated",
        "label.updated",
        "issue.branch.added",
        "label.updated",
      ]);
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

  it("parses explicit typed issue references only", () => {
    const refs = parseIssueReferences([
      "See [issue:abc1234], [issue:mandible/def4567], and [comment:mandible/ghi7890#com_1].",
      "Ignore #feedbee, bare feedbee1, and issue_legacy_alias in normal text.",
      "Inline `020a65b` and commit `7714da1` are plain code/text.",
      "Current commit is f026c06, superseding the earlier 7714da1.",
      "Skip [`abc1234`](#/issues?repo=x&issue=abc1234), `#badcafe`, and ```#deadbee```.",
    ].join("\n"));

    expect(refs.map((ref) => [ref.kind, ref.project ?? "", ref.issueRef, ref.commentRef ?? ""]))
      .toEqual([
        ["issue", "", "abc1234", ""],
        ["issue", "mandible", "def4567", ""],
        ["comment", "mandible", "ghi7890", "com_1"],
      ]);
  });

  it("reconciles text issue references with source-level provenance", () => {
    const project = createProject();
    const store = new LedgerStore(db);
    const target = store.createIssue({
      project_id: project.project.id,
      title: "Target",
      aliases: [{ alias_kind: "git_bug_short", alias: "abcd123" }],
    });
    const source = store.createIssue({
      project_id: project.project.id,
      title: "Source",
      body: "See [issue:abcd123].",
    });

    const relationship = db.prepare(
      `SELECT * FROM ledger_issue_relationships
       WHERE source_issue_id = ? AND target_issue_id = ? AND relationship_type = 'references'`,
    ).get(source.id, target.id) as { id: string; provenance: string; deleted_at: number | null };
    expect(relationship).toMatchObject({ provenance: "derived", deleted_at: null });
    expect(db.prepare(
      `SELECT source_entity_type, source_entity_id, target_issue_id, ref_kind, normalized_ref, deleted_at
       FROM ledger_issue_relationship_sources
       WHERE relationship_id = ?`,
    ).get(relationship.id)).toEqual({
      source_entity_type: "issue_body",
      source_entity_id: source.id,
      target_issue_id: target.id,
      ref_kind: "issue",
      normalized_ref: "abcd123",
      deleted_at: null,
    });
    const eventsAfterCreate = store.listEvents({
      entity_type: "issue_relationship",
      entity_id: relationship.id,
    }).length;
    store.reconcileTextIssueReferences({
      source_issue_id: source.id,
      source_entity_type: "issue_body",
      source_entity_id: source.id,
      body: "See [issue:abcd123].",
    });
    expect(store.listEvents({
      entity_type: "issue_relationship",
      entity_id: relationship.id,
    })).toHaveLength(eventsAfterCreate);

    store.addComment(source.id, {
      body: "Also [issue:abcd123].",
      actor_type: "agent",
      author_display: "Codex",
    });
    store.updateIssue(source.id, { body: "No reference now." });
    expect(db.prepare(
      "SELECT deleted_at FROM ledger_issue_relationships WHERE id = ?",
    ).get(relationship.id)).toEqual({ deleted_at: null });

    const comment = store.getIssueDetail(source.id).comments[0];
    store.reconcileTextIssueReferences({
      source_issue_id: source.id,
      source_entity_type: "comment",
      source_entity_id: comment.id,
      body: "Comment edited away.",
    });
    const tombstoned = db.prepare(
      "SELECT deleted_at FROM ledger_issue_relationships WHERE id = ?",
    ).get(relationship.id) as { deleted_at: number | null };
    expect(tombstoned.deleted_at).not.toBeNull();
    expect(store.listEvents({ entity_type: "issue_relationship", entity_id: relationship.id })
      .map((event) => event.event_type)).toContain("relationship.deleted");
  });

  it("backfills issue references with repo, issue, and date scopes idempotently", () => {
    const project = createProject();
    const store = new LedgerStore(db);
    const target = store.createIssue({
      project_id: project.project.id,
      title: "Target",
      aliases: [{ alias_kind: "git_bug_short", alias: "beef123" }],
    });
    const source = store.createIssue({
      project_id: project.project.id,
      title: "Source",
      body: "Initially empty",
    });
    const skipped = store.createIssue({
      project_id: project.project.id,
      title: "Skipped",
      body: `See [issue:${target.short_id}].`,
    });
    db.prepare("DELETE FROM ledger_issue_relationship_sources").run();
    db.prepare("DELETE FROM ledger_issue_relationships WHERE relationship_type = 'references'").run();
    db.prepare("DELETE FROM ledger_events WHERE entity_type = 'issue_relationship'").run();
    db.prepare("UPDATE ledger_issues SET body = ?, updated_at = ? WHERE id = ?")
      .run("See [issue:beef123].", 2000, source.id);
    db.prepare("UPDATE ledger_issues SET updated_at = ? WHERE id = ?").run(1000, skipped.id);

    const first = runIssueReferenceBackfill(db, {
      project: project.project.display_name,
      issue: source.short_id,
      since: 1500,
    });
    const second = runIssueReferenceBackfill(db, {
      project: project.project.display_name,
      issue: source.short_id,
      since: 1500,
    });

    expect(first.processed).toEqual({ issue_bodies: 1, comments: 0 });
    expect(first.delta).toMatchObject({
      relationship_sources: 1,
      active_sources: 1,
      derived_refs: 1,
      events: 1,
    });
    expect(second.delta).toMatchObject({
      relationship_sources: 0,
      active_sources: 0,
      derived_refs: 0,
      events: 0,
    });
    expect(db.prepare(
      `SELECT source_issue_id, target_issue_id
       FROM ledger_issue_relationship_sources
       WHERE deleted_at IS NULL`,
    ).all()).toEqual([{ source_issue_id: source.id, target_issue_id: target.id }]);
  });

  it("does not remove manual relationships when derived text sources disappear", () => {
    const project = createProject();
    const store = new LedgerStore(db);
    const target = createIssue(store, project.project.id, "Manual target");
    const source = store.createIssue({
      project_id: project.project.id,
      title: "Manual source",
      body: "No refs yet.",
    });
    const relationship = store.upsertIssueRelationship({
      source_issue_id: source.id,
      target_issue_id: target.id,
      relationship_type: "references",
      provenance: "manual",
    });

    store.updateIssue(source.id, { body: `See [issue:${target.short_id}].` });
    store.updateIssue(source.id, { body: "Removed derived ref." });

    expect(db.prepare(
      "SELECT provenance, deleted_at FROM ledger_issue_relationships WHERE id = ?",
    ).get(relationship.id)).toEqual({ provenance: "manual", deleted_at: null });
    const sources = db.prepare(
      "SELECT deleted_at FROM ledger_issue_relationship_sources WHERE relationship_id = ?",
    ).all(relationship.id) as Array<{ deleted_at: number | null }>;
    expect(sources).toHaveLength(1);
    expect(sources[0].deleted_at).not.toBeNull();
  });
});

describe("ledger backup contract", () => {
  it("lists every non-reproducible ledger table for backup tooling", () => {
    const tableNames = db.prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'table'
         AND (name LIKE 'ledger_%' OR name = 'issue_branches')`,
    ).all() as Array<{ name: string }>;
    const backedUp = new Set<string>(LEDGER_BACKUP_TABLES);

    for (const table of tableNames) {
      expect(backedUp.has(table.name)).toBe(true);
    }
  });
});
