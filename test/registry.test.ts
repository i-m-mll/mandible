import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import SqliteDatabase from "../src/sqlite.ts";
import {
  SessionRegistry,
  checkLiveness,
  ensureSessionSchema,
  readPidStartTime,
} from "../src/registry.js";
import { migrate } from "../src/db.js";
import type { Session } from "../src/types.js";

type SqliteDb = InstanceType<typeof SqliteDatabase>;

function createRegistry(): SessionRegistry {
  const db = new SqliteDatabase(":memory:");
  db.exec("CREATE TABLE users (id TEXT PRIMARY KEY)");
  return new SessionRegistry(db);
}

function describeSessionsTable(db: SqliteDb): Array<Record<string, unknown>> {
  return (db.prepare("PRAGMA table_info(sessions)").all() as Array<{
    name: string;
    type: string;
    notnull: number;
    dflt_value: string | null;
    pk: number;
  }>)
    .map(({ name, type, notnull, dflt_value, pk }) => ({ name, type, notnull, dflt_value, pk }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function sessionsIndexNames(db: SqliteDb): string[] {
  return (db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'sessions' AND sql IS NOT NULL",
    )
    .all() as Array<{ name: string }>)
    .map((row) => row.name)
    .sort();
}

async function waitForPidStart(pid: number): Promise<string | null> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const start = readPidStartTime(pid);
    if (start) {
      return start;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return null;
}

describe("session registry", () => {
  it("creates the standalone session schema with the ownership foreign key", () => {
    const db = new SqliteDatabase(":memory:");
    try {
      db.exec("CREATE TABLE users (id TEXT PRIMARY KEY)");
      ensureSessionSchema(db);
      const foreignKeys = db.prepare("PRAGMA foreign_key_list(sessions)").all() as Array<{
        from: string;
        table: string;
        on_delete: string;
      }>;
      expect(foreignKeys).toContainEqual(expect.objectContaining({
        from: "owner_user_id",
        table: "users",
        on_delete: "SET NULL",
      }));
    } finally {
      db.close();
    }
  });

  // Issue e726bfe — SessionRegistry used to run a PRAGMA plus fourteen guarded
  // ALTER TABLE statements on every construction, duplicating the migration
  // chain. The bootstrap now only creates a fresh schema, so it has to stay
  // column- and index-complete against the migrated schema or isolated tests
  // would silently get a stale sessions table.
  it("bootstraps a fresh sessions schema identical to the migrated one", () => {
    const bootstrapped = new SqliteDatabase(":memory:");
    const migrated = new SqliteDatabase(":memory:");
    try {
      bootstrapped.exec("CREATE TABLE users (id TEXT PRIMARY KEY)");
      ensureSessionSchema(bootstrapped);
      migrate(migrated);

      expect(describeSessionsTable(bootstrapped)).toEqual(describeSessionsTable(migrated));
      expect(sessionsIndexNames(bootstrapped)).toEqual(sessionsIndexNames(migrated));
    } finally {
      bootstrapped.close();
      migrated.close();
    }
  });

  it("never alters an existing sessions table from the registry bootstrap", () => {
    const db = new SqliteDatabase(":memory:");
    try {
      db.exec("CREATE TABLE users (id TEXT PRIMARY KEY)");
      ensureSessionSchema(db);
      const before = describeSessionsTable(db);

      // A second construction against an already-populated database must be a
      // no-op: upgrades are the migration chain's job, not the registry's.
      db.prepare(
        "INSERT INTO sessions (id, app, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      ).run("s1", "claude", "active", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z");
      new SessionRegistry(db);

      expect(describeSessionsTable(db)).toEqual(before);
      expect(db.prepare("SELECT COUNT(*) AS n FROM sessions").get()).toEqual({ n: 1 });
    } finally {
      db.close();
    }
  });

  it("registers and fetches a session", () => {
    const registry = createRegistry();
    const session = registry.registerSession({
      id: "sess-1",
      app: "claude",
      cwd: "/tmp",
      status: "active",
    });

    const fetched = registry.getSession(session.id);
    expect(fetched).toBeTruthy();
    expect(fetched?.id).toBe("sess-1");
    expect(fetched?.app).toBe("claude");
  });

  it("builds a three-level session tree", () => {
    const registry = createRegistry();
    registry.registerSession({ id: "root", app: "claude" });
    registry.registerChildSession("root", { id: "child", agent_type: "planner" });
    registry.registerChildSession("child", { id: "grand", agent_type: "worker" });

    const tree = registry.getSessionTree("root");
    expect(tree).toBeTruthy();
    expect(tree?.children?.length).toBe(1);
    expect(tree?.children?.[0].id).toBe("child");
    expect(tree?.children?.[0].children?.[0].id).toBe("grand");
  });

  it("marks dead sessions when pid is gone", async () => {
    const registry = createRegistry();
    const child = spawn("sleep", ["0.2"]);
    const pid = child.pid ?? 0;
    expect(pid).toBeGreaterThan(0);

    const pidStart = await waitForPidStart(pid);
    if (child.exitCode === null) {
      child.kill();
    }
    if (child.exitCode === null) {
      await new Promise((resolve) => child.once("exit", resolve));
    }

    registry.registerSession({
      id: "dead-session",
      app: "claude",
      pid,
      pid_start: pidStart,
      status: "active",
    });

    const updated = registry.getSession("dead-session");
    expect(updated?.status).toBe("dead");
  });

  it("registerChildSession sets task from description", () => {
    const registry = createRegistry();
    registry.registerSession({ id: "parent", app: "claude" });
    const child = registry.registerChildSession("parent", {
      id: "child-task",
      agent_type: "worker",
      description: "Fixing SSE bugs",
    });
    expect(child).toBeTruthy();
    expect(child?.task).toBe("Fixing SSE bugs");
    expect(child?.description).toBe("Fixing SSE bugs");
  });

  it("marks zellij sessions without tab metadata as pending", () => {
    const registry = createRegistry();
    const session = registry.registerSession({
      id: "zj-pending",
      app: "claude",
      multiplexer: "zellij",
      nav_session: "my-session",
      nav_pane_id: "7",
      status: "active",
    });
    expect(session.nav_metadata_status).toBe("pending");
    expect(session.nav_tab).toBeNull();
    expect(session.nav_metadata_attempts).toBe(0);
  });

  it("lists sessions needing nav metadata and updates resolved tab", () => {
    const registry = createRegistry();
    registry.registerSession({
      id: "zj-needs-nav",
      app: "claude",
      multiplexer: "zellij",
      nav_session: "my-session",
      status: "active",
    });
    const pending = registry.listSessionsNeedingNavMetadata();
    expect(pending.map((session) => session.id)).toContain("zj-needs-nav");

    const updated = registry.updateSessionNavMetadata("zj-needs-nav", {
      nav_tab: "wt:main",
      nav_metadata_status: "ready",
      nav_metadata_attempts: 0,
      nav_metadata_last_error: null,
      nav_metadata_last_attempt_at: new Date().toISOString(),
      nav_metadata_next_retry_at: null,
    });
    expect(updated?.nav_tab).toBe("wt:main");
    expect(updated?.nav_metadata_status).toBe("ready");
  });

  it("getSessionByPid returns matching active session", () => {
    const registry = createRegistry();
    registry.registerSession({
      id: "pid-sess",
      app: "claude",
      pid: process.pid,
      pid_start: readPidStartTime(process.pid),
      status: "active",
    });
    const found = registry.getSessionByPid(process.pid);
    expect(found).toBeTruthy();
    expect(found?.id).toBe("pid-sess");
  });

  it("getSessionByPid returns null for unknown pid", () => {
    const registry = createRegistry();
    const found = registry.getSessionByPid(999999);
    expect(found).toBeNull();
  });

  it("marks stale PID-less session as dead after 24h", () => {
    const staleDate = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    const session: Session = {
      id: "stale-no-pid",
      app: "claude",
      pid: null,
      pid_start: null,
      cwd: null,
      branch: null,
      worktree: null,
      terminal: null,
      multiplexer: null,
      nav_session: null,
      nav_tab: null,
      nav_pane_id: null,
      nav_extra: null,
      nav_metadata_status: "not_applicable",
      nav_metadata_attempts: 0,
      nav_metadata_last_error: null,
      nav_metadata_last_attempt_at: null,
      nav_metadata_next_retry_at: null,
      task: null,
      status: "active",
      parent_id: null,
      agent_type: null,
      description: null,
      created_at: staleDate,
      updated_at: staleDate,
      ended_at: null,
    };
    expect(checkLiveness(session)).toBe("dead");
  });

  it("keeps recent PID-less session alive", () => {
    const recentDate = new Date().toISOString();
    const session: Session = {
      id: "recent-no-pid",
      app: "claude",
      pid: null,
      pid_start: null,
      cwd: null,
      branch: null,
      worktree: null,
      terminal: null,
      multiplexer: null,
      nav_session: null,
      nav_tab: null,
      nav_pane_id: null,
      nav_extra: null,
      nav_metadata_status: "not_applicable",
      nav_metadata_attempts: 0,
      nav_metadata_last_error: null,
      nav_metadata_last_attempt_at: null,
      nav_metadata_next_retry_at: null,
      task: null,
      status: "active",
      parent_id: null,
      agent_type: null,
      description: null,
      created_at: recentDate,
      updated_at: recentDate,
      ended_at: null,
    };
    expect(checkLiveness(session)).toBe("alive");
  });

  it("detects pid reuse via start time mismatch", () => {
    const registry = createRegistry();
    registry.registerSession({
      id: "reuse-session",
      app: "claude",
      pid: process.pid,
      pid_start: "1970-01-01T00:00:00.000Z",
      status: "active",
    });

    const updated = registry.getSession("reuse-session");
    expect(updated?.status).toBe("dead");
  });

  it("bounds the default sessions page and paginates with a stable cursor", () => {
    const registry = createRegistry();
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const id = `page-${i}`;
      ids.push(id);
      registry.registerSession({ id, app: "claude", status: "ended" });
    }

    const first = registry.listSessionsPage({ limit: 2 });
    expect(first.total).toBe(5);
    expect(first.sessions.length).toBe(2);
    expect(first.returned).toBe(2);
    expect(first.scope).toBe("default");
    expect(first.limit).toBe(2);
    expect(first.nextCursor).toBeTruthy();

    const seen = new Set(first.sessions.map((s) => s.id));
    let cursor = first.nextCursor;
    let guard = 0;
    while (cursor && guard < 10) {
      guard += 1;
      const next = registry.listSessionsPage({ limit: 2, cursor });
      for (const s of next.sessions) {
        expect(seen.has(s.id)).toBe(false);
        seen.add(s.id);
      }
      cursor = next.nextCursor;
    }
    expect(seen.size).toBe(5);
    for (const id of ids) {
      expect(seen.has(id)).toBe(true);
    }
  });

  it("returns full history with scope 'all' and no cursor", () => {
    const registry = createRegistry();
    for (let i = 0; i < 3; i += 1) {
      registry.registerSession({ id: `all-${i}`, app: "claude", status: "ended" });
    }
    const page = registry.listSessionsPage({ scope: "all" });
    expect(page.total).toBe(3);
    expect(page.sessions.length).toBe(3);
    expect(page.nextCursor).toBeNull();
    expect(page.limit).toBeNull();
    expect(page.scope).toBe("all");
  });

  it("applies the status filter to the paginated total and rows", () => {
    const registry = createRegistry();
    registry.registerSession({ id: "act-1", app: "claude", status: "active" });
    registry.registerSession({ id: "end-1", app: "claude", status: "ended" });
    registry.registerSession({ id: "end-2", app: "claude", status: "ended" });
    const page = registry.listSessionsPage({ status: "ended" });
    expect(page.total).toBe(2);
    expect(page.sessions.every((s) => s.status === "ended")).toBe(true);
  });

  it("derives liveness for a batched page including dead and live pids", async () => {
    const registry = createRegistry();
    const child = spawn("sleep", ["0.2"]);
    const pid = child.pid ?? 0;
    expect(pid).toBeGreaterThan(0);
    const pidStart = await waitForPidStart(pid);
    if (child.exitCode === null) {
      child.kill();
    }
    if (child.exitCode === null) {
      await new Promise((resolve) => child.once("exit", resolve));
    }

    registry.registerSession({
      id: "batch-dead",
      app: "claude",
      pid,
      pid_start: pidStart,
      status: "active",
    });
    registry.registerSession({
      id: "batch-live",
      app: "claude",
      pid: process.pid,
      pid_start: readPidStartTime(process.pid),
      status: "active",
    });

    const page = registry.listSessionsPage({ scope: "all" });
    const byId = new Map(page.sessions.map((s) => [s.id, s]));
    expect(byId.get("batch-dead")?.status).toBe("dead");
    expect(byId.get("batch-live")?.status).toBe("active");
  });
});
