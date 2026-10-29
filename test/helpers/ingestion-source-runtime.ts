import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { openDb, setDb } from "../../src/db.js";
import { canUseDefaultIngestionWorker } from "../../src/ingestion-actor.js";
import { startIngestion, stopIngestionGracefully, triggerExactPathIngest, repairConversationSourceReadiness } from "../../src/ingestion.js";
import { readConversationSourceReadiness } from "../../src/conversations/source-readiness.js";
import { ConversationSourceReader } from "../../src/conversations/source-reader.js";
import { getConversationStructureCache } from "../../src/conversations/structure-cache.js";

assert.ok(process.versions.bun);
assert.ok(canUseDefaultIngestionWorker(), "Bun source entry point must support its default ingestion worker");
const root = process.argv[2];
const dbPath = path.join(root, "ledger.db");
const file = path.join(root, "home", ".gemini", "tmp", "fixture", "chats", "session-source-runtime.json");
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, JSON.stringify({ sessionId: "source-runtime", startTime: "2026-10-01T00:00:00Z",
  lastUpdated: "2026-10-01T00:00:01Z", messages: [{ id: "u1", type: "user", timestamp: "2026-10-01T00:00:00Z",
    content: "Source-runtime repair fixture" }] }));
const db = openDb(dbPath);
setDb(db);
let workerReady = false;
startIngestion((_level, message) => { if (message === "ingestion_worker_ready") workerReady = true; },
  { dbPath, background: false });
try {
  await triggerExactPathIngest(file);
  assert.ok(workerReady, "exact ingestion must run through the default source-runtime actor");
  const { id } = db.prepare("SELECT id FROM conversations WHERE source_path = ?").get(file) as { id: string };
  const mtime = fs.statSync(file).mtimeMs;
  db.prepare("UPDATE conversation_sources SET parser_version = 'old' WHERE conversation_id = ?").run(id);
  db.prepare("UPDATE conversation_source_versions SET normalization_version = 'old' WHERE source_id IN (SELECT id FROM conversation_sources WHERE conversation_id = ?)").run(id);
  assert.equal(readConversationSourceReadiness(db, id).status, "repair_needed");
  assert.equal((await repairConversationSourceReadiness(db, id)).status, "ready");
  assert.equal(fs.statSync(file).mtimeMs, mtime);
  const read = await new ConversationSourceReader(db, { legacyFallback: false }).readAll(id);
  assert.equal(read.status, "source");
  if (read.status === "source") assert.equal(read.value[0]?.content, "Source-runtime repair fixture");
  process.stdout.write("source-runtime actor repaired unchanged Gemini epochs\n");
} finally {
  await stopIngestionGracefully();
  getConversationStructureCache(db).close();
  db.close();
}
