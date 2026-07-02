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
import { getCodexSessionIndexPath, loadCodexSessionIndexTitle } from "./parsers/codex.js";
import { parseClaudeSubagentPath } from "./parsers/claude.js";
import { inferGeminiProjectIdentity } from "./parsers/gemini.js";
import { clearHookNotificationAttention } from "./claude-hook-attention.js";
import {
  ingestClaudeWorkflowArtifact,
  isClaudeWorkflowJournalPath,
  isClaudeWorkflowSummaryPath,
  isClaudeWorkflowTranscriptPath,
} from "./workflows.js";
import type { Logger } from "./types.js";
import type { ConversationBlock, ParseResult } from "./parsers/types.js";

// --- Watch configuration ---

const WATCH_CONFIGS = [
  { base: path.join(os.homedir(), ".claude", "projects"), glob: "**/*.jsonl" },
  { base: path.join(os.homedir(), ".claude", "projects"), glob: "**/workflows/wf_*.json" },
  { base: path.join(os.homedir(), ".codex", "sessions"), glob: "**/*.jsonl" },
  { base: path.join(os.homedir(), ".gemini", "tmp"), glob: "**/chats/*.json" },
  { base: path.join(os.homedir(), ".gemini", "tmp"), glob: "**/chats/*.jsonl" },
];

const DEBOUNCE_MS = 200;
const RECONCILE_INTERVAL_MS = 60_000;
const INGEST_TAIL_HASH_BYTES = 4096;

// --- State ---

type ChokidarWatcher = ReturnType<typeof chokidar.watch>;
let watchers: ChokidarWatcher[] = [];
let reconcileTimer: ReturnType<typeof setInterval> | null = null;
let logger: Logger = () => {};
let ingestionActive = false;
let ingestionRunToken = 0;
const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

function resolveParentConversationId(
  db: ReturnType<typeof getDb>,
  sessionId: string,
  filePath: string,
  currentConversationId?: string,
): string | null {
  const subagentPath = parseClaudeSubagentPath(filePath);
  if (subagentPath) {
    const row = db.prepare(`
      SELECT id
      FROM conversations
      WHERE source = 'claude_code'
        AND session_id = ?
        AND id != ?
        AND LOWER(source_path) NOT LIKE '%/subagents/%'
      ORDER BY started_at ASC, created_at ASC
      LIMIT 1
    `).get(subagentPath.parentSessionId, currentConversationId ?? "") as { id: string } | undefined;
    if (row) {
      return row.id;
    }
  }

  const parentRow = db.prepare(`
    SELECT c.id FROM sessions s
    JOIN conversations c ON c.session_id = s.parent_id
    WHERE s.id = ?
    LIMIT 1
  `).get(sessionId) as { id: string } | undefined;
  return parentRow?.id ?? null;
}

function linkExistingClaudeSubagents(db: ReturnType<typeof getDb>, parentSessionId: string, parentConversationId: string): void {
  const parentPattern = `%/${parentSessionId}/subagents/agent-%.jsonl`;
  const workflowPattern = `%/${parentSessionId}/subagents/workflows/%/agent-%.jsonl`;
  db.prepare(`
    UPDATE conversations
    SET parent_conversation_id = COALESCE(parent_conversation_id, ?),
        is_sidechain = 1,
        agent_id = COALESCE(
          NULLIF(agent_id, ''),
          substr(source_path, instr(source_path, '/subagents/agent-') + length('/subagents/agent-'),
            length(source_path) - instr(source_path, '/subagents/agent-') - length('/subagents/agent-') - length('.jsonl') + 1)
        )
    WHERE source = 'claude_code'
      AND LOWER(source_path) LIKE LOWER(?)
      AND id != ?
  `).run(parentConversationId, parentPattern, parentConversationId);
  db.prepare(`
    UPDATE conversations
    SET parent_conversation_id = COALESCE(parent_conversation_id, ?),
        is_sidechain = 1,
        agent_id = COALESCE(
          NULLIF(agent_id, ''),
          substr(source_path, instr(source_path, '/agent-') + length('/agent-'),
            length(source_path) - instr(source_path, '/agent-') - length('/agent-') - length('.jsonl') + 1)
        )
    WHERE source = 'claude_code'
      AND LOWER(source_path) LIKE LOWER(?)
      AND id != ?
  `).run(parentConversationId, workflowPattern, parentConversationId);
}
const ingestQueue: string[] = [];
const queuedIngestPaths = new Set<string>();
let ingestDrainRunning = false;
const codexSessionIndexSyncMtimes = new Map<string, number>();
const targetedIngestLastRun = new Map<string, number>();
const TARGETED_INGEST_MIN_INTERVAL_MS = 250;
const acpSuppressedSessions = new Map<string, number>();
const ACP_SUPPRESSION_TTL_MS = 24 * 60 * 60 * 1000;

type ExistingConversationRow = {
  id: string;
  source: string;
  source_hash: string;
  source_mtime: number;
  session_id: string;
  title: string;
  summary: string | null;
  started_at: string;
  ended_at: string | null;
  block_count: number;
  project_path: string | null;
  cwd: string | null;
  branch: string | null;
  model: string | null;
  cli_version: string | null;
  actual_count: number;
};

type IngestAppendState = {
  file_path: string;
  byte_offset: number;
  line_count: number;
  tail_hash: string;
  partial_line: string;
};

type IngestMode = "full" | "append";

type AppendReadResult =
  | {
      kind: "append";
      raw: string;
      completeLineCount: number;
      appendedBytes: number;
      nextPartialLine: string;
      sourceHash: string;
      tailHash: string;
    }
  | {
      kind: "buffered";
      appendedBytes: number;
      nextPartialLine: string;
      tailHash: string;
    }
  | { kind: "fallback"; reason: string };

// --- Public API ---

export function startIngestion(log: Logger): void {
  logger = log;
  ingestionActive = true;
  ingestionRunToken++;
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
  ingestionActive = false;
  ingestionRunToken++;
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
  reconciling = false;
}

/** Manually trigger re-ingestion of all known sources. */
export async function triggerFullIngest(): Promise<{ processed: number; errors: number }> {
  let processed = 0;
  let errors = 0;

  for (const config of WATCH_CONFIGS) {
    if (!fs.existsSync(config.base)) continue;
    for await (const filePath of walkFiles(config.base, config.glob)) {
      try {
        await ingestFile(filePath, { forceFull: true });
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

export interface TargetedIngestInput {
  sessionRef?: string | null;
  transcriptPath?: string | null;
  now?: number;
}

export interface TargetedIngestResult {
  ok: boolean;
  status: "ingested" | "rate_limited" | "no_target" | "unsupported";
  transcript_path: string | null;
  session_ref: string | null;
}

export async function triggerTargetedIngest(input: TargetedIngestInput): Promise<TargetedIngestResult> {
  const sessionRef = normalizeTargetRef(input.sessionRef);
  const transcriptPath = normalizeTargetPath(input.transcriptPath) ?? findTranscriptPathForSession(sessionRef);
  if (!transcriptPath) {
    return { ok: true, status: "no_target", transcript_path: null, session_ref: sessionRef };
  }

  if (!getParserForFile(transcriptPath)) {
    logger("debug", "ingestion_targeted_unsupported", { file: transcriptPath, session_ref: sessionRef });
    return { ok: true, status: "unsupported", transcript_path: transcriptPath, session_ref: sessionRef };
  }

  const now = input.now ?? Date.now();
  const key = `${sessionRef ?? ""}\u0000${transcriptPath}`;
  const last = targetedIngestLastRun.get(key) ?? 0;
  if (now - last < TARGETED_INGEST_MIN_INTERVAL_MS) {
    return { ok: true, status: "rate_limited", transcript_path: transcriptPath, session_ref: sessionRef };
  }
  targetedIngestLastRun.set(key, now);

  const pendingTimer = debounceTimers.get(transcriptPath);
  if (pendingTimer) {
    clearTimeout(pendingTimer);
    debounceTimers.delete(transcriptPath);
  }

  await ingestFile(transcriptPath);
  clearHookNotificationAttention({ sessionRef, transcriptPath });
  return { ok: true, status: "ingested", transcript_path: transcriptPath, session_ref: sessionRef };
}

export function suppressAcpIngestForSession(source: string, sessionId: string): void {
  if (!source.trim() || !sessionId.trim()) {
    return;
  }
  acpSuppressedSessions.set(acpSuppressionKey(source, sessionId), Date.now() + ACP_SUPPRESSION_TTL_MS);
}

// --- Internal ---

function normalizeTargetRef(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, 256) : null;
}

function normalizeTargetPath(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed || !path.isAbsolute(trimmed)) {
    return null;
  }
  return trimmed;
}

function findTranscriptPathForSession(sessionRef: string | null): string | null {
  if (!sessionRef) {
    return null;
  }
  try {
    const db = getDb();
    const row = db.prepare(`
      SELECT source_path
      FROM conversations
      WHERE session_id = ?
      ORDER BY updated_at DESC
      LIMIT 1
    `).get(sessionRef) as { source_path: string | null } | undefined;
    return normalizeTargetPath(row?.source_path ?? null);
  } catch {
    return null;
  }
}

function debouncedIngest(filePath: string): void {
  const runToken = ingestionRunToken;
  if (!isCurrentIngestionRun(runToken)) {
    return;
  }
  const existing = debounceTimers.get(filePath);
  if (existing) clearTimeout(existing);

  const timer = setTimeout(() => {
    if (!isCurrentIngestionRun(runToken)) {
      debounceTimers.delete(filePath);
      return;
    }
    debounceTimers.delete(filePath);
    enqueueIngest(filePath, runToken);
  }, DEBOUNCE_MS);

  debounceTimers.set(filePath, timer);
}

function enqueueIngest(filePath: string, runToken = ingestionRunToken): void {
  if (!isCurrentIngestionRun(runToken)) {
    return;
  }
  if (queuedIngestPaths.has(filePath)) {
    return;
  }
  queuedIngestPaths.add(filePath);
  ingestQueue.push(filePath);
  if (!ingestDrainRunning) {
    void drainIngestQueue(runToken);
  }
}

async function drainIngestQueue(runToken: number): Promise<void> {
  if (!isCurrentIngestionRun(runToken)) {
    return;
  }
  ingestDrainRunning = true;
  try {
    while (isCurrentIngestionRun(runToken) && ingestQueue.length > 0) {
      const filePath = ingestQueue.shift();
      if (!filePath) {
        continue;
      }
      queuedIngestPaths.delete(filePath);
      try {
        await ingestFile(filePath);
      } catch (error) {
        if (!isCurrentIngestionRun(runToken)) {
          break;
        }
        logger("warn", "ingestion_debounced_error", {
          file: filePath,
          error: String(error),
        });
      }
      if (!isCurrentIngestionRun(runToken)) {
        break;
      }
      // Yield between files so burst ingestion doesn't monopolize the event loop.
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  } finally {
    if (runToken === ingestionRunToken) {
      ingestDrainRunning = false;
    }
  }
}

function isCurrentIngestionRun(runToken: number): boolean {
  return ingestionActive && runToken === ingestionRunToken;
}

export function isAcpIngestSuppressed(source: string, sessionId: string, now = Date.now()): boolean {
  const key = acpSuppressionKey(source, sessionId);
  const expiresAt = acpSuppressedSessions.get(key);
  if (!expiresAt) {
    return false;
  }
  if (expiresAt <= now) {
    acpSuppressedSessions.delete(key);
    return false;
  }
  return true;
}

function acpSuppressionKey(source: string, sessionId: string): string {
  return `${source.trim().toLowerCase()}:${sessionId.trim()}`;
}

async function hashFileTailAt(filePath: string, offset: number): Promise<string> {
  if (offset <= 0) {
    return "";
  }
  const length = Math.min(INGEST_TAIL_HASH_BYTES, offset);
  const buffer = Buffer.alloc(length);
  const handle = await fs.promises.open(filePath, "r");
  try {
    await handle.read(buffer, 0, length, offset - length);
  } finally {
    await handle.close();
  }
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

async function readFileRange(filePath: string, start: number, end: number): Promise<string> {
  if (end <= start) {
    return "";
  }
  const length = end - start;
  const buffer = Buffer.alloc(length);
  const handle = await fs.promises.open(filePath, "r");
  try {
    await handle.read(buffer, 0, length, start);
  } finally {
    await handle.close();
  }
  return buffer.toString("utf8");
}

async function readTrailingPartialLine(filePath: string, size: number): Promise<string> {
  if (size <= 0) {
    return "";
  }
  const length = Math.min(64 * 1024, size);
  const tail = await readFileRange(filePath, size - length, size);
  if (tail.endsWith("\n") || tail.endsWith("\r")) {
    return "";
  }
  const lastLf = tail.lastIndexOf("\n");
  const trailing = lastLf >= 0 ? tail.slice(lastLf + 1) : tail;
  if (!trailing.trim()) {
    return "";
  }
  try {
    JSON.parse(trailing);
    return "";
  } catch {
    return trailing;
  }
}

async function countCompleteLines(filePath: string): Promise<number> {
  const raw = await fs.promises.readFile(filePath, "utf8");
  return raw.length === 0 ? 0 : (raw.match(/\n/g) ?? []).length;
}

function getAppendState(db: ReturnType<typeof getDb>, filePath: string): IngestAppendState | null {
  const row = db.prepare(`
    SELECT file_path, byte_offset, line_count, tail_hash, partial_line
    FROM conversation_ingest_state
    WHERE file_path = ?
  `).get(filePath) as IngestAppendState | undefined;
  return row ?? null;
}

function deleteAppendState(db: ReturnType<typeof getDb>, filePath: string): void {
  db.prepare("DELETE FROM conversation_ingest_state WHERE file_path = ?").run(filePath);
}

function writeAppendState(
  db: ReturnType<typeof getDb>,
  state: IngestAppendState,
): void {
  db.prepare(`
    INSERT INTO conversation_ingest_state (
      file_path, byte_offset, line_count, tail_hash, partial_line, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(file_path) DO UPDATE SET
      byte_offset = excluded.byte_offset,
      line_count = excluded.line_count,
      tail_hash = excluded.tail_hash,
      partial_line = excluded.partial_line,
      updated_at = excluded.updated_at
  `).run(
    state.file_path,
    state.byte_offset,
    state.line_count,
    state.tail_hash,
    state.partial_line,
    Date.now(),
  );
}

async function refreshAppendState(
  db: ReturnType<typeof getDb>,
  filePath: string,
  stat: fs.Stats,
  lineCount: number,
  partialLine?: string,
  tailHash?: string,
): Promise<void> {
  writeAppendState(db, {
    file_path: filePath,
    byte_offset: stat.size,
    line_count: lineCount,
    tail_hash: tailHash ?? await hashFileTailAt(filePath, stat.size),
    partial_line: partialLine ?? await readTrailingPartialLine(filePath, stat.size),
  });
}

async function readAppend(
  filePath: string,
  stat: fs.Stats,
  state: IngestAppendState | null,
): Promise<AppendReadResult> {
  if (!state) {
    return { kind: "fallback", reason: "missing_append_state" };
  }
  if (state.byte_offset > stat.size) {
    return { kind: "fallback", reason: "file_truncated" };
  }
  const currentTailHash = await hashFileTailAt(filePath, state.byte_offset);
  if (currentTailHash !== state.tail_hash) {
    return { kind: "fallback", reason: "tail_hash_mismatch" };
  }
  const appendedBytes = stat.size - state.byte_offset;
  if (appendedBytes <= 0) {
    return { kind: "buffered", appendedBytes: 0, nextPartialLine: state.partial_line, tailHash: currentTailHash };
  }

  const appended = await readFileRange(filePath, state.byte_offset, stat.size);
  const combined = `${state.partial_line}${appended}`;
  const endedWithLineBreak = combined.endsWith("\n") || combined.endsWith("\r");
  const parts = combined.split(/\r?\n/);
  const completeLines = endedWithLineBreak ? parts.slice(0, -1) : parts.slice(0, -1);
  const nextPartialLine = endedWithLineBreak ? "" : parts.at(-1) ?? "";
  const rawLines = completeLines.filter((line) => line.trim().length > 0);
  const tailHash = await hashFileTailAt(filePath, stat.size);
  if (rawLines.length === 0) {
    return { kind: "buffered", appendedBytes, nextPartialLine, tailHash };
  }
  return {
    kind: "append",
    raw: `${rawLines.join("\n")}\n`,
    completeLineCount: completeLines.length,
    appendedBytes,
    nextPartialLine,
    sourceHash: `append:${stat.size}:${tailHash}`,
    tailHash,
  };
}

function mergeAppendConversationMetadata(
  result: ParseResult,
  existing: ExistingConversationRow,
): ParseResult {
  return {
    conversation: {
      ...result.conversation,
      title: existing.title,
      summary: existing.summary,
      started_at: existing.started_at,
      session_id: existing.session_id || result.conversation.session_id,
      project_path: existing.project_path ?? result.conversation.project_path,
      cwd: existing.cwd ?? result.conversation.cwd,
      branch: existing.branch ?? result.conversation.branch,
      model: result.conversation.model ?? existing.model,
      cli_version: result.conversation.cli_version ?? existing.cli_version,
    },
    blocks: result.blocks,
  };
}

function incrementalParseAnomaly(
  result: ParseResult,
  baseBlockCount: number,
  newBlockCount: number,
): string | null {
  for (const block of result.blocks) {
    if (block.position < baseBlockCount || block.position >= baseBlockCount + newBlockCount) {
      return "position_out_of_range";
    }
    if (
      block.type === "tool_result"
      && block.parent_id == null
      && typeof block.metadata.tool_id === "string"
      && block.metadata.tool_id.trim()
    ) {
      return "tool_result_parent_missing";
    }
  }
  return null;
}

function insertedBlockPayload(
  conversationId: string,
  block: Omit<ConversationBlock, "id" | "conversation_id">,
): Omit<ConversationBlock, "metadata"> & { metadata_json: string } {
  const id = crypto
    .createHash("sha256")
    .update(conversationId + block.type + (block.timestamp || "") + (block.content || "").slice(0, 100) + String(block.position))
    .digest("hex")
    .slice(0, 16);
  return {
    id,
    conversation_id: conversationId,
    type: block.type,
    role: block.role,
    content: block.content,
    position: block.position,
    timestamp: block.timestamp,
    parent_id: block.parent_id,
    metadata_json: JSON.stringify(block.metadata),
    dag_uuid: block.dag_uuid ?? null,
    dag_parent_uuid: block.dag_parent_uuid ?? null,
  };
}

async function syncCodexIndexedTitle(
  filePath: string,
  existing: {
    id: string;
    session_id: string;
    title: string;
    block_count: number;
  },
): Promise<boolean> {
  if (!existing.session_id) {
    return false;
  }
  const title = (await loadCodexSessionIndexTitle(filePath, existing.session_id))
    ?.slice(0, 100)
    .trim();
  if (!title || title === existing.title) {
    return false;
  }

  const db = getDb();
  db.prepare("UPDATE conversations SET title = ?, updated_at = datetime('now') WHERE id = ?")
    .run(title, existing.id);
  broadcast("conversation:updated", {
    id: existing.id,
    source: "codex",
    title,
    block_count: existing.block_count,
  });
  logger("info", "ingestion_title_synced", {
    file: filePath,
    id: existing.id,
    source: "codex",
  });
  return true;
}

async function syncCodexIndexedTitlesForKnownRows(db: ReturnType<typeof getDb>): Promise<void> {
  const rows = db.prepare(`
    SELECT id, source_path, session_id, title, block_count
    FROM conversations
    WHERE source = 'codex' AND session_id IS NOT NULL AND session_id != ''
  `).all() as Array<{
    id: string;
    source_path: string;
    session_id: string;
    title: string;
    block_count: number;
  }>;
  if (rows.length === 0) {
    return;
  }

  const rowsByIndex = new Map<string, typeof rows>();
  for (const row of rows) {
    const indexPath = getCodexSessionIndexPath(row.source_path);
    if (!indexPath) continue;
    const bucket = rowsByIndex.get(indexPath);
    if (bucket) {
      bucket.push(row);
    } else {
      rowsByIndex.set(indexPath, [row]);
    }
  }

  for (const [indexPath, indexRows] of rowsByIndex) {
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(indexPath);
    } catch {
      continue;
    }
    if (codexSessionIndexSyncMtimes.get(indexPath) === stat.mtimeMs) {
      continue;
    }
    for (const row of indexRows) {
      await syncCodexIndexedTitle(row.source_path, row);
    }
    codexSessionIndexSyncMtimes.set(indexPath, stat.mtimeMs);
  }
}

async function syncGeminiProjectIdentityForKnownRows(db: ReturnType<typeof getDb>): Promise<void> {
  const rows = db.prepare(`
    SELECT id, source_path, project_path, cwd, title, block_count
    FROM conversations
    WHERE source = 'gemini'
  `).all() as Array<{
    id: string;
    source_path: string;
    project_path: string | null;
    cwd: string | null;
    title: string;
    block_count: number;
  }>;

  const identityCache = new Map<string, Awaited<ReturnType<typeof inferGeminiProjectIdentity>>>();
  for (const row of rows) {
    const projectHash = row.project_path && /^[a-f0-9]{64}$/i.test(row.project_path)
      ? row.project_path
      : null;
    const projectDir = path.dirname(path.dirname(row.source_path));
    const cacheKey = `${projectDir}\0${projectHash ?? ""}`;
    let identity = identityCache.get(cacheKey);
    if (!identity) {
      identity = await inferGeminiProjectIdentity(row.source_path, projectHash);
      identityCache.set(cacheKey, identity);
    }
    if (identity.projectPath === row.project_path && identity.cwd === row.cwd) {
      continue;
    }
    db.prepare(`
      UPDATE conversations SET
        project_path = ?,
        cwd = ?,
        updated_at = datetime('now')
      WHERE id = ?
    `).run(identity.projectPath, identity.cwd, row.id);
    broadcast("conversation:updated", {
      id: row.id,
      source: "gemini",
      title: row.title,
      block_count: row.block_count,
    });
    logger("info", "ingestion_gemini_project_synced", {
      file: row.source_path,
      id: row.id,
      project_path: identity.projectPath,
    });
  }
}

async function ingestFile(
  filePath: string,
  options: { forceFull?: boolean; fallbackReason?: string } = {},
): Promise<void> {
  const ingestStartedAt = Date.now();
  if (isClaudeWorkflowSummaryPath(filePath) || isClaudeWorkflowJournalPath(filePath)) {
    await ingestWorkflowArtifact(filePath);
    return;
  }

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
    try {
      deleteAppendState(getDb(), filePath);
    } catch {
      // Best effort cleanup only.
    }
    return;
  }

  // Check if we already have this version
  const db = getDb();
  const existingRows = db.prepare(`
    SELECT
      c.id,
      c.source_hash,
      c.source_mtime,
      c.source,
      c.session_id,
      c.title,
      c.summary,
      c.started_at,
      c.ended_at,
      c.block_count,
      c.project_path,
      c.cwd,
      c.branch,
      c.model,
      c.cli_version,
      COALESCE((
        SELECT COUNT(*) FROM conversation_blocks b WHERE b.conversation_id = c.id
      ), 0) AS actual_count
    FROM conversations c
    WHERE c.source_path = ?
    ORDER BY actual_count DESC, c.updated_at DESC
  `).all(filePath) as ExistingConversationRow[];
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
    if (parser.source === "codex") {
      await syncCodexIndexedTitle(filePath, existing);
    }
    if (isClaudeWorkflowTranscriptPath(filePath)) {
      await ingestWorkflowArtifact(filePath);
    }
    return;
  }

  let alreadyIngestedCount = 0;
  if (existing) {
    const actualCount = existing.actual_count ?? 0;
    const expectedCount = existing.block_count ?? 0;
    alreadyIngestedCount = Math.max(actualCount, expectedCount);
    if (actualCount === 0 && expectedCount > 0) {
      logger("warn", "ingestion_count_mismatch", {
        file: filePath,
        conversation_id: existing.id,
        expected_count: expectedCount,
        actual_count: actualCount,
      });
    }
  }

  const appendState = getAppendState(db, filePath);
  let ingestMode: IngestMode = "full";
  let appendInfo: {
    completeLineCount: number;
    appendedBytes: number;
    nextPartialLine: string;
    tailHash: string;
  } | null = null;
  let forceFullReingest = options.forceFull === true;

  // Parse the file
  let result: ParseResult | null;
  try {
    if (
      !options.forceFull
      && existing
      && alreadyIngestedCount > 0
      && parser.parseIncremental
      && (parser.source !== "gemini" || filePath.endsWith(".jsonl"))
    ) {
      const append = await readAppend(filePath, stat, appendState);
      if (append.kind === "append") {
        result = await parser.parseIncremental({
          filePath,
          raw: append.raw,
          baseBlockCount: alreadyIngestedCount,
          sourceHash: append.sourceHash,
          sourceMtime: stat.mtimeMs,
        });
        if (!result) {
          await refreshAppendState(
            db,
            filePath,
            stat,
            (appendState?.line_count ?? alreadyIngestedCount) + append.completeLineCount,
            append.nextPartialLine,
            append.tailHash,
          );
          logger("debug", "ingestion_append_metadata_only", {
            file: filePath,
            appended_bytes: append.appendedBytes,
          });
          return;
        } else {
          const anomaly = incrementalParseAnomaly(result, alreadyIngestedCount, result.blocks.length);
          if (anomaly) {
            logger("warn", "ingestion_append_fallback", {
              file: filePath,
              reason: anomaly,
              appended_bytes: append.appendedBytes,
            });
            forceFullReingest = true;
            result = await parser.parse(filePath);
          } else {
            result = mergeAppendConversationMetadata(result, existing);
            ingestMode = "append";
            appendInfo = {
              completeLineCount: append.completeLineCount,
              appendedBytes: append.appendedBytes,
              nextPartialLine: append.nextPartialLine,
              tailHash: append.tailHash,
            };
          }
        }
      } else if (append.kind === "buffered") {
        await refreshAppendState(
          db,
          filePath,
          stat,
          appendState?.line_count ?? alreadyIngestedCount,
          append.nextPartialLine,
          append.tailHash,
        );
        logger("debug", "ingestion_append_buffered", {
          file: filePath,
          appended_bytes: append.appendedBytes,
        });
        return;
      } else {
        logger("debug", "ingestion_append_fallback", {
          file: filePath,
          reason: append.reason,
        });
        forceFullReingest = true;
        result = await parser.parse(filePath);
      }
    } else {
      result = await parser.parse(filePath);
    }
  } catch (error) {
    logger("warn", "ingestion_parse_error", {
      file: filePath,
      source: parser.source,
      error: String(error),
    });
    return;
  }

  if (
    result?.conversation.session_id
    && isAcpIngestSuppressed(result.conversation.source, result.conversation.session_id)
  ) {
    logger("debug", "ingestion_skip_acp_originated_session", {
      file: filePath,
      source: result.conversation.source,
      session_id: result.conversation.session_id,
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
          deleteAppendState(db, filePath);
          logger("info", "ingestion_removed_empty", { file: filePath, id: convId });
        }
      }
    }
    return;
  }

  const subagentPath = parseClaudeSubagentPath(filePath);
  const isSidechain = result.conversation.is_sidechain || Boolean(subagentPath);
  const agentId = result.conversation.agent_id ?? subagentPath?.agentId ?? null;
  const parentConversationId = resolveParentConversationId(
    db,
    result.conversation.session_id,
    filePath,
    existing?.id,
  );

  // Check hash — if same content, just update mtime
  if (existing && existing.source_hash === result.conversation.source_hash) {
    db.prepare(`
      UPDATE conversations SET
        source_mtime = ?,
        title = ?,
        summary = ?,
        ended_at = ?,
        block_count = ?,
        model = ?,
        cli_version = ?,
        parent_conversation_id = COALESCE(?, parent_conversation_id),
        is_sidechain = ?,
        agent_id = ?,
        updated_at = datetime('now')
      WHERE source_path = ?
    `).run(
      stat.mtimeMs,
      result.conversation.title,
      result.conversation.summary,
      result.conversation.ended_at,
      result.conversation.block_count,
      result.conversation.model,
      result.conversation.cli_version,
      parentConversationId,
      isSidechain ? 1 : 0,
      agentId,
      filePath,
    );
    if (!isSidechain && result.conversation.source === "claude_code") {
      linkExistingClaudeSubagents(db, result.conversation.session_id, existing.id);
    }
    broadcast("conversation:updated", {
      id: existing.id,
      source: result.conversation.source,
      title: result.conversation.title,
      block_count: result.conversation.block_count,
    });
    await refreshAppendState(db, filePath, stat, await countCompleteLines(filePath));
    if (isClaudeWorkflowTranscriptPath(filePath)) {
      await ingestWorkflowArtifact(filePath);
    }
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

  // Bug: 871765b — Delta ingestion: for existing conversations, only insert
  // blocks that haven't been ingested yet. JSONL files are append-only, so if
  // the new parse has at least as many blocks as already in the DB, we can
  // skip re-compressing and re-inserting the already-persisted blocks.
  // Fall back to full re-ingest if block count shrank (truncation/modification).
  const isDeltaAppend = ingestMode === "append"
    || (!forceFullReingest && !isNew && result.blocks.length >= alreadyIngestedCount && alreadyIngestedCount > 0);
  const newBlocks = ingestMode === "append"
    ? result.blocks
    : isDeltaAppend
      ? result.blocks.slice(alreadyIngestedCount)
      : result.blocks;

  if (isDeltaAppend && newBlocks.length === 0) {
    // Hash changed but no new blocks — metadata-only change (title, timestamps, etc.)
    // Update conversation metadata and return.
    db.prepare(`
      UPDATE conversations SET
        source_hash = ?, source_mtime = ?,
        title = ?, summary = ?, ended_at = ?,
        block_count = ?, model = ?, cli_version = ?,
        parent_conversation_id = COALESCE(?, parent_conversation_id),
        is_sidechain = ?,
        agent_id = ?,
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
      parentConversationId,
      isSidechain ? 1 : 0,
      agentId,
      conversationId,
    );
    if (!isSidechain && result.conversation.source === "claude_code") {
      linkExistingClaudeSubagents(db, result.conversation.session_id, conversationId);
    }
    await refreshAppendState(
      db,
      filePath,
      stat,
      ingestMode === "append"
        ? (appendState?.line_count ?? alreadyIngestedCount) + (appendInfo?.completeLineCount ?? 0)
        : await countCompleteLines(filePath),
      appendInfo?.nextPartialLine,
      appendInfo?.tailHash,
    );
    if (isClaudeWorkflowTranscriptPath(filePath)) {
      await ingestWorkflowArtifact(filePath);
    }
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
          starred, label, notes, parent_conversation_id, is_sidechain, agent_id,
          created_at, updated_at
        ) VALUES (
          ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?,
          ?, ?, ?, ?, ?, ?,
          0, NULL, NULL, ?, ?, ?,
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
        isSidechain ? 1 : 0,
        agentId,
      );
    } else {
      // Delta append path: update conversation metadata only, no block deletion
      db.prepare(`
        UPDATE conversations SET
          source_hash = ?, source_mtime = ?,
          title = ?, summary = ?, ended_at = ?,
          block_count = ?, model = ?, cli_version = ?,
          parent_conversation_id = COALESCE(?, parent_conversation_id),
          is_sidechain = ?,
          agent_id = ?,
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
        parentConversationId,
        isSidechain ? 1 : 0,
        agentId,
        conversationId,
      );
    }

    // Insert blocks — content is gzip-compressed as BLOB (Bug: e5a945d)
    // In delta mode, newBlocks contains only the newly appended blocks.
    // compressedContents was pre-computed async above, outside this transaction.
    const insertBlock = db.prepare(`
      INSERT INTO conversation_blocks (
        id, conversation_id, type, role, content, position,
        timestamp, parent_id, metadata_json, compressed,
        dag_uuid, dag_parent_uuid
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
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
        block.dag_uuid ?? null,
        block.dag_parent_uuid ?? null,
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
      if (ingestMode === "append") {
        deleteAppendState(db, filePath);
        logger("warn", "ingestion_append_fallback", {
          file: filePath,
          reason: "append_unique_conflict",
        });
        await ingestFile(filePath, { forceFull: true, fallbackReason: "append_unique_conflict" });
        return;
      }
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
              starred, label, notes, parent_conversation_id, is_sidechain, agent_id,
              created_at, updated_at
            ) VALUES (
              ?, ?, ?, ?, ?,
              ?, ?, ?, ?, ?,
              ?, ?, ?, ?, ?, ?,
              0, NULL, NULL, ?, ?, ?,
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
            isSidechain ? 1 : 0,
            agentId,
          );
          // Re-insert all blocks using pre-compressed buffers.
          const insertBlock2 = db.prepare(`
            INSERT INTO conversation_blocks (
              id, conversation_id, type, role, content, position,
              timestamp, parent_id, metadata_json, compressed,
              dag_uuid, dag_parent_uuid
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
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
              block.dag_uuid ?? null, block.dag_parent_uuid ?? null,
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

  await refreshAppendState(
    db,
    filePath,
    stat,
    ingestMode === "append"
      ? (appendState?.line_count ?? alreadyIngestedCount) + (appendInfo?.completeLineCount ?? 0)
      : await countCompleteLines(filePath),
    appendInfo?.nextPartialLine,
    appendInfo?.tailHash,
  );

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

  if (!isSidechain && result.conversation.source === "claude_code") {
    linkExistingClaudeSubagents(db, result.conversation.session_id, conversationId);
  }

  // Broadcast SSE event
  const eventType = isNew ? "conversation:new" : "conversation:updated";
  const insertedBlocks = newBlocks.map((block) => insertedBlockPayload(conversationId, block));
  broadcast(eventType, {
    id: conversationId,
    source: result.conversation.source,
    title: result.conversation.title,
    block_count: result.conversation.block_count,
    append: !isNew && isDeltaAppend && insertedBlocks.length > 0
      ? {
          blocks: insertedBlocks,
          from_position: insertedBlocks[0]?.position ?? alreadyIngestedCount,
        }
      : undefined,
  });
  if (isClaudeWorkflowTranscriptPath(filePath)) {
    await ingestWorkflowArtifact(filePath);
  }

  logger("info", "ingestion_complete", {
    file: filePath,
    source: result.conversation.source,
    blocks: newBlocks.length,
    total_blocks: result.conversation.block_count,
    delta: isDeltaAppend,
    ingest_mode: ingestMode,
    appended_bytes: appendInfo?.appendedBytes ?? null,
    append_to_ingest_latency_ms: Math.max(0, Date.now() - stat.mtimeMs),
    ingest_duration_ms: Date.now() - ingestStartedAt,
    fallback_reason: options.fallbackReason ?? null,
    event: eventType,
  });
}

async function ingestWorkflowArtifact(filePath: string): Promise<void> {
  try {
    const workflow = await ingestClaudeWorkflowArtifact(getDb(), filePath);
    if (!workflow) return;
    broadcast("workflow:updated", {
      id: workflow.id,
      session_id: workflow.session_id,
      provider_run_id: workflow.provider_run_id,
      status: workflow.status,
      completed_workers: workflow.completed_workers,
      total_workers: workflow.total_workers,
    });
    logger("info", "workflow_ingestion_complete", {
      file: filePath,
      workflow_id: workflow.id,
      provider_run_id: workflow.provider_run_id,
      status: workflow.status,
    });
  } catch (error) {
    logger("warn", "workflow_ingestion_error", {
      file: filePath,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

let reconciling = false;

function scheduleReconcile(): void {
  const runToken = ingestionRunToken;
  if (!isCurrentIngestionRun(runToken)) {
    return;
  }
  if (reconciling) return;
  reconciling = true;
  void reconcile(runToken)
    .catch((error) => {
      if (isCurrentIngestionRun(runToken)) {
        logger("warn", "ingestion_reconcile_error", { error: String(error) });
      }
    })
    .finally(() => {
      if (runToken === ingestionRunToken) {
        reconciling = false;
      }
    });
}

async function reconcile(runToken: number): Promise<void> {
  if (!isCurrentIngestionRun(runToken)) {
    return;
  }
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

  await syncCodexIndexedTitlesForKnownRows(db);
  await syncGeminiProjectIdentityForKnownRows(db);

  const knownPaths = new Set<string>();
  const scannedBases: string[] = [];

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
    if (!isCurrentIngestionRun(runToken)) {
      return;
    }
    if (!fs.existsSync(config.base)) continue;
    scannedBases.push(config.base);
    for await (const filePath of walkFiles(config.base, config.glob)) {
      if (!isCurrentIngestionRun(runToken)) {
        return;
      }
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

  const missingPaths = Array.from(dbPaths.keys()).filter((sourcePath) =>
    scannedBases.some((base) => sourcePath === base || sourcePath.startsWith(`${base}${path.sep}`)) &&
    !knownPaths.has(sourcePath)
  );
  if (missingPaths.length > 0) {
    const deleteBlocks = db.prepare("DELETE FROM conversation_blocks WHERE conversation_id = ?");
    const deleteConversation = db.prepare("DELETE FROM conversations WHERE id = ?");
    const findConversation = db.prepare(
      "SELECT id, starred FROM conversations WHERE source_path = ?"
    );
    let removed = 0;
    const cleanupMissing = db.transaction(() => {
      for (const sourcePath of missingPaths) {
        const row = findConversation.get(sourcePath) as { id: string; starred: number } | undefined;
        if (!row || row.starred) continue;
        deleteBlocks.run(row.id);
        deleteConversation.run(row.id);
        removed += 1;
      }
    });
    cleanupMissing();
    if (removed > 0) {
      logger("info", "ingestion_cleanup_missing_sources", { removed });
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
