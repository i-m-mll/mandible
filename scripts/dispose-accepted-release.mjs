#!/usr/bin/env bun
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import Database from '../src/sqlite.ts';
import { resolveAcceptedRelease, disposeAcceptedRelease } from './accepted-release.mjs';
import { readRuntimeHandoffLock } from './runtime-handoff-lock.mjs';
import { readBundleOwner } from './bundle-services.mjs';
import { serviceInstallationContext } from './service-definitions.mjs';

const [requestId, acceptanceId, reason] = process.argv.slice(2);
if (!requestId || !acceptanceId || !reason?.trim()) throw new Error('Usage: bun scripts/dispose-accepted-release.mjs <request> <acceptance> <reason>');
const home = path.resolve(process.env.MANDIBLE_HOME || path.join(os.homedir(), '.mandible'));
const db = new Database(process.env.MANDIBLE_DB || path.join(home, 'mandible.db'), { readonly: true, fileMustExist: true });
let reference;
let candidate;
try {
  const requests = db.prepare('SELECT * FROM auth_requests WHERE id = ? OR id LIKE ?').all(requestId, `${requestId}%`);
  const rows = db.prepare('SELECT * FROM auth_candidate_acceptances WHERE id = ? OR id LIKE ?').all(acceptanceId, `${acceptanceId}%`);
  if (requests.length !== 1 || rows.length !== 1 || !['rejected', 'withdrawn', 'superseded', 'expired'].includes(requests[0].status)
      || rows[0].auth_request_id !== requests[0].id || rows[0].status !== 'passed') throw new Error('Only the exact retained package of an abandoned request can be disposed.');
  const row = rows[0]; reference = JSON.parse(row.result_json).receipt;
  candidate = Object.fromEntries(['pin_sha', 'tree_sha', 'base_sha', 'head_sha'].map(key => [key, row[key]]));
  resolveAcceptedRelease(reference, candidate);
  if (readBundleOwner(serviceInstallationContext({ home }))?.acceptedRelease === reference) throw new Error('The installed release still owns these bytes.');
  const lock = readRuntimeHandoffLock(home);
  if (lock?.journalPath && JSON.parse(fs.readFileSync(lock.journalPath, 'utf8')).binding.acceptedRelease?.reference === reference) throw new Error('An unresolved handoff still owns these bytes.');
} finally { db.close(); }
process.stdout.write(`${JSON.stringify(await disposeAcceptedRelease(reference, candidate, reason))}\n`);
