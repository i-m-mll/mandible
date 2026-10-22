import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import SqliteDatabase from "../src/sqlite.ts";
import { afterEach, describe, expect, it } from "vitest";

import {
  ConversationSearchCache,
  type ConversationSearchSourceAdapter,
  type SearchBlockSource,
} from "../src/conversations/search-cache.js";

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
});
