import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getConversationSearchCache } from "../src/conversations/search-cache.js";
import { migrate, openDb, setDb, type Db } from "../src/db.js";
import { registerConversationRoutes } from "../src/routes/conversations.js";
import { Router } from "../src/server.js";

let tempDir: string;
let db: Db;
const revokedCanary = `mandible_pat_${"R".repeat(43)}`;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-conversation-search-route-"));
  process.env.MANDIBLE_CONVERSATION_CACHE_DB = path.join(tempDir, "cache", "search.db");
  db = openDb(path.join(tempDir, "mandible.db"));
  migrate(db);
  setDb(db);
  const insertConversation = db.prepare(`INSERT INTO conversations
    (id, source, source_path, source_hash, source_mtime, title, started_at, session_id,
     block_count, tags, created_at, updated_at)
    VALUES (?, 'codex', ?, ?, 1, ?, '2026-08-17', ?, 1, '[]', '2026-08-17', '2026-08-17')`);
  insertConversation.run("title-only", "/tmp/title", "hash-title", "Needle in title", "session-title");
  insertConversation.run("body-only", "/tmp/body", "hash-body", "Unrelated title", "session-body");
  insertConversation.run("revoked-canary", "/tmp/canary", "hash-canary", "Canary title", "session-canary");
  db.prepare(`INSERT INTO conversation_blocks
    (id, conversation_id, type, role, content, compressed, position, metadata_json)
    VALUES (?, ?, 'assistant_message', 'assistant', ?, 0, 0, '{}')`)
    .run("block-title", "title-only", "no body match");
  db.prepare(`INSERT INTO conversation_blocks
    (id, conversation_id, type, role, content, compressed, position, metadata_json)
    VALUES (?, ?, 'assistant_message', 'assistant', ?, 0, 0, '{}')`)
    .run("block-body", "body-only", "A Needle across the body");
  db.prepare(`INSERT INTO conversation_blocks
    (id, conversation_id, type, role, content, compressed, position, metadata_json)
    VALUES (?, ?, 'assistant_message', 'assistant', ?, 0, 0, '{}')`)
    .run("block-canary", "revoked-canary", `before ${revokedCanary} after`);
});

afterEach(() => {
  getConversationSearchCache(db).close();
  db.close();
  delete process.env.MANDIBLE_CONVERSATION_CACHE_DB;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("conversation full-text API parity", () => {
  it("makes the list full_text path reach exact body search while title mode stays title-only", async () => {
    const router = new Router();
    registerConversationRoutes(router);

    const title = await router.invoke({ method: "GET", url: "/api/conversations?search=Needle" });
    expect(title.body).toMatchObject({ conversations: [{ id: "title-only" }], total: 1 });

    const full = await router.invoke({ method: "GET", url: "/api/conversations?search=Needle&full_text=true" });
    expect(full.body).toMatchObject({
      conversations: [{ id: "body-only" }],
      total: 1,
      search_metrics: { exact_verified_blocks: 3 },
    });

    const dedicated = await router.invoke({ method: "GET", url: "/api/conversations/search?q=Needle" });
    expect(dedicated.body).toMatchObject({
      results: [{ conversation: { id: "body-only" }, block: { id: "block-body", content: "" } }],
      total: 1,
    });

    const canary = await router.invoke({ method: "GET", url: "/api/conversations/search?q=before" });
    expect(JSON.stringify(canary.body)).not.toContain(revokedCanary);
    expect(canary.body).toMatchObject({
      results: [{ conversation: { id: "revoked-canary" }, snippet: expect.stringContaining("[mandible-credential:unverified#1]") }],
    });
    for (const suffix of ["", "-wal", "-shm"]) {
      const cacheFile = `${process.env.MANDIBLE_CONVERSATION_CACHE_DB}${suffix}`;
      if (fs.existsSync(cacheFile)) expect(fs.readFileSync(cacheFile).includes(Buffer.from(revokedCanary))).toBe(false);
    }
  });
});
