import { render } from 'preact';
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'preact/hooks';

import {
  acknowledgeInboxItem,
  ackAllInbox,
  addSessionPreset,
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
  getWorkRepos,
  triggerWorkScan,
  rejectAuthRequest,
  retryAuthRequest,
  scanIssues,
  updateAuthRequestField,
  updateSetting,
} from './api';
import { createSSEClient } from './sse-client';
import type { SSEPayload } from './sse-client';
import { installTauriDeepLinkHandler } from './deep-links';
import {
  hashWithViewSidebarHidden,
  hashWithViewSidebarVisible,
  isViewSidebarHidden,
  parseRouteFromHash,
  type Route,
} from './routing';
import {
  AppShellProvider,
  RightSidebarIcon,
  ViewSidebarIcon,
  type AppRightSidebarDescriptor,
  type AppShellContextValue,
} from './app-shell';
import { AuthQueueView } from './views/auth';
import type { AuthRequest } from './views/auth';
import { ArtifactsView } from './views/artifacts';
import { InboxView } from './views/inbox';
import { IssuesView } from './views/issues';
import type { IssueRepoSummary } from './views/issues';
import { ReviewView } from './views/review';
import type { SessionRecord } from './views/sessions';
import { ConversationsView } from './views/conversations';
import { SettingsView } from './views/settings';
import { WorkOverviewView } from './views/work';
import type { WorkBranch, WorkRepo } from './views/work';
import { LogsView } from './views/logs';
import { GraphView } from './views/graph';
import type { GraphNodeType } from './views/graph';
import { TimelineView } from './views/timeline';
import { PresetsView } from './views/presets';
import { appReducer, initialState, loadCachedState, saveCachedState, selectBadgeCounts } from './state';
import type { BugRef, ConsoleSession } from './state';
import { normalizeAppThemeMode, resolveAppThemeMode, type AppThemeMode } from './theme';
import {
  ChatIcon,
  IssuesIcon,
  InboxIcon,
  AuthIcon,
  ArtifactsIcon,
  SettingsIcon,
  MonitorIcon,
  PresetsIcon,
  GraphIcon,
  TimelineIcon,
  LogsIcon,
  ProjectsIcon,
  DiffIcon,
} from './components/icons/TabIcons';

import './style.css';

const LAST_SEEN_COMMIT_KEY = 'mandible-last-seen-commit';
const THEME_COLOR_BY_RESOLVED_THEME = {
  dark: '#0b0f14',
  light: '#f5f7fb',
} as const;
const APP_THEME_MODE_LABELS: Record<AppThemeMode, string> = {
  system: 'System',
  light: 'Light',
  dark: 'Dark',
};
const APP_THEME_MODE_CYCLE: AppThemeMode[] = ['system', 'light', 'dark'];

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

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

function updateRootAppTheme(modeValue: string | undefined): () => void {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return () => undefined;
  }
  const mode = normalizeAppThemeMode(modeValue);
  const query = window.matchMedia('(prefers-color-scheme: dark)');
  const metaThemeColor = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  const apply = () => {
    const resolvedTheme = resolveAppThemeMode(mode, query.matches);
    document.documentElement.dataset.themeMode = mode;
    document.documentElement.dataset.theme = resolvedTheme;
    if (metaThemeColor) {
      metaThemeColor.content = THEME_COLOR_BY_RESOLVED_THEME[resolvedTheme];
    }
  };
  apply();
  if (mode !== 'system') {
    return () => undefined;
  }
  query.addEventListener('change', apply);
  return () => query.removeEventListener('change', apply);
}


type NavItem = {
  tab: Route['tab'];
  href: string;
  label: string;
  title: string;
  badge?: number;
  badgeClass?: string;
  icon: (props: { size?: number }) => JSX.Element;
};

const VIEW_SIDEBAR_TABS = new Set<Route['tab']>([
  'console',
  'graph',
  'timeline',
  'auth',
  'issues',
  'artifacts',
  'inbox',
]);

function SunIcon({ size = 18 }: { size?: number }): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2" />
      <path d="M12 20v2" />
      <path d="m4.93 4.93 1.41 1.41" />
      <path d="m17.66 17.66 1.41 1.41" />
      <path d="M2 12h2" />
      <path d="M20 12h2" />
      <path d="m6.34 17.66-1.41 1.41" />
      <path d="m19.07 4.93-1.41 1.41" />
    </svg>
  );
}

function MoonIcon({ size = 18 }: { size?: number }): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3a6 6 0 0 0 9 7.4A9 9 0 1 1 12 3Z" />
    </svg>
  );
}

function AppThemeModeIcon({ mode, size = 18 }: { mode: AppThemeMode; size?: number }): JSX.Element {
  if (mode === 'light') {
    return <SunIcon size={size} />;
  }
  if (mode === 'dark') {
    return <MoonIcon size={size} />;
  }
  return <MonitorIcon size={size} />;
}

function parseHashRoute(): Route {
  if (typeof window === 'undefined') {
    return { tab: 'graph', params: {} };
  }
  return parseRouteFromHash(window.location.hash || '#/graph');
}

// Bug: 326a3e2 — rebuilding/restarting splash on self-merge
function RebuildingSplash(): JSX.Element {
  return (
    <div className="rebuilding-splash">
      <div className="rebuilding-splash__content">
        <div className="rebuilding-splash__spinner" aria-hidden="true" />
        <div className="rebuilding-splash__title">Rebuilding &amp; restarting…</div>
        <div className="rebuilding-splash__subtitle">Mandible is restarting after a self-merge. This page will reload automatically.</div>
      </div>
    </div>
  );
}

function MandibleHeaderLogo(): JSX.Element {
  return (
    <img
      className="app-header__logo"
      src="/header-logo.svg"
      alt=""
      aria-hidden="true"
      draggable={false}
    />
  );
}

function App(): JSX.Element {
  const [state, dispatch] = useReducer(appReducer, undefined, () => ({
    ...initialState,
    ...loadCachedState(),
  }));
  const [route, setRoute] = useState<Route>(() => parseHashRoute());
  const settingsReturnHashRef = useRef<string | null>(null);
  // Bug: 326a3e2 — rebuilding splash triggered by mandible:rebuilding SSE event
  const [rebuilding, setRebuilding] = useState(false);
  const [graphRefreshToken, setGraphRefreshToken] = useState(0);
  const [rightSidebar, setRightSidebar] = useState<AppRightSidebarDescriptor | null>(null);
  const [themeModeSaving, setThemeModeSaving] = useState(false);

  const registerRightSidebar = useCallback((descriptor: AppRightSidebarDescriptor) => {
    setRightSidebar(descriptor);
    return () => {
      setRightSidebar((current) => (current?.id === descriptor.id ? null : current));
    };
  }, []);

  const appShellContext = useMemo<AppShellContextValue>(() => ({
    rightSidebar,
    registerRightSidebar,
  }), [registerRightSidebar, rightSidebar]);

  useEffect(() => updateRootAppTheme(state.settings.app_theme), [state.settings.app_theme]);

  const navigateToHash = useCallback((hash: string) => {
    if (typeof window === 'undefined') {
      return;
    }
    if (window.location.hash !== hash) {
      window.history.pushState(null, '', hash);
    }
    setRoute(parseRouteFromHash(hash));
  }, []);

  const navigateToSettings = useCallback(() => {
    if (typeof window !== 'undefined') {
      const currentRoute = parseHashRoute();
      const currentHash = window.location.hash || '#/graph';
      if (currentRoute.tab !== 'settings') {
        settingsReturnHashRef.current = currentHash;
      }
    }
    navigateToHash('#/settings');
  }, [navigateToHash]);

  const showViewSidebar = useCallback(() => {
    if (typeof window === 'undefined') {
      return;
    }
    navigateToHash(hashWithViewSidebarVisible(window.location.hash || '#/graph'));
  }, [navigateToHash]);

  const hideViewSidebar = useCallback(() => {
    if (typeof window === 'undefined') {
      return;
    }
    navigateToHash(hashWithViewSidebarHidden(window.location.hash || '#/graph'));
  }, [navigateToHash]);

  const handleSettingsClose = useCallback(() => {
    navigateToHash(settingsReturnHashRef.current ?? '#/console');
  }, [navigateToHash]);

  useEffect(() => {
    const handleChange = () => setRoute(parseHashRoute());
    window.addEventListener('hashchange', handleChange);
    window.addEventListener('popstate', handleChange);
    return () => {
      window.removeEventListener('hashchange', handleChange);
      window.removeEventListener('popstate', handleChange);
    };
  }, []);

  useEffect(() => {
    let disposed = false;
    let removeListener: (() => void) | undefined;

    installTauriDeepLinkHandler(navigateToHash)
      .then((cleanup) => {
        if (disposed) {
          cleanup();
          return;
        }
        removeListener = cleanup;
      })
      .catch((error) => {
        console.error('Failed to initialize Mandible deep links:', error);
      });

    return () => {
      disposed = true;
      removeListener?.();
    };
  }, [navigateToHash]);

  useEffect(() => {
    if (typeof window === 'undefined' || route.tab === 'settings') {
      return;
    }
    settingsReturnHashRef.current = window.location.hash || `#/${route.tab}`;
  }, [route]);

  // Add tauri-window class to body when running inside Tauri so CSS can
  // apply the extra top padding needed for the hidden title bar traffic lights.
  useEffect(() => {
    if (typeof window !== 'undefined' && (window as Record<string, unknown>).__TAURI__) {
      document.body.classList.add('tauri-window');
    }
  }, []);

  // Keyboard shortcuts for top-level tabs (Ctrl+1–9).
  // Order matches the left app rail: chat(1), graph(2), auth(3), issues(4),
  // inbox(5), projects(6), review(7), presets(8), settings(9), logs(0).
  // Settings UI for key bindings is deferred — Bug: 9082b2c
  useEffect(() => {
    const tabRoutes: Record<string, string> = {
      '1': 'console',
      '2': 'graph',
      '3': 'auth',
      '4': 'issues',
      '5': 'inbox',
      '6': 'work',
      '7': 'review',
      '8': 'presets',
      '9': 'settings',
      '0': 'logs',
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey && !e.metaKey && !e.altKey && tabRoutes[e.key]) {
        e.preventDefault();
        if (tabRoutes[e.key] === 'settings') {
          navigateToSettings();
        } else {
          navigateToHash(`#/${tabRoutes[e.key]}`);
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [navigateToHash, navigateToSettings]);

  useEffect(() => {
    let active = true;
    // Bug: 73ef02f — legacy session registry data remains for backend/session
    // integrations while the Monitor frontend route is retired.
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

    getConversations({ limit: 50, group: true, exclude_subagents: true, min_blocks: 1 })
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
        if (active) {
          dispatch({
            type: 'setConsoleSessions',
            sessions: sessions.map((session) => ({
              pinned: false,
              unread_count: 0,
              ...session,
            })),
          });
        }
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
      const rawIssueRefs = Array.isArray(record?.issue_refs)
        ? record.issue_refs
        : (Array.isArray(record?.bug_refs) ? record.bug_refs : []);
      const rawBugRefs = rawIssueRefs;
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
    // Bug: b949700 — console rich view SSE bridge; fix: f2e6a46
    const consoleStreamHandler = (payload: SSEPayload) => {
      // Bug: f2e6a46 — payload.data contains { console_session_id, event }; spread that, not payload.
      // The SSE broadcast wraps data in a 'data' field: { type, data: {...}, timestamp }.
      const data = typeof payload.data === 'object' && payload.data !== null ? payload.data : payload;
      window.dispatchEvent(
        new CustomEvent('console:stream_event', { detail: data }),
      );
    };

    // Bug: b5abaea — forward push SSE events to window so WorkOverviewView can subscribe
    const pushEventHandler = (payload: SSEPayload) => {
      const data = typeof payload.data === 'object' && payload.data !== null ? payload.data : payload;
      window.dispatchEvent(
        new CustomEvent('work:push', { detail: { type: payload.type, data } }),
      );
    };

    // Bug: 326a3e2 — show full-page splash when daemon is about to restart
    const rebuildingHandler = () => {
      setRebuilding(true);
    };

    const graphRefreshHandler = (_payload: SSEPayload) => {
      setGraphRefreshToken((n) => n + 1);
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
      client.on('console:session:exit', handler),
      client.on('console:session:started', handler),
      client.on('console:session:stopped', handler),
      client.on('console:session:deleted', handler),
      client.on('console:inbox:badge', handler),
      client.on('console:stream_event', consoleStreamHandler),
      client.on('session:registered', graphRefreshHandler),
      client.on('session:updated', graphRefreshHandler),
      client.on('session:ended', graphRefreshHandler),
      client.on('auth:new', graphRefreshHandler),
      client.on('auth:updated', graphRefreshHandler),
      client.on('auth:resolved', graphRefreshHandler),
      client.on('ledger:issue:created', graphRefreshHandler),
      client.on('ledger:issue:updated', graphRefreshHandler),
      client.on('ledger:issue:closed', graphRefreshHandler),
      client.on('ledger:issue:reopened', graphRefreshHandler),
      client.on('work:branch:updated', graphRefreshHandler),
      client.on('mandible:rebuilding', rebuildingHandler),
      // Bug: b5abaea — push/sync SSE events forwarded to window for WorkOverviewView
      client.on('push:started', pushEventHandler),
      client.on('push:repo:progress', pushEventHandler),
      client.on('push:repo:complete', pushEventHandler),
      client.on('push:complete', pushEventHandler),
      client.on('push:error', pushEventHandler),
      client.on('push:auth:pending', pushEventHandler),
      client.on('push:auth:complete', pushEventHandler),
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
      // Bug: a2c8d43 — poll issueRepos so the Issues tab refreshes once the
      // background IssueScanner finishes after a daemon restart. Guard: only
      // dispatch if the result is non-empty so we never overwrite valid cached
      // data with an empty list from a cold cache response.
      getIssueRepos<IssueRepoSummary>()
        .then((repos) => { if (repos.length > 0) dispatch({ type: 'setIssueRepos', repos }); })
        .catch(() => undefined);
    }, POLL_INTERVAL);

    return () => window.clearInterval(timer);
  }, []);

  // Bug: 326a3e2 — poll /api/health every 2s while rebuilding; reload when server responds.
  // Bug: 4db692a — the health response includes a `rebuilding` flag while the
  // daemon is still alive but about to restart after a self-merge. The poll must
  // wait until the daemon responds WITHOUT the rebuilding flag (i.e., the new
  // instance has started). Also fixed: the inner setInterval cleanup was returned
  // from the setTimeout callback (dead code) instead of being tracked for the
  // useEffect cleanup.
  useEffect(() => {
    if (!rebuilding) return;
    const POLL_MS = 2_000;
    let intervalId: ReturnType<typeof window.setInterval> | null = null;
    // Give the daemon a moment to shut down before starting to poll
    const startTimer = window.setTimeout(() => {
      intervalId = window.setInterval(async () => {
        try {
          const res = await fetch('/api/health');
          if (res.ok) {
            const data = await res.json();
            // Don't reload while the old daemon is still alive and rebuilding —
            // wait for the NEW daemon instance (which won't have rebuilding set).
            if (data.rebuilding) return;
            window.location.reload();
          }
        } catch {
          // Server not yet up — keep polling
        }
      }, POLL_MS);
    }, 1_000);
    return () => {
      window.clearTimeout(startTimer);
      if (intervalId !== null) window.clearInterval(intervalId);
    };
  }, [rebuilding]);

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
    state.inboxData,
    state.consoleSessions,
    state.settings,
  ]);

  const badges = useMemo(() => selectBadgeCounts(state), [state]);
  const headerDisplayMode = (state.settings.header_display_mode ?? 'icons') as 'text' | 'icons' | 'both';
  const railDisplayMode = headerDisplayMode === 'both' ? 'both' : 'icons';

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

  // Bug: 2c826ca — allow editing auth request fields from the dashboard
  const handleUpdateAuthField = async (requestId: string, field: string, value: string) => {
    try {
      await updateAuthRequestField(requestId, { [field]: value });
      // Refresh the queue to pick up the updated field
      const queue = await getAuthQueue<AuthRequest>();
      dispatch({ type: 'setAuthQueue', queue });
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

  const handleSettingsSave = async (key: string, value: string) => {
    await updateSetting(key, value);
    dispatch({ type: 'updateSetting', key, value });
  };

  const handleRailThemeCycle = async () => {
    if (themeModeSaving) {
      return;
    }
    const currentMode = normalizeAppThemeMode(state.settings.app_theme);
    const currentIndex = APP_THEME_MODE_CYCLE.indexOf(currentMode);
    const nextMode = APP_THEME_MODE_CYCLE[(currentIndex + 1) % APP_THEME_MODE_CYCLE.length];
    setThemeModeSaving(true);
    try {
      await handleSettingsSave('app_theme', nextMode);
    } catch {
      return;
    } finally {
      setThemeModeSaving(false);
    }
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

  const handleConsoleNewSession = async ({
    label,
    backend,
    kind,
    backend_type,
    channel_enabled,
    presetIds,
  }: {
    label: string;
    backend: string;
    kind: string;
    backend_type: 'pty' | 'sdk' | 'spawn';
    channel_enabled?: boolean;
    presetIds?: string[];
  }) => {
    try {
      const result = await createConsoleSession(label, backend, kind, backend_type, { channel_enabled });
      const session = {
        pinned: false,
        unread_count: 0,
        channel_enabled: channel_enabled ?? false,
        ...result.session,
        agent_type: (kind === 'operator' ? 'operator' : backend) as ConsoleSession['agent_type'],
      } as ConsoleSession;
      const id = session.id;
      if (!id) return;

      // Optimistic upsert: add the session immediately so the tab appears
      // without waiting for the SSE console:session:created event to arrive.
      // The SSE event will upsert again (idempotent) with the authoritative data.
      dispatch({
        type: 'upsertConsoleSession',
        session,
      });
      dispatch({ type: 'setConsoleActiveSessionId', sessionId: id });

      // Bug: 11f4f47 — Apply selected presets to the new SDK session.
      // Each preset is added independently so one failure doesn't block the rest.
      if (backend_type === 'sdk' && presetIds && presetIds.length > 0) {
        await Promise.all(
          presetIds.map((presetId, position) =>
            addSessionPreset(id, presetId, position).catch((err) => {
              console.error(`Failed to add preset ${presetId} to session ${id}:`, err);
            }),
          ),
        );
      }
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

  const handleGraphNavigate = (type: GraphNodeType, id: string, repoId?: string) => {
    switch (type) {
      case 'issue': {
        // id is the full graph node ID "issue:<repo_id>:<issue_human_id>"; extract parts
        const parts = id.split(':');
        const humanId = parts[2] ?? id;
        const resolvedRepoId = repoId ?? parts[1];
        const params = new URLSearchParams({ issue: humanId });
        if (resolvedRepoId) params.set('repo', resolvedRepoId);
        navigateToHash(`#/issues?${params.toString()}`);
        break;
      }
      case 'session':
        navigateToHash(`#/console?session=${encodeURIComponent(id.replace(/^session:/, ''))}`);
        break;
      case 'auth_request':
        navigateToHash(`#/auth?request=${encodeURIComponent(id.replace(/^auth_request:/, ''))}`);
        break;
      case 'artifact':
      case 'report': {
        const key = id.startsWith('artifact:') ? 'artifact' : 'ref';
        const params = new URLSearchParams({ [key]: id });
        if (repoId) params.set('repo', repoId);
        navigateToHash(`#/artifacts?${params.toString()}`);
        break;
      }
      default:
        break;
    }
  };

  const primaryNavItems: NavItem[] = [
    {
      tab: 'console',
      href: '#/console',
      label: 'Chat',
      title: 'Chat',
      badge: badges.console,
      icon: ChatIcon,
    },
    {
      tab: 'graph',
      href: '#/graph',
      label: 'Graph',
      title: 'Graph',
      icon: GraphIcon,
    },
    {
      tab: 'timeline',
      href: '#/timeline',
      label: 'Timeline',
      title: 'Timeline',
      icon: TimelineIcon,
    },
    {
      tab: 'auth',
      href: '#/auth',
      label: 'Auth',
      title: 'Auth',
      badge: badges.auth,
      badgeClass: 'tab-badge--auth',
      icon: AuthIcon,
    },
    {
      tab: 'issues',
      href: '#/issues',
      label: 'Issues',
      title: 'Issues',
      icon: IssuesIcon,
    },
    {
      tab: 'artifacts',
      href: '#/artifacts',
      label: 'Artifacts',
      title: 'Artifacts',
      icon: ArtifactsIcon,
    },
    {
      tab: 'inbox',
      href: '#/inbox',
      label: 'Inbox',
      title: 'Inbox',
      badge: badges.inbox,
      icon: InboxIcon,
    },
  ];

  const secondaryNavItems: NavItem[] = [
    {
      tab: 'work',
      href: '#/work',
      label: 'Projects',
      title: 'Projects',
      badge: badges.work,
      icon: ProjectsIcon,
    },
    {
      tab: 'review',
      href: '#/review',
      label: 'Review',
      title: 'Review',
      icon: DiffIcon,
    },
    {
      tab: 'presets',
      href: '#/presets',
      label: 'Presets',
      title: 'Presets',
      icon: PresetsIcon,
    },
    {
      tab: 'logs',
      href: '#/logs',
      label: 'Logs',
      title: 'Logs',
      icon: LogsIcon,
    },
  ];

  const renderRailItem = (item: NavItem): JSX.Element => {
    const Icon = item.icon;
    const active = route.tab === item.tab;
    return (
      <a
        key={item.tab}
        href={item.href}
        className={`app-rail__item${active ? ' app-rail__item--active' : ''}`}
        aria-current={active ? 'page' : undefined}
        aria-label={item.title}
        onClick={(event) => {
          if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
            return;
          }
          event.preventDefault();
          if (item.tab === 'settings') {
            navigateToSettings();
          } else {
            navigateToHash(item.href);
          }
        }}
      >
        <span className="app-rail__icon">
          <Icon size={18} />
        </span>
        {railDisplayMode === 'both' && <span className="app-rail__label">{item.label}</span>}
        {railDisplayMode !== 'both' && <span className="app-rail__tooltip">{item.label}</span>}
        {item.badge ? (
          <span className={`tab-badge app-rail__badge${item.badgeClass ? ` ${item.badgeClass}` : ''}`}>
            {item.badge}
          </span>
        ) : null}
      </a>
    );
  };

  const currentRouteTitle = (
    [...primaryNavItems, ...secondaryNavItems, {
      tab: 'settings' as const,
      href: '#/settings',
      label: 'Settings',
      title: 'Settings',
      icon: SettingsIcon,
    }].find((item) => item.tab === route.tab)?.title ?? 'Mandible'
  );
  const rightSidebarAvailable = Boolean(rightSidebar?.content);
  const rightSidebarOpen = Boolean(rightSidebarAvailable && rightSidebar?.open);
  const viewSidebarAvailable = VIEW_SIDEBAR_TABS.has(route.tab);
  const viewSidebarHidden = Boolean(viewSidebarAvailable && isViewSidebarHidden(route));
  const viewSidebarToggleLabel = viewSidebarHidden ? 'Show view sidebar' : 'Hide view sidebar';
  const rightSidebarToggleLabel = rightSidebar
    ? rightSidebar.open
      ? `Collapse ${rightSidebar.title}`
      : `Show ${rightSidebar.title}`
    : 'Show details sidebar';
  const appThemeMode = normalizeAppThemeMode(state.settings.app_theme);
  const appThemeModeIndex = APP_THEME_MODE_CYCLE.indexOf(appThemeMode);
  const nextAppThemeMode = APP_THEME_MODE_CYCLE[(appThemeModeIndex + 1) % APP_THEME_MODE_CYCLE.length];
  const appThemeModeLabel = APP_THEME_MODE_LABELS[appThemeMode];
  const nextAppThemeModeLabel = APP_THEME_MODE_LABELS[nextAppThemeMode];
  const appThemeModeControlLabel = `App theme: ${appThemeModeLabel}. Switch to ${nextAppThemeModeLabel}.`;

  const startRightSidebarResize = useCallback((event: JSX.TargetedMouseEvent<HTMLDivElement>) => {
    if (!rightSidebar) {
      return;
    }
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = rightSidebar.width;
    const minWidth = rightSidebar.minWidth ?? 280;
    const maxWidth = rightSidebar.maxWidth ?? 560;
    const handleMove = (moveEvent: MouseEvent) => {
      const viewportMax = Math.floor(window.innerWidth * 0.6);
      const nextWidth = clamp(startWidth + startX - moveEvent.clientX, minWidth, Math.min(maxWidth, viewportMax));
      rightSidebar.onWidthChange(nextWidth);
    };
    const handleUp = () => {
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
    };
    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
  }, [rightSidebar]);

  // Bug: 326a3e2 — full-page rebuild splash replaces normal UI entirely
  if (rebuilding) {
    return <RebuildingSplash />;
  }

  return (
    <div className="app-shell">
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
      <header className="app-header" data-tauri-drag-region>
        <div className="app-header__brand" title="Mandible">
          <span className="app-header__mark" aria-hidden="true">
            <MandibleHeaderLogo />
          </span>
          <span className="app-header__brand-text">Mandible</span>
        </div>
        <div className="app-header__route" aria-live="polite">{currentRouteTitle}</div>
        <div className="app-header__actions">
          {rightSidebarAvailable ? (
            <button
              type="button"
              className={`app-header__icon-button${rightSidebarOpen ? ' app-header__icon-button--active' : ''}`}
              onClick={() => rightSidebar?.onOpenChange(!rightSidebar.open)}
              aria-label={rightSidebarToggleLabel}
              aria-pressed={rightSidebarOpen}
              title={rightSidebarToggleLabel}
            >
              <RightSidebarIcon open={rightSidebarOpen} />
            </button>
          ) : null}
        </div>
      </header>
      <AppShellProvider value={appShellContext}>
        <div
          className={`app-layout app-layout--rail-${railDisplayMode}${rightSidebarOpen ? ' app-layout--right-sidebar-open' : ''}`}
          style={rightSidebarOpen && rightSidebar ? {
            '--app-right-sidebar-width': `${rightSidebar.width}px`,
          } as JSX.CSSProperties : undefined}
        >
          <aside className="app-rail" data-tauri-drag-region>
            {viewSidebarAvailable ? (
              <div className="app-rail__sidebar-controls">
                <button
                  type="button"
                  className={`app-rail__item app-rail__sidebar-toggle${viewSidebarHidden ? '' : ' app-rail__sidebar-toggle--active'}`}
                  onClick={viewSidebarHidden ? showViewSidebar : hideViewSidebar}
                  aria-label={viewSidebarToggleLabel}
                  aria-pressed={!viewSidebarHidden}
                  title={viewSidebarToggleLabel}
                >
                  <span className="app-rail__icon">
                    <ViewSidebarIcon open={!viewSidebarHidden} size={18} />
                  </span>
                  {railDisplayMode === 'both' && <span className="app-rail__label">Sidebar</span>}
                  {railDisplayMode !== 'both' && <span className="app-rail__tooltip">{viewSidebarToggleLabel}</span>}
                </button>
              </div>
            ) : null}
              <nav className="app-rail__nav" aria-label="Main navigation">
                <div className="app-rail__group">
                  {primaryNavItems.map(renderRailItem)}
                </div>
                <div className="app-rail__group app-rail__group--secondary">
                  {secondaryNavItems.map(renderRailItem)}
                </div>
              </nav>
              <nav className="app-rail__footer" aria-label="Settings">
                <button
                  type="button"
                  className="app-rail__item"
                  onClick={() => void handleRailThemeCycle()}
                  disabled={themeModeSaving}
                  aria-label={appThemeModeControlLabel}
                  title={appThemeModeControlLabel}
                >
                  <span className="app-rail__icon">
                    <AppThemeModeIcon mode={appThemeMode} size={18} />
                  </span>
                  {railDisplayMode === 'both' && <span className="app-rail__label">{appThemeModeLabel}</span>}
                  {railDisplayMode !== 'both' && <span className="app-rail__tooltip">{appThemeModeControlLabel}</span>}
                </button>
                {renderRailItem({
                  tab: 'settings',
                  href: '#/settings',
                  label: 'Settings',
                  title: 'Settings',
                  icon: SettingsIcon,
                })}
              </nav>
          </aside>
        <main
          className={`app-content${route.tab === 'console' ? ' app-content--console' : ''}${route.tab === 'timeline' ? ' app-content--timeline' : ''}`}
        >
        {route.tab === 'auth' && (
          <AuthQueueView
            queue={state.authQueue}
            historyQueue={state.authHistory}
            outputs={state.authOutputs}
            branchesByRepo={authBranchesByRepo}
            selectedAuthId={state.selectedAuthId}
            initialRequestId={route.params.request}
            sidebarHidden={viewSidebarHidden}
            onSelectAuth={handleSelectAuth}
            onApprove={handleApprove}
            onReject={handleReject}
            onRetry={handleRetry}
            onDismiss={handleDismiss}
            onUpdateField={handleUpdateAuthField}
          />
        )}
        {route.tab === 'work' && (
          <WorkOverviewView
            repos={state.workRepos}
            branchesByRepo={state.workBranches}
            onRescan={handleRescan}
          />
        )}
        {route.tab === 'issues' && (
          <IssuesView
            repos={state.issueRepos}
            onRescan={handleIssueRescan}
            initialRepoId={route.params.repo}
            initialIssueId={route.params.issue}
            initialCommentId={route.params.comment}
            defaultFilter={state.settings['issues.default_filter']}
            sidebarHidden={viewSidebarHidden}
          />
        )}
        {route.tab === 'artifacts' && (
          <ArtifactsView
            initialArtifactId={route.params.artifact}
            initialRef={route.params.ref}
            initialRepo={route.params.repo}
            sidebarHidden={viewSidebarHidden}
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
            sidebarHidden={viewSidebarHidden}
            onSelectItem={handleSelectInboxItem}
            onAckContinuation={handleAckContinuation}
            onAckAuthResult={handleAckAuthResult}
            onAckAll={handleAckAll}
            onRefresh={handleInboxRefresh}
          />
        )}
        {route.tab === 'console' && (
          <ConversationsView
            conversations={state.conversations}
            consoleSessions={state.consoleSessions}
            workRepos={state.workRepos}
            initialConversationId={route.params.conversation ?? null}
            initialSessionId={route.params.session ?? null}
            initialPresetId={route.params.preset ?? null}
            sidebarHidden={viewSidebarHidden}
            onSelectSession={handleConsoleSelectSession}
            onNewSession={handleConsoleNewSession}
          />
        )}
        {route.tab === 'settings' && (
          <SettingsView
            settings={state.settings}
            onSave={handleSettingsSave}
            onClose={handleSettingsClose}
          />
        )}
        {route.tab === 'logs' && (
          <LogsView />
        )}
        {route.tab === 'graph' && (
          <GraphView
            onNavigate={handleGraphNavigate}
            refreshToken={graphRefreshToken}
            initialMode={route.params.mode}
            initialFocus={route.params.focus}
            sidebarHidden={viewSidebarHidden}
          />
        )}
        {route.tab === 'timeline' && (
          <TimelineView
            repos={state.workRepos}
            params={route.params}
            sidebarHidden={viewSidebarHidden}
          />
        )}
        {route.tab === 'presets' && (
          <PresetsView
            presetsState={state.presetsState}
            dispatch={dispatch}
          />
        )}
        </main>
          {rightSidebarOpen && rightSidebar ? (
            <aside
              className="app-right-sidebar"
              aria-label={rightSidebar.ariaLabel}
              style={{ width: `${rightSidebar.width}px` }}
            >
              <div
                className="app-right-sidebar__resize"
                role="separator"
                aria-orientation="vertical"
                aria-label={`Resize ${rightSidebar.title}`}
                onMouseDown={startRightSidebarResize}
              />
              <div className="app-right-sidebar__content">
                {rightSidebar.content}
              </div>
            </aside>
          ) : null}
        </div>
      </AppShellProvider>
    </div>
  );
}

const mountNode = typeof document !== 'undefined' ? document.getElementById('app') : null;
if (mountNode) {
  render(<App />, mountNode);
}

export { App };
