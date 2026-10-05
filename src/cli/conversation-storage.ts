#!/usr/bin/env node
import { parseCommand, stringOption, numberOption, flagOption } from "./grammar.js";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import SqliteDatabase from "../sqlite.js";
import { migrate, type Db } from "../db.js";
import { ConversationSourceStore } from "../conversations/source-store.js";
import { CURRENT_CONVERSATION_SOURCE_EPOCHS } from "../conversations/source-types.js";
import { assignConversationBlockIds } from "../conversation-block-id.js";
import {
  maskAllCandidatesInBlocks,
  redactCredentialLeaksInBlocks,
} from "../credential-leak-scan.js";
import { getAllParsers } from "../parsers/index.js";
import type { ConversationSource } from "../parsers/types.js";

// Deliberately below the multi-gigabyte sources that need the already-bounded
// ingestion path, but large enough to repair the finite legacy cohort observed
// in production without leaving redundant payload behind.
const MAX_PREPARATION_REPARSE_BYTES = 512 * 1024 * 1024;
const CODEX_MODEL_CHECKPOINT = '{"kind":"codex-model-metadata","version":1}';

interface Candidate {
  id: string;
  source: ConversationSource;
  source_path: string;
  source_hash: string;
  session_id: string;
  title: string | null;
  branch: string | null;
}

/** Build one exact filename index per Codex root; final identity is parsed below. */
class CodexSessionSourceIndex {
  private readonly pathsBySession = new Map<string, string[]>();
  private readonly indexedRoots = new Set<string>();

  find(sessionId: string, stalePath: string): string | null {
    // Prefer the root named by the durable (though stale) provider path.
    // A foreign Codex root with the same UUID must not make a local repair
    // ambiguous, but an active/archive duplicate inside one root still does.
    for (const root of this.rootsFor(stalePath)) {
      this.indexRoot(root);
      const matches = (this.pathsBySession.get(sessionId) ?? [])
        .filter((candidate) => candidate === root || candidate.startsWith(`${root}${path.sep}`));
      if (matches.length === 1) return matches[0];
      if (matches.length > 1) return null;
    }
    return null;
  }

  private rootsFor(stalePath: string): string[] {
    const roots: string[] = [];
    const parts = path.resolve(stalePath).split(path.sep);
    const codex = parts.lastIndexOf(".codex");
    if (codex >= 0) roots.push(parts.slice(0, codex + 1).join(path.sep) || path.sep);
    const homeRoot = path.join(os.homedir(), ".codex");
    if (!roots.includes(homeRoot)) roots.push(homeRoot);
    return roots;
  }

  private indexRoot(root: string): void {
    const resolved = path.resolve(root);
    if (this.indexedRoots.has(resolved)) return;
    this.indexedRoots.add(resolved);
    for (const rootName of ["sessions", "archived_sessions"]) {
      const start = path.join(resolved, rootName);
      if (!fs.existsSync(start)) continue;
      const pending = [start];
      while (pending.length > 0) {
        const directory = pending.pop()!;
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
          const entryPath = path.join(directory, entry.name);
          if (entry.isDirectory()) pending.push(entryPath);
          else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
            const match = entry.name.match(/-([0-9a-f]{8}-[0-9a-f-]{27,})\.jsonl$/i);
            if (match) this.pathsBySession.set(match[1], [...(this.pathsBySession.get(match[1]) ?? []), entryPath]);
          }
        }
      }
    }
  }
}

async function markMissingNativeSource(
  store: ConversationSourceStore,
  candidate: Candidate,
  reason = "exact provider source could not be resolved",
): Promise<{ promoted: boolean; blocks: number; filePath: null }> {
  const discarded = store.discardUnavailableConversationPayload({
    conversationId: candidate.id,
    provider: candidate.source,
    nativeSessionId: candidate.session_id,
    reason,
    ...CURRENT_CONVERSATION_SOURCE_EPOCHS,
  });
  return { promoted: discarded.promoted, blocks: discarded.blocks, filePath: null };
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
  const db = new SqliteDatabase(options.dbPath, options.apply ? undefined : { readonly: true, fileMustExist: true }) as Db;
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
    const codexSources = new CodexSessionSourceIndex();
    let promoted = 0;
    let skipped = 0;
    const errors: Array<{ conversation_id: string; error: string }> = [];
    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index];
      const hasLegacyPayload = (db.prepare(`SELECT COUNT(*) AS count FROM conversation_blocks
        WHERE conversation_id = ? AND payload_state = 'legacy'`).get(candidate.id) as { count: number }).count > 0;
      let sourcePath = candidate.source_path;
      if ((!sourcePath || !fs.existsSync(sourcePath)) && candidate.source === "codex") {
        sourcePath = codexSources.find(candidate.session_id, candidate.source_path) ?? sourcePath;
      }
      if (!sourcePath || !fs.existsSync(sourcePath)) {
        try {
          const preserved = await markMissingNativeSource(store, candidate);
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
        const sourceBytes = fs.statSync(sourcePath).size;
        let result;
        if (sourceBytes <= MAX_PREPARATION_REPARSE_BYTES) {
          const parser = getAllParsers().find((entry) => entry.source === candidate.source);
          let parsed = await parser?.parse(sourcePath);
          if (!parsed) {
            if (hasLegacyPayload) {
              const discarded = await markMissingNativeSource(store, candidate, "provider source could not be parsed");
              if (discarded.promoted) promoted += 1;
            } else skipped += 1;
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
          if (candidate.source === "codex" && parsed.conversation.session_id !== candidate.session_id) {
            const resolved = codexSources.find(candidate.session_id, candidate.source_path);
            if (!resolved || resolved === sourcePath) {
              if (hasLegacyPayload) {
                const discarded = await markMissingNativeSource(store, candidate, "exact Codex session source could not be resolved");
                if (discarded.promoted) promoted += 1;
              } else skipped += 1;
              continue;
            }
            sourcePath = resolved;
            parsed = await parser?.parse(sourcePath);
            if (!parsed || parsed.conversation.session_id !== candidate.session_id) {
              if (hasLegacyPayload) {
                const discarded = await markMissingNativeSource(store, candidate, "exact Codex session source could not be parsed");
                if (discarded.promoted) promoted += 1;
              } else skipped += 1;
              continue;
            }
          }
          const existingIds = new Map((db.prepare(`
            SELECT id, position FROM conversation_blocks
             WHERE conversation_id = ? ORDER BY position, id
          `).all(candidate.id) as Array<{ id: string; position: number }>)
            .map((row) => [row.position, row.id]));
          const derivedIds = assignConversationBlockIds(parsed.blocks.map((block) => ({
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
            filePath: sourcePath,
            expectedContentHash: parsed.conversation.source_hash,
            structuralMode: "replace",
            blocks: parsed.blocks.map((block, blockIndex) => ({
              ...block,
              legacyId: existingIds.get(block.position) ?? derivedIds[blockIndex],
            })),
            ...CURRENT_CONVERSATION_SOURCE_EPOCHS,
          });
          result = await store.promoteNativeConversationPayload(candidate.id);
        } else {
          // Large sources are never materialized here. Refresh their sealed
          // identity using existing locators; sources needing a full structural
          // reparse remain as the explicitly reported last copy.
          await store.recordConversation({
            conversationId: candidate.id,
            provider: candidate.source,
            nativeSessionId: candidate.session_id,
            filePath: sourcePath,
            expectedContentHash: candidate.source_hash,
            ...CURRENT_CONVERSATION_SOURCE_EPOCHS,
          });
          result = await store.promoteNativeConversationPayload(candidate.id);
        }
        if (result.promoted) promoted += 1;
        else if (hasLegacyPayload && result.blocks > 0) {
          const discarded = await markMissingNativeSource(
            store, candidate, `native source index is unavailable: ${result.reason ?? "unknown failure"}`,
          );
          if (discarded.promoted) promoted += 1;
        } else skipped += 1;
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
    // Once bodies have been reclaimed, incomplete locator coverage cannot be
    // treated as source-backed exact-read capability. Preserve the ledger
    // conversation row, but make this explicitly unavailable instead of
    // leaving a misleading available source descriptor behind.
    const incomplete = db.prepare(`
      SELECT c.id, c.source, c.source_path, c.source_hash, c.session_id, c.title, c.branch
        FROM conversations c
        LEFT JOIN conversation_sources s
          ON s.conversation_id = c.id AND s.provider = c.source
       WHERE NOT EXISTS (
               SELECT 1 FROM conversation_blocks b
                WHERE b.conversation_id = c.id AND b.payload_state = 'legacy'
             )
         AND EXISTS (
               SELECT 1 FROM conversation_blocks b
                WHERE b.conversation_id = c.id AND b.payload_state = 'source'
             )
         AND (s.id IS NULL OR s.availability = 'available')
         AND EXISTS (
               SELECT 1 FROM conversation_blocks b
                WHERE b.conversation_id = c.id AND b.payload_state = 'source'
                  AND NOT EXISTS (
                    SELECT 1 FROM conversation_structural_blocks sb
                     WHERE sb.conversation_id = c.id AND sb.position = b.position
                       AND sb.status = 'current' AND sb.source_version_id IS NOT NULL
                       AND sb.record_offset IS NOT NULL AND sb.record_length IS NOT NULL
                       AND sb.record_length <= 67108864 AND sb.record_hash IS NOT NULL
                       AND sb.record_ordinal IS NOT NULL AND sb.record_ordinal >= 0
                  )
             )
    `).all() as Candidate[];
    for (const candidate of incomplete) {
      const discarded = await markMissingNativeSource(
        store, candidate, "native source index is unavailable: bounded exact locator coverage is incomplete",
      );
      if (discarded.promoted) promoted += 1;
    }
    // Native JSONL and ledger rows are authoritative. Historical replay
    // checkpoints are parser-cache state, so clear their structural links
    // before deleting them. Retain only the compact current Codex model
    // marker, and only while a structural row still uses it.
    db.exec(`
      UPDATE conversation_structural_blocks
         SET normalization_checkpoint_id = NULL
       WHERE normalization_checkpoint_id IS NOT NULL
         AND normalization_checkpoint_id NOT IN (
           SELECT id FROM conversation_normalization_checkpoints
            WHERE state_json = '${CODEX_MODEL_CHECKPOINT}'
         );
      CREATE TEMP TABLE retained_codex_model_checkpoints (id TEXT PRIMARY KEY);
      INSERT INTO retained_codex_model_checkpoints (id)
        SELECT DISTINCT sb.normalization_checkpoint_id
          FROM conversation_structural_blocks sb
          JOIN conversation_normalization_checkpoints checkpoint
            ON checkpoint.id = sb.normalization_checkpoint_id
         WHERE checkpoint.state_json = '${CODEX_MODEL_CHECKPOINT}';
      DELETE FROM conversation_normalization_checkpoints
       WHERE state_json <> '${CODEX_MODEL_CHECKPOINT}';
      DELETE FROM conversation_normalization_checkpoints
       WHERE state_json = '${CODEX_MODEL_CHECKPOINT}'
         AND id NOT IN (SELECT id FROM retained_codex_model_checkpoints);
      DROP TABLE retained_codex_model_checkpoints;
    `);
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



async function main(argv = process.argv.slice(2)): Promise<void> {
  const parsed = parseCommand(["conversation-storage"], argv);
  const dbPath = stringOption(parsed, "db")!;
  const limit = numberOption(parsed, "limit"), json = flagOption(parsed, "json");
  const result = await prepareSourceBackedConversationStorage({
    dbPath,
    apply: flagOption(parsed, "apply"),
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
