// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { AuthQueue } from "../src/auth-queue.js";
import { configureDaemonLogger, flushDaemonLogger, stopDaemonLogger } from "../src/daemon-log.js";
import { setDb, type Db } from "../src/db.js";
import { inlineLedgerReader } from "../src/ledger-reads/index.js";
import { openOperationalLogStore } from "../src/operational-log-db.js";
import { registerAuthRoutes } from "../src/routes/auth.js";
import { setupOperator } from "../src/users/store.js";
import { createNoopHookManager } from "./helpers/auth-queue-fixtures.js";
import { authenticatedTestRouter } from "./helpers/authenticated-router.js";
import { migratedFileDb } from "./helpers/ledger-fixtures.js";

let root: string; let db: Db; let logDb: Db; let queue: AuthQueue;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-approval-errors-"));
  db = migratedFileDb(path.join(root, "mandible.db")); setDb(db);
  logDb = openOperationalLogStore(path.join(root, "mandible.db"))!.db;
  configureDaemonLogger(logDb, { settingsDb: db });
  queue = new AuthQueue({ db, hookManager: createNoopHookManager(), backgroundMaintenance: false });
});
afterEach(async () => {
  stopDaemonLogger();
  await queue.dispose();
  db.close();
  fs.rmSync(root, { recursive: true, force: true });
});

it("an unexpected approval failure reaches the caller with its message and the daemon log with its stack", async () => {
  const operator = setupOperator(db, { display_name: "Operator", email: "op@example.test" });
  queue.approveAsOperator = async () => { throw new Error("Commit identity contains characters git does not allow."); };
  const router = authenticatedTestRouter(operator);
  registerAuthRoutes(router, queue, inlineLedgerReader(() => db));

  const response = await router.invoke({ method: "POST", url: "/api/auth/request/any/approve", body: { lifecycle_revision: 1 } });
  expect(response).toMatchObject({ status: 500, body: { error: "Commit identity contains characters git does not allow.", code: "unexpected_error" } });

  flushDaemonLogger();
  const logged = logDb.prepare("SELECT level, fields_json FROM daemon_log WHERE event = 'route_unexpected_error'").all() as Array<{ level: string; fields_json: string }>;
  expect(logged).toHaveLength(1);
  expect(logged[0]!.level).toBe("error");
  expect(JSON.parse(logged[0]!.fields_json)).toMatchObject({ route: "auth", error: "Commit identity contains characters git does not allow.", stack: expect.stringContaining("approval-route-errors.test") });
});
