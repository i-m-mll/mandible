import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { migrate, setDb } from "../src/db.js";
import { readDashboardBadgeCounts, registerDashboardRoutes } from "../src/routes/dashboard.js";
import { Router } from "../src/server.js";

describe("dashboard badge aggregate", () => {
  const db = new Database(":memory:");
  migrate(db);
  setDb(db);

  afterEach(() => {
    db.exec("DELETE FROM sessions; DELETE FROM auth_requests; DELETE FROM branches; DELETE FROM work_repos;");
  });

  it("counts only badge-relevant records from cached database state", () => {
    db.prepare(
      "INSERT INTO sessions (id, app, status, continuation) VALUES (?, ?, ?, ?)",
    ).run("ended", "codex", "ended", "resume me");
    db.prepare(
      `INSERT INTO auth_requests
       (id, command, title, status, created_at, updated_at, expires_at, resolved_at)
       VALUES (?, '', ?, 'completed', ?, ?, ?, ?)`,
    ).run("resolved", "Resolved", 1, 1, Date.now() + 60_000, Date.now());
    db.prepare(
      `INSERT INTO work_repos (id, root, name, dir_exists, excluded)
       VALUES ('visible', '/visible', 'Visible', 1, 0), ('excluded', '/excluded', 'Excluded', 1, 1)`,
    ).run();
    db.prepare(
      `INSERT INTO branches (repo_root, branch, is_dirty)
       VALUES ('/visible', 'dirty', 1), ('/visible', 'clean', 0), ('/excluded', 'dirty', 1)`,
    ).run();
    const authQueue = {
      listActive: () => [
        { status: "pending" },
        { status: "needs_rebase" },
        { status: "approved" },
      ],
    };

    expect(readDashboardBadgeCounts(authQueue as never, db)).toEqual({
      auth: 2,
      inbox: 2,
      work: 1,
    });
  });

  it("serves the compact aggregate without full tab payloads", async () => {
    const router = new Router();
    registerDashboardRoutes(router, { listActive: () => [] } as never, db);

    const response = await router.invoke({ method: "GET", url: "/api/dashboard/badges" });

    expect(response).toEqual({
      status: 200,
      body: { auth: 0, inbox: 0, work: 0 },
    });
  });
});
