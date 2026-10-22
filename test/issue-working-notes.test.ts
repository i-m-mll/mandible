import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openDb, type Db } from "../src/db.js";
import { buildLedgerIssueDetailProjection } from "../src/ledger/issue-detail.js";
import { LedgerStore } from "../src/ledger/store.js";
import { systemAction } from "../src/identity/resolver.js";
import { createLedgerProject, createLedgerIssue } from "./helpers/ledger-fixtures.js";

const ACTOR = { actor_type: "system" as const, author_display: "System", attribution: systemAction() };
let tempDir = "";
let db: Db;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-working-notes-"));
  db = openDb(path.join(tempDir, "mandible.db"));
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

