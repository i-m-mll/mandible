import { zstdCompressSync } from "node:zlib";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import SqliteDatabase from "../src/sqlite.ts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ConversationSourceReader } from "../src/conversations/source-reader.js";
import { ConversationSourceStore } from "../src/conversations/source-store.js";
import { CURRENT_CONVERSATION_SOURCE_EPOCHS } from "../src/conversations/source-types.js";
import { CodexParser } from "../src/parsers/codex.js";
import type { ParseResult } from "../src/parsers/types.js";
import { migratedMemoryDb } from "./helpers/ledger-fixtures.js";

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

function insertConversation(db: SqliteDatabase, id: string, filePath: string, result: ParseResult): void {
  db.prepare(`
    INSERT INTO conversations (
      id, source, source_path, source_hash, source_mtime, title, started_at,
      block_count, session_id, model, tags, created_at, updated_at
    ) VALUES (?, 'codex', ?, ?, ?, ?, ?, ?, ?, ?, '[]', datetime('now'), datetime('now'))
  `).run(
    id, filePath, result.conversation.source_hash, result.conversation.source_mtime,
    result.conversation.title, result.conversation.started_at, result.blocks.length,
    result.conversation.session_id, result.conversation.model,
  );
  replaceBlocks(db, id, result);
}

function replaceBlocks(db: SqliteDatabase, conversationId: string, result: ParseResult): void {
  db.prepare("UPDATE conversations SET block_count = ?, source_hash = ?, source_mtime = ? WHERE id = ?")
    .run(result.blocks.length, result.conversation.source_hash, result.conversation.source_mtime, conversationId);
}

async function record(db: SqliteDatabase, id: string, filePath: string): Promise<string> {
  return new ConversationSourceStore(db).recordConversation({
    conversationId: id,
    provider: "codex",
    nativeSessionId: "duplicate-session",
    filePath,
    blocks: (await parse(filePath)).blocks,
    ...CURRENT_CONVERSATION_SOURCE_EPOCHS,
  });
}

describe("versioned conversation source reader", () => {
  it("preserves source versions, locators and block identities across raw/zstd transitions", async () => {
    const db = migratedMemoryDb();
    const filePath = rolloutPath();
    writeRecords(filePath, records());
    try {
      const parsed = await parse(filePath);
      insertConversation(db, "compressed", filePath, parsed);
      const version = await record(db, "compressed", filePath);
      const reader = new ConversationSourceReader(db);
      const original = await reader.readAll("compressed");
      expect(original.status).toBe("source");
      const raw = fs.readFileSync(filePath);
      fs.writeFileSync(`${filePath}.zst`, zstdCompressSync(raw));
      fs.unlinkSync(filePath);
      expect((await parse(filePath)).sourceSnapshot?.contentHash).toBe(parsed.sourceSnapshot?.contentHash);
      expect(await reader.readAll("compressed")).toEqual(original);
      expect(await record(db, "compressed", filePath)).toBe(version);
      expect(await reader.readAll("compressed")).toEqual(original);
      fs.writeFileSync(filePath, raw);
      expect(await record(db, "compressed", filePath)).toBe(version);
      expect(await reader.readAll("compressed")).toEqual(original);
      fs.unlinkSync(filePath);
      fs.writeFileSync(`${filePath}.zst`, zstdCompressSync(Buffer.from(raw.toString().replace("duplicate-session", "different-session"))));
      expect((await reader.readAll("compressed")).status).not.toBe("source");
      fs.unlinkSync(`${filePath}.zst`);
      expect((await reader.readAll("compressed")).status).not.toBe("source");
    } finally { db.close(); }
  });

  it("rebuilds identical source block identities from the same transcript", async () => {
    const filePath = rolloutPath();
    writeRecords(filePath, records());
    const parsed = await parse(filePath);
    const snapshots: string[][] = [];
    for (let i = 0; i < 2; i++) {
      const db = migratedMemoryDb();
      try {
        insertConversation(db, "identity-fixture", filePath, parsed);
        await record(db, "identity-fixture", filePath);
        const result = await new ConversationSourceReader(db).readAll("identity-fixture");
        expect(result.status).toBe("source");
        if (result.status !== "source") throw new Error("expected source read");
        snapshots.push(result.value.map((block) => block.id));
      } finally {
        db.close();
      }
    }
    expect(snapshots[0].length).toBeGreaterThan(0);
    expect(snapshots[1]).toEqual(snapshots[0]);
  });

  it("seals the parser extent when the writer appends before source indexing", async () => {
    const db = migratedMemoryDb();
    const filePath = rolloutPath();
    writeRecords(filePath, records());
    const parsed = await parse(filePath);
    const sourceSnapshot = parsed.sourceSnapshot;
    if (!sourceSnapshot || sourceSnapshot.kind !== "full") {
      throw new Error("full parse did not return its source snapshot");
    }
    insertConversation(db, "conversation-a", filePath, parsed);

    fs.appendFileSync(filePath, `${JSON.stringify({
      type: "response_item",
      timestamp: "2026-08-17T00:00:04Z",
      payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "writer tail" }] },
    })}\n`);

    const versionId = await new ConversationSourceStore(db).recordConversation({
      conversationId: "conversation-a",
      provider: "codex",
      nativeSessionId: "duplicate-session",
      filePath,
      expectedContentHash: parsed.conversation.source_hash,
      sourceSnapshot,
      blocks: parsed.blocks.map((block) => ({
        ...block,
        legacyId: `legacy-conversation-a-${block.position}`,
      })),
      ...CURRENT_CONVERSATION_SOURCE_EPOCHS,
    });

    expect(db.prepare(`
      SELECT content_sha256, byte_length FROM conversation_source_versions WHERE id = ?
    `).get(versionId)).toEqual({
      content_sha256: sourceSnapshot.contentHash,
      byte_length: sourceSnapshot.byteLength,
    });
    expect(fs.statSync(filePath).size).toBeGreaterThan(sourceSnapshot.byteLength);

    const read = await new ConversationSourceReader(db).readAll("conversation-a");
    expect(read.status).toBe("source");
    if (read.status !== "source") throw new Error("expected parser-sealed source read");
    expect(read.value.map((block) => block.content)).toEqual(parsed.blocks.map((block) => block.content));
    db.close();
  });

  it("serves the sealed sparse prefix during append growth and rejects an in-place rewrite", async () => {
    const db = migratedMemoryDb();
    const filePath = rolloutPath();
    writeRecords(filePath, records());
    const parsed = await parse(filePath);
    insertConversation(db, "conversation-a", filePath, parsed);
    const versionId = await record(db, "conversation-a", filePath);


    fs.appendFileSync(filePath, `${JSON.stringify({
      type: "response_item",
      timestamp: "2026-08-17T00:00:04Z",
      payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "new tail" }] },
    })}\n`);
    const reader = new ConversationSourceReader(db);
    const appended = await reader.readPage("conversation-a", { offset: 0, limit: 3 });
    expect(appended.status).toBe("source");
    if (appended.status !== "source") throw new Error("expected verified sparse prefix read");
    expect(appended.sourceVersionId).toBe(versionId);
    expect(appended.value.total).toBe(parsed.blocks.length);
    expect(appended.value.blocks.map((block) => block.content)).toEqual(parsed.blocks.map((block) => block.content));

    const grownBytes = fs.readFileSync(filePath, "utf8");
    fs.writeFileSync(filePath, grownBytes.replace("hello result", "jello result"));
    const rewritten = await reader.readPage("conversation-a", { offset: 1, limit: 1 });
    expect(rewritten.status).toBe("stale");
    db.close();
  });

  it("rejects truncation, prepend, CRLF conversion, and replacement as stale locators", async () => {
    const db = migratedMemoryDb();
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
      expect(result.status, name).toBe("stale");
      fs.writeFileSync(filePath, original);
      expect((await reader.readPage("conversation-a", { limit: 20 })).status, `${name} restore`).toBe("source");
    }
    db.close();
  });

  it("does not treat a duplicate provider session id as conversation identity", async () => {
    const db = migratedMemoryDb();
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
    const db = migratedMemoryDb();
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
