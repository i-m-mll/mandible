// Bug: aa35aeb — Console tab renderer: one message group per assistant turn
// Bug: bce7370 — Adapted to use shared message-blocks components
// Bug: 236d03b — Fix 5: Per-block hover overlay with MessageActions

import { useMemo } from 'preact/hooks';
import type { ContentBlock, MessageGroupProps, ToolResultContentBlock } from './types';
import { TextBlock } from '../message-blocks/TextBlock';
import { ThinkingBlock } from '../message-blocks/ThinkingBlock';
import { ToolUseBlock } from '../message-blocks/ToolUseBlock';
import { latestPlanIndex, PlanBlock } from '../message-blocks/PlanBlock';
import { MessageActions, type MessageActionsMeta } from '../shared/MessageActions';

/** Extract copyable text from a single content block. */
function blockCopyText(block: ContentBlock): string {
  switch (block.type) {
    case 'text': return block.text ?? '';
    case 'thinking': return (block as { type: 'thinking'; thinking: string }).thinking ?? '';
    case 'plan': return (block as { type: 'plan'; text: string }).text ?? '';
    case 'tool_use': return JSON.stringify((block as { type: 'tool_use'; input: unknown }).input, null, 2);
    default: return '';
  }
}

export function MessageGroup({ turn, isStreaming, isThinking }: MessageGroupProps): JSX.Element {
  const { assistantEvent, toolResults } = turn;
  const blocks = assistantEvent.message.content;
  const newestPlanIndex = latestPlanIndex(blocks);

  // Bug: 0a1ad82 — Thread turn-level metadata to per-block MessageActions
  const turnMeta: MessageActionsMeta | undefined = useMemo(() => {
    const msg = assistantEvent.message;
    const usage = msg.usage;
    const model = msg.model;
    if (!usage && !model) return undefined;
    const tokenCount = usage ? (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0) : undefined;
    return { tokenCount, model };
  }, [assistantEvent]);

  function renderBlock(block: ContentBlock, index: number): JSX.Element | null {
    let inner: JSX.Element | null = null;

    switch (block.type) {
      case 'text':
        inner = block.text.trim() ? (
          <TextBlock key={`text-${index}`} content={block.text} />
        ) : null;
        break;

      case 'thinking':
        // Bug: bce7370 — Fix 5: Keep thinking expanded while actively streaming
        // so the user can see thinking content accumulate. When streaming ends,
        // the block collapses intentionally rather than jarring.
        inner = (
          <ThinkingBlock
            key={`thinking-${index}`}
            content={block.thinking}
            defaultCollapsed={!(isStreaming && isThinking)}
          />
        );
        break;

      case 'plan':
        if (index !== newestPlanIndex) {
          return null;
        }
        inner = (
          <PlanBlock
            key={`plan-${index}`}
            content={block.text}
          />
        );
        break;

      case 'tool_use': {
        // Find the matching tool result from the user event
        const result: ToolResultContentBlock | null = toolResults.get(block.id) ?? null;
        // While streaming and no result yet, the tool is in-progress
        const isPendingStreaming = isStreaming && result === null;
        inner = (
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
        break;
      }

      default:
        return null;
    }

    if (!inner) return null;

    // Bug: 236d03b — Fix 5: Wrap each block with per-block MessageActions (copy)
    const text = blockCopyText(block);
    return (
      <div key={`block-wrap-${index}`} className="message-block-wrapper" style={{ position: 'relative' }}>
        {inner}
        <MessageActions
          onCopy={text ? () => { navigator.clipboard.writeText(text).catch(() => {}); } : undefined}
          metadata={turnMeta}
        />
      </div>
    );
  }

  return (
    <div className="message-group">
      <div className="message-group__content">
        {blocks.map((block, i) => renderBlock(block, i))}
      </div>
    </div>
  );
}
