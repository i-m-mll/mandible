/**
 * @vitest-environment node
 *
 * Issue 78163ba. Two claims are worth a gate here, and they are the two that
 * would silently produce wrong audits if they broke:
 *
 *  - the read surface sees rows that are still only in the write-ahead log,
 *    which is exactly what `?immutable=1` does not; and
 *  - it is read-only in fact, leaving the caller's live ledger byte-identical.
 */
import { afterEach, describe, expect, it } from "vitest";
import SqliteDatabase from "../src/sqlite.ts";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ledgerInfo,
  openReadOnlyLedger,
  runReadOnlyQuery,
  type ReadOnlyLedger,
} from "../src/db-read.js";

const openHandles: Array<{ close(): void }> = [];

afterEach(() => {
  while (openHandles.length > 0) openHandles.pop()?.close();
});

function track<T extends { close(): void }>(handle: T): T {
  openHandles.push(handle);
  return handle;
}

/**
 * A WAL database whose schema and first row live in the main file, and whose
 * later rows live only in the -wal sidecar. The writer stays open on purpose:
 * closing the last connection checkpoints the WAL away, which would erase the
 * very condition under test.
 */
function walFixture(): { dbPath: string; writer: SqliteDatabase } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-db-read-"));
  const dbPath = path.join(dir, "fixture.db");
  const writer = track(new SqliteDatabase(dbPath));
  writer.pragma("journal_mode = WAL");
  writer.exec("create table note(id integer primary key, body text)");
  writer.prepare("insert into note(body) values (?)").run("checkpointed");
  writer.pragma("wal_checkpoint(TRUNCATE)");
  writer.prepare("insert into note(body) values (?)").run("in-wal-1");
  writer.prepare("insert into note(body) values (?)").run("in-wal-2");
  return { dbPath, writer };
}

function digest(target: string): string {
  if (!fs.existsSync(target)) return "absent";
  return crypto.createHash("sha256").update(fs.readFileSync(target)).digest("hex");
}

describe("read-only ledger access", () => {
  it("reads rows that exist only in the write-ahead log", () => {
    const { dbPath } = walFixture();
    expect(fs.statSync(`${dbPath}-wal`).size).toBeGreaterThan(0);

    const ledger = track(openReadOnlyLedger(dbPath));
    const rows = runReadOnlyQuery(ledger, "select body from note order by id").rows;

    expect(rows.flat()).toEqual(["checkpointed", "in-wal-1", "in-wal-2"]);
    expect(ledgerInfo(ledger).reads_wal).toBe(true);
  });

  it("refuses everything that is not a read", () => {
    const { dbPath } = walFixture();
    const ledger = track(openReadOnlyLedger(dbPath));

    const refused = [
      "insert into note(body) values ('x')",
      "update note set body = 'x'",
      "delete from note",
      "drop table note",
      "create table other(a)",
      "vacuum",
      // SQLite reports ATTACH and BEGIN as read-only statements, so the
      // row-returning check is what actually keeps them out.
      "attach database '/tmp/elsewhere.db' as other",
      "begin",
      // Every pragma is a potential write as far as SQLite is concerned.
      "pragma journal_mode = delete",
      "pragma table_info('note')",
      "select 1; select 2",
    ];
    for (const sql of refused) {
      expect(() => runReadOnlyQuery(ledger, sql), sql).toThrow();
    }

    expect(() => openReadOnlyLedger(`file:${dbPath}?immutable=1`)).toThrow(/URI filename/);
  });

  it("leaves the database byte-identical", () => {
    const { dbPath, writer } = walFixture();
    const before = { db: digest(dbPath), wal: digest(`${dbPath}-wal`) };
    const schemaVersion = writer.pragma("schema_version", { simple: true });

    const ledger: ReadOnlyLedger = track(openReadOnlyLedger(dbPath));
    runReadOnlyQuery(ledger, "select count(*) from note");
    runReadOnlyQuery(ledger, "select name from sqlite_master");
    ledgerInfo(ledger);
    ledger.close();
    openHandles.pop();

    // The -shm sidecar is excluded: a WAL reader takes and releases a read mark
    // there, which is coordination state, not ledger content.
    expect({ db: digest(dbPath), wal: digest(`${dbPath}-wal`) }).toEqual(before);
    expect(writer.pragma("schema_version", { simple: true })).toBe(schemaVersion);
  });
});
