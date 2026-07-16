import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import {
  getRepoBranchCommits,
  getWorkCompare,
  openPath,
  pushRepos,
  pushRepo,
  type WorkCommit,
  type WorkCommitPage,
  type WorkCompareMode,
  type WorkCompareResult,
} from '../api';
import { DiffView } from '../components/DiffView';
import { SidebarSearchFilterHeader } from '../components/shared/SidebarSearchFilterHeader';
import { formatRelativeTime } from '../lib/format';

export type WorkRepo = {
  id?: string;
  name?: string;
  path?: string;
  root?: string;
  default_branch?: string;
  excluded?: boolean;
  user_modified?: boolean;
  last_scanned_at?: string | null;
  [key: string]: unknown;
};

export type WorkBranch = {
  name?: string;
  branch?: string;
  worktree?: string;
  worktree_path?: string;
  status?: string;
  dirty?: boolean;
  ahead?: number;
  behind?: number;
  has_upstream?: boolean;
  upstream?: string | null;
  ahead_default?: number;
  behind_default?: number;
  default_branch?: string;
  last_commit?: {
    message?: string;
    date?: string;
    time?: string;
  };
  last_commit_message?: string;
  last_commit_time?: string;
  last_commit_date?: string;
  diff_stat?: string;
  [key: string]: unknown;
};

export type WorkOverviewProps = {
  repos: WorkRepo[];
  branchesByRepo: Record<string, WorkBranch[]>;
  onRescan: () => void;
  onReposChanged?: (repos: WorkRepo[]) => void;
  params?: Record<string, string>;
};

// Bug: b5abaea — Push/sync state types
type PushRepoResult = {
  repoId: string;
  repoName: string;
  branches_pushed: number | string[];
  refs_pushed: number | string[];
  skipped: boolean;
  error?: string;
};

type PushState = {
  active: boolean;
  authPending: boolean;
  message?: string | null;
  sessionId?: string;
  repoCount?: number;
  completedCount?: number;
  repoProgress: Map<string, "pending" | "pushing" | "done" | "error">;
  lastResult?: { repos: PushRepoResult[]; duration_ms: number } | null;
};

const PROTECTED_BRANCHES = new Set(['main', 'develop']);

function getRepoId(repo: WorkRepo): string {
  return repo.id || repo.name || '';
}

function getRepoTitle(repo: WorkRepo, repoId: string): string {
  const root = repo.root || repo.path || '';
  const base = root ? root.split(/[\\/]/).filter(Boolean).pop() : '';
  return repo.name || base || repoId || 'Unknown repo';
}

function getRepoPath(repo: WorkRepo): string | null {
  return repo.root || repo.path || null;
}

function getBranchName(branch: WorkBranch): string {
  return branch.name || branch.branch || '\u2014';
}

function getWorktreePath(branch: WorkBranch): string | null {
  const p = branch.worktree || branch.worktree_path;
  return p || null;
}

function isDirty(branch: WorkBranch): boolean {
  if (typeof branch.dirty === 'boolean') {
    return branch.dirty;
  }
  return branch.status ? branch.status.toLowerCase() === 'dirty' : false;
}

function getBranchStatus(branch: WorkBranch): 'dirty' | 'clean' {
  return isDirty(branch) ? 'dirty' : 'clean';
}

function formatBranchStatus(status: 'dirty' | 'clean'): string {
  return status === 'dirty' ? 'Dirty' : 'Clean';
}

function countPushed(value: number | string[] | undefined): number {
  if (Array.isArray(value)) return value.length;
  return value ?? 0;
}

function isProtectedBranch(branch: WorkBranch): boolean {
  return PROTECTED_BRANCHES.has(getBranchName(branch));
}

function getLastCommitDate(branch: WorkBranch): string | undefined {
  return (
    branch.last_commit?.date ||
    branch.last_commit?.time ||
    branch.last_commit_date ||
    branch.last_commit_time ||
    undefined
  );
}

function getBranchTimestamp(branch: WorkBranch): number {
  const value = getLastCommitDate(branch);
  if (!value) {
    return 0;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

type BranchSortKey = 'recency' | 'name' | 'ahead';
type RepoSortKey = 'name' | 'activity';
type SortDirection = 'asc' | 'desc';
type CommitLoadState = {
  loading: boolean;
  error: string | null;
};

const WORK_COMMIT_LIMIT = 50;

function sortBranches(branches: WorkBranch[], sortKey: BranchSortKey): WorkBranch[] {
  // Separate pinned (protected) from non-pinned
  const pinned: WorkBranch[] = [];
  const rest: WorkBranch[] = [];
  for (const branch of branches) {
    if (isProtectedBranch(branch)) {
      pinned.push(branch);
    } else {
      rest.push(branch);
    }
  }

  // Sort pinned by name (main before develop)
  pinned.sort((a, b) => getBranchName(a).localeCompare(getBranchName(b)));

  // Sort rest by the chosen key
  rest.sort((a, b) => {
    if (sortKey === 'name') {
      return getBranchName(a).localeCompare(getBranchName(b));
    }
    if (sortKey === 'ahead') {
      const aScore = (a.ahead_default ?? a.ahead ?? 0) + (a.behind_default ?? a.behind ?? 0);
      const bScore = (b.ahead_default ?? b.ahead ?? 0) + (b.behind_default ?? b.behind ?? 0);
      if (aScore !== bScore) {
        return bScore - aScore;
      }
    }
    const recencyDelta = getBranchTimestamp(b) - getBranchTimestamp(a);
    if (recencyDelta !== 0) {
      return recencyDelta;
    }
    return getBranchName(a).localeCompare(getBranchName(b));
  });

  return [...pinned, ...rest];
}

function getRepoActivity(branches: WorkBranch[]): number {
  return branches.reduce(
    (latest, branch) => Math.max(latest, getBranchTimestamp(branch)),
    0,
  );
}

function useDebounce(value: string, delayMs: number): string {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const handle = setTimeout(() => setDebounced(value.trim()), delayMs);
    return () => clearTimeout(handle);
  }, [value, delayMs]);
  return debounced;
}

function copyToClipboard(text: string): void {
  void navigator.clipboard.writeText(text);
}

function commitKey(repoId: string, branchName: string): string {
  return `${repoId}\u0000${branchName}`;
}

function parseCompare(value?: string): { from: string | null; to: string | null } {
  if (!value) {
    return { from: null, to: null };
  }
  const [from, to] = value.split('..');
  return {
    from: from || null,
    to: to || null,
  };
}

function classificationLabel(commit: WorkCommit): string {
  if (commit.classification === 'pre-branch-point') return 'inherited';
  if (commit.classification === 'merged-elsewhere') return 'merged elsewhere';
  return 'unique';
}

function updateWorkHash(params: Record<string, string | null | undefined>): void {
  if (typeof window === 'undefined') {
    return;
  }
  const current = new URLSearchParams(window.location.hash.replace(/^#\/?work\??/, ''));
  Object.entries(params).forEach(([key, value]) => {
    if (!value) current.delete(key);
    else current.set(key, value);
  });
  const query = current.toString();
  window.history.replaceState(null, '', `#/work${query ? `?${query}` : ''}`);
}

// --- Context menu component ---

type MenuAction = {
  label: string;
  onClick: () => void;
  show?: boolean;
};

function BranchContextMenu({
  branch,
  anchorRef,
}: {
  branch: WorkBranch;
  anchorRef: { current: HTMLElement | null };
}): JSX.Element | null {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const branchName = getBranchName(branch);
  const wtPath = getWorktreePath(branch);

  const actions: MenuAction[] = [
    {
      label: 'Copy branch name',
      onClick: () => {
        copyToClipboard(branchName);
        setOpen(false);
      },
    },
    {
      label: 'Copy path',
      show: wtPath !== null,
      onClick: () => {
        if (wtPath) copyToClipboard(wtPath);
        setOpen(false);
      },
    },
    {
      label: 'Open in Finder',
      show: wtPath !== null,
      onClick: () => {
        if (wtPath) void openPath(wtPath);
        setOpen(false);
      },
    },
  ];

  const visibleActions = actions.filter((a) => a.show !== false);

  return (
    <span className="work-actions" ref={anchorRef as any}>
      <button
        type="button"
        className="work-actions__trigger"
        onClick={(e) => {
          e.stopPropagation();
          setOpen(!open);
        }}
        title="Actions"
      >
        &hellip;
      </button>
      {open ? (
        <div ref={menuRef} className="work-actions__menu">
          {visibleActions.map((action) => (
            <button
              key={action.label}
              type="button"
              className="work-actions__item"
              onClick={(e) => {
                e.stopPropagation();
                action.onClick();
              }}
            >
              {action.label}
            </button>
          ))}
        </div>
      ) : null}
    </span>
  );
}

// --- Single branch row (extracted so useRef is called at component level, not in flatMap) ---

type BranchRowProps = {
  branch: WorkBranch;
  repoId: string;
  defaultBranch: string;
  expanded: Set<string>;
  onToggle: (repoId: string, branchName: string) => void;
};

function BranchRow({ branch, repoId, defaultBranch: _defaultBranch, expanded, onToggle }: BranchRowProps): JSX.Element {
  const anchorRef = useRef<HTMLElement>(null);
  const branchName = getBranchName(branch);
  const status = getBranchStatus(branch);
  const statusLabel = formatBranchStatus(status);
  const ahead = branch.ahead ?? 0;
  const behind = branch.behind ?? 0;
  const aheadDefault = branch.ahead_default ?? 0;
  const behindDefault = branch.behind_default ?? 0;
  const hasUpstream =
    typeof branch.has_upstream === 'boolean'
      ? branch.has_upstream
      : Boolean(branch.upstream);
  const upstreamName = branch.upstream ?? '';
  const upstreamTitle = upstreamName ? `Upstream: ${upstreamName}` : undefined;
  const lastMessage =
    branch.last_commit?.message || branch.last_commit_message || '—';
  const lastTime = getLastCommitDate(branch);
  const expandKey = `${repoId}:${branchName}`;
  const isExpanded = expanded.has(expandKey);
  const diffStat = branch.diff_stat;
  const isPinned = isProtectedBranch(branch);

  return (
    <>
      <tr key={expandKey} className={isPinned ? 'work-row--pinned' : ''}>
        <td className="work-col-status">
          <span className={`work-status-dot work-status-dot--${status}`} title={statusLabel} aria-label={statusLabel} />
        </td>
        <td>
          {diffStat ? (
            <button
              type="button"
              className="tree-toggle"
              onClick={() => onToggle(repoId, branchName)}
            >
              {isExpanded ? '\u25BE' : '\u25B8'}
            </button>
          ) : null}
          <span className="branch-name">{branchName}</span>
          {isPinned ? (
            <span className="work-badge-default" title="Protected branch">
              default
            </span>
          ) : null}
        </td>
        <td>
          {isPinned ? (
            <span className="text-muted">{'—'}</span>
          ) : aheadDefault === 0 && behindDefault === 0 ? (
            <span className="text-muted">even</span>
          ) : (
            <span className="ahead-behind">
              <span className="ahead">&uarr;{aheadDefault}</span>
              <span className="behind">&darr;{behindDefault}</span>
            </span>
          )}
        </td>
        <td>
          {hasUpstream ? (
            <span className="ahead-behind" title={upstreamTitle}>
              {ahead > 0 && <span className="remote-ahead-badge" title="Ahead of remote">{'\u2601\u2191'}{ahead}</span>}
              {behind > 0 && <span className="remote-behind-badge" title="Behind remote">{'\u2601\u2193'}{behind}</span>}
              {ahead === 0 && behind === 0 && <span className="text-muted">even</span>}
            </span>
          ) : (
            <span className="no-upstream">no upstream</span>
          )}
        </td>
        <td>
          <div className="cell-stack">
            <span>{lastMessage}</span>
            <span className="branch-timestamp">{formatRelativeTime(lastTime, { empty: '\u2014' })}</span>
          </div>
        </td>
        <td className="work-col-actions">
          <BranchContextMenu branch={branch} anchorRef={anchorRef} />
        </td>
      </tr>
      {diffStat && isExpanded ? (
        <tr key={`${expandKey}:details`} className="diff-row">
          <td colSpan={6}>
            <pre className="diff-stat">{diffStat}</pre>
          </td>
        </tr>
      ) : null}
    </>
  );
}

// --- Scrollable branch table with fade-out hint at the bottom ---

type BranchTableScrollerProps = {
  branches: WorkBranch[];
  repoId: string;
  defaultBranch: string;
  hasActiveFilters: boolean;
  perRepoFilter: string | undefined;
  expanded: Set<string>;
  onToggle: (repoId: string, branchName: string) => void;
};

function BranchTableScroller({
  branches,
  repoId,
  defaultBranch,
  hasActiveFilters,
  perRepoFilter,
  expanded,
  onToggle,
}: BranchTableScrollerProps): JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(false);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    // Consider "at bottom" when within 4px of the bottom
    setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 4);
  };

  // Re-evaluate on mount and whenever branch list changes
  useEffect(() => {
    handleScroll();
  }, [branches]);

  return (
    <div className="branch-scroll-wrap">
      <div
        ref={scrollRef}
        className="branch-scroll-region"
        onScroll={handleScroll}
      >
        <table>
          <thead>
            <tr>
              <th className="work-col-status"></th>
              <th>Branch</th>
              <th>vs {defaultBranch}</th>
              <th>vs upstream</th>
              <th>Last Commit</th>
              <th className="work-col-actions"></th>
            </tr>
          </thead>
          <tbody>
            {branches.length === 0 ? (
              <tr>
                <td colSpan={6} className="empty-state">
                  {hasActiveFilters || perRepoFilter
                    ? 'No branches match this filter.'
                    : 'No branches reported yet. Open a session in this repo or use Refresh now from advanced filters.'}
                </td>
              </tr>
            ) : (
              branches.map((branch) => (
                <BranchRow
                  key={`${repoId}:${getBranchName(branch)}`}
                  branch={branch}
                  repoId={repoId}
                  defaultBranch={defaultBranch}
                  expanded={expanded}
                  onToggle={onToggle}
                />
              ))
            )}
          </tbody>
        </table>
      </div>
      {!atBottom && branches.length > 0 ? (
        <div className="branch-scroll-fade" aria-hidden="true" />
      ) : null}
    </div>
  );
}

export function WorkOverviewView({
  repos: initialRepos,
  branchesByRepo,
  onRescan,
  params = {},
}: WorkOverviewProps): JSX.Element {
  const [repos, setRepos] = useState<WorkRepo[]>(initialRepos);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selectedRepoId, setSelectedRepoId] = useState<string | null>(params.repo ?? null);
  const [selectedBranches, setSelectedBranches] = useState<Record<string, string>>(
    params.repo && params.branch ? { [params.repo]: params.branch } : {},
  );
  const [selectedCommits, setSelectedCommits] = useState<Record<string, string>>({});
  const [commitPages, setCommitPages] = useState<Record<string, WorkCommitPage>>({});
  const [commitLoadState, setCommitLoadState] = useState<Record<string, CommitLoadState>>({});
  const initialCompare = parseCompare(params.compare);
  const [compareFrom, setCompareFrom] = useState<string | null>(initialCompare.from);
  const [compareTo, setCompareTo] = useState<string | null>(initialCompare.to);
  const [compareMode, setCompareMode] = useState<WorkCompareMode>(
    params.mode === 'range' ? 'range' : 'merge-base',
  );
  const [compareResult, setCompareResult] = useState<WorkCompareResult | null>(null);
  const [compareError, setCompareError] = useState<string | null>(null);
  const [compareLoading, setCompareLoading] = useState(false);

  // Outer-level filters
  const [repoFilterInput, setRepoFilterInput] = useState('');
  const [globalBranchFilterInput, setGlobalBranchFilterInput] = useState('');
  const repoFilter = useDebounce(repoFilterInput, 300).toLowerCase();
  const globalBranchFilter = useDebounce(globalBranchFilterInput, 300).toLowerCase();
  const [advancedFiltersOpen, setAdvancedFiltersOpen] = useState(false);
  const [repoSortKey, setRepoSortKey] = useState<RepoSortKey>('activity');
  const [repoSortDirection, setRepoSortDirection] = useState<SortDirection>('desc');

  // Per-project filters and sorts
  const [perRepoFilters, setPerRepoFilters] = useState<Record<string, string>>({});
  const [perRepoSorts, setPerRepoSorts] = useState<Record<string, BranchSortKey>>({});

  // Repo management state
  const [settingsOpenFor, setSettingsOpenFor] = useState<string | null>(null);
  const [addingRepo, setAddingRepo] = useState(false);
  const [addPath, setAddPath] = useState('');
  const [addError, setAddError] = useState<string | null>(null);
  const [showExcluded, setShowExcluded] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [editName, setEditName] = useState<Record<string, string>>({});

  // Bug: b5abaea — Push/sync state
  const [pushState, setPushState] = useState<PushState>({ active: false, authPending: false, repoProgress: new Map() });

  // Sync repos when initialRepos changes (external updates)
  useEffect(() => {
    setRepos(initialRepos);
  }, [initialRepos]);

  useEffect(() => {
    const nextCompare = parseCompare(params.compare);
    setSelectedRepoId(params.repo ?? null);
    if (params.repo && params.branch) {
      setSelectedBranches((prev) => ({ ...prev, [params.repo as string]: params.branch as string }));
    }
    if (params.repo && params.branch && params.commit) {
      setSelectedCommits((prev) => ({
        ...prev,
        [commitKey(params.repo as string, params.branch as string)]: params.commit as string,
      }));
    }
    setCompareFrom(nextCompare.from);
    setCompareTo(nextCompare.to);
    setCompareMode(params.mode === 'range' ? 'range' : 'merge-base');
  }, [params.repo, params.branch, params.commit, params.compare, params.mode]);

  // Fetch repos with/without excluded when showExcluded changes
  const fetchRepos = async (withExcluded: boolean) => {
    try {
      const url = withExcluded ? '/api/work/repos?include_excluded=true' : '/api/work/repos';
      const res = await fetch(url);
      if (res.ok) {
        const data = await res.json() as WorkRepo[];
        setRepos(Array.isArray(data) ? data : []);
      }
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    void fetchRepos(showExcluded);
  }, [showExcluded]);

  useEffect(() => {
    const refresh = () => {
      void onRescan();
    };
    const interval = window.setInterval(refresh, 60_000);
    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        refresh();
      }
    };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [onRescan]);

  // Bug: b5abaea — Subscribe to push SSE events forwarded via window CustomEvents
  useEffect(() => {
    const handler = (e: Event) => {
      const { type, data } = (e as CustomEvent).detail as { type: string; data: Record<string, unknown> };
      switch (type) {
        case 'push:started':
          setPushState(s => ({
            ...s,
            active: true,
            authPending: false,
            sessionId: data.session_id as string | undefined,
            repoCount: data.repo_count as number | undefined,
            completedCount: 0,
            repoProgress: new Map(),
            lastResult: null,
          }));
          break;
        case 'push:repo:progress':
          setPushState(s => {
            const m = new Map(s.repoProgress);
            m.set(data.repo_id as string, 'pushing');
            return { ...s, repoProgress: m };
          });
          break;
        case 'push:repo:complete':
          setPushState(s => {
            const m = new Map(s.repoProgress);
            m.set(data.repoId as string, data.error ? 'error' : 'done');
            return { ...s, completedCount: (s.completedCount ?? 0) + 1, repoProgress: m };
          });
          break;
        case 'push:complete':
          setPushState(s => ({
            ...s,
            active: false,
            authPending: false,
            lastResult: data as unknown as PushState['lastResult'],
          }));
          break;
        case 'push:error':
          setPushState(s => ({ ...s, active: false, authPending: false }));
          break;
        case 'push:auth:pending':
          setPushState(s => ({ ...s, authPending: true }));
          break;
        case 'push:auth:complete':
          setPushState(s => ({ ...s, authPending: false }));
          break;
      }
    };
    window.addEventListener('work:push', handler);
    return () => window.removeEventListener('work:push', handler);
  }, []);

  const repoRows = useMemo(() => {
    return repos
      .map((repo) => {
        const repoId = getRepoId(repo);
        const repoTitle = getRepoTitle(repo, repoId);
        return { repo, repoId, repoTitle };
      })
      .filter(({ repoTitle }) => {
        if (!repoFilter) return true;
        return repoTitle.toLowerCase().includes(repoFilter);
      })
      .map(({ repo, repoId, repoTitle }) => {
        const branches = branchesByRepo[repoId] || [];
        const localFilter = (perRepoFilters[repoId] ?? '').trim().toLowerCase();
        const sortKey = perRepoSorts[repoId] ?? 'recency';

        const filtered = branches.filter((branch) => {
          const name = getBranchName(branch).toLowerCase();
          if (globalBranchFilter && !name.includes(globalBranchFilter)) return false;
          if (localFilter && !name.includes(localFilter)) return false;
          return true;
        });
        const sorted = sortBranches(filtered, sortKey);
        return {
          repo,
          repoId,
          repoTitle,
          branches: sorted,
          sortKey,
          activity: getRepoActivity(branches),
          totalBranches: branches.length,
        };
      })
      .sort((a, b) => {
        const direction = repoSortDirection === 'asc' ? 1 : -1;
        if (repoSortKey === 'name') {
          return direction * a.repoTitle.localeCompare(b.repoTitle);
        }
        const delta = a.activity - b.activity;
        if (delta !== 0) {
          return direction * delta;
        }
        return a.repoTitle.localeCompare(b.repoTitle);
      });
  }, [
    repos,
    branchesByRepo,
    repoFilter,
    globalBranchFilter,
    perRepoFilters,
    perRepoSorts,
    repoSortDirection,
    repoSortKey,
  ]);

  useEffect(() => {
    if (repoRows.length === 0) {
      setSelectedRepoId(null);
      return;
    }
    if (!selectedRepoId || !repoRows.some((row) => row.repoId === selectedRepoId)) {
      setSelectedRepoId(repoRows[0].repoId);
    }
  }, [repoRows, selectedRepoId]);

  const selectedRepo = repoRows.find((row) => row.repoId === selectedRepoId) ?? repoRows[0] ?? null;
  const selectedBranchName = selectedRepo
    ? selectedBranches[selectedRepo.repoId] ?? getBranchName(selectedRepo.branches[0] ?? {})
    : '';
  const selectedBranch = selectedRepo
    ? selectedRepo.branches.find((branch) => getBranchName(branch) === selectedBranchName) ?? selectedRepo.branches[0] ?? null
    : null;

  useEffect(() => {
    if (!selectedRepo) {
      return;
    }
    const current = selectedBranches[selectedRepo.repoId];
    if (current && selectedRepo.branches.some((branch) => getBranchName(branch) === current)) {
      return;
    }
    const fallback = getBranchName(selectedRepo.branches[0] ?? {});
    if (!fallback || fallback === '\u2014') {
      return;
    }
    setSelectedBranches((prev) => ({ ...prev, [selectedRepo.repoId]: fallback }));
    updateWorkHash({ repo: selectedRepo.repoId, branch: fallback });
  }, [selectedRepo, selectedBranches]);

  useEffect(() => {
    if (!selectedRepo || !selectedBranch) {
      return;
    }
    const branchName = getBranchName(selectedBranch);
    const key = commitKey(selectedRepo.repoId, branchName);
    setCommitLoadState((prev) => ({ ...prev, [key]: { loading: true, error: null } }));
    let cancelled = false;
    getRepoBranchCommits(selectedRepo.repoId, branchName, { limit: WORK_COMMIT_LIMIT, offset: 0 })
      .then((page) => {
        if (cancelled) return;
        setCommitPages((prev) => ({ ...prev, [key]: page }));
        setCommitLoadState((prev) => ({ ...prev, [key]: { loading: false, error: null } }));
        setSelectedCommits((prev) => {
          const current = prev[key];
          if (current && page.commits.some((commit) => commit.hash === current)) {
            return prev;
          }
          const first = page.commits[0]?.hash;
          return first ? { ...prev, [key]: first } : prev;
        });
      })
      .catch((error) => {
        if (cancelled) return;
        const message = error instanceof Error ? error.message : String(error);
        setCommitLoadState((prev) => ({ ...prev, [key]: { loading: false, error: message } }));
      });
    return () => {
      cancelled = true;
    };
  }, [selectedRepo?.repoId, selectedBranchName]);

  useEffect(() => {
    if (!selectedRepo || !compareFrom || !compareTo) {
      setCompareResult(null);
      setCompareError(null);
      setCompareLoading(false);
      return;
    }
    let cancelled = false;
    setCompareLoading(true);
    setCompareError(null);
    getWorkCompare(selectedRepo.repoId, { from: compareFrom, to: compareTo, mode: compareMode })
      .then((result) => {
        if (cancelled) return;
        setCompareResult(result);
        setCompareLoading(false);
      })
      .catch((error) => {
        if (cancelled) return;
        setCompareResult(null);
        setCompareLoading(false);
        setCompareError(error instanceof Error ? error.message : String(error));
      });
    return () => {
      cancelled = true;
    };
  }, [selectedRepo?.repoId, compareFrom, compareTo, compareMode]);

  const repoTitleCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const { repoTitle } of repoRows) {
      counts.set(repoTitle, (counts.get(repoTitle) ?? 0) + 1);
    }
    return counts;
  }, [repoRows]);

  const toggleBranch = (repoId: string, branchName: string) => {
    const key = `${repoId}:${branchName}`;
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  const handleUpdateRepo = async (id: string, patch: { name?: string; excluded?: boolean }) => {
    try {
      const res = await fetch(`/api/work/repos/${encodeURIComponent(id)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      if (res.ok) {
        const updated = await res.json() as WorkRepo;
        setRepos((prev) => prev.map((r) => getRepoId(r) === id ? updated : r));
      }
    } catch {
      // ignore
    }
  };

  const handleRemoveRepo = async (id: string) => {
    try {
      const res = await fetch(`/api/work/repos/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      });
      if (res.ok) {
        setRepos((prev) => prev.filter((r) => getRepoId(r) !== id));
        setConfirmRemove(null);
      }
    } catch {
      // ignore
    }
  };

  const handleAddRepo = async () => {
    setAddError(null);
    try {
      const res = await fetch('/api/work/repos/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ root: addPath }),
      });
      if (res.ok) {
        const newRepo = await res.json() as WorkRepo;
        setRepos((prev) => [...prev, newRepo]);
        setAddingRepo(false);
        setAddPath('');
      } else {
        const body = await res.json() as { error?: string };
        setAddError(body.error ?? `Error ${res.status}`);
      }
    } catch (e) {
      setAddError(String(e));
    }
  };

  const handlePushRepo = async (repoId: string, repoTitle: string) => {
    setPushState((prev) => {
      const nextProgress = new Map(prev.repoProgress);
      nextProgress.set(repoId, 'pushing');
      return { ...prev, message: `Pushing ${repoTitle}...`, repoProgress: nextProgress };
    });
    try {
      const result = await pushRepo(repoId, 'current') as PushRepoResult;
      const branchCount = countPushed(result.branches_pushed);
      const refCount = countPushed(result.refs_pushed);
      const nextStatus = result.error ? 'error' : 'done';
      const message = result.error
        ? `Push failed for ${repoTitle}: ${result.error}`
        : result.skipped
          ? `Nothing to push for ${repoTitle}.`
          : refCount > 0
            ? `Pushed ${repoTitle}: ${branchCount} branch${branchCount === 1 ? '' : 'es'}, ${refCount} ref${refCount === 1 ? '' : 's'}.`
            : `Pushed ${repoTitle}.`;
      setPushState((prev) => {
        const nextProgress = new Map(prev.repoProgress);
        nextProgress.set(repoId, nextStatus);
        return { ...prev, message, repoProgress: nextProgress };
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setPushState((prev) => {
        const nextProgress = new Map(prev.repoProgress);
        nextProgress.set(repoId, 'error');
        return { ...prev, message: `Push failed for ${repoTitle}: ${message}`, repoProgress: nextProgress };
      });
    }
  };

  const hasActiveFilters = Boolean(globalBranchFilter || repoFilter);
  return (
    <div className="view work-view">
      {pushState.authPending && (
        <div className="work-auth-status" role="status" aria-live="polite">
          <span aria-hidden="true">!</span>
          <span>Please authenticate via your security key or check your SSH agent...</span>
        </div>
      )}
      {pushState.message && (
        <div className="work-push-message" role="status" aria-live="polite">
          {pushState.message}
        </div>
      )}
      <div className="work-shell">
        <aside className="work-sidebar" aria-label="Repositories">
          <SidebarSearchFilterHeader
            value={repoFilterInput}
            onValueChange={setRepoFilterInput}
            placeholder="Search repos..."
            searchAriaLabel="Search repositories"
            clearAriaLabel="Clear repository search"
            filterTrigger={{
              ariaLabel: 'Advanced filters',
              title: 'Advanced filters',
              open: advancedFiltersOpen,
              onToggle: () => setAdvancedFiltersOpen((open) => !open),
            }}
            panel={advancedFiltersOpen ? {
              variant: 'inline',
              children: (
                <>
              <label className="work-filter-panel__field">
                <span>Branch filter</span>
                <input
                  type="search"
                  className="work-search"
                  placeholder="Any branch..."
                  value={globalBranchFilterInput}
                  onInput={(event) => setGlobalBranchFilterInput(event.currentTarget.value)}
                />
              </label>
              <label className="work-filter-panel__check">
                <input
                  type="checkbox"
                  checked={showExcluded}
                  onChange={(e) => setShowExcluded(e.currentTarget.checked)}
                />
                Show excluded
              </label>
              <div className="work-filter-panel__sort">
                <label>
                  <span>Sort</span>
                  <select
                    className="work-sort"
                    value={repoSortKey}
                    onChange={(event) => setRepoSortKey(event.currentTarget.value as RepoSortKey)}
                  >
                    <option value="activity">Last activity</option>
                    <option value="name">A-Z</option>
                  </select>
                </label>
                <button
                  type="button"
                  className="work-filter-panel__direction"
                  onClick={() => setRepoSortDirection((direction) => direction === 'asc' ? 'desc' : 'asc')}
                  title="Reverse sort direction"
                >
                  {repoSortDirection === 'asc' ? '\u2191' : '\u2193'}
                </button>
              </div>
              <button type="button" className="work-refresh-action" onClick={onRescan}>
                Refresh now
              </button>
                </>
              ),
            } : undefined}
          />
          <div className="work-repo-list" role="list">
            {repoRows.length === 0 ? (
              <div className="empty-state">
                {hasActiveFilters
                  ? 'No repositories match these filters.'
                  : 'No repositories found. Register a session or add a repo.'}
              </div>
            ) : (
              repoRows.map(({ repo, repoId, repoTitle, branches, activity, totalBranches }) => {
                const repoPath = getRepoPath(repo);
                const isExcluded = Boolean(repo.excluded);
                const selected = selectedRepo?.repoId === repoId;
                return (
                  <button
                    key={repoId}
                    type="button"
                    className={`work-repo-item${selected ? ' work-repo-item--active' : ''}${isExcluded ? ' work-repo-item--excluded' : ''}`}
                    onClick={() => {
                      const branchName = selectedBranches[repoId] ?? getBranchName(branches[0] ?? {});
                      setSelectedRepoId(repoId);
                      updateWorkHash({
                        repo: repoId,
                        branch: branchName && branchName !== '\u2014' ? branchName : null,
                        commit: null,
                        compare: null,
                      });
                    }}
                  >
                    <span className="work-repo-item__main">
                      <span className="work-repo-item__name">
                        {repoTitle}
                        {isExcluded ? (
                          <span className="work-badge-excluded" title="Excluded from scans">excluded</span>
                        ) : null}
                      </span>
                      {repoPath ? <span className="work-repo-item__path">{repoPath}</span> : null}
                    </span>
                    <span className="work-repo-item__meta">
                      <span>{totalBranches} {totalBranches === 1 ? 'branch' : 'branches'}</span>
                      <span>{activity
                        ? formatRelativeTime(new Date(activity).toISOString(), { empty: '\u2014' })
                        : '\u2014'}</span>
                    </span>
                  </button>
                );
              })
            )}
          </div>
          {addingRepo ? (
            <div className="repo-add-form">
              <input
                type="text"
                className="repo-add-form__input"
                placeholder="Absolute path to git repo..."
                value={addPath}
                onInput={(e) => setAddPath(e.currentTarget.value)}
              />
              <div className="repo-add-form__actions">
                <button type="button" className="btn btn--sm" onClick={() => void handleAddRepo()}>
                  Add
                </button>
                <button
                  type="button"
                  className="btn btn--sm btn--ghost"
                  onClick={() => { setAddingRepo(false); setAddPath(''); setAddError(null); }}
                >
                  Cancel
                </button>
              </div>
              {addError && <span className="repo-add-form__error">{addError}</span>}
            </div>
          ) : null}
          <div className="work-sidebar__footer">
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => { setAddingRepo((v) => !v); setAddError(null); }}
            >
              + Add repo
            </button>
            <div className="work-push-actions">
              <button
                type="button"
                className={`btn btn--ghost btn--sm${(pushState.active || pushState.authPending) ? ' btn--disabled' : ''}`}
                disabled={pushState.active || pushState.authPending}
                onClick={() => pushRepos('all_ahead').catch(() => {})}
                title="Push all ahead branches + git-bug refs + notes for all repos"
              >
                {pushState.authPending
                  ? 'Authenticating...'
                  : pushState.active
                    ? `Pushing... (${pushState.completedCount ?? 0}/${pushState.repoCount ?? '?'})`
                    : '\u2191\u2191 Push All'}
              </button>
            </div>
          </div>
        </aside>
        <section className="work-detail" aria-label="Repository details">
          {selectedRepo === null ? (
            <div className="empty-state">Select a repository to inspect branch and worktree status.</div>
          ) : (() => {
            const { repo, repoId, repoTitle, branches, sortKey } = selectedRepo;
            const repoPath = getRepoPath(repo);
            const showPath = repoPath && (repoTitleCounts.get(repoTitle) ?? 0) > 1;
            const defaultBranch =
              repo.default_branch ||
              branches.find((b) => b.default_branch && b.default_branch !== '—')
                ?.default_branch ||
              'main';
            const isExcluded = Boolean(repo.excluded);
            const isSettingsOpen = settingsOpenFor === repoId;
            const currentEditName = editName[repoId] ?? repo.name ?? repoTitle;

            return (
              <div
                key={repoId}
                className={`work-detail-panel${isExcluded ? ' repo-card--excluded' : ''}`}
              >
                <div className="work-detail__header">
                  <div className="repo-card__title">
                    <h3>
                      {repoTitle}
                      {isExcluded && (
                        <span className="work-badge-excluded" title="Excluded from scans">excluded</span>
                      )}
                    </h3>
                    {showPath ? <span className="text-muted">{repoPath}</span> : null}
                  </div>
                  <div className="repo-card__header-actions">
                    {pushState.repoProgress.get(repoId) === 'pushing' && (
                      <span className="work-push-spinner" aria-label="Pushing" />
                    )}
                    {pushState.repoProgress.get(repoId) === 'done' && (
                      <span className="work-push-done" title="Push complete">{'\u2713'}</span>
                    )}
                    {pushState.repoProgress.get(repoId) === 'error' && (
                      <span className="work-push-error" title="Push failed">{'\u2717'}</span>
                    )}
                    <button
                      type="button"
                      className="work-repo-push-btn"
                      disabled={pushState.active || pushState.repoProgress.get(repoId) === 'pushing'}
                      onClick={() => void handlePushRepo(repoId, repoTitle)}
                      title="Push this repo"
                    >
                      <span className="work-repo-push-btn__label">
                        {pushState.repoProgress.get(repoId) === 'pushing' ? 'Pushing...' : '\u2191 Push'}
                      </span>
                    </button>
                    {isExcluded && (
                      <button
                        type="button"
                        className="btn btn--xs"
                        onClick={(e) => {
                          void handleUpdateRepo(repoId, { excluded: false });
                        }}
                        title="Include this repo in scans"
                      >
                        Include
                      </button>
                    )}
                    <button
                      type="button"
                      className={`repo-card__gear${isSettingsOpen ? ' repo-card__gear--active' : ''}`}
                      title="Repo settings"
                      aria-label="Repo settings"
                      onClick={(e) => {
                        setSettingsOpenFor((prev) => prev === repoId ? null : repoId);
                      }}
                    >
                      &#9881;
                    </button>
                  </div>
                </div>
                {isSettingsOpen && (
                  <div className="work-settings-overlay" role="dialog" aria-modal="true" aria-labelledby="work-repo-settings-title">
                    <div className="work-settings-modal">
                      <div className="work-settings-modal__header">
                        <h4 id="work-repo-settings-title">Repo settings</h4>
                        <button
                          type="button"
                          className="work-settings-modal__close"
                          aria-label="Close repo settings"
                          onClick={() => setSettingsOpenFor(null)}
                        >
                          ×
                        </button>
                      </div>
                      <div className="repo-settings-strip">
                        <div className="repo-settings-strip__row">
                          <label className="repo-settings-strip__label">Name</label>
                          <input
                            type="text"
                            className="repo-settings-strip__input"
                            value={currentEditName}
                            onInput={(e) =>
                              setEditName((prev) => ({ ...prev, [repoId]: e.currentTarget.value }))
                            }
                          />
                          <button
                            type="button"
                            className="btn btn--xs"
                            onClick={() => void handleUpdateRepo(repoId, { name: currentEditName }).then(() =>
                              setEditName((prev) => { const next = { ...prev }; delete next[repoId]; return next; })
                            )}
                          >
                            Save
                          </button>
                          <button
                            type="button"
                            className="btn btn--xs btn--ghost"
                            onClick={() => void handleUpdateRepo(repoId, { name: '' }).then(() =>
                              setEditName((prev) => { const next = { ...prev }; delete next[repoId]; return next; })
                            )}
                            title="Reset to derived name"
                          >
                            Reset
                          </button>
                        </div>
                        <div className="repo-settings-strip__row">
                          <label className="repo-settings-strip__label">
                            <input
                              type="checkbox"
                              checked={isExcluded}
                              onChange={(e) => void handleUpdateRepo(repoId, { excluded: e.currentTarget.checked })}
                              style={{ marginRight: '4px' }}
                            />
                            Exclude from scans
                          </label>
                        </div>
                        <div className="repo-settings-strip__row">
                          {confirmRemove === repoId ? (
                            <>
                              <span className="text-muted" style={{ fontSize: '0.85em' }}>Remove this repo from Mandible?</span>
                              <button
                                type="button"
                                className="btn btn--xs btn--danger"
                                onClick={() => void handleRemoveRepo(repoId)}
                              >
                                Confirm remove
                              </button>
                              <button
                                type="button"
                                className="btn btn--xs btn--ghost"
                                onClick={() => setConfirmRemove(null)}
                              >
                                Cancel
                              </button>
                            </>
                          ) : (
                            <button
                              type="button"
                              className="btn btn--xs btn--danger-outline"
                              onClick={() => setConfirmRemove(repoId)}
                            >
                              Remove repo
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                )}
                <div className="work-detail__body">
                  <div className="work-detail__controls">
                    <input
                      type="search"
                      className="repo-card__filter"
                      placeholder="Filter branches..."
                      value={perRepoFilters[repoId] ?? ''}
                      onInput={(event) =>
                        setPerRepoFilters((prev) => ({
                          ...prev,
                          [repoId]: event.currentTarget.value,
                        }))
                      }
                    />
                    <select
                      className="repo-card__sort"
                      value={sortKey}
                      onChange={(event) =>
                        setPerRepoSorts((prev) => ({
                          ...prev,
                          [repoId]: event.currentTarget.value as BranchSortKey,
                        }))
                      }
                    >
                      <option value="recency">Recent activity</option>
                      <option value="name">Branch name</option>
                      <option value="ahead">Ahead/behind</option>
                    </select>
                  </div>
                  {(() => {
                    const activeBranchName = selectedBranches[repoId] ?? getBranchName(branches[0] ?? {});
                    const activeBranch =
                      branches.find((branch) => getBranchName(branch) === activeBranchName) ??
                      branches[0] ??
                      null;
                    const branchName = activeBranch ? getBranchName(activeBranch) : '';
                    const commitsKey = branchName ? commitKey(repoId, branchName) : '';
                    const commitPage = commitsKey ? commitPages[commitsKey] : undefined;
                    const loadState = commitsKey ? commitLoadState[commitsKey] : undefined;
                    const selectedCommitHash = commitsKey ? selectedCommits[commitsKey] : undefined;
                    const selectedCommit =
                      commitPage?.commits.find((commit) => commit.hash === selectedCommitHash) ??
                      commitPage?.commits[0] ??
                      null;
                    const compareValue = compareFrom ? `${compareFrom}..${compareTo ?? ''}` : null;

                    const writeCompare = (from: string | null, to: string | null, mode: WorkCompareMode = compareMode) => {
                      setCompareFrom(from);
                      setCompareTo(to);
                      setCompareMode(mode);
                      updateWorkHash({
                        repo: repoId,
                        branch: branchName || null,
                        compare: from ? `${from}..${to ?? ''}` : null,
                        mode: from ? mode : null,
                      });
                    };

                    const selectBranch = (nextBranchName: string) => {
                      setSelectedBranches((prev) => ({ ...prev, [repoId]: nextBranchName }));
                      updateWorkHash({ repo: repoId, branch: nextBranchName, commit: null });
                    };

                    const selectCommit = (commit: WorkCommit) => {
                      setSelectedCommits((prev) => ({
                        ...prev,
                        [commitKey(repoId, branchName)]: commit.hash,
                      }));
                      updateWorkHash({ repo: repoId, branch: branchName, commit: commit.hash });
                    };

                    const addCommitToCompare = (commit: WorkCommit) => {
                      if (!compareFrom || (compareFrom && compareTo)) {
                        writeCompare(commit.hash, null);
                        return;
                      }
                      if (compareFrom !== commit.hash) {
                        writeCompare(compareFrom, commit.hash);
                      }
                    };

                    return (
                      <div className="work-project-browser">
                        <aside className="work-branch-browser" aria-label="Branches">
                          {branches.length === 0 ? (
                            <div className="empty-state">
                              {hasActiveFilters || perRepoFilters[repoId]
                                ? 'No branches match this filter.'
                                : 'No branches reported yet.'}
                            </div>
                          ) : (
                            branches.map((branch) => {
                              const name = getBranchName(branch);
                              const selected = name === branchName;
                              const status = getBranchStatus(branch);
                              return (
                                <button
                                  key={`${repoId}:branch:${name}`}
                                  type="button"
                                  className={`work-branch-button${selected ? ' work-branch-button--active' : ''}`}
                                  onClick={() => selectBranch(name)}
                                >
                                  <span className={`work-status-dot work-status-dot--${status}`} aria-hidden="true" />
                                  <span className="work-branch-button__main">
                                    <span className="work-branch-button__name">{name}</span>
                                    <span className="work-branch-button__meta">
                                      {isProtectedBranch(branch) ? 'protected' : `+${branch.ahead_default ?? 0} / -${branch.behind_default ?? 0}`}
                                      {isDirty(branch) ? ' dirty' : ''}
                                    </span>
                                  </span>
                                </button>
                              );
                            })
                          )}
                        </aside>
                        <section className="work-commit-browser" aria-label="Commits">
                          {activeBranch ? (
                            <>
                              <div className="work-commit-toolbar">
                                <div>
                                  <h4>{branchName}</h4>
                                  <span className="text-muted">
                                    {commitPage ? `${commitPage.total} commits` : 'Loading commits'}
                                  </span>
                                </div>
                                <div className="work-commit-toolbar__actions">
                                  <button
                                    type="button"
                                    className="btn btn--xs"
                                    onClick={() => writeCompare(defaultBranch as string, branchName, 'merge-base')}
                                  >
                                    Branch point
                                  </button>
                                  <button
                                    type="button"
                                    className="btn btn--xs btn--ghost"
                                    onClick={() => writeCompare(defaultBranch as string, branchName, 'range')}
                                  >
                                    vs {defaultBranch}
                                  </button>
                                </div>
                              </div>
                              <div className="work-compare-tray" aria-label="Compare tray">
                                <div className="work-compare-tray__endpoints">
                                  <span>{compareFrom ? compareFrom.slice(0, 12) : 'Select first commit'}</span>
                                  <span aria-hidden="true">..</span>
                                  <span>{compareTo ? compareTo.slice(0, 12) : 'Select second commit'}</span>
                                </div>
                                <div className="work-compare-tray__actions">
                                  <select
                                    className="work-compare-tray__mode"
                                    value={compareMode}
                                    onChange={(event) => writeCompare(compareFrom, compareTo, event.currentTarget.value as WorkCompareMode)}
                                  >
                                    <option value="merge-base">Merge base</option>
                                    <option value="range">Range</option>
                                  </select>
                                  <button
                                    type="button"
                                    className="btn btn--xs btn--ghost"
                                    disabled={!compareFrom || !compareTo}
                                    onClick={() => writeCompare(compareTo, compareFrom)}
                                  >
                                    Swap
                                  </button>
                                  <button
                                    type="button"
                                    className="btn btn--xs btn--ghost"
                                    disabled={!compareValue}
                                    onClick={() => writeCompare(null, null)}
                                  >
                                    Clear
                                  </button>
                                </div>
                              </div>
                              {loadState?.error ? (
                                <div className="empty-state">{loadState.error}</div>
                              ) : loadState?.loading && !commitPage ? (
                                <div className="empty-state">Loading commits...</div>
                              ) : (
                                <div className="work-commit-layout">
                                  <div className="work-commit-list" role="list" aria-label={`${branchName} commits`}>
                                    {(commitPage?.commits ?? []).map((commit) => {
                                      const selected = selectedCommit?.hash === commit.hash;
                                      return (
                                        <button
                                          key={commit.hash}
                                          type="button"
                                          className={`work-commit-row work-commit-row--${commit.classification}${selected ? ' work-commit-row--active' : ''}`}
                                          onClick={() => selectCommit(commit)}
                                        >
                                          <span className="work-commit-row__marker" aria-hidden="true" />
                                          <span className="work-commit-row__main">
                                            <span className="work-commit-row__message">{commit.message || commit.short_hash}</span>
                                            <span className="work-commit-row__meta">
                                              {commit.short_hash} · {commit.author} · {formatRelativeTime(commit.date, { empty: '\u2014' })}
                                            </span>
                                          </span>
                                          <span className="work-commit-row__class">{classificationLabel(commit)}</span>
                                        </button>
                                      );
                                    })}
                                  </div>
                                  <div className="work-commit-detail">
                                    {selectedCommit ? (
                                      <>
                                        <div className="work-commit-detail__header">
                                          <div>
                                            <h4>{selectedCommit.message || selectedCommit.short_hash}</h4>
                                            <span className="text-muted">
                                              {selectedCommit.hash} · {selectedCommit.author} · {selectedCommit.date}
                                            </span>
                                          </div>
                                          <div className="work-commit-detail__actions">
                                            <button
                                              type="button"
                                              className="btn btn--xs"
                                              onClick={() => addCommitToCompare(selectedCommit)}
                                            >
                                              Add to compare
                                            </button>
                                            <button
                                              type="button"
                                              className="btn btn--xs btn--ghost"
                                              disabled={selectedCommit.parents.length === 0}
                                              onClick={() => {
                                                const parent = selectedCommit.parents[0];
                                                if (parent) writeCompare(parent, selectedCommit.hash, 'range');
                                              }}
                                            >
                                              Diff parent
                                            </button>
                                          </div>
                                        </div>
                                        <dl className="work-commit-detail__facts">
                                          <div>
                                            <dt>Class</dt>
                                            <dd>{classificationLabel(selectedCommit)}</dd>
                                          </div>
                                          <div>
                                            <dt>Parents</dt>
                                            <dd>{selectedCommit.parents.length || 0}</dd>
                                          </div>
                                        </dl>
                                      </>
                                    ) : (
                                      <div className="empty-state">Select a commit.</div>
                                    )}
                                  </div>
                                </div>
                              )}
                              <section className="work-compare-output" aria-label="Compare result">
                                <div className="work-compare-output__header">
                                  <h4>Compare</h4>
                                  {compareResult ? <span className="text-muted">{compareResult.range}</span> : null}
                                </div>
                                {compareLoading ? (
                                  <div className="empty-state">Loading diff...</div>
                                ) : compareError ? (
                                  <div className="empty-state">{compareError}</div>
                                ) : compareResult ? (
                                  <>
                                    {compareResult.stat ? <pre className="work-compare-stat">{compareResult.stat}</pre> : null}
                                    <DiffView
                                      diffText={compareResult.raw}
                                      ariaLabel="Projects compare diff"
                                      emptyMessage="No diff for this comparison."
                                      initialMode="split"
                                    />
                                  </>
                                ) : (
                                  <div className="empty-state">Select two commits or a branch compare action.</div>
                                )}
                              </section>
                            </>
                          ) : (
                            <div className="empty-state">Select a branch to browse commits.</div>
                          )}
                        </section>
                      </div>
                    );
                  })()}
                </div>
              </div>
            );
          })()}
        </section>
      </div>
    </div>
  );
}
