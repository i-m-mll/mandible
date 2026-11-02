import type { ComponentChildren } from 'preact';
import { useCallback, useLayoutEffect, useRef } from 'preact/hooks';
import type { VirtualItem } from '@tanstack/react-virtual';
import type { ReadingRow, ReadingTargetRegistration } from './readingProjection';
import type { MeasurementRow } from './readingMeasurement';
import { ReadingRowFrame } from './ReadingRowView';
import { readingPayloadKey } from './useCompleteReading';

/** Consecutive mounted rows share browser flow; only absent index ranges need geometry gaps. */
export function ReadingRowStrip({ items, endOffset, children }: { items: readonly VirtualItem[]; endOffset?: number; children: (item: VirtualItem) => ComponentChildren }) {
  return <div className="stream-renderer__row-strip" style={endOffset === undefined ? { transform: `translateY(${items[0]?.start ?? 0}px)` } : { top: 'auto', bottom: `${endOffset}px` }}>
    {items.flatMap((item, index) => {
      const previous = items[index - 1];
      const gap = previous && item.index > previous.index + 1
        ? <div key={`gap:${item.key}`} aria-hidden="true" style={{ height: `${Math.max(0, item.start - previous.end)}px` }} /> : null;
      return [gap, children(item)];
    })}
  </div>;
}

export function MeasuredReadingBox({ row, index, measurement, pendingHeight, reportHeight, register, registerRow, scope, space, children }: {
  row?: ReadingRow; index: number; measurement: MeasurementRow; pendingHeight: number;
  reportHeight: (row: MeasurementRow, height: number, width: number) => void;
  register: (target: ReadingTargetRegistration) => () => void;
  registerRow: (key: string, element: HTMLElement) => () => void;
  scope: string; space: string; children?: ComponentChildren;
}) {
  const element = useRef<HTMLDivElement | null>(null);
  const setNode = useCallback((node: HTMLDivElement | null) => { element.current = node; if (node) node.dataset.readingPayload = readingPayloadKey(measurement); }, [measurement]);
  useLayoutEffect(() => {
    const box = element.current;
    if (!box) return;
    const disposeRow = registerRow(measurement.key, box);
    if (!row) return disposeRow;
    const observer = new ResizeObserver(() => { const rect = box.getBoundingClientRect(); reportHeight(measurement, rect.height, rect.width); }); observer.observe(box);
    const dispose = row.sources.map(source => {
      if (source.position === undefined) return () => {};
      const exact = row.kind === 'activity-summary' ? box : [...box.querySelectorAll<HTMLElement>('[data-block-id]')].find(node => node.dataset.blockId === source.blockId) ?? null;
      if (exact && !exact.hasAttribute('tabindex')) exact.tabIndex = -1;
      const coordinate = { conversationId: scope, positionSpaceId: space, position: source.position };
      const clearDefault = row.activityGroup?.expanded ? () => {} : register({ rowKey: row.key, coordinate, element: exact });
      const clearSubtarget = register({ rowKey: row.key, coordinate: { ...coordinate, subtarget: row.kind === 'activity-summary' ? 'summary' : `source:${source.position}` }, element: exact });
      return () => { clearDefault(); clearSubtarget(); };
    });
    return () => { observer.disconnect(); disposeRow(); dispose.forEach(dispose => dispose()); };
  }, [row, scope, space, register, registerRow, children, measurement, reportHeight]);
  return <ReadingRowFrame row={row ?? measurement} index={index} busy={!row} style={row ? undefined : { height: `${pendingHeight}px` }} elementRef={setNode}>{children}</ReadingRowFrame>;
}
