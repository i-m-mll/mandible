import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

import { startFileRpcResponder } from "./helpers/file-rpc-responder.js";

const CLI = path.join(process.cwd(), "bin", "mandible");
const tempRoots: string[] = [];

function run(args: string[], env: Record<string, string>): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(CLI, args, { cwd: os.tmpdir(), env: {
      ...process.env,
      ...env,
    } });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

afterEach(() => {
  for (const root of tempRoots) fs.rmSync(root, { recursive: true, force: true });
  tempRoots.length = 0;
});

describe("conversation metadata CLI", () => {
  it("fails --current when a sidechain is not linked to the sole parent", async () => {
    const spool = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-conversation-current-cli-"));
    tempRoots.push(spool);
    const responder = startFileRpcResponder(spool, (request) => {
      if (request.method === "GET" && String(request.path).includes("session_id=thread-1")) {
        return { status: 200, body: { conversations: [
          { id: "parent", parent_conversation_id: null, is_sidechain: false },
          { id: "orphan", parent_conversation_id: null, is_sidechain: true },
        ] } };
      }
      return { status: 500, body: { error: "unexpected mutation" } };
    });
    try {
      const result = await run(["conversations", "star", "--current"], {
        MANDIBLE_BASE: `file://${spool}`,
        MANDIBLE_FILE_RPC_TIMEOUT: "5",
        CODEX_THREAD_ID: "thread-1",
      });
      expect(result.status).toBe(2);
      expect(responder.requests.every((request) => request.method === "GET")).toBe(true);
    } finally {
      responder.stop();
    }
  });

  it("fails an explicit ref when the exact id and exact provider session identify different conversations", async () => {
    const spool = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-conversation-explicit-cli-"));
    tempRoots.push(spool);
    const responder = startFileRpcResponder(spool, (request) => {
      if (request.method === "GET" && request.path === "/api/conversations/shared") {
        return { status: 200, body: { conversation: { id: "shared" } } };
      }
      if (request.method === "GET" && String(request.path).includes("session_id=shared")) {
        return { status: 200, body: { conversations: [{ id: "other" }] } };
      }
      return { status: 500, body: { error: "unexpected mutation" } };
    });
    try {
      const result = await run(["conversations", "star", "shared"], {
        MANDIBLE_BASE: `file://${spool}`,
        MANDIBLE_FILE_RPC_TIMEOUT: "5",
        CODEX_THREAD_ID: "",
      });
      expect(result.status).toBe(2);
      expect(responder.requests.every((request) => request.method === "GET")).toBe(true);
    } finally {
      responder.stop();
    }
  });

  it("resolves a provider session with linked sidechains to its sole parent", async () => {
    const spool = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-conversation-parent-cli-"));
    tempRoots.push(spool);
    const parent = {
      id: "parent", source: "claude_code", session_id: "thread-1", title: "Parent",
      parent_conversation_id: null, is_sidechain: false, starred: false, tags: [], notes: null,
    };
    const children = ["child-1", "child-2"].map((id) => ({
      id, source: "claude_code", session_id: "thread-1", title: id,
      parent_conversation_id: "parent", is_sidechain: true,
    }));
    const responder = startFileRpcResponder(spool, (request) => {
      if (request.method === "GET" && request.path === "/api/conversations/thread-1") {
        return { status: 404, body: { error: "not found" } };
      }
      if (request.method === "GET" && String(request.path).includes("session_id=thread-1")) {
        return { status: 200, body: { conversations: [parent, ...children] } };
      }
      if (request.method === "PATCH" && request.path === "/api/conversations/parent") {
        return { status: 200, body: { ...parent, starred: true } };
      }
      return { status: 500, body: { error: "unexpected request" } };
    });
    try {
      const baseEnv = {
        MANDIBLE_BASE: `file://${spool}`,
        MANDIBLE_FILE_RPC_TIMEOUT: "5",
        CODEX_THREAD_ID: "",
      };
      expect((await run(["conversations", "star", "thread-1", "--json"], baseEnv)).status).toBe(0);
      expect((await run(["conversations", "star", "--current", "--json"], {
        ...baseEnv,
        CLAUDE_SESSION_ID: "thread-1",
      })).status).toBe(0);
      expect(responder.requests.filter((request) => request.method === "PATCH").map((request) => request.path))
        .toEqual(["/api/conversations/parent", "/api/conversations/parent"]);
    } finally {
      responder.stop();
    }
  });
});
