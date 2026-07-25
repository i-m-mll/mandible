import { render, type ComponentChildren } from 'preact';
import { lazy, Suspense } from 'preact/compat';
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'preact/hooks';

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
  getDashboardBadges,
  getInboxGlobal,
  getIssueRepos,
  getRepoBranches,
  getSettings,
  getWorkRepos,
  invalidateApiGetCache,
  invalidateDashboardApiCacheForEvent,
  triggerWorkScan,
  rejectAuthRequest,
  retryAuthRequest,
  scanIssues,
  updateAuthRequestField,
  updateSetting,
  type InstanceInfo,
  type DashboardBadgeCounts,
} from './api';
import type { SSEPayload, SseConnectionState } from './sse-client';
import { acquireSharedSse, shouldSkipFallbackPoll } from './sse-shared';
import {
  ensureClientAuthToken,
  getClientAuthSessionState,
  installClientAuthFetch,
} from './client-auth-token';
import { runDesktopLogin } from './desktop-login';
import { DesktopLoginStatus } from './components/DesktopLoginStatus';
import {
  daemonEpochChanged,
  daemonCommitChanged,
  daemonIsReadyAfterEpoch,
  daemonIsWarm,
  daemonStartupEpoch,
  daemonStartupCommit,
  shouldEnterSplashOnBackgroundProbe,
  splashRequiresNewCommit,
  stallEscapeReady,
  type DaemonHealthSnapshot,
} from './daemon-readiness';
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
import type { AuthRequest } from './views/auth';
import type { IssueRepoSummary } from './views/issues';
import type { WorkBranch, WorkRepo } from './views/work';
import type { GraphNodeType } from './views/graph';
import {
  appReducer,
  initialState,
  loadCachedState,
  saveCachedState,
  selectBadgeCounts,
  parseAuthOutputEvent,
  parseAuthResolvedId,
} from './state';
import { createAuthOutputCoalescer } from './auth-output-coalescer';
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
  GraphIcon,
  TimelineIcon,
  LogsIcon,
  ProjectsIcon,
} from './components/icons/TabIcons';
import { LoadingSkeleton } from './components/LoadingSkeleton';

import '@xterm/xterm/css/xterm.css';
import '@xyflow/react/dist/style.css';
import './components/shared/PreviewDisabledNotice.css';
import './components/spaces/AddToSpace.css';
import './views/filters/issue-predicate-filter.css';
import './views/spaces/DocumentBlockEditor.css';
import './views/spaces/DocumentRenderer.css';
import './views/spaces/RepoFileRegisterDialog.css';
import './views/spaces/renderers.css';
import './views/spaces/space-board.css';
import './views/spaces/SpaceCanvas.css';
import './views/spaces/space-collection.css';
import './views/spaces/SpaceEdgeLayer.css';
import './views/spaces/SpaceExportDialog.css';
import './views/spaces/SpaceItemPicker.css';
import './views/spaces/SpaceSeedDialog.css';
import './views/spaces/SpacesSidebar.css';
import './views/spaces/SpacesViewShell.css';
import './views/spaces/SpaceTypeIndicator.css';
import './style.css';

const LAST_SEEN_COMMIT_KEY = 'mandible-last-seen-commit';
const LAST_SEEN_STARTUP_EPOCH_KEY = 'mandible-last-seen-startup-epoch';
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

type RenderableTab = Exclude<Route['tab'], 'chat-history'>;

const RENDERABLE_TABS: RenderableTab[] = [
  'auth',
  'artifacts',
  'work',
  'issues',
  'settings',
  'inbox',
  'console',
  'logs',
  'graph',
  'timeline',
  'spaces',
];

const loadAuthQueueView = () =>
  import('./views/auth').then((module) => ({ default: module.AuthQueueView }));
const loadArtifactsView = () =>
  import('./views/artifacts').then((module) => ({ default: module.ArtifactsView }));
const loadInboxView = () =>
  import('./views/inbox').then((module) => ({ default: module.InboxView }));
const loadIssuesView = () =>
  import('./views/issues').then((module) => ({ default: module.IssuesView }));
const loadConversationsView = () =>
  import('./views/conversations').then((module) => ({ default: module.ConversationsView }));
const loadSettingsView = () =>
  import('./views/settings').then((module) => ({ default: module.SettingsView }));
const loadWorkOverviewView = () =>
  import('./views/work').then((module) => ({ default: module.WorkOverviewView }));
const loadLogsView = () =>
  import('./views/logs').then((module) => ({ default: module.LogsView }));
const loadGraphView = () =>
  import('./views/graph').then((module) => ({ default: module.GraphView }));
const loadTimelineView = () =>
  import('./views/timeline').then((module) => ({ default: module.TimelineView }));
const loadSpacesTab = () =>
  import('./views/spaces/SpacesTab').then((module) => ({ default: module.SpacesTab }));

const LazyAuthQueueView = lazy(loadAuthQueueView);
const LazyArtifactsView = lazy(loadArtifactsView);
const LazyInboxView = lazy(loadInboxView);
const LazyIssuesView = lazy(loadIssuesView);
const LazyConversationsView = lazy(loadConversationsView);
const LazySettingsView = lazy(loadSettingsView);
const LazyWorkOverviewView = lazy(loadWorkOverviewView);
const LazyLogsView = lazy(loadLogsView);
const LazyGraphView = lazy(loadGraphView);
const LazyTimelineView = lazy(loadTimelineView);
const LazySpacesTab = lazy(loadSpacesTab);

const ROUTE_CHUNK_LOADERS: Partial<Record<RenderableTab, () => Promise<unknown>>> = {
  auth: loadAuthQueueView,
  artifacts: loadArtifactsView,
  inbox: loadInboxView,
  issues: loadIssuesView,
  console: loadConversationsView,
  settings: loadSettingsView,
  work: loadWorkOverviewView,
  logs: loadLogsView,
  graph: loadGraphView,
  timeline: loadTimelineView,
  spaces: loadSpacesTab,
};

const INACTIVE_APP_SHELL_CONTEXT: AppShellContextValue = {
  bottomPanel: null,
  registerBottomPanel: () => () => undefined,
};

type SpacesLastView = {
  projectId: string | null;
  spaceId: string;
};

type MandibleBootstrapData = {
  instance?: InstanceInfo | null;
};

declare global {
  interface Window {
    __MANDIBLE_BOOTSTRAP__?: MandibleBootstrapData;
  }
}

function isInstanceInfo(value: unknown): value is InstanceInfo {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<InstanceInfo>;
  return (
    (candidate.role === 'main' ||
      candidate.role === 'preview' ||
      candidate.role === 'dev' ||
      candidate.role === 'test') &&
    (candidate.operational_mutations === 'allow' || candidate.operational_mutations === 'reject') &&
    typeof candidate.operational_mutations_overridden === 'boolean' &&
    (typeof candidate.db_path === 'string' || candidate.db_path === null) &&
    (typeof candidate.db_path_source === 'string' || candidate.db_path_source === null)
  );
}

function readBootInstanceInfo(): InstanceInfo | null {
  if (typeof window === 'undefined' || typeof document === 'undefined') return null;
  const globalInstance = window.__MANDIBLE_BOOTSTRAP__?.instance;
  if (isInstanceInfo(globalInstance)) return globalInstance;
  const script = document.getElementById('mandible-bootstrap');
  const raw = script?.textContent?.trim();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as MandibleBootstrapData;
    return isInstanceInfo(parsed.instance) ? parsed.instance : null;
  } catch {
    return null;
  }
}

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

function getLastSeenStartupEpoch(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(LAST_SEEN_STARTUP_EPOCH_KEY);
  } catch {
    return null;
  }
}

function setLastSeenStartupEpoch(epoch: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(LAST_SEEN_STARTUP_EPOCH_KEY, epoch);
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
    if (!parsed.spaceId) return null;
    return {
      projectId: typeof parsed.projectId === 'string' && parsed.projectId ? parsed.projectId : null,
      spaceId: parsed.spaceId,
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
// full-bleed content (no .app-content gutters). Issue e29a8c5.
const RESIZE_RAIL_TABS = new Set<Route['tab']>([
  'auth',
  'artifacts',
  'console',
  'graph',
  'inbox',
  'issues',
  'spaces',
  'timeline',
]);

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

function isRenderableTab(tab: Route['tab']): tab is RenderableTab {
  return RENDERABLE_TABS.includes(tab as RenderableTab);
}

function routeForTab(
  tab: RenderableTab,
  activeRoute: Route,
  snapshots: Partial<Record<RenderableTab, Route>>,
): Route {
  return activeRoute.tab === tab ? activeRoute : snapshots[tab] ?? { tab, params: {} };
}

function TabChunkFallback(): JSX.Element {
  return <LoadingSkeleton variant="tab" label="Loading view" />;
}

// Bug: 326a3e2 — rebuilding/restarting splash on self-merge
// Bug: 645f8a8 — also used as a generic "daemon starting" splash for pages
// loaded mid-startup (the daemon is alive but not yet ready for mutations).
function RebuildingSplash({
  reason = 'rebuilding',
  epochStalled = false,
  stallEscape = false,
  onContinue,
}: {
  reason?: 'rebuilding' | 'starting';
  epochStalled?: boolean;
  // Bug: afaea18 — once a stall is judged non-transient (daemon healthy on the
  // same commit past the bounded window) the splash must offer an explicit exit
  // so a healthy daemon can never be permanently stranded behind it.
  stallEscape?: boolean;
  onContinue?: () => void;
}): JSX.Element {
  const isRebuilding = reason === 'rebuilding';
  return (
    <div className="rebuilding-splash">
      <div className="rebuilding-splash__content">
        <div className="rebuilding-splash__spinner" aria-hidden="true" />
        <div className="rebuilding-splash__title">
          {isRebuilding ? 'Rebuilding & restarting…' : 'Starting Mandible…'}
        </div>
        <div className="rebuilding-splash__subtitle">
          {stallEscape
            ? 'The daemon is healthy on the current commit — this looks like a manual restart, not a rebuild. You can continue.'
            : epochStalled
            ? 'The daemon is ready, but its startup commit has not changed. The rebuild may not have completed.'
            : isRebuilding
            ? 'Mandible is restarting after a self-merge. This page will reload automatically.'
            : 'Mandible is finishing startup. This page will reload automatically when it is ready.'}
        </div>
        {stallEscape && onContinue ? (
          <button
            type="button"
            className="rebuilding-splash__continue"
            onClick={onContinue}
          >
            Continue anyway
          </button>
        ) : null}
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
  const [visitedTabs, setVisitedTabs] = useState<Set<RenderableTab>>(() => {
    const initial = parseHashRoute();
    return new Set<RenderableTab>([isRenderableTab(initial.tab) ? initial.tab : 'spaces']);
  });
  const [tabRouteSnapshots, setTabRouteSnapshots] = useState<Partial<Record<RenderableTab, Route>>>(() => {
    const initial = parseHashRoute();
    const tab = isRenderableTab(initial.tab) ? initial.tab : 'spaces';
    return { [tab]: initial };
  });
  const settingsReturnHashRef = useRef<string | null>(null);
  // Bug: 326a3e2 — rebuilding splash triggered by mandible:rebuilding SSE event
  const [rebuilding, setRebuilding] = useState(false);
  // Bug: 645f8a8 — splash for a page loaded mid-startup (or while the daemon is
  // down/restarting) that detects a not-ready daemon via the mount probe / poll,
  // even though it never saw the mandible:rebuilding SSE event.
  const [daemonStarting, setDaemonStarting] = useState(false);
  const [daemonWarm, setDaemonWarm] = useState(true);
  const [epochStalled, setEpochStalled] = useState(false);
  // Bug: afaea18 — bounded-stall escape: once the splash has been stalled on a
  // healthy same-commit daemon past STALL_ESCAPE_MS, offer an explicit exit.
  const [stallEscape, setStallEscape] = useState(false);
  const splashEpochRef = useRef<string | null>(null);
  const splashCommitRef = useRef<string | null>(null);
  const requireNewEpochRef = useRef(false);
  const requireNewCommitRef = useRef(false);
  // Bug: afaea18 — when the stall was first observed and the epoch/commit to
  // record if the user (or the bounded auto-escape) continues past it.
  const stallSinceRef = useRef<number | null>(null);
  const stalledEpochRef = useRef<string | null>(null);
  const stalledCommitRef = useRef<string | null>(null);
  const continuePastStall = useCallback(() => {
    if (stalledEpochRef.current) setLastSeenStartupEpoch(stalledEpochRef.current);
    if (stalledCommitRef.current) setLastSeenCommit(stalledCommitRef.current);
    window.location.reload();
  }, []);
  const [instanceInfo, setInstanceInfo] = useState<InstanceInfo | null>(() => readBootInstanceInfo());
  const [graphRefreshToken, setGraphRefreshToken] = useState(0);
  const [bottomPanel, setBottomPanel] = useState<AppBottomPanelDescriptor | null>(null);
  const [themeModeSaving, setThemeModeSaving] = useState(false);
  const [dashboardBadges, setDashboardBadges] = useState<DashboardBadgeCounts | null>(null);
  const lastDashboardSseAtRef = useRef(0);
  // Current shared-SSE connection state, updated from onState, so the fallback
  // poll can gate on connection health rather than last-event receipt.
  const sseStateRef = useRef<SseConnectionState>('idle');
  // Set when a graph-affecting event arrives while the graph tab is hidden or
  // inactive; the graph-activation effect flushes it on activation/visibility.
  const graphDirtyRef = useRef(false);
  // Latest values for the SSE reconnect-resync closure, so the shared-SSE
  // effect need not re-run (and re-register handlers) on every route change.
  const routeTabRef = useRef(route.tab);
  routeTabRef.current = route.tab;
  const loadVisibleRouteDataRef = useRef<(tab: Route['tab']) => void>(() => undefined);

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

  useEffect(() => {
    if (!isRenderableTab(route.tab)) return;
    setVisitedTabs((current) => {
      if (current.has(route.tab)) return current;
      const next = new Set(current);
      next.add(route.tab);
      return next;
    });
    setTabRouteSnapshots((current) => ({ ...current, [route.tab]: route }));
  }, [route]);

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

  // Spaces home navigation: open a typed-primary Space, or preserve an explicit
  // legacy renderer override when supplied by a deep link / compatibility affordance.
  // The existing `?sidebar=` param is preserved so opening a space never toggles
  // the sidebar.
  const navigateToSpace = useCallback(
    (target: { projectId?: string | null; spaceId?: string | null; renderer?: string | null }) => {
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
    if (space) {
      writeSpacesLastView({ projectId: project || null, spaceId: space });
      return;
    }
    if (project || space || renderer) return;
    const last = readSpacesLastView();
    if (!last) return;
    navigateToSpace({
      projectId: last.projectId,
      spaceId: last.spaceId,
      renderer: null,
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
  // inbox(5), projects(6), instruction artifacts(7), settings(9), logs(0).
  // Settings UI for key bindings is deferred — Bug: 9082b2c
  useEffect(() => {
    const tabRoutes: Record<string, string> = {
      '1': 'console',
      '2': 'graph',
      '3': 'auth',
      '4': 'issues',
      '5': 'inbox',
      '6': 'work',
      '7': 'artifacts?role=instructions',
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

  const loadDashboardBadges = useCallback(async () => {
    try {
      setDashboardBadges(await getDashboardBadges());
    } catch {
      // Cached full-view state remains a usable fallback when the aggregate is unavailable.
    }
  }, []);

  const loadWorkData = useCallback(async (includeBranches: boolean) => {
    const repos = await getWorkRepos<WorkRepo>();
    dispatch({ type: 'setWorkRepos', repos });
    if (!includeBranches) return;
    await Promise.all(repos.map(async (repo) => {
      const repoId = getRepoId(repo);
      if (!repoId) return;
      const branches = await getRepoBranches<WorkBranch>(repoId);
      dispatch({ type: 'setRepoBranches', repoId, branches });
    }));
  }, []);

  const loadVisibleRouteData = useCallback(async (tab: Route['tab']) => {
    try {
      switch (tab) {
        case 'auth':
          await Promise.all([
            getAuthQueue<AuthRequest>().then((queue) => dispatch({ type: 'setAuthQueue', queue })),
            getAuthHistory<AuthRequest>(200).then((history) => dispatch({ type: 'setAuthHistory', history })),
            loadWorkData(true),
          ]);
          return;
        case 'console':
        case 'chat-history':
          await Promise.all([
            getConversations({ limit: 50, group: true, exclude_subagents: true, min_blocks: 1 })
              .then((result) => dispatch({ type: 'setConversations', conversations: result.conversations })),
            getConsoleSessions<ConsoleSession>().then((sessions) => dispatch({
              type: 'setConsoleSessions',
              sessions: sessions.map((session) => ({ pinned: false, unread_count: 0, ...session })),
            })),
            loadWorkData(false),
          ]);
          return;
        case 'issues':
          await getIssueRepos<IssueRepoSummary>()
            .then((repos) => {
              if (repos.length > 0) dispatch({ type: 'setIssueRepos', repos });
            });
          return;
        case 'inbox':
          dispatch({ type: 'setInboxLoading', loading: true });
          await getInboxGlobal().then((data) => dispatch({ type: 'setInboxData', data }));
          return;
        case 'settings':
          await getSettings().then((settings) => dispatch({ type: 'setSettings', settings }));
          return;
        case 'work':
          await loadWorkData(true);
          return;
        case 'timeline':
          await loadWorkData(false);
          return;
        default:
          return;
      }
    } catch {
      if (tab === 'inbox') dispatch({ type: 'setInboxLoading', loading: false });
    }
  }, [loadWorkData]);
  loadVisibleRouteDataRef.current = loadVisibleRouteData;

  useEffect(() => {
    // Start the visible view request before the small global aggregate.
    void loadVisibleRouteData(route.tab);
    void getSettings()
      .then((settings) => dispatch({ type: 'setSettings', settings }))
      .catch(() => undefined);
    void loadDashboardBadges();
  }, [route.tab, loadDashboardBadges, loadVisibleRouteData]);

  // SSE real-time updates: register handlers FIRST, then connect, so no
  // events arrive before we are ready to dispatch them.
  useEffect(() => {
    const client = acquireSharedSse();
    // Coalesced badge refresh: an event burst schedules exactly one trailing
    // fetch instead of one per event. Reconnect resync still fetches immediately.
    let badgeTimer: number | null = null;
    const scheduleBadgeRefresh = () => {
      if (badgeTimer !== null) return;
      badgeTimer = window.setTimeout(() => {
        badgeTimer = null;
        void loadDashboardBadges();
      }, 500);
    };
    // Coalesced graph-token bump while the graph tab is active and visible.
    let graphTokenTimer: number | null = null;
    const scheduleGraphBump = () => {
      if (graphTokenTimer !== null) return;
      graphTokenTimer = window.setTimeout(() => {
        graphTokenTimer = null;
        setGraphRefreshToken((n) => n + 1);
      }, 300);
    };
    // Coalesced issues-list refetch while the issues tab is active.
    let issuesRefreshTimer: number | null = null;
    const scheduleIssuesRefresh = () => {
      if (issuesRefreshTimer !== null) return;
      issuesRefreshTimer = window.setTimeout(() => {
        issuesRefreshTimer = null;
        void loadVisibleRouteDataRef.current('issues');
      }, 1000);
    };
    const handler = (payload: SSEPayload) => {
      lastDashboardSseAtRef.current = Date.now();
      invalidateDashboardApiCacheForEvent(payload.type);
      dispatch({ type: 'sse', payload });
      scheduleBadgeRefresh();
    };
    // Heartbeat: liveness signal only — bump freshness, never cache-invalidate,
    // badge-fetch, or dispatch.
    const heartbeatHandler = () => {
      lastDashboardSseAtRef.current = Date.now();
    };
    // Ledger issue liveness: thin `{issue_id, project_id}` payloads. Bump
    // freshness, invalidate the affected cache, forward the raw payload for the
    // open issue-detail view, and (only while the issues tab is active) schedule
    // a debounced list refetch. When the tab is inactive, cache invalidation
    // suffices — the route.tab activation effect refetches on activation.
    const ledgerHandler = (payload: SSEPayload) => {
      lastDashboardSseAtRef.current = Date.now();
      invalidateDashboardApiCacheForEvent(payload.type);
      const data = typeof payload.data === 'object' && payload.data !== null ? payload.data : payload;
      window.dispatchEvent(
        new CustomEvent('ledger:sse', { detail: { type: payload.type, data } }),
      );
      if (routeTabRef.current === 'issues') {
        scheduleIssuesRefresh();
      }
    };
    // Coalesce streamed auth output: buffer chunks and flush one batched
    // dispatch per frame instead of re-rendering the whole app per chunk. Badge
    // counts do not change on output, so this path skips the per-chunk badge
    // fetch and dashboard-cache invalidation entirely.
    const outputCoalescer = createAuthOutputCoalescer((requestId, chunk) =>
      dispatch({ type: 'authOutput', requestId, chunk }),
    );
    const authOutputHandler = (payload: SSEPayload) => {
      lastDashboardSseAtRef.current = Date.now();
      const { requestId, text } = parseAuthOutputEvent(payload);
      if (requestId && text) {
        outputCoalescer.push(requestId, text);
      }
    };
    const authResolvedHandler = (payload: SSEPayload) => {
      // Terminal flush: drain this request's buffered output before applying the
      // resolution so the final chunk is never dropped or delivered late.
      const requestId = parseAuthResolvedId(payload);
      if (requestId) {
        outputCoalescer.flush(requestId);
      }
      handler(payload);
    };
    const conversationHandler = (payload: SSEPayload) => {
      handler(payload);
      const data = typeof payload.data === 'object' && payload.data !== null ? payload.data : payload;
      window.dispatchEvent(
        new CustomEvent('conversation:sse', { detail: { type: payload.type, data } }),
      );
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

    const consolePermissionHandler = (payload: SSEPayload) => {
      const data = typeof payload.data === 'object' && payload.data !== null ? payload.data : payload;
      window.dispatchEvent(
        new CustomEvent(payload.type, { detail: data }),
      );
    };

    const consoleTelemetryHandler = (payload: SSEPayload) => {
      const data = typeof payload.data === 'object' && payload.data !== null ? payload.data : payload;
      window.dispatchEvent(
        new CustomEvent('console:telemetry', { detail: data }),
      );
    };

    // Bug: b5abaea — forward push SSE events to window so WorkOverviewView can subscribe
    const pushEventHandler = (payload: SSEPayload) => {
      invalidateDashboardApiCacheForEvent(payload.type);
      const data = typeof payload.data === 'object' && payload.data !== null ? payload.data : payload;
      window.dispatchEvent(
        new CustomEvent('work:push', { detail: { type: payload.type, data } }),
      );
    };

    // Bug: 326a3e2 — show full-page splash when daemon is about to restart
    const rebuildingHandler = () => {
      splashEpochRef.current = getLastSeenStartupEpoch();
      splashCommitRef.current = getLastSeenCommit();
      requireNewEpochRef.current = true;
      // An SSE rebuild announcement is the one signal that legitimately advances
      // the startup commit, so a new commit is required to release this splash.
      requireNewCommitRef.current = splashRequiresNewCommit(true);
      stallSinceRef.current = null;
      setStallEscape(false);
      setEpochStalled(false);
      setRebuilding(true);
    };

    const graphRefreshHandler = (payload: SSEPayload) => {
      invalidateDashboardApiCacheForEvent(payload.type);
      // Only repaint the graph when it is the active, visible tab. Otherwise
      // mark it dirty; the graph-activation effect flushes one bump on
      // activation or when the tab becomes visible again.
      if (routeTabRef.current === 'graph' && document.visibilityState === 'visible') {
        scheduleGraphBump();
      } else {
        graphDirtyRef.current = true;
      }
    };

    const unsubscribes = [
      client.on('session:registered', handler),
      client.on('session:updated', handler),
      client.on('session:ended', handler),
      client.on('auth:new', handler),
      client.on('auth:updated', handler),
      client.on('auth:output', authOutputHandler),
      // Issue 75f52ac — auth:merged flips the row early (perceived-latency fix);
      // it reuses the resolved handler (terminal output flush + row dispatch).
      client.on('auth:merged', authResolvedHandler),
      client.on('auth:resolved', authResolvedHandler),
      client.on('work:branch:updated', handler),
      client.on('conversation:new', conversationHandler),
      client.on('conversation:updated', conversationHandler),
      client.on('heartbeat', heartbeatHandler),
      client.on('ledger:issue:created', ledgerHandler),
      client.on('ledger:issue:updated', ledgerHandler),
      client.on('ledger:issue:closed', ledgerHandler),
      client.on('ledger:issue:reopened', ledgerHandler),
      client.on('ledger:comment:created', ledgerHandler),
      client.on('ledger:comment:updated', ledgerHandler),
      client.on('ledger:label:updated', ledgerHandler),
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
      client.on('console:telemetry', consoleTelemetryHandler),
      client.on('console:permission:request', consolePermissionHandler),
      client.on('console:permission:cleared', consolePermissionHandler),
      client.on('session:registered', graphRefreshHandler),
      client.on('session:updated', graphRefreshHandler),
      client.on('session:ended', graphRefreshHandler),
      client.on('auth:new', graphRefreshHandler),
      client.on('auth:updated', graphRefreshHandler),
      client.on('auth:merged', graphRefreshHandler),
      client.on('auth:resolved', graphRefreshHandler),
      // Issue 75f52ac — auth:finalized only invalidates cached graph/queue data
      // (background finalizers landed); the row already flipped at auth:merged.
      client.on('auth:finalized', graphRefreshHandler),
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

    // Reconnect resync: the server has no event replay, so a reconnect after a
    // dropped stream (e.g. a daemon self-merge restart) may have missed events.
    // On a real reconnect, bust the API cache and refetch the visible route plus
    // badges so the dashboard converges on current state.
    const offState = client.onState((state, { reconnected }) => {
      sseStateRef.current = state;
      if (!reconnected) return;
      invalidateApiGetCache();
      lastDashboardSseAtRef.current = Date.now();
      void loadVisibleRouteDataRef.current(routeTabRef.current);
      void loadDashboardBadges();
      // A reconnect gap may have missed graph-affecting events; converge the
      // graph too (bump now if active/visible, else mark dirty).
      if (routeTabRef.current === 'graph' && document.visibilityState === 'visible') {
        setGraphRefreshToken((n) => n + 1);
      } else {
        graphDirtyRef.current = true;
      }
    });

    // Connect AFTER all handlers are registered
    client.connect();

    return () => {
      if (badgeTimer !== null) window.clearTimeout(badgeTimer);
      if (graphTokenTimer !== null) window.clearTimeout(graphTokenTimer);
      if (issuesRefreshTimer !== null) window.clearTimeout(issuesRefreshTimer);
      unsubscribes.forEach((unsubscribe) => unsubscribe());
      offState();
      outputCoalescer.dispose();
      client.close();
    };
  }, [loadDashboardBadges]);

  // Graph-activation flush: when the graph tab becomes active (or becomes
  // visible again while active) and a graph-affecting event was buffered while
  // it was hidden/inactive, repaint exactly once.
  useEffect(() => {
    if (route.tab !== 'graph') return undefined;
    const flush = () => {
      if (document.visibilityState !== 'visible') return;
      if (!graphDirtyRef.current) return;
      graphDirtyRef.current = false;
      setGraphRefreshToken((n) => n + 1);
    };
    flush();
    document.addEventListener('visibilitychange', flush);
    return () => document.removeEventListener('visibilitychange', flush);
  }, [route.tab]);

  // Fallback polling: periodically fetch fresh data so the UI stays current
  // even if the SSE connection drops events or disconnects silently.
  useEffect(() => {
    const POLL_INTERVAL = 10_000;
    // Freshness is now connection health, not last-event receipt: while the
    // shared SSE socket is open and a server heartbeat arrived within the last
    // three 15 s intervals, the live stream is authoritative and the heavy
    // fallback fetch is skipped. A dropped/closed socket re-enables the poll.
    const SSE_FRESH_FOR = 45_000;
    const timer = window.setInterval(() => {
      if (shouldSkipFallbackPoll(sseStateRef.current, lastDashboardSseAtRef.current, Date.now(), SSE_FRESH_FOR)) {
        return;
      }
      void loadVisibleRouteData(route.tab);
      void loadDashboardBadges();
    }, POLL_INTERVAL);

    return () => window.clearInterval(timer);
  }, [route.tab, loadDashboardBadges, loadVisibleRouteData]);

  // Bug: 645f8a8 — splash is active for either a self-merge rebuild (SSE-driven)
  // or a mid-startup / not-ready daemon (probe-driven). Mutations are gated off
  // while the splash is active: the daemon is not ready for normal use.
  const splashActive = rebuilding || daemonStarting;
  const daemonReady = !splashActive;

  // Initial mount plus low-cost background probe. Besides detecting explicit
  // not-ready states, the epoch comparison catches a self-merge whose SSE
  // rebuilding event was missed while EventSource was reconnecting.
  // mid-startup will not have seen the mandible:rebuilding SSE event. Probe
  // /api/health once on mount; enter the splash ONLY on a POSITIVE not-ready
  // signal — a successful health response that reports rebuilding or ready
  // !== true (see shouldEnterSplashOnProbe). A failed / indeterminate cold-mount
  // probe (health === null) must NOT hijack the UI: a daemon that cannot serve
  // health did not serve this page either, and we must not flash the splash on
  // every normal load. (The POLL predicate keeps the splash up through the
  // exit/restart gap once it is already active — that is a different question.)
  useEffect(() => {
    if (splashActive) return;
    let cancelled = false;
    const probe = async () => {
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
      setDaemonWarm(daemonIsWarm(health));
      const previousEpoch = getLastSeenStartupEpoch();
      const previousCommit = getLastSeenCommit();
      const currentEpoch = daemonStartupEpoch(health);
      const currentCommit = daemonStartupCommit(health);
      if (!shouldEnterSplashOnBackgroundProbe(health, previousEpoch)) {
        if (currentEpoch && !previousEpoch) setLastSeenStartupEpoch(currentEpoch);
        if (currentCommit && !previousCommit) setLastSeenCommit(currentCommit);
        return;
      }
      splashEpochRef.current = previousEpoch ?? currentEpoch;
      splashCommitRef.current = previousCommit ?? currentCommit;
      requireNewEpochRef.current = health?.rebuilding === true
        || daemonEpochChanged(health, previousEpoch);
      // Bug: afaea18 — a bare epoch change (manual/ops daemon restart) must NOT
      // require a new commit, or the page stalls on the epoch-stalled splash
      // forever. Only an announced rebuild (health still reports rebuilding)
      // advances the commit and may require it.
      requireNewCommitRef.current = splashRequiresNewCommit(health?.rebuilding === true);
      stallSinceRef.current = null;
      setStallEscape(false);
      setEpochStalled(false);
      if (health?.rebuilding) {
        setRebuilding(true);
      } else {
        setDaemonStarting(true);
      }
    };
    void probe();
    const timer = window.setInterval(() => { void probe(); }, 5_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [splashActive]);

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
    // Bug: afaea18 — how long the daemon must stay healthy on the same commit
    // (ready+warm, not rebuilding) before the stall is judged non-transient and
    // the "continue anyway" escape is surfaced.
    const STALL_ESCAPE_MS = 15_000;
    let intervalId: ReturnType<typeof window.setInterval> | null = null;
    // Give the daemon a moment to shut down before starting to poll
    const startTimer = window.setTimeout(() => {
      intervalId = window.setInterval(async () => {
        try {
          const res = await fetch('/api/health');
          if (!res.ok) return; // not up yet — keep polling
          const data = (await res.json()) as DaemonHealthSnapshot;
          setDaemonWarm(daemonIsWarm(data));
          const currentEpoch = daemonStartupEpoch(data);
          const currentCommit = daemonStartupCommit(data);
          if (data.rebuilding && !splashEpochRef.current && currentEpoch) {
            splashEpochRef.current = currentEpoch;
          }
          if (data.rebuilding && !splashCommitRef.current && currentCommit) {
            splashCommitRef.current = currentCommit;
          }
          // Reload only once the restarted daemon is mutation-safe and, for a
          // rebuild, its startup commit differs from the connected daemon.
          if (daemonIsReadyAfterEpoch(
            data,
            splashEpochRef.current,
            requireNewEpochRef.current,
          ) && (
            !requireNewCommitRef.current
            || daemonCommitChanged(data, splashCommitRef.current)
          )) {
            if (currentEpoch) setLastSeenStartupEpoch(currentEpoch);
            if (currentCommit) setLastSeenCommit(currentCommit);
            window.location.reload();
          } else if (
            requireNewEpochRef.current
            && data.ready === true
            && data.rebuilding !== true
          ) {
            setEpochStalled(true);
            // Bug: afaea18 — the stall must never be permanent. Track when it
            // began and, once the daemon has stayed healthy on the same commit
            // past the bounded window, surface the "continue anyway" escape
            // (which records the current epoch/commit as last-seen and reloads).
            stalledEpochRef.current = currentEpoch ?? splashEpochRef.current;
            stalledCommitRef.current = currentCommit ?? splashCommitRef.current;
            const now = Date.now();
            if (stallSinceRef.current === null) {
              stallSinceRef.current = now;
            }
            if (stallEscapeReady(data, now - stallSinceRef.current, STALL_ESCAPE_MS)) {
              setStallEscape(true);
            }
          } else {
            // Left the stalled condition before the escape armed; reset so a
            // later stall measures its own bounded window from scratch.
            stallSinceRef.current = null;
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

  const badges = useMemo(() => ({
    ...selectBadgeCounts(state),
    ...(dashboardBadges ?? {}),
  }), [dashboardBadges, state]);
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
      void loadDashboardBadges();
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
      void loadDashboardBadges();
    } catch {
      // Do not set a local error status — the server state is unchanged.
      // The action simply failed; inFlight cleanup in runAction is sufficient.
    }
  };

  const handleRetry = async (requestId: string) => {
    try {
      await retryAuthRequest(requestId);
      dispatch({ type: 'authResolved', requestId, status: 'pending' });
      void loadDashboardBadges();
    } catch {
      return;
    }
  };

  const handleDismiss = async (requestId: string) => {
    try {
      await dismissAuthRequest(requestId);
      dispatch({ type: 'authResolved', requestId, status: 'dismissed' });
      void loadDashboardBadges();
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
      void loadDashboardBadges();
    } catch {
      return;
    }
  };

  const handleAckAuthResult = async (requestId: string) => {
    try {
      await acknowledgeInboxItem('auth_result', requestId);
      dispatch({ type: 'ackInboxAuthResult', requestId });
      void loadDashboardBadges();
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
    transport_lane,
    channel_enabled,
    presetIds,
  }: {
    label: string;
    backend: string;
    kind: string;
    backend_type: 'pty' | 'sdk' | 'spawn' | 'acp';
    transport_lane: 'sdk' | 'pty' | 'channel' | 'acp' | 'spawn';
    channel_enabled?: boolean;
    presetIds?: string[];
  }) => {
    try {
      const result = await createConsoleSession(label, backend, kind, backend_type, {
        channel_enabled,
        transport_lane,
        presetIds,
      });
      const session = {
        pinned: false,
        unread_count: 0,
        channel_enabled: channel_enabled ?? false,
        transport_lane,
        transport_badge: result.session.transport_badge,
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

      // Instruction selections are sent with the create request so SDK sessions
      // can configure immediately and PTY/Channel sessions can apply launch-time prompts.
    } catch {
      return;
    }
  };

  const handleAckAll = async () => {
    try {
      await ackAllInbox();
      dispatch({ type: 'ackAllInboxItems' });
      void loadDashboardBadges();
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

  const renderTabPanel = (tab: RenderableTab, children: ComponentChildren): JSX.Element | null => {
    if (!visitedTabs.has(tab)) return null;
    const active = route.tab === tab;
    return (
      <AppShellProvider key={tab} value={active ? appShellContext : INACTIVE_APP_SHELL_CONTEXT}>
        <section
          className={`app-tab-panel app-tab-panel--${tab}`}
          hidden={!active}
          aria-hidden={active ? undefined : 'true'}
          data-tab={tab}
        >
          <Suspense fallback={<TabChunkFallback />}>
            {children}
          </Suspense>
        </section>
      </AppShellProvider>
    );
  };

  // Bug: 326a3e2 — full-page rebuild splash replaces normal UI entirely
  // Bug: 645f8a8 — also covers the mid-startup / not-ready daemon case.
  if (splashActive) {
    return <RebuildingSplash
      reason={rebuilding ? 'rebuilding' : 'starting'}
      epochStalled={epochStalled}
      stallEscape={stallEscape}
      onContinue={continuePastStall}
    />;
  }

  return (
    <div className="app-shell">
      {!daemonWarm && (
        <div className="daemon-warm-status" role="status" aria-live="polite">
          Still loading workspace data…
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
      <header className="app-header" data-tauri-drag-region>
        <div className="app-header__brand" title="Mandible">
          <span className="app-header__mark" aria-hidden="true">
            <MandibleHeaderLogo />
          </span>
          <span className="app-header__brand-text">Mandible</span>
        </div>
        <div className="app-header__route" aria-live="polite">{currentRouteTitle}</div>
        <div className="app-header__actions">
          <DesktopLoginStatus />
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
        {renderTabPanel('auth', (() => {
          const tabRoute = routeForTab('auth', route, tabRouteSnapshots);
          return (
            <LazyAuthQueueView
              queue={state.authQueue}
              historyQueue={state.authHistory}
              outputs={state.authOutputs}
              branchesByRepo={authBranchesByRepo}
              selectedAuthId={state.selectedAuthId}
              initialRequestId={tabRoute.params.request}
              sidebarHidden={isViewSidebarHidden(tabRoute)}
              daemonReady={daemonReady}
              instance={instanceInfo}
              onSelectAuth={handleSelectAuth}
              onApprove={handleApprove}
              onReject={handleReject}
              onRetry={handleRetry}
              onDismiss={handleDismiss}
              onUpdateField={handleUpdateAuthField}
            />
          );
        })())}
        {renderTabPanel('work', (
          (() => {
            const tabRoute = routeForTab('work', route, tabRouteSnapshots);
            return (
              <LazyWorkOverviewView
                repos={state.workRepos}
                branchesByRepo={state.workBranches}
                onRescan={handleRescan}
                params={tabRoute.params}
              />
            );
          })()
        ))}
        {renderTabPanel('issues', (() => {
          const tabRoute = routeForTab('issues', route, tabRouteSnapshots);
          return (
            <LazyIssuesView
              repos={state.issueRepos}
              onRescan={handleIssueRescan}
              initialRepoId={tabRoute.params.repo}
              initialIssueId={tabRoute.params.issue}
              initialCommentId={tabRoute.params.comment}
              defaultFilter={state.settings['issues.default_filter']}
              sidebarHidden={isViewSidebarHidden(tabRoute)}
            />
          );
        })())}
        {renderTabPanel('artifacts', (() => {
          const tabRoute = routeForTab('artifacts', route, tabRouteSnapshots);
          return (
            <LazyArtifactsView
              initialArtifactId={tabRoute.params.artifact}
              initialRef={tabRoute.params.ref}
              initialSeriesRef={tabRoute.params.series}
              initialVersionNo={parseArtifactVersionParam(tabRoute.params.version)}
              initialRepo={tabRoute.params.repo}
              initialRole={tabRoute.params.role}
              sidebarHidden={isViewSidebarHidden(tabRoute)}
            />
          );
        })())}
        {renderTabPanel('inbox', (() => {
          const tabRoute = routeForTab('inbox', route, tabRouteSnapshots);
          return (
            <LazyInboxView
              data={state.inboxData}
              loading={state.inboxLoading}
              selectedItemId={state.selectedInboxItemId}
              sidebarHidden={isViewSidebarHidden(tabRoute)}
              onSelectItem={handleSelectInboxItem}
              onAckContinuation={handleAckContinuation}
              onAckAuthResult={handleAckAuthResult}
              onAckAll={handleAckAll}
              onRefresh={handleInboxRefresh}
            />
          );
        })())}
        {renderTabPanel('console', (() => {
          const tabRoute = routeForTab('console', route, tabRouteSnapshots);
          return (
            <LazyConversationsView
              conversations={state.conversations}
              consoleSessions={state.consoleSessions}
              workRepos={state.workRepos}
              initialConversationId={tabRoute.params.conversation ?? null}
              initialSessionId={tabRoute.params.session ?? null}
              initialPresetId={tabRoute.params.preset ?? null}
              sidebarHidden={isViewSidebarHidden(tabRoute)}
              onSelectSession={handleConsoleSelectSession}
              onNewSession={handleConsoleNewSession}
            />
          );
        })())}
        {renderTabPanel('settings', (
          <LazySettingsView
            settings={state.settings}
            onSave={handleSettingsSave}
            onClose={handleSettingsClose}
            instance={instanceInfo}
          />
        ))}
        {renderTabPanel('logs', <LazyLogsView />)}
        {renderTabPanel('graph', (() => {
          const tabRoute = routeForTab('graph', route, tabRouteSnapshots);
          return (
            <LazyGraphView
              onNavigate={handleGraphNavigate}
              refreshToken={graphRefreshToken}
              initialMode={tabRoute.params.mode}
              initialFocus={tabRoute.params.focus}
              sidebarHidden={isViewSidebarHidden(tabRoute)}
            />
          );
        })())}
        {renderTabPanel('timeline', (() => {
          const tabRoute = routeForTab('timeline', route, tabRouteSnapshots);
          return (
            <LazyTimelineView
              repos={state.workRepos}
              params={tabRoute.params}
              sidebarHidden={isViewSidebarHidden(tabRoute)}
            />
          );
        })())}
        {renderTabPanel('spaces', (() => {
          const tabRoute = routeForTab('spaces', route, tabRouteSnapshots);
          return (
            <LazySpacesTab
              projectId={tabRoute.params.project ?? ''}
              spaceId={tabRoute.params.space ?? null}
              renderer={tabRoute.params.renderer}
              sidebarHidden={isViewSidebarHidden(tabRoute)}
              instance={instanceInfo}
              onNavigate={navigateToSpace}
            />
          );
        })())}
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
  // Issue 708dc4c — attach the client-auth token to every /api request, then
  // acquire one via the handshake before first render so operator mutations
  // authenticate (in strict mode too, using a token persisted during compat).
  installClientAuthFetch();
  const initialRoute = parseHashRoute();
  if (isRenderableTab(initialRoute.tab)) {
    void ROUTE_CHUNK_LOADERS[initialRoute.tab]?.();
  }
  void ensureClientAuthToken()
    .then(() => {
      // Issue 54b5677 — in the desktop shell the bootstrap proof is usually
      // gone, so a webview without an operator session asks the shell to enroll
      // it (bootstrap file first, then the operator keychain credential). This
      // is a no-op in a browser and when a session is already working, so an
      // enrolled dashboard never rotates its session just by starting up.
      if (getClientAuthSessionState() === 'enrolled') return undefined;
      return runDesktopLogin();
    })
    .catch(() => undefined)
    .finally(() => {
      render(<App />, mountNode);
    });
}

export { App };
