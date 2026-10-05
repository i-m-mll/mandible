import type { AuthRequest } from './views/auth';
import type { InboxData } from './views/inbox';
import type { IssueRepoSummary } from './views/issues';
import type { SessionIdentityMismatch } from './types/session';
import type { WorkBranch, WorkRepo } from './views/work';
import type { SSEPayload } from './sse-client';

type BugRef = {
  repo_id: string;
  issue_id: string;
};

type DaemonReloadInfo = {
  hash: string;
  summary: string;
  date: string;
  recentRequests?: Array<{ id: string; title: string }>;
  bugRefs?: BugRef[];
};

export type { BugRef };

// Bug: b949700 — Console tab: PTY session management type
type ConsoleSession = {
  id: string;
  label: string;           // display name — use this, NOT 'name'
  agent_type: 'operator' | 'claude' | 'codex' | 'gemini' | 'shell' | string;
  interaction_mode: 'inbox_only' | 'direct' | 'both';
  pinned: boolean;
  status: 'running' | 'stopped' | 'crashed';
  is_operator: boolean;
  provider_session_id: string | null;
  /** Reservation-backed canonical placement; never inferred from cwd. */
  canonical_project_id?: string | null;
  canonical_checkout_id?: string | null;
  owner_user_id?: string | null;
  owner?: {
    id: string;
    display_name: string;
    kind: 'human' | 'agent' | 'system' | 'external';
  } | null;
  command?: string;
  args?: string[];
  unread_count: number;
  created_at: number;
  started_at: number | null;
  stopped_at: number | null;
  backend_type: 'pty' | 'sdk' | 'spawn' | 'acp';
  transport_lane: 'sdk' | 'pty' | 'channel' | 'acp' | 'spawn';
  transport_badge?: {
    label: 'SDK' | 'PTY' | 'Channel' | 'ACP' | 'Spawn';
    title: string;
  };
  // Bug: b5e1c51 — Whether this PTY session has channel integration (Terminal + Events)
  channel_enabled?: boolean;
  // Issue 499c148 — set when this session's client token and its session
  // bindings resolve to different users.
  identity_mismatch?: SessionIdentityMismatch | null;
  allowed_tools?: string[] | null;
  mandible_session_id?: string | null;
  resume_at_message?: string | null;
  attention?: {
    session_id: string;
    kind: 'input_prompt' | 'running_output' | 'permission_menu' | 'hook_notification' | 'unknown';
    source: 'pty_screen' | 'pty_screen_fallback' | 'claude_hook';
    at: number;
    active: boolean;
    screen_excerpt: string;
    clear_conditions: string[];
    detail: {
      provider: ConsoleSession['agent_type'];
      confidence: 'high' | 'medium' | 'low';
      reason: string;
      matched?: string;
    };
    cleared_at?: number;
    cleared_by?:
      | 'screen_changed'
      | 'structured_stream_activity'
      | 'transcript_activity'
      | 'process_exit'
      | 'manual_clear';
  } | null;
  prompt_queue?: {
    pending_count: number;
    items: Array<{
      id: string;
      text: string;
      queued_at: number;
      blocked_by:
        | 'permission_menu'
        | 'hook_notification'
        | 'running_output'
        | 'unknown'
        | 'no_attention_state';
    }>;
    fallback_enabled: boolean;
    fallback_quiet_ms: number;
    last_flushed_at: number | null;
  } | null;
};

/**
 * `pinned` and `unread_count` are client-owned view state; the daemon never
 * sends them, so a fetched or freshly created session row may omit them.
 */
type ConsoleSessionPayload =
  Omit<ConsoleSession, 'pinned' | 'unread_count'>
  & Partial<Pick<ConsoleSession, 'pinned' | 'unread_count'>>;

export type { ConsoleSession, ConsoleSessionPayload };

type AppState = {
  authQueue: AuthRequest[];
  authHistory: AuthRequest[];
  selectedAuthId: string | null;
  workRepos: WorkRepo[];
  workBranches: Record<string, WorkBranch[]>;
  authOutputs: Record<string, string>;
  issueRepos: IssueRepoSummary[];
  daemonReload: DaemonReloadInfo | null;
  settings: Record<string, string>;
  settingsLoadError: string | null;
  inboxData: InboxData | null;
  inboxLoading: boolean;
  inboxLoadError: string | null;
  consoleSessions: ConsoleSession[];
  consoleActiveSessionId: string | null;
  consoleUnreadBadge: number;
  selectedInboxItemId: string | null;
};

type Action =
  | { type: 'setAuthQueue'; queue: AuthRequest[] }
  | { type: 'setAuthHistory'; history: AuthRequest[] }
  | { type: 'setSelectedAuthId'; id: string | null }
  | { type: 'upsertAuth'; request: AuthRequest }
  | { type: 'authOutput'; requestId: string; chunk: string }
  | {
      type: 'authResolved';
      requestId: string;
      status: string;
      resolved_at?: number;
      exit_code?: number | null;
      error?: string | null;
    }
  | { type: 'setWorkRepos'; repos: WorkRepo[] }
  | { type: 'setRepoBranches'; repoId: string; branches: WorkBranch[] }
  | { type: 'updateBranch'; repoId: string; branch: WorkBranch }
  | { type: 'setIssueRepos'; repos: IssueRepoSummary[] }
  | { type: 'setDaemonReload'; reload: DaemonReloadInfo | null }
  | { type: 'setSettings'; settings: Record<string, string> }
  | { type: 'setSettingsLoadError'; error: string | null }
  | { type: 'updateSetting'; key: string; value: string }
  | { type: 'setInboxData'; data: InboxData }
  | { type: 'setInboxLoading'; loading: boolean }
  | { type: 'setInboxLoadError'; error: string }
  | { type: 'ackInboxContinuation'; sessionId: string }
  | { type: 'ackInboxAuthResult'; requestId: string }
  | { type: 'ackInboxManagedReminderOccurrence'; occurrenceId: string }
  | { type: 'ackAllInboxItems' }
  | { type: 'setSelectedInboxItemId'; id: string | null }
  | { type: 'setConsoleSessions'; sessions: ConsoleSession[] }
  | { type: 'upsertConsoleSession'; session: ConsoleSession }
  | { type: 'removeConsoleSession'; sessionId: string }
  | { type: 'setConsoleActiveSessionId'; sessionId: string | null }
  | { type: 'setConsoleUnreadBadge'; count: number }
  | { type: 'incrementConsoleUnread'; sessionId: string }
  | { type: 'clearConsoleUnread'; sessionId: string };

type AppAction = Action | { type: 'sse'; payload: SSEPayload };

const AUTH_PROJECTION_EVENTS = new Set([
  'auth:new',
  'auth:updated',
  'auth:merged',
  'auth:resolved',
  'auth:finalized',
  'auth:lifecycle',
]);

export function authEventRequiresProjectionRefresh(type: string): boolean {
  return AUTH_PROJECTION_EVENTS.has(type);
}

const initialState: AppState = {
  authQueue: [],
  authHistory: [],
  selectedAuthId: null,
  workRepos: [],
  workBranches: {},
  authOutputs: {},
  issueRepos: [],
  daemonReload: null,
  settings: {},
  settingsLoadError: null,
  inboxData: null,
  inboxLoading: false,
  inboxLoadError: null,
  consoleSessions: [],
  consoleActiveSessionId: null,
  consoleUnreadBadge: 0,
  selectedInboxItemId: null,
};

function getAuthId(request: AuthRequest): string {
  return request.id || request.request_id || '';
}

function getBranchName(branch: WorkBranch): string {
  return branch.name || branch.branch || '';
}

function unwrapSseData(payload: SSEPayload): Record<string, unknown> | null {
  if (!payload.data || typeof payload.data !== 'object') {
    return null;
  }
  const data = payload.data as Record<string, unknown>;
  if (
    data.data &&
    typeof data.data === 'object' &&
    (typeof data.type === 'string' || typeof data.event === 'string')
  ) {
    return data.data as Record<string, unknown>;
  }
  return data;
}

function upsertById<T>(items: T[], getId: (item: T) => string, nextItem: T): T[] {
  const id = getId(nextItem);
  const index = items.findIndex((item) => getId(item) === id);
  if (index === -1) {
    return [nextItem, ...items];
  }
  const updated = items.slice();
  updated[index] = { ...updated[index], ...nextItem };
  return updated;
}

/**
 * Maximum retained streamed auth output per request, in characters. A merge can
 * emit a very long transcript; the console only shows the tail, so the reducer
 * keeps a bounded window rather than growing without limit.
 */
const MAX_AUTH_OUTPUT_CHARS = 262_144;

/** Strip ANSI escape sequences so streamed output stores clean display text. */
function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '');
}

/**
 * Extract the request id and text from an `auth:output` SSE payload.
 * Bug: f690657 — the payload shape is { type, data: { request_id, stream, text,
 * timestamp } }, so request_id and text are nested under `data`, not top-level.
 * Shared by the reducer and the app-level output coalescer so both agree on the
 * event shape.
 */
function parseAuthOutputEvent(payload: SSEPayload): { requestId: string; text: string } {
  const outputData =
    payload.data && typeof payload.data === 'object'
      ? (payload.data as Record<string, unknown>)
      : null;
  const requestId = String(outputData?.request_id ?? '');
  const text = String(outputData?.text ?? '');
  return { requestId, text };
}

/** Extract the request id from an `auth:resolved` SSE payload ('' if absent). */
function parseAuthResolvedId(payload: SSEPayload): string {
  const rd = (payload.data && typeof payload.data === 'object' ? payload.data : {}) as Record<
    string,
    unknown
  >;
  const rId = rd.request_id;
  return rId ? String(rId) : '';
}

function appReducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case 'sse':
      return applySSEEvent(state, action.payload);
    case 'setAuthQueue':
      return { ...state, authQueue: action.queue };
    case 'setAuthHistory':
      return { ...state, authHistory: action.history };
    case 'setSelectedAuthId':
      return { ...state, selectedAuthId: action.id };
    case 'upsertAuth': {
      const updated = upsertById(state.authQueue, getAuthId, action.request);
      return { ...state, authQueue: updated };
    }
    case 'authOutput': {
      const existing = state.authOutputs[action.requestId] || '';
      // Incremental ANSI-strip: strip only the appended chunk, not the whole
      // accumulated buffer, so streaming stays O(total) instead of O(n^2).
      let combined = `${existing}${stripAnsi(action.chunk)}`;
      // Bounded buffer: cap retained output so a very long merge cannot grow
      // the reducer state without limit. The console shows the tail, so drop
      // from the front when the cap is exceeded.
      if (combined.length > MAX_AUTH_OUTPUT_CHARS) {
        combined = combined.slice(combined.length - MAX_AUTH_OUTPUT_CHARS);
      }
      return {
        ...state,
        authOutputs: {
          ...state.authOutputs,
          [action.requestId]: combined,
        },
      };
    }
    case 'authResolved': {
      const updated = state.authQueue.map((request) => {
        const id = getAuthId(request);
        if (id !== action.requestId) {
          return request;
        }
        return {
          ...request,
          status: action.status,
          ...(action.resolved_at != null ? { resolved_at: action.resolved_at } : {}),
          ...(action.exit_code !== undefined ? { exit_code: action.exit_code } : {}),
          ...(action.error !== undefined ? { error: action.error } : {}),
        };
      });
      return { ...state, authQueue: updated };
    }
    case 'setWorkRepos':
      return { ...state, workRepos: action.repos };
    case 'setRepoBranches':
      return {
        ...state,
        workBranches: {
          ...state.workBranches,
          [action.repoId]: action.branches,
        },
      };
    case 'updateBranch': {
      const repoBranches = state.workBranches[action.repoId] || [];
      const updated = upsertById(repoBranches, getBranchName, action.branch);
      return {
        ...state,
        workBranches: {
          ...state.workBranches,
          [action.repoId]: updated,
        },
      };
    }
    case 'setIssueRepos':
      // Bug: a2c8d43 — guard against cold-cache API response overwriting valid
      // localStorage-restored data. If the incoming list is empty but state
      // already has repos (from loadCachedState), keep the cached data so the
      // Issues tab stays populated while the background scan finishes.
      if (action.repos.length === 0 && state.issueRepos.length > 0) return state;
      return { ...state, issueRepos: action.repos };
    case 'setDaemonReload':
      return { ...state, daemonReload: action.reload };
    case 'setSettings':
      return { ...state, settings: action.settings, settingsLoadError: null };
    case 'setSettingsLoadError':
      return { ...state, settingsLoadError: action.error };
    case 'updateSetting':
      return { ...state, settings: { ...state.settings, [action.key]: action.value } };
    case 'setInboxData':
      return { ...state, inboxData: action.data, inboxLoading: false, inboxLoadError: null };
    case 'setInboxLoading':
      return {
        ...state,
        inboxLoading: action.loading,
        inboxLoadError: action.loading ? null : state.inboxLoadError,
      };
    case 'setInboxLoadError':
      return { ...state, inboxLoading: false, inboxLoadError: action.error };
    case 'ackInboxContinuation': {
      if (!state.inboxData) return state;
      const continuations = state.inboxData.continuations.filter(
        (c) => c.session_id !== action.sessionId,
      );
      const inboxData = {
        ...state.inboxData,
        continuations,
        total: continuations.length + state.inboxData.auth_results.length + state.inboxData.open_issues.length
          + (state.inboxData.managed_reminder_occurrences?.length ?? 0),
      };
      return { ...state, inboxData };
    }
    case 'ackInboxAuthResult': {
      if (!state.inboxData) return state;
      const auth_results = state.inboxData.auth_results.filter(
        (r) => r.id !== action.requestId,
      );
      const inboxData = {
        ...state.inboxData,
        auth_results,
        total: state.inboxData.continuations.length + auth_results.length + state.inboxData.open_issues.length
          + (state.inboxData.managed_reminder_occurrences?.length ?? 0),
      };
      return { ...state, inboxData };
    }
    case 'ackInboxManagedReminderOccurrence': {
      if (!state.inboxData) return state;
      const managed_reminder_occurrences = (state.inboxData.managed_reminder_occurrences ?? [])
        .filter((occurrence) => occurrence.id !== action.occurrenceId);
      const inboxData = {
        ...state.inboxData,
        managed_reminder_occurrences,
        total: state.inboxData.continuations.length + state.inboxData.auth_results.length
          + state.inboxData.open_issues.length + managed_reminder_occurrences.length,
      };
      return { ...state, inboxData };
    }
    case 'ackAllInboxItems': {
      if (!state.inboxData) return state;
      const inboxData = {
        ...state.inboxData,
        continuations: [],
        auth_results: [],
        managed_reminder_occurrences: [],
        total: state.inboxData.open_issues.length,
      };
      return { ...state, inboxData, selectedInboxItemId: null };
    }
    case 'setSelectedInboxItemId':
      return { ...state, selectedInboxItemId: action.id };
    case 'setConsoleSessions':
      return { ...state, consoleSessions: action.sessions };
    case 'upsertConsoleSession': {
      const getConsoleId = (s: ConsoleSession) => s.id;
      const updated = upsertById(state.consoleSessions, getConsoleId, action.session);
      return { ...state, consoleSessions: updated };
    }
    case 'removeConsoleSession': {
      const consoleSessions = state.consoleSessions.filter(
        (s) => s.id !== action.sessionId,
      );
      return { ...state, consoleSessions };
    }
    case 'setConsoleActiveSessionId':
      return { ...state, consoleActiveSessionId: action.sessionId };
    case 'setConsoleUnreadBadge':
      return { ...state, consoleUnreadBadge: action.count };
    case 'incrementConsoleUnread': {
      const consoleSessions = state.consoleSessions.map((s) =>
        s.id === action.sessionId
          ? { ...s, unread_count: s.unread_count + 1 }
          : s,
      );
      return {
        ...state,
        consoleSessions,
        consoleUnreadBadge: state.consoleUnreadBadge + 1,
      };
    }
    case 'clearConsoleUnread': {
      const consoleSessions = state.consoleSessions.map((s) =>
        s.id === action.sessionId ? { ...s, unread_count: 0 } : s,
      );
      const consoleUnreadBadge = consoleSessions.reduce(
        (total, s) => total + s.unread_count,
        0,
      );
      return { ...state, consoleSessions, consoleUnreadBadge };
    }
    default:
      return state;
  }
}

function selectBadgeCounts(state: AppState): {
  auth: number;
  work: number;
  inbox: number;
  console: number;
} {
  const authQueue = Array.isArray(state.authQueue) ? state.authQueue : [];
  const workBranches =
    state.workBranches && typeof state.workBranches === 'object'
      ? Object.values(state.workBranches)
      : [];
  const inboxData = state.inboxData as Partial<InboxData> | null;
  const inboxContinuations = Array.isArray(inboxData?.continuations)
    ? inboxData.continuations.length
    : 0;
  const inboxAuthResults = Array.isArray(inboxData?.auth_results)
    ? inboxData.auth_results.length
    : 0;
  const inboxReminderOccurrences = Array.isArray(inboxData?.managed_reminder_occurrences)
    ? inboxData.managed_reminder_occurrences.length
    : 0;
  const consoleUnreadBadge =
    typeof state.consoleUnreadBadge === 'number' ? state.consoleUnreadBadge : 0;

  const auth = authQueue.filter((request) => {
    const status = (request.status || request.state || '').toLowerCase();
    return !status || status === 'pending' || status === 'needs_rebase';
  }).length;
  const work = workBranches.reduce((total, branches) => {
    if (!Array.isArray(branches)) {
      return total;
    }
    const dirtyBranches = branches.filter((branch) => {
      if (typeof branch.dirty === 'boolean') {
        return branch.dirty;
      }
      return branch.status ? branch.status.toLowerCase() === 'dirty' : false;
    });
    return total + dirtyBranches.length;
  }, 0);
  const inbox = inboxContinuations + inboxAuthResults + inboxReminderOccurrences;
  const console = consoleUnreadBadge;
  return { auth, work, inbox, console };
}

function applySSEEvent(state: AppState, payload: SSEPayload): AppState {
  switch (payload.type) {
    case 'auth:new':
    case 'auth:updated':
      // Bug: f690657 — auth:updated was not handled; server broadcasts it when
      // update() changes fields without a status transition. Treat it the same
      // as auth:new (upsert) so the UI stays in sync with server state.
      if (payload.data && typeof payload.data === 'object') {
        const nested = payload.data as Record<string, unknown>;
        const req = (nested.request ?? nested) as AuthRequest;
        if (req && typeof req === 'object') {
          return appReducer(state, { type: 'upsertAuth', request: req });
        }
      }
      return state;
    case 'auth:output': {
      const { requestId: outputId, text: outputText } = parseAuthOutputEvent(payload);
      if (outputId && outputText) {
        return appReducer(state, {
          type: 'authOutput',
          requestId: outputId,
          chunk: outputText,
        });
      }
      return state;
    }
    // Issue 75f52ac — auth:merged is the early row-flip event, broadcast right
    // after the git merge succeeds and before the background finalizers run. Its
    // payload is the resolved shape minus action_outcomes, so it maps onto the
    // same authResolved reducer action; a following auth:resolved is a no-op-safe
    // reconciliation carrying the completed action_outcomes.
    case 'auth:merged':
    case 'auth:resolved': {
      const rd = (payload.data && typeof payload.data === 'object' ? payload.data : {}) as Record<string, unknown>;
      const rId = parseAuthResolvedId(payload) || undefined;
      const rStatus = rd.status ?? rd.decision;
      if (rId && rStatus) {
        const resolvedAt = typeof rd.resolved_at === 'number' ? rd.resolved_at : undefined;
        const exitCode = typeof rd.exit_code === 'number' ? rd.exit_code : undefined;
        const error =
          rd.error == null ? undefined : typeof rd.error === 'string' ? rd.error : String(rd.error);
        return appReducer(state, {
          type: 'authResolved',
          requestId: String(rId),
          status: String(rStatus),
          resolved_at: resolvedAt,
          exit_code: exitCode,
          error,
        });
      }
      return state;
    }
    case 'work:branch:updated':
      {
        const unwrapped = unwrapSseData(payload);
        const record = unwrapped && typeof unwrapped === 'object' ? unwrapped : null;
        const branchPayload =
          record && record.branch && typeof record.branch === 'object'
            ? (record.branch as WorkBranch)
            : record
              ? (record as WorkBranch)
              : null;
        const repoId =
          (record?.repo_id ?? record?.repo) as
            | string
            | undefined;
        const branch = branchPayload;
        if (repoId && branch) {
          return appReducer(state, {
            type: 'updateBranch',
            repoId: String(repoId),
            branch,
          });
        }
      }
      return state;
    case 'console:session:created': {
      // Server sends { session: { id, label, ... } }; unwrapSseData returns that wrapper.
      // Extract the nested .session key so we don't cast { session: {...} } as ConsoleSession.
      const data = unwrapSseData(payload);
      const record = data as Record<string, unknown> | null;
      const session = ((record?.session as ConsoleSession) ?? record) as ConsoleSession | null;
      if (session?.id) {
        return appReducer(state, { type: 'upsertConsoleSession', session });
      }
      return state;
    }
    case 'console:session:updated': {
      const data = unwrapSseData(payload);
      const record = data as Record<string, unknown> | null;
      const session = ((record?.session as ConsoleSession) ?? record) as ConsoleSession | null;
      if (session?.id) {
        return appReducer(state, { type: 'upsertConsoleSession', session });
      }
      return state;
    }
    case 'console:attention': {
      const data = unwrapSseData(payload);
      const record = data as Record<string, unknown> | null;
      const sessionId = typeof record?.console_session_id === 'string' ? record.console_session_id : null;
      const existing = sessionId ? state.consoleSessions.find((s) => s.id === sessionId) : null;
      if (existing) {
        return appReducer(state, {
          type: 'upsertConsoleSession',
          session: {
            ...existing,
            attention: (record?.attention as ConsoleSession['attention']) ?? null,
          },
        });
      }
      return state;
    }
    case 'console:session:ended': {
      const data = unwrapSseData(payload);
      // Unwrap nested .session key if present (same pattern as created/updated)
      const record = data as Record<string, unknown> | null;
      const sessionData = ((record?.session as Record<string, unknown>) ?? record) as Record<string, unknown> | null;
      const sessionId = typeof sessionData?.id === 'string' ? sessionData.id : null;
      if (sessionId) {
        // Mark as stopped rather than removing, so the tab stays visible
        const existing = state.consoleSessions.find((s) => s.id === sessionId);
        if (existing) {
          return appReducer(state, {
            type: 'upsertConsoleSession',
            session: { ...existing, status: 'stopped' },
          });
        }
      }
      return state;
    }
    case 'console:session:exit': {
      const data = unwrapSseData(payload);
      const record = data as Record<string, unknown> | null;
      const sessionId = typeof record?.id === 'string' ? record.id : null;
      const exitStatus = typeof record?.status === 'string' ? record.status : 'crashed';
      if (sessionId) {
        const existing = state.consoleSessions.find((s) => s.id === sessionId);
        if (existing) {
          return appReducer(state, {
            type: 'upsertConsoleSession',
            session: { ...existing, status: exitStatus as ConsoleSession['status'] },
          });
        }
      }
      return state;
    }
    case 'console:session:started': {
      const data = unwrapSseData(payload);
      const record = data as Record<string, unknown> | null;
      const sessionId = typeof record?.id === 'string' ? record.id : null;
      if (sessionId) {
        const existing = state.consoleSessions.find((s) => s.id === sessionId);
        if (existing) {
          return appReducer(state, {
            type: 'upsertConsoleSession',
            session: { ...existing, status: 'running' },
          });
        }
      }
      return state;
    }
    case 'console:session:stopped': {
      const data = unwrapSseData(payload);
      const record = data as Record<string, unknown> | null;
      const sessionId = typeof record?.id === 'string' ? record.id : null;
      if (sessionId) {
        const existing = state.consoleSessions.find((s) => s.id === sessionId);
        if (existing) {
          return appReducer(state, {
            type: 'upsertConsoleSession',
            session: { ...existing, status: 'stopped' },
          });
        }
      }
      return state;
    }
    case 'console:session:deleted': {
      const data = unwrapSseData(payload);
      const record = data as Record<string, unknown> | null;
      const sessionId = typeof record?.id === 'string' ? record.id : null;
      if (sessionId) {
        return appReducer(state, { type: 'removeConsoleSession', sessionId });
      }
      return state;
    }
    case 'console:inbox:badge': {
      const data = unwrapSseData(payload);
      const count = typeof data?.count === 'number' ? data.count : 0;
      return appReducer(state, { type: 'setConsoleUnreadBadge', count });
    }
    default:
      return state;
  }
}

const CACHE_KEY = 'mandible_state_cache';
const CACHE_VERSION = 2;
const LEGACY_APP_RAIL_ORDER_KEY = 'app_rail_order';

function withoutLegacyAppRailOrder(settings: Record<string, string> | undefined): Record<string, string> {
  if (!settings) return {};
  const sanitized = { ...settings };
  delete sanitized[LEGACY_APP_RAIL_ORDER_KEY];
  return sanitized;
}

// Bug: 7136f0d — starredChats removed from cache (Chats tab removed, starring via History tab)
type CachedFields = Pick<
  AppState,
  'authQueue' | 'authHistory' | 'workRepos' | 'workBranches' | 'issueRepos'
  | 'inboxData' | 'consoleSessions' | 'settings' | 'selectedAuthId' | 'selectedInboxItemId'
>;

// Bug: 9860b1c, b794add — Filter stale resolved auth items on cache load so they
// never appear on initial render before the fresh API fetch overwrites them.
const RECENT_RESOLVED_MS = 3_600_000; // 1 hour
const RECENT_HISTORY_MS = 86_400_000; // 24 hours

function loadCachedState(): Partial<AppState> {
  try {
    if (typeof window === 'undefined') return {};
    const raw = window.localStorage.getItem(CACHE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as { v: number; state: Partial<AppState> };
    if (parsed.v !== CACHE_VERSION) return {};
    const cached = parsed.state;
    // The authenticated user_settings row is the only writable-instance rail
    // authority. Quarantine legacy global/browser cache bytes on hydration.
    if (cached.settings) cached.settings = withoutLegacyAppRailOrder(cached.settings);
    const now = Date.now();

    // Filter authQueue: drop dismissed/rejected/expired items whose resolved_at
    // is older than 1 hour so they do not flash on screen before the API fetch.
    if (Array.isArray(cached.authQueue)) {
      cached.authQueue = cached.authQueue.filter((item) => {
        const status = ((item.status || item.state || '') as string).toLowerCase();
        const isResolved =
          status === 'dismissed' || status === 'withdrawn' || status === 'superseded' || status === 'rejected' || status === 'expired';
        if (!isResolved) return true;
        const resolvedAt =
          typeof item.resolved_at === 'number'
            ? item.resolved_at
            : typeof item.resolved_at === 'string'
              ? Number(item.resolved_at)
              : null;
        // Keep if within the recent window; drop if older or missing resolved_at
        return resolvedAt !== null && resolvedAt >= now - RECENT_RESOLVED_MS;
      });
    }

    // Filter authHistory: drop items older than 24 hours to keep the cache lean.
    if (Array.isArray(cached.authHistory)) {
      cached.authHistory = cached.authHistory.filter((item) => {
        const resolvedAt =
          typeof item.resolved_at === 'number'
            ? item.resolved_at
            : typeof item.resolved_at === 'string'
              ? Number(item.resolved_at)
              : null;
        if (resolvedAt === null) {
          // No resolved_at — fall back to created_at
          const createdAt =
            typeof item.created_at === 'number'
              ? item.created_at
              : typeof item.created_at === 'string'
                ? Number(item.created_at)
                : null;
          return createdAt !== null && createdAt >= now - RECENT_HISTORY_MS;
        }
        return resolvedAt >= now - RECENT_HISTORY_MS;
      });
    }

    return cached;
  } catch {
    return {};
  }
}

function saveCachedState(state: AppState): void {
  try {
    if (typeof window === 'undefined') return;
    const toCache: CachedFields = {
      authQueue: state.authQueue,
      authHistory: state.authHistory,
      selectedAuthId: state.selectedAuthId,
      workRepos: state.workRepos,
      workBranches: state.workBranches,
      issueRepos: state.issueRepos,
      inboxData: state.inboxData,
      selectedInboxItemId: state.selectedInboxItemId,
      consoleSessions: state.consoleSessions,
      settings: withoutLegacyAppRailOrder(state.settings),
    };
    window.localStorage.setItem(CACHE_KEY, JSON.stringify({ v: CACHE_VERSION, state: toCache }));
  } catch {
    // Ignore storage quota errors (private browsing, etc.)
  }
}

export type { AppState, AppAction };
export {
  appReducer,
  applySSEEvent,
  initialState,
  loadCachedState,
  saveCachedState,
  selectBadgeCounts,
  parseAuthOutputEvent,
  parseAuthResolvedId,
  MAX_AUTH_OUTPUT_CHARS,
};
