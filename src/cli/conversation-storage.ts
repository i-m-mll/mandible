#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import Database from "better-sqlite3";
import { decompressContent } from "../compression.js";
import { migrate, type Db } from "../db.js";
import { ConversationSourceStore } from "../conversations/source-store.js";
import { CURRENT_CONVERSATION_SOURCE_EPOCHS } from "../conversations/source-types.js";
import { assignConversationBlockIds } from "../conversation-block-id.js";
import {
  maskAllCandidatesInBlocks,
  redactCredentialLeaksInBlocks,
} from "../credential-leak-scan.js";
import { getAllParsers } from "../parsers/index.js";
import type { BlockType, ConversationBlock, ConversationSource, Role } from "../parsers/types.js";
import { getMandibleHomePath } from "../platform-paths.js";
import {
  MANAGED_NORMALIZED_SOURCE_EPOCHS,
  serializeManagedNormalizedRecords,
  writeManagedNormalizedSource,
  type ManagedNormalizedBlockRecord,
} from "../conversations/managed-normalized-source.js";

// Deliberately below the multi-gigabyte sources that need the already-bounded
// ingestion path, but large enough to repair the finite legacy cohort observed
// in production without leaving redundant payload behind.
const MAX_PREPARATION_REPARSE_BYTES = 512 * 1024 * 1024;

interface Candidate {
  id: string;
  source: ConversationSource;
  source_path: string;
  source_hash: string;
  session_id: string;
  title: string | null;
  branch: string | null;
}

interface LegacyCustodyRow {
  id: string;
  conversation_id: string;
  type: BlockType;
  role: Role;
  content: Buffer | string;
  compressed: number;
  position: number;
  timestamp: string | null;
  parent_id: string | null;
  metadata_json: string;
  dag_uuid: string | null;
  dag_parent_uuid: string | null;
}

interface CompatibilityPreflightRow extends LegacyCustodyRow {
  payload_state: "legacy" | "source";
}

function metadataMatches(raw: string, metadata: unknown): boolean {
  try {
    return isDeepStrictEqual(JSON.parse(raw), JSON.parse(JSON.stringify(metadata)));
  } catch {
    return false;
  }
}

function preflightReplacementProjection(
  db: Db,
  conversationId: string,
  blocks: readonly Omit<ConversationBlock, "id" | "conversation_id">[],
): boolean {
  const rows = db.prepare(`
    SELECT id, conversation_id, type, role, content, compressed, position,
           timestamp, parent_id, metadata_json, dag_uuid, dag_parent_uuid,
           payload_state
      FROM conversation_blocks
     WHERE conversation_id = ?
     ORDER BY position, id
  `).all(conversationId) as CompatibilityPreflightRow[];
  if (rows.length !== blocks.length) return false;
  const rowsByPosition = new Map(rows.map((row) => [row.position, row]));
  if (rowsByPosition.size !== rows.length) return false;

  for (const block of blocks) {
    const row = rowsByPosition.get(block.position);
    if (!row || row.type !== block.type || row.role !== block.role
        || row.timestamp !== block.timestamp
        || row.dag_uuid !== (block.dag_uuid ?? null)
        || row.dag_parent_uuid !== (block.dag_parent_uuid ?? null)) return false;
    const parentAtPosition = block.parent_id !== null && /^\d+$/.test(block.parent_id)
      ? rowsByPosition.get(Number(block.parent_id))?.id ?? null
      : null;
    if (row.parent_id !== block.parent_id && row.parent_id !== parentAtPosition) return false;
    if (row.payload_state === "source") {
      if (row.content.length !== 0 || row.metadata_json !== "{}" || row.compressed !== 0) return false;
      continue;
    }
    if (decompressContent(row.content, row.compressed === 1) !== block.content
        || !metadataMatches(row.metadata_json, block.metadata)) return false;
  }
  return true;
}

async function preserveMissingSource(
  db: Db,
  store: ConversationSourceStore,
  candidate: Candidate,
  custodyRoot: string,
): Promise<{ promoted: boolean; blocks: number; filePath: string }> {
  const rows = db.prepare(`
    SELECT id, conversation_id, type, role, content, compressed, position,
           timestamp, parent_id, metadata_json, dag_uuid, dag_parent_uuid
      FROM conversation_blocks
     WHERE conversation_id = ? AND payload_state = 'legacy'
     ORDER BY position
  `).all(candidate.id) as LegacyCustodyRow[];
  if (rows.length === 0) throw new Error("missing source conversation has no legacy payload to preserve");

  // Managed custody is the sole exact source for this cohort. Preserve the
  // decompressed legacy body and metadata string byte-for-byte; masking belongs
  // to the ordinary reader/search/export presentation boundary.
  const records: ManagedNormalizedBlockRecord[] = rows.map((row) => ({
    format: "mandible-normalized-block/1",
    id: row.id,
    conversation_id: candidate.id,
    type: row.type,
    role: row.role,
    content: decompressContent(row.content, row.compressed === 1),
    position: row.position,
    timestamp: row.timestamp,
    parent_id: row.parent_id,
    metadata_json: row.metadata_json,
    dag_uuid: row.dag_uuid,
    dag_parent_uuid: row.dag_parent_uuid,
  }));
  const serialized = serializeManagedNormalizedRecords(records);
  const materialized = writeManagedNormalizedSource({
    rootPath: custodyRoot,
    conversationId: candidate.id,
    bytes: serialized.bytes,
    contentHash: serialized.contentHash,
  });
  await store.recordManagedNormalizedSource({
    conversationId: candidate.id,
    provider: candidate.source,
    nativeSessionId: candidate.session_id,
    rootPath: materialized.rootPath,
    filePath: materialized.filePath,
    expectedContentHash: serialized.contentHash,
    blocks: records.map((block, index) => ({
      id: block.id,
      type: block.type,
      role: block.role,
      position: block.position,
      timestamp: block.timestamp,
      parentId: block.parent_id,
      dagUuid: block.dag_uuid,
      dagParentUuid: block.dag_parent_uuid,
      recordOffset: serialized.ranges[index].offset,
      recordLength: serialized.ranges[index].length,
      recordHash: serialized.ranges[index].hash,
      recordOrdinal: serialized.ranges[index].ordinal,
    })),
    ...MANAGED_NORMALIZED_SOURCE_EPOCHS,
  });
  const verified = await store.verifyAndPromoteConversationPayload(candidate.id, records);
  if (!verified.promoted) throw new Error(verified.reason ?? "managed custody verification failed");
  return { promoted: true, blocks: rows.length, filePath: materialized.filePath };
}

function summary(db: Db) {
  const hasPayloadState = (db.pragma("table_info(conversation_blocks)") as Array<{ name: string }>)
    .some((column) => column.name === "payload_state");
  if (!hasPayloadState) {
    const legacy = db.prepare(`
      SELECT COUNT(DISTINCT conversation_id) AS conversations,
             COUNT(*) AS blocks,
             COALESCE(SUM(length(content) + length(metadata_json)), 0) AS payload_bytes
        FROM conversation_blocks
    `).get() as { conversations: number; blocks: number; payload_bytes: number };
    const checkpoints = db.prepare(
      "SELECT COUNT(*) AS rows FROM conversation_normalization_checkpoints",
    ).get();
    return {
      payload: [{ payload_state: "legacy", blocks: legacy.blocks, payload_bytes: legacy.payload_bytes }],
      remaining_legacy: legacy,
      normalization_checkpoints: checkpoints,
    };
  }
  const payload = db.prepare(`
    SELECT payload_state,
           COUNT(*) AS blocks,
           COALESCE(SUM(length(content) + length(metadata_json)), 0) AS payload_bytes
      FROM conversation_blocks
     GROUP BY payload_state
     ORDER BY payload_state
  `).all();
  const remaining = db.prepare(`
    SELECT COUNT(DISTINCT c.id) AS conversations,
           COUNT(b.id) AS blocks,
           COALESCE(SUM(length(b.content) + length(b.metadata_json)), 0) AS payload_bytes
      FROM conversations c
      JOIN conversation_blocks b ON b.conversation_id = c.id AND b.payload_state = 'legacy'
  `).get();
  const checkpoints = db.prepare(
    "SELECT COUNT(*) AS rows FROM conversation_normalization_checkpoints",
  ).get();
  return { payload, remaining_legacy: remaining, normalization_checkpoints: checkpoints };
}

export async function prepareSourceBackedConversationStorage(options: {
  dbPath: string;
  apply?: boolean;
  limit?: number;
  managedCustodyRoot?: string;
  onProgress?: (message: string) => void;
}) {
  const db = new Database(options.dbPath, options.apply ? undefined : { readonly: true, fileMustExist: true }) as Db;
  try {
    db.pragma("foreign_keys = ON");
    db.pragma("busy_timeout = 5000");
    if (options.apply) migrate(db);
    const before = summary(db);
    if (!options.apply) return { apply: false, before, processed: 0, promoted: 0, skipped: 0, errors: [] };

    const limit = Math.max(1, Math.min(options.limit ?? Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER));
    const candidates = db.prepare(`
      SELECT c.id, c.source, c.source_path, c.source_hash, c.session_id,
             c.title, c.branch
        FROM conversations c
       WHERE EXISTS (
         SELECT 1 FROM conversation_blocks b
          WHERE b.conversation_id = c.id AND b.payload_state = 'legacy'
       )
          OR (c.source = 'gemini' AND EXISTS (
            SELECT 1 FROM conversation_blocks b
             WHERE b.conversation_id = c.id AND b.payload_state = 'source'
          ))
       ORDER BY c.updated_at DESC, c.id
       LIMIT ?
    `).all(limit) as Candidate[];
    const store = new ConversationSourceStore(db);
    const managedCustodyRoot = path.resolve(
      options.managedCustodyRoot ?? getMandibleHomePath("conversation-sources"),
    );
    let promoted = 0;
    let skipped = 0;
    const errors: Array<{ conversation_id: string; error: string }> = [];
    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index];
      if (!candidate.source_path || !fs.existsSync(candidate.source_path)) {
        try {
          const preserved = await preserveMissingSource(db, store, candidate, managedCustodyRoot);
          if (preserved.promoted) promoted += 1;
        } catch (error) {
          errors.push({
            conversation_id: candidate.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        continue;
      }
      try {
        // Most recent conversations already have an exact sealed source and
        // bounded structural locators. Promote those in-place without hashing
        // a potentially multi-gigabyte provider file again.
        const existing = await store.verifyAndPromoteConversationPayload(candidate.id);
        if (existing.promoted) {
          promoted += 1;
          if ((index + 1) % 100 === 0 || index + 1 === candidates.length) {
            options.onProgress?.(`processed ${index + 1}/${candidates.length}; promoted ${promoted}; errors ${errors.length}`);
          }
          continue;
        }
        const sourceBytes = fs.statSync(candidate.source_path).size;
        let result;
        if (sourceBytes <= MAX_PREPARATION_REPARSE_BYTES) {
          const parser = getAllParsers().find((entry) => entry.source === candidate.source);
          const parsed = await parser?.parse(candidate.source_path);
          if (!parsed) {
            skipped += 1;
            continue;
          }
          try {
            redactCredentialLeaksInBlocks(db, parsed.blocks, {
              conversation_id: candidate.id,
              conversation_title: candidate.title,
              session_id: candidate.session_id,
              source: candidate.source,
              branch: candidate.branch,
            });
          } catch {
            maskAllCandidatesInBlocks(parsed.blocks);
          }
          if (!preflightReplacementProjection(db, candidate.id, parsed.blocks)) {
            skipped += 1;
            continue;
          }
          const legacyIds = assignConversationBlockIds(parsed.blocks.map((block) => ({
            conversation_id: candidate.id,
            type: block.type,
            timestamp: block.timestamp,
            content: block.content,
            position: block.position,
          })));
          await store.recordConversation({
            conversationId: candidate.id,
            provider: candidate.source,
            nativeSessionId: parsed.conversation.session_id,
            filePath: candidate.source_path,
            expectedContentHash: parsed.conversation.source_hash,
            structuralMode: "replace",
            blocks: parsed.blocks.map((block, blockIndex) => ({
              ...block,
              legacyId: legacyIds[blockIndex],
            })),
            ...CURRENT_CONVERSATION_SOURCE_EPOCHS,
          });
          result = await store.verifyAndPromoteConversationPayload(candidate.id);
        } else {
          // Large sources are never materialized here. Refresh their sealed
          // identity using existing locators; sources needing a full structural
          // reparse remain as the explicitly reported last copy.
          await store.recordConversation({
            conversationId: candidate.id,
            provider: candidate.source,
            nativeSessionId: candidate.session_id,
            filePath: candidate.source_path,
            expectedContentHash: candidate.source_hash,
            ...CURRENT_CONVERSATION_SOURCE_EPOCHS,
          });
          result = await store.verifyAndPromoteConversationPayload(candidate.id);
        }
        if (result.promoted) promoted += 1;
        else skipped += 1;
      } catch (error) {
        errors.push({
          conversation_id: candidate.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      if ((index + 1) % 100 === 0 || index + 1 === candidates.length) {
        options.onProgress?.(`processed ${index + 1}/${candidates.length}; promoted ${promoted}; errors ${errors.length}`);
      }
    }
    return {
      apply: true,
      before,
      after: summary(db),
      processed: candidates.length,
      promoted,
      skipped,
      errors,
    };
  } finally {
    db.close();
  }
}

function valueAfter(argv: string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

async function main(argv = process.argv.slice(2)): Promise<void> {
  if (argv[0] !== "prepare") {
    throw new Error("Usage: conversation-storage prepare --db PATH [--apply] [--limit N] [--json]");
  }
  const dbPath = valueAfter(argv, "--db");
  if (!dbPath) throw new Error("--db is required");
  const rawLimit = valueAfter(argv, "--limit");
  const limit = rawLimit === undefined ? undefined : Number(rawLimit);
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 1)) {
    throw new Error("--limit must be a positive integer");
  }
  const json = argv.includes("--json");
  const result = await prepareSourceBackedConversationStorage({
    dbPath,
    apply: argv.includes("--apply"),
    limit,
    onProgress: json ? undefined : (message) => process.stderr.write(`${message}\n`),
  });
  process.stdout.write(`${JSON.stringify(result, null, json ? 2 : 0)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`conversation storage preparation failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
