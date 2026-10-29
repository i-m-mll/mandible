import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { zstdCompressSync } from "node:zlib";
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as logicalSource from "../src/conversations/logical-source.js";
import { ConversationSourceReader } from "../src/conversations/source-reader.js";
import { ConversationSourceStore } from "../src/conversations/source-store.js";
import { getConversationStructureCache } from "../src/conversations/structure-cache.js";
import { CURRENT_CONVERSATION_SOURCE_EPOCHS } from "../src/conversations/source-types.js";
import { MANAGED_NORMALIZED_SOURCE_EPOCHS } from "../src/conversations/managed-normalized-source.js";
import { ConversationSearchCache, SourceBackedConversationSearchSourceAdapter } from "../src/conversations/search-cache.js";
import { CodexParser } from "../src/parsers/codex.js";
import { ClientAuthenticator } from "../src/client-auth/authenticator.js";
import { setupOperator, revokeCredential } from "../src/users/store.js";
import { migratedMemoryDb } from "./helpers/ledger-fixtures.js";

let root: string;
let db: ReturnType<typeof migratedMemoryDb>;
const caches: ConversationSearchCache[] = [];
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-search-stream-")); db = migratedMemoryDb(); });
afterEach(() => {
  vi.restoreAllMocks();
  for (const cache of caches.splice(0)) cache.close();
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

async function fixture(texts: string[], compressed = false, id = "stream", partialLine = "", preserveDense = false) {
  const filePath = path.join(root, `.codex/sessions/2026/10/29/${id}.jsonl`);
  const rows = [
    { type: "session_meta", timestamp: "2026-10-29T00:00:00Z", payload: { id, cwd: "/tmp/project" } },
    ...texts.map(text => ({ type: "response_item", timestamp: "2026-10-29T00:00:01Z", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text }] } })),
  ];
  const bytes = Buffer.from((rows.map(row => JSON.stringify(row)).join("\n") + "\n")
    .replaceAll("EscapedAsciiNeedle", "\\u0045scapedAsciiNeedle") + partialLine);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(compressed ? `${filePath}.zst` : filePath, compressed ? zstdCompressSync(bytes) : bytes);
  const parsed = await new CodexParser().parse(filePath) ?? (texts.length === 0 ? {
    conversation: { source_hash: createHash("sha256").update(bytes).digest("hex"), source_mtime: fs.statSync(compressed ? `${filePath}.zst` : filePath).mtimeMs },
    blocks: [],
  } : null);
  if (!parsed) throw new Error("fixture did not parse");
  db.prepare(`INSERT INTO conversations (id,source,source_path,source_hash,source_mtime,title,started_at,session_id,block_count,tags,created_at,updated_at)
    VALUES (?, 'codex', ?, ?, ?, 'Stream', '2026-10-29', ?, ?, '[]', '2026-10-29', '2026-10-29')`)
    .run(id, filePath, parsed.conversation.source_hash, parsed.conversation.source_mtime, id, parsed.blocks.length);
  await new ConversationSourceStore(db).recordConversation({ conversationId: id, provider: "codex", nativeSessionId: id, filePath,
    blocks: parsed.blocks.map(block => ({ ...block, legacyId: `${id}-${block.position}` })), ...CURRENT_CONVERSATION_SOURCE_EPOCHS });
  getConversationStructureCache(db).captureDenseRows(db, id, "replace");
  if (!preserveDense) db.prepare("DELETE FROM conversation_structural_blocks WHERE conversation_id = ?").run(id);
  return { filePath, bytes, id };
}

describe("verified conversation scans", () => {
  it.each([false, true])("reuses one descriptor and never reads later pages for an early match (zstd=%s)", async compressed => {
    const texts = Array.from({ length: 130 }, (_, index) => index === 0 ? "Early é.\nneedle" : index === 125 ? "Late needle" : `body ${index}`);
    const source = await fixture(texts, compressed);
    const reads: Array<{ position: number; length: number }> = [];
    const open = vi.spyOn(logicalSource, "openLogicalSource");
    const reader = new ConversationSourceReader(db, { legacyFallback: false, instrumentation: read => reads.push(read) });
    const early = await reader.scanBlocks(source.id, block => block.content.includes("é.\n") ? "stop" : undefined);
    expect(early).toMatchObject({ status: "source", value: { count: 1, complete: false } });
    expect(open).toHaveBeenCalledTimes(1);
    const later = source.bytes.indexOf(Buffer.from(JSON.stringify("body 32")));
    expect(reads.every(read => read.position + read.length < later)).toBe(true);
    const all = await reader.readAll(source.id);
    expect(open).toHaveBeenCalledTimes(2);
    expect(all.status).toBe("source");
    if (all.status !== "source") throw new Error("expected verified source");
    expect(all.value.map(block => block.content)).toEqual(texts);
    const page = await reader.readPage(source.id, { offset: 30, limit: 5 });
    expect(page).toMatchObject({ status: "source", value: { blocks: all.value.slice(30, 35), total: 130, offset: 30, limit: 5 } });
    const late = await reader.scanBlocks(source.id, block => block.content === "Late needle" ? "stop" : undefined);
    expect(late).toMatchObject({ status: "source", value: { count: 126, complete: false } });
    const absent = await reader.scanBlocks(source.id, () => {});
    expect(absent).toMatchObject({ status: "source", value: { count: 130, complete: true } });
  });

  it("publishes first exact masked matches without caching a partial conversation", async () => {
    const token = `mandible_pat_${"U".repeat(43)}`;
    const source = await fixture([`prefix ${token}`, "Short x", "é.\nNeedle", ...Array.from({ length: 65 }, (_, i) => `tail ${i}`)], true);
    const cache = new ConversationSearchCache(new SourceBackedConversationSearchSourceAdapter(db), { cachePath: ":memory:" });
    caches.push(cache);
    for (const [needle, position] of [["prefix", 0], ["x", 0], ["é.\nneedle", 2]] as const) {
      const found = await cache.search({ conversationIds: [source.id], needle, limit: 1 });
      expect(found.failures).toEqual([]);
      expect(found.matches).toMatchObject([{ block_id: `cblk:${source.id}:${position}` }]);
      expect(JSON.stringify(found.matches)).not.toContain(token);
      expect(found.metrics.cold_blocks).toBeLessThan(69);
    }
    const filtered = await cache.search({ conversationIds: [source.id], needle: "prefix", blockType: "user_message", limit: 1 });
    expect(filtered.matches).toEqual([]);
    const masked = await cache.search({ conversationIds: [source.id], needle: token, limit: 1 });
    expect(masked.matches).toEqual([]);
    await cache.whenIdle();
    fs.unlinkSync(`${source.filePath}.zst`);
    const removed = await cache.search({ conversationIds: [source.id], needle: "prefix", limit: 1 });
    expect(removed.matches).toEqual([]);
    expect(removed.failures).toMatchObject([{ conversation_id: source.id }]);
    const removedNegative = await cache.search({ conversationIds: [source.id], needle: "absent", limit: 1 });
    expect(removedNegative.failures).toMatchObject([{ conversation_id: source.id }]);
    fs.writeFileSync(`${source.filePath}.zst`, zstdCompressSync(source.bytes));
    expect((await cache.search({ conversationIds: [source.id], needle: "prefix", limit: 1 })).matches).toHaveLength(1);
  });

  it("searches normalized escaped JSON literals and enforces pinned versions", async () => {
    const source = await fixture(["EscapedAsciiNeedle"]);
    const adapter = new SourceBackedConversationSearchSourceAdapter(db);
    const version = adapter.describe([source.id])[0].sourceVersionId;
    const cache = new ConversationSearchCache(adapter, { cachePath: ":memory:" });
    caches.push(cache);
    const found = await cache.search({ conversationIds: [source.id], needle: "EscapedAsciiNeedle", limit: 1, expectedSourceVersions: { [source.id]: version } });
    expect(found.matches).toHaveLength(1);
    const stale = await cache.search({ conversationIds: [source.id], needle: "EscapedAsciiNeedle", limit: 1, expectedSourceVersions: { [source.id]: "older-version" } });
    expect(stale.matches).toEqual([]);
    expect(stale.failures).toMatchObject([{ conversation_id: source.id, status: "stale" }]);
  });

  it("preserves current dense block identity across pinned cold search, hot search and complete reads", async () => {
    const source = await fixture(["first needle", "later needle"], false, "dense", "", true);
    const reader = new ConversationSourceReader(db);
    const all = await reader.readAll(source.id);
    if (all.status !== "source") throw new Error("expected current dense source");
    const version = all.sourceVersionId;
    const cache = new ConversationSearchCache(new SourceBackedConversationSearchSourceAdapter(db), { cachePath: ":memory:" });
    caches.push(cache);
    const input = { conversationIds: [source.id], limit: 1, expectedSourceVersions: { [source.id]: version },
      expectedBlockCounts: { [source.id]: 2 }, expectedModels: { [source.id]: null } };
    expect((await cache.search({ ...input, needle: "needle" })).matches).toMatchObject([{ block_id: all.value[0].id }]);
    await cache.search({ ...input, needle: "absent" });
    await cache.whenIdle();
    expect((await cache.search({ ...input, needle: "needle" })).matches).toMatchObject([{ block_id: all.value[0].id }]);
    expect((await reader.readPage(source.id, { limit: 2, expectedSourceVersionId: version, expectedBlockCount: 2, expectedModel: null })))
      .toMatchObject({ status: "source", value: { blocks: all.value } });
  });

  it("keeps verified FTS-negative hits free of body reads while detecting lost sources", async () => {
    const source = await fixture(["retained content"]);
    const cache = new ConversationSearchCache(new SourceBackedConversationSearchSourceAdapter(db), { cachePath: ":memory:" });
    caches.push(cache);
    await cache.search({ conversationIds: [source.id], needle: "absent", limit: 1 });
    await cache.whenIdle();
    const bodies = vi.spyOn(cache as unknown as { hotBodies: (...args: unknown[]) => unknown }, "hotBodies");
    const warm = await cache.search({ conversationIds: [source.id], needle: "absent", limit: 1 });
    expect(warm).toMatchObject({ matches: [], failures: [], metrics: { hot_conversations: 1, cold_conversations: 0 } });
    fs.unlinkSync(source.filePath);
    const missing = await cache.search({ conversationIds: [source.id], needle: "absent", limit: 1 });
    expect(missing.failures).toMatchObject([{ conversation_id: source.id }]);
    expect(bodies).not.toHaveBeenCalled();
  });

  it("checks facts after final async verification and closes the lease before publishing", async () => {
    const source = await fixture(["needle"]);
    const open = logicalSource.openLogicalSource;
    const handles: Awaited<ReturnType<typeof open>>[] = [];
    vi.spyOn(logicalSource, "openLogicalSource").mockImplementation(async (...args) => {
      const handle = await open(...args);
      handles.push(handle);
      return handle;
    });
    let finalProof = false;
    const reader = new ConversationSourceReader(db, { onVerification: () => {
      if (finalProof) {
        finalProof = false;
        db.prepare("UPDATE conversation_sources SET redaction_epoch = redaction_epoch + 1 WHERE conversation_id = ?").run(source.id);
      }
    } });
    const result = await reader.scanBlocks(source.id, () => { finalProof = true; return "stop"; });
    expect(result.status).toBe("stale");
    expect(handles).toHaveLength(1);
    expect(handles[0].fd).toBe(-1);
  });

  it("finishes its admitted prefix when an append publishes a new source version during the scan", async () => {
    const texts = Array.from({ length: 70 }, (_, index) => `original ${index}`);
    const source = await fixture(texts);
    const store = new ConversationSourceStore(db);
    const version = store.resolveConversation(source.id)!.currentVersionId!;
    let published = false;
    const seen: string[] = [];
    const reader = new ConversationSourceReader(db, { legacyFallback: false });
    const result = await reader.scanBlocks(source.id, async block => {
      seen.push(block.content);
      if (!published) { published = true; await publishAppend(source, texts.length, nativeMessage("new snapshot only") + "\n"); }
    }, { expectedSourceVersionId: version });
    expect(store.resolveConversation(source.id)!.currentVersionId).not.toBe(version);
    expect(result).toMatchObject({ status: "source", sourceVersionId: version, value: { count: texts.length, complete: true } });
    expect(seen).toEqual(texts);
    const options = { expectedSourceVersionId: version, expectedBlockCount: texts.length, expectedModel: null };
    const oldPage = await reader.readBlock(`cblk:${source.id}:0`, options);
    expect(oldPage).toMatchObject({ status: "source", sourceVersionId: version, value: { content: texts[0] } });
    expect((await reader.scanBlocks(source.id, () => {}, options))).toMatchObject({ status: "source", value: { count: texts.length, complete: true } });
  });

  it.each(["rewrite", "alias"])("rejects a canonical %s publication during final verification and still closes its lease", async mutation => {
    const source = await fixture(["original"]);
    const version = new ConversationSourceStore(db).resolveConversation(source.id)!.currentVersionId!;
    const open = logicalSource.openLogicalSource;
    const handles: Awaited<ReturnType<typeof open>>[] = [];
    let publication: Promise<void> | undefined;
    vi.spyOn(logicalSource, "openLogicalSource").mockImplementation(async (...args) => {
      const handle = await open(...args);
      const readerLease = handles.length === 0;
      handles.push(handle);
      if (!readerLease) return handle;
      return new Proxy(handle, { get(target, property) {
        if (property === "close") return async () => { await publication; await target.close(); };
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      } });
    });
    let finalProof = false;
    const reader = new ConversationSourceReader(db, { onVerification: () => {
      if (!finalProof) return;
      finalProof = false;
      if (mutation === "alias") db.prepare("UPDATE conversation_source_aliases SET availability = 'missing'").run();
      else {
        fs.writeFileSync(source.filePath, source.bytes.toString().replace("original", "modified"));
        publication = publishAppend(source, 1, nativeMessage("new snapshot only") + "\n", true);
      }
    } });
    const result = await reader.scanBlocks(source.id, () => { finalProof = true; return "stop"; }, { expectedSourceVersionId: version });
    expect(result.status).toBe("stale");
    expect(handles[0].fd).toBe(-1);
  });

  it.each(["zero", "partial"])("preserves a published %s prefix, including an old hot negative", async kind => {
    const tail = nativeMessage("new snapshot only");
    const partial = kind === "partial" ? tail.slice(0, Math.floor(tail.length / 2)) : "";
    const texts = kind === "partial" ? ["original"] : [];
    const source = await fixture(texts, false, kind, partial);
    const version = new ConversationSourceStore(db).resolveConversation(source.id)!.currentVersionId!;
    const pins = { expectedSourceVersions: { [source.id]: version }, expectedBlockCounts: { [source.id]: texts.length }, expectedModels: { [source.id]: null } };
    const adapter = new SourceBackedConversationSearchSourceAdapter(db);
    const hot = new ConversationSearchCache(adapter, { cachePath: ":memory:" });
    caches.push(hot);
    await hot.search({ conversationIds: [source.id], needle: "new snapshot only", limit: 1, ...pins });
    await hot.whenIdle();
    await publishAppend(source, texts.length, tail.slice(partial.length) + "\n");
    const oldHot = await hot.search({ conversationIds: [source.id], needle: "new snapshot only", limit: 1, ...pins });
    expect(oldHot).toMatchObject({ matches: [], failures: [], metrics: { hot_conversations: 1 } });
    const cold = new ConversationSearchCache(adapter, { cachePath: ":memory:" });
    caches.push(cold);
    expect(await cold.search({ conversationIds: [source.id], needle: "new snapshot only", limit: 1, ...pins }))
      .toMatchObject({ matches: [], failures: [] });
    expect((await cold.search({ conversationIds: [source.id], needle: "new snapshot only", limit: 1 })).matches).toHaveLength(1);
    expect((await new ConversationSourceReader(db).scanBlocks(source.id, () => {}, {
      expectedSourceVersionId: version, expectedBlockCount: texts.length, expectedModel: null,
    }))).toMatchObject({ status: "source", sourceVersionId: version, value: { count: texts.length, complete: true } });
  });

  it.each(["rewrite", "replacement"])("rejects a published %s while preserving an old source version", async mutation => {
    const source = await fixture(["original"]);
    const version = new ConversationSourceStore(db).resolveConversation(source.id)!.currentVersionId!;
    const cache = new ConversationSearchCache(new SourceBackedConversationSearchSourceAdapter(db), { cachePath: ":memory:" });
    caches.push(cache);
    const pins = { expectedSourceVersions: { [source.id]: version }, expectedBlockCounts: { [source.id]: 1 }, expectedModels: { [source.id]: null } };
    await cache.search({ conversationIds: [source.id], needle: "absent", limit: 1, ...pins });
    await cache.whenIdle();
    if (mutation === "rewrite") fs.writeFileSync(source.filePath, source.bytes.toString().replace("original", "modified"));
    else { fs.renameSync(source.filePath, `${source.filePath}.old`); fs.writeFileSync(source.filePath, source.bytes); }
    await publishAppend(source, 1, nativeMessage("new snapshot only") + "\n", mutation === "rewrite");
    const result = await cache.search({ conversationIds: [source.id], needle: "absent", limit: 1, ...pins });
    expect(result.matches).toEqual([]);
    expect(result.failures).toMatchObject([{ conversation_id: source.id, status: "stale" }]);
  });

  it("bounds source concurrency across searches and cancels queued scans without waiting for occupied leases", async () => {
    for (const id of ["one", "two", "queued"]) await fixture(["needle"], false, id);
    const cache = new ConversationSearchCache(new SourceBackedConversationSearchSourceAdapter(db), { cachePath: ":memory:", maxConcurrentColdParses: 2 });
    caches.push(cache);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let ready!: () => void;
    const occupied = new Promise<void>(resolve => { ready = resolve; });
    let active = 0;
    let peak = 0;
    const scan = ConversationSourceReader.prototype.scanBlocks;
    vi.spyOn(ConversationSourceReader.prototype, "scanBlocks").mockImplementation(async function (...args) {
      active += 1;
      peak = Math.max(peak, active);
      if (active === 2) ready();
      try { await gate; return await scan.apply(this, args); }
      finally { active -= 1; }
    });
    const running = ["one", "two"].map(id => cache.search({ conversationIds: [id], needle: "needle", limit: 1 }));
    try {
      await occupied;
      const controller = new AbortController();
      const queued = cache.search({ conversationIds: ["queued"], needle: "needle", limit: 1, signal: controller.signal });
      controller.abort();
      expect(await queued).toMatchObject({ matches: [], failures: [{ conversation_id: "queued", status: "cancelled" }] });
    } finally { release(); }
    expect((await Promise.all(running)).every(result => result.matches.length === 1)).toBe(true);
    expect(peak).toBe(2);
  });

  it("rejects provisional matches on mutation, removal, version drift and cancellation, and accepts sealed append", async () => {
    const operator = setupOperator(db, { display_name: "Operator" });
    const credential = new ClientAuthenticator(db, { secretsDir: path.join(root, "auth") }).mintApiToken(operator.id, { label: "scan redaction" }).credential;
    const source = await fixture(["needle", ...Array.from({ length: 40 }, (_, i) => `tail ${i}`)]);
    const reader = new ConversationSourceReader(db, { legacyFallback: false });
    for (const mutation of ["rewrite", "remove", "replace", "version", "redaction", "cancel", "append"] as const) {
      fs.writeFileSync(source.filePath, source.bytes);
      const descriptor = db.prepare("SELECT id, redaction_epoch FROM conversation_sources WHERE conversation_id = ?").get(source.id) as { id: string; redaction_epoch: number };
      const controller = new AbortController();
      const result = await reader.scanBlocks(source.id, () => {
        if (mutation === "rewrite") fs.writeFileSync(source.filePath, source.bytes.toString().replace("needle", "noodle"));
        if (mutation === "remove") fs.unlinkSync(source.filePath);
        if (mutation === "replace") { fs.renameSync(source.filePath, `${source.filePath}.old`); fs.writeFileSync(source.filePath, source.bytes); }
        if (mutation === "version") db.prepare("UPDATE conversation_sources SET redaction_epoch = redaction_epoch + 1 WHERE id = ?").run(descriptor.id);
        if (mutation === "redaction") revokeCredential(db, credential.id);
        if (mutation === "cancel") controller.abort();
        if (mutation === "append") fs.appendFileSync(source.filePath, '{"type":"event_msg"}\n');
        return "stop";
      }, { signal: controller.signal });
      expect(result.status, mutation).toBe(mutation === "append" ? "source" : mutation === "cancel" ? "cancelled" : mutation === "remove" ? "unavailable" : "stale");
      db.prepare("UPDATE conversation_sources SET redaction_epoch = ? WHERE id = ?").run(descriptor.redaction_epoch, descriptor.id);
      db.prepare("UPDATE user_credentials SET status = 'active', revoked_at = NULL WHERE id = ?").run(credential.id);
      fs.writeFileSync(source.filePath, source.bytes);
      expect((await reader.scanBlocks(source.id, () => "stop")).status, `${mutation} restoration`).toBe("source");
    }
  });

  it("verifies physically empty navigation and bounds one large native record as an indivisible parse", async () => {
    const empty = await fixture([], true, "empty");
    const reader = new ConversationSourceReader(db, { legacyFallback: false });
    expect(await reader.scanBlocks(empty.id, () => {})).toMatchObject({ status: "source", value: { count: 0, complete: true } });
    fs.unlinkSync(`${empty.filePath}.zst`);
    expect((await reader.scanBlocks(empty.id, () => {})).status).not.toBe("source");
    const managed = await fixture([], false, "managed-empty");
    const managedPath = path.join(root, "managed.jsonl");
    fs.writeFileSync(managedPath, "", { mode: 0o600 });
    await new ConversationSourceStore(db).recordManagedNormalizedSource({
      conversationId: managed.id, provider: "codex", nativeSessionId: managed.id,
      rootPath: root, filePath: managedPath, expectedContentHash: createHash("sha256").digest("hex"),
      blocks: [], ...MANAGED_NORMALIZED_SOURCE_EPOCHS,
    });
    expect(await reader.scanBlocks(managed.id, () => {})).toMatchObject({ status: "source", value: { count: 0, complete: true } });
    fs.unlinkSync(managedPath);
    expect((await reader.scanBlocks(managed.id, () => {})).status).not.toBe("source");
    const large = await fixture(["large " + "x".repeat(8 * 1024 * 1024), "later"], false, "large");
    const started = performance.now();
    const result = await reader.scanBlocks(large.id, () => "stop", { maxBatchBytes: 128 * 1024 });
    expect(result).toMatchObject({ status: "source", value: { count: 1, readBlocks: 1, complete: false } });
    console.log("large native record scan", { recordBytes: 8 * 1024 * 1024, elapsedMs: Math.round(performance.now() - started), preemption: "between native records" });
  });
});

function nativeMessage(text: string): string {
  return JSON.stringify({ type: "response_item", timestamp: "2026-10-29T00:00:02Z", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text }] } });
}

async function publishAppend(source: { id: string; filePath: string }, oldCount: number, tail: string, replace = false): Promise<void> {
  fs.appendFileSync(source.filePath, tail);
  const parsed = await new CodexParser().parse(source.filePath);
  if (!parsed) throw new Error("appended fixture did not parse");
  db.prepare("UPDATE conversations SET block_count = ?, source_hash = ?, source_mtime = ? WHERE id = ?")
    .run(parsed.blocks.length, parsed.conversation.source_hash, parsed.conversation.source_mtime, source.id);
  await new ConversationSourceStore(db).recordConversation({ conversationId: source.id, provider: "codex", nativeSessionId: source.id,
    filePath: source.filePath, structuralMode: replace ? "replace" : "append", ...CURRENT_CONVERSATION_SOURCE_EPOCHS,
    blocks: parsed.blocks.slice(replace ? 0 : oldCount).map(block => ({ ...block, legacyId: `${source.id}-${block.position}` })) });
  getConversationStructureCache(db).captureDenseRows(db, source.id, replace ? "replace" : "append");
}
