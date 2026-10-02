import type { ComponentChildren, Ref } from 'preact';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { CancelledError, isCancelledError, useQuery, useQueryClient } from '@tanstack/preact-query';
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
} from '../components/shared/SidebarItemRow';
import type { OfficialProviderMarkKind } from '../components/shared/OfficialProviderMark';
import {
  orderByPinnedIds,
  reconcileOrderedPinIds,
} from '../components/shared/orderedPins';
import type { ConsoleSession } from '../state';
import type {
  Conversation,
  ConversationBlock,
  ConversationChild,
  InstanceInfo,
  ConversationPositionWindow,
  ConversationStructure,
  ConversationSource,
  ConversationSidebarGroup,
  ConversationSidebarConversation,
  CanonicalProject,
  WorkflowRun,
} from '../api.js';
import {
  forkConversation,
  getConsoleSessionUsage,
  getConsoleSessionOptions,
  getConsoleRunOptions,
  getConversationWindow,
  getConversationStructure,
  exportConversationBlocks,
  getConversationControl,
  getConversationLiveProjection,
  getChatShownProjectsPreference,
  getProviderChat,
  getConversationSidebar,
  getConversations,
  getSidebarOrderPreference,
  getSessionIssues,
  listWorkflows,
  listCanonicalProjects,
  ApiError,
  ConversationSpawnApiError,
  cancelProviderChat,
  isApiErrorStatus,
  openConversationExternally,
  retryProviderChat,
  submitConversationControl,
  updateConsoleSession,
  updateConsoleSessionOptions,
  updateConversation,
  updateConversationArchive,
  type SessionRunOptionsSnapshot,
  type ConversationRuntimeOptions,
  type ConversationControlApiError,
  type ConversationControlSnapshot,
  type ConversationSpawnReceipt,
  type ProviderAdapterEvent,
  type ProviderLiveProjection,
} from '../api.js';
import { DetailPaneHeader } from '../components/shared/DetailPaneHeader';
import { DetailPaneMenuTrigger } from '../components/shared/DetailPaneMenuTrigger';
import { DetailPaneNotice } from '../components/shared/DetailPaneNotice';
import { DetailPaneModal } from '../components/shared/DetailPaneModal';
import { OverflowFade } from '../components/shared/OverflowFade';
import { type ChatAttachment } from '../../../src/conversation-control/attachments';
import { attachmentContentUrl } from '../chat/attachmentApi';
import { importAttachmentBatch } from '../chat/attachmentImport';
import {
  activateDraftAttachmentHighlights, clearAcceptedDraft, getAttachmentDraftSnapshot,
  getDraftAttachmentHighlights,
  getPendingSubmitIntent, registerWritableChatTarget, removeDraftAttachment,
  savePendingSubmitIntent, setDraftText, subscribeAttachmentDrafts,
  subscribeDraftAttachmentHighlights, type DraftSubmitIntent,
} from '../chat/attachmentDrafts';
import { browserSessionFetch } from '../client-auth-token';
import { DetailPaneShell } from '../components/shared/DetailPaneShell';
import { TerminalPane } from '../components/console/TerminalPane';
import { SessionControls } from '../components/console/SessionControls';
import { EntityPill } from '../components/shared/EntityPill';
import {
  ChatOverlay,
  ChatFailureNotice,
  NewChatProviderPicker,
  ChatActivity,
  ChatPreview,
  ChatSessionOverview,
  ChatEntityLinkBoundary,
  ChatSurface,
  ContextUsageRing,
  UsageModal,
  conversationBlocksToStreamEvents,
  reconcileProviderProjection,
  deriveChatUsageSummary,
  useStatuslineTelemetry,
  chatControlFailureNotice,
  chatSpawnFailureNotice,
  reduceNewChatDraft,
  type ChatPreviewTarget,
  type ChatActivityItem,
  type ChatFailureNoticeModel,
  type NewChatDraft,
  type NewChatProvider,
} from '../chat';
import { formatAbsoluteTime, truncate } from '../lib/format';
import { acquireSharedSse } from '../sse-shared';
import { PreviewIcon } from '../components/icons/TabIcons';
import { VerticalArrowIcon } from '../components/icons/VerticalArrowIcon';
import {
  preferredProjectCheckout,
  reconcileShownProjects,
  DEFAULT_CHAT_VIEW_STATE,
  CHAT_VIEW_STATE_KEY,
  normalizeChatViewState,
  useChatProjectSelection,
  useChatViewState,
} from './conversation-view-state';
import { readPersistedViewState } from '../hooks/usePersistedViewState';
import { compareConversationSidebarRows } from '../../../src/conversations/sidebar-order';
import { useAnchoredMenu } from '../hooks/useAnchoredMenu';
import { useIntrinsicOverflowGroup } from '../hooks/useIntrinsicOverflowGroup';
import { openMarkdownDocument } from '../chat/markdownActions';
import { conversationControlPresentation } from '../chat/conversationControl';
import { chatItemIdentityKey, mergeProviderLiveProjection } from '../../../src/conversation-control/provider-live';
import type { ChatItem } from '../../../src/parsers/types';
import {
  CHAT_DETAIL_PREVIEW_MIN_WIDTH,
  useAppShell,
  useRegisterInitialRouteLoad,
  useRegisterAppRightSidebar,
} from '../app-shell';
import { useAppRightSidebarState } from '../right-sidebar-state';
import type { ChatEntityClickAction } from '../../../src/contracts';
import { subscribeClientAccessState } from '../client-auth-token';
import { getAgentPageBinding, hashWithAgentSession } from '../agent-page-binding';
import {
  flattenConversationTranscript,
  reconcileConversationWindow,
  mergeSidebarPages,
  type ConversationHistoryLoadResult,
  type ConversationTranscriptConsumer,
  type ConversationTranscriptData,
  type ConversationWithDetails,
} from '../query/conversationData';
import {
  conversationKeys,
  normalizeWindowTarget,
  windowRequest,
  type ConversationSidebarFilters,
} from '../query/conversationKeys';
import { queryClient as appQueryClient } from '../query/client';
import { useSidebarOrderPreference } from '../hooks/useSidebarOrderPreference';
import { useSidebarReorder } from '../hooks/useSidebarReorder';
import type { SidebarReorderBinding } from '../components/shared/sidebar-order';

// ── Toast notification ──

type ToastState = { message: string; type: 'info' | 'error' } | null;

type ChatDetailState = 'loading' | 'error' | 'not-found' | 'conversation' | 'live-session' | 'draft' | 'no-selection';

export type ConversationLoadFailure = {
  operation: 'initial' | 'edge-older' | 'edge-newer' | 'target' | 'source-unavailable' | 'refresh' | 'export';
  retryOperation?: 'initial' | 'edge-older' | 'edge-newer' | 'target' | 'refresh' | 'export';
  code: string | null;
  message: string;
  retryable: boolean;
};

type ConversationHistoryRetry =
  | { kind: 'edge'; direction: 'older' | 'newer' }
  | { kind: 'around'; position: number };

const TRANSIENT_CONVERSATION_CODES = new Set(['provider_metadata_unavailable', 'freshness_pending', 'freshness_error', 'source_unavailable']);

function optimisticPromptItem(
  intent: { id: string; message: string },
  provider: ConversationSource,
  sessionId: string,
): ChatItem {
  return {
    type: 'message',
    role: 'user',
    identity: {
      provider,
      session_id: sessionId,
      native_item_id: intent.id,
      source_record_ordinal: 0,
      source_sub_block_ordinal: 0,
    },
    provenance: { source: 'live-provider-event', provider, source_event_type: 'optimistic-user-prompt' },
    parts: [{ type: 'text', text: intent.message }],
    content_completion: 'complete',
  };
}

export function conversationLoadFailure(
  error: unknown,
  transcriptLoaded: boolean,
  operation: ConversationLoadFailure['operation'] = 'refresh',
): ConversationLoadFailure | null {
  if (isCancelledError(error) || (error !== null && typeof error === 'object'
    && 'name' in error && error.name === 'AbortError')) return null;
  const apiError = error instanceof ApiError ? error : null;
  const code = apiError?.code ?? null;
  const resolvedOperation = code === 'source_unavailable' ? 'source-unavailable' : operation;
  const retryOperation: ConversationLoadFailure['retryOperation'] = resolvedOperation === 'source-unavailable'
      && operation !== 'source-unavailable'
    ? operation
    : undefined;
  if (code === 'provider_metadata_missing') {
    return {
      operation: resolvedOperation,
      ...(retryOperation ? { retryOperation } : {}),
      code,
      message: `${transcriptLoaded ? 'Transcript loaded, but ' : ''}Mandible cannot verify its current Codex title because the matching Codex task metadata is missing. Retrying will not recreate that metadata.`,
      retryable: false,
    };
  }
  if (code === 'provider_metadata_unavailable') {
    return {
      operation: resolvedOperation,
      ...(retryOperation ? { retryOperation } : {}),
      code,
      message: `Codex title metadata is temporarily unavailable.${transcriptLoaded ? ' The transcript is unchanged;' : ''} try again.`,
      retryable: true,
    };
  }
  return {
    operation: resolvedOperation,
    ...(retryOperation ? { retryOperation } : {}),
    code,
    message: error instanceof Error ? error.message : String(error),
    retryable: code ? TRANSIENT_CONVERSATION_CODES.has(code) : apiError ? apiError.status >= 500 : true,
  };
}

export type ConversationRightSidebarViewState = {
  conversationId: string;
  previewTarget: ChatPreviewTarget | null;
  tab: 'overview' | 'preview' | 'activity';
};

function OverviewTabIcon(): JSX.Element {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 5h16v14H4z" /><path d="M8 9h8M8 13h5" /></svg>;
}

function PreviewTabIcon(): JSX.Element {
  return <PreviewIcon size={18} />;
}

function ActivityTabIcon(): JSX.Element {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M4 12h3l2-5 4 10 2-5h5" /></svg>;
}

export function scopeConversationRightSidebar(
  conversationId: string,
  state: ConversationRightSidebarViewState,
): ConversationRightSidebarViewState {
  return state.conversationId === conversationId
    ? state
    : { conversationId, previewTarget: null, tab: 'overview' };
}

type ChatDetailFrameProps = {
  state: ChatDetailState;
  className?: string;
  bodyClassName?: string;
  header: ComponentChildren;
  headerRef?: Ref<HTMLElement>;
  subheader?: ComponentChildren;
  notice?: ComponentChildren;
  overlayControl?: ComponentChildren;
  overlays?: ComponentChildren;
  ariaBusy?: boolean;
  onDragOverCapture?: (event: JSX.TargetedDragEvent<HTMLElement>) => void;
  onDropCapture?: (event: JSX.TargetedDragEvent<HTMLElement>) => void;
  children: ComponentChildren;
};

export function ChatDetailFrame({
  state,
  className,
  bodyClassName = 'conv-detail__body',
  header,
  headerRef,
  subheader,
  notice,
  overlayControl,
  overlays,
  ariaBusy,
  onDragOverCapture,
  onDropCapture,
  children,
}: ChatDetailFrameProps): JSX.Element {
  return (
    <DetailPaneShell
      as="section"
      variant="compact"
      className={`conv-detail chat-detail-frame chat-detail-frame--${state}${className ? ` ${className}` : ''}`}
      headerClassName="conv-detail__shell-header"
      headerRef={headerRef}
      subheaderClassName="conv-detail__parent"
      bodyClassName={bodyClassName}
      header={header}
      subheader={subheader}
      notice={notice}
      overlayControl={overlayControl}
      overlays={overlays}
      ariaBusy={ariaBusy}
      onDragOverCapture={onDragOverCapture}
      onDropCapture={onDropCapture}
    >
      {children}
    </DetailPaneShell>
  );
}

function Toast({ toast, onDismiss }: { toast: ToastState; onDismiss: () => void }): JSX.Element | null {
  if (!toast || toast.type === 'error') return null;
  return (
    <div className={`conv-toast conv-toast--${toast.type}`} onClick={onDismiss}>
      {toast.message}
    </div>
  );
}

// ── Constants ──

const SOURCE_LABELS: Record<ConversationSource, string> = {
  claude_code: 'Claude',
  codex: 'Codex',
  gemini: 'Gemini',
};

const SIDEBAR_PROVIDER_LABELS: Record<ConversationSource, string> = {
  claude_code: 'Claude',
  codex: 'Codex',
  gemini: 'agy',
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

type ConversationSidebarRequestState = {
  limit: number;
  projectIds: string[];
  lifecycle: 'active' | 'archived';
  pinnedConversationIds: string[] | null;
  previewPinOverrides: Record<string, boolean>;
  previewMutationsRejected: boolean;
  sourceFilter: ConversationSource | 'all';
  starredOnly: boolean;
  hideEmpty: boolean;
  search: string;
  searchMode: 'title' | 'full';
  sort: 'date' | 'blocks';
};

function buildConversationSidebarFilters(state: ConversationSidebarRequestState): ConversationSidebarFilters {
  const params: Parameters<typeof getConversationSidebar>[0] = {
    limit: state.limit,
    sort: state.sort === 'blocks' ? 'block_count' : 'started_at',
    exclude_subagents: true,
    project_ids: state.projectIds,
    lifecycle: state.lifecycle,
  };
  if (state.pinnedConversationIds !== null) {
    params.pinned_ids = state.pinnedConversationIds;
  } else if (state.previewMutationsRejected) {
    params.pinned_ids = Object.entries(state.previewPinOverrides)
      .flatMap(([id, pinned]) => pinned ? [id] : []);
  }
  if (state.sourceFilter !== 'all') params.source = state.sourceFilter;
  if (state.starredOnly) params.starred = true;
  if (state.hideEmpty) params.min_blocks = 1;
  applyConversationSearchParams(params, state.search, state.searchMode);
  return params;
}

type ConversationWarmupContext = {
  settings?: Record<string, string>;
  instanceInfo?: InstanceInfo | null;
  sidebarGroupLimit?: number;
};

const WARMED_CHAT_QUERY_STALE_TIME_MS = 1_000;

async function warmSelectedConversationWindow(
  params: Record<string, string>,
  lastSelection: { type: 'conversation' | 'session'; id: string } | null,
): Promise<void> {
  let conversationId = params.conversation?.trim()
    || (lastSelection?.type === 'conversation' ? lastSelection.id : '');
  if (!conversationId) {
    const sessionId = params.session?.trim()
      || (lastSelection?.type === 'session' ? lastSelection.id : '');
    if (!sessionId) return;
    const resolved = await appQueryClient.fetchQuery({
      queryKey: conversationKeys.bySession(sessionId),
      queryFn: ({ signal }) => getConversations({ session_id: sessionId, limit: 1, signal }),
      staleTime: 0,
    });
    conversationId = resolved.conversations[0]?.id ?? '';
  }
  if (!conversationId) return;

  const target = normalizeWindowTarget({ target: 'initial', limit: 500, view: 'display' });
  const aggregateKey = conversationKeys.aggregate(conversationId);
  const aggregateAtStart = appQueryClient.getQueryData<ConversationTranscriptData>(aggregateKey);
  const [window, structure] = await Promise.all([
    appQueryClient.fetchQuery({
      queryKey: conversationKeys.window(conversationId, target),
      queryFn: ({ signal }) => readConversationWindowWhenReady(
        conversationId, windowRequest(target, signal)),
      staleTime: WARMED_CHAT_QUERY_STALE_TIME_MS,
    }),
    readConversationStructureWhenReady(conversationId),
  ]);
  if (window.source_version_id !== structure.source_version_id || window.total !== structure.total) return;
  const current = appQueryClient.getQueryData<ConversationTranscriptData>(aggregateKey);
  const aggregateAdvanced = current !== undefined
    && (aggregateAtStart === undefined || current.source_version_id !== aggregateAtStart.source_version_id);
  if (aggregateAdvanced && current.source_version_id !== window.source_version_id) return;
  appQueryClient.setQueryData(aggregateKey, {
    ...reconcileConversationWindow(current, window), structure,
  });
}

export async function warmInitialData(
  params: Record<string, string>,
  context: ConversationWarmupContext = {},
): Promise<void> {
  const [projectSnapshot, shownPreference, sidebarOrder] = await Promise.all([
    listCanonicalProjects()
      .then((projects) => ({ projects, loaded: true }))
      .catch(() => ({ projects: [] as CanonicalProject[], loaded: false })),
    getChatShownProjectsPreference(),
    getSidebarOrderPreference().catch(() => null),
  ]);
  const { projects, loaded: projectsLoaded } = projectSnapshot;
  const storedViewState = readPersistedViewState(
    CHAT_VIEW_STATE_KEY,
    normalizeChatViewState,
    { ...DEFAULT_CHAT_VIEW_STATE, shownProjects: [] },
  );
  const shownProjects = shownPreference.revision === 0 && storedViewState.shownProjects.length > 0
    ? storedViewState.shownProjects
    : shownPreference.value;
  const reconciledShownProjects = projectsLoaded
    ? reconcileShownProjects(shownProjects, projects)
    : shownProjects;
  const registeredSelections = new Set(projects.flatMap((project) => {
    const checkout = preferredProjectCheckout(project);
    return checkout ? [`${project.id}\0${checkout.id}`] : [];
  }));
  const projectIds = [...new Set(projectsLoaded
    ? reconciledShownProjects
      .filter((shown) => registeredSelections.has(`${shown.projectId}\0${shown.checkoutId}`))
      .map((shown) => shown.projectId)
    : reconciledShownProjects.map((shown) => shown.projectId))];
  const previewMutationsRejected = Boolean(
    context.instanceInfo
    && context.instanceInfo.allowed_effects?.includes('ledger:write') !== true,
  );
  const filters = buildConversationSidebarFilters({
    limit: context.sidebarGroupLimit ?? normalizeSidebarGroupLimit(undefined),
    projectIds,
    lifecycle: storedViewState.conversationLifecycle,
    pinnedConversationIds: sidebarOrder?.value.pinnedConversationIds ?? null,
    previewPinOverrides: storedViewState.previewPinOverrides,
    previewMutationsRejected,
    sourceFilter: 'all',
    starredOnly: false,
    hideEmpty: true,
    search: '',
    searchMode: 'title',
    sort: 'date',
  });
  const warmResults = await Promise.allSettled([
    appQueryClient.fetchQuery({
      queryKey: conversationKeys.sidebarInitial(filters),
      queryFn: ({ signal }) => getConversationSidebar({ ...filters, signal }),
      staleTime: WARMED_CHAT_QUERY_STALE_TIME_MS,
    }),
    warmSelectedConversationWindow(params, storedViewState.lastSelection),
  ]);
  const failedWarm = warmResults.find((result) => result.status === 'rejected');
  if (failedWarm?.status === 'rejected') throw failedWarm.reason;
}

function isLiveConsoleSession(session: ConsoleSession): boolean {
  return session.status !== 'stopped' && session.status !== 'crashed';
}

function sourceFromSession(session: ConsoleSession): ConversationSource | null {
  const agent = session.agent_type.toLowerCase();
  const command = (session.command ?? '').toLowerCase();
  if (agent.includes('claude') || command.includes('claude')) return 'claude_code';
  if (agent.includes('codex') || command.includes('codex')) return 'codex';
  if (agent.includes('gemini') || command.includes('gemini') || agent.includes('agy') || command.includes('agy')) return 'gemini';
  return null;
}

const CHAT_PROVIDER_MARKS: Record<ConversationSource, OfficialProviderMarkKind | null> = {
  claude_code: 'anthropic',
  codex: 'openai',
  gemini: null,
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
  return projects.flatMap((project) => {
    const checkout = preferredProjectCheckout(project);
    return checkout ? [{
      id: project.id,
      key: project.project_key,
      label: project.display_name?.trim() || project.project_key,
      checkoutId: checkout.id,
      checkoutLabel: checkout.name?.trim() || checkout.work_repo_id?.trim() || checkout.root.trim(),
      root: checkout.root.trim(),
    }] : [];
  })
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
  | { type: 'draft'; id: string }
  | null;
type ChatEntry = {
  key: string;
  time: number;
  kind: 'conversation' | 'session';
  conversation?: ConversationSidebarConversation;
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
function conversationShell(conversation: Conversation): ConversationWithDetails {
  return {
    ...conversation,
    blocks: [],
    children: [],
    parent: null,
    position_window: {
      revision: conversation.block_count,
      source_version_id: null,
      total: conversation.block_count,
      loaded_intervals: [],
      has_before: false,
      has_after: conversation.block_count > 0,
      after_count: conversation.block_count,
    },
  };
}

function conversationFromSpawn(
  spawn: ConversationSpawnReceipt,
  placement: NewChatDraft['placement'],
): ConversationSidebarConversation {
  const source = spawn.request.provider;
  return {
    id: spawn.reservation_id,
    source,
    source_path: `mandible://chat/${spawn.reservation_id}`,
    title: source === 'codex' ? 'New Codex chat' : 'New Claude chat',
    summary: null,
    started_at: new Date(spawn.created_at).toISOString(),
    ended_at: spawn.state === 'failed' || spawn.state === 'cancelled'
      ? new Date(spawn.updated_at).toISOString()
      : null,
    block_count: 0,
    session_id: spawn.provider_session_id ?? spawn.reservation_id,
    project_path: null,
    cwd: null,
    branch: null,
    model: source === 'codex' ? 'gpt-5.6-sol' : 'claude-opus-5',
    cli_version: null,
    is_sidechain: false,
    agent_id: null,
    starred: false,
    tags: [],
    notes: null,
    parent_conversation_id: null,
    children_count: 0,
    canonical_project_id: placement.kind === 'project' ? placement.projectId : null,
    canonical_project_key: null,
    spawn,
  };
}

function optimisticConversationSpawn(
  draft: Extract<NewChatDraft, { state: 'starting' }>,
): ConversationSpawnReceipt {
  return {
    schema: 'mandible-conversation-spawn-receipt@3',
    reservation_id: draft.id,
    request: {
      schema: 'mandible-conversation-spawn-request@3',
      idempotency_key: draft.id,
      provider: draft.provider,
      placement: draft.placement.kind === 'project'
        ? {
            kind: 'project',
            project_id: draft.placement.projectId!,
            checkout_id: draft.placement.checkoutId!,
          }
        : { kind: 'projectless' },
    },
    state: 'starting',
    attempt_count: 1,
    native_session_id: null,
    provider_session_id: null,
    provider_receipt: null,
    error: null,
    created_at: 0,
    updated_at: 0,
  };
}

function eventData<T>(payload: unknown): T | null {
  if (!payload || typeof payload !== 'object') return null;
  const record = payload as Record<string, unknown>;
  const data = record.data;
  return (data && typeof data === 'object' ? data : record) as T;
}

const CONVERSATION_WINDOW_PENDING_LIMIT_MS = 120_000;
const CONVERSATION_WINDOW_MISSED_EVENT_CHECK_MS = 1_000;

function waitForConversationSourceUpdate(id: string, signal: AbortSignal | undefined, remainingMs: number): Promise<void> {
  const client = acquireSharedSse();
  return new Promise<void>((resolve, reject) => {
    let off = () => {};
    let timer: number | null = null;
    const abort = () => finish(new DOMException('Conversation read cancelled', 'AbortError'));
    const finish = (error?: Error) => {
      if (timer !== null) window.clearTimeout(timer);
      off();
      signal?.removeEventListener('abort', abort);
      client.close();
      if (error) reject(error); else resolve();
    };
    if (signal?.aborted) {
      finish(new DOMException('Conversation read cancelled', 'AbortError'));
      return;
    }
    off = client.on('conversation:updated', (payload) => {
      if (eventData<{ id?: string }>(payload)?.id === id) finish();
    });
    signal?.addEventListener('abort', abort, { once: true });
    // A completion event can cross the initial 503 response before this
    // subscription is attached. The bounded timer checks that missed edge.
    timer = window.setTimeout(() => finish(), Math.min(CONVERSATION_WINDOW_MISSED_EVENT_CHECK_MS, remainingMs));
    client.connect();
  });
}

async function readConversationWindowWhenReady(
  id: string,
  request: ReturnType<typeof windowRequest>,
): Promise<ConversationPositionWindow> {
  const deadline = Date.now() + CONVERSATION_WINDOW_PENDING_LIMIT_MS;
  for (;;) {
    try {
      return await getConversationWindow(id, request);
    } catch (error) {
      if (!(error instanceof ApiError) || error.code !== 'freshness_pending') throw error;
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new ApiError('Chat content is temporarily unavailable. Retry to check again.', 503, 'freshness_pending');
      }
      await waitForConversationSourceUpdate(id, request.signal, remaining);
    }
  }
}

async function readConversationStructureWhenReady(id: string, signal?: AbortSignal): Promise<ConversationStructure> {
  const deadline = Date.now() + CONVERSATION_WINDOW_PENDING_LIMIT_MS;
  for (;;) {
    try {
      return await getConversationStructure(id, signal);
    } catch (error) {
      if (!(error instanceof ApiError) || error.code !== 'freshness_pending') throw error;
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw error;
      await waitForConversationSourceUpdate(id, signal, remaining);
    }
  }
}

function reconcileControlSnapshot(
  current: ConversationControlSnapshot | null,
  incoming: ConversationControlSnapshot,
  conversationId: string,
): ConversationControlSnapshot | null {
  if (incoming.conversation_id !== conversationId) return current;
  if (!current) return incoming;
  if (incoming.ownership.generation < current.ownership.generation) return current;
  if (incoming.ownership.generation === current.ownership.generation
      && incoming.capability.revision < current.capability.revision) return current;
  return incoming;
}

export type ConversationAnchor = { block: string } | { turn: string } | { position: number };

export function conversationAnchorFromHash(hash: string): ConversationAnchor | null {
  const query = hash.includes('?') ? hash.slice(hash.indexOf('?') + 1) : '';
  const params = new URLSearchParams(query);
  const block = params.get('block');
  const turn = params.get('turn');
  const position = params.get('position');
  if (block) return { block };
  if (turn) return { turn };
  if (position !== null && Number.isSafeInteger(Number(position)) && Number(position) >= 0) {
    return { position: Number(position) };
  }
  return null;
}

export function conversationAnchorHref(
  conversationId: string,
  anchor: ConversationAnchor,
): string {
  const params = new URLSearchParams({ conversation: conversationId });
  if ('block' in anchor) params.set('block', anchor.block);
  else if ('turn' in anchor) params.set('turn', anchor.turn);
  else params.set('position', String(anchor.position));
  return `#/console?${params.toString()}`;
}

export function conversationLatestHref(currentHash: string, conversationId: string): string {
  const query = currentHash.includes('?') ? currentHash.slice(currentHash.indexOf('?') + 1) : '';
  const params = new URLSearchParams(query);
  params.set('conversation', conversationId);
  params.delete('block');
  params.delete('turn');
  params.delete('position');
  return `#/console?${params.toString()}`;
}

// ── Props ──

export type NewChatInput = {
  idempotency_key: string;
  provider: NewChatProvider;
  placement: { kind: 'projectless' } | { kind: 'project'; project_id: string; checkout_id: string };
};

export type ConversationsViewProps = {
  consoleSessions: ConsoleSession[];
  initialConversationId: string | null;
  initialSessionId: string | null;
  sidebarHidden?: boolean;
  sidebarGroupLimit?: number;
  chatEntityLinkAction?: ChatEntityClickAction;
  instance?: InstanceInfo | null;
  onSelectSession: (sessionId: string) => void;
  onNewConversation: (input: NewChatInput, signal?: AbortSignal) => Promise<{
    conversation_id: string;
    spawn: ConversationSpawnReceipt;
  }>;
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

export function ChatComposerSubmitIcon(): JSX.Element {
  return <VerticalArrowIcon direction="up" strokeWidth={1} />;
}

// ── Detail View ──

async function resolveProviderSessionConversation(providerSessionId: string): Promise<Conversation | null> {
  const result = await getConversations({ session_id: providerSessionId, limit: 1 });
  return result.conversations.find((candidate) => candidate.session_id === providerSessionId) ?? null;
}

function formatActivityDuration(seconds: number | null): string | null {
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

function buildSubagentActivityItems(
  children: ConversationChild[],
  parentBlocks: ConversationBlock[],
  onNavigate: (id: string) => void,
): ChatActivityItem[] {
  const taskLabels = parentBlocks
    .filter((block) => block.type === 'tool_use')
    .map(taskLabelFromBlock)
    .filter((label): label is string => Boolean(label));

  return children.map((child, index) => {
    const duration = formatActivityDuration(child.duration_seconds);
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

function workflowActivityStatus(workflow: WorkflowRun): ChatActivityItem['status'] {
  if (workflow.warnings.length > 0 || workflow.status === 'warning') return 'error';
  if (workflow.status === 'failed') return 'error';
  if (workflow.status === 'completed') return 'finished';
  if (workflow.status === 'running') return 'active';
  return 'waiting';
}

function buildWorkflowActivityItems(
  workflows: WorkflowRun[],
  onOpen: (id: string) => void,
): ChatActivityItem[] {
  return workflows.map((workflow) => {
    const progress = `${workflow.completed_workers}/${workflow.total_workers}`;
    const tokens = formatCompactNumber(workflow.total_tokens);
    return {
      id: workflow.id,
      icon: '◇',
      label: truncate(workflow.workflow_name || workflow.provider_run_id, 80),
      status: workflowActivityStatus(workflow),
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
                  {worker.duration_ms != null && <span>{formatActivityDuration(Math.round(worker.duration_ms / 1000))}</span>}
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

export function ConversationDetail({
  conversationId,
  initialConversation,
  anchor,
  onNavigate,
  consoleSessions,
  sidebarCollapsed,
  chatEntityLinkAction,
  creationReceipt,
  onRetryCreation,
  onUnavailable,
  externalNotice,
}: {
  conversationId: string;
  initialConversation?: Conversation | null;
  anchor: ConversationAnchor | null;
  onNavigate: (id: string) => void;
  consoleSessions: ConsoleSession[];
  sidebarCollapsed: boolean;
  chatEntityLinkAction: ChatEntityClickAction;
  creationReceipt?: ConversationSpawnReceipt | null;
  onRetryCreation?: () => void;
  onUnavailable?: (conversationId: string) => void;
  externalNotice?: ComponentChildren;
}): JSX.Element {
  const queryClient = useQueryClient(appQueryClient);
  // The sidebar descriptor is published back through the app shell. Keep its
  // activity navigation dependency stable even when an embedding parent uses
  // an inline callback, or that publication becomes a render feedback loop.
  const onNavigateRef = useRef(onNavigate);
  onNavigateRef.current = onNavigate;
  const selectionRef = useRef({ conversationId, generation: 0 });
  if (selectionRef.current.conversationId !== conversationId) {
    selectionRef.current = { conversationId, generation: selectionRef.current.generation + 1 };
  }
  const selectionGeneration = selectionRef.current.generation;
  const navigateFromActivity = useCallback((id: string) => onNavigateRef.current(id), []);
  const [jumpingToLatest, setJumpingToLatest] = useState(false);
  const [edgeLoading, setEdgeLoading] = useState<'older' | 'newer' | null>(null);
  const historyRetryRef = useRef<ConversationHistoryRetry | null>(null);
  const [exportLoading, setExportLoading] = useState(false);
  const [exportIntent, setExportIntent] = useState<'copy' | 'open' | null>(null);
  const [navigationError, setNavigationError] = useState<ConversationLoadFailure | null>(null);
  const [navigationTarget, setNavigationTarget] = useState<{
    key: string;
    kind: 'initial' | 'latest' | 'block' | 'turn' | 'position';
    turnId: string | null;
    blockId: string | null;
    smooth: boolean;
  } | null>(null);

  const [actionsOpen, setActionsOpen] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const [activeWorkflowId, setActiveWorkflowId] = useState<string | null>(null);
  const [workflows, setWorkflows] = useState<WorkflowRun[]>([]);
  const [workflowNonce, setWorkflowNonce] = useState(0);
  const [composerControlsOpen, setComposerControlsOpen] = useState(false);
  const [composerModel, setComposerModel] = useState('');
  const [composerEffort, setComposerEffort] = useState('');
  const [composerPermission, setComposerPermission] = useState('');
  const [usageModalOpen, setUsageModalOpen] = useState(false);
  const [usageRows, setUsageRows] = useState<Array<Record<string, unknown>>>([]);
  const [control, setControl] = useState<ConversationControlSnapshot | null>(null);
  const [liveProjection, setLiveProjection] = useState<ProviderLiveProjection | null>(null);
  const pendingDurableReconciliationsRef = useRef<Array<Extract<ProviderAdapterEvent, { kind: 'durable-reconciliation' }>>>([]);
  const [rightSidebarViewState, setRightSidebarViewState] = useState<ConversationRightSidebarViewState>({
    conversationId,
    previewTarget: null,
    tab: 'overview',
  });
  const [rightSidebarState, updateRightSidebarState] = useAppRightSidebarState('chat', { open: true, width: 420 });

  // Bug: 84cd5ae — linked issue pills in conversation detail
  const [sessionIssueLinks, setSessionIssueLinks] = useState<Array<{ issue_id: string; repo_id: string }>>([]);

  // Fork/control state
  const [toast, setToast] = useState<ToastState>(null);
  const navigateToCreatedTask = useCallback(async (providerSessionId: string) => {
    try {
      const target = await resolveProviderSessionConversation(providerSessionId);
      if (target) onNavigateRef.current(target.id);
      else setToast({ message: 'Created task conversation is not available yet.', type: 'info' });
    } catch (error) {
      setToast({
        message: `Could not open created task: ${error instanceof Error ? error.message : String(error)}`,
        type: 'error',
      });
    }
  }, []);
  const [attachmentStore, setAttachmentStore] = useState(getAttachmentDraftSnapshot);
  useEffect(() => subscribeAttachmentDrafts(() => setAttachmentStore(getAttachmentDraftSnapshot())), []);
  const continueDraft = attachmentStore.drafts[conversationId]?.text ?? '';
  const draftAttachments = attachmentStore.drafts[conversationId]?.attachments ?? [];
  const [highlightedAttachmentIds, setHighlightedAttachmentIds] = useState(() => getDraftAttachmentHighlights(conversationId));
  useEffect(() => {
    const refresh = () => setHighlightedAttachmentIds(getDraftAttachmentHighlights(conversationId));
    refresh();
    return subscribeDraftAttachmentHighlights(refresh);
  }, [conversationId]);
  const [attachmentBusy, setAttachmentBusy] = useState(false);
  const attachmentImportQueueRef = useRef<Promise<void>>(Promise.resolve());
  const pendingAttachmentImportsRef = useRef(0);
  const [attachmentPreview, setAttachmentPreview] = useState<ChatAttachment | null>(null);
  const [attachmentPreviewText, setAttachmentPreviewText] = useState<string | null>(null);
  const attachmentPickerRef = useRef<HTMLInputElement>(null);
  const [continueBusy, setContinueBusy] = useState(false);
  const [continueError, setContinueError] = useState<string | null>(null);
  const [runOptionsError, setRunOptionsError] = useState<string | null>(null);
  const [controlFailure, setControlFailure] = useState<ChatFailureNoticeModel | null>(null);
  const [submitIntent, setSubmitIntent] = useState<DraftSubmitIntent | null>(() => getPendingSubmitIntent(conversationId));
  const submittingIntentRef = useRef<string | null>(null);
  const incomingAnchorKey = anchor ? JSON.stringify(anchor) : 'initial';
  const [effectiveAnchor, setEffectiveAnchor] = useState(anchor);
  const handledAnchorKeyRef = useRef<string | null>(null);
  const windowTargetJson = JSON.stringify({
    ...normalizeWindowTarget(effectiveAnchor ?? { target: 'initial', limit: 500 }),
    view: 'display' as const,
  });
  const windowTarget = useMemo(
    () => JSON.parse(windowTargetJson) as ReturnType<typeof normalizeWindowTarget>,
    [windowTargetJson],
  );
  const conversationRequestKey = useMemo(
    () => conversationKeys.window(conversationId, windowTarget),
    [conversationId, windowTarget],
  );
  const readAndReconcileWindow = useCallback(async (
    target: ReturnType<typeof normalizeWindowTarget>,
    read: () => Promise<ConversationPositionWindow>,
    finalize?: (data: ConversationTranscriptData) => ConversationTranscriptData,
  ): Promise<ConversationPositionWindow> => {
    const aggregateKey = conversationKeys.aggregate(conversationId);
    const aggregateAtStart = queryClient.getQueryData<ConversationTranscriptData>(aggregateKey);
    const incoming = await read();
    if (selectionRef.current.generation !== selectionGeneration) throw new CancelledError();
    const current = queryClient.getQueryData<ConversationTranscriptData>(aggregateKey);
    const aggregateAdvanced = current !== undefined
      && (aggregateAtStart === undefined || current.source_version_id !== aggregateAtStart.source_version_id);
    if (aggregateAdvanced && current.source_version_id !== incoming.source_version_id) {
      throw new CancelledError();
    }
    if (current && current.source_version_id !== incoming.source_version_id) {
      const currentWindowKey = conversationKeys.window(conversationId, target);
      const currentWindowHash = queryClient.getQueryCache().find({
        queryKey: currentWindowKey,
        exact: true,
      })?.queryHash;
      queryClient.removeQueries({
        queryKey: conversationKeys.windows(conversationId),
        type: 'inactive',
        // Keep the window that supplied the accepted replacement.
        predicate: (query) => currentWindowHash !== undefined && query.queryHash !== currentWindowHash,
      });
    }
    const reconciled = reconcileConversationWindow(current, incoming);
    queryClient.setQueryData(aggregateKey, finalize ? finalize(reconciled) : reconciled);
    return incoming;
  }, [conversationId, queryClient, selectionGeneration]);
  const registerInitialRouteLoad = useRegisterInitialRouteLoad();
  const fetchConversationDetail = useCallback(
    ({ signal }: { signal: AbortSignal }) => {
      let structure: ConversationStructure;
      const initialLoad = readAndReconcileWindow(windowTarget, async () => {
        const [window, selectedStructure] = await Promise.all([
          readConversationWindowWhenReady(conversationId, windowRequest(windowTarget, signal)),
          readConversationStructureWhenReady(conversationId, signal),
        ]);
        if (selectedStructure.source_version_id !== window.source_version_id
            || selectedStructure.total !== window.total) {
          throw new ApiError('Conversation changed while opening; retry the reading position.', 409, 'freshness_pending');
        }
        structure = selectedStructure;
        return window;
      }, (data) => ({ ...data, structure }));
      registerInitialRouteLoad(initialLoad);
      return initialLoad;
    },
    [conversationId, readAndReconcileWindow, registerInitialRouteLoad, windowTarget],
  );
  const windowQuery = useQuery({
    queryKey: conversationRequestKey,
    queryFn: fetchConversationDetail,
  }, queryClient);
  const aggregateQuery = useQuery<ConversationTranscriptData>({
    queryKey: conversationKeys.aggregate(conversationId),
    queryFn: () => Promise.reject(new Error('Conversation transcript aggregate has no direct transport.')),
    enabled: false,
  }, queryClient);
  const fetchAndReconcileWindow = useCallback(async (
    target: ReturnType<typeof normalizeWindowTarget>,
    signal?: AbortSignal,
  ): Promise<ConversationPositionWindow> => {
    const displayTarget = { ...target, view: 'display' as const };
    return readAndReconcileWindow(displayTarget, () => readConversationWindowWhenReady(
      conversationId, windowRequest(displayTarget, signal),
    ));
  }, [conversationId, readAndReconcileWindow]);

  const hydrateConversationDetails = useCallback(async (
    sources: readonly { blockId: string; position?: number; detailsLoaded?: boolean }[],
  ): Promise<void> => {
    const aggregateKey = conversationKeys.aggregate(conversationId);
    const aggregateAtStart = queryClient.getQueryData<ConversationTranscriptData>(aggregateKey);
    if (!aggregateAtStart) return;
    const requested = [...new Map(sources
      .filter((source) => source.detailsLoaded === false && Number.isSafeInteger(source.position))
      .map((source) => [source.position!, source])).values()];
    await Promise.all(requested.map(async (source) => {
      const target = normalizeWindowTarget({ position: source.position!, limit: 1 });
      const incoming = await queryClient.fetchQuery({
        queryKey: conversationKeys.window(conversationId, target),
        queryFn: ({ signal }) => readConversationWindowWhenReady(
          conversationId,
          windowRequest(target, signal),
        ),
        staleTime: 0,
      });
      queryClient.removeQueries({ queryKey: conversationKeys.window(conversationId, target), exact: true, type: 'inactive' });
      const current = queryClient.getQueryData<ConversationTranscriptData>(aggregateKey);
      if (!current) return;
      if (incoming.source_version_id !== current.source_version_id) {
        // Keep the old projection intact until a complete display projection
        // for the new source version has arrived.
        void queryClient.invalidateQueries({ queryKey: conversationRequestKey, exact: true });
        return;
      }
      if (!incoming.blocks.some((block) => block.id === source.blockId && block.details_loaded !== false)) {
        throw new Error('The expanded conversation block did not return its complete details.');
      }
      queryClient.setQueryData(aggregateKey, reconcileConversationWindow(current, {
        ...incoming,
        blocks: incoming.blocks.map((block) => ({ ...block, details_loaded: true })),
      }));
    }));
  }, [conversationId, conversationRequestKey, queryClient]);
  const handleExpandConversationDetails = useCallback(async (
    sources: readonly { blockId: string; position?: number; detailsLoaded?: boolean }[],
  ) => {
    try {
      await hydrateConversationDetails(sources);
    } catch (cause) {
      if (selectionRef.current.generation !== selectionGeneration) return;
      setToast({
        message: `Could not load expanded chat details: ${cause instanceof Error ? cause.message : String(cause)}`,
        type: 'error',
      });
    }
  }, [hydrateConversationDetails, selectionGeneration]);

  useEffect(() => () => {
    void queryClient.cancelQueries({ queryKey: conversationKeys.conversation(conversationId) });
  }, [conversationId, queryClient]);
  useEffect(() => {
    setEdgeLoading(null);
    setJumpingToLatest(false);
    setExportLoading(false);
    setExportIntent(null);
  }, [conversationId]);
  // Flattening is a projection of query data, not a new entity on every
  // component render. Keeping its identity stable also keeps the registered
  // app-sidebar descriptor stable; otherwise that descriptor updates App,
  // which renders this detail again and recreates the descriptor forever.
  const conversation = useMemo(() => (
    aggregateQuery.data
      ? flattenConversationTranscript(aggregateQuery.data)
      : initialConversation ? conversationShell(initialConversation) : null
  ), [aggregateQuery.data, initialConversation]);
  const loading = windowQuery.isFetching;
  const targetRequest = effectiveAnchor !== null;
  const notFound = !targetRequest && isApiErrorStatus(windowQuery.error, 404) && !creationReceipt;
  const error = navigationError ?? (
    windowQuery.error && !notFound
      ? conversationLoadFailure(
        windowQuery.error,
        Boolean(aggregateQuery.data),
        targetRequest ? 'target' : aggregateQuery.data ? 'refresh' : 'initial',
      )
      : null
  );

  const loadTranscriptEdge = useCallback(async (direction: 'older' | 'newer'): Promise<ConversationHistoryLoadResult> => {
    const aggregate = queryClient.getQueryData<ConversationTranscriptData>(conversationKeys.aggregate(conversationId));
    if (!aggregate || edgeLoading) return 'busy';
    const interval = direction === 'older' ? aggregate.loaded_intervals[0] : aggregate.loaded_intervals.at(-1);
    if (!interval) {
      const failure = conversationLoadFailure(
        new Error('Chat cannot find a loaded history interval to continue from.'),
        true,
        direction === 'older' ? 'edge-older' : 'edge-newer',
      );
      if (failure && selectionRef.current.generation === selectionGeneration) setNavigationError(failure);
      return 'failed';
    }
    const position = direction === 'older' ? interval.start - 1 : interval.end + 1;
    if (position < 0 || position >= aggregate.total) {
      const reachedBoundary = direction === 'older' ? aggregate.start_reached : aggregate.end_reached;
      if (reachedBoundary) return 'covered';
      const failure = conversationLoadFailure(
        new Error(`Chat reported more ${direction === 'older' ? 'earlier' : 'later'} history, but no next position is available.`),
        true,
        direction === 'older' ? 'edge-older' : 'edge-newer',
      );
      if (failure && selectionRef.current.generation === selectionGeneration) setNavigationError(failure);
      return 'failed';
    }
    setEdgeLoading(direction);
    setNavigationError(null);
    historyRetryRef.current = { kind: 'edge', direction };
    try {
      await fetchAndReconcileWindow(normalizeWindowTarget({ position }));
      const updated = queryClient.getQueryData<ConversationTranscriptData>(conversationKeys.aggregate(conversationId));
      const nextInterval = direction === 'older' ? updated?.loaded_intervals[0] : updated?.loaded_intervals.at(-1);
      const advanced = direction === 'older'
        ? Boolean(nextInterval && nextInterval.start < interval.start)
        : Boolean(nextInterval && nextInterval.end > interval.end);
      if (!advanced) throw new Error(`Conversation history did not advance ${direction === 'older' ? 'toward the beginning' : 'toward the end'}.`);
      historyRetryRef.current = null;
      return 'loaded';
    } catch (cause) {
      const failure = conversationLoadFailure(cause, true, direction === 'older' ? 'edge-older' : 'edge-newer');
      if (failure && selectionRef.current.generation === selectionGeneration) setNavigationError(failure);
      return failure ? 'failed' : 'busy';
    } finally {
      if (selectionRef.current.generation === selectionGeneration) setEdgeLoading(null);
    }
  }, [conversationId, edgeLoading, fetchAndReconcileWindow, queryClient, selectionGeneration]);

  const loadTranscriptAround = useCallback(async (
    position: number,
    limit = 500,
    signal?: AbortSignal,
  ): Promise<ConversationHistoryLoadResult> => {
    const aggregate = queryClient.getQueryData<ConversationTranscriptData>(conversationKeys.aggregate(conversationId));
    if (!aggregate) return 'busy';
    if (!Number.isSafeInteger(position) || position < 0 || position >= aggregate.total) {
      const failure = conversationLoadFailure(new Error(`Chat cannot load history at position ${position}.`), true, 'edge-newer');
      if (failure && selectionRef.current.generation === selectionGeneration) setNavigationError(failure);
      return 'failed';
    }
    if (aggregate.loaded_intervals.some((interval) => position >= interval.start && position <= interval.end)) {
      historyRetryRef.current = null;
      return 'covered';
    }
    setNavigationError(null);
    historyRetryRef.current = { kind: 'around', position };
    try {
      await fetchAndReconcileWindow(normalizeWindowTarget({ position, limit }), signal);
      const updated = queryClient.getQueryData<ConversationTranscriptData>(conversationKeys.aggregate(conversationId));
      if (!updated?.loaded_intervals.some((interval) => position >= interval.start && position <= interval.end)) {
        throw new Error(`Conversation history did not include requested position ${position}.`);
      }
      historyRetryRef.current = null;
      return 'loaded';
    } catch (cause) {
      if (signal?.aborted || cause instanceof CancelledError
          || (cause instanceof Error && cause.name === 'AbortError')) return 'cancelled';
      const failure = conversationLoadFailure(cause, true, 'edge-newer');
      if (failure && selectionRef.current.generation === selectionGeneration) setNavigationError(failure);
      return failure ? 'failed' : 'busy';
    }
  }, [conversationId, fetchAndReconcileWindow, queryClient, selectionGeneration]);

  const transcriptConsumer = useMemo<ConversationTranscriptConsumer | undefined>(() => {
    const aggregate = aggregateQuery.data;
    if (!aggregate) return undefined;
    return {
      conversationId: aggregate.conversation.id,
      sourceVersionId: aggregate.source_version_id,
      historyLoading: edgeLoading !== null,
      total: aggregate.total,
      structure: aggregate.structure,
      loadedIntervals: aggregate.loaded_intervals,
      hasOlder: !aggregate.start_reached,
      hasNewer: !aggregate.end_reached,
      unmaterializedAfterCount: aggregate.after_count,
      loadOlder: () => loadTranscriptEdge('older'),
      loadNewer: () => loadTranscriptEdge('newer'),
      loadAround: loadTranscriptAround,
    };
  }, [aggregateQuery.data, loadTranscriptAround, loadTranscriptEdge]);

  useEffect(() => {
    if (notFound) onUnavailable?.(conversationId);
  }, [conversationId, notFound, onUnavailable]);

  const currentRightSidebarViewState = scopeConversationRightSidebar(conversationId, rightSidebarViewState);

  useEffect(() => {
    if (rightSidebarViewState.conversationId !== conversationId) {
      setRightSidebarViewState({ conversationId, previewTarget: null, tab: 'overview' });
    }
  }, [conversationId, rightSidebarViewState.conversationId]);

  const previewInRightSidebar = useCallback((target: ChatPreviewTarget) => {
    setRightSidebarViewState(() => ({
      conversationId,
      previewTarget: target,
      tab: 'preview',
    }));
    updateRightSidebarState({ open: true });
  }, [conversationId, updateRightSidebarState]);

  useEffect(() => {
    setEffectiveAnchor(anchor);
    handledAnchorKeyRef.current = null;
    setNavigationTarget(null);
    setNavigationError(null);
  }, [conversationId, incomingAnchorKey]);

  const headerRef = useRef<HTMLElement>(null);
  const actionsTriggerRef = useRef<HTMLButtonElement>(null);
  const actionsMenuRef = useRef<HTMLDivElement>(null);
  const actionsMenuStyle = useAnchoredMenu({
    open: actionsOpen,
    anchorRef: actionsTriggerRef,
    menuRef: actionsMenuRef,
    onDismiss: () => setActionsOpen(false),
  });
  const runOptionsTriggerRef = useRef<HTMLButtonElement>(null);
  const runOptionsMenuRef = useRef<HTMLDivElement>(null);
  const runOptionsMenuStyle = useAnchoredMenu({
    open: composerControlsOpen,
    anchorRef: runOptionsTriggerRef,
    menuRef: runOptionsMenuRef,
    focusRef: runOptionsTriggerRef,
    onDismiss: () => setComposerControlsOpen(false),
    placement: 'top-end',
  });

  useEffect(() => {
    const payload = windowQuery.data;
    if (!payload) return;
    const pendingReconciliations = pendingDurableReconciliationsRef.current
      .splice(0)
      .filter((event) => event.conversation_id === conversationId);
    if (pendingReconciliations.length > 0) {
      setLiveProjection((current) => pendingReconciliations.reduce(
        (projection, event) => mergeProviderLiveProjection(projection, event),
        current,
      ));
    }
    if (effectiveAnchor && handledAnchorKeyRef.current !== incomingAnchorKey) {
      handledAnchorKeyRef.current = incomingAnchorKey;
      setNavigationTarget({
        key: `${conversationId}:target:${incomingAnchorKey}`,
        kind: payload.target.kind,
        turnId: payload.target.turn_id,
        blockId: payload.target.block_id,
        smooth: false,
      });
    }
    setNavigationError((current) => {
      const operation = current?.operation === 'source-unavailable' ? current.retryOperation : current?.operation;
      return current && operation && ['edge-older', 'edge-newer', 'export'].includes(operation) ? current : null;
    });
  }, [conversationId, effectiveAnchor, incomingAnchorKey, windowQuery.data]);

  const refreshControl = useCallback(() => {
    let active = true;
    void getConversationControl(conversationId)
      .then((snapshot) => { if (active) setControl((current) => reconcileControlSnapshot(current, snapshot, conversationId)); })
      .catch(() => {});
    return () => { active = false; };
  }, [conversationId]);

  useEffect(() => {
    setControl(null);
    setLiveProjection(null);
    pendingDurableReconciliationsRef.current = [];
    setSubmitIntent(getPendingSubmitIntent(conversationId));
    setContinueBusy(false);
    submittingIntentRef.current = null;
    const cancelControl = refreshControl();
    let active = true;
    void getConversationLiveProjection(conversationId)
      .then((projection) => { if (active) setLiveProjection(projection); })
      .catch(() => { if (active) setLiveProjection(null); });
    return () => { active = false; cancelControl(); };
  }, [conversationId, refreshControl]);

  useEffect(() => {
    if (creationReceipt?.state !== 'ready') return;
    void queryClient.invalidateQueries({ queryKey: conversationKeys.conversation(conversationId) });
    return refreshControl();
  }, [conversationId, creationReceipt?.attempt_count, creationReceipt?.state, creationReceipt?.updated_at, queryClient, refreshControl]);

  useEffect(() => {
    let refreshTimer: number | null = null;
    const client = acquireSharedSse();
    const scheduleRefresh = () => {
      if (refreshTimer !== null) {
        window.clearTimeout(refreshTimer);
      }
      refreshTimer = window.setTimeout(() => {
        void queryClient.invalidateQueries({ queryKey: conversationRequestKey, exact: true });
      }, 150);
    };
    // conversation:new / conversation:updated are reconciled centrally into
    // Query caches. This effect keeps only workflow refresh and reconnect
    // resync work that cannot be reconstructed from an append payload.
    const offWorkflowUpdated = client.on('workflow:updated', () => {
      setWorkflowNonce((prev) => prev + 1);
    });
    const offControlUpdated = client.on('conversation:control-updated', (payload) => {
      const snapshot = eventData<ConversationControlSnapshot>(payload);
      if (!snapshot) return;
      setControl((current) => reconcileControlSnapshot(current, snapshot, conversationId));
    });
    const offProviderEvent = client.on('conversation:provider-event', (payload) => {
      const providerEvent = eventData<ProviderAdapterEvent>(payload);
      if (!providerEvent) return;
      if (providerEvent.conversation_id !== conversationId) return;
      if (providerEvent.kind === 'durable-reconciliation') {
        // Keep the provisional item visible until the durable window that
        // replaces it has actually arrived. Removing it at the assertion and
        // fetching afterward creates a visible empty frame for Codex turns.
        pendingDurableReconciliationsRef.current.push(providerEvent);
        scheduleRefresh();
        return;
      }
      if (providerEvent.kind === 'provider-lineage') scheduleRefresh();
      setLiveProjection((current) => mergeProviderLiveProjection(current, providerEvent));
    });
    // Reconnect resync: refetch the open conversation after a dropped stream so
    // any events missed during the gap are reconciled.
    const offState = client.onState((_state, { reconnected }) => {
      if (reconnected) {
        scheduleRefresh();
        refreshControl();
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
  }, [conversationId, conversationRequestKey, queryClient, refreshControl]);

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
        setWorkflows((current) => current.length === 0 && runs.length === 0 ? current : runs);
        if (activeWorkflowId && !runs.some((run) => run.id === activeWorkflowId)) {
          setActiveWorkflowId(null);
        }
      })
      .catch(() => {
        if (active) setWorkflows((current) => current.length === 0 ? current : []);
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

  const handleJumpToLatest = useCallback(async () => {
    setJumpingToLatest(true);
    setNavigationError(null);
    const latestTarget = normalizeWindowTarget({ target: 'latest' });
    try {
      let latest = await fetchAndReconcileWindow(latestTarget);
      let observedRevision = queryClient.getQueryData<ConversationTranscriptData>(
        conversationKeys.aggregate(conversationId),
      )?.revision ?? latest.revision;
      while (latest.revision < observedRevision) {
        if (selectionRef.current.generation !== selectionGeneration) return;
        latest = await fetchAndReconcileWindow(latestTarget);
        observedRevision = queryClient.getQueryData<ConversationTranscriptData>(
          conversationKeys.aggregate(conversationId),
        )?.revision ?? latest.revision;
      }
      if (selectionRef.current.generation !== selectionGeneration) return;
      setEffectiveAnchor(null);
      window.history.replaceState(null, '', conversationLatestHref(window.location.hash, conversationId));
      setNavigationTarget({
        key: `${conversationId}:latest:${latest.source_version_id ?? 'legacy'}:${latest.revision}`,
        kind: 'latest',
        turnId: latest.target.turn_id,
        blockId: latest.target.block_id,
        smooth: true,
      });
    } catch (err) {
      const failure = conversationLoadFailure(err, true, 'target');
      if (failure && selectionRef.current.generation === selectionGeneration) setNavigationError(failure);
    } finally {
      if (selectionRef.current.generation === selectionGeneration) setJumpingToLatest(false);
    }
  }, [conversationId, fetchAndReconcileWindow, queryClient, selectionGeneration]);

  // Toast auto-dismiss
  useEffect(() => {
    if (!toast || toast.type === 'error') return;
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

  const visibleBlocks = blocks;
  const historyEvents = useMemo(
    () => conversationBlocksToStreamEvents(conversation?.session_id ?? conversationId, visibleBlocks),
    [conversation?.session_id, conversationId, visibleBlocks],
  );
  const chatEvents = useMemo(
    () => reconcileProviderProjection(historyEvents, liveProjection),
    [historyEvents, liveProjection],
  );
  const providerStreaming = control?.turn.kind === 'queued'
    || control?.turn.kind === 'running'
    || control?.turn.kind === 'waiting-user'
    || control?.turn.kind === 'waiting-permission';
  const activityItems = useMemo(
    () => [
      ...buildSubagentActivityItems(conversation?.children ?? [], blocks, navigateFromActivity),
      ...buildWorkflowActivityItems(workflows, setActiveWorkflowId),
    ],
    [blocks, conversation?.children, navigateFromActivity, workflows],
  );
  const rightSidebarDescriptor = useMemo(() => conversation && windowQuery.data ? ({
    id: 'chat-right-sidebar',
    kind: 'tabs' as const,
    ariaLabel: 'Chat sidebar',
    open: rightSidebarState.open,
    width: rightSidebarState.width,
    minWidth: CHAT_DETAIL_PREVIEW_MIN_WIDTH,
    maxWidth: 720,
    togglePlacement: 'detail-header' as const,
    onOpenChange: (open: boolean) => updateRightSidebarState({ open }),
    onWidthChange: (width: number) => updateRightSidebarState({ width }),
    activeTab: currentRightSidebarViewState.tab,
    onActiveTabChange: (tab: string) => setRightSidebarViewState((current) => ({
      ...(current.conversationId === conversationId ? current : { conversationId, previewTarget: null, tab: 'overview' as const }),
      tab: tab === 'preview' ? 'preview' : tab === 'activity' ? 'activity' : 'overview',
    })),
    tabs: [
      {
        id: 'overview',
        label: 'Session Overview',
        tooltip: 'Session Overview',
        icon: <OverviewTabIcon />,
        scrollOwner: 'detail' as const,
        content: <ChatSessionOverview providerSessionId={conversation.session_id ?? null} conversationId={conversationId} />,
      },
      {
        id: 'preview',
        label: 'Preview',
        tooltip: 'Preview',
        icon: <PreviewTabIcon />,
        scrollOwner: 'detail' as const,
        content: <ChatPreview target={currentRightSidebarViewState.previewTarget} />,
      },
      {
        id: 'activity',
        label: 'Activity',
        tooltip: 'Activity',
        icon: <ActivityTabIcon />,
        scrollOwner: 'detail' as const,
        content: <ChatActivity items={activityItems} />,
      },
    ],
  }) : null, [activityItems, conversation, conversationId, currentRightSidebarViewState, rightSidebarState, updateRightSidebarState, windowQuery.data]);
  useRegisterAppRightSidebar(rightSidebarDescriptor);
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

  const handleStarToggle = async () => {
    if (!conversation) return;
    const newStarred = !conversation.starred;
    try {
      await updateConversation(conversationId, { starred: newStarred });
      queryClient.setQueriesData<ConversationPositionWindow>(
        { queryKey: conversationKeys.windows(conversationId) },
        (current) => current ? {
          ...current,
          conversation: { ...current.conversation, starred: newStarred },
        } : current,
      );
      void queryClient.invalidateQueries({ queryKey: conversationKeys.sidebars() });
    } catch {
      // ignore
    }
  };

  const linkedConsoleSession = useMemo(() => {
    if (creationReceipt) return null;
    if (!conversation?.session_id) return null;
    return consoleSessions.find((session) => session.provider_session_id === conversation.session_id) ?? null;
  }, [consoleSessions, conversation?.session_id, creationReceipt]);

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
  const runMarkdownAction = useCallback(async (intent: 'copy' | 'open') => {
    setExportLoading(true);
    setExportIntent(intent);
    setNavigationError(null);
    try {
      const exported = await exportConversationBlocks(conversationId, { format: 'markdown' });
      if (selectionRef.current.generation !== selectionGeneration) return;
      if (intent === 'copy') await navigator.clipboard.writeText(exported.content);
      else openMarkdownDocument(exported.content);
      setExportIntent(null);
      setActionsOpen(false);
    } catch (cause) {
      const failure = conversationLoadFailure(cause, true, 'export');
      if (failure && selectionRef.current.generation === selectionGeneration) setNavigationError(failure);
    } finally {
      if (selectionRef.current.generation === selectionGeneration) setExportLoading(false);
    }
  }, [conversationId, selectionGeneration]);

  const openUsage = useCallback(() => setUsageModalOpen(true), []);
  const [sessionRunOptions, setSessionRunOptions] = useState<SessionRunOptionsSnapshot | null>(null);
  useEffect(() => {
    let active = true;
    setSessionRunOptions(null);
    setRunOptionsError(null);
    const runOptions = linkedConsoleSession
      ? getConsoleSessionOptions(linkedConsoleSession.id).then((result) => result.runOptions)
      : conversation?.source === 'codex'
        ? getConsoleRunOptions('acp', 'codex')
        : conversation?.source === 'claude_code'
          ? getConsoleRunOptions('sdk', 'claude')
          : Promise.resolve(null);
    void runOptions.then((result) => {
      if (active) setSessionRunOptions(result);
    }).catch((cause) => {
      if (!active) return;
      setSessionRunOptions(null);
      setRunOptionsError(cause instanceof Error ? cause.message : String(cause));
    });
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
    if (creationReceipt?.state === 'starting') return null;
    if (!controlPresentation) return 'Control state unavailable.';
    if (control?.capability.kind === 'message-anchor-resume' && !latestDagUuid) {
      return 'The required message anchor is unavailable.';
    }
    if (controlPresentation.composer === 'enabled') return null;
    return controlPresentation.title;
  }, [control, controlPresentation, conversation, creationReceipt, latestDagUuid]);

  const { active: chatViewActive } = useAppShell();
  const selectedComposerWritable = !isReadOnlyChild && !continueBusy && !submitIntent
    && !continueDisabledReason && controlPresentation?.composer === 'enabled';
  const canImportAttachments = chatViewActive && !isReadOnlyChild && !continueBusy
    && (!submitIntent || submitIntent.state === 'failed')
    && (!continueDisabledReason || submitIntent?.state === 'failed')
    && (controlPresentation?.composer === 'enabled' || submitIntent?.state === 'failed');
  useLayoutEffect(() => {
    if (!selectedComposerWritable) return undefined;
    return registerWritableChatTarget(conversationId, chatViewActive);
  }, [selectedComposerWritable, chatViewActive, conversationId]);
  useLayoutEffect(() => {
    if (chatViewActive) activateDraftAttachmentHighlights(conversationId);
  }, [chatViewActive, conversationId]);

  const importFiles = useCallback((files: FileList | File[]) => {
    const batch = Array.from(files);
    if (!batch.length) return;
    if (!canImportAttachments) {
      setContinueError(submitIntent?.state === 'uncertain'
        ? 'Message delivery is uncertain. Resolve it before adding attachments.'
        : submitIntent?.state === 'submitting' || continueBusy
          ? 'Wait for the message to finish sending before adding attachments.'
          : continueDisabledReason ?? 'Attachments are unavailable in this chat.');
      return;
    }
    const targetConversationId = conversationId;
    pendingAttachmentImportsRef.current += 1;
    setAttachmentBusy(true);
    setContinueError(null);
    const runBatch = async () => {
      try {
        await importAttachmentBatch(targetConversationId, batch);
      } catch (error) {
        if (selectionRef.current.conversationId === targetConversationId) {
          setContinueError(error instanceof Error ? error.message : String(error));
        }
      } finally {
        pendingAttachmentImportsRef.current -= 1;
        if (!pendingAttachmentImportsRef.current) setAttachmentBusy(false);
      }
    };
    attachmentImportQueueRef.current = attachmentImportQueueRef.current.then(runBatch, runBatch);
  }, [canImportAttachments, continueBusy, continueDisabledReason, conversationId, submitIntent?.state]);

  const handleFileDragOver = useCallback((event: JSX.TargetedDragEvent<HTMLElement>) => {
    if (event.dataTransfer?.types.includes('Files')) event.preventDefault();
  }, []);
  const handleFileDrop = useCallback((event: JSX.TargetedDragEvent<HTMLElement>) => {
    if (!event.dataTransfer?.types.includes('Files')) return;
    event.preventDefault();
    event.stopPropagation();
    importFiles(event.dataTransfer.files);
  }, [importFiles]);

  useEffect(() => {
    if (!attachmentPreview || attachmentPreview.kind === 'annotation' || attachmentPreview.kind === 'image') {
      setAttachmentPreviewText(null);
      return undefined;
    }
    let active = true;
    void browserSessionFetch(attachmentContentUrl(attachmentPreview.file))
      .then(async (response) => {
        if (!response.ok) throw new Error(`Preview unavailable (${response.status}).`);
        return response.text();
      })
      .then((content) => { if (active) setAttachmentPreviewText(content.slice(0, 20000)); })
      .catch((error) => { if (active) setAttachmentPreviewText(error instanceof Error ? error.message : String(error)); });
    return () => { active = false; };
  }, [attachmentPreview]);

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
  const hasRunOptions = Boolean(
    currentModel
    || (thinkingRunOption && thinkingRunOption.enforcement.status !== 'unsupported')
    || (permissionRunOption && permissionRunOption.enforcement.status !== 'unsupported')
    || canShowSessionControls,
  );

  const runOptionsGeometry = useIntrinsicOverflowGroup(
    hasRunOptions,
    `${Boolean(permissionRunOption)}\u0000${composerPermission}\u0000${Boolean(currentModel)}\u0000${composerModel}\u0000${Boolean(thinkingRunOption)}\u0000${composerEffort}\u0000${Boolean(canShowSessionControls)}\u0000${sessionRunOptions?.revision ?? ''}`,
  );

  useEffect(() => {
    setComposerModel(currentModel === 'default' ? '' : currentModel);
  }, [conversationId, currentModel]);

  useEffect(() => {
    setComposerEffort(String(thinkingRunOption?.currentValue ?? ''));
    setComposerPermission(String(permissionRunOption?.currentValue ?? ''));
  }, [conversationId, thinkingRunOption?.id, thinkingRunOption?.currentValue,
    permissionRunOption?.id, permissionRunOption?.currentValue]);

  const projectPendingIntent = useCallback((intent: { id: string; message: string }) => {
    const provider = conversation?.source ?? creationReceipt?.request.provider;
    const providerSessionId = conversation?.session_id
      ?? creationReceipt?.provider_session_id
      ?? creationReceipt?.native_session_id;
    if (!provider || !providerSessionId) return;
    const item = optimisticPromptItem(intent, provider, providerSessionId);
    const identity = chatItemIdentityKey(item);
    if (identity === null) return;
    setLiveProjection((current) => mergeProviderLiveProjection(current, {
      kind: 'provisional-content',
      conversation_id: conversationId,
      provider_session_id: providerSessionId,
      generation: control?.ownership.generation ?? creationReceipt?.attempt_count ?? 0,
      sequence: (current?.events.reduce((maximum, item) => Math.max(maximum, item.sequence), 0) ?? 0) + 1,
      observed_at: Date.now(),
      identity,
      item,
    }));
  }, [control?.ownership.generation, conversation?.session_id, conversation?.source, conversationId,
    creationReceipt?.attempt_count, creationReceipt?.native_session_id, creationReceipt?.provider_session_id,
    creationReceipt?.request.provider]);

  const dispatchSubmitIntent = useCallback(async (intent: NonNullable<typeof submitIntent>) => {
    if (!control || submittingIntentRef.current === intent.id) return;
    if (creationReceipt?.state === 'starting') return;
    if (!['live-send', 'live-steer', 'owned-queue', 'provider-session-resume', 'message-anchor-resume'].includes(control.capability.kind)) return;
    const stillSelected = () => selectionRef.current.conversationId === conversationId;
    submittingIntentRef.current = intent.id;
    const persisted = savePendingSubmitIntent(conversationId, { ...intent, state: 'submitting' });
    if (!persisted.ok) { submittingIntentRef.current = null; setContinueError(persisted.error); return; }
    setSubmitIntent((current) => current?.id === intent.id ? { ...current, state: 'submitting' } : current);
    setContinueBusy(true);
    setContinueError(null);
    setControlFailure(null);
    try {
      const result = await submitConversationControl(
        control,
        intent.message,
        intent.messageAnchor,
        intent.runtimeOptions,
        intent.id,
        intent.attachments,
      );
      if (stillSelected()) setControl(result.snapshot);
      const cleared = clearAcceptedDraft(conversationId, { text: intent.draftText, attachments: intent.attachments });
      if (stillSelected()) {
        if (!cleared.ok) setContinueError(`Message accepted, but the local draft could not be cleared: ${cleared.error}`);
        setSubmitIntent((current) => current?.id === intent.id ? null : current);
      }
    } catch (err) {
      const apiError = err as Partial<ConversationControlApiError>;
      if (apiError.snapshot && stillSelected()) setControl(apiError.snapshot);
      const uncertain = apiError.controlError?.kind === 'delivery-uncertain';
      if (!uncertain) {
        const provider = conversation?.source ?? creationReceipt?.request.provider;
        const providerSessionId = conversation?.session_id
          ?? creationReceipt?.provider_session_id
          ?? creationReceipt?.native_session_id;
        const optimisticIdentity = provider && providerSessionId
          ? chatItemIdentityKey(optimisticPromptItem(intent, provider, providerSessionId))
          : null;
        if (providerSessionId && optimisticIdentity && stillSelected()) {
          setLiveProjection((current) => mergeProviderLiveProjection(current, {
            kind: 'durable-reconciliation',
            conversation_id: conversationId,
            provider_session_id: providerSessionId,
            generation: control.ownership.generation,
            sequence: (current?.events.reduce((maximum, item) => Math.max(maximum, item.sequence), 0) ?? 0) + 1,
            observed_at: Date.now(),
            provider_event_id: `failed:${intent.id}`,
            covered_identities: [optimisticIdentity],
          }));
        }
      }
      if (stillSelected()) setSubmitIntent((current) => current?.id === intent.id
        ? { ...current, state: uncertain ? 'uncertain' : 'failed' }
        : current);
      const savedFailure = savePendingSubmitIntent(conversationId, { ...intent, state: uncertain ? 'uncertain' : 'failed' });
      if (stillSelected()) {
        if (!savedFailure.ok) setContinueError(`Could not retain retry state: ${savedFailure.error}`);
        if (apiError.controlError) setControlFailure(chatControlFailureNotice(apiError.controlError));
        else setContinueError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      if (stillSelected()) {
        submittingIntentRef.current = null;
        setContinueBusy(false);
      }
    }
  }, [control, conversation?.session_id, conversation?.source, conversationId, creationReceipt?.native_session_id,
    creationReceipt?.provider_session_id, creationReceipt?.request.provider, creationReceipt?.state]);

  useEffect(() => {
    if (submitIntent?.state === 'waiting') void dispatchSubmitIntent(submitIntent);
  }, [dispatchSubmitIntent, submitIntent]);

  const handleContinueSubmit = useCallback((event: JSX.TargetedEvent<HTMLFormElement, Event>) => {
    event.preventDefault();
    if (pendingAttachmentImportsRef.current) {
      setContinueError('Wait for attachments to finish importing before sending.');
      return;
    }
    const prompt = continueDraft.trim();
    if ((!prompt && !draftAttachments.length) || submitIntent) return;
    if (continueDisabledReason && creationReceipt?.state !== 'starting') {
      setContinueError(continueDisabledReason);
      return;
    }
    const intent = {
      id: crypto.randomUUID(),
      message: prompt,
      draftText: continueDraft,
      attachments: structuredClone(draftAttachments),
      ...(control?.capability.kind === 'message-anchor-resume' && latestDagUuid ? { messageAnchor: latestDagUuid } : {}),
      runtimeOptions: {
        ...(composerModel ? { model: composerModel } : {}),
        ...(composerEffort ? { effort: composerEffort } : {}),
        ...(composerPermission ? { permission_mode: composerPermission as ConversationRuntimeOptions['permission_mode'] } : {}),
      },
      state: 'waiting' as const,
    };
    const savedIntent = savePendingSubmitIntent(conversationId, intent);
    if (!savedIntent.ok) { setContinueError(savedIntent.error); return; }
    setContinueError(null);
    setControlFailure(null);
    projectPendingIntent(intent);
    setSubmitIntent(intent);
  }, [composerEffort, composerModel, composerPermission, continueDisabledReason, continueDraft, draftAttachments, control?.capability.kind, creationReceipt?.state, latestDagUuid, projectPendingIntent, submitIntent, conversationId]);

  const handleComposerKeyDown = useCallback((event: JSX.TargetedKeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter') return;
    if (event.shiftKey && !event.metaKey && !event.ctrlKey) return;
    event.preventDefault();
    event.currentTarget.form?.requestSubmit();
  }, []);

  const retrySubmitIntent = useCallback(() => {
    if (!submitIntent || !['failed', 'uncertain'].includes(submitIntent.state)) return;
    const waiting = { ...submitIntent, state: 'waiting' as const };
    const result = savePendingSubmitIntent(conversationId, waiting);
    if (!result.ok) { setContinueError(result.error); return; }
    projectPendingIntent(waiting);
    setSubmitIntent(waiting);
  }, [conversationId, projectPendingIntent, submitIntent]);

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

  const handleOpenExternally = useCallback(async () => {
    if (!conversation?.external_navigation) return;
    try {
      await openConversationExternally(conversation.id);
      setToast({ message: `${conversation.external_navigation.label} requested.`, type: 'info' });
    } catch (err) {
      setToast({ message: err instanceof Error ? err.message : String(err), type: 'error' });
    }
  }, [conversation?.external_navigation, conversation?.id]);

  const navigateToGraph = useCallback(() => {
    const sessionId = linkedConsoleSession?.id ?? conversation?.session_id;
    const focus = sessionId ? `session:${sessionId}` : undefined;
    const params = new URLSearchParams({ mode: 'activity' });
    if (focus) params.set('focus', focus);
    window.location.hash = `#/graph?${params.toString()}`;
  }, [conversation?.session_id, linkedConsoleSession?.id]);

  const retryLoad = useCallback(() => {
    if (error) setNavigationError(error);
    const historyRetry = historyRetryRef.current;
    if (historyRetry?.kind === 'edge') {
      void loadTranscriptEdge(historyRetry.direction);
      return;
    }
    if (historyRetry?.kind === 'around') {
      void loadTranscriptAround(historyRetry.position);
      return;
    }
    const operation = error?.operation === 'source-unavailable' ? error.retryOperation : error?.operation;
    if (operation === 'edge-older') {
      void loadTranscriptEdge('older');
      return;
    }
    if (operation === 'edge-newer') {
      void loadTranscriptEdge('newer');
      return;
    }
    if (operation === 'export' && exportIntent) {
      void runMarkdownAction(exportIntent);
      return;
    }
    void windowQuery.refetch();
  }, [error, exportIntent, loadTranscriptAround, loadTranscriptEdge, runMarkdownAction, windowQuery]);

  const loadErrorNotice = error ? (
    <DetailPaneNotice
      severity="error"
      density="compact"
      actions={error.retryable ? (
        <>
          {error.retryable ? (
            <button type="button" className="btn btn--ghost btn--sm" disabled={loading || edgeLoading !== null || exportLoading} onClick={retryLoad}>Retry</button>
          ) : null}
        </>
      ) : undefined}
    >
      {error.message}
    </DetailPaneNotice>
  ) : undefined;

  const handleNavigationResult = useCallback((result: { key: string; status: 'revealed' | 'not-renderable' }) => {
    if (result.key !== navigationTarget?.key) return;
    if (result.status === 'revealed') {
      setNavigationError((current) => current?.operation === 'target' ? null : current);
      setNavigationTarget((current) => current?.key === result.key ? null : current);
      return;
    }
    setNavigationError({
      operation: 'target',
      code: 'target_not_renderable',
      message: 'The requested transcript target was loaded but has no readable rendered content.',
      retryable: false,
    });
  }, [navigationTarget?.key]);

  if (loading && !conversation && !error) {
    return (
      <ChatDetailFrame
        state="loading"
        header={<DetailPaneHeader variant="compact" title={initialConversation?.title ?? 'Conversation'} />}
        ariaBusy
      >{null}</ChatDetailFrame>
    );
  }

  if (error && !conversation) {
    return (
      <ChatDetailFrame
        state="error"
        header={<DetailPaneHeader variant="compact" title={initialConversation?.title ?? 'Conversation'} />}
        notice={loadErrorNotice}
        ariaBusy={loading}
      >{null}</ChatDetailFrame>
    );
  }

  if (notFound || !conversation) {
    return (
      <ChatDetailFrame
        state="not-found"
        header={<DetailPaneHeader variant="compact" title={initialConversation?.title ?? 'Conversation'} />}
      >
        <div className="empty-state">Conversation not found.</div>
      </ChatDetailFrame>
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
          <DetailPaneMenuTrigger
            buttonRef={actionsTriggerRef}
            label="Conversation actions"
            expanded={actionsOpen}
            onClick={() => setActionsOpen((prev) => !prev)}
          />
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
                  disabled={exportLoading}
                  onClick={() => { void runMarkdownAction('copy'); }}
                >
                  {exportLoading && exportIntent === 'copy' ? 'Copying markdown…' : 'Copy markdown'}
                </button>
                <button
                  type="button"
                  role="menuitem"
                  disabled={exportLoading}
                  onClick={() => { void runMarkdownAction('open'); }}
                >
                  {exportLoading && exportIntent === 'open' ? 'Opening markdown…' : 'Open markdown'}
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
                    Resume in Mandible
                  </button>
                )}
            </div>
          )}
        </div>
      )}
      actionsLabel="Chat sidebar"
    />
  );

  const renderRunOptionFields = () => (
    <>
      {permissionRunOption && permissionRunOption.enforcement.status !== 'unsupported' ? (
        <label className="session-controls__field">
          <span className="session-controls__label">{permissionRunOption.label}</span>
          <select className="session-controls__select" value={composerPermission} disabled={continueBusy || permissionRunOption.availability !== 'available'} aria-label={permissionRunOption.label} onChange={(event) => { void handleComposerRunOptionChange(permissionRunOption.id, event.currentTarget.value); }}>
            {permissionRunOption.nullable && <option value="">Use app default</option>}
            {(permissionRunOption.allowedValues ?? []).map((choice) => <option key={String(choice.value)} value={String(choice.value)}>{choice.label}</option>)}
          </select>
        </label>
      ) : null}
      {currentModel ? (
        <label className="session-controls__field">
          <span className="session-controls__label">{modelRunOption?.label ?? 'Model'}</span>
          <select className="session-controls__select" value={composerModel} disabled={continueBusy || (modelRunOption !== undefined && modelOptions.length === 0)} aria-label={modelRunOption?.label ?? 'Model'} title={modelRunOption?.label ?? 'Model'} onChange={(event) => { void handleComposerModelChange(event.currentTarget.value); }}>
            <option value={currentModel === 'default' ? '' : currentModel}>{currentModel === 'default' ? 'Use app default' : currentModel}</option>
            {modelOptions.filter((model) => model !== currentModel).map((model) => <option key={model} value={model}>{model}</option>)}
          </select>
        </label>
      ) : null}
      {thinkingRunOption && thinkingRunOption.enforcement.status !== 'unsupported' ? (
        <label className="session-controls__field">
          <span className="session-controls__label">{thinkingRunOption.label}</span>
          <select className="session-controls__select" value={composerEffort} disabled={continueBusy || thinkingRunOption.availability !== 'available'} aria-label={thinkingRunOption.label} onChange={(event) => { void handleComposerRunOptionChange(thinkingRunOption.id, event.currentTarget.value); }}>
            {thinkingRunOption.nullable && <option value="">Use app default</option>}
            {(thinkingRunOption.allowedValues ?? []).map((choice) => <option key={String(choice.value)} value={String(choice.value)}>{choice.label}</option>)}
          </select>
        </label>
      ) : null}
      {canShowSessionControls && linkedConsoleSession ? (
        <SessionControls
          sessionId={linkedConsoleSession.id}
          runOptions={sessionRunOptions}
          allowedTools={linkedConsoleSession.allowed_tools}
          hiddenOptionIds={[modelRunOption?.id, thinkingRunOption?.id, permissionRunOption?.id].filter((id): id is string => Boolean(id))}
        />
      ) : null}
    </>
  );

  const composerOverlay = isReadOnlyChild ? (
        <div className="conv-compose conv-compose--readonly" data-detail-pane-overlay-visual>
          <span>Read-only subagent transcript</span>
        </div>
      ) : ((controlPresentation && controlPresentation.composer !== 'hidden')
        || creationReceipt?.state === 'starting'
        || (creationReceipt?.state === 'ready' && !controlPresentation)) ? (
      <div className="conv-compose" data-detail-pane-overlay-visual>
        {draftAttachments.length > 0 && (
          <OverflowFade direction="horizontal" className="conv-compose__attachment-overflow">
            <div className="conv-compose__attachments" aria-label="Draft attachments">
              {draftAttachments.map((attachment, index) => {
                const label = attachment.kind === 'annotation' ? `Annotation ${attachment.ordinal}` : attachment.file.name;
                return <div className={`conv-compose__attachment${attachment.kind === 'annotation' && highlightedAttachmentIds.has(attachment.id) ? ' conv-compose__attachment--new' : ''}`} key={`${attachment.kind}:${attachment.kind === 'annotation' ? attachment.id : attachment.file.id}:${index}`}>
                  <button type="button" className="conv-compose__attachment-body" title={label} onClick={() => setAttachmentPreview(attachment)}>
                    <span aria-hidden="true">{attachment.kind === 'annotation' ? '✎' : attachment.kind === 'image' ? '▧' : '▤'}</span>
                    <span className="conv-compose__attachment-name">{label}</span>
                  </button>
                  <button type="button" className="conv-compose__attachment-remove" aria-label={`Remove ${label}`} title={`Remove ${label}`}
                    disabled={Boolean(submitIntent)} onClick={() => { const result = removeDraftAttachment(conversationId, index); if (!result.ok) setContinueError(result.error); }}>×</button>
                </div>;
              })}
            </div>
          </OverflowFade>
        )}
        <form id={`conversation-compose-${conversation.id}`} className="conv-compose__form" onSubmit={handleContinueSubmit}>
          <textarea
            className="conv-compose__input"
            value={continueDraft}
            onInput={(event) => { const result = setDraftText(conversationId, event.currentTarget.value); if (!result.ok) setContinueError(result.error); }}
            onKeyDown={handleComposerKeyDown}
            placeholder="Message..."
            disabled={continueBusy
              || submitIntent?.state === 'uncertain'
              || (Boolean(continueDisabledReason) && creationReceipt?.state !== 'starting')}
            rows={3}
          />
        </form>
        {(control?.capability.kind === 'blocked-external'
          || control?.capability.kind === 'blocked-ownership-unknown') && (
          <div className="conv-compose__actions">
            {conversation.external_navigation && (
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={() => { void handleOpenExternally(); }}
              >
                {conversation.external_navigation.label}
              </button>
            )}
          </div>
        )}
        <div className="conv-compose__controls">
          <input ref={attachmentPickerRef} type="file" multiple hidden
            accept="text/*,image/png,image/jpeg,image/webp,image/gif,.js,.jsx,.ts,.tsx,.json,.yaml,.yml,.toml,.py,.rs,.go,.sh,.sql,.md,.txt"
            onChange={(event) => { importFiles(event.currentTarget.files ?? []); event.currentTarget.value = ''; }} />
          <button type="button" className="conv-compose__add-attachment" aria-label="Add attachments" title="Add attachments"
            disabled={!canImportAttachments || attachmentBusy} onClick={() => attachmentPickerRef.current?.click()}>+</button>
          <div
            ref={runOptionsGeometry.containerRef}
            className={`conv-compose__runtime${runOptionsGeometry.overflowed ? ' conv-compose__runtime--run-options-overflow' : ''}`}
          >
            {hasRunOptions ? (
              <div
                ref={runOptionsGeometry.contentRef}
                className="conv-compose__run-options-inline"
                aria-label="Run options"
                aria-hidden={runOptionsGeometry.overflowed ? 'true' : undefined}
                inert={runOptionsGeometry.overflowed || undefined}
              >
                {renderRunOptionFields()}
              </div>
            ) : null}
            <span ref={runOptionsGeometry.fixedRef} className="conv-compose__runtime-actions">
              {hasRunOptions ? (
                <button
                  ref={runOptionsTriggerRef}
                  type="button"
                  className="btn btn--ghost btn--sm conv-compose__run-options-trigger"
                  data-overflow-trigger
                  aria-haspopup="dialog"
                  aria-expanded={composerControlsOpen}
                  aria-label="Run options"
                  title="Run options"
                  onClick={() => setComposerControlsOpen((prev) => !prev)}
                >
                  <HorizontalDotsIcon />
                </button>
              ) : null}
              <ContextUsageRing usage={usageSummary} size="sm" onClick={openUsage} />
              <button
                type="submit"
                form={`conversation-compose-${conversation.id}`}
                className="chat-circle-action conv-compose__send"
                disabled={continueBusy || attachmentBusy || Boolean(submitIntent) || (Boolean(continueDisabledReason) && creationReceipt?.state !== 'starting') || (!continueDraft.trim() && !draftAttachments.length)}
                title={controlPresentation?.submitLabel ?? 'Send'}
                aria-label={controlPresentation?.submitLabel ?? 'Send'}
              >
                {continueBusy ? <span aria-hidden="true">…</span> : <ChatComposerSubmitIcon />}
              </button>
            </span>
          </div>
        </div>
        {composerControlsOpen && hasRunOptions && (
          <div
            ref={runOptionsMenuRef}
            className="conv-compose__run-options app-anchored-menu"
            role="dialog"
            aria-label="Run options"
            popover="manual"
            style={runOptionsMenuStyle}
          >
            {renderRunOptionFields()}
          </div>
        )}
        {continueDisabledReason && creationReceipt?.state !== 'starting' && (
          <div className="conv-compose__status">
            {continueDisabledReason}
          </div>
        )}
        {continueError && <div className="conv-compose__status conv-compose__status--error" role="alert">{continueError}</div>}
        {(submitIntent?.state === 'uncertain' || (submitIntent?.state === 'failed' && !controlFailure?.retryable)) && (
          <button type="button" className="btn btn--ghost btn--sm" onClick={retrySubmitIntent}>
            Retry message
          </button>
        )}
        <DetailPaneModal open={Boolean(attachmentPreview)} onClose={() => setAttachmentPreview(null)}
          titleId="chat-attachment-preview-title" title={attachmentPreview?.kind === 'annotation' ? `Annotation ${attachmentPreview.ordinal}` : attachmentPreview?.file.name ?? 'Attachment'}
          closeLabel="Close attachment preview" className="conv-compose__preview-modal" panelClassName="conv-compose__preview">
          {attachmentPreview?.kind === 'annotation' ? <>
            <p>{attachmentPreview.text}</p>
            <p>{attachmentPreview.target.url}</p>
            {attachmentPreview.screenshot && <img src={attachmentContentUrl(attachmentPreview.screenshot)} alt={`Screenshot for annotation ${attachmentPreview.ordinal}`} />}
          </> : attachmentPreview?.kind === 'image' ? <img src={attachmentContentUrl(attachmentPreview.file)} alt={attachmentPreview.file.name} />
            : <pre>{attachmentPreviewText ?? 'Loading preview…'}</pre>}
        </DetailPaneModal>
      </div>
      ) : null;

  const controlFailureNotice = controlFailure ? (
    <ChatFailureNotice
      failure={controlFailure}
      busy={continueBusy}
      onRetry={controlFailure.retryable && submitIntent?.state === 'failed' ? retrySubmitIntent : undefined}
    />
  ) : null;

  const creationNotice = creationReceipt?.error ? (
    <ChatFailureNotice
      failure={chatSpawnFailureNotice(creationReceipt.error)}
      onRetry={creationReceipt.error.retryable ? onRetryCreation : undefined}
    />
  ) : undefined;

  const actionErrorNotice = toast?.type === 'error' || continueError || runOptionsError ? (
    <DetailPaneNotice
      severity="error"
      density="compact"
      title={runOptionsError && toast?.type !== 'error' && !continueError ? 'Chat run options unavailable' : 'Chat action failed'}
      actions={<button type="button" className="btn btn--ghost btn--sm" onClick={() => { setToast(null); setContinueError(null); setRunOptionsError(null); }}>Dismiss</button>}
    >
      {toast?.type === 'error' ? toast.message : continueError ?? (runOptionsError ? `Run options could not be loaded: ${runOptionsError}` : null)}
    </DetailPaneNotice>
  ) : null;

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
    <ChatDetailFrame
      state="conversation"
      className={sidebarCollapsed ? 'conv-detail--sidebar-collapsed' : undefined}
      headerRef={headerRef}
      header={detailHeader}
      subheader={parentLink}
      overlayControl={composerOverlay}
      overlays={detailOverlays}
      ariaBusy={loading}
      onDragOverCapture={handleFileDragOver}
      onDropCapture={handleFileDrop}
      notice={controlFailureNotice || creationNotice || actionErrorNotice || externalNotice || loadErrorNotice ? <>
        {controlFailureNotice}
        {creationNotice}
        {actionErrorNotice}
        {externalNotice}
        {loadErrorNotice}
      </> : null}
    >
      <div className="conv-transcript">
        <ChatEntityLinkBoundary
          defaultAction={chatEntityLinkAction}
          onPreview={previewInRightSidebar}
        >
          <ChatSurface
            events={chatEvents}
            streaming={providerStreaming}
            showEmpty={Boolean(windowQuery.isSuccess && !loading && !error
              && aggregateQuery.data?.total === 0)}
            emptyLabel={error
                ? 'Conversation content unavailable.'
                : 'No messages yet'}
            transcript={transcriptConsumer}
            unmaterializedAfterCount={transcriptConsumer?.unmaterializedAfterCount ?? 0}
            onJumpToLatest={handleJumpToLatest}
            jumpingToLatest={jumpingToLatest}
            navigationTarget={navigationTarget}
            onNavigationResult={handleNavigationResult}
            onFork={handleFork}
            onCreatedTaskNavigate={navigateToCreatedTask}
            onExpandDetails={handleExpandConversationDetails}
            sessionInfo={{
              sessionId: conversation.session_id,
              backend: conversation.source,
              model: conversation.model ?? undefined,
            }}
          />
        </ChatEntityLinkBoundary>
      </div>
    </ChatDetailFrame>
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
  onOpenExternally,
  onToggleArchived,
  reorder,
}: {
  entry: ChatEntry;
  isSelected: boolean;
  onClick: () => void;
  onTogglePin?: () => void;
  pinned?: boolean;
  pinActionRef?: (element: HTMLButtonElement | null) => void;
  onEditTags?: (tags: string[]) => void;
  onRenameSession?: (label: string | null) => void;
  onOpenExternally?: () => void;
  onToggleArchived?: () => void;
  reorder?: SidebarReorderBinding;
}): JSX.Element {
  const conversation = entry.conversation;
  const session = entry.session;
  const isSubAgent = !!conversation?.parent_conversation_id;
  const source = conversation?.source ?? (session ? sourceFromSession(session) : null);
  const providerLabel = source ? SIDEBAR_PROVIDER_LABELS[source] : null;
  const title = conversation ? getConversationTitle(conversation) : getConsoleSessionTitle(session);
  const canShowActions = Boolean(onTogglePin || onEditTags || onRenameSession || onOpenExternally || onToggleArchived);
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
  if (onOpenExternally) {
    overflowActions.push({ id: 'open-externally', label: 'Open externally', onSelect: onOpenExternally });
  }
  if (onEditTags) {
    overflowActions.push({ id: 'edit-tags', label: 'Edit tags', onSelect: handleEditTags });
  }
  if (onRenameSession) {
    overflowActions.push({ id: 'rename-session', label: 'Rename session', onSelect: handleRenameSession });
  }
  if (onToggleArchived) {
    overflowActions.push({
      id: conversation?.archived_at ? 'unarchive' : 'archive',
      label: conversation?.archived_at ? 'Unarchive' : 'Archive',
      onSelect: onToggleArchived,
    });
  }

  return (
    <SidebarItemRow
      label={title}
      selectionLabel={`Open ${entry.kind === 'conversation' ? 'conversation' : 'session'} ${title}`}
      provider={providerLabel && source ? { label: providerLabel, mark: CHAT_PROVIDER_MARKS[source] } : undefined}
      selected={isSelected}
      ariaCurrent={isSelected ? 'true' : undefined}
      className={`chat-history-item${isSubAgent ? ' chat-history-item--subagent' : ''}`}
      reorder={reorder}
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
  notice,
  onNavigateConversation,
}: {
  session: ConsoleSession;
  notice?: ComponentChildren;
  onNavigateConversation: (conversationId: string) => void;
}): JSX.Element {
  const queryClient = useQueryClient(appQueryClient);
  const [viewMode, setViewMode] = useState<ViewMode>('rich');
  const [control, setControl] = useState<ConversationControlSnapshot | null>(null);
  const [createdTaskError, setCreatedTaskError] = useState<string | null>(null);
  const navigateToCreatedTask = useCallback(async (providerSessionId: string) => {
    try {
      const target = await resolveProviderSessionConversation(providerSessionId);
      if (target) {
        setCreatedTaskError(null);
        onNavigateConversation(target.id);
      } else {
        setCreatedTaskError('Created task conversation is not available yet.');
      }
    } catch (error) {
      setCreatedTaskError(error instanceof Error ? error.message : String(error));
    }
  }, [onNavigateConversation]);
  const providerSessionId = session.provider_session_id ?? '';
  const sessionConversationQuery = useQuery({
    queryKey: conversationKeys.bySession(providerSessionId),
    queryFn: ({ signal }) => getConversations({ session_id: providerSessionId, limit: 1, signal }),
    enabled: Boolean(providerSessionId),
  }, queryClient);
  const linkedConversationId = sessionConversationQuery.data?.conversations[0]?.id ?? '';
  const latestTarget = useMemo(() => normalizeWindowTarget({ target: 'latest', limit: 1 }), []);
  const latestWindowQuery = useQuery({
    queryKey: conversationKeys.window(linkedConversationId, latestTarget),
    queryFn: ({ signal }) => getConversationWindow(linkedConversationId, windowRequest(latestTarget, signal)),
    enabled: Boolean(linkedConversationId),
  }, queryClient);
  const messageAnchor = useMemo(() => {
    const blocks = latestWindowQuery.data?.blocks ?? [];
    for (let index = blocks.length - 1; index >= 0; index -= 1) {
      if (blocks[index].dag_uuid) return blocks[index].dag_uuid ?? null;
    }
    return null;
  }, [latestWindowQuery.data]);

  useEffect(() => {
    if (!linkedConversationId) {
      setControl(null);
      return undefined;
    }
    let active = true;
    void getConversationControl(linkedConversationId)
      .then((snapshot) => {
        if (!active) return;
        setControl(snapshot);
      })
      .catch(() => {
        if (!active) return;
        setControl(null);
      });
    return () => { active = false; };
  }, [linkedConversationId]);

  useEffect(() => {
    if (!control) return undefined;
    const client = acquireSharedSse();
    const offControlUpdated = client.on('conversation:control-updated', (payload) => {
      const snapshot = payload as unknown as ConversationControlSnapshot;
      if (snapshot.conversation_id === control.conversation_id) setControl(snapshot);
    });
    client.connect();
    return () => { offControlUpdated(); client.close(); };
  }, [control?.conversation_id]);

  const detailHeader = (
    <DetailPaneHeader
      variant="compact"
      title={session.label || 'Untitled session'}
      titleTooltip={session.label || 'Untitled session'}
      metadata={session.identity_mismatch ? (
        <span
          className="chat-live-detail__identity-warning"
          title={session.identity_mismatch.message}
        >
          ⚠ identity mismatch
        </span>
      ) : undefined}
    />
  );

  return (
    <ChatDetailFrame
      state="live-session"
      className="chat-live-detail"
      bodyClassName="chat-live-detail__pane"
      header={detailHeader}
      notice={notice || createdTaskError ? <>
        {notice}
        {createdTaskError ? (
          <DetailPaneNotice severity="error" density="compact" title="Could not open created task">
            {createdTaskError}
          </DetailPaneNotice>
        ) : null}
      </> : null}
    >
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
        onCreatedTaskNavigate={navigateToCreatedTask}
        isVisible
        viewMode={viewMode}
        onViewModeChange={setViewMode}
        channelEnabled={!!session.channel_enabled}
        workspaceMode
      />
    </ChatDetailFrame>
  );
}

// ── Main View ──

export function ConversationsView({
  consoleSessions,
  initialConversationId,
  initialSessionId,
  sidebarHidden = false,
  sidebarGroupLimit: rawSidebarGroupLimit,
  chatEntityLinkAction = 'preview',
  instance = null,
  onSelectSession,
  onNewConversation,
}: ConversationsViewProps): JSX.Element {
  const queryClient = useQueryClient(appQueryClient);
  const [chatViewState, setChatViewState] = useChatViewState();
  const [selection, setSelection] = useState<ChatSelection>(() => (
    initialConversationId
      ? { type: 'conversation', id: initialConversationId }
      : initialSessionId
        ? { type: 'session', id: initialSessionId }
        : chatViewState.lastSelection
  ));
  const handleNavigateConversation = useCallback((conversationId: string, target?: ConversationAnchor) => {
    setSelection((current) => current?.type === 'conversation' && current.id === conversationId
      ? current
      : { type: 'conversation', id: conversationId });
    const nextHash = hashWithAgentSession(
      target
        ? conversationAnchorHref(conversationId, target)
        : `#/console?conversation=${encodeURIComponent(conversationId)}`,
      getAgentPageBinding(),
    );
    if (window.location.hash !== nextHash) window.location.hash = nextHash;
  }, []);
  const detailPortalRef = useRef<HTMLDivElement>(null);
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
  const conversationLifecycle = chatViewState.conversationLifecycle;
  const [retainedSelection, setRetainedSelection] = useState<ConversationSidebarConversation | null>(null);
  const [shownProjects, setShownProjects, shownProjectsState] = useChatProjectSelection();
  const sidebarOrder = useSidebarOrderPreference();
  const sidebarGroupLimit = normalizeSidebarGroupLimit(rawSidebarGroupLimit);
  const [canonicalProjects, setCanonicalProjects] = useState<CanonicalProject[]>([]);
  const [canonicalProjectsReady, setCanonicalProjectsReady] = useState(false);
  const [canonicalProjectsLoaded, setCanonicalProjectsLoaded] = useState(false);
  const [visibleTargets, setVisibleTargets] = useState<Map<string, number>>(new Map());
  const [continuationRequests, setContinuationRequests] = useState<Array<{
    group: string;
    cursor: string;
    filters: ConversationSidebarFilters;
  }>>([]);
  const [sidebarToast, setSidebarToast] = useState<ToastState>(null);
  const [newChatDraft, setNewChatDraft] = useState<NewChatDraft | null>(null);
  const acceptedConversationId = newChatDraft?.state === 'accepted' ? newChatDraft.conversationId : null;
  const acceptedSpawnState = newChatDraft?.state === 'accepted' ? newChatDraft.spawn.state : null;
  const reconcileCreationReceipt = useCallback((spawn: ConversationSpawnReceipt) => {
    setNewChatDraft((current) => current ? reduceNewChatDraft(current, { type: 'observe', spawn }) : current);
  }, []);

  useEffect(() => {
    if (!acceptedConversationId || (acceptedSpawnState !== 'starting' && acceptedSpawnState !== 'stopping')) {
      return undefined;
    }
    let active = true;
    let timer: number | null = null;
    const refresh = () => {
      void getProviderChat(acceptedConversationId)
        .then((spawn) => {
          if (!active) return;
          reconcileCreationReceipt(spawn);
          if (spawn.state === 'starting' || spawn.state === 'stopping') {
            timer = window.setTimeout(refresh, 500);
          }
        })
        .catch(() => {
          if (active) timer = window.setTimeout(refresh, 500);
        });
    };
    refresh();
    return () => {
      active = false;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [acceptedConversationId, acceptedSpawnState, reconcileCreationReceipt]);
  useEffect(() => {
    const client = acquireSharedSse();
    const offSpawn = client.on('conversation-spawn:updated', (payload) => {
      const update = eventData<{ spawn?: ConversationSpawnReceipt }>(payload);
      if (update?.spawn) reconcileCreationReceipt(update.spawn);
      void queryClient.invalidateQueries({ queryKey: conversationKeys.sidebars() });
    });
    client.connect();
    return () => {
      offSpawn();
      client.close();
    };
  }, [queryClient, reconcileCreationReceipt]);
  const targetsRef = useRef(visibleTargets);
  targetsRef.current = visibleTargets;
  const previousGroupLimitRef = useRef(sidebarGroupLimit);
  const pinActionRefs = useRef(new Map<string, HTMLButtonElement>());
  const pendingPinFocusKey = useRef<string | null>(null);
  const pendingPinIntents = useRef(new Map<string, boolean>());

  useEffect(() => {
    let active = true;
    let loadingProjects = false;
    const loadProjects = async () => {
      if (loadingProjects) return;
      loadingProjects = true;
      try {
        const projects = await listCanonicalProjects();
        if (!active) return;
        setCanonicalProjects(projects);
        setCanonicalProjectsLoaded(true);
        setCanonicalProjectsReady(true);
      } catch {
        if (!active) return;
        // Keep the last good registry snapshot visible while authentication or
        // the daemon reconnects; an empty response is not authoritative here.
        setCanonicalProjectsReady(true);
      } finally {
        loadingProjects = false;
      }
    };
    const reloadWhenVisible = () => {
      if (document.visibilityState === 'visible') void loadProjects();
    };
    const unsubscribeAuth = subscribeClientAccessState((state) => {
      if (state.phase === 'ready') void loadProjects();
    });
    window.addEventListener('focus', reloadWhenVisible);
    document.addEventListener('visibilitychange', reloadWhenVisible);
    void loadProjects();
    return () => {
      active = false;
      unsubscribeAuth();
      window.removeEventListener('focus', reloadWhenVisible);
      document.removeEventListener('visibilitychange', reloadWhenVisible);
    };
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
  const previewMutationsRejected = Boolean(instance && instance.allowed_effects?.includes('ledger:write') !== true);
  const isConversationPinned = useCallback((conversation: Conversation): boolean => {
    if (sidebarOrder.value.pinnedConversationIds !== null) {
      return sidebarOrder.value.pinnedConversationIds.includes(conversation.id);
    }
    if (!previewMutationsRejected) return conversation.starred;
    return Object.prototype.hasOwnProperty.call(chatViewState.previewPinOverrides, conversation.id)
      ? chatViewState.previewPinOverrides[conversation.id]
      : conversation.starred;
  }, [chatViewState.previewPinOverrides, previewMutationsRejected, sidebarOrder.value.pinnedConversationIds]);

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
    if (!selection || selection.type === 'draft') return;
    setChatViewState((current) => (
      current.lastSelection?.type === selection.type && current.lastSelection.id === selection.id
        ? current
        : { ...current, lastSelection: selection }
    ));
  }, [selection, setChatViewState]);

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
    const sessionLookupKey = conversationKeys.bySession(sessionLookupId);

    const resolveConversation = (attemptsRemaining: number) => {
      void queryClient.fetchQuery({
        queryKey: sessionLookupKey,
        queryFn: ({ signal }) => getConversations({ session_id: sessionLookupId, limit: 1, signal }),
        staleTime: 0,
      })
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
      void queryClient.cancelQueries({ queryKey: sessionLookupKey, exact: true });
      if (retryTimer !== null) {
        window.clearTimeout(retryTimer);
      }
    };
  }, [consoleSessions, initialConversationId, initialSessionId, onSelectSession, queryClient]);

  const registeredProjects = useMemo(() => registeredChatProjects(canonicalProjects), [canonicalProjects]);

  useEffect(() => {
    if (!canonicalProjectsLoaded || !shownProjectsState.ready) return;
    const reconciled = reconcileShownProjects(shownProjects, canonicalProjects);
    const unchanged = reconciled.length === shownProjects.length
      && reconciled.every((shown, index) => (
        shown.projectId === shownProjects[index].projectId
        && shown.checkoutId === shownProjects[index].checkoutId
      ));
    if (unchanged) return;
    setShownProjects(reconciled);
  }, [canonicalProjects, canonicalProjectsLoaded, setShownProjects, shownProjects, shownProjectsState.ready]);

  const selectedProjectIds = useMemo(() => {
    if (!canonicalProjectsReady || !shownProjectsState.ready) return [];
    if (!canonicalProjectsLoaded) {
      return [...new Set(shownProjects.map((shown) => shown.projectId))];
    }
    const registeredSelections = new Set(registeredProjects.map((project) => (
      `${project.id}\0${project.checkoutId}`
    )));
    return [...new Set(shownProjects
      .filter((shown) => registeredSelections.has(`${shown.projectId}\0${shown.checkoutId}`))
      .map((shown) => shown.projectId))];
  }, [canonicalProjectsLoaded, canonicalProjectsReady, registeredProjects, shownProjects, shownProjectsState.ready]);

  const sidebarRequestParams = useCallback((limit: number, projectIds = selectedProjectIds) => {
    return buildConversationSidebarFilters({
      limit,
      projectIds,
      lifecycle: conversationLifecycle,
      pinnedConversationIds: sidebarOrder.value.pinnedConversationIds,
      previewPinOverrides: chatViewState.previewPinOverrides,
      previewMutationsRejected,
      sourceFilter,
      starredOnly,
      hideEmpty,
      search,
      searchMode,
      sort,
    });
  }, [chatViewState.previewPinOverrides, conversationLifecycle, hideEmpty, previewMutationsRejected, selectedProjectIds, sidebarOrder.value.pinnedConversationIds, sourceFilter, starredOnly, sort, search, searchMode]);

  const registerInitialSidebarLoad = useRegisterInitialRouteLoad();
  const sidebarFiltersJson = JSON.stringify(sidebarRequestParams(sidebarGroupLimit));
  const sidebarFilters = useMemo(
    () => JSON.parse(sidebarFiltersJson) as ConversationSidebarFilters,
    [sidebarFiltersJson],
  );
  // A preference outage must not blank the entire Chat sidebar. Until the
  // per-user order is available, render the durable conversation projection
  // with its legacy starred grouping and keep reordering disabled.
  const sidebarEnabled = canonicalProjectsReady && shownProjectsState.ready;
  const sidebarQueryKey = useMemo(() => conversationKeys.sidebarInitial(sidebarFilters), [sidebarFilters]);
  const fetchSidebarInitial = useCallback(
    ({ signal }: { signal: AbortSignal }) => {
      const initialLoad = getConversationSidebar({ ...sidebarFilters, signal });
      registerInitialSidebarLoad(initialLoad);
      return initialLoad;
    },
    [registerInitialSidebarLoad, sidebarFilters],
  );
  const sidebarQuery = useQuery({
    queryKey: sidebarQueryKey,
    queryFn: fetchSidebarInitial,
    enabled: sidebarEnabled,
    staleTime: WARMED_CHAT_QUERY_STALE_TIME_MS,
  }, queryClient);
  const [continuationCacheRevision, setContinuationCacheRevision] = useState(0);
  useEffect(() => queryClient.getQueryCache().subscribe((event) => {
    if (event.query.queryKey[0] === 'chat' && event.query.queryKey[1] === 'sidebar') {
      setContinuationCacheRevision((revision) => revision + 1);
    }
  }), [queryClient]);
  useEffect(() => {
    if (!sidebarEnabled) return undefined;
    const keys = continuationRequests.map((request) => {
      const queryKey = conversationKeys.sidebarPage(request.filters, request.group, request.cursor);
      void queryClient.fetchQuery({
        queryKey,
        queryFn: ({ signal }) => getConversationSidebar({
          ...request.filters,
          group_key: request.group,
          cursor: request.cursor,
          signal,
        }),
      });
      return queryKey;
    });
    return () => {
      for (const queryKey of keys) void queryClient.cancelQueries({ queryKey, exact: true });
    };
  }, [continuationRequests, queryClient, sidebarEnabled]);
  const continuationPages = continuationRequests.flatMap((request) => {
    const data = queryClient.getQueryData<import('../api').ConversationSidebarResponse>(
      conversationKeys.sidebarPage(request.filters, request.group, request.cursor),
    );
    return data ? [data] : [];
  });
  const serverGroups = useMemo(
    () => mergeSidebarPages(sidebarQuery.data, continuationPages),
    [continuationCacheRevision, sidebarQuery.data],
  );
  const sidebarLoaded = sidebarQuery.isSuccess;
  const loading = sidebarQuery.isFetching;
  const loadingMoreKeys = new Set(continuationRequests.flatMap((request) => (
    queryClient.getQueryState(conversationKeys.sidebarPage(request.filters, request.group, request.cursor))?.fetchStatus === 'fetching'
      ? [request.group]
      : []
  )));

  useEffect(() => {
    if (!sidebarQuery.data) return;
    setVisibleTargets((current) => {
      const next = new Map(current);
      for (const group of serverGroups) {
        if (!next.has(group.key)) next.set(group.key, sidebarGroupLimit);
      }
      return next.size === current.size ? current : next;
    });
    setContinuationRequests((current) => {
      let next = current;
      for (const group of serverGroups) {
        const target = targetsRef.current.get(group.key) ?? sidebarGroupLimit;
        if (group.conversations.length >= target || !group.next_cursor) continue;
        if (next.some((request) => request.group === group.key && request.cursor === group.next_cursor)) continue;
        if (next === current) next = [...current];
        next.push({ group: group.key, cursor: group.next_cursor, filters: sidebarFilters });
      }
      return next;
    });
  }, [serverGroups, sidebarFilters, sidebarGroupLimit, sidebarQuery.data]);

  useEffect(() => {
    if (!sidebarQuery.error) return;
    setSidebarToast({ message: 'Chats could not be refreshed.', type: 'error' });
  }, [sidebarQuery.error]);

  useEffect(() => {
    setContinuationRequests((current) => current.length === 0 ? current : []);
  }, [sidebarFilters]);

  const fetchConversationGroups = useCallback(async (projectIds = selectedProjectIds) => {
    const filters = sidebarRequestParams(sidebarGroupLimit, projectIds) as ConversationSidebarFilters;
    await queryClient.fetchQuery({
      queryKey: conversationKeys.sidebarInitial(filters),
      queryFn: ({ signal }) => getConversationSidebar({ ...filters, signal }),
      staleTime: 0,
    });
  }, [queryClient, selectedProjectIds, sidebarGroupLimit, sidebarRequestParams]);

  const acceptedConversation = useMemo(() => newChatDraft?.state === 'accepted'
    ? conversationFromSpawn(newChatDraft.spawn, newChatDraft.placement)
    : null, [newChatDraft]);

  const conversationGroups = useMemo(() => {
    if (!acceptedConversation || newChatDraft?.state !== 'accepted') return serverGroups;
    let found = false;
    const reconciled = serverGroups.map((group) => ({
      ...group,
      conversations: group.conversations.map((conversation) => {
        if (conversation.id !== acceptedConversation.id) return conversation;
        found = true;
        return { ...acceptedConversation, ...conversation, spawn: newChatDraft.spawn };
      }),
    }));
    if (found) return reconciled;
    const projectId = newChatDraft.placement.kind === 'project' ? newChatDraft.placement.projectId : null;
    const targetIndex = reconciled.findIndex((group) => projectId
      ? group.kind === 'project' && group.project_id === projectId
      : group.kind === 'chats');
    if (targetIndex >= 0) {
      return reconciled.map((group, index) => index === targetIndex ? {
        ...group,
        total: group.total + 1,
        conversations: [acceptedConversation, ...group.conversations],
      } : group);
    }
    return [...reconciled, {
      key: projectId ? `accepted-project-${projectId}` : 'chats',
      kind: projectId ? 'project' as const : 'chats' as const,
      label: newChatDraft.placement.projectLabel,
      ...(projectId ? { project_id: projectId } : {}),
      total: 1,
      conversations: [acceptedConversation],
      next_cursor: null,
    }];
  }, [acceptedConversation, newChatDraft, serverGroups]);

  const selectedConversationSummary = selection?.type === 'conversation'
    ? conversationGroups.flatMap((group) => group.conversations).find((conv) => conv.id === selection.id)
      ?? (retainedSelection?.id === selection.id ? retainedSelection : null)
    : null;

  // Client-side title-only filter (when searchMode === 'title', server already
  // searched summary too, so we narrow here to title-only for the title mode).
  // When searchMode === 'full', server search is sufficient — show all results.
  const displayedConversations = useMemo(() => {
    const base = conversationGroups.map((group) => ({
      ...group,
      conversations: group.conversations.filter((conv) =>
        !isSubagentConversation(conv) && (!hideEmpty || conv.block_count > 0 || Boolean(conv.spawn))
      ),
    }));
    if (!search.trim() || searchMode === 'full') return base;
    const needle = search.trim().toLowerCase();
    return base.map((group) => ({
      ...group,
      conversations: group.conversations.filter((conv) => getConversationTitle(conv).toLowerCase().includes(needle)),
    }));
  }, [conversationGroups, hideEmpty, search, searchMode]);

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
    const selectedCheckoutByProject = new Map(shownProjects.flatMap((shown) => {
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
          key: conversation.spawn
            ? `conversation:${conversation.id}`
            : liveByProviderSession.has(conversation.session_id)
              ? `session:${liveByProviderSession.get(conversation.session_id)!.id}`
              : `conversation:${conversation.id}`,
          time: getConversationTime(conversation),
          kind: 'conversation',
          conversation,
          liveSession: conversation.spawn?.native_session_id
            ? liveSessions.find((session) => session.id === conversation.spawn?.native_session_id) ?? null
            : liveByProviderSession.get(conversation.session_id) ?? null,
        });
      }
    }
    const conversationProviderIds = new Set(
      displayedConversations.flatMap((group) => group.conversations.map((conversation) => conversation.session_id)),
    );
    const conversationLogicalIds = new Set(
      displayedConversations.flatMap((group) => group.conversations.map((conversation) => conversation.id)),
    );
    for (const session of liveSessions) {
      if (conversationLifecycle === 'archived') continue;
      if (isSubagentSession(session)) {
        continue;
      }
      if (conversationLogicalIds.has(session.id)
          || (session.provider_session_id && conversationProviderIds.has(session.provider_session_id))) {
        continue;
      }
      const canonicalProjectGroup = session.canonical_project_id
        && selectedProjectIds.includes(session.canonical_project_id)
        ? groups.find((group) => (
          group.kind === 'project' && group.canonicalProjectId === session.canonical_project_id
        ))
        : undefined;
      const group = session.pinned
        ? ensureKindGroup('pinned', 'Pinned')
        : canonicalProjectGroup ?? ensureKindGroup('chats', 'Chats');
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
          sidebarOrder.value.pinnedConversationIds ?? chatViewState.pinnedConversationIds,
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
        .sort((left, right) => shownProjects.findIndex((entry) => entry.projectId === left.canonicalProjectId)
          - shownProjects.findIndex((entry) => entry.projectId === right.canonicalProjectId)),
      chats: visibleGroups.find((group) => group.kind === 'chats') ?? null,
    };
  }, [chatViewState.pinnedConversationIds, conversationLifecycle, displayedConversations, isConversationPinned, liveByProviderSession, liveSessions, registeredProjects, selectedProjectIds, shownProjects, sidebarOrder.value.pinnedConversationIds, sort]);

  useEffect(() => {
    if (selection?.type !== 'session') return;
    const liveSession = liveSessions.find((session) => session.id === selection.id);
    if (!liveSession?.provider_session_id) return;
    const indexed = displayedConversations
      .flatMap((group) => group.conversations)
      .find((conversation) => conversation.session_id === liveSession.provider_session_id);
    if (indexed) handleNavigateConversation(indexed.id);
  }, [displayedConversations, handleNavigateConversation, liveSessions, selection]);

  useEffect(() => {
    if (sidebarOrder.value.pinnedConversationIds !== null) return;
    const effectivePinnedIds = displayedConversations
      .flatMap((group) => group.conversations)
      .filter((conversation) => pendingPinIntents.current.get(conversation.id) ?? isConversationPinned(conversation))
      .map((conversation) => conversation.id);
    setChatViewState((current) => {
      const reconciled = reconcileOrderedPinIds(current.pinnedConversationIds, effectivePinnedIds);
      return reconciled.length === current.pinnedConversationIds.length
        && reconciled.every((id, index) => id === current.pinnedConversationIds[index])
        ? current
        : { ...current, pinnedConversationIds: reconciled };
    });
  }, [displayedConversations, isConversationPinned, setChatViewState, sidebarOrder.value.pinnedConversationIds]);

  const firstChatEntry =
    chatSections.pinned?.entries[0] ??
    chatSections.projects[0]?.entries[0] ??
    chatSections.chats?.entries[0] ??
    null;
  const handleUnavailableConversation = useCallback((conversationId: string) => {
    if (initialConversationId) return;
    setSelection((current) => (
      current?.type === 'conversation' && current.id === conversationId ? null : current
    ));
  }, [initialConversationId]);
  const activeFilterCount = [
    sourceFilter !== 'all',
    starredOnly,
    !hideEmpty,
    sort !== 'date',
    searchMode !== 'title',
    conversationLifecycle !== 'active',
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
      setSelection((current) => current ?? { type: 'conversation', id: firstChatEntry.conversation!.id });
      return;
    }
    if (firstChatEntry.session) {
      setSelection((current) => current ?? { type: 'session', id: firstChatEntry.session!.id });
      onSelectSession(firstChatEntry.session.id);
    }
  }, [firstChatEntry, onSelectSession, selection]);

  const handleSelectSession = (sessionId: string) => {
    setSelection({ type: 'session', id: sessionId });
    const nextHash = hashWithAgentSession(
      `#/console?session=${encodeURIComponent(sessionId)}`,
      getAgentPageBinding(),
    );
    if (window.location.hash !== nextHash) window.location.hash = nextHash;
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
    queryClient.setQueriesData<import('../api').ConversationSidebarResponse>(
      { queryKey: conversationKeys.sidebars() },
      (current) => current ? {
        ...current,
        groups: current.groups.map((group) => ({
          ...group,
          conversations: group.conversations.map((conversation) => (
            conversation.id === updated.id ? { ...conversation, ...updated } : conversation
          )),
        })),
      } : current,
    );
    void fetchConversationGroups();
  };

  const showMore = useCallback((group: ChatProjectGroup) => {
    const currentTarget = targetsRef.current.get(group.key) ?? sidebarGroupLimit;
    const nextTarget = currentTarget + sidebarGroupLimit;
    const nextTargets = new Map(targetsRef.current).set(group.key, nextTarget);
    targetsRef.current = nextTargets;
    setVisibleTargets(nextTargets);
    if (group.entries.length >= nextTarget || !group.nextCursor) return;

    const filters = sidebarRequestParams(sidebarGroupLimit) as ConversationSidebarFilters;
    setContinuationRequests((current) => current.some((request) => (
      request.group === group.key && request.cursor === group.nextCursor
    )) ? current : [...current, { group: group.key, cursor: group.nextCursor!, filters }]);
  }, [sidebarGroupLimit, sidebarRequestParams]);

  const handleToggleEntryPin = async (entry: ChatEntry) => {
    if (!entry.conversation) return;
    if (!sidebarOrder.ready) {
      setSidebarToast({ message: sidebarOrder.notice ?? 'Sidebar order is still reconnecting.', type: 'error' });
      return;
    }
    const conversationId = entry.conversation.id;
    try {
      let current = sidebarOrder.value.pinnedConversationIds;
      if (current === null) {
        const first = await getConversations({ starred: true, exclude_subagents: true, limit: 200 });
        if (first.total > 1000) throw new Error('Too many legacy stars to migrate safely');
        const pages = await Promise.all(Array.from(
          { length: Math.ceil(first.total / 200) - 1 },
          (_, index) => getConversations({
            starred: true,
            exclude_subagents: true,
            limit: 200,
            offset: (index + 1) * 200,
          }),
        ));
        const legacyIds = [first, ...pages].flatMap((page) => page.conversations.map((conversation) => conversation.id));
        current = reconcileOrderedPinIds(chatViewState.pinnedConversationIds, legacyIds);
      }
      const pinned = !current.includes(conversationId);
      pendingPinIntents.current.set(conversationId, pinned);
      pendingPinFocusKey.current = entry.key;
      sidebarOrder.patch({
        pinnedConversationIds: pinned
          ? reconcileOrderedPinIds(current, [conversationId])
          : current.filter((id) => id !== conversationId),
      });
    } catch {
      setSidebarToast({ message: 'Pinned chats could not be migrated without losing unseen entries.', type: 'error' });
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

  const handleToggleArchived = async (entry: ChatEntry) => {
    if (!entry.conversation) return;
    const archived = !entry.conversation.archived_at;
    try {
      if (selection?.type === 'conversation' && selection.id === entry.conversation.id) {
        setRetainedSelection(entry.conversation);
      }
      await updateConversationArchive(entry.conversation.id, archived);
      await queryClient.invalidateQueries({ queryKey: conversationKeys.sidebars() });
      await fetchConversationGroups();
    } catch (error) {
      setSidebarToast({
        message: error instanceof Error ? error.message : `Chat could not be ${archived ? 'archived' : 'unarchived'}.`,
        type: 'error',
      });
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

  const handleOpenExternally = async (entry: ChatEntry) => {
    if (!entry.conversation?.external_navigation) return;
    try {
      await openConversationExternally(entry.conversation.id);
      setSidebarToast({ message: `${entry.conversation.external_navigation.label} requested.`, type: 'info' });
    } catch (error) {
      setSidebarToast({ message: error instanceof Error ? error.message : String(error), type: 'error' });
    }
  };

  const draftStartupController = useRef<AbortController | null>(null);
  const discardDraft = useCallback(() => {
    const draft = newChatDraft;
    if (draft?.state === 'starting') {
      void cancelProviderChat(draft.id, 1).then(() => fetchConversationGroups()).catch(() => undefined);
    }
    draftStartupController.current?.abort();
    draftStartupController.current = null;
    setNewChatDraft((draft) => draft ? reduceNewChatDraft(draft, { type: 'abandon' }) : null);
    setSelection((current) => current?.type === 'draft' ? null : current);
  }, [fetchConversationGroups, newChatDraft]);

  const startDraft = useCallback(async (provider: NewChatProvider, retry = false) => {
    const draft = newChatDraft;
    if (!draft || (retry ? draft.state !== 'failed' : draft.state !== 'choosing')) return;
    const starting = retry
      ? reduceNewChatDraft(draft, { type: 'retry' })
      : reduceNewChatDraft(draft, { type: 'choose', provider });
    if (starting.state !== 'starting') return;
    draftStartupController.current?.abort();
    const startupController = new AbortController();
    draftStartupController.current = startupController;
    const optimisticSpawn = optimisticConversationSpawn(starting);
    const accepted = reduceNewChatDraft(starting, {
      type: 'accepted',
      conversationId: starting.id,
      spawn: optimisticSpawn,
    });
    setNewChatDraft(accepted);
    setSelection({ type: 'conversation', id: starting.id });
    const nextHash = hashWithAgentSession(
      `#/console?conversation=${encodeURIComponent(starting.id)}`,
      getAgentPageBinding(),
    );
    if (window.location.hash !== nextHash) window.location.hash = nextHash;
    try {
      const result = await onNewConversation({
        idempotency_key: starting.id,
        provider: starting.provider,
        placement: starting.placement.kind === 'project'
          ? {
              kind: 'project',
              project_id: starting.placement.projectId!,
              checkout_id: starting.placement.checkoutId!,
            }
          : { kind: 'projectless' },
      }, startupController.signal);
      if (startupController.signal.aborted) return;
      if (result.conversation_id !== starting.id || result.spawn.reservation_id !== starting.id) {
        throw new Error('The server returned a different identity for the reserved chat.');
      }
      reconcileCreationReceipt(result.spawn);
    } catch (error) {
      if (startupController.signal.aborted) return;
      const failure = error instanceof ConversationSpawnApiError
        ? error.failure
        : {
            code: error instanceof ApiError ? error.code ?? 'spawn_request_failed' : 'spawn_request_failed',
            message: error instanceof Error ? error.message : 'The provider could not start.',
            retryable: false,
          };
      reconcileCreationReceipt({
        ...optimisticSpawn,
        state: 'failed',
        error: failure,
        updated_at: Date.now(),
      });
    } finally {
      if (draftStartupController.current === startupController) draftStartupController.current = null;
    }
  }, [newChatDraft, onNewConversation, reconcileCreationReceipt]);

  const openNewSession = (cwd?: string) => {
    const requested = cwd ? registeredProjects.find((project) => project.root === cwd) : null;
    if (cwd && !requested) {
      setSidebarToast({ message: 'Register a project checkout before starting a chat.', type: 'error' });
      return;
    }
    const id = crypto.randomUUID();
    setNewChatDraft({
      id,
      state: 'choosing',
      placement: {
        kind: requested ? 'project' : 'projectless',
        projectId: requested?.id ?? null,
        checkoutId: requested?.checkoutId ?? null,
        projectLabel: requested?.label ?? 'Chats',
      },
    });
    if (requested) {
      setShownProjects((current) => current.some((shown) => (
        shown.projectId === requested.id && shown.checkoutId === requested.checkoutId
      )) ? current : [...current, { projectId: requested.id, checkoutId: requested.checkoutId }]);
    }
    setSelection({ type: 'draft', id });
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
    if (!shownProjectsState.ready) {
      setSidebarToast({
        message: shownProjectsState.notice ?? 'Project selection is still reconnecting.',
        type: 'error',
      });
      return;
    }
    const project = registeredProjects.find((candidate) => (
      registeredProjectSelectionValue(candidate) === projectChooserSelection
    ));
    if (!project) return;
    const isNewProject = !selectedProjectIds.includes(project.id);
    setShownProjects((current) => {
      const nextSelection = { projectId: project.id, checkoutId: project.checkoutId };
      const existingIndex = current.findIndex((shown) => shown.projectId === project.id);
      if (existingIndex < 0) {
        return [...current, nextSelection];
      }
      if (current[existingIndex].checkoutId === project.checkoutId) return current;
      return current.map((shown, index) => index === existingIndex ? nextSelection : shown);
    });
    setProjectChooserOpen(false);
    if (isNewProject) {
      void fetchConversationGroups([...selectedProjectIds, project.id]);
    }
  };

  const pinnedReorder = useSidebarReorder({
    ids: sidebarOrder.value.pinnedConversationIds
      ?? chatSections.pinned?.entries.flatMap((entry) => entry.conversation ? [entry.conversation.id] : [])
      ?? [],
    disabled: !sidebarOrder.ready,
    label: (id) => getConversationTitle(chatSections.pinned?.entries.find((entry) => entry.conversation?.id === id)?.conversation),
    onCommit: (ids) => sidebarOrder.patch({ pinnedConversationIds: ids }),
  });
  const projectReorder = useSidebarReorder({
    ids: shownProjects.map((project) => project.projectId),
    disabled: !shownProjectsState.ready,
    label: (id) => registeredProjects.find((project) => project.id === id)?.label ?? id,
    onCommit: (ids) => setShownProjects((current) => ids.flatMap((id) => {
      const project = current.find((candidate) => candidate.projectId === id);
      return project ? [project] : [];
    })),
  });

  const renderEntry = (entry: ChatEntry, reorder?: SidebarReorderBinding) => (
    <ChatEntryItem
      key={entry.key}
      entry={entry}
      isSelected={entry.kind === 'conversation'
        ? selectedConversationId === entry.conversation?.id
          || (selectedSessionId !== null && selectedSessionId === entry.liveSession?.id)
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
      onOpenExternally={entry.conversation?.external_navigation
        ? () => { void handleOpenExternally(entry); }
        : undefined}
      onToggleArchived={entry.conversation ? () => { void handleToggleArchived(entry); } : undefined}
      reorder={reorder}
      onClick={() => {
        if (newChatDraft?.state === 'choosing') discardDraft();
        if (entry.kind === 'conversation' && entry.conversation) {
          handleNavigateConversation(entry.conversation.id, entry.conversation.search_target);
          setRetainedSelection(entry.conversation);
          return;
        }
        if (entry.session) {
          setRetainedSelection(null);
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
      <Toast toast={sidebarToast} onDismiss={() => setSidebarToast(null)} />
      <ViewSidebar
        {...VIEW_SIDEBAR_GEOMETRY.console}
        className="chat-history-sidebar"
        ariaLabel="Conversations"
        hidden={sidebarHidden}
        header={
          <>
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
                {conversationLifecycle === 'archived' && <span>Archived</span>}
              </>
            ) : undefined}
            panel={filterPanelOpen ? {
              variant: 'popover',
              children: (
                <>
                <div className="sidebar-search-filter__section">
                  <div className="sidebar-search-filter__label">Chats</div>
                  <div className="sidebar-search-filter__options">
                    {(['active', 'archived'] as const).map((lifecycle) => (
                      <button
                        key={lifecycle}
                        type="button"
                        className={`conv-filter-btn${conversationLifecycle === lifecycle ? ' conv-filter-btn--active' : ''}`}
                        onClick={() => setChatViewState((current) => ({ ...current, conversationLifecycle: lifecycle }))}
                      >
                        {lifecycle === 'active' ? 'Active' : 'Archived'}
                      </button>
                    ))}
                  </div>
                </div>
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
          {sidebarOrder.notice ? (
            <DetailPaneNotice
              severity="warning"
              density="compact"
              title="Sidebar order unavailable"
              testId="chat-sidebar-order-notice"
              actions={<button type="button" className="btn btn--ghost btn--sm" onClick={() => { void sidebarOrder.reload(); }}>Retry</button>}
            >
              {sidebarOrder.notice}
            </DetailPaneNotice>
          ) : null}
          {sidebarToast?.type === 'error' ? (
            <DetailPaneNotice
              severity="error"
              density="compact"
              title="Chat sidebar action failed"
              actions={<button type="button" className="btn btn--ghost btn--sm" onClick={() => setSidebarToast(null)}>Dismiss</button>}
            >
              {sidebarToast.message}
            </DetailPaneNotice>
          ) : null}
          </>
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
                  bodyAttributes={pinnedReorder.list}
                >
                  {pinnedReorder.assistive}
                  {group.entries.slice(0, target).map((entry) => renderEntry(
                    entry,
                    entry.conversation ? pinnedReorder.binding(entry.conversation.id) : undefined,
                  ))}
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
                action={{
                  label: 'Add project',
                  icon: <SidebarAddProjectIcon />,
                  onPress: openProjectChooser,
                  persistentWhenExpanded: chatSections.projects.length === 0,
                }}
                bodyAttributes={projectReorder.list}
              >
              {projectReorder.assistive}
              {projectChooserOpen ? (
                <div className="chat-project-chooser" role="group" aria-label="Choose a shown project">
                  <select aria-label="Registered project" value={projectChooserSelection} onInput={(event) => setProjectChooserSelection(event.currentTarget.value)}>
                    {registeredProjects.map((project) => (
                      <option key={project.id} value={registeredProjectSelectionValue(project)}>
                        {project.label}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    onClick={addShownProject}
                    disabled={!projectChooserSelection || !shownProjectsState.ready}
                  >
                    {shownProjectsState.ready ? 'Add' : 'Connecting…'}
                  </button>
                  <button type="button" onClick={() => setProjectChooserOpen(false)}>Cancel</button>
                </div>
              ) : null}
              {chatSections.projects.length === 0 && registeredProjects.length > 0 ? (
                <div className="sidebar-group-node__placeholder">No projects included</div>
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
                    reorder={group.canonicalProjectId ? projectReorder.binding(group.canonicalProjectId) : undefined}
                  >
                    {newChatDraft
                      && newChatDraft.state !== 'abandoned'
                      && newChatDraft.state !== 'accepted'
                      && newChatDraft.placement.kind === 'project'
                      && newChatDraft.placement.projectId === group.canonicalProjectId ? (
                        <SidebarItemRow
                          label="New chat"
                          selectionLabel="Open new chat draft"
                          selected={selection?.type === 'draft' && selection.id === newChatDraft.id}
                          ariaCurrent={selection?.type === 'draft' && selection.id === newChatDraft.id ? 'true' : undefined}
                          provider={newChatDraft.state === 'choosing'
                            ? undefined
                            : {
                                label: newChatDraft.provider === 'codex' ? 'Codex' : 'Claude',
                                mark: newChatDraft.provider === 'codex' ? 'openai' : 'anthropic',
                              }}
                          onSelect={() => setSelection({ type: 'draft', id: newChatDraft.id })}
                        />
                      ) : null}
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
                  {newChatDraft
                    && newChatDraft.state !== 'abandoned'
                    && newChatDraft.state !== 'accepted'
                    && newChatDraft.placement.kind === 'projectless' ? (
                      <SidebarItemRow
                        label="New chat"
                        selectionLabel="Open new chat draft"
                        selected={selection?.type === 'draft' && selection.id === newChatDraft.id}
                        ariaCurrent={selection?.type === 'draft' && selection.id === newChatDraft.id ? 'true' : undefined}
                        provider={newChatDraft.state === 'choosing'
                          ? undefined
                          : {
                              label: newChatDraft.provider === 'codex' ? 'Codex' : 'Claude',
                              mark: newChatDraft.provider === 'codex' ? 'openai' : 'anthropic',
                            }}
                        onSelect={() => setSelection((current) => current?.type === 'draft' && current.id === newChatDraft.id
                          ? current
                          : { type: 'draft', id: newChatDraft.id })}
                      />
                    ) : null}
                  {group.entries.slice(0, target).map((entry) => renderEntry(entry))}
                  {totalVisibleEntries === 0 && sidebarLoaded && !loading ? (
                    <div className="sidebar-group-node__placeholder">No chats</div>
                  ) : null}
                </SidebarGroupNode>
              );
            })() : null}
      </ViewSidebar>

      {/* Detail pane */}
      <div ref={detailPortalRef} className="chat-history-detail">
        {selection?.type === 'draft' && newChatDraft?.id === selection.id ? (
          <ChatDetailFrame
            state="draft"
            header={<DetailPaneHeader variant="compact" title="New chat" metadata={<span>{newChatDraft.placement.projectLabel}</span>} />}
            overlays={(
              <NewChatProviderPicker
                draft={newChatDraft}
                onChoose={(provider) => { void startDraft(provider); }}
                onRetry={() => {
                  if (newChatDraft.state === 'failed') void startDraft(newChatDraft.provider, true);
                }}
                onDiscard={discardDraft}
              />
            )}
          >
            <div className="chat-history-detail__empty" aria-hidden="true" />
          </ChatDetailFrame>
        ) : selection?.type === 'conversation' ? (
          <ConversationDetail
            conversationId={selection.id}
            initialConversation={selectedConversationSummary}
            anchor={conversationAnchorFromHash(window.location.hash)}
            onNavigate={handleNavigateConversation}
            consoleSessions={consoleSessions}
            sidebarCollapsed={false}
            chatEntityLinkAction={chatEntityLinkAction}
            creationReceipt={selectedConversationSummary?.spawn ?? null}
            onUnavailable={handleUnavailableConversation}
            onRetryCreation={selectedConversationSummary?.spawn?.error?.retryable ? () => {
              const spawn = selectedConversationSummary.spawn!;
              void retryProviderChat(spawn.reservation_id, spawn.attempt_count)
                .then(reconcileCreationReceipt);
            } : undefined}
          />
        ) : selection?.type === 'session' && selectedLiveSession ? (
          <LiveSessionDetail
            key={selectedLiveSession.id}
            session={selectedLiveSession}
            onNavigateConversation={handleNavigateConversation}
          />
        ) : (
          <ChatDetailFrame
            state="no-selection"
            header={<DetailPaneHeader variant="compact" title="Chat" />}
          >
            <div className="chat-history-detail__empty">
              No chats in this view
            </div>
          </ChatDetailFrame>
        )}
      </div>
    </div>
  );
}
