import { inlineLedgerReader } from "../src/ledger-reads/index.js";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import SqliteDatabase from "../src/sqlite.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setDb, type Db } from "../src/db.js";
import {
  ConversationFreshnessError,
  ensureExactConversationFresh,
  resolveExactConversation,
} from "../src/conversations/freshness.js";
import {
  ingestExactSelectedPath,
  triggerExactPathIngest,
  triggerTargetedIngest,
  configureIngestionWorker,
} from "../src/ingestion.js";
import { registerConversationRoutes } from "../src/routes/conversations.js";
import { Router } from "../src/server.js";
import { ConversationSourceReader } from "../src/conversations/source-reader.js";
import { ConversationSourceChangedError } from "../src/conversations/source-store.js";
import { sourceFilesystemIdentity } from "../src/conversations/source-observer.js";
import { FileRpcTransport } from "../src/file-rpc-transport.js";
import { resolveInstanceInfo } from "../src/instance-policy.js";
import { migratedMemoryDb } from "./helpers/ledger-fixtures.js";

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
  db = migratedMemoryDb();
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
    registerConversationRoutes(router, inlineLedgerReader());
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
    await expect(ensureExactConversationFresh(db, seeded.id, { ingest: slowIngest })).resolves.toMatchObject({ conversationId: seeded.id });
    expect(ingests).toBe(1);
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
      registerConversationRoutes(router, inlineLedgerReader());
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
      registerConversationRoutes(router, inlineLedgerReader());
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
});
