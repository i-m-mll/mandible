import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { AuthQueue } from "../src/auth-queue.js";
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
    expect(approved.status).toBe("approved");

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
    expect(approved.status).toBe("approved");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(calls).toHaveLength(0);
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
    expect(updated.status).toBe("approved");
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
});
