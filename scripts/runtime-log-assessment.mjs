export function assessLogs(text) {
  const failures = [];
  const counts = new Map();
  let started = 0;
  for (const line of text.split('\n').filter(Boolean)) {
    let row;
    try { row = JSON.parse(line); } catch {
      if (/panic|fatal|crash|foreign.key|database.*(?:closed|not open)|event.loop.*(?:stall|starv)/i.test(line)) { if (failures.length < 20) failures.push(line); }
      continue;
    }
    const event = row.message || row.event || '';
    if (event === 'server_started') started++;
    counts.set(event, (counts.get(event) || 0) + 1);
    if (row.level === 'error' || event === 'daemon_event_loop_lag' || /foreign.key|database.*(?:closed|not open)|panic|crash/i.test(line)) { if (failures.length < 20) failures.push(line); }
  }
  if (started > 1) failures.push('Daemon restarted during acceptance');
  for (const [event, count] of counts) if (event && count > 100) failures.push(`Repeated event storm: ${event} (${count})`);
  return failures;
}

