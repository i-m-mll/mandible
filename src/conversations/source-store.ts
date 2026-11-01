import { indexDisplayFragments } from './display-context.js';
import { preparePositionSpace, type PositionSpacePublication } from './position-space.js';
import { openLogicalSource, canonicalSourcePath, type LogicalSourceHandle } from "./logical-source.js";
import { createHash } from "node:crypto";
import path from "node:path";
import type { Db } from "../db.js";
import type { ConversationSource, ConversationBlock } from "../parsers/types.js";
import type {
  ConversationSourceAlias,
  ConversationSourceDescriptor,
  ConversationSourceVersion,
  RecordConversationSourceInput,
  RecordConversationSourceAliasInput,
  UpdateConversationSourceCustodyInput,
} from "./source-types.js";
import {
  ConversationSourceChangedError,
  observeStableSourceAliasRanges,
  numericSourceExtent,
  sameSourceFilesystemIdentity,
  sourceFilesystemIdentity,
  type SourceFilesystemIdentity,
} from "./source-observer.js";
export { ConversationSourceChangedError } from "./source-observer.js";
import { getConversationStructureCache } from "./structure-cache.js";
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

interface NativeBlockRow {
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

export function isConversationSourceChangedError(error: unknown): boolean {
  if (error instanceof ConversationSourceChangedError) return true;
  return error instanceof AggregateError && error.errors.length > 0 && error.errors.every(isConversationSourceChangedError);
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

function sourceDescriptor(row:Record<string,unknown>):ConversationSourceDescriptor {
    return {
      sourceId: String(row.id),
      conversationId: String(row.conversation_id),
      provider: row.provider as ConversationSource,
      nativeSessionId: String(row.native_session_id),
      availability: row.availability as ConversationSourceDescriptor["availability"],
      custodyState: row.custody_state as ConversationSourceDescriptor["custodyState"],
      currentVersionId: row.current_version_id == null ? null : String(row.current_version_id),
      positionSpaceId: row.position_space_id == null ? null : String(row.position_space_id),
      publicationRevision: Number(row.publication_revision),
      unavailableReason: row.unavailable_reason == null ? null : String(row.unavailable_reason),
      parserFormat: String(row.parser_format),
      parserVersion: String(row.parser_version),
      normalizationVersion: String(row.normalization_version),
      redactionEpoch: Number(row.redaction_epoch),
    };
}

function sourceVersion(row:Record<string,unknown>):ConversationSourceVersion {
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

function sourceAlias(row:Record<string,unknown>):ConversationSourceAlias {
  return {
      id: String(row.id),
      sourceId: String(row.source_id),
      rootKind: row.root_kind as ConversationSourceAlias["rootKind"],
      rootPath: String(row.root_path),
      relativePath: String(row.relative_path),
      path: String(row.path),
      aliasKind: row.alias_kind as ConversationSourceAlias["aliasKind"],
      availability: row.availability as ConversationSourceAlias["availability"],
    };
}

export class ConversationSourceStore {
  constructor(private readonly db: Db) {}

  resolveConversation(conversationId:string):ConversationSourceDescriptor|null {
    return this.resolveConversations([conversationId]).get(conversationId)??null;
  }

  resolveConversations(conversationIds:readonly string[]):Map<string,ConversationSourceDescriptor> {
    const result=new Map<string,ConversationSourceDescriptor>();
    if(conversationIds.length===0)return result;
    const rows=this.db.prepare(`SELECT id, conversation_id, provider, native_session_id, availability,
             custody_state, current_version_id, position_space_id, publication_revision, unavailable_reason,
             parser_format, parser_version, normalization_version, redaction_epoch FROM conversation_sources
      WHERE conversation_id IN (SELECT value FROM json_each(?)) ORDER BY conversation_id,updated_at DESC,id
    `).all(JSON.stringify(conversationIds)) as Array<Record<string,unknown>>;
    for(const row of rows){const id=String(row.conversation_id);if(!result.has(id))result.set(id,sourceDescriptor(row));}
    return result;
  }

  /** The source `resolveConversation` would pick, for many conversations in one statement. */
  latestSources(conversationIds:readonly string[]):Map<string,{sourceId:string;currentVersionId:string|null}> {
    return new Map([...this.resolveConversations(conversationIds)].map(([id,source])=>[id,{sourceId:source.sourceId,currentVersionId:source.currentVersionId}]));
  }

  /** Canonical identity, availability and epochs plus the immutable admitted version facts. */
  searchSnapshotAuthorities(conversationIds:readonly string[],pinnedVersions?:ReadonlyMap<string,string>):Map<string,string> {
    const latest=this.latestSources(conversationIds);
    if(latest.size===0)return new Map();
    const sourceFields=["id","provider","native_session_id","availability","parser_format","parser_version","normalization_version","redaction_epoch"];
    const versionFields=["id","source_id","availability","generation","parser_format","parser_version","normalization_version","redaction_epoch","content_sha256","byte_length","filesystem_device","filesystem_inode","filesystem_ctime_ns"];
    const currentFields=["source_id","availability","generation","parser_format","parser_version","normalization_version","redaction_epoch"];
    const selected=[...latest].map(([id,source])=>({source_id:source.sourceId,version_id:pinnedVersions?.get(id)||source.currentVersionId}));
    const columns=[...sourceFields.map(field=>`s.${field} AS source_${field}`),...versionFields.map(field=>`p.${field} AS pinned_${field}`),...currentFields.map(field=>`c.${field} AS current_${field}`)].join(",");
    const rows=this.db.prepare(`SELECT ${columns} FROM json_each(?) pin
      JOIN conversation_sources s ON s.id=json_extract(pin.value,'$.source_id')
      LEFT JOIN conversation_source_versions p ON p.id=json_extract(pin.value,'$.version_id') AND p.source_id=s.id
      LEFT JOIN conversation_source_versions c ON c.id=s.current_version_id AND c.source_id=s.id
    `).all(JSON.stringify(selected)) as Array<Record<string,unknown>&{source_id:string}>;
    const bySource=new Map(rows.map(row=>[row.source_id,createHash("sha256").update(JSON.stringify(row)).digest("hex")]));
    return new Map([...latest].flatMap(([id,source])=>{const authority=bySource.get(source.sourceId);return authority?[[id,authority] as const]:[];}));
  }

  resolveVersion(versionId:string):ConversationSourceVersion|null {
    return this.resolveVersions([versionId]).get(versionId)??null;
  }

  resolveVersions(versionIds:readonly string[]):Map<string,ConversationSourceVersion> {
    if(versionIds.length===0)return new Map();
    const rows=this.db.prepare(`SELECT id, source_id, content_sha256, byte_length, file_mtime_ms,
             filesystem_device, filesystem_inode, filesystem_ctime_ns,
             availability, custody_state, generation, parser_format,
             parser_version, normalization_version, redaction_epoch FROM conversation_source_versions WHERE id IN (SELECT value FROM json_each(?))`).all(JSON.stringify(versionIds)) as Array<Record<string,unknown>>;
    return new Map(rows.map(row=>[String(row.id),sourceVersion(row)]));
  }

  listAliases(sourceId:string):ConversationSourceAlias[] {
    return this.listAliasesForSources([sourceId]).get(sourceId)??[];
  }

  listAliasesForSources(sourceIds:readonly string[]):Map<string,ConversationSourceAlias[]> {
    const result=new Map<string,ConversationSourceAlias[]>();
    if(sourceIds.length===0)return result;
    const rows=this.db.prepare(`SELECT id,source_id,root_kind,root_path,relative_path,path,alias_kind,availability
      FROM conversation_source_aliases WHERE source_id IN (SELECT value FROM json_each(?))
      ORDER BY source_id,CASE availability WHEN 'available' THEN 0 ELSE 1 END,last_seen_at DESC
    `).all(JSON.stringify(sourceIds)) as Array<Record<string,unknown>>;
    for(const row of rows){const alias=sourceAlias(row);const existing=result.get(alias.sourceId);if(existing)existing.push(alias);else result.set(alias.sourceId,[alias]);}
    return result;
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
    const prepared = await this.prepareConversation(input);
    try {
      this.db.transaction(() => prepared.publish()).immediate();
      return prepared.versionId;
    } finally { await prepared.dispose(); }
  }

  /** Prepare source proof and disposable navigation without acquiring the ledger writer. */
  async prepareConversation(input: RecordConversationSourceInput): Promise<{
    versionId: string;
    publish(): void;
    dispose(): Promise<void>;
  }> {
    const existingSource = this.db.prepare(`
      SELECT id, current_version_id, position_space_id, position_count, position_fingerprint, position_fingerprint_version, publication_revision, parser_format, parser_version, normalization_version, redaction_epoch FROM conversation_sources WHERE conversation_id = ? AND provider = ?
    `).get(input.conversationId, input.provider) as (Partial<PositionSpacePublication> & { publication_revision: number; id: string; current_version_id: string | null; parser_format: string; parser_version: string; normalization_version: string; redaction_epoch: number }) | undefined;
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
    const blocks: NativeBlockRow[] = (input.blocks ?? []).map((block) => ({
        conversation_id: input.conversationId,
        type: block.type,
        role: block.role,
        position: block.position,
        timestamp: block.timestamp,
        parent_id: block.parent_id,
        metadata_json: JSON.stringify(block.metadata),
        dag_uuid: block.dag_uuid ?? null,
        dag_parent_uuid: block.dag_parent_uuid ?? null,
      }));
    const structuralMode = input.structuralMode ?? "replace";
    const sameContract = existingSource && existingSource.parser_format === input.parserFormat
      && existingSource.parser_version === input.parserVersion
      && existingSource.normalization_version === input.normalizationVersion
      && existingSource.redaction_epoch === input.redactionEpoch;
    const priorPosition = sameContract && existingSource.position_space_id
      && existingSource.position_count !== undefined && existingSource.position_fingerprint
      && existingSource.position_fingerprint_version !== undefined
      ? existingSource as PositionSpacePublication : null;
    if (structuralMode === 'append' && (!priorPosition || input.sourceSnapshot?.kind !== 'append')) {
      throw new ConversationSourceChangedError('append publication requires a normalized position prefix; rebuild source index');
    }
    const positionSpace = preparePositionSpace(input.blocks, priorPosition,
      structuralMode === 'append' && input.sourceSnapshot?.kind === 'append');
    if (input.blockCount !== undefined && positionSpace.position_count !== input.blockCount) {
      throw new ConversationSourceChangedError('normalized position count does not match publication');
    }
    const structuralBlocks = blocks.flatMap((block) => {
      const metadata = parseJsonObjectStrict(block.metadata_json, "conversation block metadata_json");
      const wholeGeminiSource = input.provider === "gemini" && input.blocks !== undefined;
      const recordOrdinal = wholeGeminiSource ? 0 : numericMetadata(metadata, "source_record_ordinal");
      const range = wholeGeminiSource
        ? { ordinal: 0, offset: 0, length: snapshot.size, hash: snapshot.contentHash }
        : recordOrdinal === null
          ? { ordinal: -1, offset: 0, length: snapshot.size, hash: snapshot.contentHash }
          : snapshot.records[recordOrdinal];
      if (!range) return [];
      const subBlockOrdinal = numericMetadata(metadata, "source_sub_block_ordinal") ?? block.position;
      return [{ block, range, subBlockOrdinal }];
    });
    {
      const cache = getConversationStructureCache(this.db);
      const tools = new Map<string, number>();
      for (const block of input.blocks ?? []) {
        if (block.type === "tool_use" && typeof block.metadata.tool_id === "string") {
          tools.set(block.metadata.tool_id, block.position);
        }
      }
      const priorId = structuralMode === "append" ? existingSource?.current_version_id ?? undefined : undefined;
      const rows = structuralBlocks.map(({ block, range, subBlockOrdinal }) => {
        const metadata = parseJsonObjectStrict(block.metadata_json, "conversation block metadata_json");
        const tool = block.type === "tool_result" && typeof metadata.tool_id === "string" ? metadata.tool_id : null;
        const parent = block.parent_id !== null && /^\d+$/.test(block.parent_id) ? Number(block.parent_id) : null;
        return {
          position: block.position, type: block.type as ConversationBlock["type"], role: block.role as ConversationBlock["role"],
          parentPosition: parent ?? (tool ? tools.get(tool) ?? cache.findToolPosition(input.conversationId, tool, priorId, input) : null),
          recordOffset: range.offset, recordLength: range.length, recordOrdinal: range.ordinal, subBlockOrdinal,
          model: typeof metadata.model === "string" ? metadata.model : null,
          clientIntentId: typeof metadata.client_intent_id === "string" ? metadata.client_intent_id : null,
        };
      });
      const priorCount = priorId ? cache.blockCount(input.conversationId, priorId, input) : 0;
      const displayParents = new Map(rows.map(row => [row.position, row.parentPosition]));
      if (priorId && priorCount === null) throw new ConversationSourceChangedError("append structure generation is missing");
      cache.replaceRows({
        conversation_id: input.conversationId, source_version_id: versionId,
        parser_format: input.parserFormat, parser_version: input.parserVersion,
        normalization_version: input.normalizationVersion, redaction_epoch: input.redactionEpoch,
        block_count: input.blockCount ?? (priorCount ?? 0) + rows.length,
      }, rows, tools, priorId, indexDisplayFragments(input.blocks, input.conversationId,
        position => displayParents.get(position) ?? null));
      cache.prune(input.conversationId, existingSource?.current_version_id ?? null);
    }
    let proof: LogicalSourceHandle | undefined;
    let publicationIdentity = snapshot.filesystemIdentity;
    {
      const verified = await observeStableSourceAliasRanges({
        id: aliasId, sourceId, rootKind: "provider", rootPath: alias.rootPath,
        relativePath: alias.relativePath, path: aliasPath, aliasKind: alias.aliasKind, availability: "available",
      }, [], { prefix: { byteLength: snapshot.size, contentSha256: snapshot.contentHash,
        filesystemIdentity: snapshot.filesystemIdentity } });
      publicationIdentity = verified.filesystemIdentity;
      snapshot.filesystemIdentity = verified.filesystemIdentity;
      snapshot.mtimeMs = verified.fileMtimeMs;
      proof = await openLogicalSource(input.filePath, { rootPath: alias.rootPath });
      try {
        const observed = proof.statSync();
        if (Number(observed.size) < snapshot.size
            || !sameSourceFilesystemIdentity(sourceFilesystemIdentity(observed), publicationIdentity)) {
          throw new ConversationSourceChangedError("conversation source changed after prefix validation");
        }
      } catch (error) { await proof.close(); throw error; }
    }
    const publish = () => {
      if (proof) {
        const observed = proof.statSync();
        if (Number(observed.size) < snapshot.size
            || !sameSourceFilesystemIdentity(sourceFilesystemIdentity(observed), publicationIdentity)) {
          throw new ConversationSourceChangedError("conversation source changed before publication");
        }
      }
      const current = this.db.prepare(`SELECT id, current_version_id, position_space_id, position_count, position_fingerprint, position_fingerprint_version, publication_revision, parser_format, parser_version,
        normalization_version, redaction_epoch FROM conversation_sources WHERE conversation_id = ? AND provider = ?`)
        .get(input.conversationId, input.provider);
      if (JSON.stringify(current) !== JSON.stringify(existingSource)) {
        throw new ConversationSourceChangedError("conversation publication changed after preparation");
      }

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
           SET current_version_id = ?, updated_at = ?, position_space_id = ?, position_count = ?,
               position_fingerprint = ?, position_fingerprint_version = ?, publication_revision = publication_revision + 1
         WHERE id = ?
      `).run(versionId, now, positionSpace.position_space_id, positionSpace.position_count,
        positionSpace.position_fingerprint, positionSpace.position_fingerprint_version, sourceId);

    };
    return { versionId, publish, dispose: async () => { await proof?.close(); } };
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
        // A source that a verified relocation moved elsewhere stays available
        // through its other alias; losing a former path does not lose it.
        const changed = this.db.prepare(`
          UPDATE conversation_sources
             SET availability = 'missing', unavailable_reason = ?, updated_at = ?
           WHERE id = ?
             AND NOT EXISTS (
               SELECT 1 FROM conversation_source_aliases alias
                WHERE alias.source_id = conversation_sources.id AND alias.availability = 'available'
             )
        `).run(reason, now, row.source_id);
        if (changed.changes === 0) continue;
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
