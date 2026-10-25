/**
 * Ordering and page assembly for Timeline projections, shared by the daemon,
 * which sorts each page, and the UI, which joins the pages of one request.
 * Sorting the joined pages with the same comparators reproduces the order a
 * single unpaged projection would have.
 */

type OrderedEvent = { timestamp: number; row_id: string; ordinal: number; id: string };
type OrderedLink = { created_at: number; id: string };

export type TimelineTimeAxisShape = { start: number | null; end: number | null; event_count: number };

type TimelinePageShape<Event extends OrderedEvent, Link extends OrderedLink> = {
  project: unknown;
  inputs: unknown;
  time_axis: TimelineTimeAxisShape;
  rows: ReadonlyArray<{ id: string }>;
  events: Event[];
  links: Link[];
  diagnostics: unknown;
  page: { row_offset: number; next_row_offset: number | null };
};

export function compareTimelineEvents(a: OrderedEvent, b: OrderedEvent): number {
  if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp;
  if (a.row_id !== b.row_id) return a.row_id.localeCompare(b.row_id);
  if (a.ordinal !== b.ordinal) return a.ordinal - b.ordinal;
  return a.id.localeCompare(b.id);
}

export function compareTimelineLinks(a: OrderedLink, b: OrderedLink): number {
  return a.created_at - b.created_at || a.id.localeCompare(b.id);
}

export function timelineTimeAxis(events: ReadonlyArray<{ timestamp: number }>): TimelineTimeAxisShape {
  if (events.length === 0) return { start: null, end: null, event_count: 0 };
  let start = Number.POSITIVE_INFINITY;
  let end = Number.NEGATIVE_INFINITY;
  for (const event of events) {
    if (event.timestamp < start) start = event.timestamp;
    if (event.timestamp > end) end = event.timestamp;
  }
  return { start, end, event_count: events.length };
}

/** Whether two pages were cut from the same row tree. */
export function sameTimelineRows(a: ReadonlyArray<{ id: string }>, b: ReadonlyArray<{ id: string }>): boolean {
  return a.length === b.length && a.every((row, index) => row.id === b[index].id);
}

/**
 * Join the pages of one Timeline request, first to last, into the projection
 * the rows describe. Every page must come from the same row tree.
 */
export function mergeTimelinePages<
  Event extends OrderedEvent,
  Link extends OrderedLink,
  Page extends TimelinePageShape<Event, Link>,
>(pages: readonly Page[]): Omit<Page, "page"> {
  const last = pages.at(-1);
  if (!last || last.page.next_row_offset !== null) {
    throw new Error("Timeline pages end before the last page");
  }
  const events = pages.flatMap((page) => page.events).sort(compareTimelineEvents);
  const links = pages.flatMap((page) => page.links).sort(compareTimelineLinks);
  const { page: _page, ...rest } = last;
  return {
    ...rest,
    time_axis: timelineTimeAxis(events),
    events,
    links,
  };
}
