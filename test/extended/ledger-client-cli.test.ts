import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

import { startFileRpcResponder } from "../helpers/file-rpc-responder.js";

const CLI = path.join(process.cwd(), "bin", "mandible");

let server: http.Server | null = null;
let tempRoots: string[] = [];

function run(
  args: string[],
  port: number,
  cwd = process.cwd(),
  extraEnv: Record<string, string> = {},
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(CLI, args, {
      cwd,
      env: {
        ...process.env,
        MANDIBLE_PORT: String(port),
        // Pin base to the test stub so a leaked dev-shell MANDIBLE_BASE
        // (e.g. the live daemon at :19420) can never route this subprocess.
        // Placed before extraEnv so explicit per-call overrides (file:// RPC)
        // still win.
        MANDIBLE_BASE: `http://127.0.0.1:${port}`,
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

function runBash(
  script: string,
  cwd = process.cwd(),
  extraEnv: Record<string, string> = {},
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  // Pin a dead loopback endpoint. Clearing MANDIBLE_BASE alone falls back to
  // the production canonical origin, even when MANDIBLE_PORT is a test port.
  const { MANDIBLE_BASE: _leakedBase, ...baseEnv } = process.env;
  return new Promise((resolve) => {
    const child = spawn("bash", ["-c", script], {
      cwd,
      env: {
        ...baseEnv,
        MANDIBLE_BASE: `http://127.0.0.1:${extraEnv.MANDIBLE_PORT || "9"}`,
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

function git(args: string[], cwd: string): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed:\n${result.stderr}`);
  }
}

function makeGitRepo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-ledger-client-git-"));
  tempRoots.push(root);
  git(["init", "-b", "main"], root);
  git(["config", "user.name", "Mandible Test"], root);
  git(["config", "user.email", "mandible-test@example.invalid"], root);
  fs.writeFileSync(path.join(root, "tracked.txt"), "base\n", "utf8");
  git(["add", "tracked.txt"], root);
  git(["commit", "-m", "base"], root);
  return root;
}

function listen(): Promise<{ port: number; requests: Array<Record<string, unknown>> }> {
  const requests: Array<Record<string, unknown>> = [];
  server = http.createServer((req, res) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) as unknown : null;
      requests.push({
        method: req.method,
        url: req.url,
        body,
        ambientProvider: req.headers["x-mandible-ambient-provider"],
        ambientSession: req.headers["x-mandible-ambient-provider-session-id"],
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      if (req.method === "GET" && req.url === "/api/instance") {
        res.end(JSON.stringify({
          instance: {
            role: "main",
            operational_mutations: "allow",
            operational_mutations_overridden: false,
            db_path: "/tmp/mandible-test.db",
            db_path_source: "test",
          },
        }));
        return;
      }
      if (req.method === "GET" && req.url?.startsWith("/api/ledger/issues/abc123")) {
        res.end(JSON.stringify({ id: "abc123-full", display_id: "abc123", title: "Ledger client issue" }));
        return;
      }
      if (req.method === "GET" && req.url?.startsWith("/api/work-units")) {
        res.end(JSON.stringify({ work_units: [{ id: "wu-1", state: "committed" }] }));
        return;
      }
      if (req.method === "POST" && req.url === "/api/work-units/claim") {
        res.end(JSON.stringify({ id: "wu-claim", state: "open" }));
        return;
      }
      if (req.method === "POST" && req.url === "/api/work-units/activate") {
        res.end(JSON.stringify({ id: "wu-claim", state: "committed" }));
        return;
      }
      if (req.method === "PATCH" && req.url === "/api/work-units/wu-1") {
        res.end(JSON.stringify({ id: "wu-1", state: "resolved" }));
        return;
      }
      if (req.method === "POST" && req.url === "/api/work-units/release") {
        res.end(JSON.stringify({ ok: true, released: 1 }));
        return;
      }
      if (req.method === "POST" && req.url === "/api/sessions/session-1/issues") {
        res.end(JSON.stringify({ ok: true, session_id: "session-1" }));
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ error: "not_found" }));
    });
  });
  return new Promise((resolve) => {
    server!.listen(0, "127.0.0.1", () => {
      const address = server!.address();
      if (!address || typeof address === "string") {
        throw new Error("test server did not bind a TCP port");
      }
      resolve({ port: address.port, requests });
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

describe("ledger mechanism CLI client", () => {
  it("routes work-unit, issue-title, and session-link commands over HTTP", async () => {
    const { port, requests } = await listen();

    expect((await run([
      "work-unit",
      "claim",
      "--issue",
      "abc123",
      "--repo",
      "mandible",
      "--branch",
      "feature/abc123",
      "--parent-branch",
      "main",
      "--kind",
      "solo",
      "--session",
      "session-1",
    ], port)).status).toBe(0);
    expect((await run([
      "work-unit",
      "activate",
      "--issue",
      "abc123",
      "--repo",
      "mandible",
      "--branch",
      "feature/abc123",
      "--worker",
    ], port, process.cwd(), { CODEX_THREAD_ID: "thread-worker-cli" })).status).toBe(0);
    expect((await run([
      "work-unit",
      "find",
      "--repo",
      "mandible",
      "--branch",
      "feature/abc123",
      "--state",
      "committed",
    ], port)).stdout).toContain("wu-1");
    expect((await run(["work-unit", "resolve", "--id", "wu-1", "--auth-request-id", "auth-1"], port)).status).toBe(0);
    expect((await run(["work-unit", "release", "--issue", "abc123", "--repo", "mandible"], port, process.cwd(), {
      CODEX_THREAD_ID: "thread-release-cli",
    })).status).toBe(0);
    expect((await run(["issue", "title", "abc123"], port)).stdout).toBe("Ledger client issue\n");
    expect((await run([
      "session",
      "link-issue",
      "session-1",
      "--issue",
      "abc123",
      "--repo",
      "mandible",
      "--repo-name",
      "Mandible",
    ], port)).status).toBe(0);

    expect(requests.map((request) => [request.method, request.url])).toEqual([
      ["GET", "/api/instance"],
      ["POST", "/api/work-units/claim"],
      ["GET", "/api/instance"],
      ["POST", "/api/work-units/activate"],
      ["GET", "/api/work-units?repo_id=mandible&branch=feature%2Fabc123&state=committed"],
      ["GET", "/api/instance"],
      ["PATCH", "/api/work-units/wu-1"],
      ["GET", "/api/instance"],
      ["POST", "/api/work-units/release"],
      ["GET", "/api/ledger/issues/abc123"],
      ["GET", "/api/instance"],
      ["POST", "/api/sessions/session-1/issues"],
    ]);
    expect(requests.some((request) => request.url === "/api/health")).toBe(false);

    const actualMutations = requests
      .filter((request) => request.method !== "GET" || request.url === "/api/sessions/session-1/issues")
      .map((request) => [request.method, request.url]);
    expect(actualMutations).toEqual([
      ["POST", "/api/work-units/claim"],
      ["POST", "/api/work-units/activate"],
      ["PATCH", "/api/work-units/wu-1"],
      ["POST", "/api/work-units/release"],
      ["POST", "/api/sessions/session-1/issues"],
    ]);

    const claimRequest = requests.find((request) => request.url === "/api/work-units/claim");
    expect(claimRequest?.body).toMatchObject({
      issue_id: "abc123",
      repo_id: "mandible",
      branch: "feature/abc123",
      parent_branch: "main",
      kind: "solo",
      assigned_session_id: "session-1",
    });
    expect(requests.find((request) => request.url === "/api/work-units/wu-1")?.body).toEqual({
      state: "resolved",
      auth_request_id: "auth-1",
    });
    expect(requests.find((request) => request.url === "/api/work-units/activate")).toMatchObject({
      ambientProvider: "codex",
      ambientSession: "thread-worker-cli",
      body: {
        issue_id: "abc123",
        repo_id: "mandible",
        branch: "feature/abc123",
        worker_owner: true,
      },
    });
    expect(requests.find((request) => request.url === "/api/work-units/release")).toMatchObject({
      ambientProvider: "codex",
      ambientSession: "thread-release-cli",
      body: { issue_id: "abc123", repo_id: "mandible" },
    });
    expect(requests.find((request) => request.url === "/api/sessions/session-1/issues")?.body).toEqual({
      issue_id: "abc123",
      repo_id: "mandible",
      repo_name: "Mandible",
    });
  });

  it("routes worker activation, find, and release through file RPC with ambient identity", async () => {
    const spoolDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-ledger-client-rpc-"));
    tempRoots.push(spoolDir);
    const seen: Array<Record<string, unknown>> = [];
    const responder = startFileRpcResponder(spoolDir, (request) => {
      seen.push(request);
      if (request.method === "GET") {
        return { status: 200, body: { work_units: [{ id: "wu-rpc", state: "open" }] } };
      }
      return request.path === "/api/work-units/activate"
        ? { status: 200, body: { id: "wu-rpc", state: "committed" } }
        : { status: 200, body: { ok: true, released: 1 } };
    });

    try {
      const activate = await run([
        "work-unit", "activate", "--issue", "abc123", "--repo", "mandible", "--worker",
      ], 9, process.cwd(), {
        CODEX_THREAD_ID: "thread-file-worker",
        MANDIBLE_BASE: `file://${spoolDir}`,
        MANDIBLE_FILE_RPC_TIMEOUT: "5",
        MANDIBLE_TEST_ONLY_ALLOW_NON_MAIN_OPERATIONAL_MUTATIONS: "1",
      });
      const find = await run([
        "work-unit",
        "find",
        "--repo",
        "mandible",
        "--issue",
        "abc123",
        "--state",
        "open",
      ], 9, process.cwd(), {
        MANDIBLE_BASE: `file://${spoolDir}`,
        MANDIBLE_FILE_RPC_TIMEOUT: "5",
      });
      const release = await run(["work-unit", "release", "--issue", "abc123", "--repo", "mandible"], 9, process.cwd(), {
        CODEX_THREAD_ID: "thread-file-release",
        MANDIBLE_BASE: `file://${spoolDir}`,
        MANDIBLE_FILE_RPC_TIMEOUT: "5",
        MANDIBLE_TEST_ONLY_ALLOW_NON_MAIN_OPERATIONAL_MUTATIONS: "1",
      });

      expect(activate.status).toBe(0);
      expect(find.status).toBe(0);
      expect(find.stdout).toContain("wu-rpc");
      expect(release.status).toBe(0);
      expect(seen).toHaveLength(3);
      expect(seen[0]).toMatchObject({
        method: "POST",
        path: "/api/work-units/activate",
        body: { issue_id: "abc123", repo_id: "mandible", worker_owner: true },
        ambient_identity: { provider: "codex", provider_session_id: "thread-file-worker" },
      });
      expect(seen[1]).toMatchObject({
        method: "GET",
        path: "/api/work-units?repo_id=mandible&issue_id=abc123&state=open",
      });
      expect(seen[2]).toMatchObject({
        method: "POST",
        path: "/api/work-units/release",
        body: { issue_id: "abc123", repo_id: "mandible" },
        ambient_identity: { provider: "codex", provider_session_id: "thread-file-release" },
      });
    } finally {
      responder.stop();
    }
  });

  it("supports sourceable issue-file helpers", async () => {
    const repo = makeGitRepo();
    const result = await run(["issue-file", "write", "abc123", "def456"], 9, repo);
    expect(result.status).toBe(0);

    fs.appendFileSync(path.join(repo, ".issue"), "\n# comment\n\n", "utf8");
    expect((await run(["issue-file", "read"], 9, repo)).stdout).toBe("abc123\ndef456\n");
    const sourced = await runBash(
      [
        `source ${JSON.stringify(path.join(process.cwd(), "cli", "ledger-client.sh"))}`,
        "mandible_issue_file_read",
      ].join("\n"),
      repo,
    );
    expect(sourced.status).toBe(0);
    expect(sourced.stdout).toBe("abc123\ndef456\n");
  });

  it("makes daemon-unreachable operations non-fatal when graceful is requested", async () => {
    const result = await runBash(
      [
        `source ${JSON.stringify(path.join(process.cwd(), "cli", "ledger-client.sh"))}`,
        "mandible_work_unit_claim --issue abc123 --repo mandible --branch feature/abc123 --graceful",
        "printf done",
      ].join("\n"),
      process.cwd(),
      { MANDIBLE_PORT: "9", MANDIBLE_BASE: "http://127.0.0.1:9" },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("done");
    expect(result.stderr).toContain("Mandible ledger request skipped");
  });
});
