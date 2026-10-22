// @vitest-environment node
/**
 * Trash custody finality: whatever the daemon reports, the CLI must say exactly
 * which local paths are gone, so no one keeps working in a removed worktree.
 */
import { afterEach, describe, expect, it } from "vitest";

import { runCli, startStubDaemon, type StubResponse } from "./helpers/cli-process.js";

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function trash(response: StubResponse) {
  const stub = await startStubDaemon(({ method, url }) => method === "POST" && url === "/api/v1/trash" ? response : undefined);
  cleanups.push(() => stub.close());
  return runCli(["trash", "create", "--project", "mandible", "--branch", "feature/demo", "--reason", "merged", "--checkout-root", "/registered/repo"], { env: stub.env });
}

describe("trash CLI", () => {
  it("exits non-zero after a partial removal and still reports the worktree path as gone", async () => {
    const result = await trash({
      status: 409,
      body: {
        error: "snapshot is safe but local removal failed",
        code: "remove_failed",
        detail: { id: "trash-1", outcome: { worktree_removed: true, branch_removed: false, worktree_path: "/registered/repo/worktrees/feature__demo" } },
      },
    });

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("Trash custody incomplete");
    expect(result.stderr).toContain("worktree path /registered/repo/worktrees/feature__demo is gone");
    expect(result.stderr).toContain("No further work may happen there");
  });

  it("reports branch-only success without claiming that a worktree path is gone", async () => {
    const result = await trash({
      status: 201,
      body: { entry: { id: "trash-1", branch: "feature/demo", state: "active" }, outcome: { worktree_removed: false, branch_removed: true, worktree_path: null } },
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).toContain("normal branch ref is gone");
    expect(result.stderr).not.toContain("worktree path");
    expect(result.stderr).not.toContain("No further work may happen there");
  });
});
