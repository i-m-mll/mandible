// @vitest-environment node
import { expect, it } from "vitest";
import { AUTH_SNAPSHOT_SHAPE } from "../src/auth-request-snapshot.js";
import { createMigratedDb } from "./helpers/auth-queue-fixtures.js";

// Every lifecycle revision hashes a snapshot of these fields. A column that
// joins `auth_requests` or `auth_request_actions` needs a deliberate decision
// in src/auth-request-snapshot.ts: a new shape that serializes the column only
// when it is set, or a migration that appends a canonical revision for every
// request. Otherwise existing revisions either stop verifying or never see it.
it("snapshots every auth request and action column", () => {
  const db = createMigratedDb();
  const columns = (table: string) =>
    (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((column) => column.name);
  expect(columns("auth_requests")).toEqual(AUTH_SNAPSHOT_SHAPE.request);
  expect(columns("auth_request_actions")).toEqual(AUTH_SNAPSHOT_SHAPE.actions);
  db.close();
});
