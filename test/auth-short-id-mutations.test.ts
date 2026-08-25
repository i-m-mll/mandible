// @vitest-environment node
// Issue 22ace1c — every AuthQueue mutator resolves a possibly-short caller id
// to a canonical row and then writes. Each one used to write with the caller's
// RAW parameter instead of the resolved row id, so a short id matched no row,
// changed nothing, and still returned success. Filed against DELETE; found by
// audit to affect approve, reject, dismiss, skip, retry, requeue and setResult
// on exactly the same shape.
//
// These tests assert on the DATABASE, never on the response body. A route that
// claims success is the thing under test, so its own claim cannot be the
// evidence for it.
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { AuthQueue } from "../src/auth-queue.js";
import type { SseEvent } from "../src/types.js";
import { AuthAutoApproveManager } from "../src/auth-auto-approve.js";
import { migrate, setDb, type Db } from "../src/db.js";
import { registerAuthRoutes } from "../src/routes/auth.js";
import { Router } from "../src/server.js";
import { setupOperator } from "../src/users/store.js";

let db: Db | null = null;

afterEach(() => {
  db?.close();
  db = null;
});

function setup(): { router: Router; queue: AuthQueue; db: Db; events: SseEvent[] } {
  db = new Database(":memory:");
  migrate(db);
  setDb(db);
  setupOperator(db, { slug: "auth-delete-test", display_name: "Auth Delete Test" });
  const router = new Router();
  const events: SseEvent[] = [];
  const queue = new AuthQueue({ db, broadcast: (event) => { events.push(event); } });
  registerAuthRoutes(router, queue, new AuthAutoApproveManager({ db }));
  return { router, queue, db, events };
}

function rowsFor(database: Db, id: string): number {
  const row = database
    .prepare("SELECT COUNT(*) AS n FROM auth_requests WHERE id = ?")
    .get(id) as { n: number };
  return row.n;
}

describe("DELETE /api/auth/request/:id", () => {
  it("actually removes the row when given a short id", async () => {
    const { router, queue, db: database } = setup();
    const request = queue.submit({
      command: "mandible auth merge feature/short-delete --into main",
      title: "Short-id delete",
    });
    expect(rowsFor(database, request.id)).toBe(1);

    const response = await router.invoke({
      method: "DELETE",
      url: `/api/auth/request/${request.id.slice(0, 8)}`,
      body: { reason: "superseded" },
    });

    expect(response.status).toBe(200);
    // The claim and the fact must agree. Before the fix the claim was true and
    // the fact was false.
    expect(rowsFor(database, request.id)).toBe(0);
  });

  it("reports the canonical id it deleted, not the prefix it was handed", async () => {
    const { router, queue } = setup();
    const request = queue.submit({
      command: "mandible auth merge feature/echo-id --into main",
      title: "Echo canonical id",
    });

    const response = await router.invoke({
      method: "DELETE",
      url: `/api/auth/request/${request.id.slice(0, 8)}`,
      body: { reason: "superseded" },
    });

    expect(response.status).toBe(200);
    expect((response.body as { request_id: string }).request_id).toBe(request.id);
  });

  it("broadcasts the canonical id so listeners can match the row that went away", async () => {
    const { router, queue, events } = setup();
    const request = queue.submit({
      command: "mandible auth merge feature/broadcast-id --into main",
      title: "Broadcast canonical id",
    });

    await router.invoke({
      method: "DELETE",
      url: `/api/auth/request/${request.id.slice(0, 8)}`,
      body: { reason: "superseded" },
    });

    const deleted = events
      .filter((event) => event.event === "auth:deleted")
      .map((event) => String((event.data as { request_id: string }).request_id));
    expect(deleted).toEqual([request.id]);
  });

  it("refuses an unknown id instead of claiming a delete", async () => {
    const { router, db: database } = setup();
    const response = await router.invoke({
      method: "DELETE",
      url: "/api/auth/request/deadbeef",
      body: { reason: "nothing here" },
    });

    expect(response.status).toBe(404);
    expect(response.body).not.toMatchObject({ deleted: true });
    expect(rowsFor(database, "deadbeef")).toBe(0);
  });

  it("refuses an ambiguous prefix instead of deleting an arbitrary match", async () => {
    const { router, queue, db: database } = setup();
    const first = queue.submit({ command: "echo one", title: "First" });
    const second = queue.submit({ command: "echo two", title: "Second" });
    const firstId = "aaaabbbb-1111-4111-8111-111111111111";
    const secondId = "aaaabbbb-2222-4222-8222-222222222222";
    database.prepare("UPDATE auth_requests SET id = ? WHERE id = ?").run(firstId, first.id);
    database.prepare("UPDATE auth_requests SET id = ? WHERE id = ?").run(secondId, second.id);

    const response = await router.invoke({
      method: "DELETE",
      url: "/api/auth/request/aaaabbbb",
      body: { reason: "ambiguous" },
    });

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(rowsFor(database, firstId)).toBe(1);
    expect(rowsFor(database, secondId)).toBe(1);
  });
});

// Issue 22ace1c (audit) — the same resolve-then-write-with-the-raw-id shape in
// every other mutator. Before the fix each of these returned HTTP 200 while the
// row stayed exactly as it was: a rejected request stayed pending, a skipped
// request was never marked, a retried request never returned to the queue.
describe("auth request mutations addressed by short id", () => {
  function statusOf(database: Db, id: string): string {
    const row = database
      .prepare("SELECT status FROM auth_requests WHERE id = ?")
      .get(id) as { status: string };
    return row.status;
  }

  it("reject through a short id actually rejects", async () => {
    const { router, queue, db: database } = setup();
    const request = queue.submit({
      command: "mandible auth merge feature/reject --into main",
      title: "Reject",
    });

    const response = await router.invoke({
      method: "POST",
      url: `/api/auth/request/${request.id.slice(0, 8)}/reject`,
      body: { reason: "not now" },
    });

    expect(response.status).toBe(200);
    expect(statusOf(database, request.id)).toBe("rejected");
  });

  it("dismiss through a short id actually dismisses", async () => {
    const { router, queue, db: database } = setup();
    const request = queue.submit({
      command: "mandible auth merge feature/dismiss --into main",
      title: "Dismiss",
    });

    const response = await router.invoke({
      method: "POST",
      url: `/api/auth/request/${request.id.slice(0, 8)}/dismiss`,
      body: {},
    });

    expect(response.status).toBe(200);
    expect(statusOf(database, request.id)).toBe("dismissed");
  });

  it("skip through a short id actually marks the request skipped", async () => {
    const { router, queue, db: database } = setup();
    const request = queue.submit({
      command: "mandible auth merge feature/skip --into main",
      title: "Skip",
    });

    const response = await router.invoke({
      method: "POST",
      url: `/api/auth/request/${request.id.slice(0, 8)}/skip`,
      body: {},
    });

    expect(response.status).toBe(200);
    const row = database
      .prepare("SELECT skipped_at FROM auth_requests WHERE id = ?")
      .get(request.id) as { skipped_at: number | null };
    expect(row.skipped_at).not.toBeNull();
  });

  it("retry through a short id actually returns the request to the queue", async () => {
    const { router, queue, db: database } = setup();
    const request = queue.submit({
      command: "mandible auth merge feature/retry --into main",
      title: "Retry",
    });
    database
      .prepare("UPDATE auth_requests SET status = 'completed', exit_code = 1 WHERE id = ?")
      .run(request.id);

    const response = await router.invoke({
      method: "POST",
      url: `/api/auth/request/${request.id.slice(0, 8)}/retry`,
      body: {},
    });

    expect(response.status).toBe(200);
    expect(statusOf(database, request.id)).toBe("pending");
  });

  it("requeue through a short id actually returns the request to the queue", async () => {
    const { router, queue, db: database } = setup();
    const request = queue.submit({
      command: "mandible auth merge feature/requeue --into main",
      title: "Requeue",
    });
    database
      .prepare("UPDATE auth_requests SET status = 'completed', exit_code = 1 WHERE id = ?")
      .run(request.id);

    const response = await router.invoke({
      method: "POST",
      url: `/api/auth/request/${request.id.slice(0, 8)}/requeue`,
      body: {},
    });

    expect(response.status).toBe(200);
    expect(statusOf(database, request.id)).toBe("pending");
  });

  it("append-output through a short id reaches the resolved row", async () => {
    const { router, queue, db: database } = setup();
    const request = queue.submit({
      command: "mandible auth merge feature/output --into main",
      title: "Output",
    });
    database
      .prepare("UPDATE auth_requests SET status = 'executing' WHERE id = ?")
      .run(request.id);

    const response = await router.invoke({
      method: "POST",
      url: `/api/auth/request/${request.id.slice(0, 8)}/output`,
      body: { chunk: "merge output line\n" },
    });

    expect(response.status).toBe(202);
    const row = database
      .prepare("SELECT output FROM auth_requests WHERE id = ?")
      .get(request.id) as { output: string };
    expect(row.output).toContain("merge output line");
  });
});
