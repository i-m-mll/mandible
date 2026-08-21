import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import fsp from "node:fs/promises";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";

import { migrate, openDb, setDb, type Db } from "../src/db.js";
import { triggerReconcileForTest, triggerTargetedIngest } from "../src/ingestion.js";
import { decompressContent } from "../src/compression.js";
import { CodexParser } from "../src/parsers/codex.js";
import { ConversationSourceStore } from "../src/conversations/source-store.js";
import { ConversationSourceReader } from "../src/conversations/source-reader.js";

let tempDir = "";
let db: Db;
const TEST_APPEND_BATCH_BYTES = 16 * 1024 * 1024;
const TEST_HIGH_APPEND_OFFSET = 2_147_483_647 + 8192;

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
});

afterEach(() => {
  vi.restoreAllMocks();
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("incremental tail ingestion", () => {
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

    const records: string[] = [];
    let appendedBytes = 0;
    while (appendedBytes <= TEST_APPEND_BATCH_BYTES + 1024 * 1024) {
      const record = assistantRow(`large-tail-${records.length}-${"x".repeat(4_000)}`, 3 + records.length);
      records.push(record);
      appendedBytes += Buffer.byteLength(record);
    }
    await fsp.truncate(sessionPath, TEST_HIGH_APPEND_OFFSET);
    db.prepare(`
      UPDATE conversation_ingest_state
         SET byte_offset = ?, tail_hash = ?, partial_line = ''
       WHERE file_path = ?
    `).run(
      TEST_HIGH_APPEND_OFFSET,
      crypto.createHash("sha256").update(Buffer.alloc(4096)).digest("hex"),
      sessionPath,
    );
    await appendWithMtime(sessionPath, records.join(""), 2);

    const fullParse = vi.spyOn(CodexParser.prototype, "parse").mockRejectedValue(
      new Error("unbounded whole-file reparse invoked"),
    );
    vi.spyOn(ConversationSourceStore.prototype, "recordConversation").mockResolvedValue("test-source");
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
