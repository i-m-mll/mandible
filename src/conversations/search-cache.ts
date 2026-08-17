import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import Database from "better-sqlite3";

import { decompressContentAsync } from "../compression.js";
import { maskUnverifiedCandidates } from "../credential-leak-scan.js";
import type { Db } from "../db.js";
import { getUserHome } from "../platform-paths.js";

export const CONVERSATION_SEARCH_EPOCHS = Object.freeze({
  parser: "legacy-reader-v1",
  normalization: "masked-block-v1",
  tokenizer: "sqlite-trigram-v1",
});

export const DEFAULT_SEARCH_CACHE_LIMITS = Object.freeze({
  maxConcurrentColdParses: 4,
  maxBodyBytes: 1024 * 1024,
  maxCacheBytes: 64 * 1024 * 1024,
});

export interface SearchConversationSource {
  conversationId: string;
  sourceVersionId: string;
}

export interface SearchBlockSource {
  id: string;
  conversationId: string;
  type: string;
  role: string;
  position: number;
  content: string;
}

/**
 * Deliberately small seam for the source-store lane. Its verified reader can
 * replace this legacy adapter without teaching the disposable cache about
 * canonical source tables or locator schemas.
 */
export interface ConversationSearchSourceAdapter {
  describe(conversationIds: readonly string[]): SearchConversationSource[];
  readMaskedBlocks(conversationId: string): Promise<SearchBlockSource[]>;
  redactionEpoch(): string;
}

export interface ConversationSearchMetrics {
  hot_conversations: number;
  cold_conversations: number;
  hot_blocks: number;
  cold_blocks: number;
  uncached_oversize_blocks: number;
  fts_shortlist: number;
  exact_verified_blocks: number;
  max_cold_parse_concurrency: number;
  elapsed_ms: number;
}

export interface ConversationSearchMatch {
  conversation_id: string;
  block_id: string;
  snippet: string;
}

interface CachedBodyRow {
  block_id: string;
  conversation_id: string;
  block_type: string;
  role: string;
  position: number;
  body: string;
}

interface CacheKey {
  sourceVersionId: string;
  parserVersion: string;
  normalizationVersion: string;
  tokenizerVersion: string;
  redactionEpoch: string;
}

export interface ConversationSearchCacheOptions {
  cachePath?: string;
  maxConcurrentColdParses?: number;
  maxBodyBytes?: number;
  maxCacheBytes?: number;
}

export function defaultConversationSearchCachePath(db?: Db): string {
  const override = process.env.MANDIBLE_CONVERSATION_CACHE_DB?.trim();
  if (override) return path.resolve(override);
  const dbName = db && typeof db.name === "string" ? db.name : "";
  if ((process.env.VITEST === "true" || process.env.NODE_ENV === "test") && dbName && dbName !== ":memory:") {
    return `${dbName}.conversation-cache.db`;
  }
  return path.join(getUserHome(), ".cache", "mandible", "conversations", "search-cache.db");
}

export class LegacyConversationSearchSourceAdapter implements ConversationSearchSourceAdapter {
  constructor(private readonly db: Db) {}

  describe(conversationIds: readonly string[]): SearchConversationSource[] {
    if (conversationIds.length === 0) return [];
    const placeholders = conversationIds.map(() => "?").join(",");
    const rows = this.db.prepare(
      `SELECT id, source_hash FROM conversations WHERE id IN (${placeholders})`,
    ).all(...conversationIds) as Array<{ id: string; source_hash: string }>;
    const byId = new Map(rows.map((row) => [row.id, row.source_hash]));
    return conversationIds.flatMap((conversationId) => {
      const sourceHash = byId.get(conversationId);
      return sourceHash === undefined ? [] : [{ conversationId, sourceVersionId: `legacy:${sourceHash}` }];
    });
  }

  async readMaskedBlocks(conversationId: string): Promise<SearchBlockSource[]> {
    const rows = this.db.prepare(
      `SELECT id, conversation_id, type, role, position, content, compressed
       FROM conversation_blocks WHERE conversation_id = ? ORDER BY position ASC`,
    ).all(conversationId) as Array<{
      id: string;
      conversation_id: string;
      type: string;
      role: string;
      position: number;
      content: Buffer | string;
      compressed: number;
    }>;
    const blocks: SearchBlockSource[] = [];
    for (const row of rows) {
      const normalized = await decompressContentAsync(row.content, row.compressed === 1);
      // The durable ingest path masks verified live credentials. The cache has
      // a stricter boundary: any remaining token-shaped text (including a
      // revoked token or a fixture that bypassed ingest) is masked fail-closed.
      const masked = maskUnverifiedCandidates(normalized).text;
      blocks.push({
        id: row.id,
        conversationId: row.conversation_id,
        type: row.type,
        role: row.role,
        position: row.position,
        content: masked,
      });
    }
    return blocks;
  }

  redactionEpoch(): string {
    let rows: Array<{ id: string; status: string; fingerprint: string; revoked_at: number | null }> = [];
    try {
      rows = this.db.prepare(
        `SELECT id, status, fingerprint, revoked_at FROM user_credentials
         WHERE type = 'api_token' ORDER BY id`,
      ).all() as typeof rows;
    } catch {
      // Minimal legacy fixtures can omit the credential subsystem entirely.
    }
    const digest = createHash("sha256").update(JSON.stringify(rows)).digest("hex").slice(0, 24);
    return `credentials:${digest}`;
  }
}

function snippetFor(text: string, needleLower: string): string | null {
  const index = text.toLowerCase().indexOf(needleLower);
  if (index < 0) return null;
  const start = Math.max(0, index - 80);
  const end = Math.min(text.length, index + needleLower.length + 80);
  const snippet = text.slice(start, end).replace(/\s+/g, " ").trim();
  return `${start > 0 ? "..." : ""}${snippet}${end < text.length ? "..." : ""}`;
}

async function mapConcurrent<T, R>(
  values: readonly T[],
  concurrency: number,
  mapper: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor++;
      results[index] = await mapper(values[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

export class ConversationSearchCache {
  readonly cachePath: string;
  private readonly cache: Database.Database;
  private readonly maxConcurrentColdParses: number;
  private readonly maxBodyBytes: number;
  private readonly maxCacheBytes: number;

  constructor(
    private readonly source: ConversationSearchSourceAdapter,
    options: ConversationSearchCacheOptions = {},
  ) {
    this.cachePath = options.cachePath ?? defaultConversationSearchCachePath();
    this.maxConcurrentColdParses = Math.max(1, options.maxConcurrentColdParses ?? DEFAULT_SEARCH_CACHE_LIMITS.maxConcurrentColdParses);
    this.maxBodyBytes = Math.max(1, options.maxBodyBytes ?? DEFAULT_SEARCH_CACHE_LIMITS.maxBodyBytes);
    this.maxCacheBytes = Math.max(this.maxBodyBytes, options.maxCacheBytes ?? DEFAULT_SEARCH_CACHE_LIMITS.maxCacheBytes);
    fs.mkdirSync(path.dirname(this.cachePath), { recursive: true });
    this.cache = new Database(this.cachePath);
    this.cache.pragma("journal_mode = WAL");
    this.cache.pragma("synchronous = NORMAL");
    this.initialize();
  }

  close(): void {
    this.cache.close();
  }

  private initialize(): void {
    this.cache.exec(`
      CREATE TABLE IF NOT EXISTS search_checkpoints (
        conversation_id TEXT PRIMARY KEY,
        source_version_id TEXT NOT NULL,
        parser_version TEXT NOT NULL,
        normalization_version TEXT NOT NULL,
        tokenizer_version TEXT NOT NULL,
        redaction_epoch TEXT NOT NULL,
        block_count INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS hot_bodies (
        rowid INTEGER PRIMARY KEY,
        block_id TEXT NOT NULL UNIQUE,
        conversation_id TEXT NOT NULL,
        source_version_id TEXT NOT NULL,
        parser_version TEXT NOT NULL,
        normalization_version TEXT NOT NULL,
        tokenizer_version TEXT NOT NULL,
        redaction_epoch TEXT NOT NULL,
        block_type TEXT NOT NULL,
        role TEXT NOT NULL,
        position INTEGER NOT NULL,
        body TEXT NOT NULL,
        body_bytes INTEGER NOT NULL,
        accessed_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS hot_bodies_conversation ON hot_bodies(conversation_id, position);
      CREATE INDEX IF NOT EXISTS hot_bodies_accessed ON hot_bodies(accessed_at);
    `);
    try {
      this.cache.exec(
        "CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(body, content='', contentless_delete=1, tokenize='trigram')",
      );
    } catch {
      // Older bundled SQLite versions lack contentless_delete. The whole file
      // is disposable, so rebuilding a plain contentless trigram table is safe.
      this.cache.exec("DROP TABLE IF EXISTS search_fts");
      this.cache.exec("CREATE VIRTUAL TABLE search_fts USING fts5(body, content='', tokenize='trigram')");
    }
  }

  private key(sourceVersionId: string, redactionEpoch: string): CacheKey {
    return {
      sourceVersionId,
      parserVersion: CONVERSATION_SEARCH_EPOCHS.parser,
      normalizationVersion: CONVERSATION_SEARCH_EPOCHS.normalization,
      tokenizerVersion: CONVERSATION_SEARCH_EPOCHS.tokenizer,
      redactionEpoch,
    };
  }

  private removeFtsRow(rowid: number, body: string): void {
    try {
      this.cache.prepare("DELETE FROM search_fts WHERE rowid = ?").run(rowid);
    } catch {
      // Pre-contentless-delete FTS5 uses its control command and requires the
      // old indexed bytes. They are already masked hot-cache bytes.
      try {
        this.cache.prepare(
          "INSERT INTO search_fts(search_fts, rowid, body) VALUES ('delete', ?, ?)",
        ).run(rowid, body);
      } catch {
        // A stale posting can only over-select: the join to hot_bodies and the
        // exact verification pass prevent it from becoming a returned match.
      }
    }
  }

  private cachedBlocks(conversationId: string, key: CacheKey): CachedBodyRow[] | null {
    const checkpoint = this.cache.prepare(
      `SELECT block_count FROM search_checkpoints
       WHERE conversation_id = ? AND source_version_id = ? AND parser_version = ?
         AND normalization_version = ? AND tokenizer_version = ? AND redaction_epoch = ?`,
    ).get(
      conversationId,
      key.sourceVersionId,
      key.parserVersion,
      key.normalizationVersion,
      key.tokenizerVersion,
      key.redactionEpoch,
    ) as { block_count: number } | undefined;
    if (!checkpoint) return null;
    const rows = this.cache.prepare(
      `SELECT block_id, conversation_id, block_type, role, position, body
       FROM hot_bodies WHERE conversation_id = ? AND source_version_id = ?
         AND parser_version = ? AND normalization_version = ?
         AND tokenizer_version = ? AND redaction_epoch = ? ORDER BY position ASC`,
    ).all(
      conversationId,
      key.sourceVersionId,
      key.parserVersion,
      key.normalizationVersion,
      key.tokenizerVersion,
      key.redactionEpoch,
    ) as CachedBodyRow[];
    // Oversize blocks are intentionally not retained, so their checkpoint can
    // never masquerade as a complete hot read.
    if (rows.length !== checkpoint.block_count) return null;
    this.cache.prepare("UPDATE hot_bodies SET accessed_at = ? WHERE conversation_id = ?").run(Date.now(), conversationId);
    return rows;
  }

  private replaceConversation(conversationId: string, key: CacheKey, blocks: readonly SearchBlockSource[]): number {
    const cacheable = blocks.filter((block) => Buffer.byteLength(block.content, "utf8") <= this.maxBodyBytes);
    const replace = this.cache.transaction(() => {
      const oldRows = this.cache.prepare("SELECT rowid, body FROM hot_bodies WHERE conversation_id = ?").all(conversationId) as Array<{ rowid: number; body: string }>;
      for (const row of oldRows) {
        this.removeFtsRow(row.rowid, row.body);
      }
      this.cache.prepare("DELETE FROM hot_bodies WHERE conversation_id = ?").run(conversationId);
      const insert = this.cache.prepare(
        `INSERT INTO hot_bodies
          (block_id, conversation_id, source_version_id, parser_version, normalization_version,
           tokenizer_version, redaction_epoch, block_type, role, position, body, body_bytes, accessed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const block of cacheable) {
        const info = insert.run(
          block.id, conversationId, key.sourceVersionId, key.parserVersion,
          key.normalizationVersion, key.tokenizerVersion, key.redactionEpoch,
          block.type, block.role, block.position, block.content,
          Buffer.byteLength(block.content, "utf8"), Date.now(),
        );
        this.cache.prepare("INSERT INTO search_fts(rowid, body) VALUES (?, ?)").run(Number(info.lastInsertRowid), block.content);
      }
      this.cache.prepare(
        `INSERT INTO search_checkpoints
          (conversation_id, source_version_id, parser_version, normalization_version,
           tokenizer_version, redaction_epoch, block_count, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(conversation_id) DO UPDATE SET
           source_version_id=excluded.source_version_id, parser_version=excluded.parser_version,
           normalization_version=excluded.normalization_version, tokenizer_version=excluded.tokenizer_version,
           redaction_epoch=excluded.redaction_epoch, block_count=excluded.block_count,
           updated_at=excluded.updated_at`,
      ).run(
        conversationId, key.sourceVersionId, key.parserVersion, key.normalizationVersion,
        key.tokenizerVersion, key.redactionEpoch, blocks.length, Date.now(),
      );
    });
    replace();
    this.prune();
    return blocks.length - cacheable.length;
  }

  private prune(): void {
    const total = this.cache.prepare("SELECT COALESCE(SUM(body_bytes), 0) AS bytes FROM hot_bodies").get() as { bytes: number };
    let bytes = total.bytes;
    if (bytes <= this.maxCacheBytes) return;
    const victims = this.cache.prepare(
      "SELECT conversation_id, SUM(body_bytes) AS bytes FROM hot_bodies GROUP BY conversation_id ORDER BY MIN(accessed_at) ASC",
    ).all() as Array<{ conversation_id: string; bytes: number }>;
    for (const victim of victims) {
      if (bytes <= this.maxCacheBytes) break;
      this.cache.prepare("DELETE FROM search_checkpoints WHERE conversation_id = ?").run(victim.conversation_id);
      const rows = this.cache.prepare("SELECT rowid, body FROM hot_bodies WHERE conversation_id = ?").all(victim.conversation_id) as Array<{ rowid: number; body: string }>;
      for (const row of rows) {
        this.removeFtsRow(row.rowid, row.body);
      }
      this.cache.prepare("DELETE FROM hot_bodies WHERE conversation_id = ?").run(victim.conversation_id);
      bytes -= victim.bytes;
    }
  }

  private ftsShortlist(needle: string): Set<string> {
    if ([...needle].length < 3) return new Set();
    try {
      const escaped = `"${needle.replaceAll('"', '""')}"`;
      const rows = this.cache.prepare(
        `SELECT h.block_id FROM search_fts f JOIN hot_bodies h ON h.rowid = f.rowid
         WHERE search_fts MATCH ?`,
      ).all(escaped) as Array<{ block_id: string }>;
      return new Set(rows.map((row) => row.block_id));
    } catch {
      // Punctuation and tokenizer edge cases deliberately fall back to the
      // exact source-verified scan below.
      return new Set();
    }
  }

  async search(input: {
    conversationIds: readonly string[];
    needle: string;
    blockType?: string | null;
    limit: number;
  }): Promise<{ matches: ConversationSearchMatch[]; metrics: ConversationSearchMetrics }> {
    const started = performance.now();
    const needleLower = input.needle.toLowerCase();
    const metrics: ConversationSearchMetrics = {
      hot_conversations: 0,
      cold_conversations: 0,
      hot_blocks: 0,
      cold_blocks: 0,
      uncached_oversize_blocks: 0,
      fts_shortlist: 0,
      exact_verified_blocks: 0,
      max_cold_parse_concurrency: 0,
      elapsed_ms: 0,
    };
    const shortlist = this.ftsShortlist(input.needle);
    metrics.fts_shortlist = shortlist.size;
    const sources = this.source.describe(input.conversationIds);
    const redactionEpoch = this.source.redactionEpoch();
    let activeCold = 0;
    const bodies = await mapConcurrent(sources, this.maxConcurrentColdParses, async (item) => {
      const key = this.key(item.sourceVersionId, redactionEpoch);
      const cached = this.cachedBlocks(item.conversationId, key);
      if (cached) {
        metrics.hot_conversations += 1;
        metrics.hot_blocks += cached.length;
        return cached;
      }
      activeCold += 1;
      metrics.max_cold_parse_concurrency = Math.max(metrics.max_cold_parse_concurrency, activeCold);
      try {
        const blocks = await this.source.readMaskedBlocks(item.conversationId);
        metrics.cold_conversations += 1;
        metrics.cold_blocks += blocks.length;
        metrics.uncached_oversize_blocks += this.replaceConversation(item.conversationId, key, blocks);
        return blocks.map((block) => ({
          block_id: block.id,
          conversation_id: block.conversationId,
          block_type: block.type,
          role: block.role,
          position: block.position,
          body: block.content,
        }));
      } finally {
        activeCold -= 1;
      }
    });

    const matches: ConversationSearchMatch[] = [];
    for (const blocks of bodies) {
      for (const block of blocks) {
        if (input.blockType && block.block_type !== input.blockType) continue;
        metrics.exact_verified_blocks += 1;
        const snippet = snippetFor(block.body, needleLower);
        if (snippet !== null) {
          matches.push({ conversation_id: block.conversation_id, block_id: block.block_id, snippet });
          break;
        }
      }
      if (matches.length >= input.limit) break;
    }
    metrics.elapsed_ms = Math.round((performance.now() - started) * 100) / 100;
    return { matches, metrics };
  }
}

const services = new WeakMap<Db, ConversationSearchCache>();

export function getConversationSearchCache(db: Db): ConversationSearchCache {
  const existing = services.get(db);
  if (existing) return existing;
  const service = new ConversationSearchCache(
    new LegacyConversationSearchSourceAdapter(db),
    { cachePath: defaultConversationSearchCachePath(db) },
  );
  services.set(db, service);
  return service;
}
