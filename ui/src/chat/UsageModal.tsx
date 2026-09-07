import type { JSX } from 'preact/jsx-runtime';
import type { ChatUsageSummary } from './contextUsage';
import { getContextSeverity } from './contextUsage';

export function UsageModal({
  usage,
  titleId,
  onClose,
}: {
  usage: ChatUsageSummary | undefined;
  titleId: string;
  onClose: () => void;
}): JSX.Element {
  return (
    <div className="usage-modal">
      <div className="usage-modal__header">
        <h2 id={titleId}>Usage</h2>
        <button type="button" className="usage-modal__close" aria-label="Close usage" onClick={onClose}>
          x
        </button>
      </div>

      {usage?.context && (
        <section className="usage-modal__section">
          <div className="usage-modal__section-head">
            <span>Current context</span>
            <strong>{usage.context.percent === undefined
              ? 'Unavailable'
              : `${usage.context.precision === 'approximate' ? '~' : ''}${Math.round(usage.context.percent)}%`}</strong>
          </div>
          {usage.context.percent !== undefined && (
            <div
              className={`usage-modal__bar usage-modal__bar--${getContextSeverity(usage.context.percent)}`}
              aria-hidden="true"
            >
              <span style={{ width: `${Math.round(usage.context.percent)}%` }} />
            </div>
          )}
          <div className="usage-modal__facts">
            {usage.context.usedTokens !== undefined && <span>{usage.context.usedTokens.toLocaleString()} used</span>}
            {usage.context.windowTokens !== undefined && <span>{usage.context.windowTokens.toLocaleString()} window</span>}
            <span>{usage.context.precision === 'unavailable'
              ? 'Occupancy unknown'
              : usage.context.precision === 'approximate' ? 'Approximate' : 'Exact'}</span>
          </div>
          {usage.context.reason && <div className="usage-modal__reset">{usage.context.reason}</div>}
        </section>
      )}

      {usage?.rateLimits.length ? (
        <section className="usage-modal__section">
          <div className="usage-modal__section-head">
            <span>Rate limits</span>
          </div>
          <div className="usage-modal__limit-list">
            {usage.rateLimits.map((limit) => (
              <div key={limit.label} className="usage-modal__limit">
                <div className="usage-modal__limit-row">
                  <span>{limit.label}</span>
                  <strong>{Math.round(limit.usedPercent)}%</strong>
                </div>
                <div
                  className={`usage-modal__bar usage-modal__bar--${getContextSeverity(limit.usedPercent)}`}
                  aria-hidden="true"
                >
                  <span style={{ width: `${Math.round(limit.usedPercent)}%` }} />
                </div>
                {limit.resetsAt && <div className="usage-modal__reset">Resets {formatTime(limit.resetsAt)}</div>}
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {usage?.accounting.map((accounting) => (
        <section className="usage-modal__section" key={`${accounting.scope}:${accounting.label}`}>
          <div className="usage-modal__section-head">
            <span>{accounting.label}</span>
          </div>
          <div className="usage-modal__grid">
            <Metric label="Input" value={accounting.inputTokens} />
            <Metric label="Output" value={accounting.outputTokens} />
            <Metric label="Cached input" value={accounting.cachedInputTokens} />
            <Metric label="Reasoning output" value={accounting.reasoningOutputTokens} />
            <Metric label="Cache read" value={accounting.cacheReadTokens} />
            <Metric label="Cache write" value={accounting.cacheCreationTokens} />
            <Metric label="Total" value={accounting.totalTokens} />
            {accounting.costUsd !== undefined && (
              <div className="usage-modal__metric">
                <span>Cost</span>
                <strong>${accounting.costUsd.toFixed(4)}</strong>
              </div>
            )}
          </div>
        </section>
      ))}

      <div className="usage-modal__footer">
        <span>{usage?.sourceLabel ?? 'No usage data'}</span>
        {usage?.updatedAt && <span>Updated {formatAge(usage.updatedAt)}</span>}
      </div>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: number | undefined }): JSX.Element | null {
  if (value === undefined) return null;
  return (
    <div className="usage-modal__metric">
      <span>{label}</span>
      <strong>{value.toLocaleString()}</strong>
    </div>
  );
}

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : value;
}

function formatAge(timestamp: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 10) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.round(minutes / 60)}h ago`;
}
