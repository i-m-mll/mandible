import { IntegrationIntroduction } from './components/AgentIntegrations';
import { Icon, type IconName } from './components/icons/Icon';
import { AppHoverTips, appTip } from './components/shared/AppHoverTips';
import { NativeTopBarBand } from './components/NativeTopBarBand';
import { pushAppHistory, replaceAppHistory } from './app-history';
import { useAppHistory } from './hooks/useAppHistory';
import { AppFrame } from './app-frame';
import { useChromeAppearancePreview } from './hooks/useChromeAppearancePreview';
import type { ChromeAppearanceTheme } from './chrome-appearance';
import { useNativeWindowPresentation } from './native-window-presentation';
import { browserResourceKeys, refreshBrowserResources } from './query/browserResources';
import { BRIEFING_EVENT_VALUES, DASHBOARD_BADGE_COUNTS } from '../../src/contracts';
import { render, type ComponentChildren } from 'preact';
import { lazy, Suspense } from 'preact/compat';
import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'preact/hooks';
import { QueryClientProvider } from '@tanstack/preact-query';

import {
  acknowledgeInboxItem,
  ackAllInbox,
  approveAuthRequest,
  startProviderChat,
  getAuthHistory,
  getAuthQueue,
  getConsoleSessions,
  getDashboardBadges,
  getAppThemePreference,
  isDesktopShell,
  observeNativeFrame,
  setDesktopWindowTheme,
  getInboxGlobal,
  getIssueRepos,
  getRepoBranches,
  getSettings,
  getUserAppRailOrderSetting,
  getUserTypographySetting,
  getWorkRepos,
  invalidateApiGetCache,
  invalidateDashboardCaches,
  normalizeInstanceInfo,
  sameInstanceInfo,
  loadOperationCatalog,
  triggerWorkScan,
  rejectAuthRequest,
  retryAuthRequest,
  scanIssues,
  updateAppThemePreference,
  updateSetting,
  updateUserAppRailOrderSetting,
  updateUserTypographySetting,
  canEditUserPreferences,
  canPerformOperation,
  type UserTypographySettingKey,
  type InstanceInfo,
  type DashboardBadgeCounts,
} from './api';
import {
  DEFAULT_TYPOGRAPHY_SETTINGS,
  TYPOGRAPHY_SETTING_KEYS,
  typographyCssVariables,
  typographySettingValue,
  reconcileTypographySettings,
  withTypographySetting,
} from './typography-settings';
import type { SSEPayload, SseConnectionState } from './sse-client';
import { acquireSharedSse, shouldSkipFallbackPoll } from './sse-shared';
import {
  browserSessionFetch,
  ensureClientAccess,
  getClientAccessState,
  retryClientAccess,
  subscribeClientAccessState,
} from './client-auth-token';
import { keepSubmittedBriefingAnnotations } from './views/feedback/briefing-preferences';
import { DetailPaneNotice } from './components/shared/DetailPaneNotice';
import { PreviewAppearanceTools } from './components/preview/PreviewAppearanceTools';
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
  replaceRouteHash,
  routeHashWithParams,
  shortRouteId,
  spacesRouteFromHash,
  type SpacesRouteTarget,
  type Route,
} from './routing';
import {
  AppShellProvider,
  APP_RAIL_WIDTHS,
  AppRightSidebarSurface,
  RIGHT_SIDEBAR_AUTO_COLLAPSE_WIDTH,
  WIDE_RESPONSIVE_SIDEBAR_STATE,
  responsiveSidebarThresholdTransition,
  resolveAppFrameGeometry,
  type AppRightSidebarDescriptor,
  type AppShellContextValue,
  type ResponsiveSidebarThresholdState,
} from './app-shell';
import { useAppRightSidebarState } from './right-sidebar-state';

import {
  AUTH_AUTO_RETURN_TO_OVERVIEW_SETTING,
  AUTH_AUTO_SHOW_CONSOLE_SETTING,
  AUTH_RETAIN_FINALIZED_SELECTION_SETTING,
  enabledSetting,
} from './auth-preferences';
import type { AuthRequest } from './views/auth';
import type { IssueRepoSummary } from './views/issues';
import type { WorkBranch, WorkRepo } from './views/work';
import type { GraphNodeType } from './views/graph';
import {
  appReducer,
  authEventRequiresProjectionRefresh,
  initialState,
  loadCachedState,
  saveCachedState,
  selectBadgeCounts,
  parseAuthOutputEvent,
  parseAuthResolvedId,
} from './state';
import { createAuthOutputCoalescer } from './auth-output-coalescer';
import type { BugRef, ConsoleSessionPayload } from './state';
import {
  normalizeAppThemeMode,
  normalizeTerminalThemeId,
  resolveAppThemeMode,
  resolveTerminalTheme,
} from './theme';
import {
  readInitialViewSidebarWidths,
  viewSidebarGeometryForRoute,
  type ViewSidebarWidths,
} from './view-sidebar-geometry';

import {
  adoptAgentSessionFragment,
  getAgentPageBinding,
  hashWithAgentSession,
  subscribeAgentPageBinding,
} from './agent-page-binding';
import { normalizeSidebarGroupLimit } from './components/shared/sidebar-group-settings';
import { queryClient } from './query/client';
import { applyConversationSse } from './query/conversationSse';
import { AgentationPreview } from './annotation/AgentationPreview';
import { AgentationToggleButton } from './annotation/AgentationToggleButton';
import type { ConversationAppendPayload } from './query/conversationData';
import {
  APP_RAIL_ORDER_SETTING_KEY,
  DEFAULT_APP_RAIL_ORDER,
  moveAppRailItem,
  parseAppRailOrderSetting,
  readAppRailPreviewOrder,
  clearAppRailPreviewOrder,
  reconcileAppRailOrder,
  serializeAppRailOrderSetting,
  hasExplicitStartupDestination,
  startupRailDestination,
  writeAppRailPreviewOrder,
  type AppRailGroup,
  type AppRailOrderPreference,
} from './app-rail-order';

import '@xterm/xterm/css/xterm.css';
import '@xyflow/react/dist/style.css';
import './components/spaces/AddToSpace.css';
import './views/filters/issue-predicate-filter.css';
import './views/spaces/DocumentBlockEditor.css';
import './views/spaces/DocumentRenderer.css';
import './views/spaces/renderers.css';
import './views/spaces/space-board.css';
import './views/spaces/SpaceCanvas.css';
import './views/spaces/space-collection.css';
import './views/spaces/SpaceExportDialog.css';
import './views/spaces/SpaceItemPicker.css';
import './views/spaces/SpaceSeedDialog.css';
import './views/spaces/SpacesSidebar.css';
import './views/spaces/SpacesViewShell.css';
import { savedSpacesSelection, writeSpacesLastView } from './views/spaces/last-view';
import './views/spaces/SpaceTypeIndicator.css';
import './views/tasks.css';
import './style.css';

const LAST_SEEN_COMMIT_KEY = 'mandible-last-seen-commit';
const LAST_SEEN_STARTUP_EPOCH_KEY = 'mandible-last-seen-startup-epoch';
const THEME_COLOR_BY_RESOLVED_THEME = {
  dark: '#181818',
  light: '#FFFFFF',
} as const;
type RenderableTab = Exclude<Route['tab'], 'chat-history'>;
type RouteInitialDataContext = {
  settings: Record<string, string>;
  instanceInfo: InstanceInfo | null;
  sidebarGroupLimit: number;
  agentBinding: string | null;
};
type RouteInitialDataWarmer = (
  params: Record<string, string>,
  context: RouteInitialDataContext,
) => Promise<void>;
type RouteDataLoadOptions = { background?: boolean; route?: Route };

async function warmRouteModule(
  module: { warmInitialData: RouteInitialDataWarmer },
  params: Record<string, string>,
  context: RouteInitialDataContext,
): Promise<void> {
  await module.warmInitialData(params, context);
}

const RENDERABLE_TABS: RenderableTab[] = [
  'overview',
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
  'briefing',
  'tasks',
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
const loadSessionOverviewView = () =>
  import('./views/session-overview').then((module) => ({ default: module.SessionOverviewView }));
const loadBriefingView = () =>
  import('./views/briefing').then((module) => ({ default: module.BriefingView }));
const loadTasksView = () =>
  import('./views/tasks').then((module) => ({ default: module.TasksView }));

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
const LazySessionOverviewView = lazy(loadSessionOverviewView);
const LazyBriefingView = lazy(loadBriefingView);
const LazyTasksView = lazy(loadTasksView);

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
  overview: loadSessionOverviewView,
  briefing: loadBriefingView,
  tasks: loadTasksView,
};

const ROUTE_INITIAL_DATA_WARMERS: Partial<Record<RenderableTab, RouteInitialDataWarmer>> = {
  artifacts: async (params, context) => warmRouteModule(await import('./views/artifacts'), params, context),
  graph: async (params, context) => warmRouteModule(await import('./views/graph'), params, context),
  briefing: async (params, context) => warmRouteModule(await import('./views/briefing'), params, context),
  logs: async (params, context) => warmRouteModule(await import('./views/logs'), params, context),
  overview: async (params, context) => warmRouteModule(await import('./views/session-overview'), params, context),
  tasks: async (params, context) => warmRouteModule(await import('./views/tasks'), params, context),
  spaces: async (params, context) => warmRouteModule(await import('./views/spaces/SpacesTab'), params, context),
  timeline: async (params, context) => warmRouteModule(await import('./views/timeline'), params, context),
  issues: async (params, context) => warmRouteModule(await import('./views/issues'), params, context),
  console: async (params, context) => warmRouteModule(await import('./views/conversations'), params, context),
};

type IdleRouteWindow = Window & {
  requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
  cancelIdleCallback?: (handle: number) => void;
};

function scheduleRouteWarmup(callback: () => void): () => void {
  const idleWindow = window as IdleRouteWindow;
  if (idleWindow.requestIdleCallback) {
    const handle = idleWindow.requestIdleCallback(callback, { timeout: 1_500 });
    return () => idleWindow.cancelIdleCallback?.(handle);
  }
  const handle = window.setTimeout(callback, 150);
  return () => window.clearTimeout(handle);
}

const INACTIVE_APP_SHELL_CONTEXT: AppShellContextValue = {
  rightSidebar: null,
  registerRightSidebar: () => () => undefined,
  updateRightSidebar: () => undefined,
  registerInitialRouteLoad: () => undefined,
  setViewSidebarWidth: () => undefined,
  // Keep keep-alive route sidebars in controlled mode while hidden so they
  // cannot republish a stale local hook value over the active route's storage.
  viewSidebarWidth: null,
  active: false,
};

type MandibleBootstrapData = {
  instance?: InstanceInfo | null;
};

declare global {
  interface Window {
    __MANDIBLE_BOOTSTRAP__?: MandibleBootstrapData;
  }
}

function readBootInstanceInfo(): InstanceInfo | null {
  if (typeof window === 'undefined' || typeof document === 'undefined') return null;
  const globalInstance = window.__MANDIBLE_BOOTSTRAP__?.instance;
  const normalizedGlobalInstance = normalizeInstanceInfo(globalInstance);
  if (normalizedGlobalInstance) return normalizedGlobalInstance;
  const script = document.getElementById('mandible-bootstrap');
  const raw = script?.textContent?.trim();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as MandibleBootstrapData;
    return normalizeInstanceInfo(parsed.instance);
  } catch {
    return null;
  }
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

function updateRootAppTheme(settings: Record<string, string>, previewTheme?: ChromeAppearanceTheme, onResolved?: (theme: ChromeAppearanceTheme) => void): () => void {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return () => undefined;
  }
  const mode = previewTheme ?? normalizeAppThemeMode(settings.app_theme);
  void setDesktopWindowTheme(mode === 'system' ? null : mode).catch((error) => {
    console.error('Failed to update native window theme:', error);
  });
  const query = window.matchMedia('(prefers-color-scheme: dark)');
  const metaThemeColor = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  const apply = () => {
    const resolvedTheme = resolveAppThemeMode(mode, query.matches);
    const terminalThemeId = normalizeTerminalThemeId(
      settings[resolvedTheme === 'dark' ? 'terminal_theme_dark' : 'terminal_theme_light'],
    );
    const terminalTheme = resolveTerminalTheme(resolvedTheme, terminalThemeId);
    document.documentElement.dataset.themeMode = mode;
    document.documentElement.dataset.theme = resolvedTheme;
    onResolved?.(resolvedTheme);
    document.documentElement.dataset.terminalTheme = terminalThemeId;
    document.documentElement.style.setProperty('--terminal-bg', terminalTheme.background);
    document.documentElement.style.setProperty('--terminal-fg', terminalTheme.foreground);
    document.documentElement.style.setProperty('--terminal-cursor', terminalTheme.cursor);
    document.documentElement.style.setProperty('--terminal-selection-bg', terminalTheme.selectionBackground);
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
  icon: IconName;
};

type AppRailPreviewOrder = string[];

type AppRailDrag = {
  itemId: string;
  pointerId: number;
  startX: number;
  startY: number;
  active: boolean;
  overId: string;
  originOrder: AppRailPreviewOrder;
  order: AppRailPreviewOrder;
};

const APP_RAIL_DRAG_THRESHOLD_PX = 6;

// Tabs that use the shared resize-rail layout (<ViewSidebar>) and therefore want
// full-bleed content (no .app-content gutters). Issue e29a8c5.
const RESIZE_RAIL_TABS = new Set<Route['tab']>([
  'auth',
  'artifacts',
  'briefing',
  'console',
  'graph',
  'inbox',
  'issues',
  'spaces',
  'tasks',
  'timeline',
  'work',
]);

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
      <NativeTopBarBand />
      <div className="rebuilding-splash__content">
        <div className="rebuilding-splash__spinner" aria-hidden="true" />
        <div className="rebuilding-splash__title">
          {isRebuilding ? 'Rebuilding & restarting…' : 'Starting Mandible…'}
        </div>
        <div className="rebuilding-splash__subtitle">
          {stallEscape
            ? 'The daemon is healthy, but still on its previous commit: the rebuild did not restart it. You can continue.'
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

function App(): JSX.Element {
  const [agentationVisible, setAgentationVisible] = useState(() => {
    try { return window.localStorage.getItem('mandible.agentation.visible:v1') === 'true'; }
    catch { return false; }
  });
  useEffect(() => {
    try { window.localStorage.setItem('mandible.agentation.visible:v1', String(agentationVisible)); }
    catch { /* Annotation availability does not depend on view preference storage. */ }
  }, [agentationVisible]);
  const [clientAccess, setClientAccess] = useState(getClientAccessState);
  const [accessEverReady, setAccessEverReady] = useState(clientAccess.phase === 'ready');
  const accessReady = clientAccess.phase === 'ready';
  useEffect(() => {
    const unsubscribe = subscribeClientAccessState((next) => {
      setClientAccess(next);
      if (next.phase === 'ready') setAccessEverReady(true);
    });
    void ensureClientAccess();
    const retry = () => {
      if (document.visibilityState !== 'visible') return;
      if (getClientAccessState().phase === 'failed') void retryClientAccess();
    };
    window.addEventListener('online', retry);
    document.addEventListener('visibilitychange', retry);
    return () => {
      unsubscribe();
      window.removeEventListener('online', retry);
      document.removeEventListener('visibilitychange', retry);
    };
  }, []);
  const [state, dispatch] = useReducer(appReducer, undefined, () => ({
    ...initialState,
    ...loadCachedState(),
  }));
  const navigation = useAppHistory();
  const route = useMemo(() => parseRouteFromHash(hashWithAgentSession(new URL(navigation.href).hash || '#/spaces', getAgentPageBinding())), [navigation.href, navigation.revision]);
  const [startupDestinationPending, setStartupDestinationPending] = useState(() =>
    typeof window !== 'undefined' && !hasExplicitStartupDestination(window.location.hash));
  const [startupSettingsReady, setStartupSettingsReady] = useState(false);
  const [hostAppTheme, setHostAppTheme] = useState<'system' | 'light' | 'dark' | null>(null);
  const hostAppThemeRevisionRef = useRef(0);
  const [railDrag, setRailDrag] = useState<AppRailDrag | null>(null);
  const railDragRef = useRef<AppRailDrag | null>(null);
  const [pendingRailOrder, setPendingRailOrder] = useState<AppRailPreviewOrder | null>(null);
  const [railOrderReady, setRailOrderReady] = useState(false);
  const [railOrderLoadError, setRailOrderLoadError] = useState<string | null>(null);
  const [railOrderSetting, setRailOrderSetting] = useState<string | undefined>(undefined);
  const [previewRailOrder, setPreviewRailOrder] = useState<AppRailOrderPreference | null>(() => {
    if (typeof window === 'undefined') return null;
    try {
      return readAppRailPreviewOrder(window.localStorage);
    } catch {
      return null;
    }
  });
  const railMutationRef = useRef(0);
  const railMutationPendingRef = useRef(false);
  const previewOrderMigrationRef = useRef(false);
  const railRequestRef = useRef(0);
  const railRevisionRef = useRef(0);
  const [typography, setTypography] = useState(DEFAULT_TYPOGRAPHY_SETTINGS);
  const typographyRevisionRef = useRef<Record<UserTypographySettingKey, number>>({
    ui_font_face: 0,
    ui_font_size: 0,
    detail_font_face: 0,
    detail_font_size: 0,
  });
  const [railAnnouncement, setRailAnnouncement] = useState('');
  const railNavRef = useRef<HTMLElement | null>(null);
  const railRouteRef = useRef(route.tab);
  const suppressedRailClickRef = useRef<{ itemId: string; until: number } | null>(null);
  const [viewSidebarWidths, setViewSidebarWidths] = useState<ViewSidebarWidths>(
    readInitialViewSidebarWidths,
  );
  const [fallbackNoticeHost, setFallbackNoticeHost] = useState<HTMLElement | null>(null);
  const [mainNoticeHosts, setMainNoticeHosts] = useState<Array<{ id: number; host: HTMLElement }>>([]);
  const noticeHostRegistrationSequence = useRef(0);
  const registerMainNoticeHost = useCallback((host: HTMLElement) => {
    const id = ++noticeHostRegistrationSequence.current;
    setMainNoticeHosts((current) => [...current, { id, host }]);
    return () => setMainNoticeHosts((current) => current.filter((registration) => registration.id !== id));
  }, []);
  const noticeHost = mainNoticeHosts[0]?.host ?? fallbackNoticeHost;
  const [noticeHeight, setNoticeHeight] = useState(0);
  useLayoutEffect(() => {
    if (!fallbackNoticeHost || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(() => setNoticeHeight(fallbackNoticeHost.getBoundingClientRect().height));
    observer.observe(fallbackNoticeHost);
    return () => observer.disconnect();
  }, [fallbackNoticeHost]);
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
  // Unknown until the first health probe answers.
  const [daemonWarm, setDaemonWarm] = useState<boolean | null>(null);
  const [epochStalled, setEpochStalled] = useState(false);
  // Bug: afaea18 — bounded-stall escape: once the splash has been stalled on a
  // healthy same-commit daemon past STALL_ESCAPE_MS, offer an explicit exit.
  const [stallEscape, setStallEscape] = useState(false);
  const [rebuildFailure, setRebuildFailure] = useState<string | null>(null);
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
  // The self-asserted binding gates explicit page controls. It lives only for
  // this page lifetime (never localStorage), so concurrent tabs cannot share
  // either identity or optional chrome state.
  const [agentPageBinding, setAgentPageBinding] = useState<string | null>(() => getAgentPageBinding());
  useEffect(() => subscribeAgentPageBinding(setAgentPageBinding), []);
  const [registeredRightSidebar, setRegisteredRightSidebar] = useState<AppRightSidebarDescriptor | null>(null);
  const [fallbackRightSidebarState, updateFallbackRightSidebarState] = useAppRightSidebarState(
    'app',
    { open: false, width: 360 },
  );
  const rightSidebarOwnerRef = useRef<string | null>(null);
  const [viewportWidth, setViewportWidth] = useState(() => (
    typeof window === 'undefined' ? 1280 : window.innerWidth
  ));
  const responsiveSidebarStateRef = useRef<ResponsiveSidebarThresholdState>(WIDE_RESPONSIVE_SIDEBAR_STATE);
  const rightSidebarToggleRef = useRef<HTMLButtonElement>(null);
  const { trafficLightReservation: nativeControlsReservation, liquidGlassRegular } = useNativeWindowPresentation();
  const [frameHeaderHost, setFrameHeaderHost] = useState<HTMLDivElement | null>(null);
  const [frameHeaderOwners, setFrameHeaderOwners] = useState(0);
  const registerFrameHeader = useCallback(() => {
    setFrameHeaderOwners(count => count + 1);
    return () => setFrameHeaderOwners(count => count - 1);
  }, []);
  const [dashboardBadges, setDashboardBadges] = useState<DashboardBadgeCounts | null>(null);
  const lastDashboardSseAtRef = useRef(0);
  // Current shared-SSE connection state, updated from onState, so the fallback
  // poll can gate on connection health rather than last-event receipt.
  const sseStateRef = useRef<SseConnectionState>('idle');
  const [sseWireError, setSseWireError] = useState<string | null>(null);
  // Latest values for the SSE reconnect-resync closure, so the shared-SSE
  // effect need not re-run (and re-register handlers) on every route change.
  const routeTabRef = useRef(route.tab);
  routeTabRef.current = route.tab;
  const routeRef = useRef(route);
  routeRef.current = route;
  const tabRouteSnapshotsRef = useRef(tabRouteSnapshots);
  tabRouteSnapshotsRef.current = tabRouteSnapshots;
  const routeInitialDataContextRef = useRef<RouteInitialDataContext>({
    settings: state.settings,
    instanceInfo,
    sidebarGroupLimit: normalizeSidebarGroupLimit(state.settings['conversations.sidebar_group_limit']),
    agentBinding: agentPageBinding,
  });
  routeInitialDataContextRef.current = {
    settings: state.settings,
    instanceInfo,
    sidebarGroupLimit: normalizeSidebarGroupLimit(state.settings['conversations.sidebar_group_limit']),
    agentBinding: agentPageBinding,
  };
  const routeWarmupSettingsLoadRef = useRef<Promise<void>>(Promise.resolve());
  const activeRouteDataLoadRef = useRef<Promise<void>>(Promise.resolve());
  const activeRouteInitialLoadsRef = useRef(new Set<Promise<unknown>>());
  // The startup warmup is one pass per page load; an interrupted pass resumes at this tab.
  const startupRouteWarmupNextIndexRef = useRef(0);
  const loadVisibleRouteDataRef = useRef<(
    tab: Route['tab'],
    options?: RouteDataLoadOptions,
  ) => Promise<void>>(() => Promise.resolve());

  const registerRightSidebar = useCallback((ownerId: string) => {
    rightSidebarOwnerRef.current = ownerId;
    return () => {
      if (rightSidebarOwnerRef.current !== ownerId) return;
      rightSidebarOwnerRef.current = null;
      setRegisteredRightSidebar((current) => (current?.id === ownerId ? null : current));
    };
  }, []);
  const updateRightSidebar = useCallback((ownerId: string, descriptor: AppRightSidebarDescriptor) => {
    if (rightSidebarOwnerRef.current !== ownerId) return;
    setRegisteredRightSidebar((current) => current === descriptor ? current : descriptor);
  }, []);
  const registerInitialRouteLoad = useCallback((promise: Promise<unknown>) => {
    const pending = activeRouteInitialLoadsRef.current;
    if (pending.has(promise)) return;
    pending.add(promise);
    void promise.then(
      () => pending.delete(promise),
      () => pending.delete(promise),
    );
  }, []);
  const fallbackRightSidebar = useMemo<AppRightSidebarDescriptor>(() => ({
    id: 'app-preview',
    kind: 'panel',
    title: 'Preview',
    ariaLabel: 'Preview',
    icon: <Icon name="preview" size={18} />,
    content: <p className="app-right-sidebar__empty">Select an item to preview it.</p>,
    open: fallbackRightSidebarState.open,
    width: fallbackRightSidebarState.width,
    onOpenChange: (open) => updateFallbackRightSidebarState({ open }),
    onWidthChange: (width) => updateFallbackRightSidebarState({ width }),
  }), [fallbackRightSidebarState, updateFallbackRightSidebarState]);
  const rightSidebar = registeredRightSidebar ?? fallbackRightSidebar;
  const setRightSidebarOpen = useCallback((open: boolean) => {
    if (!rightSidebar || rightSidebar.open === open) return;
    if (open && viewportWidth < RIGHT_SIDEBAR_AUTO_COLLAPSE_WIDTH) {
      responsiveSidebarStateRef.current = {
        ...responsiveSidebarStateRef.current,
        rightNarrow: true,
      };
    }
    rightSidebar.onOpenChange(open);
  }, [rightSidebar, viewportWidth]);

  const viewSidebarGeometry = viewSidebarGeometryForRoute(route.tab);
  const persistedViewSidebarWidth = viewSidebarGeometry
    ? viewSidebarWidths[route.tab as keyof ViewSidebarWidths] ?? viewSidebarGeometry.defaultWidth
    : null;
  const frameRailWidth = APP_RAIL_WIDTHS[state.settings.header_display_mode === 'both' ? 'both' : 'icons'];
  const { viewSidebarWidth, rightSidebarLayout } = resolveAppFrameGeometry({
    viewportWidth, railWidth: frameRailWidth, viewSidebarWidth: persistedViewSidebarWidth,
    rightSidebar, rightSidebarOpen: route.tab !== 'settings' && rightSidebar.open, nativeControlsReservation,
  });
  const setViewSidebarWidth = useCallback((width: number | null) => {
    if (width === null || !viewSidebarGeometry) return;
    const tab = route.tab as keyof ViewSidebarWidths;
    setViewSidebarWidths((current) => (
      current[tab] === width ? current : { ...current, [tab]: width }
    ));
    if (typeof localStorage !== 'undefined' && typeof localStorage.setItem === 'function') {
      localStorage.setItem(viewSidebarGeometry.storageKey, String(width));
    }
  }, [route.tab, viewSidebarGeometry]);

  const appShellContext = useMemo<AppShellContextValue>(() => ({
    rightSidebar,
    registerRightSidebar,
    updateRightSidebar,
    registerInitialRouteLoad,
    setRightSidebarOpen,
    setViewSidebarWidth,
    viewSidebarWidth,
    active: true,
    noticeHost,
    frameHeaderHost,
    registerFrameHeader,
    registerMainNoticeHost,
  }), [frameHeaderHost, registerFrameHeader, noticeHost, registerMainNoticeHost, registerInitialRouteLoad, rightSidebar, registerRightSidebar, setRightSidebarOpen, setViewSidebarWidth, updateRightSidebar, viewSidebarWidth]);

  const effectiveSettings = useMemo(() => (
    hostAppTheme === null ? state.settings : { ...state.settings, app_theme: hostAppTheme }
  ), [hostAppTheme, state.settings]);

  const [resolvedTheme, setResolvedTheme] = useState<ChromeAppearanceTheme>(() => document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');
  const chromeAppearancePreview = useChromeAppearancePreview(instanceInfo, resolvedTheme, liquidGlassRegular);
  useEffect(() => updateRootAppTheme(effectiveSettings, chromeAppearancePreview.themeOverride, setResolvedTheme), [effectiveSettings, chromeAppearancePreview.themeOverride]);

  useEffect(() => {
    let active = true;
    const load = () => {
      void getAppThemePreference().then((preference) => {
        if (!active) return;
        hostAppThemeRevisionRef.current = preference.revision;
        setHostAppTheme(preference.value ?? normalizeAppThemeMode(state.settings.app_theme));
      }).catch(() => undefined);
    };
    load();
    window.addEventListener('focus', load);
    return () => {
      active = false;
      window.removeEventListener('focus', load);
    };
  }, []);

  useEffect(() => {
    const tab = route.tab;
    if (!isRenderableTab(tab)) return;
    setVisitedTabs((current) => {
      if (current.has(tab)) return current;
      const next = new Set(current);
      next.add(tab);
      return next;
    });
    setTabRouteSnapshots((current) => ({ ...current, [tab]: route }));
  }, [route]);

  const navigateToHash = useCallback((hash: string) => {
    if (typeof window === 'undefined') {
      return;
    }
    const boundHash = hashWithAgentSession(hash, getAgentPageBinding());
    if (window.location.hash !== boundHash) {
      pushAppHistory(boundHash, null);
    }
    setStartupDestinationPending(false);
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
    (target: SpacesRouteTarget) => {
      if (typeof window === 'undefined') return;
      if (parseHashRoute().tab !== 'spaces') return;
      navigateToHash(spacesRouteFromHash(window.location.hash || '#/spaces', target));
    },
    [navigateToHash],
  );

  useEffect(() => {
    if (startupDestinationPending) return;
    if (route.tab !== 'spaces') return;
    const { project, space } = route.params;
    if (space) {
      writeSpacesLastView({ projectId: project || null, spaceId: space });
    }
  }, [route, startupDestinationPending]);

  useEffect(() => {
    const handleChange = () => {
      const hash = window.location.hash || '#/spaces';
      const boundHash = hashWithAgentSession(hash, getAgentPageBinding());
      if (boundHash !== hash) {
        replaceAppHistory(boundHash, window.history.state, false);
      }
      if (hasExplicitStartupDestination(window.location.hash)) setStartupDestinationPending(false);
    };
    handleChange();
  }, [navigation.revision]);

  const cancelRailInteraction = useCallback((announce = false) => {
    railDragRef.current = null;
    suppressedRailClickRef.current = null;
    setRailDrag(null);
    if (announce) setRailAnnouncement('Navigation reorder cancelled.');
  }, []);

  useEffect(() => {
    if (railRouteRef.current === route.tab) return;
    railRouteRef.current = route.tab;
    cancelRailInteraction(false);
  }, [route.tab, cancelRailInteraction]);

  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || !railDragRef.current) return;
      event.preventDefault();
      cancelRailInteraction(true);
    };
    window.addEventListener('keydown', handleEscape);
    return () => {
      window.removeEventListener('keydown', handleEscape);
      railDragRef.current = null;
      suppressedRailClickRef.current = null;
    };
  }, [cancelRailInteraction]);

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

  useEffect(() => {
    if (!frameHeaderHost || !isDesktopShell()) return;
    let first = 0;
    let second = 0;
    let disposed = false;
    const schedule = (reason: 'first-frame' | 'resize' | 'visible') => {
      window.cancelAnimationFrame(first);
      window.cancelAnimationFrame(second);
      first = window.requestAnimationFrame(() => {
        second = window.requestAnimationFrame(() => {
          if (disposed || document.visibilityState === 'hidden') return;
          void observeNativeFrame(reason).catch(error => console.error('Native frame observation failed:', error));
        });
      });
    };
    const resized = () => schedule('resize');
    const visible = () => { if (document.visibilityState === 'visible') schedule('visible'); };
    schedule('first-frame');
    window.addEventListener('resize', resized);
    document.addEventListener('visibilitychange', visible);
    return () => {
      disposed = true;
      window.cancelAnimationFrame(first);
      window.cancelAnimationFrame(second);
      window.removeEventListener('resize', resized);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [frameHeaderHost, nativeControlsReservation]);

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

  // The daemon pushes `dashboard:badges` on every change; this GET resyncs only
  // on mount and SSE reconnect. A push that lands while it is in flight is newer.
  const dashboardBadgePushesRef = useRef(0);
  const loadDashboardBadges = useCallback(async () => {
    const pushesAtStart = dashboardBadgePushesRef.current;
    try {
      const counts = await getDashboardBadges();
      if (dashboardBadgePushesRef.current === pushesAtStart) setDashboardBadges(counts);
    } catch {
      // Cached full-view state remains a usable fallback when the aggregate is unavailable.
    }
  }, []);

  const loadWorkData = useCallback(async (
    includeBranches: boolean,
    options: RouteDataLoadOptions = {},
  ) => {
    const repos = await getWorkRepos<WorkRepo>();
    dispatch({ type: 'setWorkRepos', repos });
    if (!includeBranches) return;
    const loadRepoBranches = async (repo: WorkRepo) => {
      const repoId = getRepoId(repo);
      if (!repoId) return;
      const branches = await getRepoBranches<WorkBranch>(repoId);
      dispatch({ type: 'setRepoBranches', repoId, branches });
    };
    if (!options.background) {
      await Promise.all(repos.map(loadRepoBranches));
      return;
    }
    if (options.route?.tab !== 'work') return;
    const requestedRepo = options.route.params.repo;
    const selectedRepo = repos.find((repo) => getRepoId(repo) === requestedRepo)
      ?? repos.find((repo) => getRepoId(repo) === 'mandible' || repo.name === 'mandible')
      ?? repos[0];
    if (selectedRepo) await loadRepoBranches(selectedRepo);
  }, []);

  const loadVisibleRouteData = useCallback(async (
    tab: Route['tab'],
    options: RouteDataLoadOptions = {},
  ) => {
    if (!accessReady) return;
    try {
      switch (tab) {
        case 'auth':
          await Promise.all([
            getAuthQueue<AuthRequest>().then((queue) => dispatch({ type: 'setAuthQueue', queue })),
            getAuthHistory<AuthRequest>(200).then((history) => dispatch({ type: 'setAuthHistory', history })),
            loadWorkData(!options.background, options),
          ]);
          return;
        case 'console':
        case 'chat-history':
          await Promise.all([
            getConsoleSessions<ConsoleSessionPayload>().then((sessions) => dispatch({
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
          // Startup already reads settings for the whole app.
          if (options.background) return;
          dispatch({ type: 'setSettingsLoadError', error: null });
          await getSettings().then((settings) => dispatch({ type: 'setSettings', settings }));
          return;
        case 'work':
          await loadWorkData(true, options);
          return;
        case 'timeline':
          await loadWorkData(false);
          return;
        default:
          return;
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      if (tab === 'inbox') dispatch({ type: 'setInboxLoadError', error: message });
      if (tab === 'settings') dispatch({ type: 'setSettingsLoadError', error: message });
      if (options.background) throw error;
    }
  }, [accessReady, loadWorkData]);
  loadVisibleRouteDataRef.current = loadVisibleRouteData;

  const refreshRailOrder = useCallback(async (): Promise<void> => {
    if (!instanceInfo || !canEditUserPreferences(instanceInfo)) return;
    const legacyPreviewOrder = instanceInfo.role === 'preview'
      && instanceInfo.allowed_effects.includes('preferences:instance')
      && !instanceInfo.allowed_effects.includes('maintenance:shared')
      ? readAppRailPreviewOrder(window.localStorage)
      : null;
    if (legacyPreviewOrder && previewOrderMigrationRef.current) return;
    if (legacyPreviewOrder) previewOrderMigrationRef.current = true;
    const request = railRequestRef.current + 1;
    railRequestRef.current = request;
    const mutationAtStart = railMutationRef.current;
    setRailOrderReady(false);
    setRailOrderLoadError(null);
    try {
      let setting = await getUserAppRailOrderSetting();
      if (legacyPreviewOrder) {
        if (railRequestRef.current !== request || railMutationRef.current !== mutationAtStart) return;
        setting = await updateUserAppRailOrderSetting(serializeAppRailOrderSetting(legacyPreviewOrder));
        clearAppRailPreviewOrder(window.localStorage);
        setPreviewRailOrder(null);
      }
      if (
        railRequestRef.current !== request
        || railMutationRef.current !== mutationAtStart
        || setting.revision < railRevisionRef.current
      ) return;
      railRevisionRef.current = setting.revision;
      setRailOrderSetting(setting.value ?? undefined);
      setRailOrderReady(true);
    } catch (error) {
      if (railRequestRef.current === request) {
        setRailOrderReady(false);
        setRailOrderLoadError(error instanceof Error ? error.message : 'Navigation preferences could not be loaded.');
      }
    } finally {
      if (legacyPreviewOrder) previewOrderMigrationRef.current = false;
    }
  }, [instanceInfo?.allowed_effects, instanceInfo?.role]);

  const refreshTypography = useCallback(async (): Promise<void> => {
    if (!instanceInfo || !canEditUserPreferences(instanceInfo)) return;
    try {
      const snapshots = await Promise.all(TYPOGRAPHY_SETTING_KEYS.map(getUserTypographySetting));
      setTypography((current) => {
        const reconciled = reconcileTypographySettings(current, typographyRevisionRef.current, snapshots);
        typographyRevisionRef.current = reconciled.revisions;
        return reconciled.settings;
      });
    } catch {
      // Keep the current/default typography when authenticated settings are unavailable.
    }
  }, [instanceInfo?.allowed_effects]);

  useEffect(() => {
    if (instanceInfo && canEditUserPreferences(instanceInfo)) void refreshTypography();
    if (instanceInfo && !canEditUserPreferences(instanceInfo)) {
      setTypography(DEFAULT_TYPOGRAPHY_SETTINGS);
    }
  }, [instanceInfo?.allowed_effects, refreshTypography]);

  const handleTypographySave = useCallback(async (
    key: UserTypographySettingKey,
    value: string,
  ): Promise<void> => {
    if (!canEditUserPreferences(instanceInfo)) {
      throw new Error('Typography settings are unavailable in this instance');
    }
    const previousValue = typographySettingValue(typography, key);
    const revisionAtStart = typographyRevisionRef.current[key];
    setTypography((current) => withTypographySetting(current, key, value));
    try {
      const snapshot = await updateUserTypographySetting(key, value);
      if (snapshot.revision >= typographyRevisionRef.current[key]) {
        typographyRevisionRef.current[key] = snapshot.revision;
        setTypography((current) => withTypographySetting(current, key, snapshot.value));
      }
    } catch (error) {
      if (typographyRevisionRef.current[key] === revisionAtStart) {
        setTypography((current) => withTypographySetting(current, key, previousValue));
      }
      throw error;
    }
  }, [instanceInfo?.allowed_effects, typography]);

  useEffect(() => {
    if (!accessReady) return;
    if (instanceInfo && !canEditUserPreferences(instanceInfo)) {
      railRequestRef.current += 1;
      railMutationRef.current += 1;
      railMutationPendingRef.current = false;
      railRevisionRef.current = 0;
      setPendingRailOrder(null);
      setRailOrderSetting(undefined);
      setRailOrderReady(true);
      setRailOrderLoadError(null);
      return;
    }
    if (canEditUserPreferences(instanceInfo)) {
      void refreshRailOrder();
      return;
    }
    railRequestRef.current += 1;
    railMutationRef.current += 1;
    railMutationPendingRef.current = false;
    setPendingRailOrder(null);
    setRailOrderReady(false);
  }, [accessReady, instanceInfo?.allowed_effects, instanceInfo?.role, refreshRailOrder]);

  useEffect(() => {
    const reconcileVisibleRailOrder = () => {
      if (document.visibilityState === 'visible') void refreshRailOrder();
    };
    document.addEventListener('visibilitychange', reconcileVisibleRailOrder);
    return () => document.removeEventListener('visibilitychange', reconcileVisibleRailOrder);
  }, [refreshRailOrder]);

  useEffect(() => {
    if (!accessReady) return;
    // Start the visible view request before the small global aggregate.
    const activeLoad = loadVisibleRouteData(route.tab);
    activeRouteDataLoadRef.current = activeLoad;
    void activeLoad;
    const settingsLoad = getSettings()
      .then((settings) => {
        routeInitialDataContextRef.current = {
          ...routeInitialDataContextRef.current,
          settings,
          sidebarGroupLimit: normalizeSidebarGroupLimit(settings['conversations.sidebar_group_limit']),
        };
        dispatch({ type: 'setSettings', settings });
        setStartupSettingsReady(true);
      })
      .catch(() => setStartupSettingsReady(true));
    routeWarmupSettingsLoadRef.current = settingsLoad;
  }, [accessReady, route.tab, loadVisibleRouteData]);

  useEffect(() => {
    if (accessReady) void loadDashboardBadges();
  }, [accessReady, loadDashboardBadges]);

  // Warm once the daemon has finished its startup work, so the warmup never meets its cold caches.
  const routeWarmupAllowed = accessReady && !rebuilding && !daemonStarting && daemonWarm === true;
  useEffect(() => {
    if (!routeWarmupAllowed) return undefined;
    let active = true;
    let cancelScheduled: () => void = () => undefined;
    const tabs = RENDERABLE_TABS.filter((tab) => Boolean(ROUTE_CHUNK_LOADERS[tab]));
    if (startupRouteWarmupNextIndexRef.current >= tabs.length) return undefined;

    const scheduleNext = () => {
      cancelScheduled = scheduleRouteWarmup(() => {
        void (async () => {
          while (active) {
            const pendingActiveLoad = activeRouteDataLoadRef.current;
            await pendingActiveLoad.catch(() => undefined);
            await Promise.resolve();
            const pendingRouteReads = [...activeRouteInitialLoadsRef.current];
            if (pendingRouteReads.length > 0) {
              await Promise.allSettled(pendingRouteReads);
              continue;
            }
            if (pendingActiveLoad === activeRouteDataLoadRef.current) break;
          }
          if (!active) return;

          const tab = tabs[startupRouteWarmupNextIndexRef.current];
          if (!tab) return;
          startupRouteWarmupNextIndexRef.current += 1;
          if (tab !== routeTabRef.current) {
            const tabRoute = routeForTab(tab, routeRef.current, tabRouteSnapshotsRef.current);
            try {
              if (tab === 'issues' || tab === 'console') {
                while (active) {
                  const settingsLoad = routeWarmupSettingsLoadRef.current;
                  await settingsLoad.catch(() => undefined);
                  if (settingsLoad === routeWarmupSettingsLoadRef.current) break;
                }
              }
              if (!active || tab === routeTabRef.current) {
                if (active) scheduleNext();
                return;
              }
              await ROUTE_CHUNK_LOADERS[tab]?.();
              if (active && tab !== routeTabRef.current) {
                await loadVisibleRouteDataRef.current(tab, { background: true, route: tabRoute });
              }
              if (active && tab !== routeTabRef.current) {
                await ROUTE_INITIAL_DATA_WARMERS[tab]?.(tabRoute.params, routeInitialDataContextRef.current);
              }
            } catch (error) {
              // Speculative reads never surface as route notices. Keep one console
              // diagnostic so a failed warmup can still be distinguished from a hit.
              console.warn(`Initial ${tab} route warmup failed`, error);
            }
          }
          if (active) scheduleNext();
        })();
      });
    };

    scheduleNext();
    return () => {
      active = false;
      cancelScheduled();
    };
  }, [routeWarmupAllowed]);

  // SSE real-time updates: register handlers FIRST, then connect, so no
  // events arrive before we are ready to dispatch them.
  useEffect(() => {
    if (!accessReady) return;
    const client = acquireSharedSse();
    // Coalesced issues-list refetch while the issues tab is active.
    let issuesRefreshTimer: number | null = null;
    const scheduleIssuesRefresh = () => {
      if (issuesRefreshTimer !== null) return;
      issuesRefreshTimer = window.setTimeout(() => {
        issuesRefreshTimer = null;
        void loadVisibleRouteDataRef.current('issues');
      }, 1000);
    };
    let authProjectionRefreshTimer: number | null = null;
    const scheduleAuthProjectionRefresh = () => {
      if (routeTabRef.current !== 'auth' || authProjectionRefreshTimer !== null) return;
      authProjectionRefreshTimer = window.setTimeout(() => {
        authProjectionRefreshTimer = null;
        void loadVisibleRouteDataRef.current('auth');
      }, 50);
    };
    const handler = (payload: SSEPayload) => {
      lastDashboardSseAtRef.current = Date.now();
      dispatch({ type: 'sse', payload });
      if (authEventRequiresProjectionRefresh(payload.type)) {
        scheduleAuthProjectionRefresh();
      }
    };
    const briefingHandler = () => {
      lastDashboardSseAtRef.current = Date.now();
    };
    const dashboardBadgesHandler = (payload: SSEPayload) => {
      lastDashboardSseAtRef.current = Date.now();
      const counts = DASHBOARD_BADGE_COUNTS.safeParse(payload.data);
      if (!counts.success) return;
      dashboardBadgePushesRef.current += 1;
      setDashboardBadges(counts.data);
    };
    const managedReminderHandler = (payload: SSEPayload) => {
      handler(payload);
      window.dispatchEvent(new CustomEvent('managed-reminder:sse', {
        detail: { type: payload.type },
      }));
      if (routeTabRef.current === 'inbox') {
        void loadVisibleRouteDataRef.current('inbox');
      }
    };
    const taskCommandHandler = (payload: SSEPayload) => {
      handler(payload);
      const data = typeof payload.data === 'object' && payload.data !== null
        ? payload.data
        : payload;
      window.dispatchEvent(new CustomEvent('task-command:sse', {
        detail: { type: payload.type, data },
      }));
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
      if (payload.type === 'conversation:new' || payload.type === 'conversation:updated') {
        applyConversationSse(
          queryClient,
          payload.type as 'conversation:new' | 'conversation:updated',
          data as ConversationAppendPayload,
        );
      }
    };
    const userSettingHandler = (payload: SSEPayload) => {
      lastDashboardSseAtRef.current = Date.now();
      const data = typeof payload.data === 'object' && payload.data !== null
        ? payload.data as Record<string, unknown>
        : null;
      if (data?.version !== 1 || !Number.isSafeInteger(data.revision)) return;
      if (data.key === APP_RAIL_ORDER_SETTING_KEY) {
        if ((data.revision as number) > railRevisionRef.current) void refreshRailOrder();
        return;
      }
      if (
        TYPOGRAPHY_SETTING_KEYS.includes(data.key as UserTypographySettingKey)
        && (data.revision as number) > typographyRevisionRef.current[data.key as UserTypographySettingKey]
      ) void refreshTypography();
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
      setRebuildFailure(null);
      setRebuilding(true);
    };

    // Issue a09b4d2 — the merge landed but Mandible did not update.
    const rebuildFailedHandler = (payload: SSEPayload) => {
      setRebuildFailure((payload.data as { message: string }).message);
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
      client.on('auth:finalized', handler),
      client.on('auth:lifecycle', handler),
      client.on('work:branch:updated', handler),
      client.on('work:scan:completed', (payload) => {
        handler(payload);
        window.dispatchEvent(new CustomEvent('work:scan:completed'));
      }),
      client.on('conversation:new', conversationHandler),
      client.on('conversation:updated', conversationHandler),
      client.on('user-setting:updated', userSettingHandler),
      ...BRIEFING_EVENT_VALUES.map((type) => client.on(type, briefingHandler)),
      client.on('managed-reminders.changed', managedReminderHandler),
      client.on('managed-reminders.occurred', managedReminderHandler),
      client.on('tasks.commands.changed', taskCommandHandler),
      client.on('heartbeat', heartbeatHandler),
      client.on('dashboard:badges', dashboardBadgesHandler),
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
      client.on('mandible:rebuilding', rebuildingHandler),
      client.on('mandible:rebuild-failed', rebuildFailedHandler),
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
    const offState = client.onState((state, { reconnected, error }) => {
      sseStateRef.current = state;
      setSseWireError(error ?? null);
      if (!reconnected) return;
      // Events may have been missed while disconnected: no cached read is fresh any more.
      invalidateDashboardCaches();
      lastDashboardSseAtRef.current = Date.now();
      void loadVisibleRouteDataRef.current(routeTabRef.current);
      void loadDashboardBadges();
      void refreshRailOrder();
      void refreshBrowserResources(queryClient, [browserResourceKeys.briefings]);
    });

    // Connect AFTER all handlers are registered
    client.connect();

    return () => {
      if (issuesRefreshTimer !== null) window.clearTimeout(issuesRefreshTimer);
      if (authProjectionRefreshTimer !== null) window.clearTimeout(authProjectionRefreshTimer);
      unsubscribes.forEach((unsubscribe) => unsubscribe());
      offState();
      outputCoalescer.dispose();
      client.close();
    };
  }, [accessReady, loadDashboardBadges, refreshRailOrder, refreshTypography]);

  // Fallback polling: periodically fetch fresh data so the UI stays current
  // even if the SSE connection drops events or disconnects silently.
  useEffect(() => {
    if (!accessReady) return;
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
      // Without a live stream no event invalidates cached reads, so the poll reads the network.
      invalidateDashboardCaches();
      void loadVisibleRouteData(route.tab);
      void refreshRailOrder();
    }, POLL_INTERVAL);

    return () => window.clearInterval(timer);
  }, [accessReady, route.tab, loadVisibleRouteData, refreshRailOrder]);

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
        const res = await browserSessionFetch('/api/health');
        health = res.ok ? ((await res.json()) as DaemonHealthSnapshot) : null;
      } catch {
        health = null;
      }
      if (cancelled) return;
      if (health?.instance) {
        const normalized = normalizeInstanceInfo(health.instance);
        if (normalized) {
          try { await loadOperationCatalog(normalized); }
          catch (error) { console.error('Operation catalog unavailable', error); }
          if (cancelled) return;
        }
        setInstanceInfo((current) => (sameInstanceInfo(current, normalized) ? current : normalized));
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
    // (ready, not rebuilding) before the stall is judged non-transient and
    // the "continue anyway" escape is surfaced.
    const STALL_ESCAPE_MS = 15_000;
    let intervalId: number | null = null;
    // Give the daemon a moment to shut down before starting to poll
    const startTimer = window.setTimeout(() => {
      intervalId = window.setInterval(async () => {
        try {
          const res = await browserSessionFetch('/api/health');
          if (!res.ok) return; // not up yet — keep polling
          const data = (await res.json()) as DaemonHealthSnapshot;
          setDaemonWarm(daemonIsWarm(data));
          const currentEpoch = daemonStartupEpoch(data);
          const currentCommit = daemonStartupCommit(data);
          // Issue a09b4d2 — a rebuild that will not restart the daemon is a
          // failure to report, not a stall to wait out: end the splash on the
          // serving daemon and let the toast carry the message.
          const failure = requireNewCommitRef.current ? data.rebuild_failure?.message : undefined;
          if (failure) {
            if (currentEpoch) setLastSeenStartupEpoch(currentEpoch);
            if (currentCommit) setLastSeenCommit(currentCommit);
            setRebuildFailure(failure);
            setRebuilding(false);
            return;
          }
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
    state.authQueue,
    state.authHistory,
    state.selectedAuthId,
    state.workRepos,
    state.workBranches,
    state.issueRepos,
    state.inboxData,
    state.selectedInboxItemId,
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
  const handleNavigateAuthRequest = (id: string | null) => {
    if (routeRef.current.tab !== 'auth') return;
    replaceRouteHash(routeHashWithParams(window.location.hash, 'auth', { request: id, view: null, diff_old: null, diff_new: null }));
  };

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

  // Bug: 2c826ca — allow editing auth request fields from the dashboard
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

  const saveAppTheme = async (value: string) => {
    const theme = normalizeAppThemeMode(value);
    const previous = hostAppTheme ?? normalizeAppThemeMode(state.settings.app_theme);
    setHostAppTheme(theme);
    try {
      let saved;
      try {
        saved = await updateAppThemePreference(theme, hostAppThemeRevisionRef.current);
      } catch {
        const current = await getAppThemePreference();
        hostAppThemeRevisionRef.current = current.revision;
        saved = await updateAppThemePreference(theme, current.revision);
      }
      hostAppThemeRevisionRef.current = saved.revision;
      setHostAppTheme(saved.value ?? theme);
      dispatch({ type: 'updateSetting', key: 'app_theme', value: theme });
    } catch (error) {
      setHostAppTheme(previous);
      throw error;
    }
  };

  const handleSettingsSave = async (key: string, value: string) => {
    if (key === 'app_theme') {
      await saveAppTheme(value);
      return;
    }
    await updateSetting(key, value);
    dispatch({ type: 'updateSetting', key, value });
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

  const handleAckManagedReminderOccurrence = async (occurrenceId: string) => {
    try {
      await acknowledgeInboxItem('managed_reminder_occurrence', occurrenceId);
      dispatch({ type: 'ackInboxManagedReminderOccurrence', occurrenceId });
    } catch {
      return;
    }
  };

  const handleInboxRefresh = () => {
    dispatch({ type: 'setInboxLoading', loading: true });
    invalidateApiGetCache('/api/inbox');
    getInboxGlobal()
      .then((data) => dispatch({ type: 'setInboxData', data }))
      .catch((error: unknown) => dispatch({
        type: 'setInboxLoadError',
        error: error instanceof Error ? error.message : String(error),
      }));
  };

  // ── Console handlers ── Bug: b949700
  const handleConsoleSelectSession = (sessionId: string) => {
    dispatch({ type: 'setConsoleActiveSessionId', sessionId });
  };

  const handleNewConversation = async ({
    idempotency_key,
    provider,
    placement,
  }: {
    idempotency_key: string;
    provider: 'codex' | 'claude_code';
    placement: { kind: 'projectless' } | { kind: 'project'; project_id: string; checkout_id: string };
  }, signal?: AbortSignal) => {
      const result = await startProviderChat(idempotency_key, provider, placement, { signal });
      if (!result.conversation_id) throw new Error('The server created a chat without a conversation ID.');
      return result;
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
        // Issue f59b5bd — emit the short form; the auth view resolves prefixes.
        navigateToHash(`#/auth?request=${encodeURIComponent(shortRouteId(id.replace(/^auth_request:/, '')))}`);
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

  // Issue 037fa85 — first conditional nav item: the Session Overview shortcut
  // appears when a page-local agent_session binding was delivered at boot.
  // The view itself stays reachable for any session via #/overview deep links.
  const sessionOverviewNavItem: NavItem = {
    tab: 'overview',
    href: '#/overview',
    label: 'Session',
    title: 'Session Overview',
    icon: 'sessionOverview',
  };
  const showSessionOverviewNav = agentPageBinding !== null;

  const primaryNavItems: NavItem[] = [
    ...(showSessionOverviewNav ? [sessionOverviewNavItem] : []),
    {
      tab: 'console',
      href: '#/console',
      label: 'Chat',
      title: 'Chat',
      badge: badges.console,
      icon: 'chat',
    },
    {
      tab: 'timeline',
      href: '#/timeline',
      label: 'Timeline',
      title: 'Timeline',
      icon: 'timeline',
    },
    {
      tab: 'auth',
      href: '#/auth',
      label: 'Approvals',
      title: 'Approvals',
      badge: badges.auth,
      badgeClass: 'tab-badge--auth',
      icon: 'auth',
    },
    {
      tab: 'issues',
      href: '#/issues',
      label: 'Issues',
      title: 'Issues',
      icon: 'issues',
    },
    {
      tab: 'artifacts',
      href: '#/artifacts',
      label: 'Artifacts',
      title: 'Artifacts',
      icon: 'artifacts',
    },
    {
      tab: 'spaces',
      href: '#/spaces',
      label: 'Spaces',
      title: 'Spaces',
      icon: 'spaces',
    },
    {
      tab: 'briefing',
      href: '#/briefing',
      label: 'Briefing',
      title: 'Briefing',
      icon: 'briefing',
    },
    {
      tab: 'inbox',
      href: '#/inbox',
      label: 'Inbox',
      title: 'Inbox',
      badge: badges.inbox,
      icon: 'inbox',
    },
  ];

  const remainingUpperNavItems: NavItem[] = [
    {
      tab: 'work',
      href: '#/work',
      label: 'Projects',
      title: 'Projects',
      badge: badges.work,
      icon: 'projects',
    },
    {
      tab: 'graph',
      href: '#/graph',
      label: 'Graph',
      title: 'Graph',
      icon: 'graph',
    },
    {
      tab: 'tasks',
      href: '#/tasks',
      label: 'Tasks',
      title: 'Tasks',
      badge: badges.tasks,
      badgeClass: 'tab-badge--tasks-attention',
      icon: 'tasks',
    },
  ];
  const logsNavItem: NavItem = {
    tab: 'logs',
    href: '#/logs',
    label: 'Logs',
    title: 'Logs',
    icon: 'logs',
  };

  const previewMutationsRejected = Boolean(instanceInfo && instanceInfo.allowed_effects?.includes('maintenance:shared') !== true);
  const railOrderPreference = previewMutationsRejected && instanceInfo?.role === 'preview' && previewRailOrder
    ? previewRailOrder
    : parseAppRailOrderSetting(railOrderSetting);

  const experimentalTabs = new Set<Route['tab']>(['timeline', 'graph', 'spaces']);
  const canonicalRailItems = [...primaryNavItems, ...remainingUpperNavItems];
  const canonicalPrimaryRailItems = canonicalRailItems.filter((item) => !experimentalTabs.has(item.tab));
  const experimentalOrder: Route['tab'][] = ['timeline', 'graph', 'spaces'];
  const canonicalExperimentalRailItems = experimentalOrder
    .map((tab) => canonicalRailItems.find((item) => item.tab === tab))
    .filter((item): item is NavItem => Boolean(item));
  const persistedRailOrder: AppRailPreviewOrder = reconcileAppRailOrder(
    canonicalPrimaryRailItems.map((item) => item.tab),
    railOrderPreference.groups.primary,
  ).concat(reconcileAppRailOrder(
    canonicalExperimentalRailItems.map((item) => item.tab),
    railOrderPreference.groups.secondary,
  ));
  // Pointer movement previews only the insertion marker. Keeping DOM order
  // stable until pointerup preserves native pointer capture and link identity.
  const visibleRailOrder = pendingRailOrder ?? persistedRailOrder;
  const orderedRailItems = (experimental: boolean): NavItem[] => {
    const byId = new Map(canonicalRailItems.map((item) => [item.tab, item]));
    return visibleRailOrder
      .map((id) => byId.get(id as Route['tab']))
      .filter((item): item is NavItem => Boolean(item) && experimentalTabs.has(item!.tab) === experimental);
  };

  useEffect(() => {
    if (!startupDestinationPending || !railOrderReady || !startupSettingsReady) return;
    if (hasExplicitStartupDestination(window.location.hash)) {
      setStartupDestinationPending(false);
      return;
    }
    const destination = startupRailDestination(
      window.location.hash,
      orderedRailItems(false).map((item) => item.tab),
      orderedRailItems(true).map((item) => item.tab),
      state.settings.show_experimental_features !== 'false',
    );
    if (destination) {
      const hash = hashWithAgentSession(destination, getAgentPageBinding());
      replaceAppHistory(hash, window.history.state);
      setStartupDestinationPending(false);
    }
  }, [startupDestinationPending, railOrderReady, startupSettingsReady, railOrderSetting, previewRailOrder, state.settings.show_experimental_features, agentPageBinding]);

  const focusRailItem = (itemId: string) => {
    window.setTimeout(() => {
      const target = Array.from(railNavRef.current?.querySelectorAll<HTMLAnchorElement>('[data-rail-item]') ?? [])
        .find((item) => item.dataset.railItem === itemId);
      target?.focus();
    }, 0);
  };

  const persistRailOrder = async (
    order: AppRailPreviewOrder,
    successMessage: string,
    focusItemId?: string,
  ) => {
    if (!railOrderReady || railMutationPendingRef.current) return;
    const capability = instanceInfo
      ? canEditUserPreferences(instanceInfo) || instanceInfo.role === 'preview'
      : null;
    if (capability !== true) {
      setRailAnnouncement('Navigation order is unavailable. The previous order has been retained.');
      return;
    }
    const preference: AppRailOrderPreference = {
      version: DEFAULT_APP_RAIL_ORDER.version,
      groups: {
        primary: order.filter((id) => !experimentalTabs.has(id as Route['tab'])),
        secondary: order.filter((id) => experimentalTabs.has(id as Route['tab'])),
      },
    };
    const value = serializeAppRailOrderSetting(preference);
    const mutation = railMutationRef.current + 1;
    railMutationRef.current = mutation;
    railMutationPendingRef.current = true;
    setPendingRailOrder(order);
    if (previewMutationsRejected && !canEditUserPreferences(instanceInfo)) {
      let stored = false;
      try {
        stored = writeAppRailPreviewOrder(window.localStorage, preference);
      } catch {
        stored = false;
      }
      if (railMutationRef.current !== mutation) return;
      railMutationPendingRef.current = false;
      setPendingRailOrder(null);
      if (!stored) {
        setRailAnnouncement('Navigation order was not saved. The previous order has been restored.');
        if (focusItemId) focusRailItem(focusItemId);
        return;
      }
      setPreviewRailOrder(preference);
      setRailAnnouncement(successMessage);
      if (focusItemId) focusRailItem(focusItemId);
      return;
    }
    try {
      const result = await updateUserAppRailOrderSetting(value);
      if (railMutationRef.current !== mutation) return;
      railMutationPendingRef.current = false;
      setPendingRailOrder(null);
      setRailOrderReady(true);
      if (result.revision < railRevisionRef.current) {
        setRailAnnouncement('Navigation order was updated in another instance.');
      } else {
        railRevisionRef.current = result.revision;
        setRailOrderSetting(result.value ?? undefined);
        if (instanceInfo?.role === 'preview'
            && instanceInfo.allowed_effects.includes('preferences:instance')
            && !instanceInfo.allowed_effects.includes('maintenance:shared')) {
          clearAppRailPreviewOrder(window.localStorage);
          setPreviewRailOrder(null);
        }
        setRailAnnouncement(successMessage);
      }
      if (focusItemId) focusRailItem(focusItemId);
    } catch {
      if (railMutationRef.current !== mutation) return;
      railMutationPendingRef.current = false;
      setPendingRailOrder(null);
      setRailAnnouncement('Navigation order was not saved. The previous order has been restored.');
      if (focusItemId) focusRailItem(focusItemId);
    }
  };

  const beginRailPointer = (
    event: JSX.TargetedPointerEvent<HTMLAnchorElement>,
    itemId: string,
  ) => {
    if (
      !railOrderReady
      || railMutationPendingRef.current
      || event.button !== 0
      || event.metaKey
      || event.ctrlKey
      || event.shiftKey
      || event.altKey
    ) return;

    const originOrder: AppRailPreviewOrder = [...visibleRailOrder];
    const candidate: AppRailDrag = {
      itemId,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      active: false,
      overId: itemId,
      originOrder,
      order: originOrder,
    };
    railDragRef.current = candidate;
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const moveRailPointer = (event: JSX.TargetedPointerEvent<HTMLAnchorElement>) => {
    const current = railDragRef.current;
    if (!current || current.pointerId !== event.pointerId) return;
    const distance = Math.hypot(event.clientX - current.startX, event.clientY - current.startY);
    if (!current.active && distance < APP_RAIL_DRAG_THRESHOLD_PX) return;

    event.preventDefault();
    const groupElement = event.currentTarget.closest<HTMLElement>('.app-rail__group');
    const rows = Array.from(groupElement?.querySelectorAll<HTMLAnchorElement>('[data-rail-item]') ?? []);
    let target = rows.find((row) => event.clientY < row.getBoundingClientRect().top + row.getBoundingClientRect().height / 2);
    target ??= rows.at(-1);
    const targetId = target?.dataset.railItem ?? current.overId;
    // Pointer capture keeps dispatching move frames to the dragged link while
    // the DOM remains in its persisted order. Derive every preview from the
    // immutable pointerdown snapshot so repeated or revisited targets are
    // idempotent instead of toggling the already-moved preview.
    const nextOrder = moveAppRailItem(
      current.originOrder,
      current.itemId,
      targetId,
    );
    const next: AppRailDrag = {
      ...current,
      active: true,
      overId: targetId,
      order: nextOrder,
    };
    railDragRef.current = next;
    setRailDrag(next);
  };

  const finishRailPointer = (event: JSX.TargetedPointerEvent<HTMLAnchorElement>) => {
    const current = railDragRef.current;
    if (!current || current.pointerId !== event.pointerId) return;
    railDragRef.current = null;
    setRailDrag(null);
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    if (!current.active) return;

    void persistRailOrder(
      current.order,
      `${event.currentTarget.getAttribute('aria-label') ?? current.itemId} moved to position ${current.order.indexOf(current.itemId) + 1} of ${current.order.length}.`,
    );
    suppressedRailClickRef.current = { itemId: current.itemId, until: Date.now() + 500 };
  };

  const cancelRailPointer = (event: JSX.TargetedPointerEvent<HTMLAnchorElement>) => {
    const current = railDragRef.current;
    if (!current || current.pointerId !== event.pointerId) return;
    railDragRef.current = null;
    setRailDrag(null);
  };

  const handleRailItemKeyDown = (
    event: JSX.TargetedKeyboardEvent<HTMLAnchorElement>,
    item: NavItem,
  ) => {
    const directCommand = (
      event.ctrlKey
      && event.shiftKey
      && !event.altKey
      && !event.metaKey
      && (event.key === 'ArrowUp' || event.key === 'ArrowDown')
    );
    if (!directCommand || !railOrderReady || railMutationPendingRef.current) return;

    event.preventDefault();
    const itemIsExperimental = experimentalTabs.has(item.tab);
    const ids = visibleRailOrder.filter((id) => experimentalTabs.has(id as Route['tab']) === itemIsExperimental);
    const index = ids.indexOf(item.tab);
    const targetIndex = Math.max(0, Math.min(ids.length - 1, index + (event.key === 'ArrowUp' ? -1 : 1)));
    if (index === targetIndex) {
      setRailAnnouncement(`${item.title} is already at position ${index + 1} of ${ids.length}.`);
      return;
    }
    const nextGroupIds = moveAppRailItem(ids, item.tab, ids[targetIndex]);
    const otherIds = visibleRailOrder.filter((id) => experimentalTabs.has(id as Route['tab']) !== itemIsExperimental);
    const nextIds = itemIsExperimental ? [...otherIds, ...nextGroupIds] : [...nextGroupIds, ...otherIds];
    void persistRailOrder(
      nextIds,
      `${item.title} moved to position ${targetIndex + 1} of ${ids.length}.`,
      item.tab,
    );
  };

  const renderRailItem = (item: NavItem, reorderable = false, group: AppRailGroup = 'primary'): JSX.Element => {
    const active = !startupDestinationPending && route.tab === item.tab;
    const dragging = railDrag?.active && railDrag.itemId === item.tab;
    const dropTarget = railDrag?.active && railDrag.overId === item.tab;
    return (
      <a
        key={item.tab}
        href={hashWithAgentSession(item.href, agentPageBinding)}
        className={`app-rail__item${active ? ' app-rail__item--active' : ''}${dragging ? ' app-rail__item--dragging' : ''}${dropTarget ? ' app-rail__item--drop-target' : ''}`}
        aria-current={active ? 'page' : undefined}
        {...appTip(railDisplayMode !== 'both' ? item.label : undefined, 'right')}
        aria-label={item.title}
        aria-describedby={reorderable ? 'app-rail-reorder-instructions app-rail-reorder-status' : undefined}
        aria-keyshortcuts={reorderable ? 'Control+Shift+ArrowUp Control+Shift+ArrowDown' : undefined}
        data-rail-item={reorderable ? item.tab : undefined}
        data-rail-group={reorderable ? group : undefined}
        draggable={reorderable ? false : undefined}
        onPointerDown={reorderable ? (event) => beginRailPointer(event, item.tab) : undefined}
        onPointerMove={reorderable ? moveRailPointer : undefined}
        onPointerUp={reorderable ? finishRailPointer : undefined}
        onPointerCancel={reorderable ? cancelRailPointer : undefined}
        onLostPointerCapture={reorderable ? cancelRailPointer : undefined}
        onKeyDown={reorderable ? (event) => handleRailItemKeyDown(event, item) : undefined}
        onClick={(event) => {
          const suppressed = suppressedRailClickRef.current;
          if (suppressed?.itemId === item.tab && Date.now() <= suppressed.until) {
            suppressedRailClickRef.current = null;
            event.preventDefault();
            return;
          }
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
          <Icon name={item.icon} size={18} />
        </span>
        {railDisplayMode === 'both' && <span className="app-rail__label">{item.label}</span>}

        {item.badge ? (
          <span className={`tab-badge app-rail__badge${item.badgeClass ? ` ${item.badgeClass}` : ''}`}>
            {item.badge}
          </span>
        ) : null}
      </a>
    );
  };

  const rightSidebarAvailable = route.tab !== 'settings';
  const rightSidebarOpen = Boolean(rightSidebarAvailable && rightSidebar?.open);
  const viewSidebarAvailable = Boolean(viewSidebarGeometry);
  const viewSidebarHidden = Boolean(viewSidebarAvailable && isViewSidebarHidden(route));
  const viewSidebarOpen = Boolean(viewSidebarAvailable && !viewSidebarHidden);
  useLayoutEffect(() => {
    const reconcile = () => {
      const width = window.innerWidth;
      setViewportWidth((current) => current === width ? current : width);
      const transition = responsiveSidebarThresholdTransition(
        responsiveSidebarStateRef.current,
        width,
        { right: registeredRightSidebar !== null, view: viewSidebarAvailable },
      );
      responsiveSidebarStateRef.current = transition.state;
      if (transition.closeRight) setRightSidebarOpen(false);
      if (transition.closeView) hideViewSidebar();
    };
    reconcile();
    window.addEventListener('resize', reconcile);
    return () => {
      window.removeEventListener('resize', reconcile);
    };
  }, [hideViewSidebar, registeredRightSidebar, setRightSidebarOpen, viewSidebarAvailable]);
  const appThemeMode = normalizeAppThemeMode(effectiveSettings.app_theme);
  const nextAppThemeMode = appThemeMode === 'system' ? 'light' : appThemeMode === 'light' ? 'dark' : 'system';
  const appThemeLabel = appThemeMode === 'system' ? 'System' : appThemeMode === 'light' ? 'Light' : 'Dark';
  const nextAppThemeLabel = nextAppThemeMode === 'system' ? 'System' : nextAppThemeMode === 'light' ? 'Light' : 'Dark';
  const appThemeIcon = appThemeMode === 'system'
    ? <Icon name="themeSystem" size={18} />
    : appThemeMode === 'light'
      ? <Icon name="themeLight" size={18} />
      : <Icon name="themeDark" size={18} />;
  const renderTabPanel = (tab: RenderableTab, children: ComponentChildren): JSX.Element | null => {
    if (startupDestinationPending || !accessEverReady || !visitedTabs.has(tab)) return null;
    const active = route.tab === tab;
    return (
      <AppShellProvider key={tab} value={active ? appShellContext : INACTIVE_APP_SHELL_CONTEXT}>
        <section
          className={`app-tab-panel app-tab-panel--${tab}`}
          hidden={!active}
          aria-hidden={active ? undefined : 'true'}
          aria-busy={!accessReady}
          inert={!accessReady}
          data-tab={tab}
        >
          <Suspense fallback={null}>
            {children}
          </Suspense>
        </section>
      </AppShellProvider>
    );
  };

  // Bug: 326a3e2 — full-page rebuild splash replaces normal UI entirely
  // Bug: 645f8a8 — also covers the mid-startup / not-ready daemon case.
  const renderAppShell = (children: ComponentChildren): JSX.Element => (
    <div
      className={`app-shell app-shell--rail-${railDisplayMode}${viewSidebarOpen ? ' app-shell--view-sidebar-open' : ''}${instanceInfo?.role === 'preview' ? ' app-shell--preview' : ''}`}
      style={{
        '--app-rail-width': `${frameRailWidth}px`,
        '--app-view-sidebar-persisted-width': `${viewSidebarWidth ?? 0}px`,
        '--app-right-sidebar-width': `${rightSidebarOpen ? rightSidebarLayout.effectiveWidth : 0}px`,
        ...typographyCssVariables(typography),
      } as JSX.CSSProperties}
    >
      <div className="app-shell__workspace">{children}</div>
      <AppHoverTips />
      <PreviewAppearanceTools instance={instanceInfo} controller={chromeAppearancePreview.controller} />
    </div>
  );

  if (splashActive) {
    return renderAppShell(<RebuildingSplash
      reason={rebuilding ? 'rebuilding' : 'starting'}
      epochStalled={epochStalled}
      stallEscape={stallEscape}
      onContinue={continuePastStall}
    />);
  }

  return renderAppShell(
    <>
      {startupSettingsReady && instanceInfo?.role === 'main' && canPerformOperation(instanceInfo, 'PUT', '/api/settings/integrations') && (
        <IntegrationIntroduction settings={state.settings} onSave={handleSettingsSave} />
      )}
      {rebuildFailure && (
        // Issue 54a0b88 — report a failed self-update without taking over the view.
        <div className="daemon-toast daemon-toast--failure" role="alert">
          <span>{rebuildFailure}</span>
          <button
            type="button"
            className="daemon-toast__dismiss"
            onClick={() => setRebuildFailure(null)}
            aria-label="Dismiss update failure"
          >
            <Icon name="dismiss" />
            </button>
        </div>
      )}
      {daemonWarm === false && (
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
            <Icon name="dismiss" />
            </button>
        </div>
      )}
      <AppShellProvider value={appShellContext}>
        <AppFrame
          navigation={navigation}
          chromeAppearance={chromeAppearancePreview.controller?.themes}
          nativeControlsReservation={nativeControlsReservation}
          layoutClassName={`app-layout--route-${route.tab}`}
          headerHostRef={setFrameHeaderHost}
          hasMainHeader={frameHeaderOwners > 0}
          viewSidebarAvailable={viewSidebarAvailable}
          viewSidebarOpen={viewSidebarOpen}
          onViewSidebarToggle={viewSidebarHidden ? showViewSidebar : hideViewSidebar}
          rightSidebar={rightSidebarAvailable ? rightSidebar : null}
          rightSidebarOpen={rightSidebarOpen}
          onRightSidebarOpenChange={setRightSidebarOpen}
          rightToggleRef={rightSidebarToggleRef}
          rail={(
          <aside className="app-rail" data-app-surface="chrome" data-tauri-drag-region>
              <nav
                ref={railNavRef}
                className="app-rail__nav"
                aria-label="Main navigation"
              >
                <div className="app-rail__group" data-rail-group="upper">
                  {orderedRailItems(false).map((item) => renderRailItem(item, true, 'primary'))}
                </div>
                {state.settings.show_experimental_features !== 'false' ? (
                  <div className="app-rail__experimental" aria-label="Experimental features">
                    <div className="app-rail__experimental-header" title="Experimental features">
                      <Icon name="experimental" />
                    </div>
                    <div className="app-rail__group" data-rail-group="experimental">
                      {orderedRailItems(true).map((item) => renderRailItem(item, true, 'secondary'))}
                    </div>
                  </div>
                ) : null}
                <span id="app-rail-reorder-instructions" className="sr-only">
                  To reorder, press Control Shift Up Arrow or Control Shift Down Arrow. Enter opens the destination normally.
                </span>
                <span id="app-rail-reorder-status" className="sr-only" role="status" aria-live="polite">
                  {railAnnouncement}
                </span>
              </nav>
              <nav className="app-rail__footer" aria-label="Settings">
                <button
                  type="button"
                  className="app-rail__item app-rail__theme-toggle"
                  aria-label={`App theme: ${appThemeLabel}. Switch to ${nextAppThemeLabel}`}
                  {...appTip(`App theme: ${appThemeLabel}. Switch to ${nextAppThemeLabel}`, 'right')}
                  onClick={() => {
                    void saveAppTheme(nextAppThemeMode);
                  }}
                >
                  <span className="app-rail__icon">{appThemeIcon}</span>
                  {railDisplayMode === 'both' && <span className="app-rail__label">{appThemeLabel}</span>}

                </button>
                {renderRailItem(logsNavItem)}
                <AgentationToggleButton
                  visible={agentationVisible}
                  expandedRail={railDisplayMode === 'both'}
                  onToggle={() => setAgentationVisible(visible => !visible)}
                />
                {renderRailItem({
                  tab: 'settings',
                  href: '#/settings',
                  label: 'Settings',
                  title: 'Settings',
                  icon: 'settings',
                })}
              </nav>
          </aside>
          )}
        >
        <main
          className={`app-content${route.tab === 'console' ? ' app-content--console' : ''}${route.tab === 'graph' ? ' app-content--graph' : ''}${route.tab === 'timeline' ? ' app-content--timeline' : ''}${route.tab === 'spaces' ? ' app-content--spaces' : ''}${RESIZE_RAIL_TABS.has(route.tab) ? ' app-content--view-sidebar' : ''}`}
          data-app-surface="main"
          style={{ '--app-operational-notice-height': `${mainNoticeHosts.length > 0 ? 0 : noticeHeight}px` } as JSX.CSSProperties}
        >
        <div
          id="app-operational-notices"
          className="app-operational-notices"
          data-testid="app-operational-notices"
          data-app-operational-notice-fallback
          ref={setFallbackNoticeHost}
        />
        {sseWireError ? (
          <DetailPaneNotice severity="error" source="live-update-wire" title="Live updates need attention"
            actions={<button type="button" onClick={() => window.location.reload()}>Reload</button>}>
            {sseWireError}
          </DetailPaneNotice>
        ) : null}
        {clientAccess.phase === 'initializing' || clientAccess.phase === 'recovering' ? (
          <DetailPaneNotice severity="info" source="local-access">
            {accessEverReady ? 'Reconnecting to Mandible…' : 'Connecting to Mandible…'}
          </DetailPaneNotice>
        ) : null}
        {clientAccess.phase === 'failed' ? (
          <DetailPaneNotice
            severity="error"
            source="local-access"
            title="Mandible connection unavailable"
            actions={<button type="button" onClick={() => { void retryClientAccess(); }}>Retry</button>}
          >
            {clientAccess.failure}
          </DetailPaneNotice>
        ) : null}
        {startupDestinationPending ? (
          <DetailPaneNotice
            severity={railOrderLoadError ? 'error' : 'info'}
            source="startup-navigation"
            title={railOrderLoadError ? 'Navigation preferences could not be loaded' : undefined}
            actions={railOrderLoadError ? <button type="button" onClick={() => { void refreshRailOrder(); }}>Retry</button> : undefined}
          >
            {railOrderLoadError ?? 'Loading navigation preferences…'}
          </DetailPaneNotice>
        ) : null}
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
              reviewRouteParams={tabRoute.params}
              reviewRouteActive={route.tab === 'auth'}
              sidebarHidden={isViewSidebarHidden(tabRoute)}
              daemonReady={daemonReady}
              instance={instanceInfo}
              onSelectAuth={handleSelectAuth}
              onNavigateRequest={handleNavigateAuthRequest}
              onApprove={handleApprove}
              onReject={handleReject}
              onRetry={handleRetry}
              autoShowConsoleOnApproval={enabledSetting(state.settings, AUTH_AUTO_SHOW_CONSOLE_SETTING)}
              autoReturnToAbstractOnSuccess={enabledSetting(state.settings, AUTH_AUTO_RETURN_TO_OVERVIEW_SETTING)}
              retainFinalizedSelection={enabledSetting(state.settings, AUTH_RETAIN_FINALIZED_SELECTION_SETTING)}
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
                instance={instanceInfo}
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
              error={state.inboxLoadError}
              selectedItemId={state.selectedInboxItemId}
              sidebarHidden={isViewSidebarHidden(tabRoute)}
              onSelectItem={handleSelectInboxItem}
              onAckContinuation={handleAckContinuation}
              onAckAuthResult={handleAckAuthResult}
              onAckManagedReminderOccurrence={handleAckManagedReminderOccurrence}
              onAckAll={handleAckAll}
              onRefresh={handleInboxRefresh}
              instance={instanceInfo}
            />
          );
        })())}
        {renderTabPanel('console', (() => {
          const tabRoute = routeForTab('console', route, tabRouteSnapshots);
          return (
            <LazyConversationsView
              consoleSessions={state.consoleSessions}
              initialConversationId={tabRoute.params.conversation ?? null}
              initialSessionId={tabRoute.params.session ?? null}
              routeParams={tabRoute.params}
              sidebarHidden={isViewSidebarHidden(tabRoute)}
              sidebarGroupLimit={normalizeSidebarGroupLimit(state.settings['conversations.sidebar_group_limit'])}
              chatEntityLinkAction={state.settings.chat_entity_link_action === 'open' ? 'open' : 'preview'}
              instance={instanceInfo}
              onSelectSession={handleConsoleSelectSession}
              onNewConversation={handleNewConversation}
            />
          );
        })())}
        {renderTabPanel('settings', (
          <LazySettingsView
            settings={effectiveSettings}
            onSave={handleSettingsSave}
            loadError={state.settingsLoadError}
            onRefresh={() => void loadVisibleRouteData('settings')}
            typography={typography}
            onTypographySave={handleTypographySave}
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
        {renderTabPanel('overview', (() => {
          const tabRoute = routeForTab('overview', route, tabRouteSnapshots);
          return (
            <LazySessionOverviewView
              initialSessionId={tabRoute.params.session ?? null}
              agentBinding={agentPageBinding}
            />
          );
        })())}
        {renderTabPanel('briefing', (() => {
          const tabRoute = routeForTab('briefing', route, tabRouteSnapshots);
          return (
            <LazyBriefingView
              instance={instanceInfo}
              keepSubmittedAnnotations={keepSubmittedBriefingAnnotations(state.settings)}
              initialBriefingId={tabRoute.params.briefing ?? null}
              initialGroupId={tabRoute.params.group ?? null}
              initialRoundId={tabRoute.params.round ?? null}
              sidebarHidden={isViewSidebarHidden(tabRoute)}
            />
          );
        })())}
        {renderTabPanel('tasks', (() => {
          const tabRoute = routeForTab('tasks', route, tabRouteSnapshots);
          return (
            <LazyTasksView
              sidebarHidden={isViewSidebarHidden(tabRoute)}
              initialTaskKey={tabRoute.params.task ?? null}
            />
          );
        })())}
        {renderTabPanel('spaces', (() => {
          const tabRoute = routeForTab('spaces', route, tabRouteSnapshots);
          return (
            <LazySpacesTab
              projectId={tabRoute.params.project ?? ''}
              spaceId={tabRoute.params.space ?? null}
              savedSelection={savedSpacesSelection(tabRoute.params)}
              renderer={tabRoute.params.renderer}
              sidebarHidden={isViewSidebarHidden(tabRoute)}
              instance={instanceInfo}
              onNavigate={navigateToSpace}
            />
          );
        })())}
        </main>
          {rightSidebar ? (
            <AppRightSidebarSurface
              descriptor={rightSidebar}
              closeFocusRef={rightSidebarToggleRef}
              onOpenChange={setRightSidebarOpen}
              layout={rightSidebarLayout}
              open={rightSidebarOpen}
            />
          ) : null}
        </AppFrame>
      </AppShellProvider>
      {agentationVisible && <AgentationPreview />}
    </>
  );
}

const mountNode = typeof document !== 'undefined' ? document.getElementById('app') : null;
if (mountNode) {
  // Adopt the page-local binding before the first route parse. The parameter
  // deliberately remains in the hash and is preserved through navigation.
  adoptAgentSessionFragment();
  const initialRoute = parseHashRoute();
  if (isRenderableTab(initialRoute.tab)) {
    void ROUTE_CHUNK_LOADERS[initialRoute.tab]?.();
  }
  render(
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>,
    mountNode,
  );
}

export { App };
