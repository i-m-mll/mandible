import type { AuthRequest } from './views/auth';
import type { InboxData } from './views/inbox';
import type { IssueRepoSummary } from './views/issues';
import type { SessionRecord } from './views/sessions';
import type { WorkBranch, WorkRepo } from './views/work';
import type { Conversation } from './api';
import type { SSEPayload } from './sse-client';
import type { Preset, PresetNode, UndoCommand } from './types/presets';

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
  command?: string;
  args?: string[];
  unread_count: number;
  created_at: number;
  started_at: number | null;
  stopped_at: number | null;
  backend_type: 'pty' | 'sdk' | 'spawn';
  // Bug: b5e1c51 — Whether this PTY session has channel integration (Terminal + Events)
  channel_enabled?: boolean;
  allowed_tools?: string[] | null;
  mandible_session_id?: string | null;
  resume_at_message?: string | null;
  channel_enabled?: boolean;
  attention?: {
    session_id: string;
    kind: 'input_prompt' | 'running_output' | 'permission_menu' | 'unknown';
    source: 'pty_screen' | 'pty_screen_fallback';
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
    cleared_by?: 'screen_changed' | 'structured_stream_activity' | 'process_exit' | 'manual_clear';
  } | null;
  prompt_queue?: {
    pending_count: number;
    items: Array<{
      id: string;
      text: string;
      queued_at: number;
      blocked_by: 'permission_menu' | 'running_output' | 'unknown' | 'no_attention_state';
    }>;
    fallback_enabled: boolean;
    fallback_quiet_ms: number;
    last_flushed_at: number | null;
  } | null;
};

export type { ConsoleSession };

type AppState = {
  sessions: SessionRecord[];
  authQueue: AuthRequest[];
  authHistory: AuthRequest[];
  selectedAuthId: string | null;
  workRepos: WorkRepo[];
  workBranches: Record<string, WorkBranch[]>;
  authOutputs: Record<string, string>;
  newSessionIds: Record<string, number>;
  issueRepos: IssueRepoSummary[];
  daemonReload: DaemonReloadInfo | null;
  settings: Record<string, string>;
  conversations: Conversation[];
  inboxData: InboxData | null;
  inboxLoading: boolean;
  consoleSessions: ConsoleSession[];
  consoleActiveSessionId: string | null;
  consoleUnreadBadge: number;
  selectedInboxItemId: string | null;
  // Bug: e20c88e — Presets tab state
  presetsState: {
    presets: Preset[];
    selectedPresetId: string | null;
    libraryMode: boolean;
    editingNodeId: string | null;
    nodes: Record<string, PresetNode[]>;
    undoStack: UndoCommand[];
    redoStack: UndoCommand[];
  };
};

type Action =
  | { type: 'setSessions'; sessions: SessionRecord[] }
  | { type: 'upsertSession'; session: SessionRecord; markNew?: boolean }
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
  | { type: 'updateSetting'; key: string; value: string }
  | { type: 'setConversations'; conversations: Conversation[] }
  | { type: 'upsertConversation'; conversation: Conversation }
  | { type: 'setInboxData'; data: InboxData }
  | { type: 'setInboxLoading'; loading: boolean }
  | { type: 'ackInboxContinuation'; sessionId: string }
  | { type: 'ackInboxAuthResult'; requestId: string }
  | { type: 'ackAllInboxItems' }
  | { type: 'setSelectedInboxItemId'; id: string | null }
  | { type: 'setConsoleSessions'; sessions: ConsoleSession[] }
  | { type: 'upsertConsoleSession'; session: ConsoleSession }
  | { type: 'removeConsoleSession'; sessionId: string }
  | { type: 'setConsoleActiveSessionId'; sessionId: string | null }
  | { type: 'setConsoleUnreadBadge'; count: number }
  | { type: 'incrementConsoleUnread'; sessionId: string }
  | { type: 'clearConsoleUnread'; sessionId: string }
  // Bug: e20c88e — Presets actions
  | { type: 'presetsLoaded'; presets: Preset[] }
  | { type: 'presetSelected'; presetId: string | null }
  | { type: 'presetCreated'; preset: Preset }
  | { type: 'presetUpdated'; preset: Preset }
  | { type: 'presetDeleted'; presetId: string }
  | { type: 'nodesLoaded'; presetId: string; nodes: PresetNode[] }
  | { type: 'nodeAdded'; presetId: string; node: PresetNode }
  | { type: 'nodeUpdated'; presetId: string; node: PresetNode }
  | { type: 'nodeDeleted'; presetId: string; nodeId: string }
  | { type: 'nodeReordered'; presetId: string; nodeId: string; newParentId: string | null; newPosition: number }
  | { type: 'libraryToggled'; libraryMode: boolean }
  | { type: 'editingNodeSet'; nodeId: string | null }
  | { type: 'presetsUndo' }
  | { type: 'presetsRedo' }
  | { type: 'presetsPushUndo'; command: UndoCommand }
  | { type: 'presetsClearUndoStack' };

type AppAction = Action | { type: 'sse'; payload: SSEPayload };

const initialState: AppState = {
  sessions: [],
  authQueue: [],
  authHistory: [],
  selectedAuthId: null,
  workRepos: [],
  workBranches: {},
  authOutputs: {},
  newSessionIds: {},
  issueRepos: [],
  daemonReload: null,
  settings: {},
  conversations: [],
  inboxData: null,
  inboxLoading: false,
  consoleSessions: [],
  consoleActiveSessionId: null,
  consoleUnreadBadge: 0,
  selectedInboxItemId: null,
  presetsState: {
    presets: [],
    selectedPresetId: null,
    libraryMode: false,
    editingNodeId: null,
    nodes: {},
    undoStack: [],
    redoStack: [],
  },
};

function getSessionId(session: SessionRecord): string {
  return session.id || session.session_id || '';
}

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

function appReducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case 'sse':
      return applySSEEvent(state, action.payload);
    case 'setSessions':
      return { ...state, sessions: action.sessions };
    case 'upsertSession': {
      const updatedSessions = upsertById(state.sessions, getSessionId, action.session);
      const sessionId = getSessionId(action.session);
      const newSessionIds = { ...state.newSessionIds };
      if (action.markNew && sessionId) {
        newSessionIds[sessionId] = Date.now();
      }
      return { ...state, sessions: updatedSessions, newSessionIds };
    }
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
      return {
        ...state,
        authOutputs: {
          ...state.authOutputs,
          [action.requestId]: `${existing}${action.chunk}`,
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
      return { ...state, settings: action.settings };
    case 'updateSetting':
      return { ...state, settings: { ...state.settings, [action.key]: action.value } };
    case 'setConversations':
      return { ...state, conversations: action.conversations };
    case 'upsertConversation': {
      const getId = (c: Conversation) => c.id;
      const updated = upsertById(state.conversations, getId, action.conversation);
      return { ...state, conversations: updated };
    }
    case 'setInboxData':
      return { ...state, inboxData: action.data, inboxLoading: false };
    case 'setInboxLoading':
      return { ...state, inboxLoading: action.loading };
    case 'ackInboxContinuation': {
      if (!state.inboxData) return state;
      const continuations = state.inboxData.continuations.filter(
        (c) => c.session_id !== action.sessionId,
      );
      const inboxData = {
        ...state.inboxData,
        continuations,
        total: continuations.length + state.inboxData.auth_results.length + state.inboxData.open_issues.length,
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
        total: state.inboxData.continuations.length + auth_results.length + state.inboxData.open_issues.length,
      };
      return { ...state, inboxData };
    }
    case 'ackAllInboxItems': {
      if (!state.inboxData) return state;
      const inboxData = {
        ...state.inboxData,
        continuations: [],
        auth_results: [],
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
    // Bug: e20c88e — Presets reducer cases
    case 'presetsLoaded':
      return { ...state, presetsState: { ...state.presetsState, presets: action.presets } };
    case 'presetSelected':
      return {
        ...state,
        presetsState: {
          ...state.presetsState,
          selectedPresetId: action.presetId,
          libraryMode: false,
          editingNodeId: null,
          undoStack: [],
          redoStack: [],
        },
      };
    case 'presetCreated': {
      return {
        ...state,
        presetsState: {
          ...state.presetsState,
          presets: [action.preset, ...state.presetsState.presets],
          selectedPresetId: action.preset.id,
          libraryMode: false,
        },
      };
    }
    case 'presetUpdated': {
      const presets = state.presetsState.presets.map((p) =>
        p.id === action.preset.id ? { ...p, ...action.preset } : p,
      );
      return { ...state, presetsState: { ...state.presetsState, presets } };
    }
    case 'presetDeleted': {
      const presets = state.presetsState.presets.filter((p) => p.id !== action.presetId);
      const selectedPresetId =
        state.presetsState.selectedPresetId === action.presetId
          ? null
          : state.presetsState.selectedPresetId;
      return {
        ...state,
        presetsState: { ...state.presetsState, presets, selectedPresetId },
      };
    }
    case 'nodesLoaded':
      return {
        ...state,
        presetsState: {
          ...state.presetsState,
          nodes: { ...state.presetsState.nodes, [action.presetId]: action.nodes },
        },
      };
    case 'nodeAdded': {
      const existing = state.presetsState.nodes[action.presetId] || [];
      return {
        ...state,
        presetsState: {
          ...state.presetsState,
          nodes: {
            ...state.presetsState.nodes,
            [action.presetId]: [...existing, action.node],
          },
        },
      };
    }
    case 'nodeUpdated': {
      const nodes = (state.presetsState.nodes[action.presetId] || []).map((n) =>
        n.id === action.node.id ? { ...n, ...action.node } : n,
      );
      return {
        ...state,
        presetsState: {
          ...state.presetsState,
          nodes: { ...state.presetsState.nodes, [action.presetId]: nodes },
        },
      };
    }
    case 'nodeDeleted': {
      const nodes = (state.presetsState.nodes[action.presetId] || []).filter(
        (n) => n.id !== action.nodeId,
      );
      return {
        ...state,
        presetsState: {
          ...state.presetsState,
          nodes: { ...state.presetsState.nodes, [action.presetId]: nodes },
        },
      };
    }
    case 'nodeReordered': {
      const nodes = (state.presetsState.nodes[action.presetId] || []).map((n) =>
        n.id === action.nodeId
          ? { ...n, parent_id: action.newParentId, position: action.newPosition }
          : n,
      );
      return {
        ...state,
        presetsState: {
          ...state.presetsState,
          nodes: { ...state.presetsState.nodes, [action.presetId]: nodes },
        },
      };
    }
    case 'libraryToggled':
      return {
        ...state,
        presetsState: {
          ...state.presetsState,
          libraryMode: action.libraryMode,
          selectedPresetId: action.libraryMode ? state.presetsState.selectedPresetId : state.presetsState.selectedPresetId,
        },
      };
    case 'editingNodeSet':
      return {
        ...state,
        presetsState: { ...state.presetsState, editingNodeId: action.nodeId },
      };
    case 'presetsPushUndo': {
      const STACK_CAP = 50;
      const undoStack = [...state.presetsState.undoStack, action.command].slice(-STACK_CAP);
      return {
        ...state,
        presetsState: { ...state.presetsState, undoStack, redoStack: [] },
      };
    }
    case 'presetsUndo': {
      if (state.presetsState.undoStack.length === 0) return state;
      const undoStack = state.presetsState.undoStack.slice();
      const command = undoStack.pop()!;
      const redoStack = [...state.presetsState.redoStack, command];
      return {
        ...state,
        presetsState: { ...state.presetsState, undoStack, redoStack },
      };
    }
    case 'presetsRedo': {
      if (state.presetsState.redoStack.length === 0) return state;
      const redoStack = state.presetsState.redoStack.slice();
      const command = redoStack.pop()!;
      const undoStack = [...state.presetsState.undoStack, command];
      return {
        ...state,
        presetsState: { ...state.presetsState, undoStack, redoStack },
      };
    }
    case 'presetsClearUndoStack':
      return {
        ...state,
        presetsState: { ...state.presetsState, undoStack: [], redoStack: [] },
      };
    default:
      return state;
  }
}

function selectBadgeCounts(state: AppState): {
  sessions: number;
  auth: number;
  work: number;
  inbox: number;
  console: number;
} {
  const sessionRecords = Array.isArray(state.sessions) ? state.sessions : [];
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
  const consoleUnreadBadge =
    typeof state.consoleUnreadBadge === 'number' ? state.consoleUnreadBadge : 0;

  const sessions = sessionRecords.filter((session) => {
    const status = (session.status || session.state || '').toLowerCase();
    if (!status || status === 'ended' || status === 'dead' || status === 'closed' || status === 'reaped') {
      return false;
    }
    return !(session as Record<string, unknown>).ended_at;
  }).length;
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
  const inbox = inboxContinuations + inboxAuthResults;
  const console = consoleUnreadBadge;
  return { sessions, auth, work, inbox, console };
}

function applySSEEvent(state: AppState, payload: SSEPayload): AppState {
  switch (payload.type) {
    case 'session:registered':
      if (payload.session && typeof payload.session === 'object') {
        return appReducer(state, {
          type: 'upsertSession',
          session: payload.session as SessionRecord,
          markNew: true,
        });
      }
      if (payload.data && typeof payload.data === 'object') {
        return appReducer(state, {
          type: 'upsertSession',
          session: payload.data as SessionRecord,
          markNew: true,
        });
      }
      return state;
    case 'session:updated':
    case 'session:ended':
      if (payload.session && typeof payload.session === 'object') {
        return appReducer(state, {
          type: 'upsertSession',
          session: payload.session as SessionRecord,
        });
      }
      if (payload.data && typeof payload.data === 'object') {
        return appReducer(state, {
          type: 'upsertSession',
          session: payload.data as SessionRecord,
        });
      }
      return state;
    case 'auth:new':
    case 'auth:updated':
      // Bug: f690657 — auth:updated was not handled; server broadcasts it when
      // update() changes fields without a status transition. Treat it the same
      // as auth:new (upsert) so the UI stays in sync with server state.
      if (payload.request && typeof payload.request === 'object') {
        return appReducer(state, { type: 'upsertAuth', request: payload.request as AuthRequest });
      }
      if (payload.auth && typeof payload.auth === 'object') {
        return appReducer(state, { type: 'upsertAuth', request: payload.auth as AuthRequest });
      }
      if (payload.data && typeof payload.data === 'object') {
        const nested = payload.data as Record<string, unknown>;
        const req = (nested.request ?? nested) as AuthRequest;
        if (req && typeof req === 'object') {
          return appReducer(state, { type: 'upsertAuth', request: req });
        }
      }
      return state;
    case 'auth:output': {
      // Bug: f690657 — SSE payload is { type, data: { request_id, stream, text, timestamp } }.
      // The request_id and text are nested under data, NOT at the top level.
      const outputData =
        payload.data && typeof payload.data === 'object'
          ? (payload.data as Record<string, unknown>)
          : null;
      const outputId = String(
        outputData?.request_id ?? payload.request_id ?? '',
      );
      const outputText = String(
        outputData?.text ?? payload.output ?? payload.chunk ?? '',
      );
      if (outputId && outputText) {
        return appReducer(state, {
          type: 'authOutput',
          requestId: outputId,
          chunk: outputText,
        });
      }
      return state;
    }
    case 'auth:resolved': {
      const rd = (payload.data && typeof payload.data === 'object' ? payload.data : payload) as Record<string, unknown>;
      const rId = rd.request_id ?? payload.request_id;
      const rStatus = rd.status ?? rd.decision ?? payload.status ?? payload.decision;
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
    case 'conversation:new':
    case 'conversation:updated':
      if (payload.data && typeof payload.data === 'object') {
        const conv = payload.data as Conversation;
        if (conv.id) {
          return appReducer(state, { type: 'upsertConversation', conversation: conv });
        }
      }
      return state;
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
          (record?.repo_id ?? record?.repo ?? payload.repo_id ?? payload.repo) as
            | string
            | undefined;
        const branch =
          branchPayload ||
          (payload.branch && typeof payload.branch === 'object'
            ? (payload.branch as WorkBranch)
            : undefined);
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

// Bug: 7136f0d — starredChats removed from cache (Chats tab removed, starring via History tab)
type CachedFields = Pick<
  AppState,
  'sessions' | 'authQueue' | 'authHistory' | 'workRepos' | 'workBranches' | 'issueRepos' | 'conversations'
  | 'inboxData' | 'consoleSessions' | 'settings'
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
    const now = Date.now();

    // Filter authQueue: drop dismissed/rejected/expired items whose resolved_at
    // is older than 1 hour so they do not flash on screen before the API fetch.
    if (Array.isArray(cached.authQueue)) {
      cached.authQueue = cached.authQueue.filter((item) => {
        const status = ((item.status || item.state || '') as string).toLowerCase();
        const isResolved =
          status === 'dismissed' || status === 'rejected' || status === 'expired';
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
      sessions: state.sessions,
      authQueue: state.authQueue,
      authHistory: state.authHistory,
      workRepos: state.workRepos,
      workBranches: state.workBranches,
      issueRepos: state.issueRepos,
      conversations: state.conversations,
      inboxData: state.inboxData,
      consoleSessions: state.consoleSessions,
      settings: state.settings,
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
};
