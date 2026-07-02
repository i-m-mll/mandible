import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
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
  getConversations,
  getSessionIssues,
  getSessionPresets,
  getSettings,
  resumeConversation,
  sendConsolePrompt,
  updateConsoleSession,
  updateConsoleSessionOptions,
  updateConversation,
  type SessionPreset,
} from '../api.js';
import { MessageActions } from '../components/shared/MessageActions';
import { TerminalPane } from '../components/console/TerminalPane';
import { NewSessionDialog } from '../components/console/NewSessionDialog';
import { SessionControls } from '../components/console/SessionControls';
import { EntityPill } from '../components/shared/EntityPill';
import { ChatSurface, conversationBlocksToStreamEvents } from '../chat';
import type { WorkRepo } from './work';
// Bug: bce7370 — Shared message-block components
import {
  TextBlock,
  ThinkingBlock,
  ToolUseBlock,
} from '../components/message-blocks';

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
  'plan',
  'tool_use',
  'tool_result',
  'system',
  'event',
];

const BLOCK_TYPE_LABELS: Record<BlockType, string> = {
  user_message: 'User',
  assistant_message: 'Assistant',
  thinking: 'Thinking',
  plan: 'Plan',
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

const SOURCE_MARKS: Record<ConversationSource, string> = {
  claude_code: 'CL',
  codex: 'CX',
  gemini: 'GM',
};

const AGENT_LABELS: Record<string, string> = {
  operator: 'Operator',
  claude: 'Claude',
  codex: 'Codex',
  gemini: 'Gemini',
  shell: 'Shell',
};

const MODEL_OPTIONS: Record<string, string[]> = {
  claude: ['sonnet', 'opus', 'haiku', 'sonnet[1m]', 'opusplan'],
  codex: ['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex', 'gpt-5.3-codex-spark', 'gpt-5.2'],
  gemini: [
    'auto',
    'pro',
    'flash',
    'flash-lite',
    'gemini-3.1-pro-preview',
    'gemini-3-flash-preview',
    'gemini-3.1-flash-lite-preview',
    'gemini-2.5-pro',
    'gemini-2.5-flash',
    'gemini-2.5-flash-lite',
  ],
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

function stripMarkdownText(src: string | null | undefined): string {
  if (!src) return '';
  return src
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^[\s>#*-]+/gm, '')
    .replace(/[*_~]{1,3}/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function getConversationTitle(conversation: Conversation | null | undefined): string {
  const raw = conversation?.label || conversation?.title || 'Untitled';
  return stripMarkdownText(raw) || 'Untitled';
}

function isLiveConsoleSession(session: ConsoleSession): boolean {
  return session.status !== 'stopped' && session.status !== 'crashed';
}

function getAgentLabel(agentType: string): string {
  return AGENT_LABELS[agentType] ?? agentType;
}

function getSourceMark(source: ConversationSource): string {
  return SOURCE_MARKS[source] ?? source.slice(0, 2).toUpperCase();
}

function sourceFromSession(session: ConsoleSession): ConversationSource | null {
  const agent = session.agent_type.toLowerCase();
  const command = (session.command ?? '').toLowerCase();
  if (agent.includes('claude') || command.includes('claude')) return 'claude_code';
  if (agent.includes('codex') || command.includes('codex')) return 'codex';
  if (agent.includes('gemini') || command.includes('gemini')) return 'gemini';
  return null;
}

function getSessionMark(session: ConsoleSession): string {
  const source = sourceFromSession(session);
  if (source) return getSourceMark(source);
  return getAgentLabel(session.agent_type).slice(0, 2).toUpperCase();
}

function getSessionProviderFamily(session: ConsoleSession): string {
  if (session.is_operator) return 'claude';
  const command = (session.command ?? session.agent_type).toLowerCase();
  if (command.includes('claude')) return 'claude';
  if (command.includes('gemini')) return 'gemini';
  if (command.includes('codex')) return 'codex';
  return command;
}

function parseModelFromArgs(args: string[] | undefined): string | undefined {
  if (!args) return undefined;
  for (let i = args.length - 2; i >= 0; i -= 1) {
    const arg = args[i];
    if ((arg === '--model' || arg === '-m') && args[i + 1]?.trim()) {
      return args[i + 1].trim();
    }
  }
  return undefined;
}

function normalizePathish(pathValue: string | null | undefined): string {
  if (!pathValue) return 'No Project';
  return pathValue.replace(/\\/g, '/').replace(/\/+$/, '');
}

function pathKey(pathValue: string | null | undefined): string {
  if (!pathValue) return '';
  return normalizePathish(pathValue).toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function decodeClaudeProjectPath(pathValue: string | null | undefined): string | null {
  if (!pathValue) return null;
  const normalized = normalizePathish(pathValue);
  const leaf = normalized.split('/').filter(Boolean).pop() ?? normalized;
  if (!leaf.startsWith('-')) return normalized;
  const parts = leaf.split('-').filter(Boolean);
  if (parts.length === 0) return normalized;
  return `/${parts.join('/')}`;
}

function isCodexUnboundArchivePath(pathValue: string | null | undefined): boolean {
  return /\/Documents\/Codex\/\d{4}-\d{2}-\d{2}\/[^/]+$/i.test(normalizePathish(pathValue));
}

function repoDisplayName(repo: WorkRepo): string | null {
  const name = typeof repo.name === 'string' ? repo.name.trim() : '';
  if (name) return name;
  const root = typeof repo.root === 'string' ? repo.root : typeof repo.path === 'string' ? repo.path : '';
  if (!root) return null;
  const parts = normalizePathish(root).split('/').filter(Boolean);
  return parts[parts.length - 1] ?? null;
}

function projectNameFromPath(pathValue: string | null | undefined): string {
  const normalized = normalizePathish(pathValue);
  if (normalized === 'No Project') return normalized;
  const parts = normalized.split('/').filter(Boolean);
  return parts[parts.length - 1] || 'No Project';
}

function getConversationProject(conversation: Conversation, workRepos: WorkRepo[] = []): string {
  if (
    conversation.source === 'codex' &&
    !conversation.project_path &&
    isCodexUnboundArchivePath(conversation.cwd)
  ) {
    return 'No Project';
  }

  const candidates = [
    conversation.cwd,
    conversation.project_path,
    decodeClaudeProjectPath(conversation.project_path),
  ].filter((value): value is string => Boolean(value));

  const repos = workRepos
    .map((repo) => {
      const root = typeof repo.root === 'string' ? repo.root : typeof repo.path === 'string' ? repo.path : '';
      return {
        repo,
        root,
        rootKey: pathKey(root),
        rootNorm: normalizePathish(root),
        name: repoDisplayName(repo),
      };
    })
    .filter((entry) => entry.root && entry.rootKey && entry.name && !entry.rootNorm.includes('/worktrees/'))
    .sort((a, b) => b.rootKey.length - a.rootKey.length);

  for (const candidate of candidates) {
    const normalized = normalizePathish(candidate);
    const candidateKey = pathKey(candidate);
    for (const repo of repos) {
      if (
        normalized === repo.rootNorm ||
        normalized.startsWith(`${repo.rootNorm}/`) ||
        candidateKey.startsWith(repo.rootKey)
      ) {
        return repo.name!;
      }
    }
  }

  const fallback = decodeClaudeProjectPath(conversation.project_path) ?? conversation.project_path ?? conversation.cwd;
  return projectNameFromPath(fallback);
}

function isSubagentConversation(conversation: Conversation): boolean {
  const sourcePath = normalizePathish(conversation.source_path).toLowerCase();
  const projectPath = normalizePathish(conversation.project_path).toLowerCase();
  const title = stripMarkdownText(conversation.title).toLowerCase();
  return Boolean(conversation.parent_conversation_id)
    || projectPath === 'subagents'
    || sourcePath.includes('/subagents/')
    || title.startsWith('you are a subagent');
}

function isSubagentSession(session: ConsoleSession): boolean {
  return stripMarkdownText(session.label).toLowerCase().startsWith('you are a subagent');
}

function getConversationTime(conversation: Conversation): number {
  const ended = conversation.ended_at ? Date.parse(conversation.ended_at) : Number.NaN;
  if (!Number.isNaN(ended)) return ended;
  const started = Date.parse(conversation.started_at);
  return Number.isNaN(started) ? 0 : started;
}

function getSessionTime(session: ConsoleSession): number {
  return session.started_at ?? session.created_at ?? 0;
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

type ViewMode = 'terminal' | 'rich' | 'events';
type ChatSelection =
  | { type: 'conversation'; id: string }
  | { type: 'session'; id: string }
  | null;
type ChatEntry = {
  key: string;
  project: string;
  time: number;
  kind: 'conversation' | 'session';
  conversation?: Conversation;
  session?: ConsoleSession;
  liveSession?: ConsoleSession | null;
};
type ChatProjectGroup = {
  project: string;
  latestTime: number;
  entries: ChatEntry[];
};
type ChatSectionId = 'pinned' | 'projects' | 'chats';
type ChatSidebarSections = {
  pinned: ChatEntry[];
  projects: ChatProjectGroup[];
  chats: ChatEntry[];
};
type ConversationWithDetails = Conversation & {
  blocks: ConversationBlock[];
  children: ConversationChild[];
};
function conversationShell(conversation: Conversation): ConversationWithDetails {
  return { ...conversation, blocks: [], children: [] };
}

function getEntryTitle(entry: ChatEntry): string {
  if (entry.conversation) return getConversationTitle(entry.conversation);
  return stripMarkdownText(entry.session?.label) || 'Untitled';
}

// ── Props ──

export type ConversationsViewProps = {
  conversations: Conversation[];
  consoleSessions: ConsoleSession[];
  workRepos: WorkRepo[];
  initialConversationId: string | null;
  initialSessionId: string | null;
  initialPresetId?: string | null;
  sidebarHidden?: boolean;
  onSelectSession: (sessionId: string) => void;
  onNewSession: (input: {
    label: string;
    backend: string;
    kind: string;
    backend_type: 'pty' | 'sdk' | 'spawn' | 'acp';
    transport_lane: 'sdk' | 'pty' | 'channel' | 'acp' | 'spawn';
    channel_enabled?: boolean;
    presetIds?: string[];
  }) => void;
};

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

// ── Tool use card ──
// Bug: bce7370 — ToolUseCard replaced by shared ToolUseBlock (compact mode) from message-blocks.

function renderConversationBlockBody(
  block: ConversationBlock,
  collapsed: boolean,
): JSX.Element | null {
  if (collapsed) return null;
  const metadata = parseMetadata(block.metadata_json);
  const instructionMeta = block.type === 'user_message' ? getInstructionMessageMeta(block.content) : null;

  // Bug: bce7370 — Use shared components for text and tool blocks
  if (block.type === 'assistant_message' || block.type === 'user_message') {
    return (
      <div className="block-content">
        {instructionMeta ? (
          <InstructionMessageBlock content={block.content} meta={instructionMeta} />
        ) : (
          <TextBlock content={block.content} />
        )}
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

type InstructionMessageMeta = {
  filename: 'AGENTS.md' | 'CLAUDE.md';
  scope: 'Project' | 'Global';
  path: string;
};

export function getInstructionMessageMeta(content: string): InstructionMessageMeta | null {
  const firstLine = content.split(/\r?\n/, 1)[0]?.trim() ?? '';
  const match = firstLine.match(/^#?\s*(AGENTS\.md|CLAUDE\.md) instructions for (.+)$/i);
  if (!match) return null;
  const filename = match[1].toUpperCase().startsWith('AGENTS') ? 'AGENTS.md' : 'CLAUDE.md';
  const path = match[2].trim();
  const scope = /\/(\.claude|\.dotfiles)(\/|$)|^~\/\.claude\//.test(path) ? 'Global' : 'Project';
  return { filename, scope, path };
}

function InstructionMessageBlock({
  content,
  meta,
}: {
  content: string;
  meta: InstructionMessageMeta;
}): JSX.Element {
  return (
    <details className="instruction-message-block">
      <summary className="instruction-message-block__summary">
        <span className="instruction-message-block__label">{meta.scope} {meta.filename}</span>
        <span className="instruction-message-block__path">{meta.path}</span>
      </summary>
      <div className="instruction-message-block__body">
        <TextBlock content={content} />
      </div>
    </details>
  );
}

function InfoCircleIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 17v-5" />
      <path d="M12 8h.01" />
    </svg>
  );
}

function HorizontalDotsIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <circle cx="5" cy="12" r="1.5" />
      <circle cx="12" cy="12" r="1.5" />
      <circle cx="19" cy="12" r="1.5" />
    </svg>
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

function ConversationInfoDialog({
  conversation,
  linkedConsoleSession,
  issueLinks,
  presets,
  workRepos,
  onClose,
}: {
  conversation: Conversation & { blocks: ConversationBlock[]; children: ConversationChild[] };
  linkedConsoleSession: ConsoleSession | null;
  issueLinks: Array<{ issue_id: string; repo_id: string }>;
  presets: SessionPreset[];
  workRepos: WorkRepo[];
  onClose: () => void;
}): JSX.Element {
  return (
    <div className="conv-modal-overlay" onClick={onClose}>
      <div className="conv-modal" onClick={(event) => event.stopPropagation()}>
        <div className="conv-modal__header">
          <h3 className="conv-modal__title">Conversation Info</h3>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close info">
            &times;
          </button>
        </div>
        <div className="conv-info-grid">
          <div>
            <span className="conv-info-grid__label">Agent</span>
            <span>{SOURCE_LABELS[conversation.source] ?? conversation.source}</span>
          </div>
          <div>
            <span className="conv-info-grid__label">Runtime</span>
            <span>
              {linkedConsoleSession
                ? `${linkedConsoleSession.status} ${linkedConsoleSession.backend_type}`
                : 'not running'}
            </span>
          </div>
          <div>
            <span className="conv-info-grid__label">Project</span>
            <span>{getConversationProject(conversation, workRepos)}</span>
          </div>
          <div>
            <span className="conv-info-grid__label">Branch</span>
            <span>{conversation.branch || 'unknown'}</span>
          </div>
          <div>
            <span className="conv-info-grid__label">Model</span>
            <span>{conversation.model || parseModelFromArgs(linkedConsoleSession?.args) || 'default'}</span>
          </div>
          <div>
            <span className="conv-info-grid__label">Blocks</span>
            <span>{conversation.block_count}</span>
          </div>
          <div>
            <span className="conv-info-grid__label">Started</span>
            <span>{formatAbsoluteTime(conversation.started_at) || 'unknown'}</span>
          </div>
          <div>
            <span className="conv-info-grid__label">Session</span>
            <span className="conv-info-grid__mono">{conversation.session_id || linkedConsoleSession?.id || 'none'}</span>
          </div>
        </div>
        {(issueLinks.length > 0 || presets.length > 0) && (
          <div className="conv-modal__section">
            {issueLinks.length > 0 && (
              <div className="conv-modal__chips">
                {issueLinks.map((link) => (
                  <EntityPill
                    key={`${link.repo_id}-${link.issue_id}`}
                    type="issue"
                    id={link.issue_id}
                    repoId={link.repo_id}
                  />
                ))}
              </div>
            )}
            {presets.length > 0 && (
              <div className="conv-modal__chips">
                {presets.map((preset) => (
                  <button
                    key={preset.preset_id}
                    type="button"
                    className="session-preset-badge"
                    onClick={() => { window.location.hash = `#/presets?id=${encodeURIComponent(preset.preset_id)}`; }}
                  >
                    {preset.preset_name}
                    <span className="session-preset-badge__version">v{preset.version}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function ConversationDetail({
  conversationId,
  initialConversation,
  onNavigate,
  consoleSessions,
  workRepos,
  sidebarCollapsed,
}: {
  conversationId: string;
  initialConversation?: Conversation | null;
  onNavigate: (id: string) => void;
  consoleSessions: ConsoleSession[];
  workRepos: WorkRepo[];
  sidebarCollapsed: boolean;
}): JSX.Element {
  const [conversation, setConversation] = useState<ConversationWithDetails | null>(
    initialConversation ? conversationShell(initialConversation) : null,
  );
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
  const [actionsOpen, setActionsOpen] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const [showMessageFilters, setShowMessageFilters] = useState(false);
  const [composerControlsOpen, setComposerControlsOpen] = useState(false);
  const [composerModel, setComposerModel] = useState('');

  // Bug: 84cd5ae — linked issue pills in conversation detail
  const [sessionIssueLinks, setSessionIssueLinks] = useState<Array<{ issue_id: string; repo_id: string }>>([]);
  // Bug: 11f4f47 — preset provenance in conversation history
  const [sessionPresets, setSessionPresets] = useState<SessionPreset[]>([]);

  // Fork/resume state
  const [toast, setToast] = useState<ToastState>(null);
  const [continueDraft, setContinueDraft] = useState('');
  const [continueBusy, setContinueBusy] = useState(false);
  const [continueError, setContinueError] = useState<string | null>(null);
  const [conflictDialog, setConflictDialog] = useState<{ dagUuid: string } | null>(null);
  const [selectedLeaf, setSelectedLeaf] = useState<string | null>(null);

  // Virtual scroll state
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [containerHeight, setContainerHeight] = useState(800);

  useEffect(() => {
    let active = true;
    setConversation(initialConversation ? conversationShell(initialConversation) : null);
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
  }, [conversationId, initialConversation, loadNonce]);

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
  const chatEvents = useMemo(
    () => conversationBlocksToStreamEvents(conversation?.session_id ?? conversationId, visibleBlocks),
    [conversation?.session_id, conversationId, visibleBlocks],
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
    const newStarred = !conversation.starred;
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

  const latestDagUuid = useMemo(() => {
    for (let index = blocks.length - 1; index >= 0; index -= 1) {
      const dagUuid = blocks[index].dag_uuid;
      if (dagUuid) {
        return dagUuid;
      }
    }
    return null;
  }, [blocks]);

  const continueDisabledReason = useMemo(() => {
    if (linkedConsoleSession?.interaction_mode === 'inbox_only' && isLiveConsoleSession(linkedConsoleSession)) {
      return 'Direct input is disabled for this session.';
    }
    if ((!linkedConsoleSession || !isLiveConsoleSession(linkedConsoleSession)) && !latestDagUuid) {
      return 'No resumable message is available.';
    }
    return null;
  }, [latestDagUuid, linkedConsoleSession]);

  const providerFamily = linkedConsoleSession ? getSessionProviderFamily(linkedConsoleSession) : (
    conversation?.source === 'gemini' ? 'gemini' :
    conversation?.source === 'codex' ? 'codex' :
    'claude'
  );
  const currentModel = conversation?.model || parseModelFromArgs(linkedConsoleSession?.args) || 'default';
  const modelOptions = MODEL_OPTIONS[providerFamily] ?? [];
  const canShowSessionControls = linkedConsoleSession
    && (linkedConsoleSession.backend_type === 'sdk'
      || linkedConsoleSession.backend_type === 'pty'
      || linkedConsoleSession.backend_type === 'acp');
  const canSaveComposerModel = Boolean(linkedConsoleSession)
    && (linkedConsoleSession?.backend_type === 'sdk'
      || linkedConsoleSession?.backend_type === 'pty'
      || linkedConsoleSession?.backend_type === 'spawn'
      || linkedConsoleSession?.backend_type === 'acp');

  useEffect(() => {
    setComposerModel(currentModel === 'default' ? '' : currentModel);
  }, [conversationId, currentModel]);

  const handleContinueSubmit = useCallback(async (event: JSX.TargetedEvent<HTMLFormElement, Event>) => {
    event.preventDefault();
    const prompt = continueDraft.trim();
    if (!prompt) {
      return;
    }
    if (continueDisabledReason) {
      setContinueError(continueDisabledReason);
      return;
    }
    setContinueBusy(true);
    setContinueError(null);
    try {
      let targetSessionId = linkedConsoleSession && isLiveConsoleSession(linkedConsoleSession)
        ? linkedConsoleSession.id
        : null;
      if (!targetSessionId) {
        if (!latestDagUuid) {
          throw new Error('No resumable message is available.');
        }
        const result = await resumeConversation(conversationId, latestDagUuid, undefined, composerModel || undefined);
        targetSessionId = result.console_session_id;
      }
      await sendConsolePrompt(targetSessionId, prompt);
      setContinueDraft('');
      setToast({ message: 'Message sent.', type: 'info' });
      setLoadNonce((prev) => prev + 1);
    } catch (err) {
      setContinueError(err instanceof Error ? err.message : String(err));
    } finally {
      setContinueBusy(false);
    }
  }, [composerModel, continueDisabledReason, continueDraft, conversationId, latestDagUuid, linkedConsoleSession]);

  const handleComposerKeyDown = useCallback((event: JSX.TargetedKeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter') return;
    if (event.shiftKey && !event.metaKey && !event.ctrlKey) return;
    event.preventDefault();
    event.currentTarget.form?.requestSubmit();
  }, []);

  const handleComposerModelChange = useCallback(async (value: string) => {
    setComposerModel(value);
    if (!linkedConsoleSession || !canSaveComposerModel) return;
    setContinueError(null);
    try {
      if (linkedConsoleSession.backend_type === 'sdk') {
        await updateConsoleSessionOptions(linkedConsoleSession.id, { model: value || undefined });
      } else {
        await updateConsoleSession(linkedConsoleSession.id, { model: value || undefined });
      }
    } catch (err) {
      setContinueError(err instanceof Error ? err.message : String(err));
    }
  }, [canSaveComposerModel, linkedConsoleSession]);
  const navigateToGraph = useCallback(() => {
    const sessionId = linkedConsoleSession?.id ?? conversation?.session_id;
    const focus = sessionId ? `session:${sessionId}` : undefined;
    const params = new URLSearchParams({ mode: 'activity' });
    if (focus) params.set('focus', focus);
    window.location.hash = `#/graph?${params.toString()}`;
  }, [conversation?.session_id, linkedConsoleSession?.id]);

  if (loading && !conversation) {
    return (
      <div className="conv-detail">
        <div className="empty-state">Loading conversation...</div>
      </div>
    );
  }

  if (error && !conversation) {
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

  if (!conversation) {
    return (
      <div className="conv-detail">
        <div className="empty-state">Conversation not found.</div>
      </div>
    );
  }

  return (
    <div className={`conv-detail${sidebarCollapsed ? ' conv-detail--shelf-collapsed' : ''}`}>
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

      <div className="conv-detail__header">
        <div className="conv-detail__header-left">
          <div className="conv-detail__title-row">
            <h2 className="conv-detail__title">
              {conversation.parent_conversation_id && (
                <span className="conv-subagent-indicator" title="Sub-agent conversation">&#x2937; </span>
              )}
              <span>{getConversationTitle(conversation)}</span>
            </h2>
            <div className="conv-actions">
              <button
                type="button"
                className="conv-actions__trigger"
                onClick={() => setActionsOpen((prev) => !prev)}
                title="Conversation actions"
                aria-label="Conversation actions"
                aria-haspopup="menu"
                aria-expanded={actionsOpen}
              >
                <HorizontalDotsIcon />
              </button>
              {actionsOpen && (
                <div className="conv-actions__menu">
                  <button type="button" onClick={() => { void handleStarToggle(); setActionsOpen(false); }}>
                    {conversation.starred ? 'Unstar' : 'Star'}
                  </button>
                  <button type="button" onClick={() => { navigateToGraph(); setActionsOpen(false); }}>
                    Show in graph
                  </button>
                  <button type="button" onClick={() => { setShowMessageFilters((prev) => !prev); setActionsOpen(false); }}>
                    {showMessageFilters ? 'Hide message filters' : 'Message filters'}
                  </button>
                  <button type="button" onClick={() => { setRenderMode((prev) => prev === 'transcript' ? 'raw' : 'transcript'); setActionsOpen(false); }}>
                    {renderMode === 'transcript' ? 'Inspect raw blocks' : 'Show transcript'}
                  </button>
                  <button type="button" onClick={() => { setSelectMode(true); setActionsOpen(false); }}>
                    Select messages
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
        <div className="conv-detail__header-right">
          <button
            type="button"
            className="conv-info-button"
            onClick={() => setInfoOpen(true)}
            title="Conversation info"
            aria-label="Conversation info"
          >
            <InfoCircleIcon />
          </button>
        </div>
      </div>

      {error && (
        <div className="conv-load-error">
          <span>{error}</span>
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={() => setLoadNonce((prev) => prev + 1)}
          >
            Retry
          </button>
        </div>
      )}

      {/* Sub-agents section */}
      {conversation.children && conversation.children.length > 0 && (
        <SubAgentsList children={conversation.children} onNavigate={onNavigate} />
      )}

      {showMessageFilters && (
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
      )}

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
          <ChatSurface
            events={chatEvents}
            streaming={false}
            emptyLabel={loading ? 'Loading messages...' : 'No blocks match the current filters.'}
            sessionInfo={{
              sessionId: conversation.session_id,
              backend: conversation.source,
              model: conversation.model ?? undefined,
            }}
          />
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
            <div className="empty-state">
              {loading ? 'Loading messages...' : 'No blocks match the current filters.'}
            </div>
          )}
        </div>
      )}

      <div className="conv-compose">
        <form className="conv-compose__form" onSubmit={handleContinueSubmit}>
          <textarea
            className="conv-compose__input"
            value={continueDraft}
            onInput={(event) => setContinueDraft(event.currentTarget.value)}
            onKeyDown={handleComposerKeyDown}
            placeholder="Message..."
            disabled={continueBusy}
            rows={3}
          />
          <button
            type="submit"
            className="conv-compose__send"
            disabled={continueBusy || !continueDraft.trim()}
            title="Send message"
            aria-label="Send message"
          >
            {continueBusy ? '...' : '↑'}
          </button>
        </form>
        <div className="conv-compose__footer">
          <div className="conv-compose__runtime">
            <span className={`agent-mark ${SOURCE_CLASSES[conversation.source] || ''}`}>
              {getSourceMark(conversation.source)}
            </span>
            <select
              className="conv-compose__model"
              value={composerModel}
              disabled={continueBusy || modelOptions.length === 0}
              title="Model"
              aria-label="Model"
              onChange={(event) => { void handleComposerModelChange(event.currentTarget.value); }}
            >
              <option value={currentModel === 'default' ? '' : currentModel}>
                {currentModel === 'default' ? 'Default' : currentModel}
              </option>
              {modelOptions
                .filter((model) => model !== currentModel)
                .map((model) => (
                  <option key={model} value={model}>{model}</option>
                ))}
            </select>
          </div>
          {canShowSessionControls && (
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => setComposerControlsOpen((prev) => !prev)}
            >
              Controls
            </button>
          )}
        </div>
        {canShowSessionControls && composerControlsOpen && linkedConsoleSession && (
          <div className="conv-compose__controls">
            <SessionControls
              sessionId={linkedConsoleSession.id}
              backendType={linkedConsoleSession.backend_type === 'sdk'
                ? 'sdk'
                : linkedConsoleSession.backend_type === 'acp'
                  ? 'acp'
                  : 'pty'}
              model={parseModelFromArgs(linkedConsoleSession.args)}
              modelOptions={MODEL_OPTIONS[providerFamily] ?? []}
              allowedTools={linkedConsoleSession.allowed_tools}
            />
          </div>
        )}
        {(continueError || continueDisabledReason) && (
          <div className={`conv-compose__status${continueError ? ' conv-compose__status--error' : ''}`}>
            {continueError ?? continueDisabledReason}
          </div>
        )}
      </div>

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
      {infoOpen && (
        <ConversationInfoDialog
          conversation={conversation}
          linkedConsoleSession={linkedConsoleSession}
          issueLinks={sessionIssueLinks}
          presets={sessionPresets}
          workRepos={workRepos}
          onClose={() => setInfoOpen(false)}
        />
      )}
    </div>
  );
}

// ── Sidebar Item ──

function PinIcon({ size = 13 }: { size?: number }): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 17v5" />
      <path d="M5 17h14" />
      <path d="M7 17l2-8-2-3V3h10v3l-2 3 2 8" />
    </svg>
  );
}

function FolderIcon({ size = 13, open = false }: { size?: number; open?: boolean }): JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {open ? (
        <path d="M3 7.5A2.5 2.5 0 0 1 5.5 5h4l2 2.5H19A2.5 2.5 0 0 1 21.4 11l-1.55 5.8A2.5 2.5 0 0 1 17.44 18.7H5.35A2.35 2.35 0 0 1 3 16.35z" />
      ) : (
        <path d="M3 6.5A2.5 2.5 0 0 1 5.5 4h4l2 2.5h7A2.5 2.5 0 0 1 21 9v8a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17z" />
      )}
    </svg>
  );
}

function ChatEntryItem({
  entry,
  isSelected,
  onClick,
  onTogglePin,
  onRename,
  showPinnedIcon = false,
}: {
  entry: ChatEntry;
  isSelected: boolean;
  onClick: () => void;
  onTogglePin?: () => void;
  onRename?: (label: string | null) => void;
  showPinnedIcon?: boolean;
}): JSX.Element {
  const [actionsOpen, setActionsOpen] = useState(false);
  const conversation = entry.conversation;
  const session = entry.session;
  const isSubAgent = !!conversation?.parent_conversation_id;
  const source = conversation?.source ?? (session ? sourceFromSession(session) : null);
  const title = conversation ? getConversationTitle(conversation) : stripMarkdownText(session?.label) || 'Untitled';
  const canShowActions = Boolean(onTogglePin || onRename);
  const isPinned = Boolean(conversation?.starred || session?.pinned);

  const handleRename = (event: MouseEvent) => {
    event.stopPropagation();
    setActionsOpen(false);
    if (!onRename) return;
    const nextLabel = window.prompt('Rename chat', title);
    if (nextLabel === null) return;
    const normalized = stripMarkdownText(nextLabel);
    onRename(normalized || null);
  };

  const handleTogglePin = (event: MouseEvent) => {
    event.stopPropagation();
    setActionsOpen(false);
    onTogglePin?.();
  };

  return (
    <div
      className={`chat-history-item${isSelected ? ' chat-history-item--selected' : ''}${isSubAgent ? ' chat-history-item--subagent' : ''}`}
      onClick={onClick}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onClick(); }}
    >
      <div className="chat-history-item__line">
        {showPinnedIcon && (
          <span className="chat-history-item__pin" title="Pinned">
            <PinIcon />
          </span>
        )}
        <span className="chat-history-item__title">
          {isSubAgent && <span className="conv-subagent-indicator" title="Sub-agent">&#x2937; </span>}
          <span>{truncate(title, 70)}</span>
        </span>
        {canShowActions && (
          <div className="chat-history-item__actions">
            <button
              type="button"
              className="chat-history-item__menu-btn"
              onClick={(event) => {
                event.stopPropagation();
                setActionsOpen((prev) => !prev);
              }}
              title="Chat actions"
              aria-label="Chat actions"
            >
              ...
            </button>
            {actionsOpen && (
              <div className="chat-history-item__menu" onClick={(event) => event.stopPropagation()}>
                {onTogglePin && (
                  <button type="button" onClick={handleTogglePin}>
                    {isPinned ? 'Unpin' : 'Pin'}
                  </button>
                )}
                {onRename && (
                  <button type="button" onClick={handleRename}>
                    Rename
                  </button>
                )}
              </div>
            )}
          </div>
        )}
        <span
          className={`agent-mark ${source ? SOURCE_CLASSES[source] || '' : ''}`}
          title={source ? SOURCE_LABELS[source] : session ? getAgentLabel(session.agent_type) : undefined}
        >
          {source ? getSourceMark(source) : session ? getSessionMark(session) : '??'}
        </span>
      </div>
    </div>
  );
}

function LiveSessionDetail({
  session,
}: {
  session: ConsoleSession;
}): JSX.Element {
  const [viewMode, setViewMode] = useState<ViewMode>('rich');

  return (
    <div className="chat-live-detail">
      <div className="chat-live-detail__header">
        <div className="chat-live-detail__title-group">
          <h2 className="chat-live-detail__title">{session.label || 'Untitled session'}</h2>
          <div className="chat-live-detail__meta">
            <span className={`chat-live-session__status chat-live-session__status--${session.status}`} />
            <span>{getAgentLabel(session.agent_type)}</span>
            <span>{session.status}</span>
            <span title={session.transport_badge?.title}>
              {session.transport_badge?.label ?? session.transport_lane ?? session.backend_type}
            </span>
          </div>
        </div>
      </div>
      <div className="chat-live-detail__pane">
        <TerminalPane
          sessionId={session.id}
          agentType={session.agent_type}
          backendType={session.backend_type}
          allowedTools={session.allowed_tools}
          command={session.command ?? session.agent_type}
          sessionArgs={session.args ?? []}
          isOperator={session.is_operator}
          interactionMode={session.interaction_mode}
          sessionStatus={session.status}
          providerSessionId={session.provider_session_id}
          isVisible
          viewMode={viewMode}
          onViewModeChange={setViewMode}
          resumeAtMessage={session.resume_at_message}
          channelEnabled={!!session.channel_enabled}
          workspaceMode
        />
      </div>
    </div>
  );
}

// ── Main View ──

export function ConversationsView({
  conversations: initialConversations,
  consoleSessions,
  workRepos,
  initialConversationId,
  initialSessionId,
  initialPresetId,
  sidebarHidden = false,
  onSelectSession,
  onNewSession,
}: ConversationsViewProps): JSX.Element {
  const { width: sidebarWidth, handleMouseDown } = useSidebarResize({
    defaultWidth: 320,
    minWidth: 190,
    storageKey: 'sidebar-width:conversations',
  });

  const [selection, setSelection] = useState<ChatSelection>(null);
  const [dialogOpen, setDialogOpen] = useState(Boolean(initialPresetId));
  const [search, setSearch] = useState('');
  const [searchMode, setSearchMode] = useState<'title' | 'full'>('title');
  const [sourceFilter, setSourceFilter] = useState<ConversationSource | 'all'>('all');
  const [starredOnly, setStarredOnly] = useState(false);
  const [hideEmpty, setHideEmpty] = useState(true);
  const [sort, setSort] = useState<'date' | 'blocks'>('date');
  const [filterPanelOpen, setFilterPanelOpen] = useState(false);
  const [collapsedSections, setCollapsedSections] = useState<Set<ChatSectionId>>(new Set());
  const [collapsedProjects, setCollapsedProjects] = useState<Set<string>>(new Set());
  const [conversations, setConversations] = useState<Conversation[]>(initialConversations);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const searchTimer = useRef<number | null>(null);
  const conversationsRef = useRef(conversations);
  conversationsRef.current = conversations;

  const selectedConversationId = selection?.type === 'conversation' ? selection.id : null;
  const selectedSessionId = selection?.type === 'session' ? selection.id : null;

  const liveSessions = useMemo(() => {
    return consoleSessions
      .filter(isLiveConsoleSession)
      .sort((a, b) => {
        if (a.pinned && !b.pinned) return -1;
        if (!a.pinned && b.pinned) return 1;
        return (b.started_at ?? b.created_at) - (a.started_at ?? a.created_at);
      });
  }, [consoleSessions]);

  useEffect(() => {
    if (initialPresetId) {
      setDialogOpen(true);
    }
  }, [initialPresetId]);

  useEffect(() => {
    if (!initialConversationId) return;
    setSelection({ type: 'conversation', id: initialConversationId });
  }, [initialConversationId]);

  useEffect(() => {
    let active = true;
    let retryTimer: number | null = null;

    if (initialConversationId || !initialSessionId) {
      return () => {
        active = false;
      };
    }

    const liveById = consoleSessions.find((session) => session.id === initialSessionId);
    if (liveById && !liveById.provider_session_id) {
      setSelection({ type: 'session', id: liveById.id });
      onSelectSession(liveById.id);
      return () => {
        active = false;
      };
    }
    const sessionLookupId = liveById?.provider_session_id ?? initialSessionId;

    const resolveConversation = (attemptsRemaining: number) => {
      void getConversations({ session_id: sessionLookupId, limit: 1 })
        .then((result) => {
          if (!active) return;
          const resolvedId = result.conversations[0]?.id ?? null;
          if (resolvedId) {
            setSelection({ type: 'conversation', id: resolvedId });
            return;
          }
          const liveByProvider = consoleSessions.find(
            (session) => session.provider_session_id === sessionLookupId && isLiveConsoleSession(session),
          );
          if (liveByProvider && attemptsRemaining <= 0) {
            setSelection({ type: 'session', id: liveByProvider.id });
            onSelectSession(liveByProvider.id);
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
  }, [consoleSessions, initialConversationId, initialSessionId, onSelectSession]);

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
        min_blocks?: number;
        group?: boolean;
        exclude_subagents?: boolean;
      } = {
        limit: PAGE_SIZE,
        offset: reset ? 0 : conversationsRef.current.length,
        sort: sort === 'blocks' ? 'block_count' : 'started_at',
      };
      if (sourceFilter !== 'all') params.source = sourceFilter;
      if (starredOnly) params.starred = true;
      if (hideEmpty) params.min_blocks = 1;
      if (search.trim()) params.search = search.trim();
      params.group = true;
      params.exclude_subagents = true;

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
  }, [hideEmpty, sourceFilter, starredOnly, sort, search]);

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

  const loadMore = () => {
    fetchConversations(false);
  };

  const remainingConversationCount = Math.max(0, total - conversations.length);
  const hasMore = remainingConversationCount > 0;
  const selectedConversationSummary = selection?.type === 'conversation'
    ? conversations.find((conv) => conv.id === selection.id) ?? null
    : null;

  // Client-side title-only filter (when searchMode === 'title', server already
  // searched summary too, so we narrow here to title-only for the title mode).
  // When searchMode === 'full', server search is sufficient — show all results.
  const displayedConversations = useMemo(() => {
    const base = conversations.filter((conv) =>
      !isSubagentConversation(conv) && (!hideEmpty || conv.block_count > 0)
    );
    if (!search.trim() || searchMode === 'full') return base;
    const needle = search.trim().toLowerCase();
    return base.filter((conv) =>
      getConversationTitle(conv).toLowerCase().includes(needle)
    );
  }, [conversations, hideEmpty, search, searchMode]);

  const liveByProviderSession = useMemo(() => {
    const map = new Map<string, ConsoleSession>();
    for (const session of liveSessions) {
      if (session.provider_session_id) {
        map.set(session.provider_session_id, session);
      }
    }
    return map;
  }, [liveSessions]);

  const chatSections = useMemo<ChatSidebarSections>(() => {
    const entries: ChatEntry[] = displayedConversations.map((conversation) => ({
      key: `conversation:${conversation.id}`,
      project: getConversationProject(conversation, workRepos),
      time: getConversationTime(conversation),
      kind: 'conversation',
      conversation,
      liveSession: liveByProviderSession.get(conversation.session_id) ?? null,
    }));
    const conversationProviderIds = new Set(displayedConversations.map((conversation) => conversation.session_id));
    for (const session of liveSessions) {
      if (isSubagentSession(session)) {
        continue;
      }
      if (session.provider_session_id && conversationProviderIds.has(session.provider_session_id)) {
        continue;
      }
      entries.push({
        key: `session:${session.id}`,
        project: 'No Project',
        time: getSessionTime(session),
        kind: 'session',
        session,
        liveSession: session,
      });
    }

    const sortEntries = (items: ChatEntry[]) => [...items].sort((a, b) => {
      if (sort === 'blocks') {
        const aBlocks = a.conversation?.block_count ?? 0;
        const bBlocks = b.conversation?.block_count ?? 0;
        if (aBlocks !== bBlocks) return bBlocks - aBlocks;
      }
      return b.time - a.time || getEntryTitle(a).localeCompare(getEntryTitle(b));
    });

    const pinned = sortEntries(entries.filter((entry) => Boolean(entry.conversation?.starred || entry.session?.pinned)));
    const unpinned = entries.filter((entry) => !entry.conversation?.starred && !entry.session?.pinned);
    const looseChats = sortEntries(unpinned.filter((entry) => entry.project === 'No Project'));
    const groupMap = new Map<string, ChatEntry[]>();
    for (const entry of unpinned) {
      if (entry.project === 'No Project') continue;
      const group = groupMap.get(entry.project) ?? [];
      group.push(entry);
      groupMap.set(entry.project, group);
    }
    const projects = Array.from(groupMap.entries())
      .map(([project, groupEntries]) => ({
        project,
        latestTime: Math.max(...groupEntries.map((entry) => entry.time)),
        entries: sortEntries(groupEntries),
      }))
      .sort((a, b) => a.project.localeCompare(b.project));
    return { pinned, projects, chats: looseChats };
  }, [displayedConversations, liveByProviderSession, liveSessions, sort, workRepos]);

  const firstChatEntry =
    chatSections.pinned[0] ??
    chatSections.projects[0]?.entries[0] ??
    chatSections.chats[0] ??
    null;
  const activeFilterCount = [
    sourceFilter !== 'all',
    starredOnly,
    !hideEmpty,
    sort !== 'date',
    searchMode !== 'title',
  ].filter(Boolean).length;

  const selectedLiveSession = useMemo(() => {
    if (!selectedSessionId) return null;
    return consoleSessions.find((session) => session.id === selectedSessionId) ?? null;
  }, [consoleSessions, selectedSessionId]);

  useEffect(() => {
    if (!selection) return;
    if (selection.type !== 'session') return;
    if (consoleSessions.some((session) => session.id === selection.id)) return;
    setSelection(null);
  }, [consoleSessions, selection]);

  useEffect(() => {
    if (selection) return;
    if (!firstChatEntry) return;
    if (firstChatEntry.kind === 'conversation' && firstChatEntry.conversation) {
      setSelection({ type: 'conversation', id: firstChatEntry.conversation.id });
      return;
    }
    if (firstChatEntry.session) {
      setSelection({ type: 'session', id: firstChatEntry.session.id });
      onSelectSession(firstChatEntry.session.id);
    }
  }, [firstChatEntry, onSelectSession, selection]);

  const handleSelectSession = (sessionId: string) => {
    setSelection({ type: 'session', id: sessionId });
    onSelectSession(sessionId);
  };

  const toggleProject = (project: string) => {
    setCollapsedProjects((prev) => {
      const next = new Set(prev);
      if (next.has(project)) {
        next.delete(project);
      } else {
        next.add(project);
      }
      return next;
    });
  };

  const toggleSection = (section: ChatSectionId) => {
    setCollapsedSections((prev) => {
      const next = new Set(prev);
      if (next.has(section)) {
        next.delete(section);
      } else {
        next.add(section);
      }
      return next;
    });
  };

  const updateConversationInList = (updated: Conversation) => {
    setConversations((prev) => prev.map((conv) => (conv.id === updated.id ? { ...conv, ...updated } : conv)));
  };

  const handleToggleEntryPin = async (entry: ChatEntry) => {
    if (!entry.conversation) return;
    const starred = !entry.conversation.starred;
    try {
      const updated = await updateConversation(entry.conversation.id, { starred });
      updateConversationInList(updated);
    } catch {
      // keep the current list state if persistence fails
    }
  };

  const handleRenameEntry = async (entry: ChatEntry, label: string | null) => {
    try {
      if (entry.conversation) {
        const updated = await updateConversation(entry.conversation.id, { label });
        updateConversationInList(updated);
        return;
      }
      if (entry.session && label) {
        await updateConsoleSession(entry.session.id, { label });
      }
    } catch {
      // keep the current list state if persistence fails
    }
  };

  const handleNewSession = (input: {
    label: string;
    backend: string;
    kind: string;
    backend_type: 'pty' | 'sdk' | 'spawn' | 'acp';
    transport_lane: 'sdk' | 'pty' | 'channel' | 'acp' | 'spawn';
    channel_enabled?: boolean;
    presetIds?: string[];
  }) => {
    onNewSession(input);
    setDialogOpen(false);
  };

  const renderEntry = (entry: ChatEntry, showPinnedIcon = false) => (
    <ChatEntryItem
      key={entry.key}
      entry={entry}
      isSelected={entry.kind === 'conversation'
        ? selectedConversationId === entry.conversation?.id
        : selectedSessionId === entry.session?.id}
      showPinnedIcon={showPinnedIcon}
      onTogglePin={entry.conversation ? () => { void handleToggleEntryPin(entry); } : undefined}
      onRename={(label) => { void handleRenameEntry(entry, label); }}
      onClick={() => {
        if (entry.kind === 'conversation' && entry.conversation) {
          setSelection({ type: 'conversation', id: entry.conversation.id });
          return;
        }
        if (entry.session) {
          handleSelectSession(entry.session.id);
        }
      }}
    />
  );

  const totalVisibleEntries =
    chatSections.pinned.length +
    chatSections.projects.reduce((sum, group) => sum + group.entries.length, 0) +
    chatSections.chats.length;

  return (
    <div className="chat-history-view">
      {!sidebarHidden && (
        <div className="chat-history-sidebar" style={{ ...(sidebarWidth !== null ? { width: `${sidebarWidth}px` } : {}), flexShrink: 0 }}>
          <div className="chat-sidebar-top">
            <div className="chat-history-search-row">
              <button
                type="button"
                className="icon-btn chat-sidebar-new"
                onClick={() => setDialogOpen(true)}
                title="New chat"
                aria-label="New chat"
              >
                +
              </button>
              <input
                type="text"
                className="conv-search"
                placeholder="Search chats"
                value={search}
                onInput={(e) => setSearch((e.target as HTMLInputElement).value)}
              />
              <button
                type="button"
                className={`icon-btn chat-filter-trigger${activeFilterCount > 0 ? ' chat-filter-trigger--active' : ''}`}
                title="Search and filter options"
                aria-label="Search and filter options"
                onClick={() => setFilterPanelOpen((prev) => !prev)}
              >
                ⋯
                {activeFilterCount > 0 && <span>{activeFilterCount}</span>}
              </button>
            </div>
            {activeFilterCount > 0 && (
              <div className="chat-filter-summary">
                {sourceFilter !== 'all' && <span>{SOURCE_LABELS[sourceFilter]}</span>}
                {starredOnly && <span>Starred</span>}
                {!hideEmpty && <span>Empty shown</span>}
                {sort !== 'date' && <span>By blocks</span>}
                {searchMode === 'full' && <span>Full text</span>}
              </div>
            )}
            {filterPanelOpen && (
              <div className="chat-filter-popover">
                <div className="chat-filter-popover__section">
                  <div className="chat-filter-popover__label">Agent</div>
                  <div className="chat-filter-popover__row">
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
                </div>
                <div className="chat-filter-popover__section">
                  <label className="chat-filter-popover__toggle">
                    <input
                      type="checkbox"
                      checked={starredOnly}
                      onChange={() => setStarredOnly((prev) => !prev)}
                    />
                    <span>Starred only</span>
                  </label>
                  <label className="chat-filter-popover__toggle">
                    <input
                      type="checkbox"
                      checked={hideEmpty}
                      onChange={() => setHideEmpty((prev) => !prev)}
                    />
                    <span>Hide empty chats</span>
                  </label>
                </div>
                <div className="chat-filter-popover__section">
                  <div className="chat-filter-popover__label">Search</div>
                  <div className="chat-filter-popover__row">
                    <button
                      type="button"
                      className={`conv-filter-btn${searchMode === 'title' ? ' conv-filter-btn--active' : ''}`}
                      onClick={() => setSearchMode('title')}
                    >
                      Title
                    </button>
                    <button
                      type="button"
                      className={`conv-filter-btn${searchMode === 'full' ? ' conv-filter-btn--active' : ''}`}
                      onClick={() => setSearchMode('full')}
                    >
                      Full text
                    </button>
                  </div>
                </div>
                <label className="chat-filter-popover__select">
                  <span>Sort</span>
                  <select
                    className="conv-sort"
                    value={sort}
                    onChange={(e) => setSort((e.target as HTMLSelectElement).value as 'date' | 'blocks')}
                  >
                    <option value="date">Recent activity</option>
                    <option value="blocks">Message count</option>
                  </select>
                </label>
              </div>
            )}
          </div>

          <div className="chat-history-list">
            <div className="chat-sidebar-section">
              <button
                type="button"
                className="chat-sidebar-section__heading"
                onClick={() => toggleSection('pinned')}
              >
                <strong>Pinned</strong>
                <em>{chatSections.pinned.length}</em>
              </button>
              {!collapsedSections.has('pinned') && chatSections.pinned.map((entry) => renderEntry(entry, true))}
            </div>

            <div className="chat-sidebar-section">
              <button
                type="button"
                className="chat-sidebar-section__heading"
                onClick={() => toggleSection('projects')}
              >
                <strong>Projects</strong>
                <em>{chatSections.projects.length}</em>
              </button>
              {!collapsedSections.has('projects') && chatSections.projects.map((group) => {
                const collapsed = collapsedProjects.has(group.project);
                return (
                  <div key={group.project} className="chat-project-group">
                    <button
                      type="button"
                      className="chat-project-group__header"
                      onClick={() => toggleProject(group.project)}
                    >
                      <span className="chat-project-group__folder"><FolderIcon open={!collapsed} /></span>
                      <strong>{group.project}</strong>
                      <em>{group.entries.length}</em>
                    </button>
                    {!collapsed && (
                      <div className="chat-project-group__items">
                        {group.entries.map((entry) => renderEntry(entry))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            <div className="chat-sidebar-section">
              <button
                type="button"
                className="chat-sidebar-section__heading"
                onClick={() => toggleSection('chats')}
              >
                <strong>Chats</strong>
                <em>{chatSections.chats.length}</em>
              </button>
              {!collapsedSections.has('chats') && chatSections.chats.map((entry) => renderEntry(entry))}
            </div>

            {totalVisibleEntries === 0 && !loading && (
              <div className="chat-history-empty">No conversations found.</div>
            )}
            {loading && (
              <div className="chat-history-empty">Loading…</div>
            )}
            {hasMore && !loading && (
              <button type="button" className="btn btn--ghost chat-history-load-more" onClick={loadMore}>
                Load more ({remainingConversationCount} remaining)
              </button>
            )}
          </div>
        </div>
      )}

      {/* Drag handle */}
      {!sidebarHidden && <div className="sidebar-drag-handle" onMouseDown={handleMouseDown} />}

      {/* Detail pane */}
      <div className="chat-history-detail">
        {selection?.type === 'conversation' ? (
          <ConversationDetail
            conversationId={selection.id}
            initialConversation={selectedConversationSummary}
            onNavigate={(id) => setSelection({ type: 'conversation', id })}
            consoleSessions={consoleSessions}
            workRepos={workRepos}
            sidebarCollapsed={false}
          />
        ) : selection?.type === 'session' && selectedLiveSession ? (
          <LiveSessionDetail
            key={selectedLiveSession.id}
            session={selectedLiveSession}
          />
        ) : (
          <div className="chat-history-detail__empty">
            Select a conversation to view it
          </div>
        )}
      </div>
      <NewSessionDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        onSubmit={handleNewSession}
        initialPresetId={initialPresetId}
      />
    </div>
  );
}
