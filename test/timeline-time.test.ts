import { describe, expect, it } from 'vitest';

import {
  TIMELINE_DAY_MS,
  TIMELINE_HOUR_MS,
  TIMELINE_MINUTE_MS,
  clampTimelineViewport,
  editTimelineViewportDateBoundary,
  fitTimelineViewport,
  formatUtcDate,
  formatUtcDateTime,
  generateTimelineTicks,
  paddedTimelineRenderDomain,
  timelineExtentFromTimestamps,
  timelineScrollMetrics,
  viewportFromTimelineScroll,
  zoomTimelineViewport,
} from '../ui/src/views/timeline-time';

describe('timeline time helpers', () => {
  it('builds a padded fit domain that keeps first and last anchors visible', () => {
    const first = Date.UTC(2026, 0, 1, 12);
    const last = Date.UTC(2026, 0, 11, 12);
    const extent = timelineExtentFromTimestamps([last, first]);
    const domain = paddedTimelineRenderDomain(extent, {
      viewportWidthPx: 1000,
      edgePaddingPx: 50,
    });
    const fit = fitTimelineViewport(domain);
    const span = fit.to - fit.from;
    const firstLeftPx = ((first - fit.from) / span) * 1000;
    const lastLeftPx = ((last - fit.from) / span) * 1000;

    expect(domain.start).toBeLessThan(first);
    expect(domain.end).toBeGreaterThan(last);
    expect(firstLeftPx).toBeCloseTo(50, 6);
    expect(lastLeftPx).toBeCloseTo(950, 6);
  });

  it('clamps zoomed windows to the padded domain without rounding away sub-day state', () => {
    const extent = timelineExtentFromTimestamps([
      Date.UTC(2026, 4, 21, 9, 15),
      Date.UTC(2026, 4, 24, 18, 45),
    ]);
    const domain = paddedTimelineRenderDomain(extent, { viewportWidthPx: 900 });
    const dayWindow = {
      from: Date.UTC(2026, 4, 22, 6, 30),
      to: Date.UTC(2026, 4, 22, 18, 30),
    };

    const zoomed = zoomTimelineViewport(dayWindow, domain, 0.01, 0.25, {
      minSpanMs: TIMELINE_HOUR_MS,
    });
    expect(zoomed.to - zoomed.from).toBe(TIMELINE_HOUR_MS);
    expect(zoomed.from).toBeGreaterThanOrEqual(domain.start);
    expect(zoomed.to).toBeLessThanOrEqual(domain.end);
    expect(formatUtcDateTime(zoomed.from)).toContain(':');

    const clamped = zoomTimelineViewport(dayWindow, domain, 100, 0.5);
    expect(clamped.from).toBe(domain.start);
    expect(clamped.to).toBe(domain.end);
  });

  it('maps max scroll exactly to the rendered domain edge', () => {
    const extent = timelineExtentFromTimestamps([
      Date.UTC(2026, 0, 1),
      Date.UTC(2026, 0, 31),
    ]);
    const domain = paddedTimelineRenderDomain(extent, { viewportWidthPx: 800 });
    const viewport = {
      from: domain.end - 5 * TIMELINE_DAY_MS,
      to: domain.end,
    };
    const clamped = clampTimelineViewport(viewport, domain);
    const metrics = timelineScrollMetrics(domain, clamped, 800);

    expect(metrics.scrollLeftPx).toBeCloseTo(metrics.maxScrollLeftPx, 6);

    const fromScroll = viewportFromTimelineScroll(
      domain,
      metrics.maxScrollLeftPx,
      clamped.to - clamped.from,
      800,
    );
    expect(fromScroll.to).toBeCloseTo(domain.end, 6);
  });

  it('preserves sub-day timestamps when editing date-only boundaries', () => {
    const viewport = {
      from: Date.UTC(2026, 4, 22, 6, 45, 30, 250),
      to: Date.UTC(2026, 4, 23, 17, 20, 10, 500),
    };

    const editedFrom = editTimelineViewportDateBoundary(viewport, 'from', '2026-05-25');
    expect(editedFrom.from).toBe(Date.UTC(2026, 4, 25, 6, 45, 30, 250));
    expect(editedFrom.to).toBe(viewport.to);

    const editedTo = editTimelineViewportDateBoundary(viewport, 'to', '2026-05-26');
    expect(editedTo.to).toBe(Date.UTC(2026, 4, 26, 17, 20, 10, 500));
    expect(editedTo.from).toBe(viewport.from);

    expect(editTimelineViewportDateBoundary(viewport, 'to', '2026-02-31')).toBe(viewport);
  });

  it('uses hour labels for day-scale ticks instead of repeated full dates', () => {
    const ticks = generateTimelineTicks(
      {
        from: Date.UTC(2026, 0, 2),
        to: Date.UTC(2026, 0, 3),
      },
      900,
    );

    expect(ticks.map((tick) => tick.interval)).toEqual(['6h', '6h', '6h', '6h', '6h']);
    expect(ticks.map((tick) => tick.label)).toEqual(['00:00', '06:00', '12:00', '18:00', '00:00']);
    expect(new Set(ticks.map((tick) => tick.label)).size).toBeGreaterThan(1);
    expect(ticks.every((tick) => !tick.label.includes('2026-01-'))).toBe(true);
    expect(ticks[0].contextLabel).toBe('2026-01-02');
    expect(ticks[4].contextLabel).toBe('2026-01-03');
  });

  it('keeps date-like labels in the upper tick slot and time labels in the lower slot', () => {
    const monthTicks = generateTimelineTicks(
      {
        from: Date.UTC(2026, 5, 1),
        to: Date.UTC(2026, 8, 1),
      },
      900,
      { interval: '1mo' },
    );
    expect(monthTicks[0].label).toBe('Jun 2026');
    expect(monthTicks[0].upperLabel).toBe('Jun 2026');
    expect(monthTicks[0].lowerLabel).toBeNull();
    expect(monthTicks.every((tick) => tick.lowerLabel === null)).toBe(true);

    const dayTicks = generateTimelineTicks(
      {
        from: Date.UTC(2026, 5, 1),
        to: Date.UTC(2026, 5, 3),
      },
      900,
      { interval: '1d' },
    );
    expect(dayTicks[0].upperLabel).toBe('Jun 01');
    expect(dayTicks[0].lowerLabel).toBeNull();

    const hourTicks = generateTimelineTicks(
      {
        from: Date.UTC(2026, 5, 1),
        to: Date.UTC(2026, 5, 1, 12),
      },
      900,
      { interval: '6h' },
    );
    expect(hourTicks[0].upperLabel).toBe('2026-06-01');
    expect(hourTicks[0].lowerLabel).toBe('00:00');
    expect(hourTicks[1].upperLabel).toBeNull();
    expect(hourTicks[1].lowerLabel).toBe('06:00');
  });

  it('falls back predictably for empty and single-event extents', () => {
    const fallbackNow = Date.UTC(2026, 6, 1);
    const empty = timelineExtentFromTimestamps([], {
      fallbackNow,
      fallbackSpanMs: 2 * TIMELINE_DAY_MS,
    });
    expect(empty).toEqual({
      start: Date.UTC(2026, 5, 29),
      end: fallbackNow,
      eventCount: 0,
    });

    const singleTimestamp = Date.UTC(2026, 6, 2, 14, 35);
    const single = timelineExtentFromTimestamps([singleTimestamp]);
    const domain = paddedTimelineRenderDomain(single, {
      viewportWidthPx: 600,
      minSpanMs: 2 * TIMELINE_HOUR_MS,
    });
    expect(single).toEqual({
      start: singleTimestamp,
      end: singleTimestamp,
      eventCount: 1,
    });
    expect(domain.start).toBeLessThan(singleTimestamp);
    expect(domain.end).toBeGreaterThan(singleTimestamp);
  });

  it('formats UTC dates without local timezone drift', () => {
    const timestamp = Date.UTC(2026, 2, 8, 1, 30);
    expect(formatUtcDate(timestamp)).toBe('2026-03-08');
    expect(formatUtcDateTime(timestamp)).toBe('2026-03-08 01:30:00Z');

    const ticks = generateTimelineTicks(
      {
        from: Date.UTC(2026, 2, 8, 1),
        to: Date.UTC(2026, 2, 8, 3),
      },
      600,
      { interval: '30m' },
    );
    expect(ticks.map((tick) => tick.label)).toEqual([
      '01:00',
      '01:30',
      '02:00',
      '02:30',
      '03:00',
    ]);
  });

  it('can generate close-view minute ticks', () => {
    const ticks = generateTimelineTicks(
      {
        from: Date.UTC(2026, 0, 1, 12),
        to: Date.UTC(2026, 0, 1, 12, 45),
      },
      900,
    );
    expect(ticks.every((tick) => tick.interval === '15m')).toBe(true);
    expect(ticks.map((tick) => tick.label)).toEqual(['12:00', '12:15', '12:30', '12:45']);
  });

  it('exports the minute constant for callers that need exact UTC durations', () => {
    expect(TIMELINE_MINUTE_MS).toBe(60_000);
  });
});
