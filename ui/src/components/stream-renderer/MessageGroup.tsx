// Bug: aa35aeb — Console tab renderer: one message group per assistant turn

import type { ContentBlock, MessageGroupProps, ToolResultContentBlock } from './types';
import { TextBlock } from './TextBlock';
import { ThinkingBlock } from './ThinkingBlock';
import { ToolUseBlock } from './ToolUseBlock';

export function MessageGroup({ turn, isStreaming, isThinking }: MessageGroupProps): JSX.Element {
  const { assistantEvent, toolResults } = turn;
  const blocks = assistantEvent.message.content;

  function renderBlock(block: ContentBlock, index: number): JSX.Element | null {
    switch (block.type) {
      case 'text':
        return block.text.trim() ? (
          <TextBlock key={`text-${index}`} text={block.text} />
        ) : null;

      case 'thinking':
        return (
          <ThinkingBlock
            key={`thinking-${index}`}
            thinking={block.thinking}
            defaultExpanded={false}
          />
        );

      case 'tool_use': {
        // Find the matching tool result from the user event
        const result: ToolResultContentBlock | null = toolResults.get(block.id) ?? null;
        // While streaming and no result yet, the tool is in-progress
        const isPendingStreaming = isStreaming && result === null;
        return (
          <ToolUseBlock
            key={`tool-${block.id}`}
            toolName={block.name}
            toolUseId={block.id}
            input={block.input}
            result={result}
            // Expand while pending (streaming in progress), collapse after result
            defaultExpanded={isPendingStreaming || result === null}
          />
        );
      }

      default:
        return null;
    }
  }

  return (
    <div className="message-group">
      <div className="message-group__role" aria-label="Role">
        Assistant
        {isThinking && (
          <span className="message-group__thinking-indicator" aria-label="Thinking">
            thinking…
          </span>
        )}
      </div>
      <div className="message-group__content">
        {blocks.map((block, i) => renderBlock(block, i))}
      </div>
    </div>
  );
}
