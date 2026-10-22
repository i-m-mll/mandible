// Bug: c927726 — `codex archive` moves a rollout out of ~/.codex/sessions into
// ~/.codex/archived_sessions. Mandible itself triggers that archive on
// successful auth merges and on session resume, so reconcile must treat the
// relocation as a move. Before the fix it treated the source as missing and
// deleted the conversation and every ingested block.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { openDb, setDb, type Db } from "../../src/db.js";
import { triggerReconcileForTest, triggerTargetedIngest } from "../../src/ingestion.js";
import { CodexParser } from "../../src/parsers/codex.js";
import { getConversationStructureCache } from "../../src/conversations/structure-cache.js";

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
  db = openDb(path.join(tempDir, "mandible.db"));
  setDb(db);
});

afterEach(() => {
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("codex archive relocation", () => {
  it("parses archived rollouts", () => {
    const parser = new CodexParser();
    expect(parser.canParse(sessionPath)).toBe(true);
    expect(parser.canParse(archivedPath)).toBe(true);
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

  it("atomically displaces a source-backed destination owner during verified relocation", async () => {
    await fsp.writeFile(
      archivedPath,
      transcript("archive-destination-owner", "destination history"),
      "utf8",
    );
    await triggerReconcileForTest({ watchConfigs: watchConfigs() });

    const relocating = db.prepare(
      "SELECT id, block_count FROM conversations WHERE session_id = ?",
    ).get(SESSION_ID) as { id: string; block_count: number };
    const destinationOwner = db.prepare(
      "SELECT id, block_count FROM conversations WHERE session_id = 'archive-destination-owner'",
    ).get() as { id: string; block_count: number };
    const relocatingSource = db.prepare(
      "SELECT id, current_version_id FROM conversation_sources WHERE conversation_id = ?",
    ).get(relocating.id) as { id: string; current_version_id: string };
    const destinationSource = db.prepare(
      "SELECT id, current_version_id FROM conversation_sources WHERE conversation_id = ?",
    ).get(destinationOwner.id) as { id: string; current_version_id: string };
    const destinationAlias = db.prepare(
      "SELECT id FROM conversation_source_aliases WHERE path = ?",
    ).get(archivedPath) as { id: string };

    // The destination bytes now prove the original identity, while the source
    // ledger still records a complete historical owner for that locator.
    await fsp.writeFile(archivedPath, transcript(), "utf8");
    await fsp.rm(sessionPath);
    await triggerTargetedIngest({ transcriptPath: sessionPath, now: 2_000 });

    expect(db.prepare(
      "SELECT id, source_path FROM conversations WHERE id = ?",
    ).get(relocating.id)).toEqual({ id: relocating.id, source_path: archivedPath });
    expect(db.prepare(
      "SELECT id, source_path FROM conversations WHERE id = ?",
    ).get(destinationOwner.id)).toEqual({ id: destinationOwner.id, source_path: archivedPath });
    expect(blockCount(relocating.id)).toBe(relocating.block_count);
    expect(blockCount(destinationOwner.id)).toBe(destinationOwner.block_count);

    expect(db.prepare(`
      SELECT availability, unavailable_reason
        FROM conversation_sources
       WHERE id = ?
    `).get(destinationSource.id)).toEqual({
      availability: "missing",
      unavailable_reason: "destination alias transferred during verified relocation",
    });
    expect(db.prepare(
      "SELECT availability FROM conversation_source_versions WHERE id = ?",
    ).get(destinationSource.current_version_id)).toEqual({ availability: "missing" });
    expect(db.prepare(`
      SELECT availability FROM conversation_sources WHERE id = ?
    `).get(relocatingSource.id)).toEqual({ availability: "available" });
    expect(db.prepare(
      "SELECT availability FROM conversation_source_versions WHERE id = ?",
    ).get(relocatingSource.current_version_id)).toEqual({ availability: "available" });
    const relocatedAlias = db.prepare(`
      SELECT id, source_id, availability
        FROM conversation_source_aliases
       WHERE path = ?
    `).all(archivedPath) as Array<{ id: string; source_id: string; availability: string }>;
    expect(relocatedAlias).toHaveLength(1);
    expect(relocatedAlias[0]?.id).not.toBe(destinationAlias.id);
    expect(relocatedAlias[0]).toEqual({
      id: expect.any(String),
      source_id: relocatingSource.id,
      availability: "available",
    });
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

  it("repoints only the matching identity when an old locator has multiple histories", async () => {
    await triggerReconcileForTest({ watchConfigs: watchConfigs() });
    const matching = conversationRow(sessionPath)!;
    db.prepare(`
      INSERT INTO conversations (
        id, source, source_path, source_hash, source_mtime, title, started_at,
        block_count, session_id
      ) VALUES ('old-locator-history', 'codex', ?, 'historical-hash', 0,
        'Historical', datetime('now'), 1, 'old-locator-history')
    `).run(sessionPath);
    db.prepare(`
      INSERT INTO conversation_blocks (
        id, conversation_id, type, role, content, position, metadata_json
      ) VALUES ('old-locator-history-block', 'old-locator-history',
        'assistant_message', 'assistant', 'historical body', 0, '{}')
    `).run();

    await archiveRollout();
    await triggerReconcileForTest({ watchConfigs: watchConfigs() });

    expect(db.prepare(
      "SELECT id, source_path FROM conversations WHERE id = ?",
    ).get(matching.id)).toEqual({ id: matching.id, source_path: archivedPath });
    expect(db.prepare(
      "SELECT id, source_path FROM conversations WHERE id = 'old-locator-history'",
    ).get()).toEqual({ id: "old-locator-history", source_path: sessionPath });
    expect(db.prepare(
      "SELECT content FROM conversation_blocks WHERE id = 'old-locator-history-block'",
    ).get()).toEqual({ content: "historical body" });
    expect(blockCount(matching.id)).toBe(matching.block_count);
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

  it("ingests an archived rollout that was never seen under sessions", async () => {
    await archiveRollout();
    await triggerReconcileForTest({ watchConfigs: watchConfigs() });

    const ingested = conversationRow(archivedPath);
    expect(ingested).toBeDefined();
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
