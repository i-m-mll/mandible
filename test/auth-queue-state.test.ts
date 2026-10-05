/**
 * @vitest-environment node
 *
 * Queue state: submission, storage, updates, issue links, resolved payloads.
 *
 * Split out of the former 6,122-line `test/auth-queue.test.ts` (issue 9e40a31).
 * Vitest parallelises across files and never within one, so that single file was
 * 98.9% of the default gate's wall clock. Test names and assertions are
 * unchanged; the shared helpers live in `test/helpers/auth-queue-fixtures.ts`.
 */
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AuthQueue, AuthQueueError } from "../src/auth-queue.js";
import type { SseEvent } from "../src/types.js";
import { seedHistoricalAuthExecution, seedHistoricalAuthCompletion, approveFixtureRequest, createMigratedDb, createQueue, git, waitForStatus } from "./helpers/auth-queue-fixtures.js";
import { addCredential, getOperator } from "../src/users/store.js";

describe("auth queue", () => {
  it("submits request and returns pending status", async () => {
    const queue = createQueue();

    const request = queue.submit({ type: "commit", command: "echo hello", title: "Test" });
    expect(request.id).toBeTruthy();

    const fetched = queue.getRequest(request.id);
    expect(fetched?.status).toBe("pending");
  });

  it("approves request, executes command, stores result", async () => {
    const queue = createQueue();

    const request = queue.submit({ type: "commit",
      command: "node -e \"console.log('ok')\"",
      title: "Run command"
    });

    const approved = await approveFixtureRequest(queue, request.id);
    expect(approved.status).toBe("executing");

    const resolved = await waitForStatus(queue, request.id, "completed");
    expect(resolved?.exit_code).toBe(0);
    expect(String(resolved?.output)).toContain("ok");
  });

  it("stores git context fields on submit", async () => {
    const queue = createQueue();

    const request = queue.submit({ type: "commit",
      command: "echo git",
      title: "Git",
      repo: "mandible",
      base_branch: "main",
      head_branch: "feature/demo",
      merge_head_sha: "1111111111111111111111111111111111111111",
      files_changed: 3,
      additions: 10,
      deletions: 2,
      execution_mode: "remote"
    });

    const fetched = queue.getRequest(request.id);
    expect(fetched?.repo).toBe("mandible");
    expect(fetched?.base_branch).toBe("main");
    expect(fetched?.head_branch).toBe("feature/demo");
    expect(fetched?.merge_head_sha).toBe("1111111111111111111111111111111111111111");
    expect(fetched?.files_changed).toBe(3);
    expect(fetched?.additions).toBe(10);
    expect(fetched?.deletions).toBe(2);
    expect(fetched?.execution_mode).toBe("remote");
  });

  it("appends output chunks only while the request is executing", async () => {
    const db = createMigratedDb();
    const queue = new AuthQueue({ db });

    const request = queue.submit({ type: "commit", command: "echo output", title: "Output" });
    // Issue 08a5f04 (review F1) — output is execution evidence: appends to a
    // request that is not executing are refused so a marker can never be
    // laundered into a pending or resolved row.
    expect(() => queue.appendOutput(request.id, "early")).toThrow(AuthQueueError);

    db.prepare("UPDATE auth_requests SET status = 'executing' WHERE id = ?").run(request.id);
    queue.appendOutput(request.id, "hello");
    queue.appendOutput(request.id, " world");

    const fetched = queue.getRequest(request.id);
    expect(fetched?.output).toBe("hello world");

    db.prepare("UPDATE auth_requests SET status = 'completed' WHERE id = ?").run(request.id);
    expect(() => queue.appendOutput(request.id, "late")).toThrow(AuthQueueError);
    expect(queue.getRequest(request.id)?.output).toBe("hello world");
  });

  it("sets result and completes request", async () => {
    const queue = createQueue();

    const request = queue.submit({ type: "commit", command: "echo done", title: "Done" });
    await approveFixtureRequest(queue, request.id);
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

    const request = queue.submit({ type: "commit",
      command: "echo remote",
      title: "Remote",
      execution_mode: "remote"
    });

    const approved = await approveFixtureRequest(queue, request.id);
    expect(approved.status).toBe("executing");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(calls).toHaveLength(0);
  });

  it("recovers stale executing requests with partial output on restart", async () => {
    let now = 0;
    const db = createMigratedDb();
    const queue = new AuthQueue({ db, now: () => now });
    const request = queue.submit({
      command: "mandible auth merge feature/partial --into main",
      title: "Partial execution",
      base_branch: "main",
      head_branch: "feature/partial",
      execution_mode: "remote"
    });
    seedHistoricalAuthExecution(queue, request.id);
    queue.appendOutput(request.id, "Executing merge command...\n");
    queue.dispose();

    now = 6 * 60 * 1000;
    const events: SseEvent[] = [];
    const restarted = new AuthQueue({ db, now: () => now, broadcast: (event) => events.push(event) });
    try {
      await vi.waitFor(() => expect(restarted.getRequest(request.id)?.status).toBe("completed"));
      const recovered = restarted.getRequest(request.id);
      expect(recovered?.exit_code).toBe(1);
      expect(recovered?.error).toContain("missing repository, base branch, or head branch metadata");
      expect(events.some((event) => event.event === "auth:resolved")).toBe(true);
    } finally {
      restarted.dispose();
      db.close();
    }
  });

  it("leaves copied auth state unchanged when background maintenance is disabled", async () => {
    const db = createMigratedDb();
    const initial = new AuthQueue({ db, now: () => 0 });
    const request = initial.submit({
      command: "mandible auth merge feature/preview",
      title: "Copied preview request",
      execution_mode: "remote",
    });
    db.prepare(
      "UPDATE auth_requests SET status = 'executing', updated_at = 0 WHERE id = ?",
    ).run(request.id);
    initial.dispose();

    const preview = new AuthQueue({
      db,
      now: () => 6 * 60 * 1_000,
      backgroundMaintenance: false,
    });
    try {
      expect(preview.getRequest(request.id)?.status).toBe("executing");
    } finally {
      preview.dispose();
      db.close();
    }
  });

  it("rejects request", async () => {
    const queue = createQueue();

    const request = queue.submit({ type: "commit", command: "echo nope", title: "Reject" });
    const rejected = queue.reject(request.id, "No");

    expect(rejected.status).toBe("rejected");

    const fetched = queue.getRequest(request.id);
    expect(fetched?.status).toBe("rejected");
  });

  it("queues multiple requests FIFO and supports out-of-order approval", async () => {
    let time = 1;
    const queue = createQueue({ now: () => time++ });

    const first = queue.submit({ type: "commit", command: "echo one", title: "One" });
    const second = queue.submit({ type: "commit",
      command: "node -e \"console.log('two')\"",
      title: "Two"
    });

    const pending = queue.listPending();
    const ids = pending.map((r) => r.id);
    expect(ids).toEqual([first.id, second.id]);

    await approveFixtureRequest(queue, second.id);
    const resolved = await waitForStatus(queue, second.id, "completed");
    expect(resolved?.exit_code).toBe(0);

    const stillPending = queue.getRequest(first.id);
    expect(stillPending?.status).toBe("pending");
  });

  it("expires stale requests", async () => {
    let now = 0;
    const queue = createQueue({ ttlMs: 10, now: () => now });

    const request = queue.submit({ type: "commit", command: "echo old", title: "Old" });

    now = 20;
    const fetched = queue.getRequest(request.id);
    expect(fetched?.status).toBe("expired");
  });

  it("refuses to revise a failed terminal request", async () => {
    const queue = createQueue();

    const request = queue.submit({ type: "commit",
      command: "echo fail",
      title: "Fail",
      cwd: "/wrong/path"
    });
    // Simulate a failed execution
    seedHistoricalAuthCompletion(queue, request.id, "error output", 1, "command failed");

    const failed = queue.getRequest(request.id);
    expect(failed?.status).toBe("completed");
    expect(failed?.exit_code).toBe(1);

    expect(() => queue.update(request.id, { cwd: "/correct/path" })).toThrow("Only pending requests");
    expect(queue.getRequest(request.id)?.cwd).toBe("/wrong/path");
  });

  it("allows updating merge head sha on a pending request", async () => {
    const queue = createQueue();

    const request = queue.submit({
      command: "mandible auth merge feature/foo --into main",
      title: "Merge foo",
      merge_head_sha: "1111111111111111111111111111111111111111",
    });

    const updated = queue.update(request.id, {
      merge_head_sha: "2222222222222222222222222222222222222222",
    });

    expect(updated.merge_head_sha).toBe("2222222222222222222222222222222222222222");
    expect(queue.getRequest(request.id)?.merge_head_sha).toBe(
      "2222222222222222222222222222222222222222",
    );
  });

  it("requires retry before revising a failed request", async () => {
    const events: SseEvent[] = [];
    const queue = createQueue({
      broadcast: (event) => {
        events.push(event);
      }
    });

    // A retained failed remote request can be explicitly retried and edited.
    const request = queue.submit({
      command: "mandible auth merge feature/foo --into main",
      title: "Merge foo",
      base_branch: "main",
      head_branch: "feature/foo",
      execution_mode: "remote",
    });
    seedHistoricalAuthCompletion(queue, request.id, "Not a git repository", 1, "cwd was wrong");

    expect(() => queue.update(request.id, {
      cwd: "/correct/repo",
      status: "pending"
    })).toThrow("Only pending requests");

    const retried = queue.retry(request.id);
    const updated = queue.update(retried.id, { cwd: "/correct/repo" });

    expect(updated.status).toBe("pending");
    expect(updated.cwd).toBe("/correct/repo");
    expect(updated.exit_code).toBeNull();
    expect(updated.error).toBeNull();
    expect(updated.output).toBe("");
    expect(updated.resolved_at).toBeNull();

    // Should broadcast auth:new for retry
    expect(events.some((e) => e.event === "auth:new" && (e.data as { request: { id: string } }).request.id === updated.id)).toBe(true);
  });

  it("retries a failed request through the explicit retry operation", async () => {
    const queue = createQueue();

    const request = queue.submit({ type: "commit", command: "echo retry", title: "Retry" });
    await approveFixtureRequest(queue, request.id);
    queue.setResult(request.id, 1, "failed", "oops");

    expect(() => queue.update(request.id, { status: "pending" })).toThrow("Only pending requests");
    const updated = queue.retry(request.id);
    expect(updated.status).toBe("pending");
    expect(updated.exit_code).toBeNull();
  });

  it("rejects updating a successfully completed request", async () => {
    const queue = createQueue();

    const request = queue.submit({ type: "commit", command: "echo ok", title: "OK" });
    await approveFixtureRequest(queue, request.id);
    queue.setResult(request.id, 0, "success");

    expect(() => queue.update(request.id, { title: "New title" })).toThrow();
  });

  it("refuses to revise an expired terminal request", async () => {
    let now = 0;
    const queue = createQueue({ ttlMs: 10, now: () => now });

    const request = queue.submit({ type: "commit",
      command: "echo stale",
      title: "Stale",
      cwd: "/old/path"
    });

    now = 20; // Trigger expiry

    expect(() => queue.update(request.id, {
      cwd: "/new/path",
      status: "pending"
    })).toThrow("Only pending requests");
    expect(queue.getRequest(request.id)?.cwd).toBe("/old/path");
  });

  it("refuses to revise an approved request", async () => {
    const queue = createQueue();

    const request = queue.submit({ type: "commit",
      command: "echo approved",
      title: "Approved",
      execution_mode: "remote" // remote so it doesn't auto-execute
    });
    await approveFixtureRequest(queue, request.id);

    expect(() => queue.update(request.id, { title: "Changed" })).toThrow("Only pending requests");
    expect(queue.getRequest(request.id)?.title).toBe("Approved");
  });

  it("fires SSE events for new, output, resolved", async () => {
    const events: SseEvent[] = [];
    const queue = createQueue({
      broadcast: (event) => {
        events.push(event);
      }
    });

    const request = queue.submit({ type: "commit",
      command: "node -e \"console.log('stream')\"",
      title: "Stream"
    });

    expect(events.some((event) => event.event === "auth:new")).toBe(true);

    await approveFixtureRequest(queue, request.id);
    await waitForStatus(queue, request.id, "completed");

    expect(events.some((event) => event.event === "auth:output")).toBe(true);
    expect(events.some((event) => event.event === "auth:resolved")).toBe(true);
  });

  it("stores issue references and closures separately", async () => {
    const queue = createQueue();

    const request = queue.submit({ type: "commit",
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

  it("maps legacy issues to issue_closures for compatibility", async () => {
    const queue = createQueue();

    const request = queue.submit({ type: "commit",
      command: "echo merge",
      title: "Merge with legacy closes",
      issues: ["legacy123"]
    });

    const fetched = queue.getRequest(request.id);
    expect(fetched?.issue_closures).toEqual(["legacy123"]);
    expect(fetched?.issues).toEqual(["legacy123"]);
  });

  it("stores issues on submit and retrieves them", async () => {
    const queue = createQueue();

    const request = queue.submit({ type: "commit",
      command: "echo merge",
      title: "Merge with closes",
      issues: ["abc123", "def456"]
    });

    const fetched = queue.getRequest(request.id);
    expect(fetched?.issues).toEqual(["abc123", "def456"]);
  });

  it("stores null issues when not provided", async () => {
    const queue = createQueue();

    const request = queue.submit({ type: "commit",
      command: "echo merge",
      title: "Merge without closes"
    });

    const fetched = queue.getRequest(request.id);
    expect(fetched?.issues).toBeNull();
  });

  it("allows updating issues on a pending request", async () => {
    const queue = createQueue();

    const request = queue.submit({ type: "commit",
      command: "echo merge",
      title: "Update closes"
    });

    const updated = queue.update(request.id, {
      issues: ["umbrella123"]
    });

    expect(updated.issues).toEqual(["umbrella123"]);
  });

  it("allows setting issues to null via update", async () => {
    const queue = createQueue();

    const request = queue.submit({ type: "commit",
      command: "echo merge",
      title: "Clear closes",
      issues: ["abc123"]
    });

    const updated = queue.update(request.id, {
      issues: null
    });

    expect(updated.issues).toBeNull();
  });

  it("preserves issues through explicit retry", async () => {
    const queue = createQueue();

    const request = queue.submit({ type: "commit",
      command: "echo retry",
      title: "Retry with closes",
      issues: ["umbrella789"]
    });

    // Simulate failed execution
    await approveFixtureRequest(queue, request.id);
    queue.setResult(request.id, 1, "error", "failed");

    const updated = queue.retry(request.id);
    expect(updated.status).toBe("pending");
    expect(updated.issues).toEqual(["umbrella789"]);
  });

  describe("outcome field in resolved payload", () => {
    it("resolvedPayload has outcome=succeeded when completed with exit_code=0", async () => {
      const events: SseEvent[] = [];
      const db = createMigratedDb();
      const queue = new AuthQueue({ db, broadcast: (e) => events.push(e) });

      const request = queue.submit({ type: "commit", command: "echo ok", title: "Success" });
      await approveFixtureRequest(queue, request.id);
      queue.setResult(request.id, 0, "ok");

      const resolved = events.find((e) => e.event === "auth:resolved");
      expect(resolved).toBeTruthy();
      const data = resolved!.data as Record<string, unknown>;
      expect(data.outcome).toBe("succeeded");
      expect(data.status).toBe("completed");
    });

    it("resolvedPayload has outcome=failed when completed with exit_code=1", async () => {
      const events: SseEvent[] = [];
      const queue = createQueue({ broadcast: (e) => events.push(e) });

      const request = queue.submit({ type: "commit", command: "echo fail", title: "Failure" });
      await approveFixtureRequest(queue, request.id);
      queue.setResult(request.id, 1, "error output", "command failed");

      const resolved = events.find((e) => e.event === "auth:resolved");
      expect(resolved).toBeTruthy();
      const data = resolved!.data as Record<string, unknown>;
      expect(data.outcome).toBe("failed");
      expect(data.status).toBe("completed");
    });

    it("resolvedPayload has outcome=rejected when request is rejected", async () => {
      const events: SseEvent[] = [];
      const queue = createQueue({ broadcast: (e) => events.push(e) });

      const request = queue.submit({ type: "commit", command: "echo nope", title: "Reject" });
      queue.reject(request.id, "Not approved");

      const resolved = events.find((e) => e.event === "auth:resolved");
      expect(resolved).toBeTruthy();
      const data = resolved!.data as Record<string, unknown>;
      expect(data.outcome).toBe("rejected");
      expect(data.status).toBe("rejected");
    });

    it("resolvedPayload has outcome=withdrawn when requester withdraws", async () => {
      const events: SseEvent[] = [];
      const db = createMigratedDb();
      const queue = new AuthQueue({ db, broadcast: (e) => events.push(e) });
      const operator = getOperator(db)!;
      const credential = addCredential(db, operator.id, {
        type: "api_token",
        fingerprint: `withdraw-${crypto.randomUUID()}`,
      });

      const request = queue.submit({
        command: "echo withdraw",
        title: "Withdraw",
        type: "commit",
      });
      queue.withdraw(request.id, "No longer needed", {
        user_id: operator.id,
        evidence_method: "api_token",
        evidence_id: null,
        credential_id: credential.id,
        authority_path: "operator_recovery",
      }, 1, 0);

      const resolved = events.find((e) => e.event === "auth:resolved");
      expect(resolved).toBeTruthy();
      const data = resolved!.data as Record<string, unknown>;
      expect(data.outcome).toBe("withdrawn");
      expect(data.status).toBe("withdrawn");
    });

    it("resolvedPayload has outcome=null when request is still pending (non-terminal state)", async () => {
      const events: SseEvent[] = [];
      const queue = createQueue({ broadcast: (e) => events.push(e) });

      // Use execution_mode=remote so it stays in executing without running
      const request = queue.submit({ type: "commit",
        command: "echo pending",
        title: "Pending",
        execution_mode: "remote"
      });
      await approveFixtureRequest(queue, request.id);

      // auth:new fires but not auth:resolved yet — check the request directly
      const fetched = queue.getRequest(request.id);
      expect(fetched?.status).toBe("executing");
      // No auth:resolved event should have fired yet
      const resolved = events.find((e) => e.event === "auth:resolved");
      expect(resolved).toBeUndefined();
    });

    it("resolvedPayload has outcome=expired when request expires", async () => {
      let now = 0;
      const events: SseEvent[] = [];
      const queue = createQueue({
        ttlMs: 10,
        now: () => now,
        broadcast: (e) => events.push(e)
      });

      const request = queue.submit({ type: "commit", command: "echo stale", title: "Stale" });

      now = 20; // trigger expiry
      queue.expireStale();

      const resolved = events.find((e) => e.event === "auth:resolved");
      expect(resolved).toBeTruthy();
      const data = resolved!.data as Record<string, unknown>;
      expect(data.outcome).toBe("expired");
      expect(data.status).toBe("expired");
    });
  });

  describe("error output in resolved events", () => {
    it("includes error_output in resolved payload when exit_code is non-zero", async () => {
      const events: SseEvent[] = [];
      const queue = createQueue({ broadcast: (e) => events.push(e) });

      const request = queue.submit({ type: "commit", command: "echo fail", title: "Failure" });
      // Append some output as if the executor streamed it — this goes into the
      // DB output column. setResult with a non-empty output replaces it, so we
      // pass the same content through setResult to simulate what happens when
      // the executor finishes (output is the accumulated buffer).
      const output = "line 1\nline 2\nline 3\nerror: merge conflict\n";
      await approveFixtureRequest(queue, request.id);
      queue.setResult(request.id, 1, output, "command failed");

      const resolved = events.find((e) => e.event === "auth:resolved");
      expect(resolved).toBeTruthy();
      const data = resolved!.data as Record<string, unknown>;
      expect(data.error_output).toBeTruthy();
      expect(String(data.error_output)).toContain("error: merge conflict");
    });

    it("does not include error_output when exit_code is 0", async () => {
      const events: SseEvent[] = [];
      const queue = createQueue({ broadcast: (e) => events.push(e) });

      const request = queue.submit({ type: "commit", command: "echo ok", title: "Success" });
      await approveFixtureRequest(queue, request.id);
      queue.setResult(request.id, 0, "Merge made by recursive.\nok");

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

      const request = queue.submit({ type: "commit",
        command: "git merge --gpg-sign feature/x",
        title: "Merge feature/x"
      });
      await approveFixtureRequest(queue, request.id);
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

      const request = queue.submit({ type: "commit",
        command: "nonexistent-command",
        title: "Bad command"
      });
      await approveFixtureRequest(queue, request.id);
      await waitForStatus(queue, request.id, "completed");

      const completed = queue.getRequest(request.id);
      expect(completed?.exit_code).toBe(1);
      // When the executor throws, the error message from the exception is used
      expect(completed?.error).toBe("Spawn failed: ENOENT");
    });

    it("error_output is truncated to last 20 lines", async () => {
      const events: SseEvent[] = [];
      const queue = createQueue({ broadcast: (e) => events.push(e) });

      const request = queue.submit({ type: "commit", command: "echo fail", title: "Long output" });
      // Generate 30 lines of output (no trailing newline so split gives exactly 30)
      const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n");
      await approveFixtureRequest(queue, request.id);
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

  describe("listHistorySummaries", () => {
    function submitCompleted(
      queue: AuthQueue,
      overrides: Partial<Parameters<AuthQueue["submit"]>[0]> = {},
    ): string {
      const headBranch = overrides.head_branch ?? "feature/x";
      const request = queue.submit({
        type: "merge",
        command: `mandible auth merge ${headBranch} --into main`,
        title: "History row",
        repo: "mandible",
        base_branch: "main",
        head_branch: "feature/x",
        diff_summary: "diff --git a/f b/f\n@@ -1 +1 @@\n-a\n+b\n",
        spec_content: "# Spec\n\nlots of text",
        commit_message: "feat: land it",
        execution_mode: "remote",
        ...overrides,
      });
      seedHistoricalAuthCompletion(queue, request.id, "verbose console output ".repeat(50));
      return request.id;
    }

    it("omits diff/spec/output body blobs but keeps commit_message", async () => {
      const queue = createQueue();
      submitCompleted(queue);

      const [row] = queue.listHistorySummaries(50);
      expect(row).toBeDefined();
      // Body blobs are omitted entirely (undefined, not null/"").
      expect("diff_summary" in row).toBe(false);
      expect("spec_content" in row).toBe(false);
      expect("output" in row).toBe(false);
      expect("change_report" in row).toBe(false);
      // Bounded fields the sidebar needs are still present.
      expect(row.commit_message).toBe("feat: land it");
      expect(row.title).toBe("History row");
      expect(row.repo).toBe("mandible");
      expect(row.head_branch).toBe("feature/x");
    });

    it("reports action_count per row from a batched query", async () => {
      const queue = createQueue();
      const withActions = queue.submit({
        type: "merge",
        command: "mandible auth merge feature/a --into main",
        title: "Has actions",
        repo: "mandible",
        base_branch: "main",
        head_branch: "feature/a",
        execution_mode: "remote",
        actions: [
          { kind: "comment_add", target_issue_ref: "abc1234", payload: { body: "one" } },
          { kind: "label_add", target_issue_ref: "abc1234", payload: { label: "verified" } },
        ],
      });
      seedHistoricalAuthCompletion(queue, withActions.id, "ok");
      submitCompleted(queue, { title: "No actions", head_branch: "feature/b" });

      const rows = queue.listHistorySummaries(50);
      const withActionsRow = rows.find((r) => r.id === withActions.id);
      const withoutRow = rows.find((r) => r.title === "No actions");
      expect(withActionsRow?.action_count).toBe(2);
      expect(withoutRow?.action_count).toBe(0);
    });

    it("only returns resolved rows, newest first, respecting the limit", async () => {
      let now = 1000;
      const db = createMigratedDb();
      const queue = new AuthQueue({ db, now: () => now });
      // A pending row must not appear in history.
      queue.submit({ type: "commit", command: "echo pending", title: "Pending" });
      const first = submitCompleted(queue, { title: "First", head_branch: "feature/1" });
      now = 2000;
      const second = submitCompleted(queue, { title: "Second", head_branch: "feature/2" });

      const rows = queue.listHistorySummaries(50);
      expect(rows.map((r) => r.id)).toEqual([second, first]);
      expect(rows.some((r) => r.title === "Pending")).toBe(false);

      expect(queue.listHistorySummaries(1).map((r) => r.id)).toEqual([second]);
      queue.dispose();
      db.close();
    });
  });
});
