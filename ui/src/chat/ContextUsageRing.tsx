import type { JSX } from 'preact/jsx-runtime';
import type { ChatUsageSummary, ContextUsage } from './contextUsage';
import { getContextSeverity } from './contextUsage';

type ContextUsageRingProps = {
  usage: ChatUsageSummary | undefined;
  size?: 'sm' | 'md';
  onClick?: () => void;
};

export function ContextUsageRing({ usage, size = 'md', onClick }: ContextUsageRingProps): JSX.Element | null {
  const context = usage?.context;
  if (!context) return null;
  const severity = getContextSeverity(context.percent);
  const label = ringLabel(context);
  const title = tooltipText(context, usage);
  return (
    <button
      type="button"
      className={`context-usage context-usage--${size} context-usage--${severity}`}
      title={title}
      aria-label={title}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

function ringLabel(context: ContextUsage): string {
  const percent = Math.round(context.percent);
  return context.approximate ? `~${percent}%` : `${percent}%`;
}

function tooltipText(context: ContextUsage, usage: ChatUsageSummary): string {
  const parts = [
    `${ringLabel(context)} context`,
    context.usedTokens !== undefined ? `${context.usedTokens.toLocaleString()} used` : null,
    context.windowTokens !== undefined ? `${context.windowTokens.toLocaleString()} window` : null,
    usage.sourceLabel,
    usage.updatedAt ? `updated ${formatAge(usage.updatedAt)}` : null,
  ].filter(Boolean);
  return parts.join(' · ');
}

function formatAge(timestamp: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 10) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.round(minutes / 60)}h ago`;
}
