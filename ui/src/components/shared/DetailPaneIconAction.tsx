import { forwardRef } from 'preact/compat';
import type { ComponentChildren, JSX } from 'preact';
import { appTip } from './AppHoverTips';

type DetailPaneIconActionProps = Omit<JSX.ButtonHTMLAttributes<HTMLButtonElement>, 'type'> & {
  label: string;
  tip?: string;
  children: ComponentChildren;
};

export const DetailPaneIconAction = forwardRef<HTMLButtonElement, DetailPaneIconActionProps>(
  function DetailPaneIconAction({ label, tip = label, children, className, ...props }, ref) {
    return <button {...props} ref={ref} type="button" aria-label={label} {...appTip(tip)}
      className={`detail-pane-menu-trigger${className ? ` ${className}` : ''}`}>{children}</button>;
  },
);
