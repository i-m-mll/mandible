import { Icon } from '../icons/Icon';
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
      <Icon name="more" />
    </button>
  );
}
