import SqliteDatabase from "../../src/sqlite.ts";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/sse", () => ({
  broadcast: vi.fn(),
}));

import { migrate } from "../../src/db";
import { SessionRegistry } from "../../src/registry";
import { SessionDiscovery } from "../../src/session-discovery";
import { WorkScanner } from "../../src/work-scanner";
import type { Logger } from "../../src/types";

const noopLogger: Logger = () => {};

function createDiscovery(): {
  discovery: SessionDiscovery;
  registry: SessionRegistry;
  db: InstanceType<typeof SqliteDatabase>;
} {
  const db = new SqliteDatabase(":memory:");
  migrate(db);
  const registry = new SessionRegistry(db);
  // Empty repo roots keep discovery off the developer's real repositories: the
  // worktree scan resolves to nothing, so the pass exercises the async reaping
  // path without touching on-disk state.
  const workScanner = new WorkScanner({ db, repo_roots: [] });
  const discovery = new SessionDiscovery(db, registry, workScanner, noopLogger);
  return { discovery, registry, db };
}

describe("SessionDiscovery", () => {
  let discovery: SessionDiscovery;
  let registry: SessionRegistry;
  let db: InstanceType<typeof SqliteDatabase>;

  beforeEach(() => {
    ({ discovery, registry, db } = createDiscovery());
  });

  it("resolves discoverSessions to a result packet without blocking spawns", async () => {
    const result = await discovery.discoverSessions();
    expect(result).toMatchObject({
      discovered: expect.any(Number),
      dead_reaped: expect.any(Number),
      already_tracked: expect.any(Number),
      processes_found: expect.any(Number),
      duration_ms: expect.any(Number),
    });
  });

  it("reaps active sessions whose pid is no longer alive", async () => {
    // registerSession reconciles a dead pid to 'dead' on insert, so force the
    // row back to 'active' to model a process that exited after registration.
    // 0x7fffffff is far above any real pid, so process.kill(pid, 0) reports it
    // dead and the reaper marks the session dead.
    registry.registerSession({
      id: "sess-dead",
      app: "claude",
      cwd: "/tmp",
      pid: 0x7fffffff,
      status: "active",
    });
    db.prepare("UPDATE sessions SET status = 'active', ended_at = NULL WHERE id = ?").run("sess-dead");

    const result = await discovery.discoverSessions();
    expect(result.dead_reaped).toBeGreaterThanOrEqual(1);

    const reaped = registry.getSession("sess-dead");
    expect(reaped?.status).toBe("dead");
  });
});
