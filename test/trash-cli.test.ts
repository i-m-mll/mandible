import { MAIN_CLI_INSTANCE_RESPONSE } from "./helpers/cli-instance-response.js";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const CLI = path.join(process.cwd(), "bin", "mandible");
let server: http.Server | null = null;

interface CapturedRequest {
  method: string | undefined;
  url: string | undefined;
  body: unknown;
}

function run(
  args: string[],
  port: number,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(CLI, args, {
      cwd: process.cwd(),
      env: {
        ...process.env,
        MANDIBLE_PORT: String(port),
        MANDIBLE_BASE: `http://127.0.0.1:${port}`,
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

function listen(options: {
  trashPartialFailure?: boolean;
  trashBranchOnly?: boolean;
} = {}): Promise<{ port: number; requests: CapturedRequest[] }> {
  const requests: CapturedRequest[] = [];
  server = http.createServer((req, res) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      requests.push({ method: req.method, url: req.url, body: raw ? JSON.parse(raw) : null });
      res.setHeader("Content-Type", "application/json");
      if (req.method === "GET" && req.url === "/api/instance") {
        res.end(JSON.stringify(MAIN_CLI_INSTANCE_RESPONSE));
      } else if (req.method === "GET" && req.url === "/api/v1/trash?project=mandible&state=active") {
        res.end(JSON.stringify({ entries: [{ id: "trash-1", state: "active" }] }));
      } else if (req.method === "POST" && req.url === "/api/v1/trash") {
        if (options.trashPartialFailure) {
          res.statusCode = 409;
          res.end(JSON.stringify({
            error: "snapshot is safe but local removal failed",
            code: "remove_failed",
            detail: {
              id: "trash-1",
              outcome: {
                worktree_removed: true,
                branch_removed: false,
                worktree_path: "/registered/repo/worktrees/feature__demo",
              },
            },
          }));
          return;
        }
        if (options.trashBranchOnly) {
          res.statusCode = 201;
          res.end(JSON.stringify({
            entry: { id: "trash-1", branch: "feature/demo", state: "active" },
            outcome: {
              worktree_removed: false,
              branch_removed: true,
              worktree_path: null,
            },
          }));
          return;
        }
        res.statusCode = 201;
        res.end(JSON.stringify({
          entry: { id: "trash-1", branch: "feature/demo", state: "active" },
          outcome: {
            worktree_removed: true,
            branch_removed: true,
            worktree_path: "/registered/repo/worktrees/feature__demo",
          },
        }));
      } else if (req.method === "POST" && req.url === "/api/v1/trash/trash-1/restore") {
        res.end(JSON.stringify({
          entry: { id: "trash-1", state: "restored" },
          branch: "feature/demo",
          worktree_path: "/tmp/restored",
        }));
      } else if (req.method === "POST" && req.url === "/api/v1/trash/gc") {
        res.end(JSON.stringify({ outcomes: [{ id: "trash-2", status: "expired" }], expired: 1, failed: 0 }));
      } else {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: "not found" }));
      }
    });
  });
  return new Promise((resolve) => {
    server!.listen(0, "127.0.0.1", () => {
      const address = server!.address();
      if (!address || typeof address === "string") throw new Error("server did not bind");
      resolve({ port: address.port, requests });
    });
  });
}

afterEach(async () => {
  if (!server) return;
  await new Promise<void>((resolve, reject) => {
    server!.close((error) => error ? reject(error) : resolve());
  });
  server = null;
});

describe("trash CLI", () => {
  it("routes list, create, restore, and gc with the documented JSON contract", async () => {
    const { port, requests } = await listen();

    const listed = await run(["trash", "list", "--project", "mandible", "--state", "active"], port);
    expect(listed.status).toBe(0);
    expect(JSON.parse(listed.stdout)).toMatchObject({ entries: [{ id: "trash-1" }] });

    const created = await run([
      "trash", "create",
      "--project", "/registered/repo",
      "--branch", "feature/demo",
      "--reason", "merged",
      "--actor", "auth-merge",
      "--issue", "abc123",
      "--issue", "def456",
      "--checkout-root", "/registered/repo",
      "--retention-days", "45",
    ], port);
    expect(created.status).toBe(0);
    expect(JSON.parse(created.stdout)).toMatchObject({ outcome: { worktree_removed: true } });
    expect(created.stderr).toContain("worktree path /registered/repo/worktrees/feature__demo is gone");
    expect(created.stderr).toContain("No further work may happen there");

    const restored = await run([
      "trash", "restore", "trash-1", "--worktree-path", "/tmp/restored", "--actor", "operator",
    ], port);
    expect(restored.status).toBe(0);
    expect(JSON.parse(restored.stdout)).toMatchObject({ worktree_path: "/tmp/restored" });

    const gc = await run(["trash", "gc", "--now", "1780000000000", "--limit", "25", "--actor", "timer"], port);
    expect(gc.status).toBe(0);
    expect(JSON.parse(gc.stdout)).toMatchObject({ expired: 1, failed: 0 });

    expect(requests.filter((request) => request.url !== "/api/instance")).toEqual([
      { method: "GET", url: "/api/v1/trash?project=mandible&state=active", body: null },
      {
        method: "POST",
        url: "/api/v1/trash",
        body: {
          project: "/registered/repo",
          branch: "feature/demo",
          reason: "merged",
          actor: "auth-merge",
          checkout_root: "/registered/repo",
          issue_refs: ["abc123", "def456"],
          retention_days: 45,
        },
      },
      {
        method: "POST",
        url: "/api/v1/trash/trash-1/restore",
        body: { worktree_path: "/tmp/restored", actor: "operator" },
      },
      {
        method: "POST",
        url: "/api/v1/trash/gc",
        body: { now: 1780000000000, limit: 25, actor: "timer" },
      },
    ]);
  });

  it("fails closed on invalid retention before sending a mutation", async () => {
    const { port, requests } = await listen();
    const result = await run([
      "trash", "create", "--project", "mandible", "--branch", "feature/demo",
      "--reason", "manual", "--retention-days", "0",
    ], port);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("integer from 1 to 3650");
    expect(requests).toEqual([]);
  });

  it("returns nonzero but still reports finality after partial worktree removal", async () => {
    const { port } = await listen({ trashPartialFailure: true });
    const result = await run([
      "trash", "create", "--project", "mandible", "--branch", "feature/demo",
      "--reason", "merged", "--checkout-root", "/registered/repo",
    ], port);

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain('"code":"remove_failed"');
    expect(result.stderr).toContain("Trash custody incomplete");
    expect(result.stderr).toContain("worktree path /registered/repo/worktrees/feature__demo is gone");
    expect(result.stderr).toContain("No further work may happen there");
  });

  it("reports branch-only success without claiming that a worktree path is gone", async () => {
    const { port } = await listen({ trashBranchOnly: true });
    const result = await run([
      "trash", "create", "--project", "mandible", "--branch", "feature/demo",
      "--reason", "merged", "--checkout-root", "/registered/repo",
    ], port);

    expect(result.status).toBe(0);
    expect(result.stderr).toContain("normal branch ref is gone");
    expect(result.stderr).not.toContain("worktree path");
    expect(result.stderr).not.toContain("No further work may happen there");
  });
});
