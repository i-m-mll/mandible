const STORM_WINDOW_MS = 10_000;
const STORM_LIMIT = 100;

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

export function assessRuntimeLogs(text) {
  const failures = [];
  const events = new Map();
  const routes = new Map();
  let started = 0;
  let requests = 0;
  for (const line of text.split('\n').filter(Boolean)) {
    let row;
    try { row = JSON.parse(line); } catch {
      if (/panic|fatal|crash|foreign.key|database.*(?:closed|not open)|event.loop.*(?:stall|starv)/i.test(line)) { if (failures.length < 20) failures.push(line); }
      continue;
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
    if (row.level === 'error' || ['ingestion_worker_error', 'ingestion_worker_exit', 'ingestion_reconcile_error'].includes(event) || event === 'daemon_event_loop_lag' || /foreign.key|database.*(?:closed|not open)|panic|crash/i.test(line)) { if (failures.length < 20) failures.push(line); }
  }
  if (started > 1) failures.push('Daemon restarted during acceptance');
  const eventSummaries = [];
  for (const [event, summary] of events) {
    const peak = peakWindow(summary);
    if (peak > STORM_LIMIT) failures.push(`Repeated event storm: ${event} (${peak} in ${STORM_WINDOW_MS}ms)`);
    const { times, ...counts } = summary;
    eventSummaries.push({ ...counts, peak_window_count: peak, first: times.length ? new Date(times[0]).toISOString() : null, last: times.length ? new Date(times.at(-1)).toISOString() : null });
  }
  const httpRoutes = [];
  for (const [key, route] of routes) {
    const peak = peakWindow(route);
    if (peak > STORM_LIMIT) failures.push(`Repeated request storm: ${key} (${peak} in ${STORM_WINDOW_MS}ms)`);
    const { times, ...summary } = route;
    httpRoutes.push({ ...summary, peak_window_count: peak, first: times.length ? new Date(times[0]).toISOString() : null, last: times.length ? new Date(times.at(-1)).toISOString() : null });
  }
  httpRoutes.sort((a, b) => b.peak_window_count - a.peak_window_count || b.count - a.count || `${a.method} ${a.pathname}`.localeCompare(`${b.method} ${b.pathname}`));
  eventSummaries.sort((a, b) => b.peak_window_count - a.peak_window_count || b.count - a.count || a.event.localeCompare(b.event));
  return {
    failures,
    diagnostics: { events: { event_count: eventSummaries.length, window_ms: STORM_WINDOW_MS, limit: STORM_LIMIT, events: eventSummaries.slice(0, 20), omitted_events: Math.max(0, eventSummaries.length - 20) }, http_requests: { total: requests, route_count: httpRoutes.length, window_ms: STORM_WINDOW_MS, limit: STORM_LIMIT, routes: httpRoutes.slice(0, 20), omitted_routes: Math.max(0, httpRoutes.length - 20) } },
  };
}

export function assessLogs(text) { return assessRuntimeLogs(text).failures; }
