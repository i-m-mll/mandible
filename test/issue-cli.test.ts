import { MAIN_CLI_INSTANCE_RESPONSE } from "./helpers/cli-instance-response.js";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

import { startFileRpcResponder } from "./helpers/file-rpc-responder.js";

const CLI = path.join(process.cwd(), "bin", "mandible");

let server: http.Server | null = null;
let requestedPaths: string[] = [];
let requestBodies: Array<{ path: string; method: string; body: unknown }> = [];
let tempRoots: string[] = [];
let issueHeads: Record<string, unknown> = {};
let issueHeadsAt: Record<string, Record<string, unknown>> = {};
let issueHeadsExcludingCheckpoint: Record<string, Record<string, unknown>> = {};
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

const workNotesRevision = {
  ...issueRevision,
  id: "rev_notes_1",
  entity_type: "issue_work_notes",
  entity_id: "issue-1",
  revision_no: 1,
  reason: "edit",
  new_hash: "d".repeat(64),
  snapshot_body: "Current working notes",
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
        // Default to the test stub; per-call extraEnv overrides (file:// RPC)
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
      subtree_digest: "subtree-abc-before",
      last_event_at: 1_700_000_000_000,
      last_event_kind: "issue.created",
      subtree_last_event_at: 1_700_000_000_000,
      subtree_last_event_kind: "issue.created",
    },
    def: {
      issue_id: "issue-2",
      short_id: "def",
      digest: "digest-current",
      subtree_digest: "subtree-def-current",
      last_event_at: 1_700_000_010_000,
      last_event_kind: "comment.created",
      subtree_last_event_at: 1_700_000_010_000,
      subtree_last_event_kind: "comment.created",
    },
  };
  issueHeadsAt = {
    abc: {
      "1700000020000": {
        issue_id: "issue-1",
        short_id: "abc",
        digest: "digest-before",
        subtree_digest: "subtree-abc-before",
        last_event_at: 1_700_000_020_000,
        last_event_kind: "issue.checkpoint.created",
        subtree_last_event_at: 1_700_000_020_000,
        subtree_last_event_kind: "issue.checkpoint.created",
      },
    },
  };
  issueHeadsExcludingCheckpoint = {};
  issueCheckpoints = {
    abc: [
      {
        id: "checkpoint-1",
        issue_id: "issue-1",
        kind: "delegation-manifest",
        payload: [
          { issue: "abc", digest: "digest-before", subtree_digest: "subtree-abc-before" },
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

      if (req.method === "GET" && req.url === "/api/instance") {
        res.end(JSON.stringify(MAIN_CLI_INSTANCE_RESPONSE));
        return;
      }
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
        const excludeCheckpoint = params.get("exclude_checkpoint");
        const head = at
          ? (issueHeadsAt[issueRef]?.[at] ?? issueHeads[issueRef])
          : excludeCheckpoint
            ? (issueHeadsExcludingCheckpoint[issueRef]?.[excludeCheckpoint] ?? issueHeads[issueRef])
            : issueHeads[issueRef];
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
      if (req.url === "/api/ledger/issues/abc/work-notes/history") {
        res.end(JSON.stringify({ revisions: [workNotesRevision] }));
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
      if (req.method === "POST" && req.url === "/api/issues/resolutions") {
        void readBody().then((body) => {
          requestBodies.push({ path: req.url ?? "", method: req.method ?? "", body });
          res.end(JSON.stringify({ ok: true }));
        });
        return;
      }
      if (
        req.url === "/api/ledger/issues/abc/umbrella-status" ||
        req.url === "/api/ledger/issues/abc/umbrella-status?deep=true"
      ) {
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
      if (req.method === "POST" && req.url === "/api/ledger/issues/abc/umbrella-manifest-refresh") {
        void readBody().then((body) => {
          requestBodies.push({ path: req.url ?? "", method: req.method ?? "", body });
          res.end(JSON.stringify({
            umbrella: {
              id: "issue-1",
              short_id: "abc",
              title: "Umbrella",
              status: "open",
              current_revision_id: "rev_issue_1",
            },
            delegation_manifest: { id: "checkpoint-4", payload: [] },
            children: [{ id: "issue-2", short_id: "def", title: "Child", status: "open" }],
            operation: {
              kind: "manifest-refresh",
              refreshed_child_refs: ["def"],
              delegation_manifest: { id: "checkpoint-4", payload: [] },
            },
            auth_queue: { pending_requests: [], active_requests: [] },
          }));
        });
        return;
      }
      if (req.method === "POST" && req.url === "/api/ledger/issues/abc/umbrella-adopt") {
        void readBody().then((body) => {
          requestBodies.push({ path: req.url ?? "", method: req.method ?? "", body });
          res.end(JSON.stringify({
            umbrella: {
              id: "issue-1",
              short_id: "abc",
              title: "Umbrella",
              status: "open",
              current_revision_id: "rev_issue_1",
            },
            delegation_manifest: { id: "checkpoint-2", payload: [] },
            children: [
              { id: "issue-2", short_id: "def", title: "Child", status: "open" },
              { id: "issue-3", short_id: "ghi", title: "Another child", status: "open" },
            ],
            operation: { kind: "adopt", created_child_refs: ["def", "ghi"], existing_child_refs: [] },
            auth_queue: { pending_requests: [], active_requests: [] },
          }));
        });
        return;
      }
      // Issue 7a97e2c: cli/issue.sh rendered every 409 on this route through the
      // live-holder template, so a refusal carrying no `live_holder` printed as
      // the phantom holder `- (-)`. The specific 409 that exposed it was the
      // umbrella-reconcile blocker, removed with that command on issue d894231.
      // The CLI contract it broke is not: any 409 without a holder must be
      // reported as itself.
      if (req.url === "/api/ledger/issues/non-holder-conflict/parent-role" && req.method === "POST") {
        void readBody().then(() => {
          res.statusCode = 409;
          res.end(JSON.stringify({
            error: "parent role cannot be recorded while the umbrella is closed",
          }));
        });
        return;
      }
      // Issue 5b2cdbf: an unregistered session id is refused with a 400.
      if (req.url === "/api/ledger/issues/unknown-session/parent-role" && req.method === "POST") {
        void readBody().then(() => {
          res.statusCode = 400;
          res.end(JSON.stringify({
            error: 'unknown session id "sess-ghost": Mandible has no session recorded under it. '
              + "Link it first with `mandible session link-issue sess-ghost --issue <issue> --repo <repo>`.",
            supplied_session_id: "sess-ghost",
          }));
        });
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
            action_id: "edge_action0123456789abcdef",
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
            action_id: "edge_unlink0123456789abcdef",
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
          kind: "feature",
          issue_branches: [{ branch: "feature/demo", role: "primary" }],
          body: "Issue body",
          work_notes: "Current working notes",
          work_notes_revision: "rev_notes_1",
          dependencies: [{
            id: "blocked-1",
            display_id: "blocked-1",
            project_id: "mandible",
            title: "Open prerequisite",
            status: "open",
            resolution: null,
            kind: "bug",
            priority: "normal",
            labels: [],
          }],
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
    expect(result.stdout).toContain("status <id> <none|in_progress|done|blocked|pivot-needed>");
    expect(result.stdout).toContain("branch add <id> <branch>");
  });

  it("prints help for nested issue coordination commands without contacting the daemon", async () => {
    for (const command of [["link"], ["unlink"], ["checkpoint", "add"], ["checkpoint", "show"], ["parent-role", "assume"]]) {
      const result = await run(["issue", ...command, "--help"], 9);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain(`mandible issue ${command.join(" ")} `);
    }
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

  it("requires an explicit close resolution", async () => {
    const result = await run(["issue", "close", "abc"], 9);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("--resolution");
    expect(result.stderr).toContain("delivered|duplicate|wontfix");
  });

  it("closes a duplicate without creating commit-resolution evidence", async () => {
    const port = await listen();
    const { worktreeRoot } = makeGitRepoWithWorktree();
    const result = await run(["issue", "close", "abc", "--resolution", "duplicate"], port, worktreeRoot);

    expect(result.status).toBe(0);
    expect(result.stderr).toContain("Closed issue abc as duplicate");
    expect(requestBodies).toContainEqual({
      path: "/api/ledger/issues/abc",
      method: "PATCH",
      body: { status: "closed", resolution: "duplicate" },
    });
    expect(requestBodies.some(({ path }) => path === "/api/ledger/issues/abc/comments")).toBe(false);
    expect(requestBodies.some(({ path }) => path === "/api/issues/resolutions")).toBe(false);
  });

  it("does not infer HEAD as delivered commit evidence", async () => {
    const port = await listen();
    const { worktreeRoot } = makeGitRepoWithWorktree();
    const result = await run(["issue", "close", "abc", "--resolution", "delivered"], port, worktreeRoot);

    expect(result.status).toBe(0);
    expect(result.stderr).toContain("Closed issue abc as delivered");
    expect(result.stderr).not.toContain("resolved by");
    expect(requestBodies).toContainEqual({
      path: "/api/ledger/issues/abc",
      method: "PATCH",
      body: { status: "closed", resolution: "delivered" },
    });
    expect(requestBodies.some(({ path }) => path === "/api/ledger/issues/abc/comments")).toBe(false);
    expect(requestBodies.some(({ path }) => path === "/api/issues/resolutions")).toBe(false);
  });

  it("retains commit-resolution evidence only for delivered closes", async () => {
    const port = await listen();
    const { worktreeRoot } = makeGitRepoWithWorktree();
    const result = await run([
      "issue",
      "close",
      "abc",
      "--resolution",
      "delivered",
      "--commit",
      "deadbeef",
    ], port, worktreeRoot);

    expect(result.status).toBe(0);
    expect(result.stderr).toContain("Closed issue abc as delivered (resolved by deadbeef)");
    expect(requestBodies).toContainEqual({
      path: "/api/ledger/issues/abc",
      method: "PATCH",
      body: { status: "closed", resolution: "delivered" },
    });
    expect(requestBodies).toContainEqual({
      path: "/api/ledger/issues/abc/comments",
      method: "POST",
      body: { message: "Resolved as delivered by commit deadbeef" },
    });
    expect(requestBodies).toContainEqual({
      path: "/api/issues/resolutions",
      method: "POST",
      body: { issue_id: "abc", commit_sha: "deadbeef", repo_id: "feature__demo" },
    });
  });

  it("rejects commit links for non-delivered closes", async () => {
    const result = await run([
      "issue",
      "close",
      "abc",
      "--resolution",
      "wontfix",
      "--commit",
      "deadbeef",
    ], 9);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("--commit is only supported with --resolution delivered");
  });

  it("prints umbrella status through file RPC", async () => {
    const spoolDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-umbrella-file-rpc-"));
    tempRoots.push(spoolDir);
    const seen: Array<Record<string, unknown>> = [];
    const responder = startFileRpcResponder(spoolDir, (request) => {
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
      responder.stop();
    }
  });

  it("requests deep umbrella status when asked", async () => {
    const port = await listen();
    const result = await run(["umbrella", "status", "abc", "--deep", "--json"], port);

    expect(result.status).toBe(0);
    expect(requestedPaths).toContain("/api/ledger/issues/abc/umbrella-status?deep=true");
    expect(JSON.parse(result.stdout).umbrella.short_id).toBe("abc");
  });

  it("adopts umbrella children with the expected payload", async () => {
    const port = await listen();
    const result = await run(["umbrella", "adopt", "abc", "def", "ghi", "--json"], port);

    expect(result.status).toBe(0);
    expect(requestBodies).toContainEqual({
      path: "/api/ledger/issues/abc/umbrella-adopt",
      method: "POST",
      body: { child_refs: ["def", "ghi"] },
    });
    const parsed = JSON.parse(result.stdout);
    expect(parsed.umbrella.short_id).toBe("abc");
    expect(parsed.operation.created_child_refs).toEqual(["def", "ghi"]);
  });

  it("refreshes an umbrella manifest server-side", async () => {
    const port = await listen();
    const result = await run(["umbrella", "manifest", "refresh", "abc", "--json"], port);

    expect(result.status).toBe(0);
    expect(requestBodies).toContainEqual({
      path: "/api/ledger/issues/abc/umbrella-manifest-refresh",
      method: "POST",
      body: {},
    });
    const parsed = JSON.parse(result.stdout);
    expect(parsed.umbrella.short_id).toBe("abc");
    expect(parsed.operation.kind).toBe("manifest-refresh");
    expect(parsed.operation.refreshed_child_refs).toEqual(["def"]);
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

  it("reports non-holder parent-role refusals as themselves, not as a phantom holder", async () => {
    const port = await listen();

    // Issue 7a97e2c reproduced exactly this: `parent-role status` reported no
    // holder while `assume` answered `live parent-role holder exists: - (-)`,
    // because every 409 on this route was rendered through the holder template.
    const nonHolder = await run([
      "issue",
      "parent-role",
      "assume",
      "non-holder-conflict",
      "--session",
      "sess-new",
    ], port);

    expect(nonHolder.status).toBe(1);
    expect(nonHolder.stderr).not.toContain("live parent-role holder exists");
    expect(nonHolder.stderr).toContain("parent role cannot be recorded while the umbrella is closed");

    const unknownSession = await run([
      "issue",
      "parent-role",
      "assume",
      "unknown-session",
      "--session",
      "sess-ghost",
    ], port);

    expect(unknownSession.status).toBe(1);
    expect(unknownSession.stderr).toContain('unknown session id "sess-ghost"');
    expect(unknownSession.stderr).toContain("mandible session link-issue");
  });

  it("reports a specific parent-role error when no session id is available", async () => {
    const missing = await run(["issue", "parent-role", "assume", "abc"], 9, process.cwd(), {
      MANDIBLE_SESSION_ID: "",
      CODEX_SESSION_ID: "",
    });

    expect(missing.status).toBe(2);
    expect(missing.stderr).toContain("Missing parent-role session id");
    expect(missing.stderr).toContain("Pass --session <id>");
  });

  it("auto-detects parent-role session ids from the environment", async () => {
    const port = await listen();
    const assumed = await run([
      "issue",
      "parent-role",
      "assume",
      "abc",
      "--override",
      "--json",
    ], port, process.cwd(), {
      MANDIBLE_SESSION_ID: "sess-env",
      CODEX_SESSION_ID: "",
    });

    expect(assumed.status).toBe(0);
    expect(JSON.parse(assumed.stdout).parent_role.holder.payload.session_id).toBe("sess-env");
    expect(requestBodies).toContainEqual({
      path: "/api/ledger/issues/abc/parent-role",
      method: "POST",
      body: {
        session_id: "sess-env",
        mechanism: "codex",
        override: true,
      },
    });
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
    expect(result.stdout).toContain("linked 2 relationship(s) action_id=edge_action0123");
    expect(result.stdout).not.toContain("edge_action0123456789abcdef");
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

  it("names accepted relationship types for invalid issue link types", async () => {
    const result = await run(["issue", "link", "abc", "def", "--type", "child"], 9);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Invalid relationship type: child");
    expect(result.stderr).toContain("parent_child");
    expect(result.stderr).toContain("references");
  });

  it("surfaces file-RPC relationship link denial status and body", async () => {
    const spoolDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-link-file-rpc-denied-"));
    tempRoots.push(spoolDir);
    const responder = startFileRpcResponder(spoolDir, () => ({
      status: 403,
      body: {
        error: "file_rpc_route_denied",
        method: "POST",
        path: "/api/ledger/relationships",
      },
    }));

    try {
      const result = await run(["issue", "link", "abc", "def"], 0, process.cwd(), {
        MANDIBLE_BASE: `file://${spoolDir}`,
        MANDIBLE_FILE_RPC_TIMEOUT: "5",
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Failed to link relationship(s) from abc");
      expect(result.stderr).toContain("API status 403");
      expect(result.stderr).toContain("file_rpc_route_denied");
      expect(result.stderr).toContain("/api/ledger/relationships");
    } finally {
      responder.stop();
    }
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
    expect(result.stdout).toContain("unlinked 1 relationship(s) action_id=edge_unlink0123");
    expect(result.stdout).not.toContain("edge_unlink0123456789abcdef");
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

  it("names accepted relationship types for invalid issue unlink types", async () => {
    const result = await run(["issue", "unlink", "abc", "def", "--type", "pulls-forward"], 9);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Invalid relationship type: pulls-forward");
    expect(result.stderr).toContain("parent_child");
    expect(result.stderr).toContain("references");
  });

  it("surfaces file-RPC relationship unlink denial status and body", async () => {
    const spoolDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-unlink-file-rpc-denied-"));
    tempRoots.push(spoolDir);
    const responder = startFileRpcResponder(spoolDir, () => ({
      status: 403,
      body: {
        error: "file_rpc_route_denied",
        method: "POST",
        path: "/api/ledger/relationships/unlink",
      },
    }));

    try {
      const result = await run(["issue", "unlink", "abc", "def"], 0, process.cwd(), {
        MANDIBLE_BASE: `file://${spoolDir}`,
        MANDIBLE_FILE_RPC_TIMEOUT: "5",
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Failed to unlink relationship(s) from abc");
      expect(result.stderr).toContain("API status 403");
      expect(result.stderr).toContain("file_rpc_route_denied");
      expect(result.stderr).toContain("/api/ledger/relationships/unlink");
    } finally {
      responder.stop();
    }
  });

  it("reports worker status and linked branches", async () => {
    const port = await listen();
    const result = await run(["issue", "report", "abc", "--json"], port);

    expect(result.status).toBe(0);
    const body = JSON.parse(result.stdout);
    expect(body.worker_status).toBe("in_progress");
    expect(body.issue_branches).toEqual([{ branch: "feature/demo", role: "primary" }]);
    expect(body.work_notes).toBe("Current working notes");
    expect(body.work_notes_revision).toBe("rev_notes_1");
    expect(body.dependencies).toEqual([expect.objectContaining({ display_id: "blocked-1", status: "open" })]);
  });

  it("requires and forwards a concrete canonical kind when creating an issue", async () => {
    const spoolDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-new-kind-file-rpc-"));
    tempRoots.push(spoolDir);
    const seen: Array<Record<string, unknown>> = [];
    const responder = startFileRpcResponder(spoolDir, (request) => {
      seen.push(request);
      expect(request).toMatchObject({ method: "POST", path: "/api/issues/mandible" });
      return { status: 200, body: { display_id: "new-1" } };
    });

    try {
      const result = await run([
        "issue", "new", "-t", "Coordination", "-m", "Body", "--kind", "tracker", "--project", "mandible",
      ], 0, process.cwd(), {
        MANDIBLE_BASE: `file://${spoolDir}`,
        MANDIBLE_FILE_RPC_TIMEOUT: "5",
      });

      expect(result.status).toBe(0);
      expect(result.stderr).toContain("Created issue new-1");
      expect(seen).toHaveLength(1);
      expect(seen[0].body).toMatchObject({ kind: "tracker", title: "Coordination", body: "Body" });
    } finally {
      responder.stop();
    }
  });

  it("rejects issue creation without a concrete kind", async () => {
    const result = await run(["issue", "new", "-t", "Experiment", "-m", "Body"], 0, process.cwd(), {
      MANDIBLE_BASE: "file:///nonexistent-mandible-test-spool",
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("--kind");
  });

  it("reports through file RPC when MANDIBLE_BASE is a file URL", async () => {
    const spoolDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-file-rpc-cli-"));
    tempRoots.push(spoolDir);
    const seen: Array<Record<string, unknown>> = [];
    const responder = startFileRpcResponder(spoolDir, (request) => {
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
      responder.stop();
    }
  });

  it("ignores file RPC response cleanup failures after successful POSTs", async () => {
    const spoolDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-file-rpc-cli-"));
    tempRoots.push(spoolDir);
    const seen: Array<Record<string, unknown>> = [];
    const responder = startFileRpcResponder(
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
      { afterResponse: () => { fs.chmodSync(spoolDir, 0o555); } },
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
      responder.stop();
    }
  });

  it("updates labels through file RPC with jq 1.6-safe JSON keys", async () => {
    const spoolDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-file-rpc-label-"));
    tempRoots.push(spoolDir);
    const seen: Array<Record<string, unknown>> = [];
    const responder = startFileRpcResponder(spoolDir, (request) => {
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
      responder.stop();
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
      { issue: "abc", digest: "digest-before", subtree_digest: "subtree-abc-before" },
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

  it("classifies subtree_changed and unknown entries in issue changed", async () => {
    const port = await listen();
    // ghi: own head stable, subtree digest drifted -> subtree_changed.
    (issueHeads as Record<string, unknown>).ghi = {
      issue_id: "issue-3",
      short_id: "ghi",
      digest: "digest-ghi-stable",
      subtree_digest: "subtree-ghi-current",
      last_event_at: 1_700_000_000_000,
      last_event_kind: "issue.created",
      subtree_last_event_at: 1_700_000_050_000,
      subtree_last_event_kind: "comment.created",
    };
    const manifest = path.join(os.tmpdir(), `mandible-manifest-subtree-${Date.now()}.json`);
    fs.writeFileSync(manifest, JSON.stringify([
      // own + subtree both match current -> unchanged
      { issue: "abc", digest: "digest-before", subtree_digest: "subtree-abc-before" },
      // own drifted -> changed
      { issue: "def", digest: "digest-stale", subtree_digest: "subtree-def-current" },
      // own stable, subtree drifted -> subtree_changed
      { issue: "ghi", digest: "digest-ghi-stable", subtree_digest: "subtree-ghi-stale" },
      // no baseline subtree digest, own stable -> unknown (never silently unchanged)
      { issue: "abc", digest: "digest-before" },
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
    expect(body.subtree_changed.map((entry: { issue: string }) => entry.issue)).toEqual(["ghi"]);
    expect(body.unknown.map((entry: { issue: string }) => entry.issue)).toEqual(["abc"]);
    expect(body.subtree_changed[0].expected_subtree_digest).toBe("subtree-ghi-stale");
    expect(body.subtree_changed[0].current_subtree_digest).toBe("subtree-ghi-current");
    expect(body.unknown[0].subtree_state).toBe("unknown");
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
      subtree_digest: "subtree-abc-after",
      last_event_at: 1_700_000_030_000,
      last_event_kind: "comment.created",
      subtree_last_event_at: 1_700_000_030_000,
      subtree_last_event_kind: "comment.created",
    };
    issueCheckpoints.abc = [
      {
        id: "checkpoint-child-only",
        issue_id: "issue-1",
        kind: "delegation-manifest",
        payload: [
          { issue: "def", digest: "digest-current", subtree_digest: "subtree-def-current" },
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

  it("classifies the umbrella self-entry as unknown for a pre-upgrade checkpoint", async () => {
    const port = await listen();
    // Pre-upgrade checkpoint: no stored self-baseline entry (`self: true`). The
    // /head?at reconstruction still returns a subtree_digest (the head endpoint
    // always computes one now), but the synthesized self-entry must ignore it
    // and take a null subtree baseline so it classifies "unknown" rather than
    // "subtree_changed" or "unchanged".
    issueCheckpoints.abc = [
      {
        id: "checkpoint-legacy",
        issue_id: "issue-1",
        kind: "delegation-manifest",
        // abc (the umbrella) is not in the payload, so it is synthesized as the
        // self-entry. def has an own digest but no subtree_digest.
        payload: [{ issue: "def", digest: "digest-current" }],
        author: { id: null, type: "mandible_user", display: "Mandible" },
        source: "mandible",
        created_at: 1_700_000_020_000,
      },
    ];
    // Own digest of abc is stable against the checkpoint-time reconstruction
    // (both "digest-before"), but its subtree digest has drifted. With a null
    // baseline this is "unknown"; a non-null reconstructed baseline would wrongly
    // read as "subtree_changed".
    (issueHeads as Record<string, unknown>).abc = {
      issue_id: "issue-1",
      short_id: "abc",
      digest: "digest-before",
      subtree_digest: "subtree-abc-drifted",
      last_event_at: 1_700_000_020_000,
      last_event_kind: "issue.checkpoint.created",
      subtree_last_event_at: 1_700_000_060_000,
      subtree_last_event_kind: "comment.created",
    };

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
    // Both the self-entry (abc) and def lack a subtree baseline -> unknown.
    expect(body.unknown.map((entry: { issue: string }) => entry.issue).sort()).toEqual(["abc", "def"]);
    // The self-entry must NOT be reported as subtree_changed despite the drift.
    expect(body.subtree_changed.map((entry: { issue: string }) => entry.issue)).toEqual([]);
    expect(body.changed.map((entry: { issue: string }) => entry.issue)).toEqual([]);
  });

  it("keeps the self-entry unknown when a legacy checkpoint has child subtree digests but no self marker", async () => {
    const port = await listen();
    // A checkpoint whose child entries carry subtree digests but which lacks
    // the stored self-baseline entry must still classify the umbrella self-entry
    // as unknown. Detection is the explicit `self: true` marker, not an
    // inference from whether other entries carry subtree digests -- this test
    // fails against the "any entry has a subtree_digest" heuristic, which would
    // adopt the /head?at reconstruction as the subtree baseline and classify
    // the stable umbrella "unchanged".
    issueCheckpoints.abc = [
      {
        id: "checkpoint-no-marker",
        issue_id: "issue-1",
        kind: "delegation-manifest",
        payload: [{ issue: "def", digest: "digest-current", subtree_digest: "subtree-def-current" }],
        author: { id: null, type: "mandible_user", display: "Mandible" },
        source: "mandible",
        created_at: 1_700_000_020_000,
      },
    ];
    // Defaults: abc's current head equals the checkpoint-time reconstruction
    // (digest-before / subtree-abc-before), i.e. fully stable.

    const result = await run([
      "issue",
      "changed",
      "--since-issue",
      "abc",
      "--json",
    ], port);

    expect(result.status).toBe(0);
    const body = JSON.parse(result.stdout);
    expect(body.unknown.map((entry: { issue: string }) => entry.issue)).toEqual(["abc"]);
    expect(body.unchanged.map((entry: { issue: string }) => entry.issue)).toEqual(["def"]);
    expect(body.subtree_changed.map((entry: { issue: string }) => entry.issue)).toEqual([]);
    expect(body.changed.map((entry: { issue: string }) => entry.issue)).toEqual([]);
  });

  it("classifies a stable self-entry as unchanged for a post-upgrade zero-child checkpoint", async () => {
    const port = await listen();
    // Post-upgrade zero-child checkpoint: the payload contains only the stored
    // self-baseline entry. The umbrella is stable against it, so it classifies
    // "unchanged" -- an empty child list must not be misdetected as a
    // pre-upgrade checkpoint (which would classify "unknown").
    issueCheckpoints.abc = [
      {
        id: "checkpoint-zero-child",
        issue_id: "issue-1",
        kind: "delegation-manifest",
        payload: [
          {
            issue_id: "issue-1",
            short_id: "abc",
            digest: "digest-before",
            subtree_digest: "subtree-abc-before",
            self: true,
          },
        ],
        author: { id: null, type: "mandible_user", display: "Mandible" },
        source: "mandible",
        created_at: 1_700_000_020_000,
      },
    ];
    // The normal head includes the checkpoint event and therefore differs from
    // the pre-checkpoint self baseline. The comparison must exclude only the
    // exact checkpoint that established that baseline.
    issueHeads.abc = {
      ...(issueHeads.abc as Record<string, unknown>),
      digest: "digest-after-checkpoint",
      subtree_digest: "subtree-abc-after-checkpoint",
      last_event_kind: "issue.checkpoint.created",
      subtree_last_event_kind: "issue.checkpoint.created",
    };
    issueHeadsExcludingCheckpoint.abc = {
      "checkpoint-zero-child": {
        ...(issueHeads.abc as Record<string, unknown>),
        digest: "digest-before",
        subtree_digest: "subtree-abc-before",
        last_event_kind: "issue.created",
        subtree_last_event_kind: "issue.created",
      },
    };

    const result = await run([
      "issue",
      "changed",
      "--since-issue",
      "abc",
      "--json",
    ], port);

    expect(result.status).toBe(0);
    const body = JSON.parse(result.stdout);
    expect(body.unchanged.map((entry: { issue: string }) => entry.issue)).toEqual(["abc"]);
    expect(body.unknown.map((entry: { issue: string }) => entry.issue)).toEqual([]);
    expect(body.changed.map((entry: { issue: string }) => entry.issue)).toEqual([]);
    expect(body.subtree_changed.map((entry: { issue: string }) => entry.issue)).toEqual([]);
    expect(requestedPaths).toContain(
      "/api/ledger/issues/abc/head?exclude_checkpoint=checkpoint-zero-child",
    );
  });

  it("compares the stored self baseline directly for a post-upgrade checkpoint", async () => {
    const port = await listen();
    // Normal post-upgrade checkpoint: self-baseline entry plus a child entry.
    // The self-entry's stored subtree baseline differs from the current subtree
    // digest while its own digest is stable -> subtree_changed, proving the
    // stored baseline (not a /head?at reconstruction) drives classification.
    issueCheckpoints.abc = [
      {
        id: "checkpoint-post-upgrade",
        issue_id: "issue-1",
        kind: "delegation-manifest",
        payload: [
          {
            issue_id: "issue-1",
            short_id: "abc",
            digest: "digest-before",
            subtree_digest: "subtree-abc-at-checkpoint",
            self: true,
          },
          { issue: "def", digest: "digest-current", subtree_digest: "subtree-def-current" },
        ],
        author: { id: null, type: "mandible_user", display: "Mandible" },
        source: "mandible",
        created_at: 1_700_000_020_000,
      },
    ];
    // Defaults: abc's current head is digest-before / subtree-abc-before. Own
    // digest matches the stored baseline; the subtree digest drifted from
    // "subtree-abc-at-checkpoint".

    const result = await run([
      "issue",
      "changed",
      "--since-issue",
      "abc",
      "--json",
    ], port);

    expect(result.status).toBe(0);
    const body = JSON.parse(result.stdout);
    expect(body.subtree_changed.map((entry: { issue: string }) => entry.issue)).toEqual(["abc"]);
    expect(body.subtree_changed[0].expected_subtree_digest).toBe("subtree-abc-at-checkpoint");
    expect(body.subtree_changed[0].current_subtree_digest).toBe("subtree-abc-before");
    expect(body.unchanged.map((entry: { issue: string }) => entry.issue)).toEqual(["def"]);
    expect(body.unknown.map((entry: { issue: string }) => entry.issue)).toEqual([]);
    expect(body.changed.map((entry: { issue: string }) => entry.issue)).toEqual([]);
  });

  it("can pin a non-latest checkpoint as the changed-since baseline", async () => {
    const port = await listen();
    issueHeads.abc = {
      issue_id: "issue-1",
      short_id: "abc",
      digest: "digest-after-newer-parent",
      subtree_digest: "subtree-abc-after-newer-parent",
      last_event_at: 1_700_000_040_000,
      last_event_kind: "comment.created",
      subtree_last_event_at: 1_700_000_040_000,
      subtree_last_event_kind: "comment.created",
    };
    issueHeadsAt.abc = {
      ...issueHeadsAt.abc,
      "1700000010000": {
        issue_id: "issue-1",
        short_id: "abc",
        digest: "digest-old-parent-baseline",
        subtree_digest: "subtree-abc-old-baseline",
        last_event_at: 1_700_000_010_000,
        last_event_kind: "issue.checkpoint.created",
        subtree_last_event_at: 1_700_000_010_000,
        subtree_last_event_kind: "issue.checkpoint.created",
      },
      "1700000030000": {
        issue_id: "issue-1",
        short_id: "abc",
        digest: "digest-new-parent-baseline",
        subtree_digest: "subtree-abc-new-baseline",
        last_event_at: 1_700_000_030_000,
        last_event_kind: "issue.checkpoint.created",
        subtree_last_event_at: 1_700_000_030_000,
        subtree_last_event_kind: "issue.checkpoint.created",
      },
    };
    issueCheckpoints.abc = [
      {
        id: "checkpoint-new",
        issue_id: "issue-1",
        kind: "delegation-manifest",
        payload: [{ issue: "def", digest: "digest-current", subtree_digest: "subtree-def-current" }],
        author: { id: null, type: "mandible_user", display: "Mandible" },
        source: "mandible",
        created_at: 1_700_000_030_000,
      },
      {
        id: "checkpoint-old",
        issue_id: "issue-1",
        kind: "delegation-manifest",
        payload: [{ issue: "def", digest: "digest-current", subtree_digest: "subtree-def-current" }],
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

    const addedFromStdin = await runBash(
      `printf '%s' '[{"issue":"stdin","digest":"digest-stdin"}]' | "${CLI}" issue checkpoint add abc --kind closeout --payload -`,
      process.cwd(),
      { MANDIBLE_BASE: `http://127.0.0.1:${port}` },
    );
    expect(addedFromStdin.status).toBe(0);
    expect(requestBodies.at(-1)).toMatchObject({
      path: "/api/ledger/issues/abc/checkpoints",
      method: "POST",
      body: {
        kind: "closeout",
        payload: [{ issue: "stdin", digest: "digest-stdin" }],
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
    expect(result.stderr).toContain("Arguments do not match: mandible issue description edit");
  });

  it("prints compact issue body history without snapshots by default", async () => {
    const port = await listen();
    const result = await run(["issue", "description", "history", "abc"], port);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("rev\tid\treason\tsource\toccurred\tactor\thash");
    expect(result.stdout).toContain("#1\trev_issue_1\tcreate\tmandible");
    expect(result.stdout).not.toContain("Issue body");
  });

  it("shows current working notes and their revision", async () => {
    const port = await listen();
    const result = await run(["issue", "work-notes", "show", "abc", "--json"], port);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      issue_id: "issue-1",
      display_id: "abc",
      work_notes: "Current working notes",
      work_notes_revision: "rev_notes_1",
    });
  });

  it("edits working notes through the issue PATCH API with an expected revision", async () => {
    const port = await listen();
    const result = await run([
      "issue", "work-notes", "edit", "abc", "-m", "Updated working notes", "--base-revision", "rev_notes_1",
    ], port);

    expect(result.status).toBe(0);
    expect(requestBodies).toContainEqual({
      path: "/api/ledger/issues/abc",
      method: "PATCH",
      body: { work_notes: "Updated working notes", expected_work_notes_revision: "rev_notes_1" },
    });
  });

  it("clears working notes while preserving the explicit empty value", async () => {
    const port = await listen();
    const result = await run(["issue", "work-notes", "clear", "abc"], port);

    expect(result.status).toBe(0);
    expect(requestBodies).toContainEqual({
      path: "/api/ledger/issues/abc",
      method: "PATCH",
      body: { work_notes: "" },
    });
  });

  it("prints working-notes history without snapshots by default", async () => {
    const port = await listen();
    const result = await run(["issue", "work-notes", "history", "abc"], port);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("#1\trev_notes_1\tedit\tmandible");
    expect(result.stdout).not.toContain("Current working notes");
  });

  it("updates the canonical issue kind through the existing PATCH API", async () => {
    const port = await listen();
    const result = await run(["issue", "kind", "set", "abc", "experiment"], port);

    expect(result.status).toBe(0);
    expect(requestBodies).toContainEqual({
      path: "/api/ledger/issues/abc",
      method: "PATCH",
      body: { kind: "experiment" },
    });
  });

  it("rejects retired issue kinds instead of treating labels as kind aliases", async () => {
    const result = await run(["issue", "kind", "set", "abc", "legacy"], 0, process.cwd(), {
      MANDIBLE_BASE: "file:///nonexistent-mandible-test-spool",
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("Arguments do not match: mandible issue kind set");
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
    const responder = startFileRpcResponder(spoolDir, () => ({ status: 200, body: [] }));

    try {
      const result = await run(["issue", "list"], 0, os.tmpdir(), {
        MANDIBLE_BASE: `file://${spoolDir}`,
        MANDIBLE_FILE_RPC_TIMEOUT: "5",
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("cwd does not resolve to a registered repo; pass --repo <path|id>");
    } finally {
      responder.stop();
    }
  });

  it("triages explicit repo filters through file RPC with jq 1.6-safe label variables", async () => {
    const spoolDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-issue-triage-file-rpc-"));
    tempRoots.push(spoolDir);
    const seenPaths: string[] = [];
    const responder = startFileRpcResponder(
      spoolDir,
      (request) => {
        seenPaths.push(String(request.path ?? ""));
        return {
          status: 200,
          body: [
            {
              repo_name: "mandible",
              issues: [
                {
                  id: "abc",
                  status: "open",
                  kind: "tracker",
                  priority: "high",
                  resolution: "delivered",
                  title: "Read-only transport",
                  updated_at: "2026-06-12T12:00:00.000Z",
                  labels: ["feature"],
                },
                {
                  id: "def",
                  status: "open",
                  kind: "maintenance",
                  priority: "normal",
                  title: "Other work",
                  updated_at: "2026-06-12T12:00:00.000Z",
                  labels: ["maintenance"],
                },
              ],
            },
          ],
        };
      },
    );

    try {
      const result = await run(["issue", "triage", "--repo", "/repo/mandible", "--kind", "tracker", "--priority", "high", "--resolution", "delivered", "--label", "feature", "--json"], 0, os.tmpdir(), {
        MANDIBLE_BASE: `file://${spoolDir}`,
        MANDIBLE_FILE_RPC_TIMEOUT: "5",
      });

      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual([
        expect.objectContaining({ id: "abc", title: "Read-only transport" }),
      ]);
      expect(result.stderr).not.toContain("jq:");
      const triagePath = seenPaths.find((item) => item.startsWith("/api/issues?"));
      expect(triagePath).toBeTruthy();
      expect(new URL(`http://127.0.0.1${triagePath}`).searchParams.get("repo")).toBe("/repo/mandible");
    } finally {
      responder.stop();
    }
  });
});
