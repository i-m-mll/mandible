import fs from "node:fs";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

import SqliteDatabase from "../src/sqlite.ts";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ConversationSearchCache,
  type ConversationSearchSourceAdapter,
  type SearchBlockSource,
} from "../src/conversations/search-cache.js";
import { longestEventLoopBlockMs } from "./helpers/event-loop-blocking.js";

class FakeSource implements ConversationSearchSourceAdapter {
  active = 0;
  maxActive = 0;
  epoch = "redaction:1";
  reads: string[] = [];
  shortlist: Set<string> | null = null;

  constructor(
    readonly blocks: Map<string, SearchBlockSource[]>,
    readonly delayMs = 0,
  ) {}

  describe(conversationIds: readonly string[]) {
    return conversationIds.map((conversationId) => ({
      conversationId,
      sourceVersionId: `source:${conversationId}:1`,
    }));
  }

  redactionEpoch(): string {
    return this.epoch;
  }

  async readMaskedBlocks(conversationId: string): Promise<SearchBlockSource[]> {
    this.reads.push(conversationId);
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    if (this.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    this.active -= 1;
    return this.blocks.get(conversationId) ?? [];
  }

  async shortlistMaskedBlocks(conversationIds: readonly string[]): Promise<ReadonlySet<string> | null> {
    if (this.shortlist === null) return null;
    return new Set(conversationIds.filter((id) => this.shortlist!.has(id)));
  }
}

const tempDirs: string[] = [];

function tempCachePath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-conversation-search-"));
  tempDirs.push(dir);
  return path.join(dir, "search-cache.db");
}

function block(conversationId: string, content: string, position = 0): SearchBlockSource {
  return {
    id: `${conversationId}-block-${position}`,
    conversationId,
    type: position % 2 === 0 ? "user_message" : "assistant_message",
    role: position % 2 === 0 ? "user" : "assistant",
    position,
    content,
  };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("disposable conversation search cache", () => {
  it.each(["version", "epoch"])("rejects bodies replaced after the validated %s checkpoint", async (change) => {
    const source = new FakeSource(new Map([
      ["c1", [block("c1", "needle in current source")]],
      ["sibling", []],
    ]));
    let version = "v0";
    source.describe = (ids) => ids.map((conversationId) => ({ conversationId, sourceVersionId: version }));
    let releaseOld!: () => void;
    const oldGate = new Promise<void>((resolve) => { releaseOld = resolve; });
    let startedOld!: () => void;
    const oldStarted = new Promise<void>((resolve) => { startedOld = resolve; });
    const read = source.readMaskedBlocks.bind(source);
    let first = true;
    source.readMaskedBlocks = async (id) => {
      if (first) {
        first = false;
        startedOld();
        await oldGate;
        return [block("c1", "obsolete body with no matching text")];
      }
      return read(id);
    };
    const cache = new ConversationSearchCache(source, { cachePath: tempCachePath() });
    try {
      const stale = cache.search({ conversationIds: ["c1"], needle: "needle", limit: 2 });
      await oldStarted;
      if (change === "version") version = "v1";
      else source.epoch = "redaction:2";
      await cache.search({ conversationIds: ["c1"], needle: "needle", limit: 2 });
      await cache.whenIdle();
      source.shortlistMaskedBlocks = async () => {
        // Search has snapshotted the current checkpoint and is waiting on a
        // cold sibling when the delayed old parse replaces the resident entry.
        releaseOld();
        await stale;
        await cache.whenIdle();
        return null;
      };
      const result = await cache.search({ conversationIds: ["c1", "sibling"], needle: "needle", limit: 2 });
      expect(result.matches.map((match) => match.conversation_id)).toEqual(["c1"]);
    } finally {
      releaseOld();
      cache.close();
    }
  });

  it.each([0, 2])("refuses an unrelated database at schema version %i without deleting its file family or changing durable bytes", (version) => {
    const cachePath = tempCachePath();
    const unrelated = new SqliteDatabase(cachePath);
    unrelated.pragma("auto_vacuum = 2");
    unrelated.pragma("journal_mode = WAL");
    unrelated.pragma(`user_version = ${version}`);
    unrelated.exec("CREATE TABLE ledger_issues (body TEXT); INSERT INTO ledger_issues VALUES ('keep me')");
    // SQLite may update read marks in -shm when validating the schema.
    const snapshot = () => ["", "-wal"].map((suffix) => fs.readFileSync(`${cachePath}${suffix}`).toString("base64"));
    const before = snapshot();
    let accidentalCache: ConversationSearchCache | undefined;
    try {
      expect(() => { accidentalCache = new ConversationSearchCache(new FakeSource(new Map()), { cachePath }); })
        .toThrow("not a conversation search cache");
      expect(snapshot()).toEqual(before);
      expect(["", "-wal", "-shm"].every((suffix) => fs.existsSync(`${cachePath}${suffix}`))).toBe(true);
      expect(unrelated.prepare("SELECT body FROM ledger_issues").get()).toEqual({ body: "keep me" });
    } finally {
      accidentalCache?.close();
      unrelated.close();
    }
  });

  it("rebuilds a fresh cache after initialization fails part-way through its schema", async () => {
    const cachePath = tempCachePath();
    const source = new FakeSource(new Map([["c1", [block("c1", "needle")]]]));
    const exec = SqliteDatabase.prototype.exec;
    const failSchema = vi.spyOn(SqliteDatabase.prototype, "exec").mockImplementation(function (sql) {
      if (sql.includes("CREATE TABLE IF NOT EXISTS search_checkpoints")) {
        exec.call(this, "CREATE TABLE interrupted_initialization (id TEXT)");
        throw new Error("interrupted initialization");
      }
      return exec.call(this, sql);
    });
    try {
      expect(() => new ConversationSearchCache(source, { cachePath })).toThrow("interrupted initialization");
    } finally {
      failSchema.mockRestore();
    }
    const rebuilt = new ConversationSearchCache(source, { cachePath });
    try {
      expect((await rebuilt.search({ conversationIds: ["c1"], needle: "needle", limit: 1 })).matches).toHaveLength(1);
      await rebuilt.whenIdle();
    } finally {
      rebuilt.close();
    }
  });

  it("recognizes and rebuilds an unmarked legacy cache", async () => {
    const source = new FakeSource(new Map([["c1", [block("c1", "needle")]]]));
    const cachePath = tempCachePath();
    const old = new ConversationSearchCache(source, { cachePath });
    await old.search({ conversationIds: ["c1"], needle: "needle", limit: 1 });
    await old.whenIdle();
    old.close();
    const sql = new SqliteDatabase(cachePath);
    sql.pragma("application_id = 0");
    sql.pragma("user_version = 2");
    sql.close();
    const rebuilt = new ConversationSearchCache(source, { cachePath });
    try {
      const empty = new SqliteDatabase(cachePath, { readonly: true });
      expect(empty.prepare("SELECT COUNT(*) AS n FROM hot_bodies").get()).toEqual({ n: 0 });
      empty.close();
      expect((await rebuilt.search({ conversationIds: ["c1"], needle: "needle", limit: 1 })).matches).toHaveLength(1);
      await rebuilt.whenIdle();
      const check = new SqliteDatabase(cachePath, { readonly: true });
      expect(check.pragma("application_id", { simple: true })).not.toBe(0);
      check.close();
    } finally {
      rebuilt.close();
    }
  });

  it("excludes a second writer during chunked replacement and leaves a complete repairable entry", async () => {
    const blocks = Array.from({ length: 64 }, (_, i) => block("c1", `needle ${i} ${"body ".repeat(1600)}`, i));
    const source = new FakeSource(new Map([["c1", blocks]]));
    const cachePath = tempCachePath();
    const cache = new ConversationSearchCache(source, { cachePath });
    const sql = new SqliteDatabase(cachePath, { readonly: true });
    let contender: ConversationSearchCache | undefined;
    let attempted = false;
    let rejection: unknown;
    let watching = true;
    const observe = () => {
      if (!watching) return;
      const row = sql.prepare(`SELECT c.complete, c.block_count, COUNT(h.rowid) AS rows
        FROM search_checkpoints c LEFT JOIN hot_bodies h ON h.conversation_id = c.conversation_id
        WHERE c.conversation_id = 'c1' GROUP BY c.conversation_id`).get() as
        { complete: number; block_count: number; rows: number } | undefined;
      if (row && row.complete === 0 && row.rows > 0 && row.rows < row.block_count) {
        attempted = true;
        try { contender = new ConversationSearchCache(source, { cachePath }); }
        catch (error) { rejection = error; }
        return;
      }
      setImmediate(observe);
    };
    try {
      setImmediate(observe);
      await cache.search({ conversationIds: ["c1"], needle: "needle", limit: 1 });
      await cache.whenIdle();
      expect(attempted).toBe(true);
      expect(rejection).toBeInstanceOf(Error);
      expect(String(rejection)).toContain("already has a writer");
      expect(sql.prepare("SELECT complete, block_count FROM search_checkpoints").get())
        .toEqual({ complete: 1, block_count: blocks.length });
      expect(sql.prepare("SELECT COUNT(*) AS n FROM hot_bodies").get()).toEqual({ n: blocks.length });
      expect((await cache.search({ conversationIds: ["c1"], needle: "needle", limit: 1 })).metrics.cold_conversations).toBe(0);
    } finally {
      watching = false;
      contender?.close();
      sql.close();
      cache.close();
    }
  });

  it("guards process-local accounting across processes and releases the writer lock on close", async () => {
    const cachePath = tempCachePath();
    const source = new FakeSource(new Map([["c1", [block("c1", "needle")]]]));
    const cache = new ConversationSearchCache(source, { cachePath });
    const moduleUrl = new URL("../src/conversations/search-cache.ts", import.meta.url).href;
    const code = `import { ConversationSearchCache } from ${JSON.stringify(moduleUrl)};
      const source = {describe: () => [], readMaskedBlocks: async () => [], redactionEpoch: () => "epoch"};
      try { const cache = new ConversationSearchCache(source, {cachePath: process.argv[1]}); cache.close(); process.exitCode = 2; }
      catch (error) { if (!String(error).includes("already has a writer")) throw error; }`;
    try {
      await cache.whenIdle();
      const status = await new Promise<number | null>((resolve, reject) => {
        const child = spawn(process.execPath, ["--no-install", "--eval", code, cachePath], {
          stdio: ["ignore", "ignore", "pipe"], timeout: 10_000,
        });
        let stderr = "";
        child.stderr.on("data", (chunk) => { stderr += String(chunk); });
        child.once("error", reject);
        child.once("close", (exitCode) => exitCode === 0 ? resolve(exitCode) : reject(new Error(`writer probe exited ${exitCode}: ${stderr}`)));
      });
      expect(status).toBe(0);
    } finally {
      cache.close();
    }
    const next = new ConversationSearchCache(source, { cachePath });
    try {
      expect((await next.search({ conversationIds: ["c1"], needle: "needle", limit: 1 })).matches).toHaveLength(1);
      await next.whenIdle();
    } finally {
      next.close();
    }
  });

  it("preserves exact lowercase-substring semantics for randomized Unicode, punctuation, and short needles", async () => {
    let seed = 0x5eed1234;
    const next = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed;
    };
    const alphabet = ["a", "B", "é", "界", "🙂", "_", "-", ".", "\n", " ", "?"];
    const blocks = new Map<string, SearchBlockSource[]>();
    for (let conversation = 0; conversation < 24; conversation += 1) {
      let content = "";
      for (let i = 0; i < 90; i += 1) content += alphabet[next() % alphabet.length];
      blocks.set(`c${conversation}`, [block(`c${conversation}`, content)]);
    }
    blocks.set("edge", [block("edge", "one\nTwo...CAFÉ🙂界 -- punctuation")]);
    const source = new FakeSource(blocks);
    const cache = new ConversationSearchCache(source, { cachePath: tempCachePath() });
    const ids = [...blocks.keys()];
    const needles = ["a", "🙂", "界", "..", "\nt", "CAFÉ", "-", "one\nTwo"];
    for (let i = 0; i < 40; i += 1) {
      const text = blocks.get(ids[next() % ids.length])![0].content;
      const start = next() % Math.max(1, text.length - 2);
      needles.push(text.slice(start, start + 1 + (next() % 4)));
    }

    try {
      for (const needle of needles) {
        const expected = ids.filter((id) => blocks.get(id)![0].content.toLowerCase().includes(needle.toLowerCase()));
        const result = await cache.search({ conversationIds: ids, needle, limit: ids.length });
        expect(result.matches.map((match) => match.conversation_id), needle).toEqual(expected);
      }
    } finally {
      cache.close();
    }
  });

  it("bounds cold parsing, reports cold then hot behavior, and invalidates on redaction epoch changes", async () => {
    const blocks = new Map(Array.from({ length: 12 }, (_, index) => {
      const id = `c${index}`;
      return [id, [block(id, `needle ${index}`)]];
    }));
    const source = new FakeSource(blocks, 8);
    const cache = new ConversationSearchCache(source, {
      cachePath: tempCachePath(),
      maxConcurrentColdParses: 3,
    });
    const ids = [...blocks.keys()];
    try {
      const cold = await cache.search({ conversationIds: ids, needle: "needle", limit: ids.length });
      expect(cold.metrics).toMatchObject({ cold_conversations: 12, hot_conversations: 0, max_cold_parse_concurrency: 3 });
      expect(source.maxActive).toBe(3);
      await cache.whenIdle();

      const hot = await cache.search({ conversationIds: ids, needle: "needle", limit: ids.length });
      expect(hot.metrics).toMatchObject({ cold_conversations: 0, hot_conversations: 12, max_cold_parse_concurrency: 0 });

      source.epoch = "redaction:2";
      const rotated = await cache.search({ conversationIds: ids, needle: "needle", limit: ids.length });
      expect(rotated.metrics).toMatchObject({ cold_conversations: 12, hot_conversations: 0 });
    } finally {
      cache.close();
    }
  });

  it("keeps credential canaries out of cache bytes and results", async () => {
    const token = `mandible_pat_${"A".repeat(43)}`;
    const source = new FakeSource(new Map([
      ["c1", [block("c1", `before ${token} after`)]],
    ]));
    // Fake adapters model the sibling seam; apply the same fail-closed boundary
    // a verified source adapter is required to provide.
    const original = source.readMaskedBlocks.bind(source);
    source.readMaskedBlocks = async (id) => (await original(id)).map((item) => ({
      ...item,
      content: item.content.replace(token, "[mandible-credential:unverified#1]"),
    }));
    const cachePath = tempCachePath();
    const cache = new ConversationSearchCache(source, { cachePath });
    try {
      const result = await cache.search({ conversationIds: ["c1"], needle: "before", limit: 1 });
      await cache.whenIdle();
      expect(JSON.stringify(result)).not.toContain(token);
      expect(result.matches[0].snippet).toContain("[mandible-credential:unverified#1]");
      expect(await cache.search({ conversationIds: ["c1"], needle: token, limit: 1 })).toMatchObject({ matches: [] });
      const sql = new SqliteDatabase(cachePath, { readonly: true });
      expect(sql.prepare("SELECT body FROM hot_bodies").all()).not.toContainEqual(expect.objectContaining({ body: expect.stringContaining(token) }));
      sql.close();
      expect(fs.readFileSync(cachePath).includes(Buffer.from(token))).toBe(false);
    } finally {
      cache.close();
    }
  });

  it("rebuilds from source after the entire cache is deleted", async () => {
    const source = new FakeSource(new Map([["c1", [block("c1", "delete me safely")]]]));
    const cachePath = tempCachePath();
    let cache = new ConversationSearchCache(source, { cachePath });
    await cache.search({ conversationIds: ["c1"], needle: "safely", limit: 1 });
    await cache.whenIdle();
    cache.close();
    for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(`${cachePath}${suffix}`, { force: true });

    cache = new ConversationSearchCache(source, { cachePath });
    try {
      const rebuilt = await cache.search({ conversationIds: ["c1"], needle: "safely", limit: 1 });
      expect(rebuilt.matches).toHaveLength(1);
      expect(rebuilt.metrics.cold_conversations).toBe(1);
    } finally {
      cache.close();
    }
  });

  it("serves a scan larger than the cache without blocking the event loop or churning entries", async () => {
    const filler = "searchable transcript text with a needle inside ".repeat(40);
    const blocks = new Map(Array.from({ length: 8 }, (_, conversation) => {
      const id = `c${conversation}`;
      return [id, Array.from({ length: 400 }, (_, position) => block(id, `${filler}${position}`, position))];
    }));
    const source = new FakeSource(blocks);
    const cache = new ConversationSearchCache(source, {
      cachePath: tempCachePath(),
      maxCacheBytes: 2 * 1024 * 1024,
    });
    const ids = [...blocks.keys()];
    try {
      const passes = [];
      for (let pass = 0; pass < 3; pass += 1) {
        const readsBefore = source.reads.length;
        let result!: Awaited<ReturnType<ConversationSearchCache["search"]>>;
        const blockedMs = await longestEventLoopBlockMs(async () => {
          result = await cache.search({ conversationIds: ids, needle: "needle", limit: ids.length });
          await cache.whenIdle();
        });
        expect(blockedMs, `pass ${pass}`).toBeLessThan(100);
        expect(result.matches.map((match) => match.conversation_id)).toEqual(ids);
        passes.push({ hot: result.metrics.hot_conversations, reads: source.reads.length - readsBefore });
      }
      expect(passes[1].hot).toBeGreaterThan(0);
      expect(passes[2]).toEqual(passes[1]);
    } finally {
      cache.close();
    }
  });
});
