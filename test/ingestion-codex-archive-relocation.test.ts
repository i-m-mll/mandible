import { openLogicalSource } from "../src/conversations/logical-source.js";
import { zstdCompressSync } from "node:zlib";
import { ConversationSourceReader } from "../src/conversations/source-reader.js";
import { ensureExactConversationFresh } from "../src/conversations/freshness.js";
// Bug: c927726 — `codex archive` moves a rollout out of ~/.codex/sessions into
// ~/.codex/archived_sessions. Mandible itself triggers that archive on
// successful auth merges and on session resume, so reconcile must treat the
// relocation as a move. Before the fix it treated the source as missing and
// deleted the conversation and every ingested block.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { setDb, type Db } from "../src/db.js";
import { triggerReconcileForTest, triggerTargetedIngest, triggerExactPathIngest } from "../src/ingestion.js";
import { getConversationStructureCache } from "../src/conversations/structure-cache.js";
import { migratedMemoryDb } from "./helpers/ledger-fixtures.js";

const ROLLOUT_NAME = "rollout-2026-08-11T09-15-00-019f8ab1-archive-move.jsonl";
const SESSION_ID = "019f8ab1-archive-move";

let tempDir = "";
let codexRoot = "";
let sessionsBase = "";
let archivedBase = "";
let sessionPath = "";
let archivedPath = "";
let db: Db;

function row(record: unknown): string {
  return `${JSON.stringify(record)}\n`;
}

function transcript(sessionId = SESSION_ID, prompt = "archive me"): string {
  return [
    row({
      type: "session_meta",
      timestamp: "2026-08-11T09:15:00.000Z",
      payload: { id: sessionId, cwd: "/tmp/project", model_provider: "openai" },
    }),
    row({
      type: "response_item",
      timestamp: "2026-08-11T09:15:01.000Z",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: prompt }],
      },
    }),
    row({
      type: "response_item",
      timestamp: "2026-08-11T09:15:02.000Z",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "archived reply" }],
      },
    }),
  ].join("");
}

function watchConfigs(): Array<{ base: string; glob: string }> {
  return [
    { base: sessionsBase, glob: "**/*.jsonl" },
    { base: archivedBase, glob: "**/*.jsonl" },
  ];
}

function conversationRow(sourcePath: string): { id: string; block_count: number } | undefined {
  return db
    .prepare("SELECT id, block_count FROM conversations WHERE source_path = ?")
    .get(sourcePath) as { id: string; block_count: number } | undefined;
}

function blockCount(conversationId: string): number {
  const source = db.prepare(`SELECT current_version_id FROM conversation_sources
    WHERE conversation_id = ? AND current_version_id IS NOT NULL`).get(conversationId) as {
      current_version_id: string;
    } | undefined;
  if (source) {
    const sparse = getConversationStructureCache(db)
      .blockCount(conversationId, source.current_version_id);
    if (sparse !== null) return sparse;
  }
  const result = db
    .prepare("SELECT COUNT(*) AS count FROM conversation_blocks WHERE conversation_id = ?")
    .get(conversationId) as { count: number };
  return result.count;
}

/** Same rename `codex archive` performs: sessions/YYYY/MM/DD/x -> archived_sessions/x. */
async function archiveRollout(): Promise<void> {
  await fsp.rename(sessionPath, archivedPath);
}

async function unarchiveRollout(): Promise<void> {
  await fsp.rename(archivedPath, sessionPath);
}

beforeEach(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-codex-archive-"));
  codexRoot = path.join(tempDir, ".codex");
  sessionsBase = path.join(codexRoot, "sessions");
  archivedBase = path.join(codexRoot, "archived_sessions");
  sessionPath = path.join(sessionsBase, "2026", "08", "11", ROLLOUT_NAME);
  archivedPath = path.join(archivedBase, ROLLOUT_NAME);
  await fsp.mkdir(path.dirname(sessionPath), { recursive: true });
  await fsp.mkdir(archivedBase, { recursive: true });
  await fsp.writeFile(sessionPath, transcript(), "utf8");
  db = migratedMemoryDb();
  setDb(db);
});

afterEach(() => {
  vi.unstubAllEnvs();
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("codex archive relocation", () => {

  it("discovers cold-only rollouts once and preserves pins, version and logical append coordinates", async () => {
    const raw = fs.readFileSync(sessionPath);
    fs.writeFileSync(`${sessionPath}.zst`, zstdCompressSync(raw));
    fs.unlinkSync(sessionPath);
    await triggerReconcileForTest({ watchConfigs: watchConfigs() });
    const conversation = conversationRow(sessionPath)!;
    expect(conversation).toBeDefined();
    db.prepare("UPDATE conversations SET starred = 1, notes = 'keep notes' WHERE id = ?").run(conversation.id);
    const before = db.prepare("SELECT current_version_id FROM conversation_sources WHERE conversation_id = ?").get(conversation.id);
    expect((await new ConversationSourceReader(db, { legacyFallback: false }).readAll(conversation.id)).status).toBe("source");
    db.prepare("UPDATE conversation_sources SET availability = 'missing' WHERE conversation_id = ?").run(conversation.id);
    db.prepare("UPDATE conversation_source_aliases SET availability = 'missing'").run();
    await ensureExactConversationFresh(db, conversation.id, { ingest: triggerExactPathIngest });
    fs.writeFileSync(sessionPath, raw);
    await triggerReconcileForTest({ watchConfigs: watchConfigs() });
    expect(db.prepare("SELECT current_version_id FROM conversation_sources WHERE conversation_id = ?").get(conversation.id)).toEqual(before);
    fs.appendFileSync(sessionPath, row({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "resumed" }] } }));
    await triggerReconcileForTest({ watchConfigs: watchConfigs() });
    const blocks = await new ConversationSourceReader(db, { legacyFallback: false }).readAll(conversation.id);
    expect(blocks.status).toBe("source");
    if (blocks.status === "source") expect(blocks.value.at(-1)?.content).toBe("resumed");
    expect(db.prepare("SELECT starred, notes FROM conversations WHERE id = ?").get(conversation.id)).toEqual({ starred: 1, notes: "keep notes" });
    expect(db.prepare("SELECT COUNT(*) AS n FROM conversations").get()).toEqual({ n: 1 });
  });

  it("reconciles unchanged compressed history larger than its retained cache without decoding or eviction", async () => {
    const cacheBase = path.join(tempDir, "cache");
    vi.stubEnv("XDG_CACHE_HOME", cacheBase);
    const cacheRoot = path.join(cacheBase, "mandible", "logical-sources");
    let historyBytes = 0;
    const files: string[] = [];
    for (let index = 0; index < 3; index++) {
      const file = index === 0 ? sessionPath : sessionPath.replace("archive-move", `archive-move-${index}`);
      const bytes = Buffer.from(transcript(`history-${index}`));
      historyBytes += bytes.length;
      fs.writeFileSync(file, bytes);
      files.push(file);
    }
    await triggerReconcileForTest({ watchConfigs: watchConfigs() });
    expect(db.prepare("SELECT COUNT(*) AS n FROM conversations").get()).toEqual({ n: 3 });
    for (const file of files) {
      const stat = fs.statSync(file);
      fs.writeFileSync(`${file}.zst`, zstdCompressSync(fs.readFileSync(file)));
      fs.utimesSync(`${file}.zst`, stat.atime, stat.mtime);
      fs.unlinkSync(file);
    }
    await triggerReconcileForTest({ watchConfigs: watchConfigs() });
    for (const file of files) {
      const version = db.prepare(`SELECT v.filesystem_inode FROM conversations c
        JOIN conversation_sources s ON s.conversation_id = c.id
        JOIN conversation_source_versions v ON v.id = s.current_version_id
        WHERE c.source_path = ?`).get(file) as { filesystem_inode: string };
      expect(version.filesystem_inode).toBe(String(fs.statSync(`${file}.zst`, { bigint: true }).ino));
    }
    const other = path.join(tempDir, "outside", ".codex", "sessions", "rollout-offscan.jsonl");
    fs.mkdirSync(path.dirname(other), { recursive: true });
    const bytes = Buffer.from(transcript("offscan"));
    fs.writeFileSync(`${other}.zst`, zstdCompressSync(bytes));
    const quota = bytes.length * 2;
    expect(historyBytes).toBeGreaterThan(quota);
    const lease = await openLogicalSource(other, { cacheRoot, cacheBytes: quota, maxLogicalBytes: bytes.length, reserveBytes: 0 });
    await lease.close();
    const payloads = () => fs.readdirSync(cacheRoot).filter((name) => name.endsWith(".jsonl")).sort()
      .map((name) => { const stat = fs.statSync(path.join(cacheRoot, name)); return [name, stat.ino, stat.size]; });
    const retained = payloads();
    expect(retained.reduce((total, row) => total + Number(row[2]), 0)).toBeLessThanOrEqual(quota);
    for (let pass = 0; pass < 3; pass++) await triggerReconcileForTest({ watchConfigs: watchConfigs() });
    expect(payloads()).toEqual(retained);
  });

  it("keeps the conversation and its blocks when a thread is archived", async () => {
    await triggerReconcileForTest({ watchConfigs: watchConfigs() });
    const ingested = conversationRow(sessionPath);
    expect(ingested).toBeDefined();
    expect(ingested!.block_count).toBeGreaterThan(0);
    expect(blockCount(ingested!.id)).toBe(ingested!.block_count);

    await archiveRollout();
    await triggerReconcileForTest({ watchConfigs: watchConfigs() });

    expect(conversationRow(sessionPath)).toBeUndefined();
    const relocated = conversationRow(archivedPath);
    expect(relocated).toBeDefined();
    // Same conversation identity, same blocks — a move, not a delete + re-add.
    expect(relocated!.id).toBe(ingested!.id);
    expect(blockCount(relocated!.id)).toBe(ingested!.block_count);
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM conversations").get(),
    ).toMatchObject({ count: 1 });
    // Append state follows the file so incremental ingestion stays continuous.
    expect(
      db.prepare("SELECT file_path FROM conversation_ingest_state WHERE file_path = ?")
        .get(archivedPath),
    ).toBeDefined();
    expect(
      db.prepare("SELECT file_path FROM conversation_ingest_state WHERE file_path = ?")
        .get(sessionPath),
    ).toBeUndefined();
    expect(db.prepare(`
      SELECT path, alias_kind, availability
        FROM conversation_source_aliases
       WHERE source_id = (SELECT id FROM conversation_sources WHERE conversation_id = ?)
       ORDER BY path
    `).all(ingested!.id)).toEqual([
      { path: archivedPath, alias_kind: "archive", availability: "available" },
      { path: sessionPath, alias_kind: "active", availability: "missing" },
    ].sort((a, b) => a.path.localeCompare(b.path)));
  });

  it("survives an archive/unarchive round trip", async () => {
    await triggerReconcileForTest({ watchConfigs: watchConfigs() });
    const ingested = conversationRow(sessionPath);
    expect(ingested).toBeDefined();

    await archiveRollout();
    await triggerReconcileForTest({ watchConfigs: watchConfigs() });
    expect(conversationRow(archivedPath)?.id).toBe(ingested!.id);

    await unarchiveRollout();
    await triggerReconcileForTest({ watchConfigs: watchConfigs() });

    const restored = conversationRow(sessionPath);
    expect(restored).toBeDefined();
    expect(restored!.id).toBe(ingested!.id);
    expect(blockCount(restored!.id)).toBe(ingested!.block_count);
    expect(conversationRow(archivedPath)).toBeUndefined();
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM conversations").get(),
    ).toMatchObject({ count: 1 });
  });

  it("does not collapse a distinct identity already using the archive path", async () => {
    await triggerReconcileForTest({ watchConfigs: watchConfigs() });
    const ingested = conversationRow(sessionPath)!;
    db.prepare(`
      INSERT INTO conversations (
        id, source, source_path, source_hash, source_mtime, title, started_at,
        block_count, session_id
      ) VALUES ('archive-path-bystander', 'codex', ?, 'bystander-hash', 0,
        'Bystander', datetime('now'), 1, 'archive-path-bystander')
    `).run(archivedPath);
    db.prepare(`
      INSERT INTO conversation_blocks (
        id, conversation_id, type, role, content, position, metadata_json
      ) VALUES ('archive-path-bystander-block', 'archive-path-bystander',
        'assistant_message', 'assistant', 'preserve me', 0, '{}')
    `).run();

    await archiveRollout();
    await triggerReconcileForTest({ watchConfigs: watchConfigs() });

    expect(db.prepare(
      "SELECT id FROM conversations WHERE source_path = ? ORDER BY id",
    ).all(archivedPath)).toEqual([
      { id: "archive-path-bystander" },
      { id: ingested.id },
    ].sort((a, b) => a.id.localeCompare(b.id)));
    expect(blockCount(ingested.id)).toBe(ingested.block_count);
    expect(db.prepare(
      "SELECT content FROM conversation_blocks WHERE id = 'archive-path-bystander-block'",
    ).get()).toEqual({ content: "preserve me" });
  });

  it("rejects an unrelated archive candidate and ingests it independently", async () => {
    await triggerReconcileForTest({ watchConfigs: watchConfigs() });
    const original = conversationRow(sessionPath)!;
    await fsp.rm(sessionPath);
    await fsp.writeFile(
      archivedPath,
      transcript("unrelated-archive-candidate", "different conversation"),
      "utf8",
    );

    // Exercise the watcher/unlink path: it must tombstone the missing locator
    // and explicitly ingest the unrelated candidate without a broad scan.
    await triggerTargetedIngest({ transcriptPath: sessionPath, now: 2_000 });

    expect(db.prepare(
      "SELECT id, source_path FROM conversations WHERE id = ?",
    ).get(original.id)).toEqual({ id: original.id, source_path: sessionPath });
    expect(blockCount(original.id)).toBe(original.block_count);
    expect(db.prepare(
      "SELECT session_id FROM conversations WHERE source_path = ?",
    ).get(archivedPath)).toEqual({ session_id: "unrelated-archive-candidate" });
    expect(db.prepare(
      "SELECT availability FROM conversation_sources WHERE conversation_id = ?",
    ).get(original.id)).toEqual({ availability: "missing" });
  });

  it("follows the move when the watcher reports the source as gone", async () => {
    await triggerReconcileForTest({ watchConfigs: watchConfigs() });
    const ingested = conversationRow(sessionPath);
    expect(ingested).toBeDefined();

    await archiveRollout();
    // The live watcher path: an unlink event ingests the vanished path.
    await triggerTargetedIngest({ transcriptPath: sessionPath, now: 1_000 });

    expect(conversationRow(archivedPath)?.id).toBe(ingested!.id);
    expect(blockCount(ingested!.id)).toBe(ingested!.block_count);
  });

  it("tombstones a genuinely missing source without deleting its durable identity", async () => {
    await triggerReconcileForTest({ watchConfigs: watchConfigs() });
    expect(conversationRow(sessionPath)).toBeDefined();

    await fsp.rm(sessionPath);
    await triggerReconcileForTest({ watchConfigs: watchConfigs() });

    expect(
      db.prepare("SELECT COUNT(*) AS count FROM conversations").get(),
    ).toMatchObject({ count: 1 });
    expect(db.prepare(`
      SELECT availability FROM conversation_sources
       WHERE conversation_id = (SELECT id FROM conversations WHERE source_path = ?)
    `).get(sessionPath)).toEqual({ availability: "missing" });
    expect(blockCount(conversationRow(sessionPath)!.id)).toBeGreaterThan(0);
  });
});
