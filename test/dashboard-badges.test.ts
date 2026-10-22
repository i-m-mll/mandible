import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { setDb } from "../src/db.js";
import { migratedMemoryDb } from "./helpers/ledger-fixtures.js";
import { readDashboardBadgeCounts } from "../src/routes/dashboard.js";

describe("dashboard badge aggregate", () => {
  const db = migratedMemoryDb();

  // Issue c4f456c: the singleton binding is dropped after every test, so it is
  // installed per test rather than once for the whole describe block.
  beforeEach(() => {
    setDb(db);
  });

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
      briefing: 0,
      incidents: 0,
      tasks: 0,
    });
  });

  it("dashboard_badges_keep_briefing_and_incidents_separate", () => {
    const insert = db.prepare(
      `INSERT INTO operational_incidents (
         id, executor, task, condition, first_seen, observation_state,
         attention_state, remediation_state, latest_event_seq, latest_observed_at,
         latest_event_id, latest_telemetry_json, latest_telemetry_sha256,
         posted_by_user_id, resolved_at, resolution_kind, operator_closed_at,
         operator_closed_by_user_id, acknowledged_at, acknowledged_by_user_id,
         created_at, updated_at
       ) VALUES (?, 'agent-schedule', ?, 'failed_permanent', ?, 'active', ?, ?,
                 1, ?, ?, '{}', ?, '00000000000000000000000000', ?, ?, ?, ?, ?, ?, 1, 1)`,
    );
    const hash = "a".repeat(64);
    insert.run("unack", "one", 1, "unacknowledged", "none", 1, "event-1", hash,
      null, null, null, null, null, null);
    insert.run("ack", "two", 2, "acknowledged", "none", 2, "event-2", hash,
      null, null, null, null, 2, "00000000000000000000000000");
    insert.run("closed", "three", 3, "acknowledged", "complete", 3, "event-3", hash,
      3, "operator_closure", 3, "00000000000000000000000000",
      3, "00000000000000000000000000");

    expect(readDashboardBadgeCounts({ listActive: () => [] } as never, db)).toMatchObject({
      briefing: 0,
      incidents: 1,
    });
  });
});
