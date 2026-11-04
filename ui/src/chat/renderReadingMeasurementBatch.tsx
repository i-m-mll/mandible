import { render } from 'preact';
import { MessageLinkContext } from '../components/shared/MessageActions';
import { ReadingRowView } from './ReadingRowView';
import type { ReadingContentProps } from './ReadingContent';
import type { ReadingRow } from './readingProjection';
import type { MeasurementRequest, MeasurementRow } from './readingMeasurement';

/** Uses the same frame/content as visible Chat; callers supply the same rendering props. */
export function createReadingRowBatchRenderer(
  props: (row: ReadingRow, ref?: MeasurementRow) => ReadingContentProps,
): MeasurementRequest<ReadingRow>['renderBatch'] {
  return (host, rows, _layout, refs) => {
    try {
      render(<>{rows.map((row, index) => {
        const rowProps = props(row, refs[index]);
        return <MessageLinkContext.Provider key={row.key} value={rowProps.onCopyMessageLink ?? null}><ReadingRowView {...rowProps} row={row} /></MessageLinkContext.Provider>;
      })}</>, host);
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

export { readingRowPrimaryActions, readingRowTurnId } from './readingRowActions';
