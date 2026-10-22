import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

import { startFileRpcResponder } from "./helpers/file-rpc-responder.js";

const CLI = path.join(process.cwd(), "bin", "mandible");

let server: http.Server | null = null;

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
        // Pin base to the test stub so a leaked dev-shell MANDIBLE_BASE
        // (e.g. the live daemon at :19420) can never route this subprocess.
        // Placed before extraEnv so explicit per-call overrides (file:// RPC)
        // still win.
        MANDIBLE_BASE: `http://127.0.0.1:${port}`,
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

function listenWithQueue(queue: unknown): Promise<number> {
  return new Promise((resolve) => {
    server = http.createServer((req, res) => {
      if (req.url?.startsWith("/api/auth/queue")) {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(queue));
        return;
      }
      if (req.url?.startsWith("/api/issues?")) {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify([
          {
            repo_id: "mandible",
            repo_name: "mandible",
            repo_root: "/tmp/registered/mandible",
            issues: [],
          },
        ]));
        return;
      }
      res.statusCode = 404;
      res.end("not found");
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
});

describe("auth list CLI", () => {
  const queue = {
    requests: [
      {
        id: "11111111-1111-4111-8111-111111111111",
        status: "pending",
        repo: "mandible",
        head_branch: "feature/auth-list-cli",
        base_branch: "main",
        title: "Merge feature/auth-list-cli: auth list",
      },
      {
        id: "22222222-2222-4222-8222-222222222222",
        status: "completed",
        repo: "dotfiles",
        head_branch: "feature/auth-list-instructions",
        base_branch: "main",
        title: "Merge feature/auth-list-instructions: instructions",
      },
    ],
  };

  it("documents the auth subcommand surface", async () => {
    const result = await run(["auth", "--help"], 9);

    expect(result.status).toBe(0);
    for (const command of ["list", "request", "merge"]) {
      expect(result.stdout).toContain(`mandible auth ${command} `);
    }
  });

  it("prints active auth requests in a compact human format", async () => {
    const port = await listenWithQueue(queue);
    const result = await run(["auth", "list"], port);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Auth queue: 2 active request(s)");
    expect(result.stdout).toContain("[11111111] pending mandible feature/auth-list-cli -> main");
    expect(result.stdout).toContain("[22222222] completed dotfiles feature/auth-list-instructions -> main");
    expect(result.stdout).not.toContain(queue.requests[0].id);
    expect(result.stdout).not.toContain(queue.requests[1].id);
  });

  it("filters by repo, branch, and status in JSON output", async () => {
    const port = await listenWithQueue(queue);
    const result = await run(
      [
        "auth",
        "list",
        "--repo",
        "mandible",
        "--head",
        "feature/auth-list-cli",
        "--status",
        "pending",
        "--json",
      ],
      port,
    );

    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.requests).toHaveLength(1);
    expect(payload.requests[0].repo).toBe("mandible");
    expect(payload.requests[0].head_branch).toBe("feature/auth-list-cli");
    expect(payload.requests[0].status).toBe("pending");
  });

  it("matches explicit repo paths to queued repo aliases", async () => {
    const port = await listenWithQueue(queue);
    const result = await run(
      ["auth", "list", "--repo", "/tmp/registered/mandible", "--json"],
      port,
    );

    expect(result.status).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.requests).toHaveLength(1);
    expect(payload.requests[0].repo).toBe("mandible");
  });

  it("lists auth requests through file RPC", async () => {
    const spoolDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-auth-list-file-rpc-"));
    const responder = startFileRpcResponder(spoolDir, () => ({ status: 200, body: queue }));

    try {
      const result = await run(["auth", "list", "--json"], 0, {
        MANDIBLE_BASE: `file://${spoolDir}`,
        MANDIBLE_FILE_RPC_TIMEOUT: "5",
      });

      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout).requests).toHaveLength(2);
    } finally {
      responder.stop();
      fs.rmSync(spoolDir, { recursive: true, force: true });
    }
  });

  it("reports a daemon connectivity error", async () => {
    const result = await run(["auth", "list"], 9);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("could not reach Mandible daemon");
  });
});
