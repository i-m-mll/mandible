// @vitest-environment node
//
// The auth request short-id contract (issues f59b5bd, 22ace1c). Deep links
// emit the 8-char short form, so every route that takes a request id resolves
// it: an unambiguous prefix reaches exactly one canonical row, an ambiguous
// prefix is a 409 that changes nothing, and an unknown id stays an honest 404.
// Mutators once resolved the id and then wrote with the caller's raw prefix,
// changing nothing while reporting success, so these cases assert on the
// database, never on the response body.
import { afterEach, describe, expect, it } from "vitest";

import { AuthAutoApproveManager } from "../src/auth-auto-approve.js";
import { appendAuthLifecycleEvent, authRequestSnapshot } from "../src/auth-lifecycle.js";
import { AuthQueue } from "../src/auth-queue.js";
import { setDb, type Db } from "../src/db.js";
import { registerAuthRoutes } from "../src/routes/auth.js";
import type { Router } from "../src/server.js";
import type { SseEvent } from "../src/types.js";
import { addCredential, getOperator, setupOperator } from "../src/users/store.js";
import { authenticatedTestRouter } from "./helpers/authenticated-router.js";
import { migratedMemoryDb } from "./helpers/ledger-fixtures.js";

let db: Db | null = null;

afterEach(() => {
  db?.close();
  db = null;
});

function setup(): { router: Router; queue: AuthQueue; db: Db; events: SseEvent[] } {
  db = migratedMemoryDb();
  setDb(db);
  const operator = setupOperator(db, { slug: "auth-short-id-test", display_name: "Auth Short Id Test" });
  const credential = addCredential(db, operator.id, {
    type: "api_token",
    fingerprint: `auth-short-id-${crypto.randomUUID()}`,
  });
  const router = authenticatedTestRouter(operator, { credentialId: credential.id });
  const events: SseEvent[] = [];
  const queue = new AuthQueue({ db, broadcast: (event) => { events.push(event); } });
  registerAuthRoutes(router, queue, new AuthAutoApproveManager({ db }));
  return { router, queue, db, events };
}

function insertLegacyRequest(database: Db, id: string, title: string): void {
  database.prepare(
    `INSERT INTO auth_requests
      (id, command, title, status, created_at, updated_at, expires_at, output, type)
     VALUES (?, 'echo fixture', ?, 'pending', 1, 1, 9999999999999, '', 'config-change')`,
  ).run(id, title);
}

function column<T>(database: Db, id: string, name: string): T {
  return (database.prepare(`SELECT ${name} AS value FROM auth_requests WHERE id = ?`).get(id) as { value: T }).value;
}

describe("auth request short ids", () => {
  it("resolves an unambiguous prefix to the full request record", async () => {
    const { router, queue } = setup();
    const request = queue.submit({
      command: "mandible auth merge feature/linked --into main",
      title: "Session-linked request",
      session_id: "sess-deep-link-1",
    });

    const response = await router.invoke({ method: "GET", url: `/api/auth/request/${request.id.slice(0, 8)}` });

    expect(response.status).toBe(200);
    // The detail route serves the canonical projection, so session linkage
    // survives deep-linked rendering.
    expect(response.body).toMatchObject({ request_id: request.id, session_id: "sess-deep-link-1" });
  });

  it("answers an ambiguous prefix with 409 and changes neither request", async () => {
    const { router, queue, db: database } = setup();
    const firstId = "aaaabbbb-1111-4111-8111-111111111111";
    const secondId = "aaaabbbb-2222-4222-8222-222222222222";
    insertLegacyRequest(database, firstId, "First");
    insertLegacyRequest(database, secondId, "Second");

    for (const [method, body] of [["GET", undefined], ["PUT", { title: "Wrong" }]] as const) {
      const response = await router.invoke({ method, url: "/api/auth/request/aaaabbbb", body });
      expect(response.status).toBe(409);
      expect(String((response.body as { error: string }).error)).toContain("Ambiguous");
    }
    expect(queue.getRequest(firstId)?.title).toBe("First");
    expect(queue.getRequest(secondId)?.title).toBe("Second");
  });

  it("keeps an honest 404 for an unknown id", async () => {
    const { router } = setup();
    expect((await router.invoke({ method: "GET", url: "/api/auth/request/deadbeef" })).status).toBe(404);
    expect((await router.invoke({ method: "PUT", url: "/api/auth/request/deadbeef", body: { title: "Missing" } })).status)
      .toBe(404);
  });

  it("revises the canonical row through a short id and invalidates its retained candidate", async () => {
    const { router, queue, db: database } = setup();
    const request = queue.submit({
      type: "config-change",
      command: "echo candidate",
      title: "Candidate",
      merge_head_sha: "1111111111111111111111111111111111111111",
    });
    database.prepare(
      `UPDATE auth_requests SET merge_preflight_base_sha = ?,
        merge_preflight_queue_fingerprint = ?, merge_candidate_tree_sha = ?,
        merge_candidate_pin_sha = ?, merge_atomic_enabled = 1 WHERE id = ?`,
    ).run("a".repeat(40), "queue", "b".repeat(40), "c".repeat(40), request.id);
    appendAuthLifecycleEvent(database, {
      requestId: request.id,
      eventType: "revised",
      priorStatus: "pending",
      nextStatus: "pending",
      priorSnapshot: authRequestSnapshot(database, request.id),
      occurredAt: Date.now(),
    });

    const response = await router.invoke({
      method: "PUT",
      url: `/api/auth/request/${request.id.slice(0, 8)}`,
      body: {
        title: "Short-id update",
        merge_head_sha: "2222222222222222222222222222222222222222",
        operator_recovery: true,
        expected_revision: 2,
        expected_custody_generation: 0,
      },
    });

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(queue.getRequest(request.id)).toMatchObject({
      title: "Short-id update",
      merge_head_sha: "2222222222222222222222222222222222222222",
      merge_preflight_base_sha: null,
      merge_preflight_queue_fingerprint: null,
      merge_candidate_tree_sha: null,
      merge_candidate_pin_sha: null,
      merge_atomic_enabled: false,
    });
  });

  it("applies every mutator to the row the short id resolves to", async () => {
    const { router, queue, db: database } = setup();
    const submit = (branch: string, status?: string) => {
      const request = queue.submit({ command: `mandible auth merge feature/${branch} --into main`, title: branch });
      if (status) database.prepare("UPDATE auth_requests SET status = ?, exit_code = 1 WHERE id = ?").run(status, request.id);
      return request;
    };
    const post = (id: string, action: string, body: Record<string, unknown> = {}) =>
      router.invoke({ method: "POST", url: `/api/auth/request/${id.slice(0, 8)}/${action}`, body });

    const rejected = submit("reject");
    queue.reject(rejected.id.slice(0, 8), "not now", { user_id: getOperator(database)!.id, evidence_method: "operator" });
    expect(column(database, rejected.id, "status")).toBe("rejected");

    const skipped = submit("skip");
    expect((await post(skipped.id, "skip")).status).toBe(200);
    expect(column(database, skipped.id, "skipped_at")).not.toBeNull();

    for (const action of ["retry", "requeue"]) {
      const failed = submit(action, "completed");
      expect((await post(failed.id, action)).status).toBe(200);
      expect(column(database, failed.id, "status")).toBe("pending");
    }

    const executing = submit("output");
    database.prepare("UPDATE auth_requests SET status = 'executing', exit_code = NULL WHERE id = ?").run(executing.id);
    expect((await post(executing.id, "output", { chunk: "merge output line\n" })).status).toBe(202);
    expect(column<string>(database, executing.id, "output")).toContain("merge output line");
  });

  it("retires delete and dismiss as 410 without touching the row or emitting a deletion", async () => {
    const { router, queue, db: database, events } = setup();
    const request = queue.submit({ command: "mandible auth merge feature/retired --into main", title: "Retired routes" });
    const shortUrl = `/api/auth/request/${request.id.slice(0, 8)}`;

    const deleted = await router.invoke({ method: "DELETE", url: shortUrl, body: { reason: "superseded" } });
    expect(deleted.status).toBe(410);
    expect(deleted.body).toMatchObject({ code: "auth_request_delete_removed" });
    expect((await router.invoke({ method: "POST", url: `${shortUrl}/dismiss`, body: {} })).status).toBe(410);

    expect(column(database, request.id, "status")).toBe("pending");
    expect(events.filter((event) => event.event === "auth:deleted")).toEqual([]);
  });
});
