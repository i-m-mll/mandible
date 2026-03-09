import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { marked } from 'marked';
import { findIssue, getIssueDetail, getIssueSessions, issueAction, scanIssueRepo } from '../api';

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
  onRescan: () => void;
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
 * Render inline markdown — strips the outer <p>…</p> wrapper for single-line
 * input so text flows inline in compact contexts (sidebar titles, list items).
 * Bug: a44fd6a — markdown rendering in issues sidebar titles
 */
function renderInlineMarkdown(src: string): string {
  if (!src) return '';
  const result = marked.parse(src, { async: false });
  const html = typeof result === 'string' ? result : '';
  return html.replace(/^<p>([\s\S]*?)<\/p>\n?$/, '$1').trim();
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

// --- Components ---

type StatusFilter = 'all' | 'open' | 'merged' | 'closed';

/** Scrollable issue list with bottom fade that disappears at scroll end. */
function ScrollableIssueList({ children, totalCount }: { children: preact.ComponentChildren; totalCount: number }): JSX.Element {
  const listRef = useRef<HTMLDivElement>(null);
  const [needsFade, setNeedsFade] = useState(true);

  const checkFade = useCallback(() => {
    const el = listRef.current;
    if (!el) return;
    // No fade if content doesn't overflow, or scrolled near bottom (2px tolerance)
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 3;
    const noOverflow = el.scrollHeight <= el.clientHeight;
    setNeedsFade(!noOverflow && !atBottom);
  }, []);

  useEffect(() => {
    checkFade();
    // Re-check if children change (e.g. filter applied)
  }, [children, checkFade]);

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    // Also check after images/fonts settle
    const observer = new ResizeObserver(() => checkFade());
    observer.observe(el);
    return () => observer.disconnect();
  }, [checkFade]);

  return (
    <div className="issues-repo-list-wrapper">
      <div
        ref={listRef}
        className={`issues-repo-list${needsFade ? '' : ' issues-repo-list--no-fade'}`}
        onScroll={checkFade}
      >
        {children}
      </div>
      {needsFade && totalCount > 0 && (
        <div className="issues-repo-list__count">{totalCount} issues</div>
      )}
    </div>
  );
}

export function IssuesView({ repos, onRescan, initialRepoId, initialIssueId }: IssuesViewProps): JSX.Element {
  // Local state
  const [selectedRepoId, setSelectedRepoId] = useState<string | null>(null);
  const [selectedIssueId, setSelectedIssueId] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('open');
  const [expandedRepos, setExpandedRepos] = useState<Set<string>>(() => new Set());
  const [issueDetail, setIssueDetail] = useState<GitBugIssueDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [commentText, setCommentText] = useState('');
  const [showCommentBox, setShowCommentBox] = useState(false);
  const [actionInFlight, setActionInFlight] = useState(false);
  const [linkedSessions, setLinkedSessions] = useState<Array<{session_id: string; created_at: number}>>([]);

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

  // Auto-expand repos that have issues
  useEffect(() => {
    if (expandedRepos.size === 0 && repos.length > 0) {
      const initial = new Set<string>();
      for (const repo of repos) {
        if (repo.open_count > 0) {
          initial.add(repo.repo_id);
        }
      }
      if (initial.size > 0) {
        setExpandedRepos(initial);
      }
    }
  }, [repos]);

  // Deep-link: auto-select issue from URL params.
  // Supports two forms:
  //   #/issues?repo=<repoId>&issue=<issueId>  — legacy, requires known repo
  //   #/issues?issue=<issueId>                — cross-repo find via /api/issues/find/:id
  useEffect(() => {
    if (!initialIssueId) return;

    if (initialRepoId) {
      // Legacy path: repo provided, resolve directly
      const canonicalRepoId = resolveRepoId(initialRepoId) ?? initialRepoId;
      const canonicalIssueId = resolveIssueId(canonicalRepoId, initialIssueId);
      setSelectedRepoId(canonicalRepoId);
      setSelectedIssueId(canonicalIssueId);
      setExpandedRepos((prev) => {
        const next = new Set(prev);
        next.add(canonicalRepoId);
        return next;
      });
    } else {
      // No repo: search all scanned repos for this issue ID
      findIssue(initialIssueId).then((detail) => {
        const d = detail as { repo_id?: string; id?: string } | null;
        if (d?.repo_id && d?.id) {
          setSelectedRepoId(d.repo_id);
          setSelectedIssueId(d.id);
          setExpandedRepos((prev) => {
            const next = new Set(prev);
            next.add(d.repo_id!);
            return next;
          });
        }
      }).catch(() => {
        // Bug: aee671a — cold scanner cache: trigger global scan and retry once
        onRescan?.().then(() => findIssue(initialIssueId))
          .then((retried) => {
            const r = retried as { repo_id?: string; id?: string } | null;
            if (r?.repo_id && r?.id) {
              setSelectedRepoId(r.repo_id);
              setSelectedIssueId(r.id);
              setExpandedRepos((prev) => {
                const next = new Set(prev);
                next.add(r.repo_id!);
                return next;
              });
            }
          })
          .catch(() => {
            // Issue genuinely not found after scan — leave selection unchanged
          });
      });
    }
  }, [initialRepoId, initialIssueId, resolveRepoId, resolveIssueId]);

  const normalizedFilter = useMemo(() => filter.trim().toLowerCase(), [filter]);

  // Filter issues within repos — three-state aware
  const filteredRepos = useMemo(() => {
    return repos
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
        return { ...repo, issues };
      })
      .filter((repo) => repo.issues.length > 0);
  }, [repos, statusFilter, normalizedFilter]);

  // Total issue count for badge
  const totalOpen = useMemo(
    () => repos.reduce((acc, r) => acc + r.open_count, 0),
    [repos],
  );

  // Fetch detail when selection changes.
  // If the first attempt fails (e.g. daemon just reloaded and hasn't scanned
  // this repo yet), trigger a per-repo scan and retry once before giving up.
  //
  // Bug: 5183781 — do NOT call setSelectedRepoId/setSelectedIssueId inside this
  // effect. Those setState calls cause the effect to re-run (since selectedRepoId
  // and selectedIssueId are in the dep array), triggering a second fetch and
  // visible flicker. Instead, resolve the canonical IDs locally and use them
  // for fetching; update state only after the fetch completes successfully.
  useEffect(() => {
    if (!selectedRepoId || !selectedIssueId) {
      setIssueDetail(null);
      setLinkedSessions([]);
      return;
    }
    const repoId = resolveRepoId(selectedRepoId) ?? selectedRepoId;
    const issueId = resolveIssueId(repoId, selectedIssueId);
    let cancelled = false;
    setDetailLoading(true);
    const fetchDetail = (rId: string, iId: string) =>
      getIssueDetail(rId, iId).then((data) => {
        if (!cancelled) {
          // Normalise state to canonical IDs only after a successful fetch so
          // we don't trigger a mid-flight effect re-run (Bug: 5183781).
          if (rId !== selectedRepoId) setSelectedRepoId(rId);
          if (iId !== selectedIssueId) setSelectedIssueId(iId);
          setIssueDetail(data as GitBugIssueDetail);
          setDetailLoading(false);
        }
      });
    fetchDetail(repoId, issueId).catch(() => {
      // First attempt failed — trigger a targeted repo scan and retry once.
      scanIssueRepo(repoId)
        .then(() => fetchDetail(repoId, issueId))
        .catch(() => {
          if (!cancelled) {
            setIssueDetail(null);
            setDetailLoading(false);
          }
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
    return () => {
      cancelled = true;
    };
  }, [selectedRepoId, selectedIssueId, resolveRepoId, resolveIssueId]);

  const toggleRepo = useCallback((repoId: string) => {
    setExpandedRepos((prev) => {
      const next = new Set(prev);
      if (next.has(repoId)) {
        next.delete(repoId);
      } else {
        next.add(repoId);
      }
      return next;
    });
  }, []);

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

  return (
    <div className="issues-view">
      {/* Left tree panel */}
      <div className="issues-tree">
        <div className="issues-filter">
          <input
            type="search"
            className="issues-filter__input"
            placeholder="Filter issues..."
            value={filter}
            onInput={(e) => setFilter(e.currentTarget.value)}
          />
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

        {filteredRepos.length === 0 ? (
          <div className="issues-tree__empty">
            {repos.length === 0
              ? 'No repos with git-bug issues found.'
              : 'No issues match the current filter.'}
          </div>
        ) : (
          filteredRepos.map((repo) => {
            const isExpanded = expandedRepos.has(repo.repo_id);
            const openCount = repo.issues.filter((i) => i.status === 'open').length;
            return (
              <div key={repo.repo_id} className={`issues-repo-group${isExpanded ? ' issues-repo-group--expanded' : ''}`}>
                <button
                  type="button"
                  className="issues-repo-header"
                  onClick={() => toggleRepo(repo.repo_id)}
                >
                  <span className="issues-repo-header__chevron">
                    {isExpanded ? '\u25BE' : '\u25B8'}
                  </span>
                  <span className="issues-repo-header__name">{repo.repo_name}</span>
                  {openCount > 0 && (
                    <span className="issues-repo-header__badge">{openCount}</span>
                  )}
                </button>
                {isExpanded && (
                  <ScrollableIssueList totalCount={repo.issues.length}>
                    {repo.issues.map((issue) => {
                      const isSelected =
                        selectedRepoId === repo.repo_id && selectedIssueId === issue.id;
                      const vs = getVisualState(issue);
                      return (
                        <button
                          key={issue.id}
                          type="button"
                          className={`issues-item${isSelected ? ' issues-item--selected' : ''}`}
                          onClick={() => selectIssue(repo.repo_id, issue.id)}
                        >
                          <span
                            className={`issue-status-dot issue-status-dot--${vs}`}
                          />
                          {/* Bug: a44fd6a — render issue sidebar titles as inline markdown */}
                          <span
                            className="issues-item__title"
                            dangerouslySetInnerHTML={{ __html: renderInlineMarkdown(issue.title) }}
                          />
                        </button>
                      );
                    })}
                  </ScrollableIssueList>
                )}
              </div>
            );
          })
        )}
      </div>

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
            {/* Bug: a44fd6a — render issue detail title as inline markdown */}
            <h2
              className="issues-detail__title"
              dangerouslySetInnerHTML={{ __html: renderInlineMarkdown(issueDetail.title) }}
            />
            <div className="issues-detail__meta">
              <span
                className={`status-pill ${
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
                return (
                  <span
                    key={lbl}
                    className="issue-label-pill"
                    style={{ background: color.bg, color: color.fg }}
                  >
                    {lbl}
                  </span>
                );
              })}
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

            {issueDetail.comments.length > 0 && (
              <>
                <hr className="issues-detail__divider" />
                <h3 className="issues-detail__section-title">
                  Comments ({issueDetail.comments.length})
                </h3>
                <div className="issue-comments">
                  {issueDetail.comments.map((comment) => (
                    <div key={comment.id} className="issue-comment">
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
                  ))}
                </div>
              </>
            )}

            {linkedSessions.length > 0 && (
              <>
                <hr className="issues-detail__divider" />
                <h3 className="issues-detail__section-title">
                  Linked Sessions ({linkedSessions.length})
                </h3>
                <div className="linked-chips">
                  {linkedSessions.map((link) => (
                    <a
                      key={link.session_id}
                      className="linked-session-chip"
                      href={`#/sessions?session=${encodeURIComponent(link.session_id)}`}
                    >
                      {link.session_id.slice(0, 8)}
                    </a>
                  ))}
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
              ) : detailVisualState === 'merged' ? (
                <button
                  type="button"
                  className="btn btn--success"
                  disabled={actionInFlight}
                  onClick={handleReopenIssue}
                >
                  Reopen Issue
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
