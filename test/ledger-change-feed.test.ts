import SqliteDatabase from "../src/sqlite.ts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrate, type Db } from "../src/db.js";
import { systemAction } from "../src/identity/resolver.js";
import {
  LEDGER_CHANGE_FEED_SCHEMA,
  LedgerChangeFeedError,
  readLedgerChangeFeed,
} from "../src/ledger/change-feed.js";
import { addProject } from "../src/ledger/project-registry.js";
import { LedgerStore } from "../src/ledger/store.js";
import { registerLedgerChangeRoutes } from "../src/routes/ledger-changes.js";
import { setupOperator } from "../src/users/store.js";
import { authenticatedTestRouter } from "./helpers/authenticated-router.js";

let db: Db;

beforeEach(() => {
  db = new SqliteDatabase(":memory:");
  migrate(db);
});

afterEach(() => db.close());

function cursor(page: Record<string, unknown>): string {
  return page.next_cursor as string;
}

function changes(page: Record<string, unknown>): Array<Record<string, unknown>> {
  return page.changes as Array<Record<string, unknown>>;
}

function addIssue(store: LedgerStore, projectId: string, title: string, body = "private body") {
  return store.createIssue({
    attribution: systemAction(),
    actor_type: "system",
    author_display: "System",
    project_id: projectId,
    title,
    body,
  });
}

describe("bounded ledger change feed", () => {
  it("establishes a quiet resync cursor and isolates projects", () => {
    const alpha = addProject(db, { project_key: "alpha" });
    const beta = addProject(db, { project_key: "beta" });
    const store = new LedgerStore(db);

    const initial = readLedgerChangeFeed(db, {
      project_id: alpha.id,
      project_key: alpha.project_key,
    });
    expect(initial).toMatchObject({
      schema: LEDGER_CHANGE_FEED_SCHEMA,
      changes: [],
      resync: { established: true },
    });

    const baseline = initial.high_water_mark as number;
    addIssue(store, beta.id, "Other project");
    addIssue(store, alpha.id, "Visible project");
    const page = readLedgerChangeFeed(db, {
      project_id: alpha.id,
      project_key: alpha.project_key,
      cursor: cursor(initial),
    });
    expect(changes(page)).toHaveLength(1);
    expect(changes(page)[0]).toMatchObject({ sequence: baseline + 1, event_type: "issue.created" });
    expect(JSON.stringify(changes(page)[0])).not.toContain("private body");
  });

  it("holds a deterministic high-water mark across pagination and replay", () => {
    const project = addProject(db, { project_key: "alpha" });
    const store = new LedgerStore(db);
    const initial = readLedgerChangeFeed(db, { project_id: project.id, project_key: project.project_key });
    const baseline = initial.high_water_mark as number;
    addIssue(store, project.id, "One");
    addIssue(store, project.id, "Two");

    const first = readLedgerChangeFeed(db, {
      project_id: project.id,
      project_key: project.project_key,
      cursor: cursor(initial),
      limit: 1,
    });
    expect(first).toMatchObject({ high_water_mark: baseline + 2, page: { count: 1, has_more: true } });

    const secondBeforeAppend = readLedgerChangeFeed(db, {
      project_id: project.id,
      project_key: project.project_key,
      cursor: cursor(first),
      limit: 1,
    });
    addIssue(store, project.id, "Three");
    const replay = readLedgerChangeFeed(db, {
      project_id: project.id,
      project_key: project.project_key,
      cursor: cursor(first),
      limit: 1,
    });
    expect(replay).toEqual(secondBeforeAppend);

    const second = replay;
    expect(second).toMatchObject({ high_water_mark: baseline + 2, page: { count: 1, has_more: false } });
    const third = readLedgerChangeFeed(db, {
      project_id: project.id,
      project_key: project.project_key,
      cursor: cursor(second),
    });
    expect(changes(third)[0]).toMatchObject({ sequence: baseline + 3 });
  });

  it("fails closed for retention gaps, truncation, and cursor drift", () => {
    const project = addProject(db, { project_key: "alpha" });
    const store = new LedgerStore(db);
    const initial = readLedgerChangeFeed(db, { project_id: project.id, project_key: project.project_key });
    const baseline = initial.high_water_mark as number;
    addIssue(store, project.id, "One");
    addIssue(store, project.id, "Two");

    db.prepare("DELETE FROM ledger_change_log WHERE project_id = ? AND sequence = ?").run(project.id, baseline + 1);
    expect(() => readLedgerChangeFeed(db, {
      project_id: project.id,
      project_key: project.project_key,
      cursor: cursor(initial),
    })).toThrowError(expect.objectContaining({ code: "truncated_change_log" }));

    db.prepare("UPDATE ledger_change_feed_state SET retained_from_sequence = ? WHERE project_id = ?").run(baseline + 2, project.id);
    expect(() => readLedgerChangeFeed(db, {
      project_id: project.id,
      project_key: project.project_key,
      cursor: cursor(initial),
    })).toThrowError(expect.objectContaining({ code: "retention_gap" }));

    const beta = addProject(db, { project_key: "beta" });
    expect(() => readLedgerChangeFeed(db, {
      project_id: beta.id,
      project_key: beta.project_key,
      cursor: cursor(initial),
    })).toThrowError(expect.objectContaining({ code: "cursor_project_mismatch" }));
  });

  it("exposes the same contract through the file-RPC-safe HTTP route", async () => {
    const project = addProject(db, { project_key: "alpha" });
    const router = authenticatedTestRouter(setupOperator(db, { display_name: "Change feed test operator" }));
    registerLedgerChangeRoutes(router, db);
    const response = await router.invoke({ method: "GET", url: "/api/ledger/changes?project=alpha" });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      schema: LEDGER_CHANGE_FEED_SCHEMA,
      project: { id: project.id, key: "alpha" },
      changes: [],
      resync: { established: true },
    });
  });
});
