import fs from 'node:fs';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import SqliteDatabase from '../src/sqlite.js';
import { ConversationCacheTransition, projectLegacyConversationCache } from '../src/conversations/cache-transition.js';
import { getConversationStructureCache, projectConversationCache } from '../src/conversations/structure-cache.js';
import { testRuntimeRoot } from './helpers/runtime-isolation.js';

const cleanups: Array<() => void> = [];
afterEach(() => { for (const close of cleanups.splice(0).reverse()) close(); });
function fixture(count = 3) {
  const root = fs.mkdtempSync(path.join(testRuntimeRoot, 'cache-transition-'));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const ledger = new SqliteDatabase(path.join(root, 'ledger.db'));
  cleanups.push(() => ledger.close());
  ledger.exec(`CREATE TABLE conversations(id TEXT, block_count INTEGER);
    CREATE TABLE conversation_sources(conversation_id TEXT,current_version_id TEXT,parser_format TEXT,parser_version TEXT,
      normalization_version TEXT,redaction_epoch INTEGER,availability TEXT,position_space_id TEXT);
    CREATE TABLE conversation_source_versions(id TEXT,availability TEXT,generation TEXT);
    INSERT INTO conversations VALUES('selected',${count});
    INSERT INTO conversation_sources VALUES('selected','version','provider-jsonl','2','2',0,'available','space');
    INSERT INTO conversation_source_versions VALUES('version','available','sealed_sha256');`);
  const transition = new ConversationCacheTransition(ledger);
  const cache = getConversationStructureCache(ledger);
  cleanups.push(() => cache.close());
  const old = new SqliteDatabase(transition.obsoletePath!);
  cleanups.push(() => old.close());
  old.pragma('journal_mode = WAL');
  old.exec(fs.readFileSync(new URL('./fixtures/conversation-cache-v18.sql', import.meta.url), 'utf8'));
  old.prepare(`INSERT INTO cache_conversations VALUES(1,'selected','version','provider-jsonl','2','2',0,?,0,0)`).run(count);
  old.transaction(() => {
    for (let position = 0; position < count; position++) {
      old.prepare('INSERT INTO cache_blocks VALUES(1,?,0,0,NULL,?,1,?,0,NULL,NULL,NULL,?)').run(position, position, position, position);
      old.prepare('INSERT INTO cache_display_positions VALUES(1,?,?)').run(position, JSON.stringify({ position, revision: 'a'.repeat(64), speaker: 'user', handoffKeys: [] }));
      old.prepare("INSERT INTO cache_display_fragments VALUES(1,?,'content:0',?,'content','user',NULL,?)").run(position, position,
        JSON.stringify({ activity: null, summary_from_source: false, has_details: false, paired_source_positions: [] }));
    }
  })();
  const manifest = { conversation_id: 'selected', source_version_id: 'version', parser_format: 'provider-jsonl', parser_version: '2', normalization_version: '2', redaction_epoch: 0, block_count: count };
  const ready = () => cache.hasCompleteConversation('selected', 'version', count, { parserFormat: 'provider-jsonl', parserVersion: '2', normalizationVersion: '2', redactionEpoch: 0 });
  return { root, ledger, transition, cache, old, manifest, ready };
}

it('keeps interrupted generations unreadable, retries idempotently and projects only selected ready tuples', async () => {
  const f = fixture(600);
  let interrupted = false;
  await expect(f.transition.prepare('selected', async () => {
    expect(f.ready()).toBe(false);
    interrupted = true;
    throw new Error('interrupted');
  })).rejects.toThrow('interrupted');
  expect(interrupted).toBe(true);
  expect(f.ready()).toBe(false);
  await f.transition.prepare('selected', async () => {});
  expect(f.ready()).toBe(true);
  await f.transition.prepare(undefined, async () => {});
  expect(f.cache.stats().blocks).toBe(600);
  const projected = path.join(f.root, 'projection.v19');
  await projectConversationCache(f.cache.cachePath, projected, [f.manifest]);
  const read = new SqliteDatabase(projected, { readonly: true });
  try {
    expect(read.prepare('SELECT count(*) AS count FROM cache_blocks').get().count).toBe(600);
    expect(read.pragma('foreign_key_check')).toEqual([]);
  } finally { read.close(); }
  expect(fs.existsSync(f.transition.obsoletePath!)).toBe(true);
});

it('gives selected conversion priority over a paused background conversion without stale publication', async () => {
  const f = fixture(600);
  let selected = false;
  await f.transition.prepare(undefined, async () => {
    if (selected) return;
    selected = true;
    await f.transition.prepare('selected', async () => {});
    expect(f.ready()).toBe(true);
  });
  expect(f.ready()).toBe(true);
  expect(f.cache.stats().blocks).toBe(600);
});

it('discards a conversion whose source pointer was superseded while yielding', async () => {
  const f = fixture(600);
  await f.transition.prepare('selected', async () => {
    f.ledger.prepare("UPDATE conversation_sources SET current_version_id = 'newer'").run();
  });
  expect(f.ready()).toBe(false);
  expect(f.cache.stats().blocks).toBe(0);
  expect(f.ledger.prepare('SELECT current_version_id FROM conversation_sources').get().current_version_id).toBe('newer');
});

it('projects warmed v18 generations into isolated v19 before the production transition', async () => {
  const f = fixture();
  const projected = path.join(f.root, 'legacy-projection.v19');
  const before = fs.readFileSync(f.transition.obsoletePath!);
  await projectLegacyConversationCache(f.transition.obsoletePath!, projected, f.ledger.name);
  expect(fs.readFileSync(f.transition.obsoletePath!)).toEqual(before);
  const read = new SqliteDatabase(projected, { readonly: true });
  try {
    expect(read.prepare('SELECT count(*) AS count FROM cache_blocks').get().count).toBe(3);
    expect(read.prepare('SELECT count(*) AS count FROM cache_conversations WHERE ready = 1').get().count).toBe(1);
  } finally { read.close(); }
  expect(f.ready()).toBe(false);
});
