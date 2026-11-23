import { ChevronLeft, ChevronRight, FileDiff } from 'lucide-preact';
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
