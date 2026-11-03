import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import SqliteDatabase from '../sqlite.js';
import { CURRENT_CONVERSATION_SOURCE_EPOCHS } from './source-types.js';

export const OBSOLETE_CACHE_SUFFIXES = ['', '-wal', '-shm', '-journal'] as const;
export const INCOMPATIBLE_CACHE_FORMATS = [18, 19] as const;
export type CacheFileIdentity = { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number };
type ReceiptBinding = {
  revision: string;
  ledger: string;
  obsolete: string;
  current: string;
  currentIdentity: { dev: number; ino: number };
  files: Array<{ suffix: typeof OBSOLETE_CACHE_SUFFIXES[number]; identity: CacheFileIdentity | null }>;
};
export type ConvertedCacheTransitionReceipt = ReceiptBinding & {
  schema: 'mandible-conversation-cache-transition@1';
  state: 'coverage-complete';
  targetFormat: 19;
  sourceGenerationDigest: string;
};
export type InvalidatedCacheTransitionReceipt = ReceiptBinding & {
  schema: 'mandible-conversation-cache-transition@2';
  mode: 'invalidated';
  state: 'invalidated';
  sourceFormat: typeof INCOMPATIBLE_CACHE_FORMATS[number];
  targetFormat: 20;
};
export type CacheTransitionReceipt = ConvertedCacheTransitionReceipt | InvalidatedCacheTransitionReceipt;
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
export function cacheTransitionReceiptPath(current: string, sourceFormat = 18): string { return `${current}.transition-v${sourceFormat}.json`; }

export function incompatibleConversationCachePaths(current: string): Array<{ obsolete: string; current: string; sourceFormat: typeof INCOMPATIBLE_CACHE_FORMATS[number] }> {
  if (!current.endsWith('.v20')) throw new Error('Invalidation requires the enriched conversation cache format');
  const base = current.slice(0, -4);
  return INCOMPATIBLE_CACHE_FORMATS.map(sourceFormat => ({ obsolete: `${base}.v${sourceFormat}`, current, sourceFormat }));
}

export function assertCacheTransitionFileIdentities(receipt: ReceiptBinding): void {
  if (receipt.files.length !== OBSOLETE_CACHE_SUFFIXES.length
      || receipt.files.some((file, index) => file.suffix !== OBSOLETE_CACHE_SUFFIXES[index])) {
    throw new Error('Conversation cache sidecar identities are incomplete');
  }
  const current = cacheFileIdentity(receipt.current);
  if (!current || current.dev !== receipt.currentIdentity.dev || current.ino !== receipt.currentIdentity.ino) {
    throw new Error('Current conversation cache identity changed');
  }
  for (const file of receipt.files) {
    const actual = cacheFileIdentity(`${receipt.obsolete}${file.suffix}`);
    if (actual && JSON.stringify(actual) !== JSON.stringify(file.identity)) throw new Error('Obsolete conversation cache identity changed');
  }
}
export function sourceGenerationDigest(source: SqliteDatabase): string {
  const digest = createHash('sha256');
  for (const row of source.prepare(`SELECT cache_id,conversation_id,source_version_id,parser_format,parser_version,
    normalization_version,redaction_epoch,block_count FROM cache_conversations ORDER BY cache_id`).iterate()) {
    digest.update(JSON.stringify(row));
  }
  return digest.digest('hex');
}
/** The runtime cleanup owner records incompatibility only after qualifying its current runtime and old consumers. */
export function publishCacheInvalidationReceipt(ledger: string, obsolete: string, current: string,
  sourceFormat: typeof INCOMPATIBLE_CACHE_FORMATS[number]): InvalidatedCacheTransitionReceipt {
  const files = OBSOLETE_CACHE_SUFFIXES.map(suffix => ({ suffix, identity: cacheFileIdentity(`${obsolete}${suffix}`) }));
  const currentIdentity = cacheFileIdentity(current);
  if (!files[0].identity || !currentIdentity) throw new Error('Cache invalidation requires both exact cache files');
  const receipt: InvalidatedCacheTransitionReceipt = { schema: 'mandible-conversation-cache-transition@2',
    mode: 'invalidated', state: 'invalidated', revision: randomUUID(), sourceFormat, targetFormat: 20,
    ledger: path.resolve(ledger), obsolete: path.resolve(obsolete), current: path.resolve(current),
    currentIdentity: { dev: currentIdentity.dev, ino: currentIdentity.ino }, files };
  validateCacheInvalidationReceipt(receipt);
  assertCacheTransitionFileIdentities(receipt);
  const destination = cacheTransitionReceiptPath(current, sourceFormat);
  const temporary = `${destination}.${process.pid}.partial`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(receipt), { mode: 0o600 });
    const fd = fs.openSync(temporary, 'r');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, destination);
  } finally { fs.rmSync(temporary, { force: true }); }
  return receipt;
}

export function validateCacheInvalidationReceipt(receipt: InvalidatedCacheTransitionReceipt): void {
  const exact = incompatibleConversationCachePaths(receipt.current).find(item => item.sourceFormat === receipt.sourceFormat);
  if (receipt.schema !== 'mandible-conversation-cache-transition@2' || receipt.mode !== 'invalidated'
      || receipt.state !== 'invalidated' || receipt.targetFormat !== 20 || exact?.obsolete !== receipt.obsolete) {
    throw new Error('Cache invalidation formats or paths differ from the receipt');
  }
  const obsolete = new SqliteDatabase(receipt.obsolete, { readonly: true, fileMustExist: true });
  let current: SqliteDatabase | undefined;
  try {
    current = new SqliteDatabase(receipt.current, { readonly: true, fileMustExist: true });
    for (const db of [obsolete, current]) { db.pragma('query_only = ON'); db.exec('BEGIN'); }
    if (obsolete.prepare("SELECT value FROM cache_meta WHERE key = 'schema_version'").get()?.value !== String(receipt.sourceFormat)
      || current.prepare("SELECT value FROM cache_meta WHERE key = 'schema_version'").get()?.value !== '20') {
      throw new Error('Cache invalidation schema identity changed');
    }
    for (const db of [obsolete, current]) {
      db.prepare('SELECT cache_id, conversation_id, source_version_id FROM cache_conversations LIMIT 0').all();
      db.prepare('SELECT cache_conversation_id, position FROM cache_blocks LIMIT 0').all();
    }
    const next = cacheFileIdentity(receipt.current);
    if (!next || next.dev !== receipt.currentIdentity.dev || next.ino !== receipt.currentIdentity.ino) {
      throw new Error('Current conversation cache identity changed');
    }
  } finally { current?.close(); obsolete.close(); }
}

/** Revalidate ready coverage against the current ledger using read-only WAL snapshots. */
export function validateCacheTransitionCoverage(receipt: ConvertedCacheTransitionReceipt): void {
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
    if (sourceGenerationDigest(obsolete) !== receipt.sourceGenerationDigest) throw new Error('Obsolete source-generation coverage identity changed');
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
