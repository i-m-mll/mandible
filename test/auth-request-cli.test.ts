import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const CLI = path.join(process.cwd(), "bin", "mandible");

let tempDir = "";
let homeDir = "";

function run(
  args: string[],
  cwd = tempDir,
  extraEnv: Record<string, string> = {},
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(CLI, args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: homeDir,
      MANDIBLE_PORT: "9",
      // Pin base to the (dead) test port so a leaked dev-shell MANDIBLE_BASE
      // (e.g. the live daemon at :19420) can never route this subprocess.
      // Placed before extraEnv so explicit per-call overrides still win.
      MANDIBLE_BASE: "http://127.0.0.1:9",
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
        ...process.env,
        HOME: homeDir,
        MANDIBLE_PORT: "9",
        // Pin base to the (dead) test port so a leaked dev-shell MANDIBLE_BASE
        // (e.g. the live daemon at :19420) can never route this subprocess.
        // Placed before extraEnv so explicit per-call overrides still win.
        MANDIBLE_BASE: "http://127.0.0.1:9",
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

function listenForAuthRequest(): Promise<{
  port: number;
  close: () => Promise<void>;
  bodies: Record<string, unknown>[];
  checkBodies: Record<string, unknown>[];
}> {
  const bodies: Record<string, unknown>[] = [];
  const checkBodies: Record<string, unknown>[] = [];
  const server = http.createServer((req, res) => {
    if (req.method === "POST" && req.url === "/api/auth/check") {
      let raw = "";
      req.setEncoding("utf8");
      req.on("data", (chunk) => {
        raw += chunk;
      });
      req.on("end", () => {
        checkBodies.push(JSON.parse(raw));
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          check: {
            status: "clean",
            repo: localRepoName(),
            base_branch: "main",
            head_branch: "feature/demo",
            checked_requests: 0,
            conflicts: [],
          }
        }));
      });
      return;
    }
    if (req.method === "POST" && req.url === "/api/auth/request") {
      let raw = "";
      req.setEncoding("utf8");
      req.on("data", (chunk) => {
        raw += chunk;
      });
      req.on("end", () => {
        bodies.push(JSON.parse(raw));
        res.writeHead(201, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ request_id: "req_cli_close" }));
      });
      return;
    }
    res.statusCode = 404;
    res.end("not found");
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("test server did not bind a TCP port");
      }
      resolve({
        port: address.port,
        bodies,
        checkBodies,
        close: () => new Promise<void>((done, reject) => {
          server.close((error) => (error ? reject(error) : done()));
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

function localRepoName(): string {
  return path.basename(tempDir);
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
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-auth-request-cli-"));
  homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-auth-request-home-"));
  createRepo();
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
  fs.rmSync(homeDir, { recursive: true, force: true });
});

describe("auth request repo context validation", () => {
  it("rejects explicit repo mismatches before request submission", () => {
    const result = run([
      "auth",
      "request",
      "feature/demo",
      "--title",
      "Merge feature/demo",
      "--issue",
      "25123f9",
      "--repo",
      "target-repo",
      "--force",
      "--no-watch",
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      `cwd git repo '${localRepoName()}' does not match target repo 'target-repo'`,
    );
    expect(result.stderr).toContain("Run mandible auth request from the target repo worktree");
    expect(result.stderr).not.toContain("Mandible unreachable");
  });

  it("preserves explicit matching repo submissions", () => {
    const result = run([
      "auth",
      "request",
      "feature/demo",
      "--title",
      "Merge feature/demo",
      "--issue",
      "25123f9",
      "--repo",
      localRepoName(),
      "--no-watch",
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).not.toContain("does not match target repo");
    expect(result.stderr).toContain("could not reach Mandible daemon");
    expect(result.stderr).toContain("Mandible merge preflight failed");
  });
});

describe("auth request staged close action sugar", () => {
  it("sends issue_close actions while preserving legacy issue_closures", async () => {
    const server = await listenForAuthRequest();
    try {
      const result = await runAsync([
        "auth",
        "request",
        "feature/demo",
        "--title",
        "Merge feature/demo",
        "--closes-issue",
        "done456",
        "--no-watch",
      ], tempDir, {
        MANDIBLE_PORT: String(server.port),
        MANDIBLE_BASE: `http://127.0.0.1:${server.port}`,
      });

      expect(result.status).toBe(0);
      expect(server.checkBodies).toHaveLength(1);
      expect(server.checkBodies[0]).toMatchObject({
        repo: localRepoName(),
        base_branch: "main",
        head_branch: "feature/demo",
      });
      expect(fs.realpathSync(String(server.checkBodies[0].cwd))).toBe(fs.realpathSync(tempDir));
      expect(server.bodies).toHaveLength(1);
      expect(server.bodies[0].issue_closures).toEqual(["done456"]);
      expect(server.bodies[0].issues).toEqual(["done456"]);
      expect(server.bodies[0].actions).toEqual([
        { kind: "issue_close", target_issue_ref: "done456", payload: {} },
      ]);
    } finally {
      await server.close();
    }
  });
});

describe("auth request Mandible merge preflight", () => {
  it("ignores dotfiles pre-auth-check and uses the Mandible auth check route", async () => {
    const dotfilesBin = path.join(homeDir, ".dotfiles", "bin");
    fs.mkdirSync(dotfilesBin, { recursive: true });
    fs.writeFileSync(path.join(dotfilesBin, "pre-auth-check"), [
      "#!/usr/bin/env bash",
      "echo dotfiles pre-auth-check should not run >&2",
      "exit 99",
      "",
    ].join("\n"), { mode: 0o755 });

    const server = await listenForAuthRequest();
    try {
      const result = await runAsync([
        "auth",
        "request",
        "feature/demo",
        "--title",
        "Merge feature/demo",
        "--issue",
        "148e602",
        "--no-watch",
      ], tempDir, {
        MANDIBLE_PORT: String(server.port),
        MANDIBLE_BASE: `http://127.0.0.1:${server.port}`,
      });

      expect(result.status).toBe(0);
      expect(result.stderr).not.toContain("dotfiles pre-auth-check should not run");
      expect(server.checkBodies).toHaveLength(1);
      expect(server.bodies).toHaveLength(1);
    } finally {
      await server.close();
    }
  });
});

describe("auth request protected-root dirty policy", () => {
  it("blocks tracked dirty protected roots without restoring files", () => {
    fs.writeFileSync(path.join(tempDir, "tracked.txt"), "dirty\n", "utf8");

    const result = run([
      "auth",
      "request",
      "feature/demo",
      "--title",
      "Merge feature/demo",
      "--issue",
      "350817b",
      "--no-watch",
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("protected branch worktree is dirty");
    expect(result.stderr).toContain("tracked.txt");
    expect(fs.readFileSync(path.join(tempDir, "tracked.txt"), "utf8")).toBe("dirty\n");
  });

  it("moves dirty protected-root state to a shelve branch when configured", () => {
    fs.writeFileSync(
      path.join(tempDir, "mandible.toml"),
      [
        "[auth.protected_root_dirty]",
        'default_policy = "branch-off"',
        'branch_prefix = "shelve/protected-root-test"',
        "include_untracked = true",
        "",
      ].join("\n"),
      "utf8",
    );
    git(["add", "mandible.toml"]);
    git(["commit", "-m", "add mandible config"]);
    fs.writeFileSync(path.join(tempDir, "tracked.txt"), "dirty\n", "utf8");
    fs.writeFileSync(path.join(tempDir, "untracked.txt"), "local\n", "utf8");

    const result = run([
      "auth",
      "request",
      "feature/demo",
      "--title",
      "Merge feature/demo",
      "--issue",
      "350817b",
      "--no-watch",
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Protected-root changes were moved to branch");
    expect(fs.readFileSync(path.join(tempDir, "tracked.txt"), "utf8")).toBe("base\n");
    expect(fs.existsSync(path.join(tempDir, "untracked.txt"))).toBe(false);

    const branches = git(["branch", "--list", "shelve/protected-root-test-*"]);
    const branch = branches.split(/\s+/).find((item) => item.includes("shelve/protected-root-test-"));
    expect(branch).toBeTruthy();
    const safeBranch = branch!.replace(/[/: .]/g, "_").replace(/[^A-Za-z0-9._-]/g, "");
    const shelveRoot = path.join(tempDir, "worktrees", safeBranch);
    expect(fs.readFileSync(path.join(shelveRoot, "tracked.txt"), "utf8")).toBe("dirty\n");
    expect(fs.readFileSync(path.join(shelveRoot, "untracked.txt"), "utf8")).toBe("local\n");
  });
});
