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
  rejectAuthRequest,
  retryAuthRequest,
  scanIssues,
  updateAuthRequestField,
  updateSetting,
} from './api';
import { createSSEClient } from './sse-client';
import type { SSEPayload } from './sse-client';
import { parseRouteFromHash, type Route } from './routing';
import {
  AppShellProvider,
  RightSidebarIcon,
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
import { SwitchboardView } from './views/switchboard';
import type { HookTemplate, PairingHooks, SwitchboardItem, SwitchboardPairing } from './views/switchboard';
import { WorkOverviewView } from './views/work';
import type { WorkBranch, WorkRepo } from './views/work';
import { LogsView } from './views/logs';
import { GraphView } from './views/graph';
import type { GraphNodeType } from './views/graph';
import { TimelineView } from './views/timeline';
import { PresetsView } from './views/presets';
import { appReducer, initialState, loadCachedState, saveCachedState, selectBadgeCounts } from './state';
import type { BugRef, ConsoleSession } from './state';
import {
  ChatIcon,
  IssuesIcon,
  InboxIcon,
  AuthIcon,
  ArtifactsIcon,
  SettingsIcon,
  PresetsIcon,
  GraphIcon,
  TimelineIcon,
  SwitchboardIcon,
  LogsIcon,
  ProjectsIcon,
  DiffIcon,
} from './components/icons/TabIcons';

import './style.css';

const LAST_SEEN_COMMIT_KEY = 'mandible-last-seen-commit';

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


type NavItem = {
  tab: Route['tab'];
  href: string;
  label: string;
  title: string;
  badge?: number;
  badgeClass?: string;
  icon: (props: { size?: number }) => JSX.Element;
};

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
    <svg
      className="app-header__logo"
      viewBox="0 0 179.23444 168.53958"
      focusable="false"
      aria-hidden="true"
    >
      <path
        fill="currentColor"
        d="M 32.783763,167.37924 C 26.856543,162.42581 20.403413,154.7398 15.644153,146.96509 0.96083316,122.97848 -3.1828018,91.036334 4.7124132,62.695304 9.8775932,44.154156 18.632353,28.845146 31.360303,16.097476 37.543853,9.9043463 42.952283,5.7375463 48.520753,2.8766163 c 3.03891,-1.56132 4.70499,-2.09380997 6.55113,-2.09380997 1.60844,0 2.24194,0.51544997 2.24194,1.82415997 0,1.05289 -0.10524,1.2542 -2.68933,5.14437 -2.17492,3.2741797 -4.06258,6.8811097 -4.34797,8.3080897 -0.18007,0.90033 -0.31659,0.80858 1.88466,1.26656 1.47545,0.30699 2.16104,1.95282 1.40967,3.38411 -0.51243,0.97613 -1.83621,2.36954 -3.51652,3.7015 -2.08208,1.65043 -2.15272,1.7556 -2.53298,3.77091 -0.38296,2.02959 -0.1514,2.49821 1.23441,2.49821 1.95015,0 3.26639,1.01116 3.26639,2.50929 0,1.1454 -0.64255,2.04919 -3.1603,4.44515 -1.32056,1.25669 -2.51895,2.59505 -2.66307,2.97412 -0.33838,0.89002 -0.34014,3.75028 -0.002,3.959 0.14279,0.0883 0.98404,0.0291 1.86944,-0.13147 2.70071,-0.48973 3.95636,0.21079 3.95636,2.20722 0,0.9504 -0.096,1.11502 -3.52695,6.047158 -2.04774,2.94373 -3.35573,5.63825 -3.34431,6.88945 0.007,0.75272 0.29051,1.10743 2.17325,2.71779 3.18291,2.72243 12.55452,12.13476 16.37876,16.44991 8.28265,9.3459 15.13863,18.62025 22.73194,30.750366 2.49031,3.97822 3.08047,4.45914 4.86674,3.96593 0.83544,-0.23068 1.17527,-0.57649 2.21866,-2.25772 2.40619,-3.87709 8.175497,-12.442756 10.487677,-15.570986 7.72902,-10.45691 14.59801,-18.29843 24.87165,-28.39309 l 6.81601,-6.69726 -0.13588,-1.20556 c -0.18336,-1.62672 -1.61185,-4.33581 -4.29961,-8.154088 -1.22922,-1.74625 -2.30966,-3.56117 -2.40098,-4.03315 -0.43931,-2.27071 0.88807,-3.22781 3.77849,-2.72446 0.92941,0.16185 1.80443,0.22345 1.94449,0.13689 0.36488,-0.22551 0.29695,-3.59516 -0.0855,-4.23948 -0.17674,-0.2978 -1.37393,-1.54495 -2.66041,-2.77144 -2.46175,-2.34696 -3.0849,-3.22854 -3.0849,-4.36428 0,-1.48644 1.30925,-2.50436 3.23265,-2.51334 1.55973,-0.007 1.68541,-0.23813 1.32165,-2.42775 -0.29832,-1.7957 -0.40155,-1.99996 -1.44528,-2.85986 -2.09166,-1.72325 -4.2201,-3.83287 -4.59153,-4.55093 -0.39286,-0.75948 -0.47541,-1.74455 -0.20522,-2.44868 0.1926,-0.50189 1.44708,-1.20248 2.15319,-1.20248 0.27046,0 0.69658,-0.14979 0.94695,-0.33286 0.42934,-0.31394 0.42665,-0.41548 -0.0473,-1.78594 -0.65707,-1.89988 -2.10327,-4.53055 -4.28967,-7.8030697 -2.23415,-3.34398 -2.36708,-3.60816 -2.36708,-4.7041 0,-1.30583 0.65405,-1.77818997 2.46218,-1.77818997 2.81006,0 7.63016,2.36584997 13.41282,6.58340997 26.43095,19.2773397 42.41809,54.8001277 40.52201,90.0383077 -0.17473,3.247366 -0.49391,7.214006 -0.70929,8.814736 -3.15938,23.48089 -12.8165,43.58497 -27.97445,58.23682 -1.79995,1.73986 -3.85893,3.55172 -4.5755,4.02636 -2.09953,1.39067 -3.44096,0.82703 -2.85423,-1.19929 0.15981,-0.55191 0.84595,-2.90848 1.52475,-5.23681 1.52358,-5.22597 2.30355,-8.77938 3.16512,-14.41979 1.99392,-13.05353 1.58807,-23.81925 -1.30281,-34.55923 -1.31998,-4.90389 -3.77216,-10.94329 -5.75791,-14.180996 -1.80452,-2.94221 -2.82029,-3.0072 -7.0802,-0.45304 -5.45157,3.268646 -8.61152,5.445326 -13.61275,9.376876 -10.87168,8.54643 -19.72857,17.9504 -27.220917,28.90233 -1.76137,2.57468 -2.73536,3.77031 -3.0714,3.77031 -0.33623,0 -1.30784,-1.19423 -3.0675,-3.77031 -2.68148,-3.92559 -3.10155,-4.49375 -5.91262,-7.99704 -9.69911,-12.08746 -23.10556,-23.5289 -36.84025,-31.440506 -1.841,-1.06047 -2.9641,-0.97128 -4.20579,0.334 -2.2247,2.33865 -5.97863,11.628606 -7.48857,18.532186 -1.21767,5.5673 -1.53361,8.36825 -1.67127,14.81667 -0.1495,7.00334 0.18708,11.21952 1.50879,18.89974 0.92821,5.39366 1.99925,9.89331 3.4771,14.60796 1.28438,4.09743 1.25825,4.85688 -0.1671,4.85688 -0.74447,0 -1.33592,-0.35514 -3.23611,-1.94314 z"
      />
    </svg>
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
    state.switchboardPairings,
    state.switchboardTemplates,
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
      tab: 'switchboard',
      href: '#/switchboard',
      label: 'Switchboard',
      title: 'Switchboard',
      icon: SwitchboardIcon,
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
  const rightSidebarToggleLabel = rightSidebar
    ? rightSidebar.open
      ? `Collapse ${rightSidebar.title}`
      : `Show ${rightSidebar.title}`
    : 'Show details sidebar';

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
          <nav className="app-rail__nav" aria-label="Main navigation">
            <div className="app-rail__group">
              {primaryNavItems.map(renderRailItem)}
            </div>
            <div className="app-rail__group app-rail__group--secondary">
              {secondaryNavItems.map(renderRailItem)}
            </div>
          </nav>
          <nav className="app-rail__footer" aria-label="Settings">
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
            initialCommentId={route.params.comment}
            defaultFilter={state.settings['issues.default_filter']}
          />
        )}
        {route.tab === 'artifacts' && (
          <ArtifactsView
            initialArtifactId={route.params.artifact}
            initialRef={route.params.ref}
            initialRepo={route.params.repo}
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
          <ConversationsView
            conversations={state.conversations}
            consoleSessions={state.consoleSessions}
            workRepos={state.workRepos}
            initialConversationId={route.params.conversation ?? null}
            initialSessionId={route.params.session ?? null}
            initialPresetId={route.params.preset ?? null}
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
          />
        )}
        {route.tab === 'timeline' && (
          <TimelineView
            repos={state.workRepos}
            params={route.params}
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
