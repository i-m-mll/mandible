import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MERGE_CHANGE_MESSAGE_FLAGS } from "./helpers/auth-delivery-fixtures.js";
import { MAIN_CLI_INSTANCE_RESPONSE } from "./helpers/cli-instance-response.js";

const CLI = path.join(process.cwd(), "bin", "mandible");

let tempDir = "";
let homeDir = "";

/**
 * Issue 4720024 — every merge request needs a canonical change message and
 * verification text. Supply them for merge-request cases that do not exercise
 * the message themselves.
 */
function withChangeMessage(args: string[]): string[] {
  const typeIndex = args.indexOf("--type");
  if (args[0] !== "auth" || args[1] !== "request" || (typeIndex >= 0 && args[typeIndex + 1] !== "merge")) return args;
  if (["--message", "--message-file", "--verification"].some((flag) => args.includes(flag))) return args;
  return [...args, ...MERGE_CHANGE_MESSAGE_FLAGS];
}

function run(
  args: string[],
  cwd = tempDir,
  extraEnv: Record<string, string> = {},
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(CLI, withChangeMessage(args), {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: homeDir,
      MANDIBLE_PORT: "9",
      // Default to the dead test port; per-call extraEnv overrides still win.
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
  stdin = "",
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(CLI, withChangeMessage(args), {
      cwd,
      env: {
        ...process.env,
        HOME: homeDir,
        MANDIBLE_PORT: "9",
        // Default to the dead test port; per-call extraEnv overrides still win.
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
    child.stdin.end(stdin);
    child.on("close", (status) => {
      resolve({ status, stdout, stderr });
    });
  });
}

/**
 * `submitResponse` overrides the POST /api/auth/request reply so a test can
 * drive a non-201 path (Issue 608d1db — the duplicate refusal). Defaults to the
 * 201 success reply every pre-existing caller expects.
 */
function listenForAuthRequest(
  submitResponse: { status: number; body: Record<string, unknown> } = {
    status: 201,
    body: { request_id: "req_cli_close" },
  },
): Promise<{
  port: number;
  close: () => Promise<void>;
  bodies: Record<string, unknown>[];
  checkBodies: Record<string, unknown>[];
}> {
  const bodies: Record<string, unknown>[] = [];
  const checkBodies: Record<string, unknown>[] = [];
  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/api/instance") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(MAIN_CLI_INSTANCE_RESPONSE));
      return;
    }
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
        res.writeHead(submitResponse.status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(submitResponse.body));
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

describe("action-specific request preparation", () => {
  it("queues exact non-merge bytes outside Git without preparing or executing a merge", async () => {
    const server = await listenForAuthRequest();
    const executionDir = path.join(homeDir, "operation");
    fs.mkdirSync(executionDir);
    const command = "printf '%s\\n' 'reviewed $value `literal`' > should-not-exist";
    try {
      const result = await runAsync([
        "auth", "request", "--type", "config-change", "--command", command,
        "--cwd", executionDir, "--repo", "example", "--title", "Apply reviewed settings",
        "--issue", "settings123", "--no-watch",
      ], executionDir, { MANDIBLE_BASE: `http://127.0.0.1:${server.port}` });
      expect(result.status, result.stderr).toBe(0);
      expect(server.checkBodies).toEqual([]);
      expect(server.bodies).toHaveLength(1);
      expect(server.bodies[0]).toMatchObject({
        type: "config-change", command, repo: "example", base_branch: null,
        head_branch: null, target_repo_root: null, protected_root_dirty_action: null,
        canonical_message: false, issue_references: ["settings123"], actions: [],
      });
      expect(fs.realpathSync(String(server.bodies[0].cwd))).toBe(fs.realpathSync(executionDir));
      expect(fs.existsSync(path.join(executionDir, "should-not-exist"))).toBe(false);
    } finally {
      await server.close();
    }
  });

  it.each([
    { args: ["--type", "data-delete"], error: "requires an explicit non-empty --command" },
    { args: ["--type", "merge", "feature/demo", "--command", "echo override"], error: "--command cannot override a merge" },
  ])("refuses ambiguous operation inputs: $error", async ({ args }) => {
    const server = await listenForAuthRequest();
    try {
      const result = await runAsync(["auth", "request", ...args, "--title", "Review", "--issue", "example", "--no-watch"], tempDir, {
        MANDIBLE_BASE: `http://127.0.0.1:${server.port}`,
      });
      expect(result.status).toBe(2);
      expect(server.checkBodies).toEqual([]);
      expect(server.bodies).toEqual([]);
    } finally {
      await server.close();
    }
  });

  it("never executes a command when queue submission is unavailable", () => {
    const result = run([
      "auth", "request", "--type", "data-delete", "--command", "touch should-not-exist",
      "--cwd", homeDir, "--repo", "example", "--title", "Review", "--issue", "example", "--no-watch",
    ]);
    expect(result.status).toBe(1);
    expect(result.stdout).not.toContain("request submitted");
    expect(fs.existsSync(path.join(homeDir, "should-not-exist"))).toBe(false);
  });
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
});

// Issue 8ae6b5f — requests carry no spec. The removed flag fails as an unknown
// option before anything is submitted.
describe("auth request without a spec", () => {
  it("refuses --spec before submission", async () => {
    const server = await listenForAuthRequest();
    try {
      const result = await runAsync([
        "auth", "request", "feature/demo", "--spec", "Intent", "--title", "Spec refused", "--issue", "8ae6b5f",
        "--message", "Refuse specs\n\nWhy:\nThe change message carries intent.", "--verification", "n/a",
        "--no-watch",
      ], tempDir, { MANDIBLE_BASE: `http://127.0.0.1:${server.port}` });
      expect(result.status).toBe(2);
      expect(result.stderr).toMatch(/--spec/);
      expect(server.bodies).toEqual([]);
    } finally {
      await server.close();
    }
  });
});

// Issue 608d1db — a duplicate 409 is a refusal, not an outcome. It used to
// echo the caller's own --title and branch under "Auth request (existing)" and
// exit 0, so a submitter read its own arguments back beside a foreign
// request's id and concluded the work was queued when nothing was.
describe("auth request duplicate refusal", () => {
  const CALLER_TITLE = "Caller supplied title";
  const duplicate409 = {
    status: 409,
    body: {
      error:
        "Duplicate auth request — this repo already has a pending or approved " +
        "request for this branch. Nothing was queued.",
      request_id: "1e412da6-168e-424d-9e93-5e2f1c140c44",
      status: "pending",
      existing: {
        id: "1e412da6-168e-424d-9e93-5e2f1c140c44",
        status: "pending",
        title: "Stored request from another repo",
        repo: "other-repo",
        head_branch: "feature/demo",
        base_branch: "main",
        created_at: 1786845649435,
      },
    },
  };

  it("exits non-zero and reports the existing request's own identity", async () => {
    const server = await listenForAuthRequest(duplicate409);
    try {
      const result = await runAsync([
        "auth", "request", "feature/demo",
        "--title", CALLER_TITLE,
        "--issue", "608d1db",
        "--no-watch",
      ], tempDir, {
        MANDIBLE_PORT: String(server.port),
        MANDIBLE_BASE: `http://127.0.0.1:${server.port}`,
      });

      // A refusal must never present as success.
      expect(result.status).not.toBe(0);
      expect(result.status).toBe(3);

      const output = `${result.stdout}${result.stderr}`;
      expect(output).toContain("REFUSED");
      expect(output).toContain("Nothing was queued");
      // The stored request's own identity, so the repo mismatch is visible.
      expect(output).toContain("1e412da6");
      expect(output).not.toContain("1e412da6-168e-424d-9e93-5e2f1c140c44");
      expect(output).toContain("Stored request from another repo");
      expect(output).toContain("other-repo");
      // Never the caller's own arguments echoed back as if they were stored.
      expect(output).not.toContain(CALLER_TITLE);
      // Nothing on stdout that a caller could parse as a submitted request.
      expect(result.stdout).toBe("");
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
    fs.writeFileSync(path.join(tempDir, "staged.txt"), "staged\n", "utf8");
    git(["add", "staged.txt"]);
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
    expect(git(["status", "--porcelain=v1", "--", "staged.txt"], shelveRoot)).toBe("A  staged.txt");
    expect(git(["stash", "list"])).toBe("");
    expect(git(["for-each-ref", "refs/mandible/"])).toBe("");
  });

  it("preserves dirty protected-root state as a stash commit outside the shared stash", () => {
    fs.writeFileSync(path.join(tempDir, "tracked.txt"), "dirty\n", "utf8");
    fs.writeFileSync(path.join(tempDir, "staged.txt"), "staged\n", "utf8");
    git(["add", "staged.txt"]);
    fs.writeFileSync(path.join(tempDir, "untracked.txt"), "local\n", "utf8");

    const result = run([
      "auth",
      "request",
      "feature/demo",
      "--title",
      "Merge feature/demo",
      "--issue",
      "029661a",
      "--dirty-policy",
      "stash",
      "--no-watch",
    ]);

    expect(result.stderr).toContain("Protected-root changes were preserved as stash commit");
    expect(git(["status", "--porcelain=v1"])).toBe("");
    expect(git(["stash", "list"])).toBe("");
    const snapshot = git(["for-each-ref", "--format=%(objectname)", "refs/mandible/protected-root-dirty/"]);
    expect(result.stderr).toContain(`stash apply --index ${snapshot}`);

    git(["stash", "apply", "--index", snapshot]);
    expect(fs.readFileSync(path.join(tempDir, "tracked.txt"), "utf8")).toBe("dirty\n");
    expect(fs.readFileSync(path.join(tempDir, "untracked.txt"), "utf8")).toBe("local\n");
    expect(git(["status", "--porcelain=v1", "--", "staged.txt"])).toBe("A  staged.txt");
  });
});
