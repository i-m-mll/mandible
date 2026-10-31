import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { openDb, setDb } from "../src/db.js";
import { buildMetadataBackupSql } from "../src/ledger/backup.js";
import { configureIngestionWorker, ingestBatchForWorker, stopIngestionGracefully } from "../src/ingestion.js";
import { restoreConversationMetadata, inspectConversationRecovery } from "../src/conversations/recovery.js";
import { IngestionActor } from "../src/ingestion-actor.js";
import { ConversationSourceReader } from "../src/conversations/source-reader.js";
import { getConversationStructureCache } from "../src/conversations/structure-cache.js";
import { ConversationSearchCache, SourceBackedConversationSearchSourceAdapter } from "../src/conversations/search-cache.js";
import { testRuntimeRoot } from "./helpers/runtime-isolation.js";

it("restores authored metadata and discovers native content, with honest missing-source results", async () => {
  const root = fs.mkdtempSync(path.join(testRuntimeRoot, "recovery-"));
  const file = path.join(root, "home", ".codex", "sessions", "fixture.jsonl");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, [
    { type: "session_meta", timestamp: "2026-10-01T00:00:00Z", payload: { id: "recovery-session", cwd: root } },
    { type: "response_item", timestamp: "2026-10-01T00:00:01Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "restorable native needle" }] } },
  ].map(value => JSON.stringify(value)).join("\n") + "\n");
  const original = openDb(path.join(root, "original.db"));
  let restored: ReturnType<typeof openDb> | undefined;
  let actor: IngestionActor | undefined;
  let search: ConversationSearchCache | undefined;
  try {
    setDb(original);
    configureIngestionWorker(() => {}, () => {});
    await ingestBatchForWorker([file], true, true, true);
    const { id } = original.prepare("SELECT id FROM conversations WHERE session_id = 'recovery-session'").get() as { id: string };
    original.prepare("UPDATE conversations SET starred = 1, tags = '[\"retained\"]', notes = 'authored annotation' WHERE id = ?").run(id);
    const metadata = buildMetadataBackupSql(original);
    getConversationStructureCache(original).close();
    restored = restoreConversationMetadata(metadata, path.join(root, "restored.db"));
    expect((await new ConversationSourceReader(restored).readAll(id)).status).not.toBe("source");
    actor = new IngestionActor({ dbPath: path.join(root, "restored.db"), logger: () => {}, publish: () => {}, workerUrl: new URL("./helpers/ingestion-demand-worker.ts", import.meta.url) });
    await actor.reconcile();
    expect(restored.prepare("SELECT session_id, starred, tags, notes FROM conversations WHERE id = ?").get(id)).toEqual({
      session_id: "recovery-session", starred: 1, tags: '["retained"]', notes: "authored annotation",
    });
    const reader = new ConversationSourceReader(restored);
    const content = await reader.readAll(id);
    expect(content.status === "source" && content.value.map(block => block.content)).toEqual(["restorable native needle"]);
    search = new ConversationSearchCache(new SourceBackedConversationSearchSourceAdapter(restored), { cachePath: path.join(root, "search.db") });
    const found = await search.search({ conversationIds: [id], needle: "needle", limit: 5 });
    expect(found.matches.map(match => match.conversation_id)).toEqual([id]);
    fs.unlinkSync(file);
    await actor.reconcile();
    expect((await reader.readAll(id)).status).toBe("unavailable");
    const missing = await search.search({ conversationIds: [id], needle: "needle", limit: 5 });
    expect(missing.matches).toEqual([]);
    expect((await inspectConversationRecovery(restored)).conversations).toMatchObject([{ conversation_id: id, status: "unavailable" }]);
    expect(restored.prepare("SELECT notes FROM conversations WHERE id = ?").get(id)).toEqual({ notes: "authored annotation" });
  } finally {
    await actor?.close();
    search?.close();
    if (restored) { getConversationStructureCache(restored).close(); restored.close(); }
    await stopIngestionGracefully();
    original.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
