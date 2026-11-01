import { inlineLedgerReader } from "../src/ledger-reads/index.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { sparseConversationBlockId } from "../src/conversations/structure-cache.js";
import { nativeSearchSource } from "./helpers/search-native-source.js";
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

async function source(count: number) {
  const now = "2026-07-08T12:00:00.000Z";
  db.prepare(`INSERT INTO conversations (id, source, source_path, source_hash, source_mtime,
    title, started_at, session_id, created_at, updated_at) VALUES
    ('native', 'codex', '/pending.jsonl', 'hash', 0, 'Native conversation', ?, 'native', ?, ?)`)
    .run(now, now, now);
  await nativeSearchSource(db, tempDir, "native", Array.from({ length: count }, (_, position) => ({
    role: position % 10 === 0 ? "user" as const : "assistant" as const, text: `content ${position}`,
  })));
}

it("caps native pages and resolves current positional anchors", async () => {
  await source(600);
  const router = new Router();
  registerConversationRoutes(router, inlineLedgerReader());
  const first = await router.invoke({ method: "GET", url: "/api/conversations/native/blocks?limit=999" });
  expect(first.status).toBe(200);
  expect(first.body).toMatchObject({ total: 600, offset: 0, limit: 500, truncated: true });
  const second = await router.invoke({ method: "GET", url: "/api/conversations/native/blocks?limit=999&offset=500" });
  expect(second.status).toBe(200);
  expect(second.body).toMatchObject({ total: 600, offset: 500, limit: 500, truncated: false });
  expect((second.body as { blocks: Array<{ position: number }> }).blocks).toHaveLength(100);
  expect((second.body as { blocks: Array<{ position: number }> }).blocks[0].position).toBe(500);
  const turnId = sparseConversationBlockId("native", 500);
  const turn = await router.invoke({ method: "GET", url: `/api/conversations/native?turn=${encodeURIComponent(turnId)}&limit=40` });
  expect(turn.status).toBe(200);
  expect(turn.body).toMatchObject({ target: { kind: "turn", block_id: turnId, position: 500 } });
  const snapshot = turn.body as { position_space_id: string; publication_revision: number; source_version_id: string };
  expect(snapshot.position_space_id).toBeTruthy();
  const structure = await router.invoke({ method: 'GET', url: '/api/conversations/native/structure' });
  expect(structure.body).toMatchObject({ position_space_id: snapshot.position_space_id,
    publication_revision: snapshot.publication_revision, source_version_id: snapshot.source_version_id });
  for (const route of ['?position=500&limit=1', '/structure?limit=1']) {
    const stale = await router.invoke({ method: 'GET', url: `/api/conversations/native${route}&expected_position_space_id=obsolete` });
    expect(stale).toMatchObject({ status: 409, body: { code: 'position_space_changed', position_space_id: snapshot.position_space_id } });
  }
  for (const query of ["block=retired-id", "position=601"]) {
    expect((await router.invoke({ method: "GET", url: `/api/conversations/native?${query}` })).status).toBe(404);
  }
});
