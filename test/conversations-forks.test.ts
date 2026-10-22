import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { compressContent } from "../../src/compression.js";
import { migrate, openDb, setDb, type Db } from "../../src/db.js";
import { registerConversationRoutes } from "../../src/routes/conversations.js";
import { Router } from "../../src/server.js";

let tempDir = "";
let db: Db;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-conversations-forks-"));
  db = openDb(path.join(tempDir, "mandible.db"));
  migrate(db);
  setDb(db);
});

afterEach(() => {
  vi.restoreAllMocks();
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function insertConversation(id = "conv-fork"): void {
  const now = "2026-07-01T12:00:00.000Z";
  db.prepare(`INSERT INTO conversations (
    id, source, source_path, source_hash, source_mtime, title, started_at,
    session_id, created_at, updated_at
  ) VALUES (?, 'codex', '/tmp/conv.jsonl', 'hash', 0, 'Forked conversation', ?, 'session-1', ?, ?)`)
    .run(id, now, now, now);
}

function insertBlock(id: string, dagUuid: string, position: number, content: Buffer | string, compressed: number): void {
  db.prepare(`INSERT INTO conversation_blocks (
    id, conversation_id, type, role, content, compressed, position, timestamp,
    dag_uuid, dag_parent_uuid, metadata_json
  ) VALUES (?, 'conv-fork', 'assistant_message', 'assistant', ?, ?, ?, ?, ?, 'parent-1', '{}')`)
    .run(id, content, compressed, position, "2026-07-01T12:00:00.000Z", dagUuid);
}

describe("conversation browse and fork routes", () => {
  it("batches branch preview/count queries and decompresses previews asynchronously", async () => {
    insertConversation();
    insertBlock("block-a1", "child-a", 1, compressContent("Alpha compressed branch preview text"), 1);
    insertBlock("block-a2", "child-a", 2, "Alpha second block", 0);
    insertBlock("block-b1", "child-b", 3, "Beta uncompressed branch preview text", 0);
    insertBlock("block-c1", "child-c", 4, compressContent("Gamma compressed branch preview text"), 1);

    const prepareSpy = vi.spyOn(db, "prepare");
    const router = new Router();
    registerConversationRoutes(router);
    const response = await router.invoke({ method: "GET", url: "/api/conversations/conv-fork/forks" });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ forks: [{
      parent_dag_uuid: "parent-1",
      branches: [
        { dag_uuid: "child-a", first_text: "Alpha compressed branch preview text", block_count: 2 },
        { dag_uuid: "child-b", first_text: "Beta uncompressed branch preview text", block_count: 1 },
        { dag_uuid: "child-c", first_text: "Gamma compressed branch preview text", block_count: 1 },
      ],
    }] });
    const blockQueries = prepareSpy.mock.calls.map(([sql]) => String(sql)).filter((sql) => sql.includes("conversation_blocks"));
    expect(blockQueries.length).toBeLessThanOrEqual(4);
  });

  it("keeps transcript browsing passive", async () => {
    insertConversation("conv-browse");
    const router = new Router();
    registerConversationRoutes(router);
    const before = db.prepare("SELECT COUNT(*) AS count FROM conversation_control_state").get() as { count: number };
    const response = await router.invoke({ method: "GET", url: "/api/conversations/conv-browse" });
    const after = db.prepare("SELECT COUNT(*) AS count FROM conversation_control_state").get() as { count: number };

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ conversation: { id: "conv-browse" } });
    expect(after.count).toBe(before.count);
  });
});
