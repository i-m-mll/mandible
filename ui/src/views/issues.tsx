import { pushAppHistory, navigateAppHash } from '../app-history';
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import {
  addLedgerIssueComment,
  getIssueRepos,
  patchLedgerIssue,
  spawnIssueAgent,
  isApiErrorStatus,
  type LedgerIssueDetailActor,
  type LedgerIssueDetailProjection,
} from '../api';
import { ViewSidebar } from '../components/ViewSidebar';
import { VIEW_SIDEBAR_GEOMETRY } from '../view-sidebar-geometry';
import { LedgerIssueDetail, type LedgerIssueCloseResolution } from '../components/ledger/IssueDetail';
import { DetailPaneNotice } from '../components/shared/DetailPaneNotice';
import { SidebarSearchFilterHeader } from '../components/shared/SidebarSearchFilterHeader';
import { readPersistedViewState, usePersistedViewState } from '../hooks/usePersistedViewState';
import { routeHashWithParams, shortRouteId } from '../routing';
import { renderInlineMarkdown } from '../lib/markdown';
import { hashKey } from "@tanstack/preact-query";
import { queryClient } from "../query/client";
import { issueDetailOptions, issueInitialDetailOptions, publishIssueDetail, refreshIssueDetail, detailQueryData } from "../query/details";
import { useProjectionQuery } from "../query/useProjectionQuery";
import { useSidebarListNavigation } from '../hooks/useSidebarListNavigation';
import { useAppShell, useViewActive } from '../app-shell';
import {
  LEDGER_ISSUE_KINDS,
  LEDGER_ISSUE_RESOLUTIONS,
  LEDGER_ISSUE_STATUSES,
  LEDGER_PRIORITIES,
  normalizeLedgerIssueKind,
  normalizeLedgerIssuePriority,
} from '../types/issues';

// --- Types ---

export type IssueSummary = {
  id: string;
  repo_id: string;
  repo_name: string;
  title: string;
  status: (typeof LEDGER_ISSUE_STATUSES)[number];
  kind?: string;
  priority?: string;
  resolution?: (typeof LEDGER_ISSUE_RESOLUTIONS)[number] | null;
  labels: string[];
  author: string;
  created_at: string;
  // Perf (issue e5fc02b): the /api/issues list projection omits description.
  // The body arrives via the two-stage detail fetch on selection; the
  // synthesized instant-paint detail treats an absent description as empty.
  description?: string;
  // Canonical parent-child projection. parent_id is retained only for an
  // unambiguous single-parent compatibility projection; parent_ids preserves
  // multiple active parent_child edges.
  parent_id?: string;
  parent_ids?: string[];
  parent_relationships?: import('../../../src/types.js').GitBugIssue['parent_relationships'];
};

export type IssueRepoSummary = {
  repo_id: string;
  project_key?: string | null;
  repo_name: string;
  repo_root?: string | null;
  open_count: number;
  delivered_count: number;
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

type VisualState = 'open' | 'closed';

function getVisualState(issue: { status: string }): VisualState {
  return issue.status === 'open' ? 'open' : 'closed';
}

const KIND_FILTERS = [
  ...LEDGER_ISSUE_KINDS.map((key) => ({ key, label: key })),
] as const;

const PRIORITY_FILTERS = [
  ...LEDGER_PRIORITIES.map((key) => ({ key, label: key })),
] as const;

type ParsedIssueFilter = {
  text: string;
  status: StatusFilter | null;
  resolution: string | null;
  kinds: string[];
  priorities: string[];
};

function parseIssueFilter(value: string): ParsedIssueFilter {
  const textParts: string[] = [];
  let status: StatusFilter | null = null;
  let resolution: string | null = null;
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
      if (next === 'all' || next === 'open' || next === 'closed') {
        status = next;
      }
      continue;
    }
    if (key === 'resolution') {
      const next = values[0];
      if ((LEDGER_ISSUE_RESOLUTIONS as readonly string[]).includes(next)) resolution = next;
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
    resolution,
    kinds: [...kinds],
    priorities: [...priorities],
  };
}

function formatIssueFilter(parsed: ParsedIssueFilter): string {
  const tokens = [parsed.text.trim()].filter(Boolean);
  if (parsed.status) tokens.push(`status:${parsed.status}`);
  if (parsed.resolution) tokens.push(`resolution:${parsed.resolution}`);
  if (parsed.kinds.length > 0) tokens.push(`kind:${parsed.kinds.join(',')}`);
  if (parsed.priorities.length > 0) tokens.push(`priority:${parsed.priorities.join(',')}`);
  return tokens.join(' ');
}

function canonicalIssueKind(issue: { kind?: string }) {
  return normalizeLedgerIssueKind(issue.kind);
}

function issueHasAnyKind(issue: { kind?: string }, selected: string[]): boolean {
  if (selected.length === 0) return true;
  return selected.some((kind) => canonicalIssueKind(issue) === kind);
}

function issueHasAnyPriority(issue: { priority?: string }, selected: string[]): boolean {
  if (selected.length === 0) return true;
  return selected.some((priority) => normalizeLedgerIssuePriority(issue.priority) === priority);
}

function issueParentIds(issue: IssueSummary): string[] {
  if (Array.isArray(issue.parent_ids)) return issue.parent_ids;
  return issue.parent_id ? [issue.parent_id] : [];
}

function filterIssueReposForView(
  repos: IssueRepoSummary[],
  filter: string,
  parentFilter: string | null,
): IssueRepoSummary[] {
  const parsed = parseIssueFilter(filter);
  const normalizedFilter = parsed.text.trim().toLowerCase();
  return repos
    .map((repo) => {
      let issues = repo.issues;
      if (parsed.status && parsed.status !== 'all') {
        issues = issues.filter((issue) => getVisualState(issue) === parsed.status);
      }
      if (parsed.resolution) {
        issues = issues.filter((issue) => issue.resolution === parsed.resolution);
      }
      if (normalizedFilter) {
        const repoMatches = [
          repo.project_key,
          repo.repo_id,
          repo.repo_name,
          repo.repo_root,
          pathBasename(repo.repo_root),
        ].some((value) => value?.toLowerCase().includes(normalizedFilter));
        issues = issues.filter((issue) => repoMatches
          || issue.title.toLowerCase().includes(normalizedFilter)
          || issue.id.toLowerCase().includes(normalizedFilter));
      }
      if (parsed.kinds.length > 0) {
        issues = issues.filter((issue) => issueHasAnyKind(issue, parsed.kinds));
      }
      if (parsed.priorities.length > 0) {
        issues = issues.filter((issue) => issueHasAnyPriority(issue, parsed.priorities));
      }
      if (parentFilter) {
        issues = issues.filter((issue) => issueParentIds(issue).includes(parentFilter)
          || issue.parent_relationships?.some((parent) => parent.parent_ref === parentFilter));
      }
      return { ...repo, issues };
    })
    .filter((repo) => repo.issues.length > 0);
}

function buildIssueItems(repos: IssueRepoSummary[]): ListItem[] {
  const items = repos.flatMap((repo) => repo.issues.map((issue) => ({ kind: 'issue' as const, issue, repo })));
  items.sort((left, right) => {
    const leftTime = left.issue.created_at ? Date.parse(left.issue.created_at) : 0;
    const rightTime = right.issue.created_at ? Date.parse(right.issue.created_at) : 0;
    return rightTime - leftTime;
  });
  return items;
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
      detail.project.display_name === repoId ||
      detail.project.repo_root === repoId;
    if (!repoMatches) return false;
  }

  const refs = new Set<string>([detail.id, detail.display_id]);
  for (const alias of detail.aliases) {
    if (alias.alias) refs.add(alias.alias);
    if (alias.external_id) refs.add(alias.external_id);
  }
  return [...refs].some((ref) => ref === issueId || ref.startsWith(issueId));
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
  const authorDisplay = issue.author || 'Mandible';
  const author: LedgerIssueDetailActor = {
    id: null,
    type: 'mandible_user',
    display: authorDisplay,
    legacy_display: authorDisplay,
    attribution: null,
  };
  const labels = issue.labels ?? [];
  const kind = canonicalIssueKind(issue);
  const priority = normalizeLedgerIssuePriority(issue.priority);
  const resolution = issue.resolution ?? null;
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
      work_repo_id: null,
      repo_name: repo.repo_name,
      repo_root: repo.repo_root ?? null,
      default_branch: null,
    },
    title: issue.title,
    body: issue.description ?? '',
    status: issue.status,
    worker_status: 'none',
    work_notes: '',
    work_notes_revision: null,
    issue_branches: [],
    dependencies: [],
    dependency_warning: false,
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
    detail_stage: 'initial',
    timeline_partial: true,
  };
}

function issueRouteHash(repoId: string, issueId: string, commentId?: string | null): string {
  return routeHashWithParams(window.location.hash, 'issues', {
    repo: repoId, issue: issueId, comment: commentId ?? null,
  });
}

// --- Flat list item types ---

type ListItem = { kind: 'issue'; issue: IssueSummary; repo: IssueRepoSummary };

// --- Components ---

type StatusFilter = 'all' | (typeof LEDGER_ISSUE_STATUSES)[number];

const DEFAULT_ISSUES_FILTER = 'status:open';
const ISSUES_VIEW_STATE_STORAGE_KEY = 'mandible_issues_view_state:v1';

type IssuesViewState = {
  filter: string;
  filterEdited: boolean;
  filterNotice: string | null;
  parentFilter: string | null;
  selectedRepoId: string | null;
  selectedIssueId: string | null;
};

function migrateIssueFilter(value: string): { filter: string; notice: string | null } {
  const notices: string[] = [];
  const migrated: string[] = [];
  for (const token of value.trim().split(/\s+/).filter(Boolean)) {
    if (/^status:merged$/i.test(token)) {
      migrated.push('status:closed', 'resolution:delivered');
    } else if (/^priority:important$/i.test(token)) {
      migrated.push('priority:high');
    } else if (/^priority:(?:.*,)?unknown(?:,.*)?$/i.test(token)) {
      const priorities = token.slice('priority:'.length).split(',')
        .map((priority) => priority.trim().toLowerCase() === 'unknown' ? 'normal' : priority);
      migrated.push(`priority:${[...new Set(priorities)].join(',')}`);
    } else if (/^priority:user-action-required$/i.test(token)) {
      notices.push('The priority:user-action-required filter is obsolete; choose a canonical priority instead.');
    } else {
      migrated.push(token);
    }
  }
  return {
    filter: migrated.join(' ') || DEFAULT_ISSUES_FILTER,
    notice: notices.length > 0 ? notices.join(' ') : null,
  };
}

function normalizeIssueDefaultFilter(value: string | null | undefined): { filter: string; notice: string | null } {
  return migrateIssueFilter(value?.trim() || DEFAULT_ISSUES_FILTER);
}

function normalizeIssuesViewState(value: unknown, defaults: Readonly<IssuesViewState>): IssuesViewState {
  const stored = value && typeof value === 'object' ? value as Partial<IssuesViewState> : {};
  const editedFilter = stored.filterEdited === true && typeof stored.filter === 'string' ? stored.filter : null;
  const legacyRepoFilter = typeof (stored as Partial<IssuesViewState> & { repoFilter?: unknown }).repoFilter === 'string'
    ? (stored as Partial<IssuesViewState> & { repoFilter: string }).repoFilter.trim()
    : '';
  const storedFilter = editedFilter ?? defaults.filter;
  const migrated = migrateIssueFilter(storedFilter);
  const filter = legacyRepoFilter && !migrated.filter.toLowerCase().includes(legacyRepoFilter.toLowerCase())
    ? `${migrated.filter} ${legacyRepoFilter}`.trim()
    : migrated.filter;
  return {
    filter,
    filterEdited: editedFilter !== null || Boolean(legacyRepoFilter),
    filterNotice: migrated.notice,
    parentFilter: stored.parentFilter === null || typeof stored.parentFilter === 'string'
      ? stored.parentFilter
      : defaults.parentFilter,
    selectedRepoId: typeof stored.selectedRepoId === 'string' && stored.selectedRepoId.trim()
      ? stored.selectedRepoId
      : null,
    selectedIssueId: typeof stored.selectedIssueId === 'string' && stored.selectedIssueId.trim()
      ? stored.selectedIssueId
      : null,
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
  const appShell = useAppShell();
  const normalizedDefaultFilter = useMemo(
    () => normalizeIssueDefaultFilter(defaultFilter),
    [defaultFilter],
  );
  const defaultViewState = useMemo<IssuesViewState>(() => ({
    filter: normalizedDefaultFilter.filter,
    filterEdited: false,
    filterNotice: normalizedDefaultFilter.notice,
    parentFilter: null,
    selectedRepoId: null,
    selectedIssueId: null,
  }), [normalizedDefaultFilter]);
  const [viewState, setViewState] = usePersistedViewState(
    ISSUES_VIEW_STATE_STORAGE_KEY,
    normalizeIssuesViewState,
    defaultViewState,
  );
  const { filter, filterNotice, parentFilter } = viewState;
  const parentFilterLabel = parentFilter
    ? repos.flatMap(repo => repo.issues.flatMap(issue => issue.parent_relationships ?? []))
      .find(parent => parent.parent_id === parentFilter || parent.parent_ref === parentFilter)?.parent_ref
      ?? 'selected issue'
    : '';
  // Local state
  const [selectedRepoId, setSelectedRepoId] = useState<string | null>(
    initialIssueId ? resolveIssueRepoDeepLink(repos, initialRepoId) : viewState.selectedRepoId,
  );
  const [selectedIssueId, setSelectedIssueId] = useState<string | null>(
    initialIssueId ?? viewState.selectedIssueId,
  );
  const [filterMenuOpen, setFilterMenuOpen] = useState(false);
  type SortField = 'created_at';
  const [sortField] = useState<SortField>('created_at');
  const [actionInFlight, setActionInFlight] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const routeKey = JSON.stringify([initialRepoId, initialIssueId]);
  const [appliedRouteKey, setAppliedRouteKey] = useState(routeKey);
  const lastScrolledCommentRef = useRef<string | null>(null);
  const selectedIssueKeyRef = useRef<string | null>(null);
  const selectedIssueGenerationRef = useRef(0);
  const issueDetailScrollRef = useRef<HTMLDivElement>(null);
  const scrollSaveTimerRef = useRef<number | null>(null);
  const lastRestoredScrollKeyRef = useRef<string | null>(null);
  if (appliedRouteKey !== routeKey) {
    setAppliedRouteKey(routeKey);
    const nextRepoId = initialIssueId ? resolveIssueRepoDeepLink(repos, initialRepoId) : viewState.selectedRepoId;
    const nextIssueId = initialIssueId ?? viewState.selectedIssueId;
    if (nextRepoId !== selectedRepoId || nextIssueId !== selectedIssueId) {
      setSelectedRepoId(nextRepoId);
      setSelectedIssueId(nextIssueId);
    }
  }
  const nextSelectedIssueKey = `${selectedRepoId ?? ''}:${selectedIssueId ?? ''}`;
  if (selectedIssueKeyRef.current !== nextSelectedIssueKey) {
    selectedIssueGenerationRef.current += 1;
  }
  selectedIssueKeyRef.current = nextSelectedIssueKey;

  const active = useViewActive();
  const detailOptions = useMemo(() => issueDetailOptions(selectedIssueId, selectedRepoId ?? undefined), [selectedIssueId, selectedRepoId]);
  const fullQuery = useProjectionQuery(detailOptions, active && Boolean(selectedIssueId));
  const fullDetail = useMemo(() => detailQueryData(fullQuery, detailOptions), [fullQuery.data, fullQuery.isError, detailOptions]);
  const identityInvalid = isApiErrorStatus(fullQuery.error, 404) || isApiErrorStatus(fullQuery.error, 409);
  const initialOptions = useMemo(() => issueInitialDetailOptions(selectedIssueId, selectedRepoId ?? undefined), [selectedIssueId, selectedRepoId]);
  const initialQuery = useProjectionQuery(initialOptions, active && Boolean(selectedIssueId) && !fullDetail && !identityInvalid);
  const initialDetail = useMemo(() => detailQueryData(initialQuery, initialOptions), [initialQuery.data, initialQuery.isError, initialOptions]);
  const ledgerIssueDetail = identityInvalid ? null : fullDetail ?? initialDetail ?? null;
  const detailLoading = Boolean(selectedIssueId) && fullQuery.isFetching && !fullDetail;
  const detailLoadFailed = fullQuery.isError;
  const detailError = fullQuery.error?.message ?? null;
  useEffect(() => {
    if (selectedRepoId || !selectedIssueId || !fullDetail || !fullQuery.isFetchedAfterMount
      || !fullQuery.isSuccess || fullQuery.isPlaceholderData || fullQuery.isFetching) return;
    const repo = fullDetail.project.project_key;
    if (!repo) return;
    const canonicalOptions = issueDetailOptions(selectedIssueId, repo);
    if (hashKey(canonicalOptions.queryKey) !== hashKey(detailOptions.queryKey)) queryClient.setQueryData(canonicalOptions.queryKey, fullDetail);
    setSelectedRepoId(repo);
  }, [selectedRepoId, selectedIssueId, fullDetail, detailOptions, fullQuery.isFetchedAfterMount,
    fullQuery.isSuccess, fullQuery.isPlaceholderData, fullQuery.isFetching]);

  useEffect(() => {
    setActionError(null);
    setActionInFlight(false);
  }, [selectedRepoId, selectedIssueId]);

  useEffect(() => {
    setViewState((current) => current.filterEdited
      ? current
      : { ...current, filter: normalizedDefaultFilter.filter, filterNotice: normalizedDefaultFilter.notice });
  }, [normalizedDefaultFilter]);

  const setIssueFilter = useCallback((nextFilter: string) => {
    setViewState((current) => ({
      ...current,
      filter: nextFilter,
      filterEdited: true,
      filterNotice: null,
    }));
  }, [setViewState]);

  const setParentFilter = useCallback((parentFilterValue: string | null) => {
    setViewState((current) => ({ ...current, parentFilter: parentFilterValue }));
  }, [setViewState]);

  const resolveRepoId = useCallback((rawRepoId: string | null | undefined): string | null => {
    return resolveIssueRepoDeepLink(repos, rawRepoId);
  }, [repos]);

  useEffect(() => {
    if (!ledgerIssueDetail || !initialCommentId || ledgerIssueDetail.timeline_partial) return;
    const scrollKey = `${ledgerIssueDetail.id}:${initialCommentId}`;
    if (lastScrolledCommentRef.current === scrollKey) return;
    const comment = Array.from(issueDetailScrollRef.current?.querySelectorAll<HTMLElement>('[id], [data-comment-ordinal]') ?? [])
      .find((node) => node.id === `comment-${initialCommentId}` || node.dataset.commentOrdinal === initialCommentId);
    if (!comment) return;
    lastScrolledCommentRef.current = scrollKey;
    comment.scrollIntoView({ block: 'center' });
  }, [ledgerIssueDetail, initialCommentId]);

  const parsedFilter = useMemo(() => parseIssueFilter(filter), [filter]);
  const selectedStatus = parsedFilter.status;
  const selectedResolution = parsedFilter.resolution;
  const selectedKinds = parsedFilter.kinds;
  const selectedPriorities = parsedFilter.priorities;

  const updateStructuredFilter = useCallback((next: Partial<ParsedIssueFilter>) => {
    setViewState((current) => ({
      ...current,
      filter: formatIssueFilter({ ...parseIssueFilter(current.filter), ...next }),
      filterEdited: true,
      filterNotice: null,
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
        filterNotice: null,
      };
    });
  }, [setViewState]);

  // Filter issues within repos — three-state aware, plus repo identity,
  // label, and parent matching through one view-wide query.
  const filteredRepos = useMemo(() => {
    return filterIssueReposForView(repos, filter, parentFilter);
  }, [repos, filter, parentFilter]);

  // Build flat list items: all issues sorted by created_at descending (newest first)
  const items = useMemo<ListItem[]>(() => {
    return buildIssueItems(filteredRepos);
  }, [filteredRepos, sortField]);

  const showRepoLabels = useMemo(() => {
    return new Set(items.map((item) => item.repo.repo_id)).size > 1;
  }, [items]);

  const selectedIssueSummary = useMemo(() => {
    if (!selectedIssueId) return null;
    const resolved = ledgerDetailMatchesSelection(ledgerIssueDetail, selectedRepoId, selectedIssueId)
      ? ledgerIssueDetail : null;
    const repoId = resolveRepoId(selectedRepoId) ?? resolved?.project.project_key;
    if (!repoId) return null;
    const repo = repos.find((candidate) => (
      candidate.repo_id === repoId || candidate.project_key === repoId
    ));
    if (!repo) return null;
    const issue = repo.issues.find((candidate) => candidate.id === selectedIssueId
      || Boolean(resolved && (candidate.id === resolved.id || candidate.id === resolved.display_id)));
    return issue ? { repo, issue } : null;
  }, [repos, selectedRepoId, selectedIssueId, resolveRepoId, ledgerIssueDetail]);

  const synthesizedLedgerIssueDetail = useMemo(
    () => (!initialIssueId || selectedIssueId !== initialIssueId) && !identityInvalid && selectedIssueSummary
      ? synthesizeLedgerIssueDetail(selectedIssueSummary.repo, selectedIssueSummary.issue)
      : null,
    [initialIssueId, selectedIssueId, identityInvalid, selectedIssueSummary],
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
  const selectIssue = useCallback((repoId: string, issueId: string) => {
    const nextHash = issueRouteHash(repoId, issueId);
    if (typeof window !== 'undefined' && window.location.hash !== nextHash) {
      pushAppHistory(nextHash, null);
      window.dispatchEvent(new PopStateEvent('popstate'));
    }
    setSelectedRepoId(repoId);
    setSelectedIssueId(issueId);
  }, []);

  useEffect(() => {
    if (!selectedRepoId || !selectedIssueId) return;
    setViewState((current) => (
      current.selectedRepoId === selectedRepoId && current.selectedIssueId === selectedIssueId
        ? current
        : { ...current, selectedRepoId, selectedIssueId }
    ));
  }, [selectedIssueId, selectedRepoId, setViewState]);

  useEffect(() => {
    if (!appShell.active || initialIssueId || selectedIssueSummary || items.length === 0) return;
    const first = items[0];
    setSelectedRepoId(first.repo.repo_id);
    setSelectedIssueId(first.issue.id);
  }, [appShell.active, initialIssueId, items, selectedIssueSummary]);

  const issueListNavigation = useSidebarListNavigation({
    items,
    getKey: (item) => `${item.repo.repo_id}:${item.issue.id}`,
    selectedKey: selectedIssueSummary ? `${selectedIssueSummary.repo.repo_id}:${selectedIssueSummary.issue.id}` : null,
    onSelect: (item) => selectIssue(item.repo.repo_id, item.issue.id),
  });

  const handleIssueActionFailure = useCallback(async (
    action: string,
    selectionKey: string,
    selectionGeneration: number,
    error: unknown,
  ) => {
    const isCurrentSelection = () => (
      selectedIssueKeyRef.current === selectionKey &&
      selectedIssueGenerationRef.current === selectionGeneration
    );
    if (!isCurrentSelection()) return;
    const reason = error instanceof Error && error.message ? error.message : 'the server did not confirm the request';
    if (!selectedRepoId || !selectedIssueId) {
      setActionError(`${action} request could not be confirmed: ${reason}. Refresh the issue before retrying.`);
      return;
    }
    try {
      const detail = await refreshIssueDetail(detailOptions);
      if (!isCurrentSelection()) return;
      await publishIssueDetail(detailOptions.queryKey, detail);
      const state = detail.status === 'closed'
        ? `closed as ${detail.resolution ?? 'an unknown resolution'}`
        : 'open';
      setActionError(
        `${action} request could not be confirmed: ${reason}. Authoritative refresh shows this issue is ${state}; refresh before retrying.`,
      );
    } catch {
      if (!isCurrentSelection()) return;
      setActionError(`${action} request could not be confirmed: ${reason}. Refresh the issue before retrying.`);
    }
  }, [selectedRepoId, selectedIssueId, detailOptions]);

  const handleCloseIssue = useCallback(async (resolution?: LedgerIssueCloseResolution) => {
    if (!visibleLedgerIssueDetail || actionInFlight) return;
    if (!resolution) {
      setActionError('Choose delivered, duplicate, or wontfix before closing the issue.');
      return;
    }
    setActionError(null);
    const selectionKey = selectedIssueKeyRef.current ?? '';
    const selectionGeneration = selectedIssueGenerationRef.current;
    setActionInFlight(true);
    try {
      const detail = await patchLedgerIssue(visibleLedgerIssueDetail.id, { status: 'closed', resolution });
      await publishIssueDetail(detailOptions.queryKey, detail);
      if (
        selectedIssueKeyRef.current !== selectionKey ||
        selectedIssueGenerationRef.current !== selectionGeneration
      ) return;
      void onRescan();
    } catch (error) {
      await handleIssueActionFailure(`Close as ${resolution}`, selectionKey, selectionGeneration, error);
    } finally {
      if (
        selectedIssueKeyRef.current === selectionKey &&
        selectedIssueGenerationRef.current === selectionGeneration
      ) setActionInFlight(false);
    }
  }, [visibleLedgerIssueDetail, actionInFlight, onRescan, detailOptions, handleIssueActionFailure]);

  const handleReopenIssue = useCallback(async () => {
    if (!visibleLedgerIssueDetail || actionInFlight) return;
    setActionError(null);
    const selectionKey = selectedIssueKeyRef.current ?? '';
    const selectionGeneration = selectedIssueGenerationRef.current;
    setActionInFlight(true);
    try {
      const detail = await patchLedgerIssue(visibleLedgerIssueDetail.id, { status: 'open', resolution: null });
      await publishIssueDetail(detailOptions.queryKey, detail);
      if (
        selectedIssueKeyRef.current !== selectionKey ||
        selectedIssueGenerationRef.current !== selectionGeneration
      ) return;
      void onRescan();
    } catch (error) {
      await handleIssueActionFailure('Reopen', selectionKey, selectionGeneration, error);
    } finally {
      if (
        selectedIssueKeyRef.current === selectionKey &&
        selectedIssueGenerationRef.current === selectionGeneration
      ) setActionInFlight(false);
    }
  }, [visibleLedgerIssueDetail, actionInFlight, onRescan, detailOptions, handleIssueActionFailure]);

  const handleAddCommentBody = useCallback(async (message: string) => {
    if (!visibleLedgerIssueDetail || !message.trim() || actionInFlight) return;
    const selectionKey = selectedIssueKeyRef.current;
    const selectionGeneration = selectedIssueGenerationRef.current;
    setActionInFlight(true);
    try {
      const detail = await addLedgerIssueComment(visibleLedgerIssueDetail.id, message.trim());
      await publishIssueDetail(detailOptions.queryKey, detail);
    } finally {
      if (selectedIssueKeyRef.current === selectionKey && selectedIssueGenerationRef.current === selectionGeneration) setActionInFlight(false);
    }
  }, [visibleLedgerIssueDetail, actionInFlight, detailOptions]);

  const handleUpdateWorkNotes = useCallback(async (workNotes: string, expectedRevision: string | null) => {
    if (!visibleLedgerIssueDetail || actionInFlight) return;
    const saveSelectionKey = `${selectedRepoId ?? ''}:${selectedIssueId ?? ''}`;
    const saveIssueId = visibleLedgerIssueDetail.id;
    setActionInFlight(true);
    try {
      const payload: Record<string, unknown> = { work_notes: workNotes };
      payload.expected_work_notes_revision = expectedRevision;
      const detail = await patchLedgerIssue(saveIssueId, payload);
      await publishIssueDetail(detailOptions.queryKey, detail);
    } catch (error) {
      if (isApiErrorStatus(error, 409) && selectedIssueKeyRef.current === saveSelectionKey && selectedRepoId && selectedIssueId) {
        try {
          const latest = await refreshIssueDetail(detailOptions);
          if (selectedIssueKeyRef.current === saveSelectionKey) {
            await publishIssueDetail(detailOptions.queryKey, latest);
          }
        } catch {
          // Preserve the original conflict so the editor can explain it.
        }
      }
      throw error;
    } finally {
      if (selectedIssueKeyRef.current === saveSelectionKey) setActionInFlight(false);
    }
  }, [visibleLedgerIssueDetail, actionInFlight, selectedRepoId, selectedIssueId, detailOptions]);

  const handleStartAgent = useCallback(async () => {
    if (!selectedRepoId || !selectedIssueId || actionInFlight) return;
    setActionInFlight(true);
    try {
      const units = visibleLedgerIssueDetail?.work_units.filter(unit => unit.assigned_session_id && ['open', 'committed'].includes(unit.state)) ?? [];
      if (units.length !== 1) throw new Error('Select an exact assigned work unit in Inbox before resuming.');
      const result = await spawnIssueAgent(selectedRepoId, selectedIssueId, units[0]);
      navigateAppHash(`#/console?conversation=${encodeURIComponent(result.conversation_id)}`);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setActionInFlight(false);
    }
  }, [selectedRepoId, selectedIssueId, actionInFlight, visibleLedgerIssueDetail]);

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
      navigateAppHash(`#/sessions?session=${encodeURIComponent(id.replace(/^session:/, ''))}`);
      return;
    }
    if (type === 'conversation') {
      navigateAppHash(`#/history?session=${encodeURIComponent(id.replace(/^session:/, ''))}`);
      return;
    }
    if (type === 'auth_request') {
      // Issue f59b5bd — emit the short form; the auth view resolves prefixes.
      navigateAppHash(`#/auth?request=${encodeURIComponent(shortRouteId(id.replace(/^auth_request:/, '')))}`);
    }
  }, [selectedRepoId, selectIssue]);

  return (
    <div className="issues-view">
      <ViewSidebar
        hidden={sidebarHidden}
        {...VIEW_SIDEBAR_GEOMETRY.issues}
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
                id: 'issue-filter-panel',
                variant: 'popover',
                ariaLabel: 'Issue filter controls',
                onDismiss: () => setFilterMenuOpen(false),
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
                  {(['all', ...LEDGER_ISSUE_STATUSES] as const).map((status) => (
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
                <span className="sidebar-search-filter__label">Resolution</span>
                <div className="sidebar-search-filter__options sidebar-search-filter__options--segmented">
                  {(['all', ...LEDGER_ISSUE_RESOLUTIONS] as const).map((resolution) => (
                    <button
                      key={resolution}
                      type="button"
                      className={`sidebar-search-filter__option${(resolution === 'all' ? selectedResolution === null : selectedResolution === resolution) ? ' sidebar-search-filter__option--active' : ''}`}
                      onClick={() => updateStructuredFilter({ resolution: resolution === 'all' ? null : resolution })}
                    >
                      {resolution}
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
              Children of {parentFilterLabel}
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

        {filterNotice && (
          <div className="issues-filter-notice" role="status">
            {filterNotice}
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
                    selectedIssueSummary?.repo.repo_id === item.repo.repo_id && selectedIssueSummary.issue.id === item.issue.id
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
            <p className="text-muted">No issues in this view</p>
          </div>
        ) : visibleLedgerIssueDetail ? (
          <div className="issues-detail__content" ref={issueDetailScrollRef}>
            {detailError && <DetailPaneNotice severity="error" title="Issue could not be refreshed">{detailError}</DetailPaneNotice>}
            {actionError ? (
              <DetailPaneNotice
                severity="error"
                density="compact"
                title="Issue action could not be completed"
                source="issues:close"
              >
                {actionError}
              </DetailPaneNotice>
            ) : null}
            <LedgerIssueDetail
              detail={visibleLedgerIssueDetail}
              hydrating={detailLoading}
              fullLoadFailed={detailLoadFailed}
              actionInFlight={actionInFlight}
              onAddComment={handleAddCommentBody}
              onUpdateWorkNotes={handleUpdateWorkNotes}
              onSetStatus={(status, resolution) => status === 'open' ? handleReopenIssue() : handleCloseIssue(resolution)}
              onStartAgent={handleStartAgent}
              onOpenEntity={handleOpenLedgerEntity}
              onShowChildren={(detail) => {
                setIssueFilter(formatIssueFilter({ ...parseIssueFilter(filter), text: '' }));
                setParentFilter(detail.id);
              }}
            />
          </div>
        ) : detailLoading ? (
          <div className="issues-detail__empty">
            <p className="text-muted">Loading...</p>
          </div>
        ) : (
          <div className="issues-detail__empty">
            <p className="text-muted">{detailError ?? 'Failed to load issue detail.'}</p>
          </div>
        )}
      </div>
    </div>
  );
}

type IssueWarmupContext = { settings?: Record<string, string> };

export async function warmInitialData(
  params: Record<string, string>,
  context: IssueWarmupContext = {},
): Promise<void> {
  const repos = await getIssueRepos<IssueRepoSummary>();
  const normalizedDefaultFilter = normalizeIssueDefaultFilter(context.settings?.['issues.default_filter']);
  const defaults: IssuesViewState = {
    filter: normalizedDefaultFilter.filter,
    filterEdited: false,
    filterNotice: normalizedDefaultFilter.notice,
    parentFilter: null,
    selectedRepoId: null,
    selectedIssueId: null,
  };
  const viewState = readPersistedViewState(
    ISSUES_VIEW_STATE_STORAGE_KEY,
    normalizeIssuesViewState,
    defaults,
  );

  let repoId = params.issue && !params.repo ? null : params.repo ?? viewState.selectedRepoId;
  let issueId = params.issue ?? viewState.selectedIssueId;
  if (issueId && repoId) {
    repoId = resolveIssueRepoDeepLink(repos, repoId) ?? repoId;
  } else if (!issueId) {
    const first = buildIssueItems(filterIssueReposForView(repos, viewState.filter, viewState.parentFilter))[0];
    if (first) {
      repoId = first.repo.repo_id;
      issueId = first.issue.id;
    }
  }
  if (!issueId) return;

  await queryClient.fetchQuery(issueDetailOptions(issueId, repoId ?? undefined));
}
