// @vitest-environment node
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import SqliteDatabase from "../src/sqlite.ts";
import {
  SessionRegistry,
  checkLiveness,
  ensureSessionSchema,
  readPidStartTime,
} from "../src/registry.js";
import { migrate } from "../src/db.js";
import { ReaperTimer } from "../src/session-reaper.js";
import type { Session } from "../src/types.js";
import { testRuntimeRoot } from "./helpers/runtime-isolation.js";
import { waitUntil } from "./helpers/wait-until.js";

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

/** The pid of a process that has started and then exited, with its recorded start time. */
async function exitedProcess(): Promise<{ pid: number; pidStart: string }> {
  const child = spawn("sleep", ["30"]);
  const pid = child.pid ?? 0;
  expect(pid).toBeGreaterThan(0);
  const pidStart = await waitUntil(() => readPidStartTime(pid), "the child's start time");
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.kill();
  await exited;
  return { pid, pidStart };
}

function pidlessSession(updatedAt: string): Session {
  return {
    id: "no-pid", app: "claude", pid: null, pid_start: null, cwd: null, branch: null, worktree: null,
    terminal: null, multiplexer: null, nav_session: null, nav_tab: null, nav_pane_id: null, nav_extra: null,
    nav_metadata_status: "not_applicable", nav_metadata_attempts: 0, nav_metadata_last_error: null,
    nav_metadata_last_attempt_at: null, nav_metadata_next_retry_at: null, task: null, status: "active",
    parent_id: null, agent_type: null, description: null, conversation_id: null, created_at: updatedAt, updated_at: updatedAt,
    pinned: 0, continuation: null, continuation_acked_by: null, ended_at: null, last_active: null,
    channel_connected_at: null, channel_last_tool_call: null, owner_user_id: null, identity_mismatch: null,
  };
}

describe("session registry", () => {
  // Issue e726bfe: the bootstrap only creates a fresh schema, so it must stay
  // column-, index- and key-complete against the migrated schema, and must
  // never upgrade an existing table, which is the migration chain's job.
  it("bootstraps a fresh sessions schema identical to the migrated one", () => {
    const bootstrapped = new SqliteDatabase(":memory:");
    const migrated = new SqliteDatabase(":memory:");
    try {
      bootstrapped.exec("CREATE TABLE users (id TEXT PRIMARY KEY)");
      ensureSessionSchema(bootstrapped);
      migrate(migrated);
      const foreignKeys = (db: SqliteDb) => db.prepare('SELECT "from", "table", on_delete FROM pragma_foreign_key_list(\'sessions\') ORDER BY "from"').all();
      expect(describeSessionsTable(bootstrapped)).toEqual(describeSessionsTable(migrated));
      expect(sessionsIndexNames(bootstrapped)).toEqual(sessionsIndexNames(migrated));
      expect(foreignKeys(bootstrapped)).toEqual(foreignKeys(migrated));
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
      db.prepare("INSERT INTO sessions (id, app, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
        .run("s1", "claude", "active", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z");
      new SessionRegistry(db);
      expect(describeSessionsTable(db)).toEqual(before);
      expect(db.prepare("SELECT COUNT(*) AS n FROM sessions").get()).toEqual({ n: 1 });
    } finally {
      db.close();
    }
  });

  it("marks a session dead when its pid is gone or reused, and keeps the live one active", async () => {
    const registry = createRegistry();
    const { pid, pidStart } = await exitedProcess();
    registry.registerSession({ id: "gone", app: "claude", pid, pid_start: pidStart, status: "active" });
    registry.registerSession({ id: "reused", app: "claude", pid: process.pid, pid_start: "1970-01-01T00:00:00.000Z", status: "active" });
    registry.registerSession({ id: "live", app: "claude", pid: process.pid, pid_start: readPidStartTime(process.pid), status: "active" });
    const page = registry.listSessionsPage({ scope: "all" });
    expect(Object.fromEntries(page.sessions.map((session) => [session.id, session.status])))
      .toEqual({ gone: "dead", reused: "dead", live: "active" });
    expect(registry.getSessionByPid(process.pid)?.id).toBe("live");
  });

  it("marks a PID-less session dead only after a day without updates", () => {
    expect(checkLiveness(pidlessSession(new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString()))).toBe("dead");
    expect(checkLiveness(pidlessSession(new Date().toISOString()))).toBe("alive");
  });

  it("pages with a bounded default, a stable cursor and the status filter applied to the total", () => {
    const registry = createRegistry();
    for (let i = 0; i < 5; i += 1) registry.registerSession({ id: `page-${i}`, app: "claude", status: "ended" });
    registry.registerSession({ id: "act-1", app: "claude", status: "active" });

    const seen: string[] = [];
    let cursor: string | null | undefined;
    do {
      const page = registry.listSessionsPage({ limit: 2, status: "ended", ...(cursor ? { cursor } : {}) });
      expect(page).toMatchObject({ total: 5, scope: "default", limit: 2 });
      expect(page.sessions.length).toBeLessThanOrEqual(2);
      seen.push(...page.sessions.map((session) => session.id));
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen.sort()).toEqual(["page-0", "page-1", "page-2", "page-3", "page-4"]);
    expect(registry.listSessionsPage({ scope: "all" })).toMatchObject({ total: 6, nextCursor: null, limit: null });
  });
});

/** Run `body` with a `ps` first on PATH that runs `script` (sh) before or instead of the real one. */
async function withPs<T>(name: string, script: string, body: () => Promise<T>): Promise<T> {
  const dir = path.join(testRuntimeRoot, `ps-${name}`);
  fs.mkdirSync(dir, { recursive: true });
  const realPath = process.env.PATH ?? "";
  fs.writeFileSync(path.join(dir, "ps"), `#!/bin/sh\nPATH='${realPath}'\n${script}\n`, { mode: 0o755 });
  process.env.PATH = `${dir}:${realPath}`;
  try {
    return await body();
  } finally {
    process.env.PATH = realPath;
  }
}

/** A running child with its recorded start time. */
async function liveProcess(): Promise<{ pid: number; pidStart: string; stop: () => Promise<unknown> }> {
  const child = spawn("sleep", ["30"]);
  const pid = child.pid ?? 0;
  const pidStart = await waitUntil(() => readPidStartTime(pid), "the child's start time");
  const exited = new Promise((resolve) => child.once("exit", resolve));
  return { pid, pidStart, stop: () => (child.kill(), exited) };
}

/** Registration judges liveness itself, so a session goes stale only after it is registered live. */
function registerLive(db: SqliteDb, registry: SessionRegistry, id: string, process: { pid: number; pidStart: string }): void {
  registry.registerSession({ id, app: "claude", pid: process.pid, pid_start: process.pidStart, status: "active" });
  expect(registry.getSession(id)?.status).toBe("active");
}

function reusePid(db: SqliteDb, id: string): void {
  db.prepare("UPDATE sessions SET pid_start = ? WHERE id = ?").run("1970-01-01T00:00:00.000Z", id);
}

describe("session reaper", () => {
  it("keeps the event loop free while ps is slow, and ends only sessions whose process is gone or reused", async () => {
    const db = new SqliteDatabase(":memory:");
    db.exec("CREATE TABLE users (id TEXT PRIMARY KEY)");
    const registry = new SessionRegistry(db);
    const live = await liveProcess();
    const reused = await liveProcess();
    const gone = await liveProcess();
    try {
      registerLive(db, registry, "live", live);
      registerLive(db, registry, "reused", reused);
      registerLive(db, registry, "gone", gone);
      reusePid(db, "reused");
      await gone.stop();

      const { maxGapMs, tickMs } = await withPs("slow", 'sleep 0.3\nexec ps "$@"', async () => {
        let maxGapMs = 0;
        let last = performance.now();
        let probed = () => {};
        const probe = setInterval(() => {
          const now = performance.now();
          maxGapMs = Math.max(maxGapMs, now - last);
          last = now;
          probed();
        }, 2);
        const started = performance.now();
        try {
          await new ReaperTimer(registry, () => undefined).tick();
          const tickMs = performance.now() - started;
          await new Promise<void>((resolve) => { probed = resolve; });
          return { maxGapMs, tickMs };
        } finally {
          clearInterval(probe);
        }
      });

      expect(tickMs).toBeGreaterThanOrEqual(300);
      expect(maxGapMs).toBeLessThan(50);
      const status = (id: string) => (db.prepare("SELECT status FROM sessions WHERE id = ?").get(id) as { status: string }).status;
      expect({ live: status("live"), reused: status("reused"), gone: status("gone") })
        .toEqual({ live: "active", reused: "dead", gone: "dead" });
    } finally {
      await Promise.all([live.stop(), reused.stop()]);
      db.close();
    }
  });

  it("ends no session for want of a start time when ps cannot answer", async () => {
    const db = new SqliteDatabase(":memory:");
    db.exec("CREATE TABLE users (id TEXT PRIMARY KEY)");
    const registry = new SessionRegistry(db);
    const live = await liveProcess();
    try {
      registerLive(db, registry, "reused", live);
      reusePid(db, "reused");
      const reaped = await withPs("broken", "echo 'ps: unavailable' >&2\nexit 2", () => registry.reapDead());
      expect(reaped).toEqual([]);
      expect((await registry.reapDead()).map((session) => session.id)).toEqual(["reused"]);
    } finally {
      await live.stop();
      db.close();
    }
  });
});
