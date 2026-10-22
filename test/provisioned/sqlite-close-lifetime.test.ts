// @vitest-environment node
import { expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import SqliteDatabase from "../../src/sqlite.ts";
import { testRuntimeRoot } from "../helpers/runtime-isolation.js";

it("close releases database and WAL handles while statements and an iterator remain reachable", () => {
  expect(process.platform, "This qualification requires macOS descriptor inspection").toBe("darwin");
  expect(process.versions.bun).toBeTruthy();
  const directory = fs.mkdtempSync(path.join(testRuntimeRoot, "sqlite-close-"));
  const filename = path.join(fs.realpathSync(directory), "database.db");
  const files = new Set([filename, `${filename}-wal`, `${filename}-shm`]);
  const holders = () => {
    const result = spawnSync("/usr/sbin/lsof", ["-p", String(process.pid), "-Fn"], {
      encoding: "utf8", timeout: 5_000,
    });
    if (result.error) throw result.error;
    expect(result.status, result.stderr).toBe(0);
    return result.stdout.split("\n").filter(line => line.startsWith("n") && files.has(line.slice(1)));
  };
  const db = new SqliteDatabase(filename);
  try {
    db.exec("PRAGMA journal_mode=WAL; CREATE TABLE item(value)");
    const statement = db.prepare("INSERT INTO item VALUES(?)");
    statement.run("retained");
    const read = db.prepare("SELECT value FROM item UNION ALL SELECT 'second'");
    const iterator = read.iterate()[Symbol.iterator]();
    expect(iterator.next().value).toEqual({ value: "retained" });
    expect(holders().length).toBeGreaterThan(0);
    db.close();
    expect(db.open).toBe(false);
    expect(holders()).toEqual([]);
    expect(() => statement.run("after-close")).toThrow();
    expect(() => read.get()).toThrow();
    expect(() => iterator.next()).toThrow();
    expect(() => db.close()).toThrow("database is not open");
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
