import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

import { MAIN_CLI_INSTANCE_RESPONSE } from "../helpers/cli-instance-response.js";

const CLI = path.join(process.cwd(), "bin", "mandible");

let server: http.Server | null = null;

function run(
  args: string[],
  port: number,
  cwd: string,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(CLI, args, {
      cwd,
      env: {
        ...process.env,
        MANDIBLE_PORT: String(port),
        // Pin base to the test stub so a leaked dev-shell MANDIBLE_BASE
        // (e.g. the live daemon at :19420) can never route this subprocess.
        MANDIBLE_BASE: `http://127.0.0.1:${port}`,
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

function listenWithAuthCheck(): Promise<{ port: number; bodies: Array<Record<string, unknown>> }> {
  const bodies: Array<Record<string, unknown>> = [];
  return new Promise((resolve) => {
    server = http.createServer((req, res) => {
      if (req.method === "GET" && req.url === "/api/instance") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(MAIN_CLI_INSTANCE_RESPONSE));
      return;
    }
    if (req.method !== "POST" || req.url !== "/api/auth/check") {
        res.statusCode = 404;
        res.end("not found");
        return;
      }
      let raw = "";
      req.setEncoding("utf8");
      req.on("data", (chunk) => {
        raw += chunk;
      });
      req.on("end", () => {
        bodies.push(JSON.parse(raw) as Record<string, unknown>);
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({
          check: {
            status: "clean",
            repo: "repo",
            base_branch: "main",
            head_branch: "feature/demo",
            checked_requests: 0,
            conflicts: [],
          }
        }));
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server!.address();
      if (!address || typeof address === "string") {
        throw new Error("test server did not bind a TCP port");
      }
      resolve({ port: address.port, bodies });
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

describe("auth check CLI", () => {
  it("lets the daemon resolve cwd when --repo is used outside the target repo", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-auth-check-cli-"));
    try {
      const { port, bodies } = await listenWithAuthCheck();
      const result = await run([
        "auth",
        "check",
        "--repo",
        "repo",
        "--branch",
        "feature/demo",
        "--json",
      ], port, cwd);

      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout).check.status).toBe("clean");
      expect(bodies).toHaveLength(1);
      expect(bodies[0]).toMatchObject({
        repo: "repo",
        base_branch: null,
        head_branch: "feature/demo",
        cwd: null,
      });
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("renders a stale queue request as remediation, not a conflict (fbf2a58)", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-auth-check-cli-"));
    try {
      const port = await new Promise<number>((resolve) => {
        server = http.createServer((req, res) => {
          if (req.method === "GET" && req.url === "/api/instance") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(MAIN_CLI_INSTANCE_RESPONSE));
      return;
    }
    if (req.method !== "POST" || req.url !== "/api/auth/check") {
            res.statusCode = 404;
            res.end("not found");
            return;
          }
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({
            check: {
              status: "stale_request",
              repo: "repo",
              base_branch: "main",
              head_branch: "feature/live",
              checked_requests: 0,
              conflicts: [],
              stale_requests: [
                {
                  request_id: "1504906a-dead-beef",
                  head_branch: "feature/gone",
                  message:
                    "Queued auth request 1504906a-dead-beef references head branch " +
                    "'feature/gone', which no longer exists.",
                },
              ],
              reason: "1 queued request(s) reference a head branch that no longer exists.",
            },
          }));
        });
        server.listen(0, "127.0.0.1", () => {
          const address = server!.address();
          if (!address || typeof address === "string") {
            throw new Error("test server did not bind a TCP port");
          }
          resolve(address.port);
        });
      });

      const result = await run([
        "auth",
        "check",
        "--repo",
        "repo",
        "--branch",
        "feature/live",
      ], port, cwd);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("stale queue request");
      expect(result.stderr).toContain("1504906a-dead-beef");
      expect(result.stderr).toContain("Remediation");
      // The stale-request path must never frame this as a conflict or dirty state.
      expect(result.stderr).not.toContain("Auth check: conflict");
      expect(result.stderr.toLowerCase()).not.toContain("dirty");
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});
