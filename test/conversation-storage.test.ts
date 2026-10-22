import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import SqliteDatabase from "../src/sqlite.ts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { migrate } from "../src/db.js";
import { conversationBlockId } from "../src/conversation-block-id.js";
import { CodexParser } from "../src/parsers/codex.js";
import { GeminiParser } from "../src/parsers/gemini.js";
import { prepareSourceBackedConversationStorage } from "../src/cli/conversation-storage.js";
import { ConversationSourceReader } from "../src/conversations/source-reader.js";
import { ConversationSourceStore } from "../src/conversations/source-store.js";
import { CURRENT_CONVERSATION_SOURCE_EPOCHS } from "../src/conversations/source-types.js";

let root = "";

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-conversation-storage-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

async function fixture(sessionId = "storage-session") {
  const sourceDir = path.join(root, ".codex", "sessions", "2026", "08", "20");
  fs.mkdirSync(sourceDir, { recursive: true });
  const sourcePath = path.join(sourceDir, `rollout-2026-08-20T00-00-00-${sessionId}.jsonl`);
  fs.writeFileSync(sourcePath, [
    { type: "session_meta", timestamp: "2026-08-20T00:00:00Z", payload: { id: sessionId, cwd: "/tmp/project" } },
    { type: "response_item", timestamp: "2026-08-20T00:00:01Z", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "source-backed body" }] } },
  ].map((row) => JSON.stringify(row)).join("\n") + "\n");
  const parsed = await new CodexParser().parse(sourcePath);
  if (!parsed) throw new Error("fixture did not parse");
  const dbPath = path.join(root, "mandible.db");
  const db = new SqliteDatabase(dbPath);
  migrate(db);
  db.prepare(`
    INSERT INTO conversations (
      id, source, source_path, source_hash, source_mtime, title, started_at,
      block_count, session_id, tags, created_at, updated_at
    ) VALUES ('conversation-storage', 'codex', ?, ?, ?, ?, ?, ?, ?, '[]', datetime('now'), datetime('now'))
  `).run(
    sourcePath, parsed.conversation.source_hash, parsed.conversation.source_mtime,
    parsed.conversation.title, parsed.conversation.started_at, parsed.blocks.length, sessionId,
  );
  const insert = db.prepare(`
    INSERT INTO conversation_blocks (
      id, conversation_id, type, role, content, position, timestamp, parent_id,
      metadata_json, compressed, dag_uuid, dag_parent_uuid
    ) VALUES (?, 'conversation-storage', ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
  `);
  for (const block of parsed.blocks) {
    insert.run(
      conversationBlockId({
        conversation_id: "conversation-storage", type: block.type,
        timestamp: block.timestamp, content: block.content, position: block.position,
      }),
      block.type, block.role, block.content, block.position, block.timestamp,
      block.parent_id, JSON.stringify(block.metadata), block.dag_uuid ?? null,
      block.dag_parent_uuid ?? null,
    );
  }
  db.close();
  return { dbPath, sourcePath, parsed };
}

describe("source-backed conversation storage preparation", () => {
  it("is read-only until apply and then discards only the duplicate payload", async () => {
    const { dbPath } = await fixture();
    const dry = await prepareSourceBackedConversationStorage({ dbPath });
    expect(dry).toMatchObject({ apply: false, processed: 0 });

    const result = await prepareSourceBackedConversationStorage({ dbPath, apply: true });
    expect(result).toMatchObject({ apply: true, processed: 1, promoted: 1, errors: [] });

    const db = new SqliteDatabase(dbPath);
    const rows = db.prepare(`
      SELECT content, metadata_json, compressed, payload_state
        FROM conversation_blocks WHERE conversation_id = 'conversation-storage'
    `).all();
    expect(rows).toEqual(parsedPayloadSkeleton(rows.length));
    expect(db.prepare("SELECT COUNT(*) AS count FROM conversation_normalization_checkpoints").get())
      .toEqual({ count: 0 });
    const page = await new ConversationSourceReader(db).readPage("conversation-storage", { limit: 20 });
    expect(page.status).toBe("source");
    if (page.status === "source") {
      expect(page.value.blocks.some((block) => block.content === "source-backed body")).toBe(true);
    }
    db.close();
  });

  it("resolves a stale Codex path by exact session id before falling back to managed custody", async () => {
    const sessionId = "019e8921-136f-78d0-8c8b-9eb21121ccb4";
    const { dbPath, sourcePath } = await fixture(sessionId);
    const db = new SqliteDatabase(dbPath);
    const stalePath = path.join(root, ".codex", "sessions", "2026", "06", "06",
      "rollout-2026-06-06T01-55-27-019e9b80-2819-7ab3-ab74-c6eced23b8cc.jsonl");
    fs.mkdirSync(path.dirname(stalePath), { recursive: true });
    fs.writeFileSync(stalePath, fs.readFileSync(sourcePath, "utf8").replaceAll(
      sessionId, "019e9b80-2819-7ab3-ab74-c6eced23b8cc",
    ));
    db.prepare("UPDATE conversations SET source_path = ? WHERE id = 'conversation-storage'").run(stalePath);
    db.close();

    const result = await prepareSourceBackedConversationStorage({ dbPath, apply: true });
    expect(result).toMatchObject({ processed: 1, promoted: 1, errors: [] });
    const repaired = new SqliteDatabase(dbPath);
    expect(repaired.prepare("SELECT path FROM conversation_source_aliases WHERE source_id = (SELECT id FROM conversation_sources WHERE conversation_id = 'conversation-storage')").get())
      .toEqual({ path: sourcePath });
    repaired.close();
  });

  it("replaces legacy parser projection drift with the current native parse", async () => {
    const { dbPath } = await fixture();
    const db = new SqliteDatabase(dbPath);
    db.prepare("UPDATE conversation_blocks SET content = 'obsolete body', metadata_json = '{\"legacy_parser\":true}' WHERE conversation_id = 'conversation-storage'").run();
    db.close();

    const result = await prepareSourceBackedConversationStorage({ dbPath, apply: true });
    expect(result).toMatchObject({ processed: 1, promoted: 1, errors: [] });
    const repaired = new SqliteDatabase(dbPath);
    const read = await new ConversationSourceReader(repaired, { maskCredentials: false }).readAll("conversation-storage");
    expect(read).toMatchObject({ status: "source" });
    if (read.status === "source") expect(read.value[0].content).toBe("source-backed body");
    repaired.close();
  });

  it("keeps the database payload when the provider file no longer matches its sealed identity", async () => {
    const { dbPath, sourcePath, parsed } = await fixture();
    const db = new SqliteDatabase(dbPath);
    const legacyIds = parsed.blocks.map((block) => conversationBlockId({
      conversation_id: "conversation-storage",
      type: block.type,
      timestamp: block.timestamp,
      content: block.content,
      position: block.position,
    }));
    const store = new ConversationSourceStore(db);
    await store.recordConversation({
      conversationId: "conversation-storage",
      provider: "codex",
      nativeSessionId: "storage-session",
      filePath: sourcePath,
      expectedContentHash: parsed.conversation.source_hash,
      structuralMode: "replace",
      blocks: parsed.blocks.map((block, index) => ({ ...block, legacyId: legacyIds[index] })),
      ...CURRENT_CONVERSATION_SOURCE_EPOCHS,
    });
    db.prepare(`
      UPDATE conversation_blocks
         SET content = 'database fallback', metadata_json = '{}', payload_state = 'legacy'
       WHERE conversation_id = 'conversation-storage'
    `).run();
    fs.writeFileSync(sourcePath, fs.readFileSync(sourcePath, "utf8").replace(
      "source-backed body",
      "source-backed bodx",
    ));

    await expect(store.verifyAndPromoteConversationPayload("conversation-storage")).resolves.toMatchObject({
      promoted: false,
      reason: "exact source read failed: conversation source prefix no longer matches its indexed version",
    });
    expect(db.prepare(`
      SELECT COUNT(*) AS count FROM conversation_blocks
       WHERE conversation_id = 'conversation-storage'
         AND payload_state = 'legacy' AND content = 'database fallback'
    `).get()).toEqual({ count: parsed.blocks.length });
    db.close();
  });

  it("refuses to strip when the exact source projection differs from the database", async () => {
    const { dbPath, sourcePath, parsed } = await fixture();
    const db = new SqliteDatabase(dbPath);
    const legacyIds = parsed.blocks.map((block) => conversationBlockId({
      conversation_id: "conversation-storage",
      type: block.type,
      timestamp: block.timestamp,
      content: block.content,
      position: block.position,
    }));
    const store = new ConversationSourceStore(db);
    await store.recordConversation({
      conversationId: "conversation-storage",
      provider: "codex",
      nativeSessionId: "storage-session",
      filePath: sourcePath,
      expectedContentHash: parsed.conversation.source_hash,
      structuralMode: "replace",
      blocks: parsed.blocks.map((block, index) => ({ ...block, legacyId: legacyIds[index] })),
      ...CURRENT_CONVERSATION_SOURCE_EPOCHS,
    });
    db.prepare(`UPDATE conversation_blocks SET content = 'database divergence'
      WHERE conversation_id = 'conversation-storage'`).run();

    await expect(store.verifyAndPromoteConversationPayload("conversation-storage")).resolves.toMatchObject({
      promoted: false,
      reason: "exact source projection diverges at block position 0",
    });
    expect(db.prepare(`SELECT content, payload_state FROM conversation_blocks
      WHERE conversation_id = 'conversation-storage'`).get()).toEqual({
      content: "database divergence",
      payload_state: "legacy",
    });
    db.close();
  });

  it("keeps legacy block references while discarding an obsolete larger projection", async () => {
    const { dbPath } = await fixture();
    const db = new SqliteDatabase(dbPath);
    db.prepare(`
      INSERT INTO conversation_blocks (
        id, conversation_id, type, role, content, compressed, position,
        timestamp, parent_id, metadata_json, dag_uuid, dag_parent_uuid
      ) VALUES ('unmatched-legacy', 'conversation-storage', 'assistant_message',
                'assistant', 'unique unmatched bytes', 0, 1,
                '2026-08-20T00:00:02Z', NULL, '{"unmatched":true}', NULL, NULL)
    `).run();
    db.prepare(`UPDATE conversations SET block_count = 2 WHERE id = 'conversation-storage'`).run();
    db.close();

    const result = await prepareSourceBackedConversationStorage({ dbPath, apply: true });
    expect(result).toMatchObject({ processed: 1, promoted: 1, skipped: 0, errors: [] });
    const retained = new SqliteDatabase(dbPath);
    expect(retained.prepare(`SELECT content, metadata_json, payload_state
      FROM conversation_blocks WHERE id = 'unmatched-legacy'`).get()).toEqual({
      content: "",
      metadata_json: "{}",
      payload_state: "source",
    });
    const read = await new ConversationSourceReader(retained).readAll("conversation-storage");
    expect(read.status).toBe("unavailable");
    expect(retained.prepare("SELECT availability FROM conversation_sources WHERE conversation_id = 'conversation-storage'").get())
      .toEqual({ availability: "missing" });
    retained.close();
  });

  it("refuses a payload mutation committed after asynchronous source verification starts", async () => {
    const { dbPath, sourcePath, parsed } = await fixture();
    const db = new SqliteDatabase(dbPath);
    const legacyIds = parsed.blocks.map((block) => conversationBlockId({
      conversation_id: "conversation-storage",
      type: block.type,
      timestamp: block.timestamp,
      content: block.content,
      position: block.position,
    }));
    const store = new ConversationSourceStore(db);
    await store.recordConversation({
      conversationId: "conversation-storage",
      provider: "codex",
      nativeSessionId: "storage-session",
      filePath: sourcePath,
      expectedContentHash: parsed.conversation.source_hash,
      structuralMode: "replace",
      blocks: parsed.blocks.map((block, index) => ({ ...block, legacyId: legacyIds[index] })),
      ...CURRENT_CONVERSATION_SOURCE_EPOCHS,
    });

    const pending = store.verifyAndPromoteConversationPayload("conversation-storage");
    const concurrent = new SqliteDatabase(dbPath);
    concurrent.prepare(`UPDATE conversation_blocks SET content = 'concurrent unique bytes'
      WHERE conversation_id = 'conversation-storage'`).run();
    concurrent.close();
    await expect(pending).resolves.toMatchObject({
      promoted: false,
      reason: "conversation payload changed after source verification",
    });
    expect(db.prepare(`SELECT content, payload_state FROM conversation_blocks
      WHERE conversation_id = 'conversation-storage'`).get()).toEqual({
      content: "concurrent unique bytes",
      payload_state: "legacy",
    });
    db.close();
  });

  it("repairs legacy one-byte Gemini locators before relying on the provider file", async () => {
    const chats = path.join(root, ".gemini", "tmp", "project", "chats");
    fs.mkdirSync(chats, { recursive: true });
    const sourcePath = path.join(chats, "session-2026-08-20T00-00-gemini.json");
    fs.writeFileSync(sourcePath, JSON.stringify({
      sessionId: "gemini-storage",
      startTime: "2026-08-20T00:00:00Z",
      messages: [
        { id: "user-1", type: "user", content: "Gemini question", timestamp: "2026-08-20T00:00:01Z" },
        { id: "user-2", type: "user", content: "Gemini follow-up", timestamp: "2026-08-20T00:00:01Z" },
        { id: "model-1", type: "gemini", content: "Gemini answer", timestamp: "2026-08-20T00:00:02Z" },
      ],
    }));
    const parsed = await new GeminiParser().parse(sourcePath);
    if (!parsed) throw new Error("Gemini fixture did not parse");
    const dbPath = path.join(root, "gemini.db");
    const db = new SqliteDatabase(dbPath);
    migrate(db);
    db.prepare(`
      INSERT INTO conversations (
        id, source, source_path, source_hash, source_mtime, title, started_at,
        block_count, session_id, tags, created_at, updated_at
      ) VALUES ('gemini-conversation', 'gemini', ?, ?, ?, ?, ?, ?, 'gemini-storage', '[]', datetime('now'), datetime('now'))
    `).run(
      sourcePath, parsed.conversation.source_hash, parsed.conversation.source_mtime,
      parsed.conversation.title, parsed.conversation.started_at, parsed.blocks.length,
    );
    const legacyIds = parsed.blocks.map((block) => conversationBlockId({
      conversation_id: "gemini-conversation",
      type: block.type,
      timestamp: block.timestamp,
      content: block.content,
      position: block.position,
    }));
    const insert = db.prepare(`
      INSERT INTO conversation_blocks (
        id, conversation_id, type, role, content, position, timestamp, parent_id,
        metadata_json, compressed, dag_uuid, dag_parent_uuid
      ) VALUES (?, 'gemini-conversation', ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
    `);
    for (let index = 0; index < parsed.blocks.length; index += 1) {
      const block = parsed.blocks[index];
      insert.run(
        legacyIds[index], block.type, block.role, block.content, block.position,
        block.timestamp, block.parent_id, JSON.stringify(block.metadata),
        block.dag_uuid ?? null, block.dag_parent_uuid ?? null,
      );
    }
    await new ConversationSourceStore(db).recordConversation({
      conversationId: "gemini-conversation",
      provider: "gemini",
      nativeSessionId: "gemini-storage",
      filePath: sourcePath,
      expectedContentHash: parsed.conversation.source_hash,
      structuralMode: "replace",
      blocks: parsed.blocks.map((block, index) => ({ ...block, legacyId: legacyIds[index] })),
      ...CURRENT_CONVERSATION_SOURCE_EPOCHS,
    });
    const oneByteHash = createHash("sha256").update("{").digest("hex");
    db.prepare(`
      UPDATE conversation_structural_blocks
         SET record_offset = 0, record_length = 1, record_hash = ?, record_ordinal = 0
       WHERE conversation_id = 'gemini-conversation'
    `).run(oneByteHash);
    db.close();

    const result = await prepareSourceBackedConversationStorage({ dbPath, apply: true });
    expect(result).toMatchObject({ processed: 1, promoted: 1, errors: [] });
    const repaired = new SqliteDatabase(dbPath);
    expect(repaired.prepare(`
      SELECT COUNT(*) AS count
        FROM conversation_structural_blocks sb
        JOIN conversation_source_versions v ON v.id = sb.source_version_id
       WHERE sb.conversation_id = 'gemini-conversation'
         AND sb.status = 'current'
         AND sb.record_offset = 0
         AND sb.record_length = v.byte_length
         AND sb.record_hash = v.content_sha256
    `).get()).toEqual({ count: parsed.blocks.length });
    expect(repaired.prepare(`SELECT COUNT(DISTINCT provider_key) AS count
      FROM conversation_structural_blocks WHERE conversation_id = 'gemini-conversation'
        AND status = 'current'`).get()).toEqual({ count: parsed.blocks.length });
    const page = await new ConversationSourceReader(repaired).readPage("gemini-conversation", { limit: 10 });
    expect(page.status).toBe("source");
    if (page.status === "source") {
      expect(page.value.blocks.map((block) => block.content)).toEqual(expect.arrayContaining([
        "Gemini question",
        "Gemini answer",
      ]));
    }
    repaired.close();
  });

  it("marks an unresolved native source missing while discarding obsolete payload", async () => {
    const { dbPath, sourcePath } = await fixture();
    fs.rmSync(sourcePath);
    const result = await prepareSourceBackedConversationStorage({ dbPath, apply: true });
    expect(result).toMatchObject({ processed: 1, promoted: 1, errors: [] });
    const db = new SqliteDatabase(dbPath);
    expect(db.prepare("SELECT availability, unavailable_reason FROM conversation_sources WHERE conversation_id = 'conversation-storage'").get())
      .toEqual({ availability: "missing", unavailable_reason: "exact provider source could not be resolved" });
    expect(db.prepare("SELECT content, metadata_json, payload_state FROM conversation_blocks WHERE conversation_id = 'conversation-storage'").get())
      .toEqual({ content: "", metadata_json: "{}", payload_state: "source" });
    db.close();
  });
});

function parsedPayloadSkeleton(count: number) {
  return Array.from({ length: count }, () => ({
    content: "",
    metadata_json: "{}",
    compressed: 0,
    payload_state: "source",
  }));
}
