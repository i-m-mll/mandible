import { approveFixtureRequest } from "./helpers/auth-queue-fixtures.js";
// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";

import { AuthAutoApproveManager } from "../src/auth-auto-approve.js";
import { AuthQueue } from "../src/auth-queue.js";
import { setDb, type Db } from "../src/db.js";
import { registerAuthRoutes } from "../src/routes/auth.js";
import { Router } from "../src/server.js";
import { setupOperator } from "../src/users/store.js";
import { migratedMemoryDb } from "./helpers/ledger-fixtures.js";

let db: Db | null = null;

afterEach(() => {
  db?.close();
  db = null;
});

function setup(): { db: Db; queue: AuthQueue; router: Router } {
  db = migratedMemoryDb();
  setDb(db);
  setupOperator(db, { slug: "dependency-test", display_name: "Dependency Test" });
  const queue = new AuthQueue({
    db,
    backgroundMaintenance: false,
    executor: async () => ({
      exit_code: 0,
      signal: null,
      stdout: "ok\n",
      stderr: "",
      output: "ok\n",
      started_at: 1,
      finished_at: 2,
    }),
  });
  const router = new Router();
  registerAuthRoutes(router, queue, new AuthAutoApproveManager({ db }));
  return { db, queue, router };
}

function setDependencyResult(
  database: Db,
  id: string,
  values: { status: string; exitCode: number | null; finalizedAt: number | null },
): void {
  database.prepare(
    "UPDATE auth_requests SET status = ?, exit_code = ?, merge_finalized_at = ? WHERE id = ?",
  ).run(values.status, values.exitCode, values.finalizedAt, id);
}

function createAmbiguousRequestPrefix(database: Db, queue: AuthQueue): string {
  const seed = queue.submit({ type: "commit", command: "echo ambiguous", title: "Ambiguous dependency seed" });
  const columns = database.prepare("PRAGMA table_info(auth_requests)").all() as Array<{ name: string }>;
  const names = columns.map(({ name }) => `"${name}"`);
  const selections = columns.map(({ name }) => name === "id" ? "?" : `"${name}"`);
  const clone = database.prepare(
    `INSERT INTO auth_requests (${names.join(", ")}) SELECT ${selections.join(", ")} FROM auth_requests WHERE id = ?`,
  );
  clone.run("aaaabbbb-1111-4111-8111-111111111111", seed.id);
  clone.run("aaaabbbb-2222-4222-8222-222222222222", seed.id);
  return "aaaabbbb";
}

describe("auth dependency readiness", () => {
  it("classifies every durable dependency state and permits only finalized success", () => {
    const { db: database, queue } = setup();
    const dependency = queue.submit({ type: "commit", command: "echo dependency", title: "Dependency" });
    const dependent = queue.submit({ type: "commit",
      command: "echo dependent",
      title: "Dependent",
      depends_on_id: dependency.id,
    });

    expect(queue.dependencyForRequest(dependent)?.state).toBe("pending");

    setDependencyResult(database, dependency.id, { status: "rejected", exitCode: null, finalizedAt: null });
    expect(queue.dependencyForRequest(dependent)?.state).toBe("failed");

    setDependencyResult(database, dependency.id, { status: "completed", exitCode: 9, finalizedAt: 10 });
    expect(queue.dependencyForRequest(dependent)?.state).toBe("failed");

    setDependencyResult(database, dependency.id, { status: "completed", exitCode: 0, finalizedAt: null });
    expect(queue.dependencyForRequest(dependent)?.state).toBe("unfinalized");

    setDependencyResult(database, dependency.id, { status: "completed", exitCode: 0, finalizedAt: 10 });
    expect(queue.dependencyForRequest(dependent)).toMatchObject({
      state: "ready",
      request_id: dependency.id,
      status: "completed",
      outcome: "succeeded",
      exit_code: 0,
      merge_finalized_at: 10,
    });

    expect(queue.dependencyForRequest({ depends_on_id: "does-not-exist" })?.state).toBe("missing");

    const ambiguousPrefix = createAmbiguousRequestPrefix(database, queue);
    expect(queue.dependencyForRequest({ depends_on_id: ambiguousPrefix })?.state).toBe("ambiguous");
    queue.dispose();
  });

  it("uses the same projection in detail, queue, and history", async () => {
    const { db: database, queue, router } = setup();
    const dependency = queue.submit({ type: "commit", command: "echo dependency", title: "Dependency" });
    setDependencyResult(database, dependency.id, { status: "completed", exitCode: 0, finalizedAt: 42 });
    const active = queue.submit({ type: "commit",
      command: "echo active", title: "Active dependent", depends_on_id: dependency.id,
    });
    const historical = queue.submit({ type: "commit",
      command: "echo historical", title: "Historical dependent", depends_on_id: dependency.id,
    });
    setDependencyResult(database, historical.id, { status: "rejected", exitCode: null, finalizedAt: null });

    const detail = await router.invoke({ method: "GET", url: `/api/auth/request/${active.id}` });
    const queueResponse = await router.invoke({ method: "GET", url: "/api/auth/queue" });
    const history = await router.invoke({ method: "GET", url: "/api/auth/history" });
    const queueRow = (queueResponse.body as { requests: Array<{ id: string; dependency: unknown }> })
      .requests.find((request) => request.id === active.id);
    const historyRow = (history.body as { requests: Array<{ id: string; dependency: unknown }> })
      .requests.find((request) => request.id === historical.id);

    expect((detail.body as { dependency: unknown }).dependency).toMatchObject({ state: "ready" });
    expect(queueRow?.dependency).toMatchObject({ state: "ready" });
    expect(historyRow?.dependency).toMatchObject({ state: "ready" });
    queue.dispose();
  });

  it("blocks ordinary approval until the dependency is durably finalized", async () => {
    const { db: database, queue } = setup();
    const dependency = queue.submit({ type: "commit", command: "echo dependency", title: "Dependency" });
    const dependent = queue.submit({ type: "commit",
      command: "echo dependent", title: "Dependent", depends_on_id: dependency.id,
    });

    await expect(approveFixtureRequest(queue, dependent.id)).rejects.toThrow(/Dependency .* is pending/);
    setDependencyResult(database, dependency.id, { status: "rejected", exitCode: null, finalizedAt: null });
    await expect(approveFixtureRequest(queue, dependent.id)).rejects.toThrow(/is failed/);
    setDependencyResult(database, dependency.id, { status: "completed", exitCode: 1, finalizedAt: 42 });
    await expect(approveFixtureRequest(queue, dependent.id)).rejects.toThrow(/is failed/);
    setDependencyResult(database, dependency.id, { status: "completed", exitCode: 0, finalizedAt: null });
    await expect(approveFixtureRequest(queue, dependent.id)).rejects.toThrow(/is unfinalized/);

    database.prepare("UPDATE auth_requests SET depends_on_id = ? WHERE id = ?")
      .run("missing-dependency", dependent.id);
    await expect(approveFixtureRequest(queue, dependent.id)).rejects.toThrow(/is missing/);

    const ambiguousPrefix = createAmbiguousRequestPrefix(database, queue);
    database.prepare("UPDATE auth_requests SET depends_on_id = ? WHERE id = ?")
      .run(ambiguousPrefix, dependent.id);
    await expect(approveFixtureRequest(queue, dependent.id)).rejects.toThrow(/is ambiguous/);

    database.prepare("UPDATE auth_requests SET depends_on_id = ? WHERE id = ?")
      .run(dependency.id, dependent.id);
    setDependencyResult(database, dependency.id, { status: "completed", exitCode: 0, finalizedAt: 42 });
    expect((await approveFixtureRequest(queue, dependent.id)).status).toBe("executing");
    queue.dispose();
  });
});
