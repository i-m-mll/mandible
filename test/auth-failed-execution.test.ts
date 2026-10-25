// @vitest-environment node
import { inlineLedgerReader } from "../src/ledger-reads/index.js";
/**
 * Issue cc8fe29 — an execution that exits non-zero is `failed`, never
 * `completed`. The daemon records it with its reason, the API and CLI present
 * it as failed, retry returns it to pending, and after a successful retry the
 * request's history still shows the failed execution.
 */
import { afterEach, describe, expect, it } from "vitest";

import { AuthAutoApproveManager } from "../src/auth-auto-approve.js";
import { registerAuthRoutes } from "../src/routes/auth.js";
import { registerInboxRoutes } from "../src/routes/inbox.js";
import { setDb } from "../src/db.js";
import { getOperator } from "../src/users/store.js";
import type { AuthExecutionResult } from "../src/auth-executor.js";
import { AUTH_COMMAND_REVIEW, approveFixtureRequest, createQueue, waitForStatus } from "./helpers/auth-queue-fixtures.js";
import { authenticatedTestRouter } from "./helpers/authenticated-router.js";
import { runCli, startStubDaemon } from "./helpers/cli-process.js";

const SIGNING_FAILURE = [
  "Auth phase: creating signed merge commit for feature/x with git commit-tree...",
  "error: Signing file /tmp/.git_signing_buffer_tmp Confirm user presence for key ED25519-SK SHA256:abc",
  "Couldn't sign message: incorrect passphrase supplied to decrypt private key?",
  "\u001b[31mSigned commit creation failed; no ref or worktree was changed.\u001b[0m",
  "",
].join("\n");
const REASON = "signing failed: user presence not confirmed; no ref changed";

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function result(exitCode: number, output: string): AuthExecutionResult {
  return { exit_code: exitCode, signal: null, stdout: "", stderr: output, output, started_at: Date.now(), finished_at: Date.now() };
}

describe("failed auth execution", () => {
  it("is recorded, served and printed as failed, retries to pending, and stays in the history after success", async () => {
    const outcomes = [result(1, SIGNING_FAILURE), result(0, "Committed.\n")];
    const queue = createQueue({ executor: async () => outcomes.shift()! });
    const db = (queue as unknown as { db: Parameters<typeof setDb>[0] }).db;
    setDb(db);
    cleanups.push(() => queue.dispose());
    const router = authenticatedTestRouter(getOperator(db)!);
    registerAuthRoutes(router, queue, new AuthAutoApproveManager({ db }), undefined, inlineLedgerReader(() => queue.db));
    const read = async (url: string) => {
      const response = await router.invoke({ method: "GET", url });
      expect(response.status).toBe(200);
      return response.body as Record<string, unknown>;
    };

    const request = await queue.submit({ ...AUTH_COMMAND_REVIEW, type: "commit", command: "git commit -S", title: "Signed commit" });
    await approveFixtureRequest(queue, request.id);
    await waitForStatus(queue, request.id, "failed");

    const failedDetail = await read(`/api/auth/request/${request.id}`);
    expect(failedDetail).toMatchObject({ status: "failed", exit_code: 1, failure_reason: REASON });
    expect((failedDetail.lifecycle_events as Array<{ event_type: string }>).at(-1)?.event_type).toBe("failed");
    const failedQueue = await read("/api/auth/queue");
    expect((failedQueue.requests as Array<Record<string, unknown>>).find((row) => row.id === request.id))
      .toMatchObject({ status: "failed", failure_reason: REASON });

    const retried = await router.invoke({ method: "POST", url: `/api/auth/request/${request.id}/retry`, body: {} });
    expect(retried.body).toMatchObject({ status: "pending" });
    await approveFixtureRequest(queue, request.id);
    await waitForStatus(queue, request.id, "completed");

    const completedDetail = await read(`/api/auth/request/${request.id}`);
    expect(completedDetail).toMatchObject({ status: "completed", exit_code: 0, failure_reason: null });
    expect(completedDetail.execution_attempts).toEqual([
      expect.objectContaining({ result: "failed", exit_code: 1, failure_reason: REASON }),
      expect.objectContaining({ result: "succeeded", exit_code: 0, failure_reason: null }),
    ]);

    const bodies: Record<string, unknown> = { failed: failedDetail, completed: completedDetail };
    let phase = "failed";
    const stub = await startStubDaemon(({ url }) => {
      if (url.startsWith("/api/auth/request/")) return { body: bodies[phase] };
      if (url.startsWith("/api/auth/queue")) return { body: failedQueue };
      return undefined;
    });
    cleanups.push(() => stub.close());
    const short = request.id.slice(0, 8);

    const [show, list] = await Promise.all([
      runCli(["auth", "show", short], { env: stub.env }),
      runCli(["auth", "list"], { env: stub.env }),
    ]);
    expect(show.status, show.stderr).toBe(0);
    expect(show.stdout).toContain(`${short} [failed] Signed commit`);
    expect(show.stdout).toContain(`failed: ${REASON}`);
    expect(show.stdout).toContain("retry:");
    expect(show.stdout).not.toContain("completed");
    expect(list.status, list.stderr).toBe(0);
    expect(list.stdout).toContain(`[${short}] failed`);
    expect(list.stdout).toContain(`failed: ${REASON}`);

    phase = "completed";
    const history = await runCli(["auth", "show", short], { env: stub.env });
    expect(history.status, history.stderr).toBe(0);
    expect(history.stdout).toContain(`${short} [completed] Signed commit`);
    expect(history.stdout).not.toContain("retry:");
    const executions = history.stdout.split("\n").filter((line) => line.startsWith("    revision "));
    expect(executions).toHaveLength(2);
    expect(executions[0]).toContain(`failed (exit 1): ${REASON}`);
    expect(executions[1]).toMatch(/succeeded \(exit 0\)$/);
  });

  it("delivers the result of a retried execution again after the earlier result was delivered and acknowledged", async () => {
    const outcomes = [result(1, SIGNING_FAILURE), result(1, SIGNING_FAILURE)];
    const queue = createQueue({ executor: async () => outcomes.shift()! });
    const db = (queue as unknown as { db: Parameters<typeof setDb>[0] }).db;
    setDb(db);
    cleanups.push(() => queue.dispose());
    const router = authenticatedTestRouter(getOperator(db)!);
    registerAuthRoutes(router, queue, new AuthAutoApproveManager({ db }), undefined, inlineLedgerReader(() => queue.db));
    registerInboxRoutes(router as never, undefined, queue, undefined, inlineLedgerReader());
    const undelivered = async () => {
      const response = await router.invoke({ method: "GET", url: "/api/inbox/undelivered?target_session_id=owner-session" });
      expect(response.status).toBe(200);
      return (response.body as { undelivered: Array<{ id: string; status: string }> }).undelivered;
    };

    const request = await queue.submit({
      ...AUTH_COMMAND_REVIEW, type: "commit", command: "git commit -S", title: "Signed commit", target_session_id: "owner-session",
    });
    await approveFixtureRequest(queue, request.id);
    await waitForStatus(queue, request.id, "failed");
    expect(await undelivered()).toEqual([expect.objectContaining({ id: request.id, status: "failed" })]);
    expect((await router.invoke({ method: "POST", url: `/api/inbox/delivered/${request.id}`, body: {} })).status).toBe(204);
    expect((await router.invoke({ method: "POST", url: `/api/inbox/auth_result/${request.id}/ack`, body: {} })).status).toBe(200);
    expect(await undelivered()).toEqual([]);

    expect((await router.invoke({ method: "POST", url: `/api/auth/request/${request.id}/retry`, body: {} })).body).toMatchObject({ status: "pending" });
    expect(await queue.getRequest(request.id)).toMatchObject({ delivered_at: null, acknowledged_by: null });
    await approveFixtureRequest(queue, request.id);
    await waitForStatus(queue, request.id, "failed");

    expect(await undelivered()).toEqual([expect.objectContaining({ id: request.id, status: "failed" })]);
  });
});
