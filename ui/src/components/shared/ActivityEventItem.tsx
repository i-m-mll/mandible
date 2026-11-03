import type { ComponentChildren } from 'preact';

/** One event owns the inset around its header and complete payload. */
export function ActivityEventItem({ header, children }: { header?: ComponentChildren; children?: ComponentChildren }): JSX.Element {
  return <div className={`activity-event-item${children != null ? ' activity-event-item--with-payload' : ''}`}>
    {header != null && <div className="activity-event-item__header">{header}</div>}
    {children}
  </div>;
}
