import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { ViewSidebar } from '../components/ViewSidebar';
import { VIEW_SIDEBAR_GEOMETRY } from '../view-sidebar-geometry';
import { SidebarSearchFilterHeader } from '../components/shared/SidebarSearchFilterHeader';
import { SidebarAddProjectIcon, SidebarGroupNode, SidebarNewChatIcon } from '../components/shared/SidebarGroupNode';
import { SidebarLeadingActionRow } from '../components/shared/SidebarItemRow';
import { normalizeSidebarGroupLimit } from '../components/shared/sidebar-group-settings';
import {
  SidebarItemBadge,
  SidebarItemOverflowMenu,
  SidebarItemPinAction,
  SidebarItemRow,
  type SidebarItemOverflowAction,
  type SidebarItemProviderTone,
} from '../components/shared/SidebarItemRow';
import {
  orderByPinnedIds,
  reconcileOrderedPinIds,
} from '../components/shared/orderedPins';
import type { ConsoleSession } from '../state';
import type {
  BlockType,
  Conversation,
  ConversationBlock,
  ConversationChild,
  InstanceInfo,
  ConversationParent,
  ConversationPositionWindow,
  ConversationSource,
  ConversationSidebarGroup,
  ConversationSidebarConversation,
  CanonicalProject,
  WorkflowRun,
} from '../api.js';
import {
  exportConversationBlocks,
  forkConversation,
  getConsoleSessionUsage,
  getConsoleSessionOptions,
  getConsoleRunOptions,
  getConversationWindow,
  getConversationControl,
  getConversationLiveProjection,
  getConversationSidebar,
  getConversations,
  getSessionIssues,
  listWorkflows,
  listCanonicalProjects,
  navigateSession,
  submitConversationControl,
  updateConsoleSession,
  updateConsoleSessionOptions,
  updateConversation,
  type SessionRunOptionsSnapshot,
  type ConversationRuntimeOptions,
  type ConversationControlApiError,
  type ConversationControlSnapshot,
  type ProviderAdapterEvent,
  type ProviderLiveProjection,
} from '../api.js';
import { DetailPaneHeader } from '../components/shared/DetailPaneHeader';
import { DetailPaneNotice } from '../components/shared/DetailPaneNotice';
import { DetailPaneModal } from '../components/shared/DetailPaneModal';
import { DetailPaneShell } from '../components/shared/DetailPaneShell';
import { TerminalPane } from '../components/console/TerminalPane';
import { NewSessionDialog } from '../components/console/NewSessionDialog';
import { SessionControls } from '../components/console/SessionControls';
import { EntityPill } from '../components/shared/EntityPill';
import {
  ChatOverlay,
  ChatSurface,
  ContextUsageRing,
  Shelf,
  UsageModal,
  conversationBlocksToStreamEvents,
  reconcileProviderProjection,
  buildStreamState,
  deriveChatUsageSummary,
  serializeConversationToMarkdown,
  useStatuslineTelemetry,
  type ShelfItem,
} from '../chat';
import {
  applyConversationAppendPayload,
  mergeConversationSummaryIntoList,
  type ConversationAppendPayload,
} from '../chat/conversationAppend';
import { formatAbsoluteTime, truncate } from '../lib/format';
import { acquireSharedSse } from '../sse-shared';
import { detailRequestKey, readPersistedDetail, writePersistedDetail } from '../detail-cache';
import { LoadingSkeleton } from '../components/LoadingSkeleton';
import { reconcileShownProjects, useChatViewState } from './conversation-view-state';
import { compareConversationSidebarRows } from '../../../src/conversations/sidebar-order';
import { useAnchoredMenu } from '../hooks/useAnchoredMenu';
import { openMarkdownDocument } from '../chat/markdownActions';
import { conversationControlPresentation } from '../chat/conversationControl';
import { mergeProviderLiveProjection } from '../../../src/conversation-control/provider-live';

// ── Toast notification ──

type ToastState = { message: string; type: 'info' | 'error' } | null;

function formatControlApiError(err: unknown): { message: string; details: string | null; snapshot: ConversationControlSnapshot | null } {
  if (err instanceof Error) {
    const apiError = err as Partial<ConversationControlApiError>;
    return {
      message: apiError.controlError?.kind ?? apiError.message ?? 'Conversation control failed',
      details: apiError.controlError ? JSON.stringify(apiError.controlError, null, 2) : null,
      snapshot: apiError.snapshot ?? null,
    };
  }
  return { message: String(err), details: null, snapshot: null };
}

function Toast({ toast, onDismiss }: { toast: ToastState; onDismiss: () => void }): JSX.Element | null {
  if (!toast) return null;
  return (
    <div className={`conv-toast conv-toast--${toast.type}`} onClick={onDismiss}>
      {toast.message}
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

const DETAIL_HEADER_PROVIDER_LABELS: Record<ConversationSource, string> = {
  claude_code: 'Claude',
  codex: 'Codex',
  gemini: 'agy',
};

export function getConversationHeaderProviderLabel(source: ConversationSource): string {
  return DETAIL_HEADER_PROVIDER_LABELS[source];
}

const AGENT_LABELS: Record<string, string> = {
  operator: 'Operator',
  claude: 'Claude',
  codex: 'Codex',
  gemini: 'Gemini',
  shell: 'Shell',
};

// ── Helpers ──

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

export function getConversationTitle(conversation: Conversation | null | undefined): string {
  const raw = conversation?.title || 'Untitled';
  if (/^\s*<(?:codex_delegation|system|developer)\b/i.test(raw)
      || /^\s*[0-9a-f]{8}-[0-9a-f-]{27,}(?:\s|$|<)/i.test(raw)) {
    const provider = conversation?.source ? SOURCE_LABELS[conversation.source] : null;
    return provider ? `${provider} chat` : 'Untitled chat';
  }
  return stripMarkdownText(raw) || 'Untitled';
}

function getConsoleSessionTitle(session: ConsoleSession | null | undefined): string {
  const raw = stripMarkdownText(session?.label);
  if (raw && !/^[0-9a-f]{8}-[0-9a-f-]{27,}(?:\s|$|<)/i.test(raw)) return raw;
  const source = session ? sourceFromSession(session) : null;
  return source ? `${SOURCE_LABELS[source]} chat` : 'Untitled chat';
}

export function parseConversationTagsInput(value: string): string[] {
  return [...new Set(value.split(',').map((tag) => tag.trim()).filter(Boolean))];
}

export function applyConversationSearchParams(
  params: { search?: string; full_text?: boolean },
  search: string,
  mode: 'title' | 'full',
): void {
  const query = search.trim();
  if (!query) return;
  params.search = query;
  if (mode === 'full') params.full_text = true;
}

function isLiveConsoleSession(session: ConsoleSession): boolean {
  return session.status !== 'stopped' && session.status !== 'crashed';
}

function getAgentLabel(agentType: string): string {
  return AGENT_LABELS[agentType] ?? agentType;
}

function sourceFromSession(session: ConsoleSession): ConversationSource | null {
  const agent = session.agent_type.toLowerCase();
  const command = (session.command ?? '').toLowerCase();
  if (agent.includes('claude') || command.includes('claude')) return 'claude_code';
  if (agent.includes('codex') || command.includes('codex')) return 'codex';
  if (agent.includes('gemini') || command.includes('gemini') || agent.includes('agy') || command.includes('agy')) return 'gemini';
  return null;
}

const CHAT_PROVIDER_TONES: Record<ConversationSource, SidebarItemProviderTone> = {
  claude_code: 'claude',
  codex: 'codex',
  gemini: 'agy',
};

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

type RegisteredChatProject = {
  id: string;
  key: string;
  label: string;
  checkoutId: string;
  checkoutLabel: string;
  root: string;
};

function registeredChatProjects(projects: CanonicalProject[]): RegisteredChatProject[] {
  return projects.flatMap((project) => project.checkouts.map((checkout) => ({
    id: project.id,
    key: project.project_key,
    label: project.display_name?.trim() || project.project_key,
    checkoutId: checkout.id,
    checkoutLabel: checkout.name?.trim() || checkout.work_repo_id?.trim() || checkout.root.trim(),
    root: checkout.root.trim(),
  })))
    .filter((project) => Boolean(project.id && project.key && project.checkoutId && project.root))
    .sort((left, right) => left.label.localeCompare(right.label)
      || left.id.localeCompare(right.id)
      || left.checkoutId.localeCompare(right.checkoutId));
}

function registeredProjectSelectionValue(project: RegisteredChatProject): string {
  return `${encodeURIComponent(project.id)}:${encodeURIComponent(project.checkoutId)}`;
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

type ViewMode = 'terminal' | 'rich' | 'events';
type ChatSelection =
  | { type: 'conversation'; id: string }
  | { type: 'session'; id: string }
  | null;
type ChatEntry = {
  key: string;
  time: number;
  kind: 'conversation' | 'session';
  conversation?: Conversation;
  session?: ConsoleSession;
  liveSession?: ConsoleSession | null;
};

function getCanonicalConversationProjectId(conversation: Conversation): string | null {
  const projectId = (conversation as Partial<ConversationSidebarConversation>).canonical_project_id;
  return typeof projectId === 'string' && projectId ? projectId : null;
}
type ChatProjectGroup = {
  key: string;
  label: string;
  total: number;
  nextCursor: string | null;
  entries: ChatEntry[];
  exactRoot?: string;
  canonicalProjectId?: string;
  canonicalProjectKey?: string;
};
type ChatSectionId = 'pinned' | 'projects' | 'chats';
type ChatSidebarSections = {
  pinned: ChatProjectGroup | null;
  projects: ChatProjectGroup[];
  chats: ChatProjectGroup | null;
};
type ConversationWithDetails = Conversation & {
  blocks: ConversationBlock[];
  children: ConversationChild[];
  parent: ConversationParent | null;
  position_window: Pick<ConversationPositionWindow, 'revision' | 'total' | 'target' | 'window'>;
};
type ConversationAppendSseDetail = {
  type: string;
  data?: ConversationAppendPayload;
};
function conversationShell(conversation: Conversation): ConversationWithDetails {
  return {
    ...conversation,
    blocks: [],
    children: [],
    parent: null,
    position_window: {
      revision: conversation.block_count,
      total: conversation.block_count,
      target: { kind: 'initial', requested_value: null, position: null, block_id: null, turn_id: null },
      window: {
        start_position: null,
        end_position: null,
        has_before: false,
        has_after: conversation.block_count > 0,
        after_count: conversation.block_count,
        limit: 160,
      },
    },
  };
}

function flattenConversationWindow(payload: ConversationPositionWindow): ConversationWithDetails {
  return {
    ...payload.conversation,
    blocks: payload.blocks,
    children: payload.children,
    parent: payload.parent,
    position_window: {
      revision: payload.revision,
      total: payload.total,
      target: payload.target,
      window: payload.window,
    },
  };
}

export function conversationAnchorFromHash(hash: string): { block: string } | { turn: string } | null {
  const query = hash.includes('?') ? hash.slice(hash.indexOf('?') + 1) : '';
  const params = new URLSearchParams(query);
  const block = params.get('block');
  const turn = params.get('turn');
  if (block) return { block };
  if (turn) return { turn };
  return null;
}

export function conversationAnchorHref(
  conversationId: string,
  anchor: { block: string } | { turn: string },
): string {
  const params = new URLSearchParams({ conversation: conversationId });
  if ('block' in anchor) params.set('block', anchor.block);
  else params.set('turn', anchor.turn);
  return `#/console?${params.toString()}`;
}

export function conversationTurnSelectionHref(
  conversationId: string,
  selectedTurnId: string | null,
  nextTurnId: string,
): string {
  if (selectedTurnId === nextTurnId) {
    return `#/console?${new URLSearchParams({ conversation: conversationId }).toString()}`;
  }
  return conversationAnchorHref(conversationId, { turn: nextTurnId });
}

// ── Props ──

export type ConversationsViewProps = {
  consoleSessions: ConsoleSession[];
  initialConversationId: string | null;
  initialSessionId: string | null;
  sidebarHidden?: boolean;
  sidebarGroupLimit?: number;
  instance?: InstanceInfo | null;
  onSelectSession: (sessionId: string) => void;
  onNewSession: (input: {
    label: string;
    backend: string;
    kind: string;
    backend_type: 'pty' | 'sdk' | 'spawn' | 'acp';
    transport_lane: 'sdk' | 'pty' | 'channel' | 'acp' | 'spawn';
    channel_enabled?: boolean;
    runOptions?: Record<string, import('../api.js').SessionRunOptionValue>;
    cwd?: string;
  }) => Promise<void>;
};

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

function formatShelfDuration(seconds: number | null): string | null {
  if (seconds == null) return null;
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function taskLabelFromBlock(block: ConversationBlock): string | null {
  const metadata = parseMetadata(block.metadata_json);
  if (metadata.tool_name !== 'Task') return null;
  const input = metadata.tool_input;
  if (!input || typeof input !== 'object') return null;
  const record = input as Record<string, unknown>;
  const description = typeof record.description === 'string' ? record.description.trim() : '';
  const subagentType = typeof record.subagent_type === 'string' ? record.subagent_type.trim() : '';
  return description || subagentType || null;
}

function buildSubagentShelfItems(
  children: ConversationChild[],
  parentBlocks: ConversationBlock[],
  onNavigate: (id: string) => void,
): ShelfItem[] {
  const taskLabels = parentBlocks
    .filter((block) => block.type === 'tool_use')
    .map(taskLabelFromBlock)
    .filter((label): label is string => Boolean(label));

  return children.map((child, index) => {
    const duration = formatShelfDuration(child.duration_seconds);
    const meta = [
      `${child.block_count} blocks`,
      duration,
      child.model,
    ].filter((value): value is string => Boolean(value));
    const fallbackLabel = child.agent_id ? `agent-${child.agent_id}` : stripMarkdownText(child.title) || 'Subagent';
    return {
      id: child.id,
      icon: '↳',
      label: truncate(taskLabels[index] ?? fallbackLabel, 80),
      status: child.status,
      meta,
      onActivate: () => onNavigate(child.id),
    };
  });
}

function formatCompactNumber(value: number | null | undefined): string | null {
  if (value == null || !Number.isFinite(value)) return null;
  if (value >= 1000) return `${Math.round(value / 1000)}k`;
  return String(value);
}

function workflowShelfStatus(workflow: WorkflowRun): ShelfItem['status'] {
  if (workflow.warnings.length > 0 || workflow.status === 'warning') return 'error';
  if (workflow.status === 'failed') return 'error';
  if (workflow.status === 'completed') return 'finished';
  if (workflow.status === 'running') return 'active';
  return 'waiting';
}

function buildWorkflowShelfItems(
  workflows: WorkflowRun[],
  onOpen: (id: string) => void,
): ShelfItem[] {
  return workflows.map((workflow) => {
    const progress = `${workflow.completed_workers}/${workflow.total_workers}`;
    const tokens = formatCompactNumber(workflow.total_tokens);
    return {
      id: workflow.id,
      icon: '◇',
      label: truncate(workflow.workflow_name || workflow.provider_run_id, 80),
      status: workflowShelfStatus(workflow),
      meta: [
        progress,
        tokens ? `${tokens} tok` : null,
        workflow.warnings.length > 0 ? 'warning' : null,
      ].filter((value): value is string => Boolean(value)),
      onActivate: () => onOpen(workflow.id),
    };
  });
}

function statusClass(status: string): string {
  return status.replace(/[^a-z0-9_-]/gi, '').toLowerCase() || 'pending';
}

function WorkflowRunDialog({
  workflow,
  onClose,
  onNavigate,
}: {
  workflow: WorkflowRun;
  onClose: () => void;
  onNavigate: (id: string) => void;
}): JSX.Element {
  const [selectedPhaseIndex, setSelectedPhaseIndex] = useState(0);
  const [selectedWorkerIndex, setSelectedWorkerIndex] = useState(0);
  const [focusColumn, setFocusColumn] = useState<'phases' | 'workers'>('phases');
  const panelRef = useRef<HTMLDivElement>(null);

  const phases = workflow.phases.length > 0
    ? workflow.phases
    : [{
        id: `${workflow.id}:phase:0`,
        workflow_id: workflow.id,
        phase_index: 1,
        title: 'Workflow',
        status: workflow.status,
        worker_count: workflow.total_workers,
        completed_count: workflow.completed_workers,
      }];
  const selectedPhase = phases[Math.min(selectedPhaseIndex, phases.length - 1)] ?? phases[0];
  const phaseWorkers = workflow.workers.filter((worker) => (
    worker.phase_id === selectedPhase.id
      || (selectedPhase.phase_index === 1 && !worker.phase_id && phases.length === 1)
  ));
  const selectedWorker = phaseWorkers[Math.min(selectedWorkerIndex, Math.max(0, phaseWorkers.length - 1))] ?? null;

  useEffect(() => {
    panelRef.current?.focus();
  }, [workflow.id]);

  useEffect(() => {
    setSelectedPhaseIndex((index) => Math.min(index, Math.max(0, phases.length - 1)));
  }, [phases.length, workflow.id]);

  useEffect(() => {
    setSelectedWorkerIndex((index) => Math.min(index, Math.max(0, phaseWorkers.length - 1)));
  }, [phaseWorkers.length, selectedPhase.id]);

  const openSelectedWorker = (): void => {
    if (selectedWorker?.conversation_id) {
      onNavigate(selectedWorker.conversation_id);
    }
  };

  const handleKeyDown = (event: JSX.TargetedKeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      setFocusColumn('phases');
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      setFocusColumn('workers');
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      if (focusColumn === 'phases') {
        setSelectedPhaseIndex((index) => Math.max(0, index - 1));
        setSelectedWorkerIndex(0);
      } else {
        setSelectedWorkerIndex((index) => Math.max(0, index - 1));
      }
    } else if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (focusColumn === 'phases') {
        setSelectedPhaseIndex((index) => Math.min(phases.length - 1, index + 1));
        setSelectedWorkerIndex(0);
      } else {
        setSelectedWorkerIndex((index) => Math.min(Math.max(0, phaseWorkers.length - 1), index + 1));
      }
    } else if (event.key === 'Enter') {
      event.preventDefault();
      openSelectedWorker();
    }
  };

  return (
    <div className="workflow-modal-overlay" onClick={onClose}>
      <div
        className="workflow-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="workflow-modal-title"
        tabIndex={-1}
        ref={panelRef}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        <div className="workflow-modal__header">
          <div>
            <h3 id="workflow-modal-title" className="workflow-modal__title">{workflow.workflow_name}</h3>
            <div className="workflow-modal__meta">
              <span>{workflow.completed_workers}/{workflow.total_workers}</span>
              <span className={`workflow-status workflow-status--${statusClass(workflow.status)}`}>{workflow.status}</span>
              {workflow.total_tokens != null && <span>{workflow.total_tokens.toLocaleString()} tokens</span>}
            </div>
          </div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close workflow">
            &times;
          </button>
        </div>

        {workflow.warnings.length > 0 && (
          <div className="workflow-warning" role="status">
            {workflow.warnings[0].message || "Can't parse this run. The workflow format may have changed."}
          </div>
        )}

        <div className="workflow-modal__grid">
          <div className={`workflow-phase-list${focusColumn === 'phases' ? ' workflow-phase-list--active' : ''}`}>
            {phases.map((phase, index) => (
              <button
                key={phase.id}
                type="button"
                className={`workflow-phase${index === selectedPhaseIndex ? ' workflow-phase--selected' : ''}`}
                onClick={() => {
                  setSelectedPhaseIndex(index);
                  setSelectedWorkerIndex(0);
                  setFocusColumn('phases');
                }}
              >
                <span className="workflow-phase__title">{phase.title}</span>
                <span className="workflow-phase__meta">
                  {phase.completed_count}/{phase.worker_count}
                  <span className={`workflow-status workflow-status--${statusClass(phase.status)}`}>{phase.status}</span>
                </span>
              </button>
            ))}
          </div>

          <div className={`workflow-worker-list${focusColumn === 'workers' ? ' workflow-worker-list--active' : ''}`}>
            {phaseWorkers.length === 0 ? (
              <div className="workflow-worker-list__empty">No workers recorded</div>
            ) : phaseWorkers.map((worker, index) => (
              <button
                key={worker.id}
                type="button"
                className={`workflow-worker workflow-worker--${statusClass(worker.status)}${index === selectedWorkerIndex ? ' workflow-worker--selected' : ''}`}
                onClick={() => {
                  setSelectedWorkerIndex(index);
                  setFocusColumn('workers');
                }}
                onDblClick={() => {
                  if (worker.conversation_id) onNavigate(worker.conversation_id);
                }}
              >
                <span className="workflow-worker__top">
                  <span className="workflow-worker__label">{worker.label}</span>
                  <span className={`workflow-status workflow-status--${statusClass(worker.status)}`}>{worker.status}</span>
                </span>
                <span className="workflow-worker__meta">
                  {worker.model && <span>{worker.model}</span>}
                  {worker.tokens != null && <span>{worker.tokens.toLocaleString()} tokens</span>}
                  {worker.duration_ms != null && <span>{formatShelfDuration(Math.round(worker.duration_ms / 1000))}</span>}
                </span>
                {(worker.last_tool_summary || worker.result_preview || worker.warnings[0]?.message) && (
                  <span className="workflow-worker__preview">
                    {worker.warnings[0]?.message ?? worker.last_tool_summary ?? worker.result_preview}
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function ConversationMetadataModal({
  open,
  conversation,
  linkedConsoleSession,
  issueLinks,
  headerRef,
  onClose,
}: {
  open: boolean;
  conversation: Conversation & { blocks: ConversationBlock[]; children: ConversationChild[] };
  linkedConsoleSession: ConsoleSession | null;
  issueLinks: Array<{ issue_id: string; repo_id: string }>;
  headerRef: { current: HTMLElement | null };
  onClose: () => void;
}): JSX.Element {
  return (
    <DetailPaneModal
      open={open}
      onClose={onClose}
      titleId="conversation-metadata-title"
      title="Conversation metadata"
      closeLabel="Close conversation metadata"
      excludeAboveRef={headerRef}
      scrollOwnerSelector=".conv-detail"
      scrollLockClassName="conv-detail--metadata-open"
      className="conv-detail__metadata-modal"
      panelClassName="conv-detail__metadata-panel"
    >
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
            <span>Unscoped</span>
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
            <span>{formatAbsoluteTime(conversation.started_at, { invalid: '' }) || 'unknown'}</span>
          </div>
          <div>
            <span className="conv-info-grid__label">Session</span>
            <span className="conv-info-grid__mono">{conversation.session_id || linkedConsoleSession?.id || 'none'}</span>
          </div>
      </div>
      {issueLinks.length > 0 && (
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
        </div>
      )}
    </DetailPaneModal>
  );
}

function ConversationDetail({
  conversationId,
  initialConversation,
  anchor,
  onNavigate,
  consoleSessions,
  sidebarCollapsed,
}: {
  conversationId: string;
  initialConversation?: Conversation | null;
  anchor: { block: string } | { turn: string } | null;
  onNavigate: (id: string) => void;
  consoleSessions: ConsoleSession[];
  sidebarCollapsed: boolean;
}): JSX.Element {
  const [loadedConversation, setConversation] = useState<ConversationWithDetails | null>(
    initialConversation ? conversationShell(initialConversation) : null,
  );
  const [loadedConversationKey, setLoadedConversationKey] = useState(
    () => detailRequestKey('conversation', { conversationId, leaf: null }),
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [loadNonce, setLoadNonce] = useState(0);
  const requestGenerationRef = useRef(0);
  const requestAbortRef = useRef<AbortController | null>(null);
  const retryingLoadRef = useRef(false);
  const skipNextWindowLoadRef = useRef(false);
  const latestRevisionRef = useRef(initialConversation?.block_count ?? 0);
  const [jumpingToLatest, setJumpingToLatest] = useState(false);
  const [navigationTarget, setNavigationTarget] = useState<{
    key: string;
    kind: 'initial' | 'latest' | 'block' | 'turn' | 'position';
    turnId: string | null;
    blockId: string | null;
    smooth: boolean;
  } | null>(null);

  // Selection state
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [lastSelectedId, setLastSelectedId] = useState<string | null>(null);
  const [visibleTypes, setVisibleTypes] = useState<Set<BlockType>>(new Set(ALL_BLOCK_TYPES));
  const [showExport, setShowExport] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const [activeWorkflowId, setActiveWorkflowId] = useState<string | null>(null);
  const [workflows, setWorkflows] = useState<WorkflowRun[]>([]);
  const [workflowNonce, setWorkflowNonce] = useState(0);
  const [showMessageFilters, setShowMessageFilters] = useState(false);
  const [composerControlsOpen, setComposerControlsOpen] = useState(false);
  const [composerModel, setComposerModel] = useState('');
  const [composerEffort, setComposerEffort] = useState('');
  const [composerPermission, setComposerPermission] = useState('');
  const [usageModalOpen, setUsageModalOpen] = useState(false);
  const [usageRows, setUsageRows] = useState<Array<Record<string, unknown>>>([]);
  const [control, setControl] = useState<ConversationControlSnapshot | null>(null);
  const [liveProjection, setLiveProjection] = useState<ProviderLiveProjection | null>(null);

  // Bug: 84cd5ae — linked issue pills in conversation detail
  const [sessionIssueLinks, setSessionIssueLinks] = useState<Array<{ issue_id: string; repo_id: string }>>([]);

  // Fork/control state
  const [toast, setToast] = useState<ToastState>(null);
  const [continueDraft, setContinueDraft] = useState('');
  const [continueBusy, setContinueBusy] = useState(false);
  const [continueError, setContinueError] = useState<string | null>(null);
  const [resumeErrorDetails, setResumeErrorDetails] = useState<string | null>(null);
  const incomingAnchorKey = anchor ? JSON.stringify(anchor) : 'initial';
  const [effectiveAnchor, setEffectiveAnchor] = useState(anchor);
  const anchorKey = effectiveAnchor ? JSON.stringify(effectiveAnchor) : 'initial';
  const conversationRequestKey = detailRequestKey('conversation', { conversationId, anchor: anchorKey });
  const conversation = loadedConversationKey === conversationRequestKey ? loadedConversation : null;

  useEffect(() => {
    setEffectiveAnchor(anchor);
  }, [incomingAnchorKey]);

  const headerRef = useRef<HTMLElement>(null);
  const actionsTriggerRef = useRef<HTMLButtonElement>(null);
  const actionsMenuRef = useRef<HTMLDivElement>(null);
  const actionsMenuStyle = useAnchoredMenu({
    open: actionsOpen,
    anchorRef: actionsTriggerRef,
    menuRef: actionsMenuRef,
    onDismiss: () => setActionsOpen(false),
  });

  useLayoutEffect(() => {
    if (skipNextWindowLoadRef.current) {
      skipNextWindowLoadRef.current = false;
      return undefined;
    }
    const controller = new AbortController();
    requestAbortRef.current?.abort();
    requestAbortRef.current = controller;
    const generation = ++requestGenerationRef.current;
    const requestKey = conversationRequestKey;
    const cached = readPersistedDetail<ConversationWithDetails>('conversations', requestKey);
    const preserveErrorWhileRetrying = retryingLoadRef.current;
    retryingLoadRef.current = false;
    setLoadedConversationKey(requestKey);
    setConversation(cached ?? (initialConversation ? conversationShell(initialConversation) : null));
    setLoading(true);
    if (!preserveErrorWhileRetrying) setError(null);
    getConversationWindow(conversationId, { ...(effectiveAnchor ?? { target: 'initial' as const }), signal: controller.signal })
      .then((payload) => {
        if (generation !== requestGenerationRef.current) return;
        const conv = flattenConversationWindow(payload);
        latestRevisionRef.current = Math.max(latestRevisionRef.current, payload.revision);
        setConversation(conv);
        setNavigationTarget({
          key: `${generation}:${payload.revision}:${payload.target.kind}:${payload.target.turn_id ?? ''}`,
          kind: payload.target.kind,
          turnId: payload.target.turn_id,
          blockId: payload.target.block_id,
          smooth: false,
        });
        setError(null);
        setLoading(false);
      })
      .catch((err) => {
        if (generation !== requestGenerationRef.current || controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : String(err));
        setLoading(false);
      });
    return () => controller.abort();
  }, [anchorKey, conversationId, conversationRequestKey, effectiveAnchor, initialConversation, loadNonce]);

  useEffect(() => {
    let active = true;
    setLiveProjection(null);
    void getConversationControl(conversationId)
      .then((snapshot) => { if (active) setControl(snapshot); })
      .catch(() => { if (active) setControl(null); });
    void getConversationLiveProjection(conversationId)
      .then((projection) => { if (active) setLiveProjection(projection); })
      .catch(() => { if (active) setLiveProjection(null); });
    return () => { active = false; };
  }, [conversationId]);

  useEffect(() => {
    if (!conversation || loading || loadedConversationKey !== conversationRequestKey) return;
    writePersistedDetail('conversations', conversationRequestKey, conversation);
  }, [conversation, conversationRequestKey, loadedConversationKey, loading]);

  useEffect(() => {
    if (typeof EventSource === 'undefined') return undefined;
    let refreshTimer: number | null = null;
    const client = acquireSharedSse();
    const scheduleRefresh = () => {
      if (refreshTimer !== null) {
        window.clearTimeout(refreshTimer);
      }
      refreshTimer = window.setTimeout(() => {
        setLoadNonce((prev) => prev + 1);
      }, 150);
    };
    // conversation:new / conversation:updated are NOT subscribed here: the
    // id-filtered `conversation:sse` window handler below applies append
    // payloads in place and falls back to a targeted `loadNonce` refetch only
    // on a detected sequence gap. This effect keeps just the workflow refresh
    // and the reconnect resync (which patching can never survive).
    const offWorkflowUpdated = client.on('workflow:updated', () => {
      setWorkflowNonce((prev) => prev + 1);
    });
    const offControlUpdated = client.on('conversation:control-updated', (payload) => {
      const snapshot = payload as unknown as ConversationControlSnapshot;
      if (snapshot.conversation_id !== conversationId) return;
      setControl(snapshot);
    });
    const offProviderEvent = client.on('conversation:provider-event', (payload) => {
      const providerEvent = payload as unknown as ProviderAdapterEvent;
      if (providerEvent.conversation_id !== conversationId) return;
      if (providerEvent.kind === 'provider-lineage') scheduleRefresh();
      setLiveProjection((current) => mergeProviderLiveProjection(current, providerEvent));
    });
    // Reconnect resync: refetch the open conversation after a dropped stream so
    // any events missed during the gap are reconciled.
    const offState = client.onState((_state, { reconnected }) => {
      if (reconnected) {
        scheduleRefresh();
        void getConversationLiveProjection(conversationId).then(setLiveProjection).catch(() => {});
      }
    });
    client.connect();
    return () => {
      if (refreshTimer !== null) {
        window.clearTimeout(refreshTimer);
      }
      offWorkflowUpdated();
      offControlUpdated();
      offProviderEvent();
      offState();
      client.close();
    };
  }, [conversationId]);

  useEffect(() => {
    if (!conversation?.session_id) {
      setWorkflows([]);
      setActiveWorkflowId(null);
      return undefined;
    }
    let active = true;
    listWorkflows({ session_id: conversation.session_id })
      .then((runs) => {
        if (!active) return;
        setWorkflows(runs);
        if (activeWorkflowId && !runs.some((run) => run.id === activeWorkflowId)) {
          setActiveWorkflowId(null);
        }
      })
      .catch(() => {
        if (active) setWorkflows([]);
      });
    return () => { active = false; };
  }, [activeWorkflowId, conversation?.session_id, workflowNonce]);

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

  useEffect(() => {
    const handleConversationSse = (event: Event) => {
      const detail = (event as CustomEvent<ConversationAppendSseDetail>).detail;
      const data = detail?.data;
      if (!data || data.id !== conversationId) return;
      if (typeof data.block_count === 'number') {
        latestRevisionRef.current = Math.max(latestRevisionRef.current, data.block_count);
      }

      const appendBlocks = data.append?.blocks ?? [];
      if (appendBlocks.length === 0) {
        setConversation((prev) => {
          if (!prev) return prev;
          const nextTotal = Math.max(prev.position_window.total, data.block_count ?? 0);
          const appendedAfterWindow = prev.position_window.window.has_after
            ? Math.max(0, nextTotal - prev.position_window.total)
            : 0;
          return {
            ...(applyConversationAppendPayload(prev, data) ?? prev),
            position_window: {
              ...prev.position_window,
              revision: Math.max(prev.position_window.revision, data.block_count ?? 0),
              total: nextTotal,
              window: {
                ...prev.position_window.window,
                after_count: prev.position_window.window.after_count + appendedAfterWindow,
              },
            },
          };
        });
        return;
      }

      setConversation((prev) => {
        if (!prev) return prev;
        if (prev.position_window.window.has_after) {
          const nextTotal = Math.max(prev.position_window.total, data.block_count ?? prev.position_window.total);
          return {
            ...prev,
            block_count: Math.max(prev.block_count, data.block_count ?? prev.block_count),
            position_window: {
              ...prev.position_window,
              revision: Math.max(prev.position_window.revision, data.block_count ?? 0),
              total: nextTotal,
              window: {
                ...prev.position_window.window,
                after_count: prev.position_window.window.after_count
                  + Math.max(0, nextTotal - prev.position_window.total),
              },
            },
          };
        }
        const next = applyConversationAppendPayload(prev, data);
        if (!next) {
          window.setTimeout(() => setLoadNonce((nonce) => nonce + 1), 0);
          return prev;
        }
        return {
          ...next,
          position_window: {
            ...prev.position_window,
            revision: Math.max(prev.position_window.revision, data.block_count ?? next.block_count),
            total: Math.max(prev.position_window.total, data.block_count ?? next.block_count),
            window: {
              ...prev.position_window.window,
              end_position: next.blocks[next.blocks.length - 1]?.position ?? prev.position_window.window.end_position,
            },
          },
        };
      });
    };

    window.addEventListener('conversation:sse', handleConversationSse);
    return () => window.removeEventListener('conversation:sse', handleConversationSse);
  }, [conversationId]);

  const handleJumpToLatest = useCallback(async () => {
    const controller = new AbortController();
    requestAbortRef.current?.abort();
    requestAbortRef.current = controller;
    const generation = ++requestGenerationRef.current;
    setJumpingToLatest(true);
    setError(null);
    try {
      let payload = await getConversationWindow(conversationId, { target: 'latest', signal: controller.signal });
      // Appends can land after the indexed end was read but before each response
      // reaches the browser. Re-resolve until it covers the newest observed revision.
      while (payload.revision < latestRevisionRef.current) {
        if (generation !== requestGenerationRef.current || controller.signal.aborted) return;
        payload = await getConversationWindow(conversationId, { target: 'latest', signal: controller.signal });
      }
      if (generation !== requestGenerationRef.current) return;
      latestRevisionRef.current = Math.max(latestRevisionRef.current, payload.revision);
      setConversation(flattenConversationWindow(payload));
      const latestRequestKey = detailRequestKey('conversation', { conversationId, anchor: 'initial' });
      if (effectiveAnchor) {
        skipNextWindowLoadRef.current = true;
        setEffectiveAnchor(null);
      }
      setLoadedConversationKey(latestRequestKey);
      const params = new URLSearchParams({ conversation: conversationId });
      window.history.replaceState(null, '', `#/console?${params.toString()}`);
      setNavigationTarget({
        key: `${generation}:${payload.revision}:latest`,
        kind: 'latest',
        turnId: payload.target.turn_id,
        blockId: payload.target.block_id,
        smooth: true,
      });
    } catch (err) {
      if (generation === requestGenerationRef.current && !controller.signal.aborted) {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (generation === requestGenerationRef.current) setJumpingToLatest(false);
    }
  }, [conversationId, effectiveAnchor]);

  // Toast auto-dismiss
  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(null), 4000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  // Fork handlers
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

  const blocks = conversation?.blocks || [];

  const visibleBlocks = useMemo(
    () => blocks.filter((b) => visibleTypes.has(b.type)),
    [blocks, visibleTypes],
  );
  const historyEvents = useMemo(
    () => {
      const targetTurnId = conversation?.position_window.target.turn_id ?? null;
      const leadingAssistantTurnId = targetTurnId
        && visibleBlocks.length > 0
        && visibleBlocks[0].type !== 'user_message'
        && !visibleBlocks.some((block) => block.id === targetTurnId)
        ? targetTurnId
        : null;
      return conversationBlocksToStreamEvents(
        conversation?.session_id ?? conversationId,
        visibleBlocks,
        { leadingAssistantTurnId },
      );
    },
    [conversation?.position_window.target.turn_id, conversation?.session_id, conversationId, visibleBlocks],
  );
  const chatEvents = useMemo(
    () => reconcileProviderProjection(historyEvents, liveProjection),
    [historyEvents, liveProjection],
  );
  const providerStreaming = control?.turn.kind === 'queued'
    || control?.turn.kind === 'running'
    || control?.turn.kind === 'waiting-user'
    || control?.turn.kind === 'waiting-permission';
  const shelfItems = useMemo(
    () => [
      ...buildSubagentShelfItems(conversation?.children ?? [], blocks, onNavigate),
      ...buildWorkflowShelfItems(workflows, setActiveWorkflowId),
    ],
    [blocks, conversation?.children, onNavigate, workflows],
  );
  const isReadOnlyChild = Boolean(conversation?.is_sidechain || conversation?.parent_conversation_id);
  const activeWorkflow = useMemo(
    () => workflows.find((workflow) => workflow.id === activeWorkflowId) ?? null,
    [activeWorkflowId, workflows],
  );

  useEffect(() => {
    if (!conversation?.parent_conversation_id) return undefined;
    const parentId = conversation.parent_conversation_id;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      onNavigate(parentId);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [conversation?.parent_conversation_id, onNavigate]);

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

  const controlPresentation = control ? conversationControlPresentation(control) : null;

  const telemetry = useStatuslineTelemetry({
    sessionRef: linkedConsoleSession?.id ?? conversation?.session_id ?? null,
    transcriptPath: conversation?.source_path ?? null,
  });

  useEffect(() => {
    if (!linkedConsoleSession) {
      setUsageRows([]);
      return undefined;
    }
    let active = true;
    void getConsoleSessionUsage<Record<string, unknown>>(linkedConsoleSession.id)
      .then((rows) => {
        if (active) setUsageRows(rows);
      })
      .catch(() => {
        if (active) setUsageRows([]);
      });
    return () => {
      active = false;
    };
  }, [linkedConsoleSession?.id]);

  const usageSummary = useMemo(() => deriveChatUsageSummary({
    telemetry,
    events: chatEvents,
    blocks,
    usageRows,
  }), [blocks, chatEvents, telemetry, usageRows]);
  const conversationMarkdown = useMemo(
    () => serializeConversationToMarkdown(buildStreamState(chatEvents).nodes),
    [chatEvents],
  );

  const openUsage = useCallback(() => setUsageModalOpen(true), []);
  const [sessionRunOptions, setSessionRunOptions] = useState<SessionRunOptionsSnapshot | null>(null);
  useEffect(() => {
    let active = true;
    const runOptions = linkedConsoleSession
      ? getConsoleSessionOptions(linkedConsoleSession.id).then((result) => result.runOptions)
      : conversation?.source === 'codex'
        ? getConsoleRunOptions('acp', 'codex')
        : conversation?.source === 'claude_code'
          ? getConsoleRunOptions('sdk', 'claude')
          : Promise.resolve(null);
    void runOptions.then((result) => {
      if (active) setSessionRunOptions(result);
    }).catch(() => { if (active) setSessionRunOptions(null); });
    return () => { active = false; };
  }, [conversation?.source, linkedConsoleSession?.id]);

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
    if (!conversation) return null;
    if (!controlPresentation) return 'Control state unavailable.';
    if (control?.capability.kind === 'message-anchor-resume' && !latestDagUuid) {
      return 'The required message anchor is unavailable.';
    }
    if (controlPresentation.composer === 'enabled') return null;
    return controlPresentation.title;
  }, [control, controlPresentation, conversation, latestDagUuid]);

  const currentModel = conversation?.model || parseModelFromArgs(linkedConsoleSession?.args) || 'default';
  const modelRunOption = sessionRunOptions?.options.find((option) => option.id === 'model');
  const thinkingRunOption = sessionRunOptions?.options.find((option) => option.category === 'thought_level');
  const permissionRunOption = sessionRunOptions?.options.find((option) => option.category === 'mode');
  const modelOptions = (modelRunOption?.allowedValues ?? [])
    .map((choice) => choice.value)
    .filter((value): value is string => typeof value === 'string');
  const canShowSessionControls = linkedConsoleSession
    && control?.ownership.kind === 'mandible'
    && (linkedConsoleSession.backend_type === 'sdk'
      || linkedConsoleSession.backend_type === 'pty'
      || linkedConsoleSession.backend_type === 'acp');
  const canSaveComposerModel = Boolean(linkedConsoleSession)
    && control?.ownership.kind === 'mandible'
    && (linkedConsoleSession?.backend_type === 'sdk'
      || linkedConsoleSession?.backend_type === 'pty'
      || linkedConsoleSession?.backend_type === 'spawn'
      || linkedConsoleSession?.backend_type === 'acp');

  useEffect(() => {
    setComposerModel(currentModel === 'default' ? '' : currentModel);
  }, [conversationId, currentModel]);

  useEffect(() => {
    setComposerEffort(String(thinkingRunOption?.currentValue ?? ''));
    setComposerPermission(String(permissionRunOption?.currentValue ?? ''));
  }, [conversationId, thinkingRunOption?.id, thinkingRunOption?.currentValue,
    permissionRunOption?.id, permissionRunOption?.currentValue]);

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
    setResumeErrorDetails(null);
    try {
      if (!control) return;
      const messageAnchor = control.capability.kind === 'message-anchor-resume'
        ? latestDagUuid ?? undefined
        : undefined;
      const runtimeOptions: ConversationRuntimeOptions = {
        ...(composerModel ? { model: composerModel } : {}),
        ...(composerEffort ? { effort: composerEffort } : {}),
        ...(composerPermission ? { permission_mode: composerPermission as ConversationRuntimeOptions['permission_mode'] } : {}),
      };
      const result = await submitConversationControl(control, prompt, messageAnchor, runtimeOptions);
      setControl(result.snapshot);
      setContinueDraft('');
      setToast({ message: 'Message sent.', type: 'info' });
    } catch (err) {
      const formatted = formatControlApiError(err);
      if (formatted.snapshot) {
        setControl(formatted.snapshot);
      }
      setContinueError(formatted.message);
      setResumeErrorDetails(formatted.details);
    } finally {
      setContinueBusy(false);
    }
  }, [composerEffort, composerModel, composerPermission, continueDisabledReason, continueDraft, control, latestDagUuid]);

  const handleComposerKeyDown = useCallback((event: JSX.TargetedKeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'ArrowUp' && shelfItems.length > 0 && event.currentTarget.selectionStart === 0) {
      const firstRow = document.querySelector<HTMLButtonElement>('.chat-shelf-row');
      if (firstRow) {
        event.preventDefault();
        firstRow.focus();
        return;
      }
    }
    if (event.key !== 'Enter') return;
    if (event.shiftKey && !event.metaKey && !event.ctrlKey) return;
    event.preventDefault();
    event.currentTarget.form?.requestSubmit();
  }, [shelfItems.length]);

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

  const handleComposerRunOptionChange = useCallback(async (id: string, value: string) => {
    if (id === thinkingRunOption?.id) setComposerEffort(value);
    if (id === permissionRunOption?.id) setComposerPermission(value);
    if (!linkedConsoleSession || !canSaveComposerModel) return;
    setContinueError(null);
    try {
      const result = await updateConsoleSessionOptions(linkedConsoleSession.id, {
        runOptions: { [id]: value || null },
      }) as { runOptions?: SessionRunOptionsSnapshot };
      if (result.runOptions) setSessionRunOptions(result.runOptions);
    } catch (err) {
      setContinueError(err instanceof Error ? err.message : String(err));
    }
  }, [canSaveComposerModel, linkedConsoleSession, permissionRunOption?.id, thinkingRunOption?.id]);

  const externalNavigationSession = useMemo(() => {
    const ownership = control?.ownership;
    if (ownership?.kind !== 'external') return null;
    return consoleSessions.find((session) => session.id === ownership.evidence.reference) ?? null;
  }, [consoleSessions, control]);

  const handleFocusExternalSession = useCallback(async () => {
    const sessionId = externalNavigationSession?.id;
    if (!sessionId) return;
    setContinueError(null);
    setResumeErrorDetails(null);
    try {
      await navigateSession(sessionId);
      setToast({ message: 'Terminal focus requested.', type: 'info' });
    } catch (err) {
      setContinueError(err instanceof Error ? err.message : String(err));
    }
  }, [externalNavigationSession?.id]);

  const navigateToGraph = useCallback(() => {
    const sessionId = linkedConsoleSession?.id ?? conversation?.session_id;
    const focus = sessionId ? `session:${sessionId}` : undefined;
    const params = new URLSearchParams({ mode: 'activity' });
    if (focus) params.set('focus', focus);
    window.location.hash = `#/graph?${params.toString()}`;
  }, [conversation?.session_id, linkedConsoleSession?.id]);

  const retryLoad = useCallback(() => {
    retryingLoadRef.current = true;
    setLoading(true);
    setLoadNonce((prev) => prev + 1);
  }, []);

  const loadErrorNotice = error ? (
    <DetailPaneNotice
      severity="error"
      density="compact"
      actions={(
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          disabled={loading}
          onClick={retryLoad}
        >
          Retry
        </button>
      )}
    >
      {error}
    </DetailPaneNotice>
  ) : undefined;

  if (loading && !conversation && !error) {
    return <LoadingSkeleton variant="detail" label="Loading conversation" />;
  }

  if (error && !conversation) {
    return (
      <DetailPaneShell
        as="div"
        variant="compact"
        className="conv-detail"
        bodyClassName="conv-detail__body"
        header={<DetailPaneHeader variant="compact" title={initialConversation?.title ?? 'Conversation'} />}
        notice={loadErrorNotice}
        ariaBusy={loading}
      >
        <div className="empty-state">Conversation content unavailable.</div>
      </DetailPaneShell>
    );
  }

  if (!conversation) {
    return (
      <div className="conv-detail">
        <div className="empty-state">Conversation not found.</div>
      </div>
    );
  }

  const parentLink = conversation.parent_conversation_id ? (
    <div className="conv-parent-link">
      <button
        type="button"
        className="btn btn--ghost btn--sm"
        onClick={() => onNavigate(conversation.parent_conversation_id!)}
      >
        Subagent of {conversation.parent?.title ? truncate(stripMarkdownText(conversation.parent.title), 80) : 'parent conversation'}
      </button>
    </div>
  ) : undefined;

  const detailHeader = (
    <DetailPaneHeader
      variant="compact"
      title={(
        <>
          {conversation.parent_conversation_id && (
            <span className="conv-subagent-indicator" title="Sub-agent conversation">&#x2937; </span>
          )}
          <span>{getConversationTitle(conversation)}</span>
        </>
      )}
      titleTooltip={getConversationTitle(conversation)}
      menuLabel="Conversation detail actions"
      menu={(
        <div className="conv-actions">
          <button
              ref={actionsTriggerRef}
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
            <div
                ref={actionsMenuRef}
                className="conv-actions__menu app-anchored-menu"
                role="menu"
                popover="manual"
                style={actionsMenuStyle}
              >
                <button type="button" role="menuitem" onClick={() => { setInfoOpen(true); setActionsOpen(false); }}>
                  View metadata
                </button>
                <button
                  type="button"
                  role="menuitem"
                  disabled={!conversationMarkdown}
                  onClick={() => {
                    void navigator.clipboard.writeText(conversationMarkdown).catch(() => {});
                    setActionsOpen(false);
                  }}
                >
                  Copy markdown
                </button>
                <button
                  type="button"
                  role="menuitem"
                  disabled={!conversationMarkdown}
                  onClick={() => { openMarkdownDocument(conversationMarkdown); setActionsOpen(false); }}
                >
                  Open markdown
                </button>
                <button type="button" role="menuitem" onClick={() => { void handleStarToggle(); setActionsOpen(false); }}>
                  {conversation.starred ? 'Unstar' : 'Star'}
                </button>
                <button type="button" role="menuitem" onClick={() => { navigateToGraph(); setActionsOpen(false); }}>
                  Show in graph
                </button>
                {linkedConsoleSession
                  && (control?.capability.kind === 'provider-session-resume'
                    || control?.capability.kind === 'message-anchor-resume') && (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      window.location.hash = `#/console?session=${encodeURIComponent(linkedConsoleSession.id)}`;
                      setActionsOpen(false);
                    }}
                  >
                    Resume in terminal
                  </button>
                )}
                <button type="button" role="menuitem" onClick={() => { setShowMessageFilters((prev) => !prev); setActionsOpen(false); }}>
                  {showMessageFilters ? 'Hide message filters' : 'Message filters'}
                </button>
                <button type="button" role="menuitem" onClick={() => { setSelectMode(true); setActionsOpen(false); }}>
                  Select messages
                </button>
            </div>
          )}
        </div>
      )}
      metadata={(
        <span className="conv-detail__status">
          <span className="conv-detail__provider">
            {getConversationHeaderProviderLabel(conversation.source)}
          </span>
          {controlPresentation && control && (
            <span
              className={`conv-attach-badge conv-attach-badge--${control.capability.kind}`}
              title={controlPresentation.title}
            >
              {controlPresentation.status}
            </span>
          )}
        </span>
      )}
    />
  );

  const detailFooter = (
    <>
      <Shelf
        conversationId={conversation.id}
        title="Activity"
        items={shelfItems}
        onEscape={conversation.parent_conversation_id ? () => onNavigate(conversation.parent_conversation_id!) : undefined}
      />

      {isReadOnlyChild ? (
        <div className="conv-compose conv-compose--readonly">
          <span>Read-only subagent transcript</span>
        </div>
      ) : controlPresentation && controlPresentation.composer !== 'hidden' ? (
      <div className="conv-compose">
        <form id={`conversation-compose-${conversation.id}`} className="conv-compose__form" onSubmit={handleContinueSubmit}>
          <textarea
            className="conv-compose__input"
            value={continueDraft}
            onInput={(event) => setContinueDraft(event.currentTarget.value)}
            onKeyDown={handleComposerKeyDown}
            placeholder="Message..."
            disabled={continueBusy || Boolean(continueDisabledReason)}
            rows={3}
          />
        </form>
        {(control?.capability.kind === 'blocked-external'
          || control?.capability.kind === 'blocked-ownership-unknown') && (
          <div className="conv-compose__actions">
            {externalNavigationSession && (
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={() => { void handleFocusExternalSession(); }}
              >
                Go to terminal
              </button>
            )}
          </div>
        )}
        <div className="conv-compose__footer">
          <div className="conv-compose__runtime">
            <span className="conv-compose__runtime-leading">
              {permissionRunOption && permissionRunOption.enforcement.status !== 'unsupported' ? (
                <select
                  className="conv-compose__permission"
                  value={composerPermission}
                  disabled={continueBusy || permissionRunOption.availability !== 'available'}
                  title="Permission mode"
                  aria-label="Permission mode"
                  onChange={(event) => { void handleComposerRunOptionChange(permissionRunOption.id, event.currentTarget.value); }}
                >
                  {permissionRunOption.nullable && <option value="">Use app default</option>}
                  {(permissionRunOption.allowedValues ?? []).map((choice) => (
                    <option key={String(choice.value)} value={String(choice.value)}>{choice.label}</option>
                  ))}
                </select>
              ) : null}
              {canShowSessionControls && (
                <button
                  type="button"
                  className="btn btn--ghost btn--sm"
                  onClick={() => setComposerControlsOpen((prev) => !prev)}
                >
                  More
                </button>
              )}
            </span>
            <span className="conv-compose__runtime-actions">
              <ContextUsageRing usage={usageSummary} size="sm" onClick={openUsage} />
              <select
                className="conv-compose__model"
                value={composerModel}
                disabled={continueBusy || modelOptions.length === 0}
                title="Model"
                aria-label="Model"
                onChange={(event) => { void handleComposerModelChange(event.currentTarget.value); }}
              >
                <option value={currentModel === 'default' ? '' : currentModel}>
                  {currentModel === 'default' ? 'Use app default' : currentModel}
                </option>
                {modelOptions
                  .filter((model) => model !== currentModel)
                  .map((model) => (
                    <option key={model} value={model}>{model}</option>
                  ))}
              </select>
              {thinkingRunOption && thinkingRunOption.enforcement.status !== 'unsupported' ? (
                <select
                  className="conv-compose__effort"
                  value={composerEffort}
                  disabled={continueBusy || thinkingRunOption.availability !== 'available'}
                  title={thinkingRunOption.label}
                  aria-label={thinkingRunOption.label}
                  onChange={(event) => { void handleComposerRunOptionChange(thinkingRunOption.id, event.currentTarget.value); }}
                >
                  {thinkingRunOption.nullable && <option value="">Use app default</option>}
                  {(thinkingRunOption.allowedValues ?? []).map((choice) => (
                    <option key={String(choice.value)} value={String(choice.value)}>{choice.label}</option>
                  ))}
                </select>
              ) : null}
              <button
                type="submit"
                form={`conversation-compose-${conversation.id}`}
                className="conv-compose__send"
                disabled={continueBusy || Boolean(continueDisabledReason) || !continueDraft.trim()}
                title={controlPresentation?.submitLabel ?? 'Send'}
                aria-label={controlPresentation?.submitLabel ?? 'Send'}
              >
                {continueBusy ? '…' : (
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.25" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="m6 12 6-6 6 6" />
                    <path d="M12 6v12" />
                  </svg>
                )}
              </button>
            </span>
          </div>
        </div>
        {canShowSessionControls && composerControlsOpen && linkedConsoleSession && (
          <div className="conv-compose__controls">
            <SessionControls
              sessionId={linkedConsoleSession.id}
              runOptions={sessionRunOptions}
              allowedTools={linkedConsoleSession.allowed_tools}
              hiddenOptionIds={[
                modelRunOption?.id,
                thinkingRunOption?.id,
                permissionRunOption?.id,
              ].filter((id): id is string => Boolean(id))}
            />
          </div>
        )}
        {(continueError || continueDisabledReason) && (
          <div className={`conv-compose__status${continueError ? ' conv-compose__status--error' : ''}`}>
            {continueError ?? continueDisabledReason}
          </div>
        )}
        {resumeErrorDetails && (
          <details className="conv-compose__details">
            <summary>Details</summary>
            <pre>{resumeErrorDetails}</pre>
          </details>
        )}
      </div>
      ) : null}
    </>
  );
  const shouldRenderDetailFooter = shelfItems.length > 0
    || isReadOnlyChild
    || Boolean(controlPresentation && controlPresentation.composer !== 'hidden');

  const detailOverlays = (
    <>
      <ChatOverlay
        open={usageModalOpen}
        titleId="conversation-usage-modal-title"
        onClose={() => setUsageModalOpen(false)}
      >
        <UsageModal
          usage={usageSummary}
          titleId="conversation-usage-modal-title"
          onClose={() => setUsageModalOpen(false)}
        />
      </ChatOverlay>

      {activeWorkflow && (
        <WorkflowRunDialog
          workflow={activeWorkflow}
          onClose={() => setActiveWorkflowId(null)}
          onNavigate={onNavigate}
        />
      )}

      <Toast toast={toast} onDismiss={() => setToast(null)} />

      <ConversationMetadataModal
        open={infoOpen}
        conversation={conversation}
        linkedConsoleSession={linkedConsoleSession}
        issueLinks={sessionIssueLinks}
        headerRef={headerRef}
        onClose={() => setInfoOpen(false)}
      />
    </>
  );

  return (
    <DetailPaneShell
      as="div"
      variant="compact"
      className={`conv-detail${sidebarCollapsed ? ' conv-detail--shelf-collapsed' : ''}`}
      headerClassName="conv-detail__shell-header"
      headerRef={headerRef}
      subheaderClassName="conv-detail__parent"
      bodyClassName="conv-detail__body"
      footerClassName="conv-detail__footer"
      header={detailHeader}
      subheader={parentLink}
      footer={shouldRenderDetailFooter ? { content: detailFooter } : undefined}
      overlays={detailOverlays}
      ariaBusy={loading}
      notice={loadErrorNotice}
    >
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

      <div className="conv-transcript">
        <ChatSurface
          events={chatEvents}
          streaming={providerStreaming}
          emptyLabel={loading ? 'Loading messages...' : 'No blocks match the current filters.'}
          unmaterializedAfterCount={conversation.position_window.window.after_count}
          onJumpToLatest={handleJumpToLatest}
          jumpingToLatest={jumpingToLatest}
          navigationTarget={navigationTarget}
          selectedMessageId={conversation.position_window.target.turn_id}
          selectedBlockIds={selected}
          selectMode={selectMode}
          onToggleBlockSelect={(blockId, shiftKey) => shiftKey ? handleShiftSelect(blockId) : toggleSelect(blockId)}
          onFork={handleFork}
          onSelectMessageInfo={(turnId) => {
            window.location.hash = conversationTurnSelectionHref(
              conversationId,
              conversation.position_window.target.turn_id,
              turnId,
            );
          }}
          sessionInfo={{
            sessionId: conversation.session_id,
            backend: conversation.source,
            model: conversation.model ?? undefined,
          }}
        />
      </div>
    </DetailPaneShell>
  );
}

// ── Sidebar Item ──

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
  pinned,
  pinActionRef,
  onEditTags,
  onRenameSession,
}: {
  entry: ChatEntry;
  isSelected: boolean;
  onClick: () => void;
  onTogglePin?: () => void;
  pinned?: boolean;
  pinActionRef?: (element: HTMLButtonElement | null) => void;
  onEditTags?: (tags: string[]) => void;
  onRenameSession?: (label: string | null) => void;
}): JSX.Element {
  const conversation = entry.conversation;
  const session = entry.session;
  const isSubAgent = !!conversation?.parent_conversation_id;
  const source = conversation?.source ?? (session ? sourceFromSession(session) : null);
  const providerLabel = source ? DETAIL_HEADER_PROVIDER_LABELS[source] : null;
  const title = conversation ? getConversationTitle(conversation) : getConsoleSessionTitle(session);
  const canShowActions = Boolean(onTogglePin || onEditTags || onRenameSession);
  const isPinned = pinned ?? Boolean(conversation?.starred || session?.pinned);
  const hasBadges = Boolean(conversation?.tags.length || session?.owner);

  const handleEditTags = () => {
    if (!onEditTags) return;
    const nextLabel = window.prompt('Edit tags (comma-separated)', conversation?.tags.join(', ') ?? '');
    if (nextLabel === null) return;
    onEditTags(parseConversationTagsInput(nextLabel));
  };

  const handleRenameSession = () => {
    if (!onRenameSession) return;
    const nextLabel = window.prompt('Rename session', title);
    if (nextLabel === null) return;
    const normalized = stripMarkdownText(nextLabel);
    onRenameSession(normalized || null);
  };

  const handleTogglePin = () => {
    onTogglePin?.();
  };

  const overflowActions: SidebarItemOverflowAction[] = [];
  if (onEditTags) {
    overflowActions.push({ id: 'edit-tags', label: 'Edit tags', onSelect: handleEditTags });
  }
  if (onRenameSession) {
    overflowActions.push({ id: 'rename-session', label: 'Rename session', onSelect: handleRenameSession });
  }

  return (
    <SidebarItemRow
      label={title}
      selectionLabel={`Open ${entry.kind === 'conversation' ? 'conversation' : 'session'} ${title}`}
      provider={providerLabel && source ? { label: providerLabel, tone: CHAT_PROVIDER_TONES[source] } : undefined}
      selectionTone={source ? CHAT_PROVIDER_TONES[source] : undefined}
      selected={isSelected}
      ariaCurrent={isSelected ? 'true' : undefined}
      className={`chat-history-item${isSubAgent ? ' chat-history-item--subagent' : ''}`}
      onSelect={onClick}
      leading={isSubAgent ? <span className="conv-subagent-indicator" title="Sub-agent">&#x2937;</span> : undefined}
      badges={hasBadges ? (
        <>
          {conversation && conversation.tags.length > 0 ? (
            <SidebarItemBadge className="chat-history-item__tags" title={conversation.tags.join(' · ')}>
              {conversation.tags.join(' · ')}
            </SidebarItemBadge>
          ) : null}
          {session?.owner ? (
            <SidebarItemBadge
              className="chat-history-item__owner"
              title={`${session.owner.display_name} (${session.owner.kind})`}
            >
              {session.owner.display_name}
            </SidebarItemBadge>
          ) : null}
        </>
      ) : undefined}
      actions={canShowActions ? (
        <>
          {onTogglePin ? (
            <SidebarItemPinAction
              label={title}
              pressed={isPinned}
              actionRef={pinActionRef}
              onPress={handleTogglePin}
            />
          ) : null}
          <SidebarItemOverflowMenu
            label={`Chat actions for ${title}`}
            actions={overflowActions}
          />
        </>
      ) : undefined}
    />
  );
}

function LiveSessionDetail({
  session,
}: {
  session: ConsoleSession;
}): JSX.Element {
  const [viewMode, setViewMode] = useState<ViewMode>('rich');
  const [control, setControl] = useState<ConversationControlSnapshot | null>(null);
  const [messageAnchor, setMessageAnchor] = useState<string | null>(null);

  useEffect(() => {
    if (!session.provider_session_id) {
      setControl(null);
      setMessageAnchor(null);
      return undefined;
    }
    let active = true;
    void getConversations({ session_id: session.provider_session_id, limit: 1 })
      .then(async ({ conversations }) => {
        const conversation = conversations[0];
        if (!conversation) return null;
        const [snapshot, window] = await Promise.all([
          getConversationControl(conversation.id),
          getConversationWindow(conversation.id, { target: 'latest', limit: 1 }),
        ]);
        let latestMessageAnchor: string | null = null;
        for (let index = window.blocks.length - 1; index >= 0; index -= 1) {
          if (window.blocks[index].dag_uuid) {
            latestMessageAnchor = window.blocks[index].dag_uuid ?? null;
            break;
          }
        }
        return {
          snapshot,
          messageAnchor: latestMessageAnchor,
        };
      })
      .then((result) => {
        if (!active) return;
        setControl(result?.snapshot ?? null);
        setMessageAnchor(result?.messageAnchor ?? null);
      })
      .catch(() => {
        if (!active) return;
        setControl(null);
        setMessageAnchor(null);
      });
    return () => { active = false; };
  }, [session.provider_session_id]);

  useEffect(() => {
    if (!control || typeof EventSource === 'undefined') return undefined;
    const client = acquireSharedSse();
    const offControlUpdated = client.on('conversation:control-updated', (payload) => {
      const snapshot = payload as unknown as ConversationControlSnapshot;
      if (snapshot.conversation_id === control.conversation_id) setControl(snapshot);
    });
    client.connect();
    return () => { offControlUpdated(); client.close(); };
  }, [control?.conversation_id]);

  const controlPresentation = control ? conversationControlPresentation(control) : null;

  return (
    <div className="chat-live-detail">
      <div className="chat-live-detail__header">
        <div className="chat-live-detail__title-group">
          <h2 className="chat-live-detail__title">{session.label || 'Untitled session'}</h2>
          <div className="chat-live-detail__meta">
            <span className={`chat-live-session__status chat-live-session__status--${controlPresentation?.status.toLowerCase() ?? 'unavailable'}`} />
            <span>{getAgentLabel(session.agent_type)}</span>
            {session.owner && (
              <span>{session.owner.display_name} · {session.owner.kind}</span>
            )}
            <span title={controlPresentation?.title}>{controlPresentation?.status ?? 'Unavailable'}</span>
            <span title={session.transport_badge?.title}>
              {session.transport_badge?.label ?? session.transport_lane ?? session.backend_type}
            </span>
            {/* Issue 499c148 — the session's client token and its session
                bindings resolve to different users. */}
            {session.identity_mismatch && (
              <span
                className="chat-live-detail__identity-warning"
                title={session.identity_mismatch.message}
              >
                ⚠ identity mismatch
              </span>
            )}
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
          transportLane={session.transport_lane}
          transportBadge={session.transport_badge}
          attention={session.attention}
          providerSessionId={session.provider_session_id}
          conversationControl={control}
          conversationMessageAnchor={messageAnchor}
          onConversationControlChange={setControl}
          isVisible
          viewMode={viewMode}
          onViewModeChange={setViewMode}
          channelEnabled={!!session.channel_enabled}
          workspaceMode
        />
      </div>
    </div>
  );
}

// ── Main View ──

export function ConversationsView({
  consoleSessions,
  initialConversationId,
  initialSessionId,
  sidebarHidden = false,
  sidebarGroupLimit: rawSidebarGroupLimit,
  instance = null,
  onSelectSession,
  onNewSession,
}: ConversationsViewProps): JSX.Element {
  const [selection, setSelection] = useState<ChatSelection>(null);
  const detailPortalRef = useRef<HTMLDivElement>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [newSessionCwd, setNewSessionCwd] = useState<string | undefined>(undefined);
  const [projectChooserOpen, setProjectChooserOpen] = useState(false);
  const [projectChooserSelection, setProjectChooserSelection] = useState('');
  const [search, setSearch] = useState('');
  const [searchMode, setSearchMode] = useState<'title' | 'full'>('title');
  const [sourceFilter, setSourceFilter] = useState<ConversationSource | 'all'>('all');
  const [starredOnly, setStarredOnly] = useState(false);
  const [hideEmpty, setHideEmpty] = useState(true);
  const [sort, setSort] = useState<'date' | 'blocks'>('date');
  const [filterPanelOpen, setFilterPanelOpen] = useState(false);
  const [collapsedSections, setCollapsedSections] = useState<Set<ChatSectionId>>(new Set());
  const [collapsedProjects, setCollapsedProjects] = useState<Set<string>>(new Set());
  const [chatViewState, setChatViewState] = useChatViewState();
  const sidebarGroupLimit = normalizeSidebarGroupLimit(rawSidebarGroupLimit);
  const [serverGroups, setServerGroups] = useState<ConversationSidebarGroup[]>([]);
  const [canonicalProjects, setCanonicalProjects] = useState<CanonicalProject[]>([]);
  const [canonicalProjectsReady, setCanonicalProjectsReady] = useState(false);
  const [canonicalProjectsLoaded, setCanonicalProjectsLoaded] = useState(false);
  const [visibleTargets, setVisibleTargets] = useState<Map<string, number>>(new Map());
  const [loadingMoreKeys, setLoadingMoreKeys] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const searchTimer = useRef<number | null>(null);
  const fetchGenerationRef = useRef(0);
  const groupsRef = useRef(serverGroups);
  groupsRef.current = serverGroups;
  const targetsRef = useRef(visibleTargets);
  targetsRef.current = visibleTargets;
  const previousGroupLimitRef = useRef(sidebarGroupLimit);
  const pinActionRefs = useRef(new Map<string, HTMLButtonElement>());
  const pendingPinFocusKey = useRef<string | null>(null);

  useEffect(() => {
    let active = true;
    void listCanonicalProjects().then((projects) => {
      if (active) {
        setCanonicalProjects(projects);
        setCanonicalProjectsLoaded(true);
        setCanonicalProjectsReady(true);
      }
    }).catch(() => {
      if (active) {
        setCanonicalProjects([]);
        setCanonicalProjectsReady(true);
      }
    });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    const previous = previousGroupLimitRef.current;
    if (previous === sidebarGroupLimit) return;
    previousGroupLimitRef.current = sidebarGroupLimit;
    setVisibleTargets((current) => new Map(
      Array.from(current, ([key, target]) => [key, target === previous ? sidebarGroupLimit : target]),
    ));
  }, [sidebarGroupLimit]);

  useLayoutEffect(() => {
    const key = pendingPinFocusKey.current;
    if (!key) return;
    const action = pinActionRefs.current.get(key);
    if (!action) return;
    action.focus({ preventScroll: true });
    pendingPinFocusKey.current = null;
  });

  const selectedConversationId = selection?.type === 'conversation' ? selection.id : null;
  const selectedSessionId = selection?.type === 'session' ? selection.id : null;
  const previewMutationsRejected = instance?.operational_mutations === 'reject';
  const isConversationPinned = useCallback((conversation: Conversation): boolean => {
    if (!previewMutationsRejected) return conversation.starred;
    return Object.prototype.hasOwnProperty.call(chatViewState.previewPinOverrides, conversation.id)
      ? chatViewState.previewPinOverrides[conversation.id]
      : conversation.starred;
  }, [chatViewState.previewPinOverrides, previewMutationsRejected]);

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

  const registeredProjects = useMemo(() => registeredChatProjects(canonicalProjects), [canonicalProjects]);
  const availableProjectCount = useMemo(
    () => new Set(registeredProjects.map((project) => project.id)).size,
    [registeredProjects],
  );

  useEffect(() => {
    if (!canonicalProjectsLoaded) return;
    setChatViewState((current) => {
      const shownProjects = reconcileShownProjects(current.shownProjects, canonicalProjects);
      return shownProjects.length === current.shownProjects.length
        && shownProjects.every((shown, index) => (
          shown.projectId === current.shownProjects[index].projectId
          && shown.checkoutId === current.shownProjects[index].checkoutId
        ))
        ? current
        : { ...current, shownProjects };
    });
  }, [canonicalProjects, canonicalProjectsLoaded, setChatViewState]);

  const selectedProjectIds = useMemo(() => {
    if (!canonicalProjectsReady) return [];
    if (!canonicalProjectsLoaded) {
      return [...new Set(chatViewState.shownProjects.map((shown) => shown.projectId))];
    }
    const registeredSelections = new Set(registeredProjects.map((project) => (
      `${project.id}\0${project.checkoutId}`
    )));
    return [...new Set(chatViewState.shownProjects
      .filter((shown) => registeredSelections.has(`${shown.projectId}\0${shown.checkoutId}`))
      .map((shown) => shown.projectId))];
  }, [canonicalProjectsLoaded, canonicalProjectsReady, chatViewState.shownProjects, registeredProjects]);

  const sidebarRequestParams = useCallback((limit: number, projectIds = selectedProjectIds) => {
    const params: Parameters<typeof getConversationSidebar>[0] = {
      limit,
      sort: sort === 'blocks' ? 'block_count' : 'started_at',
      exclude_subagents: true,
      project_ids: projectIds,
    };
    if (sourceFilter !== 'all') params.source = sourceFilter;
    if (starredOnly) params.starred = true;
    if (hideEmpty) params.min_blocks = 1;
    applyConversationSearchParams(params, search, searchMode);
    return params;
  }, [hideEmpty, selectedProjectIds, sourceFilter, starredOnly, sort, search, searchMode]);

  // A refresh starts from one bounded page per logical group, then replays only
  // the extra pages needed to restore that group's current visible target.
  const fetchConversationGroups = useCallback(async (projectIds = selectedProjectIds) => {
    if (!canonicalProjectsReady) return;
    const generation = ++fetchGenerationRef.current;
    setLoading(true);
    try {
      const result = await getConversationSidebar(sidebarRequestParams(sidebarGroupLimit, projectIds));
      const reconciled = await Promise.all(result.groups.map(async (initialGroup) => {
        const target = targetsRef.current.get(initialGroup.key) ?? sidebarGroupLimit;
        let group = initialGroup;
        while (group.conversations.length < target && group.next_cursor) {
          const page = await getConversationSidebar({
            ...sidebarRequestParams(Math.min(sidebarGroupLimit, target - group.conversations.length), projectIds),
            group_key: group.key,
            cursor: group.next_cursor,
          });
          const next = page.groups[0];
          if (!next) break;
          const seen = new Set(group.conversations.map((conversation) => conversation.id));
          group = {
            ...next,
            conversations: [...group.conversations, ...next.conversations.filter((conversation) => !seen.has(conversation.id))],
          };
        }
        return group;
      }));
      if (generation !== fetchGenerationRef.current) return;
      setServerGroups(reconciled);
      setVisibleTargets((current) => {
        const next = new Map(current);
        for (const group of reconciled) {
          if (!next.has(group.key)) next.set(group.key, sidebarGroupLimit);
        }
        return next;
      });
    } catch {
      // ignore fetch errors
    } finally {
      if (generation === fetchGenerationRef.current) setLoading(false);
    }
  }, [canonicalProjectsReady, selectedProjectIds, sidebarGroupLimit, sidebarRequestParams]);

  // Live sidebar updates: the sidebar owns its own shared SSE handle rather than
  // refetching whenever the parent's `initialConversations` prop changes.
  // - conversation:updated for a known id merges {title, block_count} in place
  //   with a monotonic block_count check (rejecting stale/out-of-order summaries);
  // - conversation:new, an unknown id, or a summary with no block_count anchor
  //   schedules one trailing 1 s refetch (membership/grouping under the active
  //   filters is server-determined);
  // - a reconnect refetches, since patching cannot survive a missed-event gap.
  // Bug: d51fbc8 — SSE updates must not blindly overwrite the filtered/paginated list.
  useEffect(() => {
    if (typeof EventSource === 'undefined') return undefined;
    let refetchTimer: number | null = null;
    const client = acquireSharedSse();
    const scheduleListRefetch = () => {
      if (refetchTimer !== null) return;
      refetchTimer = window.setTimeout(() => {
        refetchTimer = null;
        void fetchConversationGroups();
      }, 1000);
    };
    const offUpdated = client.on('conversation:updated', (payload) => {
      const data = (
        typeof payload.data === 'object' && payload.data !== null ? payload.data : payload
      ) as ConversationAppendPayload;
      const rawData = data as ConversationAppendPayload & { updates?: unknown };
      const membershipFields = ['starred', 'cwd', 'project_path', 'canonical_project_id', 'canonical_project_key'];
      const membershipChanged = membershipFields.some((field) => Object.prototype.hasOwnProperty.call(rawData, field))
        || (Array.isArray(rawData.updates) && rawData.updates.some((field) => (
          typeof field === 'string' && membershipFields.includes(field)
        )));
      const groupIndex = data.id
        ? groupsRef.current.findIndex((group) => group.conversations.some((conversation) => conversation.id === data.id))
        : -1;
      if (groupIndex < 0) {
        scheduleListRefetch();
        return;
      }
      const currentGroup = groupsRef.current[groupIndex];
      const currentConversation = currentGroup.conversations.find((conversation) => conversation.id === data.id)!;
      const sortKeyChanged = sort === 'blocks'
        ? typeof data.block_count === 'number' && data.block_count !== currentConversation.block_count
        : typeof data.started_at === 'string' && data.started_at !== currentConversation.started_at;
      const result = mergeConversationSummaryIntoList(currentGroup.conversations, data);
      if (result.applied) {
        setServerGroups(groupsRef.current.map((group, index) => (
          index === groupIndex
            ? { ...group, conversations: result.conversations as ConversationSidebarConversation[] }
            : group
        )));
        if (sortKeyChanged || membershipChanged) scheduleListRefetch();
      } else if (result.refetch) {
        scheduleListRefetch();
      } else if (membershipChanged) {
        scheduleListRefetch();
      }
      // stale summary (neither applied nor refetch): keep the list unchanged.
    });
    const offNew = client.on('conversation:new', () => {
      scheduleListRefetch();
    });
    const offState = client.onState((_state, { reconnected }) => {
      if (reconnected) void fetchConversationGroups();
    });
    client.connect();
    return () => {
      if (refetchTimer !== null) {
        window.clearTimeout(refetchTimer);
      }
      offUpdated();
      offNew();
      offState();
      client.close();
    };
  }, [fetchConversationGroups]);

  // Debounced fetch on filter changes
  useEffect(() => {
    if (!canonicalProjectsReady) return undefined;
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = window.setTimeout(() => {
      fetchConversationGroups();
    }, 300);
    return () => {
      if (searchTimer.current) clearTimeout(searchTimer.current);
    };
  }, [canonicalProjectsReady, fetchConversationGroups]);

  const selectedConversationSummary = selection?.type === 'conversation'
    ? serverGroups.flatMap((group) => group.conversations).find((conv) => conv.id === selection.id) ?? null
    : null;

  // Client-side title-only filter (when searchMode === 'title', server already
  // searched summary too, so we narrow here to title-only for the title mode).
  // When searchMode === 'full', server search is sufficient — show all results.
  const displayedConversations = useMemo(() => {
    const base = serverGroups.map((group) => ({
      ...group,
      conversations: group.conversations.filter((conv) =>
        !isSubagentConversation(conv) && (!hideEmpty || conv.block_count > 0)
      ),
    }));
    if (!search.trim() || searchMode === 'full') return base;
    const needle = search.trim().toLowerCase();
    return base.map((group) => ({
      ...group,
      conversations: group.conversations.filter((conv) => getConversationTitle(conv).toLowerCase().includes(needle)),
    }));
  }, [serverGroups, hideEmpty, search, searchMode]);

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
    type WorkingGroup = ChatProjectGroup & { kind: ConversationSidebarGroup['kind'] };
    const selectedCheckoutByProject = new Map(chatViewState.shownProjects.flatMap((shown) => {
      const registered = registeredProjects.find((project) => (
        project.id === shown.projectId && project.checkoutId === shown.checkoutId
      ));
      return registered ? [[shown.projectId, registered] as const] : [];
    }));
    const groups = displayedConversations.map((group): WorkingGroup => ({
      key: group.key,
      label: group.label,
      total: group.total,
      nextCursor: group.next_cursor,
      kind: group.kind,
      entries: [],
      exactRoot: group.kind === 'project' && group.project_id
        ? selectedCheckoutByProject.get(group.project_id)?.root
        : undefined,
      canonicalProjectId: group.kind === 'project' ? group.project_id : undefined,
      canonicalProjectKey: group.kind === 'project' ? group.project_key : undefined,
    }));
    const groupByKey = new Map(groups.map((group) => [group.key, group]));
    const ensureKindGroup = (
      kind: 'pinned' | 'chats',
      label: 'Pinned' | 'Chats',
    ): WorkingGroup => {
      const existing = groups.find((group) => group.kind === kind);
      if (existing) return existing;
      const created: WorkingGroup = {
        key: kind,
        kind,
        label,
        total: 0,
        nextCursor: null,
        entries: [],
      };
      groups.push(created);
      groupByKey.set(created.key, created);
      return created;
    };

    for (const sourceGroup of displayedConversations) {
      const source = groupByKey.get(sourceGroup.key)!;
      for (const conversation of sourceGroup.conversations) {
        const canonicalProjectId = getCanonicalConversationProjectId(conversation);
        const canonicalProjectGroup = canonicalProjectId && selectedProjectIds.includes(canonicalProjectId)
          ? groups.find((group) => (
            group.kind === 'project' && group.canonicalProjectId === canonicalProjectId
          ))
          : undefined;
        const target = isConversationPinned(conversation)
          ? ensureKindGroup('pinned', 'Pinned')
          : source.kind === 'pinned' ? canonicalProjectGroup ?? ensureKindGroup('chats', 'Chats') : source;
        if (source.key !== target.key) {
          source.total = Math.max(0, source.total - 1);
          target.total += 1;
        }
        target.entries.push({
          key: `conversation:${conversation.id}`,
          time: getConversationTime(conversation),
          kind: 'conversation',
          conversation,
          liveSession: liveByProviderSession.get(conversation.session_id) ?? null,
        });
      }
    }
    const conversationProviderIds = new Set(
      displayedConversations.flatMap((group) => group.conversations.map((conversation) => conversation.session_id)),
    );
    for (const session of liveSessions) {
      if (isSubagentSession(session)) {
        continue;
      }
      if (session.provider_session_id && conversationProviderIds.has(session.provider_session_id)) {
        continue;
      }
      const kind = session.pinned ? 'pinned' : 'chats';
      const group = kind === 'pinned'
        ? ensureKindGroup('pinned', 'Pinned')
        : ensureKindGroup('chats', 'Chats');
      group.total += 1;
      group.entries.push({
        key: `session:${session.id}`,
        time: getSessionTime(session),
        kind: 'session',
        session,
        liveSession: session,
      });
    }

    const entryOrderRow = (entry: ChatEntry) => entry.conversation ?? {
      id: entry.key,
      started_at: Number.isFinite(entry.time) ? new Date(entry.time).toISOString() : '',
      block_count: 0,
    };
    const compareEntries = (a: ChatEntry, b: ChatEntry) => compareConversationSidebarRows(
      entryOrderRow(a),
      entryOrderRow(b),
      sort === 'blocks' ? 'block_count' : 'started_at',
    );
    const sortEntries = (items: ChatEntry[]) => [...items].sort(compareEntries);

    for (const group of groups) {
      group.entries = group.kind === 'pinned'
        ? orderByPinnedIds(
          group.entries,
          chatViewState.pinnedConversationIds,
          (entry) => entry.conversation?.id ?? `session:${entry.session?.id ?? entry.key}`,
          compareEntries,
        )
        : sortEntries(group.entries);
    }
    ensureKindGroup('chats', 'Chats');
    const visibleGroups = groups.filter((group) => (
      group.kind === 'chats' || group.kind === 'project' || group.total > 0 || group.entries.length > 0
    ));
    return {
      pinned: visibleGroups.find((group) => group.kind === 'pinned') ?? null,
      projects: visibleGroups
        .filter((group) => group.kind === 'project')
        .sort((left, right) => left.label.localeCompare(right.label)),
      chats: visibleGroups.find((group) => group.kind === 'chats') ?? null,
    };
  }, [chatViewState.pinnedConversationIds, chatViewState.shownProjects, displayedConversations, isConversationPinned, liveByProviderSession, liveSessions, registeredProjects, selectedProjectIds, sort]);

  useEffect(() => {
    const effectivePinnedIds = displayedConversations
      .flatMap((group) => group.conversations)
      .filter(isConversationPinned)
      .map((conversation) => conversation.id);
    setChatViewState((current) => {
      const reconciled = reconcileOrderedPinIds(current.pinnedConversationIds, effectivePinnedIds);
      return reconciled.length === current.pinnedConversationIds.length
        && reconciled.every((id, index) => id === current.pinnedConversationIds[index])
        ? current
        : { ...current, pinnedConversationIds: reconciled };
    });
  }, [displayedConversations, isConversationPinned, setChatViewState]);

  const firstChatEntry =
    chatSections.pinned?.entries[0] ??
    chatSections.projects[0]?.entries[0] ??
    chatSections.chats?.entries[0] ??
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
    // Pinning can change group membership and manual order, so reconcile from
    // the grouped endpoint while keeping selection, folds, and quotas intact.
    setServerGroups((current) => current.map((group) => ({
      ...group,
      conversations: group.conversations.map((conv) => (conv.id === updated.id ? { ...conv, ...updated } : conv)),
    })));
    void fetchConversationGroups();
  };

  const showMore = useCallback((group: ChatProjectGroup) => {
    const currentTarget = targetsRef.current.get(group.key) ?? sidebarGroupLimit;
    const nextTarget = currentTarget + sidebarGroupLimit;
    const nextTargets = new Map(targetsRef.current).set(group.key, nextTarget);
    targetsRef.current = nextTargets;
    setVisibleTargets(nextTargets);
    if (group.entries.length >= nextTarget || !group.nextCursor) return;

    setLoadingMoreKeys((current) => new Set(current).add(group.key));
    void getConversationSidebar({
      ...sidebarRequestParams(sidebarGroupLimit),
      group_key: group.key,
      cursor: group.nextCursor,
    })
      .then((page) => {
        const fetched = page.groups[0];
        if (!fetched) return;
        setServerGroups((current) => current.map((candidate) => {
          if (candidate.key !== group.key) return candidate;
          const seen = new Set(candidate.conversations.map((conversation) => conversation.id));
          return {
            ...fetched,
            conversations: [
              ...candidate.conversations,
              ...fetched.conversations.filter((conversation) => !seen.has(conversation.id)),
            ],
          };
        }));
      })
      .catch(() => {
        const rolledBackTargets = new Map(targetsRef.current).set(group.key, currentTarget);
        targetsRef.current = rolledBackTargets;
        setVisibleTargets(rolledBackTargets);
      })
      .finally(() => setLoadingMoreKeys((current) => {
        const next = new Set(current);
        next.delete(group.key);
        return next;
      }));
  }, [sidebarGroupLimit, sidebarRequestParams]);

  const handleToggleEntryPin = async (entry: ChatEntry) => {
    if (!entry.conversation) return;
    const conversationId = entry.conversation.id;
    const starred = !isConversationPinned(entry.conversation);
    if (previewMutationsRejected) {
      pendingPinFocusKey.current = entry.key;
      setChatViewState((current) => ({
        ...current,
        pinnedConversationIds: starred
          ? reconcileOrderedPinIds(current.pinnedConversationIds, [conversationId])
          : current.pinnedConversationIds.filter((id) => id !== conversationId),
        previewPinOverrides: {
          ...current.previewPinOverrides,
          [conversationId]: starred,
        },
      }));
      return;
    }
    try {
      const updated = await updateConversation(conversationId, { starred });
      pendingPinFocusKey.current = entry.key;
      updateConversationInList(updated);
      setChatViewState((current) => ({
        ...current,
        pinnedConversationIds: starred
          ? reconcileOrderedPinIds(current.pinnedConversationIds, [conversationId])
          : current.pinnedConversationIds.filter((id) => id !== conversationId),
      }));
    } catch {
      // keep the current list state if persistence fails
    }
  };

  const handleEditEntryTags = async (entry: ChatEntry, tags: string[]) => {
    try {
      if (entry.conversation) {
        const updated = await updateConversation(entry.conversation.id, { tags });
        updateConversationInList(updated);
      }
    } catch {
      // keep the current list state if persistence fails
    }
  };

  const handleRenameSession = async (entry: ChatEntry, label: string | null) => {
    try {
      if (entry.session && label) {
        await updateConsoleSession(entry.session.id, { label });
      }
    } catch {
      // keep the current list state if persistence fails
    }
  };

  const handleNewSession = async (input: {
    label: string;
    backend: string;
    kind: string;
    backend_type: 'pty' | 'sdk' | 'spawn' | 'acp';
    transport_lane: 'sdk' | 'pty' | 'channel' | 'acp' | 'spawn';
    channel_enabled?: boolean;
    runOptions?: Record<string, import('../api.js').SessionRunOptionValue>;
    cwd?: string;
  }) => {
    await onNewSession(input);
    setDialogOpen(false);
    setNewSessionCwd(undefined);
  };

  const openNewSession = (cwd?: string) => {
    setNewSessionCwd(cwd);
    setDialogOpen(true);
  };

  const openProjectChooser = () => {
    setProjectChooserSelection((current) => (
      registeredProjects.some((project) => registeredProjectSelectionValue(project) === current)
        ? current
        : registeredProjects[0] ? registeredProjectSelectionValue(registeredProjects[0]) : ''
    ));
    setProjectChooserOpen(true);
    setCollapsedSections((current) => {
      if (!current.has('projects')) return current;
      const next = new Set(current);
      next.delete('projects');
      return next;
    });
  };

  const addShownProject = () => {
    const project = registeredProjects.find((candidate) => (
      registeredProjectSelectionValue(candidate) === projectChooserSelection
    ));
    if (!project) return;
    const isNewProject = !selectedProjectIds.includes(project.id);
    setChatViewState((current) => {
      const nextSelection = { projectId: project.id, checkoutId: project.checkoutId };
      const existingIndex = current.shownProjects.findIndex((shown) => shown.projectId === project.id);
      if (existingIndex < 0) {
        return { ...current, shownProjects: [...current.shownProjects, nextSelection] };
      }
      if (current.shownProjects[existingIndex].checkoutId === project.checkoutId) return current;
      return {
        ...current,
        shownProjects: current.shownProjects.map((shown, index) => index === existingIndex ? nextSelection : shown),
      };
    });
    setProjectChooserOpen(false);
    if (isNewProject) {
      void fetchConversationGroups([...selectedProjectIds, project.id]);
    }
  };

  const renderEntry = (entry: ChatEntry) => (
    <ChatEntryItem
      key={entry.key}
      entry={entry}
      isSelected={entry.kind === 'conversation'
        ? selectedConversationId === entry.conversation?.id
        : selectedSessionId === entry.session?.id}
      pinned={entry.conversation ? isConversationPinned(entry.conversation) : undefined}
      onTogglePin={entry.conversation ? () => { void handleToggleEntryPin(entry); } : undefined}
      pinActionRef={entry.conversation ? (element) => {
        if (element) pinActionRefs.current.set(entry.key, element);
        else pinActionRefs.current.delete(entry.key);
      } : undefined}
      onEditTags={entry.conversation ? (tags) => { void handleEditEntryTags(entry, tags); } : undefined}
      onRenameSession={!entry.conversation && entry.session
        ? (label) => { void handleRenameSession(entry, label); }
        : undefined}
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
    (chatSections.pinned?.entries.length ?? 0) +
    chatSections.projects.reduce((sum, group) => sum + group.entries.length, 0) +
    (chatSections.chats?.entries.length ?? 0);

  return (
    <div className="chat-history-view">
      <ViewSidebar
        {...VIEW_SIDEBAR_GEOMETRY.console}
        className="chat-history-sidebar"
        ariaLabel="Conversations"
        hidden={sidebarHidden}
        header={
          <SidebarSearchFilterHeader
            value={search}
            onValueChange={setSearch}
            placeholder="Search chats"
            searchAriaLabel="Search chats"
            clearAriaLabel="Clear chat search"
            inputType="text"
            filterTrigger={{
              ariaLabel: 'Search and filter options',
              title: 'Search and filter options',
              open: filterPanelOpen,
              active: activeFilterCount > 0,
              count: activeFilterCount,
              onToggle: () => setFilterPanelOpen((prev) => !prev),
            }}
            summarySlot={activeFilterCount > 0 ? (
              <>
                {sourceFilter !== 'all' && <span>{SOURCE_LABELS[sourceFilter]}</span>}
                {starredOnly && <span>Starred</span>}
                {!hideEmpty && <span>Empty shown</span>}
                {sort !== 'date' && <span>By blocks</span>}
                {searchMode === 'full' && <span>Full text</span>}
              </>
            ) : undefined}
            panel={filterPanelOpen ? {
              variant: 'popover',
              children: (
                <>
                <div className="sidebar-search-filter__section">
                  <div className="sidebar-search-filter__label">Agent</div>
                  <div className="sidebar-search-filter__options">
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
                <div className="sidebar-search-filter__section">
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
                <div className="sidebar-search-filter__section">
                  <div className="sidebar-search-filter__label">Search</div>
                  <div className="sidebar-search-filter__options">
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
                </>
              ),
            } : undefined}
          />
        }
        bodyClassName="chat-history-list"
      >

            <div className="chat-sidebar-global-actions" role="region" aria-label="Chat actions">
              <SidebarLeadingActionRow
                label="New chat"
                icon={<SidebarNewChatIcon size={16} />}
                onPress={() => openNewSession()}
              />
            </div>

            {chatSections.pinned ? (() => {
              const group = chatSections.pinned;
              const target = visibleTargets.get(group.key) ?? sidebarGroupLimit;
              return (
                <SidebarGroupNode
                  id="chat-pinned"
                  presentation="category"
                  label={group.label}
                  headingDescription={`${group.total} pinned chat${group.total === 1 ? '' : 's'}`}
                  expanded={!collapsedSections.has('pinned')}
                  onToggle={() => toggleSection('pinned')}
                  canShowMore={group.entries.length > target || group.nextCursor !== null}
                  loadingMore={loadingMoreKeys.has(group.key)}
                  onShowMore={() => { void showMore(group); }}
                >
                  {group.entries.slice(0, target).map((entry) => renderEntry(entry))}
                </SidebarGroupNode>
              );
            })() : null}

            {chatSections.projects.length > 0 || registeredProjects.length > 0 ? (
              <SidebarGroupNode
                id="chat-projects"
                presentation="category"
                label="Projects"
                expanded={!collapsedSections.has('projects')}
                onToggle={() => toggleSection('projects')}
                action={{ label: 'Add project', icon: <SidebarAddProjectIcon />, onPress: openProjectChooser }}
              >
              {projectChooserOpen ? (
                <div className="chat-project-chooser" role="group" aria-label="Choose a shown project">
                  <select aria-label="Registered project" value={projectChooserSelection} onInput={(event) => setProjectChooserSelection(event.currentTarget.value)}>
                    {registeredProjects.map((project) => {
                      const hasMultipleCheckouts = registeredProjects.some((candidate) => (
                        candidate.id === project.id && candidate.checkoutId !== project.checkoutId
                      ));
                      return (
                        <option key={`${project.id}:${project.checkoutId}`} value={registeredProjectSelectionValue(project)}>
                          {hasMultipleCheckouts ? `${project.label} — ${project.checkoutLabel} (${project.root})` : project.label}
                        </option>
                      );
                    })}
                  </select>
                  <button type="button" onClick={addShownProject} disabled={!projectChooserSelection}>Add</button>
                  <button type="button" onClick={() => setProjectChooserOpen(false)}>Cancel</button>
                </div>
              ) : null}
              {chatSections.projects.length === 0 && registeredProjects.length > 0 ? (
                <div className="chat-projects-empty" role="status">
                  <span>No projects shown · {availableProjectCount} available</span>
                  <button type="button" onClick={openProjectChooser}>Add Project</button>
                </div>
              ) : null}
              {chatSections.projects.map((group, index) => {
                const collapsed = collapsedProjects.has(group.key);
                const target = visibleTargets.get(group.key) ?? sidebarGroupLimit;
                return (
                  <SidebarGroupNode
                    key={group.key}
                    id={`chat-project-${index}`}
                    presentation="folder"
                    bodyClassName="chat-project-group__items"
                    label={group.label}
                    count={group.total}
                    countLabel={`${group.total} chat${group.total === 1 ? '' : 's'} in ${group.label}`}
                    countVisibility="interaction"
                    expanded={!collapsed}
                    onToggle={() => toggleProject(group.key)}
                    showDisclosure={false}
                    action={group.exactRoot
                      ? { label: `New chat in ${group.label}`, icon: <SidebarNewChatIcon />, onPress: () => openNewSession(group.exactRoot) }
                      : undefined}
                    leadingIcon={<FolderIcon open={!collapsed} />}
                    canShowMore={group.entries.length > target || group.nextCursor !== null}
                    loadingMore={loadingMoreKeys.has(group.key)}
                    onShowMore={() => { void showMore(group); }}
                  >
                    {group.entries.slice(0, target).map((entry) => renderEntry(entry))}
                  </SidebarGroupNode>
                );
              })}
              </SidebarGroupNode>
            ) : null}

            {chatSections.chats ? (() => {
              const group = chatSections.chats;
              const target = visibleTargets.get(group.key) ?? sidebarGroupLimit;
              return (
                <SidebarGroupNode
                  id="chat-chats"
                  presentation="category"
                  label={group.label}
                  headingDescription={`${group.total} chat${group.total === 1 ? '' : 's'}`}
                  expanded={!collapsedSections.has('chats')}
                  onToggle={() => toggleSection('chats')}
                  action={{ label: 'New chat', icon: <SidebarNewChatIcon />, onPress: () => openNewSession() }}
                  canShowMore={group.entries.length > target || group.nextCursor !== null}
                  loadingMore={loadingMoreKeys.has(group.key)}
                  onShowMore={() => { void showMore(group); }}
                >
                  {group.entries.slice(0, target).map((entry) => renderEntry(entry))}
                </SidebarGroupNode>
              );
            })() : null}

            {totalVisibleEntries === 0 && !loading && (
              <div className="chat-history-empty">No conversations found.</div>
            )}
            {loading && (
              <div className="chat-history-empty">Loading…</div>
            )}
      </ViewSidebar>

      {/* Detail pane */}
      <div ref={detailPortalRef} className="chat-history-detail">
        {selection?.type === 'conversation' ? (
          <ConversationDetail
            conversationId={selection.id}
            initialConversation={selectedConversationSummary}
            anchor={conversationAnchorFromHash(window.location.hash)}
            onNavigate={(id) => setSelection({ type: 'conversation', id })}
            consoleSessions={consoleSessions}
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
        cwd={newSessionCwd}
        portalTarget={detailPortalRef.current}
        onClose={() => { setDialogOpen(false); setNewSessionCwd(undefined); }}
        onSubmit={handleNewSession}
      />
    </div>
  );
}
