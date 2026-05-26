import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { marked } from 'marked';
import {
  addLedgerIssueComment,
  getLedgerIssueDetailByRef,
  patchLedgerIssue,
  resolveLedgerConflict,
  spawnIssueAgent,
  type LedgerIssueDetailProjection,
} from '../api';
import { sanitizeHtml } from '../sanitize';
import { useSidebarResize } from '../hooks/useSidebarResize';
import { LedgerIssueDetail } from '../components/ledger/IssueDetail';

// --- Types ---

export type IssueSummary = {
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

export type IssueRepoSummary = {
  repo_id: string;
  repo_name: string;
  repo_root: string;
  open_count: number;
  merged_count: number;
  closed_count: number;
  issues: IssueSummary[];
};

export type IssuesViewProps = {
  repos: IssueRepoSummary[];
  onRescan: () => Promise<void>;
  initialRepoId?: string;
  initialIssueId?: string;
  initialCommentId?: string;
};

// --- Helpers ---

// Bug: e32ee8b — three-state lifecycle: open, merged (closed + "merged" label), closed
type VisualState = 'open' | 'merged' | 'closed';

function getVisualState(issue: { status: string; labels: string[] }): VisualState {
  if (issue.status === 'open') return 'open';
  if (issue.labels.includes('merged')) return 'merged';
  return 'closed';
}

/**
 * Sanitize inline markdown HTML produced by marked before inserting it into the
 * local issue UI. Bug: 387ae46.
 */
function sanitizeInlineHtml(html: string): string {
  return sanitizeHtml(html);
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

// Reverse map: display name → internal label (for filter pills)
const LABEL_INTERNAL_NAMES: Record<string, string> = {
  bug: 'error',
  umbrella: 'umbrella',
  feature: 'feature',
  deferred: 'deferred',
};

function ledgerDetailMatchesSelection(
  detail: LedgerIssueDetailProjection | null,
  repoId: string | null,
  issueId: string | null,
): detail is LedgerIssueDetailProjection {
  if (!detail || !repoId || !issueId) return false;
  const repoMatches =
    detail.project.repo_id === repoId ||
    detail.project.repo_name === repoId ||
    detail.project.display_name === repoId;
  if (!repoMatches) return false;

  const refs = new Set<string>([detail.id, detail.display_id]);
  for (const alias of detail.aliases) {
    if (alias.alias) refs.add(alias.alias);
    if (alias.external_id) refs.add(alias.external_id);
  }
  return [...refs].some((ref) => ref === issueId || ref.startsWith(issueId) || issueId.startsWith(ref));
}

// --- Flat list item types ---

type ListItem = { kind: 'issue'; issue: IssueSummary; repo: IssueRepoSummary };

// --- Components ---

type StatusFilter = 'all' | 'open' | 'merged' | 'closed';

export function IssuesView({
  repos,
  onRescan,
  initialRepoId,
  initialIssueId,
  initialCommentId,
}: IssuesViewProps): JSX.Element {
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
  const [ledgerIssueDetail, setLedgerIssueDetail] = useState<LedgerIssueDetailProjection | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [actionInFlight, setActionInFlight] = useState(false);

  // Bug: a44fd6a — gate deep-link to run once per route change (not on every repos update)
  const lastAppliedDeepLinkRef = useRef<string | null>(null);
  const lastScrolledCommentRef = useRef<string | null>(null);

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
    const deepLinkKey = `${initialRepoId ?? ''}:${initialIssueId}:${initialCommentId ?? ''}`;
    if (lastAppliedDeepLinkRef.current === deepLinkKey) return;
    lastAppliedDeepLinkRef.current = deepLinkKey;

    if (initialRepoId) {
      const canonicalRepoId = resolveRepoId(initialRepoId) ?? initialRepoId;
      const canonicalIssueId = resolveIssueId(canonicalRepoId, initialIssueId);
      setSelectedRepoId(canonicalRepoId);
      setSelectedIssueId(canonicalIssueId);
      setRepoFilter(canonicalRepoId);
    } else {
      const found = repos
        .flatMap((repo) => repo.issues.map((issue) => ({ repo, issue })))
        .find(({ issue }) => issue.id === initialIssueId || issue.id.startsWith(initialIssueId));
      if (found) {
        setSelectedRepoId(found.repo.repo_id);
        setSelectedIssueId(found.issue.id);
        setRepoFilter(found.repo.repo_id);
      }
    }
  }, [initialRepoId, initialIssueId, initialCommentId, resolveRepoId, resolveIssueId, repos]);

  useEffect(() => {
    if (!ledgerIssueDetail || !initialCommentId) return;
    const scrollKey = `${ledgerIssueDetail.id}:${initialCommentId}`;
    if (lastScrolledCommentRef.current === scrollKey) return;
    const comment = document.getElementById(`comment-${initialCommentId}`);
    if (!comment) return;
    lastScrolledCommentRef.current = scrollKey;
    comment.scrollIntoView({ block: 'center' });
  }, [ledgerIssueDetail, initialCommentId]);

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

  const visibleLedgerIssueDetail = useMemo(
    () => ledgerDetailMatchesSelection(ledgerIssueDetail, selectedRepoId, selectedIssueId)
      ? ledgerIssueDetail
      : null,
    [ledgerIssueDetail, selectedRepoId, selectedIssueId],
  );

  // Fetch canonical ledger detail when selection changes.
  useEffect(() => {
    if (!selectedRepoId || !selectedIssueId) {
      setLedgerIssueDetail(null);
      setDetailLoading(false);
      return;
    }
    const repoId = resolveRepoId(selectedRepoId) ?? selectedRepoId;
    const issueId = resolveIssueId(repoId, selectedIssueId);
    let cancelled = false;
    setDetailLoading(true);
    getLedgerIssueDetailByRef(repoId, issueId)
      .then((detail) => {
        if (cancelled) return;
        setLedgerIssueDetail(detail);
      })
      .catch(() => {
        if (!cancelled) setLedgerIssueDetail(null);
      })
      .finally(() => {
        if (!cancelled) setDetailLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedRepoId, selectedIssueId, resolveRepoId, resolveIssueId]);

  const selectIssue = useCallback((repoId: string, issueId: string) => {
    setSelectedRepoId(repoId);
    setSelectedIssueId(issueId);
  }, []);

  const refreshLedgerIssueDetail = useCallback(async () => {
    if (!selectedRepoId || !selectedIssueId) return;
    try {
      const detail = await getLedgerIssueDetailByRef(selectedRepoId, selectedIssueId);
      setLedgerIssueDetail(detail);
    } catch {
      setLedgerIssueDetail(null);
    }
  }, [selectedRepoId, selectedIssueId]);

  const handleCloseIssue = useCallback(async () => {
    if (!visibleLedgerIssueDetail || actionInFlight) return;
    setActionInFlight(true);
    try {
      const detail = await patchLedgerIssue(visibleLedgerIssueDetail.id, { status: 'closed' });
      setLedgerIssueDetail(detail);
      void onRescan();
    } catch {
      // silently fail
    } finally {
      setActionInFlight(false);
    }
  }, [visibleLedgerIssueDetail, actionInFlight, onRescan]);

  const handleReopenIssue = useCallback(async () => {
    if (!visibleLedgerIssueDetail || actionInFlight) return;
    setActionInFlight(true);
    try {
      const detail = await patchLedgerIssue(visibleLedgerIssueDetail.id, { status: 'open', resolution: null });
      setLedgerIssueDetail(detail);
      void onRescan();
    } catch {
      // silently fail
    } finally {
      setActionInFlight(false);
    }
  }, [visibleLedgerIssueDetail, actionInFlight, onRescan]);

  const handleAddCommentBody = useCallback(async (message: string) => {
    if (!visibleLedgerIssueDetail || !message.trim() || actionInFlight) return;
    setActionInFlight(true);
    try {
      const detail = await addLedgerIssueComment(visibleLedgerIssueDetail.id, message.trim());
      setLedgerIssueDetail(detail);
    } catch {
      // silently fail
    } finally {
      setActionInFlight(false);
    }
  }, [visibleLedgerIssueDetail, actionInFlight]);

  const handleStartAgent = useCallback(async () => {
    if (!selectedRepoId || !selectedIssueId || actionInFlight) return;
    setActionInFlight(true);
    try {
      const result = await spawnIssueAgent(selectedRepoId, selectedIssueId);
      window.location.hash = `#/console?session=${encodeURIComponent(result.console_session_id)}`;
    } catch {
      // silently fail
    } finally {
      setActionInFlight(false);
    }
  }, [selectedRepoId, selectedIssueId, actionInFlight]);

  const handleOpenLedgerEntity = useCallback((type: 'issue' | 'session' | 'auth_request' | 'conversation', id: string, repoId?: string) => {
    if (type === 'issue') {
      if (repoId) {
        selectIssue(repoId, id);
      } else if (selectedRepoId) {
        selectIssue(selectedRepoId, id);
      }
      return;
    }
    if (type === 'session') {
      window.location.hash = `#/sessions?session=${encodeURIComponent(id.replace(/^session:/, ''))}`;
      return;
    }
    if (type === 'conversation') {
      window.location.hash = `#/history?session=${encodeURIComponent(id.replace(/^session:/, ''))}`;
      return;
    }
    if (type === 'auth_request') {
      window.location.hash = `#/auth?request=${encodeURIComponent(id.replace(/^auth_request:/, ''))}`;
    }
  }, [selectedRepoId, selectIssue]);

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
              ? 'No repos with issues found.'
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
        ) : visibleLedgerIssueDetail ? (
          <div className="issues-detail__content">
            <LedgerIssueDetail
              detail={visibleLedgerIssueDetail}
              actionInFlight={actionInFlight}
              onAddComment={handleAddCommentBody}
              onSetStatus={(status) => status === 'open' ? handleReopenIssue() : handleCloseIssue()}
              onStartAgent={handleStartAgent}
              onOpenEntity={handleOpenLedgerEntity}
              onShowChildren={(detail) => {
                if (detail.project.repo_id) setRepoFilter(detail.project.repo_id);
                setParentFilter(detail.display_id);
              }}
              onResolveConflict={async (conflictId, resolution, status) => {
                await resolveLedgerConflict(conflictId, resolution, status);
                await refreshLedgerIssueDetail();
              }}
            />
          </div>
        ) : detailLoading ? (
          <div className="issues-detail__empty">
            <p className="text-muted">Loading...</p>
          </div>
        ) : (
          <div className="issues-detail__empty">
            <p className="text-muted">Failed to load issue detail.</p>
          </div>
        )}
      </div>
    </div>
  );
}
