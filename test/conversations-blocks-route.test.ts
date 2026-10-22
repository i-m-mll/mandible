import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConversationSourceStore } from "../src/conversations/source-store.js";
import { CURRENT_CONVERSATION_SOURCE_EPOCHS } from "../src/conversations/source-types.js";
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
  it("keeps a reasoning title in compact display data and marks title-only leaves inert", async () => {
    insertIndexedConversation(3);
    const reasoning = (content: string, position: number): void => {
      db.prepare(`UPDATE conversation_blocks SET type = 'thinking', content = ?, metadata_json = ?
        WHERE conversation_id = 'conv-indexed' AND position = ?`).run(content, JSON.stringify({
        source_event_type: "reasoning_summary",
        chat_item: { type: "activity", activity_kind: "reasoning-summary", parts: [{ type: "text", text: content }] },
      }), position);
    };
    reasoning("Check the source records", 2);
    reasoning("Review the grouped rows\nA longer explanation stays lazy", 3);

    const router = new Router();
    registerConversationRoutes(router);
    const response = await router.invoke({ method: "GET", url: "/api/conversations/conv-indexed?view=display" });
    expect(response.status).toBe(200);
    const blocks = (response.body as { blocks: Array<{ position: number; content: string; metadata_json: string; details_loaded?: boolean }> }).blocks;
    const compact = blocks.filter((block) => block.position >= 2).map((block) => ({
      content: block.content,
      detailsLoaded: block.details_loaded,
      metadata: JSON.parse(block.metadata_json),
    }));
    expect(compact).toMatchObject([
      { content: "Check the source records", detailsLoaded: false, metadata: {
        display_has_body: false, chat_item: { parts: [{ text: "Check the source records" }] },
      } },
      { content: "Review the grouped rows", detailsLoaded: false, metadata: {
        display_has_body: true, chat_item: { parts: [{ text: "Review the grouped rows" }] },
      } },
    ]);
  });

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

  it("uses the block primary key and conversation-position index for exact resolution", () => {
    insertIndexedConversation(10_000);
    const blockPlan = db.prepare(
      "EXPLAIN QUERY PLAN SELECT * FROM conversation_blocks WHERE conversation_id = ? AND id = ?",
    ).all("conv-indexed", "indexed-5000") as Array<{ detail: string }>;
    const positionPlan = db.prepare(
      "EXPLAIN QUERY PLAN SELECT * FROM conversation_blocks WHERE conversation_id = ? AND position = ?",
    ).all("conv-indexed", 5000) as Array<{ detail: string }>;
    expect(blockPlan.map((row) => row.detail).join(" ")).toMatch(/sqlite_autoindex_conversation_blocks_1|PRIMARY KEY/);
    expect(positionPlan.map((row) => row.detail).join(" ")).toMatch(/conversation_id=.*position=|sqlite_autoindex_conversation_blocks_2/);
  });

  it("keeps initial, exact start, middle, and latest responses bounded at 10k scale", async () => {
    insertIndexedConversation(10_000);
    const router = new Router();
    registerConversationRoutes(router);

    const initial = await router.invoke({ method: "GET", url: "/api/conversations/conv-indexed" });
    expect(initial.status).toBe(200);
    expect(initial.body).toMatchObject({
      revision: 10_000,
      total: 10_000,
      target: { kind: "initial", position: 10_000, block_id: "indexed-10000", turn_id: "indexed-9992" },
      window: { start_position: 9841, end_position: 10_000, has_before: true, has_after: false, after_count: 0, limit: 160 },
    });
    expect((initial.body as { blocks: unknown[] }).blocks).toHaveLength(160);

    const display = await router.invoke({ method: "GET", url: "/api/conversations/conv-indexed?view=display&position=5000&limit=80" });
    expect(display.status).toBe(200);
    expect(display.body).toMatchObject({ total: 10_000, target: { position: 5000 } });
    expect((display.body as { blocks: unknown[] }).blocks).toHaveLength(80);

    const structure = await router.invoke({ method: "GET", url: "/api/conversations/conv-indexed/structure" });
    expect(structure.status).toBe(200);
    expect(structure.body).toMatchObject({ total: 10_000 });
    expect((structure.body as { rows: unknown[] }).rows).toHaveLength(10_000);

    const start = await router.invoke({
      method: "GET",
      url: "/api/conversations/conv-indexed?position=1&limit=80",
    });
    expect(start.body).toMatchObject({
      target: { kind: "position", position: 1, block_id: "indexed-1", turn_id: "indexed-1" },
      window: { start_position: 1, has_before: false, has_after: true, after_count: 9920, limit: 80 },
    });
    expect((start.body as { blocks: unknown[] }).blocks).toHaveLength(80);

    const middle = await router.invoke({
      method: "GET",
      url: "/api/conversations/conv-indexed?block=indexed-5005&limit=101",
    });
    expect(middle.body).toMatchObject({
      target: { kind: "block", position: 5005, block_id: "indexed-5005", turn_id: "indexed-5002" },
      window: { start_position: 4955, end_position: 5055, has_before: true, has_after: true, after_count: 4945, limit: 101 },
    });
    expect((middle.body as { blocks: unknown[] }).blocks).toHaveLength(101);

    const latest = await router.invoke({
      method: "GET",
      url: "/api/conversations/conv-indexed?target=latest&limit=25",
    });
    expect(latest.body).toMatchObject({
      target: { kind: "latest", position: 10_000 },
      window: { start_position: 9976, end_position: 10_000, has_after: false, after_count: 0, limit: 25 },
    });
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
