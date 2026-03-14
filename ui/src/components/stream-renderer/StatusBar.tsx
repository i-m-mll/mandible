// Bug: aa35aeb — Console tab renderer: streaming status bar

import type { JSX } from 'preact/jsx-runtime';
import type { StatusBarProps } from './types';

function formatCost(usd: number): string {
  if (usd < 0.001) {
    return 'est. <$0.001';
  }
  return `est. $${usd.toFixed(4)}`;
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
  backend,
  totalCostUsd,
  numTurns,
  durationMs,
  error,
  elapsedSeconds,
  liveLabel,
  modelOptions,
  modelSaving,
  onChangeModel,
}: StatusBarProps): JSX.Element {
  const dotClass = error
    ? 'status-bar__dot status-bar__dot--error'
    : streaming
      ? 'status-bar__dot status-bar__dot--streaming'
      : 'status-bar__dot status-bar__dot--done';

  // Center: always show model; add cost + turns when available (post-result)
  const centerParts: string[] = [];
  if (numTurns !== undefined) {
    centerParts.push(`${numTurns} turn${numTurns === 1 ? '' : 's'}`);
  }
  if (totalCostUsd !== undefined) {
    centerParts.push(formatCost(totalCostUsd));
  }

  const centerText = centerParts.join(' · ');

  // Right: elapsed seconds while streaming; final duration after completion
  let rightText = '';
  if (streaming && elapsedSeconds !== undefined) {
    rightText = `${elapsedSeconds}s`;
  } else if (!streaming && durationMs !== undefined) {
    rightText = formatDuration(durationMs);
  }

  // Label text: streaming shows elapsed, error shows error, done shows Complete
  let labelContent: JSX.Element;
  if (error) {
    labelContent = <span className="status-bar__error">{error}</span>;
  } else if (streaming) {
    labelContent = (
      <span className="status-bar__label">
        {liveLabel ?? 'Working'}
      </span>
    );
  } else {
    labelContent = <span className="status-bar__label">Complete</span>;
  }

  return (
    <div className="status-bar">
      <span className={dotClass} aria-hidden="true" />
      {labelContent}
      {onChangeModel && backend === 'codex' ? (
        <button
          type="button"
          className="status-bar__model-button"
          onClick={() => {
            const next = window.prompt('Set model', model ?? '');
            if (next !== null) {
              void onChangeModel(next.trim());
            }
          }}
          disabled={modelSaving}
        >
          {modelSaving ? 'Saving…' : (model ?? 'default')}
        </button>
      ) : onChangeModel && modelOptions && modelOptions.length > 0 ? (
        <select
          className="status-bar__model-select"
          value={model ?? ''}
          onChange={(e) => { void onChangeModel(e.currentTarget.value); }}
          disabled={modelSaving}
        >
          <option value="">default</option>
          {modelOptions.map((option) => (
            <option key={option} value={option}>{option}</option>
          ))}
        </select>
      ) : model ? (
        <span className="status-bar__center">{model}</span>
      ) : null}
      {centerText && (
        <span className="status-bar__center">{centerText}</span>
      )}
      {rightText && (
        <span className="status-bar__right">{rightText}</span>
      )}
    </div>
  );
}
