import fs from 'node:fs';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import SqliteDatabase from '../src/sqlite.js';
import { getConversationStructureCache } from '../src/conversations/structure-cache.js';
import { assertCacheTransitionFileIdentities, cacheFileIdentity, OBSOLETE_CACHE_SUFFIXES, publishCacheInvalidationReceipt, sourceGenerationDigest,
  validateCacheInvalidationReceipt, validateCacheTransitionCoverage, type ConvertedCacheTransitionReceipt } from '../src/conversations/cache-transition-receipt.js';
import { assertNoCacheConsumers } from '../scripts/runtime-handoff.mjs';
import { migratedFileDb } from './helpers/ledger-fixtures.js';
import { testRuntimeRoot } from './helpers/runtime-isolation.js';

const cleanups: Array<() => void> = [];
afterEach(() => { for (const close of cleanups.splice(0).reverse()) close(); });
function fixture(sourceFormat: 18 | 19) {
  const root = fs.mkdtempSync(path.join(testRuntimeRoot, 'cache-invalidation-'));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const ledger = migratedFileDb(path.join(root, 'ledger.db'));
  cleanups.push(() => ledger.close());
  const cache = getConversationStructureCache(ledger);
  cleanups.push(() => cache.close());
  const obsolete = `${ledger.name}.conversation-structure.db.v${sourceFormat}`;
  const old = new SqliteDatabase(obsolete);
  try {
    old.exec(fs.readFileSync(new URL(`./fixtures/conversation-cache-v${sourceFormat}.sql`, import.meta.url), 'utf8'));
    old.prepare(`INSERT INTO cache_conversations
      (cache_id,conversation_id,source_version_id,parser_format,parser_version,normalization_version,redaction_epoch,block_count,updated_at,accessed_at)
      VALUES(1,'selected','version','provider-jsonl','2','2',0,1,0,0)`).run();
  } finally { old.close(); }
  return { root, ledger, cache, obsolete, sourceFormat };
}

it('records incompatibility without converting old facts or changing source custody', () => {
  for (const format of [18, 19] as const) {
    const f = fixture(format);
    const native = path.join(f.root, 'transcript.jsonl');
    fs.writeFileSync(native, 'native source is retained\n');
    const before = [f.obsolete, f.ledger.name, native].map(file => fs.readFileSync(file));
    const receipt = publishCacheInvalidationReceipt(f.ledger.name, f.obsolete, f.cache.cachePath, format);
    expect(receipt.mode).toBe('invalidated');
    expect(receipt).not.toHaveProperty('sourceGenerationDigest');
    expect(f.cache.stats().conversations).toBe(0);
    [f.obsolete, f.ledger.name, native].forEach((file, index) => expect(fs.readFileSync(file)).toEqual(before[index]));
    assertCacheTransitionFileIdentities(receipt);
    fs.renameSync(f.obsolete, `${f.obsolete}.replaced`);
    fs.copyFileSync(`${f.obsolete}.replaced`, f.obsolete);
    expect(() => assertCacheTransitionFileIdentities(receipt)).toThrow();
  }
});

it('preserves unknown schemas and distinguishes recorded covered conversion from invalidation', () => {
  const f = fixture(18);
  const old = new SqliteDatabase(f.obsolete, { readonly: true });
  const current19 = `${f.ledger.name}.conversation-structure.db.v19`;
  const target = new SqliteDatabase(current19);
  let digest: string;
  try {
    target.exec(fs.readFileSync(new URL('./fixtures/conversation-cache-v19.sql', import.meta.url), 'utf8'));
    digest = sourceGenerationDigest(old);
  } finally { target.close(); old.close(); }
  const identity = cacheFileIdentity(current19)!;
  const converted: ConvertedCacheTransitionReceipt = {
    schema: 'mandible-conversation-cache-transition@1', revision: 'recorded', state: 'coverage-complete', targetFormat: 19,
    sourceGenerationDigest: digest, ledger: f.ledger.name, obsolete: f.obsolete, current: current19,
    currentIdentity: { dev: identity.dev, ino: identity.ino },
    files: OBSOLETE_CACHE_SUFFIXES.map(suffix => ({ suffix, identity: cacheFileIdentity(`${f.obsolete}${suffix}`) })),
  };
  expect(() => validateCacheTransitionCoverage(converted)).not.toThrow();
  expect(() => validateCacheInvalidationReceipt(converted as never)).toThrow();
  const foreign = path.join(f.root, 'foreign.db');
  const db = new SqliteDatabase(foreign);
  db.exec('CREATE TABLE unrelated(content TEXT)'); db.close();
  const before = fs.readFileSync(foreign);
  fs.renameSync(f.obsolete, `${f.obsolete}.preserved`);
  fs.copyFileSync(foreign, f.obsolete);
  expect(() => publishCacheInvalidationReceipt(f.ledger.name, f.obsolete, f.cache.cachePath, 18)).toThrow();
  expect(fs.readFileSync(f.obsolete)).toEqual(before);
});

it('refuses retirement while the exact obsolete cache has an open reader', () => {
  const f = fixture(19);
  const fd = fs.openSync(f.obsolete, 'r');
  try { expect(() => assertNoCacheConsumers(f.obsolete)).toThrow(); }
  finally { fs.closeSync(fd); }
  expect(() => assertNoCacheConsumers(f.obsolete)).not.toThrow();
});
