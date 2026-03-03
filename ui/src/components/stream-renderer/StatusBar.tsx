// Bug: aa35aeb — Console tab renderer: streaming status bar

import type { StatusBarProps } from './types';

function formatCost(usd: number): string {
  if (usd < 0.001) {
    return '<$0.001';
  }
  return `$${usd.toFixed(4)}`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`;
  }
  return `${(ms / 1000).toFixed(1)}s`;
}

export function StatusBar({
  streaming,
  model,
  totalCostUsd,
  numTurns,
  durationMs,
  error,
}: StatusBarProps): JSX.Element {
  const dotClass = error
    ? 'status-bar__dot status-bar__dot--error'
    : streaming
      ? 'status-bar__dot status-bar__dot--streaming'
      : 'status-bar__dot status-bar__dot--done';

  const parts: string[] = [];
  if (numTurns !== undefined) {
    parts.push(`${numTurns} turn${numTurns === 1 ? '' : 's'}`);
  }
  if (totalCostUsd !== undefined) {
    parts.push(formatCost(totalCostUsd));
  }
  if (model) {
    parts.push(model);
  }

  const centerText = parts.join(' · ');
  const rightText = !streaming && durationMs !== undefined ? formatDuration(durationMs) : '';

  return (
    <div className="status-bar">
      <span className={dotClass} aria-hidden="true" />
      {error ? (
        <span className="status-bar__error">{error}</span>
      ) : streaming ? (
        <span className="status-bar__label">Streaming…</span>
      ) : (
        <span className="status-bar__label">Complete</span>
      )}
      {centerText && (
        <span className="status-bar__center">{centerText}</span>
      )}
      {rightText && (
        <span className="status-bar__right">{rightText}</span>
      )}
    </div>
  );
}
