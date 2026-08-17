import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ClientAuthenticator } from "../src/client-auth/authenticator.js";
import { getConversationSearchCache } from "../src/conversations/search-cache.js";
import { ConversationSourceStore } from "../src/conversations/source-store.js";
import { CURRENT_CONVERSATION_SOURCE_EPOCHS } from "../src/conversations/source-types.js";
import { resetCredentialLeakScanCache } from "../src/credential-leak-scan.js";
import { migrate, openDb, setDb, type Db } from "../src/db.js";
import { CodexParser } from "../src/parsers/codex.js";
import type { ParseResult } from "../src/parsers/types.js";
import { registerConversationRoutes } from "../src/routes/conversations.js";
import { Router } from "../src/server.js";
import { revokeCredential, setupOperator } from "../src/users/store.js";

let tempDir: string;
let db: Db;
const revokedCanary = `mandible_pat_${"R".repeat(43)}`;
const unverifiedCanary = `mandible_pat_${"U".repeat(43)}`;

beforeEach(() => {
  resetCredentialLeakScanCache();
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
  resetCredentialLeakScanCache();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

async function insertSourceBackedConversation(
  conversationId: string,
  sourcePath: string,
  rows: Record<string, unknown>[],
): Promise<ParseResult> {
  fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
  fs.writeFileSync(sourcePath, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
  const parsed = await new CodexParser().parse(sourcePath);
  if (!parsed) throw new Error("source-backed route fixture did not parse");
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
      `summary ${unverifiedCanary}`,
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
  await new ConversationSourceStore(db).recordConversation({
    conversationId,
    provider: "codex",
    nativeSessionId: parsed.conversation.session_id,
    filePath: sourcePath,
    ...CURRENT_CONVERSATION_SOURCE_EPOCHS,
  });
  return parsed;
}

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

  it("returns source-verified dedicated-route matches with durable structural block ids", async () => {
    const sourcePath = path.join(
      tempDir,
      ".codex/sessions/2026/08/17/rollout-2026-08-17T00-00-00-source-route.jsonl",
    );
    await insertSourceBackedConversation("source-route", sourcePath, [
      { type: "session_meta", timestamp: "2026-08-17T00:00:00Z", payload: { id: "source-route", cwd: "/tmp/project" } },
      { type: "response_item", timestamp: "2026-08-17T00:00:01Z", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Durable Structural Needle" }] } },
    ]);
    const structural = db.prepare(
      "SELECT id FROM conversation_structural_blocks WHERE conversation_id = ? AND status = 'current'",
    ).get("source-route") as { id: string };

    const router = new Router();
    registerConversationRoutes(router);
    const response = await router.invoke({
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

  it("masks revoked and unverified canaries across source-backed detail and export responses", async () => {
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

    const router = new Router({ clientAuth: authenticator });
    registerConversationRoutes(router);
    const detail = await router.invoke({
      method: "GET",
      url: "/api/conversations/source-mask?source_backed=1",
    });
    const blocks = await router.invoke({
      method: "GET",
      url: "/api/conversations/source-mask/blocks?source_backed=1",
    });
    const exported = await router.invoke({
      method: "POST",
      url: "/api/conversations/source-mask/export",
      credential: requestToken,
      body: { format: "json", source_backed: true },
    });

    for (const response of [detail, blocks, exported]) {
      expect(response.status).toBe(200);
      const serialized = JSON.stringify(response.body);
      expect(serialized).not.toContain(revoked.token);
      expect(serialized).not.toContain(unverifiedCanary);
      expect(serialized).toContain("[mandible-credential:unverified#");
    }
    const detailBody = detail.body as {
      conversation: { summary: string; notes: string };
      blocks: Array<{ id: string; metadata_json: string; locator: unknown }>;
    };
    expect(detailBody.conversation.summary).toContain("[mandible-credential:unverified#1]");
    expect(detailBody.conversation.notes).toContain("[mandible-credential:unverified#1]");
    expect(detailBody.blocks.some((block) => block.metadata_json.includes("[mandible-credential:unverified#"))).toBe(true);
    expect(detailBody.blocks.every((block) => block.id.startsWith("cblk_"))).toBe(true);
    expect(detailBody.blocks.every((block) => block.locator !== null)).toBe(true);
  });
});
