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
  type InstanceInfo,
} from './api';
import { createSSEClient } from './sse-client';
import type { SSEPayload } from './sse-client';
import { daemonIsReady, shouldEnterSplashOnProbe, type DaemonHealthSnapshot } from './daemon-readiness';
import { installTauriDeepLinkHandler } from './deep-links';
import {
  hashWithViewSidebarHidden,
  hashWithViewSidebarVisible,
  isViewSidebarHidden,
  parseArtifactVersionParam,
  parseRouteFromHash,
  type Route,
} from './routing';
import {
  AppShellProvider,
  BottomPanelIcon,
  ViewSidebarIcon,
  type AppBottomPanelDescriptor,
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
import { SpacesViewShell } from './views/spaces/SpacesViewShell';
import { SPACE_RENDERERS_REGISTRY } from './views/spaces/renderers';
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
const SPACES_LAST_VIEW_KEY = 'mandible.spaces.lastView:v1';
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

type SpacesLastView = {
  projectId: string;
  spaceId: string;
  renderer: string;
};

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

function readSpacesLastView(): SpacesLastView | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(SPACES_LAST_VIEW_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<SpacesLastView>;
    if (!parsed.projectId || !parsed.spaceId) return null;
    return {
      projectId: parsed.projectId,
      spaceId: parsed.spaceId,
      renderer: parsed.renderer || 'collection',
    };
  } catch {
    return null;
  }
}

function writeSpacesLastView(view: SpacesLastView): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(SPACES_LAST_VIEW_KEY, JSON.stringify(view));
  } catch {
    // Browser-local view restoration is best-effort only.
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
  'spaces',
]);

// Tabs that use the shared resize-rail layout (<ViewSidebar>) and therefore want
// full-bleed content (no .app-content gutters). Deliberately NARROWER than
// VIEW_SIDEBAR_TABS, which also includes console/auth/inbox/artifacts — those use
// other breakout mechanisms. Issue e29a8c5.
const RESIZE_RAIL_TABS = new Set<Route['tab']>(['issues', 'graph', 'timeline', 'spaces']);

function SpacesIcon({ size = 18 }: { size?: number }): JSX.Element {
  // Lucide-style "layout-grid": Spaces are an authored grid of surfaces.
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
    </svg>
  );
}

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

function SunMoonIcon({ size = 18 }: { size?: number }): JSX.Element {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 2v2" />
      <path d="M14.837 16.385a6 6 0 1 1-7.223-7.222c.624-.147.97.66.715 1.248a4 4 0 0 0 5.26 5.259c.589-.255 1.396.09 1.248.715" />
      <path d="M16 12a4 4 0 0 0-4-4" />
      <path d="m19 5-1.256 1.256" />
      <path d="M20 12h2" />
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
  return <SunMoonIcon size={size} />;
}

function parseHashRoute(): Route {
  if (typeof window === 'undefined') {
    return { tab: 'spaces', params: {} };
  }
  return parseRouteFromHash(window.location.hash || '#/spaces');
}

// Bug: 326a3e2 — rebuilding/restarting splash on self-merge
// Bug: 645f8a8 — also used as a generic "daemon starting" splash for pages
// loaded mid-startup (the daemon is alive but not yet ready for mutations).
function RebuildingSplash({ reason = 'rebuilding' }: { reason?: 'rebuilding' | 'starting' }): JSX.Element {
  const isRebuilding = reason === 'rebuilding';
  return (
    <div className="rebuilding-splash">
      <div className="rebuilding-splash__content">
        <div className="rebuilding-splash__spinner" aria-hidden="true" />
        <div className="rebuilding-splash__title">
          {isRebuilding ? 'Rebuilding & restarting…' : 'Starting Mandible…'}
        </div>
        <div className="rebuilding-splash__subtitle">
          {isRebuilding
            ? 'Mandible is restarting after a self-merge. This page will reload automatically.'
            : 'Mandible is finishing startup. This page will reload automatically when it is ready.'}
        </div>
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
  // Bug: 645f8a8 — splash for a page loaded mid-startup (or while the daemon is
  // down/restarting) that detects a not-ready daemon via the mount probe / poll,
  // even though it never saw the mandible:rebuilding SSE event.
  const [daemonStarting, setDaemonStarting] = useState(false);
  const [instanceInfo, setInstanceInfo] = useState<InstanceInfo | null>(null);
  const [graphRefreshToken, setGraphRefreshToken] = useState(0);
  const [bottomPanel, setBottomPanel] = useState<AppBottomPanelDescriptor | null>(null);
  const [themeModeSaving, setThemeModeSaving] = useState(false);

  const registerBottomPanel = useCallback((descriptor: AppBottomPanelDescriptor) => {
    setBottomPanel(descriptor);
    return () => {
      setBottomPanel((current) => (current?.id === descriptor.id ? null : current));
    };
  }, []);

  const appShellContext = useMemo<AppShellContextValue>(() => ({
    bottomPanel,
    registerBottomPanel,
  }), [bottomPanel, registerBottomPanel]);

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
      const currentHash = window.location.hash || '#/spaces';
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
    navigateToHash(hashWithViewSidebarVisible(window.location.hash || '#/spaces'));
  }, [navigateToHash]);

  const hideViewSidebar = useCallback(() => {
    if (typeof window === 'undefined') {
      return;
    }
    navigateToHash(hashWithViewSidebarHidden(window.location.hash || '#/spaces'));
  }, [navigateToHash]);

  const handleSettingsClose = useCallback(() => {
    navigateToHash(settingsReturnHashRef.current ?? '#/console');
  }, [navigateToHash]);

  // Spaces home navigation: open a space and/or switch its renderer by rebuilding
  // the `#/spaces?project=…&space=…&renderer=…` hash. Selection + renderer choice
  // stay URL-canonical (Dataful UX rule), and the existing `?sidebar=` param is
  // preserved so opening a space never toggles the sidebar.
  const navigateToSpace = useCallback(
    (target: { projectId?: string | null; spaceId?: string | null; renderer?: string }) => {
      if (typeof window === 'undefined') return;
      const hash = window.location.hash || '#/spaces';
      const queryPart = hash.replace(/^#/, '').split('?')[1] ?? '';
      const params = new URLSearchParams(queryPart);
      const setOrDelete = (key: string, value: string | null | undefined) => {
        if (value === undefined) return; // leave untouched
        if (value === null || value === '') params.delete(key);
        else params.set(key, value);
      };
      setOrDelete('project', target.projectId);
      setOrDelete('space', target.spaceId);
      setOrDelete('renderer', target.renderer);
      const query = params.toString();
      navigateToHash(`#/spaces${query ? `?${query}` : ''}`);
    },
    [navigateToHash],
  );

  useEffect(() => {
    if (route.tab !== 'spaces') return;
    const { project, space, renderer } = route.params;
    if (project && space) {
      writeSpacesLastView({ projectId: project, spaceId: space, renderer: renderer || 'collection' });
      return;
    }
    if (project || space || renderer) return;
    const last = readSpacesLastView();
    if (!last) return;
    navigateToSpace({
      projectId: last.projectId,
      spaceId: last.spaceId,
      renderer: last.renderer,
    });
  }, [route, navigateToSpace]);

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

  // Bug: 645f8a8 — splash is active for either a self-merge rebuild (SSE-driven)
  // or a mid-startup / not-ready daemon (probe-driven). Mutations are gated off
  // while the splash is active: the daemon is not ready for normal use.
  const splashActive = rebuilding || daemonStarting;
  const daemonReady = !splashActive;

  // Bug: 645f8a8 — initial mount probe. A page (re)loaded mid-rebuild or
  // mid-startup will not have seen the mandible:rebuilding SSE event. Probe
  // /api/health once on mount; enter the splash ONLY on a POSITIVE not-ready
  // signal — a successful health response that reports rebuilding or ready
  // !== true (see shouldEnterSplashOnProbe). A failed / indeterminate cold-mount
  // probe (health === null) must NOT hijack the UI: a daemon that cannot serve
  // health did not serve this page either, and we must not flash the splash on
  // every normal load. (The POLL predicate keeps the splash up through the
  // exit/restart gap once it is already active — that is a different question.)
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      let health: DaemonHealthSnapshot | null = null;
      try {
        const res = await fetch('/api/health');
        health = res.ok ? ((await res.json()) as DaemonHealthSnapshot) : null;
      } catch {
        health = null;
      }
      if (cancelled) return;
      if (health?.instance) {
        setInstanceInfo(health.instance);
      }
      if (!shouldEnterSplashOnProbe(health)) return; // ready, or unreachable cold mount — render normally
      if (health?.rebuilding) {
        setRebuilding(true);
      } else {
        setDaemonStarting(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Bug: 326a3e2 — poll /api/health every 2s while the splash is active; reload
  // when the daemon reports it is ready.
  // Bug: 4db692a — the health response includes a `rebuilding` flag while the
  // old daemon is still alive but about to restart after a self-merge.
  // Bug: 645f8a8 — and a lifecycle-owned `ready` flag. The poll must wait until
  // the (restarted) daemon responds with rebuilding falsy AND ready === true,
  // so we never reload into a daemon that is merely listening but still starting
  // up. Reload happens exactly once; the post-reload mount probe confirms ready.
  useEffect(() => {
    if (!splashActive) return;
    const POLL_MS = 2_000;
    let intervalId: ReturnType<typeof window.setInterval> | null = null;
    // Give the daemon a moment to shut down before starting to poll
    const startTimer = window.setTimeout(() => {
      intervalId = window.setInterval(async () => {
        try {
          const res = await fetch('/api/health');
          if (!res.ok) return; // not up yet — keep polling
          const data = (await res.json()) as DaemonHealthSnapshot;
          // Reload only once the restarted daemon is ready for normal mutations.
          if (daemonIsReady(data)) {
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
  }, [splashActive]);

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

  const handleGraphNavigate = useCallback((type: GraphNodeType, id: string, repoId?: string) => {
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
  }, [navigateToHash]);

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
      tab: 'spaces',
      href: '#/spaces',
      label: 'Spaces',
      title: 'Spaces',
      icon: SpacesIcon,
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
      tab: 'graph',
      href: '#/graph',
      label: 'Graph',
      title: 'Graph',
      icon: GraphIcon,
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
  const bottomPanelAvailable = Boolean(bottomPanel?.content);
  const bottomPanelOpen = Boolean(bottomPanelAvailable && bottomPanel?.open);
  const viewSidebarAvailable = VIEW_SIDEBAR_TABS.has(route.tab);
  const viewSidebarHidden = Boolean(viewSidebarAvailable && isViewSidebarHidden(route));
  const viewSidebarOpen = Boolean(viewSidebarAvailable && !viewSidebarHidden);
  const viewSidebarToggleLabel = viewSidebarHidden ? 'Show view sidebar' : 'Hide view sidebar';
  const bottomPanelToggleLabel = bottomPanel
    ? bottomPanel.open
      ? `Collapse ${bottomPanel.title}`
      : `Show ${bottomPanel.title}`
    : 'Show detail panel';
  const appThemeMode = normalizeAppThemeMode(state.settings.app_theme);
  const appThemeModeIndex = APP_THEME_MODE_CYCLE.indexOf(appThemeMode);
  const nextAppThemeMode = APP_THEME_MODE_CYCLE[(appThemeModeIndex + 1) % APP_THEME_MODE_CYCLE.length];
  const appThemeModeLabel = APP_THEME_MODE_LABELS[appThemeMode];
  const nextAppThemeModeLabel = APP_THEME_MODE_LABELS[nextAppThemeMode];
  const appThemeModeControlLabel = `App theme: ${appThemeModeLabel}. Switch to ${nextAppThemeModeLabel}.`;
  const appThemeModeTooltipLabel = 'App theme';

  const startBottomPanelResize = useCallback((event: JSX.TargetedMouseEvent<HTMLDivElement>) => {
    if (!bottomPanel) {
      return;
    }
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = bottomPanel.height;
    const minHeight = bottomPanel.minHeight ?? 220;
    const maxHeight = bottomPanel.maxHeight ?? 520;
    const handleMove = (moveEvent: MouseEvent) => {
      const viewportMax = Math.floor(window.innerHeight * 0.55);
      const nextHeight = clamp(startHeight + startY - moveEvent.clientY, minHeight, Math.min(maxHeight, viewportMax));
      bottomPanel.onHeightChange(nextHeight);
    };
    const handleUp = () => {
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
    };
    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
  }, [bottomPanel]);

  // Bug: 326a3e2 — full-page rebuild splash replaces normal UI entirely
  // Bug: 645f8a8 — also covers the mid-startup / not-ready daemon case.
  if (splashActive) {
    return <RebuildingSplash reason={rebuilding ? 'rebuilding' : 'starting'} />;
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
          {bottomPanelAvailable ? (
            <button
              type="button"
              className={`app-header__icon-button${bottomPanelOpen ? ' app-header__icon-button--active' : ''}`}
              onClick={() => bottomPanel?.onOpenChange(!bottomPanel.open)}
              aria-label={bottomPanelToggleLabel}
              aria-pressed={bottomPanelOpen}
              title={bottomPanelToggleLabel}
            >
              <BottomPanelIcon open={bottomPanelOpen} />
            </button>
          ) : null}
        </div>
      </header>
      <AppShellProvider value={appShellContext}>
        <div
          className={`app-layout app-layout--rail-${railDisplayMode}${viewSidebarOpen ? ' app-layout--view-sidebar-open' : ''}${bottomPanelOpen ? ' app-layout--bottom-panel-open' : ''}`}
          style={bottomPanelOpen && bottomPanel ? {
            '--app-bottom-panel-height': `${bottomPanel.height}px`,
          } as JSX.CSSProperties : undefined}
        >
          <aside className="app-rail" data-tauri-drag-region>
              <nav className="app-rail__nav" aria-label="Main navigation">
                <div className="app-rail__group">
                  {primaryNavItems.map(renderRailItem)}
                </div>
                <div className="app-rail__group app-rail__group--secondary">
                  {secondaryNavItems.map(renderRailItem)}
                </div>
              </nav>
              <nav className="app-rail__footer" aria-label="Settings">
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
                <button
                  type="button"
                  className={`app-rail__item app-rail__theme-toggle app-rail__theme-toggle--${appThemeMode}`}
                  onClick={() => void handleRailThemeCycle()}
                  disabled={themeModeSaving}
                  data-theme-mode={appThemeMode}
                  aria-label={appThemeModeControlLabel}
                  title={appThemeModeTooltipLabel}
                >
                  <span className="app-rail__icon">
                    <AppThemeModeIcon mode={appThemeMode} size={18} />
                  </span>
                  {railDisplayMode === 'both' && <span className="app-rail__label">{appThemeModeLabel}</span>}
                  {railDisplayMode !== 'both' && <span className="app-rail__tooltip">{appThemeModeTooltipLabel}</span>}
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
          className={`app-content${route.tab === 'console' ? ' app-content--console' : ''}${route.tab === 'graph' ? ' app-content--graph' : ''}${route.tab === 'timeline' ? ' app-content--timeline' : ''}${route.tab === 'spaces' ? ' app-content--spaces' : ''}${RESIZE_RAIL_TABS.has(route.tab) ? ' app-content--view-sidebar' : ''}`}
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
            daemonReady={daemonReady}
            instance={instanceInfo}
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
            initialSeriesRef={route.params.series}
            initialVersionNo={parseArtifactVersionParam(route.params.version)}
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
        {route.tab === 'spaces' && (
          <SpacesViewShell
            projectId={route.params.project ?? ''}
            spaceId={route.params.space ?? null}
            renderer={route.params.renderer}
            renderers={SPACE_RENDERERS_REGISTRY}
            sidebarHidden={viewSidebarHidden}
            onNavigate={navigateToSpace}
          />
        )}
        </main>
          {bottomPanelOpen && bottomPanel ? (
            <aside
              className="app-bottom-panel"
              aria-label={bottomPanel.ariaLabel}
              style={{ height: `${bottomPanel.height}px` }}
            >
              <div
                className="app-bottom-panel__resize"
                role="separator"
                aria-orientation="horizontal"
                aria-label={`Resize ${bottomPanel.title}`}
                onMouseDown={startBottomPanelResize}
              />
              <div className="app-bottom-panel__content">
                {bottomPanel.content}
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
