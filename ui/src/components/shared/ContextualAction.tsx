import type { ComponentChildren, JSX } from 'preact';
import { forwardRef } from 'preact/compat';

export type ContextualActionProps = Omit<JSX.HTMLAttributes<HTMLButtonElement>, 'className' | 'type'> & {
  children: ComponentChildren;
  className?: string;
  type?: 'button' | 'submit' | 'reset';
};

/** A bare icon action whose visibility is controlled by a contextual action owner/group. */
export const ContextualAction = forwardRef<HTMLButtonElement, ContextualActionProps>(function ContextualAction({
  children,
  className,
  type = 'button',
  ...buttonProps
}, ref): JSX.Element {
  return (
    <button
      {...buttonProps}
      ref={ref}
      type={type}
      className={`contextual-action${className ? ` ${className}` : ''}`}
    >
      {children}
    </button>
  );
});
