import { nativeSearchSource } from "./helpers/search-native-source.js";
import { inlineLedgerReader } from "../src/ledger-reads/index.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setDb, type Db } from "../src/db.js";
import { registerConversationRoutes } from "../src/routes/conversations.js";
import { Router } from "../src/server.js";
import { migratedMemoryDb } from "./helpers/ledger-fixtures.js";

let tempDir = "";
let db: Db;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-conversations-forks-"));
  db = migratedMemoryDb();
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
  ) VALUES (?, 'codex', '/tmp/conv.jsonl', 'hash', 0, 'Forked conversation', ?, ?, ?, ?)`)
    .run(id, now, id, now, now);
}

describe("conversation browse routes", () => {
  it("keeps transcript browsing passive", async () => {
    insertConversation("conv-browse");
    await nativeSearchSource(db, tempDir, "conv-browse", "passive native transcript");
    const router = new Router();
    registerConversationRoutes(router, inlineLedgerReader());
    const before = db.prepare("SELECT COUNT(*) AS count FROM conversation_control_state").get() as { count: number };
    const response = await router.invoke({ method: "GET", url: "/api/conversations/conv-browse" });
    const after = db.prepare("SELECT COUNT(*) AS count FROM conversation_control_state").get() as { count: number };

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.body).toMatchObject({ conversation: { id: "conv-browse" } });
    expect(after.count).toBe(before.count);
  });
});
