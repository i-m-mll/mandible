import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { setDb, type Db } from "../src/db.js";
import { triggerReconcileForTest, triggerTargetedIngest } from "../src/ingestion.js";
import type { Logger } from "../src/types.js";
import { migratedMemoryDb } from "./helpers/ledger-fixtures.js";

let tempDir = "";
let watchBase = "";
let sessionDir = "";
let sessionPath = "";
let db: Db;

function row(record: unknown): string {
  return `${JSON.stringify(record)}\n`;
}

function sessionMeta(): string {
  return row({
    type: "session_meta",
    timestamp: "2026-07-14T00:00:00.000Z",
    payload: { id: "empty-cache", cwd: "/tmp/project", model_provider: "openai" },
  });
}

function meaningfulSession(): string {
  return `${sessionMeta()}${row({
    type: "response_item",
    timestamp: "2026-07-14T00:00:01.000Z",
    payload: {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "now meaningful" }],
    },
  })}`;
}

function insertLegacyPathDuplicate(
  id: string,
  nativeSessionId: string,
  sourcePath = sessionPath,
): void {
  db.prepare(`
    INSERT INTO conversations (
      id, source, source_path, source_hash, source_mtime,
      title, started_at, block_count, session_id
    ) VALUES (?, 'codex', ?, ?, 0, 'preserved legacy row', datetime('now'), 1, ?)
  `).run(id, sourcePath, `legacy-hash-${id}`, nativeSessionId);
  db.prepare(`
    INSERT INTO conversation_blocks (
      id, conversation_id, type, role, content, compressed, position, metadata_json
    ) VALUES (?, ?, 'user_message', 'user', 'preserved legacy body', 0, 0, '{}')
  `).run(`block-${id}`, id);
  db.prepare(`
    INSERT INTO conversation_sources (
      id, conversation_id, provider, native_session_id, parser_format,
      parser_version, normalization_version, availability, custody_state,
      current_version_id, created_at, updated_at
    ) VALUES (?, ?, 'codex', ?, 'codex-jsonl', 'legacy', 'legacy',
              'unchecked', 'provider', NULL, ?, ?)
  `).run(`source-${id}`, id, nativeSessionId, Date.now(), Date.now());
}

function watchConfigs(): Array<{ base: string; glob: string }> {
  return [{ base: watchBase, glob: "**/*.jsonl" }];
}

async function writeAtTick(content: string, tick: number): Promise<void> {
  await fsp.writeFile(sessionPath, content, "utf8");
  const timestamp = new Date(1_800_000_000_000 + tick * 1000);
  await fsp.utimes(sessionPath, timestamp, timestamp);
}

beforeEach(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-ingestion-empty-cache-"));
  watchBase = path.join(tempDir, ".codex", "sessions");
  sessionDir = path.join(watchBase, "2026", "07", "14");
  sessionPath = path.join(sessionDir, "rollout-2026-07-14T00-00-00-empty-cache.jsonl");
  await fsp.mkdir(sessionDir, { recursive: true });
  db = migratedMemoryDb();
  setDb(db);
});

afterEach(() => {
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("empty conversation ingest state", () => {

  it("reconciles same-native-identity path duplicates without merging legacy bodies", async () => {
    await writeAtTick(meaningfulSession(), 1);
    await triggerTargetedIngest({ transcriptPath: sessionPath, now: 1_000 });
    const owner = db.prepare(
      "SELECT id FROM conversations WHERE source_path = ?",
    ).get(sessionPath) as { id: string };
    insertLegacyPathDuplicate("legacy-same-identity", "empty-cache");
    const events: string[] = [];

    await triggerReconcileForTest({
      watchConfigs: watchConfigs(),
      log: (_level, event) => events.push(event),
    });

    expect(db.prepare(
      "SELECT id FROM conversations WHERE source_path = ?",
    ).all(sessionPath)).toEqual([{ id: owner.id }]);
    expect(db.prepare(
      "SELECT source_path FROM conversations WHERE id = 'legacy-same-identity'",
    ).get()).toEqual({
      source_path: "mandible-preserved://conversation/legacy-same-identity",
    });
    expect(db.prepare(
      "SELECT content FROM conversation_blocks WHERE conversation_id = 'legacy-same-identity'",
    ).get()).toEqual({ content: "preserved legacy body" });
    expect(db.prepare(`
      SELECT availability, unavailable_reason FROM conversation_sources
       WHERE conversation_id = 'legacy-same-identity'
    `).get()).toEqual({
      availability: "missing",
      unavailable_reason: "legacy source path projection detached; no available alias",
    });
    expect(events).toContain("ingestion_duplicate_path_ownership_reconciled");
    expect(events).not.toContain("ingestion_duplicate_conversation_rows");
  });

  it("does not re-parse an unchanged empty source during reconcile", async () => {
    await writeAtTick(sessionMeta(), 1);
    const events: string[] = [];
    const log: Logger = (_level, event) => events.push(event);

    await triggerReconcileForTest({ watchConfigs: watchConfigs(), log });
    db.prepare("UPDATE conversation_ingest_state SET updated_at = 123 WHERE file_path = ?")
      .run(sessionPath);
    await triggerTargetedIngest({ transcriptPath: sessionPath, now: 1_000 });
    await triggerReconcileForTest({ watchConfigs: watchConfigs(), log });

    expect(events.filter((event) => event === "ingestion_skip_empty")).toHaveLength(1);
    expect(
      db.prepare(`
        SELECT empty_source_mtime, empty_source_size, updated_at
        FROM conversation_ingest_state
        WHERE file_path = ?
      `).get(sessionPath),
    ).toMatchObject({
      empty_source_mtime: fs.statSync(sessionPath).mtimeMs,
      empty_source_size: fs.statSync(sessionPath).size,
      updated_at: 123,
    });
    expect(
      db.prepare("SELECT id FROM conversations WHERE source_path = ?").get(sessionPath),
    ).toBeUndefined();
  });

  it("invalidates a changed empty fingerprint and ingests the new conversation", async () => {
    await writeAtTick(sessionMeta(), 1);
    await triggerReconcileForTest({ watchConfigs: watchConfigs() });

    await writeAtTick(meaningfulSession(), 2);
    await triggerReconcileForTest({ watchConfigs: watchConfigs() });

    expect(
      db.prepare("SELECT session_id, block_count FROM conversations WHERE source_path = ?")
        .get(sessionPath),
    ).toMatchObject({ session_id: "empty-cache", block_count: 1 });
    expect(
      db.prepare(`
        SELECT empty_source_mtime, empty_source_size
        FROM conversation_ingest_state
        WHERE file_path = ?
      `).get(sessionPath),
    ).toMatchObject({ empty_source_mtime: null, empty_source_size: null });
  });
});
