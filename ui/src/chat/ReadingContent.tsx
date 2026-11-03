import { readingContentBlockDisclosureKey, readingNodeDisclosures, readingThinkingDefaultExpanded, readingToolExecutionActive } from '../../../src/presentation/reading-disclosures';
import type { JSX } from 'preact/jsx-runtime';
import type { PersistedBlockSource, RenderNode } from '../components/stream-renderer/types';
import { MessageGroup } from '../components/stream-renderer/MessageGroup';
import { MessageActions, MessageActionsVariantContext, MessageLinkContext, MessagePrimaryActionsContext, type MessagePrimaryAction } from '../components/shared/MessageActions';
import { TurnGroup } from '../components/message-blocks/TurnGroup';
import { UserBubble } from '../components/message-blocks/UserBubble';
import { SemanticEventBlock, UnmatchedToolResultBlock } from '../components/message-blocks/SemanticEventBlock';
import { ActivityGroup, ActivityRow } from '../components/message-blocks/ActivityBlock';
import { ThinkingBlock } from '../components/message-blocks/ThinkingBlock';
import { ToolUseBlock } from '../components/message-blocks/ToolUseBlock';
import type { ReadingRow } from './readingProjection';
import type { ChatSurfaceProps } from './ChatSurface';
import { isCompactReadingRow } from './readingRowPresentation';

export type ReadingContentProps = ChatSurfaceProps & {
  row: ReadingRow;
  expandedBlocks: Readonly<Record<string, boolean>>;
  setBlockExpanded: (id: string, expanded: boolean, sources?: readonly (PersistedBlockSource | undefined)[], trigger?: HTMLElement) => void;
  preparing: boolean;
  primaryActions: MessagePrimaryAction[];
  lastAssistantTurnId?: string;
  onActivityGroupExpandedChange: (expanded: boolean, trigger?: HTMLElement) => void;
};
export function ReadingContent({ row, expandedBlocks, setBlockExpanded, preparing, primaryActions,
  lastAssistantTurnId,
  onActivityGroupExpandedChange,
  streaming, selectedMessageId, sessionInfo, onToggleBlockSelect, selectedBlockIds, selectMode,
  onFork, onResume }: ReadingContentProps): JSX.Element {
  const nodes = row.nodes;
  const compact = isCompactReadingRow(row);
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
            <UserBubble text={node.text} provider={sessionInfo?.backend} getDisclosureExpanded={key => preparing || expandedBlocks[`${node.key}:${key}`]} onDisclosureExpandedChange={(key, next, trigger) => setBlockExpanded(`${node.key}:${key}`, next, row.sources, trigger)} />
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
              headerMetadata={compact ? footer : undefined}
              content={node.event.content}
              label={node.event.label}
              isError={node.event.is_error}
              expanded={preparing || expandedBlocks[readingNodeDisclosures(node).keys[0]]}
              detailsAvailable={source?.detailsLoaded === false}
              onExpandedChange={(next, trigger) => setBlockExpanded(readingNodeDisclosures(node).keys[0], next, [source], trigger)}
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
        const disclosureKey = readingNodeDisclosures(node).keys[0];
        return (
          <div key={node.key} className="message-block-wrapper" data-block-id={source?.blockId}>
            <UnmatchedToolResultBlock
              result={node.result}
              headerMetadata={compact ? footer : undefined}
              unmatched={!source?.parentBlockId}
              expanded={preparing || expandedBlocks[disclosureKey]}
              onExpandedChange={(next, trigger) => setBlockExpanded(disclosureKey, next, [source], trigger)}
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
        const disclosureKey = readingNodeDisclosures(node).keys[0];
        const defaultExpanded = node.item.type === 'thinking-block-activity' && readingThinkingDefaultExpanded(node.item.turnId, { streaming, lastAssistantTurnId });
        const expanded = preparing || (expandedBlocks[disclosureKey] ?? defaultExpanded);
        let activity: JSX.Element;
        if (node.item.type === 'tool-call-activity') {
          const resultSource = node.item.result?.source;
          activity = (
            <ToolUseBlock
              toolName={node.item.name}
              operationContext={node.item.operationContext}
              executionEvidence={node.item.executionEvidence}
              headerMetadata={compact ? footer : undefined}
              toolKind={node.item.toolKind}
              toolUseId={node.item.id}
              active={readingToolExecutionActive(node.item.executionActive, { streaming, lastAssistantTurnId })}
              detailsAvailable={source?.detailsLoaded === false}
              input={node.item.input}
              header={node.item.header}
              result={node.item.result}
              defaultExpanded={false}
              withinCollection={row.activityMember}
              getDisclosureExpanded={(key,defaultExpanded)=>expandedBlocks[`${disclosureKey}:${key}`] ?? (preparing || defaultExpanded)}
              onDisclosureExpandedChange={(key,next,trigger)=>setBlockExpanded(`${disclosureKey}:${key}`,next,[source,resultSource],trigger)}
              expanded={expanded}
              onExpandedChange={(next, trigger) => setBlockExpanded(disclosureKey, next, [source, resultSource], trigger)}
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
              headerMetadata={compact ? footer : undefined}
              defaultCollapsed={!defaultExpanded}
              expanded={expanded}
              detailsAvailable={source?.detailsLoaded === false}
              onExpandedChange={(next, trigger) => setBlockExpanded(disclosureKey, next, [source], trigger)}
            />
          );
        } else {
          activity = (
            <ActivityRow
              item={node.item}
              headerMetadata={compact ? footer : undefined}
              expanded={expanded}
              detailsAvailable={source?.detailsLoaded === false && source.hasBody !== false}
              onExpandedChange={(next, trigger) => setBlockExpanded(disclosureKey, next, [source], trigger)}
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
        const defaultThinkingExpanded = readingThinkingDefaultExpanded(turn.id, { streaming, lastAssistantTurnId });
        const isSelected = selectedMessageId === turn.id;
        return (
          <div
            key={node.key}
            className={isSelected ? 'stream-turn-node stream-turn--selected' : 'stream-turn-node'}
          >
            <MessageGroup
              turn={turn}
              headerMetadata={compact ? footer : undefined}
              defaultThinkingExpanded={defaultThinkingExpanded}
              getBlockExpanded={(contentBlock, index, defaultExpanded) => (
                preparing || (expandedBlocks[readingContentBlockDisclosureKey(turn.id, contentBlock, index)] ?? defaultExpanded)
              )}
              onBlockExpandedChange={(contentBlock, index, expanded, relatedSources = [], trigger) => (
                setBlockExpanded(readingContentBlockDisclosureKey(turn.id, contentBlock, index), expanded, [contentBlock.source, ...relatedSources], trigger)
              )}
              getDisclosureExpanded={(id, defaultExpanded) => expandedBlocks[`${node.key}:${id}`] ?? (preparing || defaultExpanded)}
              onDisclosureExpandedChange={(id, expanded, trigger) => setBlockExpanded(`${node.key}:${id}`, expanded, row.sources, trigger)}
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
  const footer = row.totalTokens === undefined ? undefined : <span className="turn-group__stats" title={`${row.totalTokens.toLocaleString()} tokens`}>{row.totalTokens.toLocaleString()} tokens</span>;
  const body = row.activityGroup ? <div className="message-block-wrapper"><ActivityGroup
        items={row.activityGroup.items.map(node => node.item)}
        presentation={row.activityGroup.presentation}
    headerMetadata={compact ? footer : undefined}
        active={streaming && row.activityGroup.items.some(node => node.item.type === 'tool-call-activity' && node.item.executionActive)}
        expanded={row.activityGroup.expanded}
        onExpandedChange={onActivityGroupExpandedChange}
        actions={<MessageLinkContext.Provider value={null}><MessageActions /></MessageLinkContext.Provider>}
        renderMember={() => null}
        externalMembers
      /></div> : nodes.map(node => renderNodeBody(node));
  return <MessageActionsVariantContext.Provider value={row.isFinalResponse ? 'reply-footer' : 'menu'}><MessagePrimaryActionsContext.Provider value={primaryActions}>
    {compact ? <div className="reading-compact-row">{body}</div>
      : <TurnGroup speaker={speaker} footer={footer}>{body}</TurnGroup>}
  </MessagePrimaryActionsContext.Provider></MessageActionsVariantContext.Provider>;
}
