import fs from 'node:fs';
import path from 'node:path';
import { compactFailure } from './acceptance-failure.mjs';

const DIAGNOSTIC_BYTES = 60 * 1024;
const fits = value => Buffer.byteLength(JSON.stringify(value), 'utf8') <= DIAGNOSTIC_BYTES;
const text = (value, limit) => typeof value === 'string' ? value.slice(0, limit) : undefined;
const slice = (value, limit) => Array.isArray(value) ? value.slice(0, limit) : undefined;
const bindingKeys = ['recordId', 'runId', 'requestId', 'projectId', 'workUnitId', 'pin_sha', 'tree_sha', 'base_sha', 'head_sha', 'started_at'];

/** A bounded diagnostic projection; the release reference identifies the sealed authority. */
export function compactAcceptanceResult(result) {
  const { shipped, ...provenance } = result.provenance ?? {};
  const diagnostic = shipped === undefined ? result : { ...result, truncated: true, provenance };
  if (fits(diagnostic)) return diagnostic;
  const checks = result.checks ?? {};
  const route = checks.route_cost;
  const short = { truncated: true, schema: result.schema, status: result.status, candidate: result.candidate, binding: result.binding, scope: result.scope,
    timing: result.timing, phases: result.phases, warnings: result.warnings, error: text(result.error, 1024), failure: compactFailure(result.failure),
    cleanup_error: text(result.cleanup_error, 512), receipt: text(result.receipt, 512), secondary_errors: slice(result.secondary_errors, 8)?.map(value => text(value, 512)),
    subprocess: result.subprocess,
    checks: { readiness: checks.readiness, desktop_interaction: checks.desktop_interaction, health_coverage: checks.health_coverage,
      startup_trace: checks.startup_trace, installed_verification: checks.installed_verification, daemon_preflight: checks.daemon_preflight,
      log_digest: checks.log_digest, log_bytes: checks.log_bytes, cleanup: checks.cleanup,
      initial_transport_error: checks.initial_transport_error,
      failure_logs: slice(checks.failure_logs, 4)?.map(log => ({ name: text(log?.name, 64), sha256: text(log?.sha256, 64),
        bytes: typeof log?.bytes === 'number' ? log.bytes : undefined, excerpt: typeof log?.excerpt === 'string' ? log.excerpt.slice(-1000) : undefined })),
      route_cost: route ? { complete: route.complete, diagnostic: route.diagnostic, error: text(route.error, 512),
        progress: route.progress, counts: route.counts, pending_confirmations: slice(route.pending_confirmations, 32),
        routes_not_run: slice(route.routes_not_run, 32), source_stderr: typeof route.source_stderr === 'string' ? route.source_stderr.slice(-1000) : undefined } : undefined,
    } };
  if (fits(short)) return short;
  const binding = result.binding && Object.fromEntries(bindingKeys.map(key => [key, key === 'started_at'
    ? (typeof result.binding[key] === 'number' ? result.binding[key] : undefined) : text(result.binding[key], 512)]));
  const minimal = { truncated: true, schema: text(result.schema, 128), status: text(result.status, 16), candidate: text(result.candidate, 64),
    binding, receipt: short.receipt, error: short.error, cleanup_error: short.cleanup_error };
  const withLogs = { ...minimal, checks: { failure_logs: short.checks.failure_logs } };
  return fits(withLogs) ? withLogs : minimal;
}

export function acceptanceResultPath(cache, runId) {
  if (!path.isAbsolute(cache) || !/^[a-zA-Z0-9-]+$/.test(runId ?? '')) throw new Error('Acceptance result requires an absolute cache and exact run identity.');
  return path.join(cache, '.receipts', `${runId}-acceptance.json`);
}

/** Only an exact failed run can supply a primary error after response loss. */
export function readAcceptanceFailure(cache, binding) {
  try {
    const file = acceptanceResultPath(cache, binding.recordId);
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) return { result: null, error: 'Acceptance checkpoint is not a regular file.' };
    const result = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (result.schema !== 'mandible-candidate-acceptance@1' || result.status !== 'failed' || typeof result.error !== 'string' || !result.error.trim()
        || result.candidate !== binding.pin_sha || result.binding?.runId !== binding.recordId
        || !Object.entries(binding).every(([key, value]) => result.binding?.[key] === value)) return { result: null, error: null };
    return { result, error: null };
  } catch (error) {
    return { result: null, error: error.code === 'ENOENT' ? null : error.message };
  }
}
