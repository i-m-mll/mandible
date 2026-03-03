import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { openPath } from '../api';

export type WorkRepo = {
  id?: string;
  name?: string;
  path?: string;
  root?: string;
  default_branch?: string;
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

function formatRelativeTime(value?: string): string {
  if (!value) {
    return '\u2014';
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    return value;
  }
  const delta = Date.now() - parsed;
  if (delta < 0) {
    return 'just now';
  }
  const seconds = Math.floor(delta / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days > 1) {
    return `${days}d ago`;
  }
  if (days === 1) {
    return 'yesterday';
  }
  if (hours > 0) {
    return `${hours}h ago`;
  }
  if (minutes > 0) {
    return `${minutes}m ago`;
  }
  return `${seconds}s ago`;
}

type BranchSortKey = 'recency' | 'name' | 'ahead';

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
  const dirty = isDirty(branch);
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
        <td>
          <button
            type="button"
            className={`tree-toggle ${diffStat ? '' : 'tree-toggle--empty'}`}
            onClick={() => diffStat && onToggle(repoId, branchName)}
          >
            {diffStat ? (isExpanded ? '\u25BE' : '\u25B8') : ''}
          </button>
          <span className="branch-name">{branchName}</span>
          {isPinned ? (
            <span className="work-badge-default" title="Protected branch">
              default
            </span>
          ) : null}
        </td>
        <td>
          <span
            className={`status-pill ${dirty ? 'status-pill--dirty' : 'status-pill--clean'}`}
          >
            {dirty ? 'Dirty' : 'Clean'}
          </span>
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
              <span className="ahead">&uarr;{ahead}</span>
              <span className="behind">&darr;{behind}</span>
            </span>
          ) : (
            <span className="no-upstream">no upstream</span>
          )}
        </td>
        <td>
          <div className="cell-stack">
            <span>{lastMessage}</span>
            <span className="branch-timestamp">{formatRelativeTime(lastTime)}</span>
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
              <th>Branch</th>
              <th>Status</th>
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
                    : 'No branches reported yet. Rescan or open a session in this repo.'}
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
  repos,
  branchesByRepo,
  onRescan,
}: WorkOverviewProps): JSX.Element {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [repoToggles, setRepoToggles] = useState<Record<string, boolean>>({});

  // Outer-level filters
  const [repoFilterInput, setRepoFilterInput] = useState('');
  const [globalBranchFilterInput, setGlobalBranchFilterInput] = useState('');
  const repoFilter = useDebounce(repoFilterInput, 300).toLowerCase();
  const globalBranchFilter = useDebounce(globalBranchFilterInput, 300).toLowerCase();

  // Per-project filters and sorts
  const [perRepoFilters, setPerRepoFilters] = useState<Record<string, string>>({});
  const [perRepoSorts, setPerRepoSorts] = useState<Record<string, BranchSortKey>>({});

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
        return { repo, repoId, repoTitle, branches: sorted, sortKey };
      });
  }, [repos, branchesByRepo, repoFilter, globalBranchFilter, perRepoFilters, perRepoSorts]);

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

  const hasActiveFilters = Boolean(globalBranchFilter || repoFilter);

  return (
    <div className="view work-view">
      <div className="view-header">
        <div>
          <h2>Work Overview</h2>
          <p className="text-muted">Branch and worktree status across repos.</p>
        </div>
        <button type="button" className="btn" onClick={onRescan}>
          Rescan
        </button>
      </div>
      <div className="work-toolbar">
        <input
          type="search"
          className="work-search"
          placeholder="Filter repos..."
          value={repoFilterInput}
          onInput={(event) => setRepoFilterInput(event.currentTarget.value)}
        />
        <input
          type="search"
          className="work-search"
          placeholder="Filter branches (all repos)..."
          value={globalBranchFilterInput}
          onInput={(event) => setGlobalBranchFilterInput(event.currentTarget.value)}
        />
      </div>
      <div className="work-table">
        {repoRows.length === 0 ? (
          <div className="empty-state">
            {hasActiveFilters
              ? 'No repositories match these filters.'
              : 'No repositories found. Register a session or hit Rescan to discover worktrees.'}
          </div>
        ) : (
          repoRows.map(({ repo, repoId, repoTitle, branches, sortKey }) => {
            const repoPath = getRepoPath(repo);
            const showPath = repoPath && (repoTitleCounts.get(repoTitle) ?? 0) > 1;
            const isOpen = repoToggles[repoId] ?? (branches.length > 0);
            const branchCount = branches.length;
            const defaultBranch =
              repo.default_branch ||
              branches.find((b) => b.default_branch && b.default_branch !== '—')
                ?.default_branch ||
              'main';

            return (
              <details
                key={repoId}
                className="repo-card repo-card--collapsible"
                open={isOpen}
                onToggle={(event) => {
                  const nextOpen = event.currentTarget.open;
                  setRepoToggles((prev) => ({ ...prev, [repoId]: nextOpen }));
                }}
              >
                <summary className="repo-card__summary">
                  <div className="repo-card__title">
                    <h3>
                      {repoTitle}
                      <span className="branch-count">
                        ({branchCount} {branchCount === 1 ? 'branch' : 'branches'})
                      </span>
                    </h3>
                    {showPath ? <span className="text-muted">{repoPath}</span> : null}
                  </div>
                </summary>
                <div className="repo-card__body">
                  <div className="repo-card__controls">
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
                  <BranchTableScroller
                    branches={branches}
                    repoId={repoId}
                    defaultBranch={defaultBranch as string}
                    hasActiveFilters={hasActiveFilters}
                    perRepoFilter={perRepoFilters[repoId]}
                    expanded={expanded}
                    onToggle={toggleBranch}
                  />
                </div>
              </details>
            );
          })
        )}
      </div>
    </div>
  );
}
