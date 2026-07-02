import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { migrate, openDb, setDb, type Db } from "../src/db.js";
import { triggerTargetedIngest } from "../src/ingestion.js";
import { decompressContent } from "../src/compression.js";

let tempDir = "";
let db: Db;

function row(record: unknown): string {
  return `${JSON.stringify(record)}\n`;
}

async function makeCodexSession(): Promise<string> {
  const sessionDir = path.join(tempDir, "home", ".codex", "sessions", "2026", "07", "02");
  await fsp.mkdir(sessionDir, { recursive: true });
  return path.join(sessionDir, "rollout-2026-07-02T00-00-00-tailtest.jsonl");
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
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM conversation_blocks WHERE conversation_id = ?")
        .get(conversation.id),
    ).toMatchObject({ count: 3 });
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

  it("falls back to full parse after truncation or rewrite", async () => {
    const sessionPath = await makeCodexSession();
    await writeWithMtime(sessionPath, `${initialCodexRows()}${assistantRow("before", 3)}`, 1);
    await triggerTargetedIngest({ transcriptPath: sessionPath, now: 1_000 });

    const rewritten = initialCodexRows("tailtest-rewritten").replace("hello", "rewritten hello");
    await writeWithMtime(sessionPath, `${rewritten}${assistantRow("after rewrite", 3)}`, 2);
    await triggerTargetedIngest({ transcriptPath: sessionPath, now: 2_000 });

    const conversation = db.prepare("SELECT id, session_id, block_count FROM conversations WHERE source_path = ?")
      .get(sessionPath) as { id: string; session_id: string; block_count: number };
    expect(conversation).toMatchObject({ session_id: "tailtest-rewritten", block_count: 3 });
    const firstBlock = db.prepare(
      "SELECT content, compressed FROM conversation_blocks WHERE conversation_id = ? ORDER BY position ASC LIMIT 1",
    ).get(conversation.id) as { content: Buffer | string; compressed: number };
    expect(decompressContent(firstBlock.content, firstBlock.compressed === 1)).toBe("rewritten hello");
    expect(
      db.prepare("SELECT byte_offset FROM conversation_ingest_state WHERE file_path = ?")
        .get(sessionPath),
    ).toMatchObject({ byte_offset: fs.statSync(sessionPath).size });
  });
});
