import { openLogicalSource, canonicalSourcePath, type LogicalSourceHandle } from "./logical-source.js";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import path from "node:path";
import { decompressContent } from "../compression.js";
import type { Db } from "../db.js";
import type { ConversationSource } from "../parsers/types.js";
import type {
  ConversationSourceAlias,
  ConversationSourceDescriptor,
  ConversationSourceVersion,
  RecordConversationSourceInput,
  RecordConversationSourceAliasInput,
  RecordManagedNormalizedSourceInput,
  RecordNormalizationCheckpointInput,
  UpdateConversationSourceCustodyInput,
} from "./source-types.js";
import {
  ConversationSourceChangedError,
  numericSourceExtent,
  sameSourceFilesystemIdentity,
  sourceFilesystemIdentity,
  type SourceFilesystemIdentity,
} from "./source-observer.js";
export { ConversationSourceChangedError } from "./source-observer.js";
import { parseJsonObjectStrict } from "../row-coerce.js";

interface RecordRange {
  ordinal: number;
  offset: number;
  length: number;
  hash: string;
}

interface SourceSnapshot {
  contentHash: string;
  size: number;
  mtimeMs: number;
  records: RecordRange[];
  filesystemIdentity: SourceFilesystemIdentity;
  mode: number;
}

interface LegacyBlockRow {
  id: string;
  conversation_id: string;
  type: string;
  role: string;
  position: number;
  timestamp: string | null;
  parent_id: string | null;
  metadata_json: string;
  dag_uuid: string | null;
  dag_parent_uuid: string | null;
}

interface CompatibilityBlockRow extends LegacyBlockRow {
  content: Buffer | string;
  compressed: number;
  payload_state: "legacy" | "source";
}

class ConversationPayloadChangedError extends Error {}

export function isConversationSourceChangedError(error: unknown): boolean {
  if (error instanceof ConversationSourceChangedError) return true;
  if (error instanceof AggregateError) {
    const errors = Array.from(error.errors);
    return errors.length > 0 && errors.every(isConversationSourceChangedError);
  }
  return false;
}

function rawValueEquals(left: unknown, right: unknown): boolean {
  if (Buffer.isBuffer(left) || Buffer.isBuffer(right)) {
    return Buffer.isBuffer(left) && Buffer.isBuffer(right) && left.equals(right);
  }
  return left === right;
}

function sameCompatibilityRows(
  left: readonly CompatibilityBlockRow[],
  right: readonly CompatibilityBlockRow[],
): boolean {
  if (left.length !== right.length) return false;
  const fields: ReadonlyArray<keyof CompatibilityBlockRow> = [
    "id", "conversation_id", "type", "role", "content", "compressed",
    "position", "timestamp", "parent_id", "metadata_json", "dag_uuid",
    "dag_parent_uuid", "payload_state",
  ];
  return left.every((row, index) => fields.every(
    (field) => rawValueEquals(row[field], right[index][field]),
  ));
}

interface AliasRoot {
  rootPath: string;
  relativePath: string;
  aliasKind: "active" | "archive" | "provider";
}

function stableId(prefix: string, ...parts: string[]): string {
  const hash = createHash("sha256").update(parts.join("\0")).digest("hex");
  return `${prefix}_${hash.slice(0, 26)}`;
}

function isSha256(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}

function insideDeclaredRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function sourceRoot(provider: ConversationSource, filePath: string): AliasRoot {
  const normalized = path.resolve(canonicalSourcePath(filePath));
  const separators = normalized.split(path.sep);
  if (provider === "codex") {
    const codex = separators.lastIndexOf(".codex");
    const rootName = codex >= 0 ? separators[codex + 1] : "";
    if (codex >= 0 && (rootName === "sessions" || rootName === "archived_sessions")) {
      const rootPath = separators.slice(0, codex + 2).join(path.sep) || path.sep;
      return {
        rootPath,
        relativePath: path.relative(rootPath, normalized),
        aliasKind: rootName === "archived_sessions" ? "archive" : "active",
      };
    }
  } else if (provider === "claude_code") {
    const claude = separators.lastIndexOf(".claude");
    if (claude >= 0 && separators[claude + 1] === "projects") {
      const rootPath = separators.slice(0, claude + 2).join(path.sep) || path.sep;
      return { rootPath, relativePath: path.relative(rootPath, normalized), aliasKind: "provider" };
    }
  } else if (provider === "gemini") {
    const gemini = separators.lastIndexOf(".gemini");
    if (gemini >= 0 && separators[gemini + 1] === "tmp") {
      const rootPath = separators.slice(0, gemini + 2).join(path.sep) || path.sep;
      return { rootPath, relativePath: path.relative(rootPath, normalized), aliasKind: "provider" };
    }
  }
  throw new Error(`unsupported ${provider} source path outside its allowlisted provider root`);
}

async function snapshotJsonl(
  filePath: string,
  expected: RecordConversationSourceInput["sourceSnapshot"] = undefined,
  expectedPriorContentHash?: string,
): Promise<SourceSnapshot> {
  const handle = await openLogicalSource(filePath);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) throw new Error("conversation source is not a regular file");
    const observedSize = Number(before.size);
    if (!Number.isSafeInteger(observedSize) || observedSize < 0) {
      throw new Error("conversation source extent exceeds safe integer range");
    }
    const size = expected?.byteLength ?? observedSize;
    if (!Number.isSafeInteger(size) || size < 0 || observedSize < size) {
      throw new ConversationSourceChangedError("conversation source was truncated after parser snapshot");
    }
    if (expected?.kind === "append") {
      let rangeEnd = -1;
      if (expected.appendRanges.length === 0) {
        throw new ConversationSourceChangedError("conversation append parser snapshot has no byte ranges");
      }
      for (const range of expected.appendRanges) {
        if (!Number.isSafeInteger(range.byteStart) || !Number.isSafeInteger(range.byteEnd)
          || range.byteStart !== rangeEnd && rangeEnd !== -1
          || range.byteStart < 0 || range.byteEnd < range.byteStart || range.byteEnd > size
          || !isSha256(range.contentHash)) {
          throw new ConversationSourceChangedError("conversation append parser snapshot has an invalid extent");
        }
        rangeEnd = range.byteEnd;
      }
      if (expected.appendRanges[0].byteStart > size || rangeEnd !== size) {
        throw new ConversationSourceChangedError("conversation append parser snapshot does not cover its extent");
      }
    }
    const beforeIdentity = sourceFilesystemIdentity(before);
    if (expected && (beforeIdentity.device !== expected.filesystemDevice
      || beforeIdentity.inode !== expected.filesystemInode)) {
      throw new ConversationSourceChangedError("conversation source file changed after parser snapshot");
    }

    const contentHash = createHash("sha256");
    const priorContentHash = expected?.kind === "append" ? createHash("sha256") : null;
    const appendRangeHashes = expected?.kind === "append"
      ? expected.appendRanges.map(() => createHash("sha256"))
      : [];
    const records: RecordRange[] = [];
    let carry: Buffer = Buffer.alloc(0);
    let carryOffset = 0;
    let total = 0;

    if (size > 0) {
      const stream = expected
        ? handle.createReadStream({ start: 0, end: size - 1, autoClose: false })
        : handle.createReadStream({ autoClose: false });
      for await (const rawChunk of stream) {
        const chunk = rawChunk as Buffer;
        contentHash.update(chunk);
        if (expected?.kind === "append") {
          const priorLength = Math.max(0, Math.min(chunk.length, expected.appendRanges[0].byteStart - total));
          if (priorLength > 0) priorContentHash?.update(chunk.subarray(0, priorLength));
          for (const [rangeIndex, range] of expected.appendRanges.entries()) {
            const overlapStart = Math.max(total, range.byteStart);
            const overlapEnd = Math.min(total + chunk.length, range.byteEnd);
            if (overlapEnd > overlapStart) {
              appendRangeHashes[rangeIndex].update(chunk.subarray(overlapStart - total, overlapEnd - total));
            }
          }
        }
        const data = carry.length === 0 ? chunk : Buffer.concat([carry, chunk]);
        let start = 0;
        for (;;) {
          const newline = data.indexOf(0x0a, start);
          if (newline < 0) break;
          const record = data.subarray(start, newline);
          if (record.toString("utf8").trim()) {
            records.push({
              ordinal: records.length,
              offset: carryOffset + start,
              length: record.length,
              hash: createHash("sha256").update(record).digest("hex"),
            });
          }
          start = newline + 1;
        }
        total += chunk.length;
        carry = data.subarray(start);
        carryOffset = total - carry.length;
      }
    }
    if (carry.toString("utf8").trim()) {
      records.push({
        ordinal: records.length,
        offset: carryOffset,
        length: carry.length,
        hash: createHash("sha256").update(carry).digest("hex"),
      });
    }

    const after = await handle.stat({ bigint: true });
    const afterSize = Number(after.size);
    const afterIdentity = sourceFilesystemIdentity(after);
    if (expected) {
      const pathAfter = await handle.stat({ bigint: true });
      if (
        total !== size || afterSize < size
        || beforeIdentity.device !== afterIdentity.device
        || beforeIdentity.inode !== afterIdentity.inode
        || !pathAfter.isFile()
        || pathAfter.dev.toString(10) !== beforeIdentity.device
        || pathAfter.ino.toString(10) !== beforeIdentity.inode
      ) {
        throw new ConversationSourceChangedError("conversation source changed while being indexed");
      }
    } else if (
      total !== size || afterSize !== size || before.mtimeNs !== after.mtimeNs
      || !sameSourceFilesystemIdentity(beforeIdentity, afterIdentity)
    ) {
      throw new ConversationSourceChangedError("conversation source changed while being indexed");
    }
    const snapshotHash = contentHash.digest("hex");
    if (expected?.kind === "full" && snapshotHash !== expected.contentHash) {
      throw new ConversationSourceChangedError("conversation source changed after parser snapshot");
    }
    if (expected?.kind === "append") {
      if (!expectedPriorContentHash
        || priorContentHash?.digest("hex") !== expectedPriorContentHash
        || appendRangeHashes.some((hash, index) => hash.digest("hex") !== expected.appendRanges[index].contentHash)) {
        throw new ConversationSourceChangedError("conversation source changed after append parser snapshot");
      }
    }
    return {
      contentHash: snapshotHash,
      size,
      mtimeMs: numericSourceExtent(after).fileMtimeMs,
      records,
      filesystemIdentity: afterIdentity,
      mode: Number(after.mode),
    };
  } finally {
    await handle.close();
  }
}


function numericMetadata(metadata: Record<string, unknown>, key: string): number | null {
  const value = metadata[key];
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function providerBlockKey(
  block: LegacyBlockRow,
  metadata: Record<string, unknown>,
  range: RecordRange,
  subBlockOrdinal: number,
): string {
  const sub = numericMetadata(metadata, "source_sub_block_ordinal") ?? subBlockOrdinal;
  const recordIdentity = `${range.ordinal}:${range.offset}:${range.hash}`;
  if (block.dag_uuid) return `dag:${block.dag_uuid}:${block.type}:${sub}:record:${recordIdentity}`;
  const toolId = typeof metadata.tool_id === "string" ? metadata.tool_id : "";
  if (toolId) return `tool:${toolId}:${block.type}:${sub}:record:${recordIdentity}`;
  return `record:${recordIdentity}:${block.type}:${sub}`;
}

function sameJson(left: string, right: string): boolean {
  try {
    return JSON.stringify(JSON.parse(left)) === JSON.stringify(JSON.parse(right));
  } catch {
    return left === right;
  }
}

export class ConversationSourceStore {
  constructor(private readonly db: Db) {}

  resolveConversation(conversationId: string): ConversationSourceDescriptor | null {
    const row = this.db.prepare(`
      SELECT id, conversation_id, provider, native_session_id, availability,
             custody_state, current_version_id, unavailable_reason,
             parser_format, parser_version, normalization_version, redaction_epoch
        FROM conversation_sources
       WHERE conversation_id = ?
       ORDER BY updated_at DESC, id
       LIMIT 1
    `).get(conversationId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      sourceId: String(row.id),
      conversationId: String(row.conversation_id),
      provider: row.provider as ConversationSource,
      nativeSessionId: String(row.native_session_id),
      availability: row.availability as ConversationSourceDescriptor["availability"],
      custodyState: row.custody_state as ConversationSourceDescriptor["custodyState"],
      currentVersionId: row.current_version_id == null ? null : String(row.current_version_id),
      unavailableReason: row.unavailable_reason == null ? null : String(row.unavailable_reason),
      parserFormat: String(row.parser_format),
      parserVersion: String(row.parser_version),
      normalizationVersion: String(row.normalization_version),
      redactionEpoch: Number(row.redaction_epoch),
    };
  }

  /** The source `resolveConversation` would pick, for many conversations in one statement. */
  latestSources(conversationIds: readonly string[]): Map<string, { sourceId: string; currentVersionId: string | null }> {
    const latest = new Map<string, { sourceId: string; currentVersionId: string | null }>();
    if (conversationIds.length === 0) return latest;
    const rows = this.db.prepare(`
      SELECT s.conversation_id, s.id, s.current_version_id
        FROM json_each(?) ids
        JOIN conversation_sources s ON s.conversation_id = ids.value
       ORDER BY s.conversation_id, s.updated_at DESC, s.id
    `).all(JSON.stringify([...new Set(conversationIds)])) as Array<{
      conversation_id: string; id: string; current_version_id: string | null;
    }>;
    for (const row of rows) {
      if (latest.has(row.conversation_id)) continue;
      latest.set(row.conversation_id, { sourceId: row.id, currentVersionId: row.current_version_id });
    }
    return latest;
  }

  resolveVersion(versionId: string): ConversationSourceVersion | null {
    const row = this.db.prepare(`
      SELECT id, source_id, content_sha256, byte_length, file_mtime_ms,
             filesystem_device, filesystem_inode, filesystem_ctime_ns,
             availability, custody_state, generation, parser_format,
             parser_version, normalization_version, redaction_epoch
        FROM conversation_source_versions
       WHERE id = ?
    `).get(versionId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      id: String(row.id),
      sourceId: String(row.source_id),
      contentSha256: String(row.content_sha256),
      byteLength: Number(row.byte_length),
      fileMtimeMs: row.file_mtime_ms == null ? null : Number(row.file_mtime_ms),
      filesystemDevice: row.filesystem_device == null ? null : String(row.filesystem_device),
      filesystemInode: row.filesystem_inode == null ? null : String(row.filesystem_inode),
      filesystemCtimeNs: row.filesystem_ctime_ns == null ? null : String(row.filesystem_ctime_ns),
      availability: row.availability as ConversationSourceVersion["availability"],
      custodyState: row.custody_state as ConversationSourceVersion["custodyState"],
      generation: row.generation as ConversationSourceVersion["generation"],
      parserFormat: String(row.parser_format),
      parserVersion: String(row.parser_version),
      normalizationVersion: String(row.normalization_version),
      redactionEpoch: Number(row.redaction_epoch),
    };
  }

  listAliases(sourceId: string): ConversationSourceAlias[] {
    return (this.db.prepare(`
      SELECT id, source_id, root_kind, root_path, relative_path, path, alias_kind, availability
        FROM conversation_source_aliases
       WHERE source_id = ?
       ORDER BY CASE availability WHEN 'available' THEN 0 ELSE 1 END, last_seen_at DESC
    `).all(sourceId) as Array<Record<string, unknown>>).map((row) => ({
      id: String(row.id),
      sourceId: String(row.source_id),
      rootKind: row.root_kind as ConversationSourceAlias["rootKind"],
      rootPath: String(row.root_path),
      relativePath: String(row.relative_path),
      path: String(row.path),
      aliasKind: row.alias_kind as ConversationSourceAlias["aliasKind"],
      availability: row.availability as ConversationSourceAlias["availability"],
    }));
  }

  /** Paths of each source's aliases marked available, keyed by source id. */
  availableAliasPaths(sourceIds: readonly string[]): Map<string, string[]> {
    const paths = new Map<string, string[]>();
    if (sourceIds.length === 0) return paths;
    const rows = this.db.prepare(`
      SELECT source_id, path FROM conversation_source_aliases
       WHERE availability = 'available' AND source_id IN (SELECT value FROM json_each(?))
    `).all(JSON.stringify([...new Set(sourceIds)])) as Array<{ source_id: string; path: string }>;
    for (const row of rows) {
      const forSource = paths.get(row.source_id);
      if (forSource) forSource.push(row.path);
      else paths.set(row.source_id, [row.path]);
    }
    return paths;
  }

  resolveLegacyBlockId(alias: string): string | null {
    const row = this.db.prepare(
      "SELECT block_id FROM conversation_block_aliases WHERE alias = ?",
    ).get(alias) as { block_id: string } | undefined;
    return row?.block_id ?? null;
  }

  /**
   * Remove the duplicate normalized payload only after every current block has
   * an exact bounded source locator under the current sealed version.
   */
  private compatibilityRows(conversationId: string): CompatibilityBlockRow[] {
    return this.db.prepare(`
      SELECT id, conversation_id, type, role, content, compressed, position,
             timestamp, parent_id, metadata_json, dag_uuid, dag_parent_uuid,
             payload_state
        FROM conversation_blocks
       WHERE conversation_id = ?
       ORDER BY position, id
    `).all(conversationId) as CompatibilityBlockRow[];
  }

  private stripConversationPayload(conversationId: string, proof: LogicalSourceHandle): { promoted: boolean; blocks: number; reason: string | null } {
    const state = this.db.prepare(`
        SELECT c.block_count,
               (SELECT COUNT(*) FROM conversation_blocks b
                 WHERE b.conversation_id = c.id) AS body_rows,
               (SELECT COUNT(*) FROM conversation_structural_blocks sb
                 WHERE sb.conversation_id = c.id AND sb.status = 'current') AS structural_rows,
               (SELECT COUNT(*) FROM conversation_structural_blocks sb
                 WHERE sb.conversation_id = c.id AND sb.status = 'current'
                   AND NOT (sb.source_version_id = s.current_version_id
                            AND sb.record_offset IS NOT NULL
                            AND sb.record_length IS NOT NULL
                            AND sb.record_length <= 67108864
                            AND sb.record_hash IS NOT NULL
                            AND sb.record_ordinal IS NOT NULL
                            AND sb.record_ordinal >= 0
                            AND (v.parser_format = 'mandible-normalized-jsonl'
                              OR s.provider <> 'gemini'
                              OR (sb.record_offset = 0
                                AND sb.record_length = v.byte_length
                                AND sb.record_hash = v.content_sha256
                                AND sb.record_ordinal = 0)))) AS invalid_locators,
               s.id AS source_id,
               s.provider,
               s.availability,
               v.generation,
               v.availability AS version_availability,
               v.filesystem_device,
               v.filesystem_inode,
               v.filesystem_ctime_ns,
               v.byte_length,
               v.content_sha256
          FROM conversations c
          JOIN conversation_sources s ON s.conversation_id = c.id
          JOIN conversation_source_versions v ON v.id = s.current_version_id
         WHERE c.id = ?
    `).get(conversationId) as {
        block_count: number;
        body_rows: number;
        structural_rows: number;
        invalid_locators: number;
        source_id: string;
        provider: ConversationSource;
        availability: string;
        generation: string;
        version_availability: string;
        filesystem_device: string | null;
        filesystem_inode: string | null;
        filesystem_ctime_ns: string | null;
        byte_length: number;
        content_sha256: string;
    } | undefined;
    if (!state) return { promoted: false, blocks: 0, reason: "current sealed source is missing" };
    if (state.availability !== "available" || state.version_availability !== "available"
        || state.generation !== "sealed_sha256" || !state.filesystem_device
        || !state.filesystem_inode || !state.filesystem_ctime_ns) {
      return { promoted: false, blocks: state.body_rows, reason: "current source is not exactly available" };
    }
    if (state.body_rows !== state.block_count || state.structural_rows !== state.block_count
        || state.invalid_locators !== 0) {
      return { promoted: false, blocks: state.body_rows, reason: "bounded structural locator coverage is incomplete" };
    }
    const expectedIdentity: SourceFilesystemIdentity = {
      device: state.filesystem_device,
      inode: state.filesystem_inode,
      ctimeNs: state.filesystem_ctime_ns,
    };
    const before = proof.statSync();
    if (Number(before.size) !== state.byte_length
        || !sameSourceFilesystemIdentity(expectedIdentity, sourceFilesystemIdentity(before))) {
      return { promoted: false, blocks: state.body_rows, reason: "exact provider source is no longer present" };
    }
    this.db.prepare(`
      UPDATE conversation_blocks SET content = '', metadata_json = '{}', compressed = 0,
        payload_state = 'source' WHERE conversation_id = ?
    `).run(conversationId);
    const after = proof.statSync();
    if (Number(after.size) !== state.byte_length
        || !sameSourceFilesystemIdentity(expectedIdentity, sourceFilesystemIdentity(after))) {
      throw new ConversationSourceChangedError("conversation source changed while duplicate payload was stripped");
    }
    return { promoted: true, blocks: state.block_count, reason: null };
  }

  /** Strip only after the ordinary unmasked source reader exactly reproduces the DB projection. */
  async verifyAndPromoteConversationPayload(
    conversationId: string,
    normalizedProjection?: ReadonlyArray<{
      id: string;
      type: string;
      role: string;
      content: string;
      position: number;
      timestamp: string | null;
      parent_id: string | null;
      metadata_json: string;
      dag_uuid: string | null;
      dag_parent_uuid: string | null;
    }>,
  ): Promise<{ promoted: boolean; blocks: number; reason: string | null }> {
    const compatibilitySnapshot = this.compatibilityRows(conversationId);
    const expected = compatibilitySnapshot.filter((row) => row.payload_state === "legacy");
    if (expected.length === 0) {
      return { promoted: false, blocks: 0, reason: "no legacy payload is available for projection verification" };
    }
    if (normalizedProjection && normalizedProjection.length !== expected.length) {
      return { promoted: false, blocks: expected.length, reason: "normalized projection block count diverges" };
    }
    const { ConversationSourceReader } = await import("./source-reader.js");
    const read = await new ConversationSourceReader(this.db, {
      legacyFallback: false,
      maskCredentials: false,
    }).readAll(conversationId);
    if (read.status !== "source") {
      return { promoted: false, blocks: expected.length, reason: `exact source read failed: ${read.reason}` };
    }
    const malformedSource = compatibilitySnapshot.some((row) => row.payload_state === "source"
      && (row.content.length !== 0 || row.metadata_json !== "{}" || row.compressed !== 0));
    if (read.value.length !== compatibilitySnapshot.length || malformedSource) {
      return { promoted: false, blocks: expected.length, reason: "exact source projection block count diverges" };
    }
    const sourceByPosition = new Map(read.value.map((block) => [block.position, block]));
    for (let index = 0; index < expected.length; index += 1) {
      const row = expected[index];
      const projection = normalizedProjection?.[index];
      if (projection && (projection.id !== row.id || projection.position !== row.position
          || projection.type !== row.type || projection.role !== row.role
          || projection.timestamp !== row.timestamp || projection.parent_id !== row.parent_id
          || projection.dag_uuid !== row.dag_uuid || projection.dag_parent_uuid !== row.dag_parent_uuid)) {
        return { promoted: false, blocks: expected.length, reason: "normalized projection structural identity diverges" };
      }
      const block = sourceByPosition.get(row.position);
      if (!block) {
        return { promoted: false, blocks: expected.length, reason: "exact source projection block count diverges" };
      }
      const compared = projection ?? {
        ...row,
        content: decompressContent(row.content, row.compressed === 1),
      };
      const expectedId = this.resolveLegacyBlockId(compared.id) ?? compared.id;
      const parentAtPosition = compared.parent_id !== null && /^\d+$/.test(compared.parent_id)
        ? sourceByPosition.get(Number(compared.parent_id))?.id ?? null
        : null;
      const expectedParent = parentAtPosition ?? (compared.parent_id === null
        ? null
        : this.resolveLegacyBlockId(compared.parent_id) ?? compared.parent_id);
      if (block.id !== expectedId || block.position !== compared.position
          || block.type !== compared.type || block.role !== compared.role || block.content !== compared.content
          || !sameJson(block.metadata_json, compared.metadata_json)
          || block.timestamp !== compared.timestamp || block.parent_id !== expectedParent
          || block.dag_uuid !== compared.dag_uuid || block.dag_parent_uuid !== compared.dag_parent_uuid) {
        return {
          promoted: false,
          blocks: expected.length,
          reason: `exact source projection diverges at block position ${row.position}`,
        };
      }
    }
    const source = this.resolveConversation(conversationId);
    let proof: LogicalSourceHandle | null = null;
    for (const alias of source ? this.listAliases(source.sourceId) : []) {
      if (alias.availability !== "available") continue;
      try { proof = await openLogicalSource(alias.path, { rootPath: alias.rootPath }); break; }
      catch { /* Source verification below fails closed if no alias remains. */ }
    }
    if (!proof) return { promoted: false, blocks: expected.length, reason: "exact provider source is no longer present" };
    const promote = this.db.transaction(() => {
      const current = this.compatibilityRows(conversationId);
      if (!sameCompatibilityRows(compatibilitySnapshot, current)) {
        throw new ConversationPayloadChangedError("conversation payload changed after source verification");
      }
      return this.stripConversationPayload(conversationId, proof!);
    });
    try {
      return promote.immediate();
    } catch (error) {
      if (error instanceof ConversationPayloadChangedError) {
        return { promoted: false, blocks: expected.length, reason: error.message };
      }
      throw error;
    } finally {
      await proof.close();
    }
  }

  /**
   * Native provider bytes are the conversation authority. Once the current
   * parser can read the sealed, indexed source, discard an old normalized
   * cache without requiring a historical parser projection to match it.
   */
  async promoteNativeConversationPayload(
    conversationId: string,
  ): Promise<{ promoted: boolean; blocks: number; reason: string | null }> {
    const compatibilitySnapshot = this.compatibilityRows(conversationId);
    const expected = compatibilitySnapshot.filter((row) => row.payload_state === "legacy");
    if (expected.length === 0) {
      return { promoted: false, blocks: 0, reason: "no legacy payload is available for promotion" };
    }
    const { ConversationSourceReader } = await import("./source-reader.js");
    const read = await new ConversationSourceReader(this.db, {
      legacyFallback: false,
      maskCredentials: false,
    }).readAll(conversationId);
    if (read.status !== "source") {
      return { promoted: false, blocks: expected.length, reason: `native source read failed: ${read.reason}` };
    }
    const promote = this.db.transaction(() => {
      const current = this.compatibilityRows(conversationId);
      if (!sameCompatibilityRows(compatibilitySnapshot, current)) {
        throw new ConversationPayloadChangedError("conversation payload changed after native source verification");
      }
      this.db.prepare(`UPDATE conversation_blocks
        SET content = '', metadata_json = '{}', compressed = 0, payload_state = 'source'
        WHERE conversation_id = ? AND payload_state = 'legacy'`).run(conversationId);
      return { promoted: true, blocks: expected.length, reason: null };
    });
    try {
      return promote.immediate();
    } catch (error) {
      if (error instanceof ConversationPayloadChangedError) {
        return { promoted: false, blocks: expected.length, reason: error.message };
      }
      throw error;
    }
  }

  /** Retain the conversation index while making an unresolved native source explicit. */
  discardUnavailableConversationPayload(input: {
    conversationId: string;
    provider: ConversationSource;
    nativeSessionId: string;
    reason: string;
    parserFormat: string;
    parserVersion: string;
    normalizationVersion: string;
    redactionEpoch: number;
  }): { promoted: boolean; blocks: number; reason: string | null } {
    const existing = this.db.prepare(`SELECT id FROM conversation_sources
      WHERE conversation_id = ? AND provider = ?`).get(input.conversationId, input.provider) as { id: string } | undefined;
    const sourceId = existing?.id ?? stableId("csrc", input.conversationId, input.provider);
    const now = Date.now();
    return this.db.transaction(() => {
      const count = (this.db.prepare(`SELECT COUNT(*) AS count FROM conversation_blocks
        WHERE conversation_id = ? AND payload_state = 'legacy'`).get(input.conversationId) as { count: number }).count;
      this.db.prepare(`
        INSERT INTO conversation_sources (
          id, conversation_id, provider, native_session_id, parser_format, parser_version,
          normalization_version, redaction_epoch, availability, custody_state,
          current_version_id, unavailable_reason, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'missing', 'provider', NULL, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET availability = 'missing',
          unavailable_reason = excluded.unavailable_reason, updated_at = excluded.updated_at
      `).run(sourceId, input.conversationId, input.provider, input.nativeSessionId,
        input.parserFormat, input.parserVersion, input.normalizationVersion, input.redactionEpoch,
        input.reason, now, now);
      this.db.prepare(`UPDATE conversation_blocks
        SET content = '', metadata_json = '{}', compressed = 0, payload_state = 'source'
        WHERE conversation_id = ? AND payload_state = 'legacy'`).run(input.conversationId);
      return { promoted: count > 0, blocks: count, reason: input.reason };
    }).immediate();
  }

  /** Register a provider or managed-custody alias without changing source identity. */
  recordAlias(input: RecordConversationSourceAliasInput): string {
    const rootPath = path.resolve(input.rootPath);
    const resolvedPath = path.resolve(rootPath, input.relativePath);
    if (!insideDeclaredRoot(rootPath, resolvedPath)) {
      throw new Error("conversation source alias escapes its declared root");
    }
    const id = stableId("csa", input.sourceId, resolvedPath);
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO conversation_source_aliases (
        id, source_id, root_kind, root_path, relative_path, path, alias_kind,
        availability, first_seen_at, last_seen_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET
        source_id = excluded.source_id, root_kind = excluded.root_kind,
        root_path = excluded.root_path, relative_path = excluded.relative_path,
        alias_kind = excluded.alias_kind, availability = excluded.availability,
        last_seen_at = excluded.last_seen_at
    `).run(
      id, input.sourceId, input.rootKind, rootPath, path.relative(rootPath, resolvedPath),
      resolvedPath, input.aliasKind, input.availability ?? "unchecked", now, now,
    );
    return id;
  }

  /** Persist replay context for a parser epoch. Checkpoints contain no bodies. */
  recordCheckpoint(input: RecordNormalizationCheckpointInput): string {
    const id = stableId("ccp", input.sourceVersionId, String(input.recordOrdinal),
      input.parserVersion, input.normalizationVersion, String(input.redactionEpoch));
    this.db.prepare(`
      INSERT INTO conversation_normalization_checkpoints (
        id, source_version_id, record_ordinal, prefix_offset, parser_format,
        parser_version, normalization_version, redaction_epoch, state_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_version_id, record_ordinal, parser_version, normalization_version, redaction_epoch)
      DO UPDATE SET prefix_offset = excluded.prefix_offset, state_json = excluded.state_json
    `).run(
      id, input.sourceVersionId, input.recordOrdinal, input.prefixOffset,
      input.parserFormat, input.parserVersion, input.normalizationVersion,
      input.redactionEpoch, JSON.stringify(input.state), Date.now(),
    );
    return id;
  }

  /** Atomically attach custody evidence only while the sealed version remains current. */
  updateVersionCustody(input: UpdateConversationSourceCustodyInput): boolean {
    return this.db.transaction(() => {
      const current = this.db.prepare(`
        SELECT v.id
          FROM conversation_sources s
          JOIN conversation_source_versions v ON v.id = s.current_version_id
         WHERE s.id = ? AND s.current_version_id = ?
           AND v.source_id = s.id AND v.content_sha256 = ?
           AND v.generation = 'sealed_sha256' AND v.availability = 'available'
      `).get(input.sourceId, input.sourceVersionId, input.sourceContentSha256) as { id: string } | undefined;
      if (!current) return false;
      const result = this.db.prepare(`
        UPDATE conversation_source_versions
           SET custody_state = ?, custody_ref = ?, capture_consistency = ?, verification_json = ?
         WHERE id = ? AND source_id = ? AND content_sha256 = ?
           AND generation = 'sealed_sha256' AND availability = 'available'
      `).run(
        input.custodyState, input.custodyRef ?? null, input.captureConsistency ?? null,
        JSON.stringify(input.verification ?? {}), input.sourceVersionId,
        input.sourceId, input.sourceContentSha256,
      );
      if (result.changes !== 1) return false;
      const sourceResult = this.db.prepare(`
        UPDATE conversation_sources SET custody_state = ?, updated_at = ?
         WHERE id = ? AND current_version_id = ?
      `).run(input.custodyState, Date.now(), input.sourceId, input.sourceVersionId);
      return sourceResult.changes === 1;
    })();
  }

  async recordConversation(input: RecordConversationSourceInput): Promise<string> {
    const existingSource = this.db.prepare(`
      SELECT id FROM conversation_sources WHERE conversation_id = ? AND provider = ?
    `).get(input.conversationId, input.provider) as { id: string } | undefined;
    const sourceId = existingSource?.id ?? stableId("csrc", input.conversationId, input.provider);
    let expectedPriorContentHash: string | undefined;
    if (input.sourceSnapshot?.kind === "append") {
      const priorVersion = this.db.prepare(`
        SELECT v.byte_length, v.content_sha256
          FROM conversation_sources s
          JOIN conversation_source_versions v ON v.id = s.current_version_id
         WHERE s.id = ?
      `).get(sourceId) as { byte_length: number; content_sha256: string } | undefined;
      if (!priorVersion
        || priorVersion.byte_length !== input.sourceSnapshot.appendRanges[0]?.byteStart) {
        throw new ConversationSourceChangedError("conversation append checkpoint is outside the sealed source version");
      }
      expectedPriorContentHash = priorVersion.content_sha256;
    }
    const snapshot = await snapshotJsonl(
      input.filePath,
      input.sourceSnapshot,
      expectedPriorContentHash,
    );
    if (!input.sourceSnapshot && input.expectedContentHash && isSha256(input.expectedContentHash)
      && input.expectedContentHash !== snapshot.contentHash) {
      throw new ConversationSourceChangedError("conversation source changed after parser snapshot");
    }
    const existingVersion = this.db.prepare(`
      SELECT id
        FROM conversation_source_versions
       WHERE source_id = ? AND content_sha256 = ?
    `).get(sourceId, snapshot.contentHash) as { id: string } | undefined;
    // Migration v140 may already have backfilled this exact provider hash under
    // a legacy id. Preserve that referenced identity instead of manufacturing a
    // new id that the UNIQUE(source_id, content_sha256) upsert will not insert.
    const versionId = existingVersion?.id ?? stableId("cver", sourceId, snapshot.contentHash);
    const alias = sourceRoot(input.provider, input.filePath);
    const aliasPath = path.resolve(canonicalSourcePath(input.filePath));
    const aliasId = stableId("csa", sourceId, aliasPath);
    const now = Date.now();
    const blocks: LegacyBlockRow[] = input.blocks
      ? input.blocks.map((block) => ({
        id: block.legacyId,
        conversation_id: input.conversationId,
        type: block.type,
        role: block.role,
        position: block.position,
        timestamp: block.timestamp,
        parent_id: block.parent_id,
        metadata_json: JSON.stringify(block.metadata),
        dag_uuid: block.dag_uuid ?? null,
        dag_parent_uuid: block.dag_parent_uuid ?? null,
      }))
      : this.db.prepare(`
        SELECT id, conversation_id, type, role, position, timestamp, parent_id,
               metadata_json, dag_uuid, dag_parent_uuid
          FROM conversation_blocks
         WHERE conversation_id = ?
         ORDER BY position
      `).all(input.conversationId) as LegacyBlockRow[];
    const structuralMode = input.structuralMode ?? "replace";
    const codexModelPositions = new Set(
      input.provider === "codex"
        ? blocks.filter((block) => {
          const metadata = parseJsonObjectStrict(block.metadata_json, "conversation block metadata_json");
          return (block.type === "assistant_message" || block.type === "thinking")
            && typeof metadata.model === "string" && metadata.model.length > 0;
        }).map((block) => block.position)
        : [],
    );

    const apply = this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO conversation_sources (
          id, conversation_id, provider, native_session_id, parser_format, parser_version,
          normalization_version, redaction_epoch, availability, custody_state,
          current_version_id, unavailable_reason, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'available', 'provider', NULL, NULL, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          native_session_id = excluded.native_session_id,
          parser_format = excluded.parser_format,
          parser_version = excluded.parser_version,
          normalization_version = excluded.normalization_version,
          redaction_epoch = excluded.redaction_epoch,
          availability = 'available',
          unavailable_reason = NULL,
          updated_at = excluded.updated_at
      `).run(
        sourceId, input.conversationId, input.provider, input.nativeSessionId,
        input.parserFormat, input.parserVersion, input.normalizationVersion, input.redactionEpoch,
        now, now,
      );
      this.db.prepare(`
        INSERT INTO conversation_source_aliases (
          id, source_id, root_kind, root_path, relative_path, path, alias_kind,
          availability, first_seen_at, last_seen_at
        ) VALUES (?, ?, 'provider', ?, ?, ?, ?, 'available', ?, ?)
        ON CONFLICT(path) DO UPDATE SET
          source_id = excluded.source_id, root_kind = excluded.root_kind,
          root_path = excluded.root_path, relative_path = excluded.relative_path,
          alias_kind = excluded.alias_kind, availability = 'available',
          last_seen_at = excluded.last_seen_at
      `).run(aliasId, sourceId, alias.rootPath, alias.relativePath, aliasPath, alias.aliasKind, now, now);
      this.db.prepare(`
        INSERT INTO conversation_source_versions (
          id, source_id, content_sha256, byte_length, file_mtime_ms,
          filesystem_device, filesystem_inode, filesystem_ctime_ns, generation,
          parser_format, parser_version, normalization_version, redaction_epoch,
          availability, custody_state, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'sealed_sha256', ?, ?, ?, ?, 'available', 'provider', ?)
        ON CONFLICT(source_id, content_sha256) DO UPDATE SET
          byte_length = excluded.byte_length,
          file_mtime_ms = excluded.file_mtime_ms,
          filesystem_device = excluded.filesystem_device,
          filesystem_inode = excluded.filesystem_inode,
          filesystem_ctime_ns = excluded.filesystem_ctime_ns,
          generation = 'sealed_sha256',
          parser_format = excluded.parser_format,
          parser_version = excluded.parser_version,
          normalization_version = excluded.normalization_version,
          redaction_epoch = excluded.redaction_epoch,
          availability = 'available'
      `).run(
        versionId, sourceId, snapshot.contentHash, snapshot.size, snapshot.mtimeMs,
        snapshot.filesystemIdentity.device, snapshot.filesystemIdentity.inode,
        snapshot.filesystemIdentity.ctimeNs,
        input.parserFormat, input.parserVersion, input.normalizationVersion,
        input.redactionEpoch, now,
      );
      // conversation_sources.current_version_id and
      // conversation_source_versions.source_id form a deliberate cycle. Insert
      // the source without a current version, insert or refresh the version,
      // then complete the pointer while both rows exist. SQLite checks these
      // immediate foreign keys after each statement, not only at transaction
      // commit; assigning a newly generated version id in the first INSERT
      // therefore fails on every changed source when foreign_keys is enabled.
      this.db.prepare(`
        UPDATE conversation_sources
           SET current_version_id = ?, updated_at = ?
         WHERE id = ?
      `).run(versionId, now, sourceId);

      const inheritedCodexModelPositions = new Set<number>();
      if (structuralMode === "append") {
        const priorCheckpoints = this.db.prepare(`
          SELECT sb.position, checkpoint.state_json
            FROM conversation_structural_blocks sb
            JOIN conversation_normalization_checkpoints checkpoint
              ON checkpoint.id = sb.normalization_checkpoint_id
           WHERE sb.conversation_id = ? AND sb.status = 'current'
        `).all(input.conversationId) as Array<{ position: number; state_json: string }>;
        for (const checkpoint of priorCheckpoints) {
          try {
            const state = JSON.parse(checkpoint.state_json) as { kind?: unknown; version?: unknown };
            if (state.kind === "codex-model-metadata" && state.version === 1) {
              inheritedCodexModelPositions.add(checkpoint.position);
            }
          } catch {
            // The reader will fail closed on a malformed referenced checkpoint.
          }
        }
      }
      const allCodexModelPositions = new Set([...inheritedCodexModelPositions, ...codexModelPositions]);
      const codexModelCheckpointId = allCodexModelPositions.size === 0 ? null : this.recordCheckpoint({
        sourceVersionId: versionId,
        recordOrdinal: 0,
        prefixOffset: 0,
        parserFormat: input.parserFormat,
        parserVersion: input.parserVersion,
        normalizationVersion: input.normalizationVersion,
        redactionEpoch: input.redactionEpoch,
        // This is parser state only: it proves that the full Codex parser
        // attached model metadata for these rows; it stores no transcript body.
        state: { kind: "codex-model-metadata", version: 1 },
      });

      if (structuralMode === "append") {
        // An append creates a new sealed source version but does not change the
        // already-indexed prefix. Rebind that prefix to the new version and add
        // only the parser-provided tail below. This is what lets ingestion stop
        // retaining normalized body metadata merely to rebuild the locator map.
        this.db.prepare(`
          UPDATE conversation_structural_blocks
             SET source_version_id = ?, normalization_checkpoint_id = NULL,
                 parser_format = ?, parser_version = ?, normalization_version = ?,
                 redaction_epoch = ?, updated_at = ?
           WHERE conversation_id = ? AND status = 'current'
        `).run(
          versionId, input.parserFormat, input.parserVersion,
          input.normalizationVersion, input.redactionEpoch, now, input.conversationId,
        );
        if (codexModelCheckpointId && inheritedCodexModelPositions.size > 0) {
          this.db.prepare(`
            UPDATE conversation_structural_blocks
               SET normalization_checkpoint_id = ?
             WHERE conversation_id = ? AND status = 'current'
               AND position IN (${[...inheritedCodexModelPositions].map(() => "?").join(",")})
          `).run(codexModelCheckpointId, input.conversationId, ...inheritedCodexModelPositions);
        }
      } else {
        this.db.prepare(
          "UPDATE conversation_structural_blocks SET status = 'retired', updated_at = ? WHERE conversation_id = ? AND status = 'current'",
        ).run(now, input.conversationId);
      }

      const positionToId = new Map<number, string>(
        structuralMode === "append"
          ? (this.db.prepare(`
              SELECT position, id FROM conversation_structural_blocks
               WHERE conversation_id = ? AND status = 'current'
            `).all(input.conversationId) as Array<{ position: number; id: string }>)
            .map((row) => [row.position, row.id])
          : [],
      );
      const pendingParents: Array<{ blockId: string; parentPosition: number | null }> = [];
      const providerKeyOccurrences = new Map<string, number>();
      const findAlias = this.db.prepare(
        "SELECT block_id FROM conversation_block_aliases WHERE alias = ?",
      );
      const findProviderKey = this.db.prepare(`
        SELECT id FROM conversation_structural_blocks
         WHERE conversation_id = ? AND provider_key = ?
         ORDER BY created_at LIMIT 1
      `);
      const upsertStructuralBlock = this.db.prepare(`
        INSERT INTO conversation_structural_blocks (
          id, conversation_id, source_version_id, status, provider_key, position,
          type, role, timestamp, parent_block_id, dag_uuid, dag_parent_uuid,
          record_offset, record_length, record_hash, record_ordinal,
          sub_block_ordinal, normalization_checkpoint_id, parser_format,
          parser_version, normalization_version, redaction_epoch, created_at, updated_at
        ) VALUES (
          ?, ?, ?, 'current', ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        )
        ON CONFLICT(id) DO UPDATE SET
          source_version_id = excluded.source_version_id, status = 'current',
          provider_key = excluded.provider_key, position = excluded.position,
          type = excluded.type, role = excluded.role, timestamp = excluded.timestamp,
          dag_uuid = excluded.dag_uuid, dag_parent_uuid = excluded.dag_parent_uuid,
          record_offset = excluded.record_offset, record_length = excluded.record_length,
          record_hash = excluded.record_hash, record_ordinal = excluded.record_ordinal,
          sub_block_ordinal = excluded.sub_block_ordinal,
          normalization_checkpoint_id = excluded.normalization_checkpoint_id,
          parser_format = excluded.parser_format, parser_version = excluded.parser_version,
          normalization_version = excluded.normalization_version,
          redaction_epoch = excluded.redaction_epoch, updated_at = excluded.updated_at
      `);
      const upsertAlias = this.db.prepare(`
        INSERT INTO conversation_block_aliases (alias, block_id, alias_kind, created_at)
        VALUES (?, ?, 'legacy', ?)
        ON CONFLICT(alias) DO UPDATE SET block_id = excluded.block_id
      `);
      const setParent = this.db.prepare(
        "UPDATE conversation_structural_blocks SET parent_block_id = ? WHERE id = ?",
      );
      for (const block of blocks) {
        const metadata = parseJsonObjectStrict(block.metadata_json, "conversation block metadata_json");
        // Gemini's legacy JSON and JSONL parser normalizes the whole session at
        // once and does not expose per-message record ordinals. Its files are
        // bounded, so seal the complete provider file as one exact record.
        const wholeGeminiSource = input.provider === "gemini" && input.blocks !== undefined;
        const recordOrdinal = wholeGeminiSource
          ? 0
          : numericMetadata(metadata, "source_record_ordinal");
        const range = wholeGeminiSource
          ? { ordinal: 0, offset: 0, length: snapshot.size, hash: snapshot.contentHash }
          : recordOrdinal === null
          ? { ordinal: -1, offset: 0, length: snapshot.size, hash: snapshot.contentHash }
          : snapshot.records[recordOrdinal];
        if (!range) continue;
        const subBlockOrdinal = numericMetadata(metadata, "source_sub_block_ordinal") ?? block.position;
        const providerKeyBase = providerBlockKey(block, metadata, range, subBlockOrdinal);
        const providerKeyOccurrence = providerKeyOccurrences.get(providerKeyBase) ?? 0;
        providerKeyOccurrences.set(providerKeyBase, providerKeyOccurrence + 1);
        const providerKey = providerKeyOccurrence === 0
          ? providerKeyBase
          : `${providerKeyBase}:occurrence:${providerKeyOccurrence}`;
        const aliasRow = findAlias.get(block.id) as { block_id: string } | undefined;
        const keyRow = findProviderKey.get(input.conversationId, providerKey) as { id: string } | undefined;
        // The provider key is the stable parser identity. A legacy block alias
        // can point at an older placeholder structural row while a partial
        // prior index already owns this key; reusing the alias row would try
        // to assign the same unique key twice. Reuse the key owner and move
        // the legacy alias to it instead.
        const blockId = keyRow?.id ?? aliasRow?.block_id
          ?? stableId("cblk", input.conversationId, providerKey);
        positionToId.set(block.position, blockId);
        const parentPosition = block.parent_id !== null && /^\d+$/.test(block.parent_id)
          ? Number(block.parent_id)
          : null;
        pendingParents.push({ blockId, parentPosition });

        upsertStructuralBlock.run(
          blockId, input.conversationId, versionId, providerKey, block.position,
          block.type, block.role, block.timestamp, block.dag_uuid, block.dag_parent_uuid,
          range.offset, range.length, range.hash, range.ordinal, subBlockOrdinal,
          allCodexModelPositions.has(block.position) ? codexModelCheckpointId : null,
          input.parserFormat, input.parserVersion,
          input.normalizationVersion, input.redactionEpoch, now, now,
        );
        upsertAlias.run(block.id, blockId, now);
      }
      for (const pending of pendingParents) {
        setParent.run(
          pending.parentPosition === null ? null : positionToId.get(pending.parentPosition) ?? null,
          pending.blockId,
        );
      }
    });
    apply();
    return versionId;
  }

  /** Register an immutable Mandible-owned normalized source without stripping DB payload. */
  async recordManagedNormalizedSource(input: RecordManagedNormalizedSourceInput): Promise<string> {
    const rootPath = fs.realpathSync.native(path.resolve(input.rootPath));
    const filePath = fs.realpathSync.native(path.resolve(input.filePath));
    if (!insideDeclaredRoot(rootPath, filePath)) {
      throw new Error("managed conversation source escapes its declared root");
    }
    const snapshot = await snapshotJsonl(filePath);
    if ((snapshot.mode & 0o7777) !== 0o600) {
      throw new Error("managed conversation source permissions are not owner-only 0600");
    }
    if (snapshot.contentHash !== input.expectedContentHash) {
      throw new Error("managed conversation source changed after materialization");
    }
    if (snapshot.records.length !== input.blocks.length) {
      throw new Error("managed conversation source record count diverges");
    }
    for (let index = 0; index < input.blocks.length; index += 1) {
      const block = input.blocks[index];
      const range = snapshot.records[index];
      if (block.recordOrdinal !== range.ordinal || block.recordOffset !== range.offset
          || block.recordLength !== range.length || block.recordHash !== range.hash) {
        throw new Error("managed conversation source locator map diverges");
      }
    }

    const existingSource = this.db.prepare(`
      SELECT id FROM conversation_sources WHERE conversation_id = ? AND provider = ?
    `).get(input.conversationId, input.provider) as { id: string } | undefined;
    const sourceId = existingSource?.id ?? stableId("csrc", input.conversationId, input.provider);
    const existingVersion = this.db.prepare(`
      SELECT id FROM conversation_source_versions WHERE source_id = ? AND content_sha256 = ?
    `).get(sourceId, snapshot.contentHash) as { id: string } | undefined;
    const versionId = existingVersion?.id ?? stableId("cver", sourceId, snapshot.contentHash);
    const aliasId = stableId("csa", sourceId, filePath);
    const now = Date.now();
    const blockIds = new Set(input.blocks.map((block) => block.id));
    const blockIdsByPosition = new Map(input.blocks.map((block) => [block.position, block.id]));

    this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO conversation_sources (
          id, conversation_id, provider, native_session_id, parser_format, parser_version,
          normalization_version, redaction_epoch, availability, custody_state,
          current_version_id, unavailable_reason, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'available', 'sealed', NULL, NULL, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          native_session_id = excluded.native_session_id,
          parser_format = excluded.parser_format,
          parser_version = excluded.parser_version,
          normalization_version = excluded.normalization_version,
          redaction_epoch = excluded.redaction_epoch,
          availability = 'available', custody_state = 'sealed',
          unavailable_reason = NULL, updated_at = excluded.updated_at
      `).run(
        sourceId, input.conversationId, input.provider, input.nativeSessionId,
        input.parserFormat, input.parserVersion, input.normalizationVersion,
        input.redactionEpoch, now, now,
      );
      this.db.prepare(`
        INSERT INTO conversation_source_aliases (
          id, source_id, root_kind, root_path, relative_path, path, alias_kind,
          availability, first_seen_at, last_seen_at
        ) VALUES (?, ?, 'managed_custody', ?, ?, ?, 'managed', 'available', ?, ?)
        ON CONFLICT(path) DO UPDATE SET
          source_id = excluded.source_id, root_kind = 'managed_custody',
          root_path = excluded.root_path, relative_path = excluded.relative_path,
          alias_kind = 'managed', availability = 'available',
          last_seen_at = excluded.last_seen_at
      `).run(aliasId, sourceId, rootPath, path.relative(rootPath, filePath), filePath, now, now);
      this.db.prepare(`
        INSERT INTO conversation_source_versions (
          id, source_id, content_sha256, byte_length, file_mtime_ms,
          filesystem_device, filesystem_inode, filesystem_ctime_ns, generation,
          parser_format, parser_version, normalization_version, redaction_epoch,
          availability, custody_state, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'sealed_sha256', ?, ?, ?, ?, 'available', 'sealed', ?)
        ON CONFLICT(source_id, content_sha256) DO UPDATE SET
          byte_length = excluded.byte_length, file_mtime_ms = excluded.file_mtime_ms,
          filesystem_device = excluded.filesystem_device,
          filesystem_inode = excluded.filesystem_inode,
          filesystem_ctime_ns = excluded.filesystem_ctime_ns,
          generation = 'sealed_sha256', parser_format = excluded.parser_format,
          parser_version = excluded.parser_version,
          normalization_version = excluded.normalization_version,
          redaction_epoch = excluded.redaction_epoch,
          availability = 'available', custody_state = 'sealed'
      `).run(
        versionId, sourceId, snapshot.contentHash, snapshot.size, snapshot.mtimeMs,
        snapshot.filesystemIdentity.device, snapshot.filesystemIdentity.inode,
        snapshot.filesystemIdentity.ctimeNs, input.parserFormat, input.parserVersion,
        input.normalizationVersion, input.redactionEpoch, now,
      );
      this.db.prepare(`
        UPDATE conversation_sources SET current_version_id = ?, updated_at = ? WHERE id = ?
      `).run(versionId, now, sourceId);
      this.db.prepare(`
        UPDATE conversation_structural_blocks SET status = 'retired', updated_at = ?
         WHERE conversation_id = ? AND status = 'current'
      `).run(now, input.conversationId);

      for (const block of input.blocks) {
        this.db.prepare(`
          INSERT INTO conversation_structural_blocks (
            id, conversation_id, source_version_id, status, provider_key, position,
            type, role, timestamp, parent_block_id, dag_uuid, dag_parent_uuid,
            record_offset, record_length, record_hash, record_ordinal,
            sub_block_ordinal, normalization_checkpoint_id, parser_format,
            parser_version, normalization_version, redaction_epoch, created_at, updated_at
          ) VALUES (?, ?, ?, 'current', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            source_version_id = excluded.source_version_id, status = 'current',
            provider_key = excluded.provider_key, position = excluded.position,
            type = excluded.type, role = excluded.role, timestamp = excluded.timestamp,
            parent_block_id = excluded.parent_block_id, dag_uuid = excluded.dag_uuid,
            dag_parent_uuid = excluded.dag_parent_uuid,
            record_offset = excluded.record_offset, record_length = excluded.record_length,
            record_hash = excluded.record_hash, record_ordinal = excluded.record_ordinal,
            sub_block_ordinal = 0, normalization_checkpoint_id = NULL,
            parser_format = excluded.parser_format, parser_version = excluded.parser_version,
            normalization_version = excluded.normalization_version,
            redaction_epoch = excluded.redaction_epoch, updated_at = excluded.updated_at
        `).run(
          block.id, input.conversationId, versionId,
          `managed:${block.recordHash}`, block.position, block.type, block.role,
          block.timestamp, block.parentId && blockIds.has(block.parentId)
            ? block.parentId
            : block.parentId && /^\d+$/.test(block.parentId)
              ? blockIdsByPosition.get(Number(block.parentId)) ?? null
              : null,
          block.dagUuid, block.dagParentUuid, block.recordOffset, block.recordLength,
          block.recordHash, block.recordOrdinal, input.parserFormat, input.parserVersion,
          input.normalizationVersion, input.redactionEpoch, now, now,
        );
        this.db.prepare(`
          INSERT INTO conversation_block_aliases (alias, block_id, alias_kind, created_at)
          VALUES (?, ?, 'legacy', ?)
          ON CONFLICT(alias) DO UPDATE SET block_id = excluded.block_id
        `).run(block.id, block.id, now);
      }
    })();
    return versionId;
  }

  recordUnavailable(filePath: string, reason = "source file missing"): void {
    const aliasPath = path.resolve(filePath);
    const now = Date.now();
    this.db.transaction(() => {
      const rows = this.db.prepare(
        "SELECT source_id FROM conversation_source_aliases WHERE path = ?",
      ).all(aliasPath) as Array<{ source_id: string }>;
      this.db.prepare(
        "UPDATE conversation_source_aliases SET availability = 'missing', last_seen_at = ? WHERE path = ?",
      ).run(now, aliasPath);
      for (const row of rows) {
        this.db.prepare(`
          UPDATE conversation_sources
             SET availability = 'missing', unavailable_reason = ?, updated_at = ?
           WHERE id = ?
        `).run(reason, now, row.source_id);
        this.db.prepare(`
          UPDATE conversation_source_versions SET availability = 'missing'
           WHERE id = (SELECT current_version_id FROM conversation_sources WHERE id = ?)
        `).run(row.source_id);
      }
    })();
  }

  recordRelocation(fromPath: string, toPath: string, expectedSourceId?: string): void {
    const source = expectedSourceId
      ? this.db.prepare(
        "SELECT id AS source_id FROM conversation_sources WHERE id = ?",
      ).get(expectedSourceId) as { source_id: string } | undefined
      : this.db.prepare(
        "SELECT source_id FROM conversation_source_aliases WHERE path = ?",
      ).get(path.resolve(fromPath)) as { source_id: string } | undefined;
    if (!source) return;
    const descriptor = this.db.prepare(
      "SELECT provider FROM conversation_sources WHERE id = ?",
    ).get(source.source_id) as { provider: ConversationSource } | undefined;
    if (!descriptor) return;
    const root = sourceRoot(descriptor.provider, toPath);
    const resolved = path.resolve(toPath);
    const now = Date.now();
    this.db.transaction(() => {
      const displaced = this.db.prepare(`
        SELECT source_id
          FROM conversation_source_aliases
         WHERE path = ? AND source_id <> ?
      `).get(resolved, source.source_id) as { source_id: string } | undefined;
      if (displaced) {
        const reason = "destination alias transferred during verified relocation";
        this.db.prepare(`
          UPDATE conversation_sources
             SET availability = 'missing', unavailable_reason = ?, updated_at = ?
           WHERE id = ?
        `).run(reason, now, displaced.source_id);
        this.db.prepare(`
          UPDATE conversation_source_versions SET availability = 'missing'
           WHERE id = (SELECT current_version_id FROM conversation_sources WHERE id = ?)
        `).run(displaced.source_id);
      }
      this.db.prepare(
        `UPDATE conversation_source_aliases
            SET availability = 'missing', last_seen_at = ?
          WHERE path = ? AND source_id = ?`,
      ).run(now, path.resolve(fromPath), source.source_id);
      this.db.prepare(`
        INSERT INTO conversation_source_aliases (
          id, source_id, root_kind, root_path, relative_path, path, alias_kind,
          availability, first_seen_at, last_seen_at
        ) VALUES (?, ?, 'provider', ?, ?, ?, ?, 'available', ?, ?)
        ON CONFLICT(path) DO UPDATE SET id = excluded.id,
          source_id = excluded.source_id, root_kind = excluded.root_kind,
          root_path = excluded.root_path, relative_path = excluded.relative_path,
          alias_kind = excluded.alias_kind, availability = 'available',
          first_seen_at = excluded.first_seen_at, last_seen_at = excluded.last_seen_at
      `).run(
        stableId("csa", source.source_id, resolved), source.source_id, root.rootPath,
        root.relativePath, resolved, root.aliasKind, now, now,
      );
      this.db.prepare(`
        UPDATE conversation_sources SET availability = 'available', unavailable_reason = NULL, updated_at = ?
         WHERE id = ?
      `).run(now, source.source_id);
      this.db.prepare(`
        UPDATE conversation_source_versions SET availability = 'available'
         WHERE id = (SELECT current_version_id FROM conversation_sources WHERE id = ?)
      `).run(source.source_id);
    })();
  }
}

export function legacyHashIsImmutableContentHash(value: string): boolean {
  return isSha256(value);
}
