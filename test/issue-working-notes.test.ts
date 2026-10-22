import SqliteDatabase from "../src/sqlite.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDb, type Db } from "../src/db.js";
import { buildLedgerIssueDetailProjection } from "../src/ledger/issue-detail.js";
import { LedgerStore } from "../src/ledger/store.js";
import { systemAction } from "../src/identity/resolver.js";
import { createLedgerProject, createLedgerIssue, migratedMemoryDb } from "./helpers/ledger-fixtures.js";

const ACTOR = { actor_type: "system" as const, author_display: "System", attribution: systemAction() };
let tempDir = "";
let db: Db;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-working-notes-"));
  db = migratedMemoryDb();
});

afterEach(() => {
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("issue working notes", () => {
  it("records note edits and clears as immutable revisions with exact events", () => {
    const project = createLedgerProject(db, path.join(tempDir, "repo"), { mkdir: true });
    const store = new LedgerStore(db);
    const issue = createLedgerIssue(db, { project_id: project.project.id, kind: "experiment", store });

    store.updateIssue(issue.id, { work_notes: "first" }, {
      ...ACTOR,
      base_work_notes_revision_id: null,
      base_work_notes_revision_provided: true,
    });
    const firstRevision = store.listBodyRevisions({ entity_type: "issue_work_notes", entity_id: issue.id })[0];
    expect(firstRevision.snapshot_body).toBe("first");
    expect(() => store.updateIssue(issue.id, { work_notes: "stale" }, {
      ...ACTOR,
      base_work_notes_revision_id: null,
      base_work_notes_revision_provided: true,
    })).toThrowError("stale body revision");

    store.updateIssue(issue.id, { work_notes: "" }, {
      ...ACTOR,
      base_work_notes_revision_id: firstRevision.id,
      base_work_notes_revision_provided: true,
    });
    const revisions = store.listBodyRevisions({ entity_type: "issue_work_notes", entity_id: issue.id });
    expect(revisions.map((revision) => revision.snapshot_body)).toEqual(["first", ""]);
    const events = store.listEvents({ entity_type: "issue", entity_id: issue.id })
      .filter((event) => event.event_type === "issue.work_notes_updated");
    expect(events.map((event) => JSON.parse(event.payload_json).work_notes)).toEqual(["first", ""]);
    const detail = buildLedgerIssueDetailProjection(db, issue.id);
    expect(detail.work_notes).toBe("");
    expect(detail.work_notes_revision).toBe(revisions[1].id);
    expect(detail.timeline.filter((entry) => entry.event_type === "issue.work_notes_updated")).toHaveLength(2);
  });

  it("retains scalar and lifecycle history when notes change in the same write", () => {
    const project = createLedgerProject(db, path.join(tempDir, "repo"), { mkdir: true });
    const store = new LedgerStore(db);
    const issue = createLedgerIssue(db, { project_id: project.project.id, kind: "experiment", store });

    expect(() => store.setIssueStatus(issue.id, "closed", null, ACTOR))
      .toThrow("closed issues require a resolution");
    expect(() => store.setIssueStatus(issue.id, "open", "delivered", ACTOR))
      .toThrow("open issues cannot have a resolution");

    store.updateIssue(issue.id, { work_notes: "note", title: "Renamed" }, {
      ...ACTOR,
      base_work_notes_revision_id: null,
      base_work_notes_revision_provided: true,
    });
    expect(store.listEvents({ entity_type: "issue", entity_id: issue.id })
      .some((event) => event.event_type === "issue.updated" && JSON.parse(event.payload_json).patch.title === "Renamed"))
      .toBe(true);

    const closed = store.setIssueStatus(issue.id, "closed", "delivered", ACTOR);
    expect(closed.resolution).toBe("delivered");
    store.applyImportedIssuePatch(issue.id, { status: "open", work_notes: "reopened note" }, "import", ACTOR);
    const reopened = store.listEvents({ entity_type: "issue", entity_id: issue.id })
      .find((event) => event.event_type === "issue.reopened");
    expect(reopened).toBeDefined();
    expect(JSON.parse(reopened!.payload_json)).toMatchObject({
      previous_resolution: "delivered",
      resolution: null,
    });
    expect(store.getIssue(issue.id)).toMatchObject({ status: "open", resolution: null, work_notes: "reopened note" });
  });

  it("derives dependency warnings only from incoming blocks edges", () => {
    const project = createLedgerProject(db, path.join(tempDir, "repo"), { mkdir: true });
    const store = new LedgerStore(db);
    const blocker = createLedgerIssue(db, { project_id: project.project.id, title: "Blocker", kind: "bug", store });
    const target = createLedgerIssue(db, { project_id: project.project.id, title: "Target", kind: "feature", store });
    store.upsertIssueRelationship({
      source_issue_id: blocker.id,
      target_issue_id: target.id,
      relationship_type: "blocks",
      actor: ACTOR,
    });

    expect(buildLedgerIssueDetailProjection(db, target.id).dependencies.map((dependency) => dependency.id))
      .toEqual([blocker.id]);
    expect(buildLedgerIssueDetailProjection(db, target.id).dependency_warning).toBe(true);
    store.setIssueStatus(blocker.id, "closed", "delivered", ACTOR);
    expect(buildLedgerIssueDetailProjection(db, target.id).dependency_warning).toBe(false);
  });
});

describe("working-notes migration", () => {
  it("preserves retired kind and label provenance while moving kinds to unknown", () => {
    const fixture = fs.readFileSync(
      path.join(process.cwd(), "test", "fixtures", "schema-v158.sql"),
      "utf8",
    );
    const dbPath = path.join(tempDir, "legacy.db");
    const legacy = new SqliteDatabase(dbPath);
    legacy.exec(fixture);
    const projectId = "project-working-notes";
    legacy.prepare(`INSERT INTO ledger_projects
      (id, display_name, remote_identity, upstream_identity, namespace_policy, created_at, updated_at)
      VALUES (?, 'Working notes', '', '', 'local', 1, 1)`).run(projectId);
    const insertIssue = legacy.prepare(`INSERT INTO ledger_issues
      (id, short_id, project_id, title, body, status, kind, priority, source, created_at, updated_at)
      VALUES (?, ?, ?, ?, '', 'open', ?, 'unknown', 'mandible', 1, 1)`);
    insertIssue.run("issue-deferred", "def", projectId, "Deferred", "deferred");
    insertIssue.run("issue-task", "task", projectId, "Task", "task");
    insertIssue.run("issue-question", "ques", projectId, "Question", "question");
    insertIssue.run("issue-label", "label", projectId, "Label", "unknown");
    legacy.prepare(`INSERT INTO ledger_issues
      (id, short_id, project_id, title, body, status, resolution, kind, priority, source, created_at, updated_at)
      VALUES (?, ?, ?, ?, '', 'closed', ?, 'feature', 'unknown', 'mandible', 1, 1)`)
      .run("issue-fixed", "fix", projectId, "Fixed", "fixed");
    legacy.prepare(`INSERT INTO ledger_issues
      (id, short_id, project_id, title, body, status, resolution, kind, priority, source, created_at, updated_at)
      VALUES (?, ?, ?, ?, '', 'closed', ?, 'feature', 'unknown', 'mandible', 1, 1)`)
      .run("issue-merged", "mer", projectId, "Merged", "merged");
    legacy.prepare(`INSERT INTO ledger_issues
      (id, short_id, project_id, title, body, status, resolution, kind, priority, source, created_at, updated_at)
      VALUES (?, ?, ?, ?, '', 'closed', ?, 'feature', 'unknown', 'mandible', 1, 1)`)
      .run("issue-obsolete", "obs", projectId, "Obsolete", "obsolete");
    legacy.prepare(`INSERT INTO ledger_labels (issue_id, label, source, created_at)
      VALUES ('issue-deferred', 'deferred', 'mandible', 1),
             ('issue-label', 'deferred', 'mandible', 1)`).run();
    legacy.close();

    const migrated = openDb(dbPath);
    const rows = migrated.prepare(
      "SELECT id, kind, work_notes FROM ledger_issues ORDER BY id",
    ).all();
    expect(rows).toEqual([
      { id: "issue-deferred", kind: "unknown", work_notes: "this issue had kind 'deferred', when 'deferred' was a kind\nthis issue had an active 'deferred' label, when 'deferred' was an active label" },
      { id: "issue-fixed", kind: "feature", work_notes: "" },
      { id: "issue-label", kind: "unknown", work_notes: "this issue had an active 'deferred' label, when 'deferred' was an active label" },
      { id: "issue-merged", kind: "feature", work_notes: "" },
      { id: "issue-obsolete", kind: "feature", work_notes: "" },
      { id: "issue-question", kind: "unknown", work_notes: "" },
      { id: "issue-task", kind: "unknown", work_notes: "" },
    ]);
    expect(migrated.prepare(
      "SELECT id, resolution FROM ledger_issues WHERE id LIKE 'issue-%' AND resolution IS NOT NULL ORDER BY id",
    ).all()).toEqual([
      { id: "issue-fixed", resolution: "delivered" },
      { id: "issue-merged", resolution: "delivered" },
      { id: "issue-obsolete", resolution: "wontfix" },
    ]);
    const retiredEvents = migrated.prepare(
      `SELECT entity_id, payload_json FROM ledger_events
       WHERE event_type = 'issue.updated' AND json_extract(payload_json, '$.migration') = 'resolution_retirement'
       ORDER BY entity_id`,
    ).all() as Array<{ entity_id: string; payload_json: string }>;
    expect(retiredEvents.map((event) => ({
      entity_id: event.entity_id,
      payload: JSON.parse(event.payload_json),
    }))).toEqual([
      expect.objectContaining({
        entity_id: "issue-fixed",
        payload: expect.objectContaining({ previous_resolution: "fixed", replacement_resolution: "delivered" }),
      }),
      expect.objectContaining({
        entity_id: "issue-merged",
        payload: expect.objectContaining({ previous_resolution: "merged", replacement_resolution: "delivered" }),
      }),
      expect.objectContaining({
        entity_id: "issue-obsolete",
        payload: expect.objectContaining({ previous_resolution: "obsolete", replacement_resolution: "wontfix" }),
      }),
    ]);
    expect(migrated.prepare(
      "SELECT issue_id, deleted_at FROM ledger_labels WHERE label = 'deferred' ORDER BY issue_id",
    ).all()).toEqual([
      expect.objectContaining({ issue_id: "issue-deferred" }),
      expect.objectContaining({ issue_id: "issue-label" }),
    ]);
    expect(migrated.pragma("foreign_key_check")).toEqual([]);
    migrated.close();
  });
});
