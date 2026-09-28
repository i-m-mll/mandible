// Bug: aa35aeb — Console tab renderer: one message group per assistant turn
// Bug: bce7370 — Adapted to use shared message-blocks components
// Bug: 236d03b — Fix 5: Per-block hover overlay with MessageActions

import type { ContentBlock, MessageGroupProps, ToolResultContentBlock, ToolUseContentBlock } from './types';
import { TextBlock } from '../message-blocks/TextBlock';
import { ThinkingBlock } from '../message-blocks/ThinkingBlock';
import { ToolUseBlock } from '../message-blocks/ToolUseBlock';
import { latestPlanIndex, PlanBlock } from '../message-blocks/PlanBlock';
import { MessageActions } from '../shared/MessageActions';
import { ToolCallGroup } from '../message-blocks/ToolCallGroup';
import { summarizeToolRun, toolRunIcon } from '../message-blocks/toolPresentation';

export function MessageGroup({
  turn,
  isStreaming,
  isThinking,
  getBlockExpanded,
  onBlockExpandedChange,
  getDisclosureExpanded,
  onDisclosureExpandedChange,
  selectedBlockIds,
  selectMode,
  onToggleBlockSelect,
  onFork,
  onResume,
}: MessageGroupProps): JSX.Element {
  const { assistantEvent, toolResults } = turn;
  const blocks = assistantEvent.message.content;
  const newestPlanIndex = latestPlanIndex(blocks);

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
        {
          const defaultExpanded = isStreaming && isThinking === true;
          const expanded = getBlockExpanded?.(block, index, defaultExpanded);
          inner = (
            <ThinkingBlock
              key={`thinking-${index}`}
              content={block.thinking}
              defaultCollapsed={!defaultExpanded}
              expanded={expanded}
              onExpandedChange={(next) => onBlockExpandedChange?.(block, index, next)}
            />
          );
        }
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
        // Tool disclosures are initially folded in both live and persisted
        // streams. Running state remains visible in the summary row.
        const defaultExpanded = false;
        const expanded = getBlockExpanded?.(block, index, defaultExpanded);
        inner = (
          <ToolUseBlock
            key={`tool-${block.id}`}
            toolName={block.name}
            toolUseId={block.id}
            input={block.input}
            result={result as import('../message-blocks/ToolUseBlock').ToolResultContentBlock | null}
            defaultExpanded={defaultExpanded}
            expanded={expanded}
            onExpandedChange={(next) => onBlockExpandedChange?.(block, index, next)}
            resultSelected={result?.source ? selectedBlockIds?.has(result.source.blockId) : false}
            selectMode={selectMode}
            onToggleResultSelect={result?.source && onToggleBlockSelect
              ? (shiftKey) => onToggleBlockSelect(result.source!.blockId, shiftKey)
              : undefined}
            onForkResult={result?.source?.dagUuid && onFork ? () => onFork(result.source!.dagUuid!) : undefined}
            onResumeResult={result?.source?.dagUuid && onResume ? () => onResume(result.source!.dagUuid!) : undefined}
          />
        );
        break;
      }

      default:
        return null;
    }

    if (!inner) return null;

    // Keep selection and provenance controls attached to their exact block.
    // Copy lives in the shared group footer, so a second top-right copy action
    // would duplicate the same operation and obscure message text on hover.
    const source = block.source;
    return (
      <div
        key={`block-wrap-${index}`}
        className="message-block-wrapper contextual-action-owner"
        data-block-id={source?.blockId}
      >
        {inner}
        <MessageActions
          onSelect={source && onToggleBlockSelect ? (shiftKey) => onToggleBlockSelect(source.blockId, shiftKey) : undefined}
          isSelected={source ? selectedBlockIds?.has(source.blockId) : false}
          selectMode={selectMode}
          onFork={source?.dagUuid && onFork ? () => onFork(source.dagUuid!) : undefined}
          onResume={source?.dagUuid && onResume ? () => onResume(source.dagUuid!) : undefined}
          dagUuid={source?.dagUuid}
          metadata={{ timestamp: source?.timestamp }}
        />
      </div>
    );
  }

  function renderBlocks(): Array<JSX.Element | null> {
    const rendered: Array<JSX.Element | null> = [];
    let index = 0;
    while (index < blocks.length) {
      if (blocks[index].type !== 'tool_use') {
        rendered.push(renderBlock(blocks[index], index));
        index += 1;
        continue;
      }
      let end = index + 1;
      while (end < blocks.length && blocks[end].type === 'tool_use') end += 1;
      const run = blocks.slice(index, end) as ToolUseContentBlock[];
      if (run.length < 2) {
        rendered.push(renderBlock(run[0], index));
        index = end;
        continue;
      }

      const groupId = `tool-group:${run[0].id}`;
      const expanded = getDisclosureExpanded?.(groupId, false);
      const memberRefs = run
        .map((block) => block.source?.blockId)
        .filter((blockId): blockId is string => Boolean(blockId))
        .join(' ');
      rendered.push(
        <ToolCallGroup
          key={groupId}
          summary={summarizeToolRun(run)}
          icon={toolRunIcon(run)}
          expanded={expanded}
          onExpandedChange={(next) => onDisclosureExpandedChange?.(groupId, next)}
          memberRefs={memberRefs}
        >
          {run.map((block, offset) => renderBlock(block, index + offset))}
        </ToolCallGroup>,
      );
      index = end;
    }
    return rendered;
  }

  return (
    <div className="message-group">
      <div className="message-group__content">
        {renderBlocks()}
      </div>
    </div>
  );
}
