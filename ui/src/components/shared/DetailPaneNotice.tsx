import type { ComponentChildren } from 'preact';

import './DetailPaneNotice.css';

export type DetailPaneNoticeSeverity = 'info' | 'success' | 'warning' | 'error';
export type DetailPaneNoticeDensity = 'default' | 'compact';

export type DetailPaneNoticeProps = {
  severity: DetailPaneNoticeSeverity;
  density?: DetailPaneNoticeDensity;
  title?: ComponentChildren;
  children: ComponentChildren;
  actions?: ComponentChildren;
  className?: string;
  testId?: string;
};

const semantics: Record<DetailPaneNoticeSeverity, { role: 'status' | 'alert'; live: 'polite' | 'assertive' }> = {
  info: { role: 'status', live: 'polite' },
  success: { role: 'status', live: 'polite' },
  warning: { role: 'status', live: 'polite' },
  error: { role: 'alert', live: 'assertive' },
};

function classNames(...values: Array<string | undefined>): string {
  return values.filter(Boolean).join(' ');
}

/** A typed notice anchored above a detail or main region's scrolling body. */
export function DetailPaneNotice({
  severity,
  density = 'default',
  title,
  children,
  actions,
  className,
  testId,
}: DetailPaneNoticeProps): JSX.Element {
  const semantic = semantics[severity];
  return (
    <div
      className={classNames(
        'detail-pane-notice',
        `detail-pane-notice--${severity}`,
        density === 'compact' ? 'detail-pane-notice--compact' : undefined,
        className,
      )}
      data-severity={severity}
      data-testid={testId}
      role={semantic.role}
      aria-live={semantic.live}
      aria-atomic="true"
    >
      <div className="detail-pane-notice__content">
        {title !== undefined && title !== null ? (
          <strong className="detail-pane-notice__title">{title}</strong>
        ) : null}
        <span className="detail-pane-notice__body">{children}</span>
      </div>
      {actions !== undefined && actions !== null ? (
        <div className="detail-pane-notice__actions">{actions}</div>
      ) : null}
    </div>
  );
}

