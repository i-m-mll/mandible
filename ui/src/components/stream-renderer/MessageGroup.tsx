// Bug: aa35aeb — Console tab renderer: one message group per assistant turn
// Bug: bce7370 — Adapted to use shared message-blocks components

import type { ContentBlock, MessageGroupProps, ToolResultContentBlock } from './types';
import { TextBlock } from '../message-blocks/TextBlock';
import { ThinkingBlock } from '../message-blocks/ThinkingBlock';
import { ToolUseBlock } from '../message-blocks/ToolUseBlock';

export function MessageGroup({ turn, isStreaming, isThinking }: MessageGroupProps): JSX.Element {
  const { assistantEvent, toolResults } = turn;
  const blocks = assistantEvent.message.content;

  function renderBlock(block: ContentBlock, index: number): JSX.Element | null {
    switch (block.type) {
      case 'text':
        return block.text.trim() ? (
          <TextBlock key={`text-${index}`} content={block.text} />
        ) : null;

      case 'thinking':
        // Bug: bce7370 — Fix 5: Keep thinking expanded while actively streaming
        // so the user can see thinking content accumulate. When streaming ends,
        // the block collapses intentionally rather than jarring.
        return (
          <ThinkingBlock
            key={`thinking-${index}`}
            content={block.thinking}
            defaultCollapsed={!(isStreaming && isThinking)}
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
            result={result as import('../message-blocks/ToolUseBlock').ToolResultContentBlock | null}
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
      <div className="message-group__content">
        {blocks.map((block, i) => renderBlock(block, i))}
      </div>
    </div>
  );
}
