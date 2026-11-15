export const LEGACY_ACCEPTED_RELEASE_SCHEMA = 'mandible-accepted-release@1';
export const ACCEPTANCE_CERTIFICATE_SCHEMA = 'mandible-accepted-release@2';
export const ACCEPTANCE_RECEIPT_CAPABILITY = 'MANDIBLE_ACCEPTANCE_RECEIPT_SCHEMA';
export const ACCEPTANCE_CERTIFICATE_LIMIT = 64 * 1024;
export const ACCEPTANCE_CONTRACT = 'mandible-candidate-acceptance@1';

export function acceptanceReceiptSchema(value) {
  if (value === undefined) return LEGACY_ACCEPTED_RELEASE_SCHEMA;
  if (value === ACCEPTANCE_CERTIFICATE_SCHEMA) return value;
  throw new Error('Unsupported accepted release receipt capability.');
}

const runtimePhases = ['package_build', 'package_verification', 'readiness', 'desktop_interaction', 'health_coverage'];
const gateNames = [...runtimePhases, 'shutdown', 'log_assessment', 'runtime_scratch_cleanup'];
const exactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const natural = value => Number.isSafeInteger(value) && value >= 0;
const sha256 = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const identity = value => typeof value === 'string' && /^[A-Za-z0-9_-]+$/.test(value);
const isExit = value => value === null || natural(value) && value <= 255;
const isSignal = value => value === null || typeof value === 'string' && /^SIG[A-Z0-9]+$/.test(value);
const validSummary = value => {
  const { gates, interaction, health, shutdown } = value;
  return exactKeys(gates, gateNames) && gateNames.every(name => gates[name] === 'passed')
    && exactKeys(interaction, ['completed_at', 'reloads']) && natural(interaction.completed_at) && interaction.reloads === 2
    && exactKeys(health, ['started_at', 'completed_at', 'periodic_windows']) && natural(health.started_at)
    && natural(health.completed_at) && natural(health.periodic_windows)
    && health.started_at <= interaction.completed_at && interaction.completed_at <= health.completed_at
    && exactKeys(shutdown, ['desktop_exit', 'desktop_signal'])
    && isExit(shutdown.desktop_exit) && isSignal(shutdown.desktop_signal)
    && (shutdown.desktop_exit === null) !== (shutdown.desktop_signal === null);
};

export function certifyAcceptance(result) {
  const { desktop_interaction: interaction, desktop_interaction_completed_at: completedAt,
    health_coverage: health, shutdown, log_failures: logs, cleanup } = result.checks;
  if (result.status !== 'passed' || !runtimePhases.every(name => result.phases[name]?.status === 'passed')
      || interaction?.passed !== true || health?.observation.mustCover !== completedAt
      || shutdown?.daemon_exit !== 0 || shutdown.daemon_signal !== null || shutdown.gateway_exit !== 0 || shutdown.gateway_signal !== null
      || !Array.isArray(logs) || logs.length || cleanup?.action !== 'delete-owned' || cleanup.remaining?.length !== 0) {
    throw new Error('Acceptance is missing a completed runtime gate.');
  }
  const summary = { gates: Object.fromEntries(gateNames.map(name => [name, 'passed'])),
    interaction: { completed_at: completedAt, reloads: interaction.setup?.reloads },
    health: { started_at: health.observation.startedAt, completed_at: health.observation.completedAt, periodic_windows: health.periodic_windows_completed },
    shutdown: { desktop_exit: shutdown.desktop_exit, desktop_signal: shutdown.desktop_signal } };
  if (!validSummary(summary)) throw new Error('Acceptance is missing an exact runtime observation.');
  return summary;
}

export function validateAcceptanceCertificate(receipt) {
  if (!exactKeys(receipt, ['schema', 'contract', 'acceptance', 'candidate', 'target', 'package', 'retention', 'manifest_sha256', 'gates', 'interaction', 'health', 'shutdown'])
      || receipt.contract !== ACCEPTANCE_CONTRACT || typeof receipt.target !== 'string' || !/^[a-z0-9]+-[a-z0-9]+$/.test(receipt.target)
      || !exactKeys(receipt.acceptance, ['run_id', 'record_id', 'request_id'])
      || !identity(receipt.acceptance.record_id) || !identity(receipt.acceptance.request_id)
      || receipt.acceptance.record_id !== receipt.acceptance.run_id
      || !exactKeys(receipt.candidate, ['pin_sha', 'tree_sha', 'base_sha', 'head_sha'])
      || !exactKeys(receipt.package, ['custody', 'handle', 'path', 'sha256']) || !sha256(receipt.package.sha256)
      || !exactKeys(receipt.package.handle, ['root', 'runId']) || typeof receipt.package.handle.root !== 'string'
      || !exactKeys(receipt.retention, ['project', 'work_unit']) || !identity(receipt.retention.project) || !identity(receipt.retention.work_unit)
      || !sha256(receipt.manifest_sha256) || !validSummary(receipt)) throw new Error('Invalid accepted release certificate.');
}

export function boundedAcceptanceBytes(value) {
  const bytes = Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
  if (bytes.length > ACCEPTANCE_CERTIFICATE_LIMIT) throw new Error('Accepted release certificate exceeds 64 KiB.');
  return bytes;
}
