import type { JSX } from 'preact/jsx-runtime';
import type { ContentBlock, PersistedBlockSource, RenderNode } from '../components/stream-renderer/types';
import { MessageGroup } from '../components/stream-renderer/MessageGroup';
import { MessageActions, MessageLinkContext, MessagePrimaryActionsContext, type MessagePrimaryAction } from '../components/shared/MessageActions';
import { TurnGroup } from '../components/message-blocks/TurnGroup';
import { UserBubble } from '../components/message-blocks/UserBubble';
import { SemanticEventBlock, UnmatchedToolResultBlock } from '../components/message-blocks/SemanticEventBlock';
import { ActivityGroup, ActivityRow } from '../components/message-blocks/ActivityBlock';
import { ThinkingBlock } from '../components/message-blocks/ThinkingBlock';
import { ToolUseBlock } from '../components/message-blocks/ToolUseBlock';
import type { ReadingRow } from './readingProjection';
import type { ChatSurfaceProps } from './ChatSurface';
function blockId(turnId: string, block: ContentBlock, index: number): string {
  if (block.contentKey) return block.contentKey;
  if (block.type === 'tool_use') {
    return `tool:${block.id}`;
  }
  return `${turnId}:${block.type}:${index}`;
}

export type ReadingContentProps = ChatSurfaceProps & {
  row: ReadingRow;
  expandedBlocks: Readonly<Record<string, boolean>>;
  setBlockExpanded: (id: string, expanded: boolean, sources?: readonly (PersistedBlockSource | undefined)[]) => void;
  preparing: boolean;
  primaryActions: MessagePrimaryAction[];
  lastAssistantTurnId?: string;
  onActivityGroupExpandedChange: (expanded: boolean) => void;
};
export function ReadingContent({ row, expandedBlocks, setBlockExpanded, preparing, primaryActions,
  lastAssistantTurnId,
  onActivityGroupExpandedChange,
  streaming, selectedMessageId, sessionInfo, onToggleBlockSelect, selectedBlockIds, selectMode,
  onFork, onResume, onCreatedTaskNavigate }: ReadingContentProps): JSX.Element {
  const nodes = row.nodes;
  function renderNodeBody(node: RenderNode, memberRef?: string): JSX.Element | null {
    switch (node.kind) {
      case 'transcript_boundary': return null;
      case 'user_message': {
        const source = node.persisted;
        return (
          <div
            key={node.key}
            className="message-block-wrapper contextual-action-owner"
            data-block-id={source?.blockId}
          >
            <UserBubble text={node.text} provider={sessionInfo?.backend} getDisclosureExpanded={key => preparing || expandedBlocks[`${node.key}:${key}`]} onDisclosureExpandedChange={(key, next) => setBlockExpanded(`${node.key}:${key}`, next, row.sources)} />
            <MessageActions
              blockId={source?.blockId}
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

       case 'semantic_event': {
        const source = node.event.source;
        return (
          <div key={node.key} className="message-block-wrapper" data-block-id={source?.blockId}>
            <SemanticEventBlock
              kind={node.event.semantic_kind}
              content={node.event.content}
              label={node.event.label}
              isError={node.event.is_error}
              expanded={preparing || expandedBlocks[`semantic:${node.key}`]}
              detailsAvailable={source?.detailsLoaded === false}
              onExpandedChange={next => setBlockExpanded(`semantic:${node.key}`, next, [source])}
            />
            <MessageActions
              blockId={source?.blockId}
              onSelect={source && onToggleBlockSelect ? (shiftKey) => onToggleBlockSelect(source.blockId, shiftKey) : undefined}
              isSelected={source ? selectedBlockIds?.has(source.blockId) : false}
              selectMode={selectMode}
              metadata={{ timestamp: source?.timestamp }}
            />
          </div>
        );
      }

      case 'unmatched_tool_result': {
        const source = node.result.source;
        const disclosureKey = `unmatched-tool-result:${node.key}`;
        return (
          <div key={node.key} className="message-block-wrapper" data-block-id={source?.blockId}>
            <UnmatchedToolResultBlock
              result={node.result}
              unmatched={!source?.parentBlockId}
              expanded={preparing || expandedBlocks[disclosureKey]}
              onExpandedChange={(next) => setBlockExpanded(disclosureKey, next, [source])}
            />
            <MessageActions
              blockId={source?.blockId}
              onSelect={source && onToggleBlockSelect ? (shiftKey) => onToggleBlockSelect(source.blockId, shiftKey) : undefined}
              isSelected={source ? selectedBlockIds?.has(source.blockId) : false}
              selectMode={selectMode}
              metadata={{ timestamp: source?.timestamp }}
            />
          </div>
        );
      }

      case 'activity': {
        const source = node.source;
        const sourceBlockId = source?.blockId
          ?? (node.item.type === 'provider-directive' ? node.item.blockId ?? undefined : undefined);
        const disclosureKey = `activity:${node.key}`;
        const defaultExpanded = node.item.type === 'thinking-block-activity'
          && streaming
          && node.item.turnId === lastAssistantTurnId;
        const expanded = preparing || (expandedBlocks[disclosureKey] ?? defaultExpanded);
        let activity: JSX.Element;
        if (node.item.type === 'tool-call-activity') {
          const resultSource = node.item.result?.source;
          activity = (
            <ToolUseBlock
              toolName={node.item.name}
              toolKind={node.item.toolKind}
              toolUseId={node.item.id}
              active={Boolean(node.item.executionActive && streaming)}
              detailsAvailable={source?.detailsLoaded === false}
              input={node.item.input}
              header={node.item.header}
              result={node.item.result}
              defaultExpanded={false}
              expanded={expanded}
              onExpandedChange={(next) => setBlockExpanded(disclosureKey, next, [source, resultSource])}
              resultSelected={resultSource ? selectedBlockIds?.has(resultSource.blockId) : false}
              selectMode={selectMode}
              onToggleResultSelect={resultSource && onToggleBlockSelect
                ? (shiftKey) => onToggleBlockSelect(resultSource.blockId, shiftKey)
                : undefined}
              onForkResult={resultSource?.dagUuid && onFork ? () => onFork(resultSource.dagUuid!) : undefined}
              onResumeResult={resultSource?.dagUuid && onResume ? () => onResume(resultSource.dagUuid!) : undefined}
            />
          );
        } else if (node.item.type === 'thinking-block-activity') {
          activity = (
            <ThinkingBlock
              content={node.item.content}
              defaultCollapsed={!defaultExpanded}
              expanded={expanded}
              detailsAvailable={source?.detailsLoaded === false}
              onExpandedChange={(next) => setBlockExpanded(disclosureKey, next, [source])}
            />
          );
        } else {
          activity = (
            <ActivityRow
              item={node.item}
              expanded={expanded}
              detailsAvailable={source?.detailsLoaded === false && source.hasBody !== false}
              onExpandedChange={(next) => setBlockExpanded(disclosureKey, next, [source])}
              onCreatedTaskNavigate={onCreatedTaskNavigate}
            />
          );
        }
        return (
          <div key={node.key} className="message-block-wrapper" data-block-id={sourceBlockId} data-member-refs={memberRef}>
            {activity}
            <MessageActions
              blockId={source?.blockId}
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

      case 'assistant_turn': {
        const { turn } = node;
        const isLastStreamingTurn = streaming && node.turn.id === lastAssistantTurnId;
        const isThinking =
          isLastStreamingTurn &&
          turn.assistantEvent.message.content.some((b) => b.type === 'thinking');
        const isSelected = selectedMessageId === turn.id;
        return (
          <div
            key={node.key}
            className={isSelected ? 'stream-turn-node stream-turn--selected' : 'stream-turn-node'}
          >
            <MessageGroup
              turn={turn}
              isStreaming={isLastStreamingTurn}
              isThinking={isThinking}
              getBlockExpanded={(contentBlock, index, defaultExpanded) => (
                preparing || (expandedBlocks[blockId(turn.id, contentBlock, index)] ?? defaultExpanded)
              )}
              onBlockExpandedChange={(contentBlock, index, expanded, relatedSources = []) => (
                setBlockExpanded(blockId(turn.id, contentBlock, index), expanded, [contentBlock.source, ...relatedSources])
              )}
              getDisclosureExpanded={(id, defaultExpanded) => preparing || (expandedBlocks[`${node.key}:${id}`] ?? defaultExpanded)}
              onDisclosureExpandedChange={(id, expanded) => setBlockExpanded(`${node.key}:${id}`, expanded, row.sources)}
              selectedBlockIds={selectedBlockIds}
              selectMode={selectMode}
              onToggleBlockSelect={onToggleBlockSelect}
              onFork={onFork}
              onResume={onResume}
            />
          </div>
        );
      }

      default:
        return null;
    }
  }

  const speaker = row.activityGroup?.items[0]?.entity ?? nodes.find(node => node.kind !== 'transcript_boundary')?.entity ?? 'assistant';
  const footer = row.totalTokens === undefined ? undefined : <span className="turn-group__stats">{row.totalTokens.toLocaleString()} tokens</span>;
  const body = row.activityGroup ? <div className="message-block-wrapper"><ActivityGroup
        items={row.activityGroup.items.map(node => node.item)}
        presentation={row.activityGroup.presentation}
        active={streaming && row.activityGroup.items.some(node => node.item.type === 'tool-call-activity' && node.item.executionActive)}
        expanded={row.activityGroup.expanded}
        onExpandedChange={onActivityGroupExpandedChange}
        actions={<MessageLinkContext.Provider value={null}><MessageActions /></MessageLinkContext.Provider>}
        renderMember={() => null}
        externalMembers
      /></div> : nodes.map(node => renderNodeBody(node));
  return <MessagePrimaryActionsContext.Provider value={primaryActions}>
    {row.activityMember ? <div className="activity-details activity-group__members">{body}{footer}</div>
      : <TurnGroup speaker={speaker} footer={footer}>{body}</TurnGroup>}
  </MessagePrimaryActionsContext.Provider>;
}
