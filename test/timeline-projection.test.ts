import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setDb } from "../src/db.js";
import { buildProjectTimelineProjection, type TimelinePageBudget } from "../src/ledger/timeline-projection.js";
import { mergeTimelinePages } from "../src/timeline-pages.js";
import { registerTimelineRoutes } from "../src/routes/timeline.js";
import type { ProjectTimelineInput, ProjectTimelineProjection } from "../src/types.js";
import { createTimelineFixture, type TimelineFixture } from "./helpers/timeline-fixtures.js";

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
      event_kinds: ["auth_request", "body", "comment", "commit", "issue_state", "label"],
    });
    expect(projection.time_axis).toEqual({
      start: fixture.issues.rootA.created_at,
      end: expect.any(Number),
      event_count: projection.events.length,
    });
    expect(projection.rows.map((row) => [row.kind, row.issue?.id ?? row.row_spec?.id])).toEqual([
      ["root", fixture.issues.rootA.id],
      ["root", fixture.issues.rootB.id],
      ["root", "residual"],
    ]);
    expect(memberIssueIds(projection, "residual")).toEqual([]);
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
        state: expect.objectContaining({
          event_type: "issue.closed",
          status: "closed",
          resolution: "delivered",
        }),
        headline_source: "state",
      }),
      expect.objectContaining({
        kind: "state",
        state: expect.objectContaining({
          event_type: "issue.reopened",
          status: "open",
          resolution: null,
        }),
      }),
    ]));
    expect(projection.diagnostics).toMatchObject({
      total_issues: 9,
      deleted_issues: 1,
      root_count: 3,
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

  it("filters timeline event kinds and leaves noisy operational links default-off", () => {
    fixture.db.prepare(
      `INSERT INTO ledger_events (
        id, entity_type, entity_id, event_type, actor_id, actor_type,
        source, payload_json, occurred_at, observed_at
      ) VALUES (?, ?, ?, ?, NULL, 'system', ?, ?, ?, ?)`,
    ).run(
      "event_session_timeline_1",
      "session",
      "session_timeline_1",
      "session.issue_linked",
      "session",
      JSON.stringify({
        session_id: "session_timeline_1",
        issue_id: fixture.issues.rootB.id,
        link_type: "worked_on",
      }),
      1_800_000_000_185,
      1_800_000_000_185,
    );
    const defaults = buildProjectTimelineProjection(fixture.db, {
      project_id: fixture.project.id,
      root_policy: "explicit",
      explicit_root_issue_ids: [fixture.issues.rootB.id],
    });
    const labelsOnly = buildProjectTimelineProjection(fixture.db, {
      project_id: fixture.project.id,
      root_policy: "explicit",
      explicit_root_issue_ids: [fixture.issues.rootB.id],
      event_kinds: ["label"],
    });
    const withSession = buildProjectTimelineProjection(fixture.db, {
      project_id: fixture.project.id,
      root_policy: "explicit",
      explicit_root_issue_ids: [fixture.issues.rootB.id],
      event_kinds: ["label", "session"],
    });

    expect(defaults.events.some((event) => event.state?.event_type === "session.issue_linked")).toBe(false);
    expect(labelsOnly.events.map((event) => event.state?.event_type)).toEqual([
      "label.updated",
      "label.updated",
    ]);
    expect(withSession.events.map((event) => event.state?.event_type)).toEqual([
      "label.updated",
      "label.updated",
      "session.issue_linked",
    ]);
    expect(withSession.events.at(-1)).toMatchObject({
      display_headline: "Session session_timeline_1 linked",
      state: expect.objectContaining({
        payload: expect.objectContaining({ session_id: "session_timeline_1" }),
      }),
    });
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
    const sharedRows = expanded.rows.filter((row) => row.issue?.id === fixture.issues.shared.id);
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
      row.issue?.id === fixture.issues.shared.id
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
      row.issue?.id === fixture.issues.nested.id
      && row.parent_row_id === alphaShared?.id
    ));
    const betaRoot = nested.rows.find((row) => row.issue?.id === fixture.issues.rootB.id);
    const betaShared = nested.rows.find((row) => (
      row.issue?.id === fixture.issues.shared.id
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
      "row:spec:residual:0",
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
      event.kind === "comment"
      && event.row_id === sharedRow?.id
      && event.source_entity.type === "comment"
      && event.source_entity.id === fixture.comments.sharedNested
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
      event.kind === "comment" && event.row_id === cycleRow?.id && event.source_entity.type === "comment"
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
    expect(explicit.rows.map((row) => [row.kind, row.issue?.id ?? row.row_spec?.id])).toEqual([
      ["explicit_root", fixture.issues.shared.id],
      ["promoted_root", fixture.issues.closed.id],
      ["root", "residual"],
    ]);

    const statusFiltered = buildProjectTimelineProjection(fixture.db, {
      project_id: fixture.project.id,
      root_policy: "explicit",
      explicit_root_issue_ids: [fixture.issues.closed.id],
      statuses: ["closed"],
    });
    expect(statusFiltered.rows.map((row) => row.issue?.id ?? row.row_spec?.id)).toEqual([
      fixture.issues.closed.id,
      "residual",
    ]);

    setDb(fixture.db);
    const route = captureTimelineRoute();
    const response = route({
      project_id: fixture.project.id,
      root_policy: "explicit",
      explicit_root_issue_ids: [fixture.issues.shared.id],
    });
    expect(response.statusCode).toBe(200);
    expect((response.body as ProjectTimelineProjection).rows
      .map((row) => row.issue?.id ?? row.row_spec?.id)).toEqual([
        fixture.issues.shared.id,
        "residual",
      ]);
  });

  it("keeps default residual as the allowed project-issue complement for empty filters", () => {
    const projection = buildProjectTimelineProjection(fixture.db, {
      project_id: fixture.project.id,
      root_specs: [{ id: "empty", scope: { type: "label", name: "not-present" } }],
    });

    expect(memberIssueIds(projection, "empty")).toEqual([]);
    expect(memberIssueIds(projection, "residual")).toEqual([
      fixture.issues.rootA.id,
      fixture.issues.rootB.id,
      fixture.issues.shared.id,
      fixture.issues.nested.id,
      fixture.issues.cycle.id,
      fixture.issues.loner.id,
    ]);
  });

  it("distinguishes current label membership from ever-in-window membership", () => {
    const now = buildProjectTimelineProjection(fixture.db, {
      project_id: fixture.project.id,
      root_specs: [{
        id: "review-now",
        title: "Currently needs review",
        scope: { type: "label", name: "needs-review" },
      }],
      from: fixture.issues.rootB.created_at + 156,
      to: fixture.issues.rootB.created_at + 156,
    });
    const ever = buildProjectTimelineProjection(fixture.db, {
      project_id: fixture.project.id,
      root_specs: [{
        id: "review-ever",
        title: "Ever needed review",
        scope: { type: "label", name: "needs-review", membership: "ever_in_window" },
      }],
      from: fixture.issues.rootB.created_at + 156,
      to: fixture.issues.rootB.created_at + 156,
    });

    expect(memberIssueIds(now, "review-now")).toEqual([
      fixture.issues.shared.id,
      fixture.issues.nested.id,
    ]);
    expect(memberIssueIds(ever, "review-ever")).toEqual([
      fixture.issues.rootB.id,
      fixture.issues.shared.id,
      fixture.issues.nested.id,
    ]);
  });

  it("supports kind, and/or/not composition, overlapping members, and residual complement rows", () => {
    const projection = buildProjectTimelineProjection(fixture.db, {
      project_id: fixture.project.id,
      root_specs: [
        { id: "review", scope: { type: "label", name: "needs-review" } },
        {
          id: "review-feature",
          scope: {
            type: "and",
            predicates: [
              { type: "label", name: "needs-review" },
              { type: "kind", kind: "feature" },
            ],
          },
        },
        {
          id: "open-not-review",
          scope: {
            type: "and",
            predicates: [
              { type: "kind", kind: "feature" },
              { type: "not", predicate: { type: "label", name: "needs-review" } },
            ],
          },
        },
        {
          id: "feature-or-tracker",
          scope: {
            type: "or",
            predicates: [
              { type: "kind", kind: "feature" },
              { type: "kind", kind: "tracker" },
            ],
          },
        },
        { id: "residual", scope: { type: "residual" } },
      ],
    });

    expect(memberIssueIds(projection, "review")).toEqual([
      fixture.issues.shared.id,
      fixture.issues.nested.id,
    ]);
    expect(memberIssueIds(projection, "review-feature")).toEqual([
      fixture.issues.shared.id,
      fixture.issues.nested.id,
    ]);
    expect(memberIssueIds(projection, "open-not-review")).toEqual([
      fixture.issues.cycle.id,
      fixture.issues.loner.id,
    ]);
    expect(memberIssueIds(projection, "feature-or-tracker")).toEqual([
      fixture.issues.rootA.id,
      fixture.issues.rootB.id,
      fixture.issues.shared.id,
      fixture.issues.nested.id,
      fixture.issues.cycle.id,
      fixture.issues.loner.id,
    ]);
    expect(memberIssueIds(projection, "residual")).toEqual([]);

    const sharedMemberships = projection.rows.filter((row) => (
      row.kind === "member" && row.issue?.id === fixture.issues.shared.id
    ));
    expect(sharedMemberships.length).toBeGreaterThan(1);

    const closedOnly = buildProjectTimelineProjection(fixture.db, {
      project_id: fixture.project.id,
      root_specs: [{ id: "closed-features", scope: { type: "kind", kind: "feature" } }],
      statuses: ["closed"],
    });
    expect(memberIssueIds(closedOnly, "closed-features")).toEqual([
      fixture.issues.closed.id,
      fixture.issues.authDone.id,
    ]);
  });

  it("projects parent-subtree members and reports parent-label cycles without crashing", () => {
    const projection = buildProjectTimelineProjection(fixture.db, {
      project_id: fixture.project.id,
      root_specs: [{
        id: "subtree",
        scope: { type: "parent_subtree", issue_id: fixture.issues.rootA.short_id },
      }],
    });

    expect(memberIssueIds(projection, "subtree")).toEqual([
      fixture.issues.shared.id,
      fixture.issues.nested.id,
      fixture.issues.cycle.id,
    ]);
    expect(projection.diagnostics.cycles).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "cycle",
        row_spec_id: "subtree",
        message: expect.stringContaining("parent-label cycle"),
      }),
    ]));
  });

  it("joins pages cut by event count or by elapsed time into the unpaged projection", () => {
    const allKinds: ProjectTimelineInput["event_kinds"] = [
      "auth_request", "backlink", "body", "comment", "commit", "issue_state", "label", "session", "state", "work_unit",
    ];
    const inputs: ProjectTimelineInput[] = [
      { project_id: fixture.project.id },
      {
        project_id: fixture.project.id,
        include_closed: true,
        event_kinds: allKinds,
        expanded_paths: [`row:root:${fixture.issues.rootA.id}:0`],
        depth: 2,
        root_specs: [{
          id: "review-ever",
          title: "Ever needed review",
          scope: { type: "label", name: "needs-review", membership: "ever_in_window" },
        }],
      },
      {
        project_id: fixture.project.id,
        root_policy: "explicit",
        explicit_root_issue_ids: [fixture.issues.shared.id],
        promoted_root_issue_ids: [fixture.issues.closed.id],
        include_closed: true,
        event_kinds: allKinds,
      },
    ];
    const unbounded: TimelinePageBudget = { events: Infinity, ms: Infinity, now: () => 0 };
    let clock = 0;
    const budgets: TimelinePageBudget[] = [
      { events: 0, ms: Infinity, now: () => 0 },
      { events: Infinity, ms: 25, now: () => (clock += 10) },
    ];
    for (const input of inputs) {
      const whole = buildProjectTimelineProjection(fixture.db, input, unbounded);
      expect(whole.page).toEqual({ row_offset: 0, next_row_offset: null });
      for (const budget of budgets) {
        const pages: ProjectTimelineProjection[] = [];
        let rowOffset: number | null = 0;
        while (rowOffset !== null) {
          const page = buildProjectTimelineProjection(fixture.db, { ...input, row_offset: rowOffset }, budget);
          expect(page.page.row_offset).toBe(rowOffset);
          pages.push(page);
          rowOffset = page.page.next_row_offset;
        }
        expect(pages.length).toBeGreaterThan(1);
        const { page: _page, ...unpaged } = whole;
        expect(mergeTimelinePages(pages)).toEqual(unpaged);
      }
    }
  });

  it("reads only the project's index ranges and the shown issues, never a ledger-wide range", () => {
    const statements = recordStatements(fixture.db);
    buildProjectTimelineProjection(fixture.db, { project_id: fixture.project.id });
    buildProjectTimelineProjection(fixture.db, {
      project_id: fixture.project.id,
      include_closed: true,
      event_kinds: ["auth_request", "backlink", "body", "comment", "commit", "issue_state", "label", "session", "state", "work_unit"],
      expanded_paths: [`row:root:${fixture.issues.rootA.id}:0`],
      depth: 2,
      root_specs: [{
        id: "review-ever",
        title: "Ever needed review",
        scope: { type: "label", name: "needs-review", membership: "ever_in_window" },
      }],
    });

    const ledgerWideSteps = statements
      .filter(({ sql }) => !/FROM ledger_projects\b/.test(sql))
      .flatMap(({ sql, args }) => (
      (fixture.db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args) as Array<{ detail: string }>)
        .map((step) => step.detail)
        .filter((detail) => /\bSCAN (?!json_each\b)\w+/.test(detail)
          || /\(entity_type=\?\)/.test(detail)
          // An issue's events of every type, when only the selected types are needed.
          || /\bidx_ledger_events_entity\b/.test(detail))
        .map((detail) => `${detail} <- ${sql.replace(/\s+/g, " ").slice(0, 120)}`)
    ));
    expect(statements.length).toBeGreaterThan(0);
    expect(ledgerWideSteps).toEqual([]);
  });
});

function recordStatements(db: TimelineFixture["db"]): Array<{ sql: string; args: unknown[] }> {
  const recorded: Array<{ sql: string; args: unknown[] }> = [];
  const prepare = db.prepare.bind(db);
  db.prepare = ((sql: string) => {
    const statement = prepare(sql);
    for (const method of ["all", "get"] as const) {
      const run = statement[method].bind(statement);
      statement[method] = ((...args: unknown[]) => {
        recorded.push({ sql, args });
        return run(...args);
      }) as typeof statement[typeof method];
    }
    return statement;
  }) as typeof db.prepare;
  return recorded;
}

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

function memberIssueIds(projection: ProjectTimelineProjection, specId: string) {
  return projection.rows
    .filter((row) => row.kind === "member" && row.row_spec?.id === specId)
    .map((row) => row.issue?.id);
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
