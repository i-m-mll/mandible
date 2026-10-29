#!/usr/bin/env bun
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import Database from '../src/sqlite.ts';
import { reconcileGeneratedScratch, scratchCursors, restoreScratchCursors } from './generated-scratch.mjs';
import { reconcileAcceptedReleases, releaseCursors, restoreReleaseCursors } from './accepted-release-retention.mjs';
import { withOwnedRunLock, finalizeOwnedRun, saveOwnedMetadata, ownedRunIdentityMatches } from './owned-run.mjs';

export async function generatedStorage({ home, cache, db, apply = false, limit = 8, cursors, until = Date.now() + 5000 }) {
  restoreScratchCursors(cursors?.scratch); restoreReleaseCursors(cursors?.releases);
  const scratch = [];
  for (const name of ['acceptance', 'route-cost-sweep']) scratch.push(...await reconcileGeneratedScratch(path.join(cache, name), { apply, limit, until }));
  const releases = await reconcileAcceptedReleases(db, home, { apply, limit, until });
  return { apply, scratch, releases, cursors: { scratch: scratchCursors(), releases: releaseCursors() } };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { home: { type: 'string' }, db: { type: 'string' }, cache: { type: 'string' },
    apply: { type: 'boolean', default: false }, limit: { type: 'string', default: '8' }, cursor: { type: 'string' },
    retain: { type: 'string' }, release: { type: 'string' }, reason: { type: 'string' }, 'review-by': { type: 'string' }, help: { type: 'boolean' } } });
  if (values.help) {
    console.log('Usage: bun scripts/generated-storage.mjs [--apply] [--home <path>] [--db <path>] [--cache <path>] [--limit <1-1000>] [--cursor <json>]\nInventory is read-only by default. Investigation: --apply --retain <metadata.json> --reason <need> --review-by <ISO-date>; release: --apply --release <metadata.json> --reason <resolution>.');
    process.exit(0);
  }
  const limit = Number(values.limit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error('Limit must be between 1 and 1000.');
  if (values.retain || values.release) {
    if (!values.apply || !values.reason?.trim() || values.retain && values.release) throw new Error('Investigation changes require --apply, one --retain/--release metadata path and --reason.');
    const file = path.resolve(values.retain || values.release);
    const result = await withOwnedRunLock(path.dirname(file), () => {
      const metadata = JSON.parse(fs.readFileSync(file, 'utf8'));
      const { ownership } = metadata;
      if (values.release && ownership.state !== 'investigating') throw new Error('Only an explicitly retained investigation can be released.');
      if (values.release) {
        if (!ownedRunIdentityMatches(path.dirname(file), ownership)) throw new Error('Investigation root identity changed.');
        ownership.state = ownership.investigation.priorState ?? 'creating';
        ownership.investigation = { ...ownership.investigation, releasedAt: new Date().toISOString(), releaseReason: values.reason };
        ownership.revision += 1;
        saveOwnedMetadata(file, metadata);
        return metadata;
      }
      if (!ownership.workUnit) throw new Error('Retained investigation requires an existing work-unit owner; use route sweep --keep with --project and --work-unit.');
      return finalizeOwnedRun(file, { expectedRevision: ownership.revision, outcome: 'investigating', summary: values.reason, reviewBy: values['review-by'] });
    }, { recoverStale: true });
    console.log(JSON.stringify(result));
  } else {
    const home = path.resolve(values.home || process.env.MANDIBLE_HOME || path.join(os.homedir(), '.mandible'));
    const cache = path.resolve(values.cache || path.join(os.homedir(), '.cache/mandible'));
    const db = new Database(values.db || process.env.MANDIBLE_DB || path.join(home, 'mandible.db'), { readonly: !values.apply, fileMustExist: true });
    try { console.log(JSON.stringify(await generatedStorage({ home, cache, db, apply: values.apply, limit, cursors: values.cursor ? JSON.parse(values.cursor) : undefined }))); }
    finally { db.close(); }
  }
}
