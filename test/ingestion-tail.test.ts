import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import fsp from "node:fs/promises";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import SqliteDatabase from "../src/sqlite.ts";

import { migrate, openDb, setDb, type Db } from "../src/db.js";
import { triggerExactPathIngest, triggerReconcileForTest, triggerTargetedIngest } from "../src/ingestion.js";
import { decompressContent } from "../src/compression.js";
import { CodexParser } from "../src/parsers/codex.js";
import { ConversationSourceStore } from "../src/conversations/source-store.js";
import { ConversationSourceReader } from "../src/conversations/source-reader.js";
import { CURRENT_CONVERSATION_SOURCE_EPOCHS } from "../src/conversations/source-types.js";
import { ensureExactConversationFresh } from "../src/conversations/freshness.js";

let tempDir = "";
let db: Db;
let previousCodexHome: string | undefined;
const TEST_APPEND_BATCH_BYTES = 16 * 1024 * 1024;

function row(record: unknown): string {
  return `${JSON.stringify(record)}\n`;
}

async function makeCodexSession(): Promise<string> {
  const sessionDir = path.join(tempDir, "home", ".codex", "sessions", "2026", "07", "02");
  await fsp.mkdir(sessionDir, { recursive: true });
  return path.join(sessionDir, "rollout-2026-07-02T00-00-00-tailtest.jsonl");
}

function watchConfigs(): Array<{ base: string; glob: string }> {
  return [{ base: path.join(tempDir, "home", ".codex", "sessions"), glob: "**/*.jsonl" }];
}

async function writeWithMtime(filePath: string, content: string, tick: number): Promise<void> {
  await fsp.writeFile(filePath, content, "utf8");
  const atime = new Date(1_800_000_000_000 + tick * 1000);
  await fsp.utimes(filePath, atime, atime);
}

async function appendWithMtime(filePath: string, content: string, tick: number): Promise<void> {
  await fsp.appendFile(filePath, content, "utf8");
  const atime = new Date(1_800_000_000_000 + tick * 1000);
  await fsp.utimes(filePath, atime, atime);
}

function initialCodexRows(sessionId = "tailtest"): string {
  return [
    row({
      type: "session_meta",
      timestamp: "2026-07-02T00:00:00.000Z",
      payload: { id: sessionId, cwd: "/tmp/project", model_provider: "openai" },
    }),
    row({
      type: "response_item",
      timestamp: "2026-07-02T00:00:01.000Z",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "hello" }],
      },
    }),
    row({
      type: "response_item",
      timestamp: "2026-07-02T00:00:02.000Z",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "hi" }],
      },
    }),
  ].join("");
}

function assistantRow(text: string, second: number): string {
  return row({
    type: "response_item",
    timestamp: `2026-07-02T00:00:${String(second).padStart(2, "0")}.000Z`,
    payload: {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text }],
    },
  });
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-ingestion-tail-"));
  process.env.HOME = path.join(tempDir, "home");
  db = openDb(path.join(tempDir, "mandible.db"));
  migrate(db);
  setDb(db);
  previousCodexHome = process.env.CODEX_HOME;
});

afterEach(() => {
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousCodexHome;
  vi.restoreAllMocks();
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("incremental tail ingestion", () => {
  it("attaches one preview-created Codex Chat by exact thread authority and replaces its provisional title", async () => {
    const sessionId = "01a00000-0000-7000-8000-000000000123";
    const reservationId = "01a00000-0000-7000-8000-000000000456";
    const codexRoot = path.join(tempDir, ".codex");
    const sessionDir = path.join(codexRoot, "sessions", "2026", "07", "02");
    const sessionPath = path.join(sessionDir, `rollout-2026-07-02T00-00-00-${sessionId}.jsonl`);
    await fsp.mkdir(sessionDir, { recursive: true });
    await writeWithMtime(sessionPath, initialCodexRows(sessionId), 1);
    process.env.CODEX_HOME = codexRoot;
    const state = new SqliteDatabase(path.join(codexRoot, "state_5.sqlite"));
    state.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT, rollout_path TEXT, updated_at INTEGER, updated_at_ms INTEGER)");
    state.prepare("INSERT INTO threads VALUES (?, ?, ?, ?, ?)").run(
      sessionId,
      "Current exact provider title",
      sessionPath,
      1_900_000_000,
      1_900_000_000_000,
    );
    state.close();
    db.prepare(`INSERT INTO conversation_spawn_requests (
      id, schema_version, idempotency_key, request_digest, request_json, provider,
      topology_kind, state, attempt_count, native_session_id, provider_session_id, created_at, updated_at
    ) VALUES (?, 'mandible-conversation-spawn-request@3', ?, ?, '{}', 'codex',
      'top-level', 'ready', 1, 'controller-1', ?, 1, 1)`).run(reservationId, reservationId, "a".repeat(64), sessionId);
    db.prepare(`INSERT INTO conversations (
      id, source, source_path, source_hash, source_mtime, title, started_at,
      block_count, session_id, cwd, created_at, updated_at
    ) VALUES (?, 'codex', ?, ?, 1, 'New Codex chat', '2026-07-02T00:00:00Z',
      0, ?, '/tmp/project', '2026-07-02T00:00:00Z', '2026-07-02T00:00:00Z')`)
      .run(reservationId, `mandible://chat/${reservationId}`, "b".repeat(64), sessionId);

    await expect(triggerTargetedIngest({ sessionRef: sessionId, now: 1_000 })).resolves.toMatchObject({
      status: "ingested",
      transcript_path: sessionPath,
    });
    await expect(ensureExactConversationFresh(db, reservationId)).resolves.toMatchObject({ conversationId: reservationId });
    expect(db.prepare("SELECT id, source_path, title FROM conversations WHERE id = ?").get(reservationId)).toEqual({
      id: reservationId,
      source_path: sessionPath,
      title: "Current exact provider title",
    });
  });

  it("ingests appended Codex JSONL records without duplicating prior blocks", async () => {
    const sessionPath = await makeCodexSession();
    await writeWithMtime(sessionPath, initialCodexRows(), 1);

    expect(await triggerTargetedIngest({ transcriptPath: sessionPath, now: 1_000 })).toMatchObject({
      status: "ingested",
    });

    await appendWithMtime(sessionPath, assistantRow("new tail", 3), 2);
    expect(await triggerTargetedIngest({ transcriptPath: sessionPath, now: 2_000 })).toMatchObject({
      status: "ingested",
    });

    const conversation = db.prepare("SELECT id, block_count FROM conversations WHERE source_path = ?")
      .get(sessionPath) as { id: string; block_count: number };
    expect(conversation.block_count).toBe(3);
    expect(db.prepare("SELECT COUNT(*) AS count FROM conversation_blocks WHERE conversation_id = ?")
      .get(conversation.id)).toEqual({ count: 0 });
    const sourcePage = await new ConversationSourceReader(db).readPage(conversation.id, { limit: 10 });
    expect(sourcePage.status).toBe("source");
    if (sourcePage.status === "source") {
      expect(sourcePage.value.blocks.map((block) => block.content)).toEqual(["hello", "hi", "new tail"]);
    }
    expect(
      db.prepare("SELECT byte_offset, line_count FROM conversation_ingest_state WHERE file_path = ?")
        .get(sessionPath),
    ).toMatchObject({ byte_offset: fs.statSync(sessionPath).size, line_count: 4 });
  });

  it("indexes the exact incremental append prefix when the writer grows during source capture", async () => {
    const sessionPath = await makeCodexSession();
    await writeWithMtime(sessionPath, initialCodexRows(), 1);
    await triggerTargetedIngest({ transcriptPath: sessionPath, now: 1_000 });
    const conversation = db.prepare("SELECT id FROM conversations WHERE source_path = ?")
      .get(sessionPath) as { id: string };
    const priorVersion = db.prepare(`
      SELECT version.byte_length
        FROM conversation_sources source
        JOIN conversation_source_versions version ON version.id = source.current_version_id
       WHERE source.conversation_id = ?
    `).get(conversation.id) as { byte_length: number };

    const parsedTail = assistantRow("parsed tail", 3);
    const concurrentTail = assistantRow("writer tail", 4);
    await appendWithMtime(sessionPath, parsedTail, 2);
    const expectedByteLength = fs.statSync(sessionPath).size;
    const originalRecordConversation = ConversationSourceStore.prototype.recordConversation;
    let capturedByteLength: number | null = null;
    vi.spyOn(ConversationSourceStore.prototype, "recordConversation").mockImplementation(async function (input) {
      if (input.sourceSnapshot?.kind === "append" && capturedByteLength === null) {
        capturedByteLength = input.sourceSnapshot.byteLength;
        await fsp.appendFile(sessionPath, concurrentTail, "utf8");
      }
      return originalRecordConversation.call(this, input);
    });

    await triggerTargetedIngest({ transcriptPath: sessionPath, now: 2_000 });

    expect(capturedByteLength).toBe(expectedByteLength);
    expect(fs.statSync(sessionPath).size).toBeGreaterThan(expectedByteLength);
    const currentVersion = db.prepare(`
      SELECT version.content_sha256, version.byte_length
        FROM conversation_sources source
        JOIN conversation_source_versions version ON version.id = source.current_version_id
       WHERE source.conversation_id = ?
    `).get(conversation.id) as { content_sha256: string; byte_length: number };
    const capturedBytes = fs.readFileSync(sessionPath).subarray(0, expectedByteLength);
    expect(currentVersion).toEqual({
      content_sha256: crypto.createHash("sha256").update(capturedBytes).digest("hex"),
      byte_length: expectedByteLength,
    });

    const page = await new ConversationSourceReader(db).readAll(conversation.id);
    expect(page.status).toBe("source");
    if (page.status === "source") {
      expect(page.value.map((block) => block.content)).toEqual(["hello", "hi", "parsed tail"]);
    }
  });

  it("fully reindexes an unchanged source when the normalization epoch advances", async () => {
    const sessionPath = await makeCodexSession();
    await writeWithMtime(sessionPath, initialCodexRows(), 1);
    await triggerTargetedIngest({ transcriptPath: sessionPath, now: 1_000 });
    const conversation = db.prepare("SELECT id FROM conversations WHERE source_path = ?")
      .get(sessionPath) as { id: string };
    db.prepare("UPDATE conversation_sources SET normalization_version = '1' WHERE conversation_id = ?")
      .run(conversation.id);
    db.prepare(`UPDATE conversation_source_versions SET normalization_version = '1'
      WHERE source_id IN (SELECT id FROM conversation_sources WHERE conversation_id = ?)`)
      .run(conversation.id);
    const fullParse = vi.spyOn(CodexParser.prototype, "parse");

    await triggerTargetedIngest({ transcriptPath: sessionPath, now: 2_000 });

    expect(fullParse).toHaveBeenCalledWith(sessionPath);
    expect(db.prepare(`SELECT normalization_version FROM conversation_sources
      WHERE conversation_id = ?`).get(conversation.id)).toEqual({ normalization_version: "2" });
    const page = await new ConversationSourceReader(db).readPage(conversation.id, { limit: 10 });
    expect(page.status).toBe("source");
    if (page.status === "source") {
      expect(JSON.parse(page.value.blocks[1].metadata_json).chat_item).toMatchObject({
        type: "message",
        identity: { provider: "codex", session_id: "tailtest" },
      });
    }
  });

  it("does not read the full session file for steady-state appends", async () => {
    const sessionPath = await makeCodexSession();
    await writeWithMtime(sessionPath, `${initialCodexRows()}${assistantRow("before", 3)}`, 1);
    await triggerTargetedIngest({ transcriptPath: sessionPath, now: 1_000 });

    const readFileSpy = vi.spyOn(fsp, "readFile");
    await appendWithMtime(sessionPath, assistantRow("after", 4), 2);
    await triggerTargetedIngest({ transcriptPath: sessionPath, now: 2_000 });

    expect(readFileSpy.mock.calls.some((call) => call[0] === sessionPath)).toBe(false);
    const conversation = db.prepare("SELECT block_count FROM conversations WHERE source_path = ?")
      .get(sessionPath) as { block_count: number };
    expect(conversation.block_count).toBe(4);
  });

  it("drains an oversized startup append without invoking the whole-file parser", async () => {
    const sessionPath = await makeCodexSession();
    await writeWithMtime(sessionPath, initialCodexRows(), 1);
    await triggerTargetedIngest({ transcriptPath: sessionPath, now: 1_000 });
    const conversation = db.prepare("SELECT id FROM conversations WHERE source_path = ?")
      .get(sessionPath) as { id: string };
    const sealedBase = db.prepare(`
      SELECT version.byte_length
        FROM conversation_sources source
        JOIN conversation_source_versions version ON version.id = source.current_version_id
       WHERE source.conversation_id = ?
    `).get(conversation.id) as { byte_length: number };

    const records: string[] = [];
    let appendedBytes = 0;
    while (appendedBytes <= TEST_APPEND_BATCH_BYTES + 1024 * 1024) {
      const record = assistantRow(`large-tail-${records.length}-${"x".repeat(4_000)}`, 3 + records.length);
      records.push(record);
      appendedBytes += Buffer.byteLength(record);
    }
    await appendWithMtime(sessionPath, records.join(""), 2);

    const fullParse = vi.spyOn(CodexParser.prototype, "parse").mockRejectedValue(
      new Error("unbounded whole-file reparse invoked"),
    );
    let capturedRanges: Array<{ byteStart: number; byteEnd: number; contentHash: string }> | undefined;
    vi.spyOn(ConversationSourceStore.prototype, "recordConversation").mockImplementation(async (input) => {
      if (input.sourceSnapshot?.kind === "append") {
        capturedRanges = input.sourceSnapshot.appendRanges;
      }
      return "test-source";
    });
    const appendBatchBytes: number[] = [];
    await triggerReconcileForTest({
      watchConfigs: watchConfigs(),
      log: (_level, event, fields) => {
        if (event === "ingestion_complete" && typeof fields?.appended_bytes === "number") {
          appendBatchBytes.push(fields.appended_bytes);
        }
      },
    });

    expect(fullParse).not.toHaveBeenCalled();
    expect(appendBatchBytes.length).toBeGreaterThan(1);
    expect(Math.max(...appendBatchBytes)).toBeLessThanOrEqual(TEST_APPEND_BATCH_BYTES);
    if (!capturedRanges) throw new Error("append range proof was not passed to the source store");
    expect(capturedRanges.length).toBeGreaterThan(1);
    expect(capturedRanges[0].byteStart).toBe(sealedBase.byte_length);
    for (let index = 1; index < capturedRanges.length; index += 1) {
      expect(capturedRanges[index].byteStart).toBe(capturedRanges[index - 1].byteEnd);
    }
    expect(capturedRanges.at(-1)?.byteEnd).toBe(fs.statSync(sessionPath).size);
    expect(db.prepare("SELECT block_count FROM conversations WHERE source_path = ?")
      .get(sessionPath)).toEqual({ block_count: 2 + records.length });
    expect(db.prepare("SELECT byte_offset, line_count FROM conversation_ingest_state WHERE file_path = ?")
      .get(sessionPath)).toEqual({
        byte_offset: fs.statSync(sessionPath).size,
        line_count: 3 + records.length,
      });
  });

  it("falls back to full parse after truncation or rewrite", async () => {
    const sessionPath = await makeCodexSession();
    await writeWithMtime(sessionPath, `${initialCodexRows()}${assistantRow("before", 3)}`, 1);
    await triggerTargetedIngest({ transcriptPath: sessionPath, now: 1_000 });
    const original = db.prepare(
      "SELECT id FROM conversations WHERE source_path = ? AND session_id = 'tailtest'",
    ).get(sessionPath) as { id: string };

    const rewritten = initialCodexRows("tailtest-rewritten").replace("hello", "rewritten hello");
    await writeWithMtime(sessionPath, `${rewritten}${assistantRow("after rewrite", 3)}`, 2);
    await triggerTargetedIngest({ transcriptPath: sessionPath, now: 2_000 });

    const conversation = db.prepare(`
      SELECT id, session_id, block_count FROM conversations
       WHERE source_path = ? AND session_id = 'tailtest-rewritten'
    `).get(sessionPath) as { id: string; session_id: string; block_count: number };
    expect(conversation).toMatchObject({ session_id: "tailtest-rewritten", block_count: 3 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM conversation_blocks WHERE conversation_id = ?")
      .get(conversation.id)).toEqual({ count: 0 });
    const sourcePage = await new ConversationSourceReader(db).readPage(conversation.id, { limit: 10 });
    expect(sourcePage.status).toBe("source");
    if (sourcePage.status === "source") expect(sourcePage.value.blocks[0].content).toBe("rewritten hello");
    expect(
      db.prepare("SELECT byte_offset FROM conversation_ingest_state WHERE file_path = ?")
        .get(sessionPath),
    ).toMatchObject({ byte_offset: fs.statSync(sessionPath).size });
    expect(db.prepare("SELECT block_count FROM conversations WHERE id = ?")
      .get(original.id)).toEqual({ block_count: 3 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM conversation_blocks WHERE conversation_id = ?")
      .get(original.id)).toEqual({ count: 0 });
  });

  it("detects a replacement with the exact previously indexed mtime", async () => {
    const sessionPath = await makeCodexSession();
    await writeWithMtime(sessionPath, initialCodexRows("same-mtime-owner-a"), 1);
    await triggerTargetedIngest({ transcriptPath: sessionPath, now: 1_000 });
    const indexedMtime = fs.statSync(sessionPath).mtimeMs;

    await fsp.writeFile(sessionPath, initialCodexRows("same-mtime-owner-b"), "utf8");
    await fsp.utimes(sessionPath, new Date(indexedMtime), new Date(indexedMtime));
    expect(fs.statSync(sessionPath).mtimeMs).toBe(indexedMtime);
    await triggerTargetedIngest({ transcriptPath: sessionPath, now: 2_000 });

    expect(db.prepare(
      "SELECT session_id FROM conversations WHERE source_path = ? ORDER BY session_id",
    ).all(sessionPath)).toEqual([
      { session_id: "same-mtime-owner-a" },
      { session_id: "same-mtime-owner-b" },
    ]);
  });

  it("does not fully parse a redundant same-mtime Codex watcher event", async () => {
    const sessionPath = await makeCodexSession();
    await writeWithMtime(sessionPath, initialCodexRows("same-mtime-unchanged"), 1);
    await triggerTargetedIngest({ transcriptPath: sessionPath, now: 1_000 });

    const readFileSpy = vi.spyOn(fsp, "readFile");
    await triggerTargetedIngest({ transcriptPath: sessionPath, now: 2_000 });

    expect(readFileSpy.mock.calls.some((call) => call[0] === sessionPath)).toBe(false);
    expect(db.prepare(
      "SELECT session_id FROM conversations WHERE source_path = ?",
    ).all(sessionPath)).toEqual([{ session_id: "same-mtime-unchanged" }]);
  });

  it("preserves fallback data when a source truncates at the exact indexed mtime", async () => {
    const sessionPath = await makeCodexSession();
    await writeWithMtime(sessionPath, initialCodexRows("same-mtime-truncation"), 1);
    await triggerTargetedIngest({ transcriptPath: sessionPath, now: 1_000 });
    const indexedMtime = fs.statSync(sessionPath).mtimeMs;
    const conversation = db.prepare(
      "SELECT id FROM conversations WHERE source_path = ?",
    ).get(sessionPath) as { id: string };
    const before = db.prepare(
      "SELECT id, content FROM conversation_blocks WHERE conversation_id = ? ORDER BY position",
    ).all(conversation.id);

    await fsp.writeFile(sessionPath, "", "utf8");
    await fsp.utimes(sessionPath, new Date(indexedMtime), new Date(indexedMtime));
    expect(fs.statSync(sessionPath).mtimeMs).toBe(indexedMtime);
    await triggerTargetedIngest({ transcriptPath: sessionPath, now: 2_000 });

    expect(db.prepare(
      "SELECT id, content FROM conversation_blocks WHERE conversation_id = ? ORDER BY position",
    ).all(conversation.id)).toEqual(before);
    expect(db.prepare(
      "SELECT availability FROM conversation_sources WHERE conversation_id = ?",
    ).get(conversation.id)).toEqual({ availability: "missing" });
  });

  it("reconcile detects a replacement with the exact indexed mtime", async () => {
    const sessionPath = await makeCodexSession();
    await writeWithMtime(sessionPath, initialCodexRows("reconcile-same-mtime-a"), 1);
    await triggerReconcileForTest({ watchConfigs: watchConfigs() });
    const indexedMtime = fs.statSync(sessionPath).mtimeMs;

    await fsp.writeFile(sessionPath, initialCodexRows("reconcile-same-mtime-b"), "utf8");
    await fsp.utimes(sessionPath, new Date(indexedMtime), new Date(indexedMtime));
    expect(fs.statSync(sessionPath).mtimeMs).toBe(indexedMtime);
    await triggerReconcileForTest({ watchConfigs: watchConfigs() });

    expect(db.prepare(
      "SELECT session_id FROM conversations WHERE source_path = ? ORDER BY session_id",
    ).all(sessionPath)).toEqual([
      { session_id: "reconcile-same-mtime-a" },
      { session_id: "reconcile-same-mtime-b" },
    ]);
  });

  it("reconcile does not reparse an unchanged known transcript", async () => {
    const sessionPath = await makeCodexSession();
    await writeWithMtime(sessionPath, initialCodexRows("reconcile-unchanged"), 1);
    await triggerReconcileForTest({ watchConfigs: watchConfigs() });
    const events: string[] = [];

    await triggerReconcileForTest({
      watchConfigs: watchConfigs(),
      log: (_level, event) => events.push(event),
    });

    expect(events).not.toContain("ingestion_complete");
    expect(events).not.toContain("conversation_source_snapshot_failed");
  });

  it("reparses only an exact requested old-epoch source without changing its sealed bytes", async () => {
    const sessionPath = await makeCodexSession();
    await writeWithMtime(sessionPath, initialCodexRows("reconcile-parser-upgrade"), 1);
    await triggerReconcileForTest({ watchConfigs: watchConfigs() });
    const before = db.prepare(`
      SELECT source.id, source.conversation_id, source.current_version_id, version.content_sha256
        FROM conversation_sources source
        JOIN conversation_source_aliases alias ON alias.source_id = source.id
        JOIN conversation_source_versions version ON version.id = source.current_version_id
       WHERE alias.path = ?
    `).get(sessionPath) as {
      id: string; conversation_id: string; current_version_id: string; content_sha256: string;
    };
    const previousParserVersion = "1";
    const previousNormalizationVersion = "1";
    db.prepare("UPDATE conversation_sources SET parser_version = ?, normalization_version = ? WHERE id = ?")
      .run(previousParserVersion, previousNormalizationVersion, before.id);
    db.prepare("UPDATE conversation_source_versions SET parser_version = ?, normalization_version = ? WHERE id = ?")
      .run(previousParserVersion, previousNormalizationVersion, before.current_version_id);

    await expect(ensureExactConversationFresh(db, before.conversation_id, {
      waitForFresh: false,
      scheduleReparse: () => { throw new Error("parser failed; retry later"); },
    })).rejects.toMatchObject({ code: "freshness_error", message: "parser failed; retry later" });

    let requestedPath: string | null = null;
    let reparse: ReturnType<typeof triggerExactPathIngest> | null = null;
    await expect(ensureExactConversationFresh(db, before.conversation_id, {
      waitForFresh: false,
      scheduleReparse: (filePath) => {
        requestedPath = filePath;
        reparse = triggerExactPathIngest(filePath);
        return true;
      },
    })).rejects.toMatchObject({ code: "freshness_pending" });
    expect(requestedPath).toBe(sessionPath);
    await reparse;

    const after = db.prepare(`
      SELECT current_version_id, parser_version, normalization_version FROM conversation_sources WHERE id = ?
    `).get(before.id) as { current_version_id: string; parser_version: string; normalization_version: string };
    expect(after.parser_version).toBe(CURRENT_CONVERSATION_SOURCE_EPOCHS.parserVersion);
    expect(after.normalization_version).toBe(CURRENT_CONVERSATION_SOURCE_EPOCHS.normalizationVersion);
    expect(after.current_version_id).toBe(before.current_version_id);
    expect(db.prepare("SELECT content_sha256, parser_version, normalization_version FROM conversation_source_versions WHERE id = ?")
      .get(before.current_version_id)).toEqual({
      content_sha256: before.content_sha256,
      parser_version: CURRENT_CONVERSATION_SOURCE_EPOCHS.parserVersion,
      normalization_version: CURRENT_CONVERSATION_SOURCE_EPOCHS.normalizationVersion,
    });
    expect((await new ConversationSourceReader(db).readPage(before.conversation_id)).status).toBe("source");
  });

  it("reports an exact parser failure instead of treating it as a successful reparse", async () => {
    const sessionPath = await makeCodexSession();
    await writeWithMtime(sessionPath, initialCodexRows("exact-parser-failure"), 1);
    await triggerExactPathIngest(sessionPath);
    const parser = vi.spyOn(CodexParser.prototype, "parse").mockRejectedValueOnce(new Error("parser failed"));
    await expect(triggerExactPathIngest(sessionPath)).rejects.toThrow("parser failed");
    parser.mockRestore();
    await expect(triggerExactPathIngest(sessionPath)).resolves.toMatchObject({ status: "ingested" });
  });

  it("does not warn when a touched already-source-backed conversation has no legacy payload to promote", async () => {
    const sessionPath = await makeCodexSession();
    const source = initialCodexRows("reconcile-source-backed");
    await writeWithMtime(sessionPath, source, 1);
    await triggerReconcileForTest({ watchConfigs: watchConfigs() });
    await writeWithMtime(sessionPath, source, 2);
    const events: string[] = [];

    await triggerReconcileForTest({
      watchConfigs: watchConfigs(),
      log: (_level, event) => events.push(event),
    });

    expect(events).not.toContain("conversation_source_projection_mismatch");
    expect(events).not.toContain("conversation_source_snapshot_failed");
  });

  it("reconcile preserves fallback data after same-mtime truncation", async () => {
    const sessionPath = await makeCodexSession();
    await writeWithMtime(sessionPath, initialCodexRows("reconcile-same-mtime-truncated"), 1);
    await triggerReconcileForTest({ watchConfigs: watchConfigs() });
    const indexedMtime = fs.statSync(sessionPath).mtimeMs;
    const conversation = db.prepare(
      "SELECT id FROM conversations WHERE source_path = ?",
    ).get(sessionPath) as { id: string };
    const before = db.prepare(
      "SELECT id, content FROM conversation_blocks WHERE conversation_id = ? ORDER BY position",
    ).all(conversation.id);

    await fsp.writeFile(sessionPath, "", "utf8");
    await fsp.utimes(sessionPath, new Date(indexedMtime), new Date(indexedMtime));
    expect(fs.statSync(sessionPath).mtimeMs).toBe(indexedMtime);
    await triggerReconcileForTest({ watchConfigs: watchConfigs() });

    expect(db.prepare(
      "SELECT id, content FROM conversation_blocks WHERE conversation_id = ? ORDER BY position",
    ).all(conversation.id)).toEqual(before);
    expect(db.prepare(`
      SELECT s.availability AS source_availability, v.availability AS version_availability
        FROM conversation_sources s
        JOIN conversation_source_versions v ON v.id = s.current_version_id
       WHERE s.conversation_id = ?
    `).get(conversation.id)).toEqual({
      source_availability: "missing",
      version_availability: "missing",
    });
  });

  it("preserves fallback bodies and source history while the source is empty or truncated", async () => {
    const sessionPath = await makeCodexSession();
    const original = initialCodexRows();
    await writeWithMtime(sessionPath, original, 1);
    await triggerTargetedIngest({ transcriptPath: sessionPath, now: 1_000 });

    const conversation = db.prepare("SELECT id FROM conversations WHERE source_path = ?")
      .get(sessionPath) as { id: string };
    const beforeBlocks = db.prepare(
      "SELECT id, content FROM conversation_blocks WHERE conversation_id = ? ORDER BY position",
    ).all(conversation.id);
    const beforeVersions = db.prepare(`
      SELECT COUNT(*) AS count FROM conversation_source_versions
       WHERE source_id = (SELECT id FROM conversation_sources WHERE conversation_id = ?)
    `).get(conversation.id);
    const beforeAliases = db.prepare(`
      SELECT alias, block_id FROM conversation_block_aliases
       WHERE block_id IN (SELECT id FROM conversation_structural_blocks WHERE conversation_id = ?)
       ORDER BY alias
    `).all(conversation.id);

    await writeWithMtime(sessionPath, "", 2);
    await triggerTargetedIngest({ transcriptPath: sessionPath, now: 2_000 });
    await writeWithMtime(sessionPath, initialCodexRows().split("\n", 1)[0] + "\n", 3);
    await triggerTargetedIngest({ transcriptPath: sessionPath, now: 3_000 });

    expect(db.prepare("SELECT id FROM conversations WHERE id = ?").get(conversation.id))
      .toBeDefined();
    expect(db.prepare(
      "SELECT id, content FROM conversation_blocks WHERE conversation_id = ? ORDER BY position",
    ).all(conversation.id)).toEqual(beforeBlocks);
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM conversation_source_versions
       WHERE source_id = (SELECT id FROM conversation_sources WHERE conversation_id = ?)
    `).get(conversation.id)).toEqual(beforeVersions);
    expect(db.prepare(`
      SELECT alias, block_id FROM conversation_block_aliases
       WHERE block_id IN (SELECT id FROM conversation_structural_blocks WHERE conversation_id = ?)
       ORDER BY alias
    `).all(conversation.id)).toEqual(beforeAliases);
    expect(db.prepare(
      "SELECT availability, unavailable_reason FROM conversation_sources WHERE conversation_id = ?",
    ).get(conversation.id)).toEqual({
      availability: "missing",
      unavailable_reason: "source parsed as empty or temporarily truncated",
    });
  });

  it("treats a reused path as an alias and preserves both conversation identities", async () => {
    const sessionPath = await makeCodexSession();
    await writeWithMtime(sessionPath, initialCodexRows("path-owner-a"), 1);
    await triggerTargetedIngest({ transcriptPath: sessionPath, now: 1_000 });
    const original = db.prepare(
      "SELECT id FROM conversations WHERE source_path = ? AND session_id = 'path-owner-a'",
    ).get(sessionPath) as { id: string };
    const originalBlocks = db.prepare(
      "SELECT id, content FROM conversation_blocks WHERE conversation_id = ? ORDER BY position",
    ).all(original.id);

    await writeWithMtime(sessionPath, initialCodexRows("path-owner-b"), 2);
    await triggerTargetedIngest({ transcriptPath: sessionPath, now: 2_000 });
    await appendWithMtime(sessionPath, assistantRow("current owner append", 3), 3);
    await triggerTargetedIngest({ transcriptPath: sessionPath, now: 3_000 });

    expect(db.prepare(
      "SELECT session_id FROM conversations WHERE source_path = ? ORDER BY session_id",
    ).all(sessionPath)).toEqual([
      { session_id: "path-owner-a" },
      { session_id: "path-owner-b" },
    ]);
    expect(db.prepare(
      "SELECT id, content FROM conversation_blocks WHERE conversation_id = ? ORDER BY position",
    ).all(original.id)).toEqual(originalBlocks);
    expect(db.prepare(
      "SELECT block_count FROM conversations WHERE source_path = ? AND session_id = 'path-owner-b'",
    ).get(sessionPath)).toEqual({ block_count: 3 });
    expect(db.prepare(
      "SELECT COUNT(*) AS count FROM conversation_sources WHERE conversation_id = ?",
    ).get(original.id)).toEqual({ count: 1 });
    expect(db.prepare(
      "SELECT availability, unavailable_reason FROM conversation_sources WHERE conversation_id = ?",
    ).get(original.id)).toEqual({
      availability: "missing",
      unavailable_reason: "source path reused by a distinct conversation identity",
    });
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM conversation_block_aliases
       WHERE block_id IN (SELECT id FROM conversation_structural_blocks WHERE conversation_id = ?)
    `).get(original.id)).toEqual({ count: originalBlocks.length });
  });
});
