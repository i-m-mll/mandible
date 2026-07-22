export function LoadingSkeleton({
  variant,
  label,
  announce = true,
}: {
  variant: 'tab' | 'canvas' | 'detail';
  label: string;
  announce?: boolean;
}): JSX.Element {
  return (
    <div
      className={`loading-skeleton loading-skeleton--${variant}`}
      role={announce ? 'status' : undefined}
      aria-label={announce ? label : undefined}
      aria-hidden={announce ? undefined : 'true'}
    >
      {announce ? <span className="sr-only">{label}</span> : null}
      <div className="loading-skeleton__sidebar" aria-hidden="true">
        <i /><i /><i /><i />
      </div>
      <div className="loading-skeleton__surface" aria-hidden="true">
        <b /><span /><span /><span /><span />
      </div>
    </div>
  );
}
