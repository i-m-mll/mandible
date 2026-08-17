import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { migrate } from "../src/db.js";
import { ConversationSourceReader } from "../src/conversations/source-reader.js";
import { ConversationSourceStore } from "../src/conversations/source-store.js";
import { CURRENT_CONVERSATION_SOURCE_EPOCHS } from "../src/conversations/source-types.js";
import { CodexParser } from "../src/parsers/codex.js";
import type { ParseResult } from "../src/parsers/types.js";

let tempDir = "";

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-source-reader-"));
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function rolloutPath(name = "rollout-2026-08-17T00-00-00-session-a.jsonl"): string {
  const dir = path.join(tempDir, ".codex", "sessions", "2026", "08", "17");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, name);
}

function records(extra: Record<string, unknown>[] = []): Record<string, unknown>[] {
  return [
    { type: "session_meta", timestamp: "2026-08-17T00:00:00Z", payload: { id: "duplicate-session", cwd: "/tmp/project" } },
    { type: "response_item", timestamp: "2026-08-17T00:00:01Z", payload: { type: "function_call", call_id: "call-1", name: "shell", arguments: '{"cmd":"hello"}' } },
    { type: "response_item", timestamp: "2026-08-17T00:00:02Z", payload: { type: "function_call_output", call_id: "call-1", output: "hello result" } },
    { type: "response_item", timestamp: "2026-08-17T00:00:03Z", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] } },
    ...extra,
  ];
}

function writeRecords(filePath: string, rows: Record<string, unknown>[]): void {
  fs.writeFileSync(filePath, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
}

async function parse(filePath: string): Promise<ParseResult> {
  const result = await new CodexParser().parse(filePath);
  if (!result) throw new Error("fixture did not parse");
  return result;
}

function insertConversation(db: Database.Database, id: string, filePath: string, result: ParseResult): void {
  db.prepare(`
    INSERT INTO conversations (
      id, source, source_path, source_hash, source_mtime, title, started_at,
      block_count, session_id, tags, created_at, updated_at
    ) VALUES (?, 'codex', ?, ?, ?, ?, ?, ?, ?, '[]', datetime('now'), datetime('now'))
  `).run(
    id, filePath, result.conversation.source_hash, result.conversation.source_mtime,
    result.conversation.title, result.conversation.started_at, result.blocks.length,
    result.conversation.session_id,
  );
  replaceBlocks(db, id, result);
}

function replaceBlocks(db: Database.Database, conversationId: string, result: ParseResult): void {
  db.prepare("DELETE FROM conversation_blocks WHERE conversation_id = ?").run(conversationId);
  const insert = db.prepare(`
    INSERT INTO conversation_blocks (
      id, conversation_id, type, role, content, compressed, position, timestamp,
      parent_id, metadata_json, dag_uuid, dag_parent_uuid
    ) VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)
  `);
  for (const block of result.blocks) {
    insert.run(
      `legacy-${conversationId}-${block.position}`, conversationId, block.type, block.role,
      block.content, block.position, block.timestamp, block.parent_id,
      JSON.stringify(block.metadata), block.dag_uuid ?? null, block.dag_parent_uuid ?? null,
    );
  }
  db.prepare("UPDATE conversations SET block_count = ?, source_hash = ?, source_mtime = ? WHERE id = ?")
    .run(result.blocks.length, result.conversation.source_hash, result.conversation.source_mtime, conversationId);
}

async function record(db: Database.Database, id: string, filePath: string): Promise<string> {
  return new ConversationSourceStore(db).recordConversation({
    conversationId: id,
    provider: "codex",
    nativeSessionId: "duplicate-session",
    filePath,
    ...CURRENT_CONVERSATION_SOURCE_EPOCHS,
  });
}

describe("versioned conversation source reader", () => {
  it("reads verified multi-record tool linkage and resolves every legacy block id", async () => {
    const db = new Database(":memory:");
    migrate(db);
    const filePath = rolloutPath();
    writeRecords(filePath, records());
    const parsed = await parse(filePath);
    insertConversation(db, "conversation-a", filePath, parsed);
    const versionId = await record(db, "conversation-a", filePath);

    const result = await new ConversationSourceReader(db).readPage("conversation-a", { limit: 20 });
    expect(result.status).toBe("source");
    if (result.status !== "source") throw new Error("expected source read");
    expect(result.sourceVersionId).toBe(versionId);
    expect(result.value.blocks.map((block) => block.type)).toEqual([
      "tool_use", "tool_result", "assistant_message",
    ]);
    expect(result.value.blocks[1].parent_id).toBe(result.value.blocks[0].id);
    expect(result.value.blocks.every((block) => block.locator?.recordHash.length === 64)).toBe(true);

    for (const block of parsed.blocks) {
      const legacy = await new ConversationSourceReader(db).readBlock(`legacy-conversation-a-${block.position}`);
      expect(legacy.status).toBe("source");
      if (legacy.status === "source") expect(legacy.value.content).toBe(block.content);
    }
    db.close();
  });

  it("keeps structural ids across append, and fails closed to legacy on same-size rewrite", async () => {
    const db = new Database(":memory:");
    migrate(db);
    const filePath = rolloutPath();
    writeRecords(filePath, records());
    let parsed = await parse(filePath);
    insertConversation(db, "conversation-a", filePath, parsed);
    const firstVersion = await record(db, "conversation-a", filePath);
    const firstIds = (await new ConversationSourceReader(db).readPage("conversation-a", { limit: 20 }));
    if (firstIds.status !== "source") throw new Error("expected source read");

    writeRecords(filePath, records([
      { type: "response_item", timestamp: "2026-08-17T00:00:04Z", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "appended" }] } },
    ]));
    parsed = await parse(filePath);
    replaceBlocks(db, "conversation-a", parsed);
    const secondVersion = await record(db, "conversation-a", filePath);
    const appended = await new ConversationSourceReader(db).readPage("conversation-a", { limit: 20 });
    expect(secondVersion).not.toBe(firstVersion);
    expect(appended.status).toBe("source");
    if (appended.status !== "source") throw new Error("expected source read");
    expect(appended.value.blocks.slice(0, firstIds.value.blocks.length).map((block) => block.id))
      .toEqual(firstIds.value.blocks.map((block) => block.id));

    const bytes = fs.readFileSync(filePath, "utf8");
    fs.writeFileSync(filePath, bytes.replace("appended", "xppended"));
    const stale = await new ConversationSourceReader(db).readPage("conversation-a", { limit: 20 });
    expect(stale.status).toBe("legacy");
    if (stale.status === "legacy") {
      expect(stale.reason).toBe("stale");
      expect(stale.value.blocks.at(-1)?.content).toBe("appended");
    }
    db.close();
  });

  it("rejects truncation, prepend, CRLF conversion, and replacement as stale locators", async () => {
    const db = new Database(":memory:");
    migrate(db);
    const filePath = rolloutPath();
    writeRecords(filePath, records());
    const original = fs.readFileSync(filePath);
    const parsed = await parse(filePath);
    insertConversation(db, "conversation-a", filePath, parsed);
    await record(db, "conversation-a", filePath);
    const reader = new ConversationSourceReader(db);

    const mutations: Array<[string, Buffer]> = [
      ["truncation", original.subarray(0, original.length - 5)],
      ["prepend", Buffer.concat([Buffer.from("{}\n"), original])],
      ["crlf", Buffer.from(original.toString("utf8").replaceAll("\n", "\r\n"))],
      ["replacement", Buffer.from(original.toString("utf8").replace("hello result", "jello result"))],
    ];
    for (const [name, bytes] of mutations) {
      fs.writeFileSync(filePath, bytes);
      const result = await reader.readPage("conversation-a", { limit: 20 });
      expect(result.status, name).toBe("legacy");
      if (result.status === "legacy") expect(result.reason, name).toBe("stale");
      fs.writeFileSync(filePath, original);
      expect((await reader.readPage("conversation-a", { limit: 20 })).status, `${name} restore`).toBe("source");
    }
    db.close();
  });

  it("falls back when the parser epoch is unavailable or the cold-read bound is exceeded", async () => {
    const db = new Database(":memory:");
    migrate(db);
    const filePath = rolloutPath();
    writeRecords(filePath, records());
    const parsed = await parse(filePath);
    insertConversation(db, "conversation-a", filePath, parsed);
    await record(db, "conversation-a", filePath);

    const bounded = await new ConversationSourceReader(db, { maxSourceBytes: 16 })
      .readPage("conversation-a", { limit: 20 });
    expect(bounded.status).toBe("legacy");
    if (bounded.status === "legacy") expect(bounded.reason).toBe("unsupported");

    db.prepare("UPDATE conversation_source_versions SET parser_version = 'future' WHERE source_id = (SELECT id FROM conversation_sources WHERE conversation_id = ?)")
      .run("conversation-a");
    const future = await new ConversationSourceReader(db).readPage("conversation-a", { limit: 20 });
    expect(future.status).toBe("legacy");
    if (future.status === "legacy") expect(future.reason).toBe("unsupported");
    db.close();
  });

  it("rejects a symlink escape and preserves metadata plus fallback bodies on missing source", async () => {
    const db = new Database(":memory:");
    migrate(db);
    const filePath = rolloutPath();
    writeRecords(filePath, records());
    const parsed = await parse(filePath);
    insertConversation(db, "conversation-a", filePath, parsed);
    await record(db, "conversation-a", filePath);

    const outside = path.join(tempDir, "outside.jsonl");
    fs.copyFileSync(filePath, outside);
    const escaped = path.join(tempDir, ".codex", "sessions", "escaped.jsonl");
    fs.symlinkSync(outside, escaped);
    db.prepare(`
      UPDATE conversation_source_aliases
         SET root_path = ?, relative_path = 'escaped.jsonl', path = ?
       WHERE source_id = (SELECT id FROM conversation_sources WHERE conversation_id = ?)
    `).run(path.join(tempDir, ".codex", "sessions"), escaped, "conversation-a");
    const escapedRead = await new ConversationSourceReader(db).readPage("conversation-a", { limit: 20 });
    expect(escapedRead.status).toBe("legacy");
    if (escapedRead.status === "legacy") expect(escapedRead.reason).toBe("stale");

    new ConversationSourceStore(db).recordUnavailable(escaped);
    expect(db.prepare("SELECT availability FROM conversation_sources WHERE conversation_id = ?")
      .get("conversation-a")).toEqual({ availability: "missing" });
    expect(db.prepare("SELECT COUNT(*) AS count FROM conversations WHERE id = ?")
      .get("conversation-a")).toEqual({ count: 1 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM conversation_blocks WHERE conversation_id = ?")
      .get("conversation-a")).toEqual({ count: parsed.blocks.length });
    expect(db.prepare("SELECT COUNT(*) AS count FROM conversation_block_aliases")
      .get()).toEqual({ count: parsed.blocks.length });
    db.close();
  });

  it("does not treat a duplicate provider session id as conversation identity", async () => {
    const db = new Database(":memory:");
    migrate(db);
    const first = rolloutPath("rollout-2026-08-17T00-00-00-first.jsonl");
    const second = rolloutPath("rollout-2026-08-17T00-00-00-second.jsonl");
    writeRecords(first, records());
    writeRecords(second, records());
    insertConversation(db, "conversation-a", first, await parse(first));
    insertConversation(db, "conversation-b", second, await parse(second));
    await record(db, "conversation-a", first);
    await record(db, "conversation-b", second);
    expect(db.prepare(`
      SELECT conversation_id FROM conversation_sources
       WHERE provider = 'codex' AND native_session_id = 'duplicate-session'
       ORDER BY conversation_id
    `).all()).toEqual([
      { conversation_id: "conversation-a" },
      { conversation_id: "conversation-b" },
    ]);
    db.close();
  });

  it("uses a full immutable digest rather than the append generation marker", async () => {
    const db = new Database(":memory:");
    migrate(db);
    const filePath = rolloutPath();
    writeRecords(filePath, records());
    const parsed = await parse(filePath);
    insertConversation(db, "conversation-a", filePath, parsed);
    db.prepare("UPDATE conversations SET source_hash = ? WHERE id = ?")
      .run("append:123:tail", "conversation-a");
    await record(db, "conversation-a", filePath);
    const version = db.prepare(`
      SELECT content_sha256, generation FROM conversation_source_versions
       WHERE id = (SELECT current_version_id FROM conversation_sources WHERE conversation_id = ?)
    `).get("conversation-a") as { content_sha256: string; generation: string };
    expect(version).toEqual({
      content_sha256: createHash("sha256").update(fs.readFileSync(filePath)).digest("hex"),
      generation: "sealed_sha256",
    });
    db.close();
  });
});
