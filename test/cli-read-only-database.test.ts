import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import SqliteDatabase from "../src/sqlite.js";
import { withCliReadOnlyDatabase } from "../src/cli/read-only-database.js";

it("reads current committed WAL with bounded busy handling and releases the connection after success or failure", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-cli-reader-"));
  const filename = path.join(directory, "ledger.db");
  const writer = new SqliteDatabase(filename);
  let reader: SqliteDatabase | undefined;
  try {
    writer.exec("PRAGMA journal_mode=WAL; CREATE TABLE note(value TEXT)");
    writer.pragma("wal_checkpoint(TRUNCATE)");
    writer.exec("INSERT INTO note VALUES ('committed'); BEGIN IMMEDIATE; INSERT INTO note VALUES ('pending')");
    expect(await withCliReadOnlyDatabase(filename, db => {
      reader = db;
      expect(db.pragma("busy_timeout", { simple: true })).toBe(5000);
      expect(db.pragma("query_only", { simple: true })).toBe(1);
      expect(db.readonly).toBe(true);
      expect(db.inTransaction).toBe(false);
      expect(db.prepare("SELECT value FROM note").all()).toEqual([{ value: "committed" }]);
      expect(() => db.exec("INSERT INTO note VALUES ('forbidden')")).toThrow();
      writer.exec("COMMIT");
      expect(db.inTransaction).toBe(false);
      return db.prepare("SELECT value FROM note").all();
    })).toEqual([{ value: "committed" }, { value: "pending" }]);
    expect(reader!.open).toBe(false);
    await expect(withCliReadOnlyDatabase(filename, db => {
      reader = db;
      return db.prepare("SELECT * FROM missing_table").all();
    })).rejects.toThrow();
    expect(reader!.open).toBe(false);
    expect(writer.prepare("SELECT value FROM note").all()).toEqual([{ value: "committed" }, { value: "pending" }]);
  } finally {
    writer.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
