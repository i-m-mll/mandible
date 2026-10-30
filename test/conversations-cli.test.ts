import { inlineLedgerReader } from "../src/ledger-reads/index.js";
// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";

import { fileRpc, runCli, scratchDir, startStubDaemon } from "./helpers/cli-process.js";
import type { FileRpcHandler } from "./helpers/file-rpc-responder.js";
import { migratedMemoryDb } from "./helpers/ledger-fixtures.js";
import { setDb } from "../src/db.js";
import { createServer, Router } from "../src/server.js";
import { SseManager } from "../src/sse.js";
import { registerConversationRoutes } from "../src/routes/conversations.js";
import { MAIN_CLI_INSTANCE_RESPONSE } from "./helpers/cli-instance-response.js";

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
  });

  it("waits for a shared search snapshot and releases its observer over file RPC", async () => {
    const { env, responder } = spool((request) => {
      const url = new URL(String(request.path), 'http://fixture');
      if (url.pathname !== '/api/conversations/search') return { status: 404, body: {} };
      if (url.searchParams.has('cancel')) return { status: 200, body: { released: true } };
      if (!url.searchParams.has('search_id')) return { status: 202, body: {
        state: 'pending', search_id: 'search-1', observer_token: 'observer-1', phase: 'scanning',
        progress: { eligible: 2, prepared: 2, scanned: 1, matched: 0 }, retry_after_ms: 250,
      } };
      return { status: 200, body: {
        state: 'complete', search_id: 'search-1', snapshot_id: 'search-1',
        coverage: { eligible: 2, prepared: 2, scanned: 2, matched: 1, failed: 0, complete: true },
        results: [{ conversation, block, snippet: 'RPC' }], total: 1, limit: 20,
      } };
    });
    const result = await runCli(['conversations', 'search', 'RPC', '--json'], { env });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ state: 'complete', total: 1 });
    const paths = responder.requests.map(request => String(request.path));
    expect(paths).toHaveLength(3);
    expect(paths[1]).toContain('search_id=search-1&observer_token=observer-1');
    expect(paths[2]).toContain('cancel=true');
  });

  it('reports incomplete search as a failed command with coverage, never as an empty result', async () => {
    const terminal = { state: 'incomplete', search_id: 'search-1', reason: 'source_unavailable',
      coverage: { eligible: 2, prepared: 1, scanned: 1, matched: 0, failed: 1, complete: false } };
    const { env, responder } = spool(() => ({ status: 409, body: terminal }));
    const result = await runCli(['conversations', 'search', 'RPC', '--json'], { env });
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stdout)).toEqual(terminal);
    expect(responder.requests).toHaveLength(1);
  });

  it("lists through the daemon with provider, tag, and limit filters", async () => {
    const db = migratedMemoryDb();
    const insert = db.prepare(`
      INSERT INTO conversations (id, source, source_path, source_hash, source_mtime, title, started_at, session_id, tags)
      VALUES (?, ?, ?, 'hash', 0, ?, ?, ?, ?)
    `);
    insert.run("conv-old", "codex", "/logs/old.jsonl", "Older", "2026-06-11T00:00:00.000Z", "session-old", '["keep"]');
    insert.run("conv-new", "codex", "/logs/new.jsonl", "Newer", "2026-06-12T00:00:00.000Z", "session-new", '["keep"]');
    insert.run("conv-claude", "claude_code", "/logs/claude.jsonl", "Claude", "2026-06-13T00:00:00.000Z", "session-claude", "[]");
    insert.run("conv-untagged", "codex", "/logs/untagged.jsonl", "Untagged", "2026-06-14T00:00:00.000Z", "session-untagged", '[]');
    setDb(db);
    const instance = MAIN_CLI_INSTANCE_RESPONSE.instance;
    const router = new Router({ instance });
    registerConversationRoutes(router, inlineLedgerReader());
    const server = createServer({ db, router, instance, sse: new SseManager(), logger: () => undefined,
      version: 'cli-list-fixture', getStartupInfo: () => null });
    const port = await new Promise<number>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve((server.address() as { port: number }).port));
    });
    cleanups.push(() => db.close());
    cleanups.push(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
    const result = await runCli(["conversations", "list", "--provider", "codex", "--tag", "keep", "--limit", "1", "--json"], {
      cwd: scratchDir("cwd"),
      env: { MANDIBLE_BASE: `http://127.0.0.1:${port}`, MANDIBLE_PORT: String(port) },
    });

    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([
      expect.objectContaining({ id: "conv-new", source: "codex", session_id: "session-new", tags: ["keep"] }),
    ]);
  });
});
