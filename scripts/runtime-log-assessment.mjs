const HTTP_STORM_WINDOW_MS = 10_000;
const STORM_LIMIT = 100;

export function assessRuntimeLogs(text) {
  const failures = [];
  const counts = new Map();
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
      const time = Date.parse(row.time);
      if (Number.isFinite(time)) route.times.push(time); else route.untimed++;
    } else {
      counts.set(event, (counts.get(event) || 0) + 1);
    }
    if (row.level === 'error' || ['ingestion_worker_error', 'ingestion_worker_exit', 'ingestion_reconcile_error'].includes(event) || event === 'daemon_event_loop_lag' || /foreign.key|database.*(?:closed|not open)|panic|crash/i.test(line)) { if (failures.length < 20) failures.push(line); }
  }
  if (started > 1) failures.push('Daemon restarted during acceptance');
  for (const [event, count] of counts) if (event && count > STORM_LIMIT) failures.push(`Repeated event storm: ${event} (${count})`);
  const httpRoutes = [];
  for (const [key, route] of routes) {
    route.times.sort((a, b) => a - b);
    let left = 0;
    let peak = 0;
    for (let right = 0; right < route.times.length; right++) {
      while (route.times[right] - route.times[left] > HTTP_STORM_WINDOW_MS) left++;
      peak = Math.max(peak, right - left + 1);
    }
    // Missing timestamps cannot establish a safe request rate. Conservatively
    // include those requests in the busiest observed window for this route.
    peak += route.untimed;
    if (peak > STORM_LIMIT) failures.push(`Repeated request storm: ${key} (${peak} in ${HTTP_STORM_WINDOW_MS}ms)`);
    const { times, ...summary } = route;
    httpRoutes.push({ ...summary, peak_window_count: peak, first: times.length ? new Date(times[0]).toISOString() : null, last: times.length ? new Date(times.at(-1)).toISOString() : null });
  }
  httpRoutes.sort((a, b) => b.peak_window_count - a.peak_window_count || b.count - a.count || `${a.method} ${a.pathname}`.localeCompare(`${b.method} ${b.pathname}`));
  return {
    failures,
    diagnostics: { http_requests: { total: requests, route_count: httpRoutes.length, window_ms: HTTP_STORM_WINDOW_MS, limit: STORM_LIMIT, routes: httpRoutes.slice(0, 20), omitted_routes: Math.max(0, httpRoutes.length - 20) } },
  };
}

export function assessLogs(text) { return assessRuntimeLogs(text).failures; }
