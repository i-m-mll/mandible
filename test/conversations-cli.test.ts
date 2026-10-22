import { MAIN_CLI_INSTANCE_RESPONSE } from "../helpers/cli-instance-response.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import http from "node:http";
import { afterEach, describe, expect, it } from "vitest";

import { startFileRpcResponder } from "../helpers/file-rpc-responder.js";

const CLI = path.join(process.cwd(), "bin", "mandible");

let tempRoots: string[] = [];

function run(
  args: string[],
  extraEnv: Record<string, string>,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(CLI, args, {
      cwd: os.tmpdir(),
      env: {
        ...process.env,
        ...extraEnv,
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("close", (status) => {
      resolve({ status, stdout, stderr });
    });
  });
}

afterEach(() => {
  for (const dir of tempRoots) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tempRoots = [];
});

describe("conversations CLI file RPC", () => {
  const conversation = {
    id: "conv-1",
    source: "codex",
    source_path: "/logs/codex/session.jsonl",
    title: "Sandbox session",
    started_at: "2026-06-12T12:00:00.000Z",
    updated_at: "2026-06-12T12:01:00.000Z",
    block_count: 1,
    session_id: "session-1",
    cwd: "/repo/mandible",
  };

  const block = {
    id: "block-1",
    conversation_id: "conv-1",
    type: "assistant_message",
    role: "assistant",
    content: "The file RPC route is readable.",
    position: 1,
    timestamp: "2026-06-12T12:01:00.000Z",
    parent_id: null,
    metadata_json: "{}",
    dag_uuid: null,
    dag_parent_uuid: null,
  };

  it("lists conversations and reads blocks by session id without a local database", async () => {
    const spoolDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-conversations-file-rpc-"));
    tempRoots.push(spoolDir);
    const seenPaths: string[] = [];
    const responder = startFileRpcResponder(spoolDir, (request) => {
      const requestPath = String(request.path ?? "");
      seenPaths.push(requestPath);
      if (requestPath.startsWith("/api/conversations?")) {
        return { status: 200, body: { conversations: [conversation], total: 1, page: 1, limit: 20, pages: 1 } };
      }
      if (requestPath.startsWith("/api/conversations/session-1/blocks")) {
        return { status: 200, body: { blocks: [block], total: 1, page: 1, limit: 100, pages: 1 } };
      }
      return { status: 404, body: { error: "not_found", path: requestPath } };
    });

    try {
      const env = {
        MANDIBLE_BASE: `file://${spoolDir}`,
        MANDIBLE_FILE_RPC_TIMEOUT: "5",
      };
      const list = await run(["conversations", "list", "--json"], env);
      const blocks = await run(["conversations", "blocks", "session-1", "--json"], env);

      expect(list.status).toBe(0);
      expect(JSON.parse(list.stdout)).toEqual([expect.objectContaining({ id: "conv-1", session_id: "session-1" })]);
      expect(blocks.status, blocks.stderr).toBe(0);
      expect(JSON.parse(blocks.stdout)).toEqual([expect.objectContaining({ id: "block-1", role: "assistant" })]);
      expect(seenPaths.some((item) => item.startsWith("/api/conversations?"))).toBe(true);
      expect(seenPaths.some((item) => item.startsWith("/api/conversations/session-1/blocks"))).toBe(true);
    } finally {
      responder.stop();
    }
  });

  it("forwards block offsets and warns when the file-RPC window is truncated", async () => {
    const spoolDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-conversations-offset-file-rpc-"));
    tempRoots.push(spoolDir);
    const seenPaths: string[] = [];
    const laterBlock = { ...block, id: "block-501", position: 501, content: "Later block" };
    const responder = startFileRpcResponder(spoolDir, (request) => {
      const requestPath = String(request.path ?? "");
      seenPaths.push(requestPath);
      if (requestPath.startsWith("/api/conversations?")) {
        return { status: 200, body: { conversations: [conversation], total: 1, page: 1, limit: 1, pages: 1 } };
      }
      if (requestPath.startsWith("/api/conversations/session-1/blocks")) {
        return {
          status: 200,
          body: {
            blocks: [laterBlock],
            total: 907,
            offset: 500,
            page: 2,
            limit: 500,
            requested_limit: 999,
            cap: 500,
            pages: 2,
            truncated: true,
          },
        };
      }
      return { status: 404, body: { error: "not_found", path: requestPath } };
    });

    try {
      const result = await run(["conversations", "blocks", "session-1", "--limit", "999", "--offset", "500", "--json"], {
        MANDIBLE_BASE: `file://${spoolDir}`,
        MANDIBLE_FILE_RPC_TIMEOUT: "5",
      });

      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual([expect.objectContaining({ id: "block-501", position: 501 })]);
      expect(result.stderr).toContain("output truncated");
      expect(result.stderr).toContain("907 blocks");
      expect(result.stderr).toContain("--offset 501");
      expect(seenPaths).toContain("/api/conversations/session-1/blocks?limit=999&offset=500");
    } finally {
      responder.stop();
    }
  });

  it("exports an exact conversation through file RPC", async () => {
    const spoolDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-conversations-export-file-rpc-"));
    tempRoots.push(spoolDir);
    const seenRequests: Array<{ method?: string; path?: string; body?: unknown }> = [];
    const responder = startFileRpcResponder(spoolDir, (request) => {
      seenRequests.push(request);
      if (request.method === "POST" && request.path === "/api/conversations/session-1/export") {
        return {
          status: 200,
          body: { content: "# exact file-RPC export" },
        };
      }
      return { status: 404, body: { error: "not_found" } };
    });

    try {
      const result = await run(["conversations", "export", "session-1"], {
        MANDIBLE_BASE: `file://${spoolDir}`,
        MANDIBLE_FILE_RPC_TIMEOUT: "5",
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toBe("# exact file-RPC export\n");
      expect(result.stderr).toBe("");
      expect(seenRequests).toContainEqual(expect.objectContaining({
        method: "POST",
        path: "/api/conversations/session-1/export",
        body: { format: "markdown" },
      }));
    } finally {
      responder.stop();
    }
  });

  it("forwards log parse offsets through file RPC and warns on truncation", async () => {
    const spoolDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-logs-offset-file-rpc-"));
    tempRoots.push(spoolDir);
    const seenPaths: string[] = [];
    const laterBlock = { ...block, id: "block-251", position: 251, content: "Later log block" };
    const responder = startFileRpcResponder(spoolDir, (request) => {
      const requestPath = String(request.path ?? "");
      seenPaths.push(requestPath);
      if (requestPath.startsWith("/api/conversations?")) {
        return { status: 200, body: { conversations: [conversation], total: 1, page: 1, limit: 1, pages: 1 } };
      }
      if (requestPath.startsWith("/api/conversations/conv-1/blocks")) {
        return {
          status: 200,
          body: {
            blocks: [laterBlock],
            total: 300,
            offset: 250,
            page: 6,
            limit: 50,
            requested_limit: 50,
            cap: 500,
            pages: 6,
            truncated: true,
          },
        };
      }
      return { status: 404, body: { error: "not_found", path: requestPath } };
    });

    try {
      const result = await run(["logs", "inspect", "session-1", "--parse", "--limit", "50", "--offset", "250", "--json"], {
        MANDIBLE_BASE: `file://${spoolDir}`,
        MANDIBLE_FILE_RPC_TIMEOUT: "5",
      });

      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual([expect.objectContaining({ id: "block-251", position: 251 })]);
      expect(result.stderr).toContain("output truncated");
      expect(result.stderr).toContain("--offset 251");
      expect(seenPaths).toContain("/api/conversations/conv-1/blocks?limit=50&offset=250");
    } finally {
      responder.stop();
    }
  });

  it("searches the daemon conversation index through file RPC", async () => {
    const spoolDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-conversations-search-file-rpc-"));
    tempRoots.push(spoolDir);
    const seenPaths: string[] = [];
    const responder = startFileRpcResponder(spoolDir, (request) => {
      const requestPath = String(request.path ?? "");
      seenPaths.push(requestPath);
      if (requestPath.startsWith("/api/conversations/search?")) {
        return {
          status: 200,
          body: {
            results: [{ conversation, block, snippet: "file RPC route is readable" }],
            total: 1,
            limit: 20,
          },
        };
      }
      return { status: 404, body: { error: "not_found", path: requestPath } };
    });

    try {
      const result = await run(["conversations", "search", "RPC"], {
        MANDIBLE_BASE: `file://${spoolDir}`,
        MANDIBLE_FILE_RPC_TIMEOUT: "5",
      });
      const json = await run(["conversations", "search", "RPC", "--json", "--limit", "500"], {
        MANDIBLE_BASE: `file://${spoolDir}`,
        MANDIBLE_FILE_RPC_TIMEOUT: "5",
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("[codex] 2026-06-12 | \"Sandbox session\" | assistant: file RPC route is readable");
      expect(json.status).toBe(0);
      expect(JSON.parse(json.stdout).results).toEqual([expect.objectContaining({
        conversation: expect.objectContaining({ id: "conv-1", session_id: "session-1" }),
        snippet: "file RPC route is readable",
      })]);
      expect(json.stderr).toContain("--limit 500 exceeds the server cap; at most 20 hits are returned");
      expect(seenPaths.some((item) => item.startsWith("/api/conversations/search?"))).toBe(true);
    } finally {
      responder.stop();
    }
  });
});

describe("conversations CLI canonical HTTP reads", () => {
  it("sends show, blocks, and export exact refs directly to the shared server boundary", async () => {
    const seen: Array<{ method: string; url: string }> = [];
    const conversation = {
      id: "conv-1", source: "codex", source_path: "/logs/codex/session.jsonl",
      title: "Sandbox session", started_at: "2026-06-12T12:00:00.000Z",
      updated_at: "2026-06-12T12:01:00.000Z", block_count: 1,
      session_id: "session-1", cwd: "/repo/mandible",
    };
    const block = {
      id: "block-1", conversation_id: "conv-1", type: "assistant_message",
      role: "assistant", content: "canonical body", position: 1,
      timestamp: "2026-06-12T12:01:00.000Z", parent_id: null,
      metadata_json: "{}", dag_uuid: null, dag_parent_uuid: null,
    };
    const server = http.createServer((request, response) => {
      seen.push({ method: request.method ?? "", url: request.url ?? "" });
      response.setHeader("Content-Type", "application/json");
      if (request.method === "GET" && request.url === "/api/instance") {
        response.end(JSON.stringify(MAIN_CLI_INSTANCE_RESPONSE));
      } else if (request.method === "GET" && request.url?.startsWith("/api/conversations/session-1?")) {
        response.end(JSON.stringify({ conversation, blocks: [block] }));
      } else if (request.method === "GET" && request.url?.startsWith("/api/conversations/session-1/blocks?")) {
        response.end(JSON.stringify({ blocks: [block], total: 1, offset: 0, limit: 50, truncated: false }));
      } else if (request.method === "POST" && request.url === "/api/conversations/session-1/export") {
        response.end(JSON.stringify({ content: "# canonical export" }));
      } else {
        response.statusCode = 404;
        response.end(JSON.stringify({ error: "not_found" }));
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("HTTP test server did not bind");
    const env = {
      MANDIBLE_BASE: `http://127.0.0.1:${address.port}`,
      MANDIBLE_TEST_ONLY_ALLOW_NON_MAIN_OPERATIONAL_MUTATIONS: "1",
    };
    try {
      const show = await run(["conversations", "show", "session-1", "--json", "--blocks"], env);
      const blocks = await run(["conversations", "blocks", "session-1", "--json"], env);
      const exported = await run(["conversations", "export", "session-1"], env);
      expect(show.status, show.stderr).toBe(0);
      expect(blocks.status, blocks.stderr).toBe(0);
      expect(exported.status, exported.stderr).toBe(0);
      expect(exported.stdout).toContain("canonical export");
      expect(seen).toEqual(expect.arrayContaining([
        { method: "GET", url: "/api/conversations/session-1?target=latest" },
        { method: "GET", url: "/api/conversations/session-1/blocks?limit=100&offset=0" },
        { method: "POST", url: "/api/conversations/session-1/export" },
      ]));
      expect(seen.some((request) => request.url.includes("session_id="))).toBe(false);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
