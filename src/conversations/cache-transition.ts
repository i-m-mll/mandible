import fs from 'node:fs';
import SqliteDatabase from '../sqlite.js';
import type { Db } from '../db.js';
import { ConversationStructureCache, getConversationStructureCache, type SourceManifestRow } from './structure-cache.js';
import { legacyDisplayIndexBatch } from './conversation-index.js';
import { displayFragmentId } from './display-context.js';
import { CURRENT_CONVERSATION_SOURCE_EPOCHS } from './source-types.js';
import { publishCacheTransitionReceipt, sourceGenerationDigest, cacheFileIdentity, cacheTransitionReceiptPath, OBSOLETE_CACHE_SUFFIXES, type CacheTransitionReceipt } from './cache-transition-receipt.js';

const MAX_BATCH_ROWS = 512;
const MAX_BATCH_BYTES = 2 * 1024 * 1024;
const TYPES = ['user_message', 'assistant_message', 'thinking', 'plan', 'tool_use', 'tool_result', 'system', 'event'] as const;
const ROLES = ['user', 'assistant', 'system', 'tool'] as const;
type LegacyManifest = SourceManifestRow & { cache_id: number };

/** Only the serialized ingestion owner invokes this one-time format transition. */
export class ConversationCacheTransition {
  private readonly target;
  readonly obsoletePath: string | null;

  constructor(private readonly ledger: Db, private readonly options: { obsoletePath?: string; sourceSnapshot?: SqliteDatabase; targetCache?: ConversationStructureCache } = {}) {
    this.target = options.targetCache ?? getConversationStructureCache(ledger);
    this.obsoletePath = options.obsoletePath ?? (this.target.cachePath.endsWith('.v19')
      ? `${this.target.cachePath.slice(0, -4)}.v18` : null);
  }

  async preparePath(filePath: string, cooperate: () => Promise<void>): Promise<void> {
    const conversations = this.ledger.prepare('SELECT id FROM conversations WHERE source_path = ?').all(filePath) as Array<{ id: string }>;
    for (const conversation of conversations) await this.prepare(conversation.id, cooperate);
  }

  async prepare(conversationId: string | undefined, cooperate: () => Promise<void>): Promise<void> {
    if (!this.obsoletePath || !fs.existsSync(this.obsoletePath)) return;
    const receiptPath = cacheTransitionReceiptPath(this.target.cachePath);
    if (fs.existsSync(receiptPath)) {
      const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8')) as CacheTransitionReceipt;
      const next = cacheFileIdentity(this.target.cachePath);
      if (receipt.schema === 'mandible-conversation-cache-transition@1' && receipt.state === 'coverage-complete'
        && receipt.ledger === this.ledger.name && receipt.obsolete === this.obsoletePath && receipt.current === this.target.cachePath
        && receipt.currentIdentity?.dev === next?.dev && receipt.currentIdentity?.ino === next?.ino
        && receipt.files.length === OBSOLETE_CACHE_SUFFIXES.length
        && receipt.files.every((file, index) => file.suffix === OBSOLETE_CACHE_SUFFIXES[index]
          && JSON.stringify(file.identity) === JSON.stringify(cacheFileIdentity(`${this.obsoletePath}${file.suffix}`)))) return;
    }
    const source = this.options.sourceSnapshot ?? new SqliteDatabase(this.obsoletePath, { readonly: true, fileMustExist: true });
    try {
      source.pragma('query_only = ON');
      if (!this.options.sourceSnapshot) source.exec('BEGIN');
      if (source.prepare("SELECT value FROM cache_meta WHERE key = 'schema_version'").get()?.value !== '18') {
        throw new Error('Obsolete conversation cache has an unexpected format');
      }
      let cursor = 0;
      for (;;) {
        const manifest = source.prepare(`SELECT * FROM cache_conversations WHERE cache_id > ?
          ${conversationId === undefined ? '' : 'AND conversation_id = ?'} ORDER BY cache_id LIMIT 1`)
          .get(cursor, ...(conversationId === undefined ? [] : [conversationId])) as LegacyManifest | undefined;
        if (!manifest) break;
        cursor = manifest.cache_id;
        if (this.current(manifest) && !this.ready(manifest)) await this.convert(source, manifest, cooperate);
        await cooperate();
      }
    } finally {
      if (!this.options.sourceSnapshot) source.close();
    }
    if (conversationId === undefined && !this.options.sourceSnapshot) await this.recordCoverage(cooperate);
  }

  private async recordCoverage(cooperate: () => Promise<void>): Promise<void> {
    if (!this.obsoletePath) return;
    const source = new SqliteDatabase(this.obsoletePath, { readonly: true, fileMustExist: true });
    let covered = true;
    let identities;
    let generationDigest;
    try {
      source.pragma('query_only = ON');
      source.exec('BEGIN');
      source.prepare('SELECT cache_id FROM cache_conversations LIMIT 1').get();
      generationDigest = sourceGenerationDigest(source);
      identities = OBSOLETE_CACHE_SUFFIXES.map(suffix => ({ suffix, identity: cacheFileIdentity(`${this.obsoletePath}${suffix}`) }));
      for (const manifest of source.prepare('SELECT * FROM cache_conversations ORDER BY cache_id').iterate() as Iterable<LegacyManifest>) {
        if (this.current(manifest) && !this.ready(manifest)) { covered = false; break; }
        await cooperate();
      }
    } finally { source.close(); }
    const unchanged = identities?.every(file => JSON.stringify(file.identity) === JSON.stringify(cacheFileIdentity(`${this.obsoletePath}${file.suffix}`)));
    if (covered && unchanged) publishCacheTransitionReceipt(this.ledger.name, this.obsoletePath, this.target.cachePath, identities, generationDigest);
  }

  private ready(manifest: SourceManifestRow): boolean {
    return this.target.hasCompleteConversation(manifest.conversation_id, manifest.source_version_id,
      manifest.block_count, { parserFormat: manifest.parser_format, parserVersion: manifest.parser_version,
        normalizationVersion: manifest.normalization_version, redactionEpoch: manifest.redaction_epoch });
  }

  private current(manifest: SourceManifestRow): boolean {
    const epochs = CURRENT_CONVERSATION_SOURCE_EPOCHS;
    if (manifest.parser_format !== epochs.parserFormat || manifest.parser_version !== epochs.parserVersion
      || manifest.normalization_version !== epochs.normalizationVersion || manifest.redaction_epoch !== epochs.redactionEpoch) return false;
    return Boolean(this.ledger.prepare(`SELECT 1 FROM conversation_sources source JOIN conversations conversation
      ON conversation.id = source.conversation_id
      JOIN conversation_source_versions version ON version.id = source.current_version_id
      WHERE source.availability = 'available' AND version.availability = 'available'
      AND version.generation = 'sealed_sha256' AND source.position_space_id IS NOT NULL
      AND source.conversation_id = ? AND source.current_version_id = ?
      AND source.parser_format = ? AND source.parser_version = ? AND source.normalization_version = ?
      AND source.redaction_epoch = ? AND conversation.block_count = ?`)
      .get(manifest.conversation_id, manifest.source_version_id, manifest.parser_format, manifest.parser_version,
        manifest.normalization_version, manifest.redaction_epoch, manifest.block_count));
  }

  private async convert(source: SqliteDatabase, manifest: LegacyManifest, cooperate: () => Promise<void>): Promise<void> {
    const generation = this.target.beginGeneration(manifest);
    let complete = false;
    try {
      let after = -1;
      for (;;) {
        if (!this.current(manifest) || this.ready(manifest)) return;
        const bounds = source.prepare(`SELECT block.position, coalesce(length(facts.facts_json), 0)
          + coalesce((SELECT sum(length(fragment.facts_json)) FROM cache_display_fragments fragment
            WHERE fragment.cache_conversation_id = block.cache_conversation_id AND fragment.position = block.position),0)
          + 128 AS bytes FROM cache_blocks block LEFT JOIN cache_display_positions facts
          ON facts.cache_conversation_id = block.cache_conversation_id AND facts.position = block.position
          WHERE block.cache_conversation_id = ? AND block.position > ? ORDER BY block.position LIMIT ?`)
          .all(manifest.cache_id, after, MAX_BATCH_ROWS) as Array<{ position: number; bytes: number }>;
        if (!bounds.length) break;
        let bytes = 0;
        let end = bounds[0].position;
        for (const row of bounds) {
          if (bytes && bytes + row.bytes > MAX_BATCH_BYTES) break;
          bytes += row.bytes;
          end = row.position;
        }
        const blocks = source.prepare(`SELECT * FROM cache_blocks WHERE cache_conversation_id = ?
          AND position > ? AND position <= ? ORDER BY position`).all(manifest.cache_id, after, end);
        const positions = source.prepare(`SELECT facts_json FROM cache_display_positions WHERE cache_conversation_id = ?
          AND position > ? AND position <= ? ORDER BY position`).all(manifest.cache_id, after, end).map(row => JSON.parse(row.facts_json));
        const fragments = source.prepare(`SELECT * FROM cache_display_fragments WHERE cache_conversation_id = ?
          AND position > ? AND position <= ? ORDER BY position, ordinal`).all(manifest.cache_id, after, end).map(row => ({
            ...JSON.parse(row.facts_json), id: displayFragmentId({ position: row.position, part: row.part }),
            coordinate: { position: row.position, part: row.part }, kind: row.kind, speaker: row.speaker, activity_run_id: row.run_id,
          }));
        const aliases = source.prepare(`SELECT position, owner_position FROM cache_display_aliases WHERE cache_conversation_id = ?
          AND position > ? AND position <= ? ORDER BY position`).all(manifest.cache_id, after, end)
          .map(row => ({ position: row.position, owner_position: row.owner_position, failed: false }));
        this.target.appendGeneration(generation, {
          rows: blocks.map(row => {
            const type = TYPES[row.type_code];
            const role = ROLES[row.role_code];
            if (!type || !role) throw new Error('Invalid obsolete conversation block encoding');
            return { position: row.position, type, role, parentPosition: row.parent_position,
              recordOffset: row.record_offset, recordLength: row.record_length, recordOrdinal: row.record_ordinal,
              subBlockOrdinal: row.sub_block_ordinal, model: row.model, clientIntentId: row.client_intent_id };
          }),
          display: legacyDisplayIndexBatch({ positions, fragments, aliases }, manifest.conversation_id),
          toolKeys: source.prepare(`SELECT tool_key, position FROM cache_tool_links WHERE cache_conversation_id = ?
            AND position > ? AND position <= ?`).all(manifest.cache_id, after, end)
            .map(row => ({ key: row.tool_key, position: row.position })),
        });
        after = end;
        await cooperate();
      }
      if (!this.current(manifest) || this.ready(manifest)) return;
      this.target.completeGeneration(generation);
      complete = true;
    } finally {
      if (!complete) this.target.discardGeneration(generation);
    }
  }
}

/** Selective v18 projection uses the same converter and generation writer as runtime preparation. */
export async function projectLegacyConversationCache(sourcePath: string, destinationPath: string, projectedLedgerPath: string,
  options: { signal?: AbortSignal; maxBytes?: number; cooperate?: () => Promise<void> } = {}): Promise<{ generations: number; rows: number }> {
  const ledger = new SqliteDatabase(projectedLedgerPath, { readonly: true, fileMustExist: true });
  let source: SqliteDatabase | undefined;
  let target: ConversationStructureCache | undefined;
  try {
    source = new SqliteDatabase(sourcePath, { readonly: true, fileMustExist: true });
    source.pragma('query_only = ON'); source.exec('BEGIN');
    target = new ConversationStructureCache(undefined, {
      cachePath: destinationPath.endsWith('.v19') ? destinationPath.slice(0, -4) : destinationPath,
      maxBytes: options.maxBytes,
    });
    const transition = new ConversationCacheTransition(ledger, { obsoletePath: sourcePath, sourceSnapshot: source, targetCache: target });
    await transition.prepare(undefined, async () => {
      options.signal?.throwIfAborted();
      if (options.maxBytes !== undefined) {
        const bytes = ['', '-wal', '-shm'].reduce((sum, suffix) => sum + (fs.existsSync(target!.cachePath + suffix) ? fs.statSync(target!.cachePath + suffix).size : 0), 0);
        if (bytes > options.maxBytes) throw new Error('Conversation cache projection exceeds its byte budget');
      }
      if (options.cooperate) await options.cooperate();
      else await new Promise<void>(resolve => setImmediate(resolve));
    });
    options.signal?.throwIfAborted();
    const stats = target.stats();
    return { generations: stats.conversations, rows: stats.blocks };
  } finally { target?.close(); source?.close(); ledger.close(); }
}
