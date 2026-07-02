import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { compressContent } from "../src/compression.js";
import { migrate, openDb, setDb, type Db } from "../src/db.js";
import { registerConversationRoutes } from "../src/routes/conversations.js";
import { Router } from "../src/server.js";

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

function insertConversation(): void {
  const now = "2026-07-01T12:00:00.000Z";
  db.prepare(
    `INSERT INTO conversations (
      id, source, source_path, source_hash, source_mtime, title, started_at,
      session_id, created_at, updated_at
    ) VALUES (
      'conv-fork', 'codex', '/tmp/conv.jsonl', 'hash', 0, 'Forked conversation',
      ?, 'session-1', ?, ?
    )`,
  ).run(now, now, now);
}

function insertConversationWithSource(id: string, sourcePath: string, sourceMtime: number): void {
  const now = "2026-07-01T12:00:00.000Z";
  db.prepare(
    `INSERT INTO conversations (
      id, source, source_path, source_hash, source_mtime, title, started_at,
      session_id, created_at, updated_at
    ) VALUES (?, 'claude_code', ?, 'hash', ?, 'Conversation lifecycle', ?, 'provider-1', ?, ?)`,
  ).run(id, sourcePath, sourceMtime, now, now, now);

  db.prepare(
    `INSERT INTO conversation_blocks (
      id, conversation_id, type, role, content, compressed, position, timestamp,
      dag_uuid, dag_parent_uuid, metadata_json
    ) VALUES (?, ?, 'assistant_message', 'assistant', 'hello', 0, 1, ?, 'dag-1', NULL, '{}')`,
  ).run(`${id}-block`, id, now);
}

function insertBlock(id: string, dagUuid: string, position: number, content: Buffer | string, compressed: number): void {
  db.prepare(
    `INSERT INTO conversation_blocks (
      id, conversation_id, type, role, content, compressed, position, timestamp,
      dag_uuid, dag_parent_uuid, metadata_json
    ) VALUES (?, 'conv-fork', 'assistant_message', 'assistant', ?, ?, ?, ?, ?, 'parent-1', '{}')`,
  ).run(id, content, compressed, position, "2026-07-01T12:00:00.000Z", dagUuid);
}

describe("conversation fork routes", () => {
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
    expect(response.body).toEqual({
      forks: [{
        parent_dag_uuid: "parent-1",
        branches: [
          { dag_uuid: "child-a", first_text: "Alpha compressed branch preview text", block_count: 2 },
          { dag_uuid: "child-b", first_text: "Beta uncompressed branch preview text", block_count: 1 },
          { dag_uuid: "child-c", first_text: "Gamma compressed branch preview text", block_count: 1 },
        ],
      }],
    });

    const conversationBlockQueries = prepareSpy.mock.calls
      .map(([sql]) => String(sql))
      .filter((sql) => sql.includes("conversation_blocks"));
    expect(conversationBlockQueries.length).toBeLessThanOrEqual(4);
  });

  it("does not spawn while browsing conversation details", async () => {
    insertConversationWithSource("conv-browse", "/tmp/missing-mandible-transcript.jsonl", 0);
    const router = new Router();
    const manager = { create: vi.fn(), getAll: vi.fn(() => []) };
    registerConversationRoutes(router, manager as never);

    const response = await router.invoke({ method: "GET", url: "/api/conversations/conv-browse" });

    expect(response.status).toBe(200);
    expect(manager.create).not.toHaveBeenCalled();
    expect(response.body).toMatchObject({
      conversation: {
        id: "conv-browse",
        attach_state: { kind: "resumable" },
      },
    });
  });

  it("guards resume when the transcript was recently modified", async () => {
    const transcriptPath = path.join(tempDir, "live.jsonl");
    fs.writeFileSync(transcriptPath, "{}\n");
    const now = Date.now();
    fs.utimesSync(transcriptPath, new Date(now), new Date(now));
    insertConversationWithSource("conv-live", transcriptPath, now);

    const router = new Router();
    const manager = { create: vi.fn(), getAll: vi.fn(() => []) };
    registerConversationRoutes(router, manager as never);

    const response = await router.invoke({
      method: "POST",
      url: "/api/conversations/conv-live/resume",
      body: { message_dag_uuid: "dag-1" },
    });

    expect(response.status).toBe(409);
    expect(manager.create).not.toHaveBeenCalled();
    expect(response.body).toMatchObject({
      error: "resume_conflict",
      reason: "transcript-recent",
      attach_state: { kind: "live-external" },
    });
  });

  it("reuses an owned live session instead of spawning another resume", async () => {
    insertConversationWithSource("conv-owned", "/tmp/missing-mandible-transcript.jsonl", 0);
    const router = new Router();
    const manager = {
      create: vi.fn(),
      getAll: vi.fn(() => [{
        meta: {
          id: "console-owned",
          provider_session_id: "provider-1",
          status: "running",
        },
      }]),
    };
    registerConversationRoutes(router, manager as never);

    const response = await router.invoke({
      method: "POST",
      url: "/api/conversations/conv-owned/resume",
      body: { message_dag_uuid: "dag-1" },
    });

    expect(response.status).toBe(200);
    expect(manager.create).not.toHaveBeenCalled();
    expect(response.body).toMatchObject({
      console_session_id: "console-owned",
      attach_state: { kind: "live-owned" },
    });
  });
});
