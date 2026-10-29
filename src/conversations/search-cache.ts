import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import SqliteDatabase from "../sqlite.js";

import { decompressContentAsync } from "../compression.js";
import { maskUnverifiedCandidates } from "../credential-leak-scan.js";
import { getDaemonLogger } from "../daemon-log.js";
import type { Db } from "../db.js";
import { getUserHome } from "../platform-paths.js";
import { ConversationSourceReader, type SourceScanProgress } from "./source-reader.js";
import type { SourceReadResult, SourceReadFailureKind } from "./source-types.js";
import { ConversationSourceStore } from "./source-store.js";
import { readConversationSourceReadiness } from "./source-readiness.js";

export const CONVERSATION_SEARCH_EPOCHS = Object.freeze({
  parser: "source-reader-v2",
  normalization: "masked-block-v1",
  tokenizer: "sqlite-trigram-v1",
});

export const DEFAULT_SEARCH_CACHE_LIMITS = Object.freeze({
  maxConcurrentColdParses: 4,
  /**
   * Largest block body the cache retains. One trigram insert of this size
   * costs about 20 ms, which bounds every background maintenance statement.
   */
  maxBodyBytes: 128 * 1024,
  maxCacheBytes: 32 * 1024 * 1024,
  maxPhysicalBytes: 256 * 1024 * 1024,
});

/** v3 discards entries that may have been corrupted by pre-lock concurrent writers. */
const CACHE_SCHEMA_VERSION = 3;
const CACHE_APPLICATION_ID = 0x4d435343; // MCSC: Mandible conversation search cache
const SQLITE_AUTO_VACUUM_INCREMENTAL = 2;
const COLD_PROBE_BATCH_SIZE = 64;
const SEARCH_TURN_MS = 10;
const MAINTENANCE_TURN_MS = 4;
const MAINTENANCE_CHUNK_ROWS = 8;
const MAINTENANCE_CHUNK_BYTES = 16 * 1024;
const FTS_MERGE_PAGES = 8;
const INCREMENTAL_VACUUM_PAGES = 256;
const FREQUENCY_SAMPLE_SIZE = 16_384;

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
  /** `null` means unavailable; unlike a successful empty read it cannot be cached. */
  readMaskedBlocks(conversationId: string): Promise<SearchBlockSource[] | null>;
  scanMaskedBlocks?(
    conversationId: string,
    visitor: (block: SearchBlockSource) => "stop" | void | Promise<"stop" | void>,
    options?: { signal?: AbortSignal; expectedSourceVersionId?: string; onVerification?: (milliseconds: number) => void },
  ): Promise<SourceReadResult<SourceScanProgress>>;
  /** `null` means no sound shortlist is available, so every input is parsed. */
  shortlistMaskedBlocks?(
    conversationIds: readonly string[],
    needle: string,
  ): Promise<ReadonlySet<string> | null>;
  verifySource?(conversationId: string, sourceVersionId: string, signal?: AbortSignal, onVerification?: (milliseconds: number) => void): Promise<SourceReadResult<void>>;
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
  /** Includes logical open/decode and sealed-version proof; excludes parsing. */
  source_verification_ms: number;
  elapsed_ms: number;
}

function rawLiteralCanShortlist(needle: string): boolean {
  // Provider JSON preserves ordinary ASCII terms verbatim. Escapes, control
  // characters, and Unicode case folds use the parser-exact path so this
  // accelerator cannot create false negatives.
  return needle.length >= 3 && /^[A-Za-z0-9 _./:@-]+$/.test(needle);
}

export interface ConversationSearchMatch {
  conversation_id: string;
  block_id: string;
  snippet: string;
  block_type: string;
  role: string;
  position: number;
}

export interface ConversationSearchFailure {
  conversation_id: string;
  status: SourceReadFailureKind;
  reason: string;
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

interface Checkpoint extends CacheKey {
  blockCount: number;
}

interface AdmissionCandidate {
  conversationId: string;
  key: CacheKey;
  blocks: readonly SearchBlockSource[];
  bytes: number;
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
    const rows = this.db.prepare(
      `SELECT c.id, c.source_hash FROM json_each(?) ids JOIN conversations c ON c.id = ids.value`,
    ).all(JSON.stringify([...new Set(conversationIds)])) as Array<{ id: string; source_hash: string }>;
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

  constructor(private readonly db: Db) {
    this.store = new ConversationSourceStore(db);
    this.reader = new ConversationSourceReader(db);
    this.legacy = new LegacyConversationSearchSourceAdapter(db);
  }

  describe(conversationIds: readonly string[]): SearchConversationSource[] {
    let sources: ReturnType<ConversationSourceStore["latestSources"]> = new Map();
    try {
      sources = this.store.latestSources(conversationIds);
    } catch (error) {
      if (!isMissingSourceSchema(error)) throw error;
      // Minimal pre-v140 fixtures deliberately exercise the legacy seam.
    }
    const legacy = new Map(
      this.legacy.describe(conversationIds.filter((id) => !sources.get(id)?.currentVersionId))
        .map((item) => [item.conversationId, item]),
    );
    return conversationIds.flatMap((conversationId) => {
      const currentVersionId = sources.get(conversationId)?.currentVersionId;
      if (currentVersionId) return [{ conversationId, sourceVersionId: currentVersionId }];
      const fallback = legacy.get(conversationId);
      return fallback ? [fallback] : [];
    });
  }

  async readMaskedBlocks(conversationId: string): Promise<SearchBlockSource[] | null> {
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
      return null;
    } catch (error) {
      if (!isMissingSourceSchema(error)) throw error;
      // Missing v140 tables in a narrow legacy fixture fall through below.
    }
    return this.legacy.readMaskedBlocks(conversationId);
  }

  async scanMaskedBlocks(
    conversationId: string,
    visitor: (block: SearchBlockSource) => "stop" | void | Promise<"stop" | void>,
    options: { signal?: AbortSignal; expectedSourceVersionId?: string; onVerification?: (milliseconds: number) => void } = {},
  ): Promise<SourceReadResult<SourceScanProgress>> {
    try {
      if (this.store.resolveConversation(conversationId)?.currentVersionId) {
        const readiness = readConversationSourceReadiness(this.db, conversationId);
        if (readiness.status !== "ready") return {
          status: readiness.status === "repair_needed" ? "unsupported" : "unavailable",
          reason: readiness.reason,
        };
      }
      const result = await this.reader.scanBlocks(conversationId, block => visitor({
        id: block.id,
        conversationId: block.conversation_id,
        type: block.type,
        role: block.role,
        position: block.position,
        content: maskUnverifiedCandidates(block.content).text,
      }), options);
      if (result.status === "legacy" && this.store.resolveConversation(conversationId)?.currentVersionId) {
        return { status: result.reason, reason: "conversation source could not be verified" };
      }
      return result;
    } catch (error) {
      if (!isMissingSourceSchema(error)) throw error;
    }
    const blocks = await this.legacy.readMaskedBlocks(conversationId);
    let count = 0;
    for (const block of blocks) {
      if (options.signal?.aborted) return { status: "cancelled", reason: "conversation search cancelled" };
      count += 1;
      if (await visitor(block) === "stop") return { status: "legacy", value: { count, readBlocks: blocks.length, complete: false }, reason: "not_found" };
    }
    return { status: "legacy", value: { count, readBlocks: blocks.length, complete: true }, reason: "not_found" };
  }


  verifySource(conversationId: string, sourceVersionId: string, signal?: AbortSignal, onVerification?: (milliseconds: number) => void): Promise<SourceReadResult<void>> {
    if (sourceVersionId.startsWith("legacy:")) return Promise.resolve({ status: "legacy", value: undefined, reason: "not_found" });
    return this.reader.verifyVersion(conversationId, sourceVersionId, signal, onVerification);
  }

  redactionEpoch(): string {
    return this.legacy.redactionEpoch();
  }
}

export function snippetFor(text: string, needleLower: string): string | null {
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

/** Cooperative scheduling: hand the event loop back once a turn has run long enough. */
class TurnBudget {
  private since = performance.now();

  constructor(private readonly turnMs: number) {}

  due(): boolean {
    return performance.now() - this.since >= this.turnMs;
  }

  async yield(): Promise<void> {
    await new Promise<void>((resolve) => setImmediate(resolve));
    this.since = performance.now();
  }

  async yieldIfDue(): Promise<void> {
    if (this.due()) await this.yield();
  }
}

/**
 * A bounded, disposable trigram cache in front of verified conversation
 * sources. `search` only reads it. Every write — admitting freshly parsed
 * conversations, recording recency, evicting, compacting — runs in background
 * turns of a few milliseconds each. A conversation's checkpoint row exists
 * before any of its body rows and outlives them; it is `complete` only while
 * exactly its key's rows are present, so a search between maintenance turns
 * never trusts a partial entry.
 *
 * Admission is frequency-gated (TinyLFU): a candidate displaces residents only
 * if it has been searched strictly more often than each of them, so a scan
 * over more conversations than the cache holds settles instead of evicting and
 * re-admitting the same entries on every search.
 */
export class ConversationSearchCache {
  readonly cachePath: string;
  private cache!: SqliteDatabase;
  private writerLock: SqliteDatabase | null = null;
  private readonly maxConcurrentColdParses: number;
  private readonly maxBodyBytes: number;
  private readonly maxCacheBytes: number;
  private readonly maxPhysicalBytes: number;
  private closed = false;
  private readonly frequency = new Map<string, number>();
  private frequencyEvents = 0;
  private readonly candidates = new Map<string, AdmissionCandidate>();
  private candidateBytes = 0;
  private readonly touches = new Set<string>();
  /** Conversations holding body rows: bytes retained and last search access. */
  private readonly residents = new Map<string, { bytes: number; accessedAt: number }>();
  private residentBytes = 0;
  private capsVerified = false;
  private maintenance: Promise<void> | null = null;
  private activeColdParses = 0;
  private readonly coldWaiters: Array<() => void> = [];

  private async coldRead<T>(signal: AbortSignal | undefined, run: () => Promise<T>): Promise<T> {
    let acquired = true;
    if (this.activeColdParses >= this.maxConcurrentColdParses) {
      acquired = await new Promise<boolean>(resolve => {
        const grant = () => { signal?.removeEventListener("abort", cancel); resolve(true); };
        const cancel = () => {
          const index = this.coldWaiters.indexOf(grant);
          if (index >= 0) this.coldWaiters.splice(index, 1);
          resolve(false);
        };
        this.coldWaiters.push(grant);
        signal?.addEventListener("abort", cancel, { once: true });
        if (signal?.aborted) cancel();
      });
    } else this.activeColdParses += 1;
    if (!acquired) return run();
    try { return await run(); }
    finally {
      const next = this.coldWaiters.shift();
      if (next) next();
      else this.activeColdParses -= 1;
    }
  }

  constructor(
    private readonly source: ConversationSearchSourceAdapter,
    options: ConversationSearchCacheOptions = {},
  ) {
    const cachePath = options.cachePath ?? defaultConversationSearchCachePath();
    if (cachePath !== ":memory:") fs.mkdirSync(path.dirname(cachePath), { recursive: true });
    this.cachePath = cachePath === ":memory:" ? cachePath : fs.existsSync(cachePath)
      ? fs.realpathSync(cachePath)
      : path.join(fs.realpathSync(path.dirname(cachePath)), path.basename(cachePath));
    this.maxConcurrentColdParses = Math.max(1, options.maxConcurrentColdParses ?? DEFAULT_SEARCH_CACHE_LIMITS.maxConcurrentColdParses);
    this.maxBodyBytes = Math.max(1, options.maxBodyBytes ?? DEFAULT_SEARCH_CACHE_LIMITS.maxBodyBytes);
    this.maxCacheBytes = Math.max(this.maxBodyBytes, options.maxCacheBytes ?? DEFAULT_SEARCH_CACHE_LIMITS.maxCacheBytes);
    this.maxPhysicalBytes = Math.max(
      64 * 1024,
      options.maxPhysicalBytes ?? DEFAULT_SEARCH_CACHE_LIMITS.maxPhysicalBytes,
    );
    this.acquireWriterLock();
    try {
      this.open();
    } catch (error) {
      this.writerLock?.close();
      this.writerLock = null;
      throw error;
    }
    this.scheduleMaintenance();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.cache.close();
    } finally {
      this.writerLock?.close();
      this.writerLock = null;
    }
  }

  /** Resolves once no background maintenance is pending. */
  async whenIdle(): Promise<void> {
    while (this.maintenance) await this.maintenance;
  }

  /**
   * The daemon is the sole production writer. A separate SQLite connection holds
   * an OS-backed lock for its lifetime, including cache resets. It releases on
   * process death; never unlink the lock file (that would split its identity).
   * Previews and route sweeps each use their own cache path.
   */
  private acquireWriterLock(): void {
    if (this.cachePath === ":memory:") return;
    const lock = new SqliteDatabase(`${this.cachePath}.writer-lock`, { timeout: 0 });
    try {
      lock.exec("BEGIN EXCLUSIVE");
      this.writerLock = lock;
    } catch (error) {
      lock.close();
      throw new Error(`Conversation search cache already has a writer: ${this.cachePath}`, { cause: error });
    }
  }

  /** Recognize unmarked caches from before application_id was introduced. */
  private isLegacyCache(cache: SqliteDatabase): boolean {
    const tables = cache.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name")
      .all() as Array<{ name: string }>;
    const names = tables.map((row) => row.name).join(",");
    if (names !== "hot_bodies,search_checkpoints,search_fts,search_fts_config,search_fts_data,search_fts_docsize,search_fts_idx") return false;
    const columns = (table: string) => (cache.pragma(`table_info(${table})`) as Array<{ name: string }>)
      .map((column) => column.name).join(",");
    const checkpoints = "conversation_id,source_version_id,parser_version,normalization_version,tokenizer_version,redaction_epoch,block_count,";
    const v1 = columns("search_checkpoints") === `${checkpoints}updated_at`
      && columns("hot_bodies") === "rowid,block_id,conversation_id,source_version_id,parser_version,normalization_version,tokenizer_version,redaction_epoch,block_type,role,position,body,body_bytes,accessed_at";
    const v2 = columns("search_checkpoints") === `${checkpoints}complete,accessed_at`
      && columns("hot_bodies") === "rowid,conversation_id,block_id,block_type,role,position,body_bytes,body";
    const fts = cache.prepare("SELECT sql FROM sqlite_schema WHERE name = 'search_fts'")
      .get() as { sql: string };
    return (v1 || v2) && /USING fts5\(body, content='', (?:contentless_delete=1, )?tokenize='trigram'\)/i.test(fts.sql);
  }

  private open(): void {
    if (this.cachePath !== ":memory:") fs.mkdirSync(path.dirname(this.cachePath), { recursive: true });
    const fresh = this.cachePath === ":memory:" || !fs.existsSync(this.cachePath);
    let cache = new SqliteDatabase(this.cachePath, { readonly: !fresh });
    try {
      if (fresh) cache.pragma(`application_id = ${CACHE_APPLICATION_ID}`);
      const applicationId = Number(cache.pragma("application_id", { simple: true }));
      if (!fresh && applicationId !== CACHE_APPLICATION_ID
        && !(applicationId === 0 && this.isLegacyCache(cache))) {
        throw new Error(`Refusing to replace a database that is not a conversation search cache: ${this.cachePath}`);
      }
      const compatible = Number(cache.pragma("user_version", { simple: true })) === CACHE_SCHEMA_VERSION
        && Number(cache.pragma("auto_vacuum", { simple: true })) === SQLITE_AUTO_VACUUM_INCREMENTAL;
      if (!compatible) {
        cache.close();
        this.removeFiles();
        cache = new SqliteDatabase(this.cachePath);
        cache.pragma(`application_id = ${CACHE_APPLICATION_ID}`);
        cache.pragma(`auto_vacuum = ${SQLITE_AUTO_VACUUM_INCREMENTAL}`);
      } else if (!fresh) {
        cache.close();
        cache = new SqliteDatabase(this.cachePath);
      }
      cache.pragma("journal_mode = WAL");
      cache.pragma("synchronous = NORMAL");
      cache.pragma(`journal_size_limit = ${8 * 1024 * 1024}`);
      cache.exec(`
        CREATE TABLE IF NOT EXISTS search_checkpoints (
          conversation_id TEXT PRIMARY KEY,
          source_version_id TEXT NOT NULL,
          parser_version TEXT NOT NULL,
          normalization_version TEXT NOT NULL,
          tokenizer_version TEXT NOT NULL,
          redaction_epoch TEXT NOT NULL,
          block_count INTEGER NOT NULL,
          complete INTEGER NOT NULL,
          accessed_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS hot_bodies (
          rowid INTEGER PRIMARY KEY,
          conversation_id TEXT NOT NULL,
          block_id TEXT NOT NULL,
          block_type TEXT NOT NULL,
          role TEXT NOT NULL,
          position INTEGER NOT NULL,
          body_bytes INTEGER NOT NULL,
          -- Last, so size scans never read a body's overflow pages.
          body TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS hot_bodies_conversation ON hot_bodies(conversation_id, position);
        CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(body, content='', contentless_delete=1, tokenize='trigram');
      `);
      // FTS5's own merging runs inside whichever commit trips it and can take
      // hundreds of milliseconds on a large index. Maintenance merges instead,
      // a few pages per turn, and the crisis threshold is set out of reach.
      cache.prepare("INSERT INTO search_fts(search_fts, rank) VALUES ('automerge', 0)").run();
      cache.prepare("INSERT INTO search_fts(search_fts, rank) VALUES ('crisismerge', 2000)").run();
      cache.pragma(`application_id = ${CACHE_APPLICATION_ID}`);
      cache.pragma(`user_version = ${CACHE_SCHEMA_VERSION}`);
      this.cache = cache;
      this.residents.clear();
      this.residentBytes = 0;
      const rows = cache.prepare(
        `SELECT c.conversation_id, c.accessed_at, SUM(h.body_bytes) AS bytes
         FROM search_checkpoints c JOIN hot_bodies h ON h.conversation_id = c.conversation_id
         GROUP BY c.conversation_id`,
      ).all() as Array<{ conversation_id: string; accessed_at: number; bytes: number }>;
      for (const row of rows) this.adjustResident(row.conversation_id, row.bytes, row.accessed_at);
    } catch (error) {
      if (cache.open) cache.close();
      throw error;
    }
  }

  private adjustResident(conversationId: string, deltaBytes: number, accessedAt?: number): void {
    const resident = this.residents.get(conversationId) ?? { bytes: 0, accessedAt: accessedAt ?? Date.now() };
    resident.bytes += deltaBytes;
    if (accessedAt !== undefined) resident.accessedAt = accessedAt;
    this.residentBytes += deltaBytes;
    if (resident.bytes > 0) this.residents.set(conversationId, resident);
    else this.residents.delete(conversationId);
  }

  private removeFiles(): void {
    if (this.cachePath === ":memory:") return;
    for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(`${this.cachePath}${suffix}`, { force: true });
  }

  private reset(): void {
    this.cache.close();
    this.removeFiles();
    this.open();
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

  private completeCheckpoints(redactionEpoch: string): Map<string, Checkpoint> {
    const rows = this.cache.prepare(
      `SELECT conversation_id, source_version_id, block_count FROM search_checkpoints
       WHERE complete = 1 AND parser_version = ? AND normalization_version = ?
         AND tokenizer_version = ? AND redaction_epoch = ?`,
    ).all(
      CONVERSATION_SEARCH_EPOCHS.parser,
      CONVERSATION_SEARCH_EPOCHS.normalization,
      CONVERSATION_SEARCH_EPOCHS.tokenizer,
      redactionEpoch,
    ) as Array<{ conversation_id: string; source_version_id: string; block_count: number }>;
    return new Map(rows.map((row) => [row.conversation_id, {
      ...this.key(row.source_version_id, redactionEpoch),
      blockCount: row.block_count,
    }]));
  }

  private hotBodies(conversationId: string, key: Checkpoint): CachedBodyRow[] {
    return this.cache.prepare(
      `SELECT h.block_id, h.conversation_id, h.block_type, h.role, h.position, h.body
       FROM hot_bodies h JOIN search_checkpoints c ON c.conversation_id = h.conversation_id
       WHERE c.conversation_id = ? AND c.complete = 1
         AND c.source_version_id = ? AND c.parser_version = ? AND c.normalization_version = ?
         AND c.tokenizer_version = ? AND c.redaction_epoch = ?
       ORDER BY h.position ASC`,
    ).all(conversationId, key.sourceVersionId, key.parserVersion,
      key.normalizationVersion, key.tokenizerVersion, key.redactionEpoch) as CachedBodyRow[];
  }

  private ftsShortlist(needle: string): { blocks: number; conversations: Set<string> } | null {
    if (!rawLiteralCanShortlist(needle)) return null;
    try {
      const escaped = `"${needle.replaceAll('"', '""')}"`;
      const rows = this.cache.prepare(
        `SELECT h.conversation_id FROM search_fts f JOIN hot_bodies h ON h.rowid = f.rowid
         WHERE search_fts MATCH ?`,
      ).all(escaped) as Array<{ conversation_id: string }>;
      return { blocks: rows.length, conversations: new Set(rows.map((row) => row.conversation_id)) };
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
    signal?: AbortSignal;
    expectedSourceVersions?: Readonly<Record<string, string>>;
  }): Promise<{ matches: ConversationSearchMatch[]; failures: ConversationSearchFailure[]; metrics: ConversationSearchMetrics }> {
    const started = performance.now();
    const budget = new TurnBudget(SEARCH_TURN_MS);
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
      source_verification_ms: 0,
      elapsed_ms: 0,
    };
    const shortlist = this.ftsShortlist(input.needle);
    metrics.fts_shortlist = shortlist?.blocks ?? 0;
    const redactionEpoch = this.source.redactionEpoch();
    const checkpoints = this.completeCheckpoints(redactionEpoch);
    const failures: ConversationSearchFailure[] = [];
    const matches: ConversationSearchMatch[] = [];
    try {
      // Probe native files in modest batches (the same approach used by editor
      // search): cheap fixed-string search rules out most cold files, then only
      // candidate conversations pay the parser cost. Exact masked block matching
      // remains the authority, and unsupported needles simply skip the probe.
      for (let windowStart = 0;
        windowStart < input.conversationIds.length && matches.length < input.limit;
        windowStart += COLD_PROBE_BATCH_SIZE) {
        if (input.signal?.aborted) break;
        await budget.yieldIfDue();
        const work: Array<{ item: SearchConversationSource; hot: Checkpoint | null }> = [];
        const coldIds: string[] = [];
        const window = this.source.describe(input.conversationIds.slice(windowStart, windowStart + COLD_PROBE_BATCH_SIZE));
        const described = new Set(window.map(item => item.conversationId));
        for (const conversationId of input.conversationIds.slice(windowStart, windowStart + COLD_PROBE_BATCH_SIZE)) {
          if (!described.has(conversationId)) failures.push({ conversation_id: conversationId, status: "not_found", reason: "conversation source was not found" });
        }
        for (const item of window) {
          const expected = input.expectedSourceVersions?.[item.conversationId];
          if (expected !== undefined && item.sourceVersionId !== expected) {
            failures.push({ conversation_id: item.conversationId, status: "stale", reason: "conversation source differs from pinned search version" });
            continue;
          }
          const checkpoint = checkpoints.get(item.conversationId);
          if (checkpoint?.sourceVersionId === item.sourceVersionId) {
            metrics.hot_conversations += 1;
            metrics.hot_blocks += checkpoint.blockCount;
            if (!this.source.verifySource && (checkpoint.blockCount === 0
                || (shortlist && !shortlist.conversations.has(item.conversationId)))) continue;
            work.push({ item, hot: checkpoint });
          } else {
            coldIds.push(item.conversationId);
            work.push({ item, hot: null });
          }
        }
        const coldShortlist = coldIds.length > 0 && this.source.shortlistMaskedBlocks
          ? await this.source.shortlistMaskedBlocks(coldIds, input.needle)
          : null;
        metrics.cold_shortlist += coldShortlist?.size ?? 0;
        const pending = work.filter(({ item, hot }) =>
          hot !== null || coldShortlist === null || coldShortlist.has(item.conversationId));

        for (let batchStart = 0;
          batchStart < pending.length && matches.length < input.limit;
          batchStart += this.maxConcurrentColdParses) {
          const batch = pending.slice(batchStart, batchStart + this.maxConcurrentColdParses);
          const batchMatches = await mapConcurrent(batch, this.maxConcurrentColdParses, async ({ item, hot }) => {
            const matchBlock = (block: SearchBlockSource): ConversationSearchMatch | null => {
              if (input.blockType && block.type !== input.blockType) return null;
              metrics.exact_verified_blocks += 1;
              const snippet = snippetFor(block.content, needleLower);
              return snippet === null ? null : { conversation_id: block.conversationId, block_id: block.id, snippet,
                block_type: block.type, role: block.role, position: block.position };
            };
            const validateHotSource = async (): Promise<boolean> => {
              if (this.source.verifySource) {
                const verified = await this.coldRead(input.signal, () => this.source.verifySource!(item.conversationId, item.sourceVersionId, input.signal,
                  milliseconds => { metrics.source_verification_ms += milliseconds; }));
                if (verified.status !== "source" && verified.status !== "legacy") {
                  failures.push({ conversation_id: item.conversationId, status: verified.status, reason: verified.reason });
                  return false;
                }
              }
              if (this.source.redactionEpoch() !== redactionEpoch) {
                failures.push({ conversation_id: item.conversationId, status: "stale", reason: "search redaction facts changed" });
                return false;
              }
              this.recordAccess(item.conversationId);
              return true;
            };
            if (hot) {
              if (hot.blockCount === 0 || (shortlist && !shortlist.conversations.has(item.conversationId))) {
                await validateHotSource();
                return null;
              }
              const rows = this.hotBodies(item.conversationId, hot);
              if (rows.length === hot.blockCount) {
                let match: ConversationSearchMatch | null = null;
                for (const row of rows) {
                  if (budget.due()) await budget.yield();
                  match = matchBlock({ id: row.block_id, conversationId: row.conversation_id,
                    type: row.block_type, role: row.role, position: row.position, content: row.body });
                  if (match) break;
                }
                return await validateHotSource() ? match : null;
              }
            }
            return this.coldRead(input.signal, async () => {
              metrics.max_cold_parse_concurrency = Math.max(metrics.max_cold_parse_concurrency, this.activeColdParses);
              metrics.cold_conversations += 1;
              if (input.signal?.aborted) {
                failures.push({ conversation_id: item.conversationId, status: "cancelled", reason: "conversation search cancelled" });
                return null;
              }
              if (this.source.scanMaskedBlocks) {
                let match: ConversationSearchMatch | null = null;
                let retained: SearchBlockSource[] | null = [];
                let bytes = 0;
                const result = await this.source.scanMaskedBlocks(item.conversationId, async block => {
                  if (budget.due()) await budget.yield();
                  const blockBytes = Buffer.byteLength(block.content, "utf8");
                  bytes += blockBytes;
                  if (blockBytes > this.maxBodyBytes) metrics.uncached_oversize_blocks += 1;
                  if (blockBytes > this.maxBodyBytes || bytes > this.maxCacheBytes) retained = null;
                  retained?.push(block);
                  match = matchBlock(block);
                  if (match) return "stop";
                }, { signal: input.signal, expectedSourceVersionId: item.sourceVersionId,
                  onVerification: milliseconds => { metrics.source_verification_ms += milliseconds; } });
                if (result.status !== "source" && result.status !== "legacy") {
                  failures.push({ conversation_id: item.conversationId, status: result.status, reason: result.reason });
                  return null;
                }
                if (result.status === "source" && result.sourceVersionId !== item.sourceVersionId) {
                  failures.push({ conversation_id: item.conversationId, status: "stale", reason: "conversation source version changed during search" });
                  return null;
                }
                if (this.source.redactionEpoch() !== redactionEpoch) {
                  failures.push({ conversation_id: item.conversationId, status: "stale", reason: "search redaction facts changed" });
                  return null;
                }
                metrics.cold_blocks += result.value.readBlocks;
                this.recordAccess(item.conversationId);
                if (result.value.complete && retained && (result.status === "source" || item.sourceVersionId.startsWith("legacy:"))) {
                  this.offer(item.conversationId, this.key(item.sourceVersionId, redactionEpoch), retained);
                }
                return match;
              }
              const blocks = await this.source.readMaskedBlocks(item.conversationId);
              if (blocks === null) {
                failures.push({ conversation_id: item.conversationId, status: "unavailable", reason: "conversation source is unavailable" });
                return null;
              }
              metrics.cold_blocks += blocks.length;
              this.recordAccess(item.conversationId);
              metrics.uncached_oversize_blocks += this.offer(item.conversationId, this.key(item.sourceVersionId, redactionEpoch), blocks);
              for (const block of blocks) {
                if (budget.due()) await budget.yield();
                const match = matchBlock(block);
                if (match) return match;
              }
              return null;
            });
          });
          for (const match of batchMatches) {
            if (match) matches.push(match);
            if (matches.length >= input.limit) break;
          }
        }
      }
    } finally {
      this.scheduleMaintenance();
    }
    metrics.elapsed_ms = Math.round((performance.now() - started) * 100) / 100;
    if (input.signal?.aborted) {
      const failed = new Set(failures.map(failure => failure.conversation_id));
      for (const conversationId of input.conversationIds) {
        if (!failed.has(conversationId)) failures.push({ conversation_id: conversationId, status: "cancelled", reason: "conversation search cancelled" });
      }
    }
    return { matches, failures, metrics };
  }

  private recordAccess(conversationId: string): void {
    this.touches.add(conversationId);
    const resident = this.residents.get(conversationId);
    if (resident) resident.accessedAt = Date.now();
    this.frequency.set(conversationId, (this.frequency.get(conversationId) ?? 0) + 1);
    this.frequencyEvents += 1;
    if (this.frequencyEvents < FREQUENCY_SAMPLE_SIZE) return;
    // Periodic halving ages old popularity out, as in TinyLFU's reset.
    for (const [id, count] of this.frequency) {
      if (count <= 1) this.frequency.delete(id);
      else this.frequency.set(id, count >> 1);
    }
    this.frequencyEvents = 0;
  }

  /** Queues a parsed conversation for admission; returns its blocks too large to retain. */
  private offer(conversationId: string, key: CacheKey, blocks: readonly SearchBlockSource[]): number {
    let bytes = 0;
    let oversize = 0;
    for (const block of blocks) {
      const blockBytes = Buffer.byteLength(block.content, "utf8");
      if (blockBytes > this.maxBodyBytes) oversize += 1;
      bytes += blockBytes;
    }
    // An entry missing any block could never be read back as complete.
    if (oversize > 0 || bytes > this.maxCacheBytes) return oversize;
    if (bytes > 0 && this.victimsFor(conversationId, bytes) === null) return oversize;
    const queued = this.candidates.get(conversationId);
    if (queued) {
      this.candidates.delete(conversationId);
      this.candidateBytes -= queued.bytes;
    }
    if (this.candidateBytes + bytes > this.maxCacheBytes) return oversize;
    this.candidates.set(conversationId, { conversationId, key, blocks, bytes });
    this.candidateBytes += bytes;
    return oversize;
  }

  private scheduleMaintenance(): void {
    if (this.maintenance || this.closed) return;
    if (this.capsVerified && this.candidates.size === 0 && this.touches.size === 0) return;
    this.maintenance = this.maintain()
      .catch((error: unknown) => {
        // Searches re-offer whatever they still need; a failing pass must not retry in a loop.
        this.candidates.clear();
        this.candidateBytes = 0;
        this.touches.clear();
        getDaemonLogger()("error", "conversation_search_cache_maintenance_failed", {
          cache: this.cachePath,
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        this.maintenance = null;
        // Work offered while the last pass was finishing must not wait for the next search.
        this.scheduleMaintenance();
      });
  }

  private async maintain(): Promise<void> {
    const budget = new TurnBudget(MAINTENANCE_TURN_MS);
    for (;;) {
      await budget.yield();
      if (this.closed) return;
      this.flushTouches();
      if (!this.capsVerified) {
        this.capsVerified = true;
        if (!(await this.enforceCaps(budget))) return;
        continue;
      }
      const next = this.candidates.values().next();
      if (next.done) {
        if (this.mergeStep()) continue;
        return;
      }
      const candidate = next.value;
      this.candidates.delete(candidate.conversationId);
      this.candidateBytes -= candidate.bytes;
      if (!(await this.admit(candidate, budget))) return;
      if (!(await this.enforceCaps(budget))) return;
    }
  }

  /** Each `pause` may hand the loop back; false means the cache closed meanwhile. */
  private async pause(budget: TurnBudget): Promise<boolean> {
    await budget.yieldIfDue();
    return !this.closed;
  }

  /** One bounded FTS segment merge; false once nothing is left to merge. */
  private mergeStep(): boolean {
    // SQLite's documented progress test for 'merge': fewer than two changes means no work.
    const totalChanges = this.cache.prepare("SELECT total_changes() AS changes");
    const before = Number((totalChanges.get() as { changes: number }).changes);
    this.cache.prepare("INSERT INTO search_fts(search_fts, rank) VALUES ('merge', ?)").run(FTS_MERGE_PAGES);
    return Number((totalChanges.get() as { changes: number }).changes) - before >= 2;
  }

  private flushTouches(): void {
    if (this.touches.size === 0) return;
    this.cache.prepare(
      "UPDATE search_checkpoints SET accessed_at = ? WHERE conversation_id IN (SELECT value FROM json_each(?))",
    ).run(Date.now(), JSON.stringify([...this.touches]));
    this.touches.clear();
  }

  private async admit(candidate: AdmissionCandidate, budget: TurnBudget): Promise<boolean> {
    const { conversationId, key } = candidate;
    const current = this.cache.prepare(
      `SELECT 1 FROM search_checkpoints WHERE conversation_id = ? AND complete = 1
         AND source_version_id = ? AND parser_version = ? AND normalization_version = ?
         AND tokenizer_version = ? AND redaction_epoch = ?`,
    ).get(
      conversationId, key.sourceVersionId, key.parserVersion,
      key.normalizationVersion, key.tokenizerVersion, key.redactionEpoch,
    );
    if (current) return true;
    if (candidate.bytes > 0) {
      const victims = this.victimsFor(conversationId, candidate.bytes);
      if (victims === null) return true;
      for (const victim of victims) {
        if (!(await this.evict(victim, budget))) return false;
      }
    }
    return this.replace(candidate, budget);
  }

  /**
   * The least recently used residents that must leave for `conversationId` to
   * fit, or `null` when any of them has been searched at least as often.
   */
  private victimsFor(conversationId: string, bytes: number): string[] | null {
    let excess = this.residentBytes - (this.residents.get(conversationId)?.bytes ?? 0) + bytes - this.maxCacheBytes;
    if (excess <= 0) return [];
    const popularity = this.frequency.get(conversationId) ?? 0;
    const victims: string[] = [];
    for (const [id, resident] of this.residentsByRecency()) {
      if (id === conversationId) continue;
      if ((this.frequency.get(id) ?? 0) >= popularity) return null;
      victims.push(id);
      excess -= resident.bytes;
      if (excess <= 0) return victims;
    }
    return null;
  }

  private residentsByRecency(): Array<[string, { bytes: number; accessedAt: number }]> {
    return [...this.residents].sort((left, right) => left[1].accessedAt - right[1].accessedAt);
  }

  private async replace(candidate: AdmissionCandidate, budget: TurnBudget): Promise<boolean> {
    const { conversationId, key, blocks } = candidate;
    this.cache.prepare(
      `INSERT INTO search_checkpoints
        (conversation_id, source_version_id, parser_version, normalization_version,
         tokenizer_version, redaction_epoch, block_count, complete, accessed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)
       ON CONFLICT(conversation_id) DO UPDATE SET
         source_version_id=excluded.source_version_id, parser_version=excluded.parser_version,
         normalization_version=excluded.normalization_version, tokenizer_version=excluded.tokenizer_version,
         redaction_epoch=excluded.redaction_epoch, block_count=excluded.block_count,
         complete=0, accessed_at=excluded.accessed_at`,
    ).run(
      conversationId, key.sourceVersionId, key.parserVersion, key.normalizationVersion,
      key.tokenizerVersion, key.redactionEpoch, blocks.length, Date.now(),
    );
    if (!(await this.deleteBodies(conversationId, budget))) return false;
    const insertBody = this.cache.prepare(
      `INSERT INTO hot_bodies (conversation_id, block_id, block_type, role, position, body, body_bytes)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertFts = this.cache.prepare("INSERT INTO search_fts(rowid, body) VALUES (?, ?)");
    let next = 0;
    while (next < blocks.length) {
      if (!(await this.pause(budget))) return false;
      this.cache.transaction(() => {
        // Trigram indexing costs grow with bytes, so a chunk is bounded by both.
        let chunkBytes = 0;
        for (let rows = 0; next < blocks.length && rows < MAINTENANCE_CHUNK_ROWS && chunkBytes < MAINTENANCE_CHUNK_BYTES; rows += 1) {
          const block = blocks[next++];
          const bodyBytes = Buffer.byteLength(block.content, "utf8");
          const info = insertBody.run(
            conversationId, block.id, block.type, block.role, block.position, block.content, bodyBytes,
          );
          insertFts.run(Number(info.lastInsertRowid), block.content);
          chunkBytes += bodyBytes;
        }
        this.adjustResident(conversationId, chunkBytes);
      })();
      if (!(await this.pause(budget))) return false;
      this.mergeStep();
    }
    this.cache.prepare(
      "UPDATE search_checkpoints SET complete = 1 WHERE conversation_id = ? AND source_version_id = ?",
    ).run(conversationId, key.sourceVersionId);
    return true;
  }

  private async evict(conversationId: string, budget: TurnBudget): Promise<boolean> {
    this.cache.prepare("UPDATE search_checkpoints SET complete = 0 WHERE conversation_id = ?").run(conversationId);
    if (!(await this.deleteBodies(conversationId, budget))) return false;
    this.cache.prepare("DELETE FROM search_checkpoints WHERE conversation_id = ?").run(conversationId);
    return true;
  }

  private async deleteBodies(conversationId: string, budget: TurnBudget): Promise<boolean> {
    const select = this.cache.prepare("SELECT rowid, body_bytes FROM hot_bodies WHERE conversation_id = ? LIMIT ?");
    for (;;) {
      if (!(await this.pause(budget))) return false;
      const rows = select.all(conversationId, MAINTENANCE_CHUNK_ROWS) as Array<{ rowid: number; body_bytes: number }>;
      if (rows.length === 0) return true;
      const ids = JSON.stringify(rows.map((row) => row.rowid));
      this.cache.transaction(() => {
        this.cache.prepare("DELETE FROM search_fts WHERE rowid IN (SELECT value FROM json_each(?))").run(ids);
        this.cache.prepare("DELETE FROM hot_bodies WHERE rowid IN (SELECT value FROM json_each(?))").run(ids);
        this.adjustResident(conversationId, -rows.reduce((total, row) => total + row.body_bytes, 0));
      })();
      if (!(await this.pause(budget))) return false;
      this.mergeStep();
    }
  }

  /** Least recently used entries give way to the hard body and page caps. */
  private async enforceCaps(budget: TurnBudget): Promise<boolean> {
    while (this.residentBytes > this.maxCacheBytes || this.livePageBytes() > this.maxPhysicalBytes) {
      const victim = this.residentsByRecency()[0]?.[0];
      if (!victim) {
        // Contentless FTS can retain tombstone pages after every body has gone;
        // resetting the disposable file is the honest way to meet the cap.
        this.reset();
        return true;
      }
      if (!(await this.evict(victim, budget))) return false;
    }
    return this.compact(budget);
  }

  private async compact(budget: TurnBudget): Promise<boolean> {
    if (this.cachePath === ":memory:" || this.physicalBytes() <= this.maxPhysicalBytes) return true;
    this.cache.pragma("wal_checkpoint(TRUNCATE)");
    while (this.physicalBytes() > this.maxPhysicalBytes
      && Number(this.cache.pragma("freelist_count", { simple: true })) > 0) {
      if (!(await this.pause(budget))) return false;
      this.cache.pragma(`incremental_vacuum(${INCREMENTAL_VACUUM_PAGES})`);
      this.cache.pragma("wal_checkpoint(TRUNCATE)");
    }
    if (this.physicalBytes() > this.maxPhysicalBytes) this.reset();
    return true;
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
