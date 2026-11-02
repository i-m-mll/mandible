import { render } from 'preact';
import { ReadingRowView } from './ReadingRowView';
import type { ReadingContentProps } from './ReadingContent';
import type { ReadingRow } from './readingProjection';
import type { MeasurementRequest } from './readingMeasurement';

/** Uses the same frame/content as visible Chat; callers supply the same rendering props. */
export function createReadingRowBatchRenderer(
  props: (row: ReadingRow) => ReadingContentProps,
): MeasurementRequest<ReadingRow>['renderBatch'] {
  return (host, rows) => {
    try {
      render(<>{rows.map(row => <ReadingRowView key={row.key} {...props(row)} row={row} />)}</>, host);
    } catch (error) {
      render(null, host);
      throw error;
    }
    const elements = new Map<string, HTMLElement>();
    for (const element of host.children) {
      if (!(element instanceof HTMLElement)) continue;
      // Absolute rows share the visible canvas width without accumulating a giant layout tree.
      elements.set(element.dataset.readingKey!, element);
    }
    return { elements, dispose: () => render(null, host) };
  };
}
