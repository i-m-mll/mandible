import type { ComponentChildren } from 'preact';

export function ActivityPayloadBox({ children, className = '' }: {
  children: ComponentChildren;
  className?: string;
}): JSX.Element {
  return <div className={`activity-payload-box${className ? ` ${className}` : ''}`}>{children}</div>;
}
