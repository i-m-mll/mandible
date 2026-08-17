import { createHash } from "node:crypto";
import * as fs from "node:fs";
import path from "node:path";
import { decompressContent } from "../compression.js";
import { maskActiveCredentialsInText } from "../credential-leak-scan.js";
import type { Db } from "../db.js";
import { getAllParsers } from "../parsers/index.js";
import type { ConversationBlock, ConversationSource } from "../parsers/types.js";
import { ConversationSourceStore } from "./source-store.js";
import type {
  ConversationBlockLocator,
  SourceBackedConversationBlock,
  SourceBlockPage,
  SourceReadFailureKind,
  SourceReadResult,
} from "./source-types.js";

const DEFAULT_MAX_SOURCE_BYTES = 32 * 1024 * 1024;

interface StructuralRow {
  id: string;
  conversation_id: string;
  source_version_id: string;
  position: number;
  type: string;
  role: string;
  timestamp: string | null;
  parent_block_id: string | null;
  dag_uuid: string | null;
  dag_parent_uuid: string | null;
  record_offset: number;
  record_length: number;
  record_hash: string;
  record_ordinal: number;
  sub_block_ordinal: number;
  normalization_checkpoint_id: string | null;
  parser_format: string;
  parser_version: string;
  normalization_version: string;
  redaction_epoch: number;
}

interface VersionRow {
  id: string;
  content_sha256: string;
  byte_length: number;
  parser_format: string;
  parser_version: string;
  normalization_version: string;
  redaction_epoch: number;
}

interface LegacyRow {
  id: string;
  conversation_id: string;
  type: string;
  role: string;
  content: Buffer | string;
  compressed: number;
  position: number;
  timestamp: string | null;
  parent_id: string | null;
  metadata_json: string;
  dag_uuid: string | null;
  dag_parent_uuid: string | null;
}

type SnapshotResult =
  | { ok: true; bytes: Buffer; version: VersionRow; provider: ConversationSource }
  | { ok: false; kind: SourceReadFailureKind; reason: string };

function insideRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function locator(row: StructuralRow): ConversationBlockLocator {
  return {
    sourceVersionId: row.source_version_id,
    recordOffset: row.record_offset,
    recordLength: row.record_length,
    recordHash: row.record_hash,
    recordOrdinal: row.record_ordinal,
    subBlockOrdinal: row.sub_block_ordinal,
    normalizationCheckpointId: row.normalization_checkpoint_id,
    parserFormat: row.parser_format,
    parserVersion: row.parser_version,
    normalizationVersion: row.normalization_version,
    redactionEpoch: row.redaction_epoch,
  };
}

function legacyBlock(row: LegacyRow): SourceBackedConversationBlock {
  return {
    id: row.id,
    conversation_id: row.conversation_id,
    type: row.type as SourceBackedConversationBlock["type"],
    role: row.role as SourceBackedConversationBlock["role"],
    content: decompressContent(row.content, row.compressed === 1),
    position: row.position,
    timestamp: row.timestamp,
    parent_id: row.parent_id,
    metadata_json: row.metadata_json,
    dag_uuid: row.dag_uuid,
    dag_parent_uuid: row.dag_parent_uuid,
    locator: null,
  };
}

export interface ConversationSourceReaderOptions {
  legacyFallback?: boolean;
  maxSourceBytes?: number;
}

/**
 * Verified dual reader. Source bytes are preferred, while the legacy normalized
 * body remains an explicit safe fallback until the later cutover gate flips it.
 */
export class ConversationSourceReader {
  private readonly store: ConversationSourceStore;
  private readonly legacyFallback: boolean;
  private readonly maxSourceBytes: number;

  constructor(private readonly db: Db, options: ConversationSourceReaderOptions = {}) {
    this.store = new ConversationSourceStore(db);
    this.legacyFallback = options.legacyFallback !== false;
    this.maxSourceBytes = options.maxSourceBytes ?? DEFAULT_MAX_SOURCE_BYTES;
  }

  async readBlock(blockRef: string): Promise<SourceReadResult<SourceBackedConversationBlock>> {
    const durableId = this.store.resolveLegacyBlockId(blockRef) ?? blockRef;
    const row = this.db.prepare(`
      SELECT * FROM conversation_structural_blocks WHERE id = ? AND status = 'current'
    `).get(durableId) as StructuralRow | undefined;
    if (!row) {
      const legacy = this.db.prepare(
        "SELECT * FROM conversation_blocks WHERE id = ?",
      ).get(blockRef) as LegacyRow | undefined;
      if (legacy && this.legacyFallback) return { status: "legacy", value: legacyBlock(legacy), reason: "not_found" };
      return { status: "not_found", reason: "conversation block was not found" };
    }
    const page = await this.readStructuralRows(row.conversation_id, [row], row.position);
    if (page.status === "source" || page.status === "legacy") {
      const value = page.value.blocks[0];
      if (value) return { ...page, value };
      return { status: "not_found", reason: "conversation block was not produced by the parser" };
    }
    return page;
  }

  async readPage(
    conversationId: string,
    options: { offset?: number; limit?: number; types?: readonly string[] } = {},
  ): Promise<SourceReadResult<SourceBlockPage>> {
    const offset = Math.max(0, options.offset ?? 0);
    const limit = Math.max(1, Math.min(500, options.limit ?? 100));
    const params: unknown[] = [conversationId];
    const conditions = ["conversation_id = ?", "status = 'current'"];
    if (options.types && options.types.length > 0) {
      conditions.push(`type IN (${options.types.map(() => "?").join(",")})`);
      params.push(...options.types);
    }
    const where = conditions.join(" AND ");
    const total = (this.db.prepare(
      `SELECT COUNT(*) AS total FROM conversation_structural_blocks WHERE ${where}`,
    ).get(...params) as { total: number }).total;
    const rows = this.db.prepare(`
      SELECT * FROM conversation_structural_blocks
       WHERE ${where}
       ORDER BY position LIMIT ? OFFSET ?
    `).all(...params, limit, offset) as StructuralRow[];

    if (rows.length === 0) {
      return this.legacyPage(conversationId, offset, limit, options.types, "not_found");
    }
    const result = await this.readStructuralRows(conversationId, rows, offset, options.types);
    if (result.status === "source" || result.status === "legacy") {
      return { ...result, value: { ...result.value, total, offset, limit } };
    }
    return result;
  }

  async readAll(conversationId: string): Promise<SourceReadResult<SourceBackedConversationBlock[]>> {
    const rows = this.db.prepare(`
      SELECT * FROM conversation_structural_blocks
       WHERE conversation_id = ? AND status = 'current'
       ORDER BY position
    `).all(conversationId) as StructuralRow[];
    if (rows.length === 0) {
      const legacy = this.legacyPage(conversationId, 0, Number.MAX_SAFE_INTEGER, undefined, "not_found");
      if (legacy.status === "source" || legacy.status === "legacy") {
        return { ...legacy, value: legacy.value.blocks };
      }
      return legacy;
    }
    const result = await this.readStructuralRows(conversationId, rows, 0);
    if (result.status === "source" || result.status === "legacy") {
      return { ...result, value: result.value.blocks };
    }
    return result;
  }

  async streamBlocks(
    conversationId: string,
    visitor: (block: SourceBackedConversationBlock) => void | Promise<void>,
    pageSize = 100,
  ): Promise<SourceReadResult<number>> {
    let offset = 0;
    let count = 0;
    for (;;) {
      const page = await this.readPage(conversationId, { offset, limit: pageSize });
      if (page.status !== "source" && page.status !== "legacy") return page;
      for (const block of page.value.blocks) {
        await visitor(block);
        count += 1;
      }
      offset += page.value.blocks.length;
      if (offset >= page.value.total || page.value.blocks.length === 0) {
        return page.status === "source"
          ? { status: "source", value: count, sourceVersionId: page.sourceVersionId }
          : { status: "legacy", value: count, reason: page.reason };
      }
    }
  }

  private async readStructuralRows(
    conversationId: string,
    rows: StructuralRow[],
    fallbackOffset: number,
    fallbackTypes?: readonly string[],
  ): Promise<SourceReadResult<SourceBlockPage>> {
    if (!rows[0].source_version_id || rows[0].record_offset == null || rows[0].record_hash == null) {
      return this.legacyPage(conversationId, fallbackOffset, rows.length, fallbackTypes, "unsupported", "source locator has not been indexed");
    }
    const snapshot = await this.openVerifiedSnapshot(conversationId, rows[0].source_version_id);
    if (!snapshot.ok) {
      return this.legacyPage(conversationId, fallbackOffset, rows.length, fallbackTypes, snapshot.kind, snapshot.reason);
    }
    for (const row of rows) {
      if (row.source_version_id !== snapshot.version.id) {
        return this.legacyPage(conversationId, fallbackOffset, rows.length, fallbackTypes, "stale", "page spans source versions");
      }
      const end = row.record_offset + row.record_length;
      if (row.record_offset < 0 || row.record_length < 0 || end > snapshot.bytes.length) {
        return this.legacyPage(conversationId, fallbackOffset, rows.length, fallbackTypes, "stale", "record range is outside source bytes");
      }
      const recordHash = createHash("sha256")
        .update(snapshot.bytes.subarray(row.record_offset, end)).digest("hex");
      if (recordHash !== row.record_hash) {
        return this.legacyPage(conversationId, fallbackOffset, rows.length, fallbackTypes, "stale", "record hash mismatch");
      }
    }

    const parser = getAllParsers().find((candidate) => candidate.source === snapshot.provider);
    if (!parser?.parseIncremental) {
      return this.legacyPage(conversationId, fallbackOffset, rows.length, fallbackTypes, "unsupported", "provider has no snapshot parser");
    }
    if (
      snapshot.version.parser_format !== "provider-jsonl"
      || snapshot.version.parser_version !== "1"
      || snapshot.version.normalization_version !== "1"
    ) {
      return this.legacyPage(conversationId, fallbackOffset, rows.length, fallbackTypes, "unsupported", "recorded parser epoch is unavailable");
    }
    const parsed = await parser.parseIncremental({
      filePath: "source-snapshot.jsonl",
      raw: snapshot.bytes.toString("utf8"),
      baseBlockCount: 0,
      baseRecordCount: 0,
      sourceHash: snapshot.version.content_sha256,
      sourceMtime: 0,
    });
    if (!parsed) {
      return this.legacyPage(conversationId, fallbackOffset, rows.length, fallbackTypes, "stale", "verified source produced no blocks");
    }
    const parsedByPosition = new Map(parsed.blocks.map((block) => [block.position, block]));
    const blocks: SourceBackedConversationBlock[] = [];
    for (const row of rows) {
      const block = parsedByPosition.get(row.position);
      if (!block || block.type !== row.type || block.role !== row.role) {
        return this.legacyPage(conversationId, fallbackOffset, rows.length, fallbackTypes, "stale", "parser output no longer matches structural identity");
      }
      blocks.push(this.sourceBlock(row, block));
    }
    return {
      status: "source",
      value: { blocks, total: blocks.length, offset: rows[0].position, limit: rows.length },
      sourceVersionId: snapshot.version.id,
    };
  }

  private sourceBlock(
    row: StructuralRow,
    block: Omit<ConversationBlock, "id" | "conversation_id">,
  ): SourceBackedConversationBlock {
    return {
      id: row.id,
      conversation_id: row.conversation_id,
      type: block.type,
      role: block.role,
      content: maskActiveCredentialsInText(this.db, block.content).text,
      position: row.position,
      timestamp: block.timestamp ?? row.timestamp,
      parent_id: row.parent_block_id,
      metadata_json: maskActiveCredentialsInText(this.db, JSON.stringify(block.metadata)).text,
      dag_uuid: block.dag_uuid ?? row.dag_uuid,
      dag_parent_uuid: block.dag_parent_uuid ?? row.dag_parent_uuid,
      locator: locator(row),
    };
  }

  private legacyPage(
    conversationId: string,
    offset: number,
    limit: number,
    types: readonly string[] | undefined,
    reason: SourceReadFailureKind,
    detail: string = reason,
  ): SourceReadResult<SourceBlockPage> {
    if (!this.legacyFallback) return { status: reason, reason: detail };
    const params: unknown[] = [conversationId];
    const conditions = ["conversation_id = ?"];
    if (types && types.length > 0) {
      conditions.push(`type IN (${types.map(() => "?").join(",")})`);
      params.push(...types);
    }
    const where = conditions.join(" AND ");
    const total = (this.db.prepare(
      `SELECT COUNT(*) AS total FROM conversation_blocks WHERE ${where}`,
    ).get(...params) as { total: number }).total;
    const rows = this.db.prepare(`
      SELECT * FROM conversation_blocks WHERE ${where}
       ORDER BY position LIMIT ? OFFSET ?
    `).all(...params, limit, offset) as LegacyRow[];
    return {
      status: "legacy",
      value: { blocks: rows.map(legacyBlock), total, offset, limit },
      reason,
    };
  }

  private async openVerifiedSnapshot(conversationId: string, versionId: string): Promise<SnapshotResult> {
    const source = this.store.resolveConversation(conversationId);
    if (!source || source.currentVersionId !== versionId) {
      return { ok: false, kind: "stale", reason: "source version is not current" };
    }
    if (source.availability !== "available") {
      return { ok: false, kind: "unavailable", reason: source.unavailableReason ?? source.availability };
    }
    const version = this.db.prepare(`
      SELECT id, content_sha256, byte_length, parser_format, parser_version,
             normalization_version, redaction_epoch
        FROM conversation_source_versions WHERE id = ? AND availability = 'available'
    `).get(versionId) as VersionRow | undefined;
    if (!version) return { ok: false, kind: "unavailable", reason: "source version is unavailable" };
    if (version.byte_length > this.maxSourceBytes) {
      return { ok: false, kind: "unsupported", reason: "source exceeds bounded cold-read limit" };
    }

    for (const alias of this.store.listAliases(source.sourceId)) {
      if (alias.availability !== "available") continue;
      try {
        const rootReal = await fs.promises.realpath(alias.rootPath);
        const declared = path.resolve(alias.rootPath, alias.relativePath);
        if (declared !== path.resolve(alias.path) || !insideRoot(path.resolve(alias.rootPath), declared)) continue;
        const fileReal = await fs.promises.realpath(declared);
        if (!insideRoot(rootReal, fileReal)) continue;
        const handle = await fs.promises.open(fileReal, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
        try {
          const before = await handle.stat();
          if (!before.isFile() || before.size !== version.byte_length || before.size > this.maxSourceBytes) continue;
          const bytes = Buffer.alloc(before.size);
          let read = 0;
          while (read < bytes.length) {
            const result = await handle.read(bytes, read, bytes.length - read, read);
            if (result.bytesRead === 0) break;
            read += result.bytesRead;
          }
          const after = await handle.stat();
          if (
            read !== bytes.length || before.dev !== after.dev || before.ino !== after.ino
            || before.size !== after.size || before.mtimeMs !== after.mtimeMs
          ) continue;
          if (createHash("sha256").update(bytes).digest("hex") !== version.content_sha256) continue;
          return { ok: true, bytes, version, provider: source.provider };
        } finally {
          await handle.close();
        }
      } catch {
        // Try another durable alias (for example Codex active/archive relocation).
      }
    }
    return { ok: false, kind: "stale", reason: "no root-confined alias matches the recorded source version" };
  }
}
