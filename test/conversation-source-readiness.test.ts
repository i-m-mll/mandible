import { migratedFileDb } from './helpers/ledger-fixtures.js';
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setDb, type Db } from "../src/db.js";
import { IngestionActor } from "../src/ingestion-actor.js";
import { repairConversationSourceReadiness, startIngestion, stopIngestionGracefully } from "../src/ingestion.js";
import { readConversationSourceReadiness } from "../src/conversations/source-readiness.js";
import { ConversationSourceStore } from "../src/conversations/source-store.js";
import { ConversationSourceReader } from "../src/conversations/source-reader.js";
import { CURRENT_CONVERSATION_SOURCE_EPOCHS } from "../src/conversations/source-types.js";
import { ConversationStructureCache, getConversationStructureCache } from "../src/conversations/structure-cache.js";

let actor: IngestionActor;
vi.mock("../src/ingestion-actor.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/ingestion-actor.js")>();
  return { ...actual, canUseDefaultIngestionWorker: () => true,
    IngestionActor: class extends actual.IngestionActor {
      constructor(options: import("../src/ingestion-actor.js").IngestionActorOptions) {
        super({ ...options, workerUrl: new URL("./helpers/ingestion-demand-worker.ts", import.meta.url) });
        actor = this;
      }
    } };
});

let root: string;
let db: Db;
const observations: Array<{ message: string; details?: Record<string, unknown> }> = [];
const row = (value: unknown) => `${JSON.stringify(value)}\n`;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-source-readiness-"));
  db = migratedFileDb(path.join(root, "ledger.db"));
  setDb(db);
  observations.length = 0;
  startIngestion((_level, message, details) => observations.push({ message, details }),
    { dbPath: path.join(root, "ledger.db"), background: false });
});

afterEach(async () => {
  await stopIngestionGracefully();
  getConversationStructureCache(db).close();
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

function source(provider: "codex" | "claude" | "gemini-jsonl" | "gemini-json"): string {
  const home = path.join(root, "home");
  let file: string;
  let content: string;
  if (provider === "codex") {
    file = path.join(home, ".codex", "sessions", "fixture.jsonl");
    content = row({ type: "session_meta", timestamp: "2026-10-01T00:00:00Z", payload: { id: "fixture", cwd: "/tmp/project" } })
      + row({ type: "response_item", timestamp: "2026-10-01T00:00:01Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "needle provider content" }] } });
  } else if (provider === "claude") {
    file = path.join(home, ".claude", "projects", "fixture", "fixture.jsonl");
    content = row({ uuid: "u1", type: "user", timestamp: "2026-10-01T00:00:00Z", sessionId: "fixture", cwd: "/tmp/project",
      message: { role: "user", content: "needle provider content" } });
  } else {
    const messages = [{ id: "u1", type: "user", timestamp: "2026-10-01T00:00:00Z", content: "needle provider content" }];
    const header = { sessionId: "fixture", startTime: "2026-10-01T00:00:00Z", lastUpdated: "2026-10-01T00:00:01Z" };
    file = path.join(home, ".gemini", "tmp", "fixture", "chats", `session-fixture.${provider === "gemini-json" ? "json" : "jsonl"}`);
    content = provider === "gemini-json" ? JSON.stringify({ ...header, messages }) : row(header) + messages.map(row).join("");
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

async function seed(provider: Parameters<typeof source>[0] = "codex") {
  const file = source(provider);
  await actor.ingest([file]);
  const conversation = db.prepare("SELECT id, block_count FROM conversations WHERE source_path = ?")
    .get(file) as { id: string; block_count: number };
  expect(conversation).toBeDefined();
  expect(readConversationSourceReadiness(db, conversation.id).status).toBe("ready");
  return { file, id: conversation.id, blockCount: conversation.block_count };
}

describe("source metadata readiness and canonical ingestion repair", () => {
  it.each(["codex", "claude", "gemini-jsonl", "gemini-json"] as const)("repairs unchanged %s epochs during reconciliation", async (provider) => {
    const { file, id } = await seed(provider);
    const beforeMtime = fs.statSync(file).mtimeMs;
    db.prepare("UPDATE conversation_sources SET normalization_version = 'old' WHERE conversation_id = ?").run(id);
    db.prepare("UPDATE conversation_source_versions SET parser_version = 'old' WHERE source_id IN (SELECT id FROM conversation_sources WHERE conversation_id = ?)").run(id);
    expect(readConversationSourceReadiness(db, id)).toMatchObject({ status: "repair_needed", reason: "epochs_outdated" });
    expect((await new ConversationSourceReader(db).readAll(id)).status).not.toBe("source");
    await actor.reconcile();
    expect(fs.statSync(file).mtimeMs).toBe(beforeMtime);
    expect(readConversationSourceReadiness(db, id).status).toBe("ready");
    const read = await new ConversationSourceReader(db).readAll(id);
    expect(read.status).toBe("source");
    if (read.status === "source") expect(read.value.some((block) => block.content.includes("needle provider content"))).toBe(true);
  });

  it.each(["missing", "old-epochs"])("repairs %s sparse projection while source metadata and mtime are current", async (failure) => {
    const { file, id } = await seed();
    const readiness = readConversationSourceReadiness(db, id);
    const cache = getConversationStructureCache(db);
    const rows = cache.readPage(id, readiness.sourceVersionId!, { offset: 0, limit: 10 })!.rows;
    cache.clear();
    cache.replaceRows({ conversation_id: id, source_version_id: readiness.sourceVersionId!,
      parser_format: CURRENT_CONVERSATION_SOURCE_EPOCHS.parserFormat,
      parser_version: failure === "old-epochs" ? "old" : CURRENT_CONVERSATION_SOURCE_EPOCHS.parserVersion,
      normalization_version: CURRENT_CONVERSATION_SOURCE_EPOCHS.normalizationVersion,
      redaction_epoch: CURRENT_CONVERSATION_SOURCE_EPOCHS.redactionEpoch, block_count: failure === "missing" ? 0 : rows.length }, failure === "missing" ? [] : rows);
    expect(readConversationSourceReadiness(db, id)).toMatchObject({ status: "repair_needed", reason: "projection_incomplete" });
    const mtime = fs.statSync(file).mtimeMs;
    const repaired = await repairConversationSourceReadiness(db, id);
    expect(repaired.status).toBe("ready");
    expect(fs.statSync(file).mtimeMs).toBe(mtime);
    expect((await new ConversationSourceReader(db).readAll(id)).status).toBe("source");
  });

  it("isolates independent ledger caches outside the test environment", async () => {
    const { id } = await seed();
    const version = readConversationSourceReadiness(db, id).sourceVersionId!;
    const rows = getConversationStructureCache(db).readPage(id, version, { offset: 0, limit: 10 })!.rows;
    const otherDb = migratedFileDb(path.join(root, "other-ledger.db"));
    const environment = { VITEST: process.env.VITEST, NODE_ENV: process.env.NODE_ENV };
    process.env.VITEST = "false"; process.env.NODE_ENV = "production";
    const first = new ConversationStructureCache(db);
    const second = new ConversationStructureCache(otherDb);
    try {
      first.replaceRows({ conversation_id: id, source_version_id: version,
        parser_format: CURRENT_CONVERSATION_SOURCE_EPOCHS.parserFormat, parser_version: CURRENT_CONVERSATION_SOURCE_EPOCHS.parserVersion,
        normalization_version: CURRENT_CONVERSATION_SOURCE_EPOCHS.normalizationVersion,
        redaction_epoch: CURRENT_CONVERSATION_SOURCE_EPOCHS.redactionEpoch, block_count: rows.length }, rows);
      expect(second.readPage(id, version, { offset: 0, limit: 10 })).toBeNull();
    } finally {
      first.close(); second.close(); otherDb.close();
      for (const [key, value] of Object.entries(environment)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
  });

  it("finishes an admitted scan while newer publications prune its navigation generation", async () => {
    const { file, id } = await seed();
    const append = (index: number) => fs.appendFileSync(file, row({ type: "response_item", timestamp: `2026-10-01T00:00:${index + 2}Z`,
      payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: `tail ${index}` }] } }));
    append(0); append(1);
    await actor.ingest([file]);
    const before = readConversationSourceReadiness(db, id).sourceVersionId!;
    const contents: string[] = [];
    const scan = await new ConversationSourceReader(db).scanBlocks(id, async block => {
      contents.push(block.content);
      if (contents.length === 1) {
        for (let index = 2; index < 8; index++) { append(index); await actor.ingest([file]); }
        expect(getConversationStructureCache(db).blockCount(id, before)).toBeNull();
      }
    }, { pageSize: 1 });
    expect(scan.status).toBe("source");
    expect(contents).toEqual(["needle provider content", "tail 0", "tail 1"]);
    expect(readConversationSourceReadiness(db, id).status).toBe("ready");
  });

  it("reports unavailable repair ownership without parsing on the request thread", async () => {
    const { id } = await seed();
    db.prepare("UPDATE conversation_sources SET parser_version = 'old' WHERE conversation_id = ?").run(id);
    await stopIngestionGracefully();
    expect(await repairConversationSourceReadiness(db, id)).toMatchObject({ status: "unavailable", reason: "repair_unavailable" });
    expect(readConversationSourceReadiness(db, id).status).toBe("repair_needed");
  });

  it.each(["missing", "corrupt"] as const)("keeps %s provider bytes unavailable after repair", async (failure) => {
    const { file, id } = await seed();
    db.prepare("UPDATE conversation_sources SET parser_version = 'old' WHERE conversation_id = ?").run(id);
    if (failure === "missing") fs.unlinkSync(file);
    else fs.writeFileSync(file, "{not valid provider json}\n");
    const repaired = await repairConversationSourceReadiness(db, id);
    expect(repaired.status).toBe("unavailable");
    expect((await new ConversationSourceReader(db).readAll(id)).status).not.toBe("source");
  });

  it("accepts a proved zero-block native projection without scheduling another parse", async () => {
    const { file, id } = await seed();
    const content = row({ type: "session_meta", payload: { id: "fixture", cwd: "/tmp/project" } });
    fs.writeFileSync(file, content);
    db.prepare("UPDATE conversations SET block_count = 0, source_mtime = ? WHERE id = ?").run(fs.statSync(file).mtimeMs, id);
    await new ConversationSourceStore(db).recordConversation({ conversationId: id, provider: "codex", nativeSessionId: "fixture",
      filePath: file, expectedContentHash: createHash("sha256").update(content).digest("hex"), blocks: [], structuralMode: "replace", ...CURRENT_CONVERSATION_SOURCE_EPOCHS });
    db.prepare("UPDATE conversation_ingest_state SET byte_offset = ?, tail_hash = ?, line_count = 1, partial_line = '' WHERE file_path = ?")
      .run(Buffer.byteLength(content), createHash("sha256").update(content).digest("hex"), file);
    expect(readConversationSourceReadiness(db, id).status).toBe("ready");
    const calls = observations.filter((event) => event.message === "source_start").length;
    expect((await repairConversationSourceReadiness(db, id)).status).toBe("ready");
    await actor.reconcile();
    expect(observations.filter((event) => event.message === "source_start")).toHaveLength(calls);
  });
});
