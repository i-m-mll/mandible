import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrate, openDb, setDb, type Db } from "../src/db.js";
import { registerConversationRoutes } from "../src/routes/conversations.js";
import { Router } from "../src/server.js";

let tempDir = "";
let db: Db;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-conversation-blocks-route-"));
  db = openDb(path.join(tempDir, "mandible.db"));
  migrate(db);
  setDb(db);
});

afterEach(() => {
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function insertConversationWithBlocks(count: number): void {
  const now = "2026-07-08T12:00:00.000Z";
  db.prepare(
    `INSERT INTO conversations (
      id, source, source_path, source_hash, source_mtime, title, started_at,
      session_id, created_at, updated_at, block_count
    ) VALUES (
      'conv-long', 'codex', '/tmp/long.jsonl', 'hash', 0, 'Long conversation',
      ?, 'session-long', ?, ?, ?
    )`,
  ).run(now, now, now, count);

  const insert = db.prepare(
    `INSERT INTO conversation_blocks (
      id, conversation_id, type, role, content, compressed, position, timestamp,
      metadata_json
    ) VALUES (?, 'conv-long', 'assistant_message', 'assistant', ?, 0, ?, ?, '{}')`,
  );
  const tx = db.transaction(() => {
    for (let index = 1; index <= count; index += 1) {
      insert.run(`block-${index}`, `block content ${index}`, index, now);
    }
  });
  tx();
}

describe("conversation blocks route pagination", () => {
  it("caps large limits, accepts explicit offsets, and reports truncation metadata", async () => {
    insertConversationWithBlocks(600);
    const router = new Router();
    registerConversationRoutes(router);

    const first = await router.invoke({
      method: "GET",
      url: "/api/conversations/conv-long/blocks?limit=999",
    });
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({
      total: 600,
      offset: 0,
      page: 1,
      limit: 500,
      requested_limit: 999,
      cap: 500,
      pages: 2,
      truncated: true,
    });
    expect((first.body as { blocks: unknown[] }).blocks).toHaveLength(500);

    const second = await router.invoke({
      method: "GET",
      url: "/api/conversations/conv-long/blocks?limit=999&offset=500",
    });
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({
      total: 600,
      offset: 500,
      page: 2,
      limit: 500,
      requested_limit: 999,
      cap: 500,
      pages: 2,
      truncated: false,
    });
    expect((second.body as { blocks: Array<{ id: string; position: number }> }).blocks).toHaveLength(100);
    expect((second.body as { blocks: Array<{ id: string; position: number }> }).blocks[0])
      .toMatchObject({ id: "block-501", position: 501 });
  });
});
