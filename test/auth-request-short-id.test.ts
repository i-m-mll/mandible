// Issue f59b5bd — GET /api/auth/request/:id accepts short-form ids: an
// unambiguous prefix resolves to the full request, an ambiguous prefix is a
// 409, and an unknown id stays an honest 404. Deep links emit the 8-char
// short form, so this route is their resolution point.
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { AuthQueue } from "../src/auth-queue.js";
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

function setup(): { router: Router; queue: AuthQueue; db: Db } {
  db = new Database(":memory:");
  migrate(db);
  setDb(db);
  setupOperator(db, { slug: "auth-short-id-test", display_name: "Auth Short Id Test" });
  const router = new Router();
  const queue = new AuthQueue({ db });
  registerAuthRoutes(router, queue, new AuthAutoApproveManager({ db }));
  return { router, queue, db };
}

describe("GET /api/auth/request/:id short-form ids", () => {
  it("resolves an unambiguous 8-char prefix to the full request", async () => {
    const { router, queue } = setup();
    const request = queue.submit({
      command: "mandible auth merge feature/example --into main",
      title: "Short-id lookup",
    });

    const response = await router.invoke({
      method: "GET",
      url: `/api/auth/request/${request.id.slice(0, 8)}`,
    });

    expect(response.status).toBe(200);
    expect((response.body as { request_id: string }).request_id).toBe(request.id);
  });

  it("reports an ambiguous prefix as 409 instead of silently picking", async () => {
    const { router, queue, db: database } = setup();
    const first = queue.submit({
      command: "mandible auth merge feature/one --into main",
      title: "First",
    });
    const second = queue.submit({
      command: "mandible auth merge feature/two --into main",
      title: "Second",
    });
    // Force a shared 8-char prefix — randomUUID ids never collide naturally.
    database.prepare("UPDATE auth_requests SET id = ? WHERE id = ?").run(
      "aaaabbbb-1111-4111-8111-111111111111",
      first.id,
    );
    database.prepare("UPDATE auth_requests SET id = ? WHERE id = ?").run(
      "aaaabbbb-2222-4222-8222-222222222222",
      second.id,
    );

    const response = await router.invoke({
      method: "GET",
      url: "/api/auth/request/aaaabbbb",
    });

    expect(response.status).toBe(409);
    expect(String((response.body as { error: string }).error)).toContain("Ambiguous");
  });

  it("keeps an honest 404 for an unknown id", async () => {
    const { router } = setup();

    const response = await router.invoke({
      method: "GET",
      url: "/api/auth/request/deadbeef",
    });

    expect(response.status).toBe(404);
  });

  // Review R3 (issue f59b5bd) — the detail route serves the canonical full
  // request projection, so session linkage (session_id) and future columns
  // survive deep-linked/archived rendering instead of being dropped by a
  // hand-maintained field allowlist.
  it("includes session_id and the full record in the detail projection", async () => {
    const { router, queue } = setup();
    const request = queue.submit({
      command: "mandible auth merge feature/linked --into main",
      title: "Session-linked request",
      session_id: "sess-deep-link-1",
    });

    const response = await router.invoke({
      method: "GET",
      url: `/api/auth/request/${request.id}`,
    });

    expect(response.status).toBe(200);
    const body = response.body as Record<string, unknown>;
    expect(body.request_id).toBe(request.id);
    expect(body.session_id).toBe("sess-deep-link-1");
    expect(body.title).toBe("Session-linked request");
    expect(body.status).toBe(request.status);
  });
});

describe("PUT /api/auth/request/:id short-form ids", () => {
  it("updates through full and unambiguous short ids", async () => {
    const { router, queue } = setup();
    const request = queue.submit({
      command: "mandible auth merge feature/update --into main",
      title: "Before",
      merge_head_sha: "1111111111111111111111111111111111111111",
    });

    const fullResponse = await router.invoke({
      method: "PUT",
      url: `/api/auth/request/${request.id}`,
      body: { title: "Full-id update" },
    });
    expect(fullResponse.status).toBe(200);
    expect((fullResponse.body as { title: string }).title).toBe("Full-id update");

    const shortResponse = await router.invoke({
      method: "PUT",
      url: `/api/auth/request/${request.id.slice(0, 8)}`,
      body: {
        title: "Short-id update",
        merge_head_sha: "2222222222222222222222222222222222222222",
      },
    });

    expect(shortResponse.status).toBe(200);
    expect(shortResponse.body).toMatchObject({
      request_id: request.id,
      title: "Short-id update",
      merge_head_sha: "2222222222222222222222222222222222222222",
    });
    expect(queue.getRequest(request.id)).toMatchObject({
      title: "Short-id update",
      merge_head_sha: "2222222222222222222222222222222222222222",
    });
  });

  it("invalidates the canonical request's retained candidate through a short id", async () => {
    const { router, queue, db: database } = setup();
    const request = queue.submit({
      command: "mandible auth merge feature/candidate --into main",
      title: "Candidate",
      merge_head_sha: "1111111111111111111111111111111111111111",
    });
    database.prepare(
      `UPDATE auth_requests SET merge_preflight_base_sha = ?,
        merge_preflight_queue_fingerprint = ?, merge_candidate_tree_sha = ?,
        merge_candidate_pin_sha = ?, merge_atomic_enabled = 1 WHERE id = ?`,
    ).run("a".repeat(40), "queue", "b".repeat(40), "c".repeat(40), request.id);

    const response = await router.invoke({
      method: "PUT",
      url: `/api/auth/request/${request.id.slice(0, 8)}`,
      body: { merge_head_sha: "2222222222222222222222222222222222222222" },
    });

    expect(response.status).toBe(200);
    expect(queue.getRequest(request.id)).toMatchObject({
      merge_head_sha: "2222222222222222222222222222222222222222",
      merge_preflight_base_sha: null,
      merge_preflight_queue_fingerprint: null,
      merge_candidate_tree_sha: null,
      merge_candidate_pin_sha: null,
      merge_atomic_enabled: false,
    });
  });

  it("rejects ambiguous prefixes without changing either request", async () => {
    const { router, queue, db: database } = setup();
    const first = queue.submit({ command: "echo one", title: "First" });
    const second = queue.submit({ command: "echo two", title: "Second" });
    const firstId = "aaaabbbb-1111-4111-8111-111111111111";
    const secondId = "aaaabbbb-2222-4222-8222-222222222222";
    database.prepare("UPDATE auth_requests SET id = ? WHERE id = ?").run(firstId, first.id);
    database.prepare("UPDATE auth_requests SET id = ? WHERE id = ?").run(secondId, second.id);

    const response = await router.invoke({
      method: "PUT",
      url: "/api/auth/request/aaaabbbb",
      body: { title: "Wrong" },
    });

    expect(response.status).toBe(409);
    expect(String((response.body as { error: string }).error)).toContain("Ambiguous");
    expect(queue.getRequest(firstId)?.title).toBe("First");
    expect(queue.getRequest(secondId)?.title).toBe("Second");
  });

  it("keeps an honest 404 for an unknown id", async () => {
    const { router } = setup();

    const response = await router.invoke({
      method: "PUT",
      url: "/api/auth/request/deadbeef",
      body: { title: "Missing" },
    });

    expect(response.status).toBe(404);
  });
});
