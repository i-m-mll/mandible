import { spawnSync } from 'node:child_process';

export const TIMING_LIMITS = { wallMs: 60_000, fileMs: 25_000, sumMs: 600_000 };

export function checkoutState(cwd = process.cwd()) {
  const status = spawnSync('git', ['status', '--porcelain', '--untracked-files=all'], {
    cwd, encoding: 'utf8', timeout: 5_000,
  });
  if (status.error || status.status !== 0) {
    return { ok: false, error: status.error?.message ?? (status.stderr.trim() || `exit ${status.status}`) };
  }
  return { ok: true, entries: status.stdout.split('\n').filter(Boolean) };
}

export function checkoutViolation(before, after) {
  if (!before.ok) return `cannot read checkout state at run start: ${before.error}`;
  if (!after.ok) return `cannot read checkout state at run end: ${after.error}`;
  const start = new Set(before.entries);
  const end = new Set(after.entries);
  const changes = [
    ...after.entries.filter((entry) => !start.has(entry)).map((entry) => `+ ${entry}`),
    ...before.entries.filter((entry) => !end.has(entry)).map((entry) => `- ${entry}`),
  ];
  return changes.length === 0 ? null :
    `the run changed the checkout; tests must write only under their own temp root ` +
    `(testRuntimeRoot in test/helpers/runtime-isolation.ts):\n${changes.map((c) => `        ${c}`).join('\n')}`;
}

/** Finish after child supervision and private-root cleanup, charging overhead once. */
export function completeTimingPacket(packet, command, lifecycles, absolute) {
  const byFile = new Map();
  const workerIds = new Set();
  for (const receipt of lifecycles) {
    if (receipt.status !== 'complete' || !receipt.file || !receipt.environment || !receipt.worker_id || workerIds.has(receipt.worker_id) || byFile.has(receipt.file)) {
      throw new Error('Incomplete, failed, or duplicate isolated-worker timing receipt.');
    }
    if (!Number.isFinite(receipt.start_ms) || !Number.isFinite(receipt.end_ms) || receipt.end_ms < receipt.start_ms) {
      throw new Error('Invalid worker lifecycle interval.');
    }
    workerIds.add(receipt.worker_id);
    byFile.set(receipt.file, receipt);
  }
  const files = packet.files.map((file) => {
    const receipt = byFile.get(file.absolute_file);
    if (!receipt) throw new Error(`Missing completed worker lifecycle for ${file.file}.`);
    byFile.delete(file.absolute_file);
    const occupancy = receipt.end_ms - receipt.start_ms;
    const { absolute_file, ...diagnostic } = file;
    return { ...diagnostic, environment: receipt.environment, occupancy_ms: occupancy,
      unattributed_lifecycle_ms: occupancy - file.diagnostic_occupancy_ms };
  }).sort((a, b) => b.occupancy_ms - a.occupancy_ms);
  if (byFile.size) throw new Error('Worker lifecycle inventory does not match the reported test files.');

  let unionMs = 0;
  let start;
  let end;
  for (const interval of [...lifecycles].sort((a, b) => a.start_ms - b.start_ms)) {
    if (start === undefined) { start = interval.start_ms; end = interval.end_ms; }
    else if (interval.start_ms <= end) end = Math.max(end, interval.end_ms);
    else { unionMs += end - start; start = interval.start_ms; end = interval.end_ms; }
  }
  if (start !== undefined) unionMs += end - start;
  if (unionMs > command.wall_ms) throw new Error('Worker lifecycle union exceeds the measured runner wall.');
  const events = lifecycles.flatMap((i) => [[i.start_ms, 1], [i.end_ms, -1]]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let live = 0;
  let peak = 0;
  for (const [, delta] of events) { live += delta; peak = Math.max(peak, live); }
  const fileSum = files.reduce((sum, file) => sum + file.occupancy_ms, 0);
  const overheadMs = command.wall_ms - unionMs;
  const sumMs = fileSum + overheadMs;
  const violations = [...packet.violations];
  const slowest = files[0];
  const second = files[1];
  if (second && slowest.occupancy_ms > 30_000 && slowest.occupancy_ms > 2 * second.occupancy_ms) {
    violations.push(`${slowest.file} exceeds 30s and twice the next file's lifecycle; reduce its work or split independent contracts.`);
  }
  if (absolute) for (const file of files) {
    if (file.occupancy_ms > TIMING_LIMITS.fileMs) violations.push(`${file.file} exceeds the 25.00s per-file lifecycle budget.`);
  }
  if (absolute && sumMs > TIMING_LIMITS.sumMs) {
    violations.push(`sum of occupancies including shared command work ${(sumMs / 1000).toFixed(2)}s exceeds the 600.00s budget.`);
  }
  if (absolute && command.wall_ms > TIMING_LIMITS.wallMs) {
    violations.push(`command wall ${(command.wall_ms / 1000).toFixed(2)}s exceeds the 60.00s budget.`);
  }
  return {
    ...packet,
    wall_ms: command.wall_ms,
    wall_scope: 'Runner initialization before runtime qualification through supervised child settlement, private-root cleanup, and final checkout verification; use an external timer for full shell command startup and exit.',
    sum_ms: sumMs,
    file_sum_ms: fileSum,
    lifecycle_union_ms: unionMs,
    peak_live_workers: peak,
    shared_ms: overheadMs,
    files,
    command,
    violations,
  };
}
