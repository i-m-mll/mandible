import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';

import { getProjectTimeline } from '../api';
import type { WorkRepo } from './work';
import {
  DEFAULT_TIMELINE_VIEW_STATE,
  type ProjectTimelineProjection,
  type TimelineDensity,
  type TimelineEvent,
  type TimelineEventKind,
  type TimelineLink,
  type TimelineRootPolicy,
  type TimelineRowOccurrence,
  type TimelineViewState,
} from '../types/timeline';

const STORAGE_PREFIX = 'mandible_timeline_view_state:v1';
const EVENT_TYPES: TimelineEventKind[] = ['body', 'comment', 'state'];
const DENSITIES: TimelineDensity[] = ['compact', 'comfortable', 'expanded'];
const DAY_MS = 24 * 60 * 60 * 1000;

export type TimelineViewProps = {
  repos: WorkRepo[];
  params?: Record<string, string | undefined>;
};

type ProjectionStatus = 'idle' | 'syncing' | 'error';

type TimelineUrlState = Partial<TimelineViewState> & {
  projectRef?: string;
};

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

function parseUrlState(params: Record<string, string | undefined>): TimelineUrlState {
  const eventTypes = parseCsv(params.types).filter((type): type is TimelineEventKind => (
    EVENT_TYPES.includes(type as TimelineEventKind)
  ));
  const from = safeNumber(params.from);
  const to = safeNumber(params.to);
  return {
    projectRef: params.project,
    rootPolicy: coerceRootPolicy(params.root_policy),
    explicitRootIssueIds: parseCsv(params.roots),
    promotedRootIssueIds: parseCsv(params.promoted),
    expandedEventIds: parseCsv(params.expanded),
    expandedPaths: parseCsv(params.paths),
    selectedRowOccurrenceId: params.row || undefined,
    selectedEventId: params.event || undefined,
    timeWindow: from !== null || to !== null ? { from, to } : undefined,
    density: coerceDensity(params.density),
    visibleEventTypes: eventTypes.length > 0 ? eventTypes : undefined,
    includeClosed: parseBool(params.closed),
    panes: params.inspector ? { ...DEFAULT_TIMELINE_VIEW_STATE.panes, inspector: parseBool(params.inspector) ?? true } : undefined,
  };
}

function mergeTimelineState(
  base: TimelineViewState,
  local: Partial<TimelineViewState>,
  url: TimelineUrlState,
): TimelineViewState {
  return {
    ...base,
    ...local,
    ...url,
    projectRef: undefined,
    explicitRootIssueIds: url.explicitRootIssueIds?.length ? url.explicitRootIssueIds : local.explicitRootIssueIds ?? base.explicitRootIssueIds,
    promotedRootIssueIds: url.promotedRootIssueIds?.length ? url.promotedRootIssueIds : local.promotedRootIssueIds ?? base.promotedRootIssueIds,
    expandedEventIds: url.expandedEventIds?.length ? url.expandedEventIds : local.expandedEventIds ?? base.expandedEventIds,
    expandedPaths: url.expandedPaths?.length ? url.expandedPaths : local.expandedPaths ?? base.expandedPaths,
    visibleEventTypes: url.visibleEventTypes?.length ? url.visibleEventTypes : local.visibleEventTypes ?? base.visibleEventTypes,
    timeWindow: url.timeWindow ?? local.timeWindow ?? base.timeWindow,
    panes: url.panes ?? local.panes ?? base.panes,
  } as TimelineViewState;
}

function readStoredState(projectId: string): Partial<TimelineViewState> {
  if (typeof window === 'undefined' || !projectId) return {};
  try {
    const raw = window.localStorage.getItem(storageKey(projectId));
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Partial<TimelineViewState>;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeStoredState(projectId: string, state: TimelineViewState): void {
  if (typeof window === 'undefined' || !projectId) return;
  try {
    window.localStorage.setItem(storageKey(projectId), JSON.stringify(state));
  } catch {
    return;
  }
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
  if (!value) return 'Open';
  return new Date(value).toISOString().slice(0, 10);
}

function formatDateTime(value: number | null | undefined): string {
  if (!value) return 'Open';
  return new Date(value).toLocaleString();
}

function dateInputValue(value: number | null): string {
  return value ? new Date(value).toISOString().slice(0, 10) : '';
}

function dateInputToTimestamp(value: string, endOfDay = false): number | null {
  if (!value) return null;
  const parsed = Date.parse(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed)) return null;
  return endOfDay ? parsed + DAY_MS - 1 : parsed;
}

function eventLeft(timestamp: number, start: number, span: number): number {
  return Math.max(0, Math.min(100, ((timestamp - start) / span) * 100));
}

function eventKindLabel(kind: TimelineEventKind): string {
  return kind === 'body' ? 'Body' : kind === 'comment' ? 'Comment' : 'State';
}

function rowKindLabel(kind: TimelineRowOccurrence['kind']): string {
  if (kind === 'promoted_root') return 'Promoted root';
  if (kind === 'explicit_root') return 'Explicit root';
  if (kind === 'transient') return 'Transient';
  return 'Root';
}

function visibleWindow(projection: ProjectTimelineProjection | null, state: TimelineViewState): { start: number; end: number; span: number } {
  const fallbackStart = projection?.time_axis.start ?? Date.now() - 7 * DAY_MS;
  const fallbackEnd = projection?.time_axis.end ?? Date.now();
  const start = state.timeWindow.from ?? fallbackStart;
  const end = state.timeWindow.to ?? fallbackEnd;
  const normalizedEnd = end <= start ? start + DAY_MS : end;
  return { start, end: normalizedEnd, span: Math.max(1, normalizedEnd - start) };
}

function eventInWindow(event: TimelineEvent, start: number, end: number): boolean {
  return event.timestamp >= start && event.timestamp <= end;
}

function isInputElement(target: EventTarget | null): boolean {
  const tag = (target as HTMLElement | null)?.tagName?.toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select' || tag === 'button';
}

export function TimelineView({ repos, params = {} }: TimelineViewProps): JSX.Element {
  const urlState = useMemo(() => parseUrlState(params), [params]);
  const initialProjectRef = defaultProjectRef(repos, urlState.projectRef);
  const [projectRef, setProjectRef] = useState(initialProjectRef);
  const [viewState, setViewState] = useState<TimelineViewState>(() => (
    mergeTimelineState(DEFAULT_TIMELINE_VIEW_STATE, readStoredState(initialProjectRef), urlState)
  ));
  const [projection, setProjection] = useState<ProjectTimelineProjection | null>(null);
  const lastProjectionRef = useRef<ProjectTimelineProjection | null>(null);
  const [status, setStatus] = useState<ProjectionStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const requestGeneration = useRef(0);

  useEffect(() => {
    const nextProjectRef = defaultProjectRef(repos, urlState.projectRef);
    if (nextProjectRef !== projectRef) {
      setProjectRef(nextProjectRef);
      setViewState(mergeTimelineState(DEFAULT_TIMELINE_VIEW_STATE, readStoredState(nextProjectRef), urlState));
      return;
    }
    setViewState((current) => mergeTimelineState(current, {}, urlState));
  }, [projectRef, repos, urlState]);

  useEffect(() => {
    const canonicalProjectId = projection?.project.id ?? projectRef;
    const timers = [window.setTimeout(() => writeStoredState(canonicalProjectId, viewState), 250)];
    if (projection?.project.id && projection.project.id !== projectRef) {
      timers.push(window.setTimeout(() => writeStoredState(projectRef, viewState), 250));
    }
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [projectRef, projection?.project.id, viewState]);

  useEffect(() => {
    const generation = requestGeneration.current + 1;
    requestGeneration.current = generation;
    const controller = new AbortController();
    setStatus(lastProjectionRef.current ? 'syncing' : 'idle');
    setError(null);
    getProjectTimeline({
      project_ref: projectRef,
      root_policy: viewState.rootPolicy,
      explicit_root_issue_ids: viewState.explicitRootIssueIds,
      promoted_root_issue_ids: viewState.promotedRootIssueIds,
      expanded_event_ids: viewState.expandedEventIds,
      expanded_paths: viewState.expandedPaths,
      include_closed: viewState.includeClosed,
      from: viewState.timeWindow.from ?? undefined,
      to: viewState.timeWindow.to ?? undefined,
    }, controller.signal)
      .then((next) => {
        if (requestGeneration.current !== generation) return;
        lastProjectionRef.current = next;
        setProjection(next);
        setStatus('idle');
      })
      .catch((err) => {
        if (controller.signal.aborted || requestGeneration.current !== generation) return;
        setError(err instanceof Error ? err.message : String(err));
        setProjection(lastProjectionRef.current);
        setStatus('error');
      });
    return () => controller.abort();
  }, [
    projectRef,
    viewState.rootPolicy,
    viewState.explicitRootIssueIds.join(','),
    viewState.promotedRootIssueIds.join(','),
    viewState.expandedEventIds.join(','),
    viewState.expandedPaths.join(','),
    viewState.includeClosed,
    viewState.timeWindow.from,
    viewState.timeWindow.to,
  ]);

  const rows = projection?.rows ?? [];
  const events = projection?.events ?? [];
  const links = projection?.links ?? [];
  const linkById = useMemo(() => new Map(links.map((link) => [link.id, link])), [links]);
  const eventsByRow = useMemo(() => {
    const result = new Map<string, TimelineEvent[]>();
    for (const event of events) {
      if (!viewState.visibleEventTypes.includes(event.kind)) continue;
      const rowEvents = result.get(event.row_id) ?? [];
      rowEvents.push(event);
      result.set(event.row_id, rowEvents);
    }
    for (const rowEvents of result.values()) {
      rowEvents.sort((a, b) => a.timestamp - b.timestamp || a.ordinal - b.ordinal);
    }
    return result;
  }, [events, viewState.visibleEventTypes]);
  const eventById = useMemo(() => new Map(events.map((event) => [event.id, event])), [events]);
  const rowById = useMemo(() => new Map(rows.map((row) => [row.id, row])), [rows]);
  const selectedEvent = viewState.selectedEventId ? eventById.get(viewState.selectedEventId) ?? null : null;
  const selectedRow = viewState.selectedRowOccurrenceId
    ? rowById.get(viewState.selectedRowOccurrenceId) ?? null
    : selectedEvent ? rowById.get(selectedEvent.row_id) ?? null : null;
  const { start, end, span } = visibleWindow(projection, viewState);
  const selectedRowEvents = selectedRow ? eventsByRow.get(selectedRow.id) ?? [] : [];
  const visibleSelectedRowEvents = selectedRowEvents.filter((event) => eventInWindow(event, start, end));

  const updateState = useCallback((patch: Partial<TimelineViewState>) => {
    setViewState((current) => ({
      ...current,
      ...patch,
      timeWindow: patch.timeWindow ?? current.timeWindow,
      panes: patch.panes ?? current.panes,
    }));
  }, []);

  const selectEvent = useCallback((event: TimelineEvent) => {
    updateState({
      selectedEventId: event.id,
      selectedRowOccurrenceId: event.row_id,
      panes: { ...viewState.panes, inspector: true },
    });
  }, [updateState, viewState.panes]);

  const selectRow = useCallback((row: TimelineRowOccurrence) => {
    updateState({
      selectedRowOccurrenceId: row.id,
      selectedEventId: null,
      panes: { ...viewState.panes, inspector: true },
    });
  }, [updateState, viewState.panes]);

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
    });
  }, [events, links, rows, updateState, viewState]);

  const promoteRow = useCallback((row: TimelineRowOccurrence) => {
    updateState({ promotedRootIssueIds: unique([...viewState.promotedRootIssueIds, row.issue.id]) });
  }, [updateState, viewState.promotedRootIssueIds]);

  const removePromotedRow = useCallback((row: TimelineRowOccurrence) => {
    updateState({ promotedRootIssueIds: viewState.promotedRootIssueIds.filter((id) => id !== row.issue.id) });
  }, [updateState, viewState.promotedRootIssueIds]);

  const removeTransientRow = useCallback((row: TimelineRowOccurrence) => {
    if (!row.source_event_id) return;
    collapseEvent(row.source_event_id);
  }, [collapseEvent]);

  const fitProject = useCallback(() => {
    updateState({ timeWindow: { from: projection?.time_axis.start ?? null, to: projection?.time_axis.end ?? null } });
  }, [projection, updateState]);

  const fitSelected = useCallback(() => {
    const target = selectedEvent ?? visibleSelectedRowEvents[0] ?? selectedRowEvents[0];
    if (!target) return;
    updateState({ timeWindow: { from: target.timestamp - DAY_MS, to: target.timestamp + DAY_MS } });
  }, [selectedEvent, selectedRowEvents, updateState, visibleSelectedRowEvents]);

  const navigateEvent = useCallback((direction: 1 | -1) => {
    const rowEvents = selectedRowEvents.length > 0 ? selectedRowEvents : events;
    if (rowEvents.length === 0) return;
    const index = viewState.selectedEventId
      ? rowEvents.findIndex((event) => event.id === viewState.selectedEventId)
      : -1;
    const next = rowEvents[Math.max(0, Math.min(rowEvents.length - 1, index + direction))] ?? rowEvents[0];
    selectEvent(next);
  }, [events, selectEvent, selectedRowEvents, viewState.selectedEventId]);

  const navigateRow = useCallback((direction: 1 | -1) => {
    if (rows.length === 0) return;
    const index = viewState.selectedRowOccurrenceId
      ? rows.findIndex((row) => row.id === viewState.selectedRowOccurrenceId)
      : -1;
    const next = rows[Math.max(0, Math.min(rows.length - 1, index + direction))] ?? rows[0];
    selectRow(next);
  }, [rows, selectRow, viewState.selectedRowOccurrenceId]);

  useEffect(() => {
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
  }, [navigateEvent, navigateRow]);

  const axisTicks = useMemo(() => {
    const ticks = 4;
    return Array.from({ length: ticks + 1 }, (_, index) => {
      const timestamp = start + (span * index) / ticks;
      return { timestamp, left: (index / ticks) * 100 };
    });
  }, [span, start]);

  const diagnosticsCount = projection
    ? projection.diagnostics.cycles.length
      + projection.diagnostics.depth_limits.length
      + projection.diagnostics.filtered_targets.length
      + projection.diagnostics.missing_expansions.length
    : 0;

  return (
    <section className="timeline-workspace" aria-label="Project timeline">
      <div className="timeline-toolbar">
        <label className="timeline-control">
          <span>Project</span>
          <select
            value={projectRef}
            onChange={(event) => setProjectRef((event.currentTarget as HTMLSelectElement).value)}
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
            <option value="coordination_and_explicit">Coordination + explicit</option>
            <option value="coordination">Coordination</option>
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
            value={dateInputValue(viewState.timeWindow.from)}
            onChange={(event) => updateState({ timeWindow: { ...viewState.timeWindow, from: dateInputToTimestamp((event.currentTarget as HTMLInputElement).value) } })}
          />
        </label>
        <label className="timeline-control">
          <span>To</span>
          <input
            type="date"
            value={dateInputValue(viewState.timeWindow.to)}
            onChange={(event) => updateState({ timeWindow: { ...viewState.timeWindow, to: dateInputToTimestamp((event.currentTarget as HTMLInputElement).value, true) } })}
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
        <button type="button" className="timeline-button" onClick={fitProject}>Fit</button>
        <button type="button" className="timeline-button" onClick={fitSelected} disabled={!selectedRow && !selectedEvent}>Focus</button>
        <button
          type="button"
          className="timeline-button"
          onClick={() => updateState({ panes: { ...viewState.panes, inspector: !viewState.panes.inspector } })}
        >
          Inspector
        </button>
        <div className="timeline-diagnostics" role="status">
          <span>{status === 'syncing' ? 'Syncing' : status === 'error' ? 'Using last valid' : 'Current'}</span>
          <span>{rows.length} rows</span>
          <span>{events.length} events</span>
          <span>{diagnosticsCount} diagnostics</span>
        </div>
      </div>

      {error ? <div className="timeline-sync-banner">{error}</div> : null}

      <div className={`timeline-grid timeline-grid--${viewState.density}${viewState.panes.inspector ? '' : ' timeline-grid--no-inspector'}`}>
        <div className="timeline-main" role="grid" aria-rowcount={rows.length}>
          <div className="timeline-axis">
            <div className="timeline-axis__corner">Rows</div>
            <div className="timeline-axis__track">
              {axisTicks.map((tick) => (
                <span key={tick.timestamp} className="timeline-axis__tick" style={{ left: `${tick.left}%` }}>
                  {formatDate(tick.timestamp)}
                </span>
              ))}
            </div>
          </div>
          <div className="timeline-row-stack">
            {rows.length === 0 ? (
              <div className="timeline-empty">No timeline rows match the current controls.</div>
            ) : rows.map((row) => {
              const rowEvents = eventsByRow.get(row.id) ?? [];
              const visibleEvents = rowEvents.filter((event) => eventInWindow(event, start, end));
              const earlier = rowEvents.filter((event) => event.timestamp < start).length;
              const later = rowEvents.filter((event) => event.timestamp > end).length;
              const sourceEvent = row.source_event_id ? eventById.get(row.source_event_id) : null;
              const selected = selectedRow?.id === row.id;
              return (
                <div
                  key={row.id}
                  className={`timeline-row timeline-row--${row.kind}${selected ? ' timeline-row--selected' : ''}`}
                  role="row"
                >
                  <button
                    type="button"
                    className="timeline-gutter-row"
                    style={{ '--depth': row.depth } as JSX.CSSProperties}
                    onClick={() => selectRow(row)}
                  >
                    <span className="timeline-gutter-row__branch" aria-hidden="true" />
                    <span className="timeline-gutter-row__kind">{rowKindLabel(row.kind)}</span>
                    <strong>{row.issue.display_id}</strong>
                    <span>{row.issue.title}</span>
                    <em>{row.issue.status}{row.issue.resolution ? `/${row.issue.resolution}` : ''}</em>
                    {sourceEvent ? (
                      <span className="timeline-gutter-row__origin">from {formatDate(sourceEvent.timestamp)}</span>
                    ) : null}
                  </button>
                  <div className="timeline-row-canvas" role="gridcell">
                    {sourceEvent ? (
                      <button
                        type="button"
                        className="timeline-origin-marker"
                        style={{ left: `${eventLeft(sourceEvent.timestamp, start, span)}%` }}
                        onClick={() => selectEvent(sourceEvent)}
                      >
                        Origin
                      </button>
                    ) : null}
                    {earlier > 0 ? <span className="timeline-boundary timeline-boundary--left">{earlier} earlier</span> : null}
                    {later > 0 ? <span className="timeline-boundary timeline-boundary--right">{later} later</span> : null}
                    {visibleEvents.map((event) => {
                      const eventLinks = event.link_ids.map((id) => linkById.get(id)).filter((link): link is TimelineLink => Boolean(link));
                      const issueLinks = eventLinks.filter((link) => link.target_issue && !link.target_issue.deleted);
                      const expanded = eventLinks.some((link) => Boolean(link.expanded_row_id));
                      const eventSelected = viewState.selectedEventId === event.id;
                      return (
                        <button
                          key={event.id}
                          type="button"
                          className={`timeline-event timeline-event--${event.kind}${eventSelected ? ' timeline-event--selected' : ''}${expanded ? ' timeline-event--expanded' : ''}`}
                          style={{ left: `${eventLeft(event.timestamp, start, span)}%` }}
                          onClick={() => selectEvent(event)}
                          title={`${event.display_headline} ${formatDateTime(event.timestamp)}`}
                        >
                          <span className="timeline-event__marker" aria-hidden="true" />
                          <span className="timeline-event__body">
                            <strong>{event.display_headline}</strong>
                            <span>{formatDate(event.timestamp)}</span>
                          </span>
                          {eventLinks.length > 0 ? <em>{eventLinks.length} refs</em> : null}
                          {issueLinks.length > 0 ? <b>{issueLinks.length} expandable</b> : null}
                        </button>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {viewState.panes.inspector ? (
          <aside className="timeline-inspector" aria-label="Timeline inspector">
            <TimelineInspector
              selectedEvent={selectedEvent}
              selectedRow={selectedRow}
              missingEventId={viewState.selectedEventId && !selectedEvent ? viewState.selectedEventId : null}
              missingRowId={viewState.selectedRowOccurrenceId && !selectedRow ? viewState.selectedRowOccurrenceId : null}
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
            />
          </aside>
        ) : null}
      </div>
    </section>
  );
}

type InspectorProps = {
  selectedEvent: TimelineEvent | null;
  selectedRow: TimelineRowOccurrence | null;
  missingEventId: string | null;
  missingRowId: string | null;
  rowEvents: TimelineEvent[];
  links: TimelineLink[];
  linkById: Map<string, TimelineLink>;
  expandedEventIds: string[];
  onExpandEvent: (eventId: string) => void;
  onCollapseEvent: (eventId: string) => void;
  onSelectEvent: (event: TimelineEvent) => void;
  onPromoteRow: (row: TimelineRowOccurrence) => void;
  onRemovePromotedRow: (row: TimelineRowOccurrence) => void;
  onRemoveTransientRow: (row: TimelineRowOccurrence) => void;
};

function TimelineInspector({
  selectedEvent,
  selectedRow,
  missingEventId,
  missingRowId,
  rowEvents,
  linkById,
  expandedEventIds,
  onExpandEvent,
  onCollapseEvent,
  onSelectEvent,
  onPromoteRow,
  onRemovePromotedRow,
  onRemoveTransientRow,
}: InspectorProps): JSX.Element {
  const eventLinks = selectedEvent
    ? selectedEvent.link_ids.map((id) => linkById.get(id)).filter((link): link is TimelineLink => Boolean(link))
    : [];
  const expandableLinks = eventLinks.filter((link) => link.target_issue && !link.target_issue.deleted);
  const otherRefs = eventLinks.filter((link) => link.target_issue?.deleted || link.ref_kind !== 'issue');
  return (
    <div className="timeline-inspector__content">
      {missingEventId || missingRowId ? (
        <div className="timeline-inspector__missing">
          Selection is outside the current projection.
          {missingEventId ? <code>{missingEventId}</code> : null}
          {missingRowId ? <code>{missingRowId}</code> : null}
        </div>
      ) : null}
      {selectedEvent ? (
        <section className="timeline-inspector__section">
          <div className="timeline-inspector__header">
            <span>{eventKindLabel(selectedEvent.kind)}</span>
            <strong>{selectedEvent.display_headline}</strong>
          </div>
          <dl className="timeline-meta">
            <div><dt>Issue</dt><dd>{selectedEvent.issue.display_id}</dd></div>
            <div><dt>Timestamp</dt><dd>{formatDateTime(selectedEvent.timestamp)}</dd></div>
            <div><dt>Ordinal</dt><dd>{selectedEvent.ordinal}</dd></div>
            <div><dt>Source</dt><dd>{selectedEvent.source_entity.type}</dd></div>
          </dl>
          {selectedEvent.state ? (
            <div className="timeline-state-pill">
              {selectedEvent.state.event_type}: {selectedEvent.state.status ?? 'none'}
            </div>
          ) : null}
          <pre className="timeline-event-body">{selectedEvent.body || selectedEvent.display_headline}</pre>
          <div className="timeline-action-row">
            {expandedEventIds.includes(selectedEvent.id) ? (
              <button type="button" onClick={() => onCollapseEvent(selectedEvent.id)}>Fold refs</button>
            ) : expandableLinks.length > 0 ? (
              <button type="button" onClick={() => onExpandEvent(selectedEvent.id)}>Expand refs</button>
            ) : null}
            <a href={`#/issues?issue=${encodeURIComponent(selectedEvent.issue.display_id)}`}>Open issue</a>
          </div>
          {expandableLinks.length > 0 ? (
            <div className="timeline-ref-list">
              <h3>Issue refs</h3>
              {expandableLinks.map((link) => (
                <button key={link.id} type="button" onClick={() => onExpandEvent(selectedEvent.id)}>
                  <span>{link.relationship_type}</span>
                  <strong>{link.target_issue.display_id}</strong>
                  <em>{link.target_issue.title}</em>
                  {link.expanded_row_id ? <b>expanded</b> : null}
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
            <strong>{selectedRow.issue.title}</strong>
          </div>
          <dl className="timeline-meta">
            <div><dt>Issue</dt><dd>{selectedRow.issue.display_id}</dd></div>
            <div><dt>Status</dt><dd>{selectedRow.issue.status}</dd></div>
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
            <a href={`#/issues?issue=${encodeURIComponent(selectedRow.issue.display_id)}`}>Open issue</a>
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
      ) : !selectedEvent ? (
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
