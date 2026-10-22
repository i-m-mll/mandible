// @vitest-environment node
/**
 * A reminder fires once, from exactly one trigger, under a durable idempotency
 * key: the CLI refuses anything else before transport, and the daemon's
 * identity, admission and idempotency refusals reach the caller intact.
 */
import { afterEach, describe, expect, it } from "vitest";

import { fileRpc, runCli } from "./helpers/cli-process.js";
import type { FileRpcHandler } from "./helpers/file-rpc-responder.js";

const cleanups: Array<() => unknown> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function spool(handler: FileRpcHandler) {
  const stub = fileRpc(handler);
  cleanups.push(() => stub.responder.stop());
  return stub;
}

const create = ["reminder", "create", "--project", "mandible", "--message", "Review"];

describe("reminder CLI", () => {
  it("refuses a missing idempotency key, a second trigger, or a malformed count trigger before transport", async () => {
    const { env, responder } = spool(() => ({ status: 500, body: { error: "unexpected request" } }));
    const cases: Array<[string[], string]> = [
      [["--at", "2026-08-15T12:00:00Z"], "--idempotency-key"],
      [["--idempotency-key", "review-20", "--at", "2026-08-15T12:00:00Z", "--issue-closed", "54a7bda"], "Arguments do not match"],
      [["--idempotency-key", "review-20", "--auth-merge-count-gte", "0"], "Invalid value for --auth-merge-count-gte"],
      [["--idempotency-key", "review-20", "--at", "2026-08-15T12:00:00Z", "--base-branch", "develop"], "Arguments do not match"],
    ];

    const results = await Promise.all(cases.map(([args]) => runCli([...create, ...args], { env })));

    for (const [index, [args, message]] of cases.entries()) {
      expect(results[index].status, args.join(" ")).toBe(2);
      expect(results[index].stderr, args.join(" ")).toContain(message);
    }
    expect(responder.requests).toEqual([]);
  });

  it("surfaces identity, project-admission, and idempotency conflicts with their codes", async () => {
    const failures = [
      { status: 401, code: "authentication_required", error: "Authentication required" },
      { status: 403, code: "project_permission_required", error: "Project write access required" },
      { status: 409, code: "idempotency_conflict", error: "Idempotency key was reused with different bytes" },
    ];

    const results = await Promise.all(failures.map((failure) => runCli(
      [...create, "--idempotency-key", "review-20", "--issue-closed", "54a7bda"],
      { env: spool(() => ({ status: failure.status, body: { code: failure.code, error: failure.error } })).env },
    )));

    for (const [index, failure] of failures.entries()) {
      expect(results[index].status, failure.code).not.toBe(0);
      expect(results[index].stderr).toContain(failure.code);
      expect(results[index].stderr).toContain(failure.error);
    }
  });
});
