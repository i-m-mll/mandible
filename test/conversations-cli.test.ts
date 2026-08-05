import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

import { startFileRpcResponder } from "./helpers/file-rpc-responder.js";

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
      if (requestPath.startsWith("/api/conversations/conv-1/blocks")) {
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
      expect(blocks.status).toBe(0);
      expect(JSON.parse(blocks.stdout)).toEqual([expect.objectContaining({ id: "block-1", role: "assistant" })]);
      expect(seenPaths.some((item) => item.startsWith("/api/conversations?"))).toBe(true);
      expect(seenPaths.some((item) => item.startsWith("/api/conversations/conv-1/blocks"))).toBe(true);
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
      if (requestPath.startsWith("/api/conversations/conv-1/blocks")) {
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
      expect(seenPaths).toContain("/api/conversations/conv-1/blocks?limit=999&offset=500");
    } finally {
      responder.stop();
    }
  });

  it("returns a clear unsupported error for file-RPC conversation export", async () => {
    const spoolDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-conversations-export-file-rpc-"));
    tempRoots.push(spoolDir);

    const result = await run(["conversations", "export", "session-1"], {
      MANDIBLE_BASE: `file://${spoolDir}`,
      MANDIBLE_FILE_RPC_TIMEOUT: "5",
    });

    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("conversations export is not supported through file-RPC");
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

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("[codex] 2026-06-12 | \"Sandbox session\" | assistant: file RPC route is readable");
      expect(seenPaths.some((item) => item.startsWith("/api/conversations/search?"))).toBe(true);
    } finally {
      responder.stop();
    }
  });
});
