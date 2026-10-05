/** @vitest-environment node */
import { expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import SqliteDatabase from "../../src/sqlite.ts";

it.runIf(process.platform === "darwin")("close releases database and WAL handles without garbage collection", () => {
  expect(process.versions.bun).toBeTruthy();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-close-"));
  const filename = path.join(fs.realpathSync(directory), "database.db");
  const db = new SqliteDatabase(filename);
  try {
    db.exec("PRAGMA journal_mode=WAL; CREATE TABLE item(value)");
    const statement = db.prepare("INSERT INTO item VALUES(?)");
    statement.run("retained");
    const read = db.prepare("SELECT value FROM item UNION ALL SELECT 'second'");
    const iterator = read.iterate()[Symbol.iterator]();
    expect(iterator.next().value).toEqual({ value: "retained" });
    db.close();
    expect(db.open).toBe(false);
    const holders = spawnSync("/usr/sbin/lsof", ["-p", String(process.pid), "-Fn"], { encoding: "utf8", timeout: 5000 });
    if (holders.error) throw holders.error;
    expect(holders.status).toBe(0);
    const files = new Set([filename, `${filename}-wal`, `${filename}-shm`]);
    const retained = holders.stdout.split("\n").filter(line => line.startsWith("n") && files.has(line.slice(1)));
    expect(() => statement.run("after-close")).toThrow();
    expect(() => read.get()).toThrow();
    expect(() => iterator.next()).toThrow();
    expect(() => db.close()).toThrow("database is not open");
    expect(retained).toEqual([]);
    expect(fs.existsSync(`${filename}-wal`)).toBe(false);
    expect(fs.existsSync(`${filename}-shm`)).toBe(false);
    const reader = new SqliteDatabase(filename, { readonly: true });
    try {
      expect(reader.prepare("SELECT value FROM item").all()).toEqual([{ value: "retained" }]);
      expect(() => reader.exec("INSERT INTO item VALUES('bad')")).toThrow();
    } finally { reader.close(); }
  } finally {
    if (db.open) db.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
