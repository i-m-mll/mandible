import type { JSX, Ref } from 'preact';
import { Icon } from '../icons/Icon';
import { DetailPaneIconAction } from './DetailPaneIconAction';

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
  return <DetailPaneIconAction ref={buttonRef} label={label} tip={title}
    aria-haspopup="menu" aria-expanded={expanded} onClick={onClick}><Icon name="more" /></DetailPaneIconAction>;
}
