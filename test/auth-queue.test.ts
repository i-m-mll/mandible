import Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { AuthQueue, AuthQueueError } from "../src/auth-queue.js";
import type { SseEvent } from "../src/types.js";

function createQueue(options: ConstructorParameters<typeof AuthQueue>[0] = {}) {
  const db = new Database(":memory:");
  return new AuthQueue({ db, ...options });
}

async function waitForStatus(queue: AuthQueue, id: string, status: string, timeoutMs = 2000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const request = queue.getRequest(id);
    if (request?.status === status) {
      return request;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for status ${status}`);
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function writeFile(repo: string, relativePath: string, content: string): void {
  const fullPath = path.join(repo, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, content, "utf8");
}

function createAuthCheckRepo(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-auth-check-"));
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.name", "Mandible Test"]);
  git(repo, ["config", "user.email", "mandible-test@localhost"]);
  git(repo, ["config", "commit.gpgsign", "false"]);
  writeFile(repo, "shared.txt", "base\n");
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", "init"]);
  return repo;
}

function commitOnBranch(repo: string, branch: string, changes: Record<string, string>): void {
  git(repo, ["checkout", "-b", branch, "main"]);
  for (const [file, content] of Object.entries(changes)) {
    writeFile(repo, file, content);
  }
  git(repo, ["add", "."]);
  git(repo, ["commit", "-m", branch]);
  git(repo, ["checkout", "main"]);
}

describe("auth queue", () => {
  it("submits request and returns pending status", () => {
    const queue = createQueue();

    const request = queue.submit({ command: "echo hello", title: "Test" });
    expect(request.id).toBeTruthy();

    const fetched = queue.getRequest(request.id);
    expect(fetched?.status).toBe("pending");
  });

  it("approves request, executes command, stores result", async () => {
    const queue = createQueue();

    const request = queue.submit({
      command: "node -e \"console.log('ok')\"",
      title: "Run command"
    });

    const approved = queue.approve(request.id);
    expect(approved.status).toBe("executing");

    const resolved = await waitForStatus(queue, request.id, "completed");
    expect(resolved?.exit_code).toBe(0);
    expect(String(resolved?.output)).toContain("ok");
  });

  it("stores git context fields on submit", () => {
    const queue = createQueue();

    const request = queue.submit({
      command: "echo git",
      title: "Git",
      repo: "mandible",
      base_branch: "main",
      head_branch: "feature/demo",
      files_changed: 3,
      additions: 10,
      deletions: 2,
      execution_mode: "remote"
    });

    const fetched = queue.getRequest(request.id);
    expect(fetched?.repo).toBe("mandible");
    expect(fetched?.base_branch).toBe("main");
    expect(fetched?.head_branch).toBe("feature/demo");
    expect(fetched?.files_changed).toBe(3);
    expect(fetched?.additions).toBe(10);
    expect(fetched?.deletions).toBe(2);
    expect(fetched?.execution_mode).toBe("remote");
  });

  it("appends output chunks", () => {
    const queue = createQueue();

    const request = queue.submit({ command: "echo output", title: "Output" });
    queue.appendOutput(request.id, "hello");
    queue.appendOutput(request.id, " world");

    const fetched = queue.getRequest(request.id);
    expect(fetched?.output).toBe("hello world");
  });

  it("sets result and completes request", () => {
    const queue = createQueue();

    const request = queue.submit({ command: "echo done", title: "Done" });
    queue.setResult(request.id, 0, "ok", undefined);

    const fetched = queue.getRequest(request.id);
    expect(fetched?.status).toBe("completed");
    expect(fetched?.exit_code).toBe(0);
    expect(fetched?.output).toBe("ok");
  });

  it("does not execute in remote mode", async () => {
    const calls: string[] = [];
    const executor = async () => {
      calls.push("called");
      return {
        exit_code: 0,
        signal: null,
        stdout: "",
        stderr: "",
        output: "",
        started_at: Date.now(),
        finished_at: Date.now()
      };
    };
    const queue = createQueue({ executor });

    const request = queue.submit({
      command: "echo remote",
      title: "Remote",
      execution_mode: "remote"
    });

    const approved = queue.approve(request.id);
    expect(approved.status).toBe("executing");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(calls).toHaveLength(0);
  });

  it("recovers stale executing requests with partial output on restart", () => {
    let now = 0;
    const db = new Database(":memory:");
    const queue = new AuthQueue({ db, now: () => now });
    const request = queue.submit({
      command: "mandible auth merge feature/partial",
      title: "Partial execution",
      execution_mode: "remote"
    });
    queue.approve(request.id);
    queue.appendOutput(request.id, "Executing merge command...\n");
    queue.dispose();

    now = 6 * 60 * 1000;
    const events: SseEvent[] = [];
    const restarted = new AuthQueue({ db, now: () => now, broadcast: (event) => events.push(event) });
    try {
      const recovered = restarted.getRequest(request.id);
      expect(recovered?.status).toBe("completed");
      expect(recovered?.exit_code).toBe(1);
      expect(recovered?.error).toContain("partial output");
      expect(events.some((event) => event.event === "auth:resolved")).toBe(true);
    } finally {
      restarted.dispose();
      db.close();
    }
  });

  it("recovers successful executing requests and reapplies merge finalizers on restart", () => {
    let now = 0;
    const db = new Database(":memory:");
    const queue = new AuthQueue({ db, now: () => now });
    db.exec(`
      CREATE TABLE work_units (
        id TEXT PRIMARY KEY,
        issue_id TEXT NOT NULL,
        repo_id TEXT NOT NULL,
        branch TEXT,
        kind TEXT NOT NULL DEFAULT 'solo',
        state TEXT NOT NULL DEFAULT 'open',
        created_at INTEGER NOT NULL,
        resolved_at INTEGER,
        auth_request_id TEXT
      )
    `);
    const request = queue.submit({
      type: "merge",
      command: "mandible auth merge feature/recovered --into main",
      title: "Recovered merge",
      repo: "mandible",
      base_branch: "main",
      head_branch: "feature/recovered",
      execution_mode: "remote"
    });
    db.prepare(
      `INSERT INTO work_units (
        id, issue_id, repo_id, branch, kind, state, created_at, auth_request_id
      ) VALUES (
        'wu-recovered', 'issue-1', 'mandible', 'feature/recovered', 'solo', 'committed', ?, ?
      )`
    ).run(now, request.id);
    queue.approve(request.id);
    queue.appendOutput(request.id, "Merge made by recursive.\n");
    queue.dispose();

    now = 6 * 60 * 1000;
    const restarted = new AuthQueue({ db, now: () => now });
    try {
      const recovered = restarted.getRequest(request.id);
      const workUnit = db.prepare("SELECT state, resolved_at FROM work_units WHERE id = 'wu-recovered'")
        .get() as { state: string; resolved_at: number | null };
      expect(recovered?.status).toBe("completed");
      expect(recovered?.exit_code).toBe(0);
      expect(workUnit.state).toBe("resolved");
      expect(workUnit.resolved_at).toBe(now);
    } finally {
      restarted.dispose();
      db.close();
    }
  });

  it("executes in daemon mode", async () => {
    const calls: string[] = [];
    const executor = async () => {
      calls.push("called");
      return {
        exit_code: 0,
        signal: null,
        stdout: "ok\n",
        stderr: "",
        output: "ok\n",
        started_at: Date.now(),
        finished_at: Date.now()
      };
    };
    const queue = createQueue({ executor });

    const request = queue.submit({
      command: "echo daemon",
      title: "Daemon",
      execution_mode: "daemon"
    });

    queue.approve(request.id);
    const resolved = await waitForStatus(queue, request.id, "completed");
    expect(resolved?.exit_code).toBe(0);
    expect(calls).toHaveLength(1);
  });

  it("auto-approves new requests while a lease is active and passes scoped env", async () => {
    const calls: Array<NodeJS.ProcessEnv | undefined> = [];
    const queue = createQueue({
      autoApprover: {
        getActiveApprovalContext: () => ({
          source: "auto_lease",
          leaseId: "lease-1",
          env: {
            SSH_AUTH_SOCK: "/tmp/mandible-agent.sock",
            GIT_CONFIG_COUNT: "1",
            GIT_CONFIG_KEY_0: "user.signingkey",
            GIT_CONFIG_VALUE_0: "/tmp/delegated.pub",
          },
        }),
      },
      executor: async (options) => {
        calls.push(options.env);
        return {
          exit_code: 0,
          signal: null,
          stdout: "ok\n",
          stderr: "",
          output: "ok\n",
          started_at: Date.now(),
          finished_at: Date.now(),
        };
      },
    });

    const request = queue.submit({
      command: "echo daemon",
      title: "Daemon",
      execution_mode: "daemon",
    });

    expect(request.status).toBe("executing");
    expect(request.approval_source).toBe("auto_lease");
    expect(request.approval_lease_id).toBe("lease-1");
    await waitForStatus(queue, request.id, "completed");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.SSH_AUTH_SOCK).toBe("/tmp/mandible-agent.sock");
    expect(calls[0]?.GIT_CONFIG_VALUE_0).toBe("/tmp/delegated.pub");
  });

  it("auto-approves pending requests when a lease is enabled", () => {
    const queue = createQueue({
      executor: async () => ({
        exit_code: 0,
        signal: null,
        stdout: "",
        stderr: "",
        output: "",
        started_at: Date.now(),
        finished_at: Date.now(),
      }),
    });
    const first = queue.submit({ command: "echo one", title: "One" });
    const second = queue.submit({ command: "echo two", title: "Two" });

    const approved = queue.autoApprovePending({
      source: "auto_lease",
      leaseId: "lease-2",
      env: { SSH_AUTH_SOCK: "/tmp/agent.sock" },
    });

    expect(approved.map((r) => r.id)).toEqual([first.id, second.id]);
    expect(queue.getRequest(first.id)?.approval_source).toBe("auto_lease");
    expect(queue.getRequest(second.id)?.approval_lease_id).toBe("lease-2");
  });

  it("rejects request", () => {
    const queue = createQueue();

    const request = queue.submit({ command: "echo nope", title: "Reject" });
    const rejected = queue.reject(request.id, "No");

    expect(rejected.status).toBe("rejected");

    const fetched = queue.getRequest(request.id);
    expect(fetched?.status).toBe("rejected");
  });

  it("queues multiple requests FIFO and supports out-of-order approval", async () => {
    let time = 1;
    const queue = createQueue({ now: () => time++ });

    const first = queue.submit({ command: "echo one", title: "One" });
    const second = queue.submit({
      command: "node -e \"console.log('two')\"",
      title: "Two"
    });

    const pending = queue.listPending();
    const ids = pending.map((r) => r.id);
    expect(ids).toEqual([first.id, second.id]);

    queue.approve(second.id);
    const resolved = await waitForStatus(queue, second.id, "completed");
    expect(resolved?.exit_code).toBe(0);

    const stillPending = queue.getRequest(first.id);
    expect(stillPending?.status).toBe("pending");
  });

  it("accepts pairwise-independent pending merge requests", () => {
    const repo = createAuthCheckRepo();
    const queue = createQueue();
    try {
      commitOnBranch(repo, "feature/a", { "a.txt": "a\n" });
      commitOnBranch(repo, "feature/b", { "b.txt": "b\n" });

      const first = queue.submit({
        type: "merge",
        command: "mandible auth merge feature/a --into main",
        title: "Merge feature/a",
        repo: "repo",
        base_branch: "main",
        head_branch: "feature/a",
        cwd: repo,
      });
      const check = queue.checkMergeIndependence({
        repo: "repo",
        base_branch: "main",
        head_branch: "feature/b",
        cwd: repo,
      });
      expect(check.status).toBe("clean");
      expect(check.checked_requests).toBe(1);

      const second = queue.submit({
        type: "merge",
        command: "mandible auth merge feature/b --into main",
        title: "Merge feature/b",
        repo: "repo",
        base_branch: "main",
        head_branch: "feature/b",
        cwd: repo,
      });

      expect(queue.getRequest(first.id)?.status).toBe("pending");
      expect(queue.getRequest(second.id)?.status).toBe("pending");
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("rejects a pending merge request that conflicts with the queued simulation", () => {
    const repo = createAuthCheckRepo();
    const queue = createQueue();
    try {
      commitOnBranch(repo, "feature/a", { "shared.txt": "a\n" });
      commitOnBranch(repo, "feature/b", { "shared.txt": "b\n" });

      const first = queue.submit({
        type: "merge",
        command: "mandible auth merge feature/a --into main",
        title: "Merge feature/a",
        repo: "repo",
        base_branch: "main",
        head_branch: "feature/a",
        cwd: repo,
      });

      const check = queue.checkMergeIndependence({
        repo: "repo",
        base_branch: "main",
        head_branch: "feature/b",
        cwd: repo,
      });
      expect(check.status).toBe("conflict");
      expect(check.conflicts[0]?.request_id).toBe(first.id);
      expect(check.conflicts[0]?.files).toContain("shared.txt");

      expect(() => queue.submit({
        type: "merge",
        command: "mandible auth merge feature/b --into main",
        title: "Merge feature/b",
        repo: "repo",
        base_branch: "main",
        head_branch: "feature/b",
        cwd: repo,
      })).toThrow(AuthQueueError);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("marks pending merge requests needs_rebase after post-merge revalidation", () => {
    const repo = createAuthCheckRepo();
    const db = new Database(":memory:");
    const events: SseEvent[] = [];
    const queue = new AuthQueue({ db, broadcast: (event) => events.push(event) });
    try {
      commitOnBranch(repo, "feature/a", { "shared.txt": "a\n" });
      commitOnBranch(repo, "feature/b", { "shared.txt": "b\n" });

      const pending = queue.submit({
        type: "merge",
        command: "mandible auth merge feature/b --into main",
        title: "Merge feature/b",
        repo: "repo",
        base_branch: "main",
        head_branch: "feature/b",
        cwd: repo,
      });
      const now = 100;
      db.prepare(
        `INSERT INTO auth_requests (
          id, session_id, type, command, title, cwd, repo, base_branch, head_branch,
          status, created_at, updated_at, expires_at, output, execution_mode,
          files_changed, additions, deletions, approval_source
        ) VALUES (
          'merge-a', NULL, 'merge', 'mandible auth merge feature/a --into main',
          'Merge feature/a', ?, 'repo', 'main', 'feature/a',
          'executing', ?, ?, ?, '', 'daemon', 0, 0, 0, 'manual'
        )`
      ).run(repo, now, now, now + 1000);

      git(repo, ["checkout", "main"]);
      git(repo, ["merge", "--no-ff", "feature/a", "-m", "merge feature/a"]);
      queue.setResult("merge-a", 0, "ok");

      const invalidated = queue.getRequest(pending.id);
      expect(invalidated?.status).toBe("needs_rebase");
      expect(invalidated?.error).toContain("Needs rebase");
      expect(events.some((event) => event.event === "auth:needs_rebase")).toBe(true);
      expect(events.some((event) => {
        const data = event.data as Record<string, unknown>;
        return event.event === "auth:resolved" && data.request_id === pending.id;
      })).toBe(true);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it("expires stale requests", () => {
    let now = 0;
    const queue = createQueue({ ttlMs: 10, now: () => now });

    const request = queue.submit({ command: "echo old", title: "Old" });

    now = 20;
    const fetched = queue.getRequest(request.id);
    expect(fetched?.status).toBe("expired");
  });

  it("allows updating fields on a failed (non-zero exit) request", () => {
    const queue = createQueue();

    const request = queue.submit({
      command: "echo fail",
      title: "Fail",
      cwd: "/wrong/path"
    });
    // Simulate a failed execution
    queue.setResult(request.id, 1, "error output", "command failed");

    const failed = queue.getRequest(request.id);
    expect(failed?.status).toBe("completed");
    expect(failed?.exit_code).toBe(1);

    // Should be able to update fields on a failed request
    const updated = queue.update(request.id, { cwd: "/correct/path" });
    expect(updated.cwd).toBe("/correct/path");
    expect(updated.status).toBe("completed"); // Status unchanged
  });

  it("allows updating fields and resetting failed request to pending", () => {
    const events: SseEvent[] = [];
    const queue = createQueue({
      broadcast: (event) => {
        events.push(event);
      }
    });

    const request = queue.submit({
      command: "mandible auth merge feature/foo",
      title: "Merge foo",
      cwd: "/wrong/repo"
    });
    queue.setResult(request.id, 1, "Not a git repository", "cwd was wrong");

    // Update cwd and reset to pending in a single PUT
    const updated = queue.update(request.id, {
      cwd: "/correct/repo",
      status: "pending"
    });

    expect(updated.status).toBe("pending");
    expect(updated.cwd).toBe("/correct/repo");
    expect(updated.exit_code).toBeNull();
    expect(updated.error).toBeNull();
    expect(updated.output).toBe("");
    expect(updated.resolved_at).toBeNull();

    // Should broadcast auth:new for retry
    expect(events.some((e) => e.event === "auth:new" && (e.data as { request: { id: string } }).request.id === updated.id)).toBe(true);
  });

  it("allows resetting failed request to pending with status only (no other fields)", () => {
    const queue = createQueue();

    const request = queue.submit({ command: "echo retry", title: "Retry" });
    queue.setResult(request.id, 1, "failed", "oops");

    const updated = queue.update(request.id, { status: "pending" });
    expect(updated.status).toBe("pending");
    expect(updated.exit_code).toBeNull();
  });

  it("rejects updating a successfully completed request", () => {
    const queue = createQueue();

    const request = queue.submit({ command: "echo ok", title: "OK" });
    queue.setResult(request.id, 0, "success");

    expect(() => queue.update(request.id, { title: "New title" })).toThrow();
  });

  it("allows updating fields on an expired request", () => {
    let now = 0;
    const queue = createQueue({ ttlMs: 10, now: () => now });

    const request = queue.submit({
      command: "echo stale",
      title: "Stale",
      cwd: "/old/path"
    });

    now = 20; // Trigger expiry

    const updated = queue.update(request.id, {
      cwd: "/new/path",
      status: "pending"
    });

    expect(updated.status).toBe("pending");
    expect(updated.cwd).toBe("/new/path");
  });

  it("allows updating an approved request (Bug: 68aa754 — stuck execution recovery)", () => {
    const queue = createQueue();

    const request = queue.submit({
      command: "echo approved",
      title: "Approved",
      execution_mode: "remote" // remote so it doesn't auto-execute
    });
    queue.approve(request.id);

    // Approved requests can be modified for recovery scenarios (force-dismiss,
    // reset to pending after interrupted execution, etc.)
    const updated = queue.update(request.id, { title: "Changed" });
    expect(updated.title).toBe("Changed");
    expect(updated.status).toBe("executing");
  });

  it("fires SSE events for new, output, resolved", async () => {
    const events: SseEvent[] = [];
    const queue = createQueue({
      broadcast: (event) => {
        events.push(event);
      }
    });

    const request = queue.submit({
      command: "node -e \"console.log('stream')\"",
      title: "Stream"
    });

    expect(events.some((event) => event.event === "auth:new")).toBe(true);

    queue.approve(request.id);
    await waitForStatus(queue, request.id, "completed");

    expect(events.some((event) => event.event === "auth:output")).toBe(true);
    expect(events.some((event) => event.event === "auth:resolved")).toBe(true);
  });

  // Bug: 297677f — issues field tests
  it("stores issue references and closures separately", () => {
    const queue = createQueue();

    const request = queue.submit({
      command: "echo merge",
      title: "Merge with typed issue links",
      issue_references: ["umbrella123"],
      issue_closures: ["done456"]
    });

    const fetched = queue.getRequest(request.id);
    expect(fetched?.issue_references).toEqual(["umbrella123"]);
    expect(fetched?.issue_closures).toEqual(["done456"]);
    expect(fetched?.issues).toBeNull();
  });

  it("maps legacy issues to issue_closures for compatibility", () => {
    const queue = createQueue();

    const request = queue.submit({
      command: "echo merge",
      title: "Merge with legacy closes",
      issues: ["legacy123"]
    });

    const fetched = queue.getRequest(request.id);
    expect(fetched?.issue_closures).toEqual(["legacy123"]);
    expect(fetched?.issues).toEqual(["legacy123"]);
  });

  it("stores issues on submit and retrieves them", () => {
    const queue = createQueue();

    const request = queue.submit({
      command: "echo merge",
      title: "Merge with closes",
      issues: ["abc123", "def456"]
    });

    const fetched = queue.getRequest(request.id);
    expect(fetched?.issues).toEqual(["abc123", "def456"]);
  });

  it("stores null issues when not provided", () => {
    const queue = createQueue();

    const request = queue.submit({
      command: "echo merge",
      title: "Merge without closes"
    });

    const fetched = queue.getRequest(request.id);
    expect(fetched?.issues).toBeNull();
  });

  it("allows updating issues on a pending request", () => {
    const queue = createQueue();

    const request = queue.submit({
      command: "echo merge",
      title: "Update closes"
    });

    const updated = queue.update(request.id, {
      issues: ["umbrella123"]
    });

    expect(updated.issues).toEqual(["umbrella123"]);
  });

  it("allows setting issues to null via update", () => {
    const queue = createQueue();

    const request = queue.submit({
      command: "echo merge",
      title: "Clear closes",
      issues: ["abc123"]
    });

    const updated = queue.update(request.id, {
      issues: null
    });

    expect(updated.issues).toBeNull();
  });

  it("preserves issues through retry-via-update", () => {
    const queue = createQueue();

    const request = queue.submit({
      command: "echo retry",
      title: "Retry with closes",
      issues: ["umbrella789"]
    });

    // Simulate failed execution
    queue.setResult(request.id, 1, "error", "failed");

    // Reset to pending — issues should survive
    const updated = queue.update(request.id, { status: "pending" });
    expect(updated.status).toBe("pending");
    expect(updated.issues).toEqual(["umbrella789"]);
  });

  // Bug: 93c57c4 — outcome field tests
  describe("outcome field in resolved payload", () => {
    it("resolvedPayload has outcome=succeeded when completed with exit_code=0", () => {
      const events: SseEvent[] = [];
      const queue = createQueue({ broadcast: (e) => events.push(e) });

      const request = queue.submit({ command: "echo ok", title: "Success" });
      queue.setResult(request.id, 0, "ok");

      const resolved = events.find((e) => e.event === "auth:resolved");
      expect(resolved).toBeTruthy();
      const data = resolved!.data as Record<string, unknown>;
      expect(data.outcome).toBe("succeeded");
      expect(data.status).toBe("completed");
    });

    it("resolvedPayload has outcome=failed when completed with exit_code=1", () => {
      const events: SseEvent[] = [];
      const queue = createQueue({ broadcast: (e) => events.push(e) });

      const request = queue.submit({ command: "echo fail", title: "Failure" });
      queue.setResult(request.id, 1, "error output", "command failed");

      const resolved = events.find((e) => e.event === "auth:resolved");
      expect(resolved).toBeTruthy();
      const data = resolved!.data as Record<string, unknown>;
      expect(data.outcome).toBe("failed");
      expect(data.status).toBe("completed");
    });

    it("resolvedPayload has outcome=rejected when request is rejected", () => {
      const events: SseEvent[] = [];
      const queue = createQueue({ broadcast: (e) => events.push(e) });

      const request = queue.submit({ command: "echo nope", title: "Reject" });
      queue.reject(request.id, "Not approved");

      const resolved = events.find((e) => e.event === "auth:resolved");
      expect(resolved).toBeTruthy();
      const data = resolved!.data as Record<string, unknown>;
      expect(data.outcome).toBe("rejected");
      expect(data.status).toBe("rejected");
    });

    it("resolvedPayload has outcome=dismissed when request is dismissed", () => {
      const events: SseEvent[] = [];
      const queue = createQueue({ broadcast: (e) => events.push(e) });

      const request = queue.submit({ command: "echo dismiss", title: "Dismiss" });
      queue.dismiss(request.id);

      const resolved = events.find((e) => e.event === "auth:resolved");
      expect(resolved).toBeTruthy();
      const data = resolved!.data as Record<string, unknown>;
      expect(data.outcome).toBe("dismissed");
      expect(data.status).toBe("dismissed");
    });

    it("resolvedPayload has outcome=null when request is still pending (non-terminal state)", () => {
      const events: SseEvent[] = [];
      const queue = createQueue({ broadcast: (e) => events.push(e) });

      // Use execution_mode=remote so it stays in executing without running
      const request = queue.submit({
        command: "echo pending",
        title: "Pending",
        execution_mode: "remote"
      });
      queue.approve(request.id);

      // auth:new fires but not auth:resolved yet — check the request directly
      const fetched = queue.getRequest(request.id);
      expect(fetched?.status).toBe("executing");
      // No auth:resolved event should have fired yet
      const resolved = events.find((e) => e.event === "auth:resolved");
      expect(resolved).toBeUndefined();
    });

    it("resolvedPayload has outcome=expired when request expires", () => {
      let now = 0;
      const events: SseEvent[] = [];
      const queue = createQueue({
        ttlMs: 10,
        now: () => now,
        broadcast: (e) => events.push(e)
      });

      const request = queue.submit({ command: "echo stale", title: "Stale" });

      now = 20; // trigger expiry
      queue.expireStale();

      const resolved = events.find((e) => e.event === "auth:resolved");
      expect(resolved).toBeTruthy();
      const data = resolved!.data as Record<string, unknown>;
      expect(data.outcome).toBe("expired");
      expect(data.status).toBe("expired");
    });
  });

  // Bug: 929c6d0 — error output in resolved payload and error field
  describe("error output in resolved events", () => {
    it("includes error_output in resolved payload when exit_code is non-zero", () => {
      const events: SseEvent[] = [];
      const queue = createQueue({ broadcast: (e) => events.push(e) });

      const request = queue.submit({ command: "echo fail", title: "Failure" });
      // Append some output as if the executor streamed it — this goes into the
      // DB output column. setResult with a non-empty output replaces it, so we
      // pass the same content through setResult to simulate what happens when
      // the executor finishes (output is the accumulated buffer).
      const output = "line 1\nline 2\nline 3\nerror: merge conflict\n";
      queue.setResult(request.id, 1, output, "command failed");

      const resolved = events.find((e) => e.event === "auth:resolved");
      expect(resolved).toBeTruthy();
      const data = resolved!.data as Record<string, unknown>;
      expect(data.error_output).toBeTruthy();
      expect(String(data.error_output)).toContain("error: merge conflict");
    });

    it("does not include error_output when exit_code is 0", () => {
      const events: SseEvent[] = [];
      const queue = createQueue({ broadcast: (e) => events.push(e) });

      const request = queue.submit({ command: "echo ok", title: "Success" });
      queue.appendOutput(request.id, "Merge made by recursive.\n");
      queue.setResult(request.id, 0, "ok");

      const resolved = events.find((e) => e.event === "auth:resolved");
      expect(resolved).toBeTruthy();
      const data = resolved!.data as Record<string, unknown>;
      expect(data.error_output).toBeNull();
    });

    it("populates error field with tail of output for daemon-executed failures", async () => {
      const events: SseEvent[] = [];
      const queue = createQueue({
        broadcast: (e) => events.push(e),
        executor: async () => ({
          exit_code: 1,
          signal: null,
          stdout: "",
          stderr: "fatal: not a git repo\nfatal: merge failed\n",
          output: "fatal: not a git repo\nfatal: merge failed\n",
          started_at: Date.now(),
          finished_at: Date.now()
        })
      });

      const request = queue.submit({
        command: "git merge --gpg-sign feature/x",
        title: "Merge feature/x"
      });
      queue.approve(request.id);
      await waitForStatus(queue, request.id, "completed");

      const completed = queue.getRequest(request.id);
      expect(completed?.exit_code).toBe(1);
      // Bug: 929c6d0 — error field should now contain the tail of executor output
      expect(completed?.error).toBeTruthy();
      expect(completed?.error).toContain("fatal: merge failed");
    });

    it("preserves explicit error message over output tail when executor throws", async () => {
      const events: SseEvent[] = [];
      const queue = createQueue({
        broadcast: (e) => events.push(e),
        executor: async () => {
          throw new Error("Spawn failed: ENOENT");
        }
      });

      const request = queue.submit({
        command: "nonexistent-command",
        title: "Bad command"
      });
      queue.approve(request.id);
      await waitForStatus(queue, request.id, "completed");

      const completed = queue.getRequest(request.id);
      expect(completed?.exit_code).toBe(1);
      // When the executor throws, the error message from the exception is used
      expect(completed?.error).toBe("Spawn failed: ENOENT");
    });

    it("error_output is truncated to last 20 lines", () => {
      const events: SseEvent[] = [];
      const queue = createQueue({ broadcast: (e) => events.push(e) });

      const request = queue.submit({ command: "echo fail", title: "Long output" });
      // Generate 30 lines of output (no trailing newline so split gives exactly 30)
      const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n");
      queue.setResult(request.id, 1, lines, "failed");

      const resolved = events.find((e) => e.event === "auth:resolved");
      expect(resolved).toBeTruthy();
      const data = resolved!.data as Record<string, unknown>;
      const errorOutput = String(data.error_output);
      // Should contain lines 11-30 but not lines 1-10
      expect(errorOutput).toContain("line 30");
      expect(errorOutput).toContain("line 11");
      expect(errorOutput).not.toContain("line 10\n");
    });
  });

  // Bug: 03d6cb0 — self-rebuild delay: auth:resolved must broadcast BEFORE
  // the daemon schedules a process.exit for self-merges.
  describe("self-rebuild event ordering", () => {
    it("broadcasts auth:resolved before scheduling self-rebuild exit", async () => {
      const events: SseEvent[] = [];
      let exitScheduled = false;
      let resolvedBeforeExit = false;

      // Mock setTimeout to detect when process.exit is scheduled
      const originalSetTimeout = globalThis.setTimeout;
      const setTimeoutSpy = (fn: (...args: unknown[]) => void, ms?: number) => {
        // The self-rebuild uses a 2000ms timeout for process.exit
        if (ms === 2000) {
          exitScheduled = true;
          // Don't actually call process.exit — just record it
          return originalSetTimeout(() => {}, 0);
        }
        return originalSetTimeout(fn, ms);
      };
      globalThis.setTimeout = setTimeoutSpy as typeof globalThis.setTimeout;

      try {
        const queue = createQueue({
          broadcast: (event) => {
            events.push(event);
            if (event.event === "auth:resolved") {
              // At the moment auth:resolved fires, exit should NOT yet be scheduled
              resolvedBeforeExit = !exitScheduled;
            }
          },
          executor: async () => ({
            exit_code: 0,
            signal: null,
            stdout: "Merge made by recursive.\n",
            stderr: "",
            output: "Merge made by recursive.\n",
            started_at: Date.now(),
            finished_at: Date.now()
          })
        });

        const request = queue.submit({
          command: "mandible auth merge main",
          title: "Self-merge",
          repo: "mandible",
          base_branch: "main",
          head_branch: "feature/self-fix",
          execution_mode: "daemon"
        });

        queue.approve(request.id);
        await waitForStatus(queue, request.id, "completed");
        // Give the post-execution code time to run (setTimeout scheduling)
        await new Promise((resolve) => originalSetTimeout(resolve, 100));

        // Verify auth:resolved was broadcast
        expect(events.some((e) => e.event === "auth:resolved")).toBe(true);
        // Verify it fired before the exit was scheduled
        expect(resolvedBeforeExit).toBe(true);
        // Verify exit WAS scheduled (the self-rebuild detection works)
        expect(exitScheduled).toBe(true);
      } finally {
        globalThis.setTimeout = originalSetTimeout;
      }
    });

    it("uses a 2-second delay for self-rebuild exit to allow event delivery", async () => {
      let exitDelayMs: number | undefined;

      const originalSetTimeout = globalThis.setTimeout;
      const setTimeoutSpy = (fn: (...args: unknown[]) => void, ms?: number) => {
        // Capture the delay used for the self-rebuild exit
        if (ms !== undefined && ms >= 1000) {
          exitDelayMs = ms;
          return originalSetTimeout(() => {}, 0);
        }
        return originalSetTimeout(fn, ms);
      };
      globalThis.setTimeout = setTimeoutSpy as typeof globalThis.setTimeout;

      try {
        const queue = createQueue({
          executor: async () => ({
            exit_code: 0,
            signal: null,
            stdout: "Merge made by recursive.\n",
            stderr: "",
            output: "Merge made by recursive.\n",
            started_at: Date.now(),
            finished_at: Date.now()
          })
        });

        const request = queue.submit({
          command: "mandible auth merge main",
          title: "Self-merge delay test",
          repo: "mandible",
          base_branch: "main",
          head_branch: "feature/delay-test",
          execution_mode: "daemon"
        });

        queue.approve(request.id);
        await waitForStatus(queue, request.id, "completed");
        await new Promise((resolve) => originalSetTimeout(resolve, 100));

        // Bug: 03d6cb0 — the delay must be >= 2000ms to give the channel
        // server time to receive and process the auth:resolved event.
        expect(exitDelayMs).toBe(2000);
      } finally {
        globalThis.setTimeout = originalSetTimeout;
      }
    });
  });
});
