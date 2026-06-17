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
  repo_root?: string | null;
  open_count: number;
  merged_count: number;
  closed_count: number;
  issues: IssueSummary[];
};

function pathBasename(value: string | null | undefined): string {
  if (typeof value !== 'string') return '';
  const normalized = value.trim().replace(/[\\/]+$/, '');
  const parts = normalized.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? normalized;
}

export function resolveIssueRepoDeepLink(
  repos: IssueRepoSummary[],
  rawRepoId: string | null | undefined,
): string | null {
  if (!rawRepoId) return null;
  const trimmed = rawRepoId.trim();
  if (!trimmed) return null;
  const basename = pathBasename(trimmed);

  const repoMatches = (repo: IssueRepoSummary, value: string, ignoreCase: boolean): boolean => {
    const candidates = [repo.repo_id, repo.repo_name, repo.repo_root, pathBasename(repo.repo_root)]
      .filter((candidate): candidate is string => typeof candidate === 'string' && candidate.trim() !== '');
    return candidates.some((candidate) => (
      ignoreCase
        ? candidate.toLowerCase() === value.toLowerCase()
        : candidate === value
    ));
  };

  const exact = repos.find((repo) => repoMatches(repo, trimmed, false));
  if (exact) return exact.repo_id;
  const basenameMatch = repos.find((repo) => repoMatches(repo, basename, false));
  if (basenameMatch) return basenameMatch.repo_id;
  const insensitive = repos.find((repo) => (
    repoMatches(repo, trimmed, true) || repoMatches(repo, basename, true)
  ));
  if (insensitive) return insensitive.repo_id;
  return trimmed;
}

export function resolveIssueIdDeepLink(
  repo: IssueRepoSummary | undefined,
  rawIssueId: string,
): string {
  if (!repo) return rawIssueId;
  const exact = repo.issues.find((issue) => issue.id === rawIssueId);
  if (exact) return exact.id;
  const matches = repo.issues.filter((issue) => (
    issue.id.startsWith(rawIssueId) || rawIssueId.startsWith(issue.id)
  ));
  return matches.length === 1 ? matches[0].id : rawIssueId;
}

export type IssuesViewProps = {
  repos: IssueRepoSummary[];
  onRescan: () => Promise<void>;
  initialRepoId?: string;
  initialIssueId?: string;
  initialCommentId?: string;
  defaultFilter?: string;
  sidebarHidden?: boolean;
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
  coordination: 'coordination',
};

const KIND_FILTERS = [
  { key: 'umbrella', label: 'umbrella', labels: ['umbrella'] },
  { key: 'feature', label: 'feature', labels: ['feature'] },
  { key: 'bug', label: 'bug', labels: ['error', 'bug'] },
  { key: 'deferred', label: 'deferred', labels: ['deferred'] },
  { key: 'coordination', label: 'coordination', labels: ['coordination'] },
] as const;

const PRIORITY_FILTERS = [
  { key: 'important', label: 'important', labels: ['important'] },
  { key: 'user-action-required', label: 'user action', labels: ['user-action-required'] },
] as const;

type ParsedIssueFilter = {
  text: string;
  status: StatusFilter | null;
  kinds: string[];
  priorities: string[];
};

function parseIssueFilter(value: string): ParsedIssueFilter {
  const textParts: string[] = [];
  let status: StatusFilter | null = null;
  const kinds = new Set<string>();
  const priorities = new Set<string>();

  for (const token of value.trim().split(/\s+/).filter(Boolean)) {
    const match = token.match(/^([a-z]+):(.+)$/i);
    if (!match) {
      textParts.push(token);
      continue;
    }
    const key = match[1].toLowerCase();
    const values = match[2].split(',').map((part) => part.trim().toLowerCase()).filter(Boolean);
    if (key === 'status') {
      const next = values[0];
      if (next === 'all' || next === 'open' || next === 'merged' || next === 'closed') {
        status = next;
      }
      continue;
    }
    if (key === 'kind') {
      values.forEach((kind) => kinds.add(kind));
      continue;
    }
    if (key === 'priority') {
      values.forEach((priority) => priorities.add(priority));
      continue;
    }
    textParts.push(token);
  }

  return {
    text: textParts.join(' '),
    status,
    kinds: [...kinds],
    priorities: [...priorities],
  };
}

function formatIssueFilter(parsed: ParsedIssueFilter): string {
  const tokens = [parsed.text.trim()].filter(Boolean);
  if (parsed.status) tokens.push(`status:${parsed.status}`);
  if (parsed.kinds.length > 0) tokens.push(`kind:${parsed.kinds.join(',')}`);
  if (parsed.priorities.length > 0) tokens.push(`priority:${parsed.priorities.join(',')}`);
  return tokens.join(' ');
}

function issueHasAnyLabel(issue: { labels: string[] }, labelGroups: readonly { key: string; labels: readonly string[] }[], selected: string[]): boolean {
  if (selected.length === 0) return true;
  return selected.some((key) => {
    const option = labelGroups.find((candidate) => candidate.key === key);
    const labels = option?.labels ?? [key];
    return labels.some((label) => issue.labels.includes(label));
  });
}

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

function issueRouteHash(repoId: string, issueId: string, commentId?: string | null): string {
  const params = new URLSearchParams({ repo: repoId, issue: issueId });
  if (commentId) params.set('comment', commentId);
  return `#/issues?${params.toString()}`;
}

// --- Flat list item types ---

type ListItem = { kind: 'issue'; issue: IssueSummary; repo: IssueRepoSummary };

// --- Components ---

type StatusFilter = 'all' | 'open' | 'merged' | 'closed';

const DEFAULT_ISSUES_FILTER = 'status:open';

function normalizeIssueDefaultFilter(value: string | null | undefined): string {
  return value?.trim() || DEFAULT_ISSUES_FILTER;
}

export function IssuesView({
  repos,
  onRescan,
  initialRepoId,
  initialIssueId,
  initialCommentId,
  defaultFilter,
  sidebarHidden = false,
}: IssuesViewProps): JSX.Element {
  const normalizedDefaultFilter = useMemo(
    () => normalizeIssueDefaultFilter(defaultFilter),
    [defaultFilter],
  );
  // Local state
  const [selectedRepoId, setSelectedRepoId] = useState<string | null>(null);
  const [selectedIssueId, setSelectedIssueId] = useState<string | null>(null);
  const [filter, setFilter] = useState(normalizedDefaultFilter);
  const [filterMenuOpen, setFilterMenuOpen] = useState(false);
  const [repoFilter, setRepoFilter] = useState<string | null>(null);
  const [repoInput, setRepoInput] = useState('');
  const [repoMenuOpen, setRepoMenuOpen] = useState(false);
  const [parentFilter, setParentFilter] = useState<string | null>(null);
  type SortField = 'created_at';
  const [sortField] = useState<SortField>('created_at');
  const [ledgerIssueDetail, setLedgerIssueDetail] = useState<LedgerIssueDetailProjection | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [actionInFlight, setActionInFlight] = useState(false);

  // Bug: a44fd6a — gate deep-link to run once per route change (not on every repos update)
  const lastAppliedDeepLinkRef = useRef<string | null>(null);
  const lastScrolledCommentRef = useRef<string | null>(null);
  const filterEditedRef = useRef(false);

  useEffect(() => {
    if (!filterEditedRef.current) setFilter(normalizedDefaultFilter);
  }, [normalizedDefaultFilter]);

  const setIssueFilter = useCallback((nextFilter: string) => {
    filterEditedRef.current = true;
    setFilter(nextFilter);
  }, []);

  const resolveRepoId = useCallback((rawRepoId: string | null | undefined): string | null => {
    return resolveIssueRepoDeepLink(repos, rawRepoId);
  }, [repos]);

  const resolveIssueId = useCallback((repoId: string, rawIssueId: string): string => {
    const repo = repos.find((r) => r.repo_id === repoId);
    return resolveIssueIdDeepLink(repo, rawIssueId);
  }, [repos]);

  // Deep-link: auto-select issue from URL params without treating the route repo
  // as a sidebar filter. The repo filter is user-controlled through the field.
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
    } else {
      const found = repos
        .flatMap((repo) => repo.issues.map((issue) => ({ repo, issue })))
        .find(({ issue }) => issue.id === initialIssueId || issue.id.startsWith(initialIssueId));
      if (found) {
        setSelectedRepoId(found.repo.repo_id);
        setSelectedIssueId(found.issue.id);
      }
    }
  }, [initialRepoId, initialIssueId, initialCommentId, resolveRepoId, resolveIssueId, repos]);

  useEffect(() => {
    if (!ledgerIssueDetail || !initialCommentId) return;
    const scrollKey = `${ledgerIssueDetail.id}:${initialCommentId}`;
    if (lastScrolledCommentRef.current === scrollKey) return;
    const comment = document.getElementById(`comment-${initialCommentId}`)
      ?? document.querySelector(`[data-comment-ordinal="${CSS.escape(initialCommentId)}"]`);
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

  const parsedFilter = useMemo(() => parseIssueFilter(filter), [filter]);
  const normalizedFilter = useMemo(() => parsedFilter.text.trim().toLowerCase(), [parsedFilter.text]);
  const selectedStatus = parsedFilter.status;
  const selectedKinds = parsedFilter.kinds;
  const selectedPriorities = parsedFilter.priorities;

  const updateStructuredFilter = useCallback((next: Partial<ParsedIssueFilter>) => {
    setFilter((current) => {
      filterEditedRef.current = true;
      return formatIssueFilter({ ...parseIssueFilter(current), ...next });
    });
  }, []);

  const toggleMultiFilter = useCallback((field: 'kinds' | 'priorities', key: string) => {
    setFilter((current) => {
      filterEditedRef.current = true;
      const parsed = parseIssueFilter(current);
      const values = new Set(parsed[field]);
      if (values.has(key)) {
        values.delete(key);
      } else {
        values.add(key);
      }
      return formatIssueFilter({ ...parsed, [field]: [...values] });
    });
  }, []);

  // Filter issues within repos — three-state aware, plus repo/label/parent filters
  const filteredRepos = useMemo(() => {
    return repos
      .filter((repo) => !repoFilter || repo.repo_id === repoFilter)
      .map((repo) => {
        let issues = repo.issues;
        if (selectedStatus && selectedStatus !== 'all') {
          issues = issues.filter((issue) => getVisualState(issue) === selectedStatus);
        }
        if (normalizedFilter) {
          issues = issues.filter(
            (issue) =>
              issue.title.toLowerCase().includes(normalizedFilter) ||
              issue.id.toLowerCase().includes(normalizedFilter),
          );
        }
        if (selectedKinds.length > 0) {
          issues = issues.filter((issue) => issueHasAnyLabel(issue, KIND_FILTERS, selectedKinds));
        }
        if (selectedPriorities.length > 0) {
          issues = issues.filter((issue) => issueHasAnyLabel(issue, PRIORITY_FILTERS, selectedPriorities));
        }
        if (parentFilter) {
          issues = issues.filter((issue) => issue.parent_id === parentFilter);
        }
        return { ...repo, issues };
      })
      .filter((repo) => repo.issues.length > 0);
  }, [repos, selectedStatus, normalizedFilter, repoFilter, selectedKinds, selectedPriorities, parentFilter]);

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

  const repoOptions = useMemo(() => {
    const normalized = repoInput.trim().toLowerCase();
    return repos
      .filter((repo) => {
        if (!normalized) return true;
        return (
          repo.repo_name.toLowerCase().includes(normalized) ||
          repo.repo_id.toLowerCase().includes(normalized)
        );
      })
      .slice(0, 12);
  }, [repos, repoInput]);

  const showRepoLabels = useMemo(() => {
    return new Set(items.map((item) => item.repo.repo_id)).size > 1;
  }, [items]);

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
    const nextHash = issueRouteHash(repoId, issueId);
    if (typeof window !== 'undefined' && window.location.hash !== nextHash) {
      window.history.pushState(null, '', nextHash);
      window.dispatchEvent(new PopStateEvent('popstate'));
    }
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
    defaultWidth: 420,
    minWidth: 280,
    storageKey: 'sidebar-width:issues',
  });

  return (
    <div className="issues-view">
      {!sidebarHidden ? (
        <div className="issues-tree" style={{ ...(sidebarWidth !== null ? { width: `${sidebarWidth}px` } : {}), flexShrink: 0 }}>
          <div className="sidebar-drag-handle issues-tree__resize-handle" onMouseDown={handleMouseDown} />
          <div
            className="issues-filter"
            onBlur={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                setFilterMenuOpen(false);
              }
            }}
          >
            <input
              type="text"
              className="issues-filter__input"
              placeholder="Filter issues..."
              value={filter}
              onInput={(e) => setIssueFilter(e.currentTarget.value)}
            />
            {filter && (
              <button
                type="button"
                className="issues-filter__clear"
                aria-label="Clear issue filter"
                title="Clear issue filter"
                onClick={() => setIssueFilter('')}
              >
                <ClearIcon />
              </button>
            )}
            <button
              type="button"
              className={`issues-filter__advanced-trigger${filterMenuOpen ? ' issues-filter__advanced-trigger--active' : ''}`}
              aria-label="Advanced issue filters"
              title="Advanced issue filters"
              onClick={() => setFilterMenuOpen((prev) => !prev)}
            >
              <FilterIcon />
            </button>
            {filterMenuOpen && (
              <div className="issues-filter-menu">
              <div className="issues-filter-menu__header">
                <span>Filters</span>
                <button
                  type="button"
                  className="issues-filter-menu__clear"
                  onClick={() => setIssueFilter(parsedFilter.text)}
                >
                  Clear
                </button>
              </div>
              <div className="issues-filter-menu__section">
                <span className="issues-filter-menu__label">Status</span>
                <div className="issues-filter-menu__options issues-filter-menu__options--segmented">
                  {(['all', 'open', 'merged', 'closed'] as const).map((status) => (
                    <button
                      key={status}
                      type="button"
                      className={`issues-filter-menu__option${selectedStatus === status ? ' issues-filter-menu__option--active' : ''}`}
                      onClick={() => updateStructuredFilter({ status })}
                    >
                      {status}
                    </button>
                  ))}
                </div>
              </div>
              <div className="issues-filter-menu__section">
                <span className="issues-filter-menu__label">Kind</span>
                <div className="issues-filter-menu__options">
                  {KIND_FILTERS.map((kind) => (
                    <button
                      key={kind.key}
                      type="button"
                      className={`issues-filter-menu__option${selectedKinds.includes(kind.key) ? ' issues-filter-menu__option--active' : ''}`}
                      onClick={() => toggleMultiFilter('kinds', kind.key)}
                    >
                      {kind.label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="issues-filter-menu__section">
                <span className="issues-filter-menu__label">Priority</span>
                <div className="issues-filter-menu__options">
                  {PRIORITY_FILTERS.map((priority) => (
                    <button
                      key={priority.key}
                      type="button"
                      className={`issues-filter-menu__option${selectedPriorities.includes(priority.key) ? ' issues-filter-menu__option--active' : ''}`}
                      onClick={() => toggleMultiFilter('priorities', priority.key)}
                    >
                      {priority.label}
                    </button>
                  ))}
                </div>
              </div>
              </div>
            )}
          </div>

        {/* Repo filter */}
        <div
          className="issues-repo-filter"
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
              setRepoMenuOpen(false);
            }
          }}
        >
          <input
            type="search"
            className="issues-filter__input issues-repo-filter__input"
            placeholder="Filter by repo..."
            value={repoInput}
            onFocus={() => setRepoMenuOpen(true)}
            onClick={() => setRepoMenuOpen(true)}
            onInput={(e) => {
              const val = e.currentTarget.value;
              setRepoInput(val);
              setRepoMenuOpen(true);
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
                setRepoMenuOpen(false);
              }
            }}
          />
          {repoMenuOpen && repoOptions.length > 0 && (
            <div className="issues-repo-filter__menu" role="listbox">
              {repoOptions.map((repo) => (
                <button
                  key={repo.repo_id}
                  type="button"
                  className="issues-repo-filter__option"
                  role="option"
                  aria-selected={repoFilter === repo.repo_id}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => {
                    setRepoFilter(repo.repo_id);
                    setRepoInput(repo.repo_name);
                    setRepoMenuOpen(false);
                  }}
                >
                  <span className="issues-repo-filter__option-name">{repo.repo_name}</span>
                  <span className="issues-repo-filter__option-count">{repo.issues.length}</span>
                </button>
              ))}
            </div>
          )}
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
                {showRepoLabels && (
                  <span className="issues-item__repo">{item.repo.repo_name}</span>
                )}
              </button>
            ))}
          </div>
        )}
      </div>
      ) : null}

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

function FilterIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 6h16" />
      <path d="M7 12h10" />
      <path d="M10 18h4" />
    </svg>
  );
}

function ClearIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M18 6L6 18" />
      <path d="M6 6l12 12" />
    </svg>
  );
}
