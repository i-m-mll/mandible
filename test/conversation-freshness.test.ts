import fs from "node:fs";
import fsp from "node:fs/promises";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import SqliteDatabase from "../src/sqlite.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { migrate, openDb, setDb, type Db } from "../src/db.js";
import {
  ConversationFreshnessError,
  ensureExactConversationFresh,
  resolveExactConversation,
} from "../src/conversations/freshness.js";
import {
  INGEST_RANGE_READ_CHUNK_BYTES,
  ingestExactSelectedPath,
  triggerExactPathIngest,
  triggerTargetedIngest,
  configureIngestionWorker,
} from "../src/ingestion.js";
import { registerConversationRoutes, sendFreshnessError } from "../src/routes/conversations.js";
import { Router } from "../src/server.js";
import { ConversationSourceReader } from "../src/conversations/source-reader.js";
import { getConversationStructureCache } from "../src/conversations/structure-cache.js";
import { CURRENT_CONVERSATION_SOURCE_EPOCHS } from "../src/conversations/source-types.js";
import { ConversationSourceChangedError } from "../src/conversations/source-store.js";
import { sourceFilesystemIdentity } from "../src/conversations/source-observer.js";
import { CodexParser } from "../src/parsers/codex.js";
import { FileRpcTransport } from "../src/file-rpc-transport.js";
import { resolveInstanceInfo } from "../src/instance-policy.js";

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

function stateDbPath(): string {
  return path.join(tempDir, "home", ".codex", "state_5.sqlite");
}

function updateThread(
  sessionId: string,
  values: { title?: string; rolloutPath?: string; updatedAtMs?: number } = {},
): void {
  const state = new SqliteDatabase(stateDbPath());
  try {
    state.prepare(`
      INSERT INTO threads (id, title, rollout_path, updated_at, updated_at_ms)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        rollout_path = excluded.rollout_path,
        updated_at = excluded.updated_at,
        updated_at_ms = excluded.updated_at_ms
    `).run(
      sessionId,
      values.title ?? "hello",
      values.rolloutPath ?? path.join(tempDir, "home", ".codex", "sessions", "2026", "08", "19", `rollout-2026-08-19T00-00-00-${sessionId}.jsonl`),
      Math.floor((values.updatedAtMs ?? 2_100_000_000_000) / 1000),
      values.updatedAtMs ?? 2_100_000_000_000,
    );
  } finally {
    state.close();
  }
}

function deleteThread(sessionId: string): void {
  const state = new SqliteDatabase(stateDbPath());
  try {
    state.prepare("DELETE FROM threads WHERE id = ?").run(sessionId);
  } finally {
    state.close();
  }
}

async function seed(sessionId = "fresh-session"): Promise<{ file: string; id: string }> {
  const file = await sourcePath(sessionId);
  await writeAt(file, transcript(sessionId), 1);
  await triggerTargetedIngest({ transcriptPath: file, now: 1_000 });
  const row = db.prepare("SELECT id FROM conversations WHERE source_path = ?").get(file) as { id: string };
  updateThread(sessionId, { rolloutPath: file });
  return { file, id: row.id };
}

async function exactContents(conversationId: string): Promise<string[]> {
  const read = await new ConversationSourceReader(db).readAll(conversationId);
  expect(read.status).toBe("source");
  if (read.status !== "source") return [];
  return read.value.map((block) => block.content);
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-conversation-freshness-"));
  previousHome = process.env.HOME;
  process.env.HOME = path.join(tempDir, "home");
  fs.mkdirSync(path.join(tempDir, "home", ".codex"), { recursive: true });
  const state = new SqliteDatabase(stateDbPath());
  state.exec(`
    CREATE TABLE threads (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      rollout_path TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      updated_at_ms INTEGER
    )
  `);
  state.close();
  db = openDb(path.join(tempDir, "mandible.db"));
  migrate(db);
  setDb(db);
  configureIngestionWorker(() => {}, () => {});
});

afterEach(() => {
  db.close();
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("exact conversation freshness", () => {
  it("returns a structured retryable pending response", () => {
    const status = vi.fn();
    const header = vi.fn();
    const json = vi.fn();
    expect(sendFreshnessError({ status, header, json }, new ConversationFreshnessError(
      "freshness_pending", "conversation is being reindexed",
    ))).toBe(true);
    expect(status).toHaveBeenCalledWith(503);
    expect(header).toHaveBeenCalledWith("Retry-After", "1");
    expect(json).toHaveBeenCalledWith({
      error: "freshness_pending",
      code: "freshness_pending",
      message: "conversation is being reindexed",
    });
  });
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

  it("refreshes only the selected stale source and retries a source-change race", async () => {
    const selected = await seed("selected-stale-source");
    const other = await seed("unselected-source");
    const otherVersion = db.prepare(`SELECT current_version_id FROM conversation_sources
      WHERE conversation_id = ?`).get(other.id) as { current_version_id: string };
    await appendAt(selected.file, assistant("selected appended tail", 3), 2);
    let attempts = 0;
    const actor = {
      ingest: async (paths: string[]) => {
        attempts += 1;
        if (attempts === 1) {
          await appendAt(paths[0], assistant("tail written during refresh", 4), 3);
          throw new ConversationSourceChangedError("conversation source changed while being indexed");
        }
        await triggerExactPathIngest(paths[0]);
      },
    };
    const ingest = async (file: string) => {
      await ingestExactSelectedPath(actor, file);
      return { ok: true as const, status: "ingested" as const, transcript_path: file, session_ref: null };
    };

    await expect(ensureExactConversationFresh(db, selected.id, { ingest }))
      .resolves.toMatchObject({ conversationId: selected.id, refreshed: true });

    expect(attempts).toBe(2);
    expect(await exactContents(selected.id)).toEqual([
      "hello",
      "initial tail",
      "selected appended tail",
      "tail written during refresh",
    ]);
    expect(db.prepare(`SELECT current_version_id FROM conversation_sources
      WHERE conversation_id = ?`).get(other.id)).toEqual(otherVersion);
  });

  it("rebuilds a deleted sparse cache before declaring an unchanged source fresh", async () => {
    const seeded = await seed("missing-structure-cache");
    const cache = getConversationStructureCache(db);
    cache.clear();

    const refreshed = await ensureExactConversationFresh(db, seeded.id);

    expect(refreshed.refreshed).toBe(true);
    const source = db.prepare(`SELECT current_version_id FROM conversation_sources
      WHERE conversation_id = ?`).get(seeded.id) as { current_version_id: string };
    expect(cache.hasCompleteConversation(seeded.id, source.current_version_id, 2)).toBe(true);
    const read = await new ConversationSourceReader(db).readAll(seeded.id);
    expect(read.status).toBe("source");
    if (read.status === "source") expect(read.value.map((block) => block.content)).toEqual(["hello", "initial tail"]);
    expect(db.prepare("SELECT COUNT(*) AS count FROM conversation_blocks WHERE conversation_id = ?")
      .get(seeded.id)).toEqual({ count: 0 });
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

    const router = new Router({ instance: resolveInstanceInfo({ env: {} }) });
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

    expect(router.resolveFileRpcPolicy("POST", "/api/conversations/concurrent-session/export")).toBe(true);
    expect(router.resolveFileRpcPolicy("POST", "/api/conversations/ingest")).toBe(false);
    expect(router.resolveFileRpcPolicy("POST", "/api/conversations/export/transform")).toBe(false);
    expect(router.resolveFileRpcPolicy("POST", "/api/conversations/concurrent-session/fork")).toBe(false);

    const rpcDir = path.join(tempDir, "file-rpc");
    const transport = new FileRpcTransport({ router, dir: rpcDir, responseTtlMs: 60_000 });
    fs.mkdirSync(rpcDir, { recursive: true });
    fs.writeFileSync(path.join(rpcDir, "export.request.json"), JSON.stringify({
      id: "export",
      method: "POST",
      path: "/api/conversations/concurrent-session/export",
      body: { format: "json" },
    }));
    await transport.processOnce();
    const rpcResponse = JSON.parse(fs.readFileSync(path.join(rpcDir, "export.response.json"), "utf8"));
    expect(rpcResponse.status).toBe(200);
    expect(JSON.stringify(rpcResponse.body)).toContain("new exact tail");
  });

  it("links a tool result to a prior sparse tool call without reparsing the full transcript", async () => {
    const seeded = await seed("cross-append-tool-session");
    await appendAt(seeded.file, record({
      type: "response_item", timestamp: "2026-08-19T00:00:03Z",
      payload: { type: "function_call", id: "provider-tool-message", call_id: "earlier-tool", name: "inspect", arguments: "{}" },
    }), 2);
    await triggerExactPathIngest(seeded.file);
    expect((await exactContents(seeded.id)).length).toBe(3);
    expect(getConversationStructureCache(db).findToolPosition(seeded.id, "earlier-tool")).toBe(2);
    await appendAt(seeded.file, record({
      type: "response_item", timestamp: "2026-08-19T00:00:04Z",
      payload: { type: "function_call_output", call_id: "earlier-tool", output: "tool result tail" },
    }), 3);

    const fullParse = vi.spyOn(CodexParser.prototype, "parse");
    try {
      await triggerExactPathIngest(seeded.file);
      expect(fullParse).not.toHaveBeenCalled();
    } finally {
      fullParse.mockRestore();
    }
    const read = await new ConversationSourceReader(db).readAll(seeded.id);
    expect(read.status).toBe("source");
    if (read.status !== "source") return;
    const toolUse = read.value.find((block) => block.type === "tool_use");
    const toolResult = read.value.find((block) => block.type === "tool_result");
    expect(toolUse).toBeDefined();
    expect(toolResult?.parent_id).toBe(toolUse?.id);
    expect(toolResult?.content).toContain("tool result tail");
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
    expect((await exactContents(seeded.id)).at(-1)).toBe(`${padding}€`);
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
      "SELECT conversation_id FROM conversation_blocks WHERE conversation_id = ? ORDER BY position",
    ).all(seeded.id) as Array<{ conversation_id: string }>;
    expect(rows.every((row) => row.conversation_id === seeded.id)).toBe(true);
    expect((await exactContents(seeded.id)).some((content) => content.includes("rewritten body"))).toBe(true);
    expect(db.prepare("SELECT COUNT(*) AS count FROM conversation_source_versions WHERE source_id = (SELECT id FROM conversation_sources WHERE conversation_id = ?)")
      .get(seeded.id)).toMatchObject({ count: 2 });
  });

  it("rejects the bounded extent match after a middle rewrite restores size, mtime, and tail", async () => {
    const sessionId = "middle-rewrite-session";
    const file = await sourcePath(sessionId);
    const staleMarker = "stale marker";
    const freshMarker = "fresh marker";
    await writeAt(file, transcript(sessionId, `${"x".repeat(8192)}${staleMarker}${"y".repeat(8192)}`), 1);
    await triggerTargetedIngest({ transcriptPath: file, now: 1_000 });
    const seeded = db.prepare("SELECT id FROM conversations WHERE source_path = ?").get(file) as { id: string };
    updateThread(sessionId, { rolloutPath: file });

    const original = await fsp.stat(file, { bigint: true });
    const originalTail = (await fsp.readFile(file)).subarray(-4096);
    const bytes = await fsp.readFile(file);
    const markerOffset = bytes.indexOf(staleMarker);
    expect(markerOffset).toBeGreaterThan(0);
    expect(markerOffset).toBeLessThan(bytes.length - 4096);
    const handle = await fsp.open(file, "r+");
    try {
      await handle.write(Buffer.from(freshMarker), 0, Buffer.byteLength(freshMarker), markerOffset);
    } finally {
      await handle.close();
    }
    await fsp.utimes(file, Number(original.atimeNs) / 1_000_000_000, Number(original.mtimeNs) / 1_000_000_000);
    const rewritten = await fsp.stat(file, { bigint: true });
    expect(rewritten.size).toBe(original.size);
    expect(rewritten.mtimeNs).toBe(original.mtimeNs);
    expect(rewritten.dev).toBe(original.dev);
    expect(rewritten.ino).toBe(original.ino);
    expect(rewritten.ctimeNs).not.toBe(original.ctimeNs);
    expect((await fsp.readFile(file)).subarray(-4096)).toEqual(originalTail);

    let ingests = 0;
    const result = await ensureExactConversationFresh(db, seeded.id, {
      ingest: async (source) => {
        ingests += 1;
        return triggerExactPathIngest(source);
      },
    });
    const normalized = (await exactContents(seeded.id)).join("\n");
    expect(result.refreshed).toBe(true);
    expect(ingests).toBe(1);
    expect(normalized).toContain(freshMarker);
    expect(normalized).not.toContain(staleMarker);
  });

  it("rehashes and refreshes identity after same-byte inode replacement", async () => {
    const seeded = await seed("inode-replacement-session");
    const original = await fsp.stat(seeded.file, { bigint: true });
    const replacement = `${seeded.file}.replacement`;
    await fsp.copyFile(seeded.file, replacement);
    await fsp.utimes(replacement, Number(original.atimeNs) / 1_000_000_000, Number(original.mtimeNs) / 1_000_000_000);
    await fsp.rename(replacement, seeded.file);
    const replaced = await fsp.stat(seeded.file, { bigint: true });
    expect(replaced.ino).not.toBe(original.ino);
    expect(replaced.size).toBe(original.size);
    expect(replaced.mtimeNs).toBe(original.mtimeNs);

    let ingests = 0;
    await expect(ensureExactConversationFresh(db, seeded.id, {
      ingest: async (source) => {
        ingests += 1;
        return triggerExactPathIngest(source);
      },
    })).resolves.toMatchObject({ refreshed: true });
    expect(ingests).toBe(1);
    const identity = sourceFilesystemIdentity(replaced);
    expect(db.prepare(`
      SELECT filesystem_device, filesystem_inode, filesystem_ctime_ns
        FROM conversation_source_versions
       WHERE id = (SELECT current_version_id FROM conversation_sources WHERE conversation_id = ?)
    `).get(seeded.id)).toEqual({
      filesystem_device: identity.device,
      filesystem_inode: identity.inode,
      filesystem_ctime_ns: identity.ctimeNs,
    });
  });

  it("does not trust a legacy current version without filesystem identity", async () => {
    const seeded = await seed("legacy-identity-session");
    db.prepare(`
      UPDATE conversation_source_versions
         SET filesystem_device = NULL, filesystem_inode = NULL, filesystem_ctime_ns = NULL
       WHERE id = (SELECT current_version_id FROM conversation_sources WHERE conversation_id = ?)
    `).run(seeded.id);
    let ingests = 0;
    await expect(ensureExactConversationFresh(db, seeded.id, {
      ingest: async (source) => {
        ingests += 1;
        return triggerExactPathIngest(source);
      },
    })).resolves.toMatchObject({ refreshed: true });
    expect(ingests).toBe(1);
    expect(db.prepare(`
      SELECT filesystem_device IS NOT NULL AS device,
             filesystem_inode IS NOT NULL AS inode,
             filesystem_ctime_ns IS NOT NULL AS ctime
        FROM conversation_source_versions
       WHERE id = (SELECT current_version_id FROM conversation_sources WHERE conversation_id = ?)
    `).get(seeded.id)).toEqual({ device: 1, inode: 1, ctime: 1 });
  });

  it("repairs an exact Codex active-to-archive move on demand", async () => {
    const seeded = await seed("archived-session");
    const archivedDir = path.join(tempDir, "home", ".codex", "archived_sessions");
    const archivedFile = path.join(archivedDir, path.basename(seeded.file));
    await fsp.mkdir(archivedDir, { recursive: true });
    await fsp.rename(seeded.file, archivedFile);

    await expect(ensureExactConversationFresh(db, seeded.id)).resolves.toMatchObject({
      conversationId: seeded.id,
      sourcePath: archivedFile,
      refreshed: true,
    });
    expect(db.prepare("SELECT source_path FROM conversations WHERE id = ?").get(seeded.id))
      .toEqual({ source_path: archivedFile });
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
    expect(coldRead).toMatchObject({
      status: "unsupported",
      reason: "requested source page exceeds bounded range-read limit",
    });
    await expect(ensureExactConversationFresh(db, seeded.id)).resolves.toMatchObject({ refreshed: true });
    expect(db.prepare("SELECT block_count FROM conversations WHERE id = ?").get(seeded.id)).toMatchObject({ block_count: 3 });
    expect(await exactContents(seeded.id)).toHaveLength(3);
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

  it("queues an exact source refresh for an active append and keeps unavailable workers visible", async () => {
    const seeded = await seed("background-refresh-session");
    await appendAt(seeded.file, assistant("new tail", 3), 2);
    let ingests = 0;
    const scheduleReparse = vi.fn(() => true);
    const ingest = async (file: string) => {
      ingests += 1;
      return triggerExactPathIngest(file);
    };

    await expect(ensureExactConversationFresh(db, seeded.id, {
      ingest,
      waitForFresh: false,
      scheduleReparse,
    })).resolves.toMatchObject({ conversationId: seeded.id, refreshed: false });
    expect(scheduleReparse).toHaveBeenCalledWith(seeded.file, expect.any(String), seeded.id);
    expect(ingests).toBe(0);

    const router = new Router({ instance: resolveInstanceInfo({ env: {} }) });
    registerConversationRoutes(router);
    const pending = await router.invoke({ method: "GET", url: `/api/conversations/${seeded.id}?target=latest` });
    // This isolated fixture has no running ingestion actor, so the route
    // reports the scheduler failure before reaching the source reader.
    expect(pending.status).toBe(503);
    expect(pending.body).toMatchObject({ error: "freshness_error" });

    await expect(ensureExactConversationFresh(db, seeded.id, { ingest })).resolves.toMatchObject({
      conversationId: seeded.id,
      refreshed: true,
    });
    expect(ingests).toBe(1);
    const current = await router.invoke({ method: "GET", url: `/api/conversations/${seeded.id}?target=latest` });
    expect(current.status).toBe(200);
    expect(JSON.stringify(current.body)).toContain("new tail");
  });

  it("serves the verified indexed prefix when an append races the selected read", async () => {
    const seeded = await seed("read-race-session");
    const originalReadPage = ConversationSourceReader.prototype.readPage;
    const readPage = vi.spyOn(ConversationSourceReader.prototype, "readPage").mockImplementation(async function (...args) {
      await appendAt(seeded.file, assistant("racing tail", 3), 2);
      return originalReadPage.apply(this, args);
    });
    try {
      const router = new Router({ instance: resolveInstanceInfo({ env: {} }) });
      registerConversationRoutes(router);
      const response = await router.invoke({ method: "GET", url: `/api/conversations/${seeded.id}?target=latest` });
      expect(response.status).toBe(200);
      expect(JSON.stringify(response.body)).not.toContain("racing tail");
      expect(readPage).toHaveBeenCalledOnce();
    } finally {
      readPage.mockRestore();
    }
  });

  it("retries the whole selected window when exact indexing finishes after a stale page read", async () => {
    const seeded = await seed("read-catchup-session");
    const originalReadPage = ConversationSourceReader.prototype.readPage;
    let first = true;
    const readPage = vi.spyOn(ConversationSourceReader.prototype, "readPage").mockImplementation(async function (...args) {
      if (!first) return originalReadPage.apply(this, args);
      first = false;
      await appendAt(seeded.file, assistant("caught-up tail", 3), 2);
      const stale = { status: "stale" as const, reason: "test invalidation between source read and refresh" };
      await triggerExactPathIngest(seeded.file);
      return stale;
    });
    try {
      const router = new Router({ instance: resolveInstanceInfo({ env: {} }) });
      registerConversationRoutes(router);
      const pending = await router.invoke({ method: "GET", url: `/api/conversations/${seeded.id}?target=latest` });
      expect(pending.status).toBe(503);
      expect(pending.body).toMatchObject({ error: "freshness_pending" });
      const current = await router.invoke({ method: "GET", url: `/api/conversations/${seeded.id}?target=latest` });
      expect(current.status).toBe(200);
      expect(JSON.stringify(current.body)).toContain("caught-up tail");
    } finally {
      readPage.mockRestore();
    }
  });

  it("announces same-byte reparse only after its current source index is readable", async () => {
    const seeded = await seed("reparse-completion-event");
    db.prepare("UPDATE conversation_sources SET parser_version = 'old' WHERE conversation_id = ?")
      .run(seeded.id);
    let epochAtEvent: string | null = null;
    const events: string[] = [];
    configureIngestionWorker(() => {}, (event, data) => {
      if (event !== "conversation:updated" || (data as { id?: string }).id !== seeded.id) return;
      events.push(event);
      epochAtEvent = (db.prepare("SELECT parser_version FROM conversation_sources WHERE conversation_id = ?")
        .get(seeded.id) as { parser_version: string }).parser_version;
    });

    await triggerExactPathIngest(seeded.file);

    expect(events).toEqual(["conversation:updated"]);
    expect(epochAtEvent).toBe(CURRENT_CONVERSATION_SOURCE_EPOCHS.parserVersion);
    expect(await exactContents(seeded.id)).toContain("hello");
  });

  it("refreshes one exact provider title, broadcasts once, and leaves an unchanged transcript bounded", async () => {
    const seeded = await seed("title-authority-session");
    db.prepare("UPDATE conversations SET title = 'New Codex chat' WHERE id = ?").run(seeded.id);
    updateThread("title-authority-session", { title: "Current provider title", rolloutPath: seeded.file });
    let ingests = 0;
    const events: Array<{ event: string; data: unknown }> = [];
    configureIngestionWorker(() => {}, (event, data) => events.push({ event, data }));
    const ingest = async (file: string) => {
      ingests += 1;
      return triggerExactPathIngest(file);
    };

    const [first, joined] = await Promise.all([
      ensureExactConversationFresh(db, seeded.id, { ingest }),
      ensureExactConversationFresh(db, "title-authority-session", { ingest }),
    ]);
    const changesAfterFirst = db.totalChanges;
    const second = await ensureExactConversationFresh(db, seeded.id, { ingest });

    expect(first.refreshed).toBe(true);
    expect(joined).toEqual(first);
    expect(second.refreshed).toBe(false);
    expect(ingests).toBe(0);
    expect(db.totalChanges).toBe(changesAfterFirst);
    expect(db.prepare("SELECT title FROM conversations WHERE id = ?").get(seeded.id)).toEqual({ title: "Current provider title" });
    expect(events).toEqual([{
      event: "conversation:updated",
      data: expect.objectContaining({ id: seeded.id, title: "Current provider title" }),
    }]);
  });

  it("refreshes and rechecks a current sparse source above INT32_MAX using tail reads only", async () => {
    const seeded = await seed("sparse-title-authority-session");
    const sparseSize = 2_147_483_648 + 8_192;
    const sparseSha256 = "50ef94816ed66470c87be5e6cc3cdbc0c9d64f5706c10fde6ab8b82846aa0f4c";
    const sparseMtime = new Date(1_900_000_010_000);
    await fsp.truncate(seeded.file, 0);
    await fsp.truncate(seeded.file, sparseSize);
    await fsp.utimes(seeded.file, sparseMtime, sparseMtime);
    const stat = await fsp.stat(seeded.file);
    const bigintStat = await fsp.stat(seeded.file, { bigint: true });
    const identity = sourceFilesystemIdentity(bigintStat);
    expect(stat.size).toBe(sparseSize);
    expect(stat.size).toBeGreaterThan(0x7fffffff);
    expect(stat.blocks * 512).toBeLessThan(stat.size);

    const tailHash = crypto.createHash("sha256").update(Buffer.alloc(4096)).digest("hex");
    db.prepare(`
      UPDATE conversation_source_versions
         SET content_sha256 = ?, byte_length = ?, file_mtime_ms = ?,
             filesystem_device = ?, filesystem_inode = ?, filesystem_ctime_ns = ?,
             availability = 'available'
       WHERE id = (
         SELECT current_version_id FROM conversation_sources WHERE conversation_id = ?
       )
    `).run(
      sparseSha256, stat.size, stat.mtimeMs,
      identity.device, identity.inode, identity.ctimeNs, seeded.id,
    );
    db.prepare(`
      UPDATE conversation_ingest_state
         SET byte_offset = ?, tail_hash = ?, partial_line = '', empty_source_mtime = NULL,
             empty_source_size = NULL
       WHERE file_path = ?
    `).run(stat.size, tailHash, seeded.file);
    db.prepare("UPDATE conversations SET source_hash = ?, source_mtime = ? WHERE id = ?")
      .run(sparseSha256, stat.mtimeMs, seeded.id);
    updateThread("sparse-title-authority-session", {
      title: "Sparse provider title",
      rolloutPath: seeded.file,
      updatedAtMs: Math.ceil(stat.mtimeMs),
    });

    let ingests = 0;
    const reads: Array<{ position: number; length: number; fileSize: number }> = [];
    const sourceReadInstrumentation = (read: { position: number; length: number; fileSize: number }) => {
      if (read.position < read.fileSize - 4096) {
        throw new Error(`unexpected non-tail source read at ${read.position}`);
      }
      reads.push(read);
    };
    const ingest = async () => {
      ingests += 1;
      throw new Error("unexpected giant-source ingest");
    };

    const first = await ensureExactConversationFresh(db, seeded.id, {
      ingest,
      sourceReadInstrumentation,
    });
    const changesAfterFirst = db.totalChanges;
    const second = await ensureExactConversationFresh(db, seeded.id, {
      ingest,
      sourceReadInstrumentation,
    });

    expect(first.refreshed).toBe(true);
    expect(second.refreshed).toBe(false);
    expect(ingests).toBe(0);
    expect(db.totalChanges).toBe(changesAfterFirst);
    expect(reads).toEqual([
      { position: sparseSize - 4096, length: 4096, fileSize: sparseSize },
      { position: sparseSize - 4096, length: 4096, fileSize: sparseSize },
    ]);
    expect(db.prepare("SELECT title FROM conversations WHERE id = ?").get(seeded.id))
      .toEqual({ title: "Sparse provider title" });
  });

  it("keeps transcripts readable when optional Codex title metadata cannot converge", async () => {
    const missing = await seed("missing-metadata-session");
    deleteThread("missing-metadata-session");
    await expect(ensureExactConversationFresh(db, missing.id)).resolves.toMatchObject({ refreshed: false });

    const mismatched = await seed("mismatched-metadata-session");
    updateThread("mismatched-metadata-session", { rolloutPath: path.join(tempDir, "elsewhere", "other.jsonl") });
    await expect(ensureExactConversationFresh(db, mismatched.id)).resolves.toMatchObject({ refreshed: false });

    const stale = await seed("stale-metadata-session");
    updateThread("stale-metadata-session", { rolloutPath: stale.file, updatedAtMs: 1 });
    await expect(ensureExactConversationFresh(db, stale.id)).resolves.toMatchObject({ refreshed: false });

    const unreadable = await seed("unreadable-metadata-session");
    fs.rmSync(stateDbPath());
    fs.writeFileSync(stateDbPath(), "not sqlite");
    await expect(ensureExactConversationFresh(db, unreadable.id)).resolves.toMatchObject({ refreshed: false });
  });
});
