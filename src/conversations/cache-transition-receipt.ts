import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import SqliteDatabase from '../sqlite.js';
import { CURRENT_CONVERSATION_SOURCE_EPOCHS } from './source-types.js';

export const OBSOLETE_CACHE_SUFFIXES = ['', '-wal', '-shm', '-journal'] as const;
export type CacheFileIdentity = { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number };
export type CacheTransitionReceipt = {
  schema: 'mandible-conversation-cache-transition@1';
  revision: string;
  state: 'coverage-complete';
  ledger: string;
  obsolete: string;
  current: string;
  currentIdentity: { dev: number; ino: number };
  files: Array<{ suffix: typeof OBSOLETE_CACHE_SUFFIXES[number]; identity: CacheFileIdentity | null }>;
};
export function cacheFileIdentity(file: string): CacheFileIdentity | null {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Conversation cache file is not a regular owned file');
    return { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
export function cacheTransitionReceiptPath(current: string): string { return `${current}.transition-v18.json`; }
export function publishCacheTransitionReceipt(ledger: string, obsolete: string, current: string, files = OBSOLETE_CACHE_SUFFIXES.map(suffix => ({ suffix, identity: cacheFileIdentity(`${obsolete}${suffix}`) }))): void {
  const receipt: CacheTransitionReceipt = { schema: 'mandible-conversation-cache-transition@1', revision: randomUUID(),
    state: 'coverage-complete', ledger: path.resolve(ledger), obsolete, current,
    currentIdentity: { dev: fs.statSync(current).dev, ino: fs.statSync(current).ino },
    files };
  const destination = cacheTransitionReceiptPath(current);
  const temporary = `${destination}.${process.pid}.partial`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(receipt), { mode: 0o600 });
    const fd = fs.openSync(temporary, 'r');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, destination);
  } finally { fs.rmSync(temporary, { force: true }); }
}

/** Revalidate ready coverage against the current ledger using read-only WAL snapshots. */
export function validateCacheTransitionCoverage(receipt: CacheTransitionReceipt): void {
  const ledger = new SqliteDatabase(receipt.ledger, { readonly: true, fileMustExist: true });
  let obsolete: SqliteDatabase | undefined;
  let current: SqliteDatabase | undefined;
  try {
    obsolete = new SqliteDatabase(receipt.obsolete, { readonly: true, fileMustExist: true });
    current = new SqliteDatabase(receipt.current, { readonly: true, fileMustExist: true });
    for (const db of [ledger, obsolete, current]) { db.pragma('query_only = ON'); db.exec('BEGIN'); }
    if (current.prepare("SELECT value FROM cache_meta WHERE key = 'schema_version'").get()?.value !== '19'
      || obsolete.prepare("SELECT value FROM cache_meta WHERE key = 'schema_version'").get()?.value !== '18') {
      throw new Error('Conversation cache transition formats differ from the receipt');
    }
    for (const row of ledger.prepare(`SELECT source.conversation_id, source.current_version_id AS source_version_id,
      source.parser_format, source.parser_version, source.normalization_version, source.redaction_epoch, conversation.block_count
      FROM conversation_sources source JOIN conversations conversation ON conversation.id = source.conversation_id
      JOIN conversation_source_versions version ON version.id = source.current_version_id
      WHERE source.availability = 'available' AND version.availability = 'available'
      AND version.generation = 'sealed_sha256' AND source.position_space_id IS NOT NULL
      AND source.parser_format = ? AND source.parser_version = ? AND source.normalization_version = ?
      AND source.redaction_epoch = ?`).iterate(CURRENT_CONVERSATION_SOURCE_EPOCHS.parserFormat,
        CURRENT_CONVERSATION_SOURCE_EPOCHS.parserVersion, CURRENT_CONVERSATION_SOURCE_EPOCHS.normalizationVersion,
        CURRENT_CONVERSATION_SOURCE_EPOCHS.redactionEpoch)) {
      const params = [row.conversation_id, row.source_version_id, row.parser_format, row.parser_version,
        row.normalization_version, row.redaction_epoch, row.block_count];
      const where = 'conversation_id = ? AND source_version_id = ? AND parser_format = ? AND parser_version = ? AND normalization_version = ? AND redaction_epoch = ? AND block_count = ?';
      if (obsolete.prepare(`SELECT 1 FROM cache_conversations WHERE ${where}`).get(...params)
          && !current.prepare(`SELECT 1 FROM cache_conversations WHERE ready = 1 AND ${where}`).get(...params)) {
        throw new Error('Conversation cache ready coverage is incomplete');
      }
    }
  } finally { current?.close(); obsolete?.close(); ledger.close(); }
}
