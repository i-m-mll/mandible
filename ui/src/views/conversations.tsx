import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { marked } from 'marked';
import { useSidebarResize } from '../hooks/useSidebarResize';
import type {
  BlockType,
  Conversation,
  ConversationBlock,
  ConversationChild,
  ConversationSource,
} from '../api.js';
import {
  exportConversationBlocks,
  getConversation,
  getConversations,
  triggerIngestion,
  updateConversation,
} from '../api.js';

// Configure marked for safe, synchronous rendering
marked.setOptions({ async: false, gfm: true, breaks: false });

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

// ── Props ──

export type ConversationsViewProps = {
  conversations: Conversation[];
};

// ── Markdown renderer ──

/**
 * Render markdown content safely. Uses marked synchronously (marked.parse
 * returns string when async:false). Returns null if the content doesn't look
 * like markdown (no special characters) to avoid wrapping plaintext in a div.
 * Bug: 372edcb — markdown rendering for assistant/user messages
 */
function MarkdownContent({ content }: { content: string }): JSX.Element {
  const html = marked.parse(content) as string;
  // eslint-disable-next-line react/no-danger
  return (
    <div
      className="block-markdown"
      // marked sanitizes by default; content is from our own DB
      // eslint-disable-next-line react/no-danger
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

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
    >
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}

// ── Tool use card ──

/**
 * Extract the primary argument to display in the tool use card.
 * For Read/Write/Edit: file_path. For Grep/Glob: pattern. For Bash: description
 * (trimmed). For WebFetch: url. Fallback: first value or empty.
 * Bug: 372edcb — compact tool card rendering
 */
function primaryToolArg(toolName: string | undefined, toolInput: unknown): string {
  if (!toolInput || typeof toolInput !== 'object') return '';
  const inp = toolInput as Record<string, unknown>;
  const priority: string[] = (() => {
    switch (toolName) {
      case 'Read': case 'Write': case 'Edit': return ['file_path'];
      case 'Bash': return ['description', 'command'];
      case 'Grep': return ['pattern', 'path'];
      case 'Glob': return ['pattern', 'path'];
      case 'WebFetch': return ['url'];
      case 'WebSearch': return ['query'];
      default: return ['path', 'file_path', 'pattern', 'query', 'url', 'command'];
    }
  })();
  for (const key of priority) {
    if (typeof inp[key] === 'string' && inp[key]) {
      const val = inp[key] as string;
      return val.length > 80 ? val.slice(0, 80) + '…' : val;
    }
  }
  // Fallback: first string value
  for (const v of Object.values(inp)) {
    if (typeof v === 'string' && v) return v.length > 80 ? v.slice(0, 80) + '…' : v;
  }
  return '';
}

function ToolUseCard({
  toolName,
  toolInput,
  fullContent,
}: {
  toolName: string | undefined;
  toolInput: unknown;
  fullContent: string;
}): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const primary = primaryToolArg(toolName, toolInput);

  return (
    <div className="tool-use-card">
      <div className="tool-use-card__header">
        <span className="tool-use-card__name">{toolName ?? 'Tool'}</span>
        {primary && <span className="tool-use-card__arg">{primary}</span>}
        <button
          type="button"
          className="tool-use-card__expand"
          onClick={(e) => { e.stopPropagation(); setExpanded((p) => !p); }}
        >
          {expanded ? 'less' : 'more'}
        </button>
      </div>
      {expanded && (
        <pre className="block-pre tool-use-card__full">{fullContent}</pre>
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
}: {
  block: ConversationBlock;
  isSelected: boolean;
  selectMode: boolean;
  onToggleSelect: () => void;
  onShiftSelect: () => void;
  onToggleCollapse: () => void;
  collapsed: boolean;
}): JSX.Element {
  const metadata = parseMetadata(block.metadata_json);
  const isCollapsible =
    block.type === 'thinking' ||
    block.type === 'tool_use' ||
    block.type === 'tool_result' ||
    block.type === 'system' ||
    block.type === 'event';

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

  const headerLabel = (() => {
    switch (block.type) {
      case 'user_message':
        return null; // no header label for user messages
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
  })();

  // Render markdown for assistant and user messages; mono pre for everything else
  const renderContent = () => {
    if (collapsed) return null;

    if (block.type === 'assistant_message' || block.type === 'user_message') {
      return (
        <div className="block-content">
          <MarkdownContent content={block.content} />
        </div>
      );
    }

    if (block.type === 'tool_use') {
      const toolName = metadata.tool_name as string | undefined;
      const toolInput = (metadata.tool_input ?? null) as unknown;
      return (
        <div className="block-content block-content--mono">
          <ToolUseCard toolName={toolName} toolInput={toolInput} fullContent={block.content} />
        </div>
      );
    }

    const showExpandButton = isCollapsible && block.content.length > 200;
    return (
      <div className={`block-content${block.type === 'tool_result' ? ' block-content--mono' : ''}`}>
        {showExpandButton ? (
          <ContentWithExpand content={block.content} />
        ) : (
          <pre className="block-pre">{block.content}</pre>
        )}
      </div>
    );
  };

  return (
    <div className={typeClass} onClick={handleClick} data-block-id={block.id}>
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
      {renderContent()}
    </div>
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
}: {
  conversationId: string;
  onNavigate: (id: string) => void;
}): JSX.Element {
  const [conversation, setConversation] = useState<(Conversation & { blocks: ConversationBlock[]; children: ConversationChild[] }) | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Selection state
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [lastSelectedId, setLastSelectedId] = useState<string | null>(null);
  const [visibleTypes, setVisibleTypes] = useState<Set<BlockType>>(new Set(ALL_BLOCK_TYPES));
  const [collapsedBlocks, setCollapsedBlocks] = useState<Set<string>>(new Set());
  const [showExport, setShowExport] = useState(false);

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
        if (active) {
          setConversation(conv);
          // Collapse thinking and system blocks by default
          const defaultCollapsed = new Set<string>();
          for (const block of conv.blocks) {
            if (block.type === 'thinking' || block.type === 'system') {
              defaultCollapsed.add(block.id);
            }
          }
          setCollapsedBlocks(defaultCollapsed);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (active) {
          setError(String(err));
          setLoading(false);
        }
      });
    return () => { active = false; };
  }, [conversationId]);

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
        <div className="empty-state">{error || 'Conversation not found.'}</div>
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
          </div>
        </div>
        <div className="conv-detail__header-right">
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

      {/* Block list */}
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
            />
          ))
        )}
        {visibleBlocks.length === 0 && (
          <div className="empty-state">No blocks match the current filters.</div>
        )}
      </div>
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

export function ConversationsView({ conversations: initialConversations }: ConversationsViewProps): JSX.Element {
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
