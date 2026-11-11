import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { qualifiedRuntimeFixtureEnv } from "./helpers/runtime-fixture.js";
import { MAIN_CLI_INSTANCE_RESPONSE } from "./helpers/cli-instance-response.js";
import { authCliRepo } from "./helpers/prepared-git-fixture.js";

const fixtureRuntimeEnv = {
  MANDIBLE_RUNTIME: process.execPath,
  ...qualifiedRuntimeFixtureEnv(),
  GIT_OPTIONAL_LOCKS: "0",
};

const CLI = path.join(process.cwd(), "bin", "mandible");

let tempDir = "";
let homeDir = "";
let server: http.Server | null = null;

function run(
  args: string[],
  cwd = tempDir,
  extraEnv: Record<string, string> = {},
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(CLI, args, {
    cwd,
    encoding: "utf8",
    env: {
      HOME: homeDir,
      ...fixtureRuntimeEnv,
      PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin",
      MANDIBLE_PORT: "9",
      ZELLIJ: "",
      TMUX: "",
      ...extraEnv,
    },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function runAsync(
  args: string[],
  cwd = tempDir,
  extraEnv: Record<string, string> = {},
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(CLI, args, {
      cwd,
      env: {
        HOME: homeDir,
        ...fixtureRuntimeEnv,
        PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin",
        MANDIBLE_PORT: "9",
        ZELLIJ: "",
        TMUX: "",
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

function listenForAuthCheck(
  check: Record<string, unknown> = {
    status: "clean",
    repo: "repo",
    base_branch: "main",
    head_branch: "feature/demo",
    checked_requests: 0,
    conflicts: [],
  },
): Promise<{ port: number; bodies: Record<string, unknown>[]; close: () => Promise<void> }> {
  const bodies: Record<string, unknown>[] = [];
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
      bodies.push(JSON.parse(raw));
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ check }));
    });
  });
  return new Promise((resolve) => {
    server!.listen(0, "127.0.0.1", () => {
      const address = server!.address();
      if (!address || typeof address === "string") {
        throw new Error("test server did not bind a TCP port");
      }
      resolve({
        port: address.port,
        bodies,
        close: () => new Promise<void>((done, reject) => {
          server!.close((error) => (error ? reject(error) : done()));
          server = null;
        }),
      });
    });
  });
}

function git(
  args: string[],
  cwd = tempDir,
  extraEnv: Record<string, string> = {},
): string {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, ...extraEnv },
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed:\n${result.stderr}`);
  }
  return result.stdout.trim();
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-auth-merge-cli-"));
  homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-auth-merge-home-"));
  authCliRepo.copyInto(tempDir);
});

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve, reject) => {
      server!.close((error) => (error ? reject(error) : resolve()));
    });
    server = null;
  }
  fs.rmSync(tempDir, { recursive: true, force: true });
  fs.rmSync(homeDir, { recursive: true, force: true });
});

describe("auth merge Mandible preflight", () => {

  it("aborts before dirty checks when git lock files are present", () => {
    const lockPath = path.join(tempDir, ".git", "index.lock");
    fs.writeFileSync(lockPath, "", "utf8");

    const result = run(["auth", "merge", "feature/demo"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Git lock file(s) are present before auth merge");
    expect(result.stderr).toContain(lockPath);
    expect(result.stderr).toContain("no owning process found");
    expect(result.stderr).toContain("Aborting before auth merge because git lock files are present");
    expect(result.stderr).not.toContain("Mandible merge preflight failed");
    expect(result.stderr).not.toContain("commit.gpgsign is set to false");
  });

  it("fails closed when the reviewed target head is stale", async () => {
    const authCheck = await listenForAuthCheck();

    const result = await runAsync(["auth", "merge", "feature/demo"], tempDir, {
      MANDIBLE_AUTH_ATOMIC: "1",
      MANDIBLE_PORT: String(authCheck.port),
      MANDIBLE_BASE: `http://127.0.0.1:${authCheck.port}`,
      MANDIBLE_AUTH_SKIP_MERGE_PREFLIGHT: "1",
      MANDIBLE_AUTH_PREFLIGHT_BASE_SHA: "0000000000000000000000000000000000000000",
    });

    expect(result.status).toBe(1);
    expect(authCheck.bodies).toHaveLength(0);
    expect(result.stderr).toContain("Target main moved from reviewed base");
    expect(result.stderr).toContain("requeue and reapprove");
    expect(result.stderr).not.toContain("commit.gpgsign is set to false");
  });

  it("preserves delegated signing git config overrides from the executor", async () => {
    const authCheck = await listenForAuthCheck();
    const baseSha = git(["rev-parse", "main"]);

    const result = await runAsync(["auth", "merge", "feature/demo"], tempDir, {
      MANDIBLE_AUTH_ATOMIC: "1",
      MANDIBLE_PORT: String(authCheck.port),
      MANDIBLE_BASE: `http://127.0.0.1:${authCheck.port}`,
      MANDIBLE_AUTH_SKIP_MERGE_PREFLIGHT: "1",
      MANDIBLE_AUTH_PREFLIGHT_BASE_SHA: baseSha,
      MANDIBLE_AUTH_DELEGATED_SIGNING: "1",
      AUTH_MERGE_AUTO_CONFIRM: "1",
      GIT_CONFIG_COUNT: "2",
      GIT_CONFIG_KEY_0: "commit.gpgsign",
      GIT_CONFIG_VALUE_0: "true",
      GIT_CONFIG_KEY_1: "user.signingkey",
      GIT_CONFIG_VALUE_1: "/tmp/mandible-delegated.pub",
    });

    expect(result.status).toBe(1);
    expect(authCheck.bodies).toHaveLength(0);
    expect(result.stderr).not.toContain("commit.gpgsign is set to false");
    expect(result.stderr).not.toContain("No signing key configured");
    expect(result.stderr).toContain("checking signing configuration");
  });

  it("preserves staged changes by refusing before daemon preflight", async () => {
    const authCheck = await listenForAuthCheck({
      status: "error",
      repo: "repo",
      base_branch: "main",
      head_branch: "feature/demo",
      checked_requests: 0,
      conflicts: [],
      reason: "tracked worktree changes are present: staged.txt",
    });
    fs.writeFileSync(path.join(tempDir, "staged.txt"), "staged\n", "utf8");
    git(["add", "staged.txt"]);

    const before = git(["rev-parse", "main"]);
    const index = fs.readFileSync(path.join(tempDir, ".git", "index"));

    const result = await runAsync(["auth", "merge", "feature/demo"], tempDir, {
      MANDIBLE_AUTH_ATOMIC: "1",
      MANDIBLE_PORT: String(authCheck.port),
      MANDIBLE_BASE: `http://127.0.0.1:${authCheck.port}`,
    });

    expect(result.status).toBe(1);
    expect(authCheck.bodies).toHaveLength(0);
    expect(result.stdout).toContain("Checkout blocked: staged [A ]: staged.txt");
    expect(git(["rev-parse", "main"])).toBe(before);
    expect(fs.readFileSync(path.join(tempDir, ".git", "index"))).toEqual(index);
    expect(fs.readFileSync(path.join(tempDir, "staged.txt"), "utf8")).toBe("staged\n");
    expect(result.stderr).not.toContain("commit.gpgsign is set to false");
  });

  it("preserves interrupted legacy merge state", () => {
    git(["merge", "--no-ff", "--no-commit", "feature/demo"]);
    fs.writeFileSync(path.join(tempDir, "tracked.txt"), "unrelated local edit\n", "utf8");
    const before = git(["rev-parse", "main"]);
    const mergeHead = fs.readFileSync(path.join(tempDir, ".git", "MERGE_HEAD"), "utf8");
    const index = git(["write-tree"]);

    const result = run(["auth", "merge", "feature/demo"], tempDir, { MANDIBLE_AUTH_ATOMIC: "1" });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("requires operator recovery");
    expect(git(["rev-parse", "main"])).toBe(before);
    expect(git(["write-tree"])).toBe(index);
    expect(fs.readFileSync(path.join(tempDir, ".git", "MERGE_HEAD"), "utf8")).toBe(mergeHead);
    expect(fs.readFileSync(path.join(tempDir, "tracked.txt"), "utf8")).toBe("unrelated local edit\n");
  });

});

// Child issue 8921e84: docs-branch promotion via a short-lived proxy branch.
