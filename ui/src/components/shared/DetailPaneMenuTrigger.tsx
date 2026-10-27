import { appTip } from './AppHoverTips';
import type { JSX, Ref } from 'preact';

export type DetailPaneMenuTriggerProps = {
  buttonRef?: Ref<HTMLButtonElement>;
  label: string;
  title?: string;
  expanded: boolean;
  onClick: NonNullable<JSX.HTMLAttributes<HTMLButtonElement>['onClick']>;
};

export function DetailPaneMenuTrigger({
  buttonRef,
  label,
  title = label,
  expanded,
  onClick,
}: DetailPaneMenuTriggerProps): JSX.Element {
  return (
    <button
      ref={buttonRef}
      type="button"
      className="detail-pane-menu-trigger"
      aria-label={label}
      aria-haspopup="menu"
      aria-expanded={expanded}
      {...appTip(title)}
      onClick={onClick}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <circle cx="5" cy="12" r="1.5" />
        <circle cx="12" cy="12" r="1.5" />
        <circle cx="19" cy="12" r="1.5" />
      </svg>
    </button>
  );
}
