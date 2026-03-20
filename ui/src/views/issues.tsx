import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { marked } from 'marked';
import {
  findIssue,
  getIssueContext,
  getIssueDetail,
  getIssueSessions,
  issueAction,
  scanIssueRepo,
  type IssueContext,
  type IssueContextAuthRequest,
  type IssueContextSession,
  type IssueContextWorkUnit,
} from '../api';
import { useSidebarResize } from '../hooks/useSidebarResize';
import { EntityPill, EntityPillList } from '../components/shared/EntityPill';

// --- Types ---

export type GitBugIssue = {
  id: string;
  repo_id: string;
  repo_name: string;
  title: string;
  status: 'open' | 'closed';
  labels: string[];
  author: string;
  created_at: string;
  description: string;
  parent_id?: string;  // derived from parent:<human_id> label
};

export type GitBugComment = {
  id: string;
  author: string;
  date: string;
  body: string;
};

export type GitBugIssueDetail = GitBugIssue & {
  comments: GitBugComment[];
};

export type IssueRepoSummary = {
  repo_id: string;
  repo_name: string;
  repo_root: string;
  open_count: number;
  merged_count: number;
  closed_count: number;
  issues: GitBugIssue[];
};

export type IssuesViewProps = {
  repos: IssueRepoSummary[];
  onRescan: () => Promise<void>;
  initialRepoId?: string;
  initialIssueId?: string;
};

// --- Helpers ---

// Bug: e32ee8b — three-state lifecycle: open, merged (closed + "merged" label), closed
type VisualState = 'open' | 'merged' | 'closed';

function getVisualState(issue: { status: string; labels: string[] }): VisualState {
  if (issue.status === 'open') return 'open';
  if (issue.labels.includes('merged')) return 'merged';
  return 'closed';
}

function renderMarkdown(src: string): string {
  if (!src) return '';
  const result = marked.parse(src, { async: false });
  return typeof result === 'string' ? result : '';
}

/**
 * Strip dangerous tags and attributes from HTML produced by marked.
 * Keeps safe inline tags (strong, em, code, a, del, s, sup, sub, span).
 * Bug: 387ae46 — sanitize marked output before dangerouslySetInnerHTML
 */
function sanitizeInlineHtml(html: string): string {
  let out = html.replace(
    /<(script|iframe|object|embed|form|style|svg|math)[^>]*>[\s\S]*?<\/\1>/gi,
    '',
  );
  out = out.replace(/<(script|iframe|object|embed|form|style|svg|math)[^>]*\/>/gi, '');
  out = out.replace(/\s+on\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]*)/gi, '');
  out = out.replace(/\s+(href|src)\s*=\s*(?:"javascript:[^"]*"|'javascript:[^']*')/gi, '');
  return out;
}

/**
 * Render inline markdown — strips the outer <p>…</p> wrapper for single-line
 * input so text flows inline in compact contexts (sidebar titles, list items).
 * Bug: a44fd6a — markdown rendering in issues sidebar titles
 */
function renderInlineMarkdown(src: string): string {
  if (!src) return '';
  const result = marked.parse(src, { async: false });
  const html = typeof result === 'string' ? result : '';
  const stripped = html.replace(/^<p>([\s\S]*?)<\/p>\n?$/, '$1').trim();
  return sanitizeInlineHtml(stripped);
}

function formatRelativeTime(value?: string): string {
  if (!value) return '';
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return value;
  const delta = Date.now() - parsed;
  if (delta < 0) return 'just now';
  const seconds = Math.floor(delta / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days > 1) return `${days}d ago`;
  if (days === 1) return 'yesterday';
  if (hours > 0) return `${hours}h ago`;
  if (minutes > 0) return `${minutes}m ago`;
  return `${seconds}s ago`;
}

// --- Label color palette ---

const LABEL_COLORS = [
  { bg: 'rgba(77, 163, 255, 0.2)', fg: '#4da3ff' },
  { bg: 'rgba(50, 210, 150, 0.2)', fg: '#32d296' },
  { bg: 'rgba(245, 194, 92, 0.2)', fg: '#f5c25c' },
  { bg: 'rgba(242, 107, 107, 0.2)', fg: '#f26b6b' },
  { bg: 'rgba(187, 134, 252, 0.2)', fg: '#bb86fc' },
  { bg: 'rgba(255, 167, 38, 0.2)', fg: '#ffa726' },
];

function labelColor(label: string): { bg: string; fg: string } {
  let hash = 0;
  for (let i = 0; i < label.length; i++) {
    hash = (hash * 31 + label.charCodeAt(i)) | 0;
  }
  return LABEL_COLORS[Math.abs(hash) % LABEL_COLORS.length];
}

// Bug: cce48c1 — maps git-bug internal label names → user-facing display text
// "error" is the git-bug label for bug-fix issues; displaying it as "error" looks like an error state.
const LABEL_DISPLAY_NAMES: Record<string, string> = {
  error: 'bug',
  umbrella: 'umbrella',
};

// Reverse map: display name → internal label (for filter pills)
const LABEL_INTERNAL_NAMES: Record<string, string> = {
  bug: 'error',
  umbrella: 'umbrella',
  feature: 'feature',
  deferred: 'deferred',
};

// --- Flat list item types ---

type ListItem = { kind: 'issue'; issue: GitBugIssue; repo: IssueRepoSummary };

// --- Components ---

type StatusFilter = 'all' | 'open' | 'merged' | 'closed';

export function IssuesView({ repos, onRescan, initialRepoId, initialIssueId }: IssuesViewProps): JSX.Element {
  // Local state
  const [selectedRepoId, setSelectedRepoId] = useState<string | null>(null);
  const [selectedIssueId, setSelectedIssueId] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('open');
  const [repoFilter, setRepoFilter] = useState<string | null>(initialRepoId ?? null);
  const [repoInput, setRepoInput] = useState('');
  const [labelFilter, setLabelFilter] = useState<string | null>(null);
  const [parentFilter, setParentFilter] = useState<string | null>(null);
  type SortField = 'created_at';
  const [sortField] = useState<SortField>('created_at');
  const [issueDetail, setIssueDetail] = useState<GitBugIssueDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [commentText, setCommentText] = useState('');
  const [showCommentBox, setShowCommentBox] = useState(false);
  const [actionInFlight, setActionInFlight] = useState(false);
  const [linkedSessions, setLinkedSessions] = useState<Array<{session_id: string; created_at: number}>>([]);
  const [issueContext, setIssueContext] = useState<IssueContext | null>(null);

  // Bug: a44fd6a — gate deep-link to run once per route change (not on every repos update)
  const lastAppliedDeepLinkRef = useRef<string | null>(null);

  const resolveRepoId = useCallback((rawRepoId: string | null | undefined): string | null => {
    if (!rawRepoId) return null;
    const trimmed = rawRepoId.trim();
    if (!trimmed) return null;
    const exact = repos.find((repo) => repo.repo_id === trimmed);
    if (exact) return exact.repo_id;
    const byName = repos.find((repo) => repo.repo_name === trimmed);
    if (byName) return byName.repo_id;
    const byNameInsensitive = repos.find((repo) => repo.repo_name.toLowerCase() === trimmed.toLowerCase());
    if (byNameInsensitive) return byNameInsensitive.repo_id;
    return trimmed;
  }, [repos]);

  const resolveIssueId = useCallback((repoId: string, rawIssueId: string): string => {
    const repo = repos.find((r) => r.repo_id === repoId);
    if (!repo) return rawIssueId;
    const exact = repo.issues.find((issue) => issue.id === rawIssueId);
    if (exact) return exact.id;
    const byPrefix = repo.issues.filter((issue) => issue.id.startsWith(rawIssueId));
    if (byPrefix.length === 1) return byPrefix[0].id;
    return rawIssueId;
  }, [repos]);

  // Deep-link: auto-select issue from URL params.
  // When initialRepoId is present, set repoFilter to narrow the list.
  // When initialIssueId is present, select it.
  useEffect(() => {
    if (!initialIssueId) return;
    const deepLinkKey = `${initialRepoId ?? ''}:${initialIssueId}`;
    if (lastAppliedDeepLinkRef.current === deepLinkKey) return;
    lastAppliedDeepLinkRef.current = deepLinkKey;

    if (initialRepoId) {
      const canonicalRepoId = resolveRepoId(initialRepoId) ?? initialRepoId;
      const canonicalIssueId = resolveIssueId(canonicalRepoId, initialIssueId);
      setSelectedRepoId(canonicalRepoId);
      setSelectedIssueId(canonicalIssueId);
      setRepoFilter(canonicalRepoId);
    } else {
      // No repo: search all scanned repos for this issue ID
      findIssue(initialIssueId).then((detail) => {
        const d = detail as { repo_id?: string; id?: string } | null;
        if (d?.repo_id && d?.id) {
          setSelectedRepoId(d.repo_id);
          setSelectedIssueId(d.id);
          setRepoFilter(d.repo_id);
        }
      }).catch(() => {
        // Bug: aee671a — cold scanner cache: trigger global scan and retry once
        onRescan().then(() => findIssue(initialIssueId))
          .then((retried) => {
            const r = retried as { repo_id?: string; id?: string } | null;
            if (r?.repo_id && r?.id) {
              setSelectedRepoId(r.repo_id);
              setSelectedIssueId(r.id);
              setRepoFilter(r.repo_id);
            }
          })
          .catch(() => {
            // Issue genuinely not found after scan — leave selection unchanged
          });
      });
    }
  }, [initialRepoId, initialIssueId, resolveRepoId, resolveIssueId]);

  // Sync repoInput display name when repoFilter is set externally (e.g. deep-link or "Show children")
  useEffect(() => {
    if (repoFilter) {
      const repo = repos.find((r) => r.repo_id === repoFilter);
      if (repo) setRepoInput(repo.repo_name);
    } else {
      setRepoInput('');
    }
  }, [repoFilter, repos]);

  const normalizedFilter = useMemo(() => filter.trim().toLowerCase(), [filter]);

  // Filter issues within repos — three-state aware, plus repo/label/parent filters
  const filteredRepos = useMemo(() => {
    return repos
      .filter((repo) => !repoFilter || repo.repo_id === repoFilter)
      .map((repo) => {
        let issues = repo.issues;
        if (statusFilter !== 'all') {
          issues = issues.filter((issue) => getVisualState(issue) === statusFilter);
        }
        if (normalizedFilter) {
          issues = issues.filter(
            (issue) =>
              issue.title.toLowerCase().includes(normalizedFilter) ||
              issue.id.toLowerCase().includes(normalizedFilter),
          );
        }
        if (labelFilter) {
          const internalLabel = LABEL_INTERNAL_NAMES[labelFilter] ?? labelFilter;
          issues = issues.filter((issue) => issue.labels.includes(internalLabel));
        }
        if (parentFilter) {
          issues = issues.filter((issue) => issue.parent_id === parentFilter);
        }
        return { ...repo, issues };
      })
      .filter((repo) => repo.issues.length > 0);
  }, [repos, statusFilter, normalizedFilter, repoFilter, labelFilter, parentFilter]);

  // Build flat list items: all issues sorted by created_at descending (newest first)
  const items = useMemo<ListItem[]>(() => {
    const all: ListItem[] = [];
    for (const repo of filteredRepos) {
      for (const issue of repo.issues) {
        all.push({ kind: 'issue', issue, repo });
      }
    }
    // Sort by created_at descending (newest first)
    all.sort((a, b) => {
      const ta = a.issue.created_at ? Date.parse(a.issue.created_at) : 0;
      const tb = b.issue.created_at ? Date.parse(b.issue.created_at) : 0;
      return tb - ta;
    });
    return all;
  }, [filteredRepos, sortField]);

  // Total issue count for badge
  const totalOpen = useMemo(
    () => repos.reduce((acc, r) => acc + r.open_count, 0),
    [repos],
  );

  // Fetch detail when selection changes.
  useEffect(() => {
    if (!selectedRepoId || !selectedIssueId) {
      setIssueDetail(null);
      setLinkedSessions([]);
      setIssueContext(null);
      return;
    }
    const repoId = resolveRepoId(selectedRepoId) ?? selectedRepoId;
    const issueId = resolveIssueId(repoId, selectedIssueId);
    let cancelled = false;
    // Bug: a44fd6a — only show loading spinner when the detail pane is empty.
    if (!issueDetail) {
      setDetailLoading(true);
    }
    const fetchDetail = (rId: string, iId: string) =>
      getIssueDetail(rId, iId).then((data) => {
        if (!cancelled) {
          if (rId !== selectedRepoId) setSelectedRepoId(rId);
          if (iId !== selectedIssueId) setSelectedIssueId(iId);
          setIssueDetail(data as GitBugIssueDetail);
          setDetailLoading(false);
        }
      });
    // Bug: 88d3b1d — defensive fallback chain
    fetchDetail(repoId, issueId).catch(() => {
      scanIssueRepo(repoId)
        .then(() => fetchDetail(repoId, issueId))
        .catch(() => {
          findIssue(issueId)
            .then((found) => {
              if (cancelled) return;
              const d = found as { repo_id?: string; id?: string } | null;
              if (d?.repo_id && d?.id) {
                setSelectedRepoId(d.repo_id);
                setSelectedIssueId(d.id);
                setIssueDetail(found as GitBugIssueDetail);
              } else {
                setIssueDetail(null);
              }
              setDetailLoading(false);
            })
            .catch(() => {
              if (!cancelled) {
                setIssueDetail(null);
                setDetailLoading(false);
              }
            });
        });
    });
    getIssueSessions(repoId, issueId)
      .then((data) => {
        if (!cancelled) {
          setLinkedSessions(data as Array<{session_id: string; created_at: number}>);
        }
      })
      .catch(() => {
        if (!cancelled) setLinkedSessions([]);
      });
    // Bug: 84cd5ae — fetch issue context for the hub view
    getIssueContext(repoId, issueId)
      .then((ctx) => {
        if (!cancelled) setIssueContext(ctx);
      })
      .catch(() => {
        if (!cancelled) setIssueContext(null);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedRepoId, selectedIssueId, resolveRepoId, resolveIssueId]);

  const selectIssue = useCallback((repoId: string, issueId: string) => {
    setSelectedRepoId(repoId);
    setSelectedIssueId(issueId);
    setShowCommentBox(false);
    setCommentText('');
  }, []);

  // Close issue (manual close — no "merged" label)
  const handleCloseIssue = useCallback(async () => {
    if (!selectedRepoId || !selectedIssueId || actionInFlight) return;
    setActionInFlight(true);
    try {
      await issueAction(selectedRepoId, selectedIssueId, 'status', {
        status: 'closed',
      });
      const data = await getIssueDetail(selectedRepoId, selectedIssueId);
      setIssueDetail(data as GitBugIssueDetail);
      onRescan();
    } catch {
      // silently fail
    } finally {
      setActionInFlight(false);
    }
  }, [selectedRepoId, selectedIssueId, actionInFlight, onRescan]);

  // Reopen issue (works for both closed and merged)
  const handleReopenIssue = useCallback(async () => {
    if (!selectedRepoId || !selectedIssueId || actionInFlight) return;
    setActionInFlight(true);
    try {
      // If merged, remove the "merged" label first
      if (issueDetail && issueDetail.labels.includes('merged')) {
        await issueAction(selectedRepoId, selectedIssueId, 'label', {
          action: 'remove',
          label: 'merged',
        });
      }
      await issueAction(selectedRepoId, selectedIssueId, 'status', {
        status: 'open',
      });
      const data = await getIssueDetail(selectedRepoId, selectedIssueId);
      setIssueDetail(data as GitBugIssueDetail);
      onRescan();
    } catch {
      // silently fail
    } finally {
      setActionInFlight(false);
    }
  }, [selectedRepoId, selectedIssueId, actionInFlight, onRescan, issueDetail]);

  const handleAddComment = useCallback(async () => {
    if (!selectedRepoId || !selectedIssueId || !commentText.trim() || actionInFlight) return;
    setActionInFlight(true);
    try {
      await issueAction(selectedRepoId, selectedIssueId, 'comment', {
        message: commentText.trim(),
      });
      setCommentText('');
      setShowCommentBox(false);
      // Refresh detail
      const data = await getIssueDetail(selectedRepoId, selectedIssueId);
      setIssueDetail(data as GitBugIssueDetail);
    } catch {
      // silently fail
    } finally {
      setActionInFlight(false);
    }
  }, [selectedRepoId, selectedIssueId, commentText, actionInFlight]);

  // Description and comments as HTML
  const descriptionHtml = useMemo(
    () => (issueDetail?.description ? renderMarkdown(issueDetail.description) : ''),
    [issueDetail?.description],
  );

  // Compute visual state of the currently selected detail
  const detailVisualState: VisualState | null = useMemo(
    () => (issueDetail ? getVisualState(issueDetail) : null),
    [issueDetail],
  );

  // Labels to display in detail — hide the "merged" label since it's shown via the status pill
  const displayLabels = useMemo(
    () => (issueDetail ? issueDetail.labels.filter((l) => l !== 'merged') : []),
    [issueDetail],
  );

  const { width: sidebarWidth, handleMouseDown } = useSidebarResize({
    defaultWidth: 280,
    minWidth: 190,
    storageKey: 'sidebar-width:issues',
  });

  return (
    <div className="issues-view">
      {/* Left sidebar panel */}
      <div className="issues-tree" style={{ ...(sidebarWidth !== null ? { width: `${sidebarWidth}px` } : {}), flexShrink: 0 }}>
        <div className="issues-filter">
          <input
            type="search"
            className="issues-filter__input"
            placeholder="Filter issues..."
            value={filter}
            onInput={(e) => setFilter(e.currentTarget.value)}
          />
        </div>

        {/* Repo filter */}
        <div className="issues-repo-filter">
          <input
            type="search"
            list="issues-repo-list"
            className="issues-filter__input issues-repo-filter__input"
            placeholder="Filter by repo..."
            value={repoInput}
            onInput={(e) => {
              const val = e.currentTarget.value;
              setRepoInput(val);
              if (!val) {
                setRepoFilter(null);
              }
            }}
            onChange={(e) => {
              const val = e.currentTarget.value;
              // When user selects from datalist, the value is repo_name; resolve to repo_id
              const matched = repos.find(
                (r) => r.repo_name === val || r.repo_id === val
              );
              if (matched) {
                setRepoFilter(matched.repo_id);
                setRepoInput(matched.repo_name);
              }
            }}
          />
          {repoInput && (
            <button
              type="button"
              className="issues-repo-filter__clear"
              onClick={() => {
                setRepoInput('');
                setRepoFilter(null);
              }}
              aria-label="Clear repo filter"
            >
              ×
            </button>
          )}
          <datalist id="issues-repo-list">
            {repos.map((r) => (
              <option key={r.repo_id} value={r.repo_name} />
            ))}
          </datalist>
        </div>

        <div className="issues-status-filters">
          <button
            type="button"
            className={`issues-status-pill${statusFilter === 'all' ? ' issues-status-pill--active' : ''}`}
            onClick={() => setStatusFilter('all')}
          >
            All
          </button>
          <button
            type="button"
            className={`issues-status-pill${statusFilter === 'open' ? ' issues-status-pill--active' : ''}`}
            onClick={() => setStatusFilter('open')}
          >
            Open
          </button>
          <button
            type="button"
            className={`issues-status-pill${statusFilter === 'merged' ? ' issues-status-pill--active issues-status-pill--merged' : ''}`}
            onClick={() => setStatusFilter('merged')}
          >
            Merged
          </button>
          <button
            type="button"
            className={`issues-status-pill${statusFilter === 'closed' ? ' issues-status-pill--active' : ''}`}
            onClick={() => setStatusFilter('closed')}
          >
            Closed
          </button>
        </div>

        {/* Label filter pills */}
        <div className="issues-label-filters">
          {(['umbrella', 'feature', 'bug', 'deferred'] as const).map((lbl) => (
            <button
              key={lbl}
              type="button"
              className={`issues-label-pill${labelFilter === lbl ? ' issues-label-pill--active' : ''}`}
              onClick={() => setLabelFilter((prev) => prev === lbl ? null : lbl)}
            >
              {lbl}
            </button>
          ))}
        </div>

        {/* Parent filter indicator */}
        {parentFilter && (
          <div className="issues-parent-filter">
            <span className="issues-parent-filter__label">
              Children of {parentFilter}
            </span>
            <button
              type="button"
              className="issues-parent-filter__clear"
              onClick={() => setParentFilter(null)}
            >
              Clear
            </button>
          </div>
        )}

        {/* Flat issue list */}
        {items.length === 0 ? (
          <div className="issues-tree__empty">
            {repos.length === 0
              ? 'No repos with git-bug issues found.'
              : 'No issues match the current filter.'}
          </div>
        ) : (
          <div className="issues-list">
            {items.map((item) => (
              <button
                key={item.issue.id}
                type="button"
                className={`issues-item${
                  selectedRepoId === item.repo.repo_id && selectedIssueId === item.issue.id
                    ? ' issues-item--selected'
                    : ''
                }`}
                onClick={() => selectIssue(item.repo.repo_id, item.issue.id)}
              >
                <span
                  className={`issue-status-dot issue-status-dot--${getVisualState(item.issue)}`}
                />
                <span
                  className="issues-item__title"
                  dangerouslySetInnerHTML={{ __html: renderInlineMarkdown(item.issue.title) }}
                />
                {filteredRepos.length > 1 && (
                  <span className="issues-item__repo">{item.repo.repo_name}</span>
                )}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Drag handle */}
      <div className="sidebar-drag-handle" onMouseDown={handleMouseDown} />

      {/* Right detail panel */}
      <div className="issues-detail">
        {!selectedIssueId ? (
          <div className="issues-detail__empty">
            <p className="text-muted">Select an issue to view details</p>
          </div>
        ) : detailLoading ? (
          <div className="issues-detail__empty">
            <p className="text-muted">Loading...</p>
          </div>
        ) : !issueDetail ? (
          <div className="issues-detail__empty">
            <p className="text-muted">Failed to load issue detail.</p>
          </div>
        ) : (
          <div className="issues-detail__content">
            {/* ── Status Banner ── Bug: 84cd5ae */}
            <div className="issue-hub__banner">
              <div className="issue-hub__banner-top">
                {/* Bug: a44fd6a — render issue detail title as inline markdown */}
                <h2
                  className="issues-detail__title"
                  dangerouslySetInnerHTML={{ __html: renderInlineMarkdown(issueDetail.title) }}
                />
              </div>
              <div className="issues-detail__meta">
                <span
                  className={`status-pill status-pill--lg ${
                    detailVisualState === 'open'
                      ? 'status-pill--success'
                      : detailVisualState === 'merged'
                        ? 'status-pill--merged'
                        : 'status-pill--dismissed'
                  }`}
                >
                  {detailVisualState}
                </span>
                {displayLabels.map((lbl) => {
                  const color = labelColor(lbl);
                  const display = LABEL_DISPLAY_NAMES[lbl] ?? lbl;
                  return (
                    <span
                      key={lbl}
                      className="issue-label-pill"
                      style={{ background: color.bg, color: color.fg }}
                      title="label"
                    >
                      {display}
                    </span>
                  );
                })}
                {/* Umbrella: show children button */}
                {issueDetail.labels.includes('umbrella') && (
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    onClick={() => {
                      setRepoFilter(issueDetail.repo_id);
                      setParentFilter(issueDetail.id.slice(0, 8));
                    }}
                  >
                    Show children
                  </button>
                )}
              </div>

              {/* Work unit status line */}
              {issueContext?.work_unit && (
                <div className="issue-hub__work-status">
                  {issueContext.work_unit.branch && (
                    <span className="issue-hub__branch-status">
                      {issueContext.work_unit.state === 'committed' ? 'Committed on ' : 'Assigned to '}
                      <EntityPill
                        type="branch"
                        id={issueContext.work_unit.branch}
                        label={issueContext.work_unit.branch}
                        repoId={issueDetail.repo_id}
                      />
                    </span>
                  )}
                  <span className={`issue-hub__liveness issue-hub__liveness--${
                    issueContext.work_unit.liveness.has_live_agent
                      ? (issueContext.work_unit.liveness.is_processing ? 'active' : 'idle')
                      : 'unassigned'
                  }`}>
                    <span className="issue-hub__liveness-dot" />
                    {issueContext.work_unit.liveness.has_live_agent
                      ? (issueContext.work_unit.liveness.is_processing
                          ? 'Active \u2014 SDK session running'
                          : 'Idle')
                      : 'Unassigned'}
                  </span>
                </div>
              )}

              {/* Action buttons */}
              <div className="issue-hub__actions">
                {/* Open in Console — only if there's an active session */}
                {issueContext?.work_unit?.liveness.has_live_agent &&
                  issueContext.work_unit.assigned_session_id && (
                  <a
                    className="issue-hub__action-btn issue-hub__action-btn--primary"
                    href={`#/console?session=${encodeURIComponent(issueContext.work_unit.assigned_session_id)}`}
                  >
                    Open in Console
                  </a>
                )}
                {/* Resume Work — continuation exists, no active session */}
                {issueContext?.work_unit?.continuation &&
                  !issueContext.work_unit.liveness.has_live_agent && (
                  <button
                    type="button"
                    className="issue-hub__action-btn issue-hub__action-btn--secondary"
                    onClick={() => {
                      // P6 will implement POST /api/issues/:repo/:id/spawn
                      // For now, no-op placeholder
                    }}
                    title="Coming soon — will spawn an SDK session with continuation context"
                  >
                    Resume Work
                  </button>
                )}
                {/* Start Agent — no active session, no continuation */}
                {(!issueContext?.work_unit || (
                  !issueContext.work_unit.liveness.has_live_agent &&
                  !issueContext.work_unit.continuation
                )) && (
                  <button
                    type="button"
                    className="issue-hub__action-btn issue-hub__action-btn--secondary"
                    onClick={() => {
                      // P6 will implement POST /api/issues/:repo/:id/spawn
                    }}
                    title="Coming soon — will spawn an SDK session for this issue"
                  >
                    Start Agent
                  </button>
                )}
              </div>
            </div>

            <div className="issues-detail__info text-muted">
              <span>{issueDetail.author}</span>
              {issueDetail.created_at && (
                <span> &middot; {formatRelativeTime(issueDetail.created_at)}</span>
              )}
              <span className="issues-detail__id"> &middot; {issueDetail.id.slice(0, 8)}</span>
            </div>

            {descriptionHtml ? (
              <div
                className="issues-detail__body spec-panel"
                dangerouslySetInnerHTML={{ __html: descriptionHtml }}
              />
            ) : (
              <div className="issues-detail__body spec-panel spec-panel--empty">
                No description.
              </div>
            )}

            {/* ── Activity Timeline ── Bug: 84cd5ae, f3dbb3e (chronological sort) */}
            <hr className="issues-detail__divider" />
            <h3 className="issues-detail__section-title">Activity</h3>
            <div className="issue-hub__timeline">
              {(() => {
                // Bug: f3dbb3e — normalize all timeline items to a common shape and sort chronologically
                type TimelineItem =
                  | { kind: 'session'; ts: number; sess: IssueContextSession }
                  | { kind: 'auth'; ts: number; auth: IssueContextAuthRequest }
                  | { kind: 'comment'; ts: number; comment: GitBugComment }
                  | { kind: 'handoff'; ts: number; continuation: string };

                const items: TimelineItem[] = [];

                for (const sess of (issueContext?.sessions ?? [])) {
                  const ts = sess.created_at
                    ? (typeof sess.created_at === 'string' ? Date.parse(sess.created_at) : Number(sess.created_at))
                    : 0;
                  items.push({ kind: 'session', ts: Number.isNaN(ts) ? 0 : ts, sess });
                }

                for (const auth of (issueContext?.auth_requests ?? [])) {
                  const ts = auth.created_at ? Number(auth.created_at) : 0;
                  items.push({ kind: 'auth', ts: Number.isNaN(ts) ? 0 : ts, auth });
                }

                for (const comment of issueDetail.comments) {
                  const ts = comment.date ? Date.parse(comment.date) : 0;
                  items.push({ kind: 'comment', ts: Number.isNaN(ts) ? 0 : ts, comment });
                }

                if (issueContext?.work_unit?.continuation) {
                  // Handoff note: use continuation_at if available, otherwise sort last
                  items.push({
                    kind: 'handoff',
                    ts: Number.MAX_SAFE_INTEGER,
                    continuation: issueContext.work_unit.continuation,
                  });
                }

                items.sort((a, b) => a.ts - b.ts);

                if (items.length === 0) {
                  return <div className="issue-hub__timeline-empty text-muted">No activity yet.</div>;
                }

                return items.map((item, idx) => {
                  if (item.kind === 'session') {
                    const sess = item.sess;
                    return (
                      <div key={`sess-${sess.session_id}`} className="issue-hub__timeline-item">
                        <span className="issue-hub__timeline-icon issue-hub__timeline-icon--session" />
                        <span className="issue-hub__timeline-text">
                          Session started
                          {sess.app ? ` (${sess.app})` : ''}
                          {' \u2014 '}
                          <EntityPill type="session" id={sess.session_id} />
                        </span>
                        {sess.created_at && (
                          <span className="issue-hub__timeline-time text-muted">
                            {formatRelativeTime(typeof sess.created_at === 'string' ? sess.created_at : new Date(sess.created_at).toISOString())}
                          </span>
                        )}
                      </div>
                    );
                  }
                  if (item.kind === 'auth') {
                    const auth = item.auth;
                    return (
                      <div key={`auth-${auth.id}`} className="issue-hub__timeline-item">
                        <span className="issue-hub__timeline-icon issue-hub__timeline-icon--auth" />
                        <span className="issue-hub__timeline-text">
                          Auth request: {auth.status}
                          {' \u2014 '}
                          <EntityPill type="auth" id={auth.id} label={auth.title?.slice(0, 30) || auth.id.slice(0, 8)} />
                        </span>
                        {item.ts > 0 && (
                          <span className="issue-hub__timeline-time text-muted">
                            {formatRelativeTime(new Date(item.ts).toISOString())}
                          </span>
                        )}
                      </div>
                    );
                  }
                  if (item.kind === 'comment') {
                    const comment = item.comment;
                    return (
                      <div key={comment.id} className="issue-hub__timeline-item">
                        <span className="issue-hub__timeline-icon issue-hub__timeline-icon--comment" />
                        <div className="issue-hub__timeline-comment">
                          <div className="issue-comment__header">
                            <span className="issue-comment__author">{comment.author}</span>
                            {comment.date && (
                              <span className="issue-comment__date text-muted">
                                {formatRelativeTime(comment.date)}
                              </span>
                            )}
                          </div>
                          <div
                            className="issue-comment__body spec-panel"
                            dangerouslySetInnerHTML={{
                              __html: renderMarkdown(comment.body),
                            }}
                          />
                        </div>
                      </div>
                    );
                  }
                  // handoff
                  return (
                    <div key={`handoff-${idx}`} className="issue-hub__timeline-item">
                      <span className="issue-hub__timeline-icon issue-hub__timeline-icon--handoff" />
                      <div className="issue-hub__timeline-comment">
                        <div className="issue-comment__header">
                          <span className="issue-comment__author">Handoff Note</span>
                        </div>
                        <div
                          className="issue-comment__body spec-panel"
                          dangerouslySetInnerHTML={{
                            __html: renderMarkdown(item.continuation),
                          }}
                        />
                      </div>
                    </div>
                  );
                });
              })()}
            </div>

            {/* ── Related Entities ── Bug: 84cd5ae */}
            {((issueContext?.sessions ?? []).length > 0 ||
              (issueContext?.auth_requests ?? []).length > 0 ||
              linkedSessions.length > 0) && (
              <>
                <hr className="issues-detail__divider" />
                <h3 className="issues-detail__section-title">Related</h3>
                <div className="issue-hub__related">
                  {/* Sessions */}
                  {(issueContext?.sessions ?? linkedSessions.map((l) => ({
                    session_id: l.session_id,
                    has_conversation: false,
                  }))).length > 0 && (
                    <div className="issue-hub__related-group">
                      <span className="issue-hub__related-label">Sessions</span>
                      <EntityPillList>
                        {(issueContext?.sessions ?? []).map((sess: IssueContextSession) => (
                          <EntityPill key={sess.session_id} type="session" id={sess.session_id} />
                        ))}
                        {!issueContext && linkedSessions.map((link) => (
                          <EntityPill key={link.session_id} type="session" id={link.session_id} />
                        ))}
                      </EntityPillList>
                    </div>
                  )}
                  {/* Auth requests */}
                  {(issueContext?.auth_requests ?? []).length > 0 && (
                    <div className="issue-hub__related-group">
                      <span className="issue-hub__related-label">Auth Requests</span>
                      <EntityPillList>
                        {(issueContext?.auth_requests ?? []).map((auth: IssueContextAuthRequest) => (
                          <EntityPill key={auth.id} type="auth" id={auth.id} label={auth.id.slice(0, 8)} />
                        ))}
                      </EntityPillList>
                    </div>
                  )}
                  {/* Conversations — from sessions that have conversations */}
                  {(issueContext?.sessions ?? []).filter((s: IssueContextSession) => s.has_conversation).length > 0 && (
                    <div className="issue-hub__related-group">
                      <span className="issue-hub__related-label">Conversations</span>
                      <EntityPillList>
                        {(issueContext?.sessions ?? [])
                          .filter((s: IssueContextSession) => s.has_conversation)
                          .map((s: IssueContextSession) => (
                            <EntityPill key={`conv-${s.session_id}`} type="conversation" id={s.session_id} />
                          ))}
                      </EntityPillList>
                    </div>
                  )}
                </div>
              </>
            )}

            <div className="issue-actions">
              {detailVisualState === 'open' ? (
                <button
                  type="button"
                  className="btn btn--danger"
                  disabled={actionInFlight}
                  onClick={handleCloseIssue}
                >
                  Close Issue
                </button>
              ) : (
                <button
                  type="button"
                  className="btn btn--success"
                  disabled={actionInFlight}
                  onClick={handleReopenIssue}
                >
                  Reopen Issue
                </button>
              )}
              <button
                type="button"
                className="btn btn--ghost"
                onClick={() => setShowCommentBox((prev) => !prev)}
              >
                {showCommentBox ? 'Cancel' : 'Add Comment'}
              </button>
            </div>

            {showCommentBox && (
              <div className="issue-comment-form">
                <textarea
                  className="issue-comment-form__input"
                  placeholder="Write a comment..."
                  value={commentText}
                  onInput={(e) => setCommentText(e.currentTarget.value)}
                  rows={4}
                />
                <button
                  type="button"
                  className="btn btn--active"
                  disabled={actionInFlight || !commentText.trim()}
                  onClick={handleAddComment}
                >
                  Submit Comment
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
