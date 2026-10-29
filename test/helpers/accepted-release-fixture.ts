import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import type { CandidateAcceptanceCandidate } from '../../src/candidate-acceptance.js';
import { createOwnedRun } from '../../scripts/owned-run.mjs';

/** Bounded receipt/evidence fixture for metadata-only approval checks. Package
 * byte verification has its own real retained-app fixture in accepted-release.test. */
export function acceptedReleaseReceiptFixture(root: string, candidate: CandidateAcceptanceCandidate,
  acceptance: { record_id: string | null; request_id: string | null } = { record_id: null, request_id: null }, workUnit = 'fixture') {
  const runId = randomUUID();
  const evidence = path.join(root, `${runId}-evidence.json`);
  const evidenceBytes = JSON.stringify({ status: 'passed', candidate: candidate.pin_sha });
  fs.mkdirSync(path.join(root, '.receipts'), { recursive: true });
  const runRoot = path.join(fs.realpathSync(root), runId);
  fs.mkdirSync(runRoot);
  const ownership = createOwnedRun({ root: runRoot, runId, instanceId: 'fixture',
    project: 'fixture', workUnit, outputs: [{ path: 'Mandible.app', kind: 'deliverable' }] });
  fs.writeFileSync(path.join(runRoot, 'metadata.json'), JSON.stringify({ ownership }));
  fs.writeFileSync(evidence, evidenceBytes);
  const file = path.join(fs.realpathSync(root), '.receipts', `${runId}-accepted-release.json`);
  const bytes = JSON.stringify({ schema: 'mandible-accepted-release@1', candidate,
    acceptance: { ...acceptance, run_id: runId }, retention: { project: 'fixture', work_unit: workUnit },
    package: { custody: 'owned-run', path: 'Mandible.app', handle: { root: runRoot, runId } },
    evidence: { receipt: evidence, sha256: createHash('sha256').update(evidenceBytes).digest('hex') } });
  fs.writeFileSync(file, bytes);
  return `accepted-release:${createHash('sha256').update(bytes).digest('hex')}:${Buffer.from(file).toString('base64url')}`;
}
