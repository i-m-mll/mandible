import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import SqliteDatabase, { SqliteError } from "../src/sqlite.ts";
import { openReadOnlyLedger, runReadOnlyQuery } from "../src/db-read.ts";

function temporaryDatabase(run: (filename: string) => void | Promise<void>) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "mandible-sqlite-"));
  return Promise.resolve().then(() => run(path.join(directory, "test.db"))).finally(() => fs.rmSync(directory, { recursive: true, force: true }));
}

describe("Bun SQLite boundary", () => {
  it("selects SQLite on first use, retries failed initialization, and keeps the selected library", async () => temporaryDatabase(filename => {
    const facade = new URL("../src/sqlite.ts", import.meta.url).href;
    const result = spawnSync(process.execPath, ["--no-install", "--eval", `
      import fs from "node:fs";
      const { default: Database } = await import(${JSON.stringify(facade)});
      const filename = process.argv[1];
      try { new Database(filename); throw new Error("invalid runtime accepted"); }
      catch (error) { if (!String(error).includes("Pinned SQLite library is missing or corrupt")) throw error; }
      if (fs.existsSync(filename)) throw new Error("failed initialization created the database");
      const original = ${JSON.stringify(process.env.MANDIBLE_SQLITE_LIBRARY ?? null)};
      if (original) process.env.MANDIBLE_SQLITE_LIBRARY = original; else delete process.env.MANDIBLE_SQLITE_LIBRARY;
      const first = new Database(filename); first.exec("CREATE TABLE item(value INTEGER); INSERT INTO item VALUES(42)"); first.close();
      process.env.MANDIBLE_SQLITE_LIBRARY = "/wrong/sqlite";
      const next = new Database(filename);
      if (next.prepare("SELECT value FROM item").get().value !== 42) throw new Error("selected runtime changed");
      next.close();
    `, filename], { encoding: "utf8", timeout: 5000, env: { ...process.env, MANDIBLE_SQLITE_LIBRARY: "/wrong/sqlite" } });
    expect(result.status, result.stderr).toBe(0);
  }));

  it("publishes only committed nested effects and keeps notification errors outside rollback", () => {
    const db = new SqliteDatabase();
    const published: string[] = [];
    try {
      db.transaction(() => {
        db.afterCommit(() => { expect(db.inTransaction).toBe(false); published.push("outer"); });
        db.transaction(() => db.afterCommit(() => published.push("nested")))();
        expect(() => db.transaction(() => {
          db.afterCommit(() => published.push("rolled-back"));
          throw new Error("rollback");
        })()).toThrow("rollback");
        expect(published).toEqual([]);
      })();
      expect(published).toEqual(["outer", "nested"]);
      expect(() => db.transaction(() => {
        db.transaction(() => db.afterCommit(() => published.push("discarded")))();
        throw new Error("outer rollback");
      })()).toThrow("outer rollback");
      expect(published).toEqual(["outer", "nested"]);
      expect(() => db.transaction(() => {
        db.afterCommit(() => { throw new Error("publish failed"); });
        db.afterCommit(() => published.push("after-failed-notification"));
      })()).toThrow("publish failed");
      expect(published.at(-1)).toBe("after-failed-notification");
      expect(db.inTransaction).toBe(false);
    } finally { db.close(); }
  });

  it("preserves bindings, blobs, safe integers and exact large integers", () => {
    const db = new SqliteDatabase();
    try {
      db.exec("CREATE TABLE values_test(id INTEGER PRIMARY KEY, label TEXT UNIQUE, bytes BLOB, large INTEGER)");
      const insert = db.prepare("INSERT INTO values_test(label,bytes,large) VALUES($label,$bytes,$large)");
      expect(insert.run({ label: "one", bytes: new Uint8Array([1, 2]), large: 9007199254740993n })).toEqual({ changes: 1, lastInsertRowid: 1 });
      const row = db.prepare("SELECT * FROM values_test WHERE id = ?").get([1]);
      expect(row).toMatchObject({ id: 1, label: "one", large: 9007199254740993n });
      expect([...row.bytes]).toEqual([1, 2]);
      expect(db.prepare("SELECT id FROM values_test WHERE id = ?").get(2)).toBeUndefined();
      expect(insert.run({ label: "two", bytes: null, large: 2, extraDomainField: { arbitrary: true } }).changes).toBe(1);
      expect(() => insert.run({ label: "one", bytes: null, large: 2 })).toThrow(SqliteError);
    } finally { db.close(); }
  });

  it("validates SQLite parameter slots without mistaking quoted text for bindings", () => {
    const db = new SqliteDatabase();
    try {
      db.exec('CREATE TABLE quoted("a$fake" INTEGER, [bracket?] INTEGER, `tick@fake` INTEGER); INSERT INTO quoted VALUES(1,2,3)');
      const cases: Array<[string, unknown[], unknown[]]> = [
        ["SELECT :name, :name, ?2", [{ name: "repeat" }, 8], ["repeat", "repeat", 8]],
        ["SELECT ?3, ?1, ?", [1, null, 3, 4], [3, 1, 4]],
        ["SELECT ?5", [{ "?5": 5 }], [5]],
        ["SELECT ?01, ?1", [7], [7, 7]],
        ["SELECT :name, ?", [{ ":name": 4 }, 5], [4, 5]],
        ["SELECT :name, ?1", [{ name: 4 }], [4, 4]],
        ["SELECT :a, @a", [{ ":a": 1, "@a": 2 }], [1, 2]],
        ["SELECT :名字, @café, $ns::part(?fake:@x)", [{ "名字": 1, "café": 2, "$ns::part(?fake:@x)": 3 }], [1, 2, 3]],
        ["SELECT @ns::part(?fake), :ns::part(@fake)", [{ "@ns::part(?fake)": 1, ":ns::part(@fake)": 2 }], [1, 2]],
        ["SELECT 'it''s ? :fake', a$fake, [bracket?], `tick@fake`, x'3f' FROM quoted /* ? */ -- :fake\n", [], ["it's ? :fake", 1, 2, 3, Buffer.from([63])]],
      ];
      for (const [sql, args, row] of cases) expect(db.prepare(sql).arrays().get(...args), sql).toEqual(row);
      for (const method of ["get", "all", "run", "iterate"] as const) {
        const statement = db.prepare("SELECT :required, ?");
        const execute = () => method === "iterate" ? [...statement.iterate({ required: 1 })] : statement[method]({ required: 1 });
        expect(execute, method).toThrow("Missing SQLite binding");
      }
      const statement = db.prepare("SELECT :name, ?");
      expect(statement.arrays().get({ name: 1, change_report: undefined }, 2)).toEqual([1, 2]);
      expect(() => statement.get({}, 2)).toThrow("Missing SQLite binding");
      expect(() => statement.get(Object.create({ name: 1 }), 2)).toThrow("Missing SQLite binding");
      expect(() => statement.get({ name: 1, ":name": 1 }, 2)).toThrow("supplied twice");
      expect(() => db.prepare("SELECT :a, @a").get({ a: 1 })).toThrow(/ambiguous/i);
      expect(() => db.prepare("SELECT ?").get([, 1])).toThrow("omissions");
      expect(() => db.prepare("SELECT ?").get(undefined)).toThrow("undefined");
      expect(() => db.prepare("SELECT ?").get(9007199254740992)).toThrow("BigInt");
      expect(() => db.prepare("SELECT ?").get(1, 2)).toThrow("Too many");
      db.exec("CREATE TABLE writes_test(value)");
      const insert = db.prepare("INSERT INTO writes_test VALUES(:value)");
      expect(() => insert.run({})).toThrow("Missing");
      expect(insert.run({ value: null }).changes).toBe(1);
      expect(() => insert.run({})).toThrow("Missing");
      expect(db.prepare("SELECT value FROM writes_test").all()).toEqual([{ value: null }]);
    } finally { db.close(); }
  });

  it("keeps synchronous nested rollback and immediate locking semantics", async () => temporaryDatabase(filename => {
    const db = new SqliteDatabase(filename, { timeout: 1 });
    const other = new SqliteDatabase(filename, { timeout: 1 });
    try {
      db.exec("CREATE TABLE item(value INTEGER)");
      expect(db.transaction(() => {
        db.prepare("INSERT INTO item VALUES(?)").run(1);
        expect(() => db.transaction(() => { db.prepare("INSERT INTO item VALUES(?)").run(2); throw new Error("inner"); })()).toThrow("inner");
        expect(db.inTransaction).toBe(true);
        expect(() => other.transaction(() => {}) .immediate()).toThrowError(SqliteError);
        return 7;
      }).immediate()).toBe(7);
      expect(db.prepare("SELECT value FROM item").all()).toEqual([{ value: 1 }]);
      expect(() => db.transaction(() => { db.prepare("INSERT INTO item VALUES(?)").run(3); throw new Error("outer"); })()).toThrow("outer");
      expect(() => db.transaction(async () => 1)()).toThrow("synchronous");
      expect(db.inTransaction).toBe(false);
      expect(db.prepare("SELECT value FROM item").all()).toEqual([{ value: 1 }]);
    } finally { other.close(); db.close(); }
  }));

  it("reads live WAL and rejects parsed non-query operations before effects", async () => temporaryDatabase(filename => {
    const writer = new SqliteDatabase(filename);
    writer.exec("PRAGMA journal_mode=WAL; CREATE TABLE item(id INTEGER PRIMARY KEY, label TEXT)");
    writer.exec("CREATE VIRTUAL TABLE search USING fts5(body); INSERT INTO search VALUES('fresh row')");
    const ledger = openReadOnlyLedger(filename);
    try {
      writer.prepare("INSERT INTO item(label) VALUES(?)").run("fresh");
      expect(runReadOnlyQuery(ledger, "WITH rows AS (SELECT * FROM item) SELECT rows.id, item.label FROM rows JOIN item USING(id)").rows).toEqual([[1, "fresh"]]);
      expect(runReadOnlyQuery(ledger, "SELECT body FROM search WHERE search MATCH 'fresh'").rows).toEqual([["fresh row"]]);
      expect(runReadOnlyQuery(ledger, "SELECT json_extract('{\"value\":42}', '$.value')").rows).toEqual([[42]]);
      for (const sql of ["INSERT INTO item(label) VALUES('bad') RETURNING id", "CREATE TABLE bad(x)", "PRAGMA user_version=10", "PRAGMA data_version", "ATTACH ':memory:' AS bad", "BEGIN", "SELECT 1; SELECT 2", "SELECT load_extension('bad')"]) {
        expect(() => runReadOnlyQuery(ledger, sql), sql).toThrow();
      }
      expect(runReadOnlyQuery(ledger, "SELECT ';' AS same, 2 AS same; /* trailing comment */").rows).toEqual([[";", 2]]);
      expect(writer.prepare("SELECT count(*) count FROM item").get()).toEqual({ count: 1 });
      expect(() => new SqliteDatabase(`file:${filename}?immutable=1`, { readonly: true })).toThrow("plain path");
    } finally { ledger.close(); writer.close(); }
  }));

  it("backs up committed WAL rows in another Bun process", async () => temporaryDatabase(async filename => {
    const db = new SqliteDatabase(filename);
    const snapshot = `${filename}.snapshot`;
    try {
      db.exec("PRAGMA journal_mode=WAL; CREATE TABLE item(id INTEGER); INSERT INTO item VALUES(42)");
      let eventLoopTurn = false;
      const pending = db.backup(snapshot);
      setImmediate(() => { eventLoopTurn = true; });
      await pending;
      expect(eventLoopTurn).toBe(true);
      const copy = new SqliteDatabase(snapshot, { readonly: true });
      try {
        expect(copy.prepare("SELECT id FROM item").all()).toEqual([{ id: 42 }]);
        expect(copy.pragma("integrity_check", { simple: true })).toBe("ok");
      } finally { copy.close(); }
      const saved = fs.readFileSync(snapshot);
      await expect(db.backup(snapshot)).rejects.toThrow();
      expect(fs.readFileSync(snapshot)).toEqual(saved);
      await expect(db.backup(`${snapshot}.cancelled`, { signal: AbortSignal.abort() })).rejects.toThrow();
      expect(fs.existsSync(`${snapshot}.cancelled`)).toBe(false);
      expect(fs.readdirSync(path.dirname(filename)).some(name => name.startsWith(".mandible-snapshot-"))).toBe(false);
    } finally { db.close(); }
  }));
});
