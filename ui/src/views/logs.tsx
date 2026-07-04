// Logs viewer tab — Bug: af91bdd
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { getLogs } from '../api';

export type LogEntry = {
  level: string;
  message: string;
  time?: string;
  [key: string]: unknown;
};

type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<string, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const LEVEL_LABELS: LogLevel[] = ['debug', 'info', 'warn', 'error'];

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
  if (!iso) return '—';
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

function LogRow({ entry }: { entry: LogEntry }): JSX.Element {
  const [expanded, setExpanded] = useState(false);

  // Build "extra" fields: everything except level, message, time
  const extraKeys = Object.keys(entry).filter(
    (k) => k !== 'level' && k !== 'message' && k !== 'time',
  );
  const hasExtra = extraKeys.length > 0;

  const extra: Record<string, unknown> = {};
  for (const k of extraKeys) {
    extra[k] = entry[k];
  }

  return (
    <div className={`log-row log-row--${entry.level ?? 'info'}`}>
      <div className="log-row__main" onClick={() => hasExtra && setExpanded((v) => !v)}>
        <span className="log-row__time">{formatTime(entry.time)}</span>
        <span className={levelClass(entry.level ?? 'info')}>{(entry.level ?? 'info').toUpperCase()}</span>
        <span className="log-row__message">{entry.message}</span>
        {hasExtra && (
          <button
            type="button"
            className="log-row__expand"
            aria-label={expanded ? 'Collapse details' : 'Expand details'}
          >
            {expanded ? '▾' : '▸'}
          </button>
        )}
      </div>
      {expanded && hasExtra && (
        <pre className="log-row__detail">{JSON.stringify(extra, null, 2)}</pre>
      )}
    </div>
  );
}

export function LogsView(): JSX.Element {
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [minLevel, setMinLevel] = useState<LogLevel>('info');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [logFileExists, setLogFileExists] = useState<boolean | null>(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const [lastLoadedAt, setLastLoadedAt] = useState<Date | null>(null);
  const [lastFailedAt, setLastFailedAt] = useState<Date | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const requestSeqRef = useRef(0);

  const fetchLogs = useCallback(async () => {
    const requestSeq = requestSeqRef.current + 1;
    requestSeqRef.current = requestSeq;
    setLoading(true);
    try {
      const result = await getLogs({ level: minLevel, limit: 500 });
      if (requestSeq !== requestSeqRef.current) return;
      setEntries(result.entries);
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
  }, [minLevel]);

  // Initial load and re-fetch whenever the level filter changes
  useEffect(() => {
    fetchLogs();
  }, [fetchLogs]);

  // Periodic refresh every 5 seconds
  useEffect(() => {
    const timer = window.setInterval(() => {
      fetchLogs();
    }, 5_000);
    return () => window.clearInterval(timer);
  }, [fetchLogs]);

  // Auto-scroll to bottom when new entries arrive and auto-scroll is on
  useEffect(() => {
    if (autoScroll && bottomRef.current) {
      bottomRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [entries, autoScroll]);

  // Pause auto-scroll when the user scrolls up
  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 20;
    setAutoScroll(atBottom);
  };

  const filteredByLevel = entries.filter(
    (e) => (LEVEL_ORDER[e.level] ?? 1) >= (LEVEL_ORDER[minLevel] ?? 1),
  );
  const refreshStatus = error
    ? `Stale since ${formatStatusTime(lastFailedAt)}`
    : lastLoadedAt
      ? `Updated ${formatStatusTime(lastLoadedAt)}`
      : 'Not loaded';

  return (
    <div className="view logs-view">
      <div className="view-header">
        <div>
          <h2>Logs</h2>
          <p className="text-muted">Daemon structured log output.</p>
        </div>
        <div className="logs-toolbar">
          <div className="logs-level-filters">
            {LEVEL_LABELS.map((level) => (
              <button
                key={level}
                type="button"
                className={`logs-level-chip logs-level-chip--${level}${minLevel === level ? ' logs-level-chip--active' : ''}`}
                onClick={() => setMinLevel(level)}
              >
                {level.toUpperCase()}
              </button>
            ))}
          </div>
          <button type="button" className="btn" onClick={fetchLogs} disabled={loading}>
            {loading ? 'Loading…' : 'Refresh'}
          </button>
          <span className={`logs-refresh-status${error ? ' logs-refresh-status--stale' : ''}`}>
            {refreshStatus}
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
          Log file not found. Mandible may not have written any structured logs yet.
        </div>
      )}

      {logFileExists !== false && (
        <div
          ref={scrollRef}
          className="logs-scroll-region"
          onScroll={handleScroll}
        >
          {filteredByLevel.length === 0 && !loading && (
            <div className="empty-state">No log entries match the current filter.</div>
          )}
          {filteredByLevel.map((entry, i) => (
            // eslint-disable-next-line react/no-array-index-key
            <LogRow key={`${entry.time ?? ''}-${i}`} entry={entry} />
          ))}
          <div ref={bottomRef} />
        </div>
      )}
    </div>
  );
}
