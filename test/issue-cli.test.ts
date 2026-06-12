import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const CLI = path.join(process.cwd(), "bin", "mandible");

let server: http.Server | null = null;
let requestedPaths: string[] = [];
let requestBodies: Array<{ path: string; method: string; body: unknown }> = [];
let tempRoots: string[] = [];
let issueHeads: Record<string, unknown> = {};
let issueHeadsAt: Record<string, Record<string, unknown>> = {};
let issueCheckpoints: Record<string, unknown[]> = {};

const issueRevision = {
  id: "rev_issue_1",
  entity_type: "issue_body",
  entity_id: "issue-1",
  issue_id: "issue-1",
  project_id: "mandible",
  revision_no: 1,
  event_id: "evt_issue_1",
  actor_id: "agent",
  actor_type: "agent",
  source: "mandible",
  reason: "create",
  occurred_at: 1_700_000_000_000,
  observed_at: 1_700_000_000_000,
  base_revision_id: null,
  base_hash: null,
  new_hash: "a".repeat(64),
  snapshot_body: "Issue body",
  patch_format: null,
  patch_text: null,
  metadata_json: "{}",
  redacted_at: null,
  redacted_by_actor_id: null,
  redaction_reason: null,
};

const oldCommentRevision = {
  ...issueRevision,
  id: "rev_comment_1",
  entity_type: "comment_body",
  entity_id: "comment-2",
  revision_no: 1,
  reason: "create",
  new_hash: "b".repeat(64),
  snapshot_body: "Before",
};

const newCommentRevision = {
  ...oldCommentRevision,
  id: "rev_comment_2",
  revision_no: 2,
  reason: "edit",
  base_revision_id: oldCommentRevision.id,
  new_hash: "c".repeat(64),
  snapshot_body: "After",
};

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
  return new Promise((resolve) => {
    const child = spawn("bash", ["-c", script], {
      cwd,
      env: {
        ...process.env,
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

function startFileRpcResponder(
  spoolDir: string,
  handler: (request: Record<string, unknown>) => { status: number; body: unknown },
  afterResponse?: (request: Record<string, unknown>) => void,
): NodeJS.Timeout {
  fs.mkdirSync(spoolDir, { recursive: true });
  const timer = setInterval(() => {
    for (const file of fs.readdirSync(spoolDir)) {
      if (!file.endsWith(".request.json")) continue;
      const requestPath = path.join(spoolDir, file);
      const request = JSON.parse(fs.readFileSync(requestPath, "utf8")) as Record<string, unknown>;
      const id = typeof request.id === "string" ? request.id : file.replace(/\.request\.json$/, "");
      const response = handler(request);
      fs.writeFileSync(path.join(spoolDir, `${id}.response.json`), JSON.stringify({ id, ...response }), "utf8");
      fs.rmSync(requestPath, { force: true });
      afterResponse?.(request);
    }
  }, 10);
  return timer;
}

function git(args: string[], cwd: string): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed:\n${result.stderr}`);
  }
  return result.stdout.trim();
}

function makeGitRepoWithWorktree(): { repoRoot: string; worktreeRoot: string } {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-issue-cli-"));
  tempRoots.push(tempRoot);
  const repoRoot = path.join(tempRoot, "mandible");
  const worktreeRoot = path.join(tempRoot, "worktrees", "feature__demo");

  fs.mkdirSync(repoRoot, { recursive: true });
  git(["init", "-b", "main"], repoRoot);
  git(["config", "user.name", "Mandible Test"], repoRoot);
  git(["config", "user.email", "mandible-test@example.invalid"], repoRoot);
  git(["config", "commit.gpgsign", "false"], repoRoot);
  fs.writeFileSync(path.join(repoRoot, "tracked.txt"), "base\n", "utf8");
  git(["add", "tracked.txt"], repoRoot);
  git(["commit", "-m", "base"], repoRoot);
  git(["worktree", "add", "-b", "feature/demo", worktreeRoot], repoRoot);

  return {
    repoRoot: fs.realpathSync(repoRoot),
    worktreeRoot: fs.realpathSync(worktreeRoot),
  };
}

function listen(): Promise<number> {
  requestedPaths = [];
  requestBodies = [];
  issueHeads = {
    abc: {
      issue_id: "issue-1",
      short_id: "abc",
      digest: "digest-before",
      last_event_at: 1_700_000_000_000,
      last_event_kind: "issue.created",
    },
    def: {
      issue_id: "issue-2",
      short_id: "def",
      digest: "digest-current",
      last_event_at: 1_700_000_010_000,
      last_event_kind: "comment.created",
    },
  };
  issueHeadsAt = {
    abc: {
      "1700000020000": {
        issue_id: "issue-1",
        short_id: "abc",
        digest: "digest-before",
        last_event_at: 1_700_000_020_000,
        last_event_kind: "issue.checkpoint.created",
      },
    },
  };
  issueCheckpoints = {
    abc: [
      {
        id: "checkpoint-1",
        issue_id: "issue-1",
        kind: "delegation-manifest",
        payload: [
          { issue: "abc", digest: "digest-before" },
          { issue: "def", digest: "digest-stale" },
          { issue: "missing", digest: "digest-missing" },
        ],
        author: { id: null, type: "mandible_user", display: "Mandible" },
        source: "mandible",
        created_at: 1_700_000_020_000,
      },
    ],
  };
  return new Promise((resolve) => {
    server = http.createServer((req, res) => {
      requestedPaths.push(req.url ?? "");
      res.setHeader("Content-Type", "application/json");

      const readBody = async (): Promise<unknown> => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        const raw = Buffer.concat(chunks).toString("utf8");
        return raw ? JSON.parse(raw) : null;
      };

      if (req.url?.startsWith("/api/issues?")) {
        res.end(JSON.stringify([
          {
            repo_name: "mandible",
            issues: [{ id: "abc", status: "open", title: "Worktree issue" }],
          },
        ]));
        return;
      }
      const headMatch = req.url?.match(/^\/api\/ledger\/issues\/([^/?]+)\/head(?:\?(.*))?$/);
      if (headMatch) {
        const issueRef = decodeURIComponent(headMatch[1]);
        const params = new URLSearchParams(headMatch[2] ?? "");
        const at = params.get("at");
        const head = at ? (issueHeadsAt[issueRef]?.[at] ?? issueHeads[issueRef]) : issueHeads[issueRef];
        if (!head) {
          res.statusCode = 404;
          res.end(JSON.stringify({ error: "ledger issue not found" }));
          return;
        }
        res.end(JSON.stringify(head));
        return;
      }
      const checkpointMatch = req.url?.match(/^\/api\/ledger\/issues\/([^/?]+)\/checkpoints(?:\?.*)?$/);
      if (checkpointMatch) {
        const issueRef = decodeURIComponent(checkpointMatch[1]);
        const checkpoints = issueCheckpoints[issueRef] ?? [];
        const checkpoint = checkpoints[0];
        if (req.method === "POST") {
          void readBody().then((body) => {
            requestBodies.push({ path: req.url ?? "", method: req.method ?? "", body });
            res.end(JSON.stringify({
              id: "checkpoint-new",
              issue_id: "issue-1",
              kind: (body as { kind?: string } | null)?.kind ?? "unknown",
              payload: (body as { payload?: unknown } | null)?.payload ?? {},
              author: { id: null, type: "mandible_user", display: "Mandible" },
              source: "mandible",
              created_at: 1_700_000_030_000,
            }));
          });
          return;
        }
        if (!checkpoint) {
          res.statusCode = 404;
          res.end(JSON.stringify({ error: "checkpoint not found" }));
          return;
        }
        if (req.url.includes("latest=true")) {
          res.end(JSON.stringify(checkpoint));
        } else {
          res.end(JSON.stringify({ checkpoints }));
        }
        return;
      }
      if (req.url === "/api/ledger/issues/abc/body/revisions") {
        res.end(JSON.stringify({ revisions: [issueRevision] }));
        return;
      }
      if (req.method === "POST" && req.url === "/api/ledger/issues/abc/comments") {
        void readBody().then((body) => {
          requestBodies.push({ path: req.url ?? "", method: req.method ?? "", body });
          const reopen = (body as { reopen?: boolean } | null)?.reopen === true;
          res.end(JSON.stringify({
            id: "issue-1",
            display_id: "abc",
            title: "Issue title",
            status: reopen ? "open" : "closed",
            comments: [
              { id: "comment-3", ordinal: 3, body: (body as { message?: string } | null)?.message ?? "", created_at: 3 },
            ],
          }));
        });
        return;
      }
      if (req.url === "/api/ledger/issues/abc/umbrella-status") {
        res.end(JSON.stringify({
          umbrella: {
            id: "issue-1",
            short_id: "abc",
            title: "Umbrella",
            status: "open",
            current_revision_id: "rev_issue_1",
          },
          delegation_manifest: { id: "checkpoint-1", payload: [] },
          children: [{ id: "issue-2", short_id: "def", title: "Child", status: "open" }],
          auth_queue: { pending_requests: [], active_requests: [] },
        }));
        return;
      }
      if (req.url === "/api/ledger/issues/abc/parent-role") {
        if (req.method === "GET") {
          res.end(JSON.stringify({
            issue_id: "issue-1",
            holder: null,
            live_holder: null,
            stale_holders: [],
            holders: [],
          }));
          return;
        }
        void readBody().then((body) => {
          requestBodies.push({ path: req.url ?? "", method: req.method ?? "", body });
          if ((body as { override?: boolean } | null)?.override !== true) {
            res.statusCode = 409;
            res.end(JSON.stringify({
              error: "parent role already held by a live session; pass override to retake",
              live_holder: { session_id: "sess-live", mechanism: "codex" },
            }));
            return;
          }
          res.end(JSON.stringify({
            ok: true,
            checkpoint: { id: "checkpoint-parent", kind: "parent-role" },
            parent_role: { holder: { payload: { session_id: (body as { session_id?: string } | null)?.session_id } } },
          }));
        });
        return;
      }
      if (req.method === "PATCH" && req.url === "/api/ledger/issues/abc") {
        void readBody().then((body) => {
          requestBodies.push({ path: req.url ?? "", method: req.method ?? "", body });
          res.end(JSON.stringify({
            id: "issue-1",
            display_id: "abc",
            body: (body as { body?: string } | null)?.body ?? "",
          }));
        });
        return;
      }
      if (req.method === "POST" && req.url === "/api/ledger/issues/abc/worker-status") {
        res.end(JSON.stringify({ id: "issue-1", display_id: "abc", worker_status: "done" }));
        return;
      }
      if (req.method === "POST" && req.url === "/api/ledger/issues/abc/branches") {
        res.end(JSON.stringify({
          id: "issue-1",
          display_id: "abc",
          issue_branches: [{ branch: "feature/demo", role: "primary" }],
        }));
        return;
      }
      if (req.method === "POST" && req.url === "/api/ledger/relationships") {
        void readBody().then((body) => {
          requestBodies.push({ path: req.url ?? "", method: req.method ?? "", body });
          res.end(JSON.stringify({
            action_id: "edge_action",
            edges: [
              { id: "edge_1", source_issue_id: "issue-1", target_issue_id: "issue-2" },
              { id: "edge_2", source_issue_id: "issue-1", target_issue_id: "issue-3" },
            ],
          }));
        });
        return;
      }
      if (req.method === "POST" && req.url === "/api/ledger/relationships/unlink") {
        void readBody().then((body) => {
          requestBodies.push({ path: req.url ?? "", method: req.method ?? "", body });
          res.end(JSON.stringify({
            action_id: "edge_unlink",
            edges: [{ id: "edge_1", deleted_at: 1_700_000_000_000 }],
          }));
        });
        return;
      }
      if (req.url === "/api/ledger/issues/abc") {
        res.end(JSON.stringify({
          id: "issue-1",
          display_id: "abc",
          title: "Issue title",
          status: "open",
          worker_status: "in_progress",
          labels: ["feature", "mandible:status:in_progress"],
          issue_branches: [{ branch: "feature/demo", role: "primary" }],
          body: "Issue body",
          comments: [
            { id: "comment-1", ordinal: 1, body: "First comment" },
            { id: "comment-2", ordinal: 2, body: "Second comment" },
          ],
          checkpoints: [],
        }));
        return;
      }
      if (req.url === "/api/ledger/comments/comment-2/revisions") {
        res.end(JSON.stringify({ revisions: [oldCommentRevision, newCommentRevision] }));
        return;
      }
      if (req.url === "/api/ledger/body-revisions/rev_issue_1") {
        res.end(JSON.stringify({ revision: issueRevision }));
        return;
      }
      if (req.url === "/api/ledger/body-revisions/rev_comment_1") {
        res.end(JSON.stringify({ revision: oldCommentRevision }));
        return;
      }
      if (req.url === "/api/ledger/body-revisions/rev_comment_2") {
        res.end(JSON.stringify({ revision: newCommentRevision }));
        return;
      }

      res.statusCode = 404;
      res.end(JSON.stringify({ error: "not found" }));
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
  for (const root of tempRoots) {
    fs.rmSync(root, { recursive: true, force: true });
  }
  tempRoots = [];
});

describe("issue CLI body revisions", () => {
  it("documents the revision command surface", async () => {
    const result = await run(["issue", "--help"], 9);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("description show <issue-ref>");
    expect(result.stdout).toContain("description history <issue-ref>");
    expect(result.stdout).toContain("comment add <issue-ref>");
    expect(result.stdout).toContain("comment show <comment-ref>");
    expect(result.stdout).toContain("comment history <comment-ref>");
    expect(result.stdout).toContain("revision show <revision-id>");
    expect(result.stdout).toContain("revision diff <old-revision-id> <new-revision-id>");
    expect(result.stdout).toContain("status <id> <value>");
    expect(result.stdout).toContain("branch add <id> <branch>");
  });

  it("adds comments with the official comment add namespace", async () => {
    const port = await listen();
    const result = await run(["issue", "comment", "add", "abc", "-m", "New comment"], port);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("issue_status=closed");
    expect(requestedPaths).toContain("/api/ledger/issues/abc/comments");
  });

  it("adds comments with an atomic reopen flag", async () => {
    const port = await listen();
    const result = await run(["issue", "comment", "add", "abc", "-m", "Reopen comment", "--reopen"], port);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("issue_status=open");
    expect(requestBodies).toContainEqual({
      path: "/api/ledger/issues/abc/comments",
      method: "POST",
      body: { message: "Reopen comment", reopen: true },
    });
  });

  it("prints umbrella status through file RPC", async () => {
    const spoolDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-umbrella-file-rpc-"));
    tempRoots.push(spoolDir);
    const seen: Array<Record<string, unknown>> = [];
    const timer = startFileRpcResponder(spoolDir, (request) => {
      seen.push(request);
      return {
        status: 200,
        body: {
          umbrella: { id: "issue-1", short_id: "abc", title: "Umbrella", status: "open" },
          delegation_manifest: null,
          children: [],
          auth_queue: { pending_requests: [], active_requests: [] },
        },
      };
    });

    try {
      const result = await run(["umbrella", "status", "abc", "--json"], 0, process.cwd(), {
        MANDIBLE_BASE: `file://${spoolDir}`,
        MANDIBLE_FILE_RPC_TIMEOUT: "5",
      });

      expect(result.status).toBe(0);
      expect(seen[0]).toMatchObject({
        method: "GET",
        path: "/api/ledger/issues/abc/umbrella-status",
      });
      expect(JSON.parse(result.stdout).umbrella.short_id).toBe("abc");
    } finally {
      clearInterval(timer);
    }
  });

  it("surfaces live parent-role holders and requires override", async () => {
    const port = await listen();
    const blocked = await run([
      "issue",
      "parent-role",
      "assume",
      "abc",
      "--session",
      "sess-new",
    ], port);

    expect(blocked.status).toBe(3);
    expect(blocked.stderr).toContain("live parent-role holder exists: sess-live");

    const assumed = await run([
      "issue",
      "parent-role",
      "assume",
      "abc",
      "--session",
      "sess-new",
      "--override",
      "--json",
    ], port);
    expect(assumed.status).toBe(0);
    expect(JSON.parse(assumed.stdout).checkpoint.id).toBe("checkpoint-parent");
  });

  it("sets worker status through the issue status command", async () => {
    const port = await listen();
    const result = await run(["issue", "status", "abc", "done"], port);

    expect(result.status).toBe(0);
    expect(requestedPaths).toContain("/api/ledger/issues/abc/worker-status");
  });

  it("links branches through the issue branch namespace", async () => {
    const port = await listen();
    const result = await run(["issue", "branch", "add", "abc", "feature/demo"], port);

    expect(result.status).toBe(0);
    expect(requestedPaths).toContain("/api/ledger/issues/abc/branches");
  });

  it("links structured issue relationships through the issue link command", async () => {
    const port = await listen();
    const result = await run([
      "issue",
      "link",
      "abc",
      "def",
      "ghi",
      "--type",
      "references",
      "--note",
      "coordination context",
    ], port);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("linked 2 relationship(s) action_id=edge_action");
    expect(requestBodies).toContainEqual({
      path: "/api/ledger/relationships",
      method: "POST",
      body: {
        source_ref: "abc",
        target_refs: ["def", "ghi"],
        link_type: "references",
        note: "coordination context",
      },
    });
  });

  it("unlinks structured issue relationships through the issue unlink command", async () => {
    const port = await listen();
    const result = await run([
      "issue",
      "unlink",
      "abc",
      "def",
      "--type",
      "references",
    ], port);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("unlinked 1 relationship(s) action_id=edge_unlink");
    expect(requestBodies).toContainEqual({
      path: "/api/ledger/relationships/unlink",
      method: "POST",
      body: {
        source_ref: "abc",
        target_refs: ["def"],
        link_type: "references",
      },
    });
  });

  it("reports worker status and linked branches", async () => {
    const port = await listen();
    const result = await run(["issue", "report", "abc", "--json"], port);

    expect(result.status).toBe(0);
    const body = JSON.parse(result.stdout);
    expect(body.worker_status).toBe("in_progress");
    expect(body.issue_branches).toEqual([{ branch: "feature/demo", role: "primary" }]);
  });

  it("reports through file RPC when MANDIBLE_BASE is a file URL", async () => {
    const spoolDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-file-rpc-cli-"));
    tempRoots.push(spoolDir);
    const seen: Array<Record<string, unknown>> = [];
    const timer = startFileRpcResponder(spoolDir, (request) => {
      seen.push(request);
      expect(request).toMatchObject({
        method: "GET",
        path: "/api/ledger/issues/abc",
      });
      return {
        status: 200,
        body: {
          id: "issue-1",
          display_id: "abc",
          title: "Issue title",
          status: "open",
          worker_status: "in_progress",
          labels: ["feature", "mandible:status:in_progress"],
          issue_branches: [{ branch: "feature/demo", role: "primary" }],
          priority: "normal",
          kind: "feature",
          body: "Issue body",
          comments: [],
        },
      };
    });

    try {
      const result = await run(["issue", "report", "abc", "--json"], 0, process.cwd(), {
        MANDIBLE_BASE: `file://${spoolDir}`,
        MANDIBLE_FILE_RPC_TIMEOUT: "5",
      });

      expect(result.status).toBe(0);
      expect(seen).toHaveLength(1);
      expect(JSON.parse(result.stdout)).toMatchObject({
        display_id: "abc",
        worker_status: "in_progress",
        issue_branches: [{ branch: "feature/demo", role: "primary" }],
      });
    } finally {
      clearInterval(timer);
    }
  });

  it("ignores file RPC response cleanup failures after successful POSTs", async () => {
    const spoolDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-file-rpc-cli-"));
    tempRoots.push(spoolDir);
    const seen: Array<Record<string, unknown>> = [];
    const timer = startFileRpcResponder(
      spoolDir,
      (request) => {
        seen.push(request);
        expect(request).toMatchObject({
          method: "POST",
          path: "/api/ledger/issues/abc/comments",
          body: { message: "New comment" },
        });
        return {
          status: 200,
          body: { id: "comment-3" },
        };
      },
      () => {
        fs.chmodSync(spoolDir, 0o555);
      },
    );

    try {
      const result = await runBash(
        [
          "set -euo pipefail",
          `source ${JSON.stringify(path.join(process.cwd(), "cli", "api.sh"))}`,
          "tmp_response=$(mktemp)",
          "status=$(api_send_capture POST /api/ledger/issues/abc/comments " +
            "'{\"message\":\"New comment\"}' \"$tmp_response\")",
          "printf '%s\\n' \"$status\"",
          "cat \"$tmp_response\"",
        ].join("\n"),
        process.cwd(),
        {
          MANDIBLE_BASE: `file://${spoolDir}`,
          MANDIBLE_FILE_RPC_TIMEOUT: "5",
        },
      );

      expect(result.status).toBe(0);
      expect(seen).toHaveLength(1);
      expect(result.stdout).toBe("200\n{\"id\":\"comment-3\"}\n");
    } finally {
      fs.chmodSync(spoolDir, 0o755);
      clearInterval(timer);
    }
  });

  it("updates labels through file RPC with jq 1.6-safe JSON keys", async () => {
    const spoolDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-file-rpc-label-"));
    tempRoots.push(spoolDir);
    const seen: Array<Record<string, unknown>> = [];
    const timer = startFileRpcResponder(spoolDir, (request) => {
      seen.push(request);
      expect(request).toMatchObject({
        method: "POST",
        path: "/api/ledger/issues/abc/labels",
        body: { label: "deferred", present: false },
      });
      return {
        status: 200,
        body: { ok: true },
      };
    });

    try {
      const result = await run(["issue", "label", "rm", "abc", "deferred"], 0, process.cwd(), {
        MANDIBLE_BASE: `file://${spoolDir}`,
        MANDIBLE_FILE_RPC_TIMEOUT: "5",
      });

      expect(result.status).toBe(0);
      expect(seen).toHaveLength(1);
      expect(result.stderr).toContain("Removed label 'deferred' from abc");
    } finally {
      clearInterval(timer);
    }
  });

  it("prints issue heads as JSON", async () => {
    const port = await listen();
    const result = await run(["issue", "heads", "abc", "def", "--json"], port);

    expect(result.status).toBe(0);
    expect(requestedPaths).toContain("/api/ledger/issues/abc/head");
    expect(requestedPaths).toContain("/api/ledger/issues/def/head");
    expect(JSON.parse(result.stdout)).toEqual([
      issueHeads.abc,
      issueHeads.def,
    ]);
  });

  it("compares issue heads against a delegation manifest", async () => {
    const port = await listen();
    const manifest = path.join(os.tmpdir(), `mandible-manifest-${Date.now()}.json`);
    fs.writeFileSync(manifest, JSON.stringify([
      { issue: "abc", digest: "digest-before" },
      { issue: "def", digest: "digest-stale" },
      { issue: "missing", digest: "digest-missing" },
    ]), "utf8");
    tempRoots.push(manifest);

    const result = await run([
      "issue",
      "changed",
      "--since-manifest",
      manifest,
      "--json",
    ], port);

    expect(result.status).toBe(0);
    const body = JSON.parse(result.stdout);
    expect(body.unchanged.map((entry: { issue: string }) => entry.issue)).toEqual(["abc"]);
    expect(body.changed.map((entry: { issue: string }) => entry.issue)).toEqual(["def"]);
    expect(body.missing.map((entry: { issue: string }) => entry.issue)).toEqual(["missing"]);
  });

  it("compares issue heads against the latest checkpoint on an issue", async () => {
    const port = await listen();
    const result = await run([
      "issue",
      "changed",
      "--since-issue",
      "abc",
      "--kind",
      "delegation-manifest",
      "--json",
    ], port);

    expect(result.status).toBe(0);
    expect(requestedPaths).toContain("/api/ledger/issues/abc/checkpoints?latest=true&kind=delegation-manifest");
    const body = JSON.parse(result.stdout);
    expect(body.unchanged.map((entry: { issue: string }) => entry.issue)).toEqual(["abc"]);
    expect(body.changed.map((entry: { issue: string }) => entry.issue)).toEqual(["def"]);
    expect(body.missing.map((entry: { issue: string }) => entry.issue)).toEqual(["missing"]);
  });

  it("includes the umbrella issue head when comparing against a checkpoint", async () => {
    const port = await listen();
    issueHeads.abc = {
      issue_id: "issue-1",
      short_id: "abc",
      digest: "digest-after-umbrella-comment",
      last_event_at: 1_700_000_030_000,
      last_event_kind: "comment.created",
    };
    issueCheckpoints.abc = [
      {
        id: "checkpoint-child-only",
        issue_id: "issue-1",
        kind: "delegation-manifest",
        payload: [
          { issue: "def", digest: "digest-current" },
        ],
        author: { id: null, type: "mandible_user", display: "Mandible" },
        source: "mandible",
        created_at: 1_700_000_020_000,
      },
    ];

    const result = await run([
      "issue",
      "changed",
      "--since-issue",
      "abc",
      "--json",
    ], port);

    expect(result.status).toBe(0);
    expect(requestedPaths).toContain("/api/ledger/issues/abc/head?at=1700000020000");
    const body = JSON.parse(result.stdout);
    expect(body.changed.map((entry: { issue: string }) => entry.issue)).toEqual(["abc"]);
    expect(body.unchanged.map((entry: { issue: string }) => entry.issue)).toEqual(["def"]);
  });

  it("can pin a non-latest checkpoint as the changed-since baseline", async () => {
    const port = await listen();
    issueHeads.abc = {
      issue_id: "issue-1",
      short_id: "abc",
      digest: "digest-after-newer-parent",
      last_event_at: 1_700_000_040_000,
      last_event_kind: "comment.created",
    };
    issueHeadsAt.abc = {
      ...issueHeadsAt.abc,
      "1700000010000": {
        issue_id: "issue-1",
        short_id: "abc",
        digest: "digest-old-parent-baseline",
        last_event_at: 1_700_000_010_000,
        last_event_kind: "issue.checkpoint.created",
      },
      "1700000030000": {
        issue_id: "issue-1",
        short_id: "abc",
        digest: "digest-new-parent-baseline",
        last_event_at: 1_700_000_030_000,
        last_event_kind: "issue.checkpoint.created",
      },
    };
    issueCheckpoints.abc = [
      {
        id: "checkpoint-new",
        issue_id: "issue-1",
        kind: "delegation-manifest",
        payload: [{ issue: "def", digest: "digest-current" }],
        author: { id: null, type: "mandible_user", display: "Mandible" },
        source: "mandible",
        created_at: 1_700_000_030_000,
      },
      {
        id: "checkpoint-old",
        issue_id: "issue-1",
        kind: "delegation-manifest",
        payload: [{ issue: "def", digest: "digest-current" }],
        author: { id: null, type: "mandible_user", display: "Mandible" },
        source: "mandible",
        created_at: 1_700_000_010_000,
      },
    ];

    const result = await run([
      "issue",
      "changed",
      "--since-issue",
      "abc",
      "--checkpoint",
      "checkpoint-old",
      "--json",
    ], port);

    expect(result.status).toBe(0);
    expect(requestedPaths).toContain("/api/ledger/issues/abc/checkpoints?kind=delegation-manifest");
    expect(requestedPaths).toContain("/api/ledger/issues/abc/head?at=1700000010000");
    const body = JSON.parse(result.stdout);
    expect(body.changed.map((entry: { issue: string }) => entry.issue)).toEqual(["abc"]);
    expect(body.unchanged.map((entry: { issue: string }) => entry.issue)).toEqual(["def"]);
  });

  it("adds and shows issue checkpoints", async () => {
    const port = await listen();
    const payloadPath = path.join(os.tmpdir(), `mandible-checkpoint-${Date.now()}.json`);
    fs.writeFileSync(payloadPath, JSON.stringify([{ issue: "abc", digest: "digest-before" }]), "utf8");
    tempRoots.push(payloadPath);

    const added = await run([
      "issue",
      "checkpoint",
      "add",
      "abc",
      "--kind",
      "delegation-manifest",
      "--payload-file",
      payloadPath,
    ], port);
    expect(added.status).toBe(0);
    expect(added.stdout).toContain("checkpoint checkpoint-new delegation-manifest");
    expect(requestBodies.at(-1)).toMatchObject({
      path: "/api/ledger/issues/abc/checkpoints",
      method: "POST",
      body: {
        kind: "delegation-manifest",
        payload: [{ issue: "abc", digest: "digest-before" }],
      },
    });

    const shown = await run([
      "issue",
      "checkpoint",
      "show",
      "abc",
      "--kind",
      "delegation-manifest",
      "--json",
    ], port);
    expect(shown.status).toBe(0);
    expect(JSON.parse(shown.stdout)).toMatchObject({
      id: "checkpoint-1",
      kind: "delegation-manifest",
      payload: [
        { issue: "abc", digest: "digest-before" },
        { issue: "def", digest: "digest-stale" },
        { issue: "missing", digest: "digest-missing" },
      ],
    });
  });

  it("shows only the issue description", async () => {
    const port = await listen();
    const result = await run(["issue", "description", "show", "abc"], port);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("Issue body\n");
  });

  it("edits issue descriptions through the official description namespace", async () => {
    const port = await listen();
    const result = await run([
      "issue",
      "description",
      "edit",
      "abc",
      "-m",
      "Updated body",
      "--base-revision",
      "rev_issue_1",
      "--base-body-hash",
      "aaaaaaaa",
    ], port);

    expect(result.status).toBe(0);
    expect(requestedPaths).toContain("/api/ledger/issues/abc");
    expect(requestBodies).toContainEqual({
      path: "/api/ledger/issues/abc",
      method: "PATCH",
      body: {
        body: "Updated body",
        base_body_revision_id: "rev_issue_1",
        base_body_hash: "aaaaaaaa",
      },
    });
  });

  it("supports the top-level description edit alias", async () => {
    const port = await listen();
    const result = await run(["description", "edit", "abc", "-m", "Alias body"], port);

    expect(result.status).toBe(0);
    expect(requestBodies).toContainEqual({
      path: "/api/ledger/issues/abc",
      method: "PATCH",
      body: { body: "Alias body" },
    });
  });

  it("rejects description edits without a body", async () => {
    const port = await listen();
    const result = await run(["issue", "description", "edit", "abc"], port);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("description edit <issue-ref> -m <body>");
  });

  it("prints compact issue body history without snapshots by default", async () => {
    const port = await listen();
    const result = await run(["issue", "description", "history", "abc"], port);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("rev\tid\treason\tsource\toccurred\tactor\thash");
    expect(result.stdout).toContain("#1\trev_issue_1\tcreate\tmandible");
    expect(result.stdout).not.toContain("Issue body");
  });

  it("shows one comment by last-comment reference", async () => {
    const port = await listen();
    const result = await run(["issue", "comment", "show", "abc#last"], port);

    expect(result.status).toBe(0);
    expect(requestedPaths).toContain("/api/ledger/issues/abc");
    expect(requestedPaths).toContain("/api/ledger/comments/comment-2/revisions");
    expect(result.stdout).toBe("After\n");
  });

  it("resolves issue ordinal comment refs and prints snapshots when requested", async () => {
    const port = await listen();
    const result = await run(["issue", "comment", "history", "abc#2", "--with-body"], port);

    expect(result.status).toBe(0);
    expect(requestedPaths).toContain("/api/ledger/issues/abc");
    expect(requestedPaths).toContain("/api/ledger/comments/comment-2/revisions");
    expect(result.stdout).toContain("#2\trev_comment_2\tedit\tmandible");
    expect(result.stdout).toContain("----- body #2 -----");
    expect(result.stdout).toContain("After");
  });

  it("keeps hyphenated history commands as compatibility aliases", async () => {
    const port = await listen();
    const result = await run(["issue", "comment-history", "abc#2"], port);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("#2\trev_comment_2\tedit\tmandible");
  });

  it("shows a single globally addressed revision", async () => {
    const port = await listen();
    const result = await run(["issue", "revision", "show", "rev_comment_2"], port);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("revision: rev_comment_2");
    expect(result.stdout).toContain("entity: comment_body comment-2");
    expect(result.stdout).toContain("body:\nAfter");
  });

  it("diffs revisions from the same entity", async () => {
    const port = await listen();
    const result = await run(["issue", "revision", "diff", "rev_comment_1", "rev_comment_2"], port);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("--- rev_comment_1 #1 comment_body:comment-2");
    expect(result.stdout).toContain("+++ rev_comment_2 #2 comment_body:comment-2");
    expect(result.stdout).toContain("-Before");
    expect(result.stdout).toContain("+After");
  });

  it("rejects cross-entity diffs unless forced", async () => {
    const port = await listen();
    const result = await run(["issue", "revision", "diff", "rev_issue_1", "rev_comment_2"], port);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Refusing to diff revisions from different entities");
  });
});

describe("issue CLI list repo scoping", () => {
  it("passes the root checkout path as the repo filter", async () => {
    const { repoRoot } = makeGitRepoWithWorktree();
    const port = await listen();
    const result = await run(["issue", "list", "--status", "open"], port, repoRoot);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("abc\topen\tmandible\tWorktree issue");

    const listPath = requestedPaths.find((item) => {
      if (!item.startsWith("/api/issues?")) return false;
      return new URL(`http://127.0.0.1${item}`).searchParams.get("status") === "open";
    });
    expect(listPath).toBeTruthy();
    const url = new URL(`http://127.0.0.1${listPath}`);
    expect(url.searchParams.get("repo")).toBe(repoRoot);
    expect(url.searchParams.get("status")).toBe("open");
  });

  it("normalizes linked worktree cwd to the main checkout path", async () => {
    const { repoRoot, worktreeRoot } = makeGitRepoWithWorktree();
    const port = await listen();
    const result = await run(["issue", "list", "--status", "open"], port, worktreeRoot);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("abc\topen\tmandible\tWorktree issue");

    const listPath = requestedPaths.find((item) => {
      if (!item.startsWith("/api/issues?")) return false;
      return new URL(`http://127.0.0.1${item}`).searchParams.get("status") === "open";
    });
    expect(listPath).toBeTruthy();
    const url = new URL(`http://127.0.0.1${listPath}`);
    expect(url.searchParams.get("repo")).toBe(repoRoot);
    expect(url.searchParams.get("repo")).not.toBe(worktreeRoot);
    expect(url.searchParams.get("status")).toBe("open");
  });

  it("fails loudly when inferred cwd does not resolve to a registered repo", async () => {
    const spoolDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-issue-list-file-rpc-"));
    tempRoots.push(spoolDir);
    const timer = startFileRpcResponder(spoolDir, () => ({ status: 200, body: [] }));

    try {
      const result = await run(["issue", "list"], 0, os.tmpdir(), {
        MANDIBLE_BASE: `file://${spoolDir}`,
        MANDIBLE_FILE_RPC_TIMEOUT: "5",
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("cwd does not resolve to a registered repo; pass --repo <path|id>");
    } finally {
      clearInterval(timer);
    }
  });
});
