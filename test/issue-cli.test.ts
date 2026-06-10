import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const CLI = path.join(process.cwd(), "bin", "mandible");

let server: http.Server | null = null;
let requestedPaths: string[] = [];
let tempRoots: string[] = [];
let issueHeads: Record<string, unknown> = {};

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
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(CLI, args, {
      cwd,
      env: {
        ...process.env,
        MANDIBLE_PORT: String(port),
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
  return new Promise((resolve) => {
    server = http.createServer((req, res) => {
      requestedPaths.push(req.url ?? "");
      res.setHeader("Content-Type", "application/json");

      if (req.url?.startsWith("/api/issues?")) {
        res.end(JSON.stringify([
          {
            repo_name: "mandible",
            issues: [{ id: "abc", status: "open", title: "Worktree issue" }],
          },
        ]));
        return;
      }
      const headMatch = req.url?.match(/^\/api\/ledger\/issues\/([^/]+)\/head$/);
      if (headMatch) {
        const head = issueHeads[decodeURIComponent(headMatch[1])];
        if (!head) {
          res.statusCode = 404;
          res.end(JSON.stringify({ error: "ledger issue not found" }));
          return;
        }
        res.end(JSON.stringify(head));
        return;
      }
      if (req.url === "/api/ledger/issues/abc/body/revisions") {
        res.end(JSON.stringify({ revisions: [issueRevision] }));
        return;
      }
      if (req.method === "POST" && req.url === "/api/ledger/issues/abc/comments") {
        res.end(JSON.stringify({ id: "comment-3" }));
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
    expect(requestedPaths).toContain("/api/ledger/issues/abc/comments");
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

  it("reports worker status and linked branches", async () => {
    const port = await listen();
    const result = await run(["issue", "report", "abc", "--json"], port);

    expect(result.status).toBe(0);
    const body = JSON.parse(result.stdout);
    expect(body.worker_status).toBe("in_progress");
    expect(body.issue_branches).toEqual([{ branch: "feature/demo", role: "primary" }]);
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

  it("shows only the issue description", async () => {
    const port = await listen();
    const result = await run(["issue", "description", "show", "abc"], port);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("Issue body\n");
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

    const listPath = requestedPaths.find((item) => item.startsWith("/api/issues?"));
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

    const listPath = requestedPaths.find((item) => item.startsWith("/api/issues?"));
    expect(listPath).toBeTruthy();
    const url = new URL(`http://127.0.0.1${listPath}`);
    expect(url.searchParams.get("repo")).toBe(repoRoot);
    expect(url.searchParams.get("repo")).not.toBe(worktreeRoot);
    expect(url.searchParams.get("status")).toBe("open");
  });
});
