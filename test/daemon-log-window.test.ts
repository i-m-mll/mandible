// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";

import { openOperationalLogStore } from "../src/operational-log-db.js";
import { LOG_WINDOW_ROWS, registerSystemRoutes } from "../src/routes/system.js";
import type { RouteHandler, RouteRegistrar } from "../src/server.js";

// Issue 138d38a: a logs request examined every row and stalled the daemon.
it("examines a bounded window per logs request and seeks keyed filters by index", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-log-window-"));
  const store = openOperationalLogStore(path.join(dir, "mandible.db"), { dbPath: path.join(dir, "logs.db") })!;
  try {
    const insert = store.db.prepare(
      "INSERT INTO daemon_log (id, ts, level, event, subsystem, fields_json) VALUES (?, ?, 'info', ?, ?, ?)",
    );
    store.db.exec("BEGIN");
    insert.run("old", 1, "auth_failure", "auth", '{"detail":"needle"}');
    for (let index = 0; index < LOG_WINDOW_ROWS; index += 1) {
      insert.run(`new-${index}`, 2 + index, "http_request", "http", "{}");
    }
    store.db.exec("COMMIT");

    let handler: RouteHandler | undefined;
    const routes = { get: (route: string, next: RouteHandler) => { if (route === "/api/system/logs") handler = next; }, post() {} };
    registerSystemRoutes(routes as unknown as RouteRegistrar, { getRepos: () => [] } as never, store.db);
    const logs = async (query: Record<string, string>) => {
      let payload: { entries: Array<{ id: string }>; has_older: boolean; older_cursor: string | null } | undefined;
      const res = { status: () => res, json: (body: typeof payload) => { payload = body; } };
      await handler!({ method: "GET", url: "/api/system/logs", params: {}, query, body: undefined }, res as never);
      return payload!;
    };

    expect((await logs({ subsystem: "auth" })).entries.map((entry) => entry.id)).toEqual(["old"]);
    const head = await logs({ q: "needle" });
    expect(head).toMatchObject({ entries: [], has_older: true });
    expect((await logs({ q: "needle", before: head.older_cursor! })).entries.map((entry) => entry.id)).toEqual(["old"]);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
