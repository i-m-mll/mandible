import { MAIN_CLI_INSTANCE_RESPONSE } from "./helpers/cli-instance-response.js";
import { renderMandibleInstructionsFragment } from "../src/instructions/fragment.js";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

import { startFileRpcResponder } from "./helpers/file-rpc-responder.js";

const CLI = path.join(process.cwd(), "bin", "mandible");

let server: http.Server | null = null;
let requestBodies: Array<{ path: string; method: string; body: unknown }> = [];
let tempRoots: string[] = [];

const issueWithComments = {
  id: "issue-1",
  display_id: "abc",
  title: "Test issue",
  status: "open",
  body: "Body",
  comments: [
    { id: "comment-1", ordinal: 1, body: "First", created_at: 1 },
    { id: "comment-2", ordinal: 2, body: "Second", created_at: 2 },
  ],
};

const editedIssue = {
  ...issueWithComments,
  comments: [
    { id: "comment-1", ordinal: 1, body: "First", created_at: 1 },
    { id: "comment-2", ordinal: 2, body: "Updated body", created_at: 2 },
  ],
};

function run(
  args: string[],
  port: number,
  extraEnv: Record<string, string> = {},
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(CLI, args, {
      cwd: process.cwd(),
      env: {
        ...process.env,
        MANDIBLE_PORT: String(port),
        MANDIBLE_BASE: `http://127.0.0.1:${port}`,
        ...extraEnv,
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

function listen(opts: { staleConflict?: boolean } = {}): Promise<number> {
  requestBodies = [];
  return new Promise((resolve) => {
    server = http.createServer((req, res) => {
      res.setHeader("Content-Type", "application/json");

      const readBody = async (): Promise<unknown> => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        const raw = Buffer.concat(chunks).toString("utf8");
        return raw ? JSON.parse(raw) : null;
      };

      if (req.method === "GET" && req.url === "/api/instance") {
        res.end(JSON.stringify(MAIN_CLI_INSTANCE_RESPONSE));
        return;
      }

      if (req.url?.startsWith("/api/issues?")) {
        res.end(JSON.stringify([{ repo_name: "mandible", issues: [{ id: "abc", status: "open" }] }]));
        return;
      }

      if (req.url === "/api/ledger/issues/abc") {
        res.end(JSON.stringify(issueWithComments));
        return;
      }

      if (req.method === "PATCH" && ["abc%232", "abc%23last"].some((ref) => req.url === `/api/ledger/comments/${ref}`)) {
        void readBody().then((body) => {
          requestBodies.push({ path: req.url ?? "", method: req.method ?? "", body });
          if (opts.staleConflict) {
            res.statusCode = 409;
            res.end(JSON.stringify({ error: "body revision conflict: base does not match current" }));
            return;
          }
          res.end(JSON.stringify(editedIssue));
        });
        return;
      }

      if (req.method === "PATCH" && req.url === "/api/ledger/comments/raw-comment-id") {
        void readBody().then((body) => {
          requestBodies.push({ path: req.url ?? "", method: req.method ?? "", body });
          res.end(JSON.stringify(editedIssue));
        });
        return;
      }

      res.statusCode = 404;
      res.end(JSON.stringify({ error: "not found" }));
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server!.address();
      if (!address || typeof address === "string") {
        throw new Error("test server did not bind a TCP port");
      }
      resolve(address.port);
    });
  });
}

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve, reject) => {
      server!.close((error) => (error ? reject(error) : resolve()));
    });
    server = null;
  }
  for (const root of tempRoots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
  tempRoots = [];
});

describe("comment edit CLI", () => {
  it("includes comment edit in --help output", async () => {
    const result = await run(["issue", "--help"], 9);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("comment edit");
  });

  it("includes comment edit in comment subcommand help", async () => {
    const result = await run(["issue", "comment", "--help"], 9);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("comment edit <comment-ref>");
    expect(result.stdout).toContain("--base-revision");
    expect(result.stdout).toContain("--base-body-hash");
  });

  it("fails validation when comment ref is missing (no API call)", async () => {
    const port = await listen();
    const result = await run(["issue", "comment", "edit", "-m", "body"], port);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Arguments do not match");
    expect(requestBodies).toHaveLength(0);
  });

  it("fails validation when body (-m) is missing (no API call)", async () => {
    const port = await listen();
    const result = await run(["issue", "comment", "edit", "abc#2"], port);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Arguments do not match");
    expect(requestBodies).toHaveLength(0);
  });

  it("edits a comment by ordinal ref (abc#2)", async () => {
    const port = await listen();
    const result = await run(["issue", "comment", "edit", "abc#2", "-m", "Updated body"], port);

    expect(result.status).toBe(0);
    expect(result.stderr).toContain("Edited comment abc#2");
    expect(requestBodies).toContainEqual({
      path: "/api/ledger/comments/abc%232",
      method: "PATCH",
      body: { body: "Updated body" },
    });
  });

  it("edits a comment by #last ref", async () => {
    const port = await listen();
    const result = await run(["issue", "comment", "edit", "abc#last", "-m", "Last comment updated"], port);

    expect(result.status).toBe(0);
    expect(requestBodies).toContainEqual({
      path: "/api/ledger/comments/abc%23last",
      method: "PATCH",
      body: { body: "Last comment updated" },
    });
  });

  it("edits a comment by raw comment id", async () => {
    const port = await listen();
    const result = await run(["issue", "comment", "edit", "raw-comment-id", "-m", "Raw id edit"], port);

    expect(result.status).toBe(0);
    expect(requestBodies).toContainEqual({
      path: "/api/ledger/comments/raw-comment-id",
      method: "PATCH",
      body: { body: "Raw id edit" },
    });
  });

  it("passes --base-revision through as base_body_revision_id", async () => {
    const port = await listen();
    const result = await run([
      "issue", "comment", "edit", "abc#2",
      "-m", "With base rev",
      "--base-revision", "rev-abc123",
    ], port);

    expect(result.status).toBe(0);
    expect(requestBodies).toContainEqual({
      path: "/api/ledger/comments/abc%232",
      method: "PATCH",
      body: { body: "With base rev", base_body_revision_id: "rev-abc123" },
    });
  });

  it("passes --base-body-hash through to the API", async () => {
    const port = await listen();
    const result = await run([
      "issue", "comment", "edit", "abc#2",
      "-m", "With base hash",
      "--base-body-hash", "deadbeef1234",
    ], port);

    expect(result.status).toBe(0);
    expect(requestBodies).toContainEqual({
      path: "/api/ledger/comments/abc%232",
      method: "PATCH",
      body: { body: "With base hash", base_body_hash: "deadbeef1234" },
    });
  });

  it("surfaces a 409 stale base conflict as a clear CLI error with exit code 3", async () => {
    const port = await listen({ staleConflict: true });
    const result = await run(["issue", "comment", "edit", "abc#2", "-m", "Stale"], port);

    expect(result.status).toBe(3);
    expect(result.stderr).toContain("stale base conflict");
    expect(result.stderr).toContain("body revision conflict");
  });

  it("sends PATCH through file RPC when MANDIBLE_BASE is file://", async () => {
    const spoolDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-comment-edit-rpc-"));
    tempRoots.push(spoolDir);
    const seen: Array<Record<string, unknown>> = [];

    const responder = startFileRpcResponder(spoolDir, (request) => {
      seen.push(request);
      if (request.method === "PATCH" && request.path === "/api/ledger/comments/raw-comment-id") {
        return { status: 200, body: editedIssue };
      }
      return { status: 404, body: { error: "not found" } };
    });

    try {
      const result = await run(
        ["issue", "comment", "edit", "raw-comment-id", "-m", "File RPC edit"],
        0,
        { MANDIBLE_BASE: `file://${spoolDir}`, MANDIBLE_FILE_RPC_TIMEOUT: "5" },
      );
      expect(result.status).toBe(0);
      expect(seen.some((r) => r.method === "PATCH" && r.path === "/api/ledger/comments/raw-comment-id")).toBe(true);
    } finally {
      responder.stop();
    }
  });
});

describe("comment edit instructions contract", () => {
  it("lists comment edit in the instructions contract", () => {
    const contract = renderMandibleInstructionsFragment();
    const entry = contract.split("\n").find((line) => line.startsWith("- `mandible issue comment edit "));
    expect(entry).toContain("--base-revision");
    expect(entry).toContain("--base-body-hash");
  });

  it("includes comment edit in installed instructions output", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-comment-edit-instructions-"));
    tempRoots.push(tempDir);
    const target = path.join(tempDir, "AGENTS.md");
    fs.writeFileSync(target, "# Existing\n", "utf8");

    const result = await run(["instructions", "install", "--target", target], 9);
    expect(result.status).toBe(0);
    const installed = fs.readFileSync(target, "utf8");
    expect(installed).toContain("comment edit");
  });
});
