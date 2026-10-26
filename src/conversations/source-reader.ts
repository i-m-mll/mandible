import { createHash } from "node:crypto";
import { decompressContent } from "../compression.js";
import {
  maskActiveCredentialsInText,
  maskUnverifiedCandidates,
} from "../credential-leak-scan.js";
import type { Db } from "../db.js";
import { getAllParsers } from "../parsers/index.js";
import type { ConversationBlock, ConversationSource } from "../parsers/types.js";
import { ConversationSourceStore } from "./source-store.js";
import {
  observeStableSourceAlias,
  observeStableSourceAliasExtent,
  observeStableSourceAliasRanges,
  sameSourceFilesystemIdentity,
  SourceObservationError,
} from "./source-observer.js";
import type {
  ConversationBlockLocator,
  SourceBackedConversationBlock,
  SourceBlockPage,
  SourceReadFailureKind,
  SourceReadResult,
} from "./source-types.js";
import { CURRENT_CONVERSATION_SOURCE_EPOCHS } from "./source-types.js";
import {
  getConversationStructureCache,
  parseSparseConversationBlockId,
  sparseConversationBlockId,
  type SparseConversationBlockRow,
} from "./structure-cache.js";
import {
  MANAGED_NORMALIZED_SOURCE_EPOCHS,
  parseManagedNormalizedRecord,
} from "./managed-normalized-source.js";

const DEFAULT_MAX_SOURCE_BYTES = 128 * 1024 * 1024;
const MAX_SOURCE_RECORD_BYTES = 64 * 1024 * 1024;

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
  source_id: string;
  content_sha256: string;
  byte_length: number;
  parser_format: string;
  parser_version: string;
  normalization_version: string;
  redaction_epoch: number;
  filesystem_device: string | null;
  filesystem_inode: string | null;
  filesystem_ctime_ns: string | null;
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

interface ConversationReadContext {
  source: ConversationSource;
  model: string | null;
}

interface CheckpointRow {
  id: string;
  source_version_id: string;
  parser_format: string;
  parser_version: string;
  normalization_version: string;
  redaction_epoch: number;
  state_json: string;
}

type SnapshotResult =
  | { ok: true; records: Map<string, Buffer>; version: VersionRow; provider: ConversationSource; nativeSessionId: string; aliasPath: string }
  | { ok: false; kind: SourceReadFailureKind; reason: string };

function recordKey(row: Pick<StructuralRow, "record_offset" | "record_length">): string {
  return `${row.record_offset}:${row.record_length}`;
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
  /** Trusted internal scanners can inspect raw parsed bytes without serializing them. */
  maskCredentials?: boolean;
}

/**
 * Verified dual reader. Source bytes are preferred, while the legacy normalized
 * body remains an explicit safe fallback until the later cutover gate flips it.
 */
export class ConversationSourceReader {
  private readonly store: ConversationSourceStore;
  private readonly structureCache;
  private readonly legacyFallback: boolean;
  private readonly maxSourceBytes: number;
  private readonly maskCredentials: boolean;

  constructor(private readonly db: Db, options: ConversationSourceReaderOptions = {}) {
    this.store = new ConversationSourceStore(db);
    this.structureCache = getConversationStructureCache(db);
    this.legacyFallback = options.legacyFallback !== false;
    this.maxSourceBytes = options.maxSourceBytes ?? DEFAULT_MAX_SOURCE_BYTES;
    this.maskCredentials = options.maskCredentials !== false;
  }

  async readBlock(blockRef: string): Promise<SourceReadResult<SourceBackedConversationBlock>> {
    const durableId = this.store.resolveLegacyBlockId(blockRef) ?? blockRef;
    const row = this.db.prepare(`
      SELECT * FROM conversation_structural_blocks WHERE id = ? AND status = 'current'
    `).get(durableId) as StructuralRow | undefined;
    if (!row) {
      const sparseRef = parseSparseConversationBlockId(blockRef);
      if (sparseRef) {
        const source = this.store.resolveConversation(sparseRef.conversationId);
        const sparse = source?.currentVersionId
          ? this.structureCache.readPosition(
            sparseRef.conversationId,
            source.currentVersionId,
            sparseRef.position,
          )
          : null;
        if (sparse) {
          const page = await this.readSparseRows(sparseRef.conversationId, [sparse], sparse.position);
          if (page.status === "source" || page.status === "legacy") {
            const value = page.value.blocks[0];
            if (value) return { ...page, value };
          } else {
            return { status: page.status, reason: page.reason };
          }
        }
      }
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
      const source = this.store.resolveConversation(conversationId);
      const sparsePage = source?.currentVersionId
        ? this.structureCache.readPage(conversationId, source.currentVersionId, {
          offset,
          limit,
          types: options.types,
        })
        : null;
      if (sparsePage && (sparsePage.rows.length > 0 || sparsePage.total === 0)) {
        const sparseResult = await this.readSparseRows(
          conversationId,
          sparsePage.rows,
          offset,
          options.types,
        );
        if (sparseResult.status === "source" || sparseResult.status === "legacy") {
          return {
            ...sparseResult,
            value: {
              ...sparseResult.value,
              total: sparsePage.total,
              offset,
              limit,
            },
          };
        }
        return sparseResult;
      }
      return this.legacyPage(conversationId, offset, limit, options.types, "not_found");
    }
    const result = await this.readStructuralRows(conversationId, rows, offset, options.types);
    if (result.status === "source" || result.status === "legacy") {
      return { ...result, value: { ...result.value, total, offset, limit } };
    }
    return result;
  }

  async readAll(conversationId: string): Promise<SourceReadResult<SourceBackedConversationBlock[]>> {
    // Do not turn an export into a whole-source read. A single conversation can
    // live in a multi-gigabyte provider JSONL, while each indexed record remains
    // independently bounded. Paging also keeps the aggregate read cap meaningful.
    const blocks: SourceBackedConversationBlock[] = [];
    let offset = 0;
    let firstStatus: "source" | "legacy" | null = null;
    let sourceVersionId: string | undefined;
    for (;;) {
      const page = await this.readPage(conversationId, { offset, limit: 100 });
      if (page.status !== "source" && page.status !== "legacy") return page;
      if (firstStatus === null) {
        firstStatus = page.status;
        sourceVersionId = page.status === "source" ? page.sourceVersionId : undefined;
      } else if (
        page.status !== firstStatus
        || (page.status === "source" && page.sourceVersionId !== sourceVersionId)
      ) {
        return { status: "stale", reason: "conversation source changed during paged read" };
      }
      blocks.push(...page.value.blocks);
      offset += page.value.blocks.length;
      if (offset >= page.value.total || page.value.blocks.length === 0) {
        if (firstStatus === "source") {
          return { status: "source", value: blocks, sourceVersionId: sourceVersionId! };
        }
        if (page.status !== "legacy") {
          return { status: "stale", reason: "conversation source changed during paged read" };
        }
        return { status: "legacy", value: blocks, reason: page.reason };
      }
    }
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
    sparseParentRows?: readonly StructuralRow[],
    verifyRecordHashes = true,
  ): Promise<SourceReadResult<SourceBlockPage>> {
    if (!rows[0].source_version_id || rows[0].record_offset == null || rows[0].record_hash == null) {
      return this.legacyPage(conversationId, fallbackOffset, rows.length, fallbackTypes, "unsupported", "source locator has not been indexed");
    }
    const parentIds = [...new Set(rows.map((row) => row.parent_block_id).filter((id): id is string => id !== null))];
    const parentRows = sparseParentRows ?? (parentIds.length === 0 ? [] : this.db.prepare(`
      SELECT * FROM conversation_structural_blocks
       WHERE conversation_id = ? AND status = 'current'
         AND id IN (${parentIds.map(() => "?").join(",")})
    `).all(conversationId, ...parentIds) as StructuralRow[]);
    const contextRows = [...new Map([...rows, ...parentRows].map((row) => [row.id, row])).values()];
    const snapshot = await this.openVerifiedRecords(
      conversationId,
      rows[0].source_version_id,
      contextRows,
    );
    if (!snapshot.ok) {
      return this.legacyPage(conversationId, fallbackOffset, rows.length, fallbackTypes, snapshot.kind, snapshot.reason);
    }
    for (const row of contextRows) {
      if (row.source_version_id !== snapshot.version.id) {
        return this.legacyPage(conversationId, fallbackOffset, rows.length, fallbackTypes, "stale", "page spans source versions");
      }
      const record = snapshot.records.get(recordKey(row));
      if (!record) {
        return this.legacyPage(conversationId, fallbackOffset, rows.length, fallbackTypes, "stale", "record range was not read");
      }
      const recordHash = verifyRecordHashes
        ? createHash("sha256").update(record).digest("hex")
        : null;
      if (verifyRecordHashes && recordHash !== row.record_hash) {
        return this.legacyPage(conversationId, fallbackOffset, rows.length, fallbackTypes, "stale", "record hash mismatch");
      }
    }

    if (snapshot.version.parser_format === MANAGED_NORMALIZED_SOURCE_EPOCHS.parserFormat) {
      if (snapshot.version.parser_version !== MANAGED_NORMALIZED_SOURCE_EPOCHS.parserVersion
          || snapshot.version.normalization_version !== MANAGED_NORMALIZED_SOURCE_EPOCHS.normalizationVersion
          || snapshot.version.redaction_epoch !== MANAGED_NORMALIZED_SOURCE_EPOCHS.redactionEpoch) {
        return this.legacyPage(conversationId, fallbackOffset, rows.length, fallbackTypes, "unsupported", "managed normalized parser epoch is unavailable");
      }
      const blocks: SourceBackedConversationBlock[] = [];
      try {
        for (const row of rows) {
          const record = parseManagedNormalizedRecord(snapshot.records.get(recordKey(row))!);
          if (record.id !== row.id || record.conversation_id !== row.conversation_id
              || record.position !== row.position || record.type !== row.type
              || record.role !== row.role || record.timestamp !== row.timestamp
              || record.dag_uuid !== row.dag_uuid || record.dag_parent_uuid !== row.dag_parent_uuid) {
            return this.legacyPage(conversationId, fallbackOffset, rows.length, fallbackTypes, "stale", "managed normalized record no longer matches structural identity");
          }
          blocks.push(this.managedSourceBlock(row, record));
        }
      } catch (error) {
        return this.legacyPage(
          conversationId, fallbackOffset, rows.length, fallbackTypes, "stale",
          error instanceof Error ? error.message : "managed normalized record could not be decoded",
        );
      }
      return {
        status: "source",
        value: { blocks, total: blocks.length, offset: rows[0].position, limit: rows.length },
        sourceVersionId: snapshot.version.id,
      };
    }

    const parser = getAllParsers().find((candidate) => candidate.source === snapshot.provider);
    if (!parser?.parseIncremental) {
      return this.legacyPage(conversationId, fallbackOffset, rows.length, fallbackTypes, "unsupported", "provider has no snapshot parser");
    }
    if (
      snapshot.version.parser_format !== "provider-jsonl"
      || snapshot.version.parser_version !== CURRENT_CONVERSATION_SOURCE_EPOCHS.parserVersion
      || snapshot.version.normalization_version !== CURRENT_CONVERSATION_SOURCE_EPOCHS.normalizationVersion
    ) {
      return this.legacyPage(conversationId, fallbackOffset, rows.length, fallbackTypes, "unsupported", "This conversation was indexed by an older Mandible version.");
    }
    const rowsByRecord = new Map<string, StructuralRow[]>();
    for (const row of contextRows) {
      const key = recordKey(row);
      const grouped = rowsByRecord.get(key) ?? [];
      grouped.push(row);
      rowsByRecord.set(key, grouped);
    }
    const parsedByPosition = new Map<number, Omit<ConversationBlock, "id" | "conversation_id">>();
    for (const [key, recordRows] of rowsByRecord) {
      const record = snapshot.records.get(key);
      if (!record) continue;
      const baseBlockCount = recordRows[0].position - recordRows[0].sub_block_ordinal;
      const parsed = await parser.parseIncremental({
        filePath: snapshot.provider === "gemini" && snapshot.aliasPath.endsWith(".json")
          ? "source-record.json"
          : "source-record.jsonl",
        raw: `${record.toString("utf8")}\n`,
        nativeSessionId: snapshot.nativeSessionId,
        baseBlockCount,
        baseRecordCount: recordRows[0].record_ordinal,
        sourceHash: snapshot.version.content_sha256,
        sourceMtime: 0,
      });
      if (!parsed) {
        return this.legacyPage(conversationId, fallbackOffset, rows.length, fallbackTypes, "stale", "verified source record produced no blocks");
      }
      for (const block of parsed.blocks) parsedByPosition.set(block.position, block);
    }
    // Incremental provider parses are deliberately one bounded record at a
    // time. Codex's model arrives in an earlier turn_context record, so recover
    // it only when the structural row carries the exact parser-state checkpoint
    // proving the full parser attached model metadata.
    const conversation = this.db.prepare(`
      SELECT source, model FROM conversations WHERE id = ?
    `).get(conversationId) as ConversationReadContext | undefined;
    const checkpointIds = [...new Set(contextRows
      .map((row) => row.normalization_checkpoint_id)
      .filter((id): id is string => id !== null))];
    const checkpoints = checkpointIds.length === 0 ? [] : this.db.prepare(`
      SELECT * FROM conversation_normalization_checkpoints
       WHERE id IN (${checkpointIds.map(() => "?").join(",")})
    `).all(...checkpointIds) as CheckpointRow[];
    const checkpointById = new Map(checkpoints.map((checkpoint) => [checkpoint.id, checkpoint]));
    const blocks: SourceBackedConversationBlock[] = [];
    const rowById = new Map(contextRows.map((row) => [row.id, row]));
    for (const row of rows) {
      const block = parsedByPosition.get(row.position);
      if (!block || block.type !== row.type || block.role !== row.role) {
        return this.legacyPage(conversationId, fallbackOffset, rows.length, fallbackTypes, "stale", "parser output no longer matches structural identity");
      }
      const parent = row.parent_block_id ? rowById.get(row.parent_block_id) : undefined;
      const parentBlock = parent ? parsedByPosition.get(parent.position) : undefined;
      const linkedToolName = block.type === "tool_result"
        && typeof block.metadata.tool_name !== "string"
        && typeof parentBlock?.metadata.tool_name === "string"
        ? parentBlock.metadata.tool_name
        : null;
      const withBoundedLinkage = linkedToolName
        ? {
            ...block,
            metadata: {
              ...block.metadata,
              tool_name: linkedToolName,
              ...(block.metadata.chat_item?.type === "tool-call"
                ? { chat_item: withToolName(block.metadata.chat_item, linkedToolName) }
                : {}),
            },
          }
        : block;
      const checkpoint = row.normalization_checkpoint_id
        ? checkpointById.get(row.normalization_checkpoint_id)
        : undefined;
      let hasCodexModelCheckpoint = false;
      if (checkpoint) {
        try {
          const state = JSON.parse(checkpoint.state_json) as { kind?: unknown; version?: unknown };
          if (state.kind === "codex-model-metadata" && state.version === 1) {
            if (checkpoint.source_version_id !== snapshot.version.id
                || checkpoint.parser_format !== row.parser_format
                || checkpoint.parser_version !== row.parser_version
                || checkpoint.normalization_version !== row.normalization_version
                || checkpoint.redaction_epoch !== row.redaction_epoch) {
              return this.legacyPage(conversationId, fallbackOffset, rows.length, fallbackTypes, "stale", "model metadata checkpoint epoch diverges");
            }
            hasCodexModelCheckpoint = true;
          }
        } catch {
          // Historical parser state is intentionally disposable. A missing or
          // malformed non-model checkpoint cannot invalidate native JSONL.
        }
      }
      const withCodexModel = hasCodexModelCheckpoint && conversation?.source === "codex"
        && typeof conversation.model === "string" && conversation.model.length > 0
        && (withBoundedLinkage.type === "assistant_message" || withBoundedLinkage.type === "thinking")
        && withBoundedLinkage.metadata.model === undefined
        ? {
          ...withBoundedLinkage,
          metadata: { ...withBoundedLinkage.metadata, model: conversation.model },
        }
        : withBoundedLinkage;
      blocks.push(this.sourceBlock(row, withCodexModel));
    }
    return {
      status: "source",
      value: { blocks, total: blocks.length, offset: rows[0].position, limit: rows.length },
      sourceVersionId: snapshot.version.id,
    };
  }

  private structuralRowFromSparse(row: SparseConversationBlockRow): StructuralRow {
    return {
      id: sparseConversationBlockId(row.conversationId, row.position),
      conversation_id: row.conversationId,
      source_version_id: row.sourceVersionId,
      position: row.position,
      type: row.type,
      role: row.role,
      timestamp: null,
      parent_block_id: row.parentPosition === null
        ? null
        : sparseConversationBlockId(row.conversationId, row.parentPosition),
      dag_uuid: null,
      dag_parent_uuid: null,
      record_offset: row.recordOffset,
      record_length: row.recordLength,
      record_hash: "",
      record_ordinal: row.recordOrdinal,
      sub_block_ordinal: row.subBlockOrdinal,
      normalization_checkpoint_id: null,
      parser_format: row.parserFormat,
      parser_version: row.parserVersion,
      normalization_version: row.normalizationVersion,
      redaction_epoch: row.redactionEpoch,
    };
  }

  private async readSparseRows(
    conversationId: string,
    rows: readonly SparseConversationBlockRow[],
    fallbackOffset: number,
    fallbackTypes?: readonly string[],
  ): Promise<SourceReadResult<SourceBlockPage>> {
    if (rows.length === 0) {
      return { status: "source", value: { blocks: [], total: 0, offset: fallbackOffset, limit: 0 }, sourceVersionId: "" };
    }
    const sourceVersionId = rows[0].sourceVersionId;
    const parentPositions = [...new Set(rows
      .map((row) => row.parentPosition)
      .filter((position): position is number => position !== null))];
    const sparseParents = parentPositions.flatMap((position) => {
      const parent = this.structureCache.readPosition(conversationId, sourceVersionId, position);
      return parent ? [this.structuralRowFromSparse(parent)] : [];
    });
    return this.readStructuralRows(
      conversationId,
      rows.map((row) => this.structuralRowFromSparse(row)),
      fallbackOffset,
      fallbackTypes,
      sparseParents,
      false,
    );
  }

  private sourceBlock(
    row: StructuralRow,
    block: Omit<ConversationBlock, "id" | "conversation_id">,
  ): SourceBackedConversationBlock {
    // The source snapshot is verified, but its token-shaped text may refer to a
    // revoked credential or to material that was never registered locally.
    // Match the disposable search boundary before any source-backed API or
    // export response can serialize those bytes. Legacy fallback rows retain
    // their existing behavior until the explicit cutover gate.
    const content = this.maskCredentials
      ? maskUnverifiedCandidates(maskActiveCredentialsInText(this.db, block.content).text).text
      : block.content;
    const metadataJson = this.maskCredentials
      ? maskUnverifiedCandidates(
        maskActiveCredentialsInText(this.db, JSON.stringify(block.metadata)).text,
      ).text
      : JSON.stringify(block.metadata);
    return {
      id: row.id,
      conversation_id: row.conversation_id,
      type: block.type,
      role: block.role,
      content,
      position: row.position,
      timestamp: block.timestamp ?? row.timestamp,
      parent_id: row.parent_block_id,
      metadata_json: metadataJson,
      dag_uuid: block.dag_uuid ?? row.dag_uuid,
      dag_parent_uuid: block.dag_parent_uuid ?? row.dag_parent_uuid,
      // Sparse cache rows deliberately omit per-record hashes. The complete
      // source version and observed file extent remain authoritative; do not
      // manufacture a durable-looking locator from disposable coordinates.
      locator: row.record_hash ? locator(row) : null,
    };
  }

  private managedSourceBlock(
    row: StructuralRow,
    record: ReturnType<typeof parseManagedNormalizedRecord>,
  ): SourceBackedConversationBlock {
    const content = this.maskCredentials
      ? maskUnverifiedCandidates(maskActiveCredentialsInText(this.db, record.content).text).text
      : record.content;
    const metadataJson = this.maskCredentials
      ? maskUnverifiedCandidates(maskActiveCredentialsInText(this.db, record.metadata_json).text).text
      : record.metadata_json;
    return {
      id: record.id,
      conversation_id: record.conversation_id,
      type: record.type,
      role: record.role,
      content,
      position: record.position,
      timestamp: record.timestamp,
      parent_id: row.parent_block_id,
      metadata_json: metadataJson,
      dag_uuid: record.dag_uuid,
      dag_parent_uuid: record.dag_parent_uuid,
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
    const conditions = ["conversation_id = ?", "payload_state = 'legacy'"];
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
    if (rows.length === 0 && total === 0 && reason !== "not_found") {
      return { status: reason, reason: detail };
    }
    return {
      status: "legacy",
      value: { blocks: rows.map(legacyBlock), total, offset, limit },
      reason,
    };
  }

  private async openVerifiedRecords(
    conversationId: string,
    versionId: string,
    rows: readonly StructuralRow[],
  ): Promise<SnapshotResult> {
    const source = this.store.resolveConversation(conversationId);
    if (!source) {
      return { ok: false, kind: "stale", reason: "conversation source is unavailable" };
    }
    if (source.availability !== "available") {
      return { ok: false, kind: "unavailable", reason: source.unavailableReason ?? source.availability };
    }
    const version = this.db.prepare(`
      SELECT id, source_id, content_sha256, byte_length, parser_format, parser_version,
             normalization_version, redaction_epoch, filesystem_device,
             filesystem_inode, filesystem_ctime_ns
        FROM conversation_source_versions WHERE id = ? AND availability = 'available'
    `).get(versionId) as VersionRow | undefined;
    if (!version) return { ok: false, kind: "unavailable", reason: "source version is unavailable" };
    if (version.source_id !== source.sourceId) {
      return { ok: false, kind: "stale", reason: "source version belongs to a different source" };
    }
    if (!version.filesystem_device || !version.filesystem_inode || !version.filesystem_ctime_ns) {
      return { ok: false, kind: "stale", reason: "source version predates exact filesystem identity" };
    }

    const uniqueRanges = [...new Map(rows.map((row) => [recordKey(row), {
      offset: row.record_offset,
      length: row.record_length,
    }])).values()];

    for (const alias of this.store.listAliases(source.sourceId)) {
      if (alias.availability !== "available") continue;
      try {
        let observedExtent: Awaited<ReturnType<typeof observeStableSourceAliasExtent>> | undefined;
        try {
          observedExtent = await observeStableSourceAliasExtent(alias);
        } catch (error) {
          if (!(error instanceof SourceObservationError) || error.kind !== "changed") throw error;
        }
        const exactIdentity = observedExtent !== undefined
          && sameSourceFilesystemIdentity(observedExtent.filesystemIdentity, {
            device: version.filesystem_device,
            inode: version.filesystem_inode,
            ctimeNs: version.filesystem_ctime_ns,
          });
        let records: Map<string, Buffer> | null = null;
        if (observedExtent !== undefined && (exactIdentity || observedExtent.contentSha256 === version.content_sha256)
            && observedExtent.byteLength === version.byte_length) {
          try {
            const observed = await observeStableSourceAliasRanges(alias, uniqueRanges, {
              maxRangeBytes: MAX_SOURCE_RECORD_BYTES,
              maxTotalBytes: this.maxSourceBytes,
            });
            if (sameSourceFilesystemIdentity(observed.filesystemIdentity, observedExtent.filesystemIdentity)
                && observed.byteLength === version.byte_length) {
              records = new Map(uniqueRanges.map((range, index) => [
                `${range.offset}:${range.length}`,
                observed.ranges[index],
              ]));
            }
          } catch (error) {
            if (!(error instanceof SourceObservationError) || error.kind !== "changed") throw error;
            // The source may have appended between the exact-extent probe and
            // range read. Retry by proving the sealed prefix and capturing the
            // same requested ranges in one pass.
          }
        }

        const sameFile = observedExtent !== undefined
          && observedExtent.filesystemIdentity.device === version.filesystem_device
          && observedExtent.filesystemIdentity.inode === version.filesystem_inode;
        const canVerifyPrefix = observedExtent === undefined
          || (sameFile && observedExtent.byteLength >= version.byte_length);
        if (!records && canVerifyPrefix) {
          const observed = await observeStableSourceAliasRanges(alias, uniqueRanges, {
            maxRangeBytes: MAX_SOURCE_RECORD_BYTES,
            maxTotalBytes: this.maxSourceBytes,
            prefix: {
              byteLength: version.byte_length,
              contentSha256: version.content_sha256,
              filesystemIdentity: {
                device: version.filesystem_device,
                inode: version.filesystem_inode,
              },
            },
          });
          records = new Map(uniqueRanges.map((range, index) => [
            `${range.offset}:${range.length}`,
            observed.ranges[index],
          ]));
        }

        if (!records) {
          const full = await observeStableSourceAlias(alias, { captureBytes: false });
          if (full.byteLength !== version.byte_length || full.contentSha256 !== version.content_sha256) continue;
          const observed = await observeStableSourceAliasRanges(alias, uniqueRanges, {
            maxRangeBytes: MAX_SOURCE_RECORD_BYTES,
            maxTotalBytes: this.maxSourceBytes,
          });
          if (observed.byteLength !== version.byte_length) continue;
          const exactIdentityAfterHash = sameSourceFilesystemIdentity(full.filesystemIdentity, observed.filesystemIdentity);
          if (!exactIdentityAfterHash) continue;
          records = new Map(uniqueRanges.map((range, index) => [
            `${range.offset}:${range.length}`,
            observed.ranges[index],
          ]));
        }

        if (records) {
          return {
            ok: true,
            records,
            version,
            provider: source.provider,
            nativeSessionId: source.nativeSessionId,
            aliasPath: alias.path,
          };
        }
      } catch (error) {
        if (error instanceof SourceObservationError && error.kind === "unsupported") {
          return { ok: false, kind: "unsupported", reason: error.message };
        }
        if (error instanceof SourceObservationError && error.kind === "changed") {
          return { ok: false, kind: "stale", reason: error.message };
        }
        // Try another durable alias (for example Codex active/archive relocation).
      }
    }
    return { ok: false, kind: "stale", reason: "This transcript changed after Mandible indexed it." };
  }
}

function withToolName(
  item: Extract<NonNullable<ConversationBlock["metadata"]["chat_item"]>, { type: "tool-call" }>,
  toolName: string,
): Extract<NonNullable<ConversationBlock["metadata"]["chat_item"]>, { type: "tool-call" }> {
  const { tool_kind: toolKind, tool_id: toolId, input, output, ...head } = item;
  return {
    ...head,
    tool_name: toolName,
    ...(toolKind ? { tool_kind: toolKind } : {}),
    ...(toolId ? { tool_id: toolId } : {}),
    ...(input !== undefined ? { input } : {}),
    ...(output !== undefined ? { output } : {}),
  };
}
