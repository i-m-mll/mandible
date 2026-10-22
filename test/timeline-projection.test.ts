import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setDb, type Db } from "../src/db.js";
import { systemAction } from "../src/identity/resolver.js";
import { buildProjectTimelineProjection } from "../src/ledger/timeline-projection.js";
import { resolveProjectForCheckout } from "../src/ledger/projects.js";
import { LedgerStore } from "../src/ledger/store.js";
import { registerTimelineRoutes } from "../src/routes/timeline.js";
import type { ProjectTimelineProjection } from "../src/types.js";
import { createTimelineFixture, type TimelineFixture } from "./helpers/timeline-fixtures.js";
import { createUser } from "../src/users/store.js";

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
  it("uses the canonical project key as outward repo identity", () => {
    fixture.db.prepare(
      "UPDATE ledger_projects SET project_key = ? WHERE id = ?",
    ).run("canonical-timeline", fixture.project.id);
    fixture.db.prepare(
      "UPDATE ledger_project_checkouts SET work_repo_id = ? WHERE project_id = ?",
    ).run("20-widgets-widgets", fixture.project.id);

    const projection = buildProjectTimelineProjection(fixture.db, {
      project_ref: "canonical-timeline",
    });

    expect(projection.project.repo_id).toBe("canonical-timeline");
  });

  it("passes resolved attribution through body and comment events", () => {
    const user = createUser(fixture.db, {
      slug: "timeline-agent",
      kind: "agent",
      display_name: "Timeline Agent",
    });
    fixture.db.prepare(
      `UPDATE ledger_issues
          SET author_user_id = ?, evidence_method = 'session_claim', author_display = 'Mandible'
        WHERE id = ?`,
    ).run(user.id, fixture.issues.rootA.id);
    fixture.db.prepare(
      `UPDATE ledger_comments
          SET author_user_id = ?, evidence_method = 'session_claim', author_display = 'Mandible'
        WHERE id = ?`,
    ).run(user.id, fixture.comments.rootARefs);

    const projection = buildProjectTimelineProjection(fixture.db, {
      project_id: fixture.project.id,
      root_policy: "explicit",
      explicit_root_issue_ids: [fixture.issues.rootA.id],
    });
    const body = projection.events.find((event) => event.kind === "body");
    const comment = projection.events.find((event) => (
      event.source_entity.id === fixture.comments.rootARefs
    ));
    expect(body?.author).toMatchObject({
      display: "Timeline Agent",
      legacy_display: "Mandible",
      attribution: { user: { id: user.id, kind: "agent" }, evidence_method: "session_claim" },
      source: fixture.issues.rootA.source,
    });
    expect(comment?.author).toMatchObject({ display: "Timeline Agent", source: "mandible" });
  });

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

  it("surfaces requested label and operational ledger events with inspector payloads", () => {
    const projection = buildProjectTimelineProjection(fixture.db, {
      project_id: fixture.project.id,
      root_policy: "explicit",
      explicit_root_issue_ids: [fixture.issues.rootB.id, fixture.issues.authDone.id],
      include_closed: true,
    });
    const labelEvents = projection.events.filter((event) => event.state?.event_type === "label.updated");
    const authCompleted = projection.events.find((event) => (
      event.state?.event_type === "auth_request.completed"
    ));
    const authClosed = projection.events.find((event) => (
      event.issue.id === fixture.issues.authDone.id
      && event.state?.event_type === "issue.closed"
    ));

    expect(labelEvents).toHaveLength(2);
    expect(labelEvents.map((event) => [event.timestamp, event.display_headline])).toEqual([
      [1_800_000_000_175, "Label needs-review added"],
      [1_800_000_000_180, "Label needs-review removed"],
    ]);
    expect(labelEvents[0].state?.payload).toMatchObject({
      issue_id: fixture.issues.rootB.id,
      label: "needs-review",
      present: true,
    });
    expect(authCompleted).toMatchObject({
      issue: expect.objectContaining({ id: fixture.issues.authDone.id }),
      source_entity: {
        type: "issue_state",
        id: fixture.operationalEvents.authCompleted,
        issue_id: fixture.issues.authDone.id,
      },
      kind: "state",
      timestamp: 1_800_000_000_190,
      display_headline: "Auth request auth_timeline_1 completed",
      state: expect.objectContaining({
        event_type: "auth_request.completed",
        payload: expect.objectContaining({
          auth_request_id: "auth_timeline_1",
          issue_id: fixture.issues.authDone.id,
        }),
      }),
    });
    expect(authClosed).toBeUndefined();
  });

  it("preloads comments and operational ledger events once for multi-row projections", () => {
    const originalPrepare = fixture.db.prepare.bind(fixture.db);
    let projectCommentLoadCount = 0;
    let operationalEventLoadCount = 0;
    fixture.db.prepare = ((sql: string) => {
      if (sql.includes("FROM ledger_comments c")) projectCommentLoadCount += 1;
      if (sql.includes("entity_type != 'issue'")) operationalEventLoadCount += 1;
      return originalPrepare(sql);
    }) as Db["prepare"];

    try {
      const projection = buildProjectTimelineProjection(fixture.db, {
        project_id: fixture.project.id,
        root_policy: "explicit",
        explicit_root_issue_ids: [
          fixture.issues.rootA.id,
          fixture.issues.rootB.id,
          fixture.issues.authDone.id,
        ],
        include_closed: true,
      });

      expect(projectCommentLoadCount).toBe(1);
      expect(operationalEventLoadCount).toBe(1);
      expect(projection.events.some((event) => (
        event.issue.id === fixture.issues.authDone.id
        && event.state?.event_type === "auth_request.completed"
      ))).toBe(true);
    } finally {
      fixture.db.prepare = originalPrepare as Db["prepare"];
    }
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

  it("synthesizes derived backlink events on visible target rows", () => {
    const projection = buildProjectTimelineProjection(fixture.db, {
      project_id: fixture.project.id,
      root_policy: "explicit",
      explicit_root_issue_ids: [fixture.issues.shared.id],
      event_kinds: ["backlink", "body", "comment", "state"],
    });
    const sharedRow = projection.rows.find((row) => row.issue.id === fixture.issues.shared.id);
    const backlink = projection.events.find((event) => (
      event.kind === "backlink"
      && event.row_id === sharedRow?.id
      && event.source_entity.type === "comment"
      && event.source_entity.id === fixture.comments.rootARefs
    ));

    expect(backlink).toMatchObject({
      row_id: sharedRow?.id,
      issue: expect.objectContaining({ id: fixture.issues.shared.id }),
      source_entity: {
        type: "comment",
        id: fixture.comments.rootARefs,
        issue_id: fixture.issues.rootA.id,
      },
      kind: "backlink",
      timestamp: 1_800_000_000_110,
      display_headline: `Referenced by ${fixture.issues.rootA.short_id}`,
      headline_source: "backlink",
      body: expect.stringContaining("[issue:"),
      link_ids: [],
      backlink: expect.objectContaining({
        relationship_type: "references",
        source_issue: expect.objectContaining({ id: fixture.issues.rootA.id }),
        target_issue: expect.objectContaining({ id: fixture.issues.shared.id }),
        source_entity: {
          type: "comment",
          id: fixture.comments.rootARefs,
          issue_id: fixture.issues.rootA.id,
        },
        raw_ref: expect.stringContaining("[issue:"),
        derived: true,
      }),
    });
  });

  it("keeps many backlink refs as projection events with clustering metadata", () => {
    const projection = buildProjectTimelineProjection(fixture.db, {
      project_id: fixture.project.id,
      root_policy: "explicit",
      explicit_root_issue_ids: [
        fixture.issues.shared.id,
        fixture.issues.nested.id,
        fixture.issues.cycle.id,
      ],
      event_kinds: ["backlink", "body", "comment", "state"],
    });
    const manyRefBacklinks = projection.events.filter((event) => (
      event.kind === "backlink"
      && event.source_entity.type === "comment"
      && event.source_entity.id === fixture.comments.manyRefs
    ));

    expect(manyRefBacklinks.map((event) => event.issue.id).sort()).toEqual([
      fixture.issues.cycle.id,
      fixture.issues.nested.id,
      fixture.issues.shared.id,
    ].sort());
    expect(manyRefBacklinks.every((event) => event.timestamp === 1_800_000_000_130)).toBe(true);
    expect(manyRefBacklinks.every((event) => event.backlink?.relationship_source_id)).toBe(true);
    expect(manyRefBacklinks.every((event) => event.backlink?.normalized_ref)).toBe(true);
  });

  it("can omit synthetic backlink events via event_kinds without changing rows or diagnostics", () => {
    const withBacklinks = buildProjectTimelineProjection(fixture.db, {
      project_id: fixture.project.id,
      root_policy: "explicit",
      explicit_root_issue_ids: [fixture.issues.shared.id],
      event_kinds: ["backlink", "body", "comment", "state"],
    });
    const withoutBacklinks = buildProjectTimelineProjection(fixture.db, {
      project_id: fixture.project.id,
      root_policy: "explicit",
      explicit_root_issue_ids: [fixture.issues.shared.id],
      event_kinds: ["body", "comment", "state"],
    });

    expect(withBacklinks.events.some((event) => event.kind === "backlink")).toBe(true);
    expect(withoutBacklinks.events.some((event) => event.kind === "backlink")).toBe(false);
    expect(withoutBacklinks.inputs.event_kinds).toEqual(["body", "comment", "state"]);
    expect(withoutBacklinks.rows).toEqual(withBacklinks.rows);
    expect(withoutBacklinks.diagnostics).toEqual(withBacklinks.diagnostics);
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

  it("keeps anchor RowSpecs additive with the existing coordination root projection", () => {
    const legacy = buildProjectTimelineProjection(fixture.db, {
      project_id: fixture.project.id,
      root_policy: "coordination",
    });
    const rowSpec = buildProjectTimelineProjection(fixture.db, {
      project_id: fixture.project.id,
      root_specs: [{
        id: "alpha",
        anchor_issue_id: fixture.issues.rootA.id,
        scope: { type: "referenced_by", issue_id: fixture.issues.rootA.id },
      }],
    });
    const rootRows = rowSpec.rows.filter((row) => row.issue && row.parent_row_id === null);
    const alphaSpecRow = rowSpec.rows.find((row) => row.row_spec?.id === "alpha");

    expect(rootRows.map((row) => [row.kind, row.issue?.id])).toEqual([
      ["root", fixture.issues.rootA.id],
      ["root", fixture.issues.rootB.id],
      ["root", fixture.issues.rootA.id],
    ]);
    expect(rowSpec.rows.find((row) => row.row_spec?.id === "residual")).toBeTruthy();
    expect(memberIssueIds(rowSpec, "residual")).toEqual([]);
    expect(alphaSpecRow?.row_spec).toMatchObject({
      id: "alpha",
      anchor_issue_id: fixture.issues.rootA.id,
    });
    const legacyAlphaRow = legacy.rows.find((row) => row.issue?.id === fixture.issues.rootA.id);
    const eventSummary = (projection: ProjectTimelineProjection, rowId: string | undefined) => (
      projection.events
        .filter((event) => event.row_id === rowId)
        .map((event) => [event.kind, event.source_entity.type, event.source_entity.id, event.timestamp])
    );
    expect(eventSummary(rowSpec, alphaSpecRow?.id))
      .toEqual(eventSummary(legacy, legacyAlphaRow?.id));
  });

  it("emits anchor-less label filter roots with predicate member rows and filtered member events", () => {
    const projection = buildProjectTimelineProjection(fixture.db, {
      project_id: fixture.project.id,
      root_specs: [{
        id: "review",
        title: "Needs review",
        scope: { type: "label", name: "needs-review" },
      }],
      from: fixture.issues.nested.created_at,
      to: fixture.issues.nested.created_at,
    });
    const root = projection.rows.find((row) => row.row_spec?.id === "review" && row.kind === "root");
    const members = projection.rows.filter((row) => row.parent_row_id === root?.id);

    expect(topLevelIssueRows(projection).map((row) => row.issue?.id)).toEqual([
      fixture.issues.rootA.id,
      fixture.issues.rootB.id,
    ]);
    expect(root).toMatchObject({
      id: "row:spec:review:0",
      issue: null,
      kind: "root",
      parent_row_id: null,
      row_spec: expect.objectContaining({ id: "review", title: "Needs review" }),
      expanded: true,
    });
    expect(members.map((row) => [row.kind, row.issue?.id, row.parent_row_id, row.source_event_id])).toEqual([
      ["member", fixture.issues.shared.id, root?.id, null],
      ["member", fixture.issues.nested.id, root?.id, null],
    ]);
    expect(projection.events
      .filter((event) => event.row_id === members[1]?.id)
      .map((event) => event.issue.id))
      .toEqual([fixture.issues.nested.id]);
    expect(memberIssueIds(projection, "residual")).toEqual([
      fixture.issues.rootA.id,
      fixture.issues.rootB.id,
      fixture.issues.cycle.id,
      fixture.issues.loner.id,
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

  it("exposes label membership intervals for filter RowSpec aggregate support", () => {
    const projection = buildProjectTimelineProjection(fixture.db, {
      project_id: fixture.project.id,
      root_specs: [{
        id: "review-ever",
        title: "Ever needed review",
        scope: { type: "label", name: "needs-review", membership: "ever_in_window" },
      }],
      from: fixture.issues.rootB.created_at + 156,
      to: fixture.issues.rootB.created_at + 156,
    });
    const root = projection.rows.find((row) => row.row_spec?.id === "review-ever" && row.kind === "root");
    const rootBInterval = root?.row_spec?.label_intervals?.find((interval) => (
      interval.issue_id === fixture.issues.rootB.id && interval.label === "needs-review"
    ));

    expect(rootBInterval).toEqual({
      issue_id: fixture.issues.rootB.id,
      label: "needs-review",
      start: fixture.issues.rootB.created_at + 155,
      end: fixture.issues.rootB.created_at + 160,
      degraded: false,
    });
  });

  it("keeps residual rows based on current label membership", () => {
    const projection = buildProjectTimelineProjection(fixture.db, {
      project_id: fixture.project.id,
      root_specs: [
        {
          id: "review-ever",
          scope: { type: "label", name: "needs-review", membership: "ever_in_window" },
        },
        { id: "residual", scope: { type: "residual" } },
      ],
      from: fixture.issues.rootB.created_at + 156,
      to: fixture.issues.rootB.created_at + 156,
    });

    expect(memberIssueIds(projection, "review-ever")).toContain(fixture.issues.rootB.id);
    expect(memberIssueIds(projection, "residual")).toContain(fixture.issues.rootB.id);
    expect(memberIssueIds(projection, "residual")).not.toContain(fixture.issues.shared.id);
    expect(memberIssueIds(projection, "residual")).not.toContain(fixture.issues.nested.id);
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

  it("uses the selected project's coordination roots and residual universe", () => {
    const checkout = resolveProjectForCheckout(fixture.db, {
      root: path.join(tempDir, "feedbax"),
      name: "feedbax",
      workRepoId: "feedbax",
      defaultBranch: "main",
      remoteUrl: "",
    });
    const store = new LedgerStore(fixture.db);
    const coordination = store.createIssue({
      attribution: systemAction(),
      project_id: checkout.project.id,
      title: "Feedbax coordination",
      body: "Project-local coordination body.",
      kind: "tracker",
      labels: [],
      aliases: [{ alias_kind: "git_bug_short", alias: "fbcoord" }],
      created_at: 1_900_000_000_000,
    });
    const feature = store.createIssue({
      attribution: systemAction(),
      project_id: checkout.project.id,
      title: "Feedbax feature",
      body: "Project-local feature body.",
      kind: "feature",
      labels: ["feature"],
      aliases: [{ alias_kind: "git_bug_short", alias: "fbfeature" }],
      created_at: 1_900_000_000_010,
    });

    const projection = buildProjectTimelineProjection(fixture.db, {
      project_id: checkout.project.id,
      root_specs: [{ id: "features", scope: { type: "kind", kind: "feature" } }],
    });

    expect(topLevelIssueRows(projection).map((row) => row.issue?.id)).toEqual([coordination.id]);
    expect(memberIssueIds(projection, "features")).toEqual([feature.id]);
    expect(memberIssueIds(projection, "residual")).toEqual([coordination.id]);
    expect(projection.rows.some((row) => row.issue?.project_id === fixture.project.id)).toBe(false);
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

  it("reports unmatched and invalid predicates as diagnostics", () => {
    const projection = buildProjectTimelineProjection(fixture.db, {
      project_id: fixture.project.id,
      root_specs: [
        { id: "missing-label", scope: { type: "label", name: "not-present" } },
        { id: "missing-source", scope: { type: "referenced_by", issue_id: "missing" } },
        { id: "bad-and", scope: { type: "and", predicates: [] } },
        { id: "bad-label", scope: { type: "label" } as never },
      ],
    });

    expect(projection.rows
      .filter((row) => row.kind === "root" && row.row_spec)
      .map((row) => row.id)).toEqual([
      "row:spec:missing-label:0",
      "row:spec:missing-source:1",
      "row:spec:bad-and:2",
      "row:spec:bad-label:3",
      "row:spec:residual:4",
    ]);
    expect(projection.diagnostics.unmatched_predicates).toEqual(expect.arrayContaining([
      expect.objectContaining({ row_spec_id: "missing-label", kind: "unmatched_predicate" }),
    ]));
    expect(projection.diagnostics.invalid_predicates).toEqual(expect.arrayContaining([
      expect.objectContaining({ row_spec_id: "missing-source", kind: "invalid_predicate" }),
      expect.objectContaining({ row_spec_id: "bad-and", kind: "invalid_predicate" }),
      expect.objectContaining({ row_spec_id: "bad-label", kind: "invalid_predicate" }),
    ]));
  });

  it("preserves predicate-driven projection output after evaluator extraction", () => {
    // Regression guard for the shared-evaluator extraction (issue dce57b1):
    // the Timeline projection's predicate-derived membership must be byte-for-byte
    // unchanged from before src/ledger/issue-predicate.ts was split out.
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
        { id: "subtree", scope: { type: "parent_subtree", issue_id: fixture.issues.rootA.short_id } },
        {
          id: "or-not",
          scope: {
            type: "or",
            predicates: [
              { type: "kind", kind: "umbrella" },
              { type: "not", predicate: { type: "label", name: "needs-review" } },
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
    expect(memberIssueIds(projection, "subtree")).toEqual([
      fixture.issues.shared.id,
      fixture.issues.nested.id,
      fixture.issues.cycle.id,
    ]);
    expect(memberIssueIds(projection, "or-not")).toEqual([
      fixture.issues.rootA.id,
      fixture.issues.rootB.id,
      fixture.issues.cycle.id,
      fixture.issues.loner.id,
    ]);
    expect(memberIssueIds(projection, "residual")).toEqual([]);
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

function memberIssueIds(projection: ProjectTimelineProjection, specId: string) {
  return projection.rows
    .filter((row) => row.kind === "member" && row.row_spec?.id === specId)
    .map((row) => row.issue?.id);
}

function topLevelIssueRows(projection: ProjectTimelineProjection) {
  return projection.rows.filter((row) => row.parent_row_id === null && row.issue);
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
