import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import SqliteDatabase from "../sqlite.js";

import { decompressContentAsync } from "../compression.js";
import { maskUnverifiedCandidates } from "../credential-leak-scan.js";
import type { Db } from "../db.js";
import { getUserHome } from "../platform-paths.js";
import { ConversationSourceReader } from "./source-reader.js";
import { ConversationSourceStore } from "./source-store.js";

export const CONVERSATION_SEARCH_EPOCHS = Object.freeze({
  parser: "source-reader-v1",
  normalization: "masked-block-v1",
  tokenizer: "sqlite-trigram-v1",
});

export const DEFAULT_SEARCH_CACHE_LIMITS = Object.freeze({
  maxConcurrentColdParses: 4,
  maxBodyBytes: 1024 * 1024,
  maxCacheBytes: 32 * 1024 * 1024,
  maxPhysicalBytes: 256 * 1024 * 1024,
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
  /** `null` means no sound shortlist is available, so every input is parsed. */
  shortlistMaskedBlocks?(
    conversationIds: readonly string[],
    needle: string,
  ): Promise<ReadonlySet<string> | null>;
  redactionEpoch(): string;
}

export interface ConversationSearchMetrics {
  hot_conversations: number;
  cold_conversations: number;
  hot_blocks: number;
  cold_blocks: number;
  uncached_oversize_blocks: number;
  fts_shortlist: number;
  cold_shortlist: number;
  exact_verified_blocks: number;
  max_cold_parse_concurrency: number;
  elapsed_ms: number;
}

const COLD_PROBE_BATCH_SIZE = 64;

function rawLiteralCanShortlist(needle: string): boolean {
  // Provider JSON preserves ordinary ASCII terms verbatim. Escapes, control
  // characters, and Unicode case folds use the parser-exact path so this
  // accelerator cannot create false negatives.
  return needle.length >= 3 && /^[A-Za-z0-9 _./:@-]+$/.test(needle);
}

async function ripgrepFiles(needle: string, files: readonly string[]): Promise<Set<string> | null> {
  if (files.length === 0) return new Set();
  const configured = process.env.MANDIBLE_RIPGREP_PATH?.trim();
  const executables = [...new Set([
    configured,
    fs.existsSync("/opt/homebrew/bin/rg") ? "/opt/homebrew/bin/rg" : null,
    fs.existsSync("/usr/local/bin/rg") ? "/usr/local/bin/rg" : null,
    "rg",
  ].filter((value): value is string => Boolean(value)))];
  const args = [
    "--files-with-matches", "--null", "--ignore-case", "--fixed-strings",
    "--no-config", "--no-messages", "--color=never", "-e", needle, "--", ...files,
  ];
  for (const executable of executables) {
    const result = await new Promise<{ missing: boolean; code: number | null; stdout: Buffer }>((resolve) => {
      const child = spawn(executable, args, { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
      const chunks: Buffer[] = [];
      let settled = false;
      const finish = (value: { missing: boolean; code: number | null; stdout: Buffer }) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
      child.once("error", (error: NodeJS.ErrnoException) => {
        finish({ missing: error.code === "ENOENT", code: null, stdout: Buffer.concat(chunks) });
      });
      child.once("close", (code) => {
        finish({ missing: false, code, stdout: Buffer.concat(chunks) });
      });
    });
    if (result.missing) continue;
    if (result.code !== 0 && result.code !== 1) return null;
    return new Set(result.stdout.toString("utf8").split("\0").filter(Boolean).map((file) => path.resolve(file)));
  }
  return null;
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
  /** Maximum normalized body bytes retained before FTS expansion. */
  maxCacheBytes?: number;
  /** Hard cap for the complete disposable SQLite file family. */
  maxPhysicalBytes?: number;
}

function isMissingSourceSchema(error: unknown): boolean {
  return error instanceof Error && /no such table: conversation_(sources|structural_blocks)/i.test(error.message);
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

/**
 * Prefer verified provider bytes while retaining the legacy body adapter as
 * the explicit migration fallback for legacy-only rows and narrow fixtures.
 */
export class SourceBackedConversationSearchSourceAdapter implements ConversationSearchSourceAdapter {
  private readonly store: ConversationSourceStore;
  private readonly reader: ConversationSourceReader;
  private readonly legacy: LegacyConversationSearchSourceAdapter;

  constructor(db: Db) {
    this.store = new ConversationSourceStore(db);
    this.reader = new ConversationSourceReader(db);
    this.legacy = new LegacyConversationSearchSourceAdapter(db);
  }

  describe(conversationIds: readonly string[]): SearchConversationSource[] {
    const legacy = new Map(
      this.legacy.describe(conversationIds).map((item) => [item.conversationId, item]),
    );
    return conversationIds.flatMap((conversationId) => {
      try {
        const source = this.store.resolveConversation(conversationId);
        if (source?.currentVersionId) {
          return [{ conversationId, sourceVersionId: source.currentVersionId }];
        }
      } catch (error) {
        if (!isMissingSourceSchema(error)) throw error;
        // Minimal pre-v140 fixtures deliberately exercise the legacy seam.
      }
      const fallback = legacy.get(conversationId);
      return fallback ? [fallback] : [];
    });
  }

  async readMaskedBlocks(conversationId: string): Promise<SearchBlockSource[]> {
    try {
      const result = await this.reader.readAll(conversationId);
      if (result.status === "source" || result.status === "legacy") {
        return result.value.map((block) => ({
          id: block.id,
          conversationId: block.conversation_id,
          type: block.type,
          role: block.role,
          position: block.position,
          // Source reads mask active credentials. The disposable search
          // boundary also masks revoked or unverified token-shaped material.
          content: maskUnverifiedCandidates(block.content).text,
        }));
      }
    } catch (error) {
      if (!isMissingSourceSchema(error)) throw error;
      // Missing v140 tables in a narrow legacy fixture fall through below.
    }
    return this.legacy.readMaskedBlocks(conversationId);
  }

  async shortlistMaskedBlocks(
    conversationIds: readonly string[],
    needle: string,
  ): Promise<ReadonlySet<string> | null> {
    if (!rawLiteralCanShortlist(needle)) return null;
    const pathsToConversations = new Map<string, string[]>();
    const mustParse = new Set<string>();
    for (const conversationId of conversationIds) {
      let source;
      try {
        source = this.store.resolveConversation(conversationId);
      } catch (error) {
        if (!isMissingSourceSchema(error)) throw error;
        mustParse.add(conversationId);
        continue;
      }
      const aliases = source
        ? this.store.listAliases(source.sourceId).filter((alias) =>
          alias.availability === "available" && fs.existsSync(alias.path))
        : [];
      // A durable source record with no readable alias has no searchable body
      // after sparse cutover. Do not invoke the parser only to rediscover that
      // fact; legacy-only rows (no source descriptor) still take the fallback.
      if (aliases.length === 0) {
        if (!source) mustParse.add(conversationId);
        continue;
      }
      for (const alias of aliases) {
        const resolved = path.resolve(alias.path);
        const ids = pathsToConversations.get(resolved) ?? [];
        ids.push(conversationId);
        pathsToConversations.set(resolved, ids);
      }
    }
    const matchedPaths = await ripgrepFiles(needle, [...pathsToConversations.keys()]);
    if (matchedPaths === null) return null;
    const shortlisted = new Set(mustParse);
    for (const matchedPath of matchedPaths) {
      for (const conversationId of pathsToConversations.get(matchedPath) ?? []) {
        shortlisted.add(conversationId);
      }
    }
    return shortlisted;
  }

  redactionEpoch(): string {
    return this.legacy.redactionEpoch();
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
  private readonly cache: SqliteDatabase;
  private readonly maxConcurrentColdParses: number;
  private readonly maxBodyBytes: number;
  private readonly maxCacheBytes: number;
  private readonly maxPhysicalBytes: number;

  constructor(
    private readonly source: ConversationSearchSourceAdapter,
    options: ConversationSearchCacheOptions = {},
  ) {
    this.cachePath = options.cachePath ?? defaultConversationSearchCachePath();
    this.maxConcurrentColdParses = Math.max(1, options.maxConcurrentColdParses ?? DEFAULT_SEARCH_CACHE_LIMITS.maxConcurrentColdParses);
    this.maxBodyBytes = Math.max(1, options.maxBodyBytes ?? DEFAULT_SEARCH_CACHE_LIMITS.maxBodyBytes);
    this.maxCacheBytes = Math.max(this.maxBodyBytes, options.maxCacheBytes ?? DEFAULT_SEARCH_CACHE_LIMITS.maxCacheBytes);
    this.maxPhysicalBytes = Math.max(
      64 * 1024,
      options.maxPhysicalBytes ?? DEFAULT_SEARCH_CACHE_LIMITS.maxPhysicalBytes,
    );
    if (this.cachePath !== ":memory:") fs.mkdirSync(path.dirname(this.cachePath), { recursive: true });
    this.cache = new SqliteDatabase(this.cachePath);
    this.cache.pragma("journal_mode = WAL");
    this.cache.pragma("synchronous = NORMAL");
    this.initialize();
    this.prune();
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
    let liveBytes = this.livePageBytes();
    if (bytes <= this.maxCacheBytes && liveBytes <= this.maxPhysicalBytes) {
      this.compactIfNeeded();
      return;
    }
    const victims = this.cache.prepare(
      "SELECT conversation_id, SUM(body_bytes) AS bytes FROM hot_bodies GROUP BY conversation_id ORDER BY MIN(accessed_at) ASC",
    ).all() as Array<{ conversation_id: string; bytes: number }>;
    for (const victim of victims) {
      if (bytes <= this.maxCacheBytes && liveBytes <= this.maxPhysicalBytes) break;
      this.cache.prepare("DELETE FROM search_checkpoints WHERE conversation_id = ?").run(victim.conversation_id);
      const rows = this.cache.prepare("SELECT rowid, body FROM hot_bodies WHERE conversation_id = ?").all(victim.conversation_id) as Array<{ rowid: number; body: string }>;
      for (const row of rows) {
        this.removeFtsRow(row.rowid, row.body);
      }
      this.cache.prepare("DELETE FROM hot_bodies WHERE conversation_id = ?").run(victim.conversation_id);
      bytes -= victim.bytes;
      liveBytes = this.livePageBytes();
    }
    this.compactIfNeeded();
  }

  private livePageBytes(): number {
    const pageSize = Number(this.cache.pragma("page_size", { simple: true }));
    const pageCount = Number(this.cache.pragma("page_count", { simple: true }));
    const freePages = Number(this.cache.pragma("freelist_count", { simple: true }));
    return Math.max(0, pageCount - freePages) * pageSize;
  }

  private physicalBytes(): number {
    if (this.cachePath === ":memory:") return 0;
    return ["", "-wal", "-shm"].reduce((totalBytes, suffix) => {
      try {
        return totalBytes + fs.statSync(`${this.cachePath}${suffix}`).size;
      } catch {
        return totalBytes;
      }
    }, 0);
  }

  private compactIfNeeded(): void {
    if (this.cachePath === ":memory:" || this.physicalBytes() <= this.maxPhysicalBytes) return;
    // Deletes enforce the live-page cap. VACUUM is reserved for the uncommon
    // moment when freed pages or a large WAL keep the disposable file family
    // above its physical ceiling; it is never part of the normal search path.
    this.cache.pragma("wal_checkpoint(TRUNCATE)");
    this.cache.exec("VACUUM");
    this.cache.pragma("wal_checkpoint(TRUNCATE)");
    if (this.physicalBytes() > this.maxPhysicalBytes) {
      // Contentless FTS can retain tombstone/index pages after every hot body
      // has been evicted. It is cheaper and more honest to reset the disposable
      // cache than to let those unreachable pages defeat the advertised cap.
      this.cache.exec(`
        DROP TABLE IF EXISTS search_fts;
        DROP TABLE IF EXISTS hot_bodies;
        DROP TABLE IF EXISTS search_checkpoints;
      `);
      this.cache.pragma("wal_checkpoint(TRUNCATE)");
      this.cache.exec("VACUUM");
      this.initialize();
      this.cache.pragma("wal_checkpoint(TRUNCATE)");
    }
  }

  stats(): { bodyBytes: number; livePageBytes: number; physicalBytes: number } {
    const bodyBytes = Number((this.cache.prepare(
      "SELECT COALESCE(SUM(body_bytes), 0) AS bytes FROM hot_bodies",
    ).get() as { bytes: number }).bytes);
    return { bodyBytes, livePageBytes: this.livePageBytes(), physicalBytes: this.physicalBytes() };
  }

  private ftsShortlist(needle: string): Set<string> | null {
    if (!rawLiteralCanShortlist(needle)) return null;
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
      return null;
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
      cold_shortlist: 0,
      exact_verified_blocks: 0,
      max_cold_parse_concurrency: 0,
      elapsed_ms: 0,
    };
    const shortlist = this.ftsShortlist(input.needle);
    metrics.fts_shortlist = shortlist?.size ?? 0;
    const sources = this.source.describe(input.conversationIds);
    const redactionEpoch = this.source.redactionEpoch();
    let activeCold = 0;
    const matches: ConversationSearchMatch[] = [];
    // Probe native files in modest batches (the same approach used by editor
    // search): cheap fixed-string search rules out most cold files, then only
    // candidate conversations pay the parser cost. Exact masked block matching
    // remains the authority, and unsupported needles simply skip the probe.
    for (let windowStart = 0;
      windowStart < sources.length && matches.length < input.limit;
      windowStart += COLD_PROBE_BATCH_SIZE) {
      const window = sources.slice(windowStart, windowStart + COLD_PROBE_BATCH_SIZE)
        .map((item) => ({
          item,
          key: this.key(item.sourceVersionId, redactionEpoch),
          cached: null as CachedBodyRow[] | null,
        }));
      for (const prepared of window) {
        prepared.cached = this.cachedBlocks(prepared.item.conversationId, prepared.key);
        if (prepared.cached) {
          metrics.hot_conversations += 1;
          metrics.hot_blocks += prepared.cached.length;
        }
      }
      const coldIds = window.filter((prepared) => prepared.cached === null)
        .map((prepared) => prepared.item.conversationId);
      const coldShortlist = this.source.shortlistMaskedBlocks
        ? await this.source.shortlistMaskedBlocks(coldIds, input.needle)
        : null;
      metrics.cold_shortlist += coldShortlist?.size ?? 0;

      for (let batchStart = 0;
        batchStart < window.length && matches.length < input.limit;
        batchStart += this.maxConcurrentColdParses) {
        const batch = window.slice(batchStart, batchStart + this.maxConcurrentColdParses);
        const bodies = await mapConcurrent(batch, this.maxConcurrentColdParses, async (prepared) => {
          const { item, key, cached } = prepared;
          if (cached) {
            return shortlist && !cached.some((block) => shortlist.has(block.block_id)) ? [] : cached;
          }
          if (coldShortlist && !coldShortlist.has(item.conversationId)) return [];
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
      }
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
    new SourceBackedConversationSearchSourceAdapter(db),
    { cachePath: defaultConversationSearchCachePath(db) },
  );
  services.set(db, service);
  return service;
}
