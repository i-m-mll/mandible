export type TimelineDensityMode = "compact" | "comfortable" | "expanded";

export type TimelineImportance = "routine" | "normal" | "critical";

export type TimelineLaneCache = Record<string, number>;

export type TimelineLaneBudgets = {
  compact: number;
  comfortable: number;
  expanded: number;
  locallyExpanded: number;
};

export const TIMELINE_LANE_BUDGETS: TimelineLaneBudgets = {
  compact: 2,
  comfortable: 3,
  expanded: 4,
  locallyExpanded: 6,
};

export type TimelineLayoutRowInput = {
  id: string;
  locallyExpanded?: boolean;
};

export type TimelineLayoutEventInput = {
  id: string;
  rowId: string;
  timestamp: number;
  widthPx?: number;
  importance?: TimelineImportance;
  category?: string;
};

export type TimelineLayoutInput = {
  rows: TimelineLayoutRowInput[];
  events: TimelineLayoutEventInput[];
  renderDomain: {
    start: number;
    end: number;
  };
  viewportWidthPx: number;
  density?: TimelineDensityMode;
  zoomBucket?: string;
  selectedEventId?: string | null;
  expandedClusterIds?: readonly string[];
  locallyExpandedRowIds?: readonly string[];
  previousLaneByMarkId?: TimelineLaneCache;
  markWidthPx?: number;
  clusterWidthPx?: number;
  minGapPx?: number;
  rowMinHeightPx?: number;
  rowPaddingYPx?: number;
  laneHeightPx?: number;
  rangeClusterMinCount?: number;
};

type TimelineLayoutMarkBase = {
  id: string;
  rowId: string;
  lane: number;
  xPx: number;
  widthPx: number;
  intervalStartPx: number;
  intervalEndPx: number;
};

export type TimelineEventMark = TimelineLayoutMarkBase & {
  kind: "event";
  eventId: string;
  timestamp: number;
  importance: TimelineImportance;
  category: string;
};

export type TimelineSameTimeCluster = TimelineLayoutMarkBase & {
  kind: "same_time_cluster";
  timestamp: number;
  eventIds: string[];
  count: number;
  highestImportance: TimelineImportance;
  categorySummary: Record<string, number>;
  containsSelected: boolean;
  expanded: boolean;
};

export type TimelineRangeCluster = TimelineLayoutMarkBase & {
  kind: "range_cluster";
  minTime: number;
  maxTime: number;
  anchorTime: number;
  eventIds: string[];
  count: number;
  highestImportance: TimelineImportance;
  categorySummary: Record<string, number>;
  containsSelected: boolean;
  expanded: boolean;
};

export type TimelineLayoutMark =
  | TimelineEventMark
  | TimelineSameTimeCluster
  | TimelineRangeCluster;

export type TimelineRowLayout = {
  rowId: string;
  topPx: number;
  heightPx: number;
  laneCount: number;
  laneBudget: number;
  markIds: string[];
};

export type TimelineChronologicalOrderEntry = {
  order: number;
  rowId: string;
  eventId: string;
  timestamp: number;
  markId: string;
  markKind: TimelineLayoutMark["kind"];
};

export type TimelineLayoutResult = {
  marks: TimelineLayoutMark[];
  eventMarks: TimelineEventMark[];
  sameTimeClusters: TimelineSameTimeCluster[];
  rangeClusters: TimelineRangeCluster[];
  rowLayouts: TimelineRowLayout[];
  rowLayoutById: Record<string, TimelineRowLayout>;
  laneBudgetByRowId: Record<string, number>;
  nextLaneByMarkId: TimelineLaneCache;
  chronologicalOrder: TimelineChronologicalOrderEntry[];
};

type MarkCandidate = TimelineLayoutMark extends infer Mark
  ? Mark extends TimelineLayoutMark
    ? Omit<Mark, "lane"> & { lane?: number }
    : never
  : never;

const IMPORTANCE_RANK: Record<TimelineImportance, number> = {
  routine: 0,
  normal: 1,
  critical: 2,
};

const DEFAULT_MARK_WIDTH_PX = 96;
const DEFAULT_CLUSTER_WIDTH_PX = 32;
const DEFAULT_MIN_GAP_PX = 8;
const DEFAULT_ROW_MIN_HEIGHT_PX = 44;
const DEFAULT_ROW_PADDING_Y_PX = 8;
const DEFAULT_LANE_HEIGHT_PX = 28;
const DEFAULT_RANGE_CLUSTER_MIN_COUNT = 4;

export function timelineTimeToX(
  timestamp: number,
  renderDomain: TimelineLayoutInput["renderDomain"],
  viewportWidthPx: number,
): number {
  const duration = renderDomain.end - renderDomain.start;
  if (!Number.isFinite(duration) || duration <= 0 || viewportWidthPx <= 0) {
    return 0;
  }
  return ((timestamp - renderDomain.start) / duration) * viewportWidthPx;
}

export function getTimelineLaneBudget(
  density: TimelineDensityMode = "comfortable",
  locallyExpanded = false,
): number {
  if (locallyExpanded) {
    return TIMELINE_LANE_BUDGETS.locallyExpanded;
  }
  return TIMELINE_LANE_BUDGETS[density];
}

export function buildTimelineLayout(input: TimelineLayoutInput): TimelineLayoutResult {
  const density = input.density ?? "comfortable";
  const markWidthPx = input.markWidthPx ?? DEFAULT_MARK_WIDTH_PX;
  const clusterWidthPx = input.clusterWidthPx ?? DEFAULT_CLUSTER_WIDTH_PX;
  const minGapPx = input.minGapPx ?? DEFAULT_MIN_GAP_PX;
  const rowMinHeightPx = input.rowMinHeightPx ?? DEFAULT_ROW_MIN_HEIGHT_PX;
  const rowPaddingYPx = input.rowPaddingYPx ?? DEFAULT_ROW_PADDING_Y_PX;
  const laneHeightPx = input.laneHeightPx ?? DEFAULT_LANE_HEIGHT_PX;
  const rangeClusterMinCount = input.rangeClusterMinCount ?? DEFAULT_RANGE_CLUSTER_MIN_COUNT;
  const zoomBucket = input.zoomBucket ?? "default";
  const expandedClusterIds = new Set(input.expandedClusterIds ?? []);
  const locallyExpandedRowIds = new Set(input.locallyExpandedRowIds ?? []);
  const previousLaneByMarkId = input.previousLaneByMarkId ?? {};

  const rows = input.rows.map((row) => ({
    ...row,
    locallyExpanded: row.locallyExpanded || locallyExpandedRowIds.has(row.id),
  }));
  const rowIds = new Set(rows.map((row) => row.id));
  const eventsByRow = new Map<string, TimelineLayoutEventInput[]>();

  for (const event of input.events) {
    if (!rowIds.has(event.rowId)) {
      continue;
    }
    const events = eventsByRow.get(event.rowId) ?? [];
    events.push(normalizeEvent(event, markWidthPx));
    eventsByRow.set(event.rowId, events);
  }

  const marks: TimelineLayoutMark[] = [];
  const rowLayouts: TimelineRowLayout[] = [];
  const rowLayoutById: Record<string, TimelineRowLayout> = {};
  const laneBudgetByRowId: Record<string, number> = {};
  const nextLaneByMarkId: TimelineLaneCache = {};
  let nextRowTopPx = 0;

  for (const row of rows) {
    const laneBudget = getTimelineLaneBudget(density, row.locallyExpanded);
    laneBudgetByRowId[row.id] = laneBudget;
    const rowEvents = sortEvents(eventsByRow.get(row.id) ?? []);
    const candidates = buildClusteredCandidates(rowEvents, {
      clusterWidthPx,
      expandedClusterIds,
      input,
      laneBudget,
      minGapPx,
      rangeClusterMinCount,
      zoomBucket,
    });
    const rowMarks = packLanes(candidates, laneBudget, previousLaneByMarkId);
    const laneCount = rowMarks.length === 0
      ? 0
      : Math.max(...rowMarks.map((mark) => mark.lane)) + 1;
    const heightPx = Math.max(
      rowMinHeightPx,
      rowPaddingYPx * 2 + Math.max(1, laneCount) * laneHeightPx,
    );
    const rowLayout: TimelineRowLayout = {
      rowId: row.id,
      topPx: nextRowTopPx,
      heightPx,
      laneCount,
      laneBudget,
      markIds: rowMarks.map((mark) => mark.id),
    };

    rowLayouts.push(rowLayout);
    rowLayoutById[row.id] = rowLayout;
    nextRowTopPx += heightPx;

    for (const mark of rowMarks) {
      marks.push(mark);
      nextLaneByMarkId[mark.id] = mark.lane;
    }
  }

  const eventMarks = marks.filter((mark): mark is TimelineEventMark => mark.kind === "event");
  const sameTimeClusters = marks.filter(
    (mark): mark is TimelineSameTimeCluster => mark.kind === "same_time_cluster",
  );
  const rangeClusters = marks.filter(
    (mark): mark is TimelineRangeCluster => mark.kind === "range_cluster",
  );

  return {
    marks,
    eventMarks,
    sameTimeClusters,
    rangeClusters,
    rowLayouts,
    rowLayoutById,
    laneBudgetByRowId,
    nextLaneByMarkId,
    chronologicalOrder: buildChronologicalOrder(marks, eventsByRow),
  };
}

function normalizeEvent(
  event: TimelineLayoutEventInput,
  defaultWidthPx: number,
): TimelineLayoutEventInput {
  return {
    ...event,
    widthPx: event.widthPx ?? defaultWidthPx,
    importance: event.importance ?? "normal",
    category: event.category ?? "event",
  };
}

function buildClusteredCandidates(
  events: TimelineLayoutEventInput[],
  options: {
    clusterWidthPx: number;
    expandedClusterIds: Set<string>;
    input: TimelineLayoutInput;
    laneBudget: number;
    minGapPx: number;
    rangeClusterMinCount: number;
    zoomBucket: string;
  },
): MarkCandidate[] {
  const preliminaryMarks = buildPreliminaryMarks(events, options);
  const components = collectOverlapComponents(preliminaryMarks);
  const candidates: MarkCandidate[] = [];

  for (const component of components) {
    const componentEvents = sortEvents(component.flatMap((mark) => markEvents(mark, events)));
    const minTime = componentEvents[0]?.timestamp ?? 0;
    const maxTime = componentEvents[componentEvents.length - 1]?.timestamp ?? minTime;
    const shouldRangeCluster = (
      component.length > options.laneBudget
      && componentEvents.length >= options.rangeClusterMinCount
      && minTime < maxTime
    );

    if (shouldRangeCluster) {
      candidates.push(createRangeCluster(componentEvents, options));
    } else {
      candidates.push(...component);
    }
  }

  return sortCandidates(candidates);
}

function buildPreliminaryMarks(
  events: TimelineLayoutEventInput[],
  options: {
    clusterWidthPx: number;
    expandedClusterIds: Set<string>;
    input: TimelineLayoutInput;
    minGapPx: number;
    zoomBucket: string;
  },
): MarkCandidate[] {
  const marks: MarkCandidate[] = [];
  const eventsByTimestamp = new Map<number, TimelineLayoutEventInput[]>();

  for (const event of events) {
    const timestampEvents = eventsByTimestamp.get(event.timestamp) ?? [];
    timestampEvents.push(event);
    eventsByTimestamp.set(event.timestamp, timestampEvents);
  }

  for (const timestampEvents of eventsByTimestamp.values()) {
    const sorted = sortEvents(timestampEvents);
    if (sorted.length > 1) {
      marks.push(createSameTimeCluster(sorted, options));
    } else {
      marks.push(createEventMark(sorted[0], options.input, options.minGapPx));
    }
  }

  return sortCandidates(marks);
}

function createEventMark(
  event: TimelineLayoutEventInput,
  input: TimelineLayoutInput,
  minGapPx: number,
): MarkCandidate {
  const widthPx = event.widthPx ?? DEFAULT_MARK_WIDTH_PX;
  const xPx = timelineTimeToX(event.timestamp, input.renderDomain, input.viewportWidthPx);
  const halfWidthWithGap = (widthPx + minGapPx) / 2;
  return {
    kind: "event",
    id: stableMarkId("event", event.rowId, event.id),
    rowId: event.rowId,
    eventId: event.id,
    timestamp: event.timestamp,
    importance: event.importance ?? "normal",
    category: event.category ?? "event",
    xPx,
    widthPx,
    intervalStartPx: xPx - halfWidthWithGap,
    intervalEndPx: xPx + halfWidthWithGap,
  };
}

function createSameTimeCluster(
  events: TimelineLayoutEventInput[],
  options: {
    clusterWidthPx: number;
    expandedClusterIds: Set<string>;
    input: TimelineLayoutInput;
    minGapPx: number;
    zoomBucket: string;
  },
): MarkCandidate {
  const rowId = events[0].rowId;
  const timestamp = events[0].timestamp;
  const eventIds = events.map((event) => event.id).sort();
  const id = stableMarkId(
    "same_time_cluster",
    rowId,
    options.zoomBucket,
    String(timestamp),
    stableHash(eventIds.join("|")),
  );
  const xPx = timelineTimeToX(timestamp, options.input.renderDomain, options.input.viewportWidthPx);
  const halfWidthWithGap = (options.clusterWidthPx + options.minGapPx) / 2;

  return {
    kind: "same_time_cluster",
    id,
    rowId,
    timestamp,
    eventIds,
    count: eventIds.length,
    highestImportance: highestImportance(events),
    categorySummary: categorySummary(events),
    containsSelected: eventIds.includes(options.input.selectedEventId ?? ""),
    expanded: options.expandedClusterIds.has(id),
    xPx,
    widthPx: options.clusterWidthPx,
    intervalStartPx: xPx - halfWidthWithGap,
    intervalEndPx: xPx + halfWidthWithGap,
  };
}

function createRangeCluster(
  events: TimelineLayoutEventInput[],
  options: {
    clusterWidthPx: number;
    expandedClusterIds: Set<string>;
    input: TimelineLayoutInput;
    minGapPx: number;
    zoomBucket: string;
  },
): MarkCandidate {
  const rowId = events[0].rowId;
  const eventIds = events.map((event) => event.id).sort();
  const minTime = events[0].timestamp;
  const maxTime = events[events.length - 1].timestamp;
  const id = stableMarkId(
    "range_cluster",
    rowId,
    options.zoomBucket,
    String(minTime),
    String(maxTime),
    stableHash(eventIds.join("|")),
  );
  const xPx = timelineTimeToX(minTime, options.input.renderDomain, options.input.viewportWidthPx);
  const maxX = timelineTimeToX(maxTime, options.input.renderDomain, options.input.viewportWidthPx);
  const widthPx = Math.max(0, maxX - xPx);
  const halfGap = options.minGapPx / 2;

  return {
    kind: "range_cluster",
    id,
    rowId,
    minTime,
    maxTime,
    anchorTime: minTime,
    eventIds,
    count: eventIds.length,
    highestImportance: highestImportance(events),
    categorySummary: categorySummary(events),
    containsSelected: eventIds.includes(options.input.selectedEventId ?? ""),
    expanded: options.expandedClusterIds.has(id),
    xPx,
    widthPx,
    intervalStartPx: xPx - halfGap,
    intervalEndPx: maxX + halfGap,
  };
}

function packLanes(
  candidates: MarkCandidate[],
  laneBudget: number,
  previousLaneByMarkId: TimelineLaneCache,
): TimelineLayoutMark[] {
  const laneRightEdges = Array.from({ length: laneBudget }, () => Number.NEGATIVE_INFINITY);
  const packed: TimelineLayoutMark[] = [];

  for (const candidate of sortCandidates(candidates)) {
    const previousLane = previousLaneByMarkId[candidate.id];
    const lane = Number.isInteger(previousLane)
      && previousLane >= 0
      && previousLane < laneBudget
      && candidate.intervalStartPx >= laneRightEdges[previousLane]
      ? previousLane
      : firstFreeLane(candidate, laneRightEdges);

    if (lane < 0) {
      throw new Error(`Unable to place timeline mark ${candidate.id} within ${laneBudget} lanes`);
    }

    laneRightEdges[lane] = candidate.intervalEndPx;
    packed.push({ ...candidate, lane } as TimelineLayoutMark);
  }

  return packed;
}

function firstFreeLane(candidate: MarkCandidate, laneRightEdges: number[]): number {
  for (let lane = 0; lane < laneRightEdges.length; lane += 1) {
    if (candidate.intervalStartPx >= laneRightEdges[lane]) {
      return lane;
    }
  }
  return -1;
}

function collectOverlapComponents(candidates: MarkCandidate[]): MarkCandidate[][] {
  const components: MarkCandidate[][] = [];
  let current: MarkCandidate[] = [];
  let currentEnd = Number.NEGATIVE_INFINITY;

  for (const candidate of sortCandidates(candidates)) {
    if (current.length === 0 || candidate.intervalStartPx <= currentEnd) {
      current.push(candidate);
      currentEnd = Math.max(currentEnd, candidate.intervalEndPx);
    } else {
      components.push(current);
      current = [candidate];
      currentEnd = candidate.intervalEndPx;
    }
  }

  if (current.length > 0) {
    components.push(current);
  }

  return components;
}

function markEvents(
  mark: MarkCandidate,
  events: TimelineLayoutEventInput[],
): TimelineLayoutEventInput[] {
  if (mark.kind === "event") {
    return events.filter((event) => event.id === mark.eventId);
  }
  const eventIds = new Set(mark.eventIds);
  return events.filter((event) => eventIds.has(event.id));
}

function buildChronologicalOrder(
  marks: TimelineLayoutMark[],
  eventsByRow: Map<string, TimelineLayoutEventInput[]>,
): TimelineChronologicalOrderEntry[] {
  const markByEventId = new Map<string, TimelineLayoutMark>();
  for (const mark of marks) {
    if (mark.kind === "event") {
      markByEventId.set(mark.eventId, mark);
    } else {
      for (const eventId of mark.eventIds) {
        markByEventId.set(eventId, mark);
      }
    }
  }

  const entries: Omit<TimelineChronologicalOrderEntry, "order">[] = [];
  for (const [rowId, events] of eventsByRow) {
    for (const event of events) {
      const mark = markByEventId.get(event.id);
      if (!mark) {
        continue;
      }
      entries.push({
        rowId,
        eventId: event.id,
        timestamp: event.timestamp,
        markId: mark.id,
        markKind: mark.kind,
      });
    }
  }

  return entries
    .sort((left, right) => (
      left.timestamp - right.timestamp
      || left.rowId.localeCompare(right.rowId)
      || left.eventId.localeCompare(right.eventId)
    ))
    .map((entry, order) => ({ ...entry, order }));
}

function sortEvents(events: TimelineLayoutEventInput[]): TimelineLayoutEventInput[] {
  return [...events].sort((left, right) => (
    left.timestamp - right.timestamp
    || importanceRank(right.importance) - importanceRank(left.importance)
    || left.id.localeCompare(right.id)
  ));
}

function sortCandidates<T extends MarkCandidate>(candidates: T[]): T[] {
  return [...candidates].sort((left, right) => (
    left.intervalStartPx - right.intervalStartPx
    || markTime(left) - markTime(right)
    || importanceRank(markImportance(right)) - importanceRank(markImportance(left))
    || left.id.localeCompare(right.id)
  ));
}

function markTime(mark: MarkCandidate): number {
  if (mark.kind === "range_cluster") {
    return mark.minTime;
  }
  return mark.timestamp;
}

function markImportance(mark: MarkCandidate): TimelineImportance {
  if (mark.kind === "event") {
    return mark.importance;
  }
  return mark.highestImportance;
}

function highestImportance(events: TimelineLayoutEventInput[]): TimelineImportance {
  return events.reduce<TimelineImportance>((highest, event) => (
    importanceRank(event.importance) > importanceRank(highest) ? event.importance ?? "normal" : highest
  ), "routine");
}

function importanceRank(importance: TimelineImportance | undefined): number {
  return IMPORTANCE_RANK[importance ?? "normal"];
}

function categorySummary(events: TimelineLayoutEventInput[]): Record<string, number> {
  const summary: Record<string, number> = {};
  for (const event of events) {
    const category = event.category ?? "event";
    summary[category] = (summary[category] ?? 0) + 1;
  }
  return summary;
}

function stableMarkId(kind: string, ...parts: string[]): string {
  return ["timeline", kind, ...parts.map(sanitizeIdPart)].join(":");
}

function sanitizeIdPart(part: string): string {
  return part.replaceAll(/[^a-zA-Z0-9_.-]/g, "_");
}

function stableHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
