import { HANDLER_TURN_BUDGET_MS } from "../src/runtime-health-contract.js";
import { workerLedgerReaderPool, inlineLedgerReader } from "../src/ledger-reads/index.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { zstdCompressSync } from "node:zlib";
import SqliteDatabase from "../src/sqlite.ts";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ClientAuthenticator } from "../src/client-auth/authenticator.js";
import { getConversationSearchCache } from "../src/conversations/search-cache.js";
import { ConversationSourceStore } from "../src/conversations/source-store.js";
import { sparseConversationBlockId } from "../src/conversations/structure-cache.js";
import { configureIngestionWorker, ingestBatchForWorker, stopIngestionGracefully } from "../src/ingestion.js";
import { CURRENT_CONVERSATION_SOURCE_EPOCHS } from "../src/conversations/source-types.js";
import { resetCredentialLeakScanCache } from "../src/credential-leak-scan.js";
import { setDb, type Db } from "../src/db.js";
import { CodexParser } from "../src/parsers/codex.js";
import type { ParseResult } from "../src/parsers/types.js";
import { registerConversationRoutes } from "../src/routes/conversations.js";
import { Router } from "../src/server.js";
import { revokeCredential, setupOperator } from "../src/users/store.js";
import { managedSearchSource } from "./helpers/search-managed-source.js";
import { getFullTextSearchJobs } from "../src/conversations/full-text-search-jobs.js";
import { migratedMemoryDb } from "./helpers/ledger-fixtures.js";

let tempDir: string;
let db: Db;
const revokedCanary = `mandible_pat_${"R".repeat(43)}`;
const unverifiedCanary = `mandible_pat_${"U".repeat(43)}`;

function upsertCodexThreadMetadata(input: {
  sourcePath: string;
  nativeSessionId: string;
  title: string;
}): void {
  const codexRoot = input.sourcePath.slice(0, input.sourcePath.indexOf(`${path.sep}sessions${path.sep}`));
  const sourceMtimeMs = Math.ceil(fs.statSync(input.sourcePath).mtimeMs);
  const state = new SqliteDatabase(path.join(codexRoot, "state_5.sqlite"));
  try {
    state.exec(`
      CREATE TABLE IF NOT EXISTS threads (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        rollout_path TEXT NOT NULL,
        updated_at INTEGER NOT NULL,
        updated_at_ms INTEGER
      )
    `);
    state.prepare(`
      INSERT INTO threads (id, title, rollout_path, updated_at, updated_at_ms)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        rollout_path = excluded.rollout_path,
        updated_at = excluded.updated_at,
        updated_at_ms = excluded.updated_at_ms
    `).run(
      input.nativeSessionId,
      input.title,
      input.sourcePath,
      Math.floor(sourceMtimeMs / 1000),
      sourceMtimeMs,
    );
  } finally {
    state.close();
  }
}

beforeEach(async () => {
  resetCredentialLeakScanCache();
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-conversation-search-route-"));
  process.env.MANDIBLE_CONVERSATION_CACHE_DB = path.join(tempDir, "cache", "search.db");
  db = migratedMemoryDb();
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
  await managedSearchSource(db,path.join(tempDir,"managed"),"title-only","no body match","block-title");
  await managedSearchSource(db,path.join(tempDir,"managed"),"body-only","A Needle across the body","block-body");
  await managedSearchSource(db,path.join(tempDir,"managed"),"revoked-canary",`before ${revokedCanary} after`,"block-canary");
});

async function settled(router:Router,input:Parameters<Router["invoke"]>[0]) {
  let result=await router.invoke(input);
  const deadline=Date.now()+10_000;
  while(result.status===202 && Date.now()<deadline) {
    const pending=result.body as {search_id:string;observer_token:string};
    await new Promise<void>(resolve=>setImmediate(resolve));
    const url=new URL(input.url,"http://localhost");
    url.searchParams.set("search_id",pending.search_id);
    url.searchParams.set("observer_token",pending.observer_token);
    result=await router.invoke({...input,url:`${url.pathname}${url.search}`});
  }
  return result;
}

afterEach(() => {
  getFullTextSearchJobs(db).close();
  getConversationSearchCache(db).close();
  db.close();
  delete process.env.MANDIBLE_CONVERSATION_CACHE_DB;
  resetCredentialLeakScanCache();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

async function insertSourceBackedConversation(
  conversationId: string,
  sourcePath: string,
  rows: Record<string, unknown>[],
  compressed = false,
): Promise<ParseResult> {
  fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
  fs.writeFileSync(sourcePath, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
  const parsed = await new CodexParser().parse(sourcePath);
  if (!parsed) throw new Error("source-backed route fixture did not parse");
  upsertCodexThreadMetadata({
    sourcePath,
    nativeSessionId: parsed.conversation.session_id,
    title: `Provider title for ${conversationId}`,
  });
  db.prepare(`INSERT INTO conversations
    (id, source, source_path, source_hash, source_mtime, title, summary, started_at,
     session_id, block_count, tags, notes, created_at, updated_at)
    VALUES (?, 'codex', ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, '2026-08-17', '2026-08-17')`)
    .run(
      conversationId,
      sourcePath,
      parsed.conversation.source_hash,
      parsed.conversation.source_mtime,
      parsed.conversation.title,
      parsed.conversation.summary,
      parsed.conversation.started_at,
      parsed.conversation.session_id,
      parsed.blocks.length,
      `notes ${unverifiedCanary}`,
    );
  const insertBlock = db.prepare(`INSERT INTO conversation_blocks
    (id, conversation_id, type, role, content, compressed, position, timestamp,
     parent_id, metadata_json, dag_uuid, dag_parent_uuid)
    VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)`);
  for (const block of parsed.blocks) {
    insertBlock.run(
      `legacy-${conversationId}-${block.position}`,
      conversationId,
      block.type,
      block.role,
      block.content,
      block.position,
      block.timestamp,
      block.parent_id,
      JSON.stringify(block.metadata),
      block.dag_uuid ?? null,
      block.dag_parent_uuid ?? null,
    );
  }
  const bytes = fs.readFileSync(sourcePath);
  if (compressed) {
    fs.writeFileSync(`${sourcePath}.zst`, zstdCompressSync(bytes));
    fs.unlinkSync(sourcePath);
  }
  await new ConversationSourceStore(db).recordConversation({
    conversationId,
    provider: "codex",
    nativeSessionId: parsed.conversation.session_id,
    filePath: sourcePath,
    ...CURRENT_CONVERSATION_SOURCE_EPOCHS,
  });
  const tail = bytes.subarray(Math.max(0, bytes.length - 4096));
  db.prepare(`
    INSERT INTO conversation_ingest_state (
      file_path, byte_offset, line_count, tail_hash, partial_line, updated_at
    ) VALUES (?, ?, ?, ?, '', ?)
  `).run(sourcePath, bytes.length, rows.length, createHash("sha256").update(tail).digest("hex"), Date.now());
  configureIngestionWorker(() => {}, () => {});
  await ingestBatchForWorker([sourcePath], true, true, true);
  await stopIngestionGracefully();
  return parsed;
}

describe("conversation full-text API parity", () => {
  it("keeps compressed source matches, exact totals and cursor pages identical cold and warm", async () => {
    const paths = new Map<string, string>();
    for (const id of ["compressed", "transition", "raw"]) {
      const sourcePath = path.join(tempDir, `.codex/sessions/2026/08/17/${id}.jsonl`);
      paths.set(id, sourcePath);
      await insertSourceBackedConversation(id, sourcePath, [
        { type: "session_meta", timestamp: "2026-08-17T00:00:00Z", payload: { id, cwd: "/tmp/project" } },
        { type: "response_item", timestamp: "2026-08-17T00:00:01Z", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: `Archive Needle ${id} ${unverifiedCanary}` }] } },
      ], id === "compressed");
    }
    const transition = paths.get("transition")!;
    fs.writeFileSync(`${transition}.zst`, zstdCompressSync(fs.readFileSync(transition)));
    fs.unlinkSync(transition);
    // An alternate representation must never displace a present raw source.
    fs.writeFileSync(`${paths.get("raw")!}.zst`, zstdCompressSync(Buffer.from("Phantom Needle")));

    const router = new Router();
    registerConversationRoutes(router, inlineLedgerReader());
    const sidebarUrl = "/api/conversations/sidebar?search=Archive%20Needle&full_text=true&limit=1";
    type Sidebar = { groups: Array<{ key: string; total: number; conversations: Array<{ id: string }>; next_cursor: string | null }> };
    const cold = await settled(router,{ method: "GET", url: sidebarUrl });
    expect(cold.status).toBe(200);
    const group = (cold.body as Sidebar).groups[0];
    expect(group.total).toBe(3);
    expect(group.conversations).toHaveLength(1);
    expect(group.next_cursor).toEqual(expect.any(String));
    const visited = group.conversations.map(row => row.id);
    const coldPages = [cold.body];
    let cursor = group.next_cursor;
    while (cursor) {
      const page = await settled(router,{ method: "GET", url: `${sidebarUrl}&group_key=${encodeURIComponent(group.key)}&cursor=${encodeURIComponent(cursor)}` });
      expect(page.status).toBe(200);
      coldPages.push(page.body);
      const next = (page.body as Sidebar).groups[0];
      expect(next.total).toBe(3);
      visited.push(...next.conversations.map(row => row.id));
      cursor = next.next_cursor;
    }
    expect(visited.sort()).toEqual(["compressed", "raw", "transition"]);
    await getConversationSearchCache(db).whenIdle();
    const warm = await settled(router,{ method: "GET", url: sidebarUrl });
    expect((warm.body as Sidebar).groups).toEqual((cold.body as Sidebar).groups);
    for (const [index, coldPage] of coldPages.slice(0, -1).entries()) {
      const previous = (coldPage as Sidebar).groups[0];
      const page = await settled(router,{ method: "GET", url: `${sidebarUrl}&group_key=${encodeURIComponent(group.key)}&cursor=${encodeURIComponent(previous.next_cursor!)}` });
      expect((page.body as Sidebar).groups).toEqual((coldPages[index + 1] as Sidebar).groups);
    }
    const list = await settled(router,{ method: "GET", url: "/api/conversations?search=Archive%20Needle&full_text=true&limit=1" });
    expect(list.body).toMatchObject({ total: 3, pages: 3, conversations: [expect.any(Object)] });
    const dedicated = await settled(router,{ method: "GET", url: "/api/conversations/search?q=Archive%20Needle" });
    expect(dedicated.body).toMatchObject({ total: 3 });
    expect(JSON.stringify(dedicated.body)).not.toContain(unverifiedCanary);
    expect(JSON.stringify(dedicated.body)).toContain("[mandible-credential:unverified#1]");
    for (const query of [unverifiedCanary, "Phantom Needle"]) {
      const response = await settled(router,{ method: "GET", url: `/api/conversations/search?q=${encodeURIComponent(query)}` });
      expect(response.body).toMatchObject({ total: 0, results: [] });
    }
  });

  it("keeps valid compressed matches and recovers unavailable sources without caching stripped bodies", async () => {
    const originals = new Map<string, Buffer>();
    for (const id of ["missing", "corrupt", "healthy"]) {
      const sourcePath = path.join(tempDir, `.codex/sessions/2026/08/17/${id}.jsonl`);
      await insertSourceBackedConversation(id, sourcePath, [
        { type: "session_meta", timestamp: "2026-08-17T00:00:00Z", payload: { id, cwd: "/tmp/project" } },
        { type: "response_item", timestamp: "2026-08-17T00:00:01Z", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Unavailable Needle" }] } },
      ], true);
      originals.set(`${sourcePath}.zst`, fs.readFileSync(`${sourcePath}.zst`));
      if (id === "missing") fs.unlinkSync(`${sourcePath}.zst`);
      else if (id === "corrupt") fs.writeFileSync(`${sourcePath}.zst`, "corrupt zstd");
    }
    db.prepare("UPDATE conversation_blocks SET content = '', payload_state = 'source' WHERE conversation_id IN ('missing', 'corrupt')").run();
    const router = new Router();
    registerConversationRoutes(router, inlineLedgerReader());
    for (const url of ["/api/conversations/search?q=Unavailable%20Needle", "/api/conversations?search=Unavailable%20Needle&full_text=true"]) {
      const response = await settled(router,{ method: "GET", url });
      expect(response.status).toBe(409);
      expect(response.body).toMatchObject({coverage:{complete:false}});
      expect((response.body as {state:string}).state).toMatch(/^(incomplete|superseded)$/);
      expect(response.body).not.toHaveProperty("total");
    }
    await getConversationSearchCache(db).whenIdle();
    for (const [sourcePath, bytes] of originals) fs.writeFileSync(sourcePath, bytes);
    const restored = await settled(router,{ method: "GET", url: "/api/conversations/search?q=Unavailable%20Needle" });
    expect(restored.status).toBe(200);
    expect(restored.body).toMatchObject({ total: 3 });
  });

  it("makes the list full_text path reach exact body search while title mode stays title-only", async () => {
    const router = new Router();
    registerConversationRoutes(router, inlineLedgerReader());

    const title = await settled(router,{ method: "GET", url: "/api/conversations?search=Needle" });
    expect(title.body).toMatchObject({ conversations: [{ id: "title-only" }], total: 1 });

    const full = await settled(router,{ method: "GET", url: "/api/conversations?search=Needle&full_text=true" });
    expect(full.body).toMatchObject({
      conversations: [{ id: "body-only" }],
      total: 1,
    });

    const dedicated = await settled(router,{ method: "GET", url: "/api/conversations/search?q=Needle" });
    expect(dedicated.body).toMatchObject({
      results: [{ conversation: { id: "body-only" }, block: { id: "block-body", content: "" } }],
      total: 1,
    });

    const canary = await settled(router,{ method: "GET", url: "/api/conversations/search?q=before" });
    expect(JSON.stringify(canary.body)).not.toContain(revokedCanary);
    expect(canary.body).toMatchObject({
      results: [{ conversation: { id: "revoked-canary" }, snippet: expect.stringContaining("[mandible-credential:unverified#1]") }],
    });
    for (const suffix of ["", "-wal", "-shm"]) {
      const cacheFile = `${process.env.MANDIBLE_CONVERSATION_CACHE_DB}${suffix}`;
      if (fs.existsSync(cacheFile)) expect(fs.readFileSync(cacheFile).includes(Buffer.from(revokedCanary))).toBe(false);
    }
  });

  it("keeps cold search and sidebar source work off the daemon loop", async () => {
    await managedSearchSource(db,path.join(tempDir,"managed"),"body-only","x".repeat(512 * 1024)+" Needle","block-body");
    const ledgerPath = path.join(tempDir, "ledger.db");
    fs.writeFileSync(ledgerPath, db.serialize());
    const reader = workerLedgerReaderPool(ledgerPath, { size: 2 });
    const router = new Router();
    registerConversationRoutes(router, reader);
    let longestTurnMs = 0;
    let ticks = 0;
    let last = performance.now();
    const timer = setInterval(() => {
      const now = performance.now();
      longestTurnMs = Math.max(longestTurnMs, now - last - 2);
      last = now;
      ticks += 1;
    }, 2);
    try {
      const dedicated = await settled(router,{ method: "GET", url: "/api/conversations/search?q=Needle" });
      expect(dedicated.status).toBe(200);
      expect(dedicated.body).toMatchObject({
        results: [{ conversation: { id: "body-only" }, block: { id: "block-body", content: "" } }],
        total: 1,
      });
      const sidebar = await settled(router,{ method: "GET", url: "/api/conversations/sidebar?search=Needle&full_text=true" });
      expect(sidebar.status).toBe(200);
      expect(sidebar.body).toMatchObject({
        groups: [{ conversations: [{ id: "body-only", search_target: { block: "block-body" } }] }],
      });
      const title = await settled(router,{ method: "GET", url: "/api/conversations/search?q=Needle&title=true" });
      expect(title.status).toBe(200);
      expect(title.body).toMatchObject({ results: [{ conversation: { id: "title-only" } }], total: 1 });
      const invalid = await settled(router,{ method: "GET", url: "/api/conversations/sidebar?lifecycle=invalid" });
      expect(invalid.status).toBe(400);
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(ticks).toBeGreaterThan(0);
      expect(longestTurnMs).toBeLessThan(HANDLER_TURN_BUDGET_MS);
    } finally {
      clearInterval(timer);
      await reader.close();
    }
  });

  it("returns source-verified dedicated-route matches with durable structural block ids", async () => {
    const sourcePath = path.join(
      tempDir,
      ".codex/sessions/2026/08/17/rollout-2026-08-17T00-00-00-source-route.jsonl",
    );
    await insertSourceBackedConversation("source-route", sourcePath, [
      { type: "session_meta", timestamp: "2026-08-17T00:00:00Z", payload: { id: "source-route", cwd: "/tmp/project" } },
      { type: "response_item", timestamp: "2026-08-17T00:00:01Z", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Durable Structural Needle" }] } },
    ]);
    const structural = { id: sparseConversationBlockId("source-route", 0) };

    const router = new Router();
    registerConversationRoutes(router, inlineLedgerReader());
    const response = await settled(router,{
      method: "GET",
      url: "/api/conversations/search?q=Structural%20Needle",
    });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      results: [{
        conversation: { id: "source-route" },
        block: { id: structural.id, conversation_id: "source-route", content: "" },
        snippet: expect.stringContaining("Durable Structural Needle"),
      }],
      total: 1,
    });
    expect(structural.id).not.toBe("legacy-source-route-0");
  });

  it("forces verified source reads when stripped compatibility rows opt out of source-backed responses", async () => {
    const authenticator = new ClientAuthenticator(db, { secretsDir: path.join(tempDir, "auth") });
    const operator = setupOperator(db, { display_name: "Operator" });
    const revoked = authenticator.mintApiToken(operator.id, { label: "revoked source canary" });
    revokeCredential(db, revoked.credential.id);
    const requestToken = authenticator.mintApiToken(operator.id, { label: "route request" }).token;
    const sourcePath = path.join(
      tempDir,
      ".codex/sessions/2026/08/17/rollout-2026-08-17T00-00-00-source-mask.jsonl",
    );
    await insertSourceBackedConversation("source-mask", sourcePath, [
      { type: "session_meta", timestamp: "2026-08-17T00:00:00Z", payload: { id: "source-mask", cwd: "/tmp/project" } },
      { type: "response_item", timestamp: "2026-08-17T00:00:01Z", payload: { type: "function_call", call_id: "call-mask", name: "shell", arguments: JSON.stringify({ revoked: revoked.token, unverified: unverifiedCanary }) } },
      { type: "response_item", timestamp: "2026-08-17T00:00:02Z", payload: { type: "function_call_output", call_id: "call-mask", output: `revoked ${revoked.token}; unverified ${unverifiedCanary}` } },
    ]);
    db.prepare(`
      UPDATE conversation_blocks
         SET content = '', metadata_json = '{}', compressed = 0, payload_state = 'source'
       WHERE conversation_id = 'source-mask'
    `).run();

    const router = new Router({ clientAuth: authenticator });
    registerConversationRoutes(router, inlineLedgerReader());
    const detail = await settled(router,{
      method: "GET",
      url: "/api/conversations/source-mask?source_backed=false",
    });
    const blocks = await settled(router,{
      method: "GET",
      url: "/api/conversations/source-mask/blocks?source_backed=false",
    });
    const exported = await settled(router,{
      method: "POST",
      url: "/api/conversations/source-mask/export",
      credential: requestToken,
      body: { format: "json", source_backed: false },
    });

    const responses = [["detail", detail], ["blocks", blocks], ["export", exported]] as const;
    for (const [consumer, response] of responses) {
      expect(response.status, `${consumer} source-backed response: ${JSON.stringify(response.body)}`).toBe(200);
      const serialized = JSON.stringify(response.body);
      expect(serialized).not.toContain(revoked.token);
      expect(serialized).not.toContain(unverifiedCanary);
      expect(serialized).toContain("[mandible-credential:unverified#");
      expect(response.body).toMatchObject({ body_source: "source" });
    }
    const detailBody = detail.body as {
      conversation: { summary: null; notes: string };
      blocks: Array<{ id: string; metadata_json: string; locator: unknown }>;
    };
    // Parser-derived summaries are disposable and are recomputed from the
    // native source rather than preserved as a second body representation.
    expect(detailBody.conversation.summary).toBeNull();
    expect(detailBody.conversation.notes).toContain("[mandible-credential:unverified#1]");
    expect(detailBody.blocks.some((block) => block.metadata_json.includes("[mandible-credential:unverified#"))).toBe(true);
    expect(detailBody.blocks.every((block) => block.id.startsWith("cblk:"))).toBe(true);
    expect(detailBody.blocks.every((block) => block.locator === null)).toBe(true);

    fs.rmSync(sourcePath);
    const failingRouter = new Router({ clientAuth: authenticator });
    registerConversationRoutes(failingRouter, inlineLedgerReader());
    const failedDetail = await failingRouter.invoke({
      method: "GET",
      url: "/api/conversations/source-mask?source_backed=false",
    });
    const failedBlocks = await failingRouter.invoke({
      method: "GET",
      url: "/api/conversations/source-mask/blocks?source_backed=false",
    });
    const failedExport = await failingRouter.invoke({
      method: "POST",
      url: "/api/conversations/source-mask/export",
      credential: requestToken,
      body: { format: "json", source_backed: false },
    });
    for (const response of [failedDetail, failedBlocks]) {
      expect(response.status).toBe(409);
      expect(response.body).toMatchObject({
        error: "source_unavailable",
        message: expect.any(String),
      });
    }
    expect(failedExport.status).toBe(409);
    expect(failedExport.body).toMatchObject({
      error: "source_unavailable",
      message: expect.any(String),
    });
  });
});
