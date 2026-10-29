// Repeated non-HTTP events retain their storm policy. HTTP route rates aggregate
// independent callers and describe traffic volume, not proof of a failed update.
const STORM_WINDOW_MS = 10_000;
const STORM_LIMIT = 100;
// Performance signals: recorded in diagnostics.health_events, never failures.
// Each caller decides whether they are fatal.
const HEALTH_EVENTS = new Set([
  'daemon_event_loop_lag',
  'daemon_event_loop_stall',
  'daemon_memory_warning',
]);
const MAX_RETAINED_HEALTH_EVENTS = 20;

function recordTime(summary, row) {
  const time = Date.parse(row.time);
  if (Number.isFinite(time)) summary.times.push(time); else summary.untimed++;
}

function peakWindow(summary) {
  summary.times.sort((a, b) => a - b);
  let left = 0;
  let peak = 0;
  for (let right = 0; right < summary.times.length; right++) {
    while (summary.times[right] - summary.times[left] > STORM_WINDOW_MS) left++;
    peak = Math.max(peak, right - left + 1);
  }
  // Untimed entries cannot establish a safe rate. Include them in the busiest
  // observed window for this event or route.
  return peak + summary.untimed;
}

export function assessRuntimeLogs(text, context) {
  const assessor = createRuntimeLogAssessor(context);
  for (const line of text.split('\n')) assessor.add(line);
  return assessor.finish();
}

/** Incremental form of assessRuntimeLogs, for logs read in chunks. */
export function createRuntimeLogAssessor({ process: source, shutdown } = {}) {
  const failures = [];
  const healthEvents = [];
  let healthEventCount = 0;
  let hardFailureCount = 0;
  const events = new Map();
  const routes = new Map();
  let started = 0;
  let requests = 0;
  const ownedShutdown = source?.owned === true && source.role === 'gateway' && Number.isInteger(source.pid) && source.pid > 0
    && shutdown?.pid === source.pid && shutdown.signal === 'SIGTERM' && shutdown.exitCode === 0 && shutdown.exitSignal === null
    && Number.isFinite(shutdown.requestedAt) && Number.isFinite(shutdown.exitedAt) && shutdown.exitedAt >= shutdown.requestedAt
    && Number.isFinite(shutdown.graceSeconds) && shutdown.graceSeconds > 0;
  let signalAt = null, graceAt = null, completedAt = null;
  let lastCutoffAt = 0, cutoffCount = 0;
  const cutoffs = [];
  const recordHealth = entry => {
    healthEventCount++;
    if (healthEvents.length < MAX_RETAINED_HEALTH_EVENTS) healthEvents.push(entry);
  };
  const add = line => {
    if (!line) return;
    let row;
    try { row = JSON.parse(line); } catch {
      if (/panic|fatal|crash|foreign.key|database.*(?:closed|not open)/i.test(line)) { if (failures.length < 20) failures.push(line); }
      else if (/event.loop.*(?:stall|starv)/i.test(line)) recordHealth({ line: line.slice(0, 500) });
      return;
    }
    const time = Number.isFinite(row.ts) ? row.ts * 1000 : NaN;
    if (ownedShutdown && time >= shutdown.requestedAt && time <= shutdown.exitedAt + 1) {
      if (row.level === 'info' && row.msg === 'shutting down apps, then terminating' && row.signal === 'SIGTERM') signalAt = time;
      if (signalAt !== null && row.level === 'info' && row.logger === 'http'
          && row.msg === 'servers shutting down; grace period initiated' && row.duration === shutdown.graceSeconds && time >= signalAt) graceAt = time;
      if (graceAt !== null && row.level === 'info' && row.msg === 'shutdown complete' && row.signal === 'SIGTERM'
          && row.exit_code === 0 && time >= graceAt) completedAt = time;
    }
    const event = row.message || row.event || '';
    if (event === 'server_started') started++;
    if (event === 'http_request' && typeof row.method === 'string' && typeof row.pathname === 'string') {
      requests++;
      const key = `${row.method} ${row.pathname}`;
      let route = routes.get(key);
      if (!route) { route = { method: row.method, pathname: row.pathname, count: 0, statuses: {}, times: [], untimed: 0 }; routes.set(key, route); }
      route.count++;
      route.statuses[String(row.status ?? 'unknown')] = (route.statuses[String(row.status ?? 'unknown')] || 0) + 1;
      recordTime(route, row);
    } else if (event) {
      let summary = events.get(event);
      if (!summary) { summary = { event, count: 0, times: [], untimed: 0 }; events.set(event, summary); }
      summary.count++;
      recordTime(summary, row);
    }
    if (HEALTH_EVENTS.has(event)) {
      const occurredAt = Date.parse(row.time);
      recordHealth({
        event,
        time: Number.isFinite(occurredAt) ? new Date(occurredAt).toISOString() : null,
        ...(Number.isFinite(row.p95_ms) ? { p95_ms: row.p95_ms } : {}),
        ...(Number.isFinite(row.max_ms) ? { max_ms: row.max_ms } : {}),
        ...(Number.isFinite(row.rss_fraction) ? { rss_fraction: row.rss_fraction } : {}),
      });
    }
    const hardFault = /foreign.key|database.*(?:closed|not open)|panic|crash/i.test(line);
    if (ownedShutdown && !hardFault && completedAt === null && graceAt !== null && time >= graceAt + shutdown.graceSeconds * 1000
        && time <= shutdown.exitedAt + 1 && row.level === 'error' && row.logger === 'http' && row.msg === 'server shutdown'
        && row.error === `server graceful shutdown ${shutdown.graceSeconds}s timeout`
        && Array.isArray(row.addresses) && row.addresses.length > 0 && row.addresses.every(address => typeof address === 'string' && address.length > 0)) {
      cutoffCount++;
      lastCutoffAt = Math.max(lastCutoffAt, time);
      if (cutoffs.length < 20) cutoffs.push({ line, row });
    } else if (row.level === 'error' || ['ingestion_worker_error', 'ingestion_worker_exit', 'ingestion_reconcile_error'].includes(event) || hardFault) { hardFailureCount++; if (failures.length < 20) failures.push(line); }
  };
  const finish = () => {
    const boundedShutdown = cutoffCount > 0 && completedAt !== null && completedAt >= lastCutoffAt;
    if (!boundedShutdown && cutoffCount > 0) {
      hardFailureCount += cutoffCount;
      failures.push(...cutoffs.slice(0, Math.max(0, 20 - failures.length)).map(entry => entry.line));
    }
    if (started > 1) { hardFailureCount++; failures.push('Daemon restarted during acceptance'); }
    const eventSummaries = [];
    for (const [event, summary] of events) {
      const peak = peakWindow(summary);
      if (peak > STORM_LIMIT) { hardFailureCount++; failures.push(`Repeated event storm: ${event} (${peak} in ${STORM_WINDOW_MS}ms)`); }
      const { times, ...counts } = summary;
      eventSummaries.push({ ...counts, peak_window_count: peak, first: times.length ? new Date(times[0]).toISOString() : null, last: times.length ? new Date(times.at(-1)).toISOString() : null });
    }
    const httpRoutes = [];
    for (const route of routes.values()) {
      const peak = peakWindow(route);
      const { times, ...summary } = route;
      httpRoutes.push({ ...summary, peak_window_count: peak, first: times.length ? new Date(times[0]).toISOString() : null, last: times.length ? new Date(times.at(-1)).toISOString() : null });
    }
    httpRoutes.sort((a, b) => b.peak_window_count - a.peak_window_count || b.count - a.count || `${a.method} ${a.pathname}`.localeCompare(`${b.method} ${b.pathname}`));
    eventSummaries.sort((a, b) => b.peak_window_count - a.peak_window_count || b.count - a.count || a.event.localeCompare(b.event));
    return {
      failures,
      diagnostics: { hard_failure_count: hardFailureCount,
        ...(boundedShutdown ? { gateway_shutdown: { pid: source.pid, signal: shutdown.signal, grace_seconds: shutdown.graceSeconds,
          requested_at: shutdown.requestedAt, exited_at: shutdown.exitedAt, exit_code: shutdown.exitCode,
          signal_at: signalAt, grace_started_at: graceAt, completed_at: completedAt,
          cutoff_errors: cutoffs.map(entry => entry.row), omitted: cutoffCount - cutoffs.length } } : {}),
        health_events: { retained: healthEvents, omitted: healthEventCount - healthEvents.length }, events: { event_count: eventSummaries.length, window_ms: STORM_WINDOW_MS, limit: STORM_LIMIT, events: eventSummaries.slice(0, 20), omitted_events: Math.max(0, eventSummaries.length - 20) }, http_requests: { total: requests, route_count: httpRoutes.length, window_ms: STORM_WINDOW_MS, routes: httpRoutes.slice(0, 20), omitted_routes: Math.max(0, httpRoutes.length - 20) } },
    };
  };
  return { add, finish };
}
