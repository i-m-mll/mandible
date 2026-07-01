import './PreviewDisabledNotice.css';

export type PreviewDisabledNoticeProps = {
  title: string;
  children: JSX.Element | string;
  className?: string;
  testId?: string;
};

export function PreviewDisabledNotice({
  title,
  children,
  className = '',
  testId = 'preview-disabled-notice',
}: PreviewDisabledNoticeProps): JSX.Element {
  const classes = ['preview-disabled-notice', className].filter(Boolean).join(' ');
  return (
    <div className={classes} data-testid={testId} role="status">
      <strong className="preview-disabled-notice__title">{title}</strong>
      <span className="preview-disabled-notice__body">{children}</span>
    </div>
  );
}

export default PreviewDisabledNotice;
