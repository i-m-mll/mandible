// Bug: 11f4f47 — Token/context usage indicator with compact and bar variants
import type { JSX } from 'preact/jsx-runtime';

const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  opus: 1_000_000,
  sonnet: 250_000,
  haiku: 200_000,
  'gemini-2.5-pro': 1_048_576,
  'gemini-3-flash-preview': 1_048_576,
  codex: 200_000,
};

function lookupContextWindow(modelName?: string): number {
  if (!modelName) return 200_000;
  const lower = modelName.toLowerCase();
  for (const [key, value] of Object.entries(MODEL_CONTEXT_WINDOWS)) {
    if (lower.includes(key)) return value;
  }
  return 200_000;
}

function formatTokenCount(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}K`;
  return String(count);
}

function severityColor(ratio: number): string {
  if (ratio > 0.5) return 'var(--accent-red)';
  if (ratio > 0.25) return 'var(--accent-yellow)';
  return 'var(--accent-green)';
}

type ContextIndicatorProps = {
  tokenCount: number;
  modelName?: string;
  variant: 'bar' | 'compact';
};

export function ContextIndicator({
  tokenCount = 0,
  modelName,
  variant,
}: ContextIndicatorProps): JSX.Element {
  const safeCount = tokenCount ?? 0;
  const contextWindow = lookupContextWindow(modelName);
  const ratio = contextWindow > 0 ? safeCount / contextWindow : 0;
  const color = severityColor(ratio);
  const pct = (ratio * 100).toFixed(1);

  if (variant === 'compact') {
    return (
      <span
        className="context-indicator context-indicator--compact"
        title={`${safeCount.toLocaleString()} / ${contextWindow.toLocaleString()} tokens (~${pct}%)`}
        style={{ color }}
      >
        ~{formatTokenCount(safeCount)}
      </span>
    );
  }

  return (
    <div
      className="context-indicator context-indicator--bar"
      title={`${safeCount.toLocaleString()} / ${contextWindow.toLocaleString()} tokens (~${pct}%)`}
    >
      <div
        className="context-indicator__fill"
        style={{
          width: `${Math.min(ratio * 100, 100)}%`,
          background: color,
        }}
      />
    </div>
  );
}
