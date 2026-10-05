// Quarantined: e9cd064 — registerAuthRoutes opens the production database.
import SqliteDatabase from "../../src/sqlite.ts";
import { afterEach, describe, expect, it } from "vitest";

import { AuthQueue } from "../../src/auth-queue.js";
import { AuthAutoApproveManager } from "../../src/auth-auto-approve.js";
import { migrate, type Db } from "../../src/db.js";
import { registerAuthRoutes } from "../../src/routes/auth.js";
import { Router } from "../../src/server.js";
import { setupOperator } from "../../src/users/store.js";

let db: Db | null = null;

afterEach(() => {
  db?.close();
  db = null;
});

describe("auth request update route", () => {
  it("rebinds a pending request to a new merge head", async () => {
    db = new SqliteDatabase(":memory:");
    migrate(db);
    setupOperator(db, { slug: "auth-route-test", display_name: "Auth Route Test" });
    const router = new Router();
    const queue = new AuthQueue({ db });
    registerAuthRoutes(router, queue, new AuthAutoApproveManager({ db }));
    const request = queue.submit({
      command: "mandible auth merge feature/example --into main",
      title: "Refresh reviewed head",
      merge_head_sha: "1111111111111111111111111111111111111111",
    });

    const response = await router.invoke({
      method: "PUT",
      url: `/api/auth/request/${request.id}`,
      body: { merge_head_sha: "2222222222222222222222222222222222222222" },
    });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      request_id: request.id,
      merge_head_sha: "2222222222222222222222222222222222222222",
    });
    expect(queue.getRequest(request.id)?.merge_head_sha).toBe(
      "2222222222222222222222222222222222222222",
    );
  });

  it("rejects an invalid merge head without changing the request", async () => {
    db = new SqliteDatabase(":memory:");
    migrate(db);
    setupOperator(db, { slug: "auth-route-test", display_name: "Auth Route Test" });
    const router = new Router();
    const queue = new AuthQueue({ db });
    registerAuthRoutes(router, queue, new AuthAutoApproveManager({ db }));
    const originalHead = "1111111111111111111111111111111111111111";
    const request = queue.submit({
      command: "mandible auth merge feature/example --into main",
      title: "Keep reviewed head",
      merge_head_sha: originalHead,
    });

    const response = await router.invoke({
      method: "PUT",
      url: `/api/auth/request/${request.id}`,
      body: { merge_head_sha: 42 },
    });

    expect(response).toEqual({
      status: 400,
      body: { error: "Invalid 'merge_head_sha' — must be a string or null" },
    });
    expect(queue.getRequest(request.id)?.merge_head_sha).toBe(originalHead);
  });
});
