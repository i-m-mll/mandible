// Logs viewer tab — Bug: af91bdd
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { getLogs, type LogEntry, type LogEntityFacetValue, type LogsResponse } from '../api';
import { createSSEClient, type SSEClient, type SSEPayload } from '../sse-client';
import { artifactDetailHref, parseResourceRef, resourceRefHref } from '../resource-refs';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

type LogFilters = {
  levels: LogLevel[];
  subsystem: string;
  event: string;
  q: string;
  related: string;
  since: string;
  until: string;
};

type LogsViewProps = {
  loadLogs?: typeof getLogs;
  createSse?: () => SSEClient;
};

const LEVEL_LABELS: LogLevel[] = ['debug', 'info', 'warn', 'error'];
const DEFAULT_LEVELS: LogLevel[] = ['info', 'warn', 'error'];
const DEFAULT_FILTERS: LogFilters = {
  levels: DEFAULT_LEVELS,
  subsystem: '',
  event: '',
  q: '',
  related: '',
  since: '',
  until: '',
};

const EXCLUDED_DETAIL_KEYS = new Set([
  'id',
  'level',
  'message',
  'event',
  'subsystem',
  'time',
]);

function levelClass(level: string): string {
  switch (level) {
    case 'error':
      return 'log-badge log-badge--error';
    case 'warn':
      return 'log-badge log-badge--warn';
    case 'info':
      return 'log-badge log-badge--info';
    case 'debug':
      return 'log-badge log-badge--debug';
    default:
      return 'log-badge';
  }
}

function formatTime(iso?: string): string {
  if (!iso) return '--';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

function formatStatusTime(date: Date | null): string {
  if (!date) return 'never';
  return date.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

function formatIsoStatus(iso: string | null | undefined): string {
  return iso ? formatStatusTime(new Date(iso)) : 'none seen';
}

function rowId(entry: LogEntry, index: number): string {
  return entry.id || `${entry.time || ''}:${entry.event || entry.message || ''}:${index}`;
}

export function parseLogsHash(hash = window.location.hash): LogFilters {
  const queryIndex = hash.indexOf('?');
  const params = new URLSearchParams(queryIndex >= 0 ? hash.slice(queryIndex + 1) : '');
  const rawLevels = params.get('levels');
  const levels = rawLevels
    ? rawLevels.split(',').filter((level): level is LogLevel => LEVEL_LABELS.includes(level as LogLevel))
    : DEFAULT_FILTERS.levels;
  return {
    levels: levels.length > 0 ? levels : DEFAULT_FILTERS.levels,
    subsystem: params.get('subsystem') || '',
    event: params.get('event') || '',
    q: params.get('q') || '',
    related: params.get('related') || '',
    since: params.get('since') || '',
    until: params.get('until') || '',
  };
}

function filtersToHash(filters: LogFilters): string {
  const params = new URLSearchParams();
  if (!sameLevels(filters.levels, DEFAULT_FILTERS.levels)) {
    params.set('levels', filters.levels.join(','));
  }
  if (filters.subsystem) params.set('subsystem', filters.subsystem);
  if (filters.event) params.set('event', filters.event);
  if (filters.q) params.set('q', filters.q);
  if (filters.related) params.set('related', filters.related);
  if (filters.since) params.set('since', filters.since);
  if (filters.until) params.set('until', filters.until);
  const query = params.toString();
  return `#/logs${query ? `?${query}` : ''}`;
}

function sameLevels(a: LogLevel[], b: LogLevel[]): boolean {
  return a.length === b.length && a.every((level) => b.includes(level));
}

function updateHash(filters: LogFilters): void {
  const next = filtersToHash(filters);
  if (window.location.hash !== next) {
    window.history.replaceState(null, '', next);
  }
}

function entityHref(type: LogEntityFacetValue['type'], id: string, repoId?: string | null): string {
  if (type === 'issue') {
    const params = new URLSearchParams({ issue: id });
    if (repoId) params.set('repo', repoId);
    return `#/issues?${params.toString()}`;
  }
  if (type === 'auth_request') return `#/auth?request=${encodeURIComponent(id)}`;
  if (type === 'artifact') return artifactDetailHref(id);
  if (type === 'session') return `#/sessions?session=${encodeURIComponent(id)}`;
  return `#/graph?focus=${encodeURIComponent(id)}`;
}

function entityTypeFromKey(key: string): LogEntityFacetValue['type'] | null {
  const normalized = key.toLowerCase();
  if (normalized === 'issue_id' || normalized === 'issueid' || normalized === 'issue') return 'issue';
  if (normalized === 'auth_request_id' || normalized === 'authrequestid' || normalized === 'auth_request') return 'auth_request';
  if (normalized === 'artifact_id' || normalized === 'artifactid' || normalized === 'artifact') return 'artifact';
  if (normalized === 'session_id' || normalized === 'sessionid' || normalized === 'session') return 'session';
  if (normalized === 'repo_id' || normalized === 'repoid' || normalized === 'repo') return 'repo';
  return null;
}

function hrefForValue(key: string, value: string, repoId?: string | null): string | null {
  const entityType = entityTypeFromKey(key);
  if (entityType) {
    return entityHref(entityType, value, repoId);
  }
  const parsed = parseResourceRef(value);
  if (!parsed) {
    return null;
  }
  if (parsed.kind === 'issue') {
    return entityHref('issue', parsed.canonical.replace(/^issue:/i, ''), repoId);
  }
  if (parsed.kind === 'comment') {
    const target = parsed.canonical.replace(/^comment:/i, '');
    const [issue, comment] = target.split('#');
    const params = new URLSearchParams({ issue });
    if (comment) params.set('comment', comment);
    if (repoId) params.set('repo', repoId);
    return `#/issues?${params.toString()}`;
  }
  if (parsed.kind === 'artifact' || parsed.kind === 'repo' || parsed.kind === 'mandible') {
    return resourceRefHref(parsed.canonical);
  }
  return null;
}

function DetailValue({ fieldKey, value, repoId }: { fieldKey: string; value: unknown; repoId?: string | null }): JSX.Element {
  if (value === null || value === undefined || value === '') {
    return <span className="log-detail-value log-detail-value--empty">none</span>;
  }
  if (Array.isArray(value)) {
    return (
      <details className="log-detail-nested">
        <summary>{value.length} items</summary>
        <div className="log-detail-array">
          {value.map((item, index) => (
            <DetailValue key={index} fieldKey={`${fieldKey}[${index}]`} value={item} repoId={repoId} />
          ))}
        </div>
      </details>
    );
  }
  if (typeof value === 'object') {
    return (
      <details className="log-detail-nested">
        <summary>object</summary>
        <DetailGrid fields={value as Record<string, unknown>} repoId={repoId} />
      </details>
    );
  }
  const text = String(value);
  const href = hrefForValue(fieldKey, text, repoId);
  if (href) {
    return <a className="log-entity-link" href={href}>{text}</a>;
  }
  return <span className="log-detail-value">{text}</span>;
}

function DetailGrid({ fields, repoId }: { fields: Record<string, unknown>; repoId?: string | null }): JSX.Element {
  const entries = Object.entries(fields).filter(([, value]) => value !== undefined);
  if (entries.length === 0) {
    return <div className="log-detail-empty">No structured fields.</div>;
  }
  return (
    <div className="log-detail-grid">
      {entries.map(([key, value]) => (
        <div className="log-detail-field" key={key}>
          <div className="log-detail-key">{key}</div>
          <div className="log-detail-data">
            <DetailValue fieldKey={key} value={value} repoId={repoId} />
          </div>
        </div>
      ))}
    </div>
  );
}

function LogRow({
  entry,
  expanded,
  selected,
  onToggle,
}: {
  entry: LogEntry;
  expanded: boolean;
  selected: boolean;
  onToggle: () => void;
}): JSX.Element {
  const detail = useMemo(() => {
    const result: Record<string, unknown> = {};
    Object.entries(entry).forEach(([key, value]) => {
      if (!EXCLUDED_DETAIL_KEYS.has(key)) {
        result[key] = value;
      }
    });
    return result;
  }, [entry]);
  const hasDetail = Object.keys(detail).length > 0;
  const message = entry.message || entry.event || '(no message)';

  return (
    <div className={`log-row log-row--${entry.level || 'info'}${selected ? ' log-row--selected' : ''}`}>
      <button
        type="button"
        className="log-row__main"
        onClick={onToggle}
        aria-expanded={expanded}
      >
        <span className="log-row__time">{formatTime(entry.time)}</span>
        <span className={levelClass(entry.level || 'info')}>{(entry.level || 'info').toUpperCase()}</span>
        <span className="log-row__subsystem">{entry.subsystem || 'daemon'}</span>
        <span className="log-row__event">{entry.event || message}</span>
        <span className="log-row__message">{message}</span>
        {hasDetail && (
          <span className="log-row__expand" aria-hidden="true">{expanded ? '▾' : '▸'}</span>
        )}
      </button>
      {expanded && hasDetail && (
        <div className="log-row__detail">
          <DetailGrid fields={detail} repoId={entry.repo_id || null} />
        </div>
      )}
    </div>
  );
}

function filterParam(filters: LogFilters): Parameters<typeof getLogs>[0] {
  return {
    levels: filters.levels,
    subsystem: filters.subsystem || undefined,
    event: filters.event || undefined,
    q: filters.q || undefined,
    related: filters.related || undefined,
    since: filters.since || undefined,
    until: filters.until || undefined,
    limit: 500,
  };
}

function facetLabel(facet: LogEntityFacetValue): string {
  if (facet.type === 'auth_request') return `auth:${facet.value}`;
  return `${facet.type}:${facet.value}`;
}

export function LogsView({ loadLogs = getLogs, createSse = createSSEClient }: LogsViewProps): JSX.Element {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [filters, setFilters] = useState<LogFilters>(() => parseLogsHash());
  const [facets, setFacets] = useState<LogsResponse['facets'] | null>(null);
  const [source, setSource] = useState<LogsResponse['source'] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [logFileExists, setLogFileExists] = useState<boolean | null>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const [expandedRows, setExpandedRows] = useState<Set<string>>(() => new Set());
  const [selectedRow, setSelectedRow] = useState<string | null>(null);
  const [lastLoadedAt, setLastLoadedAt] = useState<Date | null>(null);
  const [lastFailedAt, setLastFailedAt] = useState<Date | null>(null);
  const [lastSseAt, setLastSseAt] = useState<Date | null>(null);
  const [sseError, setSseError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const requestSeqRef = useRef(0);

  const fetchLogs = useCallback(async () => {
    const requestSeq = requestSeqRef.current + 1;
    requestSeqRef.current = requestSeq;
    setLoading(true);
    try {
      const result = await loadLogs(filterParam(filters));
      if (requestSeq !== requestSeqRef.current) return;
      setEntries(result.entries);
      setFacets(result.facets || null);
      setSource(result.source || null);
      setLogFileExists(result.exists ?? true);
      setError(null);
      setLastLoadedAt(new Date());
      setLastFailedAt(null);
    } catch (err) {
      if (requestSeq !== requestSeqRef.current) return;
      setError(err instanceof Error ? err.message : String(err));
      setLastFailedAt(new Date());
    } finally {
      if (requestSeq === requestSeqRef.current) {
        setLoading(false);
      }
    }
  }, [filters, loadLogs]);

  useEffect(() => {
    updateHash(filters);
    fetchLogs();
  }, [filters, fetchLogs]);

  useEffect(() => {
    const onHashChange = () => {
      const next = parseLogsHash();
      setFilters((current) => filtersToHash(current) === filtersToHash(next) ? current : next);
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  useEffect(() => {
    let closed = false;
    let client: SSEClient | null = null;
    try {
      client = createSse();
      const unsubscribe = client.on('*', (_payload: SSEPayload) => {
        if (closed) return;
        setLastSseAt(new Date());
        setSseError(null);
        void fetchLogs();
      });
      client.connect();
      return () => {
        closed = true;
        unsubscribe();
        client?.close();
      };
    } catch (err) {
      setSseError(err instanceof Error ? err.message : String(err));
      return () => {
        closed = true;
        client?.close();
      };
    }
  }, [createSse, fetchLogs]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      void fetchLogs();
    }, 30_000);
    return () => window.clearInterval(timer);
  }, [fetchLogs]);

  useEffect(() => {
    if (autoScroll && typeof bottomRef.current?.scrollIntoView === 'function') {
      bottomRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [entries, autoScroll]);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 20;
    setAutoScroll(atBottom);
  };

  const updateFilter = <K extends keyof LogFilters>(key: K, value: LogFilters[K]) => {
    setFilters((current) => ({ ...current, [key]: value }));
  };

  const toggleLevel = (level: LogLevel) => {
    setFilters((current) => {
      const next = current.levels.includes(level)
        ? current.levels.filter((item) => item !== level)
        : [...current.levels, level].sort((a, b) => LEVEL_LABELS.indexOf(a) - LEVEL_LABELS.indexOf(b));
      return { ...current, levels: next.length > 0 ? next : [level] };
    });
  };

  const toggleRow = (id: string) => {
    setSelectedRow(id);
    setExpandedRows((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const clearFilters = () => setFilters(DEFAULT_FILTERS);

  const refreshStatus = error
    ? `stale since ${formatStatusTime(lastFailedAt)}`
    : lastLoadedAt
      ? `updated ${formatStatusTime(lastLoadedAt)}`
      : 'not loaded';
  const tailStatus = sseError
    ? `tail disconnected: ${sseError}`
    : lastSseAt
      ? `tail event ${formatStatusTime(lastSseAt)}`
      : 'tail connected; no events in this view yet';

  return (
    <div className="view logs-view">
      <div className="view-header logs-header">
        <div>
          <h2>Logs</h2>
          <p className="text-muted">Daemon log rows from {source === 'daemon_log' ? 'daemon_log' : 'stderr fallback'}.</p>
        </div>
        <div className="logs-toolbar">
          <button type="button" className="btn" onClick={fetchLogs} disabled={loading}>
            {loading ? 'Loading...' : 'Refresh'}
          </button>
          <span className={`logs-refresh-status${error ? ' logs-refresh-status--stale' : ''}`}>
            {refreshStatus}
          </span>
          <span className={`logs-refresh-status${sseError ? ' logs-refresh-status--stale' : ''}`}>
            {tailStatus}
          </span>
          <label className="logs-autoscroll-label">
            <input
              type="checkbox"
              checked={autoScroll}
              onChange={(e) => setAutoScroll(e.currentTarget.checked)}
            />
            {' '}Auto-scroll
          </label>
        </div>
      </div>

      <div className="logs-filter-panel" aria-label="Log filters">
        <div className="logs-level-filters" aria-label="Level filters">
          {LEVEL_LABELS.map((level) => (
            <button
              key={level}
              type="button"
              className={`logs-level-chip logs-level-chip--${level}${filters.levels.includes(level) ? ' logs-level-chip--active' : ''}`}
              onClick={() => toggleLevel(level)}
              aria-pressed={filters.levels.includes(level)}
            >
              {level.toUpperCase()}
            </button>
          ))}
        </div>
        <label className="logs-filter-field">
          <span>Subsystem</span>
          <input
            value={filters.subsystem}
            list="logs-subsystems"
            onInput={(e) => updateFilter('subsystem', e.currentTarget.value)}
          />
        </label>
        <label className="logs-filter-field">
          <span>Event</span>
          <input
            value={filters.event}
            list="logs-events"
            onInput={(e) => updateFilter('event', e.currentTarget.value)}
          />
        </label>
        <label className="logs-filter-field logs-filter-field--wide">
          <span>Search</span>
          <input
            value={filters.q}
            placeholder="message, field, or id"
            onInput={(e) => updateFilter('q', e.currentTarget.value)}
          />
        </label>
        <label className="logs-filter-field">
          <span>Related</span>
          <input
            value={filters.related}
            list="logs-related"
            placeholder="issue:abc123 or raw id"
            onInput={(e) => updateFilter('related', e.currentTarget.value)}
          />
        </label>
        <label className="logs-filter-field">
          <span>Since</span>
          <input
            type="datetime-local"
            value={filters.since}
            onInput={(e) => updateFilter('since', e.currentTarget.value)}
          />
        </label>
        <label className="logs-filter-field">
          <span>Until</span>
          <input
            type="datetime-local"
            value={filters.until}
            onInput={(e) => updateFilter('until', e.currentTarget.value)}
          />
        </label>
        <button type="button" className="btn btn--sm" onClick={clearFilters}>Reset</button>
      </div>

      <datalist id="logs-subsystems">
        {(facets?.subsystems || []).map((facet) => <option key={facet.value} value={facet.value} />)}
      </datalist>
      <datalist id="logs-events">
        {(facets?.events || []).map((facet) => <option key={facet.value} value={facet.value} />)}
      </datalist>
      <datalist id="logs-related">
        {(facets?.entity_refs || []).map((facet) => <option key={`${facet.type}:${facet.value}`} value={facetLabel(facet)} />)}
      </datalist>

      <div className="logs-summary">
        <span>{entries.length} shown</span>
        <span>{facets?.latest_ts ? `latest ${formatIsoStatus(facets.latest_ts)}` : 'latest unknown'}</span>
        <span>{facets?.latest_heartbeat_ts ? `reconciler tick ${formatIsoStatus(facets.latest_heartbeat_ts)}` : 'no reconciler tick in filter'}</span>
      </div>

      {error && (
        <div className="logs-error">
          <div>Failed to load logs: {error}</div>
          <div className="logs-error__detail">
            {lastLoadedAt
              ? `Showing entries from the last successful response at ${formatStatusTime(lastLoadedAt)}.`
              : 'No successful log response has loaded in this view yet.'}
          </div>
        </div>
      )}

      {logFileExists === false && (
        <div className="empty-state">
          No structured log source is available yet.
        </div>
      )}

      {logFileExists !== false && (
        <div
          ref={scrollRef}
          className="logs-scroll-region"
          onScroll={handleScroll}
        >
          {entries.length === 0 && !loading && (
            <div className="empty-state">No log entries match the current filters.</div>
          )}
          {entries.map((entry, i) => {
            const id = rowId(entry, i);
            return (
              <LogRow
                key={id}
                entry={entry}
                expanded={expandedRows.has(id)}
                selected={selectedRow === id}
                onToggle={() => toggleRow(id)}
              />
            );
          })}
          <div ref={bottomRef} />
        </div>
      )}
    </div>
  );
}
