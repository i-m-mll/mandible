import { render } from 'preact';
import { useEffect, useMemo, useReducer, useRef, useState } from 'preact/hooks';

import {
  acknowledgeInboxItem,
  ackAllInbox,
  approveAuthRequest,
  closeConsoleSession,
  createConsoleSession,
  dismissAuthRequest,
  getAuthHistory,
  getAuthQueue,
  getConsoleSessions,
  getConversations,
  getInboxGlobal,
  getIssueRepos,
  getRepoBranches,
  getSessions,
  getSettings,
  getSwitchboardItems,
  getSwitchboardPairings,
  getSwitchboardTemplates,
  createSwitchboardTemplate,
  addSwitchboardPairing,
  deleteSwitchboardPairing,
  updateSwitchboardPairing,
  toggleSwitchboardItem,
  syncSwitchboard,
  getWorkRepos,
  triggerWorkScan,
  killSession,
  navigateSession,
  rejectAuthRequest,
  retryAuthRequest,
  scanIssues,
  updateSetting,
} from './api';
import { createSSEClient } from './sse-client';
import type { SSEPayload } from './sse-client';
import { AuthQueueView } from './views/auth';
import type { AuthRequest } from './views/auth';
import { InboxView } from './views/inbox';
import { IssuesView } from './views/issues';
import type { IssueRepoSummary } from './views/issues';
import { ReviewView } from './views/review';
import { SessionsView } from './views/sessions';
import type { SessionRecord } from './views/sessions';
import { ConversationsView } from './views/conversations';
import { SettingsView } from './views/settings';
import { SwitchboardView } from './views/switchboard';
import type { HookTemplate, PairingHooks, SwitchboardItem, SwitchboardPairing } from './views/switchboard';
import { WorkOverviewView } from './views/work';
import type { WorkBranch, WorkRepo } from './views/work';
import { ConsoleView } from './views/console';
import { LogsView } from './views/logs';
import { appReducer, initialState, loadCachedState, saveCachedState, selectBadgeCounts } from './state';
import type { BugRef, ConsoleSession } from './state';

import './style.css';

const LAST_SEEN_COMMIT_KEY = 'mandible-last-seen-commit';

function getRepoId(repo: WorkRepo): string {
  return repo.id || repo.name || '';
}

function getLastSeenCommit(): string | null {
  if (typeof window === 'undefined') {
    return null;
  }
  try {
    return window.localStorage.getItem(LAST_SEEN_COMMIT_KEY);
  } catch {
    return null;
  }
}

function setLastSeenCommit(hash: string): void {
  if (typeof window === 'undefined') {
    return;
  }
  try {
    window.localStorage.setItem(LAST_SEEN_COMMIT_KEY, hash);
  } catch {
    return;
  }
}


type Route = {
  tab: 'sessions' | 'auth' | 'chat-history' | 'work' | 'review' | 'issues' | 'settings' | 'switchboard' | 'inbox' | 'console' | 'logs';
  params: Record<string, string>;
};

function parseHashRoute(): Route {
  if (typeof window === 'undefined') {
    return { tab: 'sessions', params: {} };
  }
  const hash = window.location.hash || '#/sessions';
  const [pathPart, queryPart] = hash.replace('#', '').split('?');
  const path = pathPart.replace(/^\//, '') || 'sessions';
  const params: Record<string, string> = {};
  if (queryPart) {
    const search = new URLSearchParams(queryPart);
    search.forEach((value, key) => {
      params[key] = value;
    });
  }
  // Support legacy 'conversations' and 'chats' routes as aliases for 'chat-history'
  const normalizedPath = (path === 'conversations' || path === 'chats') ? 'chat-history' : path;
  const tab = ['sessions', 'auth', 'chat-history', 'work', 'review', 'issues', 'settings', 'switchboard', 'inbox', 'console', 'logs'].includes(normalizedPath)
    ? (normalizedPath as Route['tab'])
    : 'sessions';
  return { tab, params };
}

function App(): JSX.Element {
  const [state, dispatch] = useReducer(appReducer, undefined, () => ({
    ...initialState,
    ...loadCachedState(),
  }));
  const [route, setRoute] = useState<Route>(() => parseHashRoute());
  const [showOverflow, setShowOverflow] = useState(false);
  const overflowRef = useRef<HTMLDivElement>(null);
  const [errorToast, setErrorToast] = useState<string | null>(null);
  const errorToastTimerRef = useRef<ReturnType<typeof window.setTimeout> | null>(null);

  useEffect(() => {
    const handleChange = () => setRoute(parseHashRoute());
    window.addEventListener('hashchange', handleChange);
    return () => window.removeEventListener('hashchange', handleChange);
  }, []);

  // Close overflow menu on click-outside
  useEffect(() => {
    if (!showOverflow) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (overflowRef.current && !overflowRef.current.contains(e.target as Node)) {
        setShowOverflow(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showOverflow]);

  // Keyboard shortcuts for top-level tabs (Ctrl+1–9).
  // Order matches visual tab order: twin(1=chat,2=history), inbox(3), issues(4),
  // sessions(5), auth(6), settings(7), overflow: work(8), review(9), logs(0).
  // Settings UI for key bindings is deferred — Bug: 9082b2c
  useEffect(() => {
    const tabRoutes: Record<string, string> = {
      '1': 'console',
      '2': 'chat-history',
      '3': 'inbox',
      '4': 'issues',
      '5': 'sessions',
      '6': 'auth',
      '7': 'settings',
      '8': 'work',
      '9': 'review',
      '0': 'logs',
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey && !e.metaKey && !e.altKey && tabRoutes[e.key]) {
        e.preventDefault();
        window.location.hash = `#/${tabRoutes[e.key]}`;
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  useEffect(() => {
    let active = true;
    getSessions<SessionRecord>('?include=issues')
      .then((sessions) => {
        if (active) {
          dispatch({ type: 'setSessions', sessions });
        }
      })
      .catch(() => undefined);

    getAuthQueue<AuthRequest>()
      .then((queue) => {
        if (active) {
          dispatch({ type: 'setAuthQueue', queue });
        }
      })
      .catch(() => undefined);

    getAuthHistory<AuthRequest>(200)
      .then((history) => {
        if (active) {
          dispatch({ type: 'setAuthHistory', history });
        }
      })
      .catch(() => undefined);

    const loadWork = async () => {
      try {
        const repos = await getWorkRepos<WorkRepo>();
        if (!active) {
          return;
        }
        dispatch({ type: 'setWorkRepos', repos });
        await Promise.all(
          repos.map(async (repo) => {
            const repoId = getRepoId(repo);
            if (!repoId) {
              return;
            }
            const branches = await getRepoBranches<WorkBranch>(repoId);
            if (active) {
              dispatch({ type: 'setRepoBranches', repoId, branches });
            }
          }),
        );
      } catch {
        return;
      }
    };

    loadWork();

    getIssueRepos<IssueRepoSummary>()
      .then((repos) => {
        if (active) {
          dispatch({ type: 'setIssueRepos', repos });
        }
      })
      .catch(() => undefined);

    getConversations({ limit: 50 })
      .then((result) => {
        if (active) {
          dispatch({ type: 'setConversations', conversations: result.conversations });
        }
      })
      .catch(() => undefined);

    getSettings()
      .then((settings) => {
        if (active) {
          dispatch({ type: 'setSettings', settings });
        }
      })
      .catch(() => undefined);

    getSwitchboardPairings<SwitchboardPairing>()
      .then((pairings) => {
        if (active) {
          dispatch({ type: 'setSwitchboardPairings', pairings });
        }
      })
      .catch(() => undefined);

    getSwitchboardTemplates()
      .then(({ templates }) => {
        if (active) {
          dispatch({ type: 'setSwitchboardTemplates', templates });
        }
      })
      .catch(() => undefined);

    dispatch({ type: 'setInboxLoading', loading: true });
    getInboxGlobal()
      .then((data) => {
        if (active) {
          dispatch({ type: 'setInboxData', data });
        }
      })
      .catch(() => {
        if (active) {
          dispatch({ type: 'setInboxLoading', loading: false });
        }
      });

    // Load initial console sessions list
    getConsoleSessions<ConsoleSession>()
      .then((sessions) => {
        if (active) dispatch({ type: 'setConsoleSessions', sessions });
      })
      .catch(() => undefined);

    return () => {
      active = false;
    };
  }, []);

  // SSE real-time updates: register handlers FIRST, then connect, so no
  // events arrive before we are ready to dispatch them.
  useEffect(() => {
    const client = createSSEClient();
    const handler = (payload: SSEPayload) => {
      dispatch({ type: 'sse', payload });
    };
    const daemonHandler = (payload: SSEPayload) => {
      const data = payload.data && typeof payload.data === 'object' ? payload.data : null;
      const record = data as Record<string, unknown> | null;
      const commitHash = typeof record?.commit_hash === 'string' ? record.commit_hash : '';
      if (!commitHash) {
        return;
      }
      if (getLastSeenCommit() === commitHash) {
        return;
      }
      setLastSeenCommit(commitHash);
      const commitSummary =
        typeof record?.commit_summary === 'string' ? record.commit_summary : '';
      const commitDate = typeof record?.commit_date === 'string' ? record.commit_date : '';
      const recentRequests = Array.isArray(record?.recent_requests)
        ? (record.recent_requests as Array<{ id: string; title: string }>)
        : [];
      const rawBugRefs = Array.isArray(record?.bug_refs) ? record.bug_refs : [];
      const bugRefs: BugRef[] = rawBugRefs
        .map((ref: unknown) => {
          if (ref && typeof ref === 'object' && 'repo_id' in ref && 'issue_id' in ref) {
            return ref as BugRef;
          }
          // Backwards compat: bare string IDs (no deep link possible)
          return null;
        })
        .filter((ref: BugRef | null): ref is BugRef => ref !== null);
      dispatch({
        type: 'setDaemonReload',
        reload: {
          hash: commitHash,
          summary: commitSummary,
          date: commitDate,
          recentRequests,
          bugRefs,
        },
      });
    };
    // SSE handler for console stream events — dispatches a CustomEvent so TerminalPane
    // components can subscribe per-session without needing to go through global state.
    // Bug: b949700 — console rich view SSE bridge
    const consoleStreamHandler = (payload: SSEPayload) => {
      const data = payload.data && typeof payload.data === 'object'
        ? (payload.data as Record<string, unknown>)
        : null;
      if (!data) return;
      window.dispatchEvent(
        new CustomEvent('console:stream_event', { detail: { ...data } }),
      );
    };

    const unsubscribes = [
      client.on('session:registered', handler),
      client.on('session:updated', handler),
      client.on('session:ended', handler),
      client.on('auth:new', handler),
      client.on('auth:updated', handler),
      client.on('auth:output', handler),
      client.on('auth:resolved', handler),
      client.on('work:branch:updated', handler),
      client.on('conversation:new', handler),
      client.on('conversation:updated', handler),
      client.on('daemon:reloaded', daemonHandler),
      client.on('console:session:created', handler),
      client.on('console:session:updated', handler),
      client.on('console:session:ended', handler),
      client.on('console:inbox:badge', handler),
      client.on('console:stream_event', consoleStreamHandler),
    ];

    // Connect AFTER all handlers are registered
    client.connect();

    return () => {
      unsubscribes.forEach((unsubscribe) => unsubscribe());
      client.close();
    };
  }, []);

  // Fallback polling: periodically fetch fresh data so the UI stays current
  // even if the SSE connection drops events or disconnects silently.
  useEffect(() => {
    const POLL_INTERVAL = 10_000;
    const timer = window.setInterval(() => {
      getSessions<SessionRecord>('?include=issues')
        .then((sessions) => dispatch({ type: 'setSessions', sessions }))
        .catch(() => undefined);
      getAuthQueue<AuthRequest>()
        .then((queue) => dispatch({ type: 'setAuthQueue', queue }))
        .catch(() => undefined);
      getAuthHistory<AuthRequest>(200)
        .then((history) => dispatch({ type: 'setAuthHistory', history }))
        .catch(() => undefined);
    }, POLL_INTERVAL);

    return () => window.clearInterval(timer);
  }, []);

  // Persist cacheable state to localStorage for stale-while-revalidate on next load.
  // Bug: 099fa86 — eliminate blank flash when refreshing the page
  useEffect(() => {
    const timer = window.setTimeout(() => {
      saveCachedState(state);
    }, 500);
    return () => window.clearTimeout(timer);
  }, [
    state.sessions,
    state.authQueue,
    state.authHistory,
    state.workRepos,
    state.workBranches,
    state.issueRepos,
    state.conversations,
  ]);

  const badges = useMemo(() => selectBadgeCounts(state), [state]);

  // Bug: 72384c5 — flatten work branches into name lists for stale-entry detection in auth view
  const authBranchesByRepo = useMemo(() => {
    const result: Record<string, string[]> = {};
    for (const [repoId, branches] of Object.entries(state.workBranches)) {
      result[repoId] = branches.map((b) => b.name || b.branch || '').filter(Boolean);
    }
    return result;
  }, [state.workBranches]);
  const handleToastDismiss = () => dispatch({ type: 'setDaemonReload', reload: null });
  const handleSelectAuth = (id: string | null) => dispatch({ type: 'setSelectedAuthId', id });

  useEffect(() => {
    if (!state.daemonReload) {
      return;
    }
    const timer = window.setTimeout(() => {
      dispatch({ type: 'setDaemonReload', reload: null });
    }, 10_000);
    return () => window.clearTimeout(timer);
  }, [state.daemonReload?.hash]);

  const showErrorToast = (message: string) => {
    setErrorToast(message);
    if (errorToastTimerRef.current !== null) {
      clearTimeout(errorToastTimerRef.current);
    }
    errorToastTimerRef.current = window.setTimeout(() => {
      setErrorToast(null);
      errorToastTimerRef.current = null;
    }, 6_000);
  };

  const handleNavigate = async (sessionId: string) => {
    try {
      await navigateSession(sessionId);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Navigation failed';
      showErrorToast(`Go to failed: ${message}`);
    }
  };

  const handleKill = async (sessionId: string) => {
    try {
      await killSession(sessionId);
    } catch {
      return;
    }
  };

  const handleApprove = async (requestId: string) => {
    try {
      await approveAuthRequest(requestId);
      // Set to 'approved' locally for immediate feedback; the SSE auth:resolved
      // event will update to 'completed' when the command finishes.
      dispatch({ type: 'authResolved', requestId, status: 'approved' });
    } catch (err) {
      // Bug: f690657 — do NOT dispatch a local status change on failure.
      // Dispatching status:'error' made isHistoryStatus() return true, which hid
      // the Approve button and left the user stuck until the 10-second poll
      // restored the true server state. The toast (from onError in runAction) is
      // enough feedback. The server state is still 'pending' so the card stays
      // actionable. Rethrow so the dashboard's onError callback surfaces the
      // message (e.g. "Auth request has no command set").
      throw err;
    }
  };

  const handleReject = async (requestId: string) => {
    try {
      await rejectAuthRequest(requestId);
      dispatch({ type: 'authResolved', requestId, status: 'rejected' });
    } catch {
      // Do not set a local error status — the server state is unchanged.
      // The action simply failed; inFlight cleanup in runAction is sufficient.
    }
  };

  const handleRetry = async (requestId: string) => {
    try {
      await retryAuthRequest(requestId);
      dispatch({ type: 'authResolved', requestId, status: 'pending' });
    } catch {
      return;
    }
  };

  const handleDismiss = async (requestId: string) => {
    try {
      await dismissAuthRequest(requestId);
      dispatch({ type: 'authResolved', requestId, status: 'dismissed' });
    } catch {
      return;
    }
  };

  const handleRescan = async () => {
    try {
      // Trigger a full scan on the server before fetching results
      await triggerWorkScan();
      const repos = await getWorkRepos<WorkRepo>();
      dispatch({ type: 'setWorkRepos', repos });
      await Promise.all(
        repos.map(async (repo) => {
          const repoId = getRepoId(repo);
          if (!repoId) {
            return;
          }
          const branches = await getRepoBranches<WorkBranch>(repoId);
          dispatch({ type: 'setRepoBranches', repoId, branches });
        }),
      );
    } catch {
      return;
    }
  };

  const handleIssueRescan = async () => {
    try {
      const repos = await scanIssues<IssueRepoSummary>();
      dispatch({ type: 'setIssueRepos', repos });
    } catch {
      return;
    }
  };

  // Bug: 568eca7 — optimistic pin toggle: update local state immediately
  const handlePinToggle = (sessionId: string, pinned: boolean) => {
    const session = state.sessions.find(
      (s) => (s.id || s.session_id) === sessionId,
    );
    if (session) {
      dispatch({
        type: 'upsertSession',
        session: { ...session, pinned: pinned ? 1 : 0 },
      });
    }
  };

  const handleSettingsSave = async (key: string, value: string) => {
    await updateSetting(key, value);
    dispatch({ type: 'updateSetting', key, value });
  };

  const handleSelectPairing = async (name: string | null) => {
    if (name === null) {
      dispatch({ type: 'setSwitchboardSelected', name: null });
      dispatch({ type: 'setSwitchboardItems', items: [] });
      dispatch({ type: 'setSwitchboardConsistencyErrors', errors: [] });
      return;
    }
    dispatch({ type: 'setSwitchboardSelected', name });
    dispatch({ type: 'setSwitchboardItemsLoading', loading: true });
    try {
      const result = await getSwitchboardItems<SwitchboardItem>(name);
      dispatch({ type: 'setSwitchboardItems', items: result.items });
      dispatch({ type: 'setSwitchboardConsistencyErrors', errors: result.consistencyErrors ?? [] });
    } catch {
      dispatch({ type: 'setSwitchboardItems', items: [] });
      dispatch({ type: 'setSwitchboardConsistencyErrors', errors: [] });
    } finally {
      dispatch({ type: 'setSwitchboardItemsLoading', loading: false });
    }
  };

  const handleAddPairing = async (name: string, source: string, target: string, hooks?: PairingHooks) => {
    await addSwitchboardPairing(name, source, target, hooks);
    const pairings = await getSwitchboardPairings<SwitchboardPairing>();
    dispatch({ type: 'setSwitchboardPairings', pairings });
  };

  const handleDeletePairing = async (name: string) => {
    await deleteSwitchboardPairing(name);
    dispatch({ type: 'removeSwitchboardPairing', name });
  };

  const handleUpdatePairing = async (name: string, source: string, target: string, hooks?: PairingHooks) => {
    await updateSwitchboardPairing(name, source, target, hooks);
    const pairings = await getSwitchboardPairings<SwitchboardPairing>();
    dispatch({ type: 'setSwitchboardPairings', pairings });
  };

  const handleToggleItem = async (pairingName: string, item: string) => {
    const result = await toggleSwitchboardItem(pairingName, item);
    // Re-fetch items to get accurate state after toggle
    try {
      const fetched = await getSwitchboardItems<SwitchboardItem>(pairingName);
      dispatch({ type: 'setSwitchboardItems', items: fetched.items });
      dispatch({ type: 'setSwitchboardConsistencyErrors', errors: fetched.consistencyErrors ?? [] });
    } catch {
      // Fallback: update the single item optimistically
      const newState = result.state as SwitchboardItem['state'];
      const existing = state.switchboardItems.find((i) => i.name === item);
      if (existing) {
        dispatch({ type: 'updateSwitchboardItem', item: { ...existing, state: newState } });
      }
    }
  };

  const handleSyncPairing = async (pairingName: string) => {
    await syncSwitchboard(pairingName);
    // Re-fetch items after sync
    try {
      const result = await getSwitchboardItems<SwitchboardItem>(pairingName);
      dispatch({ type: 'setSwitchboardItems', items: result.items });
      dispatch({ type: 'setSwitchboardConsistencyErrors', errors: result.consistencyErrors ?? [] });
    } catch {
      // ignore
    }
  };

  const handleSaveTemplate = async (name: string, hookSetup: string, hookTeardown: string) => {
    const template = await createSwitchboardTemplate(name, {
      hook_setup: hookSetup || undefined,
      hook_teardown: hookTeardown || undefined,
    });
    dispatch({ type: 'upsertSwitchboardTemplate', template: template as HookTemplate });
    // Refresh the full list to stay in sync
    getSwitchboardTemplates()
      .then(({ templates }) => dispatch({ type: 'setSwitchboardTemplates', templates }))
      .catch(() => undefined);
  };

  const handleAckContinuation = async (sessionId: string) => {
    try {
      await acknowledgeInboxItem('continuation', sessionId);
      dispatch({ type: 'ackInboxContinuation', sessionId });
    } catch {
      return;
    }
  };

  const handleAckAuthResult = async (requestId: string) => {
    try {
      await acknowledgeInboxItem('auth_result', requestId);
      dispatch({ type: 'ackInboxAuthResult', requestId });
    } catch {
      return;
    }
  };

  const handleInboxRefresh = () => {
    dispatch({ type: 'setInboxLoading', loading: true });
    getInboxGlobal()
      .then((data) => dispatch({ type: 'setInboxData', data }))
      .catch(() => dispatch({ type: 'setInboxLoading', loading: false }));
  };

  // ── Console handlers ── Bug: b949700
  const handleConsoleSelectSession = (sessionId: string) => {
    dispatch({ type: 'setConsoleActiveSessionId', sessionId });
  };

  const handleConsoleCloseSession = async (sessionId: string) => {
    try {
      await closeConsoleSession(sessionId);
      dispatch({ type: 'removeConsoleSession', sessionId });
      // If closing the active session, auto-select the operator session or first remaining
      if (state.consoleActiveSessionId === sessionId) {
        const next =
          state.consoleSessions.find((s) => s.id !== sessionId && !s.pinned) ??
          state.consoleSessions.find((s) => s.id !== sessionId);
        dispatch({ type: 'setConsoleActiveSessionId', sessionId: next?.id ?? null });
      }
    } catch {
      return;
    }
  };

  const handleConsoleNewSession = async (label: string, agentType: string) => {
    try {
      const { id } = await createConsoleSession(label, agentType);
      dispatch({ type: 'setConsoleActiveSessionId', sessionId: id });
      // The SSE console:session:created event will add it to consoleSessions
    } catch {
      return;
    }
  };

  const handleAckAll = async () => {
    try {
      await ackAllInbox();
      dispatch({ type: 'ackAllInboxItems' });
    } catch {
      return;
    }
  };

  const handleSelectInboxItem = (id: string | null) => {
    dispatch({ type: 'setSelectedInboxItemId', id });
  };


  return (
    <div className="app-shell">
      {errorToast && (
        <div className="error-toast" role="alert" aria-live="assertive">
          <span>{errorToast}</span>
          <button
            type="button"
            className="daemon-toast__dismiss"
            onClick={() => setErrorToast(null)}
            aria-label="Dismiss error"
          >
            ×
          </button>
        </div>
      )}
      {state.daemonReload && (
        <div className="daemon-toast" role="status" aria-live="polite">
          <span>Daemon reloaded</span>
          {state.daemonReload.bugRefs && state.daemonReload.bugRefs.length > 0 ? (
            <a
              href={
                state.daemonReload.bugRefs.length === 1
                  ? `#/issues?repo=${encodeURIComponent(state.daemonReload.bugRefs[0].repo_id)}&issue=${encodeURIComponent(state.daemonReload.bugRefs[0].issue_id)}`
                  : '#/issues'
              }
              className="daemon-toast__link"
            >
              {state.daemonReload.bugRefs.length === 1
                ? 'See issue'
                : `See ${state.daemonReload.bugRefs.length} issues`}
            </a>
          ) : (
            <span className="daemon-toast__hash">
              {state.daemonReload.hash.slice(0, 8)}
            </span>
          )}
          <button
            type="button"
            className="daemon-toast__dismiss"
            onClick={handleToastDismiss}
            aria-label="Dismiss daemon reload notification"
          >
            ×
          </button>
        </div>
      )}
      <header className="app-header">
        <div className="brand">Mandible</div>
        <nav className="tabs">
          <div className="tab-twin">
            <a
              href="#/console"
              className={`tab-twin__btn${route.tab === 'console' ? ' tab-twin__btn--active' : ''}`}
            >
              Chat
              {badges.console > 0 && (
                <span className="tab-badge">{badges.console}</span>
              )}
            </a>
            <a
              href="#/chat-history"
              className={`tab-twin__btn${route.tab === 'chat-history' ? ' tab-twin__btn--active' : ''}`}
            >
              History
            </a>
            <a
              href="#/sessions"
              className={`tab-twin__btn${route.tab === 'sessions' ? ' tab-twin__btn--active' : ''}`}
            >
              Sessions
              {badges.sessions > 0 && (
                <span className="tab-badge">{badges.sessions}</span>
              )}
            </a>
          </div>
          <div className="tab-twin">
            <a
              href="#/issues"
              className={`tab-twin__btn${route.tab === 'issues' ? ' tab-twin__btn--active' : ''}`}
            >
              Issues
            </a>
            <a
              href="#/inbox"
              className={`tab-twin__btn${route.tab === 'inbox' ? ' tab-twin__btn--active' : ''}`}
            >
              Inbox
              {badges.inbox > 0 && (
                <span className="tab-badge">{badges.inbox}</span>
              )}
            </a>
            <a
              href="#/auth"
              className={`tab-twin__btn${route.tab === 'auth' ? ' tab-twin__btn--active' : ''}`}
            >
              Auth
              {badges.auth > 0 && (
                <span className="tab-badge tab-badge--auth">{badges.auth}</span>
              )}
            </a>
          </div>
          <a href="#/settings" className={route.tab === 'settings' ? 'active' : ''}>
            Settings
          </a>
          <div className="tab-overflow" ref={overflowRef}>
            <button
              type="button"
              className={`tab-overflow__btn${['work', 'review', 'logs', 'switchboard'].includes(route.tab) ? ' tab-overflow__btn--active' : ''}`}
              onClick={() => setShowOverflow((v) => !v)}
              aria-label="More tabs"
            >
              ···
            </button>
            {showOverflow && (
              <div className="tab-overflow__menu">
                <a
                  href="#/work"
                  className={route.tab === 'work' ? 'active' : ''}
                  onClick={() => setShowOverflow(false)}
                >
                  Branches
                  {badges.work > 0 && (
                    <span className="tab-badge">{badges.work}</span>
                  )}
                </a>
                <a
                  href="#/review"
                  className={route.tab === 'review' ? 'active' : ''}
                  onClick={() => setShowOverflow(false)}
                >
                  Diff
                </a>
                <a
                  href="#/logs"
                  className={route.tab === 'logs' ? 'active' : ''}
                  onClick={() => setShowOverflow(false)}
                >
                  Logs
                </a>
                <a
                  href="#/switchboard"
                  className={route.tab === 'switchboard' ? 'active' : ''}
                  onClick={() => setShowOverflow(false)}
                >
                  Switchboard
                </a>
              </div>
            )}
          </div>
        </nav>
      </header>
      <main className="app-content">
        {route.tab === 'sessions' && (
          <SessionsView
            sessions={state.sessions}
            newSessionIds={state.newSessionIds}
            onNavigate={handleNavigate}
            onKill={handleKill}
            onPinToggle={handlePinToggle}
            highlightSessionId={route.params.session}
          />
        )}
        {route.tab === 'auth' && (
          <AuthQueueView
            queue={state.authQueue}
            historyQueue={state.authHistory}
            outputs={state.authOutputs}
            branchesByRepo={authBranchesByRepo}
            selectedAuthId={state.selectedAuthId}
            onSelectAuth={handleSelectAuth}
            onApprove={handleApprove}
            onReject={handleReject}
            onRetry={handleRetry}
            onDismiss={handleDismiss}
          />
        )}
        {route.tab === 'chat-history' && (
          <ConversationsView
            conversations={state.conversations}
          />
        )}
        {route.tab === 'work' && (
          <WorkOverviewView
            repos={state.workRepos}
            branchesByRepo={state.workBranches}
            onRescan={handleRescan}
          />
        )}
        {route.tab === 'switchboard' && (
          <SwitchboardView
            pairings={state.switchboardPairings}
            selectedPairing={state.switchboardSelected}
            items={state.switchboardItems}
            itemsLoading={state.switchboardItemsLoading}
            consistencyErrors={state.switchboardConsistencyErrors}
            templates={state.switchboardTemplates}
            onSelectPairing={handleSelectPairing}
            onAddPairing={handleAddPairing}
            onUpdatePairing={handleUpdatePairing}
            onDeletePairing={handleDeletePairing}
            onToggleItem={handleToggleItem}
            onSync={handleSyncPairing}
            onSaveTemplate={handleSaveTemplate}
          />
        )}
        {route.tab === 'issues' && (
          <IssuesView
            repos={state.issueRepos}
            onRescan={handleIssueRescan}
            initialRepoId={route.params.repo}
            initialIssueId={route.params.issue}
          />
        )}
        {route.tab === 'review' && (
          <ReviewView
            params={{
              repo: route.params.repo,
              base: route.params.base,
              head: route.params.head,
            }}
          />
        )}
        {route.tab === 'inbox' && (
          <InboxView
            data={state.inboxData}
            loading={state.inboxLoading}
            selectedItemId={state.selectedInboxItemId}
            onSelectItem={handleSelectInboxItem}
            onAckContinuation={handleAckContinuation}
            onAckAuthResult={handleAckAuthResult}
            onAckAll={handleAckAll}
            onRefresh={handleInboxRefresh}
          />
        )}
        {route.tab === 'console' && (
          <ConsoleView
            sessions={state.consoleSessions}
            activeSessionId={state.consoleActiveSessionId}
            onSelectSession={handleConsoleSelectSession}
            onCloseSession={handleConsoleCloseSession}
            onNewSession={handleConsoleNewSession}
            isActive={route.tab === 'console'}
          />
        )}
        {route.tab === 'settings' && (
          <SettingsView
            settings={state.settings}
            onSave={handleSettingsSave}
          />
        )}
        {route.tab === 'logs' && (
          <LogsView />
        )}
      </main>
    </div>
  );
}

const mountNode = typeof document !== 'undefined' ? document.getElementById('app') : null;
if (mountNode) {
  render(<App />, mountNode);
}

export { App };
