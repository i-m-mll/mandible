import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

import SqliteDatabase from "../sqlite.js";

import type { Db } from "../db.js";
import type { BlockType, Role } from "../parsers/types.js";
import { getUserHome } from "../platform-paths.js";
import { conversationSourceEpochsMatch, type ConversationSourceEpochs } from "./source-types.js";

export const CONVERSATION_STRUCTURE_CACHE_VERSION = 3;

const BLOCK_TYPES: readonly BlockType[] = [
  "user_message",
  "assistant_message",
  "thinking",
  "plan",
  "tool_use",
  "tool_result",
  "system",
  "event",
];
const ROLES: readonly Role[] = ["user", "assistant", "system", "tool"];

const BLOCK_TYPE_TO_CODE = new Map(BLOCK_TYPES.map((value, index) => [value, index]));
const ROLE_TO_CODE = new Map(ROLES.map((value, index) => [value, index]));

export interface SparseConversationBlockRow {
  conversationId: string;
  sourceVersionId: string;
  position: number;
  type: BlockType;
  role: Role;
  parentPosition: number | null;
  recordOffset: number;
  recordLength: number;
  recordOrdinal: number;
  subBlockOrdinal: number;
  parserFormat: string;
  parserVersion: string;
  normalizationVersion: string;
  redactionEpoch: number;
}

export interface SparseConversationPage {
  rows: SparseConversationBlockRow[];
  total: number;
  offset: number;
  limit: number;
}

interface CacheConversationRow {
  cache_id: number;
  conversation_id: string;
  source_version_id: string;
  parser_format: string;
  parser_version: string;
  normalization_version: string;
  redaction_epoch: number;
  block_count: number;
}

interface CacheBlockRow {
  position: number;
  type_code: number;
  role_code: number;
  parent_position: number | null;
  record_offset: number;
  record_length: number;
  record_ordinal: number;
  sub_block_ordinal: number;
}

export interface SourceManifestRow {
  conversation_id: string;
  source_version_id: string;
  parser_format: string;
  parser_version: string;
  normalization_version: string;
  redaction_epoch: number;
  block_count: number;
}

export interface ConversationStructureCacheOptions {
  cachePath?: string;
}

export function defaultConversationStructureCachePath(db?: Db): string {
  const override = process.env.MANDIBLE_CONVERSATION_STRUCTURE_DB?.trim();
  if (override) return path.resolve(override);
  const dbName = db && typeof db.name === "string" ? db.name : "";
  if (dbName === ":memory:") return ":memory:";
  if ((process.env.VITEST === "true" || process.env.NODE_ENV === "test") && dbName) {
    return `${dbName}.conversation-structure.db`;
  }
  return path.join(getUserHome(), ".cache", "mandible", "conversations", "structure.db");
}

export function sparseConversationBlockId(conversationId: string, position: number): string {
  return `cblk:${conversationId}:${position}`;
}

export function sparseConversationBlockPosition(
  conversationId: string,
  blockRef: string,
): number | null {
  const prefix = `cblk:${conversationId}:`;
  if (!blockRef.startsWith(prefix)) return null;
  const raw = blockRef.slice(prefix.length);
  if (!/^\d+$/.test(raw)) return null;
  const position = Number(raw);
  return Number.isSafeInteger(position) ? position : null;
}

export function parseSparseConversationBlockId(
  blockRef: string,
): { conversationId: string; position: number } | null {
  if (!blockRef.startsWith("cblk:")) return null;
  const separator = blockRef.lastIndexOf(":");
  if (separator <= "cblk:".length) return null;
  const conversationId = blockRef.slice("cblk:".length, separator);
  const rawPosition = blockRef.slice(separator + 1);
  if (!conversationId || !/^\d+$/.test(rawPosition)) return null;
  const position = Number(rawPosition);
  return Number.isSafeInteger(position) ? { conversationId, position } : null;
}

function blockTypeCode(type: string): number {
  const code = BLOCK_TYPE_TO_CODE.get(type as BlockType);
  if (code === undefined) throw new Error(`unsupported conversation block type: ${type}`);
  return code;
}

function roleCode(role: string): number {
  const code = ROLE_TO_CODE.get(role as Role);
  if (code === undefined) throw new Error(`unsupported conversation block role: ${role}`);
  return code;
}

function decodeType(code: number): BlockType {
  const type = BLOCK_TYPES[code];
  if (!type) throw new Error(`invalid cached conversation block type code: ${code}`);
  return type;
}

function decodeRole(code: number): Role {
  const role = ROLES[code];
  if (!role) throw new Error(`invalid cached conversation block role code: ${code}`);
  return role;
}

function toolKey(toolId: string): Buffer {
  // A 128-bit binary digest keeps the lookup compact without squeezing the key
  // through JavaScript's 53-bit integer ceiling.
  return createHash("sha256").update(toolId).digest().subarray(0, 16);
}

/**
 * Disposable, integer-only directory from normalized block positions to exact
 * provider JSONL record ranges. Conversation text and durable ledger metadata
 * never enter this database. Its only job is to make native-source paging
 * fast; deleting the file may cost a rebuild but cannot lose user data.
 */
export class ConversationStructureCache {
  readonly cachePath: string;
  private readonly cache: SqliteDatabase;

  constructor(mainDb?: Db, options: ConversationStructureCacheOptions = {}) {
    this.cachePath = options.cachePath ?? defaultConversationStructureCachePath(mainDb);
    if (this.cachePath !== ":memory:") {
      fs.mkdirSync(path.dirname(this.cachePath), { recursive: true });
    }
    this.cache = new SqliteDatabase(this.cachePath);
    this.cache.pragma("journal_mode = WAL");
    this.cache.pragma("synchronous = NORMAL");
    this.cache.pragma("foreign_keys = ON");
    this.initialize();
  }

  private initialize(): void {
    this.cache.exec(`
      CREATE TABLE IF NOT EXISTS cache_meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS cache_conversations (
        cache_id               INTEGER PRIMARY KEY,
        conversation_id        TEXT NOT NULL UNIQUE,
        source_version_id      TEXT NOT NULL,
        parser_format          TEXT NOT NULL,
        parser_version         TEXT NOT NULL,
        normalization_version  TEXT NOT NULL,
        redaction_epoch        INTEGER NOT NULL,
        block_count            INTEGER NOT NULL,
        updated_at             INTEGER NOT NULL,
        accessed_at            INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS cache_blocks (
        cache_conversation_id  INTEGER NOT NULL
                                 REFERENCES cache_conversations(cache_id) ON DELETE CASCADE,
        position               INTEGER NOT NULL,
        type_code              INTEGER NOT NULL,
        role_code              INTEGER NOT NULL,
        parent_position        INTEGER,
        record_offset          INTEGER NOT NULL,
        record_length          INTEGER NOT NULL,
        record_ordinal         INTEGER NOT NULL,
        sub_block_ordinal      INTEGER NOT NULL,
        PRIMARY KEY (cache_conversation_id, position)
      ) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS cache_tool_links (
        cache_conversation_id INTEGER NOT NULL
          REFERENCES cache_conversations(cache_id) ON DELETE CASCADE,
        tool_key BLOB NOT NULL,
        position INTEGER NOT NULL,
        PRIMARY KEY (cache_conversation_id, tool_key)
      ) WITHOUT ROWID;
    `);
    const version = this.cache.prepare(
      "SELECT value FROM cache_meta WHERE key = 'schema_version'",
    ).get() as { value: string } | undefined;
    if (version && Number(version.value) !== CONVERSATION_STRUCTURE_CACHE_VERSION) {
      this.cache.exec("DELETE FROM cache_tool_links; DELETE FROM cache_blocks; DELETE FROM cache_conversations; DELETE FROM cache_meta");
    }
    this.cache.prepare(`INSERT INTO cache_meta (key, value) VALUES ('schema_version', ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(String(CONVERSATION_STRUCTURE_CACHE_VERSION));
  }

  close(): void {
    this.cache.close();
  }

  clear(): void {
    this.cache.exec("DELETE FROM cache_tool_links; DELETE FROM cache_blocks; DELETE FROM cache_conversations");
  }

  private manifest(mainDb: Db, conversationId: string): SourceManifestRow | null {
    return (mainDb.prepare(`
      SELECT c.id AS conversation_id, source.current_version_id AS source_version_id,
             source.parser_format, source.parser_version, source.normalization_version,
             source.redaction_epoch, c.block_count
        FROM conversations c
        JOIN conversation_sources source ON source.conversation_id = c.id
       WHERE c.id = ? AND source.current_version_id IS NOT NULL
       ORDER BY CASE source.availability WHEN 'available' THEN 0 ELSE 1 END, source.updated_at DESC
       LIMIT 1
    `).get(conversationId) as SourceManifestRow | undefined) ?? null;
  }

  private cacheConversation(manifest: SourceManifestRow, mode: "replace" | "append"): number {
    const existing = this.cache.prepare(
      "SELECT cache_id, source_version_id FROM cache_conversations WHERE conversation_id = ?",
    ).get(manifest.conversation_id) as { cache_id: number; source_version_id: string } | undefined;
    const now = Date.now();
    if (!existing) {
      const inserted = this.cache.prepare(`
        INSERT INTO cache_conversations (
          conversation_id, source_version_id, parser_format, parser_version,
          normalization_version, redaction_epoch, block_count, updated_at, accessed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        manifest.conversation_id, manifest.source_version_id, manifest.parser_format,
        manifest.parser_version, manifest.normalization_version, manifest.redaction_epoch,
        manifest.block_count, now, now,
      );
      return Number(inserted.lastInsertRowid);
    }
    if (mode === "replace") {
      this.cache.prepare("DELETE FROM cache_tool_links WHERE cache_conversation_id = ?").run(existing.cache_id);
      this.cache.prepare("DELETE FROM cache_blocks WHERE cache_conversation_id = ?").run(existing.cache_id);
    }
    this.cache.prepare(`
      UPDATE cache_conversations
         SET source_version_id = ?, parser_format = ?, parser_version = ?,
             normalization_version = ?, redaction_epoch = ?, block_count = ?,
             updated_at = ?, accessed_at = ?
       WHERE cache_id = ?
    `).run(
      manifest.source_version_id, manifest.parser_format, manifest.parser_version,
      manifest.normalization_version, manifest.redaction_epoch, manifest.block_count,
      now, now, existing.cache_id,
    );
    return existing.cache_id;
  }

  captureDenseRows(
    mainDb: Db,
    conversationId: string,
    mode: "replace" | "append",
    parentPositions?: ReadonlyMap<number, number | null>,
    toolPositions?: ReadonlyMap<string, number>,
  ): { captured: number; cached: number; sourceVersionId: string | null } {
    const manifest = this.manifest(mainDb, conversationId);
    if (!manifest) return { captured: 0, cached: 0, sourceVersionId: null };
    const dense = mainDb.prepare(`
      SELECT block.position, block.type, block.role,
             parent.position AS parent_position,
             block.record_offset, block.record_length, block.record_ordinal,
             block.sub_block_ordinal
        FROM conversation_structural_blocks block
        LEFT JOIN conversation_structural_blocks parent ON parent.id = block.parent_block_id
       WHERE block.conversation_id = ? AND block.status = 'current'
         AND block.record_offset IS NOT NULL AND block.record_length IS NOT NULL
         AND block.record_ordinal IS NOT NULL
       ORDER BY block.position
    `).iterate(conversationId) as IterableIterator<{
      position: number;
      type: string;
      role: string;
      parent_position: number | null;
      record_offset: number;
      record_length: number;
      record_ordinal: number;
      sub_block_ordinal: number;
    }>;
    let captured = 0;
    let cached = 0;
    const write = this.cache.transaction(() => {
      const cacheId = this.cacheConversation(manifest, mode);
      const insert = this.cache.prepare(`
        INSERT INTO cache_blocks (
          cache_conversation_id, position, type_code, role_code, parent_position,
          record_offset, record_length, record_ordinal, sub_block_ordinal
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(cache_conversation_id, position) DO UPDATE SET
          type_code = excluded.type_code, role_code = excluded.role_code,
          parent_position = excluded.parent_position, record_offset = excluded.record_offset,
          record_length = excluded.record_length, record_ordinal = excluded.record_ordinal,
          sub_block_ordinal = excluded.sub_block_ordinal
      `);
      const insertTool = this.cache.prepare(`
        INSERT INTO cache_tool_links (cache_conversation_id, tool_key, position)
        VALUES (?, ?, ?)
        ON CONFLICT(cache_conversation_id, tool_key) DO UPDATE SET position = excluded.position
      `);
      for (const row of dense) {
        const parentPosition = parentPositions?.has(row.position)
          ? parentPositions.get(row.position) ?? null
          : row.parent_position;
        insert.run(
          cacheId, row.position, blockTypeCode(row.type), roleCode(row.role), parentPosition,
          row.record_offset, row.record_length, row.record_ordinal, row.sub_block_ordinal,
        );
        captured += 1;
      }
      for (const [toolId, position] of toolPositions ?? []) {
        insertTool.run(cacheId, toolKey(toolId), position);
      }
      cached = (this.cache.prepare(
        "SELECT COUNT(*) AS count FROM cache_blocks WHERE cache_conversation_id = ?",
      ).get(cacheId) as { count: number }).count;
      this.cache.prepare("UPDATE cache_conversations SET block_count = ? WHERE cache_id = ?")
        .run(cached, cacheId);
    });
    write();
    return { captured, cached, sourceVersionId: manifest.source_version_id };
  }

  replaceRows(
    manifest: SourceManifestRow,
    rows: readonly Omit<SparseConversationBlockRow,
      "conversationId" | "sourceVersionId" | "parserFormat" | "parserVersion" |
      "normalizationVersion" | "redactionEpoch">[],
  ): void {
    const write = this.cache.transaction(() => {
      const cacheId = this.cacheConversation(manifest, "replace");
      const insert = this.cache.prepare(`
        INSERT INTO cache_blocks (
          cache_conversation_id, position, type_code, role_code, parent_position,
          record_offset, record_length, record_ordinal, sub_block_ordinal
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const row of rows) {
        insert.run(
          cacheId, row.position, blockTypeCode(row.type), roleCode(row.role), row.parentPosition,
          row.recordOffset, row.recordLength, row.recordOrdinal, row.subBlockOrdinal,
        );
      }
      this.cache.prepare("UPDATE cache_conversations SET block_count = ? WHERE cache_id = ?")
        .run(rows.length, cacheId);
    });
    write();
  }

  private cachedConversation(conversationId: string, sourceVersionId: string): CacheConversationRow | null {
    return (this.cache.prepare(`
      SELECT cache_id, conversation_id, source_version_id, parser_format, parser_version,
             normalization_version, redaction_epoch, block_count
        FROM cache_conversations
       WHERE conversation_id = ? AND source_version_id = ?
    `).get(conversationId, sourceVersionId) as CacheConversationRow | undefined) ?? null;
  }

  readPage(
    conversationId: string,
    sourceVersionId: string,
    options: { offset: number; limit: number; types?: readonly string[]; prefix?: { blockCount: number; byteLength: number; verified?: boolean } },
  ): SparseConversationPage | null {
    const conversation = this.cachedConversation(conversationId, sourceVersionId);
    if (!conversation) return null;
    const typeCodes = options.types?.map(blockTypeCode);
    const conditions = ["cache_conversation_id = ?"];
    const params: unknown[] = [conversation.cache_id];
    if (options.prefix) {
      conditions.push("position >= 0 AND position < ?", "record_offset >= 0 AND record_length >= 0 AND record_offset + record_length <= ?",
        "(parent_position IS NULL OR (parent_position >= 0 AND parent_position < ?))");
      params.push(options.prefix.blockCount, options.prefix.byteLength, options.prefix.blockCount);
      if (!options.prefix.verified) {
        const coverage = this.cache.prepare(`SELECT COUNT(*) AS count, MIN(position) AS first, MAX(position) AS last
          FROM cache_blocks WHERE ${conditions.join(" AND ")}`).get(...params) as { count: number; first: number | null; last: number | null };
        if (coverage.count !== options.prefix.blockCount || (coverage.count > 0 && (coverage.first !== 0 || coverage.last !== coverage.count - 1))) return null;
      }
    }
    if (typeCodes && typeCodes.length > 0) {
      conditions.push(`type_code IN (${typeCodes.map(() => "?").join(",")})`);
      params.push(...typeCodes);
    }
    const where = conditions.join(" AND ");
    const total = typeCodes && typeCodes.length > 0
      ? (this.cache.prepare(`SELECT COUNT(*) AS count FROM cache_blocks WHERE ${where}`)
        .get(...params) as { count: number }).count
      : options.prefix?.blockCount ?? conversation.block_count;
    const rows = this.cache.prepare(`
      SELECT position, type_code, role_code, parent_position, record_offset,
             record_length, record_ordinal, sub_block_ordinal
        FROM cache_blocks WHERE ${where}
       ORDER BY position LIMIT ? OFFSET ?
    `).all(...params, options.limit, options.offset) as CacheBlockRow[];
    this.cache.prepare("UPDATE cache_conversations SET accessed_at = ? WHERE cache_id = ?")
      .run(Date.now(), conversation.cache_id);
    return {
      rows: rows.map((row) => ({
        conversationId,
        sourceVersionId,
        position: row.position,
        type: decodeType(row.type_code),
        role: decodeRole(row.role_code),
        parentPosition: row.parent_position,
        recordOffset: row.record_offset,
        recordLength: row.record_length,
        recordOrdinal: row.record_ordinal,
        subBlockOrdinal: row.sub_block_ordinal,
        parserFormat: conversation.parser_format,
        parserVersion: conversation.parser_version,
        normalizationVersion: conversation.normalization_version,
        redactionEpoch: conversation.redaction_epoch,
      })),
      total,
      offset: options.offset,
      limit: options.limit,
    };
  }

  readStructure(conversationId: string, sourceVersionId: string): Array<{
    position: number;
    type: BlockType;
    role: Role;
    parentPosition: number | null;
    recordOffset: number;
    recordLength: number;
  }> | null {
    const conversation = this.cachedConversation(conversationId, sourceVersionId);
    if (!conversation) return null;
    const rows = this.cache.prepare(`
      SELECT position, type_code, role_code, parent_position, record_offset, record_length
        FROM cache_blocks WHERE cache_conversation_id = ? ORDER BY position
    `).all(conversation.cache_id) as Array<Pick<CacheBlockRow,
      "position" | "type_code" | "role_code" | "parent_position" | "record_offset" | "record_length">>;
    if (rows.length !== conversation.block_count) return null;
    return rows.map((row) => ({
      position: row.position,
      type: decodeType(row.type_code),
      role: decodeRole(row.role_code),
      parentPosition: row.parent_position,
      recordOffset: row.record_offset,
      recordLength: row.record_length,
    }));
  }

  readPosition(
    conversationId: string,
    sourceVersionId: string,
    position: number,
  ): SparseConversationBlockRow | null {
    const conversation = this.cachedConversation(conversationId, sourceVersionId);
    if (!conversation) return null;
    const row = this.cache.prepare(`
      SELECT position, type_code, role_code, parent_position, record_offset,
             record_length, record_ordinal, sub_block_ordinal
        FROM cache_blocks WHERE cache_conversation_id = ? AND position = ?
    `).get(conversation.cache_id, position) as CacheBlockRow | undefined;
    if (!row) return null;
    return {
      conversationId,
      sourceVersionId,
      position: row.position,
      type: decodeType(row.type_code),
      role: decodeRole(row.role_code),
      parentPosition: row.parent_position,
      recordOffset: row.record_offset,
      recordLength: row.record_length,
      recordOrdinal: row.record_ordinal,
      subBlockOrdinal: row.sub_block_ordinal,
      parserFormat: conversation.parser_format,
      parserVersion: conversation.parser_version,
      normalizationVersion: conversation.normalization_version,
      redactionEpoch: conversation.redaction_epoch,
    };
  }

  hasCompleteConversation(
    conversationId: string,
    sourceVersionId: string,
    expectedBlockCount: number,
    epochs?: ConversationSourceEpochs,
  ): boolean {
    const conversation = this.cachedConversation(conversationId, sourceVersionId);
    return conversation?.block_count === expectedBlockCount && (!epochs || conversationSourceEpochsMatch({
      parserFormat: conversation.parser_format,
      parserVersion: conversation.parser_version,
      normalizationVersion: conversation.normalization_version,
      redactionEpoch: conversation.redaction_epoch,
    }, epochs));
  }

  blockCount(conversationId: string, sourceVersionId: string): number | null {
    return this.cachedConversation(conversationId, sourceVersionId)?.block_count ?? null;
  }

  turnPosition(
    conversationId: string,
    sourceVersionId: string,
    position: number,
  ): number | null {
    const conversation = this.cachedConversation(conversationId, sourceVersionId);
    if (!conversation) return null;
    const userType = blockTypeCode("user_message");
    const target = this.cache.prepare(`
      SELECT type_code FROM cache_blocks
       WHERE cache_conversation_id = ? AND position = ?
    `).get(conversation.cache_id, position) as { type_code: number } | undefined;
    if (!target) return null;
    if (target.type_code === userType) return position;
    const previousUser = this.cache.prepare(`
      SELECT MAX(position) AS position FROM cache_blocks
       WHERE cache_conversation_id = ? AND position <= ? AND type_code = ?
    `).get(conversation.cache_id, position, userType) as { position: number | null };
    return (this.cache.prepare(`
      SELECT MIN(position) AS position FROM cache_blocks
       WHERE cache_conversation_id = ? AND position <= ? AND position > ?
         AND type_code != ?
    `).get(
      conversation.cache_id,
      position,
      previousUser.position ?? -1,
      userType,
    ) as { position: number | null }).position ?? position;
  }

  /** First block that must be materialized to show the target's complete turn. */
  turnWindowStart(
    conversationId: string,
    sourceVersionId: string,
    position: number,
  ): number | null {
    const conversation = this.cachedConversation(conversationId, sourceVersionId);
    if (!conversation) return null;
    const userType = blockTypeCode("user_message");
    const target = this.cache.prepare(`
      SELECT type_code FROM cache_blocks
       WHERE cache_conversation_id = ? AND position = ?
    `).get(conversation.cache_id, position) as { type_code: number } | undefined;
    if (!target) return null;
    if (target.type_code === userType) return position;
    const previousUser = this.cache.prepare(`
      SELECT MAX(position) AS position FROM cache_blocks
       WHERE cache_conversation_id = ? AND position <= ? AND type_code = ?
    `).get(conversation.cache_id, position, userType) as { position: number | null };
    if (previousUser.position !== null) return previousUser.position;
    return (this.cache.prepare(`
      SELECT MIN(position) AS position FROM cache_blocks
       WHERE cache_conversation_id = ? AND position <= ?
    `).get(conversation.cache_id, position) as { position: number | null }).position;
  }

  findToolPosition(conversationId: string, toolId: string): number | null {
    const conversation = this.cache.prepare(
      "SELECT cache_id FROM cache_conversations WHERE conversation_id = ?",
    ).get(conversationId) as { cache_id: number } | undefined;
    if (!conversation) return null;
    return (this.cache.prepare(`
      SELECT position FROM cache_tool_links
       WHERE cache_conversation_id = ? AND tool_key = ?
    `).get(conversation.cache_id, toolKey(toolId)) as { position: number } | undefined)?.position ?? null;
  }

  stats(): { conversations: number; blocks: number; fileBytes: number | null } {
    const conversations = (this.cache.prepare("SELECT COUNT(*) AS count FROM cache_conversations")
      .get() as { count: number }).count;
    const blocks = (this.cache.prepare("SELECT COUNT(*) AS count FROM cache_blocks")
      .get() as { count: number }).count;
    const fileBytes = this.cachePath === ":memory:" || !fs.existsSync(this.cachePath)
      ? null
      : fs.statSync(this.cachePath).size;
    return { conversations, blocks, fileBytes };
  }
}

const services = new WeakMap<Db, ConversationStructureCache>();

export function getConversationStructureCache(db: Db): ConversationStructureCache {
  const existing = services.get(db);
  if (existing) return existing;
  const service = new ConversationStructureCache(db);
  services.set(db, service);
  return service;
}
