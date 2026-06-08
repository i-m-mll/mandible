import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setDb, type Db } from "../src/db.js";
import { buildProjectTimelineProjection } from "../src/ledger/timeline-projection.js";
import { registerTimelineRoutes } from "../src/routes/timeline.js";
import type { ProjectTimelineProjection } from "../src/types.js";
import { createTimelineFixture, type TimelineFixture } from "./timeline-fixtures.js";

let tempDir = "";
let fixture: TimelineFixture;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-timeline-"));
  fixture = createTimelineFixture(tempDir);
});

afterEach(() => {
  fixture.db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("project timeline projection", () => {
  it("projects coordination roots on one global time axis without per-row domains", () => {
    const projection = buildProjectTimelineProjection(fixture.db, {
      project_id: fixture.project.id,
    });

    expect(projection.inputs).toMatchObject({
      project_id: fixture.project.id,
      root_policy: "coordination_and_explicit",
      statuses: ["open"],
      depth: 1,
    });
    expect(projection.time_axis).toEqual({
      start: fixture.issues.rootA.created_at,
      end: expect.any(Number),
      event_count: projection.events.length,
    });
    expect(projection.rows.map((row) => [row.kind, row.issue.id])).toEqual([
      ["root", fixture.issues.rootA.id],
      ["root", fixture.issues.rootB.id],
    ]);
    expect(projection.rows.every((row) => !("time_axis" in row))).toBe(true);
    expect(projection.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source_entity: { type: "issue_body", id: fixture.issues.rootA.id, issue_id: fixture.issues.rootA.id },
        kind: "body",
        ordinal: 0,
        display_headline: "Alpha plan",
        headline_source: "markdown_heading",
      }),
      expect.objectContaining({
        kind: "comment",
        source_entity: { type: "comment", id: fixture.comments.rootARefs, issue_id: fixture.issues.rootA.id },
        headline_source: "body_excerpt",
      }),
      expect.objectContaining({
        kind: "state",
        state: { event_type: "issue.closed", status: "closed", resolution: "merged" },
        headline_source: "state",
      }),
      expect.objectContaining({
        kind: "state",
        state: { event_type: "issue.reopened", status: "open", resolution: null },
      }),
    ]));
    expect(projection.diagnostics).toMatchObject({
      total_issues: 8,
      deleted_issues: 1,
      root_count: 2,
      reachable_from_roots_count: 2,
      derived_reference_count: 13,
      unreferenced_open_issue_ids: [fixture.issues.loner.id],
      loner_open_issue_ids: [fixture.issues.loner.id],
    });
    expect(projection.diagnostics.repeated_reference_target_issue_ids).toEqual(expect.arrayContaining([
      fixture.issues.shared.id,
      fixture.issues.closed.id,
      fixture.issues.deleted.id,
      fixture.issues.cycle.id,
      fixture.issues.nested.id,
    ]));
  });

  it("attaches text-derived links to body and comment events using relationship source provenance", () => {
    const projection = buildProjectTimelineProjection(fixture.db, {
      project_id: fixture.project.id,
    });
    const rootABody = eventBySource(projection, "issue_body", fixture.issues.rootA.id);
    const rootAComment = eventBySource(projection, "comment", fixture.comments.rootARefs);
    const bodyLinks = linksForEvent(projection, rootABody.id);
    const commentLinks = linksForEvent(projection, rootAComment.id);

    expect(bodyLinks.map((link) => link.target_issue.id).sort()).toEqual([
      fixture.issues.closed.id,
      fixture.issues.shared.id,
    ].sort());
    expect(commentLinks.map((link) => link.target_issue.id).sort()).toEqual([
      fixture.issues.cycle.id,
      fixture.issues.deleted.id,
      fixture.issues.shared.id,
    ].sort());
    expect([...bodyLinks, ...commentLinks]).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source_entity: { type: "issue_body", id: fixture.issues.rootA.id, issue_id: fixture.issues.rootA.id },
        source_issue: expect.objectContaining({ id: fixture.issues.rootA.id }),
        relationship_type: "references",
        derived: true,
      }),
      expect.objectContaining({
        source_entity: { type: "comment", id: fixture.comments.rootARefs, issue_id: fixture.issues.rootA.id },
        raw_ref: expect.stringContaining("[issue:"),
      }),
    ]));
  });

  it("expands event-linked issues into path-keyed transient occurrences and preserves the time axis", () => {
    const base = buildProjectTimelineProjection(fixture.db, {
      project_id: fixture.project.id,
    });
    const alphaBody = eventBySource(base, "issue_body", fixture.issues.rootA.id);
    const betaBody = eventBySource(base, "issue_body", fixture.issues.rootB.id);
    const expanded = buildProjectTimelineProjection(fixture.db, {
      project_id: fixture.project.id,
      expanded_event_ids: [alphaBody.id, betaBody.id],
      depth: 1,
    });
    const sharedRows = expanded.rows.filter((row) => row.issue.id === fixture.issues.shared.id);
    const sharedExpandedLinks = expanded.links.filter((link) => (
      link.target_issue.id === fixture.issues.shared.id && link.expanded_row_id !== null
    ));

    expect(expanded.time_axis.start).toBe(base.time_axis.start);
    expect(expanded.time_axis.end).toBeGreaterThanOrEqual(base.time_axis.end ?? 0);
    expect(sharedRows).toHaveLength(2);
    expect(new Set(sharedRows.map((row) => row.id)).size).toBe(2);
    expect(sharedRows.every((row) => row.kind === "transient")).toBe(true);
    expect(sharedRows.map((row) => row.parent_row_id).sort()).toEqual([
      `row:root:${fixture.issues.rootA.id}:0`,
      `row:root:${fixture.issues.rootB.id}:1`,
    ].sort());
    expect(sharedExpandedLinks.map((link) => link.expanded_row_id).sort()).toEqual(
      sharedRows.map((row) => row.id).sort(),
    );
  });

  it("orders nested transient occurrences directly beneath their expanded parent", () => {
    const base = buildProjectTimelineProjection(fixture.db, {
      project_id: fixture.project.id,
    });
    const alphaBody = eventBySource(base, "issue_body", fixture.issues.rootA.id);
    const betaBody = eventBySource(base, "issue_body", fixture.issues.rootB.id);
    const firstLevel = buildProjectTimelineProjection(fixture.db, {
      project_id: fixture.project.id,
      expanded_event_ids: [alphaBody.id, betaBody.id],
      depth: 2,
    });
    const alphaSharedRow = firstLevel.rows.find((row) => (
      row.issue.id === fixture.issues.shared.id
      && row.parent_row_id === `row:root:${fixture.issues.rootA.id}:0`
    ));
    expect(alphaSharedRow).toBeTruthy();
    const sharedNestedEvent = firstLevel.events.find((event) => (
      event.row_id === alphaSharedRow?.id
      && event.source_entity.type === "comment"
      && event.source_entity.id === fixture.comments.sharedNested
    ));
    expect(sharedNestedEvent).toBeTruthy();

    const nested = buildProjectTimelineProjection(fixture.db, {
      project_id: fixture.project.id,
      expanded_event_ids: [alphaBody.id, betaBody.id, sharedNestedEvent?.id ?? ""],
      depth: 2,
    });
    const alphaShared = nested.rows.find((row) => row.id === alphaSharedRow?.id);
    const nestedChild = nested.rows.find((row) => (
      row.issue.id === fixture.issues.nested.id
      && row.parent_row_id === alphaShared?.id
    ));
    const betaRoot = nested.rows.find((row) => row.issue.id === fixture.issues.rootB.id);
    const betaShared = nested.rows.find((row) => (
      row.issue.id === fixture.issues.shared.id
      && row.parent_row_id === betaRoot?.id
    ));

    expect(alphaShared).toMatchObject({
      parent_row_id: `row:root:${fixture.issues.rootA.id}:0`,
      depth: 1,
    });
    expect(nestedChild).toMatchObject({
      parent_row_id: alphaShared?.id,
      source_event_id: sharedNestedEvent?.id,
      depth: 2,
    });
    expect(betaShared).toMatchObject({
      parent_row_id: betaRoot?.id,
      depth: 1,
    });
    expect(nested.rows.map((row) => row.id)).toEqual([
      `row:root:${fixture.issues.rootA.id}:0`,
      alphaShared?.id,
      nestedChild?.id,
      `row:root:${fixture.issues.rootB.id}:1`,
      betaShared?.id,
    ]);
    expect(nested.time_axis).toEqual({
      start: base.time_axis.start,
      end: base.time_axis.end,
      event_count: nested.events.length,
    });
  });

  it("diagnoses depth limits, filtered targets, deleted targets, missing expansions, and cycles", () => {
    const first = buildProjectTimelineProjection(fixture.db, {
      project_id: fixture.project.id,
    });
    const alphaBody = eventBySource(first, "issue_body", fixture.issues.rootA.id);
    const alphaComment = eventBySource(first, "comment", fixture.comments.rootARefs);
    const second = buildProjectTimelineProjection(fixture.db, {
      project_id: fixture.project.id,
      expanded_event_ids: [alphaBody.id, alphaComment.id, "event:missing"],
      depth: 1,
    });
    const sharedRow = second.rows.find((row) => row.issue.id === fixture.issues.shared.id);
    expect(sharedRow).toBeTruthy();
    const sharedNestedEvent = second.events.find((event) => (
      event.row_id === sharedRow?.id && event.source_entity.type === "comment" && event.source_entity.id === fixture.comments.sharedNested
    ));
    expect(sharedNestedEvent).toBeTruthy();

    const depthLimited = buildProjectTimelineProjection(fixture.db, {
      project_id: fixture.project.id,
      expanded_event_ids: [alphaBody.id, alphaComment.id, sharedNestedEvent?.id ?? ""],
      depth: 1,
    });
    expect(depthLimited.diagnostics.depth_limits).toEqual(expect.arrayContaining([
      expect.objectContaining({ target_issue_id: fixture.issues.nested.id, depth: 2 }),
    ]));
    expect(depthLimited.diagnostics.filtered_targets).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "filtered_target", target_issue_id: fixture.issues.closed.id }),
      expect.objectContaining({ kind: "deleted_target", target_issue_id: fixture.issues.deleted.id }),
    ]));
    expect(second.diagnostics.missing_expansions).toEqual(expect.arrayContaining([
      expect.objectContaining({ event_id: "event:missing" }),
    ]));

    const cycleRow = second.rows.find((row) => row.issue.id === fixture.issues.cycle.id);
    const cycleBackEvent = second.events.find((event) => (
      event.row_id === cycleRow?.id && event.source_entity.type === "comment"
    ));
    const cycleProjection = buildProjectTimelineProjection(fixture.db, {
      project_id: fixture.project.id,
      expanded_event_ids: [alphaComment.id, cycleBackEvent?.id ?? ""],
      depth: 2,
    });
    expect(cycleProjection.diagnostics.cycles).toEqual(expect.arrayContaining([
      expect.objectContaining({ target_issue_id: fixture.issues.rootA.id, depth: 2 }),
    ]));
  });

  it("represents explicit roots, promoted roots, include-closed, status filters, and route payloads deterministically", () => {
    const explicit = buildProjectTimelineProjection(fixture.db, {
      project_id: fixture.project.id,
      root_policy: "explicit",
      explicit_root_issue_ids: [fixture.issues.shared.short_id],
      promoted_root_issue_ids: [fixture.issues.closed.short_id],
      include_closed: true,
      depth: 0,
    });

    expect(explicit.inputs).toMatchObject({
      root_policy: "explicit",
      explicit_root_issue_ids: [fixture.issues.shared.id],
      promoted_root_issue_ids: [fixture.issues.closed.id],
      include_closed: true,
      statuses: ["closed", "open"],
      depth: 0,
    });
    expect(explicit.rows.map((row) => [row.kind, row.issue.id])).toEqual([
      ["explicit_root", fixture.issues.shared.id],
      ["promoted_root", fixture.issues.closed.id],
    ]);

    const statusFiltered = buildProjectTimelineProjection(fixture.db, {
      project_id: fixture.project.id,
      root_policy: "explicit",
      explicit_root_issue_ids: [fixture.issues.closed.id],
      statuses: ["closed"],
    });
    expect(statusFiltered.rows.map((row) => row.issue.id)).toEqual([fixture.issues.closed.id]);

    setDb(fixture.db);
    const route = captureTimelineRoute();
    const response = route({
      project_id: fixture.project.id,
      root_policy: "explicit",
      explicit_root_issue_ids: [fixture.issues.shared.id],
    });
    expect(response.statusCode).toBe(200);
    expect((response.body as ProjectTimelineProjection).rows.map((row) => row.issue.id)).toEqual([
      fixture.issues.shared.id,
    ]);
  });
});

function eventBySource(
  projection: ProjectTimelineProjection,
  type: "issue_body" | "comment",
  id: string,
) {
  const event = projection.events.find((item) => (
    item.source_entity.type === type && item.source_entity.id === id
  ));
  expect(event).toBeTruthy();
  return event!;
}

function linksForEvent(projection: ProjectTimelineProjection, eventId: string) {
  return projection.links.filter((link) => link.event_id === eventId);
}

function captureTimelineRoute(): (body: unknown) => { statusCode: number; body: unknown } {
  let handler: ((req: unknown, res: unknown) => unknown) | null = null;
  registerTimelineRoutes({
    get: () => undefined,
    put: () => undefined,
    patch: () => undefined,
    delete: () => undefined,
    post: (route, routeHandler) => {
      if (route === "/api/timeline/project") handler = routeHandler;
    },
  });
  if (!handler) throw new Error("timeline route was not registered");
  return (body: unknown) => {
    const response: { statusCode: number; body: unknown } = { statusCode: 200, body: null };
    handler?.({ body }, {
      status: (code: number) => {
        response.statusCode = code;
      },
      json: (payload: unknown) => {
        response.body = payload;
      },
    });
    return response;
  };
}
