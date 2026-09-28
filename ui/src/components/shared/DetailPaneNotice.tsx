import type { ComponentChildren } from 'preact';
import { createPortal } from 'preact/compat';
import { useId } from 'preact/hooks';
import { useAppShell } from '../../app-shell';

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
  /** Stable producer identity for the operational notice lifecycle. */
  source?: string;
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

/** Operational notices render in the app workspace's single anchored outlet. */
export function DetailPaneNotice({
  severity,
  density = 'default',
  title,
  children,
  actions,
  className,
  testId,
  source,
}: DetailPaneNoticeProps): JSX.Element | null {
  const { active, noticeHost } = useAppShell();
  const generatedSource = useId();
  const semantic = semantics[severity];
  const notice = (
    <div
      className={classNames(
        'detail-pane-notice',
        `detail-pane-notice--${severity}`,
        density === 'compact' ? 'detail-pane-notice--compact' : undefined,
        className,
      )}
      data-severity={severity}
      data-testid={testId}
      data-notice-source={source ?? generatedSource}
      role={semantic.role}
      aria-live={semantic.live}
      aria-atomic="true"
    >
      <div className="detail-pane-notice__content">
        {title !== undefined && title !== null ? (
          <strong className="detail-pane-notice__title">{title}</strong>
        ) : null}
        <div className="detail-pane-notice__body">{children}</div>
      </div>
      {actions !== undefined && actions !== null ? (
        <div className="detail-pane-notice__actions">{actions}</div>
      ) : null}
    </div>
  );
  if (!active) return null;
  if (source !== undefined || severity === 'error' || severity === 'warning') {
    return noticeHost ? createPortal(notice, noticeHost) : null;
  }
  return notice;
}
