/**
 * @vitest-environment node
 *
 * Queue state: submission, execution, rejection, expiry, revision and retry.
 */
import { describe, expect, it } from "vitest";
import { AuthQueue, AuthQueueError } from "../src/auth-queue.js";
import type { SseEvent } from "../src/types.js";
import { seedHistoricalAuthExecution, seedHistoricalAuthCompletion, approveFixtureRequest, createMigratedDb, createQueue, waitForStatus } from "./helpers/auth-queue-fixtures.js";
import { waitUntil } from "./helpers/wait-until.js";

describe("auth queue", () => {
  it("submits pending, then approves, executes and stores the result with new, output and resolved events", async () => {
    const events: SseEvent[] = [];
    const queue = createQueue({ broadcast: (event) => events.push(event) });

    const request = queue.submit({ type: "commit",
      command: "node -e \"console.log('ok')\"",
      title: "Run command"
    });
    expect(queue.getRequest(request.id)?.status).toBe("pending");
    expect(events.some((event) => event.event === "auth:new")).toBe(true);

    const approved = await approveFixtureRequest(queue, request.id);
    expect(approved.status).toBe("executing");

    const resolved = await waitForStatus(queue, request.id, "completed");
    expect(resolved?.exit_code).toBe(0);
    expect(String(resolved?.output)).toContain("ok");
    expect(events.some((event) => event.event === "auth:output")).toBe(true);
    expect(events.some((event) => event.event === "auth:resolved")).toBe(true);
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

  it("does not execute in remote mode", async () => {
    const executed: string[] = [];
    const queue = createQueue({
      executor: async (options) => {
        executed.push(options.request_id);
        return { exit_code: 0, signal: null, stdout: "", stderr: "", output: "", started_at: Date.now(), finished_at: Date.now() };
      },
    });

    const remote = queue.submit({ type: "commit", command: "echo remote", title: "Remote", execution_mode: "remote" });
    expect((await approveFixtureRequest(queue, remote.id)).status).toBe("executing");
    // A later daemon request executing proves the dispatcher ran past the remote one.
    const local = queue.submit({ type: "commit", command: "echo local", title: "Local" });
    await approveFixtureRequest(queue, local.id);
    await waitForStatus(queue, local.id, "completed");

    expect(executed).toEqual([local.id]);
    expect(queue.getRequest(remote.id)?.status).toBe("executing");
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
      await waitUntil(() => restarted.getRequest(request.id)?.status === "completed", "stale execution recovery");
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

  it("rejects a request and resolves it as rejected", async () => {
    const events: SseEvent[] = [];
    const queue = createQueue({ broadcast: (event) => events.push(event) });

    const request = queue.submit({ type: "commit", command: "echo nope", title: "Reject" });
    expect(queue.reject(request.id, "No").status).toBe("rejected");
    expect(queue.getRequest(request.id)?.status).toBe("rejected");
    expect(events.find((event) => event.event === "auth:resolved")?.data)
      .toMatchObject({ status: "rejected", outcome: "rejected" });
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

  it("expires stale requests and refuses to revise them", async () => {
    let now = 0;
    const queue = createQueue({ ttlMs: 10, now: () => now });
    const request = queue.submit({ type: "commit", command: "echo stale", title: "Stale", cwd: "/old/path" });

    now = 20;
    expect(queue.getRequest(request.id)?.status).toBe("expired");
    expect(() => queue.update(request.id, { cwd: "/new/path", status: "pending" })).toThrow("Only pending requests");
    expect(queue.getRequest(request.id)?.cwd).toBe("/old/path");
  });

  it("refuses to revise approved, succeeded and failed requests", async () => {
    const queue = createQueue();

    const approved = queue.submit({ type: "commit", command: "echo approved", title: "Approved", execution_mode: "remote" });
    await approveFixtureRequest(queue, approved.id);
    expect(() => queue.update(approved.id, { title: "Changed" })).toThrow("Only pending requests");
    expect(queue.getRequest(approved.id)?.title).toBe("Approved");

    const succeeded = queue.submit({ type: "commit", command: "echo ok", title: "OK" });
    await approveFixtureRequest(queue, succeeded.id);
    queue.setResult(succeeded.id, 0, "success");
    expect(() => queue.update(succeeded.id, { title: "New title" })).toThrow("Only pending requests");

    const failed = queue.submit({ type: "commit", command: "echo fail", title: "Fail", cwd: "/wrong/path" });
    seedHistoricalAuthCompletion(queue, failed.id, "error output", 1, "command failed");
    expect(() => queue.update(failed.id, { cwd: "/correct/path", status: "pending" })).toThrow("Only pending requests");
    expect(queue.getRequest(failed.id)?.cwd).toBe("/wrong/path");
  });

  it("returns a failed request to pending only through explicit retry, keeping its issues", async () => {
    const events: SseEvent[] = [];
    const queue = createQueue({ broadcast: (event) => events.push(event) });
    const request = queue.submit({
      command: "mandible auth merge feature/foo --into main",
      title: "Merge foo",
      base_branch: "main",
      head_branch: "feature/foo",
      execution_mode: "remote",
      issues: ["umbrella789"],
    });
    seedHistoricalAuthCompletion(queue, request.id, "Not a git repository", 1, "cwd was wrong");

    const retried = queue.retry(request.id);
    const updated = queue.update(retried.id, { cwd: "/correct/repo" });
    expect(updated).toMatchObject({
      status: "pending",
      cwd: "/correct/repo",
      exit_code: null,
      error: null,
      output: "",
      resolved_at: null,
      issues: ["umbrella789"],
    });
    expect(events.some((event) => (
      event.event === "auth:new" && (event.data as { request: { id: string } }).request.id === updated.id
    ))).toBe(true);
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

  it("records the output tail of a failed execution as its error, or the executor's own exception", async () => {
    const failing = createQueue({
      executor: async () => ({
        exit_code: 1,
        signal: null,
        stdout: "",
        stderr: "fatal: not a git repo\nfatal: merge failed\n",
        output: "fatal: not a git repo\nfatal: merge failed\n",
        started_at: Date.now(),
        finished_at: Date.now(),
      }),
    });
    const failed = failing.submit({ type: "commit", command: "git merge --gpg-sign feature/x", title: "Merge feature/x" });
    await approveFixtureRequest(failing, failed.id);
    expect(await waitForStatus(failing, failed.id, "completed"))
      .toMatchObject({ exit_code: 1, error: expect.stringContaining("fatal: merge failed") });

    const throwing = createQueue({ executor: async () => { throw new Error("Spawn failed: ENOENT"); } });
    const thrown = throwing.submit({ type: "commit", command: "nonexistent-command", title: "Bad command" });
    await approveFixtureRequest(throwing, thrown.id);
    expect(await waitForStatus(throwing, thrown.id, "completed"))
      .toMatchObject({ exit_code: 1, error: "Spawn failed: ENOENT" });
  });
});
