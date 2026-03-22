import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { marked } from 'marked';
import { useSidebarResize } from '../hooks/useSidebarResize';
import type { ConsoleSession } from '../state';
import type {
  BlockType,
  Conversation,
  ConversationBlock,
  ConversationChild,
  ConversationSource,
} from '../api.js';
import {
  exportConversationBlocks,
  forkConversation,
  getConversation,
  getConversationForks,
  getConversations,
  getSessionIssues,
  getSessionPresets,
  getSettings,
  resumeConversation,
  triggerIngestion,
  updateConversation,
  type ForkData,
  type ForkPoint,
  type SessionPreset,
} from '../api.js';
import { MessageActions } from '../components/shared/MessageActions';
import { BranchSelector, type BranchInfo } from '../components/console/BranchSelector';
import { EntityPill } from '../components/shared/EntityPill';
// Bug: bce7370 — Shared message-block components
import {
  TextBlock,
  ThinkingBlock,
  ToolUseBlock,
  TurnGroup,
  GroupFooter,
  BlockTypeIcon as SharedBlockTypeIcon,
} from '../components/message-blocks';

// Configure marked for safe, synchronous rendering
marked.setOptions({ async: false, gfm: true, breaks: false });

// ── Toast notification ──

type ToastState = { message: string; type: 'info' | 'error' } | null;

function Toast({ toast, onDismiss }: { toast: ToastState; onDismiss: () => void }): JSX.Element | null {
  if (!toast) return null;
  return (
    <div className={`conv-toast conv-toast--${toast.type}`} onClick={onDismiss}>
      {toast.message}
    </div>
  );
}

// ── Resume conflict dialog ──

type ResumeConflictPolicy = 'auto_fork' | 'prompt' | 'allow_concurrent';

function ResumeConflictDialog({
  onBranch,
  onFork,
  onCancel,
}: {
  onBranch: (remember: boolean) => void;
  onFork: (remember: boolean) => void;
  onCancel: () => void;
}): JSX.Element {
  const [remember, setRemember] = useState(false);

  return (
    <div className="conv-dialog-overlay" onClick={onCancel}>
      <div className="conv-dialog" onClick={(e) => e.stopPropagation()}>
        <h3 className="conv-dialog__title">This conversation is active in Console.</h3>
        <div className="conv-dialog__options">
          <button
            type="button"
            className="btn btn--active"
            onClick={() => onBranch(remember)}
          >
            Branch &mdash; Continue in the same session (creates a branch point)
          </button>
          <button
            type="button"
            className="btn btn--ghost"
            onClick={() => onFork(remember)}
          >
            Fork &mdash; Create a new conversation (clean copy up to here)
          </button>
        </div>
        <label className="conv-dialog__remember">
          <input
            type="checkbox"
            checked={remember}
            onChange={(e) => setRemember((e.target as HTMLInputElement).checked)}
          />
          Remember my choice
        </label>
        <button type="button" className="btn btn--ghost btn--sm conv-dialog__cancel" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

// ── Constants ──

const ALL_BLOCK_TYPES: BlockType[] = [
  'user_message',
  'assistant_message',
  'thinking',
  'tool_use',
  'tool_result',
  'system',
  'event',
];

const BLOCK_TYPE_LABELS: Record<BlockType, string> = {
  user_message: 'User',
  assistant_message: 'Assistant',
  thinking: 'Thinking',
  tool_use: 'Tool Use',
  tool_result: 'Tool Result',
  system: 'System',
  event: 'Event',
};

const SOURCE_LABELS: Record<ConversationSource, string> = {
  claude_code: 'Claude',
  codex: 'Codex',
  gemini: 'Gemini',
};

const SOURCE_CLASSES: Record<ConversationSource, string> = {
  claude_code: 'source-badge--claude',
  codex: 'source-badge--codex',
  gemini: 'source-badge--gemini',
};

const PAGE_SIZE = 50;
const VIRTUAL_BUFFER = 10;
const ESTIMATED_BLOCK_HEIGHT = 120;

// ── Helpers ──

function formatRelativeTime(dateStr: string | null): string {
  if (!dateStr) return '\u2014';
  const ts = Date.parse(dateStr);
  if (Number.isNaN(ts)) return '\u2014';
  const diffMs = Date.now() - ts;
  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(ts).toLocaleDateString();
}

function formatAbsoluteTime(dateStr: string | null): string {
  if (!dateStr) return '';
  const ts = Date.parse(dateStr);
  if (Number.isNaN(ts)) return '';
  return new Date(ts).toLocaleString();
}

function truncate(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + '\u2026';
}

function parseMetadata(json: string): Record<string, unknown> {
  try {
    return JSON.parse(json || '{}');
  } catch {
    return {};
  }
}

function isCollapsibleBlock(type: BlockType): boolean {
  return (
    type === 'thinking' ||
    type === 'tool_use' ||
    type === 'tool_result' ||
    type === 'system' ||
    type === 'event'
  );
}

function getBlockHeaderLabel(
  block: ConversationBlock,
  metadata: Record<string, unknown>,
): string | null {
  switch (block.type) {
    case 'user_message':
      return null;
    case 'assistant_message': {
      const model = metadata.model as string | undefined;
      return model ? `Assistant (${model})` : 'Assistant';
    }
    case 'thinking': {
      const duration = metadata.duration_ms as number | undefined;
      return duration ? `Thinking (${(duration / 1000).toFixed(1)}s)` : 'Thinking';
    }
    case 'tool_use': {
      const toolName = metadata.tool_name as string | undefined;
      return toolName ? `Tool: ${toolName}` : 'Tool Use';
    }
    case 'tool_result':
      return 'Tool Result';
    case 'system':
      return 'System';
    case 'event': {
      const eventType = metadata.event_type as string | undefined;
      const isError = metadata.is_error === true || metadata.level === 'error';
      const prefix = isError ? 'Error' : 'Event';
      return eventType ? `${prefix}: ${eventType}` : prefix;
    }
    default:
      return block.type;
  }
}

type TranscriptSpeaker = 'user' | 'assistant' | 'system';
type TranscriptTurn = {
  id: string;
  speaker: TranscriptSpeaker;
  blocks: ConversationBlock[];
};

function speakerForBlock(block: ConversationBlock): TranscriptSpeaker {
  if (block.type === 'user_message') {
    return 'user';
  }
  if (
    block.type === 'assistant_message' ||
    block.type === 'thinking' ||
    block.type === 'tool_use' ||
    block.type === 'tool_result'
  ) {
    return 'assistant';
  }
  return 'system';
}

function buildTranscriptTurns(blocks: ConversationBlock[]): TranscriptTurn[] {
  const turns: TranscriptTurn[] = [];
  let current: TranscriptTurn | null = null;

  for (const block of blocks) {
    const speaker = speakerForBlock(block);
    if (speaker === 'system') {
      current = null;
      turns.push({ id: `turn-${block.id}`, speaker, blocks: [block] });
      continue;
    }
    if (!current || current.speaker !== speaker) {
      current = { id: `turn-${block.id}`, speaker, blocks: [block] };
      turns.push(current);
      continue;
    }
    current.blocks.push(block);
  }

  return turns;
}

// ── Props ──

export type ConversationsViewProps = {
  conversations: Conversation[];
  consoleSessions: ConsoleSession[];
  initialConversationId: string | null;
  initialSessionId: string | null;
};

// ── Markdown renderer ──
// Bug: bce7370 — MarkdownContent replaced by shared TextBlock from message-blocks.

/**
 * Strip dangerous tags and attributes from HTML produced by marked.
 * Keeps safe inline tags (strong, em, code, a, del, s, sup, sub, span).
 * Bug: 387ae46 — sanitize marked output before dangerouslySetInnerHTML
 */
function sanitizeInlineHtml(html: string): string {
  // Remove dangerous block-level and executable tags (including their content)
  let out = html.replace(
    /<(script|iframe|object|embed|form|style|svg|math)[^>]*>[\s\S]*?<\/\1>/gi,
    '',
  );
  // Also strip self-closing variants (e.g. <script />, <iframe />)
  out = out.replace(/<(script|iframe|object|embed|form|style|svg|math)[^>]*\/>/gi, '');
  // Strip on* event handler attributes (onclick, onload, onerror, etc.)
  out = out.replace(/\s+on\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]*)/gi, '');
  // Strip javascript: href/src values
  out = out.replace(/\s+(href|src)\s*=\s*(?:"javascript:[^"]*"|'javascript:[^']*')/gi, '');
  return out;
}

/**
 * Render inline markdown — strips the outer <p>…</p> wrapper that marked adds
 * for single-line input so the text flows inline without extra block spacing.
 * Used for titles and short prose displayed in compact contexts (sidebar items,
 * table cells, headings).
 * Bug: a44fd6a — markdown rendering in History sidebar and detail titles
 */
function renderInlineMarkdown(src: string): string {
  if (!src) return '';
  const html = marked.parse(src, { async: false }) as string;
  // Strip a single wrapping <p>…</p> (marked emits this for one-liner input)
  const stripped = html.replace(/^<p>([\s\S]*?)<\/p>\n?$/, '$1').trim();
  return sanitizeInlineHtml(stripped);
}

// ── Copy-markdown button ──

function CopyButton({ content }: { content: string }): JSX.Element {
  const [copied, setCopied] = useState(false);

  const handleCopy = async (e: MouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // ignore
    }
  };

  return (
    <button
      type="button"
      className="block-copy-btn"
      onClick={handleCopy}
      title="Copy raw markdown"
      aria-label={copied ? 'Copied' : 'Copy raw markdown'}
    >
      {copied ? (
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path
            d="M3 8.5 6.2 11.6 13 4.8"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      ) : (
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <rect
            x="5.5"
            y="4.5"
            width="7"
            height="8"
            rx="1.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.2"
          />
          <path
            d="M3.5 9.5h-1V3.5A1.5 1.5 0 0 1 4 2h6v1.2H4.7a1.2 1.2 0 0 0-1.2 1.2Z"
            fill="currentColor"
          />
        </svg>
      )}
    </button>
  );
}

// Bug: bce7370 — BlockTypeIcon now delegates to the shared component from message-blocks.
function BlockTypeIcon({ type }: { type: BlockType }): JSX.Element | null {
  // The shared component supports these types directly
  if (type === 'thinking' || type === 'tool_use' || type === 'tool_result' || type === 'system' || type === 'event') {
    return <SharedBlockTypeIcon type={type} />;
  }
  return null;
}

// ── Tool use card ──
// Bug: bce7370 — ToolUseCard replaced by shared ToolUseBlock (compact mode) from message-blocks.

function renderConversationBlockBody(
  block: ConversationBlock,
  collapsed: boolean,
): JSX.Element | null {
  if (collapsed) return null;
  const metadata = parseMetadata(block.metadata_json);

  // Bug: bce7370 — Use shared components for text and tool blocks
  if (block.type === 'assistant_message' || block.type === 'user_message') {
    return (
      <div className="block-content">
        <TextBlock content={block.content} />
      </div>
    );
  }

  if (block.type === 'thinking') {
    return (
      <div className="block-content">
        <ThinkingBlock content={block.content} defaultCollapsed={false} />
      </div>
    );
  }

  if (block.type === 'tool_use') {
    const toolName = (metadata.tool_name as string | undefined) ?? 'Tool';
    const toolInput = (metadata.tool_input ?? block.content) as Record<string, unknown> | string;
    return (
      <div className="block-content block-content--mono">
        <ToolUseBlock toolName={toolName} input={toolInput} compact />
      </div>
    );
  }

  const showExpandButton = isCollapsibleBlock(block.type) && block.content.length > 200;
  return (
    <div className={`block-content${block.type === 'tool_result' ? ' block-content--mono' : ''}`}>
      {showExpandButton ? (
        <ContentWithExpand content={block.content} />
      ) : (
        <pre className="block-pre">{block.content}</pre>
      )}
    </div>
  );
}

// ── Block Renderer ──

function BlockRenderer({
  block,
  isSelected,
  selectMode,
  onToggleSelect,
  onShiftSelect,
  onToggleCollapse,
  collapsed,
  onFork,
  onResume,
}: {
  block: ConversationBlock;
  isSelected: boolean;
  selectMode: boolean;
  onToggleSelect: () => void;
  onShiftSelect: () => void;
  onToggleCollapse: () => void;
  collapsed: boolean;
  onFork?: (dagUuid: string) => void;
  onResume?: (dagUuid: string) => void;
}): JSX.Element {
  const metadata = parseMetadata(block.metadata_json);
  const isCollapsible = isCollapsibleBlock(block.type);

  // User message: no header label (the box style is sufficient to distinguish it)
  // Bug: 372edcb — remove redundant "User" header from user message blocks
  const showHeader = block.type !== 'user_message';

  const isErrorEvent = block.type === 'event' && (metadata.is_error === true || metadata.level === 'error');
  const typeClass = [
    'block',
    `block-${block.type.replace('_', '-')}`,
    isSelected ? 'block-selected' : '',
    collapsed ? 'block-collapsed' : '',
    isErrorEvent ? 'block-event--error' : '',
    selectMode ? 'block--selectable' : '',
  ].filter(Boolean).join(' ');

  const handleClick = (e: MouseEvent) => {
    if (selectMode) {
      if (e.shiftKey) {
        onShiftSelect();
      } else {
        onToggleSelect();
      }
    }
  };

  const headerLabel = getBlockHeaderLabel(block, metadata);

  const blockDagUuid = block.dag_uuid ?? undefined;

  return (
    <div className={typeClass} onClick={handleClick} data-block-id={block.id} style={{ position: 'relative' }}>
      {showHeader && (
        <div className="block-header">
          <div className="block-header__left">
            <input
              type="checkbox"
              checked={isSelected}
              onChange={onToggleSelect}
              onClick={(e) => e.stopPropagation()}
              className={`block-checkbox${selectMode || isSelected ? ' block-checkbox--visible' : ''}`}
            />
            {isCollapsible && (
              <button
                type="button"
                className="block-collapse-toggle"
                onClick={(e) => {
                  e.stopPropagation();
                  onToggleCollapse();
                }}
              >
                {collapsed ? '\u25B8' : '\u25BE'}
              </button>
            )}
            {headerLabel && <span className="block-label">{headerLabel}</span>}
          </div>
          <div className="block-header__right">
            <CopyButton content={block.content} />
            <span className="block-timestamp" title={formatAbsoluteTime(block.timestamp)}>
              {formatRelativeTime(block.timestamp)}
            </span>
          </div>
        </div>
      )}
      {/* User message: checkbox + copy + timestamp inline above content */}
      {!showHeader && (
        <div className="block-header block-header--user">
          <div className="block-header__left">
            <input
              type="checkbox"
              checked={isSelected}
              onChange={onToggleSelect}
              onClick={(e) => e.stopPropagation()}
              className={`block-checkbox${selectMode || isSelected ? ' block-checkbox--visible' : ''}`}
            />
          </div>
          <div className="block-header__right">
            <CopyButton content={block.content} />
            <span className="block-timestamp" title={formatAbsoluteTime(block.timestamp)}>
              {formatRelativeTime(block.timestamp)}
            </span>
          </div>
        </div>
      )}
      {renderConversationBlockBody(block, collapsed)}
      <MessageActions
        onCopy={() => { navigator.clipboard.writeText(block.content).catch(() => {}); }}
        onResume={blockDagUuid && onResume ? () => onResume(blockDagUuid) : undefined}
        onFork={blockDagUuid && onFork ? () => onFork(blockDagUuid) : undefined}
        dagUuid={blockDagUuid}
        showResume={!!blockDagUuid}
        showFork={!!blockDagUuid}
      />
    </div>
  );
}

function TranscriptBlockItem({
  block,
  isSelected,
  selectMode,
  onToggleSelect,
  onShiftSelect,
  onToggleCollapse,
  collapsed,
}: {
  block: ConversationBlock;
  isSelected: boolean;
  selectMode: boolean;
  onToggleSelect: () => void;
  onShiftSelect: () => void;
  onToggleCollapse: () => void;
  collapsed: boolean;
}): JSX.Element {
  const isCollapsible = isCollapsibleBlock(block.type);
  const metadata = parseMetadata(block.metadata_json);
  const isErrorEvent = block.type === 'event' && (metadata.is_error === true || metadata.level === 'error');
  const typeIcon = BlockTypeIcon({ type: block.type });
  const hasTypeIcon = typeIcon !== null;
  const className = [
    'transcript-item',
    `transcript-item--${block.type.replace('_', '-')}`,
    hasTypeIcon ? 'transcript-item--with-gutter' : '',
    collapsed ? 'transcript-item--collapsed' : '',
    isSelected ? 'transcript-item--selected' : '',
    isErrorEvent ? 'transcript-item--error' : '',
    selectMode ? 'transcript-item--selectable' : '',
  ].filter(Boolean).join(' ');

  // Bug: bce7370 — Fix 1: For thinking blocks, skip the outer collapse mechanism
  // and let the shared ThinkingBlock handle its own collapse UI ("Thinking" + "more").
  const isThinkingBlock = block.type === 'thinking';

  const handleClick = (e: MouseEvent) => {
    if (selectMode) {
      if (e.shiftKey) {
        onShiftSelect();
      } else {
        onToggleSelect();
      }
      return;
    }
    // Don't toggle outer collapse for thinking blocks — ThinkingBlock handles it
    if (isCollapsible && !isThinkingBlock) {
      onToggleCollapse();
    }
  };

  return (
    <div className={className} onClick={handleClick} data-block-id={block.id}>
      <div className="transcript-item__frame">
        {hasTypeIcon ? (
          <div className="transcript-item__gutter" aria-hidden="true">
            {typeIcon}
          </div>
        ) : null}
        <div className="transcript-item__bubble">
          {isThinkingBlock ? (
            // Bug: bce7370 — Fix 1: Render ThinkingBlock directly, bypassing outer collapse.
            // ThinkingBlock shows "Thinking" + "more" pattern, matching Chat view.
            <ThinkingBlock content={block.content} defaultCollapsed={true} />
          ) : collapsed ? (
            <div className="transcript-item__collapsed-preview" aria-label="Collapsed block">
              …
            </div>
          ) : (
            renderConversationBlockBody(block, collapsed)
          )}
        </div>
      </div>
      <span
        className="transcript-item__timestamp"
        title={formatAbsoluteTime(block.timestamp)}
      >
        {formatRelativeTime(block.timestamp)}
      </span>
      <div className="transcript-item__actions">
        <CopyButton content={block.content} />
        <label
          className={`transcript-item__select${selectMode || isSelected ? ' transcript-item__select--visible' : ''}`}
          title={isSelected ? 'Deselect block' : 'Select block'}
          onClick={(e) => e.stopPropagation()}
        >
          <input
            type="checkbox"
            checked={isSelected}
            onChange={onToggleSelect}
            className="block-checkbox"
            aria-label={isSelected ? 'Deselect block' : 'Select block'}
          />
        </label>
      </div>
    </div>
  );
}

function TranscriptTurnRenderer({
  turn,
  selected,
  selectMode,
  collapsedBlocks,
  onToggleSelect,
  onShiftSelect,
  onToggleCollapse,
  onFork,
  onResume,
  forkData,
  branchSelections,
  onBranchSelect,
}: {
  turn: TranscriptTurn;
  selected: Set<string>;
  selectMode: boolean;
  collapsedBlocks: Set<string>;
  onToggleSelect: (blockId: string) => void;
  onShiftSelect: (blockId: string) => void;
  onToggleCollapse: (blockId: string) => void;
  onFork?: (dagUuid: string) => void;
  onResume?: (dagUuid: string) => void;
  forkData?: ForkData | null;
  branchSelections?: Record<string, number>;
  onBranchSelect?: (forkPointUuid: string, index: number, forkPoint: ForkPoint) => void;
}): JSX.Element {
  // Collect text content for copy action across all blocks in this turn
  const turnText = turn.blocks.map((b) => b.content).join('\n\n');
  // dag_uuid: use the first block's dag_uuid if available (populated after P1 merges)
  const turnDagUuid = turn.blocks[0]?.dag_uuid ?? undefined;

  // Branch selector data: find fork point matching this turn's dagUuid
  const forkPoint = forkData?.forks.find((fp) => fp.parent_dag_uuid === turnDagUuid);
  const currentBranchIdx = forkPoint && branchSelections ? (branchSelections[turnDagUuid ?? ''] ?? 0) : 0;
  const branchInfos: BranchInfo[] | undefined = forkPoint?.branches.map((b) => ({
    dagUuid: b.dag_uuid,
    firstText: b.first_text,
    blockCount: b.block_count,
  }));

  const isShort = turn.blocks.length <= 2;

  // Bug: bce7370 — Use shared TurnGroup layout
  const footer = (
    <>
      <MessageActions
        onCopy={() => { navigator.clipboard.writeText(turnText).catch(() => {}); }}
        onResume={turnDagUuid && onResume ? () => onResume(turnDagUuid) : undefined}
        onFork={turnDagUuid && onFork ? () => onFork(turnDagUuid) : undefined}
        dagUuid={turnDagUuid}
        showResume={!!turnDagUuid}
        showFork={!!turnDagUuid}
      />
      {forkPoint && turnDagUuid && (
        <BranchSelector
          branchPointUuid={turnDagUuid}
          totalBranches={forkPoint.branches.length}
          currentIndex={currentBranchIdx}
          onSelect={(idx) => onBranchSelect?.(turnDagUuid, idx, forkPoint)}
          branches={branchInfos}
        />
      )}
    </>
  );

  return (
    <TurnGroup speaker={turn.speaker} isShort={isShort} footer={footer}>
      {turn.blocks.map((block) => (
        <TranscriptBlockItem
          key={block.id}
          block={block}
          isSelected={selected.has(block.id)}
          selectMode={selectMode}
          onToggleSelect={() => onToggleSelect(block.id)}
          onShiftSelect={() => onShiftSelect(block.id)}
          onToggleCollapse={() => onToggleCollapse(block.id)}
          collapsed={collapsedBlocks.has(block.id)}
        />
      ))}
    </TurnGroup>
  );
}

function ContentWithExpand({ content }: { content: string }): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const displayContent = expanded ? content : truncate(content, 500);

  return (
    <div>
      <pre className="block-pre">{displayContent}</pre>
      {content.length > 500 && (
        <button
          type="button"
          className="btn btn--ghost btn--sm block-expand-btn"
          onClick={(e) => {
            e.stopPropagation();
            setExpanded((prev) => !prev);
          }}
        >
          {expanded ? 'Show less' : `Show more (${content.length.toLocaleString()} chars)`}
        </button>
      )}
    </div>
  );
}

// ── Export Panel ──

function ExportPanel({
  conversationId,
  exportableCount,
  totalSelectedCount,
  hiddenSelectedCount,
  selectedIds,
  onClose,
}: {
  conversationId: string;
  exportableCount: number;
  totalSelectedCount: number;
  hiddenSelectedCount: number;
  selectedIds: string[];
  onClose: () => void;
}): JSX.Element {
  const [format, setFormat] = useState<'mdx' | 'markdown' | 'json'>('markdown');
  const [status, setStatus] = useState<'idle' | 'exporting' | 'done' | 'error'>('idle');
  const [result, setResult] = useState<{ content: string; filename: string } | null>(null);

  const handleExport = async () => {
    setStatus('exporting');
    try {
      const res = await exportConversationBlocks(conversationId, {
        block_ids: selectedIds,
        format,
      });
      setResult(res);
      setStatus('done');
    } catch {
      setStatus('error');
    }
  };

  const handleCopy = async () => {
    if (result?.content) {
      await navigator.clipboard.writeText(result.content);
    }
  };

  const handleDownload = () => {
    if (!result) return;
    const blob = new Blob([result.content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = result.filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="export-panel">
      <div className="export-panel__header">
        <h3 className="export-panel__title">Export Blocks</h3>
        <button type="button" className="btn btn--ghost btn--sm" onClick={onClose}>
          Close
        </button>
      </div>

      <div className="export-panel__info">
        <span>{exportableCount} visible selected block{exportableCount !== 1 ? 's' : ''}</span>
        {hiddenSelectedCount > 0 && (
          <span className="text-muted"> + {hiddenSelectedCount} hidden (excluded)</span>
        )}
      </div>

      <div className="export-panel__format">
        <label className="export-panel__label">Format</label>
        <div className="toggle-group">
          {(['markdown', 'mdx', 'json'] as const).map((f) => (
            <button
              key={f}
              type="button"
              className={`btn btn--sm${format === f ? ' btn--active' : ' btn--ghost'}`}
              onClick={() => setFormat(f)}
            >
              {f.toUpperCase()}
            </button>
          ))}
        </div>
      </div>

      <div className="export-panel__actions">
        {status === 'idle' && (
          <button
            type="button"
            className="btn btn--success"
            onClick={handleExport}
            disabled={exportableCount === 0}
          >
            Export
          </button>
        )}
        {status === 'exporting' && (
          <span className="text-muted">Exporting...</span>
        )}
        {status === 'done' && result && (
          <div className="export-panel__result">
            <div className="export-panel__result-actions">
              <button type="button" className="btn btn--ghost btn--sm" onClick={handleCopy}>
                Copy to clipboard
              </button>
              <button type="button" className="btn btn--ghost btn--sm" onClick={handleDownload}>
                Download ({result.filename})
              </button>
            </div>
            <pre className="export-panel__preview">{truncate(result.content, 2000)}</pre>
          </div>
        )}
        {status === 'error' && (
          <div className="export-panel__error">
            <span className="text-muted">Export failed.</span>
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => setStatus('idle')}>
              Retry
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Detail View ──

function SubAgentsList({
  children,
  onNavigate,
}: {
  children: ConversationChild[];
  onNavigate: (id: string) => void;
}): JSX.Element {
  const [expanded, setExpanded] = useState(true);

  if (children.length === 0) return <></>;

  return (
    <div className="conv-subagents">
      <button
        type="button"
        className="conv-subagents__header"
        onClick={() => setExpanded((prev) => !prev)}
      >
        <span className="conv-subagents__toggle">{expanded ? '\u25BE' : '\u25B8'}</span>
        <span className="conv-subagents__title">Sub-agents ({children.length})</span>
      </button>
      {expanded && (
        <div className="conv-subagents__list">
          {children.map((child) => {
            const durationStr = child.duration_seconds != null
              ? child.duration_seconds < 60
                ? `${child.duration_seconds}s`
                : `${Math.floor(child.duration_seconds / 60)}m ${child.duration_seconds % 60}s`
              : null;
            return (
              <div
                key={child.id}
                className="conv-subagent-card"
                onClick={() => onNavigate(child.id)}
              >
                <div className="conv-subagent-card__title">
                  {truncate(child.title || 'Untitled', 60)}
                </div>
                <div className="conv-subagent-card__meta">
                  <span>{child.block_count} blocks</span>
                  {durationStr && <span>{durationStr}</span>}
                  {child.model && <span className="conv-subagent-card__model">{child.model}</span>}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ConversationDetail({
  conversationId,
  onNavigate,
  consoleSessions,
}: {
  conversationId: string;
  onNavigate: (id: string) => void;
  consoleSessions: ConsoleSession[];
}): JSX.Element {
  const [conversation, setConversation] = useState<(Conversation & { blocks: ConversationBlock[]; children: ConversationChild[] }) | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loadNonce, setLoadNonce] = useState(0);

  // Selection state
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [lastSelectedId, setLastSelectedId] = useState<string | null>(null);
  const [visibleTypes, setVisibleTypes] = useState<Set<BlockType>>(new Set(ALL_BLOCK_TYPES));
  const [collapsedBlocks, setCollapsedBlocks] = useState<Set<string>>(new Set());
  const [showExport, setShowExport] = useState(false);
  const [renderMode, setRenderMode] = useState<'transcript' | 'raw'>('transcript');

  // Bug: 84cd5ae — linked issue pills in conversation detail
  const [sessionIssueLinks, setSessionIssueLinks] = useState<Array<{ issue_id: string; repo_id: string }>>([]);
  // Bug: 11f4f47 — preset provenance in conversation history
  const [sessionPresets, setSessionPresets] = useState<SessionPreset[]>([]);

  // Fork/resume state
  const [toast, setToast] = useState<ToastState>(null);
  const [conflictDialog, setConflictDialog] = useState<{ dagUuid: string } | null>(null);
  const [forkData, setForkData] = useState<ForkData | null>(null);
  const [branchSelections, setBranchSelections] = useState<Record<string, number>>({});
  const [selectedLeaf, setSelectedLeaf] = useState<string | null>(null);

  // Virtual scroll state
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [containerHeight, setContainerHeight] = useState(800);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    getConversation(conversationId)
      .then((conv) => {
        if (!active) return;
        setConversation(conv);
        // Bug: bce7370 — Fix 1: Don't add thinking blocks to the outer collapsed set.
        // ThinkingBlock now manages its own collapse state internally.
        const defaultCollapsed = new Set<string>();
        for (const block of conv.blocks) {
          if (block.type === 'system') {
            defaultCollapsed.add(block.id);
          }
        }
        setCollapsedBlocks(defaultCollapsed);
        setLoading(false);
      })
      .catch((err) => {
        if (!active) return;
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });
    return () => { active = false; };
  }, [conversationId, loadNonce]);

  // Fetch fork data for branch selector
  useEffect(() => {
    let active = true;
    getConversationForks(conversationId)
      .then((data) => {
        if (active) setForkData(data);
      })
      .catch(() => {
        // Non-critical — branch selector will just not show
      });
    return () => { active = false; };
  }, [conversationId, loadNonce]);

  // Bug: 84cd5ae — fetch linked issues for the conversation's session
  useEffect(() => {
    if (!conversation?.session_id) {
      setSessionIssueLinks([]);
      return;
    }
    let active = true;
    getSessionIssues(conversation.session_id)
      .then((data) => {
        if (active) {
          setSessionIssueLinks(
            (data as Array<{ issue_id: string; repo_id: string }>).filter(
              (d) => d.issue_id && d.repo_id
            )
          );
        }
      })
      .catch(() => {
        if (active) setSessionIssueLinks([]);
      });
    return () => { active = false; };
  }, [conversation?.session_id]);

  // Bug: 11f4f47 — fetch preset provenance for the conversation's session
  useEffect(() => {
    if (!conversation?.session_id) {
      setSessionPresets([]);
      return;
    }
    let active = true;
    getSessionPresets(conversation.session_id)
      .then((data) => {
        if (active) setSessionPresets(data);
      })
      .catch(() => {
        if (active) setSessionPresets([]);
      });
    return () => { active = false; };
  }, [conversation?.session_id]);

  // Reload conversation when a leaf branch is selected
  useEffect(() => {
    if (!selectedLeaf) return;
    let active = true;
    setLoading(true);
    getConversation(conversationId, selectedLeaf)
      .then((conv) => {
        if (!active) return;
        setConversation(conv);
        setLoading(false);
      })
      .catch(() => {
        if (!active) return;
        setLoading(false);
      });
    return () => { active = false; };
  }, [conversationId, selectedLeaf]);

  // Toast auto-dismiss
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 4000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  // Fork/resume handlers
  const handleFork = useCallback(async (dagUuid: string) => {
    try {
      await forkConversation(conversationId, dagUuid);
      // The forked conversation won't be available until ingestion picks it up (~3s).
      // Show a success toast and stay on the current page instead of navigating to
      // a conversation that doesn't exist yet.
      setToast({ message: 'Forked conversation — it will appear in History shortly.', type: 'info' });
    } catch (err) {
      setToast({ message: `Fork failed: ${err instanceof Error ? err.message : String(err)}`, type: 'error' });
    }
  }, [conversationId]);

  const handleResume = useCallback(async (dagUuid: string) => {
    // Check conflict: is this conversation active in Console?
    const activeSession = consoleSessions.find(
      (s) => s.provider_session_id === conversation?.session_id && s.status !== 'stopped' && s.status !== 'crashed'
    );

    if (activeSession) {
      // Check auto-fork policy
      let policy: ResumeConflictPolicy = 'prompt';
      try {
        const settings = await getSettings();
        const stored = settings.resume_conflict_policy;
        if (stored === 'auto_fork' || stored === 'prompt' || stored === 'allow_concurrent') {
          policy = stored;
        }
      } catch {
        // Default to prompt if settings unavailable
      }

      if (policy === 'auto_fork') {
        // Fork first, then resume the fork
        try {
          await forkConversation(conversationId, dagUuid);
          setToast({ message: 'Auto-forked due to active session — it will appear in History shortly.', type: 'info' });
        } catch (err) {
          setToast({ message: `Auto-fork failed: ${err instanceof Error ? err.message : String(err)}`, type: 'error' });
        }
        return;
      }

      if (policy === 'prompt') {
        setConflictDialog({ dagUuid });
        return;
      }
      // allow_concurrent — fall through to resume directly
    }

    // No conflict or allow_concurrent — resume directly
    try {
      const result = await resumeConversation(conversationId, dagUuid);
      setToast({ message: 'Resuming conversation in Console...', type: 'info' });
      window.location.hash = `#/console?session=${encodeURIComponent(result.console_session_id)}`;
    } catch (err) {
      setToast({ message: `Resume failed: ${err instanceof Error ? err.message : String(err)}`, type: 'error' });
    }
  }, [conversationId, consoleSessions, conversation?.session_id]);

  const handleConflictBranch = useCallback(async (remember: boolean) => {
    if (!conflictDialog) return;
    const dagUuid = conflictDialog.dagUuid;
    setConflictDialog(null);
    if (remember) {
      try {
        const { updateSetting } = await import('../api.js');
        await updateSetting('resume_conflict_policy', 'allow_concurrent');
      } catch { /* non-critical */ }
    }
    try {
      const result = await resumeConversation(conversationId, dagUuid);
      setToast({ message: 'Resuming conversation in Console...', type: 'info' });
      window.location.hash = `#/console?session=${encodeURIComponent(result.console_session_id)}`;
    } catch (err) {
      setToast({ message: `Resume failed: ${err instanceof Error ? err.message : String(err)}`, type: 'error' });
    }
  }, [conflictDialog, conversationId]);

  const handleConflictFork = useCallback(async (remember: boolean) => {
    if (!conflictDialog) return;
    const dagUuid = conflictDialog.dagUuid;
    setConflictDialog(null);
    if (remember) {
      try {
        const { updateSetting } = await import('../api.js');
        await updateSetting('resume_conflict_policy', 'auto_fork');
      } catch { /* non-critical */ }
    }
    try {
      await forkConversation(conversationId, dagUuid);
      setToast({ message: 'Forked conversation — it will appear in History shortly.', type: 'info' });
    } catch (err) {
      setToast({ message: `Fork failed: ${err instanceof Error ? err.message : String(err)}`, type: 'error' });
    }
  }, [conflictDialog, conversationId]);

  // Branch selection handler
  const handleBranchSelect = useCallback((forkPointUuid: string, index: number, forkPoint: ForkPoint) => {
    setBranchSelections((prev) => ({ ...prev, [forkPointUuid]: index }));
    const branch = forkPoint.branches[index];
    if (branch) {
      setSelectedLeaf(branch.dag_uuid);
    }
  }, []);

  // Observe container resize
  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setContainerHeight(entry.contentRect.height);
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const blocks = conversation?.blocks || [];

  const visibleBlocks = useMemo(
    () => blocks.filter((b) => visibleTypes.has(b.type)),
    [blocks, visibleTypes],
  );
  const transcriptTurns = useMemo(() => buildTranscriptTurns(visibleBlocks), [visibleBlocks]);

  const exportableBlocks = useMemo(
    () => visibleBlocks.filter((b) => selected.has(b.id)),
    [visibleBlocks, selected],
  );

  const selectedHiddenCount = useMemo(() => {
    let count = 0;
    for (const id of selected) {
      const block = blocks.find((b) => b.id === id);
      if (block && !visibleTypes.has(block.type)) {
        count++;
      }
    }
    return count;
  }, [selected, blocks, visibleTypes]);

  // Block type counts for filter bar
  const typeCounts = useMemo(() => {
    const counts: Partial<Record<BlockType, number>> = {};
    for (const block of blocks) {
      counts[block.type] = (counts[block.type] || 0) + 1;
    }
    return counts;
  }, [blocks]);

  const presentTypes = useMemo(
    () => ALL_BLOCK_TYPES.filter((t) => (typeCounts[t] || 0) > 0),
    [typeCounts],
  );

  // Virtual scrolling
  const handleScroll = useCallback(() => {
    const el = scrollContainerRef.current;
    if (el) setScrollTop(el.scrollTop);
  }, []);

  const totalHeight = visibleBlocks.length * ESTIMATED_BLOCK_HEIGHT;
  const startIndex = Math.max(0, Math.floor(scrollTop / ESTIMATED_BLOCK_HEIGHT) - VIRTUAL_BUFFER);
  const endIndex = Math.min(
    visibleBlocks.length,
    Math.ceil((scrollTop + containerHeight) / ESTIMATED_BLOCK_HEIGHT) + VIRTUAL_BUFFER,
  );
  const shouldVirtualize = visibleBlocks.length > 200;
  const renderedBlocks = shouldVirtualize ? visibleBlocks.slice(startIndex, endIndex) : visibleBlocks;

  // Selection handlers
  const toggleSelect = (blockId: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(blockId)) {
        next.delete(blockId);
      } else {
        next.add(blockId);
      }
      return next;
    });
    setLastSelectedId(blockId);
  };

  const handleShiftSelect = (blockId: string) => {
    if (!lastSelectedId) {
      toggleSelect(blockId);
      return;
    }
    const startIdx = visibleBlocks.findIndex((b) => b.id === lastSelectedId);
    const endIdx = visibleBlocks.findIndex((b) => b.id === blockId);
    if (startIdx === -1 || endIdx === -1) {
      toggleSelect(blockId);
      return;
    }
    const low = Math.min(startIdx, endIdx);
    const high = Math.max(startIdx, endIdx);
    setSelected((prev) => {
      const next = new Set(prev);
      for (let i = low; i <= high; i++) {
        next.add(visibleBlocks[i].id);
      }
      return next;
    });
    setLastSelectedId(blockId);
  };

  const selectAllVisible = () => {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const block of visibleBlocks) {
        next.add(block.id);
      }
      return next;
    });
  };

  const clearSelection = () => {
    setSelected(new Set());
    setLastSelectedId(null);
  };

  const toggleType = (type: BlockType) => {
    setVisibleTypes((prev) => {
      const next = new Set(prev);
      if (next.has(type)) {
        next.delete(type);
      } else {
        next.add(type);
      }
      return next;
    });
  };

  const toggleCollapse = (blockId: string) => {
    setCollapsedBlocks((prev) => {
      const next = new Set(prev);
      if (next.has(blockId)) {
        next.delete(blockId);
      } else {
        next.add(blockId);
      }
      return next;
    });
  };

  const handleStarToggle = async () => {
    if (!conversation) return;
    const newStarred = conversation.starred ? 0 : 1;
    try {
      await updateConversation(conversationId, { starred: newStarred });
      setConversation((prev) => prev ? { ...prev, starred: newStarred } : prev);
    } catch {
      // ignore
    }
  };

  const linkedConsoleSession = useMemo(() => {
    if (!conversation?.session_id) return null;
    return consoleSessions.find((session) => session.provider_session_id === conversation.session_id) ?? null;
  }, [consoleSessions, conversation?.session_id]);

  if (loading) {
    return (
      <div className="conv-detail">
        <div className="empty-state">Loading conversation...</div>
      </div>
    );
  }

  if (error || !conversation) {
    return (
      <div className="conv-detail">
        <div className="empty-state">
          <div>{error || 'Conversation not found.'}</div>
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => setLoadNonce((prev) => prev + 1)}
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="conv-detail">
      {/* Parent link for sub-agent conversations */}
      {conversation.parent_conversation_id && (
        <div className="conv-parent-link">
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => onNavigate(conversation.parent_conversation_id!)}
          >
            &uarr; Parent conversation
          </button>
        </div>
      )}

      {/* Header */}
      <div className="conv-detail__header">
        <div className="conv-detail__header-left">
          <h2 className="conv-detail__title">
            {conversation.parent_conversation_id && (
              <span className="conv-subagent-indicator" title="Sub-agent conversation">&#x2937; </span>
            )}
            {/* Bug: a44fd6a — render conversation title as markdown */}
            <span
              dangerouslySetInnerHTML={{
                __html: renderInlineMarkdown(conversation.title || 'Untitled'),
              }}
            />
          </h2>
          <div className="conv-detail__meta">
            <span className={`source-badge ${SOURCE_CLASSES[conversation.source] || ''}`}>
              {SOURCE_LABELS[conversation.source] || conversation.source}
            </span>
            <span className="text-muted" title={formatAbsoluteTime(conversation.started_at)}>
              {formatRelativeTime(conversation.started_at)}
            </span>
            {conversation.branch && (
              <span className="branch-tag">{conversation.branch}</span>
            )}
            {conversation.model && (
              <span className="text-muted">{conversation.model}</span>
            )}
            {/* Bug: 84cd5ae — linked issue pills */}
            {sessionIssueLinks.length > 0 && sessionIssueLinks.map((link) => (
              <EntityPill
                key={`${link.repo_id}-${link.issue_id}`}
                type="issue"
                id={link.issue_id}
                repoId={link.repo_id}
              />
            ))}
            {/* Bug: 11f4f47 — preset provenance badges */}
            {sessionPresets.length > 0 && (
              <div className="session-presets">
                {sessionPresets.map((sp) => (
                  <span
                    key={sp.preset_id}
                    className="session-preset-badge"
                    title={`Preset: ${sp.preset_name} (v${sp.version})`}
                    onClick={() => { window.location.hash = `#/presets?id=${encodeURIComponent(sp.preset_id)}`; }}
                    style={{ cursor: 'pointer' }}
                  >
                    {sp.preset_name}
                    <span className="session-preset-badge__version">v{sp.version}</span>
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>
        <div className="conv-detail__header-right">
          {/* Bug: bce7370 — Resume button in conversation header */}
          {conversation.session_id && (
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => handleResume(conversation.blocks?.[conversation.blocks.length - 1]?.dag_uuid ?? '')}
              title="Resume this conversation in Console"
            >
              Resume
            </button>
          )}
          {linkedConsoleSession && (
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => {
                window.location.hash = `#/console?session=${encodeURIComponent(linkedConsoleSession.id)}`;
              }}
            >
              Open live chat
            </button>
          )}
          <button
            type="button"
            className={`btn btn--ghost btn--sm conv-star-btn${conversation.starred ? ' conv-star-btn--active' : ''}`}
            onClick={handleStarToggle}
            title={conversation.starred ? 'Unstar' : 'Star'}
          >
            {conversation.starred ? '\u2605' : '\u2606'}
          </button>
        </div>
      </div>

      {/* Sub-agents section */}
      {conversation.children && conversation.children.length > 0 && (
        <SubAgentsList children={conversation.children} onNavigate={onNavigate} />
      )}

      {/* Filter bar */}
      <div className="conv-filter-bar">
        <div className="conv-filter-bar__types">
          {presentTypes.map((type) => (
            <button
              key={type}
              type="button"
              className={`conv-filter-btn${visibleTypes.has(type) ? ' conv-filter-btn--active' : ''}`}
              onClick={() => toggleType(type)}
            >
              {BLOCK_TYPE_LABELS[type]}
              <span className="conv-filter-btn__count">{typeCounts[type] || 0}</span>
            </button>
          ))}
        </div>
        <div className="conv-filter-bar__actions">
          <div className="toggle-group">
            <button
              type="button"
              className={`btn btn--sm${renderMode === 'transcript' ? ' btn--active' : ' btn--ghost'}`}
              onClick={() => setRenderMode('transcript')}
            >
              Transcript
            </button>
            <button
              type="button"
              className={`btn btn--sm${renderMode === 'raw' ? ' btn--active' : ' btn--ghost'}`}
              onClick={() => setRenderMode('raw')}
            >
              Inspect raw
            </button>
          </div>
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => setVisibleTypes(new Set(ALL_BLOCK_TYPES))}
          >
            Show all
          </button>
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => setVisibleTypes(new Set())}
          >
            Hide all
          </button>
        </div>
      </div>

      {/* Selection toolbar */}
      {(selectMode || selected.size > 0) && (
        <div className="conv-selection-toolbar">
          <button
            type="button"
            className={`btn btn--sm${selectMode ? ' btn--active' : ' btn--ghost'}`}
            onClick={() => setSelectMode((prev) => !prev)}
          >
            Select mode
          </button>
          <span className="conv-selection-toolbar__count">
            {selected.size} selected
            {selectedHiddenCount > 0 && (
              <span className="text-muted"> + {selectedHiddenCount} hidden</span>
            )}
          </span>
          <button type="button" className="btn btn--ghost btn--sm" onClick={selectAllVisible}>
            Select all visible
          </button>
          <button type="button" className="btn btn--ghost btn--sm" onClick={clearSelection}>
            Clear
          </button>
          <button
            type="button"
            className="btn btn--success btn--sm"
            onClick={() => setShowExport(true)}
            disabled={exportableBlocks.length === 0}
          >
            Export ({exportableBlocks.length})
          </button>
        </div>
      )}

      {/* Enable select mode button when not in select mode */}
      {!selectMode && selected.size === 0 && (
        <div className="conv-selection-toolbar conv-selection-toolbar--minimal">
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => setSelectMode(true)}
          >
            Select mode
          </button>
        </div>
      )}

      {/* Export panel */}
      {showExport && (
        <ExportPanel
          conversationId={conversationId}
          exportableCount={exportableBlocks.length}
          totalSelectedCount={selected.size}
          hiddenSelectedCount={selectedHiddenCount}
          selectedIds={exportableBlocks.map((b) => b.id)}
          onClose={() => setShowExport(false)}
        />
      )}

      {renderMode === 'transcript' ? (
        <div className="conv-transcript">
          {transcriptTurns.map((turn) => (
            <TranscriptTurnRenderer
              key={turn.id}
              turn={turn}
              selected={selected}
              selectMode={selectMode}
              collapsedBlocks={collapsedBlocks}
              onToggleSelect={toggleSelect}
              onShiftSelect={handleShiftSelect}
              onToggleCollapse={toggleCollapse}
              onFork={handleFork}
              onResume={handleResume}
              forkData={forkData}
              branchSelections={branchSelections}
              onBranchSelect={handleBranchSelect}
            />
          ))}
          {transcriptTurns.length === 0 && (
            <div className="empty-state">No blocks match the current filters.</div>
          )}
        </div>
      ) : (
        <div
          className="conv-blocks"
          ref={scrollContainerRef}
          onScroll={handleScroll}
        >
          {shouldVirtualize ? (
            <div style={{ height: `${totalHeight}px`, position: 'relative' }}>
              <div style={{ position: 'absolute', top: `${startIndex * ESTIMATED_BLOCK_HEIGHT}px`, left: 0, right: 0 }}>
                {renderedBlocks.map((block) => (
                  <BlockRenderer
                    key={block.id}
                    block={block}
                    isSelected={selected.has(block.id)}
                    selectMode={selectMode}
                    onToggleSelect={() => toggleSelect(block.id)}
                    onShiftSelect={() => handleShiftSelect(block.id)}
                    onToggleCollapse={() => toggleCollapse(block.id)}
                    collapsed={collapsedBlocks.has(block.id)}
                    onFork={handleFork}
                    onResume={handleResume}
                  />
                ))}
              </div>
            </div>
          ) : (
            renderedBlocks.map((block) => (
              <BlockRenderer
                key={block.id}
                block={block}
                isSelected={selected.has(block.id)}
                selectMode={selectMode}
                onToggleSelect={() => toggleSelect(block.id)}
                onShiftSelect={() => handleShiftSelect(block.id)}
                onToggleCollapse={() => toggleCollapse(block.id)}
                collapsed={collapsedBlocks.has(block.id)}
                onFork={handleFork}
                onResume={handleResume}
              />
            ))
          )}
          {visibleBlocks.length === 0 && (
            <div className="empty-state">No blocks match the current filters.</div>
          )}
        </div>
      )}

      {/* Toast notification */}
      <Toast toast={toast} onDismiss={() => setToast(null)} />

      {/* Resume conflict dialog */}
      {conflictDialog && (
        <ResumeConflictDialog
          onBranch={handleConflictBranch}
          onFork={handleConflictFork}
          onCancel={() => setConflictDialog(null)}
        />
      )}
    </div>
  );
}

// ── Sidebar Item ──

function ChatHistoryItem({
  conversation,
  isSelected,
  onClick,
}: {
  conversation: Conversation;
  isSelected: boolean;
  onClick: () => void;
}): JSX.Element {
  const isSubAgent = !!conversation.parent_conversation_id;

  return (
    <div
      className={`chat-history-item${isSelected ? ' chat-history-item--selected' : ''}${isSubAgent ? ' chat-history-item--subagent' : ''}`}
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onClick(); }}
    >
      <div className="chat-history-item__header">
        <span className={`source-badge ${SOURCE_CLASSES[conversation.source] || ''}`}>
          {SOURCE_LABELS[conversation.source] || conversation.source}
        </span>
        <span className="chat-history-item__date" title={formatAbsoluteTime(conversation.started_at)}>
          {formatRelativeTime(conversation.started_at)}
        </span>
      </div>
      <div className="chat-history-item__title">
        {conversation.starred ? '\u2605 ' : ''}
        {isSubAgent && <span className="conv-subagent-indicator" title="Sub-agent">&#x2937; </span>}
        <span
          // Bug: a44fd6a — render conversation titles as inline markdown
          dangerouslySetInnerHTML={{
            __html: renderInlineMarkdown(truncate(conversation.title || 'Untitled', 55)),
          }}
        />
      </div>
      <div className="chat-history-item__meta">
        <span className="chat-history-item__blocks">{conversation.block_count} blocks</span>
        {conversation.branch && (
          <span className="chat-history-item__branch">{truncate(conversation.branch, 20)}</span>
        )}
      </div>
    </div>
  );
}

// ── Main View ──

export function ConversationsView({
  conversations: initialConversations,
  consoleSessions,
  initialConversationId,
  initialSessionId,
}: ConversationsViewProps): JSX.Element {
  const { width: sidebarWidth, handleMouseDown } = useSidebarResize({
    defaultWidth: 320,
    minWidth: 190,
    storageKey: 'sidebar-width:conversations',
  });

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [searchMode, setSearchMode] = useState<'title' | 'full'>('title');
  const [sourceFilter, setSourceFilter] = useState<ConversationSource | 'all'>('all');
  const [starredOnly, setStarredOnly] = useState(false);
  const [hideEmpty, setHideEmpty] = useState(true);
  const [groupSubAgents, setGroupSubAgents] = useState(true);
  const [sort, setSort] = useState<'date' | 'blocks'>('date');
  const [conversations, setConversations] = useState<Conversation[]>(initialConversations);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [ingesting, setIngesting] = useState(false);
  const searchTimer = useRef<number | null>(null);
  const conversationsRef = useRef(conversations);
  conversationsRef.current = conversations;

  useEffect(() => {
    if (!initialConversationId) return;
    setSelectedId(initialConversationId);
  }, [initialConversationId]);

  useEffect(() => {
    let active = true;
    let retryTimer: number | null = null;

    if (initialConversationId || !initialSessionId) {
      return () => {
        active = false;
      };
    }

    const resolveConversation = (attemptsRemaining: number) => {
      void getConversations({ session_id: initialSessionId, limit: 1 })
        .then((result) => {
          if (!active) return;
          const resolvedId = result.conversations[0]?.id ?? null;
          if (resolvedId) {
            setSelectedId(resolvedId);
            return;
          }
          if (attemptsRemaining > 0) {
            retryTimer = window.setTimeout(() => resolveConversation(attemptsRemaining - 1), 1500);
          }
        })
        .catch(() => {
          if (!active) return;
          if (attemptsRemaining > 0) {
            retryTimer = window.setTimeout(() => resolveConversation(attemptsRemaining - 1), 1500);
          }
        });
    };

    resolveConversation(5);

    return () => {
      active = false;
      if (retryTimer !== null) {
        window.clearTimeout(retryTimer);
      }
    };
  }, [initialConversationId, initialSessionId]);

  // Fetch conversations. Uses ref for offset to avoid stale closure.
  const fetchConversations = useCallback(async (reset = true) => {
    setLoading(true);
    try {
      const params: {
        source?: string;
        starred?: boolean;
        search?: string;
        offset?: number;
        limit?: number;
        sort?: string;
        group?: boolean;
      } = {
        limit: PAGE_SIZE,
        offset: reset ? 0 : conversationsRef.current.length,
        sort: sort === 'blocks' ? 'block_count' : 'started_at',
      };
      if (sourceFilter !== 'all') params.source = sourceFilter;
      if (starredOnly) params.starred = true;
      if (search.trim()) params.search = search.trim();
      if (groupSubAgents) params.group = true;

      const result = await getConversations(params);
      if (reset) {
        setConversations(result.conversations);
      } else {
        setConversations((prev) => [...prev, ...result.conversations]);
      }
      setTotal(result.total);
    } catch {
      // ignore fetch errors
    } finally {
      setLoading(false);
    }
  }, [sourceFilter, starredOnly, sort, search, groupSubAgents]);

  // When parent's initialConversations changes (e.g., via SSE upsert), re-fetch
  // with current filters instead of blindly overwriting local state.
  // Bug: d51fbc8 — SSE updates were overwriting filtered/paginated conversation list
  const initialConversationsRef = useRef(initialConversations);
  useEffect(() => {
    // Skip the first render (already used as initial state)
    if (initialConversationsRef.current === initialConversations) return;
    initialConversationsRef.current = initialConversations;
    fetchConversations(true);
  }, [initialConversations, fetchConversations]);

  // Debounced fetch on filter changes
  useEffect(() => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = window.setTimeout(() => {
      fetchConversations(true);
    }, 300);
    return () => {
      if (searchTimer.current) clearTimeout(searchTimer.current);
    };
  }, [fetchConversations]);

  const handleIngest = async () => {
    setIngesting(true);
    try {
      await triggerIngestion();
      await fetchConversations(true);
    } catch {
      // ignore
    } finally {
      setIngesting(false);
    }
  };

  const loadMore = () => {
    fetchConversations(false);
  };

  const hasMore = conversations.length < total;

  // Client-side title-only filter (when searchMode === 'title', server already
  // searched summary too, so we narrow here to title-only for the title mode).
  // When searchMode === 'full', server search is sufficient — show all results.
  const displayedConversations = useMemo(() => {
    const base = conversations.filter((conv) => !hideEmpty || conv.block_count > 0);
    if (!search.trim() || searchMode === 'full') return base;
    const needle = search.trim().toLowerCase();
    return base.filter((conv) =>
      (conv.title || '').toLowerCase().includes(needle)
    );
  }, [conversations, hideEmpty, search, searchMode]);

  return (
    <div className="chat-history-view">
      {/* Sidebar */}
      <div className="chat-history-sidebar" style={{ ...(sidebarWidth !== null ? { width: `${sidebarWidth}px` } : {}), flexShrink: 0 }}>
        {/* Search row */}
        <div className="chat-history-search-row">
          <input
            type="text"
            className="conv-search"
            placeholder="Search…"
            value={search}
            onInput={(e) => setSearch((e.target as HTMLInputElement).value)}
          />
          <button
            type="button"
            className={`btn btn--sm chat-history-search-mode${searchMode === 'full' ? ' btn--active' : ' btn--ghost'}`}
            title={searchMode === 'title' ? 'Title-only search (click for full text)' : 'Full-text search (click for title only)'}
            onClick={() => setSearchMode((prev) => prev === 'title' ? 'full' : 'title')}
          >
            {searchMode === 'full' ? 'Full' : 'Title'}
          </button>
        </div>

        {/* Source filters */}
        <div className="chat-history-filters">
          <div className="conv-filters__sources">
            {(['all', 'claude_code', 'codex', 'gemini'] as const).map((src) => (
              <button
                key={src}
                type="button"
                className={`conv-filter-btn${sourceFilter === src ? ' conv-filter-btn--active' : ''}`}
                onClick={() => setSourceFilter(src)}
              >
                {src === 'all' ? 'All' : SOURCE_LABELS[src]}
              </button>
            ))}
          </div>
          <div className="chat-history-filter-controls">
            <button
              type="button"
              className={`btn btn--sm${starredOnly ? ' btn--active' : ' btn--ghost'}`}
              onClick={() => setStarredOnly((prev) => !prev)}
            >
              Starred
            </button>
            <button
              type="button"
              className={`btn btn--sm${groupSubAgents ? ' btn--active' : ' btn--ghost'}`}
              onClick={() => setGroupSubAgents((prev) => !prev)}
              title="When on, sub-agent conversations are hidden from the main list and shown under their parent"
            >
              Group subs
            </button>
            <button
              type="button"
              className={`btn btn--sm${hideEmpty ? ' btn--active' : ' btn--ghost'}`}
              onClick={() => setHideEmpty((prev) => !prev)}
            >
              Hide empty
            </button>
            <select
              className="conv-sort"
              value={sort}
              onChange={(e) => setSort((e.target as HTMLSelectElement).value as 'date' | 'blocks')}
            >
              <option value="date">Date</option>
              <option value="blocks">Blocks</option>
            </select>
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={handleIngest}
              disabled={ingesting}
              title="Refresh conversation logs"
            >
              {ingesting ? '…' : 'Refresh'}
            </button>
          </div>
        </div>

        {/* List */}
        <div className="chat-history-list">
          {displayedConversations.map((conv) => (
            <ChatHistoryItem
              key={conv.id}
              conversation={conv}
              isSelected={selectedId === conv.id}
              onClick={() => setSelectedId(conv.id)}
            />
          ))}
          {displayedConversations.length === 0 && !loading && (
            <div className="chat-history-empty">
              No conversations found.
            </div>
          )}
          {loading && (
            <div className="chat-history-empty">Loading…</div>
          )}
          {hasMore && !loading && (
            <button type="button" className="btn btn--ghost chat-history-load-more" onClick={loadMore}>
              Load more ({total - conversations.length} remaining)
            </button>
          )}
        </div>
      </div>

      {/* Drag handle */}
      <div className="sidebar-drag-handle" onMouseDown={handleMouseDown} />

      {/* Detail pane */}
      <div className="chat-history-detail">
        {selectedId ? (
          <ConversationDetail
            conversationId={selectedId}
            onNavigate={(id) => setSelectedId(id)}
            consoleSessions={consoleSessions}
          />
        ) : (
          <div className="chat-history-detail__empty">
            Select a conversation to view it
          </div>
        )}
      </div>
    </div>
  );
}
