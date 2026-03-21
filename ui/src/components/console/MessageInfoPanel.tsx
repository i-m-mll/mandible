// Bug: 60b1fd7 — P5: Sidebar info panel showing per-message metadata

import type { JSX } from 'preact/jsx-runtime';
import type { AssistantEvent, StreamEvent } from '../stream-renderer/types';

export type MessageInfoPanelProps = {
  selectedMessageId: string | null;
  streamEvents: StreamEvent[];
};

/** Find the AssistantEvent matching a turn ID (uuid or message.id). */
function findAssistantEvent(
  events: StreamEvent[],
  turnId: string,
): AssistantEvent | null {
  for (const event of events) {
    if (event.type !== 'assistant') continue;
    const ae = event as AssistantEvent;
    const id = ae.uuid ?? ae.message?.id;
    if (id === turnId) return ae;
  }
  return null;
}

export function MessageInfoPanel({
  selectedMessageId,
  streamEvents,
}: MessageInfoPanelProps): JSX.Element {
  if (!selectedMessageId) {
    return (
      <div className="message-info-panel">
        <div className="message-info-panel__empty">
          Select a message to view its metadata.
        </div>
      </div>
    );
  }

  const assistant = findAssistantEvent(streamEvents, selectedMessageId);
  if (!assistant) {
    return (
      <div className="message-info-panel">
        <div className="message-info-panel__empty">
          Message not found in stream events.
        </div>
      </div>
    );
  }

  const msg = assistant.message;
  const usage = msg.usage;
  const blocks = msg.content;

  // Content block summary: count per type
  const blockCounts = new Map<string, number>();
  for (const block of blocks) {
    blockCounts.set(block.type, (blockCounts.get(block.type) ?? 0) + 1);
  }

  // Collect tool names
  const toolNames: string[] = [];
  for (const block of blocks) {
    if (block.type === 'tool_use') {
      toolNames.push(block.name);
    }
  }

  return (
    <div className="message-info-panel">
      {/* Model */}
      {msg.model && (
        <div className="message-info-panel__section">
          <span className="message-info-panel__label">Model</span>
          <span className="message-info-panel__value">{msg.model}</span>
        </div>
      )}

      {/* Stop reason */}
      {msg.stop_reason && (
        <div className="message-info-panel__section">
          <span className="message-info-panel__label">Stop reason</span>
          <span className="message-info-panel__value">{msg.stop_reason}</span>
        </div>
      )}

      {/* Token usage */}
      {usage && (
        <div className="message-info-panel__section">
          <span className="message-info-panel__label">Tokens</span>
          <span className="message-info-panel__value">
            {usage.input_tokens.toLocaleString()} in / {usage.output_tokens.toLocaleString()} out
            {' '}({(usage.input_tokens + usage.output_tokens).toLocaleString()} total)
          </span>
        </div>
      )}

      {/* Content blocks */}
      <div className="message-info-panel__section">
        <span className="message-info-panel__label">Content blocks</span>
        <span className="message-info-panel__value">
          {Array.from(blockCounts.entries())
            .map(([type, count]) => `${count} ${type}`)
            .join(', ')}
        </span>
      </div>

      {/* Tool names */}
      {toolNames.length > 0 && (
        <div className="message-info-panel__section">
          <span className="message-info-panel__label">Tools</span>
          <div className="message-info-panel__tools">
            {toolNames.map((name, i) => (
              <span key={`${name}-${i}`} className="message-info-panel__tool-pill">
                {name}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Message ID */}
      <div className="message-info-panel__section">
        <span className="message-info-panel__label">Message ID</span>
        <span className="message-info-panel__value message-info-panel__value--mono">
          {selectedMessageId}
        </span>
      </div>
    </div>
  );
}
