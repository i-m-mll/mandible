import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import {
  addLedgerIssueComment,
  getLedgerIssueDetailByIssueId,
  getLedgerIssueDetailByRef,
  getLedgerIssueInitialDetailByIssueId,
  getLedgerIssueInitialDetailByRef,
  patchLedgerIssue,
  resolveLedgerConflict,
  spawnIssueAgent,
  type LedgerIssueDetailProjection,
} from '../api';
import { ViewSidebar } from '../components/ViewSidebar';
import { LedgerIssueDetail } from '../components/ledger/IssueDetail';
import { SidebarSearchFilterHeader } from '../components/shared/SidebarSearchFilterHeader';
import { usePersistedViewState } from '../hooks/usePersistedViewState';
import { renderInlineMarkdown } from '../lib/markdown';
import { detailRequestKey, readPersistedDetail, writePersistedDetail } from '../detail-cache';
import { useSidebarListNavigation } from '../hooks/useSidebarListNavigation';

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
  // Perf (issue e5fc02b): the /api/issues list projection omits description.
  // The body arrives via the two-stage detail fetch on selection; the
  // synthesized instant-paint detail treats an absent description as empty.
  description?: string;
  parent_id?: string;  // derived from parent:<human_id> label
};

export type IssueRepoSummary = {
  repo_id: string;
  project_key?: string | null;
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
    const candidates = [
      repo.project_key,
      repo.repo_id,
      repo.repo_name,
      repo.repo_root,
      pathBasename(repo.repo_root),
    ]
      .filter((candidate): candidate is string => typeof candidate === 'string' && candidate.trim() !== '');
    return candidates.some((candidate) => (
      ignoreCase
        ? candidate.toLowerCase() === value.toLowerCase()
        : candidate === value
    ));
  };

  const exact = repos.find((repo) => repoMatches(repo, trimmed, false));
  if (exact) return exact.project_key || exact.repo_id;
  const basenameMatch = repos.find((repo) => repoMatches(repo, basename, false));
  if (basenameMatch) return basenameMatch.project_key || basenameMatch.repo_id;
  const insensitive = repos.find((repo) => (
    repoMatches(repo, trimmed, true) || repoMatches(repo, basename, true)
  ));
  if (insensitive) return insensitive.project_key || insensitive.repo_id;
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
  if (!detail || !issueId) return false;
  if (repoId) {
    const repoMatches =
      detail.project.project_key === repoId ||
      detail.project.repo_id === repoId ||
      detail.project.repo_name === repoId ||
      detail.project.display_name === repoId;
    if (!repoMatches) return false;
  }

  const refs = new Set<string>([detail.id, detail.display_id]);
  for (const alias of detail.aliases) {
    if (alias.alias) refs.add(alias.alias);
    if (alias.external_id) refs.add(alias.external_id);
  }
  return [...refs].some((ref) => ref === issueId || ref.startsWith(issueId) || issueId.startsWith(ref));
}

function shouldAcceptInitialLedgerDetail(
  current: LedgerIssueDetailProjection | null,
  initial: LedgerIssueDetailProjection,
  repoId: string | null,
  issueId: string,
): boolean {
  if (!ledgerDetailMatchesSelection(initial, repoId, issueId)) return false;
  if (!current || !ledgerDetailMatchesSelection(current, repoId, issueId)) return true;
  return current.detail_stage === 'initial' || current.timeline_partial === true;
}

const ISSUE_DETAIL_CACHE_LIMIT = 15;
type IssueDetailCache = Map<string, LedgerIssueDetailProjection>;

function issueDetailCacheKeys(repoId: string | null, issueId: string): string[] {
  return [`${repoId ?? ''}:${issueId}`];
}

function putCachedIssueDetail(
  cache: IssueDetailCache,
  repoId: string | null,
  issueId: string,
  detail: LedgerIssueDetailProjection,
): void {
  if (detail.detail_stage === 'initial') return;
  const key = issueDetailCacheKeys(repoId, issueId)[0];
  cache.delete(key);
  cache.set(key, detail);
  while (cache.size > ISSUE_DETAIL_CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (!oldest) break;
    cache.delete(oldest);
  }
}

function getCachedIssueDetail(
  cache: IssueDetailCache,
  repoId: string | null,
  issueId: string,
): LedgerIssueDetailProjection | null {
  for (const key of issueDetailCacheKeys(repoId, issueId)) {
    const detail = cache.get(key);
    if (!detail) continue;
    cache.delete(key);
    cache.set(key, detail);
    return detail;
  }
  return null;
}

// Detail scroll intentionally remains session-scoped; promoting it to durable browser
// storage would change its lifetime and is outside the local filter contract below.
const ISSUE_DETAIL_SCROLL_STORAGE_PREFIX = 'mandible:issues:detail-scroll:';

function issueDetailScrollStorageKey(repoId: string, issueId: string): string {
  return `${ISSUE_DETAIL_SCROLL_STORAGE_PREFIX}${repoId}:${issueId}`;
}

function readIssueDetailScrollOffset(key: string): number | null {
  if (typeof window === 'undefined') return null;
  const value = window.sessionStorage.getItem(key);
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function writeIssueDetailScrollOffset(key: string, offset: number): void {
  if (typeof window === 'undefined') return;
  if (offset <= 0) {
    window.sessionStorage.removeItem(key);
    return;
  }
  window.sessionStorage.setItem(key, String(Math.round(offset)));
}

function synthesizeLedgerIssueDetail(
  repo: IssueRepoSummary,
  issue: IssueSummary,
): LedgerIssueDetailProjection {
  const createdAt = Date.parse(issue.created_at);
  const timestamp = Number.isFinite(createdAt) ? createdAt : Date.now();
  const author = { id: null, type: 'mandible_user' as const, display: issue.author || 'Mandible' };
  const labels = issue.labels ?? [];
  const kind = labels.includes('umbrella')
    ? 'umbrella'
    : labels.some((label) => label === 'error' || label === 'bug')
      ? 'bug'
      : labels.includes('deferred')
        ? 'deferred'
        : labels.includes('coordination')
          ? 'coordination'
          : 'feature';
  const priority = labels.includes('important')
    ? 'important'
    : labels.includes('user-action-required')
      ? 'user-action-required'
      : 'normal';
  const resolution = issue.status === 'closed' && labels.includes('merged') ? 'merged' : null;
  return {
    id: issue.id,
    display_id: issue.id,
    project: {
      id: repo.repo_id,
      project_key: repo.project_key ?? null,
      display_name: repo.repo_name,
      remote_identity: '',
      upstream_identity: '',
      repo_id: repo.repo_id,
      repo_name: repo.repo_name,
      repo_root: repo.repo_root ?? null,
      default_branch: null,
    },
    title: issue.title,
    body: issue.description ?? '',
    status: issue.status,
    resolution,
    kind,
    priority,
    source: 'mandible',
    author,
    created_at: timestamp,
    updated_at: timestamp,
    closed_at: null,
    aliases: [],
    labels,
    comments: [],
    checkpoints: [],
    timeline: [{
      id: `${issue.id}:body`,
      kind: 'body',
      ordinal: 0,
      body: issue.description ?? '',
      author,
      source: 'mandible',
      created_at: timestamp,
      updated_at: null,
    }],
    relationships: [],
    work_units: [],
    sessions: [],
    auth_requests: [],
    associated_artifacts: [],
    conflicts: [],
    sync: { state: 'clean', outbox: {}, open_conflicts: 0, latest_jobs: [] },
    detail_stage: 'initial',
    timeline_partial: true,
  };
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
const ISSUES_VIEW_STATE_STORAGE_KEY = 'mandible_issues_view_state:v1';

type IssuesViewState = {
  filter: string;
  filterEdited: boolean;
  parentFilter: string | null;
};

function normalizeIssueDefaultFilter(value: string | null | undefined): string {
  return value?.trim() || DEFAULT_ISSUES_FILTER;
}

function normalizeIssuesViewState(value: unknown, defaults: Readonly<IssuesViewState>): IssuesViewState {
  const stored = value && typeof value === 'object' ? value as Partial<IssuesViewState> : {};
  const hasEditedFilter = stored.filterEdited === true && typeof stored.filter === 'string';
  const legacyRepoFilter = typeof (stored as Partial<IssuesViewState> & { repoFilter?: unknown }).repoFilter === 'string'
    ? (stored as Partial<IssuesViewState> & { repoFilter: string }).repoFilter.trim()
    : '';
  const storedFilter = hasEditedFilter
    ? stored.filter
    : defaults.filter;
  const filter = legacyRepoFilter && !storedFilter.toLowerCase().includes(legacyRepoFilter.toLowerCase())
    ? `${storedFilter} ${legacyRepoFilter}`.trim()
    : storedFilter;
  return {
    filter,
    filterEdited: hasEditedFilter || Boolean(legacyRepoFilter),
    parentFilter: stored.parentFilter === null || typeof stored.parentFilter === 'string'
      ? stored.parentFilter
      : defaults.parentFilter,
  };
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
  const defaultViewState = useMemo<IssuesViewState>(() => ({
    filter: normalizedDefaultFilter,
    filterEdited: false,
    parentFilter: null,
  }), [normalizedDefaultFilter]);
  const [viewState, setViewState] = usePersistedViewState(
    ISSUES_VIEW_STATE_STORAGE_KEY,
    normalizeIssuesViewState,
    defaultViewState,
  );
  const { filter, parentFilter } = viewState;
  // Local state
  const [selectedRepoId, setSelectedRepoId] = useState<string | null>(null);
  const [selectedIssueId, setSelectedIssueId] = useState<string | null>(null);
  const [filterMenuOpen, setFilterMenuOpen] = useState(false);
  type SortField = 'created_at';
  const [sortField] = useState<SortField>('created_at');
  const [ledgerIssueDetail, setLedgerIssueDetail] = useState<LedgerIssueDetailProjection | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailLoadFailed, setDetailLoadFailed] = useState(false);
  const [actionInFlight, setActionInFlight] = useState(false);

  // Bug: a44fd6a — gate deep-link to run once per route change (not on every repos update)
  const lastAppliedDeepLinkRef = useRef<string | null>(null);
  const lastScrolledCommentRef = useRef<string | null>(null);
  const detailRequestSeqRef = useRef(0);
  const issueDetailScrollRef = useRef<HTMLDivElement>(null);
  const scrollSaveTimerRef = useRef<number | null>(null);
  const lastRestoredScrollKeyRef = useRef<string | null>(null);
  const issueDetailCacheRef = useRef<IssueDetailCache>(new Map());

  useEffect(() => {
    setViewState((current) => current.filterEdited
      ? current
      : { ...current, filter: normalizedDefaultFilter });
  }, [normalizedDefaultFilter]);

  const setIssueFilter = useCallback((nextFilter: string) => {
    setViewState((current) => ({
      ...current,
      filter: nextFilter,
      filterEdited: true,
    }));
  }, [setViewState]);

  const setParentFilter = useCallback((parentFilterValue: string | null) => {
    setViewState((current) => ({ ...current, parentFilter: parentFilterValue }));
  }, [setViewState]);

  const resolveRepoId = useCallback((rawRepoId: string | null | undefined): string | null => {
    return resolveIssueRepoDeepLink(repos, rawRepoId);
  }, [repos]);

  const resolveIssueId = useCallback((repoId: string, rawIssueId: string): string => {
    const repo = repos.find((r) => r.repo_id === repoId || r.project_key === repoId);
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
      setSelectedRepoId(null);
      setSelectedIssueId(initialIssueId);
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

  const parsedFilter = useMemo(() => parseIssueFilter(filter), [filter]);
  const normalizedFilter = useMemo(() => parsedFilter.text.trim().toLowerCase(), [parsedFilter.text]);
  const selectedStatus = parsedFilter.status;
  const selectedKinds = parsedFilter.kinds;
  const selectedPriorities = parsedFilter.priorities;

  const updateStructuredFilter = useCallback((next: Partial<ParsedIssueFilter>) => {
    setViewState((current) => ({
      ...current,
      filter: formatIssueFilter({ ...parseIssueFilter(current.filter), ...next }),
      filterEdited: true,
    }));
  }, [setViewState]);

  const toggleMultiFilter = useCallback((field: 'kinds' | 'priorities', key: string) => {
    setViewState((current) => {
      const parsed = parseIssueFilter(current.filter);
      const values = new Set(parsed[field]);
      if (values.has(key)) {
        values.delete(key);
      } else {
        values.add(key);
      }
      return {
        ...current,
        filter: formatIssueFilter({ ...parsed, [field]: [...values] }),
        filterEdited: true,
      };
    });
  }, [setViewState]);

  // Filter issues within repos — three-state aware, plus repo identity,
  // label, and parent matching through one view-wide query.
  const filteredRepos = useMemo(() => {
    return repos
      .map((repo) => {
        let issues = repo.issues;
        if (selectedStatus && selectedStatus !== 'all') {
          issues = issues.filter((issue) => getVisualState(issue) === selectedStatus);
        }
        if (normalizedFilter) {
          const repoMatches = [
            repo.project_key,
            repo.repo_id,
            repo.repo_name,
            repo.repo_root,
            pathBasename(repo.repo_root),
          ].some((value) => value?.toLowerCase().includes(normalizedFilter));
          issues = issues.filter(
            (issue) =>
              repoMatches ||
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
  }, [repos, selectedStatus, normalizedFilter, selectedKinds, selectedPriorities, parentFilter]);

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

  const showRepoLabels = useMemo(() => {
    return new Set(items.map((item) => item.repo.repo_id)).size > 1;
  }, [items]);

  // Total issue count for badge
  const totalOpen = useMemo(
    () => repos.reduce((acc, r) => acc + r.open_count, 0),
    [repos],
  );

  const selectedIssueSummary = useMemo(() => {
    if (!selectedRepoId || !selectedIssueId) return null;
    const repoId = resolveRepoId(selectedRepoId) ?? selectedRepoId;
    const repo = repos.find((candidate) => (
      candidate.repo_id === repoId || candidate.project_key === repoId
    ));
    if (!repo) return null;
    const issueId = resolveIssueId(repoId, selectedIssueId);
    const issue = repo.issues.find((candidate) => (
      candidate.id === issueId ||
      candidate.id.startsWith(issueId) ||
      issueId.startsWith(candidate.id)
    ));
    return issue ? { repo, issue } : null;
  }, [repos, selectedRepoId, selectedIssueId, resolveRepoId, resolveIssueId]);

  const synthesizedLedgerIssueDetail = useMemo(
    () => selectedIssueSummary
      ? synthesizeLedgerIssueDetail(selectedIssueSummary.repo, selectedIssueSummary.issue)
      : null,
    [selectedIssueSummary],
  );

  const visibleLedgerIssueDetail = useMemo(
    () => ledgerDetailMatchesSelection(ledgerIssueDetail, selectedRepoId, selectedIssueId)
      ? ledgerIssueDetail
      : synthesizedLedgerIssueDetail,
    [ledgerIssueDetail, selectedRepoId, selectedIssueId, synthesizedLedgerIssueDetail],
  );
  const issueDetailScrollKey = useMemo(
    () => selectedRepoId && selectedIssueId
      ? issueDetailScrollStorageKey(selectedRepoId, selectedIssueId)
      : null,
    [selectedRepoId, selectedIssueId],
  );
  const getIssueDetailScrollNode = useCallback((): HTMLDivElement | null => {
    const shell = issueDetailScrollRef.current;
    return shell?.querySelector<HTMLDivElement>('.ledger-issue-detail__body') ?? shell;
  }, []);

  useEffect(() => {
    const key = issueDetailScrollKey;
    const node = getIssueDetailScrollNode();
    if (!key || !node) return undefined;

    const save = () => writeIssueDetailScrollOffset(key, node.scrollTop);
    const scheduleSave = () => {
      if (scrollSaveTimerRef.current !== null) window.clearTimeout(scrollSaveTimerRef.current);
      scrollSaveTimerRef.current = window.setTimeout(() => {
        scrollSaveTimerRef.current = null;
        save();
      }, 150);
    };

    node.addEventListener('scroll', scheduleSave, { passive: true });
    return () => {
      node.removeEventListener('scroll', scheduleSave);
      if (scrollSaveTimerRef.current !== null) {
        window.clearTimeout(scrollSaveTimerRef.current);
        scrollSaveTimerRef.current = null;
      }
      save();
    };
  }, [getIssueDetailScrollNode, issueDetailScrollKey, visibleLedgerIssueDetail?.id]);

  useEffect(() => {
    if (!issueDetailScrollKey || !visibleLedgerIssueDetail || initialCommentId) return;
    if (lastRestoredScrollKeyRef.current === issueDetailScrollKey) return;
    if (visibleLedgerIssueDetail.detail_stage === 'initial' && visibleLedgerIssueDetail.timeline_partial) return;
    const savedOffset = readIssueDetailScrollOffset(issueDetailScrollKey);
    if (savedOffset === null) {
      lastRestoredScrollKeyRef.current = issueDetailScrollKey;
      return;
    }
    window.requestAnimationFrame(() => {
      const node = getIssueDetailScrollNode();
      if (!node) return;
      const maxScroll = Math.max(0, node.scrollHeight - node.clientHeight);
      node.scrollTop = Math.min(savedOffset, maxScroll || savedOffset);
      lastRestoredScrollKeyRef.current = issueDetailScrollKey;
    });
  }, [
    initialCommentId,
    getIssueDetailScrollNode,
    issueDetailScrollKey,
    visibleLedgerIssueDetail?.id,
    visibleLedgerIssueDetail?.detail_stage,
    visibleLedgerIssueDetail?.timeline_partial,
    visibleLedgerIssueDetail?.timeline.length,
  ]);

  // Fetch canonical ledger detail when selection changes.
  useEffect(() => {
    if (!selectedIssueId) {
      detailRequestSeqRef.current += 1;
      setLedgerIssueDetail(null);
      setDetailLoading(false);
      setDetailLoadFailed(false);
      return;
    }
    const repoId = selectedRepoId;
    const issueId = selectedIssueId;
    const requestSeq = detailRequestSeqRef.current + 1;
    detailRequestSeqRef.current = requestSeq;
    const persistedKey = detailRequestKey('issue', { repoId, issueId });
    const cachedDetail = getCachedIssueDetail(issueDetailCacheRef.current, repoId, issueId)
      ?? readPersistedDetail<LedgerIssueDetailProjection>('issue-detail', persistedKey);
    const hasCachedDetail = Boolean(cachedDetail && ledgerDetailMatchesSelection(cachedDetail, repoId, issueId));
    if (hasCachedDetail && cachedDetail) {
      setLedgerIssueDetail(cachedDetail);
    }
    setDetailLoading(!hasCachedDetail);
    setDetailLoadFailed(false);
    const initialDetail = hasCachedDetail
      ? null
      : repoId
        ? getLedgerIssueInitialDetailByRef(repoId, issueId)
        : getLedgerIssueInitialDetailByIssueId(issueId);
    const fullDetail = repoId
      ? getLedgerIssueDetailByRef(repoId, issueId)
      : getLedgerIssueDetailByIssueId(issueId);
    if (initialDetail) {
      initialDetail
        .then((detail) => {
          if (detailRequestSeqRef.current !== requestSeq) return;
          setLedgerIssueDetail((current) => (
            shouldAcceptInitialLedgerDetail(current, detail, repoId, issueId) ? detail : current
          ));
        })
        .catch(() => {
          // The full projection fetch below remains authoritative.
        });
    }
    fullDetail
      .then((detail) => {
        if (detailRequestSeqRef.current !== requestSeq) return;
        putCachedIssueDetail(issueDetailCacheRef.current, repoId, issueId, detail);
        writePersistedDetail('issue-detail', persistedKey, detail);
        setLedgerIssueDetail(detail);
      })
      .catch(() => {
        if (detailRequestSeqRef.current === requestSeq && !hasCachedDetail) setDetailLoadFailed(true);
      })
      .finally(() => {
        if (detailRequestSeqRef.current === requestSeq) setDetailLoading(false);
      });
    return () => {
      if (detailRequestSeqRef.current === requestSeq) detailRequestSeqRef.current += 1;
    };
  }, [selectedRepoId, selectedIssueId]);

  const selectIssue = useCallback((repoId: string, issueId: string) => {
    const cachedDetail = getCachedIssueDetail(issueDetailCacheRef.current, repoId, issueId);
    if (cachedDetail && ledgerDetailMatchesSelection(cachedDetail, repoId, issueId)) {
      setLedgerIssueDetail(cachedDetail);
      setDetailLoading(false);
      setDetailLoadFailed(false);
    } else {
      const repo = repos.find((candidate) => candidate.repo_id === repoId);
      const issue = repo?.issues.find((candidate) => candidate.id === issueId);
      if (repo && issue) {
        setLedgerIssueDetail(synthesizeLedgerIssueDetail(repo, issue));
        setDetailLoading(true);
        setDetailLoadFailed(false);
      }
    }
    const nextHash = issueRouteHash(repoId, issueId);
    if (typeof window !== 'undefined' && window.location.hash !== nextHash) {
      window.history.pushState(null, '', nextHash);
      window.dispatchEvent(new PopStateEvent('popstate'));
    }
    setSelectedRepoId(repoId);
    setSelectedIssueId(issueId);
  }, [repos]);

  const issueListNavigation = useSidebarListNavigation({
    items,
    getKey: (item) => `${item.repo.repo_id}:${item.issue.id}`,
    selectedKey: selectedRepoId && selectedIssueId ? `${selectedRepoId}:${selectedIssueId}` : null,
    onSelect: (item) => selectIssue(item.repo.repo_id, item.issue.id),
  });

  const refreshLedgerIssueDetail = useCallback(async () => {
    if (!selectedRepoId || !selectedIssueId) return;
    const requestSeq = detailRequestSeqRef.current + 1;
    detailRequestSeqRef.current = requestSeq;
    setDetailLoadFailed(false);
    try {
      const detail = await getLedgerIssueDetailByRef(selectedRepoId, selectedIssueId);
      if (detailRequestSeqRef.current === requestSeq) {
        putCachedIssueDetail(issueDetailCacheRef.current, selectedRepoId, selectedIssueId, detail);
        writePersistedDetail(
          'issue-detail',
          detailRequestKey('issue', { repoId: selectedRepoId, issueId: selectedIssueId }),
          detail,
        );
        setLedgerIssueDetail(detail);
      }
    } catch {
      if (detailRequestSeqRef.current === requestSeq) setDetailLoadFailed(true);
    }
  }, [selectedRepoId, selectedIssueId]);

  // Live detail refresh: when a ledger:* event (forwarded from the app-level
  // SSE handler as a `ledger:sse` window event) targets the open issue, refetch
  // the detail through a trailing 300 ms debounce. Events for other issues, and
  // unfiltered events with no issue_id, are ignored here — list freshness is
  // handled at the app level.
  useEffect(() => {
    const detailId = visibleLedgerIssueDetail?.id;
    const detailDisplayId = visibleLedgerIssueDetail?.display_id;
    if (!detailId && !detailDisplayId) return undefined;
    let debounceTimer: number | null = null;
    const handleLedgerSse = (event: Event) => {
      const detail = (event as CustomEvent<{ type: string; data?: { issue_id?: unknown } }>).detail;
      const issueId = detail?.data?.issue_id;
      if (typeof issueId !== 'string' || !issueId) return;
      const matches = [detailId, detailDisplayId].some(
        (ref) => Boolean(ref) && (ref === issueId || ref!.startsWith(issueId) || issueId.startsWith(ref!)),
      );
      if (!matches) return;
      if (debounceTimer !== null) window.clearTimeout(debounceTimer);
      debounceTimer = window.setTimeout(() => {
        debounceTimer = null;
        void refreshLedgerIssueDetail();
      }, 300);
    };
    window.addEventListener('ledger:sse', handleLedgerSse);
    return () => {
      if (debounceTimer !== null) window.clearTimeout(debounceTimer);
      window.removeEventListener('ledger:sse', handleLedgerSse);
    };
  }, [visibleLedgerIssueDetail?.id, visibleLedgerIssueDetail?.display_id, refreshLedgerIssueDetail]);

  const handleCloseIssue = useCallback(async () => {
    if (!visibleLedgerIssueDetail || actionInFlight) return;
    setActionInFlight(true);
    try {
      const detail = await patchLedgerIssue(visibleLedgerIssueDetail.id, { status: 'closed' });
      putCachedIssueDetail(issueDetailCacheRef.current, selectedRepoId, selectedIssueId ?? visibleLedgerIssueDetail.display_id, detail);
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
      putCachedIssueDetail(issueDetailCacheRef.current, selectedRepoId, selectedIssueId ?? visibleLedgerIssueDetail.display_id, detail);
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
      putCachedIssueDetail(issueDetailCacheRef.current, selectedRepoId, selectedIssueId ?? visibleLedgerIssueDetail.display_id, detail);
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

  return (
    <div className="issues-view">
      <ViewSidebar
        hidden={sidebarHidden}
        storageKey="sidebar-width:issues"
        defaultWidth={420}
        minWidth={280}
        ariaLabel="Issues"
        className="issues-tree"
        as="div"
        header={
          <>
            <SidebarSearchFilterHeader
              value={filter}
              onValueChange={setIssueFilter}
              placeholder="Filter issues..."
              searchAriaLabel="Filter issues"
              clearAriaLabel="Clear issue filter"
              inputType="text"
              onBlurWithin={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                setFilterMenuOpen(false);
              }
            }}
              filterTrigger={{
                ariaLabel: 'Advanced issue filters',
                title: 'Advanced issue filters',
                open: filterMenuOpen,
                onToggle: () => setFilterMenuOpen((prev) => !prev),
              }}
              panel={filterMenuOpen ? {
                variant: 'popover',
                children: (
                  <>
              <div className="sidebar-search-filter__section sidebar-search-filter__section--header">
                <span>Filters</span>
                <button
                  type="button"
                  className="sidebar-search-filter__clear-action"
                  onClick={() => setIssueFilter(parsedFilter.text)}
                >
                  Clear
                </button>
              </div>
              <div className="sidebar-search-filter__section">
                <span className="sidebar-search-filter__label">Status</span>
                <div className="sidebar-search-filter__options sidebar-search-filter__options--segmented">
                  {(['all', 'open', 'merged', 'closed'] as const).map((status) => (
                    <button
                      key={status}
                      type="button"
                      className={`sidebar-search-filter__option${selectedStatus === status ? ' sidebar-search-filter__option--active' : ''}`}
                      onClick={() => updateStructuredFilter({ status })}
                    >
                      {status}
                    </button>
                  ))}
                </div>
              </div>
              <div className="sidebar-search-filter__section">
                <span className="sidebar-search-filter__label">Kind</span>
                <div className="sidebar-search-filter__options">
                  {KIND_FILTERS.map((kind) => (
                    <button
                      key={kind.key}
                      type="button"
                      className={`sidebar-search-filter__option${selectedKinds.includes(kind.key) ? ' sidebar-search-filter__option--active' : ''}`}
                      onClick={() => toggleMultiFilter('kinds', kind.key)}
                    >
                      {kind.label}
                    </button>
                  ))}
                </div>
              </div>
              <div className="sidebar-search-filter__section">
                <span className="sidebar-search-filter__label">Priority</span>
                <div className="sidebar-search-filter__options">
                  {PRIORITY_FILTERS.map((priority) => (
                    <button
                      key={priority.key}
                      type="button"
                      className={`sidebar-search-filter__option${selectedPriorities.includes(priority.key) ? ' sidebar-search-filter__option--active' : ''}`}
                      onClick={() => toggleMultiFilter('priorities', priority.key)}
                    >
                      {priority.label}
                    </button>
                  ))}
                </div>
              </div>
                  </>
                ),
              } : undefined}
            />

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
          </>
        }
        bodyClassName="issues-tree__body"
      >

        {/* Flat issue list */}
        {items.length === 0 ? (
          <div className="issues-tree__empty">
            {repos.length === 0
              ? 'No repos with issues found.'
              : 'No issues match the current filter.'}
          </div>
        ) : (
          <div className="issues-list">
            {items.map((item, index) => {
              const navigation = issueListNavigation.getItemNavigationProps(item, index);
              return (
                <button
                  key={`${item.repo.repo_id}:${item.issue.id}`}
                  ref={navigation.ref}
                  type="button"
                  tabIndex={navigation.tabIndex}
                  aria-current={navigation['aria-current']}
                  className={`sidebar-list-item issues-item${
                    selectedRepoId === item.repo.repo_id && selectedIssueId === item.issue.id
                      ? ' issues-item--selected'
                      : ''
                  }`}
                  onKeyDown={navigation.onKeyDown}
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
              );
            })}
          </div>
        )}
      </ViewSidebar>

      {/* Right detail panel */}
      <div className="issues-detail">
        {!selectedIssueId ? (
          <div className="issues-detail__empty">
            <p className="text-muted">Select an issue to view details</p>
          </div>
        ) : visibleLedgerIssueDetail ? (
          <div className="issues-detail__content" ref={issueDetailScrollRef}>
            <LedgerIssueDetail
              detail={visibleLedgerIssueDetail}
              hydrating={detailLoading}
              fullLoadFailed={detailLoadFailed}
              actionInFlight={actionInFlight}
              onAddComment={handleAddCommentBody}
              onSetStatus={(status) => status === 'open' ? handleReopenIssue() : handleCloseIssue()}
              onStartAgent={handleStartAgent}
              onOpenEntity={handleOpenLedgerEntity}
              onShowChildren={(detail) => {
                const projectRef = detail.project.project_key ?? detail.project.repo_id;
                if (projectRef) {
                  setIssueFilter(formatIssueFilter({
                    ...parseIssueFilter(filter),
                    text: projectRef,
                  }));
                }
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
