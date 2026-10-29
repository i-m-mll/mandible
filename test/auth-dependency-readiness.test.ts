import { authRevalidationOrder } from "../src/auth-dependency.js";
import { inlineLedgerReader } from "../src/ledger-reads/index.js";
import { AUTH_COMMAND_REVIEW } from "./helpers/auth-queue-fixtures.js";
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
  registerAuthRoutes(router, queue, new AuthAutoApproveManager({ db }), undefined, inlineLedgerReader(() => queue.db));
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

async function createAmbiguousRequestPrefix(database: Db, queue: AuthQueue): Promise<string> {
  const seed = (await queue.submit({ ...AUTH_COMMAND_REVIEW,  type: "commit", command: "echo ambiguous", title: "Ambiguous dependency seed" }));
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
  it("prioritizes re-pin candidates by resolved identity while approval still requires durable finalization", async () => {
    const { db: database, queue } = setup();
    const submit = (title: string, depends_on_ids: string[] = []) => queue.submit({ ...AUTH_COMMAND_REVIEW,
      type: "commit", command: `echo ${title}`, title, depends_on_ids });
    const completed = await submit("completed");
    const second = await submit("second");
    const unrelated = await submit("unrelated");
    const legacy = await submit("legacy");
    database.prepare("UPDATE auth_requests SET depends_on_ids = NULL, depends_on_id = ? WHERE id = ?").run(completed.id.slice(0, 8), legacy.id);
    const conjunction = await submit("conjunction", [completed.id, second.id]);
    const remaining = [unrelated, conjunction, (await queue.getRequest(legacy.id))!];
    const order = () => authRevalidationOrder(database, remaining, completed.id).map(request => request.id);
    setDependencyResult(database, completed.id, { status: "completed", exitCode: 0, finalizedAt: null });
    for (const values of [
      { status: "pending", exitCode: null, finalizedAt: null },
      { status: "failed", exitCode: 1, finalizedAt: 10 },
      { status: "completed", exitCode: 0, finalizedAt: null },
    ]) {
      setDependencyResult(database, second.id, values);
      expect(order()).toEqual([legacy.id, unrelated.id, conjunction.id]);
    }
    setDependencyResult(database, second.id, { status: "completed", exitCode: 0, finalizedAt: 10 });
    expect(order()).toEqual([conjunction.id, legacy.id, unrelated.id]);
    expect(queue.dependenciesForRequest(conjunction).some(dependency => dependency.state === "unfinalized")).toBe(true);
    await expect(approveFixtureRequest(queue, conjunction.id)).rejects.toThrow(/unfinalized/);
    setDependencyResult(database, completed.id, { status: "completed", exitCode: 0, finalizedAt: 10 });
    expect(queue.dependenciesForRequest(conjunction).every(dependency => dependency.state === "ready")).toBe(true);
    await queue.dispose();
  });

  it("admits independent prerequisites and waits for every direct request without flattening a diamond", async () => {
    const { db: database, queue } = setup();
    const submit = (title: string, depends_on_ids?: string[]) => queue.submit({ ...AUTH_COMMAND_REVIEW,
      type: "commit", command: `echo ${title}`, title, depends_on_ids });
    const detail = await submit("detail");
    const source = await submit("source", [detail.id]);
    const validation = await submit("validation", [detail.id]);
    const spatial = await submit("spatial", [detail.id]);
    const client = await submit("client", [source.id.slice(0, 8), `auth:${validation.id.slice(0, 8)}`, spatial.id, source.id]);
    expect(client.depends_on_ids).toEqual([source.id, validation.id, spatial.id].sort());
    await expect(approveFixtureRequest(queue, client.id)).rejects.toThrow(/Dependency .* pending/);
    for (const request of [detail, source, validation]) {
      setDependencyResult(database, request.id, { status: "completed", exitCode: 0, finalizedAt: 42 });
    }
    await expect(approveFixtureRequest(queue, client.id)).rejects.toThrow(/Dependency .* pending/);
    setDependencyResult(database, spatial.id, { status: "completed", exitCode: 0, finalizedAt: null });
    await expect(approveFixtureRequest(queue, client.id)).rejects.toThrow(/unfinalized/);
    setDependencyResult(database, spatial.id, { status: "completed", exitCode: 0, finalizedAt: 42 });
    expect((await approveFixtureRequest(queue, client.id)).status).toBe("executing");
    await queue.dispose();
  });

  it("refuses retired writes without creating or changing requests", async () => {
    const { db: database, queue, router } = setup();
    const request = await queue.submit({ ...AUTH_COMMAND_REVIEW, type: "commit", command: "echo original", title: "Original" });
    const before = database.prepare("SELECT * FROM auth_requests").all();
    const events = queue.listLifecycleEvents(request.id);
    expect((await router.invoke({ method: "POST", url: "/api/auth/request", body: {
      ...AUTH_COMMAND_REVIEW, type: "commit", command: "echo retired", title: "Retired", depends_on_id: request.id,
    } })).status).toBe(410);
    expect((await router.invoke({ method: "PUT", url: `/api/auth/request/${request.id}`, body: { title: "Changed", depends_on_id: null } })).status).toBe(410);
    expect(database.prepare("SELECT * FROM auth_requests").all()).toEqual(before);
    expect(queue.listLifecycleEvents(request.id)).toEqual(events);
    await queue.dispose();
  });

  it("preserves historical storage on unrelated edits and converts only an explicit prerequisite edit", async () => {
    const { db: database, queue } = setup();
    const source = await queue.submit({ ...AUTH_COMMAND_REVIEW, type: "commit", command: "echo source", title: "Source" });
    const request = await queue.submit({ ...AUTH_COMMAND_REVIEW, type: "commit", command: "echo legacy", title: "Legacy" });
    const short = source.id.slice(0, 8);
    database.prepare("UPDATE auth_requests SET depends_on_ids = NULL, depends_on_id = ? WHERE id = ?").run(short, request.id);
    await queue.update(request.id, { title: "Renamed" });
    expect(database.prepare("SELECT depends_on_id, depends_on_ids FROM auth_requests WHERE id = ?").get(request.id))
      .toEqual({ depends_on_id: short, depends_on_ids: null });
    expect(queue.dependenciesForRequest((await queue.getRequest(request.id))!)[0]?.request_id).toBe(source.id);
    await queue.update(request.id, { depends_on_ids: [short, `auth:${source.id}`] });
    expect(database.prepare("SELECT depends_on_id, depends_on_ids FROM auth_requests WHERE id = ?").get(request.id))
      .toEqual({ depends_on_id: null, depends_on_ids: JSON.stringify([source.id]) });
    await queue.dispose();
  });

  it("rejects invalid admission and cycle edits while preserving prior prerequisites", async () => {
    const { db: database, queue, router } = setup();
    const root = await queue.submit({ ...AUTH_COMMAND_REVIEW, type: "commit", command: "echo root", title: "root" });
    const child = await queue.submit({ ...AUTH_COMMAND_REVIEW, type: "commit", command: "echo child", title: "child", depends_on_ids: [root.id] });
    const submit = (depends_on_ids: unknown) => queue.submit({ ...AUTH_COMMAND_REVIEW, type: "commit",
      command: "echo invalid", title: "invalid", depends_on_ids: depends_on_ids as string[] });
    for (const invalid of [null, "scalar", [""], [" "], [1], ["does-not-exist"]]) {
      await expect(submit(invalid)).rejects.toMatchObject({ status: 400 });
    }
    const ambiguous = await createAmbiguousRequestPrefix(database, queue);
    await expect(submit([ambiguous])).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/ambiguous/) });
    await expect(queue.update(root.id, { depends_on_ids: [root.id] })).rejects.toMatchObject({ status: 400 });
    await expect(queue.update(root.id, { depends_on_ids: [child.id] })).rejects.toMatchObject({ status: 400 });
    expect((await queue.getRequest(root.id))?.depends_on_ids).toEqual([]);
    await queue.update(child.id, { title: "renamed" });
    expect((await queue.getRequest(child.id))?.depends_on_ids).toEqual([root.id]);
    await queue.update(child.id, { depends_on_ids: [] });
    expect((await queue.getRequest(child.id))?.depends_on_ids).toEqual([]);
    const scalar = await router.invoke({ method: "POST", url: "/api/auth/v2/request",
      body: { ...AUTH_COMMAND_REVIEW, type: "commit", command: "echo scalar", title: "scalar", depends_on_id: root.id } });
    expect(scalar.status).toBe(400);
    expect(scalar.body).toMatchObject({ error: expect.stringMatching(/depends_on_id.*retired/) });
    await queue.dispose();
  });

  it("classifies every durable dependency state and permits only finalized success", async () => {
    const { db: database, queue } = setup();
    const dependency = (await queue.submit({ ...AUTH_COMMAND_REVIEW,  type: "commit", command: "echo dependency", title: "Dependency" }));
    const dependent = (await queue.submit({ ...AUTH_COMMAND_REVIEW,  type: "commit",
      command: "echo dependent",
      title: "Dependent",
      depends_on_ids: [dependency.id],
    }));

    expect(queue.dependenciesForRequest(dependent)[0]?.state).toBe("pending");

    setDependencyResult(database, dependency.id, { status: "rejected", exitCode: null, finalizedAt: null });
    expect(queue.dependenciesForRequest(dependent)[0]?.state).toBe("failed");

    setDependencyResult(database, dependency.id, { status: "failed", exitCode: 9, finalizedAt: 10 });
    expect(queue.dependenciesForRequest(dependent)[0]?.state).toBe("failed");

    setDependencyResult(database, dependency.id, { status: "completed", exitCode: 0, finalizedAt: null });
    expect(queue.dependenciesForRequest(dependent)[0]?.state).toBe("unfinalized");

    setDependencyResult(database, dependency.id, { status: "completed", exitCode: 0, finalizedAt: 10 });
    expect(queue.dependenciesForRequest(dependent)[0]).toMatchObject({
      state: "ready",
      request_id: dependency.id,
      status: "completed",
      outcome: "succeeded",
      exit_code: 0,
      merge_finalized_at: 10,
    });

    expect(queue.dependenciesForRequest({ depends_on_ids: ["does-not-exist"] })[0]?.state).toBe("missing");

    const ambiguousPrefix = (await createAmbiguousRequestPrefix(database, queue));
    expect(queue.dependenciesForRequest({ depends_on_ids: [ambiguousPrefix] })[0]?.state).toBe("ambiguous");
    (await queue.dispose());
  });

  it("uses the same projection in detail, queue, and history", async () => {
    const { db: database, queue, router } = setup();
    const dependency = (await queue.submit({ ...AUTH_COMMAND_REVIEW,  type: "commit", command: "echo dependency", title: "Dependency" }));
    setDependencyResult(database, dependency.id, { status: "completed", exitCode: 0, finalizedAt: 42 });
    const active = (await queue.submit({ ...AUTH_COMMAND_REVIEW,  type: "commit",
      command: "echo active", title: "Active dependent", depends_on_ids: [dependency.id],
    }));
    const historical = (await queue.submit({ ...AUTH_COMMAND_REVIEW,  type: "commit",
      command: "echo historical", title: "Historical dependent", depends_on_ids: [dependency.id],
    }));
    setDependencyResult(database, historical.id, { status: "rejected", exitCode: null, finalizedAt: null });

    const detail = await router.invoke({ method: "GET", url: `/api/auth/request/${active.id}` });
    const queueResponse = await router.invoke({ method: "GET", url: "/api/auth/queue" });
    const history = await router.invoke({ method: "GET", url: "/api/auth/history" });
    const queueRow = (queueResponse.body as { requests: Array<{ id: string; dependencies: unknown[] }> })
      .requests.find((request) => request.id === active.id);
    const historyRow = (history.body as { requests: Array<{ id: string; dependencies: unknown[] }> })
      .requests.find((request) => request.id === historical.id);

    expect((detail.body as { dependencies: unknown[] }).dependencies[0]).toMatchObject({ state: "ready" });
    expect(queueRow?.dependencies[0]).toMatchObject({ state: "ready" });
    expect(historyRow?.dependencies[0]).toMatchObject({ state: "ready" });
    (await queue.dispose());
  });

  it("blocks ordinary approval until the dependency is durably finalized", async () => {
    const { db: database, queue } = setup();
    const dependency = (await queue.submit({ ...AUTH_COMMAND_REVIEW,  type: "commit", command: "echo dependency", title: "Dependency" }));
    const dependent = (await queue.submit({ ...AUTH_COMMAND_REVIEW,  type: "commit",
      command: "echo dependent", title: "Dependent", depends_on_ids: [dependency.id],
    }));

    await expect(approveFixtureRequest(queue, dependent.id)).rejects.toThrow(/Dependency .* is pending/);
    setDependencyResult(database, dependency.id, { status: "rejected", exitCode: null, finalizedAt: null });
    await expect(approveFixtureRequest(queue, dependent.id)).rejects.toThrow(/is failed/);
    setDependencyResult(database, dependency.id, { status: "failed", exitCode: 1, finalizedAt: 42 });
    await expect(approveFixtureRequest(queue, dependent.id)).rejects.toThrow(/is failed/);
    setDependencyResult(database, dependency.id, { status: "completed", exitCode: 0, finalizedAt: null });
    await expect(approveFixtureRequest(queue, dependent.id)).rejects.toThrow(/is unfinalized/);

    database.prepare("UPDATE auth_requests SET depends_on_ids = NULL, depends_on_id = ? WHERE id = ?")
      .run("missing-dependency", dependent.id);
    await expect(approveFixtureRequest(queue, dependent.id)).rejects.toThrow(/is missing/);

    const ambiguousPrefix = (await createAmbiguousRequestPrefix(database, queue));
    database.prepare("UPDATE auth_requests SET depends_on_ids = NULL, depends_on_id = ? WHERE id = ?")
      .run(ambiguousPrefix, dependent.id);
    await expect(approveFixtureRequest(queue, dependent.id)).rejects.toThrow(/is ambiguous/);

    database.prepare("UPDATE auth_requests SET depends_on_ids = NULL, depends_on_id = ? WHERE id = ?")
      .run(dependency.id, dependent.id);
    setDependencyResult(database, dependency.id, { status: "completed", exitCode: 0, finalizedAt: 42 });
    expect((await approveFixtureRequest(queue, dependent.id)).status).toBe("executing");
    (await queue.dispose());
  });
});
