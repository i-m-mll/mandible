import { Fragment, type ComponentChildren } from 'preact';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';

import { getProjectTimeline, getWorkRepos } from '../api';
import {
  AppOperationalNoticeOutlet,
  useAppShell,
  useRegisterAppRightSidebar,
  useLiveLoad,
} from '../app-shell';
import { useAppRightSidebarState } from '../right-sidebar-state';
import { refreshAbandoned } from '../lib/coalesced-refresh';
import { ViewSidebar } from '../components/ViewSidebar';
import { DetailPaneNotice } from '../components/shared/DetailPaneNotice';
import { PreviewIcon } from '../components/icons/TabIcons';
import { VIEW_SIDEBAR_GEOMETRY } from '../view-sidebar-geometry';
import { LedgerRenderedBody } from '../components/ledger/LedgerRenderedBody';
import { AttributionIdentity } from '../components/shared/DetailHeaderIdentity';
import { readPersistedViewState, usePersistedViewState } from '../hooks/usePersistedViewState';
import type { WorkRepo } from './work';
import {
  TIMELINE_DAY_MS,
  TIMELINE_HOUR_MS,
  clampTimelineViewport,
  editTimelineViewportDateBoundary,
  fitTimelineViewport,
  formatUtcDate,
  formatUtcDateTime,
  generateTimelineTicks,
  paddedTimelineRenderDomain,
  timelineExtentFromTimestamps,
  timelineScrollMetrics,
  viewportFromTimelineScroll,
  zoomTimelineViewport,
  type TimelineRenderDomain,
  type TimelineViewport,
} from './timeline-time';
import {
  buildTimelineLayout,
  type TimelineAggregateMark,
  type TimelineDensityMode,
  type TimelineEventMark,
  type TimelineLaneCache,
  type TimelineRangeCluster,
  type TimelineSameTimeCluster,
} from './timeline-layout';
import {
  DEFAULT_TIMELINE_VIEW_STATE,
  type ProjectTimelineInput,
  type ProjectTimelineProjection,
  type TimelineDensity,
  type TimelineEvent,
  type TimelineEventKind,
  type TimelineFilterChip,
  type TimelineFilterRowSpec,
  type TimelineIssueRef,
  type TimelineLink,
  type TimelineRootPolicy,
  type TimelineRowOccurrence,
  type TimelineRowSpecInput,
  type TimelineViewState,
} from '../types/timeline';
import {
  isFilterField,
  parseFilterToken,
  rowSpecFromChips,
} from './filters/issue-predicate-filter';
import { IssuePredicateFilter } from './filters/IssuePredicateFilter';
import { beginDetailRequest, detailRequestKey, isPersistedDetailFresh, readPersistedDetail, writePersistedDetail } from '../detail-cache';
import { LoadingSkeleton } from '../components/LoadingSkeleton';

const STORAGE_PREFIX = 'mandible_timeline_view_state:v1';
const EVENT_TYPES: TimelineEventKind[] = ['body', 'comment', 'state'];
const DENSITIES: TimelineDensity[] = ['compact', 'comfortable', 'expanded'];
const FALLBACK_TIMELINE_WIDTH_PX = 820;
const MIN_TIMELINE_WINDOW_MS = TIMELINE_HOUR_MS;
const MIN_INSPECTOR_WIDTH = 280;
const MAX_INSPECTOR_WIDTH = 560;
const MIN_ROW_LIST_WIDTH = 220;
const MAX_ROW_LIST_WIDTH = 520;
const MIN_TIMELINE_EDGE_BREATHING_PX = 16;
const MAX_TIMELINE_EDGE_BREATHING_PX = 32;
const TIMELINE_EDGE_BREATHING_RATIO = 0.03;
const TIMELINE_TICK_SPACING_PX = 120;
const WHEEL_ZOOM_IN_FACTOR = 0.9;
const WHEEL_ZOOM_OUT_FACTOR = 1 / WHEEL_ZOOM_IN_FACTOR;
const MAX_TIMELINE_PROJECTION_DEPTH = 8;
const TIMELINE_LAYOUT_METRICS: Record<TimelineDensityMode, {
  laneHeightPx: number;
  eventHeightPx: number;
  markWidthPx: number;
  rowMinHeightPx: number;
}> = {
  compact: { laneHeightPx: 36, eventHeightPx: 30, markWidthPx: 34, rowMinHeightPx: 54 },
  comfortable: { laneHeightPx: 54, eventHeightPx: 46, markWidthPx: 170, rowMinHeightPx: 82 },
  expanded: { laneHeightPx: 82, eventHeightPx: 74, markWidthPx: 240, rowMinHeightPx: 122 },
};
const TIMELINE_ROW_PADDING_Y_PX = 8;
const EMPTY_TIMELINE_EVENTS: TimelineEvent[] = [];
const EMPTY_TIMELINE_LINKS: TimelineLink[] = [];
const EMPTY_TIMELINE_ROWS: TimelineRowOccurrence[] = [];
const FILTER_ROW_URL_PARAM = 'rows';

export type TimelineViewProps = {
  repos: WorkRepo[];
  refreshToken?: number;
  params?: Record<string, string | undefined>;
  sidebarHidden?: boolean;
};

export function TimelineInspectorFrame({ children }: { children: ComponentChildren }): JSX.Element {
  return (
    <section className="timeline-inspector">
      {children}
    </section>
  );
}

type ProjectionStatus = 'loading' | 'syncing' | 'ready' | 'error';
type TimelineSelectionStatus = 'empty' | 'present' | 'stale';

type TimelineUrlState = Partial<TimelineViewState> & {
  projectRef?: string;
};

type PartialTimelinePanes = Partial<TimelineViewState['panes']>;

function storageKey(projectId: string): string {
  return `${STORAGE_PREFIX}:${projectId}`;
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function parseCsv(value: string | undefined): string[] {
  return unique((value || '').split(','));
}

function serializeCsv(values: string[]): string {
  return unique(values).join(',');
}

function safeNumber(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function coerceDensity(value: string | undefined): TimelineDensity | undefined {
  return value && DENSITIES.includes(value as TimelineDensity)
    ? value as TimelineDensity
    : undefined;
}

function coerceRootPolicy(value: string | undefined): TimelineRootPolicy | undefined {
  if (
    value === 'coordination'
    || value === 'explicit'
    || value === 'coordination_and_explicit'
  ) {
    return value;
  }
  return undefined;
}

function parseBool(value: string | undefined): boolean | undefined {
  if (value === '1' || value === 'true') return true;
  if (value === '0' || value === 'false') return false;
  return undefined;
}

// Chip/predicate logic now lives in the shared filter module
// (`./filters/issue-predicate-filter`) so the Timeline and the Spaces seed
// dialog build identical predicate ASTs; see the imports at the top of file.

function parseFilterRows(value: string | undefined): TimelineFilterRowSpec[] | undefined {
  if (!value) return undefined;
  try {
    let parsed: Array<{ id?: unknown; chips?: unknown }>;
    try {
      parsed = JSON.parse(value) as Array<{ id?: unknown; chips?: unknown }>;
    } catch {
      parsed = JSON.parse(decodeURIComponent(value)) as Array<{ id?: unknown; chips?: unknown }>;
    }
    if (!Array.isArray(parsed)) return undefined;
    const rows: TimelineFilterRowSpec[] = [];
    for (const item of parsed) {
      if (!item || typeof item !== 'object' || !Array.isArray(item.chips)) continue;
      const chips = item.chips
        .map((chip) => {
          if (!chip || typeof chip !== 'object') return null;
          const field = String((chip as TimelineFilterChip).field ?? '');
          if (!isFilterField(field)) return null;
          const values = Array.isArray((chip as TimelineFilterChip).values)
            ? (chip as TimelineFilterChip).values.map(String)
            : [];
          return { field, values, negated: (chip as TimelineFilterChip).negated === true };
        })
        .filter((chip): chip is TimelineFilterChip => Boolean(chip));
      const row = rowSpecFromChips(chips, rows, typeof item.id === 'string' ? item.id : undefined);
      if (row) rows.push(row);
    }
    return rows;
  } catch {
    return undefined;
  }
}

function serializeFilterRows(rows: readonly TimelineFilterRowSpec[]): string {
  if (rows.length === 0) return '';
  return JSON.stringify(rows.map((row) => ({
    id: row.id,
    chips: row.chips,
  })));
}

function parseUrlState(params: Record<string, string | undefined>): TimelineUrlState {
  const eventTypes = parseCsv(params.types).filter((type): type is TimelineEventKind => (
    EVENT_TYPES.includes(type as TimelineEventKind)
  ));
  const from = safeNumber(params.from);
  const to = safeNumber(params.to);
  const filterRows = parseFilterRows(params[FILTER_ROW_URL_PARAM]);
  return {
    projectRef: params.project,
    rootPolicy: coerceRootPolicy(params.root_policy),
    explicitRootIssueIds: parseCsv(params.roots),
    promotedRootIssueIds: parseCsv(params.promoted),
    expandedEventIds: parseCsv(params.expanded),
    expandedPaths: parseCsv(params.paths),
    selectedRowOccurrenceId: params.row || undefined,
    selectedEventId: params.event || undefined,
    selectedClusterId: undefined,
    timeWindow: from !== null || to !== null ? { from, to } : undefined,
    density: coerceDensity(params.density),
    visibleEventTypes: eventTypes.length > 0 ? eventTypes : undefined,
    includeClosed: parseBool(params.closed),
    filterRows,
    panes: params.inspector
      ? { ...DEFAULT_TIMELINE_VIEW_STATE.panes, inspector: parseBool(params.inspector) ?? true }
      : undefined,
  };
}

function timelineEdgePaddingPx(markWidthPx: number, viewportWidthPx: number): number {
  const breathingPx = Math.min(
    MAX_TIMELINE_EDGE_BREATHING_PX,
    Math.max(MIN_TIMELINE_EDGE_BREATHING_PX, viewportWidthPx * TIMELINE_EDGE_BREATHING_RATIO),
  );
  return Math.ceil(markWidthPx / 2 + breathingPx);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function approximatelyEqualTimestamp(left: number, right: number): boolean {
  return Math.abs(left - right) <= 1;
}

function normalizeInspectorWidth(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? clamp(value, MIN_INSPECTOR_WIDTH, MAX_INSPECTOR_WIDTH)
    : DEFAULT_TIMELINE_VIEW_STATE.panes.inspectorWidth;
}

function normalizeRowListWidth(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? clamp(value, MIN_ROW_LIST_WIDTH, MAX_ROW_LIST_WIDTH)
    : DEFAULT_TIMELINE_VIEW_STATE.panes.rowListWidth;
}

function mergePanes(
  base: TimelineViewState['panes'],
  local?: PartialTimelinePanes,
  url?: PartialTimelinePanes,
): TimelineViewState['panes'] {
  const merged = {
    ...DEFAULT_TIMELINE_VIEW_STATE.panes,
    ...base,
    ...(local ?? {}),
    ...(url ?? {}),
  };
  return {
    inspector: merged.inspector !== false,
    inspectorWidth: normalizeInspectorWidth(merged.inspectorWidth),
    diagnostics: merged.diagnostics === true,
    rowList: merged.rowList !== false,
    rowListWidth: normalizeRowListWidth(merged.rowListWidth),
  };
}

function mergeTimelineState(
  base: TimelineViewState,
  local: Partial<TimelineViewState>,
  url: TimelineUrlState,
): TimelineViewState {
  const merged: TimelineViewState = {
    ...base,
    ...local,
    explicitRootIssueIds: url.explicitRootIssueIds?.length ? url.explicitRootIssueIds : local.explicitRootIssueIds ?? base.explicitRootIssueIds,
    promotedRootIssueIds: url.promotedRootIssueIds?.length ? url.promotedRootIssueIds : local.promotedRootIssueIds ?? base.promotedRootIssueIds,
    expandedEventIds: url.expandedEventIds?.length ? url.expandedEventIds : local.expandedEventIds ?? base.expandedEventIds,
    expandedPaths: url.expandedPaths?.length ? url.expandedPaths : local.expandedPaths ?? base.expandedPaths,
    visibleEventTypes: url.visibleEventTypes?.length ? url.visibleEventTypes : local.visibleEventTypes ?? base.visibleEventTypes,
    filterRows: url.filterRows ?? local.filterRows ?? base.filterRows,
    timeWindow: url.timeWindow ?? local.timeWindow ?? base.timeWindow,
    panes: mergePanes(base.panes, local.panes, url.panes),
  };
  if (url.rootPolicy !== undefined) merged.rootPolicy = url.rootPolicy;
  if (url.selectedRowOccurrenceId !== undefined) merged.selectedRowOccurrenceId = url.selectedRowOccurrenceId;
  if (url.selectedEventId !== undefined) merged.selectedEventId = url.selectedEventId;
  if (url.density !== undefined) merged.density = url.density;
  if (url.includeClosed !== undefined) merged.includeClosed = url.includeClosed;
  return merged;
}

function clearTimelineSelection(state: TimelineViewState): TimelineViewState {
  return {
    ...state,
    selectedRowOccurrenceId: null,
    selectedEventId: null,
    selectedClusterId: null,
  };
}

function timelineSelectionStatus(state: TimelineViewState): TimelineSelectionStatus {
  return state.selectedEventId || state.selectedRowOccurrenceId || state.selectedClusterId
    ? 'stale'
    : 'empty';
}

function projectionDepthForExpandedEvents(
  projection: ProjectTimelineProjection | null,
  expandedEventIds: readonly string[],
): number {
  if (expandedEventIds.length === 0) return 1;
  if (!projection) return MAX_TIMELINE_PROJECTION_DEPTH;
  const rowById = new Map(projection.rows.map((row) => [row.id, row]));
  const eventById = new Map(projection.events.map((event) => [event.id, event]));
  let depth = 1;
  for (const eventId of expandedEventIds) {
    const event = eventById.get(eventId);
    const row = event ? rowById.get(event.row_id) : null;
    if (!row) return MAX_TIMELINE_PROJECTION_DEPTH;
    depth = Math.max(depth, row.depth + 1);
  }
  return Math.min(MAX_TIMELINE_PROJECTION_DEPTH, Math.max(1, depth));
}

function normalizeStringArray(value: unknown, fallback: readonly string[]): string[] {
  if (!Array.isArray(value)) return [...fallback];
  return unique(value.filter((item): item is string => typeof item === 'string'));
}

function normalizeNullableString(value: unknown, fallback: string | null): string | null {
  return value === null || typeof value === 'string' ? value : fallback;
}

function normalizeTimelineViewState(
  value: unknown,
  defaults: Readonly<TimelineViewState>,
): TimelineViewState {
  const stored = value && typeof value === 'object'
    ? value as Partial<TimelineViewState>
    : {};
  const storedWindow = stored.timeWindow && typeof stored.timeWindow === 'object'
    ? stored.timeWindow
    : defaults.timeWindow;
  const storedFilterRows = Array.isArray(stored.filterRows)
    ? parseFilterRows(JSON.stringify(stored.filterRows)) ?? [...defaults.filterRows]
    : [...defaults.filterRows];
  const visibleEventTypes = normalizeStringArray(
    stored.visibleEventTypes,
    defaults.visibleEventTypes,
  ).filter((eventType): eventType is TimelineEventKind => (
    EVENT_TYPES.includes(eventType as TimelineEventKind)
  ));
  const storedAllEventTypesHidden = Array.isArray(stored.visibleEventTypes)
    && stored.visibleEventTypes.length === 0;

  return {
    rootPolicy: stored.rootPolicy === 'coordination'
      || stored.rootPolicy === 'explicit'
      || stored.rootPolicy === 'coordination_and_explicit'
      ? stored.rootPolicy
      : defaults.rootPolicy,
    explicitRootIssueIds: normalizeStringArray(
      stored.explicitRootIssueIds,
      defaults.explicitRootIssueIds,
    ),
    promotedRootIssueIds: normalizeStringArray(
      stored.promotedRootIssueIds,
      defaults.promotedRootIssueIds,
    ),
    expandedEventIds: normalizeStringArray(stored.expandedEventIds, defaults.expandedEventIds),
    expandedPaths: normalizeStringArray(stored.expandedPaths, defaults.expandedPaths),
    selectedRowOccurrenceId: normalizeNullableString(
      stored.selectedRowOccurrenceId,
      defaults.selectedRowOccurrenceId,
    ),
    selectedEventId: normalizeNullableString(stored.selectedEventId, defaults.selectedEventId),
    selectedClusterId: normalizeNullableString(stored.selectedClusterId, defaults.selectedClusterId),
    timeWindow: {
      from: typeof storedWindow.from === 'number' && Number.isFinite(storedWindow.from)
        ? storedWindow.from
        : null,
      to: typeof storedWindow.to === 'number' && Number.isFinite(storedWindow.to)
        ? storedWindow.to
        : null,
    },
    density: DENSITIES.includes(stored.density as TimelineDensity)
      ? stored.density as TimelineDensity
      : defaults.density,
    visibleEventTypes: storedAllEventTypesHidden
      ? []
      : visibleEventTypes.length > 0
        ? visibleEventTypes
        : [...defaults.visibleEventTypes],
    includeClosed: typeof stored.includeClosed === 'boolean'
      ? stored.includeClosed
      : defaults.includeClosed,
    filterRows: storedFilterRows,
    panes: mergePanes(defaults.panes, stored.panes),
  };
}

/** Keep the historical route-ref and canonical-project-id aliases coherent. */
function writeTimelineProjectStorageAliases(
  projectRefs: readonly string[],
  state: TimelineViewState,
): void {
  if (typeof window === 'undefined') return;
  try {
    const serialized = JSON.stringify(state);
    unique([...projectRefs]).forEach((projectRef) => {
      if (projectRef) window.localStorage.setItem(storageKey(projectRef), serialized);
    });
  } catch {
    return;
  }
}

function syncFilterRowsToHash(projectRef: string, filterRows: readonly TimelineFilterRowSpec[]): void {
  if (typeof window === 'undefined') return;
  const hash = window.location.hash || '#/timeline';
  const [, queryPart] = hash.replace(/^#/, '').split('?');
  const params = new URLSearchParams(queryPart ?? '');
  if (projectRef) params.set('project', projectRef);
  const serializedRows = serializeFilterRows(filterRows);
  if (serializedRows) {
    params.set(FILTER_ROW_URL_PARAM, serializedRows);
  } else {
    params.delete(FILTER_ROW_URL_PARAM);
  }
  const nextHash = `#/timeline${params.toString() ? `?${params.toString()}` : ''}`;
  if (window.location.hash !== nextHash) {
    window.location.hash = nextHash;
  }
}

function projectionRowSpecFromFilterRow(row: TimelineFilterRowSpec): TimelineRowSpecInput {
  return {
    id: row.id,
    title: row.title,
    anchor_issue_id: null,
    scope: row.scope,
  };
}

function buildProjectTimelineRequest(
  projectRef: string,
  state: TimelineViewState,
  projection: ProjectTimelineProjection | null,
): ProjectTimelineInput {
  return {
    project_ref: projectRef,
    root_policy: state.rootPolicy,
    explicit_root_issue_ids: state.explicitRootIssueIds,
    promoted_root_issue_ids: state.promotedRootIssueIds,
    expanded_event_ids: state.expandedEventIds,
    expanded_paths: state.expandedPaths.filter((path) => !isLocalFilterPath(path)),
    include_closed: state.includeClosed,
    event_kinds: state.visibleEventTypes,
    depth: projectionDepthForExpandedEvents(projection, state.expandedEventIds),
    root_specs: state.filterRows.map(projectionRowSpecFromFilterRow),
  };
}

export async function warmInitialData(params: Record<string, string>): Promise<void> {
  const detailStarted = beginDetailRequest();
  const repos = await getWorkRepos<WorkRepo>();
  const urlState = parseUrlState(params);
  const projectRef = defaultProjectRef(repos, urlState.projectRef);
  const persistedState = readPersistedViewState(
    storageKey(projectRef),
    normalizeTimelineViewState,
    DEFAULT_TIMELINE_VIEW_STATE,
  );
  const viewState = mergeTimelineState(persistedState, {}, urlState);
  const request = buildProjectTimelineRequest(projectRef, viewState, null);
  const requestKey = detailRequestKey('timeline', request);
  if (readPersistedDetail<ProjectTimelineProjection>('timeline', requestKey)) return;
  const projection = await getProjectTimeline(request);
  writePersistedDetail('timeline', requestKey, projection, undefined, detailStarted);
}

function projectedFilterRowId(row: TimelineFilterRowSpec, rows: readonly TimelineFilterRowSpec[]): string {
  const index = rows.findIndex((candidate) => candidate.id === row.id);
  return `row:spec:${row.id}:${Math.max(0, index)}`;
}

function projectedResidualRowId(rows: readonly TimelineFilterRowSpec[]): string {
  return `row:spec:residual:${rows.length}`;
}

function isProjectedFilterPath(path: string, rows: readonly TimelineFilterRowSpec[]): boolean {
  return rows.some((row) => projectedFilterRowId(row, rows) === path);
}

function isProjectedResidualPath(path: string, rows: readonly TimelineFilterRowSpec[]): boolean {
  return path === projectedResidualRowId(rows);
}

function isFilterViewPath(path: string, rows: readonly TimelineFilterRowSpec[]): boolean {
  return isLocalFilterPath(path) || isProjectedFilterPath(path, rows) || isProjectedResidualPath(path, rows);
}

function rebuildFilterExpandedPaths(
  currentPaths: readonly string[],
  currentRows: readonly TimelineFilterRowSpec[],
  nextRows: readonly TimelineFilterRowSpec[],
  options: { forceExpandedSpecId?: string } = {},
): string[] {
  const expandedSpecIds = new Set<string>();
  for (const row of currentRows) {
    if (
      currentPaths.includes(`row:local-filter:${row.id}`)
      || currentPaths.includes(projectedFilterRowId(row, currentRows))
    ) {
      expandedSpecIds.add(row.id);
    }
  }
  if (options.forceExpandedSpecId) expandedSpecIds.add(options.forceExpandedSpecId);
  const residualExpanded = currentPaths.includes('row:local-filter:residual')
    || currentPaths.includes(projectedResidualRowId(currentRows));
  const preserved = currentPaths.filter((path) => !isFilterViewPath(path, currentRows));
  const nextFilterPaths = nextRows
    .filter((row) => expandedSpecIds.has(row.id))
    .map((row) => projectedFilterRowId(row, nextRows));
  return unique([
    ...preserved,
    ...nextFilterPaths,
    ...(residualExpanded ? [projectedResidualRowId(nextRows)] : []),
  ]);
}

function repoId(repo: WorkRepo): string {
  return repo.id || repo.name || '';
}

function repoTitle(repo: WorkRepo): string {
  return repo.name || repo.id || repo.root || repo.path || 'Project';
}

function defaultProjectRef(repos: WorkRepo[], explicit?: string): string {
  if (explicit) return explicit;
  const current = repos.find((repo) => repo.id === 'mandible' || repo.name === 'mandible');
  return repoId(current ?? repos[0] ?? { id: 'mandible' });
}

function formatDate(value: number | null | undefined): string {
  return formatUtcDate(value) || 'Open';
}

function formatDateTime(value: number | null | undefined): string {
  return formatUtcDateTime(value) || 'Open';
}

function dateInputValue(value: number | null): string {
  return formatUtcDate(value);
}

function eventLeft(timestamp: number, start: number, span: number): number {
  return Math.max(0, Math.min(100, ((timestamp - start) / span) * 100));
}

function eventLeftPx(timestamp: number, start: number, span: number, widthPx: number): number {
  return Math.max(0, Math.min(widthPx, ((timestamp - start) / span) * widthPx));
}

function markLaneTopPx(mark: { lane: number }, laneHeightPx: number): number {
  return TIMELINE_ROW_PADDING_Y_PX + mark.lane * laneHeightPx + laneHeightPx / 2;
}

function rangeClusterMinCountForDensity(density: TimelineDensityMode): number {
  return density === 'compact' ? 3 : density === 'comfortable' ? 4 : 5;
}

function eventKindLabel(kind: TimelineEventKind): string {
  return kind === 'body' ? 'Body' : kind === 'comment' ? 'Comment' : 'State';
}

function shortIssueId(displayId: string): string {
  return displayId.length > 12 ? displayId.slice(0, 7) : displayId;
}

function eventEyebrow(event: TimelineEvent): string {
  return `${eventKindLabel(event.kind)} ${shortIssueId(event.issue.display_id)} #${event.ordinal}`;
}

type TimelineClusterMark = TimelineSameTimeCluster | TimelineRangeCluster;

function clusterKindLabel(cluster: TimelineClusterMark): string {
  return cluster.kind === 'same_time_cluster' ? 'Same-time cluster' : 'Range cluster';
}

function clusterCategorySummaryLabel(summary: Record<string, number>): string {
  const entries = Object.entries(summary).sort(([left], [right]) => left.localeCompare(right));
  return entries.length > 0
    ? entries.map(([category, count]) => `${eventKindLabel(category as TimelineEventKind)} ${count}`).join(', ')
    : 'Event 0';
}

function clusterTimeLabel(cluster: TimelineClusterMark): string {
  if (cluster.kind === 'same_time_cluster') {
    return `at ${formatDateTime(cluster.timestamp)}`;
  }
  return `from ${formatDateTime(cluster.minTime)} to ${formatDateTime(cluster.maxTime)}`;
}

function clusterAccessibleLabel(cluster: TimelineClusterMark, selectedClusterId: string | null): string {
  return [
    clusterKindLabel(cluster),
    `${cluster.count} ${cluster.count === 1 ? 'event' : 'events'}`,
    clusterCategorySummaryLabel(cluster.categorySummary),
    clusterTimeLabel(cluster),
    cluster.containsSelected ? 'contains selected child event' : '',
    selectedClusterId === cluster.id ? 'selected cluster' : '',
  ].filter(Boolean).join(', ');
}

function rowKindLabel(kind: TimelineRowOccurrence['kind']): string {
  if (kind === 'promoted_root') return 'Promoted root';
  if (kind === 'explicit_root') return 'Explicit root';
  if (kind === 'transient') return 'Transient';
  if (kind === 'member') return 'Member';
  return 'Root';
}

function viewportFromState(
  domain: TimelineRenderDomain,
  state: TimelineViewState,
  _options: { edgePaddingPx: number; viewportWidthPx: number },
): TimelineViewport {
  const fit = fitTimelineViewport(domain);
  if (state.timeWindow.from === null && state.timeWindow.to === null) {
    return fit;
  }
  const requested = {
    from: state.timeWindow.from ?? fit.from,
    to: state.timeWindow.to ?? fit.to,
  };
  const isLegacyRawExtentFit = (
    domain.extent.eventCount > 0
    && state.timeWindow.from !== null
    && state.timeWindow.to !== null
    && approximatelyEqualTimestamp(Math.min(state.timeWindow.from, state.timeWindow.to), domain.extent.start)
    && approximatelyEqualTimestamp(Math.max(state.timeWindow.from, state.timeWindow.to), domain.extent.end)
  );
  if (isLegacyRawExtentFit) return fit;
  return clampTimelineViewport(
    requested,
    domain,
    { minSpanMs: MIN_TIMELINE_WINDOW_MS },
  );
}

function timelineDiagnostics(projection: ProjectTimelineProjection | null): TimelineDiagnosticView[] {
  if (!projection) return [];
  return [
    ...projection.diagnostics.cycles,
    ...projection.diagnostics.depth_limits,
    ...projection.diagnostics.filtered_targets,
    ...projection.diagnostics.missing_expansions,
  ].map((diagnostic) => ({
    key: [
      diagnostic.kind,
      diagnostic.row_id,
      diagnostic.event_id,
      diagnostic.issue_id,
      diagnostic.target_issue_id,
      diagnostic.message,
    ].filter(Boolean).join(':'),
    kind: diagnostic.kind,
    message: diagnostic.message,
  }));
}

type TimelineDiagnosticView = {
  key: string;
  kind: string;
  message: string;
};

function eventInWindow(event: TimelineEvent, start: number, end: number): boolean {
  return event.timestamp >= start && event.timestamp <= end;
}

function isGroupRow(row: TimelineRowOccurrence): boolean {
  return Boolean(row.row_spec && row.issue === null);
}

function isResidualRow(row: TimelineRowOccurrence): boolean {
  return row.row_spec?.scope?.type === 'residual';
}

function isLocalFilterPath(path: string): boolean {
  return path.startsWith('row:local-filter:');
}

function isEditableFilterRoot(
  row: TimelineRowOccurrence,
  filterRows: readonly TimelineFilterRowSpec[],
): boolean {
  return row.issue === null
    && Boolean(row.row_spec)
    && !isResidualRow(row)
    && filterRows.some((spec) => spec.id === row.row_spec?.id);
}

function isInputElement(target: EventTarget | null): boolean {
  const tag = (target as HTMLElement | null)?.tagName?.toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || tag === 'button';
}

function rowKindClass(kind: TimelineRowOccurrence['kind']): string {
  return kind;
}

function rowPrimaryLabel(row: TimelineRowOccurrence): string {
  return row.issue?.display_id ?? row.row_spec?.id ?? row.id;
}

function rowTitle(row: TimelineRowOccurrence): string {
  if (isResidualRow(row)) return 'Everything else';
  return row.issue?.title ?? row.row_spec?.title ?? 'Timeline group';
}

function rowStatus(row: TimelineRowOccurrence): string {
  if (row.issue) {
    return `${row.issue.status}${row.issue.resolution ? `/${row.issue.resolution}` : ''}`;
  }
  return isResidualRow(row) ? 'residual' : 'filter';
}

function collectTimelineIssues(rows: readonly TimelineRowOccurrence[], events: readonly TimelineEvent[]): TimelineIssueRef[] {
  const byId = new Map<string, TimelineIssueRef>();
  for (const row of rows) {
    if (row.issue) byId.set(row.issue.id, row.issue);
  }
  for (const event of events) {
    byId.set(event.issue.id, event.issue);
  }
  return Array.from(byId.values()).sort((left, right) => left.display_id.localeCompare(right.display_id));
}

type TimelineAggregateInterval = {
  id: string;
  rowId: string;
  memberRowId: string;
  issue: TimelineIssueRef;
  startTime: number;
  endTime: number;
  eventCount: number;
};

function aggregateIntervalForMember(
  groupRow: TimelineRowOccurrence,
  memberRow: TimelineRowOccurrence,
  rowEvents: readonly TimelineEvent[],
): TimelineAggregateInterval | null {
  if (!memberRow.issue || rowEvents.length === 0) return null;
  let startTime = Number.POSITIVE_INFINITY;
  let endTime = Number.NEGATIVE_INFINITY;
  for (const event of rowEvents) {
    startTime = Math.min(startTime, event.timestamp);
    endTime = Math.max(endTime, event.timestamp);
  }
  if (!Number.isFinite(startTime) || !Number.isFinite(endTime)) return null;
  return {
    id: `${groupRow.id}:${memberRow.id}`,
    rowId: groupRow.id,
    memberRowId: memberRow.id,
    issue: memberRow.issue,
    startTime,
    endTime,
    eventCount: rowEvents.length,
  };
}

function aggregateAccessibleLabel(interval: TimelineAggregateInterval): string {
  const range = interval.startTime === interval.endTime
    ? `at ${formatDateTime(interval.startTime)}`
    : `from ${formatDateTime(interval.startTime)} to ${formatDateTime(interval.endTime)}`;
  return `Aggregate marker for ${interval.issue.display_id} ${interval.issue.title}, ${interval.eventCount} ${interval.eventCount === 1 ? 'event' : 'events'} ${range}`;
}

function ZoomOutIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <circle cx="11" cy="11" r="7" />
      <path d="M8 11h6" />
      <path d="m16 16 4 4" />
    </svg>
  );
}

function ZoomInIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <circle cx="11" cy="11" r="7" />
      <path d="M8 11h6" />
      <path d="M11 8v6" />
      <path d="m16 16 4 4" />
    </svg>
  );
}

function FitTimelineIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M4 9V4h5" />
      <path d="M20 9V4h-5" />
      <path d="M4 15v5h5" />
      <path d="M20 15v5h-5" />
      <path d="M8 12h8" />
    </svg>
  );
}

function AddTimelineRowIcon(): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d="M5 7h8" />
      <path d="M5 12h8" />
      <path d="M5 17h8" />
      <path d="M18 9v6" />
      <path d="M15 12h6" />
    </svg>
  );
}

export function TimelineView({ repos, params = {}, sidebarHidden = false, refreshToken = 0 }: TimelineViewProps): JSX.Element {
  const { active } = useAppShell();
  const urlState = useMemo(() => parseUrlState(params), [params]);
  const initialProjectRef = defaultProjectRef(repos, urlState.projectRef);
  const [projectRef, setProjectRef] = useState(initialProjectRef);
  const normalizePersistedTimelineState = useCallback((
    value: unknown,
    defaults: Readonly<TimelineViewState>,
  ) => {
    const normalized = normalizeTimelineViewState(value, defaults);
    const routedProjectRef = defaultProjectRef(repos, urlState.projectRef);
    return projectRef === routedProjectRef
      ? mergeTimelineState(normalized, {}, urlState)
      : normalized;
  }, [projectRef, repos, urlState]);
  const [viewState, setViewState] = usePersistedViewState(
    storageKey(projectRef),
    normalizePersistedTimelineState,
    DEFAULT_TIMELINE_VIEW_STATE,
  );
  const [inspectorSidebar, updateInspectorSidebar] = useAppRightSidebarState(`timeline:${projectRef}`, {
    open: viewState.panes.inspector,
    width: viewState.panes.inspectorWidth,
  }, {
    minWidth: MIN_INSPECTOR_WIDTH,
    maxWidth: MAX_INSPECTOR_WIDTH,
    migrate: () => ({ open: viewState.panes.inspector, width: viewState.panes.inspectorWidth }),
  });
  const [projection, setProjection] = useState<ProjectTimelineProjection | null>(null);
  const lastProjectionRef = useRef<ProjectTimelineProjection | null>(null);
  const [status, setStatus] = useState<ProjectionStatus>('loading');
  const [error, setError] = useState<string | null>(null);
  const timeScrollRef = useRef<HTMLDivElement | null>(null);
  const timelineMainRef = useRef<HTMLDivElement | null>(null);
  const suppressProgrammaticScrollRef = useRef(false);
  const suppressProgrammaticScrollTimerRef = useRef<number | null>(null);
  const gestureScaleRef = useRef<number | null>(null);
  const rowListResizeRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const [timeViewportWidthPx, setTimeViewportWidthPx] = useState(FALLBACK_TIMELINE_WIDTH_PX);
  const [composerOpen, setComposerOpen] = useState(false);
  const [composerEditingRowId, setComposerEditingRowId] = useState<string | null>(null);
  const [composerDraftChips, setComposerDraftChips] = useState<TimelineFilterChip[]>([]);
  const laneCacheRef = useRef<TimelineLaneCache>({});
  const requestGeneration = useRef(0);
  const activeProjectionRequestKeyRef = useRef<string | null>(null);
  const appliedRouteProjectRef = useRef(initialProjectRef);
  const viewStateProjectRef = useRef(initialProjectRef);

  const resetLoadedProjection = useCallback(() => {
    requestGeneration.current += 1;
    activeProjectionRequestKeyRef.current = null;
    lastProjectionRef.current = null;
    laneCacheRef.current = {};
    setProjection(null);
    setError(null);
    setStatus('loading');
  }, []);

  const handleProjectChange = useCallback((nextProjectRef: string) => {
    resetLoadedProjection();
    setProjectRef(nextProjectRef);
  }, [resetLoadedProjection]);
  const timelineRequest = useMemo<ProjectTimelineInput>(
    () => buildProjectTimelineRequest(projectRef, viewState, projection),
    [projectRef, viewState, projection],
  );
  const timelineRequestKey = useMemo(
    () => detailRequestKey('timeline', timelineRequest),
    [timelineRequest],
  );
  // Responses may rebuild the request object without changing its meaning.
  // The fetch lifecycle follows the canonical key, using the latest payload.
  const timelineRequestRef = useRef(timelineRequest);
  timelineRequestRef.current = timelineRequest;

  useEffect(() => {
    const nextProjectRef = defaultProjectRef(repos, urlState.projectRef);
    if (nextProjectRef !== appliedRouteProjectRef.current) {
      appliedRouteProjectRef.current = nextProjectRef;
      if (nextProjectRef !== projectRef) {
        resetLoadedProjection();
        setProjectRef(nextProjectRef);
        return;
      }
    }
    const projectChanged = viewStateProjectRef.current !== projectRef;
    if (projectChanged) viewStateProjectRef.current = projectRef;
    if (nextProjectRef === projectRef) {
      setViewState((current) => {
        const merged = mergeTimelineState(current, {}, urlState);
        return projectChanged ? clearTimelineSelection(merged) : merged;
      });
    } else if (projectChanged) {
      setViewState(clearTimelineSelection);
    }
  }, [projectRef, repos, resetLoadedProjection, urlState]);

  useEffect(() => {
    const canonicalProjectId = projection?.project.id;
    if (!canonicalProjectId) return undefined;
    const timer = window.setTimeout(() => {
      writeTimelineProjectStorageAliases([projectRef, canonicalProjectId], viewState);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [projectRef, projection?.project.id, viewState]);

  useEffect(() => {
    if (!active) return;
    syncFilterRowsToHash(projectRef, viewState.filterRows);
  }, [active, projectRef, viewState.filterRows]);

  useLayoutEffect(() => {
    requestGeneration.current += 1;
    activeProjectionRequestKeyRef.current = timelineRequestKey;
    const cached = readPersistedDetail<ProjectTimelineProjection>(
      'timeline',
      timelineRequestKey,
    );
    if (cached) {
      lastProjectionRef.current = cached;
      setProjection(cached);
    }
    setStatus(lastProjectionRef.current ? 'syncing' : 'loading');
    setError(null);
  }, [timelineRequestKey]);

  const refreshTimeline = useLiveLoad((signal) => {
    if (isPersistedDetailFresh('timeline', timelineRequestKey) && lastProjectionRef.current) {
      setStatus('ready');
      return undefined;
    }
    const generation = requestGeneration.current;
    const detailStarted = beginDetailRequest();
    return getProjectTimeline(timelineRequestRef.current, signal)
      .then((next) => {
        if (
          signal.aborted
          || requestGeneration.current !== generation
          || activeProjectionRequestKeyRef.current !== timelineRequestKey
        ) return;
        writePersistedDetail('timeline', timelineRequestKey, next, undefined, detailStarted);
        lastProjectionRef.current = next;
        setProjection(next);
        setStatus('ready');
      })
      .catch((err) => {
        if (
          refreshAbandoned(signal)
          || requestGeneration.current !== generation
          || activeProjectionRequestKeyRef.current !== timelineRequestKey
        ) return;
        setError(err instanceof Error ? err.message : String(err));
        setProjection(lastProjectionRef.current);
        setStatus('error');
      });
  }, [timelineRequestKey]);
  const lastRefreshTokenRef = useRef(refreshToken);
  useEffect(() => {
    if (lastRefreshTokenRef.current === refreshToken) return;
    lastRefreshTokenRef.current = refreshToken;
    refreshTimeline();
  }, [refreshToken, refreshTimeline]);

  const baseRows = projection?.rows ?? EMPTY_TIMELINE_ROWS;
  const baseEvents = projection?.events ?? EMPTY_TIMELINE_EVENTS;
  const links = projection?.links ?? EMPTY_TIMELINE_LINKS;
  const rows = baseRows;
  const events = baseEvents;
  const linkById = useMemo(() => new Map(links.map((link) => [link.id, link])), [links]);
  const allRowById = useMemo(() => new Map(rows.map((row) => [row.id, row])), [rows]);
  const rowChildrenByParent = useMemo(() => {
    const result = new Map<string, TimelineRowOccurrence[]>();
    for (const row of rows) {
      if (!row.parent_row_id) continue;
      const children = result.get(row.parent_row_id) ?? [];
      children.push(row);
      result.set(row.parent_row_id, children);
    }
    return result;
  }, [rows]);
  const expandedPathSet = useMemo(() => new Set(viewState.expandedPaths), [viewState.expandedPaths]);
  const visibleRows = useMemo(() => rows.filter((row) => {
    let parentId = row.parent_row_id;
    while (parentId) {
      const parent = allRowById.get(parentId);
      if (!parent) break;
      if (isGroupRow(parent) && !expandedPathSet.has(parent.id)) {
        return false;
      }
      parentId = parent.parent_row_id;
    }
    return true;
  }), [allRowById, expandedPathSet, rows]);
  const allEventsByRow = useMemo(() => {
    const result = new Map<string, TimelineEvent[]>();
    for (const event of events) {
      const rowEvents = result.get(event.row_id) ?? [];
      rowEvents.push(event);
      result.set(event.row_id, rowEvents);
    }
    for (const rowEvents of result.values()) {
      rowEvents.sort((a, b) => a.timestamp - b.timestamp || a.ordinal - b.ordinal);
    }
    return result;
  }, [events]);
  const eventsByRow = useMemo(() => {
    const result = new Map<string, TimelineEvent[]>();
    for (const [rowId, rowEvents] of allEventsByRow) {
      const visibleEvents = rowEvents.filter((event) => viewState.visibleEventTypes.includes(event.kind));
      if (visibleEvents.length > 0) result.set(rowId, visibleEvents);
    }
    return result;
  }, [allEventsByRow, viewState.visibleEventTypes]);
  const aggregateIntervals = useMemo(() => {
    const intervals: TimelineAggregateInterval[] = [];
    for (const row of rows) {
      if (!isGroupRow(row) || expandedPathSet.has(row.id)) continue;
      const members = rowChildrenByParent.get(row.id) ?? [];
      for (const member of members) {
        const interval = aggregateIntervalForMember(row, member, allEventsByRow.get(member.id) ?? []);
        if (interval) intervals.push(interval);
      }
    }
    return intervals;
  }, [allEventsByRow, expandedPathSet, rowChildrenByParent, rows]);
  const dataExtent = useMemo(() => {
    const timestamps = Array.from(eventsByRow.values()).flatMap((rowEvents) => (
      rowEvents.map((event) => event.timestamp)
    ));
    const fallbackEnd = projection?.time_axis.end ?? Date.now();
    const fallbackStart = projection?.time_axis.start ?? fallbackEnd - TIMELINE_DAY_MS;
    const fallbackSpan = Math.max(1, fallbackEnd - fallbackStart);
    return timelineExtentFromTimestamps(timestamps, {
      fallbackNow: fallbackEnd,
      fallbackSpanMs: fallbackSpan,
    });
  }, [eventsByRow, projection?.time_axis.end, projection?.time_axis.start]);
  const layoutMetrics = TIMELINE_LAYOUT_METRICS[viewState.density];
  const edgePaddingPx = timelineEdgePaddingPx(layoutMetrics.markWidthPx, timeViewportWidthPx);
  const renderDomain = useMemo(() => (
    paddedTimelineRenderDomain(dataExtent, {
      viewportWidthPx: timeViewportWidthPx,
      edgePaddingPx,
      minSpanMs: TIMELINE_DAY_MS,
    })
  ), [dataExtent, edgePaddingPx, timeViewportWidthPx]);
  const viewport = useMemo(() => (
    viewportFromState(renderDomain, viewState, { edgePaddingPx, viewportWidthPx: timeViewportWidthPx })
  ), [edgePaddingPx, renderDomain, timeViewportWidthPx, viewState]);
  const viewportSpan = Math.max(1, viewport.to - viewport.from);
  const domainSpan = Math.max(1, renderDomain.end - renderDomain.start);
  const { start, end } = { start: viewport.from, end: viewport.to };
  const scrollMetrics = useMemo(() => (
    timelineScrollMetrics(renderDomain, viewport, timeViewportWidthPx)
  ), [renderDomain, timeViewportWidthPx, viewport]);
  const eventById = useMemo(() => new Map(events.map((event) => [event.id, event])), [events]);
  const rowById = allRowById;
  const timelineLayout = useMemo(() => (
    buildTimelineLayout({
      rows: visibleRows.map((row) => ({ id: row.id })),
      events: Array.from(eventsByRow.values()).flatMap((rowEvents) => rowEvents.map((event) => ({
        id: event.id,
        rowId: event.row_id,
        timestamp: event.timestamp,
        widthPx: layoutMetrics.markWidthPx,
        category: event.kind,
        importance: event.issue.priority === 'critical' ? 'critical' : 'normal',
      }))),
      aggregates: aggregateIntervals.map((interval) => ({
        id: interval.id,
        rowId: interval.rowId,
        issueId: interval.issue.id,
        startTime: interval.startTime,
        endTime: interval.endTime,
        category: 'aggregate',
        importance: interval.issue.priority === 'critical' ? 'critical' : 'normal',
      })),
      renderDomain: { start: renderDomain.start, end: renderDomain.end },
      viewportWidthPx: scrollMetrics.surfaceWidthPx,
      density: viewState.density,
      selectedEventId: viewState.selectedEventId,
      expandedClusterIds: viewState.selectedClusterId ? [viewState.selectedClusterId] : [],
      previousLaneByMarkId: laneCacheRef.current,
      markWidthPx: layoutMetrics.markWidthPx,
      rowMinHeightPx: layoutMetrics.rowMinHeightPx,
      rowPaddingYPx: TIMELINE_ROW_PADDING_Y_PX,
      laneHeightPx: layoutMetrics.laneHeightPx,
      rangeClusterMinCount: rangeClusterMinCountForDensity(viewState.density),
    })
  ), [
    aggregateIntervals,
    eventsByRow,
    layoutMetrics.laneHeightPx,
    layoutMetrics.markWidthPx,
    layoutMetrics.rowMinHeightPx,
    renderDomain.end,
    renderDomain.start,
    scrollMetrics.surfaceWidthPx,
    visibleRows,
    viewState.density,
    viewState.selectedEventId,
    viewState.selectedClusterId,
  ]);
  const eventMarkById = useMemo(() => (
    new Map(timelineLayout.eventMarks.map((mark) => [mark.eventId, mark]))
  ), [timelineLayout.eventMarks]);
  const aggregateMarkById = useMemo(() => (
    new Map(timelineLayout.aggregateMarks.map((mark) => [mark.aggregateId, mark]))
  ), [timelineLayout.aggregateMarks]);
  const sameTimeClustersByRow = useMemo(() => {
    const result = new Map<string, TimelineSameTimeCluster[]>();
    for (const cluster of timelineLayout.sameTimeClusters) {
      if (cluster.expanded) continue;
      const clusters = result.get(cluster.rowId) ?? [];
      clusters.push(cluster);
      result.set(cluster.rowId, clusters);
    }
    return result;
  }, [timelineLayout.sameTimeClusters]);
  const rangeClustersByRow = useMemo(() => {
    const result = new Map<string, TimelineRangeCluster[]>();
    for (const cluster of timelineLayout.rangeClusters) {
      const clusters = result.get(cluster.rowId) ?? [];
      clusters.push(cluster);
      result.set(cluster.rowId, clusters);
    }
    return result;
  }, [timelineLayout.rangeClusters]);
  const aggregateMarksByRow = useMemo(() => {
    const result = new Map<string, Array<{ interval: TimelineAggregateInterval; mark: TimelineAggregateMark }>>();
    for (const interval of aggregateIntervals) {
      const mark = aggregateMarkById.get(interval.id);
      if (!mark) continue;
      const entries = result.get(mark.rowId) ?? [];
      entries.push({ interval, mark });
      result.set(mark.rowId, entries);
    }
    return result;
  }, [aggregateIntervals, aggregateMarkById]);
  const clusterById = useMemo(() => (
    new Map<TimelineClusterMark['id'], TimelineClusterMark>([
      ...timelineLayout.sameTimeClusters.map((cluster) => [cluster.id, cluster] as const),
      ...timelineLayout.rangeClusters.map((cluster) => [cluster.id, cluster] as const),
    ])
  ), [timelineLayout.rangeClusters, timelineLayout.sameTimeClusters]);
  const selectedCluster = viewState.selectedClusterId
    ? clusterById.get(viewState.selectedClusterId) ?? null
    : null;
  const selectedClusterEvents = useMemo(() => (
    selectedCluster
      ? selectedCluster.eventIds
        .map((eventId) => eventById.get(eventId))
        .filter((event): event is TimelineEvent => Boolean(event))
        .sort((left, right) => left.timestamp - right.timestamp || left.ordinal - right.ordinal)
      : EMPTY_TIMELINE_EVENTS
  ), [eventById, selectedCluster]);
  const selectedEvent = viewState.selectedEventId ? eventById.get(viewState.selectedEventId) ?? null : null;
  const selectedRow = viewState.selectedRowOccurrenceId
    ? rowById.get(viewState.selectedRowOccurrenceId) ?? null
    : selectedEvent ? rowById.get(selectedEvent.row_id) ?? null : null;
  const missingEventId = viewState.selectedEventId && !selectedEvent ? viewState.selectedEventId : null;
  const missingClusterId = viewState.selectedClusterId && !selectedCluster ? viewState.selectedClusterId : null;
  const missingRowId = viewState.selectedRowOccurrenceId && !selectedRow
    ? viewState.selectedRowOccurrenceId
    : null;
  const selectionStatus: TimelineSelectionStatus = missingEventId || missingClusterId || missingRowId
    ? 'stale'
    : selectedEvent || selectedRow || selectedCluster
    ? 'present'
    : timelineSelectionStatus(viewState);
  const selectedRowEvents = selectedRow
    ? eventsByRow.get(selectedRow.id) ?? EMPTY_TIMELINE_EVENTS
    : EMPTY_TIMELINE_EVENTS;
  const visibleSelectedRowEvents = useMemo(() => (
    selectedRowEvents.filter((event) => eventInWindow(event, start, end))
  ), [end, selectedRowEvents, start]);

  useEffect(() => {
    laneCacheRef.current = timelineLayout.nextLaneByMarkId;
  }, [timelineLayout.nextLaneByMarkId]);

  const updateState = useCallback((patch: Partial<TimelineViewState>) => {
    setViewState((current) => ({
      ...current,
      ...patch,
      timeWindow: patch.timeWindow ?? current.timeWindow,
      panes: patch.panes ?? current.panes,
    }));
  }, []);

  const issueOptions = useMemo(
    () => collectTimelineIssues(baseRows, baseEvents),
    [baseEvents, baseRows],
  );
  const labelOptions = useMemo(() => (
    unique(issueOptions.flatMap((issue) => issue.labels)).sort((left, right) => left.localeCompare(right))
  ), [issueOptions]);
  const kindOptions = useMemo(() => (
    unique(issueOptions.map((issue) => issue.kind)).sort((left, right) => left.localeCompare(right))
  ), [issueOptions]);
  const issueValueOptions = useMemo(() => (
    issueOptions.flatMap((issue) => [issue.display_id, issue.id]).filter(Boolean)
  ), [issueOptions]);
  const composerPreviewSpec = useMemo(
    () => rowSpecFromChips(composerDraftChips, viewState.filterRows, composerEditingRowId ?? undefined),
    [composerDraftChips, composerEditingRowId, viewState.filterRows],
  );
  const openAddRowComposer = useCallback(() => {
    setComposerOpen(true);
    setComposerEditingRowId(null);
    setComposerDraftChips([]);
  }, []);

  const openEditRowComposer = useCallback((row: TimelineRowOccurrence) => {
    const specId = row.row_spec?.id;
    const spec = specId ? viewState.filterRows.find((candidate) => candidate.id === specId) : null;
    if (!spec) return;
    setComposerOpen(true);
    setComposerEditingRowId(spec.id);
    setComposerDraftChips(spec.chips);
  }, [viewState.filterRows]);

  const closeComposer = useCallback(() => {
    setComposerOpen(false);
    setComposerEditingRowId(null);
    setComposerDraftChips([]);
  }, []);

  const addComposerToken = useCallback((rawToken: string) => {
    const chip = parseFilterToken(rawToken);
    if (!chip) return false;
    setComposerDraftChips((current) => [...current, chip]);
    return true;
  }, []);

  const removeComposerChip = useCallback((index: number) => {
    setComposerDraftChips((current) => current.filter((_, currentIndex) => currentIndex !== index));
  }, []);

  const saveComposerRow = useCallback(() => {
    const next = rowSpecFromChips(composerDraftChips, viewState.filterRows, composerEditingRowId ?? undefined);
    if (!next) return;
    const nextFilterRows = composerEditingRowId
      ? viewState.filterRows.map((row) => (row.id === composerEditingRowId ? next : row))
      : [...viewState.filterRows, next];
    const nextProjectedRowId = projectedFilterRowId(next, nextFilterRows);
    updateState({
      filterRows: nextFilterRows,
      expandedPaths: rebuildFilterExpandedPaths(viewState.expandedPaths, viewState.filterRows, nextFilterRows, {
        forceExpandedSpecId: next.id,
      }),
      selectedRowOccurrenceId: nextProjectedRowId,
      selectedEventId: null,
      selectedClusterId: null,
    });
    closeComposer();
  }, [
    closeComposer,
    composerDraftChips,
    composerEditingRowId,
    updateState,
    viewState.expandedPaths,
    viewState.filterRows,
  ]);

  const removeFilterRow = useCallback((row: TimelineRowOccurrence) => {
    const specId = row.row_spec?.id;
    if (!specId) return;
    const nextFilterRows = viewState.filterRows.filter((spec) => spec.id !== specId);
    updateState({
      filterRows: nextFilterRows,
      expandedPaths: rebuildFilterExpandedPaths(viewState.expandedPaths, viewState.filterRows, nextFilterRows),
      selectedRowOccurrenceId: viewState.selectedRowOccurrenceId === row.id
        ? null
        : viewState.selectedRowOccurrenceId,
      selectedEventId: null,
      selectedClusterId: null,
    });
    if (composerEditingRowId === specId) closeComposer();
  }, [
    closeComposer,
    composerEditingRowId,
    updateState,
    viewState.expandedPaths,
    viewState.filterRows,
    viewState.selectedEventId,
    viewState.selectedRowOccurrenceId,
  ]);

  const suppressTimelineScrollEvents = useCallback((durationMs = 160) => {
    suppressProgrammaticScrollRef.current = true;
    if (suppressProgrammaticScrollTimerRef.current !== null) {
      window.clearTimeout(suppressProgrammaticScrollTimerRef.current);
    }
    suppressProgrammaticScrollTimerRef.current = window.setTimeout(() => {
      suppressProgrammaticScrollRef.current = false;
      suppressProgrammaticScrollTimerRef.current = null;
    }, durationMs);
  }, []);

  useEffect(() => {
    const element = timeScrollRef.current;
    if (!element) return undefined;

    const measure = () => {
      const elementWidth = element.clientWidth || element.getBoundingClientRect().width;
      const width = elementWidth - viewState.panes.rowListWidth;
      if (width > 0) {
        setTimeViewportWidthPx(Math.round(width));
      }
    };

    measure();
    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(measure);
      observer.observe(element);
      return () => observer.disconnect();
    }
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, [viewState.panes.rowListWidth]);

  useEffect(() => () => {
    if (suppressProgrammaticScrollTimerRef.current !== null) {
      window.clearTimeout(suppressProgrammaticScrollTimerRef.current);
    }
  }, []);

  useLayoutEffect(() => {
    const element = timeScrollRef.current;
    if (!element) return;
    if (Math.abs(element.scrollLeft - scrollMetrics.scrollLeftPx) > 1) {
      suppressTimelineScrollEvents();
      element.scrollLeft = scrollMetrics.scrollLeftPx;
    }
  }, [scrollMetrics.scrollLeftPx, scrollMetrics.surfaceWidthPx, suppressTimelineScrollEvents]);

  const selectEvent = useCallback((event: TimelineEvent, options: { preserveCluster?: boolean } = {}) => {
    updateInspectorSidebar({ open: true });
    updateState({
      selectedEventId: event.id,
      selectedRowOccurrenceId: event.row_id,
      selectedClusterId: options.preserveCluster ? viewState.selectedClusterId : null,
      panes: viewState.panes,
    });
  }, [updateInspectorSidebar, updateState, viewState.panes, viewState.selectedClusterId]);

  const selectRow = useCallback((row: TimelineRowOccurrence) => {
    updateInspectorSidebar({ open: true });
    updateState({
      selectedRowOccurrenceId: row.id,
      selectedEventId: null,
      selectedClusterId: null,
      panes: viewState.panes,
    });
  }, [updateInspectorSidebar, updateState, viewState.panes]);

  const selectCluster = useCallback((cluster: TimelineClusterMark) => {
    updateInspectorSidebar({ open: true });
    updateState({
      selectedClusterId: cluster.id,
      selectedRowOccurrenceId: cluster.rowId,
      selectedEventId: null,
      panes: viewState.panes,
    });
  }, [updateInspectorSidebar, updateState, viewState.panes]);

  const expandEvent = useCallback((eventId: string) => {
    updateState({ expandedEventIds: unique([...viewState.expandedEventIds, eventId]) });
  }, [updateState, viewState.expandedEventIds]);

  const collapseEvent = useCallback((eventId: string) => {
    const expandedRowIds = links.filter((link) => link.event_id === eventId && link.expanded_row_id)
      .map((link) => link.expanded_row_id as string);
    const descendantRows = new Set<string>(expandedRowIds);
    let changed = true;
    while (changed) {
      changed = false;
      for (const row of rows) {
        if (row.parent_row_id && descendantRows.has(row.parent_row_id) && !descendantRows.has(row.id)) {
          descendantRows.add(row.id);
          changed = true;
        }
      }
    }
    const descendantEventIds = events
      .filter((event) => descendantRows.has(event.row_id))
      .map((event) => event.id);
    const remove = new Set([eventId, ...descendantEventIds]);
    updateState({
      expandedEventIds: viewState.expandedEventIds.filter((id) => !remove.has(id)),
      selectedRowOccurrenceId: viewState.selectedRowOccurrenceId && descendantRows.has(viewState.selectedRowOccurrenceId)
        ? null
        : viewState.selectedRowOccurrenceId,
      selectedEventId: viewState.selectedEventId && remove.has(viewState.selectedEventId)
        ? null
        : viewState.selectedEventId,
      selectedClusterId: viewState.selectedClusterId,
    });
  }, [events, links, rows, updateState, viewState]);

  const promoteRow = useCallback((row: TimelineRowOccurrence) => {
    if (!row.issue) return;
    updateState({ promotedRootIssueIds: unique([...viewState.promotedRootIssueIds, row.issue.id]) });
  }, [updateState, viewState.promotedRootIssueIds]);

  const removePromotedRow = useCallback((row: TimelineRowOccurrence) => {
    if (!row.issue) return;
    const issueId = row.issue.id;
    updateState({ promotedRootIssueIds: viewState.promotedRootIssueIds.filter((id) => id !== issueId) });
  }, [updateState, viewState.promotedRootIssueIds]);

  const removeTransientRow = useCallback((row: TimelineRowOccurrence) => {
    if (!row.source_event_id) return;
    collapseEvent(row.source_event_id);
  }, [collapseEvent]);

  const rowIsDescendantOf = useCallback((rowId: string, ancestorId: string): boolean => {
    let parentId = allRowById.get(rowId)?.parent_row_id ?? null;
    while (parentId) {
      if (parentId === ancestorId) return true;
      parentId = allRowById.get(parentId)?.parent_row_id ?? null;
    }
    return false;
  }, [allRowById]);

  const toggleGroupRow = useCallback((row: TimelineRowOccurrence) => {
    if (!isGroupRow(row)) return;
    const expanded = expandedPathSet.has(row.id);
    updateState({
      expandedPaths: expanded
        ? viewState.expandedPaths.filter((path) => path !== row.id)
        : unique([...viewState.expandedPaths, row.id]),
      selectedRowOccurrenceId: expanded
        && viewState.selectedRowOccurrenceId
        && rowIsDescendantOf(viewState.selectedRowOccurrenceId, row.id)
        ? row.id
        : viewState.selectedRowOccurrenceId,
      selectedEventId: expanded
        && selectedEvent
        && rowIsDescendantOf(selectedEvent.row_id, row.id)
        ? null
        : viewState.selectedEventId,
      selectedClusterId: expanded
        && viewState.selectedRowOccurrenceId
        && rowIsDescendantOf(viewState.selectedRowOccurrenceId, row.id)
        ? null
        : viewState.selectedClusterId,
    });
  }, [
    expandedPathSet,
    rowIsDescendantOf,
    selectedEvent,
    updateState,
    viewState.expandedPaths,
    viewState.selectedClusterId,
    viewState.selectedEventId,
    viewState.selectedRowOccurrenceId,
  ]);

  const beginRowListResize = useCallback((
    event: JSX.TargetedMouseEvent<HTMLDivElement> | JSX.TargetedPointerEvent<HTMLDivElement>,
  ) => {
    event.preventDefault();
    if (rowListResizeRef.current) return;
    rowListResizeRef.current = {
      startX: event.clientX,
      startWidth: viewState.panes.rowListWidth,
    };
    const handlePointerMove = (moveEvent: PointerEvent) => {
      const origin = rowListResizeRef.current;
      if (!origin) return;
      const width = normalizeRowListWidth(origin.startWidth + moveEvent.clientX - origin.startX);
      updateState({ panes: { ...viewState.panes, rowListWidth: width } });
    };
    const stopResize = () => {
      rowListResizeRef.current = null;
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', stopResize);
      window.removeEventListener('pointercancel', stopResize);
    };
    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', stopResize);
    window.addEventListener('pointercancel', stopResize);
  }, [updateState, viewState.panes]);

  const fitProject = useCallback(() => {
    updateState({ timeWindow: { from: null, to: null } });
  }, [updateState]);

  const fitSelected = useCallback(() => {
    const target = selectedEvent ?? visibleSelectedRowEvents[0] ?? selectedRowEvents[0];
    if (!target) return;
    const next = clampTimelineViewport(
      {
        from: target.timestamp - TIMELINE_DAY_MS,
        to: target.timestamp + TIMELINE_DAY_MS,
      },
      renderDomain,
      { minSpanMs: MIN_TIMELINE_WINDOW_MS },
    );
    updateState({ timeWindow: { from: Math.round(next.from), to: Math.round(next.to) } });
  }, [renderDomain, selectedEvent, selectedRowEvents, updateState, visibleSelectedRowEvents]);

  const zoomToCluster = useCallback((cluster: TimelineClusterMark) => {
    const minTime = cluster.kind === 'same_time_cluster' ? cluster.timestamp : cluster.minTime;
    const maxTime = cluster.kind === 'same_time_cluster' ? cluster.timestamp : cluster.maxTime;
    const clusterSpan = Math.max(0, maxTime - minTime);
    const targetSpan = Math.max(clusterSpan, TIMELINE_HOUR_MS);
    const padding = cluster.kind === 'same_time_cluster'
      ? targetSpan / 2
      : Math.max(targetSpan * 0.12, TIMELINE_HOUR_MS / 2);
    const next = clampTimelineViewport(
      { from: minTime - padding, to: maxTime + padding },
      renderDomain,
      { minSpanMs: MIN_TIMELINE_WINDOW_MS },
    );
    updateState({ timeWindow: { from: Math.round(next.from), to: Math.round(next.to) } });
  }, [renderDomain, updateState]);

  const zoomTimeline = useCallback((factor: number, focalRatio = 0.5) => {
    const next = zoomTimelineViewport(viewport, renderDomain, factor, focalRatio, {
      minSpanMs: MIN_TIMELINE_WINDOW_MS,
    });
    const fitted = (
      approximatelyEqualTimestamp(next.from, renderDomain.start)
      && approximatelyEqualTimestamp(next.to, renderDomain.end)
    );
    if (fitted) {
      updateState({ timeWindow: { from: null, to: null } });
      return;
    }
    updateState({ timeWindow: { from: Math.round(next.from), to: Math.round(next.to) } });
  }, [renderDomain, updateState, viewport]);

  const editDateBoundary = useCallback((boundary: 'from' | 'to', value: string) => {
    if (!value) {
      updateState({
        timeWindow: {
          ...viewState.timeWindow,
          [boundary]: null,
        },
      });
      return;
    }
    const next = clampTimelineViewport(
      editTimelineViewportDateBoundary(viewport, boundary, value),
      renderDomain,
      { minSpanMs: MIN_TIMELINE_WINDOW_MS },
    );
    updateState({ timeWindow: { from: Math.round(next.from), to: Math.round(next.to) } });
  }, [renderDomain, updateState, viewState.timeWindow, viewport]);

  const handleTimeScroll = useCallback((event: JSX.TargetedUIEvent<HTMLDivElement>) => {
    if (suppressProgrammaticScrollRef.current) return;
    const next = viewportFromTimelineScroll(
      renderDomain,
      event.currentTarget.scrollLeft,
      viewportSpan,
      timeViewportWidthPx,
    );
    updateState({ timeWindow: { from: Math.round(next.from), to: Math.round(next.to) } });
  }, [renderDomain, timeViewportWidthPx, updateState, viewportSpan]);

  const handleTimelineWheel = useCallback((event: WheelEvent) => {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    suppressTimelineScrollEvents();
    const bounds = timeScrollRef.current?.getBoundingClientRect() ?? timelineMainRef.current?.getBoundingClientRect();
    const focalRatio = bounds && bounds.width > 0
      ? clamp((event.clientX - bounds.left) / bounds.width, 0, 1)
      : 0.5;
    zoomTimeline(event.deltaY < 0 ? WHEEL_ZOOM_IN_FACTOR : WHEEL_ZOOM_OUT_FACTOR, focalRatio);
  }, [suppressTimelineScrollEvents, zoomTimeline]);

  useEffect(() => {
    const element = timelineMainRef.current;
    if (!element) return undefined;
    element.addEventListener('wheel', handleTimelineWheel, { capture: true, passive: false });
    return () => element.removeEventListener('wheel', handleTimelineWheel, { capture: true });
  }, [handleTimelineWheel]);

  const handleTimelineGestureStart = useCallback((event: Event) => {
    const gestureEvent = event as Event & { scale?: number };
    event.preventDefault();
    suppressTimelineScrollEvents();
    gestureScaleRef.current = Number.isFinite(gestureEvent.scale) && gestureEvent.scale
      ? gestureEvent.scale
      : 1;
  }, [suppressTimelineScrollEvents]);

  const handleTimelineGestureChange = useCallback((event: Event) => {
    const gestureEvent = event as Event & { scale?: number; clientX?: number };
    const nextScale = Number.isFinite(gestureEvent.scale) && gestureEvent.scale
      ? gestureEvent.scale
      : 1;
    const previousScale = gestureScaleRef.current ?? 1;
    const scaleDelta = nextScale / Math.max(previousScale, 0.001);
    if (Math.abs(scaleDelta - 1) < 0.01) return;
    event.preventDefault();
    suppressTimelineScrollEvents();
    gestureScaleRef.current = nextScale;
    const bounds = timeScrollRef.current?.getBoundingClientRect() ?? timelineMainRef.current?.getBoundingClientRect();
    const focalRatio = bounds && bounds.width > 0
      ? clamp(((gestureEvent.clientX ?? bounds.left + bounds.width / 2) - bounds.left) / bounds.width, 0, 1)
      : 0.5;
    zoomTimeline(scaleDelta > 1 ? WHEEL_ZOOM_IN_FACTOR : WHEEL_ZOOM_OUT_FACTOR, focalRatio);
  }, [suppressTimelineScrollEvents, zoomTimeline]);

  const handleTimelineGestureEnd = useCallback(() => {
    gestureScaleRef.current = null;
  }, []);

  useEffect(() => {
    const element = timelineMainRef.current;
    if (!element) return undefined;
    element.addEventListener('gesturestart', handleTimelineGestureStart, { capture: true, passive: false });
    element.addEventListener('gesturechange', handleTimelineGestureChange, { capture: true, passive: false });
    element.addEventListener('gestureend', handleTimelineGestureEnd, { capture: true });
    return () => {
      element.removeEventListener('gesturestart', handleTimelineGestureStart, { capture: true });
      element.removeEventListener('gesturechange', handleTimelineGestureChange, { capture: true });
      element.removeEventListener('gestureend', handleTimelineGestureEnd, { capture: true });
    };
  }, [handleTimelineGestureChange, handleTimelineGestureEnd, handleTimelineGestureStart]);

  const navigateEvent = useCallback((direction: 1 | -1) => {
    const chronologicalEvents = timelineLayout.chronologicalOrder
      .filter((entry) => !selectedRow || entry.rowId === selectedRow.id)
      .map((entry) => eventById.get(entry.eventId))
      .filter((event): event is TimelineEvent => Boolean(event));
    const rowEvents = chronologicalEvents.length > 0 ? chronologicalEvents : selectedRowEvents;
    if (rowEvents.length === 0) return;
    const index = viewState.selectedEventId
      ? rowEvents.findIndex((event) => event.id === viewState.selectedEventId)
      : -1;
    const next = rowEvents[Math.max(0, Math.min(rowEvents.length - 1, index + direction))] ?? rowEvents[0];
    selectEvent(next);
  }, [
    eventById,
    selectEvent,
    selectedRow,
    selectedRowEvents,
    timelineLayout.chronologicalOrder,
    viewState.selectedEventId,
  ]);

  const navigateRow = useCallback((direction: 1 | -1) => {
    if (visibleRows.length === 0) return;
    const index = viewState.selectedRowOccurrenceId
      ? visibleRows.findIndex((row) => row.id === viewState.selectedRowOccurrenceId)
      : -1;
    const next = visibleRows[Math.max(0, Math.min(visibleRows.length - 1, index + direction))] ?? visibleRows[0];
    selectRow(next);
  }, [selectRow, viewState.selectedRowOccurrenceId, visibleRows]);

  useEffect(() => {
    if (!active) return undefined;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (isInputElement(event.target)) return;
      if (event.key === 'ArrowRight') {
        event.preventDefault();
        navigateEvent(1);
      } else if (event.key === 'ArrowLeft') {
        event.preventDefault();
        navigateEvent(-1);
      } else if (event.key === 'ArrowDown') {
        event.preventDefault();
        navigateRow(1);
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        navigateRow(-1);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [active, navigateEvent, navigateRow]);

  const axisTicks = useMemo(() => {
    return generateTimelineTicks(viewport, timeViewportWidthPx, {
      targetSpacingPx: TIMELINE_TICK_SPACING_PX,
    }).map((tick) => ({
      ...tick,
      left: eventLeft(tick.timestamp, renderDomain.start, domainSpan),
    }));
  }, [domainSpan, renderDomain.start, timeViewportWidthPx, viewport]);

  const diagnostics = useMemo(() => timelineDiagnostics(projection), [projection]);
  const diagnosticsCount = diagnostics.length;
  const timelineLoading = status === 'loading';
  const emptyTimelineMessage = timelineLoading
    ? `Loading ${projectRef} timeline...`
    : 'No timeline rows match the current controls.';
  const inspectorContent = useMemo(() => (
    <TimelineInspectorFrame>
      <TimelineInspector
        project={projection?.project ?? null}
        selectedEvent={selectedEvent}
        selectedCluster={selectedCluster}
        selectedClusterEvents={selectedClusterEvents}
        selectedRow={selectedRow}
        missingEventId={selectionStatus === 'stale' ? missingEventId : null}
        missingClusterId={selectionStatus === 'stale' ? missingClusterId : null}
        missingRowId={selectionStatus === 'stale' ? missingRowId : null}
        selectionStatus={selectionStatus}
        rowEvents={visibleSelectedRowEvents}
        links={links}
        linkById={linkById}
        expandedEventIds={viewState.expandedEventIds}
        onExpandEvent={expandEvent}
        onCollapseEvent={collapseEvent}
        onSelectEvent={selectEvent}
        onPromoteRow={promoteRow}
        onRemovePromotedRow={removePromotedRow}
        onRemoveTransientRow={removeTransientRow}
        onZoomToCluster={zoomToCluster}
      />
    </TimelineInspectorFrame>
  ), [
    collapseEvent,
    expandEvent,
    linkById,
    links,
    promoteRow,
    projection?.project,
    removePromotedRow,
    removeTransientRow,
    selectEvent,
    selectedCluster,
    selectedClusterEvents,
    selectedEvent,
    selectedRow,
    selectionStatus,
    viewState.expandedEventIds,
    missingClusterId,
    missingEventId,
    missingRowId,
    visibleSelectedRowEvents,
    zoomToCluster,
  ]);
  const inspectorDescriptor = useMemo(() => ({
    id: 'timeline-inspector',
    kind: 'panel' as const,
    title: 'Timeline inspector',
    icon: <PreviewIcon size={18} />,
    ariaLabel: 'Timeline inspector',
    open: inspectorSidebar.open,
    width: inspectorSidebar.width,
    minWidth: MIN_INSPECTOR_WIDTH,
    maxWidth: MAX_INSPECTOR_WIDTH,
    onOpenChange: (open: boolean) => updateInspectorSidebar({ open }),
    onWidthChange: (width: number) => updateInspectorSidebar({ width }),
    content: inspectorContent,
  }), [inspectorContent, inspectorSidebar, updateInspectorSidebar]);

  useRegisterAppRightSidebar(inspectorDescriptor);

  return (
    <section className="timeline-workspace" aria-label="Project timeline">
      <div className={`timeline-layout${sidebarHidden ? ' timeline-layout--sidebar-hidden' : ''}`}>
        <ViewSidebar
          hidden={sidebarHidden}
          {...VIEW_SIDEBAR_GEOMETRY.timeline}
          ariaLabel="Timeline controls"
          className="timeline-sidebar"
          scrollBody
        >
            <div className="timeline-toolbar">
              <label className="timeline-control">
                <span>Project</span>
                <select
                  value={projectRef}
                  onChange={(event) => handleProjectChange((event.currentTarget as HTMLSelectElement).value)}
                >
                  {repos.length === 0 ? <option value={projectRef}>{projectRef}</option> : repos.map((repo) => (
                    <option key={repoId(repo)} value={repoId(repo)}>{repoTitle(repo)}</option>
                  ))}
                </select>
              </label>
              <label className="timeline-control">
                <span>Roots</span>
                <select
                  value={viewState.rootPolicy}
                  onChange={(event) => updateState({ rootPolicy: (event.currentTarget as HTMLSelectElement).value as TimelineRootPolicy })}
                >
                  <option value="coordination_and_explicit">Trackers + explicit</option>
                  <option value="coordination">Trackers</option>
                  <option value="explicit">Explicit</option>
                </select>
              </label>
              <label className="timeline-control timeline-control--wide">
                <span>Explicit</span>
                <input
                  value={serializeCsv(viewState.explicitRootIssueIds)}
                  onChange={(event) => updateState({ explicitRootIssueIds: parseCsv((event.currentTarget as HTMLInputElement).value) })}
                  placeholder="issue ids"
                />
              </label>
              <label className="timeline-control">
                <span>Density</span>
                <select
                  value={viewState.density}
                  onChange={(event) => updateState({ density: (event.currentTarget as HTMLSelectElement).value as TimelineDensity })}
                >
                  <option value="compact">Compact</option>
                  <option value="comfortable">Comfortable</option>
                  <option value="expanded">Expanded</option>
                </select>
              </label>
              <label className="timeline-control">
                <span>From</span>
                <input
                  type="date"
                  value={dateInputValue(viewport.from)}
                  onChange={(event) => editDateBoundary('from', (event.currentTarget as HTMLInputElement).value)}
                />
              </label>
              <label className="timeline-control">
                <span>To</span>
                <input
                  type="date"
                  value={dateInputValue(viewport.to)}
                  onChange={(event) => editDateBoundary('to', (event.currentTarget as HTMLInputElement).value)}
                />
              </label>
              <div className="timeline-toggle-group" aria-label="Event types">
                {EVENT_TYPES.map((kind) => {
                  const active = viewState.visibleEventTypes.includes(kind);
                  return (
                    <button
                      key={kind}
                      type="button"
                      className={active ? 'timeline-chip timeline-chip--active' : 'timeline-chip'}
                      onClick={() => updateState({
                        visibleEventTypes: active
                          ? viewState.visibleEventTypes.filter((item) => item !== kind)
                          : [...viewState.visibleEventTypes, kind],
                      })}
                    >
                      {eventKindLabel(kind)}
                    </button>
                  );
                })}
              </div>
              <label className="timeline-check">
                <input
                  type="checkbox"
                  checked={viewState.includeClosed}
                  onChange={(event) => updateState({ includeClosed: (event.currentTarget as HTMLInputElement).checked })}
                />
                <span>Closed</span>
              </label>
              <button type="button" className="timeline-button" onClick={fitSelected} disabled={!selectedRow && !selectedEvent}>Focus</button>
              <button
                type="button"
                className="timeline-diagnostics-button"
                onClick={() => updateState({ panes: { ...viewState.panes, diagnostics: !viewState.panes.diagnostics } })}
                aria-expanded={viewState.panes.diagnostics}
                aria-label={diagnosticsCount > 0 ? `Diagnostics (${diagnosticsCount})` : 'Diagnostics'}
              >
                Diagnostics
                {diagnosticsCount > 0 ? <span>{diagnosticsCount}</span> : null}
              </button>
              <div className="timeline-status-row" aria-live="polite">
                {timelineLoading ? (
                  <div className="timeline-status" role="status" aria-label="Loading timeline" />
                ) : null}
                {status === 'syncing' ? <div className="timeline-status" role="status" aria-label="Updating timeline" /> : null}
              </div>
            </div>

            {viewState.panes.diagnostics ? (
              <div className="timeline-diagnostics-panel" role="region" aria-label="Timeline diagnostics">
                {diagnostics.length === 0 ? (
                  <span>No diagnostics.</span>
                ) : diagnostics.map((diagnostic) => (
                  <span key={diagnostic.key}>
                    <strong>{diagnostic.kind}</strong>
                    {diagnostic.message}
                  </span>
                ))}
              </div>
            ) : null}
        </ViewSidebar>

        <div className={`timeline-canvas${error ? ' timeline-canvas--with-notice' : ''}`}>
          <AppOperationalNoticeOutlet registerAsMain />
          {error ? (
            <DetailPaneNotice severity="error" density="compact">
              Timeline refresh failed. Showing the last loaded timeline. {error}
            </DetailPaneNotice>
          ) : null}

          <div
            className={`timeline-grid timeline-grid--${viewState.density}`}
            style={{ '--timeline-row-list-width': `${viewState.panes.rowListWidth}px` } as JSX.CSSProperties}
          >
        <div className="timeline-main" ref={timelineMainRef} role="grid" aria-rowcount={visibleRows.length}>
          <div
            className="timeline-body-scroll"
            ref={timeScrollRef}
            onScroll={handleTimeScroll}
            aria-label="Timeline time canvas"
          >
          <div className="timeline-axis__corner">
            <div className="timeline-corner-toolbar" aria-label="Timeline header controls">
              <button
                type="button"
                className="timeline-icon-button"
                onClick={() => zoomTimeline(2)}
                aria-label="Zoom out"
                title="Zoom out"
              >
                <ZoomOutIcon />
              </button>
              <button
                type="button"
                className="timeline-icon-button"
                onClick={() => zoomTimeline(0.5)}
                aria-label="Zoom in"
                title="Zoom in"
              >
                <ZoomInIcon />
              </button>
              <button
                type="button"
                className="timeline-icon-button"
                onClick={fitProject}
                aria-label="Fit all"
                title="Fit all"
              >
                <FitTimelineIcon />
              </button>
              <button
                type="button"
                className="timeline-icon-button"
                onClick={openAddRowComposer}
                aria-label="Add row"
                title="Add row"
              >
                <AddTimelineRowIcon />
              </button>
            </div>
          </div>
          <div
            className="timeline-axis__viewport"
            style={{ width: `${scrollMetrics.surfaceWidthPx}px` } as JSX.CSSProperties}
          >
            <div
              className="timeline-axis__surface"
              style={{
                width: `${scrollMetrics.surfaceWidthPx}px`,
              } as JSX.CSSProperties}
            >
              <div className="timeline-axis__track">
                {axisTicks.map((tick) => (
                  <span
                    key={tick.timestamp}
                    className={`timeline-axis__tick${tick.major ? ' timeline-axis__tick--major' : ''}`}
                    style={{ left: `${tick.left}%` }}
                  >
                    {tick.upperLabel ? (
                      <span className="timeline-axis__tick-context">{tick.upperLabel}</span>
                    ) : (
                      <span className="timeline-axis__tick-context" aria-hidden="true" />
                    )}
                    {tick.lowerLabel ? (
                      <span className="timeline-axis__tick-label">{tick.lowerLabel}</span>
                    ) : (
                      <span className="timeline-axis__tick-label" aria-hidden="true" />
                    )}
                  </span>
                ))}
              </div>
            </div>
          </div>
          <div className="timeline-gutter-column" aria-label="Timeline rows">
            <div className="timeline-gutter-stack">
              {visibleRows.map((row) => {
                const sourceEvent = row.source_event_id ? eventById.get(row.source_event_id) : null;
                const selected = selectedRow?.id === row.id;
                const rowLayout = timelineLayout.rowLayoutById[row.id];
                const group = isGroupRow(row);
                const groupExpanded = group && expandedPathSet.has(row.id);
                const memberCount = rowChildrenByParent.get(row.id)?.length ?? 0;
                return (
                  <div
                    key={row.id}
                    className="timeline-gutter-row-shell"
                    style={{
                      height: `${rowLayout?.heightPx ?? layoutMetrics.rowMinHeightPx}px`,
                    } as JSX.CSSProperties}
                  >
                    <button
                      type="button"
                      className={`timeline-gutter-row timeline-gutter-row--${rowKindClass(row.kind)}${group ? ' timeline-gutter-row--group' : ''}${isResidualRow(row) ? ' timeline-gutter-row--residual' : ''}${selected ? ' timeline-gutter-row--selected' : ''}`}
                      style={{
                        '--depth': row.depth,
                        height: `${rowLayout?.heightPx ?? layoutMetrics.rowMinHeightPx}px`,
                      } as JSX.CSSProperties}
                      onClick={() => group ? toggleGroupRow(row) : selectRow(row)}
                      aria-expanded={group ? groupExpanded : undefined}
                      aria-label={`${rowPrimaryLabel(row)} ${rowTitle(row)}. ${group ? `${groupExpanded ? 'Expanded' : 'Collapsed'} group with ${memberCount} ${memberCount === 1 ? 'member' : 'members'}.` : `${rowKindLabel(row.kind)} row.`} Status ${rowStatus(row)}.`}
                    >
                      <span className="timeline-gutter-row__branch" aria-hidden="true" />
                      <span className="sr-only">{group ? 'Group row' : `${rowKindLabel(row.kind)} row`}</span>
                      <strong>{group ? `${groupExpanded ? '-' : '+'} ${rowPrimaryLabel(row)}` : rowPrimaryLabel(row)}</strong>
                      <span className="timeline-gutter-row__title">{rowTitle(row)}</span>
                      <em>{rowStatus(row)}</em>
                      {sourceEvent ? (
                        <span className="timeline-gutter-row__origin">from {formatDate(sourceEvent.timestamp)}</span>
                      ) : group ? (
                        <span className="timeline-gutter-row__origin">{memberCount} {memberCount === 1 ? 'member' : 'members'}</span>
                      ) : null}
                    </button>
                    {isEditableFilterRoot(row, viewState.filterRows) ? (
                      <div className="timeline-gutter-row__actions">
                        <button type="button" onClick={() => openEditRowComposer(row)} aria-label={`Edit filter ${rowTitle(row)}`}>Edit</button>
                        <button type="button" onClick={() => removeFilterRow(row)} aria-label={`Remove filter ${rowTitle(row)}`}>Remove</button>
                      </div>
                    ) : null}
                  </div>
                );
              })}
              {composerOpen ? (
                <IssuePredicateFilter
                  classPrefix="timeline-filter-composer"
                  ariaLabel={
                    composerEditingRowId !== null
                      ? 'Edit timeline filter row'
                      : 'Add timeline filter row'
                  }
                  chips={composerDraftChips}
                  editing={composerEditingRowId !== null}
                  projecting={Boolean(composerPreviewSpec)}
                  previewTitle={composerPreviewSpec?.title ?? 'Custom filter'}
                  projectingLabel="Projection row"
                  previewDetail={
                    composerPreviewSpec
                      ? 'Membership is resolved by the project timeline projection.'
                      : 'Empty rows are allowed.'
                  }
                  labelOptions={labelOptions}
                  kindOptions={kindOptions}
                  issueOptions={issueValueOptions}
                  onAddToken={addComposerToken}
                  onRemoveChip={removeComposerChip}
                  onCancel={closeComposer}
                  onSave={saveComposerRow}
                  canSave={Boolean(composerPreviewSpec)}
                />
              ) : null}
            </div>
            <div
              className="timeline-gutter-resize-hit"
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize timeline rows"
              aria-valuemin={MIN_ROW_LIST_WIDTH}
              aria-valuemax={MAX_ROW_LIST_WIDTH}
              aria-valuenow={Math.round(viewState.panes.rowListWidth)}
              onMouseDown={beginRowListResize}
              onPointerDown={beginRowListResize}
            />
          </div>
          <div
            className="timeline-time-scroll"
          >
            <div
              className="timeline-time-surface"
              style={{ width: `${scrollMetrics.surfaceWidthPx}px` } as JSX.CSSProperties}
            >
            <div className="timeline-row-stack">
              {visibleRows.length === 0 ? (
                timelineLoading
                  ? <LoadingSkeleton variant="canvas" label={emptyTimelineMessage} announce={false} />
                  : <div className="timeline-empty">{emptyTimelineMessage}</div>
              ) : visibleRows.map((row) => {
                const rowEvents = eventsByRow.get(row.id) ?? [];
                const rowLayout = timelineLayout.rowLayoutById[row.id];
                const rowEventMarks = rowEvents
                  .map((event) => ({ event, mark: eventMarkById.get(event.id) }))
                  .filter((entry): entry is { event: TimelineEvent; mark: TimelineEventMark } => Boolean(entry.mark));
                const rowSameTimeClusters = sameTimeClustersByRow.get(row.id) ?? [];
                const rowRangeClusters = rangeClustersByRow.get(row.id) ?? [];
                const rowAggregateMarks = aggregateMarksByRow.get(row.id) ?? [];
                const earlier = rowEvents.filter((event) => event.timestamp < start).length;
                const later = rowEvents.filter((event) => event.timestamp > end).length;
                const sourceEvent = row.source_event_id ? eventById.get(row.source_event_id) : null;
                const selected = selectedRow?.id === row.id;
                const originXPx = sourceEvent
                  ? eventLeftPx(sourceEvent.timestamp, renderDomain.start, domainSpan, scrollMetrics.surfaceWidthPx)
                  : null;
                const expandedSourceMark = rowEventMarks.find(({ event }) => {
                  const eventLinks = event.link_ids
                    .map((id) => linkById.get(id))
                    .filter((link): link is TimelineLink => Boolean(link));
                  return viewState.expandedEventIds.includes(event.id)
                    || eventLinks.some((link) => Boolean(link.expanded_row_id));
                })?.mark ?? null;
                const sourceParentStartYPx = expandedSourceMark
                  ? markLaneTopPx(expandedSourceMark, layoutMetrics.laneHeightPx) + layoutMetrics.eventHeightPx / 2
                  : null;
                return (
                  <div
                    key={row.id}
                    className={`timeline-row timeline-row--${rowKindClass(row.kind)}${isGroupRow(row) ? ' timeline-row--group' : ''}${isResidualRow(row) ? ' timeline-row--residual' : ''}${sourceEvent ? ' timeline-row--has-origin' : ''}${expandedSourceMark ? ' timeline-row--source-parent' : ''}${selected ? ' timeline-row--selected' : ''}`}
                    role="row"
                    style={{
                      '--origin-x': originXPx === null ? undefined : `${originXPx}px`,
                      '--source-parent-x': expandedSourceMark ? `${expandedSourceMark.xPx}px` : undefined,
                      '--source-parent-start-y': sourceParentStartYPx === null ? undefined : `${sourceParentStartYPx}px`,
                      height: `${rowLayout?.heightPx ?? layoutMetrics.rowMinHeightPx}px`,
                    } as JSX.CSSProperties}
                  >
                  <div className="timeline-row-canvas" role="gridcell">
                    {earlier > 0 ? <span className="timeline-boundary timeline-boundary--left">{earlier} earlier</span> : null}
                    {later > 0 ? <span className="timeline-boundary timeline-boundary--right">{later} later</span> : null}
                    {rowRangeClusters.map((cluster) => (
                      <button
                        key={cluster.id}
                        type="button"
                        className={`timeline-cluster timeline-cluster--range${viewState.selectedClusterId === cluster.id ? ' timeline-cluster--selected' : ''}${cluster.containsSelected ? ' timeline-cluster--contains-selected' : ''}`}
                        style={{
                          left: `${cluster.xPx}px`,
                          top: `${markLaneTopPx(cluster, layoutMetrics.laneHeightPx)}px`,
                          width: `${Math.max(cluster.widthPx, 28)}px`,
                        }}
                        onClick={() => selectCluster(cluster)}
                        onDblClick={() => {
                          selectCluster(cluster);
                          zoomToCluster(cluster);
                        }}
                        aria-label={clusterAccessibleLabel(cluster, viewState.selectedClusterId)}
                        title={clusterAccessibleLabel(cluster, viewState.selectedClusterId)}
                      >
                        <span className="timeline-cluster__range-line" aria-hidden="true" />
                        <strong>{cluster.count}</strong>
                      </button>
                    ))}
                    {rowAggregateMarks.map(({ interval, mark }) => (
                      <button
                        key={mark.id}
                        type="button"
                        className="timeline-cluster timeline-cluster--range timeline-aggregate"
                        style={{
                          left: `${mark.xPx}px`,
                          top: `${markLaneTopPx(mark, layoutMetrics.laneHeightPx)}px`,
                          width: `${Math.max(mark.widthPx, 28)}px`,
                          borderColor: 'rgba(245, 194, 92, 0.62)',
                          background: 'rgba(46, 38, 22, 0.94)',
                        }}
                        onClick={() => {
                          const member = rowById.get(interval.memberRowId);
                          if (member) selectRow(member);
                        }}
                        aria-label={aggregateAccessibleLabel(interval)}
                        title={aggregateAccessibleLabel(interval)}
                      >
                        <span
                          className="timeline-cluster__range-line"
                          style={{ borderTopColor: 'rgba(245, 194, 92, 0.72)' }}
                          aria-hidden="true"
                        />
                        <strong>{shortIssueId(interval.issue.display_id)}</strong>
                      </button>
                    ))}
                    {rowSameTimeClusters.map((cluster) => (
                      <button
                        key={cluster.id}
                        type="button"
                        className={`timeline-cluster timeline-cluster--same-time${viewState.selectedClusterId === cluster.id ? ' timeline-cluster--selected' : ''}${cluster.containsSelected ? ' timeline-cluster--contains-selected' : ''}`}
                        style={{
                          left: `${cluster.xPx}px`,
                          top: `${markLaneTopPx(cluster, layoutMetrics.laneHeightPx)}px`,
                          width: `${cluster.widthPx}px`,
                        }}
                        onClick={() => selectCluster(cluster)}
                        onDblClick={() => {
                          selectCluster(cluster);
                          zoomToCluster(cluster);
                        }}
                        aria-label={clusterAccessibleLabel(cluster, viewState.selectedClusterId)}
                        title={clusterAccessibleLabel(cluster, viewState.selectedClusterId)}
                      >
                        <strong>{cluster.count}</strong>
                      </button>
                    ))}
                    {rowEventMarks.map(({ event, mark }) => {
                      const eventLinks = event.link_ids.map((id) => linkById.get(id)).filter((link): link is TimelineLink => Boolean(link));
                      const issueLinks = eventLinks.filter((link) => link.target_issue && !link.target_issue.deleted);
                      const expanded = viewState.expandedEventIds.includes(event.id) || eventLinks.some((link) => Boolean(link.expanded_row_id));
                      const eventSelected = viewState.selectedEventId === event.id;
                      const refsToggleLabel = `${expanded ? 'Fold' : 'Expand'} ${issueLinks.length} issue ${issueLinks.length === 1 ? 'ref' : 'refs'} for ${event.display_headline}`;
                      const eventPosition = {
                        left: `${mark.xPx}px`,
                        top: `${markLaneTopPx(mark, layoutMetrics.laneHeightPx)}px`,
                      } as JSX.CSSProperties;
                      return (
                        <Fragment key={event.id}>
                          <button
                            type="button"
                            className={`timeline-event timeline-event--${event.kind}${eventSelected ? ' timeline-event--selected' : ''}${expanded ? ' timeline-event--expanded' : ''}`}
                            style={eventPosition}
                            onClick={() => selectEvent(event, {
                              preserveCluster: Boolean(selectedCluster?.eventIds.includes(event.id)),
                            })}
                            title={`${event.display_headline} ${formatDateTime(event.timestamp)}`}
                          >
                            <span className="timeline-event__marker" aria-hidden="true" />
                            <span className="timeline-event__body">
                              <strong>{event.display_headline}</strong>
                              <span>{formatDate(event.timestamp)}</span>
                            </span>
                          </button>
                          {issueLinks.length > 0 ? (
                            <button
                              type="button"
                              className={`timeline-event__refs-toggle${expanded ? ' timeline-event__refs-toggle--expanded' : ''}`}
                              style={eventPosition}
                              onClick={(clickEvent) => {
                                clickEvent.stopPropagation();
                                if (expanded) {
                                  collapseEvent(event.id);
                                } else {
                                  expandEvent(event.id);
                                }
                              }}
                              aria-label={refsToggleLabel}
                              title={refsToggleLabel}
                              aria-expanded={expanded}
                            >
                              <span className="timeline-event__refs-count">{issueLinks.length}</span>
                              <span className="timeline-event__refs-icon" aria-hidden="true">{expanded ? '-' : '+'}</span>
                            </button>
                          ) : null}
                        </Fragment>
                      );
                    })}
                  </div>
                </div>
                );
              })}
            </div>
            </div>
          </div>
          </div>
          </div>
        </div>
      </div>
      </div>
    </section>
  );
}

type InspectorProps = {
  project: ProjectTimelineProjection['project'] | null;
  selectedEvent: TimelineEvent | null;
  selectedCluster: TimelineClusterMark | null;
  selectedClusterEvents: TimelineEvent[];
  selectedRow: TimelineRowOccurrence | null;
  missingEventId: string | null;
  missingClusterId: string | null;
  missingRowId: string | null;
  selectionStatus: TimelineSelectionStatus;
  rowEvents: TimelineEvent[];
  links: TimelineLink[];
  linkById: Map<string, TimelineLink>;
  expandedEventIds: string[];
  onExpandEvent: (eventId: string) => void;
  onCollapseEvent: (eventId: string) => void;
  onSelectEvent: (event: TimelineEvent, options?: { preserveCluster?: boolean }) => void;
  onPromoteRow: (row: TimelineRowOccurrence) => void;
  onRemovePromotedRow: (row: TimelineRowOccurrence) => void;
  onRemoveTransientRow: (row: TimelineRowOccurrence) => void;
  onZoomToCluster: (cluster: TimelineClusterMark) => void;
};

function TimelineInspector({
  project,
  selectedEvent,
  selectedCluster,
  selectedClusterEvents,
  selectedRow,
  missingEventId,
  missingClusterId,
  missingRowId,
  selectionStatus,
  rowEvents,
  linkById,
  expandedEventIds,
  onExpandEvent,
  onCollapseEvent,
  onSelectEvent,
  onPromoteRow,
  onRemovePromotedRow,
  onRemoveTransientRow,
  onZoomToCluster,
}: InspectorProps): JSX.Element {
  const eventLinks = selectedEvent
    ? selectedEvent.link_ids.map((id) => linkById.get(id)).filter((link): link is TimelineLink => Boolean(link))
    : [];
  const expandableLinks = eventLinks.filter((link) => (
    link.ref_kind === 'issue' && link.target_issue && !link.target_issue.deleted
  ));
  const otherRefs = eventLinks.filter((link) => (
    link.ref_kind !== 'issue' || !link.target_issue || link.target_issue.deleted
  ));
  const selectedEventDetail = selectedEvent
    ? {
        id: selectedEvent.issue.id,
        display_id: selectedEvent.issue.display_id,
        project: {
          repo_id: project?.repo_id ?? project?.repo_name ?? project?.display_name ?? selectedEvent.issue.project_id,
          display_name: project?.display_name ?? project?.repo_name ?? selectedEvent.issue.project_id,
        },
        auth_requests: [],
      }
    : null;
  return (
    <div className="timeline-inspector__content">
      {missingEventId || missingClusterId || missingRowId ? (
        <div className="timeline-inspector__missing">
          Selection is outside the current projection.
          {missingEventId ? <code>{missingEventId}</code> : null}
          {missingClusterId ? <code>{missingClusterId}</code> : null}
          {missingRowId ? <code>{missingRowId}</code> : null}
        </div>
      ) : null}
      {selectedCluster && !selectedEvent ? (
        <section className="timeline-inspector__section">
          <div className="timeline-inspector__header">
            <span>{clusterKindLabel(selectedCluster)}</span>
            <strong>{selectedCluster.count} events</strong>
          </div>
          <dl className="timeline-meta">
            <div><dt>Time</dt><dd>{clusterTimeLabel(selectedCluster)}</dd></div>
            <div><dt>Categories</dt><dd>{clusterCategorySummaryLabel(selectedCluster.categorySummary)}</dd></div>
            <div><dt>Row</dt><dd>{selectedRow ? rowPrimaryLabel(selectedRow) : selectedCluster.rowId}</dd></div>
            <div><dt>Selected child</dt><dd>{selectedCluster.containsSelected ? 'Yes' : 'No'}</dd></div>
          </dl>
          <div className="timeline-inspector__actions">
            <button type="button" onClick={() => onZoomToCluster(selectedCluster)}>Zoom to cluster</button>
          </div>
          <div className="timeline-list-fallback timeline-cluster-list">
            <h3>Cluster events</h3>
            {selectedClusterEvents.length === 0 ? <p>No cluster events in the current projection.</p> : selectedClusterEvents.map((event) => (
              <button key={event.id} type="button" onClick={() => onSelectEvent(event, { preserveCluster: true })}>
                <time>{formatDateTime(event.timestamp)}</time>
                <strong>{event.display_headline}</strong>
                <span>{eventKindLabel(event.kind)} - {event.issue.display_id} - ordinal {event.ordinal}</span>
              </button>
            ))}
          </div>
        </section>
      ) : null}
      {selectedEvent ? (
        <section className="timeline-inspector__section timeline-inspector__section--event">
          <div className="timeline-inspector__header">
            <span>{eventEyebrow(selectedEvent)}</span>
            <strong>{selectedEvent.display_headline}</strong>
          </div>
          <dl className="timeline-meta timeline-meta--event">
            <div><dt>Timestamp</dt><dd>{formatDateTime(selectedEvent.timestamp)}</dd></div>
            {selectedEvent.author ? (
              <div>
                <dt>Author</dt>
                <dd>
                  <AttributionIdentity
                    display={selectedEvent.author.display}
                    attribution={selectedEvent.author.attribution}
                    source={selectedEvent.author.source}
                  />
                </dd>
              </div>
            ) : null}
          </dl>
          {selectedEvent.state ? (
            <div className="timeline-state-pill">
              {selectedEvent.state.event_type}: {selectedEvent.state.status ?? 'none'}
            </div>
          ) : null}
          <div className="timeline-action-row timeline-action-row--event">
            {expandedEventIds.includes(selectedEvent.id) ? (
              <button type="button" onClick={() => onCollapseEvent(selectedEvent.id)}>Fold refs</button>
            ) : expandableLinks.length > 0 ? (
              <button type="button" onClick={() => onExpandEvent(selectedEvent.id)}>Expand refs</button>
            ) : null}
            <a href={`#/issues?issue=${encodeURIComponent(selectedEvent.issue.display_id)}`}>Open issue</a>
          </div>
          {selectedEventDetail ? (
            <LedgerRenderedBody
              className="timeline-event-body"
              source={selectedEvent.body || selectedEvent.display_headline}
              empty=""
              detail={selectedEventDetail}
            />
          ) : null}
          {expandableLinks.length > 0 ? (
            <div className="timeline-ref-list">
              <h3>Issue refs</h3>
              {expandableLinks.map((link) => (
                <button key={link.id} type="button" onClick={() => onExpandEvent(selectedEvent.id)}>
                  <span>{link.relationship_type}</span>
                  <strong>{link.target_issue.display_id}</strong>
                  <em>{link.target_issue.title}</em>
                  {link.expanded_row_id ? <b>expanded</b> : expandedEventIds.includes(selectedEvent.id) ? <b>expanding</b> : null}
                </button>
              ))}
            </div>
          ) : null}
          {otherRefs.length > 0 ? (
            <div className="timeline-badge-list">
              {otherRefs.map((link) => <span key={link.id}>{link.ref_kind}: {link.raw_ref}</span>)}
            </div>
          ) : null}
        </section>
      ) : null}
      {selectedRow ? (
        <section className="timeline-inspector__section">
          <div className="timeline-inspector__header">
            <span>{rowKindLabel(selectedRow.kind)}</span>
            <strong>{rowTitle(selectedRow)}</strong>
          </div>
          <dl className="timeline-meta">
            <div><dt>{selectedRow.issue ? 'Issue' : 'Group'}</dt><dd>{rowPrimaryLabel(selectedRow)}</dd></div>
            <div><dt>Status</dt><dd>{rowStatus(selectedRow)}</dd></div>
            <div><dt>Depth</dt><dd>{selectedRow.depth}</dd></div>
            <div><dt>Path</dt><dd>{selectedRow.path.join(' / ') || selectedRow.id}</dd></div>
          </dl>
          <div className="timeline-action-row">
            {selectedRow.kind === 'transient' ? (
              <>
                <button type="button" onClick={() => onPromoteRow(selectedRow)}>Promote</button>
                <button type="button" onClick={() => onRemoveTransientRow(selectedRow)}>Remove occurrence</button>
              </>
            ) : selectedRow.kind === 'promoted_root' ? (
              <button type="button" onClick={() => onRemovePromotedRow(selectedRow)}>Remove promoted root</button>
            ) : null}
            {selectedRow.issue ? (
              <a href={`#/issues?issue=${encodeURIComponent(selectedRow.issue.display_id)}`}>Open issue</a>
            ) : null}
          </div>
          <div className="timeline-list-fallback">
            <h3>Row events</h3>
            {rowEvents.length === 0 ? <p>No events in the current window.</p> : rowEvents.map((event) => (
              <button key={event.id} type="button" onClick={() => onSelectEvent(event)}>
                <time>{formatDateTime(event.timestamp)}</time>
                <strong>{event.display_headline}</strong>
              </button>
            ))}
          </div>
        </section>
      ) : selectionStatus === 'empty' ? (
        <section className="timeline-inspector__section">
          <div className="timeline-inspector__header">
            <span>No selection</span>
            <strong>Timeline inspector</strong>
          </div>
        </section>
      ) : null}
    </div>
  );
}
