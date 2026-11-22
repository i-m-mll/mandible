import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Db } from '../db.js';
import { getSpace } from '../ledger/spaces.js';
import { spaceDocTree } from './export.js';
import { SPACE_DOCUMENT_SCHEMA_SQL } from './document-schema.js';
import { documentFromBlocks, parseSpaceSource } from './document-source.js';
import { orderSpaceSource, writeSpaceDocument } from './document-store.js';
import { readLegacySpaceBlocks, type SpaceBlockRow } from './legacy-blocks.js';
import { exportDocument } from './serialize.js';

export type SpaceCutoverReport = {
  spaces: number;
  blocks: number;
  liveEmbeds: number;
  history: number;
  publications: number;
  largest: { id: string; bytes: number } | null;
};

export function convertSpaceDocuments(db: Db, mode: 'apply' | 'dry-run'): SpaceCutoverReport {
  const convert = db.transaction(() => {
    const ids = db.prepare('SELECT id FROM spaces ORDER BY id').all() as { id: string }[];
    const rows = db.prepare('SELECT * FROM space_blocks WHERE space_id=? ORDER BY sort_key,id');
    const foreign = db.prepare('PRAGMA foreign_key_check');
    const before = new Set(foreign.all().map(row => JSON.stringify(row)));
    const count = (table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    const report: SpaceCutoverReport = {
      spaces: ids.length, blocks: 0, liveEmbeds: 0, history: count('space_document_history'),
      publications: count('space_publications'), largest: null,
    };
    for (const sql of SPACE_DOCUMENT_SCHEMA_SQL) db.exec(sql);
    const oldAddresses: string[] = [];
    const checkpoint = db.prepare(`INSERT INTO space_document_history
      (id,space_id,kind,content,blocks_json,provenance_json,created_at)
      VALUES (?,?,'pre-text-storage',?,?,'{}',?)`);
    for (const { id } of ids) {
      try {
        const space = getSpace(db, id)!;
        const legacy = readLegacySpaceBlocks(db, id);
        const originals = rows.all(id) as SpaceBlockRow[];
        const source = documentFromBlocks(legacy);
        const parsed = orderSpaceSource(parseSpaceSource(id, source, 0));
        if (parsed.length !== legacy.length) throw new Error(`expected ${legacy.length} blocks, parsed ${parsed.length}`);
        for (let index = 0; index < legacy.length; index++) {
          const old = legacy[index], next = parsed[index].block;
          for (const key of Object.keys(old) as Array<keyof typeof old>) {
            if (JSON.stringify(old[key]) !== JSON.stringify(next[key])) {
              throw new Error(`block ${old.id} differs on ${key}`);
            }
          }
        }
        const frozen = exportDocument(spaceDocTree(space, legacy));
        if (frozen !== exportDocument(spaceDocTree(space, parsed.map(span => span.block)))) {
          throw new Error('v1 export bytes differ');
        }
        writeSpaceDocument(db, id, { source, generation: 0 }, parsed);
        if (legacy.length) checkpoint.run(`pre-text-storage:${id}`, id, frozen, JSON.stringify(originals), Date.now());
        const bytes = Buffer.byteLength(source);
        if (!report.largest || bytes > report.largest.bytes) report.largest = { id, bytes };
        for (const block of legacy) oldAddresses.push(block.id);
        report.blocks += legacy.length;
        report.liveEmbeds += legacy.filter(block => block.item_id !== null).length;
      } catch (error) {
        throw new Error(`Spaces migration failed for ${id}: ${error instanceof Error ? error.message : error}`, { cause: error });
      }
    }
    if (report.blocks !== count('space_blocks')) throw new Error('Spaces migration found blocks outside a Space');
    if (count('space_document_addresses') !== report.blocks) throw new Error('Spaces migration address inventory differs');
    // Remove children first so dropping the legacy self-FK cannot hit SQLite's cascade depth limit.
    const remove = db.prepare('DELETE FROM space_blocks WHERE id=?');
    for (let index = oldAddresses.length - 1; index >= 0; index--) remove.run(oldAddresses[index]);
    db.exec('DROP TABLE space_blocks');
    if (foreign.all().some(row => !before.has(JSON.stringify(row)))) throw new Error('Spaces migration introduced foreign-key violations');
    return report;
  });
  if (mode === 'apply') return convert();
  let report: SpaceCutoverReport | undefined;
  const rollback = new Error('Spaces conversion dry run');
  try {
    db.transaction(() => { report = convert(); throw rollback; })();
  } catch (error) {
    if (error !== rollback) throw error;
  }
  return report!;
}

export function backupBeforeSpaceCutover(db: Db): void {
  if (db.name === ':memory:') return;
  const directory = path.join(path.dirname(path.resolve(db.name)), 'backups');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const timestamp = new Date().toISOString().replaceAll(':', '-');
  const backup = path.join(directory, `before-spaces-text-${timestamp}-${crypto.randomUUID()}.db`);
  db.backupBeforeMigration(backup);
}
