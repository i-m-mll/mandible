import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConversationSourceStore } from "../src/conversations/source-store.js";
import { CURRENT_CONVERSATION_SOURCE_EPOCHS } from "../src/conversations/source-types.js";
import { setDb, type Db } from "../src/db.js";
import { registerConversationRoutes } from "../src/routes/conversations.js";
import { Router } from "../src/server.js";
import { migratedMemoryDb } from "./helpers/ledger-fixtures.js";

let tempDir = "";
let db: Db;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-conversation-blocks-route-"));
  db = migratedMemoryDb();
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

function insertIndexedConversation(count: number): void {
  const now = "2026-07-08T12:00:00.000Z";
  db.prepare(
    `INSERT INTO conversations (
      id, source, source_path, source_hash, source_mtime, title, started_at,
      session_id, created_at, updated_at, block_count
    ) VALUES ('conv-indexed', 'codex', '/tmp/indexed.jsonl', 'hash', 0,
      'Indexed conversation', ?, 'session-indexed', ?, ?, ?)`,
  ).run(now, now, now, count);
  const insert = db.prepare(
    `INSERT INTO conversation_blocks (
      id, conversation_id, type, role, content, compressed, position, timestamp, metadata_json
    ) VALUES (?, 'conv-indexed', ?, ?, ?, 0, ?, ?, '{}')`,
  );
  db.transaction(() => {
    for (let position = 1; position <= count; position += 1) {
      const user = position % 10 === 1;
      insert.run(
        `indexed-${position}`,
        user ? "user_message" : "assistant_message",
        user ? "user" : "assistant",
        `content ${position}`,
        position,
        now,
      );
    }
  })();
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

describe("indexed conversation position window", () => {

  it("expands the default tail to include the complete latest turn within the cap", async () => {
    insertIndexedConversation(260);
    db.prepare("DELETE FROM conversation_blocks WHERE conversation_id = 'conv-indexed' AND type = 'user_message' AND position > 1").run();

    const router = new Router();
    registerConversationRoutes(router);
    const response = await router.invoke({ method: "GET", url: "/api/conversations/conv-indexed" });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      total: 235,
      window: { start_position: 1, end_position: 260, has_before: false, has_after: false, limit: 235 },
    });
    expect((response.body as { blocks: Array<{ position: number }> }).blocks[0]?.position).toBe(1);
  });

  it("refuses an unverified source tail when its structural index is incomplete", async () => {
    const now = "2026-07-08T12:00:00.000Z";
    db.prepare(
      `INSERT INTO conversations (
        id, source, source_path, source_hash, source_mtime, title, started_at,
        session_id, created_at, updated_at, block_count
      ) VALUES ('conv-projected', 'codex', '/tmp/projected.jsonl', 'hash', 0,
        'Projected conversation', ?, 'session-projected', ?, ?, 10000)`,
    ).run(now, now, now);
    const insert = db.prepare(
      `INSERT INTO conversation_blocks (
        id, conversation_id, type, role, content, compressed, position, timestamp,
        metadata_json
      ) VALUES (?, 'conv-projected', 'assistant_message', 'assistant', ?, 0, ?, ?, '{}')`,
    );
    for (let position = 9997; position <= 9999; position += 1) {
      insert.run(`projected-${position}`, `content ${position}`, position, now);
    }
    const sourcePath = path.join(
      tempDir,
      ".codex/sessions/2026/07/08/rollout-2026-07-08T12-00-00-session-projected.jsonl",
    );
    fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
    fs.writeFileSync(sourcePath, "{}\n{}\n{}\n");
    const sourceStore = new ConversationSourceStore(db);
    await sourceStore.recordConversation({
      conversationId: "conv-projected",
      provider: "codex",
      nativeSessionId: "session-projected",
      filePath: sourcePath,
      ...CURRENT_CONVERSATION_SOURCE_EPOCHS,
    });

    const router = new Router();
    registerConversationRoutes(router);
    const response = await router.invoke({
      method: "GET",
      url: "/api/conversations/conv-projected?target=initial",
    });

    expect(response.status, JSON.stringify(response.body)).toBe(503);
    expect(response.body).toMatchObject({ error: "freshness_error" });
    expect(db.prepare("SELECT COUNT(*) AS count FROM conversation_blocks WHERE conversation_id = 'conv-projected'").get()).toEqual({ count: 3 });
  });

  it("resolves stable logical turn ids and rejects unknown or non-boundary anchors", async () => {
    insertIndexedConversation(10_000);
    const router = new Router();
    registerConversationRoutes(router);

    const turn = await router.invoke({
      method: "GET",
      url: "/api/conversations/conv-indexed?turn=indexed-5001&limit=40",
    });
    expect(turn.status).toBe(200);
    expect(turn.body).toMatchObject({
      target: { kind: "turn", block_id: "indexed-5001", turn_id: "indexed-5001", position: 5001 },
    });

    for (const url of [
      "/api/conversations/conv-indexed?block=missing",
      "/api/conversations/conv-indexed?turn=missing",
      "/api/conversations/conv-indexed?turn=indexed-5005",
      "/api/conversations/conv-indexed?position=10001",
    ]) {
      const response = await router.invoke({ method: "GET", url });
      expect(response.status).toBe(404);
      expect(response.body).toHaveProperty("error");
    }
  });
});
