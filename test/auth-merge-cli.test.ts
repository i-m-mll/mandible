import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

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

function git(args: string[], cwd = tempDir): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed:\n${result.stderr}`);
  }
  return result.stdout.trim();
}

function createRepo(): void {
  git(["init", "-b", "main"]);
  git(["config", "user.name", "Mandible Test"]);
  git(["config", "user.email", "mandible-test@example.invalid"]);
  git(["config", "commit.gpgsign", "false"]);
  fs.writeFileSync(path.join(tempDir, "tracked.txt"), "base\n", "utf8");
  git(["add", "tracked.txt"]);
  git(["commit", "-m", "base"]);
  git(["checkout", "-b", "feature/demo"]);
  fs.writeFileSync(path.join(tempDir, "feature.txt"), "feature\n", "utf8");
  git(["add", "feature.txt"]);
  git(["commit", "-m", "feature"]);
  git(["checkout", "main"]);
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-auth-merge-cli-"));
  homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-auth-merge-home-"));
  createRepo();
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
  it("forces optional git locks off for CLI-internal git calls", async () => {
    const authCheck = await listenForAuthCheck();
    const realGit = spawnSync("bash", ["-lc", "command -v git"], { encoding: "utf8" }).stdout.trim();
    const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-git-wrapper-"));
    const envLog = path.join(fakeBin, "env.log");
    fs.writeFileSync(path.join(fakeBin, "git"), [
      "#!/usr/bin/env bash",
      `printf '%s\\n' "$GIT_OPTIONAL_LOCKS" >> ${JSON.stringify(envLog)}`,
      `exec ${JSON.stringify(realGit)} "$@"`,
      "",
    ].join("\n"), { mode: 0o755 });

    try {
      const result = await runAsync(["auth", "merge", "feature/demo"], tempDir, {
        GIT_OPTIONAL_LOCKS: "1",
        PATH: `${fakeBin}:${process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin"}`,
        MANDIBLE_PORT: String(authCheck.port),
        MANDIBLE_BASE: `http://127.0.0.1:${authCheck.port}`,
      });

      expect(result.status).toBe(1);
      expect(authCheck.bodies).toHaveLength(1);
      expect(result.stderr).toContain("commit.gpgsign is set to false");
      const observed = fs.readFileSync(envLog, "utf8").trim().split("\n");
      expect(observed.length).toBeGreaterThan(0);
      expect(observed.every((value) => value === "0")).toBe(true);
    } finally {
      fs.rmSync(fakeBin, { recursive: true, force: true });
    }
  });

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

  it("does not block untracked-only working tree state", async () => {
    const authCheck = await listenForAuthCheck();
    fs.writeFileSync(path.join(tempDir, "scratch.txt"), "local\n", "utf8");

    const result = await runAsync(["auth", "merge", "feature/demo"], tempDir, {
      MANDIBLE_PORT: String(authCheck.port),
      MANDIBLE_BASE: `http://127.0.0.1:${authCheck.port}`,
    });

    expect(result.status).toBe(1);
    expect(authCheck.bodies).toHaveLength(1);
    expect(result.stderr).not.toContain("Working tree is dirty");
    expect(result.stderr).toContain("commit.gpgsign is set to false");
  });

  it("blocks staged changes through Mandible auth check", async () => {
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

    const result = await runAsync(["auth", "merge", "feature/demo"], tempDir, {
      MANDIBLE_PORT: String(authCheck.port),
      MANDIBLE_BASE: `http://127.0.0.1:${authCheck.port}`,
    });

    expect(result.status).toBe(1);
    expect(authCheck.bodies).toHaveLength(1);
    expect(result.stderr).toContain("tracked worktree changes are present: staged.txt");
    expect(result.stderr).toContain("Mandible merge preflight failed");
    expect(result.stderr).toContain("staged.txt");
    expect(result.stderr).not.toContain("commit.gpgsign is set to false");
  });

  it("resumes MERGE_HEAD before running Mandible auth check", () => {
    fs.writeFileSync(path.join(tempDir, ".git", "MERGE_HEAD"), git(["rev-parse", "feature/demo"]), "utf8");

    const result = run(["auth", "merge", "feature/demo"]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Merge already in progress");
    expect(result.stderr).toContain("commit.gpgsign is set to false");
    expect(result.stderr).not.toContain("Mandible merge preflight failed");
  });
});
