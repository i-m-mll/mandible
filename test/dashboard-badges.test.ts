import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setDb } from "../src/db.js";
import { migratedMemoryDb } from "./helpers/ledger-fixtures.js";
import { attachDashboardBadgePublisher, readDashboardBadgeCounts } from "../src/dashboard-badges.js";
import { DOMAIN_EVENTS, type DashboardBadgeCounts, type MandibleEventType } from "../src/contracts.js";

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

  it("counts only badge-relevant records from cached database state", async () => {
    db.prepare(
      "INSERT INTO sessions (id, app, status, continuation) VALUES (?, ?, ?, ?)",
    ).run("ended", "codex", "ended", "resume me");
    db.prepare(
      `INSERT INTO auth_requests
       (id, command, title, status, created_at, updated_at, expires_at, resolved_at)
       VALUES (?, '', ?, 'completed', ?, ?, ?, ?)`,
    ).run("resolved", "Resolved", 1, 1, Date.now() + 60_000, Date.now());
    const queued = db.prepare(
      `INSERT INTO auth_requests (id, command, title, status, created_at, updated_at, expires_at)
       VALUES (?, '', ?, ?, 1, 1, ?)`,
    );
    for (const status of ["pending", "needs_rebase", "approved"]) queued.run(status, status, status, Date.now() + 60_000);
    db.prepare(
      `INSERT INTO work_repos (id, root, name, dir_exists, excluded)
       VALUES ('visible', '/visible', 'Visible', 1, 0), ('excluded', '/excluded', 'Excluded', 1, 1)`,
    ).run();
    db.prepare(
      `INSERT INTO branches (repo_root, branch, is_dirty)
       VALUES ('/visible', 'dirty', 1), ('/visible', 'clean', 0), ('/excluded', 'dirty', 1)`,
    ).run();

    expect(readDashboardBadgeCounts(db)).toEqual({
      auth: 2,
      inbox: 3,
      work: 1,
      briefing: 0,
      incidents: 0,
      tasks: 0,
    });
  });

  it("dashboard_badges_keep_briefing_and_incidents_separate", async () => {
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

    expect(readDashboardBadgeCounts(db)).toMatchObject({
      briefing: 0,
      incidents: 1,
    });
  });
});

describe("dashboard badge publisher", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("computes once per burst for all clients and pushes only changed counts", () => {
    vi.useFakeTimers();
    const observers: Array<(type: MandibleEventType) => void> = [];
    const pushed: unknown[] = [];
    let clients = 2;
    const sse = {
      count: () => clients,
      observe: (observer: (type: MandibleEventType) => void) => { observers.push(observer); return () => undefined; },
      broadcast: (event: { data: unknown }) => { pushed.push(event.data); },
    };
    let counts: DashboardBadgeCounts = { auth: 1, inbox: 0, work: 0, briefing: 0, incidents: 0, tasks: 0 };
    const read = vi.fn(() => counts);
    attachDashboardBadgePublisher(sse as never, read, () => undefined);
    const emit = (type: MandibleEventType) => observers.forEach((observer) => observer(type));

    emit(DOMAIN_EVENTS.CONVERSATION_UPDATED);
    emit(DOMAIN_EVENTS.HEARTBEAT);
    vi.advanceTimersByTime(1_000);
    expect(read).not.toHaveBeenCalled();

    for (let i = 0; i < 20; i++) emit(DOMAIN_EVENTS.AUTH_NEW);
    vi.advanceTimersByTime(499);
    expect(read).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(read).toHaveBeenCalledTimes(1);
    expect(pushed).toEqual([counts]);

    emit(DOMAIN_EVENTS.SESSION_UPDATED);
    vi.advanceTimersByTime(500);
    expect(read).toHaveBeenCalledTimes(2);
    expect(pushed).toHaveLength(1);

    counts = { ...counts, auth: 0 };
    emit(DOMAIN_EVENTS.AUTH_RESOLVED);
    vi.advanceTimersByTime(500);
    expect(pushed).toEqual([{ ...counts, auth: 1 }, counts]);

    clients = 0;
    emit(DOMAIN_EVENTS.AUTH_NEW);
    vi.advanceTimersByTime(500);
    expect(read).toHaveBeenCalledTimes(3);
  });
});
