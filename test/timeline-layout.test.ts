import { describe, expect, it } from "vitest";
import {
  TIMELINE_LANE_BUDGETS,
  buildTimelineLayout,
  timelineTimeToX,
  type TimelineLayoutEventInput,
  type TimelineLayoutInput,
  type TimelineLayoutResult,
} from "../../ui/src/views/timeline-layout";

const row = { id: "row-a" };
const domain = { start: 0, end: 1_000 };

function event(
  id: string,
  timestamp: number,
  overrides: Partial<TimelineLayoutEventInput> = {},
): TimelineLayoutEventInput {
  return {
    id,
    rowId: "row-a",
    timestamp,
    widthPx: 72,
    category: "comment",
    importance: "normal",
    ...overrides,
  };
}

function layout(events: TimelineLayoutEventInput[], overrides: Partial<TimelineLayoutInput> = {}) {
  const base: TimelineLayoutInput = {
    rows: [row],
    events,
    renderDomain: domain,
    viewportWidthPx: 1_000,
    density: "comfortable",
  };

  return buildTimelineLayout({
    ...base,
    ...overrides,
    events: overrides.events ?? events,
  });
}

function assertNoSameLaneOverlap(result: TimelineLayoutResult) {
  for (const left of result.eventMarks) {
    for (const right of result.eventMarks) {
      if (left.id >= right.id || left.rowId !== right.rowId || left.lane !== right.lane) {
        continue;
      }
      expect(left.intervalEndPx <= right.intervalStartPx || right.intervalEndPx <= left.intervalStartPx).toBe(true);
    }
  }
}

describe("buildTimelineLayout", () => {
  it("packs near-time events without same-lane interval overlap or horizontal dodging", () => {
    const result = layout([
      event("e1", 100),
      event("e2", 110),
      event("e3", 120),
    ]);

    expect(result.eventMarks).toHaveLength(3);
    assertNoSameLaneOverlap(result);
    for (const mark of result.eventMarks) {
      expect(mark.xPx).toBe(timelineTimeToX(mark.timestamp, domain, 1_000));
    }
  });

  it("uses 2/3/4/6 lane budgets for compact, comfortable, expanded, and local expansion", () => {
    const cases = [
      { density: "compact" as const, count: 2, budget: TIMELINE_LANE_BUDGETS.compact },
      { density: "comfortable" as const, count: 3, budget: TIMELINE_LANE_BUDGETS.comfortable },
      { density: "expanded" as const, count: 4, budget: TIMELINE_LANE_BUDGETS.expanded },
      { density: "compact" as const, count: 6, budget: TIMELINE_LANE_BUDGETS.locallyExpanded, local: true },
    ];

    for (const item of cases) {
      const events = Array.from({ length: item.count }, (_, index) => event(`e${index}`, 100 + index));
      const result = layout(events, {
        density: item.density,
        rows: [{ id: "row-a", locallyExpanded: item.local }],
      });

      expect(result.laneBudgetByRowId["row-a"]).toBe(item.budget);
      expect(result.rowLayoutById["row-a"].laneCount).toBe(item.count);
      expect(Math.max(...result.eventMarks.map((mark) => mark.lane))).toBe(item.count - 1);
      assertNoSameLaneOverlap(result);
    }
  });

  it("reuses a prior lane when legal and otherwise picks the first free lane", () => {
    const first = event("first", 100);
    const second = event("second", 150);
    const firstId = "timeline:event:row-a:first";
    const secondId = "timeline:event:row-a:second";

    const result = layout([first, second], {
      previousLaneByMarkId: {
        [firstId]: 1,
        [secondId]: 1,
      },
    });

    expect(result.nextLaneByMarkId[firstId]).toBe(1);
    expect(result.nextLaneByMarkId[secondId]).toBe(0);
  });

  it("emits deterministic IDs independent of input order", () => {
    const events = [
      event("c", 300),
      event("a", 100),
      event("b", 100),
      event("d", 120),
      event("e", 130),
      event("f", 140),
      event("g", 150),
    ];

    const first = layout(events, { density: "compact", zoomBucket: "z1" });
    const second = layout([...events].reverse(), { density: "compact", zoomBucket: "z1" });

    expect(first.marks.map((mark) => mark.id)).toEqual(second.marks.map((mark) => mark.id));
    expect(first.chronologicalOrder.map((entry) => entry.eventId)).toEqual(
      second.chronologicalOrder.map((entry) => entry.eventId),
    );
    for (const id of first.marks.map((mark) => mark.id)) {
      expect(id).not.toMatch(/:index[:_-]?\d+$/);
    }
  });

  it("clusters identical timestamps at the true timestamp anchor", () => {
    const result = layout([
      event("b", 250, { category: "state", importance: "critical" }),
      event("a", 250, { category: "comment", importance: "routine" }),
      event("c", 250, { category: "comment" }),
    ], {
      selectedEventId: "a",
      zoomBucket: "hour",
    });

    expect(result.eventMarks).toHaveLength(0);
    expect(result.sameTimeClusters).toHaveLength(1);
    const cluster = result.sameTimeClusters[0];
    expect(cluster.timestamp).toBe(250);
    expect(cluster.xPx).toBe(timelineTimeToX(250, domain, 1_000));
    expect(cluster.eventIds).toEqual(["a", "b", "c"]);
    expect(cluster.containsSelected).toBe(true);
    expect(cluster.highestImportance).toBe("critical");
    expect(cluster.categorySummary).toEqual({ comment: 2, state: 1 });
  });

  it("expands selected same-time clusters into child event marks while retaining cluster metadata", () => {
    const events = [
      event("b", 250, { category: "state", importance: "critical" }),
      event("a", 250, { category: "comment", importance: "routine" }),
      event("c", 250, { category: "comment" }),
    ];
    const collapsed = layout(events, { zoomBucket: "hour" });
    const clusterId = collapsed.sameTimeClusters[0].id;

    const result = layout(events, {
      expandedClusterIds: [clusterId],
      zoomBucket: "hour",
    });

    expect(result.marks.map((mark) => mark.kind)).toEqual(["event", "event", "event"]);
    expect(result.eventMarks.map((mark) => mark.eventId).sort()).toEqual(["a", "b", "c"]);
    expect(result.sameTimeClusters).toHaveLength(1);
    expect(result.sameTimeClusters[0].id).toBe(clusterId);
    expect(result.sameTimeClusters[0].expanded).toBe(true);
    expect(result.chronologicalOrder.map((entry) => entry.markKind)).toEqual(["event", "event", "event"]);
  });

  it("clusters dense nonzero bursts into true range marks with selected-child metadata", () => {
    const events = [
      event("e1", 100),
      event("e2", 106),
      event("e3", 112, { importance: "critical" }),
      event("e4", 118),
      event("e5", 124),
    ];
    const result = layout(events, {
      density: "compact",
      selectedEventId: "e3",
      zoomBucket: "minute",
    });

    expect(result.eventMarks).toHaveLength(0);
    expect(result.rangeClusters).toHaveLength(1);
    const cluster = result.rangeClusters[0];
    expect(cluster.minTime).toBe(100);
    expect(cluster.maxTime).toBe(124);
    expect(cluster.anchorTime).toBe(100);
    expect(cluster.xPx).toBe(timelineTimeToX(100, domain, 1_000));
    expect(cluster.widthPx).toBe(timelineTimeToX(124, domain, 1_000) - timelineTimeToX(100, domain, 1_000));
    expect(cluster.eventIds).toEqual(["e1", "e2", "e3", "e4", "e5"]);
    expect(cluster.containsSelected).toBe(true);
    expect(cluster.highestImportance).toBe("critical");
  });

  it("outputs explicit row heights from packed lane counts", () => {
    const result = layout([
      event("e1", 100),
      event("e2", 110),
      event("e3", 120),
    ], {
      rowMinHeightPx: 40,
      rowPaddingYPx: 5,
      laneHeightPx: 20,
    });

    expect(result.rowLayouts).toEqual([
      {
        rowId: "row-a",
        topPx: 0,
        heightPx: 70,
        laneCount: 3,
        laneBudget: 3,
        markIds: result.marks.map((mark) => mark.id),
      },
    ]);
    expect(result.rowLayoutById["row-a"].heightPx).toBe(70);
  });

  it("keeps chronological order metadata by timestamp rather than lane", () => {
    const result = layout([
      event("late", 300),
      event("early", 100),
      event("middle-a", 200),
      event("middle-b", 200),
    ]);

    expect(result.chronologicalOrder.map((entry) => entry.eventId)).toEqual([
      "early",
      "middle-a",
      "middle-b",
      "late",
    ]);
    expect(result.chronologicalOrder.map((entry) => entry.order)).toEqual([0, 1, 2, 3]);
    expect(result.chronologicalOrder.find((entry) => entry.eventId === "middle-a")?.markKind).toBe(
      "same_time_cluster",
    );
  });

  it("maps aggregate intervals with the same row x-scale as event marks", () => {
    const result = layout([
      event("member-event", 250),
    ], {
      aggregates: [{
        id: "aggregate-a",
        rowId: "row-a",
        issueId: "issue-a",
        startTime: 250,
        endTime: 750,
        widthPx: 28,
      }],
    });

    expect(result.aggregateMarks).toHaveLength(1);
    const aggregate = result.aggregateMarks[0];
    expect(aggregate.xPx).toBe(timelineTimeToX(250, domain, 1_000));
    expect(aggregate.widthPx).toBe(timelineTimeToX(750, domain, 1_000) - timelineTimeToX(250, domain, 1_000));
    expect(result.eventMarks[0].xPx).toBe(timelineTimeToX(250, domain, 1_000));
  });
});
