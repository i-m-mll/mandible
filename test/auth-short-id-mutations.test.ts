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
import SqliteDatabase from "../src/sqlite.ts";
import { afterEach, describe, expect, it } from "vitest";

import { AuthQueue } from "../src/auth-queue.js";
import type { SseEvent } from "../src/types.js";
import { AuthAutoApproveManager } from "../src/auth-auto-approve.js";
import { migrate, setDb, type Db } from "../src/db.js";
import { registerAuthRoutes } from "../src/routes/auth.js";
import { Router } from "../src/server.js";
import { getOperator, setupOperator } from "../src/users/store.js";

let db: Db | null = null;

afterEach(() => {
  db?.close();
  db = null;
});

function setup(): { router: Router; queue: AuthQueue; db: Db; events: SseEvent[] } {
  db = new SqliteDatabase(":memory:");
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

describe("removed destructive auth request routes", () => {
  it("returns a clear gone response and preserves the row", async () => {
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

    expect(response.status).toBe(410);
    expect(response.body).toMatchObject({ code: "auth_request_delete_removed" });
    expect(rowsFor(database, request.id)).toBe(1);
  });

  it("does not emit a deletion receipt", async () => {
    const { router, queue, events } = setup();
    const request = queue.submit({
      command: "mandible auth merge feature/echo-id --into main",
      title: "Echo canonical id",
    });

    const response = await router.invoke({
      method: "DELETE",
      url: `/api/auth/request/${request.id.slice(0, 8)}`,
      body: { reason: "superseded" },
    });

    expect(response.status).toBe(410);
    const deleted = events
      .filter((event) => event.event === "auth:deleted")
      .map((event) => String((event.data as { request_id: string }).request_id));
    expect(deleted).toEqual([]);
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

  it("reject through a short id actually rejects", () => {
    const { queue, db: database } = setup();
    const request = queue.submit({
      command: "mandible auth merge feature/reject --into main",
      title: "Reject",
    });

    queue.reject(request.id.slice(0, 8), "not now", {
      user_id: getOperator(database)!.id,
      evidence_method: "operator",
    });

    expect(statusOf(database, request.id)).toBe("rejected");
  });

  it("dismiss through a short id is retired without mutation", async () => {
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

    expect(response.status).toBe(410);
    expect(statusOf(database, request.id)).toBe("pending");
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
