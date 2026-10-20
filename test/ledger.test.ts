import SqliteDatabase from "../src/sqlite.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CURRENT_SCHEMA_VERSION, migrate, openDb, type Db } from "../src/db.js";
import { systemAction } from "../src/identity/resolver.js";
import {
  buildMetadataBackupSql,
  LEDGER_BACKUP_TABLES,
  METADATA_BACKUP_TABLES,
  REPRODUCIBLE_OR_RUNTIME_TABLES,
} from "../src/ledger/backup.js";
import { createLedgerId } from "../src/ledger/ids.js";
import { buildLedgerIssueDetailProjection } from "../src/ledger/issue-detail.js";
import { getLedgerIssueHead } from "../src/ledger/issue-heads.js";
import { runIssueReferenceBackfill } from "../src/ledger/issue-reference-backfill.js";
import { parseIssueReferences } from "../src/ledger/issue-xrefs.js";
import { normalizeRemoteIdentity, resolveProjectForCheckout } from "../src/ledger/projects.js";
import { LedgerStore } from "../src/ledger/store.js";
import type { LedgerEventSource } from "../src/ledger/types.js";
import { createUser } from "../src/users/store.js";

let tempDir = "";
let dbPath = "";
let db: Db;
const SYSTEM_ACTOR = { attribution: systemAction() };

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
    ...SYSTEM_ACTOR,
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
      "ledger_change_feed_state",
      "ledger_change_log",
      "ledger_comments",
      "ledger_commit_issue_links",
      "ledger_events",
      "ledger_issue_aliases",
      "ledger_issue_checkpoints",
      "ledger_issue_relationship_sources",
      "ledger_issue_relationships",
      "ledger_issues",
      "ledger_labels",
      "ledger_operational_link_mismatches",
      "ledger_operational_link_reports",
      "ledger_project_checkouts",
      "ledger_projects",
      "ledger_reconciliation_mismatches",
      "ledger_reconciliation_reports",
      "ledger_relationship_edges",
      "ledger_session_issue_links",
      "ledger_work_unit_issue_links",
    ]);

    const indexes = db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_ledger_%'",
    ).all() as Array<{ name: string }>;
    expect(indexes.map((row) => row.name)).toContain("idx_ledger_issues_project_status_updated");
    expect(indexes.map((row) => row.name)).toContain("idx_ledger_body_revisions_entity");
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
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
      ...SYSTEM_ACTOR,
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
      ...SYSTEM_ACTOR,
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
  it("can compute an issue head at a historical event cutoff", () => {
    const project = createProject();
    const store = new LedgerStore(db);
    const issue = createIssue(store, project.project.id, "Historical digest target");
    const created = getLedgerIssueHead(db, issue.id);

    store.addIssueCheckpoint(issue.id, {
      ...SYSTEM_ACTOR,
      kind: "delegation-manifest",
      payload: [],
      actor_type: "agent",
      author_display: "Codex",
      source: "mandible",
      created_at: (created.last_event_at ?? Date.now()) + 1,
    });
    const checkpointHead = getLedgerIssueHead(db, issue.id);

    store.addComment(issue.id, {
      ...SYSTEM_ACTOR,
      body: "Later umbrella coordination comment",
      actor_type: "agent",
      author_display: "Codex",
      source: "mandible",
      created_at: (checkpointHead.last_event_at ?? Date.now()) + 1,
    });
    const current = getLedgerIssueHead(db, issue.id);
    const historical = getLedgerIssueHead(db, issue.id, { at: checkpointHead.last_event_at ?? 0 });

    expect(historical.digest).toBe(checkpointHead.digest);
    expect(historical.digest).not.toBe(current.digest);
    expect(current.last_event_kind).toBe("comment.created");
  });

  it("changes both endpoint digests when a structured relationship edge is linked and unlinked", () => {
    const project = createProject();
    const store = new LedgerStore(db);
    const source = createIssue(store, project.project.id, "Head source");
    const target = createIssue(store, project.project.id, "Tail target");
    const unrelated = createIssue(store, project.project.id, "Idle unrelated");
    const beforeSource = getLedgerIssueHead(db, source.id);
    const beforeTarget = getLedgerIssueHead(db, target.id);
    const beforeUnrelated = getLedgerIssueHead(db, unrelated.id);

    store.linkRelationshipEdges({
      actor: SYSTEM_ACTOR,
      source_entity: { entity_type: "issue", entity_id: source.id },
      target_entities: [{ entity_type: "issue", entity_id: target.id }],
      link_type: "references",
      created_at: Math.max(beforeSource.last_event_at ?? 0, beforeTarget.last_event_at ?? 0) + 1,
    });

    const linkedSource = getLedgerIssueHead(db, source.id);
    const linkedTarget = getLedgerIssueHead(db, target.id);
    expect(linkedSource.digest).not.toBe(beforeSource.digest);
    expect(linkedTarget.digest).not.toBe(beforeTarget.digest);
    expect(linkedSource.last_event_kind).toBe("relationship.added");
    expect(linkedTarget.last_event_kind).toBe("relationship.added");
    expect(getLedgerIssueHead(db, unrelated.id).digest).toBe(beforeUnrelated.digest);

    store.unlinkRelationshipEdges({
      actor: SYSTEM_ACTOR,
      source_entity: { entity_type: "issue", entity_id: source.id },
      target_entities: [{ entity_type: "issue", entity_id: target.id }],
      link_type: "references",
      occurred_at: (linkedSource.last_event_at ?? 0) + 1,
    });

    const unlinkedSource = getLedgerIssueHead(db, source.id);
    const unlinkedTarget = getLedgerIssueHead(db, target.id);
    expect(unlinkedSource.digest).not.toBe(linkedSource.digest);
    expect(unlinkedTarget.digest).not.toBe(linkedTarget.digest);
    expect(unlinkedSource.last_event_kind).toBe("relationship.removed");
    expect(unlinkedTarget.last_event_kind).toBe("relationship.removed");
    expect(getLedgerIssueHead(db, unrelated.id).digest).toBe(beforeUnrelated.digest);
  });

  it("changes both endpoint digests when a stored issue relationship changes", () => {
    const project = createProject();
    const store = new LedgerStore(db);
    const source = createIssue(store, project.project.id, "Stored relationship source");
    const target = createIssue(store, project.project.id, "Linked relationship target");
    const beforeSource = getLedgerIssueHead(db, source.id);
    const beforeTarget = getLedgerIssueHead(db, target.id);

    store.upsertIssueRelationship({
      actor: SYSTEM_ACTOR,
      source_issue_id: source.id,
      target_issue_id: target.id,
      relationship_type: "blocks",
      provenance: "manual",
      created_at: Math.max(beforeSource.last_event_at ?? 0, beforeTarget.last_event_at ?? 0) + 1,
    });

    const afterSource = getLedgerIssueHead(db, source.id);
    const afterTarget = getLedgerIssueHead(db, target.id);
    expect(afterSource.digest).not.toBe(beforeSource.digest);
    expect(afterTarget.digest).not.toBe(beforeTarget.digest);
    expect(afterSource.last_event_kind).toBe("relationship.upserted");
    expect(afterTarget.last_event_kind).toBe("relationship.upserted");
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
    expect(broadcasts).toEqual(["ledger:issue:created", "ledger:event:created"]);
  });

  it("writes comments with events", () => {
    const project = createProject();
    const store = new LedgerStore(db);
    const issue = createIssue(store, project.project.id);

    const comment = store.addComment(issue.id, {
      ...SYSTEM_ACTOR,
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
  });

  it("records body edit revisions, omits body text from event patches, and skips no-op bodies", () => {
    const project = createProject();
    const store = new LedgerStore(db);
    const issue = createIssue(store, project.project.id);

    const updated = store.updateIssue(issue.id, { title: "Renamed", body: "After" }, SYSTEM_ACTOR);
    const noOp = store.updateIssue(issue.id, { body: "After" }, SYSTEM_ACTOR);
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
    const comment = store.addComment(issue.id, { body: "Before", ...SYSTEM_ACTOR });
    const base = store.listBodyRevisions({ entity_type: "comment_body", entity_id: comment.id })[0];

    store.updateComment(comment.id, { body: "After" }, {
      base_body_revision_id: base.id,
      ...SYSTEM_ACTOR,
    });
    expect(() => {
      store.updateComment(comment.id, { body: "Again" }, {
        base_body_revision_id: base.id,
        ...SYSTEM_ACTOR,
      });
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

    const closed = store.setIssueStatus(issue.id, "closed", "delivered", SYSTEM_ACTOR);
    const reopened = store.setIssueStatus(issue.id, "open", null, SYSTEM_ACTOR);
    const events = store.listEvents({ entity_type: "issue", entity_id: issue.id });

    expect(closed).toMatchObject({ status: "closed", resolution: "delivered" });
    expect(closed.closed_at).not.toBeNull();
    expect(reopened).toMatchObject({ status: "open", resolution: null, closed_at: null });
    expect(events.map((event) => event.event_type)).toEqual([
      "issue.created",
      "issue.closed",
      "issue.reopened",
    ]);
    expect(JSON.parse(events[1].payload_json)).toMatchObject({
      previous_resolution: null,
      resolution: "delivered",
    });
    expect(JSON.parse(events[2].payload_json)).toMatchObject({
      previous_resolution: "delivered",
      resolution: null,
    });
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

    store.setIssueStatus(issue.id, "closed", "delivered", SYSTEM_ACTOR);
    store.setIssueStatus(issue.id, "closed", "delivered", SYSTEM_ACTOR);

    const events = store.listEvents({ entity_type: "issue", entity_id: issue.id });
    expect(events.map((event) => event.event_type)).toEqual([
      "issue.created",
      "issue.closed",
    ]);
    expect(broadcasts.filter((event) => event === "ledger:issue:closed")).toHaveLength(1);
  });

  it("sets worker status and issue branches without metadata-label mirrors", () => {
    const project = createProject();
    const store = new LedgerStore(db);
    const issue = createIssue(store, project.project.id);

    expect(() => store.setWorkerStatus(issue.id, "in_progress" as never, SYSTEM_ACTOR))
      .toThrow(/in_progress is derived from an open or committed work unit/);
    const updated = store.setWorkerStatus(issue.id, "blocked", SYSTEM_ACTOR);
    const branch = store.addIssueBranch(issue.id, "feature/demo", "primary", SYSTEM_ACTOR);

    expect(updated.worker_status).toBe("blocked");
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
      .map((label) => label.label))
      .not.toEqual(expect.arrayContaining([
        "mandible:status:blocked",
        "mandible:branch:feature/demo",
      ]));
    expect(store.listEvents({ entity_type: "issue", entity_id: issue.id })
      .map((event) => event.event_type)).toEqual([
        "issue.created",
        "issue.worker_status.updated",
        "issue.branch.added",
      ]);
  });

  it("sets labels idempotently and records only state-changing events", () => {
    const project = createProject();
    const store = new LedgerStore(db);
    const issue = createIssue(store, project.project.id);

    expect(store.setLabel(issue.id, "umbrella", true, "mandible", SYSTEM_ACTOR).changed).toBe(true);
    expect(store.setLabel(issue.id, "umbrella", true, "mandible", SYSTEM_ACTOR).changed).toBe(false);
    expect(store.setLabel(issue.id, "umbrella", false, "mandible", SYSTEM_ACTOR).changed).toBe(true);

    const events = store
      .listEvents({ entity_type: "issue", entity_id: issue.id })
      .filter((event) => event.event_type === "label.updated");
    expect(events).toHaveLength(2);
  });

  it("resolves canonical IDs, aliases, prefixes, not-found, and ambiguity", () => {
    const project = createProject();
    const store = new LedgerStore(db);
    const first = store.createIssue({
      ...SYSTEM_ACTOR,
      project_id: project.project.id,
      title: "First",
      aliases: [{ alias_kind: "git_bug_short", alias: "abcd111" }],
    });
    store.createIssue({
      ...SYSTEM_ACTOR,
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

  it("upserts issue relationships", () => {
    const project = createProject();
    const store = new LedgerStore(db);
    const parent = createIssue(store, project.project.id, "Parent");
    const child = createIssue(store, project.project.id, "Child");

    const relationship = store.upsertIssueRelationship({
      actor: SYSTEM_ACTOR,
      source_issue_id: parent.id,
      target_issue_id: child.id,
      relationship_type: "parent_child",
      provenance: "manual",
      metadata: { order: 1 },
    });
    expect(relationship.id).toMatch(/^rel_/);
    expect(relationship.relationship_type).toBe("parent_child");
  });

  it("parses explicit typed issue references only", () => {
    const refs = parseIssueReferences([
      "See [issue:abc1234], [issue:mandible/def4567], and [comment:mandible/ghi7890#com_1].",
      "Comment ordinals: [issue:abc1234#3], [issue:mandible/def4567#0]; not [issue:abc1234#last].",
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
        ["comment", "", "abc1234", "3"],
        ["issue", "mandible", "def4567", ""],
      ]);
  });

  it("records comment-ordinal issue refs on the same references relationship", () => {
    const project = createProject();
    const store = new LedgerStore(db);
    const target = createIssue(store, project.project.id, "Target");
    const source = createIssue(store, project.project.id, "Source");
    const targetRef = target.short_id;
    store.addComment(source.id, {
      ...SYSTEM_ACTOR,
      body: `See [issue:${targetRef}], [issue:${targetRef}#2], and [issue:${targetRef}#0].`,
    });

    const relationships = db.prepare(
      `SELECT id FROM ledger_issue_relationships
       WHERE source_issue_id = ? AND target_issue_id = ? AND relationship_type = 'references'
         AND deleted_at IS NULL`,
    ).all(source.id, target.id) as Array<{ id: string }>;
    expect(relationships).toHaveLength(1);
    const sources = db.prepare(
      `SELECT ref_kind, normalized_ref, json_extract(metadata_json, '$.comment_ref') AS comment_ref
       FROM ledger_issue_relationship_sources
       WHERE relationship_id = ? AND deleted_at IS NULL
       ORDER BY normalized_ref`,
    ).all(relationships[0].id);
    expect(sources).toEqual([
      { ref_kind: "issue", normalized_ref: targetRef, comment_ref: null },
      { ref_kind: "issue", normalized_ref: `${targetRef}#0`, comment_ref: null },
      { ref_kind: "comment", normalized_ref: `${targetRef}#2`, comment_ref: "2" },
    ]);
  });

  it("reconciles text issue references with source-level provenance", () => {
    const project = createProject();
    const store = new LedgerStore(db);
    const target = store.createIssue({
      ...SYSTEM_ACTOR,
      project_id: project.project.id,
      title: "Target",
      aliases: [{ alias_kind: "git_bug_short", alias: "abcd123" }],
    });
    const source = store.createIssue({
      ...SYSTEM_ACTOR,
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
      actor: SYSTEM_ACTOR,
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
      ...SYSTEM_ACTOR,
      body: "Also [issue:abcd123].",
      actor_type: "agent",
      author_display: "Codex",
    });
    store.updateIssue(source.id, { body: "No reference now." }, SYSTEM_ACTOR);
    expect(db.prepare(
      "SELECT deleted_at FROM ledger_issue_relationships WHERE id = ?",
    ).get(relationship.id)).toEqual({ deleted_at: null });

    const comment = store.getIssueDetail(source.id).comments[0];
    store.reconcileTextIssueReferences({
      actor: SYSTEM_ACTOR,
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
      ...SYSTEM_ACTOR,
      project_id: project.project.id,
      title: "Target",
      aliases: [{ alias_kind: "git_bug_short", alias: "beef123" }],
    });
    const source = store.createIssue({
      ...SYSTEM_ACTOR,
      project_id: project.project.id,
      title: "Source",
      body: "Initially empty",
    });
    const skipped = store.createIssue({
      ...SYSTEM_ACTOR,
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
    }, { actor: SYSTEM_ACTOR });
    const second = runIssueReferenceBackfill(db, {
      project: project.project.display_name,
      issue: source.short_id,
      since: 1500,
    }, { actor: SYSTEM_ACTOR });

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
      ...SYSTEM_ACTOR,
      project_id: project.project.id,
      title: "Manual source",
      body: "No refs yet.",
    });
    const relationship = store.upsertIssueRelationship({
      actor: SYSTEM_ACTOR,
      source_issue_id: source.id,
      target_issue_id: target.id,
      relationship_type: "references",
      provenance: "manual",
    });

    store.updateIssue(source.id, { body: `See [issue:${target.short_id}].` }, SYSTEM_ACTOR);
    store.updateIssue(source.id, { body: "Removed derived ref." }, SYSTEM_ACTOR);

    expect(db.prepare(
      "SELECT provenance, deleted_at FROM ledger_issue_relationships WHERE id = ?",
    ).get(relationship.id)).toEqual({ provenance: "manual", deleted_at: null });
    const sources = db.prepare(
      "SELECT deleted_at FROM ledger_issue_relationship_sources WHERE relationship_id = ?",
    ).all(relationship.id) as Array<{ deleted_at: number | null }>;
    expect(sources).toHaveLength(1);
    expect(sources[0].deleted_at).not.toBeNull();
  });

  it("creates structured relationship edges atomically with one action id", () => {
    const project = createProject();
    const store = new LedgerStore(db);
    const source = createIssue(store, project.project.id, "Src edge");
    const first = createIssue(store, project.project.id, "One edge");
    const second = createIssue(store, project.project.id, "Two edge");

    const result = store.linkRelationshipEdges({
      source_entity: { entity_type: "issue", entity_id: source.id },
      target_entities: [
        { entity_type: "issue", entity_id: first.id },
        { entity_type: "issue", entity_id: second.id },
      ],
      link_type: "references",
      note: "coordination context",
      actor: { actor_type: "agent", actor_id: "codex", ...SYSTEM_ACTOR },
    });

    expect(result.edges).toHaveLength(2);
    expect(new Set(result.edges.map((edge) => edge.action_id))).toEqual(new Set([result.action_id]));
    expect(result.edges.map((edge) => edge.note)).toEqual(["coordination context", "coordination context"]);
    expect(result.edges.map((edge) => edge.provenance)).toEqual(["manual", "manual"]);
    expect(db.prepare(
      "SELECT COUNT(*) AS count FROM ledger_issue_relationship_sources",
    ).get()).toEqual({ count: 0 });
    const events = db.prepare(
      "SELECT event_type, payload_json FROM ledger_events WHERE entity_type = 'relationship_edge' ORDER BY occurred_at",
    ).all() as Array<{ event_type: string; payload_json: string }>;
    expect(events.map((event) => event.event_type)).toEqual(["relationship.added", "relationship.added"]);
    expect(events.map((event) => JSON.parse(event.payload_json).action_id))
      .toEqual([result.action_id, result.action_id]);
    expect(buildLedgerIssueDetailProjection(db, source.id).timeline)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({
          kind: "event",
          event_type: "relationship.added",
          payload: expect.objectContaining({ action_id: result.action_id }),
        }),
      ]));
  });

  it("unlinks structured relationship edges with tombstones and removed events", () => {
    const project = createProject();
    const store = new LedgerStore(db);
    const source = createIssue(store, project.project.id, "Src unlink");
    const target = createIssue(store, project.project.id, "Tgt unlink");
    const linked = store.linkRelationshipEdges({
      actor: SYSTEM_ACTOR,
      source_entity: { entity_type: "issue", entity_id: source.id },
      target_entities: [{ entity_type: "issue", entity_id: target.id }],
    });

    const unlinked = store.unlinkRelationshipEdges({
      actor: SYSTEM_ACTOR,
      source_entity: { entity_type: "issue", entity_id: source.id },
      target_entities: [{ entity_type: "issue", entity_id: target.id }],
    });

    expect(unlinked.edges).toHaveLength(1);
    expect(unlinked.edges[0].id).toBe(linked.edges[0].id);
    expect(unlinked.edges[0].deleted_at).not.toBeNull();
    expect(store.listRelationshipEdges({ source_issue_id: source.id })).toEqual([]);
    expect(store.listRelationshipEdges({ source_issue_id: source.id, include_deleted: true }))
      .toHaveLength(1);
    expect(store.listEvents({ entity_type: "relationship_edge", entity_id: linked.edges[0].id })
      .map((event) => event.event_type)).toEqual(["relationship.added", "relationship.removed"]);
  });

  it("keeps comment-target edges anchored to their issue and can degrade tombstoned comments", () => {
    const project = createProject();
    const store = new LedgerStore(db);
    const source = createIssue(store, project.project.id, "Src comment");
    const target = createIssue(store, project.project.id, "Tgt comment");
    const comment = store.addComment(target.id, {
      ...SYSTEM_ACTOR,
      body: "Precise anchor",
      actor_type: "agent",
      author_display: "Codex",
    });

    const linked = store.linkRelationshipEdges({
      actor: SYSTEM_ACTOR,
      source_entity: { entity_type: "issue", entity_id: source.id },
      target_entities: [{ entity_type: "comment", entity_id: comment.id }],
    });
    expect(linked.edges[0]).toMatchObject({
      target_entity_type: "comment",
      target_entity_id: comment.id,
      target_issue_id: target.id,
    });

    db.prepare("UPDATE ledger_comments SET deleted_at = ? WHERE id = ?").run(Date.now(), comment.id);
    const degraded = store.degradeCommentTargetRelationshipEdges(comment.id, {
      actor: { actor_type: "system", ...SYSTEM_ACTOR },
      occurred_at: Date.now(),
    });

    expect(degraded).toHaveLength(1);
    expect(degraded[0]).toMatchObject({
      target_entity_type: "issue",
      target_entity_id: target.id,
      target_issue_id: target.id,
      deleted_at: null,
    });
    expect(JSON.parse(degraded[0].metadata_json)).toMatchObject({
      degraded_from_target_comment_id: comment.id,
    });
  });
});

describe("ledger backup contract", () => {
  it("keeps the legacy ledger table list inside the metadata backup set", () => {
    expect(METADATA_BACKUP_TABLES).toEqual(expect.arrayContaining(LEDGER_BACKUP_TABLES));
  });

  it("round-trips exact durable user settings after their user owners", () => {
    const owner = createUser(db, {
      slug: "settings-owner",
      kind: "human",
      display_name: "Settings Owner",
    }, 100);
    const peer = createUser(db, {
      slug: "settings-peer",
      kind: "human",
      display_name: "Settings Peer",
    }, 200);
    const expected = [
      {
        user_id: owner.id,
        key: "app_rail_order",
        value: '["spaces","tasks","briefings"]',
        revision: 7,
        updated_at: 1_787_200_001_001,
      },
      {
        user_id: owner.id,
        key: "ui_font_face",
        value: "space-grotesk",
        revision: 3,
        updated_at: 1_787_200_001_002,
      },
      {
        user_id: owner.id,
        key: "detail_font_size",
        value: "17",
        revision: 11,
        updated_at: 1_787_200_001_003,
      },
      {
        user_id: peer.id,
        key: "ui_font_face",
        value: "system-ui",
        revision: 2,
        updated_at: 1_787_200_002_001,
      },
      {
        user_id: peer.id,
        key: "detail_font_face",
        value: "space-grotesk",
        revision: 5,
        updated_at: 1_787_200_002_002,
      },
      {
        user_id: peer.id,
        key: "ui_font_size",
        value: "13",
        revision: 9,
        updated_at: 1_787_200_002_003,
      },
    ];
    const insert = db.prepare(
      `INSERT INTO user_settings (user_id, key, value, revision, updated_at)
       VALUES (@user_id, @key, @value, @revision, @updated_at)`,
    );
    for (const row of expected) insert.run(row);

    expect(METADATA_BACKUP_TABLES).toContain("user_settings");
    expect(METADATA_BACKUP_TABLES.indexOf("user_settings"))
      .toBeGreaterThan(METADATA_BACKUP_TABLES.indexOf("users"));

    const backup = buildMetadataBackupSql(db);
    expect(backup.indexOf("-- Table: user_settings"))
      .toBeGreaterThan(backup.indexOf("-- Table: users"));

    const restored = new SqliteDatabase(":memory:");
    try {
      restored.exec(backup);
      const rows = restored.prepare(
        `SELECT user_id, key, value, revision, updated_at
           FROM user_settings
          ORDER BY user_id, key`,
      ).all();
      expect(rows).toEqual([...expected].sort((a, b) =>
        a.user_id.localeCompare(b.user_id) || a.key.localeCompare(b.key)));
      expect(restored.pragma("foreign_key_check")).toEqual([]);
    } finally {
      restored.close();
    }
  });
});
