import type { JSX } from 'preact/jsx-runtime';
import { useEffect, useRef } from 'preact/hooks';

export type QueuedPrompt = {
  id: string;
  text: string;
};

export type ComposerUsage = {
  inputTokens?: number;
  outputTokens?: number;
  cacheTokens?: number;
  totalTokens?: number;
  contextTokens?: number;
  costUsd?: number;
};

type ComposerProps = {
  prompt: string;
  disabled: boolean;
  streaming: boolean;
  queuedPrompts: QueuedPrompt[];
  transportLabel: string;
  transportTitle?: string;
  usage?: ComposerUsage;
  modelSlot?: JSX.Element | null;
  attentionSlot?: JSX.Element | null;
  canStop: boolean;
  stopBusy?: boolean;
  onPromptChange: (value: string) => void;
  onQueuedPromptRemove: (id: string) => void;
  onSubmit: (event: JSX.TargetedEvent<HTMLFormElement, Event>) => void;
  onStop: () => void;
};

function textareaIsComposing(event: JSX.TargetedKeyboardEvent<HTMLTextAreaElement>): boolean {
  const nativeEvent = event.nativeEvent as KeyboardEvent & { isComposing?: boolean };
  return event.isComposing === true || nativeEvent.isComposing === true;
}

function summarizeText(text: string): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  return compact.length > 96 ? `${compact.slice(0, 93)}...` : compact;
}

function usageSummary(usage: ComposerUsage | undefined): string | null {
  if (!usage) return null;
  const parts: string[] = [];
  if (usage.totalTokens !== undefined && usage.totalTokens > 0) {
    parts.push(`${usage.totalTokens.toLocaleString()} tokens`);
  }
  if (usage.contextTokens !== undefined && usage.contextTokens > 0) {
    parts.push(`${usage.contextTokens.toLocaleString()} context`);
  }
  return parts.length > 0 ? parts.join(' / ') : null;
}

export function Composer({
  prompt,
  disabled,
  streaming,
  queuedPrompts,
  transportLabel,
  transportTitle,
  usage,
  modelSlot,
  attentionSlot,
  canStop,
  stopBusy = false,
  onPromptChange,
  onQueuedPromptRemove,
  onSubmit,
  onStop,
}: ComposerProps): JSX.Element {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const summary = usageSummary(usage);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = 'auto';
    const nextHeight = Math.min(textarea.scrollHeight, 240);
    textarea.style.height = `${Math.max(42, nextHeight)}px`;
    textarea.style.overflowY = textarea.scrollHeight > nextHeight ? 'auto' : 'hidden';
  }, [prompt]);

  return (
    <div className="composer-host">
      <div className="composer-attention-strip" data-empty={!attentionSlot}>
        {attentionSlot}
      </div>

      <form className="composer" onSubmit={onSubmit}>
        {queuedPrompts.length > 0 && (
          <div className="composer__queue" aria-label="Queued messages">
            {queuedPrompts.map((item, index) => (
              <span key={item.id} className="composer__queue-chip">
                <span className="composer__queue-index">{index + 1}</span>
                <span className="composer__queue-text">{summarizeText(item.text)}</span>
                <button
                  type="button"
                  className="composer__queue-remove"
                  aria-label={`Remove queued message ${index + 1}`}
                  onClick={() => onQueuedPromptRemove(item.id)}
                >
                  x
                </button>
              </span>
            ))}
          </div>
        )}

        <div className="composer__meta-row">
          <div className="composer__meta-left">
            {modelSlot}
            <span className="composer__transport-badge" title={transportTitle}>
              {transportLabel}
            </span>
          </div>
          <div className="composer__meta-right">
            {summary && (
              <details className="composer__usage">
                <summary>{summary}</summary>
                <div className="composer__usage-popover">
                  {usage?.inputTokens !== undefined && <span>Input: {usage.inputTokens.toLocaleString()}</span>}
                  {usage?.outputTokens !== undefined && <span>Output: {usage.outputTokens.toLocaleString()}</span>}
                  {usage?.cacheTokens !== undefined && <span>Cache: {usage.cacheTokens.toLocaleString()}</span>}
                  {usage?.contextTokens !== undefined && <span>Context: {usage.contextTokens.toLocaleString()}</span>}
                  {usage?.costUsd !== undefined && usage.costUsd > 0 && <span>Cost: ${usage.costUsd.toFixed(4)}</span>}
                </div>
              </details>
            )}
          </div>
        </div>

        <div className="composer__input-row">
          <button
            type="button"
            className="composer__mention"
            aria-label="Mention context"
            title="Mention context"
            disabled
          >
            @
          </button>
          <textarea
            ref={textareaRef}
            className="composer__textarea"
            value={prompt}
            rows={1}
            placeholder={streaming ? 'Queue the next message...' : 'Send a message to the agent...'}
            disabled={disabled}
            aria-label="Message"
            onInput={(event) => onPromptChange(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.currentTarget.blur();
                return;
              }
              if (event.key !== 'Enter' || event.shiftKey || textareaIsComposing(event)) {
                return;
              }
              event.preventDefault();
              event.currentTarget.form?.requestSubmit();
            }}
          />
          {canStop && streaming && (
            <button
              type="button"
              className="composer__button composer__button--stop"
              disabled={stopBusy}
              aria-label="Stop current response"
              onClick={onStop}
            >
              Stop
            </button>
          )}
          <button
            type="submit"
            className="composer__button composer__button--send"
            disabled={!prompt.trim() || disabled}
            aria-label={streaming ? 'Queue message' : 'Send message'}
          >
            {streaming ? 'Queue' : 'Send'}
          </button>
        </div>
      </form>
    </div>
  );
}
