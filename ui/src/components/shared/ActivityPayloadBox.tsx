import type { JSX } from 'preact';

export function ActivityPayloadBox({ children, className = '', ...attributes }: JSX.HTMLAttributes<HTMLDivElement>): JSX.Element {
  return <div {...attributes} className={`activity-payload-box${className ? ` ${className}` : ''}`}>{children}</div>;
}
