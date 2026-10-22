import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const USER_CLI = path.join(process.cwd(), "cli", "user.sh");

let server: http.Server | null = null;

function run(
  shell: string,
  args: string[],
  port: number,
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(shell, [USER_CLI, ...args], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        MANDIBLE_BASE: `http://127.0.0.1:${port}`,
        MANDIBLE_CLI_DIR: path.join(process.cwd(), "cli"),
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

function listenWithUsers(requestUrls: string[]): Promise<number> {
  return new Promise((resolve) => {
    server = http.createServer((req, res) => {
      requestUrls.push(req.url ?? "");
      if (!req.url?.startsWith("/api/users")) {
        res.statusCode = 404;
        res.end("not found");
        return;
      }
      const users = [
        {
          id: "user-active",
          slug: "active-user",
          display_name: "Active User",
          email: "active@example.com",
          kind: "human",
          status: "active",
        },
        {
          id: "user-retired",
          slug: "retired-user",
          display_name: "Retired User",
          email: null,
          kind: "agent",
          status: "retired",
        },
      ];
      const filteredUsers = req.url.includes("status=active")
        ? users.filter((user) => user.status === "active")
        : users;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ users: filteredUsers }));
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

describe("user list CLI", () => {
  for (const shell of ["bash", "zsh"]) {
    it(`lists users in human-readable output under ${shell}`, async () => {
      const port = await listenWithUsers([]);
      const result = await run(shell, ["list"], port);

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("active-user\thuman\tactive\tActive User\tactive@example.com");
      expect(result.stdout).toContain("retired-user\tagent\tretired\tRetired User\t-");
    });

    it(`lists users as JSON under ${shell}`, async () => {
      const port = await listenWithUsers([]);
      const result = await run(shell, ["list", "--json"], port);

      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout).users).toHaveLength(2);
    });

    it(`preserves the public status filter under ${shell}`, async () => {
      const requestUrls: string[] = [];
      const port = await listenWithUsers(requestUrls);
      const result = await run(shell, ["list", "--status", "active", "--json"], port);

      expect(result.status, result.stderr).toBe(0);
      expect(requestUrls).toEqual(["/api/users?status=active"]);
      const payload = JSON.parse(result.stdout);
      expect(payload.users).toHaveLength(1);
      expect(payload.users[0].slug).toBe("active-user");
    });
  }
});
