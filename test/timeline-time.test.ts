import { describe, expect, it } from 'vitest';

import { TIMELINE_DAY_MS, TIMELINE_HOUR_MS, clampTimelineViewport, editTimelineViewportDateBoundary, formatUtcDate, formatUtcDateTime, generateTimelineTicks, paddedTimelineRenderDomain, timelineExtentFromTimestamps, timelineScrollMetrics, viewportFromTimelineScroll, zoomTimelineViewport } from '../ui/src/views/timeline-time';

describe('timeline time helpers', () => {

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
});
