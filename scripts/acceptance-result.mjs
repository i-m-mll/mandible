import fs from 'node:fs';
import path from 'node:path';

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
