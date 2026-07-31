export const TIMELINE_SECOND_MS = 1000;
export const TIMELINE_MINUTE_MS = 60 * TIMELINE_SECOND_MS;
export const TIMELINE_HOUR_MS = 60 * TIMELINE_MINUTE_MS;
export const TIMELINE_DAY_MS = 24 * TIMELINE_HOUR_MS;

export type TimelineExtent = {
  start: number;
  end: number;
  eventCount: number;
};

export type TimelineViewport = {
  from: number;
  to: number;
};

export type TimelineRenderDomain = {
  start: number;
  end: number;
  extent: TimelineExtent;
  paddingStartMs: number;
  paddingEndMs: number;
};

export type TimelineTick = {
  timestamp: number;
  left: number;
  label: string;
  contextLabel: string | null;
  upperLabel: string | null;
  lowerLabel: string | null;
  interval: TimelineTickIntervalId;
  major: boolean;
};

export type TimelineTickIntervalId =
  | '1s'
  | '5s'
  | '15s'
  | '30s'
  | '1m'
  | '5m'
  | '15m'
  | '30m'
  | '1h'
  | '3h'
  | '6h'
  | '12h'
  | '1d'
  | '1w'
  | '1mo'
  | '3mo'
  | '1y';

export type TimelineScrollMetrics = {
  surfaceWidthPx: number;
  maxScrollLeftPx: number;
  scrollLeftPx: number;
  viewportWidthPx: number;
};

type TimelineTickInterval = {
  id: TimelineTickIntervalId;
  unit: 'second' | 'minute' | 'hour' | 'day' | 'week' | 'month' | 'year';
  step: number;
  approxMs: number;
};

const FALLBACK_NOW = Date.UTC(2026, 0, 1);
const DEFAULT_FALLBACK_SPAN_MS = 7 * TIMELINE_DAY_MS;
const DEFAULT_MIN_VIEWPORT_SPAN_MS = TIMELINE_HOUR_MS;
const DEFAULT_EDGE_PADDING_PX = 36;
const DEFAULT_TICK_SPACING_PX = 150;

const TICK_INTERVALS: TimelineTickInterval[] = [
  { id: '1s', unit: 'second', step: 1, approxMs: TIMELINE_SECOND_MS },
  { id: '5s', unit: 'second', step: 5, approxMs: 5 * TIMELINE_SECOND_MS },
  { id: '15s', unit: 'second', step: 15, approxMs: 15 * TIMELINE_SECOND_MS },
  { id: '30s', unit: 'second', step: 30, approxMs: 30 * TIMELINE_SECOND_MS },
  { id: '1m', unit: 'minute', step: 1, approxMs: TIMELINE_MINUTE_MS },
  { id: '5m', unit: 'minute', step: 5, approxMs: 5 * TIMELINE_MINUTE_MS },
  { id: '15m', unit: 'minute', step: 15, approxMs: 15 * TIMELINE_MINUTE_MS },
  { id: '30m', unit: 'minute', step: 30, approxMs: 30 * TIMELINE_MINUTE_MS },
  { id: '1h', unit: 'hour', step: 1, approxMs: TIMELINE_HOUR_MS },
  { id: '3h', unit: 'hour', step: 3, approxMs: 3 * TIMELINE_HOUR_MS },
  { id: '6h', unit: 'hour', step: 6, approxMs: 6 * TIMELINE_HOUR_MS },
  { id: '12h', unit: 'hour', step: 12, approxMs: 12 * TIMELINE_HOUR_MS },
  { id: '1d', unit: 'day', step: 1, approxMs: TIMELINE_DAY_MS },
  { id: '1w', unit: 'week', step: 1, approxMs: 7 * TIMELINE_DAY_MS },
  { id: '1mo', unit: 'month', step: 1, approxMs: 31 * TIMELINE_DAY_MS },
  { id: '3mo', unit: 'month', step: 3, approxMs: 92 * TIMELINE_DAY_MS },
  { id: '1y', unit: 'year', step: 1, approxMs: 366 * TIMELINE_DAY_MS },
];

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function isFiniteTimestamp(value: number): boolean {
  return Number.isFinite(value);
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

function dateParts(timestamp: number): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  millisecond: number;
} {
  const date = new Date(timestamp);
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth(),
    day: date.getUTCDate(),
    hour: date.getUTCHours(),
    minute: date.getUTCMinutes(),
    second: date.getUTCSeconds(),
    millisecond: date.getUTCMilliseconds(),
  };
}

function dateKey(timestamp: number): string {
  const parts = dateParts(timestamp);
  return `${parts.year}-${pad2(parts.month + 1)}-${pad2(parts.day)}`;
}

function monthLabel(timestamp: number): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    month: 'short',
    year: 'numeric',
  }).format(new Date(timestamp));
}

function dateLabel(timestamp: number): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    month: 'short',
    day: '2-digit',
  }).format(new Date(timestamp));
}

function normalizedExtentForDomain(
  extent: TimelineExtent,
  minSpanMs: number,
): { start: number; end: number; span: number } {
  const span = Math.max(0, extent.end - extent.start);
  if (span >= minSpanMs) {
    return { start: extent.start, end: extent.end, span };
  }
  const center = extent.eventCount > 0
    ? extent.start + span / 2
    : extent.start + Math.max(minSpanMs, span) / 2;
  const nextSpan = Math.max(minSpanMs, span || minSpanMs);
  return {
    start: center - nextSpan / 2,
    end: center + nextSpan / 2,
    span: nextSpan,
  };
}

function getInterval(id: TimelineTickIntervalId): TimelineTickInterval {
  const interval = TICK_INTERVALS.find((candidate) => candidate.id === id);
  if (!interval) throw new Error(`Unknown timeline tick interval: ${id}`);
  return interval;
}

function chooseTickInterval(spanMs: number, widthPx: number, targetSpacingPx: number): TimelineTickInterval {
  const targetCount = Math.max(1, Math.floor(Math.max(1, widthPx) / targetSpacingPx));
  const desiredMs = spanMs / targetCount;
  return TICK_INTERVALS.find((interval) => interval.approxMs >= desiredMs)
    ?? TICK_INTERVALS[TICK_INTERVALS.length - 1];
}

function floorUtc(timestamp: number, interval: TimelineTickInterval): number {
  const parts = dateParts(timestamp);
  if (interval.unit === 'year') {
    const year = Math.floor(parts.year / interval.step) * interval.step;
    return Date.UTC(year, 0, 1);
  }
  if (interval.unit === 'month') {
    const month = Math.floor(parts.month / interval.step) * interval.step;
    return Date.UTC(parts.year, month, 1);
  }
  if (interval.unit === 'week') {
    const dayStart = Date.UTC(parts.year, parts.month, parts.day);
    const day = new Date(dayStart).getUTCDay();
    return dayStart - day * TIMELINE_DAY_MS;
  }
  if (interval.unit === 'day') return Date.UTC(parts.year, parts.month, parts.day);
  if (interval.unit === 'hour') {
    const hour = Math.floor(parts.hour / interval.step) * interval.step;
    return Date.UTC(parts.year, parts.month, parts.day, hour);
  }
  if (interval.unit === 'minute') {
    const minute = Math.floor(parts.minute / interval.step) * interval.step;
    return Date.UTC(parts.year, parts.month, parts.day, parts.hour, minute);
  }
  const second = Math.floor(parts.second / interval.step) * interval.step;
  return Date.UTC(parts.year, parts.month, parts.day, parts.hour, parts.minute, second);
}

function addUtc(timestamp: number, interval: TimelineTickInterval): number {
  const parts = dateParts(timestamp);
  if (interval.unit === 'year') {
    return Date.UTC(parts.year + interval.step, 0, 1);
  }
  if (interval.unit === 'month') {
    return Date.UTC(parts.year, parts.month + interval.step, 1);
  }
  if (interval.unit === 'week') return timestamp + interval.step * 7 * TIMELINE_DAY_MS;
  if (interval.unit === 'day') return timestamp + interval.step * TIMELINE_DAY_MS;
  if (interval.unit === 'hour') return timestamp + interval.step * TIMELINE_HOUR_MS;
  if (interval.unit === 'minute') return timestamp + interval.step * TIMELINE_MINUTE_MS;
  return timestamp + interval.step * TIMELINE_SECOND_MS;
}

function tickLabel(timestamp: number, interval: TimelineTickInterval): string {
  const parts = dateParts(timestamp);
  if (interval.unit === 'year') return String(parts.year);
  if (interval.unit === 'month') return monthLabel(timestamp);
  if (interval.unit === 'week' || interval.unit === 'day') return dateLabel(timestamp);
  if (interval.unit === 'hour' || interval.unit === 'minute') {
    return `${pad2(parts.hour)}:${pad2(parts.minute)}`;
  }
  return `${pad2(parts.hour)}:${pad2(parts.minute)}:${pad2(parts.second)}`;
}

function tickContextLabel(
  timestamp: number,
  previousTimestamp: number | null,
  interval: TimelineTickInterval,
): string | null {
  if (interval.unit !== 'hour' && interval.unit !== 'minute' && interval.unit !== 'second') {
    return null;
  }
  if (previousTimestamp === null || dateKey(previousTimestamp) !== dateKey(timestamp)) {
    return formatUtcDate(timestamp);
  }
  return null;
}

function isDateLikeTickLabel(interval: TimelineTickInterval): boolean {
  return (
    interval.unit === 'year'
    || interval.unit === 'month'
    || interval.unit === 'week'
    || interval.unit === 'day'
  );
}

function isMajorTick(timestamp: number, interval: TimelineTickInterval): boolean {
  const parts = dateParts(timestamp);
  if (interval.unit === 'year') return true;
  if (interval.unit === 'month') return parts.month === 0;
  if (interval.unit === 'week' || interval.unit === 'day') return parts.day === 1;
  return parts.hour === 0 && parts.minute === 0 && parts.second === 0;
}

export function timelineExtentFromTimestamps(
  timestamps: readonly number[],
  options: { fallbackNow?: number; fallbackSpanMs?: number } = {},
): TimelineExtent {
  let start = Number.POSITIVE_INFINITY;
  let end = Number.NEGATIVE_INFINITY;
  let eventCount = 0;
  for (const timestamp of timestamps) {
    if (!isFiniteTimestamp(timestamp)) continue;
    start = Math.min(start, timestamp);
    end = Math.max(end, timestamp);
    eventCount += 1;
  }
  if (eventCount > 0) return { start, end, eventCount };
  const fallbackNow = options.fallbackNow ?? FALLBACK_NOW;
  const fallbackSpanMs = Math.max(1, options.fallbackSpanMs ?? DEFAULT_FALLBACK_SPAN_MS);
  return {
    start: fallbackNow - fallbackSpanMs,
    end: fallbackNow,
    eventCount: 0,
  };
}

export function paddedTimelineRenderDomain(
  extent: TimelineExtent,
  options: {
    viewportWidthPx?: number;
    edgePaddingPx?: number;
    minSpanMs?: number;
  } = {},
): TimelineRenderDomain {
  const viewportWidthPx = Math.max(1, options.viewportWidthPx ?? 800);
  const edgePaddingPx = clamp(options.edgePaddingPx ?? DEFAULT_EDGE_PADDING_PX, 0, viewportWidthPx / 2 - 0.5);
  const minSpanMs = Math.max(1, options.minSpanMs ?? TIMELINE_DAY_MS);
  const normalized = normalizedExtentForDomain(extent, minSpanMs);
  const denominatorPx = Math.max(1, viewportWidthPx - 2 * edgePaddingPx);
  const paddingMs = edgePaddingPx > 0
    ? (normalized.span * edgePaddingPx) / denominatorPx
    : 0;
  return {
    start: normalized.start - paddingMs,
    end: normalized.end + paddingMs,
    extent,
    paddingStartMs: paddingMs,
    paddingEndMs: paddingMs,
  };
}

export function fitTimelineViewport(domain: TimelineRenderDomain): TimelineViewport {
  return { from: domain.start, to: domain.end };
}

export function clampTimelineViewport(
  viewport: TimelineViewport,
  domain: TimelineRenderDomain,
  options: { minSpanMs?: number } = {},
): TimelineViewport {
  const domainStart = Math.min(domain.start, domain.end);
  const domainEnd = Math.max(domain.start, domain.end);
  const domainSpan = Math.max(1, domainEnd - domainStart);
  const minSpanMs = Math.min(domainSpan, Math.max(1, options.minSpanMs ?? DEFAULT_MIN_VIEWPORT_SPAN_MS));
  const inputFrom = Math.min(viewport.from, viewport.to);
  const inputTo = Math.max(viewport.from, viewport.to);
  const requestedSpan = Math.max(minSpanMs, inputTo - inputFrom);
  const nextSpan = Math.min(domainSpan, requestedSpan);
  let from = inputFrom;
  let to = from + nextSpan;
  if (to > domainEnd) {
    to = domainEnd;
    from = to - nextSpan;
  }
  if (from < domainStart) {
    from = domainStart;
    to = from + nextSpan;
  }
  return { from, to };
}

export function zoomTimelineViewport(
  viewport: TimelineViewport,
  domain: TimelineRenderDomain,
  factor: number,
  focalRatio = 0.5,
  options: { minSpanMs?: number } = {},
): TimelineViewport {
  const current = clampTimelineViewport(viewport, domain, options);
  const domainSpan = Math.max(1, domain.end - domain.start);
  const minSpanMs = Math.min(domainSpan, Math.max(1, options.minSpanMs ?? DEFAULT_MIN_VIEWPORT_SPAN_MS));
  const safeFactor = Number.isFinite(factor) && factor > 0 ? factor : 1;
  const currentSpan = Math.max(1, current.to - current.from);
  const nextSpan = clamp(currentSpan * safeFactor, minSpanMs, domainSpan);
  const ratio = clamp(focalRatio, 0, 1);
  const focal = current.from + currentSpan * ratio;
  return clampTimelineViewport(
    { from: focal - nextSpan * ratio, to: focal + nextSpan * (1 - ratio) },
    domain,
    { minSpanMs },
  );
}

export function timelineScrollMetrics(
  domain: TimelineRenderDomain,
  viewport: TimelineViewport,
  viewportWidthPx: number,
): TimelineScrollMetrics {
  const clampedViewport = clampTimelineViewport(viewport, domain);
  const safeViewportWidthPx = Math.max(1, viewportWidthPx);
  const domainSpan = Math.max(1, domain.end - domain.start);
  const viewportSpan = Math.max(1, clampedViewport.to - clampedViewport.from);
  const surfaceWidthPx = Math.max(safeViewportWidthPx, (safeViewportWidthPx * domainSpan) / viewportSpan);
  const maxScrollLeftPx = Math.max(0, surfaceWidthPx - safeViewportWidthPx);
  const scrollLeftPx = clamp(
    ((clampedViewport.from - domain.start) / domainSpan) * surfaceWidthPx,
    0,
    maxScrollLeftPx,
  );
  return {
    surfaceWidthPx,
    maxScrollLeftPx,
    scrollLeftPx,
    viewportWidthPx: safeViewportWidthPx,
  };
}

export function viewportFromTimelineScroll(
  domain: TimelineRenderDomain,
  scrollLeftPx: number,
  viewportSpanMs: number,
  viewportWidthPx: number,
): TimelineViewport {
  const domainSpan = Math.max(1, domain.end - domain.start);
  const span = clamp(viewportSpanMs, 1, domainSpan);
  const safeViewportWidthPx = Math.max(1, viewportWidthPx);
  const surfaceWidthPx = Math.max(safeViewportWidthPx, (safeViewportWidthPx * domainSpan) / span);
  const maxScrollLeftPx = Math.max(0, surfaceWidthPx - safeViewportWidthPx);
  const clampedScroll = clamp(scrollLeftPx, 0, maxScrollLeftPx);
  const from = domain.start + (clampedScroll / surfaceWidthPx) * domainSpan;
  return clampTimelineViewport({ from, to: from + span }, domain, { minSpanMs: 1 });
}

export function timelineAxisTransform(scrollLeftPx: number): string {
  const safeScrollLeftPx = Number.isFinite(scrollLeftPx) ? Math.max(0, scrollLeftPx) : 0;
  return `translateX(${-safeScrollLeftPx}px)`;
}

export function formatUtcDate(timestamp: number | null | undefined): string {
  if (timestamp === null || timestamp === undefined || !Number.isFinite(timestamp)) return '';
  const parts = dateParts(timestamp);
  return `${parts.year}-${pad2(parts.month + 1)}-${pad2(parts.day)}`;
}

export function formatUtcDateTime(timestamp: number | null | undefined): string {
  if (timestamp === null || timestamp === undefined || !Number.isFinite(timestamp)) return '';
  const parts = dateParts(timestamp);
  return [
    `${parts.year}-${pad2(parts.month + 1)}-${pad2(parts.day)}`,
    `${pad2(parts.hour)}:${pad2(parts.minute)}:${pad2(parts.second)}Z`,
  ].join(' ');
}

export function editTimelineViewportDateBoundary(
  viewport: TimelineViewport,
  boundary: 'from' | 'to',
  value: string,
): TimelineViewport {
  if (!value) return viewport;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return viewport;
  const year = Number(match[1]);
  const month = Number(match[2]) - 1;
  const day = Number(match[3]);
  const existing = dateParts(boundary === 'from' ? viewport.from : viewport.to);
  const timestamp = Date.UTC(
    year,
    month,
    day,
    existing.hour,
    existing.minute,
    existing.second,
    existing.millisecond,
  );
  if (Number.isNaN(timestamp)) return viewport;
  const parsed = dateParts(timestamp);
  if (parsed.year !== year || parsed.month !== month || parsed.day !== day) return viewport;
  return boundary === 'from'
    ? { ...viewport, from: timestamp }
    : { ...viewport, to: timestamp };
}

export function generateTimelineTicks(
  viewport: TimelineViewport,
  widthPx: number,
  options: {
    targetSpacingPx?: number;
    interval?: TimelineTickIntervalId;
  } = {},
): TimelineTick[] {
  const from = Math.min(viewport.from, viewport.to);
  const to = Math.max(viewport.from, viewport.to);
  const span = Math.max(1, to - from);
  const targetSpacingPx = Math.max(1, options.targetSpacingPx ?? DEFAULT_TICK_SPACING_PX);
  const interval = options.interval
    ? getInterval(options.interval)
    : chooseTickInterval(span, widthPx, targetSpacingPx);
  const ticks: TimelineTick[] = [];
  let timestamp = floorUtc(from, interval);
  if (timestamp < from) timestamp = addUtc(timestamp, interval);
  let previousTimestamp: number | null = null;
  let guard = 0;
  while (timestamp <= to && guard < 1000) {
    const label = tickLabel(timestamp, interval);
    const contextLabel = tickContextLabel(timestamp, previousTimestamp, interval);
    const dateLikeLabel = isDateLikeTickLabel(interval);
    ticks.push({
      timestamp,
      left: ((timestamp - from) / span) * 100,
      label,
      contextLabel,
      upperLabel: contextLabel ?? (dateLikeLabel ? label : null),
      lowerLabel: dateLikeLabel ? null : label,
      interval: interval.id,
      major: isMajorTick(timestamp, interval),
    });
    previousTimestamp = timestamp;
    timestamp = addUtc(timestamp, interval);
    guard += 1;
  }
  return ticks;
}
