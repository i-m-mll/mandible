#!/usr/bin/env bun
import os from 'node:os';
import path from 'node:path';
import Database from '../src/sqlite.ts';
import { readImmutableAcceptedRelease, disposeAcceptedRelease } from './accepted-release.mjs';

const [requestId, acceptanceId, reason] = process.argv.slice(2);
if (!requestId || !acceptanceId || !reason?.trim()) throw new Error('Usage: bun scripts/dispose-accepted-release.mjs <request> <acceptance> <reason>');
const home = path.resolve(process.env.MANDIBLE_HOME || path.join(os.homedir(), '.mandible'));
const db = new Database(process.env.MANDIBLE_DB || path.join(home, 'mandible.db'), { readonly: true, fileMustExist: true });
let reference;
let candidate;
try {
  const requests = db.prepare('SELECT * FROM auth_requests WHERE id = ? OR id LIKE ?').all(requestId, `${requestId}%`);
  const rows = db.prepare('SELECT * FROM auth_candidate_acceptances WHERE id = ? OR id LIKE ?').all(acceptanceId, `${acceptanceId}%`);
  if (requests.length !== 1 || rows.length !== 1
      || rows[0].auth_request_id !== requests[0].id || rows[0].status !== 'passed') throw new Error('Disposal requires the exact passed acceptance of this request.');
  const row = rows[0]; reference = JSON.parse(row.result_json).receipt;
  candidate = Object.fromEntries(['pin_sha', 'tree_sha', 'base_sha', 'head_sha'].map(key => [key, row[key]]));
  readImmutableAcceptedRelease(reference, candidate);
} finally { db.close(); }
process.stdout.write(`${JSON.stringify(await disposeAcceptedRelease(reference, candidate, reason, { home }))}\n`);
