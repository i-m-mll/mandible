import { AlignJustify, ChevronLeft, ChevronRight, Columns2, FileDiff, FileText, WrapText } from 'lucide-preact';
import type { MarkdownChangePosition } from '../MarkdownDocument';
import { DetailPaneIconAction } from './DetailPaneIconAction';

export function DocumentChangeActions({ shown, position, onToggle, onStep }: {
  shown: boolean;
  position: MarkdownChangePosition;
  onToggle(): void;
  onStep(direction: -1 | 1): void;
}) {
  return <>
    <DetailPaneIconAction label="Show changes" aria-pressed={shown} onClick={onToggle}>
      <FileDiff className="app-icon" aria-hidden="true" />
    </DetailPaneIconAction>
    {shown && position.total > 1 && <div className="detail-pane-header__change-position">
      <DetailPaneIconAction label="Previous change" onClick={() => onStep(-1)}>
        <ChevronLeft className="app-icon" aria-hidden="true" />
      </DetailPaneIconAction>
      <span aria-live="polite">{position.index} / {position.total}</span>
      <DetailPaneIconAction label="Next change" onClick={() => onStep(1)}>
        <ChevronRight className="app-icon" aria-hidden="true" />
      </DetailPaneIconAction>
    </div>}
  </>;
}

export type DocumentFileDiffView = { mode: 'unified' | 'split'; wholeFile: boolean; wrap: boolean };

export const defaultDocumentFileDiffView: DocumentFileDiffView = { mode: 'split', wholeFile: false, wrap: true };

export function DocumentFileDiffActions({ view, onChange, partial = false }: {
  view: DocumentFileDiffView;
  onChange(view: DocumentFileDiffView): void;
  partial?: boolean;
}) {
  return <>
    <DetailPaneIconAction label="Unified" aria-pressed={view.mode === 'unified'}
      onClick={() => onChange({ ...view, mode: 'unified' })}><AlignJustify className="app-icon" aria-hidden="true" /></DetailPaneIconAction>
    <DetailPaneIconAction label="Split" aria-pressed={view.mode === 'split'}
      onClick={() => onChange({ ...view, mode: 'split' })}><Columns2 className="app-icon" aria-hidden="true" /></DetailPaneIconAction>
    {!partial && <DetailPaneIconAction label="Whole file" aria-pressed={view.wholeFile}
      onClick={() => onChange({ ...view, wholeFile: !view.wholeFile })}><FileText className="app-icon" aria-hidden="true" /></DetailPaneIconAction>}
    <DetailPaneIconAction label="Wrap" aria-pressed={view.wrap}
      onClick={() => onChange({ ...view, wrap: !view.wrap })}><WrapText className="app-icon" aria-hidden="true" /></DetailPaneIconAction>
  </>;
}
