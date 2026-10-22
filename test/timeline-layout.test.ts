import { describe, expect, it } from "vitest";
import { buildTimelineLayout, timelineTimeToX, type TimelineLayoutEventInput, type TimelineLayoutInput, type TimelineLayoutResult } from "../ui/src/views/timeline-layout";

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
