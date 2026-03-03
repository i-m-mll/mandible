// Ingestion service: watches filesystem for conversation files and maintains
// the conversations/conversation_blocks tables in sync.

import chokidar from "chokidar";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { randomUUID } from "node:crypto";
import { getDb } from "./db.js";
import { broadcast } from "./sse.js";
import { compressContent, compressContentAsync } from "./compression.js";
import { getParserForFile } from "./parsers/index.js";
import type { Logger } from "./types.js";
import type { ParseResult } from "./parsers/types.js";

// --- Watch configuration ---

const WATCH_CONFIGS = [
  { base: path.join(os.homedir(), ".claude", "projects"), glob: "**/*.jsonl" },
  { base: path.join(os.homedir(), ".codex", "sessions"), glob: "**/*.jsonl" },
  { base: path.join(os.homedir(), ".gemini", "tmp"), glob: "**/chats/*.json" },
];

const DEBOUNCE_MS = 2000;
const RECONCILE_INTERVAL_MS = 60_000;

// --- State ---

type ChokidarWatcher = ReturnType<typeof chokidar.watch>;
let watchers: ChokidarWatcher[] = [];
let reconcileTimer: ReturnType<typeof setInterval> | null = null;
let logger: Logger = () => {};
const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
const ingestQueue: string[] = [];
const queuedIngestPaths = new Set<string>();
let ingestDrainRunning = false;

// --- Public API ---

export function startIngestion(log: Logger): void {
  logger = log;
  logger("info", "ingestion_starting", {
    watch_paths: WATCH_CONFIGS.map((c) => c.base),
  });

  for (const config of WATCH_CONFIGS) {
    if (!fs.existsSync(config.base)) {
      logger("debug", "ingestion_skip_missing_dir", { path: config.base });
      continue;
    }

    const watchPattern = path.join(config.base, config.glob);
    const watcher = chokidar.watch(watchPattern, {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 1000, pollInterval: 200 },
      ignorePermissionErrors: true,
    });

    watcher.on("add", (filePath: string) => debouncedIngest(filePath));
    watcher.on("change", (filePath: string) => debouncedIngest(filePath));
    watcher.on("error", (error: unknown) => {
      logger("warn", "ingestion_watcher_error", {
        error: error instanceof Error ? error.message : String(error),
        base: config.base,
      });
    });

    watchers.push(watcher);
    logger("info", "ingestion_watcher_started", { pattern: watchPattern });
  }

  // Run initial reconciliation to pick up files that already exist
  scheduleReconcile();

  // Periodic reconciliation
  reconcileTimer = setInterval(() => {
    scheduleReconcile();
  }, RECONCILE_INTERVAL_MS);
  if (typeof reconcileTimer === "object" && "unref" in reconcileTimer) {
    reconcileTimer.unref();
  }
}

export function stopIngestion(): void {
  logger("info", "ingestion_stopping");
  for (const watcher of watchers) {
    void watcher.close();
  }
  watchers = [];

  if (reconcileTimer) {
    clearInterval(reconcileTimer);
    reconcileTimer = null;
  }

  for (const timer of debounceTimers.values()) {
    clearTimeout(timer);
  }
  debounceTimers.clear();
  ingestQueue.length = 0;
  queuedIngestPaths.clear();
  ingestDrainRunning = false;
}

/** Manually trigger re-ingestion of all known sources. */
export async function triggerFullIngest(): Promise<{ processed: number; errors: number }> {
  let processed = 0;
  let errors = 0;

  for (const config of WATCH_CONFIGS) {
    if (!fs.existsSync(config.base)) continue;
    for await (const filePath of walkFiles(config.base, config.glob)) {
      try {
        await ingestFile(filePath);
        processed++;
      } catch (error) {
        errors++;
        logger("warn", "ingestion_manual_error", {
          file: filePath,
          error: String(error),
        });
      }
    }
  }

  return { processed, errors };
}

// --- Internal ---

function debouncedIngest(filePath: string): void {
  const existing = debounceTimers.get(filePath);
  if (existing) clearTimeout(existing);

  const timer = setTimeout(() => {
    debounceTimers.delete(filePath);
    enqueueIngest(filePath);
  }, DEBOUNCE_MS);

  debounceTimers.set(filePath, timer);
}

function enqueueIngest(filePath: string): void {
  if (queuedIngestPaths.has(filePath)) {
    return;
  }
  queuedIngestPaths.add(filePath);
  ingestQueue.push(filePath);
  if (!ingestDrainRunning) {
    void drainIngestQueue();
  }
}

async function drainIngestQueue(): Promise<void> {
  ingestDrainRunning = true;
  while (ingestQueue.length > 0) {
    const filePath = ingestQueue.shift();
    if (!filePath) {
      continue;
    }
    queuedIngestPaths.delete(filePath);
    try {
      await ingestFile(filePath);
    } catch (error) {
      logger("warn", "ingestion_debounced_error", {
        file: filePath,
        error: String(error),
      });
    }
    // Yield between files so burst ingestion doesn't monopolize the event loop.
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  ingestDrainRunning = false;
}

async function ingestFile(filePath: string): Promise<void> {
  const parser = getParserForFile(filePath);
  if (!parser) {
    logger("debug", "ingestion_no_parser", { file: filePath });
    return;
  }

  // Check if file still exists
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(filePath);
  } catch {
    logger("debug", "ingestion_file_gone", { file: filePath });
    return;
  }

  // Check if we already have this version
  const db = getDb();
  const existingRows = db.prepare(`
    SELECT
      c.id,
      c.source_hash,
      c.source_mtime,
      c.block_count,
      COALESCE((
        SELECT COUNT(*) FROM conversation_blocks b WHERE b.conversation_id = c.id
      ), 0) AS actual_count
    FROM conversations c
    WHERE c.source_path = ?
    ORDER BY actual_count DESC, c.updated_at DESC
  `).all(filePath) as Array<{
    id: string;
    source_hash: string;
    source_mtime: number;
    block_count: number;
    actual_count: number;
  }>;
  const existing = existingRows[0];
  if (existingRows.length > 1 && existing) {
    logger("warn", "ingestion_duplicate_conversation_rows", {
      file: filePath,
      rows: existingRows.length,
      chosen_conversation_id: existing.id,
    });
  }

  // Quick mtime check first — if mtime hasn't changed, skip the expensive hash
  if (existing && Math.abs(existing.source_mtime - stat.mtimeMs) < 100) {
    return;
  }

  // Parse the file
  let result: ParseResult | null;
  try {
    result = await parser.parse(filePath);
  } catch (error) {
    logger("warn", "ingestion_parse_error", {
      file: filePath,
      source: parser.source,
      error: String(error),
    });
    return;
  }

  // Skip empty sessions (parser returned null = no meaningful content)
  // Bug: d51fbc8 — empty system sessions were creating "Untitled" entries
  if (!result || result.blocks.length === 0) {
    logger("debug", "ingestion_skip_empty", { file: filePath, source: parser.source });
    // If this file was previously ingested, remove the stale entry
    if (existing) {
      const convId = (db.prepare("SELECT id FROM conversations WHERE source_path = ?").get(filePath) as { id: string } | undefined)?.id;
      if (convId) {
        const isStarred = db.prepare("SELECT starred FROM conversations WHERE id = ?").get(convId) as { starred: number } | undefined;
        if (!isStarred || isStarred.starred === 0) {
          db.prepare("DELETE FROM conversation_blocks WHERE conversation_id = ?").run(convId);
          db.prepare("DELETE FROM conversations WHERE id = ?").run(convId);
          logger("info", "ingestion_removed_empty", { file: filePath, id: convId });
        }
      }
    }
    return;
  }

  // Check hash — if same content, just update mtime
  if (existing && existing.source_hash === result.conversation.source_hash) {
    db.prepare("UPDATE conversations SET source_mtime = ?, updated_at = datetime('now') WHERE source_path = ?")
      .run(stat.mtimeMs, filePath);
    return;
  }

  // Determine if this is new or updated
  const isNew = !existing;
  const conversationId = existing?.id ?? randomUUID();

  // Bug: 212ed66 — hard guard: never insert conversations with 0 blocks
  if (result.blocks.length === 0) {
    logger("warn", "ingestion_zero_block_guard", {
      file: filePath,
      source: result.conversation.source,
      hash: result.conversation.source_hash,
    });
    return;
  }

  // Resolve parent conversation: if this session has a parent session,
  // find the conversation belonging to that parent session.
  // Bug: d0759d1 — sub-agent conversations should be linked to their parent
  let parentConversationId: string | null = null;
  const parentRow = db.prepare(`
    SELECT c.id FROM sessions s
    JOIN conversations c ON c.session_id = s.parent_id
    WHERE s.id = ?
    LIMIT 1
  `).get(result.conversation.session_id) as { id: string } | undefined;
  if (parentRow) {
    parentConversationId = parentRow.id;
  }

  // Bug: 871765b — Delta ingestion: for existing conversations, only insert
  // blocks that haven't been ingested yet. JSONL files are append-only, so if
  // the new parse has at least as many blocks as already in the DB, we can
  // skip re-compressing and re-inserting the already-persisted blocks.
  // Fall back to full re-ingest if block count shrank (truncation/modification).
  let alreadyIngestedCount = 0;
  if (!isNew) {
    const actualCount = existing?.actual_count ?? 0;
    const expectedCount = existing?.block_count ?? 0;
    alreadyIngestedCount = Math.max(actualCount, expectedCount);
    if (actualCount === 0 && expectedCount > 0) {
      logger("warn", "ingestion_count_mismatch", {
        file: filePath,
        conversation_id: conversationId,
        expected_count: expectedCount,
        actual_count: actualCount,
      });
    }
  }

  const isDeltaAppend = !isNew && result.blocks.length >= alreadyIngestedCount && alreadyIngestedCount > 0;
  const newBlocks = isDeltaAppend ? result.blocks.slice(alreadyIngestedCount) : result.blocks;

  if (isDeltaAppend && newBlocks.length === 0) {
    // Hash changed but no new blocks — metadata-only change (title, timestamps, etc.)
    // Update conversation metadata and return.
    db.prepare(`
      UPDATE conversations SET
        source_hash = ?, source_mtime = ?,
        title = ?, summary = ?, ended_at = ?,
        block_count = ?, model = ?, cli_version = ?,
        updated_at = datetime('now')
      WHERE id = ?
    `).run(
      result.conversation.source_hash,
      result.conversation.source_mtime,
      result.conversation.title,
      result.conversation.summary,
      result.conversation.ended_at,
      result.conversation.block_count,
      result.conversation.model,
      result.conversation.cli_version,
      conversationId,
    );
    return;
  }

  // Pre-compress block content async before entering the transaction — gzip is
  // CPU-bound and blocks the event loop if run synchronously inside db.transaction().
  // With active conversations appending blocks every few seconds this was causing
  // all HTTP requests to time out. Compress outside the transaction, pass buffers in.
  const compressedContents = await Promise.all(
    newBlocks.map((block) => compressContentAsync(block.content))
  );

  // Atomic upsert: for full re-ingest, delete old data and re-insert;
  // for delta append, insert only new blocks and update conversation metadata.
  const upsert = db.transaction(() => {
    if (!isDeltaAppend) {
      // Full re-ingest path: delete existing rows and re-insert from scratch
      if (!isNew) {
        const staleConversationIds = db.prepare(
          "SELECT id FROM conversations WHERE source_path = ?"
        ).all(filePath) as Array<{ id: string }>;
        for (const row of staleConversationIds) {
          db.prepare("DELETE FROM conversation_blocks WHERE conversation_id = ?").run(row.id);
          db.prepare("DELETE FROM conversations WHERE id = ?").run(row.id);
        }
      }

      // Insert conversation
      db.prepare(`
        INSERT INTO conversations (
          id, source, source_path, source_hash, source_mtime,
          title, summary, started_at, ended_at, block_count,
          session_id, project_path, cwd, branch, model, cli_version,
          starred, label, notes, parent_conversation_id,
          created_at, updated_at
        ) VALUES (
          ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?, ?,
          0, NULL, NULL, ?,
          datetime('now'), datetime('now')
        )
      `).run(
        conversationId,
        result.conversation.source,
        result.conversation.source_path,
        result.conversation.source_hash,
        result.conversation.source_mtime,
        result.conversation.title,
        result.conversation.summary,
        result.conversation.started_at,
        result.conversation.ended_at,
        result.conversation.block_count,
        result.conversation.session_id,
        result.conversation.project_path,
        result.conversation.cwd,
        result.conversation.branch,
        result.conversation.model,
        result.conversation.cli_version,
        parentConversationId,
      );
    } else {
      // Delta append path: update conversation metadata only, no block deletion
      db.prepare(`
        UPDATE conversations SET
          source_hash = ?, source_mtime = ?,
          title = ?, summary = ?, ended_at = ?,
          block_count = ?, model = ?, cli_version = ?,
          updated_at = datetime('now')
        WHERE id = ?
      `).run(
        result.conversation.source_hash,
        result.conversation.source_mtime,
        result.conversation.title,
        result.conversation.summary,
        result.conversation.ended_at,
        result.conversation.block_count,
        result.conversation.model,
        result.conversation.cli_version,
        conversationId,
      );
    }

    // Insert blocks — content is gzip-compressed as BLOB (Bug: e5a945d)
    // In delta mode, newBlocks contains only the newly appended blocks.
    // compressedContents was pre-computed async above, outside this transaction.
    const insertBlock = db.prepare(`
      INSERT INTO conversation_blocks (
        id, conversation_id, type, role, content, position,
        timestamp, parent_id, metadata_json, compressed
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
    `);

    for (let i = 0; i < newBlocks.length; i++) {
      const block = newBlocks[i];
      // Bug: 7b47c6c — include block.position in hash to prevent collisions.
      // Many blocks share the same type + timestamp + content prefix (e.g. multiple
      // empty tool_result blocks). Without position, the hash is identical for all of
      // them → UNIQUE constraint fails → entire transaction rolls back → file stuck
      // in perpetual re-ingest loop. Position is stable: it's the block's index within
      // the conversation and never changes for already-ingested blocks.
      const blockHash = crypto
        .createHash("sha256")
        .update(conversationId + block.type + (block.timestamp || "") + (block.content || "").slice(0, 100) + String(block.position))
        .digest("hex")
        .slice(0, 16);

      insertBlock.run(
        blockHash,
        conversationId,
        block.type,
        block.role,
        compressedContents[i],
        block.position,
        block.timestamp,
        block.parent_id,
        JSON.stringify(block.metadata),
      );
    }
  });

  try {
    upsert();
  } catch (error) {
    const errStr = String(error);
    // Bug: 7b47c6c — UNIQUE constraint on conversation_blocks.id indicates stale blocks
    // in the DB with the same hash IDs (from a prior ingest cycle where the conversation
    // row was deleted but blocks were not cleaned up due to FK being disabled).
    // Recovery: force-delete all blocks for this conversation, then retry as full re-ingest.
    if (errStr.includes("UNIQUE constraint failed: conversation_blocks.id")) {
      try {
        // Pre-compress all blocks async before the recovery transaction.
        const recoveryCompressedContents = await Promise.all(
          result.blocks.map((block) => compressContentAsync(block.content))
        );
        const recoveryUpsert = db.transaction(() => {
          // Purge all stale rows for this source_path, then do a clean full insert
          const staleIds = db.prepare(
            "SELECT id FROM conversations WHERE source_path = ?"
          ).all(filePath) as Array<{ id: string }>;
          for (const row of staleIds) {
            db.prepare("DELETE FROM conversation_blocks WHERE conversation_id = ?").run(row.id);
            db.prepare("DELETE FROM conversations WHERE id = ?").run(row.id);
          }
          // Also purge any blocks that share IDs with the blocks we're about to insert
          // (orphaned blocks from a prior failed transaction that FK-disabled DB didn't cascade)
          const newIds = result.blocks.map((block) =>
            crypto.createHash("sha256")
              .update(conversationId + block.type + (block.timestamp || "") + (block.content || "").slice(0, 100) + String(block.position))
              .digest("hex").slice(0, 16)
          );
          if (newIds.length > 0) {
            const placeholders = newIds.map(() => "?").join(",");
            db.prepare(`DELETE FROM conversation_blocks WHERE id IN (${placeholders})`).run(...newIds);
          }
          // Re-insert conversation
          db.prepare(`
            INSERT INTO conversations (
              id, source, source_path, source_hash, source_mtime,
              title, summary, started_at, ended_at, block_count,
              session_id, project_path, cwd, branch, model, cli_version,
              starred, label, notes, parent_conversation_id,
              created_at, updated_at
            ) VALUES (
              ?, ?, ?, ?, ?,
              ?, ?, ?, ?, ?,
              ?, ?, ?, ?, ?, ?,
              0, NULL, NULL, ?,
              datetime('now'), datetime('now')
            )
          `).run(
            conversationId,
            result.conversation.source,
            result.conversation.source_path,
            result.conversation.source_hash,
            result.conversation.source_mtime,
            result.conversation.title,
            result.conversation.summary,
            result.conversation.started_at,
            result.conversation.ended_at,
            result.conversation.block_count,
            result.conversation.session_id,
            result.conversation.project_path,
            result.conversation.cwd,
            result.conversation.branch,
            result.conversation.model,
            result.conversation.cli_version,
            parentConversationId,
          );
          // Re-insert all blocks using pre-compressed buffers.
          const insertBlock2 = db.prepare(`
            INSERT INTO conversation_blocks (
              id, conversation_id, type, role, content, position,
              timestamp, parent_id, metadata_json, compressed
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
          `);
          for (let i = 0; i < result.blocks.length; i++) {
            const block = result.blocks[i];
            const blockHash = crypto
              .createHash("sha256")
              .update(conversationId + block.type + (block.timestamp || "") + (block.content || "").slice(0, 100) + String(block.position))
              .digest("hex")
              .slice(0, 16);
            insertBlock2.run(
              blockHash, conversationId, block.type, block.role,
              recoveryCompressedContents[i], block.position,
              block.timestamp, block.parent_id, JSON.stringify(block.metadata),
            );
          }
        });
        recoveryUpsert();
        logger("info", "ingestion_unique_recovery_succeeded", {
          file: filePath,
          blocks: result.blocks.length,
        });
      } catch (recoveryError) {
        logger("warn", "ingestion_db_error", {
          file: filePath,
          error: errStr,
          recovery_error: String(recoveryError),
        });
        return;
      }
    } else {
      logger("warn", "ingestion_db_error", {
        file: filePath,
        error: errStr,
      });
      return;
    }
  }

  // Bug: e01653d — update last_active on the matching session so the
  // Sessions tab shows real user activity time rather than updated_at.
  // The JSONL mtime is a reliable proxy for "last message written".
  if (result.conversation.session_id) {
    const activeAt = new Date(stat.mtimeMs).toISOString();
    db.prepare(
      `UPDATE sessions SET last_active = ?
       WHERE id = ? AND (last_active IS NULL OR last_active < ?)`
    ).run(activeAt, result.conversation.session_id, activeAt);
  }

  // Broadcast SSE event
  const eventType = isNew ? "conversation:new" : "conversation:updated";
  broadcast(eventType, {
    id: conversationId,
    source: result.conversation.source,
    title: result.conversation.title,
    block_count: result.conversation.block_count,
  });

  logger("info", "ingestion_complete", {
    file: filePath,
    source: result.conversation.source,
    blocks: newBlocks.length,
    total_blocks: result.conversation.block_count,
    delta: isDeltaAppend,
    event: eventType,
  });
}

let reconciling = false;

function scheduleReconcile(): void {
  if (reconciling) return;
  reconciling = true;
  void reconcile().finally(() => {
    reconciling = false;
  });
}

async function reconcile(): Promise<void> {
  const db = getDb();

  // Clean up existing 0-block conversations (except starred ones).
  // Bug: d51fbc8 — empty sessions should not pollute the list
  // Bug: 212ed66 — also catch conversations where block_count column is wrong
  const cleaned = db.prepare(
    `DELETE FROM conversations WHERE starred = 0 AND (
      block_count = 0
      OR id NOT IN (SELECT DISTINCT conversation_id FROM conversation_blocks)
    )`
  ).run();
  if (cleaned.changes > 0) {
    logger("info", "ingestion_cleanup_empty", { removed: cleaned.changes });
  }

  const knownPaths = new Set<string>();

  // Get all known source_paths from DB
  const rows = db
    .prepare("SELECT source_path, source_mtime FROM conversations")
    .all() as Array<{ source_path: string; source_mtime: number }>;
  const dbPaths = new Map<string, number>();
  for (const row of rows) {
    dbPaths.set(row.source_path, row.source_mtime);
  }

  // Scan filesystem using async generator — yields to the event loop every 50
  // directory entries so the HTTP server stays responsive during startup scans.
  // Bug: 737df04 — findFiles() used readdirSync recursively, blocking the event
  // loop for the entire scan before any yielding could occur.
  for (const config of WATCH_CONFIGS) {
    if (!fs.existsSync(config.base)) continue;
    for await (const filePath of walkFiles(config.base, config.glob)) {
      knownPaths.add(filePath);

      // Check if file needs ingestion
      try {
        const stat = await fs.promises.stat(filePath);
        const dbMtime = dbPaths.get(filePath);

        if (dbMtime === undefined || Math.abs(dbMtime - stat.mtimeMs) >= 100) {
          // New or modified file — queue for ingestion
          debouncedIngest(filePath);
        }
      } catch {
        // File inaccessible — skip
      }
    }
  }
}

/** Walk files matching a glob pattern using an async generator.
 *  Yields event-loop turns every 50 directory entries so the HTTP server
 *  stays responsive during large scans (Bug: 737df04). */
async function* walkFiles(baseDir: string, glob: string): AsyncGenerator<string> {
  const pattern = globToMatcher(glob);
  let entryCount = 0;

  async function* walkDir(dir: string): AsyncGenerator<string> {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      entryCount++;
      if (entryCount % 50 === 0) {
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      if (entry.isDirectory()) {
        yield* walkDir(fullPath);
      } else if (entry.isFile()) {
        const relative = path.relative(baseDir, fullPath);
        if (pattern(relative)) {
          yield fullPath;
        }
      }
    }
  }

  yield* walkDir(baseDir);
}

/** Convert a simple glob pattern to a matcher function.
 *  Supports: ** (any path), * (any segment chars), literal chars. */
function globToMatcher(glob: string): (filePath: string) => boolean {
  // Convert glob to regex
  const parts = glob.split("/");
  let regexStr = "^";
  for (let i = 0; i < parts.length; i++) {
    if (i > 0) regexStr += "/";
    const part = parts[i];
    if (part === "**") {
      regexStr += ".*";
    } else {
      // Escape regex special chars, convert * to [^/]*
      regexStr += part
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, "[^/]*");
    }
  }
  regexStr += "$";
  const regex = new RegExp(regexStr);
  return (filePath: string) => regex.test(filePath);
}
