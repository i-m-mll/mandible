import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrate, openDb, setDb, type Db } from "../src/db.js";
import {
  ConversationFreshnessError,
  ensureExactConversationFresh,
  resolveExactConversation,
} from "../src/conversations/freshness.js";
import {
  INGEST_RANGE_READ_CHUNK_BYTES,
  triggerExactPathIngest,
  triggerTargetedIngest,
} from "../src/ingestion.js";
import { registerConversationRoutes } from "../src/routes/conversations.js";
import { Router } from "../src/server.js";
import { decompressContent } from "../src/compression.js";
import { ConversationSourceReader } from "../src/conversations/source-reader.js";

let tempDir = "";
let db: Db;
let previousHome: string | undefined;

function record(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function transcript(sessionId: string, tail = "initial tail"): string {
  return [
    record({ type: "session_meta", timestamp: "2026-08-19T00:00:00Z", payload: { id: sessionId, cwd: "/tmp/project" } }),
    record({ type: "response_item", timestamp: "2026-08-19T00:00:01Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] } }),
    record({ type: "response_item", timestamp: "2026-08-19T00:00:02Z", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: tail }] } }),
  ].join("");
}

function assistant(text: string, second: number): string {
  return record({
    type: "response_item",
    timestamp: `2026-08-19T00:00:${String(second).padStart(2, "0")}Z`,
    payload: { type: "message", role: "assistant", content: [{ type: "output_text", text }] },
  });
}

async function sourcePath(name = "freshness"): Promise<string> {
  const dir = path.join(tempDir, "home", ".codex", "sessions", "2026", "08", "19");
  await fsp.mkdir(dir, { recursive: true });
  return path.join(dir, `rollout-2026-08-19T00-00-00-${name}.jsonl`);
}

async function writeAt(file: string, body: string, tick: number): Promise<void> {
  await fsp.writeFile(file, body);
  const time = new Date(1_900_000_000_000 + tick * 1000);
  await fsp.utimes(file, time, time);
}

async function appendAt(file: string, body: string, tick: number): Promise<void> {
  await fsp.appendFile(file, body);
  const time = new Date(1_900_000_000_000 + tick * 1000);
  await fsp.utimes(file, time, time);
}

async function seed(sessionId = "fresh-session"): Promise<{ file: string; id: string }> {
  const file = await sourcePath(sessionId);
  await writeAt(file, transcript(sessionId), 1);
  await triggerTargetedIngest({ transcriptPath: file, now: 1_000 });
  const row = db.prepare("SELECT id FROM conversations WHERE source_path = ?").get(file) as { id: string };
  return { file, id: row.id };
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-conversation-freshness-"));
  previousHome = process.env.HOME;
  process.env.HOME = path.join(tempDir, "home");
  db = openDb(path.join(tempDir, "mandible.db"));
  migrate(db);
  setDb(db);
});

afterEach(() => {
  db.close();
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("exact conversation freshness", () => {
  it("resolves exact ids and sessions, rejects partial ids, and no-ops when current", async () => {
    const seeded = await seed();
    let ingests = 0;
    const ingest = async (file: string) => {
      ingests += 1;
      return triggerExactPathIngest(file);
    };
    await expect(ensureExactConversationFresh(db, seeded.id, { ingest })).resolves.toMatchObject({ conversationId: seeded.id, refreshed: false });
    await expect(ensureExactConversationFresh(db, "fresh-session", { ingest })).resolves.toMatchObject({ conversationId: seeded.id, refreshed: false });
    await expect(ensureExactConversationFresh(db, seeded.id.slice(0, 8), { ingest })).rejects.toMatchObject({ code: "not_found" });
    expect(ingests).toBe(0);
  });

  it("coalesces concurrent append catch-up and serves the canonical tail through detail, blocks, and export", async () => {
    const seeded = await seed("concurrent-session");
    await appendAt(seeded.file, assistant("new exact tail", 3), 2);
    let ingests = 0;
    const ingest = async (file: string) => {
      ingests += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return triggerExactPathIngest(file);
    };
    const [byId, bySession] = await Promise.all([
      ensureExactConversationFresh(db, seeded.id, { ingest }),
      ensureExactConversationFresh(db, "concurrent-session", { ingest }),
    ]);
    expect(byId.conversationId).toBe(seeded.id);
    expect(bySession.conversationId).toBe(seeded.id);
    expect(ingests).toBe(1);

    const router = new Router();
    registerConversationRoutes(router);
    const detail = await router.invoke({ method: "GET", url: "/api/conversations/concurrent-session?target=latest" });
    const blocks = await router.invoke({ method: "GET", url: "/api/conversations/concurrent-session/blocks" });
    const exported = await router.invoke({
      method: "POST",
      url: "/api/conversations/concurrent-session/export",
      body: { format: "json" },
    });
    expect(detail.status).toBe(200);
    expect(blocks.status).toBe(200);
    expect(exported.status).toBe(200);
    expect(JSON.stringify(detail.body)).toContain("new exact tail");
    expect(JSON.stringify(blocks.body)).toContain("new exact tail");
    expect(JSON.stringify(exported.body)).toContain("new exact tail");
  });

  it("runs authoritative exact catch-up across bounded read and UTF-8 chunk boundaries", async () => {
    const seeded = await seed("chunk-boundary-session");
    const template = assistant("BOUNDARY", 3);
    const markerOffset = Buffer.byteLength(template.slice(0, template.indexOf("BOUNDARY")));
    const padding = "x".repeat(INGEST_RANGE_READ_CHUNK_BYTES - markerOffset - 1);
    await appendAt(seeded.file, assistant(`${padding}€`, 3), 2);

    await expect(ensureExactConversationFresh(db, seeded.id)).resolves.toMatchObject({
      conversationId: seeded.id,
      refreshed: true,
    });
    const last = db.prepare(`
      SELECT content, compressed FROM conversation_blocks
       WHERE conversation_id = ? ORDER BY position DESC LIMIT 1
    `).get(seeded.id) as { content: Buffer | string; compressed: number };
    expect(decompressContent(last.content, last.compressed === 1)).toBe(`${padding}€`);
  });

  it("chooses the sole available duplicate owner and fails closed when two owners are available", async () => {
    const seeded = await seed("duplicate-session");
    db.prepare(`
      INSERT INTO conversations (
        id, source, source_path, source_hash, source_mtime, title, started_at,
        session_id, created_at, updated_at, block_count
      ) VALUES ('duplicate-stale', 'codex', '/missing/duplicate.jsonl', '', 0, 'stale',
        '2026-08-19T00:00:00Z', 'duplicate-session', datetime('now'), datetime('now'), 0)
    `).run();
    expect(resolveExactConversation(db, "duplicate-session").conversationId).toBe(seeded.id);

    const second = await seed("other-native-session");
    db.prepare("UPDATE conversations SET session_id = 'duplicate-session' WHERE id = ?").run(second.id);
    db.prepare("UPDATE conversation_sources SET native_session_id = 'duplicate-session' WHERE conversation_id = ?").run(second.id);
    expect(() => resolveExactConversation(db, "duplicate-session")).toThrowError(ConversationFreshnessError);
    try {
      resolveExactConversation(db, "duplicate-session");
    } catch (error) {
      expect(error).toMatchObject({
        code: "ambiguous_ref",
        candidates: [seeded.id, second.id, "duplicate-stale"].sort(),
      });
    }
  });

  it("allows one moving-source retry, then returns source_changed while retaining fallback bytes", async () => {
    const seeded = await seed("moving-session");
    const before = db.prepare("SELECT COUNT(*) AS count FROM conversation_blocks WHERE conversation_id = ?").get(seeded.id);
    await appendAt(seeded.file, assistant("unindexed one", 3), 2);
    let pass = 0;
    const movingIngest = async () => {
      pass += 1;
      await appendAt(seeded.file, assistant(`moving ${pass}`, 3 + pass), 2 + pass);
      return { ok: true, status: "ingested" as const, transcript_path: seeded.file, session_ref: null };
    };
    await expect(ensureExactConversationFresh(db, seeded.id, { ingest: movingIngest })).rejects.toMatchObject({ code: "source_changed" });
    expect(pass).toBe(2);
    expect(db.prepare("SELECT COUNT(*) AS count FROM conversation_blocks WHERE conversation_id = ?").get(seeded.id)).toEqual(before);
  });

  it("uses the existing full rewrite path while preserving the pinned conversation identity", async () => {
    const seeded = await seed("rewrite-session");
    await writeAt(seeded.file, transcript("rewrite-session", "rewritten body"), 2);
    await expect(ensureExactConversationFresh(db, seeded.id)).resolves.toMatchObject({
      conversationId: seeded.id,
      refreshed: true,
    });
    const rows = db.prepare(
      "SELECT conversation_id, content, compressed FROM conversation_blocks WHERE conversation_id = ? ORDER BY position",
    ).all(seeded.id) as Array<{ conversation_id: string; content: Buffer | string; compressed: number }>;
    expect(rows.every((row) => row.conversation_id === seeded.id)).toBe(true);
    expect(rows.some((row) => decompressContent(row.content, row.compressed === 1).includes("rewritten body"))).toBe(true);
    expect(db.prepare("SELECT COUNT(*) AS count FROM conversation_source_versions WHERE source_id = (SELECT id FROM conversation_sources WHERE conversation_id = ?)")
      .get(seeded.id)).toMatchObject({ count: 2 });
  });

  it("reports unavailable sources explicitly without deleting normalized fallback bytes", async () => {
    const seeded = await seed("missing-session");
    const before = db.prepare("SELECT id, content FROM conversation_blocks WHERE conversation_id = ? ORDER BY position").all(seeded.id);
    await fsp.unlink(seeded.file);
    await expect(ensureExactConversationFresh(db, seeded.id)).rejects.toMatchObject({ code: "source_unavailable" });
    expect(db.prepare("SELECT id, content FROM conversation_blocks WHERE conversation_id = ? ORDER BY position").all(seeded.id)).toEqual(before);
  });

  it("accepts a source that changes once when exact ingestion stabilizes the new extent", async () => {
    const seeded = await seed("one-change-session");
    await appendAt(seeded.file, assistant("first unseen tail", 3), 2);
    let ingests = 0;
    const ingest = async (file: string) => {
      ingests += 1;
      await appendAt(file, assistant("stabilized during ingest", 4), 3);
      return triggerExactPathIngest(file);
    };
    await expect(ensureExactConversationFresh(db, seeded.id, { ingest })).resolves.toMatchObject({ refreshed: true });
    expect(ingests).toBe(1);
    expect(db.prepare("SELECT block_count FROM conversations WHERE id = ?").get(seeded.id)).toMatchObject({ block_count: 4 });
  });

  it("catches up normalized rows even when the source exceeds the reader cold limit", async () => {
    const seeded = await seed("cold-limit-session");
    await appendAt(seeded.file, assistant("tail beyond cold limit", 3), 2);
    const reader = new ConversationSourceReader(db, { maxSourceBytes: 1 });
    const coldRead = await reader.readAll(seeded.id);
    expect(coldRead).toMatchObject({ status: "legacy", reason: "unsupported" });
    await expect(ensureExactConversationFresh(db, seeded.id)).resolves.toMatchObject({ refreshed: true });
    expect(db.prepare("SELECT block_count FROM conversations WHERE id = ?").get(seeded.id)).toMatchObject({ block_count: 3 });
  });

  it("times out a caller without cancelling the authoritative single-flight", async () => {
    const seeded = await seed("timeout-session");
    await appendAt(seeded.file, assistant("eventual tail", 3), 2);
    let ingests = 0;
    const slowIngest = async (file: string) => {
      ingests += 1;
      await new Promise((resolve) => setTimeout(resolve, 40));
      return triggerExactPathIngest(file);
    };
    await expect(ensureExactConversationFresh(db, seeded.id, { timeoutMs: 5, ingest: slowIngest })).rejects.toMatchObject({ code: "freshness_pending" });
    await expect(ensureExactConversationFresh(db, seeded.id, { timeoutMs: 500, ingest: slowIngest })).resolves.toMatchObject({ conversationId: seeded.id });
    expect(ingests).toBe(1);
  });
});
