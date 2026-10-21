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

function listenForWithdrawal(): Promise<{
  port: number;
  close: () => Promise<void>;
  requests: Array<{ url: string; body: Record<string, unknown> }>;
}> {
  const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/api/instance") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(MAIN_CLI_INSTANCE_RESPONSE));
      return;
    }
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      requests.push({ url: req.url ?? "", body: JSON.parse(raw) });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ request_id: "abcdefgh-full", status: "withdrawn" }));
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server did not bind");
    resolve({
      port: address.port,
      requests,
      close: () => new Promise<void>((done, reject) => server.close((error) => error ? reject(error) : done())),
    });
  }));
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
    { args: ["--type", "commit", "--command", "echo review", "--target", "main"], error: "require --type merge" },
    { args: ["--type", "merge commit", "--command", "echo review"], error: "invalid --type" },
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
  it("sends explicit predecessor and action dispositions", async () => {
    const server = await listenForAuthRequest();
    try {
      const result = await runAsync([
        "auth", "request", "feature/demo", "--title", "Replacement",
        "--issue", "f15617a", "--supersedes", "old-request",
        "--expected-revision", "3", "--expected-custody-generation", "2",
        "--drop-superseded-action", "2:No longer closes the umbrella", "--no-watch",
      ], tempDir, {
        MANDIBLE_PORT: String(server.port),
        MANDIBLE_BASE: `http://127.0.0.1:${server.port}`,
      });
      expect(result.status).toBe(0);
      expect(server.bodies[0]).toMatchObject({
        supersedes_request_id: "old-request",
        expected_revision: 3,
        expected_custody_generation: 2,
        superseded_action_dispositions: [
          { ordinal: 2, reason: "No longer closes the umbrella" },
        ],
      });
    } finally {
      await server.close();
    }
  });

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

  it("stages one exact Briefing promotion in the request payload", async () => {
    const server = await listenForAuthRequest();
    try {
      const result = await runAsync([
        "auth",
        "request",
        "feature/demo",
        "--title",
        "Merge reviewed policy",
        "--issue",
        "policy123",
        "--promote-briefing",
        "group123",
        "base123",
        "proposal123",
        "--no-watch",
      ], tempDir, {
        MANDIBLE_PORT: String(server.port),
        MANDIBLE_BASE: `http://127.0.0.1:${server.port}`,
      });

      expect(result.status).toBe(0);
      expect(server.bodies).toHaveLength(1);
      expect(server.bodies[0].actions).toEqual([{
        kind: "briefing_group_promote",
        target_issue_ref: "policy123",
        payload: {
          group_ref: "group123",
          expected_base_bundle_ref: "base123",
          proposal_bundle_ref: "proposal123",
        },
      }]);
    } finally {
      await server.close();
    }
  });

  it("rejects Briefing promotion on a non-merge request before submission", () => {
    const result = run([
      "auth", "request", "feature/demo", "--title", "Not a merge", "--issue", "policy123",
      "--type", "config-change", "--promote-briefing", "group123", "base123", "proposal123",
      "--message", "m", "--verification", "v", "--no-watch",
    ]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("--promote-briefing requires --type merge");
  });

  it("keeps requester attribution separate from notification scoping", async () => {
    const server = await listenForAuthRequest();
    try {
      const result = await runAsync([
        "auth",
        "request",
        "feature/demo",
        "--title",
        "Merge feature/demo",
        "--issue",
        "requester123",
        "--no-watch",
      ], tempDir, {
        MANDIBLE_PORT: String(server.port),
        MANDIBLE_BASE: `http://127.0.0.1:${server.port}`,
        CODEX_THREAD_ID: "codex-requester-session",
        MANDIBLE_SESSION_ID: "mandible-notification-session",
      });

      expect(result.status).toBe(0);
      expect(server.bodies).toHaveLength(1);
      expect(server.bodies[0]).toMatchObject({
        session_id: "codex-requester-session",
        target_session_id: "mandible-notification-session",
      });
    } finally {
      await server.close();
    }
  });
});

describe("auth requester withdrawal CLI", () => {
  it("posts the required reason and concurrency guards without session authority", async () => {
    const server = await listenForWithdrawal();
    try {
      const result = await runAsync([
        "auth", "withdraw", "request123", "--reason", "Branch was abandoned",
        "--expected-revision", "4", "--expected-custody-generation", "2", "--json",
      ], tempDir, {
        MANDIBLE_PORT: String(server.port),
        MANDIBLE_BASE: `http://127.0.0.1:${server.port}`,
        CODEX_THREAD_ID: "requester-thread",
      });
      expect(result.status).toBe(0);
      expect(server.requests).toEqual([{
        url: "/api/auth/request/request123/withdraw",
        body: { reason: "Branch was abandoned", expected_revision: 4, expected_custody_generation: 2 },
      }]);
    } finally {
      await server.close();
    }
  });
});

describe("candidate acceptance CLI", () => {
  // Issue 7d83fe5 — the request id is the command's positional argument.
  it("binds the request id for run and show", async () => {
    const seen: string[] = [];
    const acceptance = { state: "running", reason: null, started_at: 1, finished_at: null };
    const server = http.createServer((req, res) => {
      res.writeHead(req.url === "/api/auth/request/request123/candidate-acceptance" || req.url === "/api/instance" ? 200 : 404, { "Content-Type": "application/json" });
      if (req.url === "/api/instance") { res.end(JSON.stringify(MAIN_CLI_INSTANCE_RESPONSE)); return; }
      seen.push(`${req.method} ${req.url}`);
      req.resume();
      req.on("end", () => res.end(JSON.stringify({ request_id: "request123-full", acceptance })));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const env = { MANDIBLE_PORT: String(port), MANDIBLE_BASE: `http://127.0.0.1:${port}` };
    try {
      const run = await runAsync(["auth", "acceptance", "run", "request123"], tempDir, env);
      expect(run).toMatchObject({ status: 0 });
      expect(run.stdout).toContain("Candidate acceptance for request1: running");
      const show = await runAsync(["auth", "acceptance", "show", "request123", "--json"], tempDir, env);
      expect(show.status).toBe(0);
      expect(JSON.parse(show.stdout)).toMatchObject({ acceptance: { state: "running" } });
      expect(seen).toEqual([
        "POST /api/auth/request/request123/candidate-acceptance",
        "GET /api/auth/request/request123/candidate-acceptance",
      ]);
      expect((await runAsync(["auth", "acceptance", "show"], tempDir, env)).status).toBe(2);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

// Issue 8ae6b5f — requests carry no spec. The removed flags fail as unknown
// options before anything is submitted, on merge and non-merge paths alike.
describe("auth request without a spec", () => {
  it.each([
    { label: "merge", args: ["feature/demo", "--spec", "Intent"] },
    { label: "merge file", args: ["feature/demo", "--spec-file", "-"] },
    { label: "command", args: ["--type", "config-change", "--command", "true", "--cwd", ".", "--repo", "example", "--spec", "Intent"] },
  ])("refuses --spec on a $label request before submission", async ({ args }) => {
    const server = await listenForAuthRequest();
    try {
      const result = await runAsync([
        "auth", "request", ...args, "--title", "Spec refused", "--issue", "8ae6b5f",
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

  it("still refuses clearly when an older daemon omits the stored details", async () => {
    const server = await listenForAuthRequest({
      status: 409,
      body: { error: "Duplicate auth request", request_id: "legacy-409-id", status: "pending" },
    });
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

      expect(result.status).toBe(3);
      const output = `${result.stdout}${result.stderr}`;
      expect(output).toContain("REFUSED");
      expect(output).toContain("legacy-409-id");
      // Without stored details, say so rather than substituting the caller's.
      expect(output).toContain("did not report the stored request's details");
      expect(output).not.toContain(CALLER_TITLE);
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
