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
import { readConversationSourceGeneration } from "./source-generation.js";
import {
  VerifiedSourceLease,
  type SourceReadInstrumentation,
  SourceObservationError,
} from "./source-observer.js";
import type {
  ConversationBlockLocator,
  SourceBackedConversationBlock,
  SourceBlockPage,
  SourceReadFailureKind,
  SourceReadResult,
  ConversationSourceVersion,
  ConversationSourceDescriptor,
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

interface ReadSession {
  conversationId: string;
  sourceState: string;
  credentialState: string;
  versionState?: string;
  pinnedVersion?: ConversationSourceVersion;
  blockCount?: number;
  context?: ConversationReadContext;
  navigationVersion?: string;
  navigationProof?: string;
  navigationKind?: "dense" | "sparse";
  canHydrateHistorical?: boolean;
  onVerification?: (milliseconds: number) => void;
  parsedRecord?: { key: string; hash: string; blocks: Array<Omit<ConversationBlock, "id" | "conversation_id">> };
  signal?: AbortSignal;
  snapshot?: { version: VersionRow; provider: ConversationSource; nativeSessionId: string; aliasPath: string; lease: VerifiedSourceLease };
}

export interface SourceScanOptions {
  signal?: AbortSignal;
  pageSize?: number;
  maxBatchBytes?: number;
  expectedSourceVersionId?: string;
  expectedBlockCount?: number;
  expectedModel?: string | null;
  onVerification?: (milliseconds: number) => void;
}

export interface SourceScanProgress {
  count: number;
  readBlocks: number;
  complete: boolean;
}

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
  instrumentation?: SourceReadInstrumentation;
  onVerification?: (milliseconds: number) => void;
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
  private readonly instrumentation?: SourceReadInstrumentation;
  private readonly onVerification?: (milliseconds: number) => void;

  constructor(private readonly db: Db, options: ConversationSourceReaderOptions = {}) {
    this.store = new ConversationSourceStore(db);
    this.structureCache = getConversationStructureCache(db);
    this.legacyFallback = options.legacyFallback !== false;
    this.maxSourceBytes = options.maxSourceBytes ?? DEFAULT_MAX_SOURCE_BYTES;
    this.maskCredentials = options.maskCredentials !== false;
    this.instrumentation = options.instrumentation;
    this.onVerification = options.onVerification;
  }

  async readBlock(blockRef: string, options: SourceScanOptions = {}): Promise<SourceReadResult<SourceBackedConversationBlock>> {
    const durableId = this.store.resolveLegacyBlockId(blockRef) ?? blockRef;
    const row = this.db.prepare("SELECT conversation_id FROM conversation_structural_blocks WHERE id = ? AND status = 'current'").get(durableId) as { conversation_id: string } | undefined;
    const legacy = this.db.prepare("SELECT conversation_id FROM conversation_blocks WHERE id = ?").get(blockRef) as { conversation_id: string } | undefined;
    const conversationId = row?.conversation_id ?? parseSparseConversationBlockId(blockRef)?.conversationId ?? legacy?.conversation_id;
    if (!conversationId) return { status: "not_found", reason: "conversation block was not found" };
    return this.withSession(conversationId, session => this.readBlockInSession(blockRef, session), options);
  }

  private async readBlockInSession(blockRef: string, session: ReadSession): Promise<SourceReadResult<SourceBackedConversationBlock>> {
    const requestedPosition = parseSparseConversationBlockId(blockRef);
    if (requestedPosition && session.blockCount !== undefined) {
      session.navigationKind = "sparse";
      const page = await this.readPageInSession(requestedPosition.conversationId, { offset: requestedPosition.position, limit: 1 }, session);
      if (page.status !== "source" && page.status !== "legacy") return page;
      return page.value.blocks[0] ? { ...page, value: page.value.blocks[0] }
        : { status: "not_found", reason: "block is outside the pinned source prefix" };
    }
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
          const page = await this.readSparseRows(sparseRef.conversationId, [sparse], sparse.position, undefined, session);
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
    const page = await this.readStructuralRows(row.conversation_id, [row], row.position, undefined, undefined, true, session);
    if (page.status === "source" || page.status === "legacy") {
      const value = page.value.blocks[0];
      if (value) return { ...page, value };
      return { status: "not_found", reason: "conversation block was not produced by the parser" };
    }
    return page;
  }

  async readPage(
    conversationId: string,
    options: { offset?: number; limit?: number; types?: readonly string[] } & SourceScanOptions = {},
  ): Promise<SourceReadResult<SourceBlockPage>> {
    return this.withSession(conversationId, session => this.readPageInSession(conversationId, options, session), options);
  }

  private async readPageInSession(
    conversationId: string,
    options: { offset?: number; limit?: number; types?: readonly string[]; maxBatchBytes?: number },
    session: ReadSession,
  ): Promise<SourceReadResult<SourceBlockPage>> {
    this.checkSession(session);
    const offset = Math.max(0, options.offset ?? 0);
    const limit = Math.max(1, Math.min(500, options.limit ?? 100));
    const pinned = session.pinnedVersion;
    const current = this.store.resolveConversation(conversationId);
    if (session.navigationKind === undefined) {
      const dense = this.db.prepare(`SELECT COUNT(*) AS count, COUNT(DISTINCT position) AS positions,
        MIN(position) AS first, MAX(position) AS last FROM conversation_structural_blocks
        WHERE conversation_id = ? AND status = 'current' AND position >= 0 AND position < ?`)
        .get(conversationId, session.blockCount ?? Number.MAX_SAFE_INTEGER) as { count: number; positions: number; first: number | null; last: number | null };
      session.navigationKind = dense.count > 0 && (session.blockCount === undefined
        || (dense.count === session.blockCount && dense.positions === dense.count && dense.first === 0 && dense.last === dense.count - 1))
        ? "dense" : "sparse";
    }
    if (pinned?.parserFormat === CURRENT_CONVERSATION_SOURCE_EPOCHS.parserFormat && current?.currentVersionId !== pinned.id
        && session.navigationKind === "dense") return { status: "unsupported", reason: "historical dense navigation is unavailable" };
    if (pinned?.parserFormat === CURRENT_CONVERSATION_SOURCE_EPOCHS.parserFormat && session.blockCount !== undefined && session.navigationKind === "sparse") {
      if (current?.currentVersionId !== pinned.id && !session.canHydrateHistorical) {
        return { status: "unsupported", reason: "historical navigation requires its admitted count and model context" };
      }
      const navigationVersion = this.structureCache.blockCount(conversationId, pinned.id) !== null
        ? pinned.id : current?.currentVersionId;
      if (navigationVersion && this.structureCache.blockCount(conversationId, navigationVersion) !== null) {
        const navigationCount = this.structureCache.blockCount(conversationId, navigationVersion)!;
        if (!this.structureCache.hasCompleteConversation(conversationId, navigationVersion, navigationCount, pinned)) {
          return { status: "unsupported", reason: "admitted source navigation epochs diverge" };
        }
        const page = this.structureCache.readPage(conversationId, navigationVersion, {
          offset, limit, types: options.types, prefix: { blockCount: session.blockCount, byteLength: pinned.byteLength,
            verified: session.navigationProof === navigationVersion },
        });
        if (!page || page.rows.some(row => row.parserFormat !== pinned.parserFormat || row.parserVersion !== pinned.parserVersion
            || row.normalizationVersion !== pinned.normalizationVersion || row.redactionEpoch !== pinned.redactionEpoch)) {
          return { status: "unsupported", reason: "admitted source prefix navigation is incomplete" };
        }
        session.navigationVersion = navigationVersion;
        session.navigationProof = navigationVersion;
        const result = await this.readSparseRows(conversationId,
          boundedRecordRows(page.rows, row => ({ offset: row.recordOffset, length: row.recordLength }), options.maxBatchBytes)
            .map(row => ({ ...row, sourceVersionId: pinned.id })), offset, options.types, session);
        return result.status === "source" || result.status === "legacy"
          ? { ...result, value: { ...result.value, total: page.total, offset, limit } } : result;
      }
      if (current?.currentVersionId !== pinned.id) return { status: "unsupported", reason: "historical dense navigation is unavailable" };
    }
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
    const rows = boundedRecordRows(this.db.prepare(`
      SELECT * FROM conversation_structural_blocks
       WHERE ${where}
       ORDER BY position LIMIT ? OFFSET ?
    `).all(...params, limit, offset) as StructuralRow[], row => ({ offset: row.record_offset, length: row.record_length }), options.maxBatchBytes);

    if (rows.length === 0) {
      const source = this.store.resolveConversation(conversationId);
      const sparsePage = source?.currentVersionId
        ? this.structureCache.readPage(conversationId, source.currentVersionId, {
          offset,
          limit,
          types: options.types,
        })
        : null;
      if (sparsePage) {
        if (sparsePage.rows.length === 0 && offset < sparsePage.total) {
          return { status: "unsupported", reason: "conversation structural navigation is incomplete" };
        }
        const sparseResult = await this.readSparseRows(
          conversationId,
          boundedRecordRows(sparsePage.rows, row => ({ offset: row.recordOffset, length: row.recordLength }), options.maxBatchBytes),
          offset,
          options.types,
          session,
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
      if (source?.currentVersionId && source.parserFormat === MANAGED_NORMALIZED_SOURCE_EPOCHS.parserFormat) {
        const snapshot = await this.openVerifiedRecords(conversationId, source.currentVersionId, [], session);
        if (!snapshot.ok) return { status: snapshot.kind, reason: snapshot.reason };
        return { status: "source", sourceVersionId: snapshot.version.id, value: { blocks: [], total, offset, limit } };
      }
      return this.legacyPage(conversationId, offset, limit, options.types, "not_found");
    }
    const result = await this.readStructuralRows(conversationId, rows, offset, options.types, undefined, true, session);
    if (result.status === "source" || result.status === "legacy") {
      return { ...result, value: { ...result.value, total, offset, limit } };
    }
    return result;
  }

  async readAll(conversationId: string): Promise<SourceReadResult<SourceBackedConversationBlock[]>> {
    const blocks: SourceBackedConversationBlock[] = [];
    const scanned = await this.scanBlocks(conversationId, block => { blocks.push(block); });
    if (scanned.status !== "source" && scanned.status !== "legacy") return scanned;
    return { ...scanned, value: blocks };
  }

  verifyVersion(conversationId: string, versionId: string, signal?: AbortSignal, onVerification?: (milliseconds: number) => void): Promise<SourceReadResult<void>> {
    return this.withSession(conversationId, async session => {
      const snapshot = await this.openVerifiedRecords(conversationId, versionId, [], session);
      return snapshot.ok ? { status: "source", value: undefined, sourceVersionId: snapshot.version.id }
        : { status: snapshot.kind, reason: snapshot.reason };
    }, { signal, expectedSourceVersionId: versionId, onVerification });
  }

  async streamBlocks(
    conversationId: string,
    visitor: (block: SourceBackedConversationBlock) => void | Promise<void>,
    pageSize = 100,
  ): Promise<SourceReadResult<number>> {
    const result = await this.scanBlocks(conversationId, visitor, { pageSize });
    return result.status === "source" || result.status === "legacy"
      ? { ...result, value: result.value.count } : result;
  }

  async scanBlocks(
    conversationId: string,
    visitor: (block: SourceBackedConversationBlock) => "stop" | void | Promise<"stop" | void>,
    options: SourceScanOptions = {},
  ): Promise<SourceReadResult<SourceScanProgress>> {
    return this.withSession<SourceScanProgress>(conversationId, async session => {
      const pageSize = Math.max(1, Math.min(100, options.pageSize ?? 32));
      let offset = 0;
      let readBlocks = 0;
      let firstStatus: "source" | "legacy" | null = null;
      const source = this.store.resolveConversation(conversationId);
      if (session.pinnedVersion && source?.currentVersionId !== session.pinnedVersion.id
          && (options.expectedBlockCount === undefined || options.expectedModel === undefined)) {
        return { status: "unsupported", reason: "historical scan requires its admitted block count and normalization model" };
      }
      const declaredCount = session.blockCount;
      for (;;) {
        this.checkSession(session);
        const page = await this.readPageInSession(conversationId, { offset, limit: pageSize, maxBatchBytes: options.maxBatchBytes ?? 512 * 1024 }, session);
        if (page.status !== "source" && page.status !== "legacy") return page;
        if (firstStatus === null && declaredCount !== undefined
            && (page.value.total !== declaredCount || (page.status === "legacy" && declaredCount === 0))) {
          return { status: "unsupported", reason: "conversation structural navigation is incomplete" };
        }
        if (firstStatus !== null && page.status !== firstStatus) {
          return { status: "stale", reason: "conversation source changed during scan" };
        }
        firstStatus = page.status;
        readBlocks += page.value.blocks.length;
        for (const block of page.value.blocks) {
          if (session.signal?.aborted) throw new SourceObservationError("conversation source read cancelled", "cancelled");
          offset += 1;
          if (await visitor(block) === "stop") return { ...page, value: { count: offset, readBlocks, complete: false } };
        }
        if (page.value.blocks.length === 0 && offset < page.value.total) {
          return { status: "unsupported", reason: "conversation structural navigation is incomplete" };
        }
        if (offset >= page.value.total) {
          return { ...page, value: { count: offset, readBlocks, complete: true } };
        }
        await new Promise<void>(resolve => setImmediate(resolve));
      }
    }, options);
  }

  private credentialState(): string {
    return JSON.stringify(this.db.prepare("SELECT id, status, fingerprint, revoked_at FROM user_credentials WHERE type = 'api_token' ORDER BY id").all());
  }

  private sourceState(source: ConversationSourceDescriptor | null): string {
    return JSON.stringify(source?.parserFormat === CURRENT_CONVERSATION_SOURCE_EPOCHS.parserFormat
      ? { ...source, currentVersionId: undefined } : source);
  }

  private checkSession(session: ReadSession, expectedGeneration?: string): void {
    if (session.signal?.aborted) throw new SourceObservationError("conversation source read cancelled", "cancelled");
    const { source, credentials, pinned, current, generation } = this.db.transaction(() => {
      const source = this.store.resolveConversation(session.conversationId);
      return { source, credentials: this.credentialState(),
        pinned: session.pinnedVersion ? this.store.resolveVersion(session.pinnedVersion.id) : null,
        current: source?.currentVersionId ? this.store.resolveVersion(source.currentVersionId) : null,
        generation: expectedGeneration === undefined ? undefined : readConversationSourceGeneration(this.db, session.conversationId) };
    })();
    if (this.sourceState(source) !== session.sourceState
        || credentials !== session.credentialState
        || (session.pinnedVersion && JSON.stringify(pinned) !== session.versionState)
        || generation !== expectedGeneration) {
      throw new SourceObservationError("conversation source or redaction facts changed during read", "changed");
    }
    if (session.pinnedVersion && source?.currentVersionId !== session.pinnedVersion.id) {
      const admitted = session.pinnedVersion;
      if (!current || current.sourceId !== admitted.sourceId || current.availability !== "available"
          || current.generation !== "sealed_sha256" || current.byteLength < admitted.byteLength
          || current.parserFormat !== admitted.parserFormat || current.parserVersion !== admitted.parserVersion
          || current.normalizationVersion !== admitted.normalizationVersion || current.redactionEpoch !== admitted.redactionEpoch) {
        throw new SourceObservationError("current source cannot prove the admitted version prefix", "changed");
      }
    }
  }

  private async withSession<T>(
    conversationId: string,
    run: (session: ReadSession) => Promise<SourceReadResult<T>>,
    options: SourceScanOptions = {},
  ): Promise<SourceReadResult<T>> {
    const { signal, expectedSourceVersionId, onVerification } = options;
    const { source, pinnedVersion, conversation, credentials } = this.db.transaction(() => {
      const source = this.store.resolveConversation(conversationId);
      const pinnedVersion = (expectedSourceVersionId && !expectedSourceVersionId.startsWith("legacy:"))
        ? this.store.resolveVersion(expectedSourceVersionId)
        : source?.currentVersionId ? this.store.resolveVersion(source.currentVersionId) : null;
      const conversation = this.db.prepare("SELECT source, model, block_count FROM conversations WHERE id = ?")
        .get(conversationId) as (ConversationReadContext & { block_count: number }) | undefined;
      return { source, pinnedVersion, conversation, credentials: this.credentialState() };
    })();
    if (expectedSourceVersionId && !expectedSourceVersionId.startsWith("legacy:")
        && (!pinnedVersion || pinnedVersion.sourceId !== source?.sourceId)) {
      return { status: "stale", reason: "conversation source differs from pinned version" };
    }
    if (pinnedVersion && source?.currentVersionId !== pinnedVersion.id
        && pinnedVersion.parserFormat !== CURRENT_CONVERSATION_SOURCE_EPOCHS.parserFormat) {
      return { status: "unsupported", reason: "historical managed navigation is unavailable" };
    }
    const session: ReadSession = {
      conversationId,
      sourceState: this.sourceState(source),
      credentialState: credentials,
      pinnedVersion: pinnedVersion ?? undefined,
      versionState: pinnedVersion ? JSON.stringify(pinnedVersion) : undefined,
      blockCount: options.expectedBlockCount ?? (pinnedVersion ? conversation?.block_count : undefined),
      context: conversation ? { source: conversation.source, model: options.expectedModel !== undefined ? options.expectedModel : conversation.model } : undefined,
      canHydrateHistorical: source?.currentVersionId === pinnedVersion?.id
        || (options.expectedBlockCount !== undefined && options.expectedModel !== undefined),
      signal,
      onVerification,
    };
    let result: SourceReadResult<T>;
    let finalGeneration: string | undefined;
    try {
      this.checkSession(session);
      result = await run(session);
      if (result.status === "source") {
        finalGeneration = readConversationSourceGeneration(this.db, conversationId);
        await session.snapshot?.lease.verify();
      }
    } catch (error) {
      if (!(error instanceof SourceObservationError)) throw error;
      result = { status: error.kind === "changed" ? "stale" : error.kind, reason: error.message };
    } finally {
      await session.snapshot?.lease.close();
    }
    if (result.status === "source" || result.status === "legacy") {
      try { this.checkSession(session, finalGeneration); }
      catch (error) {
        if (!(error instanceof SourceObservationError)) throw error;
        return { status: error.kind === "changed" ? "stale" : error.kind, reason: error.message };
      }
    }
    return result;
  }

  private async readStructuralRows(
    conversationId: string,
    rows: StructuralRow[],
    fallbackOffset: number,
    fallbackTypes: readonly string[] | undefined,
    sparseParentRows: readonly StructuralRow[] | undefined,
    verifyRecordHashes: boolean,
    session: ReadSession,
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
      session,
    );
    if (!snapshot.ok) {
      return this.legacyPage(conversationId, fallbackOffset, rows.length, fallbackTypes, snapshot.kind, snapshot.reason);
    }
    for (const row of contextRows) {
      if (row.source_version_id !== snapshot.version.id) {
        return this.legacyPage(conversationId, fallbackOffset, rows.length, fallbackTypes, "stale", "page spans source versions");
      }
      const record = snapshot.records.get(recordKey(row));
      const cached = session.parsedRecord?.key === recordKey(row) ? session.parsedRecord : undefined;
      if (!record && !cached) {
        return this.legacyPage(conversationId, fallbackOffset, rows.length, fallbackTypes, "stale", "record range was not read");
      }
      const recordHash = verifyRecordHashes
        ? cached?.hash ?? createHash("sha256").update(record!).digest("hex")
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
    let turnStarted = performance.now();
    for (const [key, recordRows] of rowsByRecord) {
      if (performance.now() - turnStarted >= 8) {
        await new Promise<void>(resolve => setImmediate(resolve));
        turnStarted = performance.now();
      }
      if (session.signal?.aborted) throw new SourceObservationError("conversation source read cancelled", "cancelled");
      if (session.parsedRecord?.key === key) {
        for (const block of session.parsedRecord.blocks) parsedByPosition.set(block.position, block);
        continue;
      }
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
      session.parsedRecord = { key, hash: createHash("sha256").update(record).digest("hex"), blocks: parsed.blocks };
      for (const block of parsed.blocks) parsedByPosition.set(block.position, block);
    }
    // Incremental provider parses are deliberately one bounded record at a
    // time. Codex's model arrives in an earlier turn_context record, so recover
    // it only when the structural row carries the exact parser-state checkpoint
    // proving the full parser attached model metadata.
    const conversation = session.context;
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
    fallbackTypes: readonly string[] | undefined,
    session: ReadSession,
  ): Promise<SourceReadResult<SourceBlockPage>> {
    if (rows.length === 0) {
      const source = this.store.resolveConversation(conversationId);
      if (!source?.currentVersionId) return { status: "unavailable", reason: "conversation source is unavailable" };
      const snapshot = await this.openVerifiedRecords(conversationId, session.pinnedVersion?.id ?? source.currentVersionId, [], session);
      if (!snapshot.ok) return { status: snapshot.kind, reason: snapshot.reason };
      return { status: "source", value: { blocks: [], total: 0, offset: fallbackOffset, limit: 0 }, sourceVersionId: snapshot.version.id };
    }
    const sourceVersionId = rows[0].sourceVersionId;
    const parentPositions = [...new Set(rows
      .map((row) => row.parentPosition)
      .filter((position): position is number => position !== null))];
    const sparseParents = parentPositions.flatMap((position) => {
      const parent = this.structureCache.readPosition(conversationId, session.navigationVersion ?? sourceVersionId, position);
      if (!parent || (session.pinnedVersion && (parent.recordOffset + parent.recordLength > session.pinnedVersion.byteLength
          || parent.position >= (session.blockCount ?? Infinity)))) {
        throw new SourceObservationError("parent context is outside admitted navigation", "changed");
      }
      return [this.structuralRowFromSparse({ ...parent, sourceVersionId })];
    });
    return this.readStructuralRows(
      conversationId,
      rows.map((row) => this.structuralRowFromSparse(row)),
      fallbackOffset,
      fallbackTypes,
      sparseParents,
      false,
      session,
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
    if (!this.legacyFallback || reason === "cancelled") return { status: reason, reason: detail };
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
    session: ReadSession,
  ): Promise<SnapshotResult> {
    this.checkSession(session);
    if (session.pinnedVersion && session.pinnedVersion.id !== versionId) {
      return { ok: false, kind: "unsupported", reason: "navigation belongs to a different source version" };
    }
    if (!session.snapshot) {
      const source = this.store.resolveConversation(conversationId);
      if (!source) return { ok: false, kind: "stale", reason: "conversation source is unavailable" };
      if (source.availability !== "available") return { ok: false, kind: "unavailable", reason: source.unavailableReason ?? source.availability };
      const version = this.db.prepare(`
        SELECT id, source_id, content_sha256, byte_length, parser_format, parser_version,
               normalization_version, redaction_epoch, filesystem_device, filesystem_inode, filesystem_ctime_ns
          FROM conversation_source_versions WHERE id = ? AND availability = 'available'
      `).get(versionId) as VersionRow | undefined;
      if (!version) return { ok: false, kind: "unavailable", reason: "source version is unavailable" };
      const epochs = version.parser_format === MANAGED_NORMALIZED_SOURCE_EPOCHS.parserFormat
        ? MANAGED_NORMALIZED_SOURCE_EPOCHS : CURRENT_CONVERSATION_SOURCE_EPOCHS;
      if (version.parser_format !== epochs.parserFormat || version.parser_version !== epochs.parserVersion
          || version.normalization_version !== epochs.normalizationVersion || version.redaction_epoch !== epochs.redactionEpoch) {
        return { ok: false, kind: "unsupported", reason: "source parser epoch is unavailable" };
      }
      if (version.source_id !== source.sourceId) return { ok: false, kind: "stale", reason: "source version belongs to a different source" };
      if (!version.filesystem_device || !version.filesystem_inode || !version.filesystem_ctime_ns) {
        return { ok: false, kind: "stale", reason: "source version predates exact filesystem identity" };
      }

      for (const alias of this.store.listAliases(source.sourceId)) {
        if (alias.availability !== "available") continue;
        try {
          const lease = await VerifiedSourceLease.open(alias, {
            byteLength: version.byte_length,
            contentSha256: version.content_sha256,
            filesystemIdentity: { device: version.filesystem_device, inode: version.filesystem_inode, ctimeNs: version.filesystem_ctime_ns },
          }, { signal: session.signal, instrumentation: this.instrumentation, onVerification: session.onVerification ?? this.onVerification });
          session.snapshot = { version, provider: source.provider, nativeSessionId: source.nativeSessionId, aliasPath: alias.path, lease };
          break;
        } catch (error) {
          if (error instanceof SourceObservationError) {
            if (error.kind === "cancelled") throw error;
            if (error.kind === "unsupported" || error.kind === "changed") {
              return { ok: false, kind: error.kind === "changed" ? "stale" : error.kind, reason: error.message };
            }
          }
        }
      }
      if (!session.snapshot) return { ok: false, kind: "stale", reason: "This transcript changed after Mandible indexed it." };
    }
    if (session.snapshot.version.id !== versionId) return { ok: false, kind: "stale", reason: "page spans source versions" };
    const uniqueRanges = [...new Map(rows.filter(row => recordKey(row) !== session.parsedRecord?.key)
      .map(row => [recordKey(row), { offset: row.record_offset, length: row.record_length }])).values()];
    try {
      const records = await session.snapshot.lease.readRanges(uniqueRanges, {
        maxRangeBytes: MAX_SOURCE_RECORD_BYTES,
        maxTotalBytes: this.maxSourceBytes,
      });
      return { ok: true, ...session.snapshot, records };
    } catch (error) {
      if (!(error instanceof SourceObservationError)) throw error;
      return { ok: false, kind: error.kind === "changed" ? "stale" : error.kind, reason: error.message };
    }
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

function boundedRecordRows<T>(rows: T[], range: (row: T) => { offset: number; length: number }, budget = Infinity): T[] {
  let bytes = 0;
  const records = new Set<string>();
  let count = 0;
  for (const row of rows) {
    const current = range(row);
    const key = `${current.offset}:${current.length}`;
    if (!records.has(key)) {
      if (count > 0 && bytes + current.length > budget) break;
      bytes += current.length;
      records.add(key);
    }
    count += 1;
  }
  return rows.slice(0, count);
}
