import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import SqliteDatabase from '../src/sqlite.js';
import { ConversationCacheTransition } from '../src/conversations/cache-transition.js';
import { getConversationStructureCache } from '../src/conversations/structure-cache.js';
import { displayFragmentId } from '../src/conversations/display-context.js';
import { CURRENT_CONVERSATION_SOURCE_EPOCHS } from '../src/conversations/source-types.js';

const [input, output] = process.argv.slice(2);
if (!input || !output || !path.isAbsolute(input) || !path.isAbsolute(output)) throw new Error('Usage: measure-cache-transition.ts <absolute-v18-input> <private-output-directory>');
fs.mkdirSync(output, { recursive: true });
const source = new SqliteDatabase(input, { readonly: true, fileMustExist: true });
const ledger = new SqliteDatabase(path.join(output, 'measurement-ledger.db'));
const cache = getConversationStructureCache(ledger);
const transition = new ConversationCacheTransition(ledger, { obsoletePath: input, sourceSnapshot: source });
const footprint = (file: string) => Object.fromEntries(['', '-wal', '-shm'].map(suffix => {
  try { const s = fs.statSync(file + suffix); return [suffix || 'main', { bytes: s.size, allocated: s.blocks * 512 }]; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [suffix || 'main', { bytes: 0, allocated: 0 }]; throw error; }
}));
const size = (file: string) => Object.values(footprint(file)).reduce((sum, entry) => sum + entry.bytes, 0);
const start = performance.now();
let peakTarget = size(cache.cachePath);
let peakInput = size(input);
let converted = 0;
let rows = 0;
let closed = false;
try {
  source.pragma('query_only = ON'); source.exec('BEGIN');
  const e = CURRENT_CONVERSATION_SOURCE_EPOCHS;
  const manifests = source.prepare(`SELECT * FROM cache_conversations WHERE parser_format=? AND parser_version=?
    AND normalization_version=? AND redaction_epoch=? ORDER BY cache_id`).all(e.parserFormat, e.parserVersion, e.normalizationVersion, e.redactionEpoch);
  const corpusDigest = createHash('sha256').update(JSON.stringify(manifests)).digest('hex');
  const before = footprint(input);
  ledger.exec(`CREATE TABLE IF NOT EXISTS conversations(id TEXT PRIMARY KEY,block_count INTEGER);
    CREATE TABLE IF NOT EXISTS conversation_sources(conversation_id TEXT PRIMARY KEY,current_version_id TEXT,parser_format TEXT,
      parser_version TEXT,normalization_version TEXT,redaction_epoch INTEGER,availability TEXT,position_space_id TEXT);
    CREATE TABLE IF NOT EXISTS conversation_source_versions(id TEXT PRIMARY KEY,availability TEXT,generation TEXT);`);
  for (const manifest of manifests) {
    ledger.prepare('INSERT OR REPLACE INTO conversations VALUES(?,?)').run(manifest.conversation_id, manifest.block_count);
    ledger.prepare("INSERT OR REPLACE INTO conversation_sources VALUES(?,?,?,?,?,?,'available','measurement-space')")
      .run(manifest.conversation_id, manifest.source_version_id, manifest.parser_format, manifest.parser_version, manifest.normalization_version, manifest.redaction_epoch);
    ledger.prepare("INSERT OR REPLACE INTO conversation_source_versions VALUES(?,'available','sealed_sha256')").run(manifest.source_version_id);
    await transition.prepare(manifest.conversation_id, async () => {
      peakTarget = Math.max(peakTarget, size(cache.cachePath)); peakInput = Math.max(peakInput, size(input));
      await new Promise<void>(resolve => setImmediate(resolve));
    });
    converted++; rows += manifest.block_count;
    if (converted % 100 === 0) process.stderr.write(JSON.stringify({ converted, rows, elapsedMs: performance.now() - start }) + '\n');
  }
  const cohort = [...new Map([...manifests.slice().sort((a,b) => b.block_count-a.block_count).slice(0,3),
    ...manifests.filter((_,index) => index % Math.max(1,Math.floor(manifests.length/8)) === 0)].map(manifest => [manifest.cache_id,manifest])).values()];
  const comparisons = cohort.map(manifest => {
    const indexed = cache.readPresentationIndex(manifest.conversation_id, manifest.source_version_id)!;
    const oldPositions = source.prepare('SELECT facts_json FROM cache_display_positions WHERE cache_conversation_id=? ORDER BY position')
      .all(manifest.cache_id).map(row => JSON.parse(row.facts_json));
    const oldFragments = source.prepare('SELECT * FROM cache_display_fragments WHERE cache_conversation_id=? ORDER BY position,ordinal').all(manifest.cache_id);
    const disclosure = (value: any) => ({ keys: value?.keys ?? [], prefixes: value?.prefixes ?? [], thinkingDefaults: value?.thinkingDefaults ?? [] });
    const expected = oldFragments.map(row => {
      const facts = JSON.parse(row.facts_json);
      return { position: row.position, part: row.part, kind: row.kind, speaker: row.speaker, run: row.run_id,
        summary: facts.summary_from_source, details: facts.has_details, eligible: facts.summary_eligible !== false, disclosures: disclosure(facts.disclosures) };
    });
    const actual = indexed.fragments.map(fragment => ({ position: fragment.coordinate.position, part: fragment.coordinate.part,
      kind: fragment.kind, speaker: fragment.speaker, run: fragment.activity_run_id, summary: fragment.summary_from_source,
      details: fragment.has_details, eligible: fragment.summary_eligible !== false, disclosures: disclosure(fragment.disclosures) }));
    const aliases = source.prepare('SELECT position,owner_position,owner_part FROM cache_display_aliases WHERE cache_conversation_id=? ORDER BY position')
      .all(manifest.cache_id).map(row => ({ position: row.position, fragment_id: displayFragmentId({position:row.owner_position,part:row.owner_part}) }));
    const actualAliases = indexed.aliases.map(alias => ({ position: alias.position, fragment_id: alias.fragment_id }));
    const result = { tupleDigest: createHash('sha256').update(JSON.stringify(manifest)).digest('hex'), blocks: manifest.block_count,
      fragments: indexed.fragments.length, positionsEqual: isDeepStrictEqual(oldPositions,indexed.positions),
      fragmentMeaningEqual: isDeepStrictEqual(expected,actual), aliasesEqual: isDeepStrictEqual(aliases,actualAliases) };
    return result;
  });
  fs.writeFileSync(path.join(output,'semantic-cohort.json'),JSON.stringify(comparisons,null,2));
  const sourceStats = source.prepare('SELECT name,sum(pgsize) AS allocated,sum(payload) AS payload,sum(unused) AS unused,sum(CASE WHEN pagetype=\'overflow\' THEN pgsize ELSE 0 END) AS overflow FROM dbstat GROUP BY name ORDER BY allocated DESC').all();
  cache.close(); closed = true;
  const target = new SqliteDatabase(cache.cachePath, { readonly: true });
  try {
    const targetStats = target.prepare('SELECT name,sum(pgsize) AS allocated,sum(payload) AS payload,sum(unused) AS unused,sum(CASE WHEN pagetype=\'overflow\' THEN pgsize ELSE 0 END) AS overflow FROM dbstat GROUP BY name ORDER BY allocated DESC').all();
    const report = { method: 'One pinned read-only src/sqlite.ts WAL snapshot; no source copy or transcript reparse. Every compatible v18 generation is converted using private current-source pointers; input generation tuples are fixed by corpusDigest.',
      input, corpusDigest, generations: converted, blocks: rows, elapsedMs: performance.now() - start, before, after: footprint(cache.cachePath),
      peakTemporaryOutputBytes: peakTarget, peakInputBytes: peakInput, peakCombinedBytes: peakTarget + peakInput,
      semanticCohort: comparisons, sourceStats, targetStats, integrity: target.pragma('quick_check'), foreignKeys: target.pragma('foreign_key_check') };
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    process.stdout.write(JSON.stringify({ generations: converted, blocks: rows, elapsedMs: report.elapsedMs, target: report.after, peakTemporaryOutputBytes: peakTarget }) + '\n');
  } finally { target.close(); }
} finally { if (!closed) cache.close(); ledger.close(); source.close(); }
