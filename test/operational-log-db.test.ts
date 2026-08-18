import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  LEGACY_PRODUCTION_DB_PATH,
  PRODUCTION_DB_PATH,
  PRODUCTION_DB_PATHS,
  PRODUCTION_OPERATIONAL_LOG_DB_PATH,
  openDb,
  type Db,
} from "../src/db.js";
import { pruneDaemonLogs } from "../src/daemon-log.js";
import {
  OPERATIONAL_LOG_BACKUP_CLASSIFICATION,
  copyForwardLegacyDaemonLogs,
  getOperationalLogDbPath,
  openOperationalLogStore,
  planLegacyDaemonLogReclaim,
  startOperationalLogCopyForward,
  verifyLegacyDaemonLogCopy,
  visibleDaemonLogSource,
  type OperationalLogStore,
} from "../src/operational-log-db.js";

let tempDir: string;
let canonicalPath: string;
let canonicalDb: Db;
let store: OperationalLogStore;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-operational-log-"));
  canonicalPath = path.join(tempDir, "mandible.db");
  canonicalDb = openDb(canonicalPath);
  const opened = openOperationalLogStore(canonicalPath);
  if (!opened) throw new Error("expected writable operational-log store");
  store = opened;
});

afterEach(() => {
  store.close();
  canonicalDb.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function insert(db: Db, id: string, ts: number, event: string): void {
  db.prepare(
    `INSERT INTO daemon_log (id, ts, level, event, subsystem, fields_json)
     VALUES (?, ?, 'info', ?, 'test', '{}')`,
  ).run(id, ts, event);
}

function visibleRows(): Array<{ id: string; event: string }> {
  const source = visibleDaemonLogSource(store.db);
  return store.db.prepare(
    `${source.cte} SELECT id, event FROM ${source.table} ORDER BY ts, id`,
  ).all() as Array<{ id: string; event: string }>;
}

describe("operational log database lifecycle", () => {
  it("creates an independently classified fresh store beside an explicit canonical DB", () => {
    expect(store.dbPath).toBe(path.join(tempDir, "mandible.operational-logs.db"));
    expect(OPERATIONAL_LOG_BACKUP_CLASSIFICATION).toBe("excluded-runtime-telemetry");
    expect(store.db.prepare("SELECT COUNT(*) AS count FROM daemon_log").get()).toEqual({ count: 0 });
    expect(copyForwardLegacyDaemonLogs(store)).toMatchObject({ complete: true, scanned: 0 });
    expect(() => insert(store.db, "main-write", 1, "main-write")).not.toThrow();
  });

  it("shows old-only, new-only, and both stores without duplicate visible IDs", () => {
    insert(canonicalDb, "legacy", 100, "legacy-row");
    expect(visibleRows()).toEqual([{ id: "legacy", event: "legacy-row" }]);

    insert(store.db, "primary", 200, "primary-row");
    insert(canonicalDb, "same", 300, "legacy-same");
    insert(store.db, "same", 300, "primary-same");

    expect(visibleRows()).toEqual([
      { id: "legacy", event: "legacy-row" },
      { id: "primary", event: "primary-row" },
      { id: "same", event: "primary-same" },
    ]);
  });

  it("resumes repeated bounded copy-forward and preserves new primary writes", () => {
    for (let index = 0; index < 5; index += 1) {
      insert(canonicalDb, `old-${index}`, 100 + index, `old-${index}`);
    }

    const first = copyForwardLegacyDaemonLogs(store, { batchSize: 2, maxBatches: 1, now: 1_000 });
    expect(first).toMatchObject({ scanned: 2, copied: 2, complete: false });
    insert(store.db, "new-write", 10_000, "new-write");

    const second = copyForwardLegacyDaemonLogs(store, { batchSize: 2, maxBatches: 10, now: 2_000 });
    const repeated = copyForwardLegacyDaemonLogs(store, { batchSize: 2, maxBatches: 10, now: 3_000 });
    expect(second).toMatchObject({ scanned: 3, copied: 3, complete: true });
    expect(repeated).toMatchObject({ scanned: 0, copied: 0, complete: true });
    expect(store.db.prepare("SELECT COUNT(*) AS count FROM daemon_log").get()).toEqual({ count: 6 });
    expect(verifyLegacyDaemonLogCopy(store, { now: 4_000 })).toMatchObject({
      legacyRows: 5,
      coveredRows: 5,
      missingRows: 0,
      mismatchedRows: 0,
      queryParity: true,
      verified: true,
      verifiedAt: 4_000,
    });
  });

  it("persists scan progress when a full legacy batch is already copied", () => {
    for (let index = 0; index < 100; index += 1) {
      const id = `existing-${String(index).padStart(3, "0")}`;
      insert(canonicalDb, id, index, id);
      insert(store.db, id, index, id);
    }

    const result = copyForwardLegacyDaemonLogs(store, {
      batchSize: 100,
      maxBatches: 2,
      now: 1_000,
    });
    const repeated = copyForwardLegacyDaemonLogs(store, { now: 2_000 });

    expect(result).toMatchObject({ scanned: 100, copied: 0, complete: true });
    expect(repeated).toMatchObject({
      scanned: 0,
      copied: 0,
      complete: true,
      lastTs: 99,
      lastId: "existing-099",
    });
    expect(store.db.prepare(
      "SELECT last_ts, last_id FROM operational_log_copy_state",
    ).get()).toEqual({ last_ts: 99, last_id: "existing-099" });
  });

  it("does not count the full legacy log while a bounded copy remains incomplete", () => {
    for (let index = 0; index < 3; index += 1) {
      insert(canonicalDb, `bounded-${index}`, 100 + index, `bounded-${index}`);
    }
    const prepareSpy = vi.spyOn(store.db, "prepare");

    expect(copyForwardLegacyDaemonLogs(store, { batchSize: 1, maxBatches: 2 })).toMatchObject({
      scanned: 2,
      complete: false,
    });
    expect(prepareSpy.mock.calls.some(([sql]) => String(sql).includes("COUNT(*)"))).toBe(false);
    expect(prepareSpy.mock.calls.some(([sql]) => String(sql).includes("(ts, id) > (?, ?)"))).toBe(true);
    expect(prepareSpy.mock.calls.some(([sql]) => String(sql).includes("? IS NULL OR"))).toBe(false);
  });

  it("starts copy-forward asynchronously and yields between bounded batches", async () => {
    for (let index = 0; index < 3; index += 1) insert(canonicalDb, `async-${index}`, index, `async-${index}`);
    const events: string[] = [];
    const scheduler = startOperationalLogCopyForward(
      store,
      (_level, event) => events.push(event),
      { initialDelayMs: 0, catchUpDelayMs: 0, recheckDelayMs: 5, batchSize: 1 },
    );
    try {
      expect(store.db.prepare("SELECT COUNT(*) AS count FROM daemon_log").get()).toEqual({ count: 0 });
      await waitFor(() => Number((store.db.prepare("SELECT COUNT(*) AS count FROM daemon_log").get() as { count: number }).count) === 3);
      await waitFor(() => Boolean(store.db.prepare(
        "SELECT 1 FROM operational_log_copy_state WHERE completed_at IS NOT NULL",
      ).get()));
      insert(canonicalDb, "async-after-completion", 10, "async-after-completion");
      await waitFor(() => Number((store.db.prepare("SELECT COUNT(*) AS count FROM daemon_log").get() as { count: number }).count) === 4);
      expect(events).toContain("operational_log_copy_forward");
    } finally {
      scheduler.stop();
    }
  });

  it("keeps the default scheduled batch small enough to yield on a large store", async () => {
    for (let index = 0; index < 101; index += 1) {
      insert(canonicalDb, `scheduled-${index}`, index, `scheduled-${index}`);
    }
    const batches: number[] = [];
    const scheduler = startOperationalLogCopyForward(
      store,
      (_level, event, details) => {
        if (event === "operational_log_copy_forward") {
          batches.push(Number(details?.scanned));
        }
      },
      { initialDelayMs: 0, catchUpDelayMs: 60_000, recheckDelayMs: 60_000 },
    );
    try {
      await waitFor(() => batches.length > 0);
      expect(batches).toEqual([100]);
    } finally {
      scheduler.stop();
    }
  });

  it("keeps an existing primary ID and makes row conflicts fail verification", () => {
    insert(canonicalDb, "same", 100, "legacy-version");
    insert(store.db, "same", 100, "primary-version");

    expect(copyForwardLegacyDaemonLogs(store)).toMatchObject({ copied: 0, complete: true });
    expect(visibleRows()).toEqual([{ id: "same", event: "primary-version" }]);
    expect(verifyLegacyDaemonLogCopy(store)).toMatchObject({
      missingRows: 0,
      mismatchedRows: 1,
      queryParity: false,
      verified: false,
    });
  });

  it("treats byte-equivalent identical IDs as covered without duplicating them", () => {
    insert(canonicalDb, "same", 100, "same-version");
    insert(store.db, "same", 100, "same-version");

    expect(copyForwardLegacyDaemonLogs(store)).toMatchObject({ copied: 0, complete: true });
    expect(visibleRows()).toEqual([{ id: "same", event: "same-version" }]);
    expect(verifyLegacyDaemonLogCopy(store, { record: true })).toMatchObject({
      legacyRows: 1,
      coveredRows: 1,
      mismatchedRows: 0,
      visibleRows: 1,
      verified: true,
    });
  });

  it("survives close/reopen with WAL sidecars and an interrupted copy cursor", () => {
    for (let index = 0; index < 3; index += 1) insert(canonicalDb, `row-${index}`, index, `row-${index}`);
    copyForwardLegacyDaemonLogs(store, { batchSize: 1, maxBatches: 1 });
    const logPath = store.dbPath;
    store.close();
    const reopened = openOperationalLogStore(canonicalPath, { dbPath: logPath });
    if (!reopened) throw new Error("expected reopened operational-log store");
    store = reopened;

    expect(copyForwardLegacyDaemonLogs(store, { batchSize: 1, maxBatches: 10 })).toMatchObject({
      scanned: 2,
      copied: 2,
      complete: true,
    });
    expect(visibleRows()).toHaveLength(3);
  });

  it("prunes the operational store independently and keeps canonical rollback rows", async () => {
    const now = Date.UTC(2026, 7, 17);
    const day = 24 * 60 * 60 * 1_000;
    canonicalDb.prepare("UPDATE settings SET value = '3' WHERE key = 'log_retention_days'").run();
    insert(canonicalDb, "legacy-old", now - 10 * day, "legacy-old");
    insert(store.db, "primary-old", now - 10 * day, "primary-old");
    insert(store.db, "primary-new", now - day, "primary-new");

    const result = await pruneDaemonLogs(store.db, { settingsDb: canonicalDb, now, yieldMs: 0 });

    expect(result).toMatchObject({ retentionDays: 3, deleted: 1 });
    expect(store.db.prepare("SELECT id FROM daemon_log ORDER BY id").all()).toEqual([{ id: "primary-new" }]);
    expect(canonicalDb.prepare("SELECT id FROM daemon_log").all()).toEqual([{ id: "legacy-old" }]);
  });

  it("protects copied rollback evidence until verification, then applies retention without legacy fallback", async () => {
    const now = Date.UTC(2026, 7, 17);
    const day = 24 * 60 * 60 * 1_000;
    canonicalDb.prepare("UPDATE settings SET value = '3' WHERE key = 'log_retention_days'").run();
    insert(canonicalDb, "legacy-old", now - 10 * day, "legacy-old");
    copyForwardLegacyDaemonLogs(store);

    const protectedPass = await pruneDaemonLogs(store.db, { settingsDb: canonicalDb, now, yieldMs: 0 });
    expect(protectedPass.deleted).toBe(0);
    expect(visibleRows()).toEqual([{ id: "legacy-old", event: "legacy-old" }]);

    expect(verifyLegacyDaemonLogCopy(store, { record: true }).verified).toBe(true);
    const retainedPass = await pruneDaemonLogs(store.db, { settingsDb: canonicalDb, now, yieldMs: 0 });
    expect(retainedPass.deleted).toBe(1);
    expect(visibleRows()).toEqual([]);
    expect(canonicalDb.prepare("SELECT id FROM daemon_log").all()).toEqual([{ id: "legacy-old" }]);
    expect(planLegacyDaemonLogReclaim(store)).toMatchObject({
      eligible: true,
      productionMutationPerformed: false,
    });
  });

  it("invalidates stale completion when a rollback daemon appends legacy rows", () => {
    insert(canonicalDb, "legacy-first", 100, "legacy-first");
    expect(copyForwardLegacyDaemonLogs(store, { now: 1_000 })).toMatchObject({ complete: true, copied: 1 });
    expect(verifyLegacyDaemonLogCopy(store, { record: true, now: 2_000 }).verified).toBe(true);
    expect(planLegacyDaemonLogReclaim(store).eligible).toBe(true);

    // A downgraded daemon can append both newer and backdated rows. The row
    // count is part of the persisted high-water snapshot, so neither shape can
    // hide behind the previously recorded verification.
    insert(canonicalDb, "legacy-later", 200, "legacy-later");
    insert(canonicalDb, "legacy-backdated", 50, "legacy-backdated");
    expect(visibleRows()).toEqual([
      { id: "legacy-backdated", event: "legacy-backdated" },
      { id: "legacy-first", event: "legacy-first" },
      { id: "legacy-later", event: "legacy-later" },
    ]);
    expect(planLegacyDaemonLogReclaim(store).eligible).toBe(false);

    const resumed = copyForwardLegacyDaemonLogs(store, { now: 3_000 });
    expect(resumed).toMatchObject({ complete: true, scanned: 3, copied: 2 });
    expect(verifyLegacyDaemonLogCopy(store, { record: true, now: 4_000 })).toMatchObject({
      legacyRows: 3,
      coveredRows: 3,
      verified: true,
      verifiedAt: 4_000,
    });
    expect(store.db.prepare(
      `SELECT legacy_high_water_ts, legacy_high_water_id, legacy_high_water_rows
       FROM operational_log_copy_state`,
    ).get()).toEqual({
      legacy_high_water_ts: 200,
      legacy_high_water_id: "legacy-later",
      legacy_high_water_rows: 3,
    });
  });

  it("emits a reclaim plan only after a recorded verifier pass and never mutates legacy rows", () => {
    insert(canonicalDb, "legacy", 100, "legacy");
    const before = planLegacyDaemonLogReclaim(store);
    expect(before).toMatchObject({ eligible: false, productionMutationPerformed: false });

    copyForwardLegacyDaemonLogs(store);
    verifyLegacyDaemonLogCopy(store, { record: true });
    const after = planLegacyDaemonLogReclaim(store);
    expect(after).toMatchObject({ eligible: true, productionMutationPerformed: false });
    expect(canonicalDb.prepare("SELECT id FROM daemon_log").all()).toEqual([{ id: "legacy" }]);
  });

  it("opens query and reclaim-plan commands read-only without creating side effects", () => {
    insert(canonicalDb, "legacy", 100, "legacy");
    copyForwardLegacyDaemonLogs(store);
    verifyLegacyDaemonLogCopy(store, { record: true });
    const logPath = store.dbPath;
    store.close();
    const readonly = openOperationalLogStore(canonicalPath, { dbPath: logPath, readonly: true });
    if (!readonly) throw new Error("expected read-only operational-log store");
    store = readonly;

    expect(planLegacyDaemonLogReclaim(store)).toMatchObject({
      eligible: true,
      productionMutationPerformed: false,
    });
    expect(() => copyForwardLegacyDaemonLogs(store)).toThrow(/read-only/);
  });
});

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started >= timeoutMs) throw new Error("timed out waiting for copy-forward");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("operational log production guards", () => {
  it("guards the canonical, legacy, and dedicated production database paths", () => {
    expect(PRODUCTION_DB_PATHS).toEqual([
      PRODUCTION_DB_PATH,
      LEGACY_PRODUCTION_DB_PATH,
      PRODUCTION_OPERATIONAL_LOG_DB_PATH,
    ]);
  });

  it("derives a disposable log path from an explicit test database", () => {
    expect(getOperationalLogDbPath(canonicalPath, {})).toBe(
      path.join(tempDir, "mandible.operational-logs.db"),
    );
  });
});
