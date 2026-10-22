// @vitest-environment node
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { fileRpc, runCli, scratchDir, startStubDaemon } from "./helpers/cli-process.js";
import type { FileRpcHandler } from "./helpers/file-rpc-responder.js";
import { migratedMemoryDb } from "./helpers/ledger-fixtures.js";
import type { SqliteDatabase } from "../src/sqlite.js";

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function spool(handler: FileRpcHandler) {
  const stub = fileRpc(handler);
  cleanups.push(() => stub.responder.stop());
  return stub;
}

const conversation = {
  id: "conv-1", source: "codex", source_path: "/logs/codex/session.jsonl", title: "Sandbox session",
  started_at: "2026-06-12T12:00:00.000Z", updated_at: "2026-06-12T12:01:00.000Z", block_count: 1,
  session_id: "session-1", cwd: "/repo/mandible",
};

const block = {
  id: "block-1", conversation_id: "conv-1", type: "assistant_message", role: "assistant",
  content: "The file RPC route is readable.", position: 1, timestamp: "2026-06-12T12:01:00.000Z",
  parent_id: null, metadata_json: "{}", dag_uuid: null, dag_parent_uuid: null,
};

describe("conversations CLI", () => {
  it("forwards block and log-parse offsets and names the next offset when the window is truncated", async () => {
    const { env } = spool((request) => {
      const requestPath = String(request.path);
      if (requestPath.startsWith("/api/conversations?")) return { status: 200, body: { conversations: [conversation], total: 1, page: 1, limit: 1, pages: 1 } };
      if (requestPath === "/api/conversations/session-1/blocks?limit=999&offset=500") {
        return { status: 200, body: { blocks: [{ ...block, id: "block-501", position: 501 }], total: 907, offset: 500, limit: 500, requested_limit: 999, cap: 500, truncated: true } };
      }
      if (requestPath === "/api/conversations/conv-1/blocks?limit=50&offset=250") {
        return { status: 200, body: { blocks: [{ ...block, id: "block-251", position: 251 }], total: 300, offset: 250, limit: 50, requested_limit: 50, cap: 500, truncated: true } };
      }
      return { status: 404, body: { error: "not_found", path: requestPath } };
    });

    const [blocks, logs] = await Promise.all([
      runCli(["conversations", "blocks", "session-1", "--limit", "999", "--offset", "500", "--json"], { env }),
      runCli(["logs", "inspect", "session-1", "--parse", "--limit", "50", "--offset", "250", "--json"], { env }),
    ]);

    expect(blocks.status, blocks.stderr).toBe(0);
    expect(JSON.parse(blocks.stdout)).toEqual([expect.objectContaining({ id: "block-501" })]);
    expect(blocks.stderr).toContain("output truncated");
    expect(blocks.stderr).toContain("--offset 501");
    expect(logs.status, logs.stderr).toBe(0);
    expect(JSON.parse(logs.stdout)).toEqual([expect.objectContaining({ id: "block-251" })]);
    expect(logs.stderr).toContain("--offset 251");
  });

  it("exports the exact conversation by its ref over file RPC and HTTP", async () => {
    const rpc = spool((request) => request.method === "POST" && request.path === "/api/conversations/session-1/export"
      ? { status: 200, body: { content: "# exact file-RPC export" } }
      : { status: 404, body: { error: "not_found" } });
    const http = await startStubDaemon(({ method, url }) => method === "POST" && url === "/api/conversations/session-1/export"
      ? { body: { content: "# exact HTTP export" } }
      : undefined);
    cleanups.push(() => http.close());

    const [overRpc, overHttp] = await Promise.all([
      runCli(["conversations", "export", "session-1"], { env: rpc.env }),
      runCli(["conversations", "export", "session-1"], { env: { ...http.env, MANDIBLE_TEST_ONLY_ALLOW_NON_MAIN_OPERATIONAL_MUTATIONS: "1" } }),
    ]);

    expect(overRpc.status, overRpc.stderr).toBe(0);
    expect(overRpc.stdout).toBe("# exact file-RPC export\n");
    expect(rpc.responder.requests).toContainEqual(expect.objectContaining({ body: { format: "markdown" } }));
    expect(overHttp.status, overHttp.stderr).toBe(0);
    expect(overHttp.stdout).toContain("# exact HTTP export");
    expect(http.requests.some((request) => request.url.includes("session_id="))).toBe(false);
  });

  it("searches the daemon index and warns when the requested limit exceeds the server cap", async () => {
    const { env } = spool((request) => String(request.path).startsWith("/api/conversations/search?")
      ? { status: 200, body: { results: [{ conversation, block, snippet: "file RPC route is readable" }], total: 1, limit: 20 } }
      : { status: 404, body: { error: "not_found" } });

    const result = await runCli(["conversations", "search", "RPC", "--json", "--limit", "500"], { env });

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout).results).toEqual([expect.objectContaining({ conversation: expect.objectContaining({ id: "conv-1" }) })]);
    expect(result.stderr).toContain("--limit 500 exceeds the server cap; at most 20 hits are returned");
  });

  // Issue 6f6b0ce: the local transport lists from the SQLite index, a path the
  // file-RPC cases never reach.
  it("lists from a local index with provider, tag, and limit filters", async () => {
    const db = migratedMemoryDb();
    const insert = db.prepare(`
      INSERT INTO conversations (id, source, source_path, source_hash, source_mtime, title, started_at, session_id, tags)
      VALUES (?, ?, ?, 'hash', 0, ?, ?, ?, ?)
    `);
    insert.run("conv-old", "codex", "/logs/old.jsonl", "Older", "2026-06-11T00:00:00.000Z", "session-old", '["keep"]');
    insert.run("conv-new", "codex", "/logs/new.jsonl", "Newer", "2026-06-12T00:00:00.000Z", "session-new", '["keep"]');
    insert.run("conv-claude", "claude_code", "/logs/claude.jsonl", "Claude", "2026-06-13T00:00:00.000Z", "session-claude", "[]");
    const dbPath = path.join(scratchDir("conversations-db"), "mandible.db");
    fs.writeFileSync(dbPath, (db as unknown as SqliteDatabase).serialize());
    db.close();

    const result = await runCli(["conversations", "list", "--provider", "codex", "--tag", "keep", "--limit", "1", "--json"], {
      cwd: scratchDir("cwd"),
      env: { MANDIBLE_DB: dbPath },
    });

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([
      expect.objectContaining({ id: "conv-new", source: "codex", session_id: "session-new", tags: ["keep"] }),
    ]);
  });
});
