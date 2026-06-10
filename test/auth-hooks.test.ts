import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { AuthHookManager } from "../src/auth-hooks.js";
import { AuthQueue } from "../src/auth-queue.js";
import { migrate } from "../src/db.js";
import type { AuthRequest } from "../src/types.js";

function createDbWithHooks(): InstanceType<typeof Database> {
  const db = new Database(":memory:");
  migrate(db);
  return db;
}

describe("AuthHookManager", () => {
  it("lists hooks including built-in", () => {
    const db = createDbWithHooks();
    const manager = new AuthHookManager(db);
    const hooks = manager.list();
    const builtin = hooks.find((h) => h.id === "builtin-mandible-rebuild");
    expect(builtin).toBeDefined();
    expect(builtin!.repo_pattern).toBe("mandible");
    expect(builtin!.auth_type).toBe("merge");
    expect(builtin!.command).toBe("bash cli/post-merge-build-dist.sh");
    expect(builtin!.label).toBe("Build Mandible and install instructions after merge");
    expect(builtin!.builtin).toBe(true);
    expect(builtin!.enabled).toBe(true);
  });

  it("creates a custom hook", () => {
    const db = createDbWithHooks();
    const manager = new AuthHookManager(db);
    const hook = manager.create({
      repo_pattern: "feedbax",
      auth_type: "merge",
      command: "npm test",
      label: "Run tests after merge",
    });
    expect(hook.id).toBeTruthy();
    expect(hook.repo_pattern).toBe("feedbax");
    expect(hook.command).toBe("npm test");
    expect(hook.builtin).toBe(false);
    expect(hook.enabled).toBe(true);
  });

  it("updates hook fields", () => {
    const db = createDbWithHooks();
    const manager = new AuthHookManager(db);
    const hook = manager.create({
      repo_pattern: "test-repo",
      auth_type: "merge",
      command: "echo hello",
      label: "Test hook",
    });

    const updated = manager.update(hook.id, { command: "echo updated", enabled: false });
    expect(updated).not.toBeNull();
    expect(updated!.command).toBe("echo updated");
    expect(updated!.enabled).toBe(false);
  });

  it("deletes custom hooks but refuses to delete built-in hooks", () => {
    const db = createDbWithHooks();
    const manager = new AuthHookManager(db);

    // Try deleting built-in
    expect(() => manager.delete("builtin-mandible-rebuild")).toThrow(/built-in/i);

    // Create and delete a custom hook
    const hook = manager.create({
      repo_pattern: "test",
      auth_type: "merge",
      command: "echo test",
      label: "Custom",
    });
    expect(manager.delete(hook.id)).toBe(true);
    expect(manager.get(hook.id)).toBeNull();
  });

  it("finds matching hooks for a repo and auth type", () => {
    const db = createDbWithHooks();
    const manager = new AuthHookManager(db);

    // Built-in matches "mandible" repo with "merge" type.
    const mandibleHooks = manager.findMatchingHooks("mandible", "merge");
    expect(mandibleHooks.length).toBeGreaterThanOrEqual(1);
    expect(mandibleHooks.some((h) => h.id === "builtin-mandible-rebuild")).toBe(true);

    // Add a wildcard hook
    manager.create({
      repo_pattern: "*",
      auth_type: "merge",
      command: "echo all-repos",
      label: "All repos hook",
    });

    // "feedbax" should match the wildcard
    const feedbaxHooks = manager.findMatchingHooks("feedbax", "merge");
    expect(feedbaxHooks.some((h) => h.label === "All repos hook")).toBe(true);

    // "mandible" should match both the built-in and the wildcard.
    const mandibleHooks2 = manager.findMatchingHooks("mandible", "merge");
    expect(mandibleHooks2.length).toBeGreaterThanOrEqual(2);

    // Wrong auth type should not match
    const commitHooks = manager.findMatchingHooks("mandible", "commit");
    expect(commitHooks.some((h) => h.id === "builtin-mandible-rebuild")).toBe(false);
  });

  it("disabled hooks are not returned by findMatchingHooks", () => {
    const db = createDbWithHooks();
    const manager = new AuthHookManager(db);

    // Disable the built-in hook
    manager.update("builtin-mandible-rebuild", { enabled: false });

    const hooks = manager.findMatchingHooks("mandible", "merge");
    expect(hooks.some((h) => h.id === "builtin-mandible-rebuild")).toBe(false);
  });

  it("executes hooks and returns results", async () => {
    const db = createDbWithHooks();
    const manager = new AuthHookManager(db);

    // Create a simple echo hook
    manager.create({
      repo_pattern: "*",
      auth_type: "merge",
      command: "echo hook-ran-ok",
      label: "Test echo hook",
      position: 0,
    });

    // Disable the built-in to avoid npm install in tests
    manager.update("builtin-mandible-rebuild", { enabled: false });

    const fakeRequest: AuthRequest = {
      id: "test-req-1",
      session_id: null,
      type: "merge",
      command: "echo merge",
      title: "Test",
      cwd: "/tmp",
      diff_summary: null,
      commit_message: null,
      spec_content: null,
      repo: "test-repo",
      base_branch: "main",
      head_branch: "feature/test",
      execution_mode: "daemon",
      status: "completed",
      created_at: Date.now(),
      updated_at: Date.now(),
      last_executed_at: null,
      approved_at: null,
      resolved_at: null,
      skipped_at: null,
      expires_at: Date.now() + 86400000,
      exit_code: 0,
      output: "",
      error: null,
      acknowledged_by: null,
    };

    const results = await manager.executeHooks(fakeRequest);
    expect(results.length).toBe(1);
    expect(results[0].exit_code).toBe(0);
    expect(results[0].output).toContain("hook-ran-ok");
    expect(results[0].duration_ms).toBeGreaterThanOrEqual(0);
  });
});

describe("AuthQueue hook integration", () => {
  it("runs hooks after successful auth command execution", async () => {
    const db = createDbWithHooks();
    const hookManager = new AuthHookManager(db);

    // Create a simple hook that writes to a predictable output
    hookManager.create({
      repo_pattern: "*",
      auth_type: "merge",
      command: "echo hook-executed",
      label: "Integration test hook",
      position: 0,
    });
    // Disable built-in to avoid npm install
    hookManager.update("builtin-mandible-rebuild", { enabled: false });

    const queue = new AuthQueue({
      db,
      hookManager,
    });

    const request = queue.submit({
      command: 'echo "merge-ok"',
      title: "Test merge",
      repo: "test-repo",
      base_branch: "main",
      head_branch: "feature/test",
    });

    queue.approve(request.id);

    // Wait for completion
    const start = Date.now();
    while (Date.now() - start < 5000) {
      const req = queue.getRequest(request.id);
      if (req?.status === "completed") {
        // Hook output should be in the request output via handleOutput
        expect(req.output).toContain("hook-executed");
        expect(req.output).toContain("[hook: Integration test hook]");
        return;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error("Timed out waiting for auth request completion");
  });
});
