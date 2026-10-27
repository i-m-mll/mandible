#!/usr/bin/env bun
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import Database from '../src/sqlite.ts';
import { validateAcceptedReleaseSelection, ACCEPTED_RELEASE_CHECKPOINT } from '../src/accepted-release-selection.ts';

const [requestId, acceptanceId, issue, revision, generation] = process.argv.slice(2);
if (!requestId || !acceptanceId || !issue || !/^\d+$/.test(revision ?? '') || !/^\d+$/.test(generation ?? '')) {
  throw new Error('Usage: bun scripts/stage-accepted-release.mjs <request> <acceptance> <issue> <expected-revision> <expected-custody-generation>');
}
const db = new Database(process.env.MANDIBLE_DB || path.join(process.env.MANDIBLE_HOME || path.join(os.homedir(), '.mandible'), 'mandible.db'), { readonly: true, fileMustExist: true });
let selection;
try {
  const request = db.prepare('SELECT * FROM auth_requests WHERE id = ? OR id LIKE ?').get(requestId, `${requestId}%`);
  const rows = db.prepare('SELECT * FROM auth_candidate_acceptances WHERE id = ? OR id LIKE ?').all(acceptanceId, `${acceptanceId}%`);
  if (!request || !['pending', 'failed'].includes(request.status) || rows.length !== 1) throw new Error('Selection requires an exact mutable request and an unambiguous acceptance.');
  const row = rows[0];
  selection = validateAcceptedReleaseSelection(db, request, { acceptanceId: row.id, reference: JSON.parse(row.result_json ?? 'null')?.receipt }).selection;
} finally { db.close(); }
const result = spawnSync('mandible', ['auth', 'action', 'add', requestId, '--kind', 'checkpoint_add', '--issue', issue,
  '--checkpoint-kind', ACCEPTED_RELEASE_CHECKPOINT, '--checkpoint-payload-json', JSON.stringify(selection),
  '--expected-revision', revision, '--expected-custody-generation', generation, '--json'], { stdio: 'inherit', timeout: 30_000 });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
