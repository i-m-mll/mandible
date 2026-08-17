import { createHash } from "node:crypto";
import * as fs from "node:fs";
import path from "node:path";
import type { Db } from "../db.js";
import type { ConversationSource } from "../parsers/types.js";
import type {
  ConversationSourceAlias,
  ConversationSourceDescriptor,
  ConversationSourceVersion,
  RecordConversationSourceInput,
  RecordConversationSourceAliasInput,
  RecordNormalizationCheckpointInput,
  UpdateConversationSourceCustodyInput,
} from "./source-types.js";

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
  const normalized = path.resolve(filePath);
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

async function snapshotJsonl(filePath: string): Promise<SourceSnapshot> {
  const before = await fs.promises.stat(filePath);
  if (!before.isFile()) throw new Error("conversation source is not a regular file");

  const contentHash = createHash("sha256");
  const records: RecordRange[] = [];
  let carry: Buffer = Buffer.alloc(0);
  let carryOffset = 0;
  let total = 0;

  for await (const rawChunk of fs.createReadStream(filePath)) {
    const chunk = rawChunk as Buffer;
    contentHash.update(chunk);
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
  if (carry.toString("utf8").trim()) {
    records.push({
      ordinal: records.length,
      offset: carryOffset,
      length: carry.length,
      hash: createHash("sha256").update(carry).digest("hex"),
    });
  }

  const after = await fs.promises.stat(filePath);
  if (
    before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
    || before.mtimeMs !== after.mtimeMs
  ) {
    throw new Error("conversation source changed while being indexed");
  }
  return {
    contentHash: contentHash.digest("hex"),
    size: after.size,
    mtimeMs: after.mtimeMs,
    records,
  };
}

function parseMetadata(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function numericMetadata(metadata: Record<string, unknown>, key: string): number | null {
  const value = metadata[key];
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function providerBlockKey(block: LegacyBlockRow, metadata: Record<string, unknown>, range: RecordRange): string {
  const sub = numericMetadata(metadata, "source_sub_block_ordinal") ?? 0;
  if (block.dag_uuid) return `dag:${block.dag_uuid}:${block.type}:${sub}`;
  const toolId = typeof metadata.tool_id === "string" ? metadata.tool_id : "";
  if (toolId) return `tool:${toolId}:${block.type}:${sub}`;
  return `record:${range.hash}:${block.type}:${sub}`;
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

  resolveVersion(versionId: string): ConversationSourceVersion | null {
    const row = this.db.prepare(`
      SELECT id, source_id, content_sha256, byte_length, file_mtime_ms,
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

  resolveLegacyBlockId(alias: string): string | null {
    const row = this.db.prepare(
      "SELECT block_id FROM conversation_block_aliases WHERE alias = ?",
    ).get(alias) as { block_id: string } | undefined;
    return row?.block_id ?? null;
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
    const snapshot = await snapshotJsonl(input.filePath);
    if (input.expectedContentHash && isSha256(input.expectedContentHash)
      && input.expectedContentHash !== snapshot.contentHash) {
      throw new Error("conversation source changed after parser snapshot");
    }
    const existingSource = this.db.prepare(`
      SELECT id FROM conversation_sources WHERE conversation_id = ? AND provider = ?
    `).get(input.conversationId, input.provider) as { id: string } | undefined;
    const sourceId = existingSource?.id ?? stableId("csrc", input.conversationId, input.provider);
    const versionId = stableId("cver", sourceId, snapshot.contentHash);
    const alias = sourceRoot(input.provider, input.filePath);
    const aliasPath = path.resolve(input.filePath);
    const aliasId = stableId("csa", sourceId, aliasPath);
    const now = Date.now();
    const blocks = this.db.prepare(`
      SELECT id, conversation_id, type, role, position, timestamp, parent_id,
             metadata_json, dag_uuid, dag_parent_uuid
        FROM conversation_blocks
       WHERE conversation_id = ?
       ORDER BY position
    `).all(input.conversationId) as LegacyBlockRow[];

    const apply = this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO conversation_sources (
          id, conversation_id, provider, native_session_id, parser_format, parser_version,
          normalization_version, redaction_epoch, availability, custody_state,
          current_version_id, unavailable_reason, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'available', 'provider', ?, NULL, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          native_session_id = excluded.native_session_id,
          parser_format = excluded.parser_format,
          parser_version = excluded.parser_version,
          normalization_version = excluded.normalization_version,
          redaction_epoch = excluded.redaction_epoch,
          availability = 'available',
          current_version_id = excluded.current_version_id,
          unavailable_reason = NULL,
          updated_at = excluded.updated_at
      `).run(
        sourceId, input.conversationId, input.provider, input.nativeSessionId,
        input.parserFormat, input.parserVersion, input.normalizationVersion, input.redactionEpoch,
        versionId, now, now,
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
          id, source_id, content_sha256, byte_length, file_mtime_ms, generation,
          parser_format, parser_version, normalization_version, redaction_epoch,
          availability, custody_state, created_at
        ) VALUES (?, ?, ?, ?, ?, 'sealed_sha256', ?, ?, ?, ?, 'available', 'provider', ?)
        ON CONFLICT(source_id, content_sha256) DO UPDATE SET
          file_mtime_ms = excluded.file_mtime_ms,
          availability = 'available'
      `).run(
        versionId, sourceId, snapshot.contentHash, snapshot.size, snapshot.mtimeMs,
        input.parserFormat, input.parserVersion, input.normalizationVersion,
        input.redactionEpoch, now,
      );

      this.db.prepare(
        "UPDATE conversation_structural_blocks SET status = 'retired', updated_at = ? WHERE conversation_id = ? AND status = 'current'",
      ).run(now, input.conversationId);

      const positionToId = new Map<number, string>();
      const pendingParents: Array<{ blockId: string; parentPosition: number | null }> = [];
      const providerKeyOccurrences = new Map<string, number>();
      for (const block of blocks) {
        const metadata = parseMetadata(block.metadata_json);
        const recordOrdinal = numericMetadata(metadata, "source_record_ordinal");
        const range = recordOrdinal === null
          ? { ordinal: -1, offset: 0, length: snapshot.size, hash: snapshot.contentHash }
          : snapshot.records[recordOrdinal];
        if (!range) continue;
        const subBlockOrdinal = numericMetadata(metadata, "source_sub_block_ordinal") ?? block.position;
        const checkpointId = stableId(
          "ccp", versionId, String(range.ordinal), input.parserVersion,
          input.normalizationVersion, String(input.redactionEpoch),
        );
        this.db.prepare(`
          INSERT OR IGNORE INTO conversation_normalization_checkpoints (
            id, source_version_id, record_ordinal, prefix_offset, parser_format,
            parser_version, normalization_version, redaction_epoch, state_json, created_at
          ) VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, ?)
        `).run(
          checkpointId, versionId, range.ordinal, input.parserFormat, input.parserVersion,
          input.normalizationVersion, input.redactionEpoch,
          JSON.stringify({ strategy: "replay-prefix", through_record: range.ordinal }), now,
        );

        const providerKeyBase = providerBlockKey(block, metadata, range);
        const providerKeyOccurrence = providerKeyOccurrences.get(providerKeyBase) ?? 0;
        providerKeyOccurrences.set(providerKeyBase, providerKeyOccurrence + 1);
        const providerKey = providerKeyOccurrence === 0
          ? providerKeyBase
          : `${providerKeyBase}:occurrence:${providerKeyOccurrence}`;
        const aliasRow = this.db.prepare(
          "SELECT block_id FROM conversation_block_aliases WHERE alias = ?",
        ).get(block.id) as { block_id: string } | undefined;
        const keyRow = this.db.prepare(`
          SELECT id FROM conversation_structural_blocks
           WHERE conversation_id = ? AND provider_key = ?
           ORDER BY created_at LIMIT 1
        `).get(input.conversationId, providerKey) as { id: string } | undefined;
        const blockId = aliasRow?.block_id ?? keyRow?.id
          ?? stableId("cblk", input.conversationId, providerKey);
        positionToId.set(block.position, blockId);
        const parentPosition = block.parent_id !== null && /^\d+$/.test(block.parent_id)
          ? Number(block.parent_id)
          : null;
        pendingParents.push({ blockId, parentPosition });

        this.db.prepare(`
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
        `).run(
          blockId, input.conversationId, versionId, providerKey, block.position,
          block.type, block.role, block.timestamp, block.dag_uuid, block.dag_parent_uuid,
          range.offset, range.length, range.hash, range.ordinal, subBlockOrdinal,
          checkpointId, input.parserFormat, input.parserVersion,
          input.normalizationVersion, input.redactionEpoch, now, now,
        );
        this.db.prepare(`
          INSERT INTO conversation_block_aliases (alias, block_id, alias_kind, created_at)
          VALUES (?, ?, 'legacy', ?)
          ON CONFLICT(alias) DO UPDATE SET block_id = excluded.block_id
        `).run(block.id, blockId, now);
      }
      for (const pending of pendingParents) {
        this.db.prepare(
          "UPDATE conversation_structural_blocks SET parent_block_id = ? WHERE id = ?",
        ).run(
          pending.parentPosition === null ? null : positionToId.get(pending.parentPosition) ?? null,
          pending.blockId,
        );
      }
    });
    apply();
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
