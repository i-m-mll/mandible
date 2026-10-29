import { configureSqliteRuntime } from "./sqlite-runtime.js";
import { SqliteBindings } from "./sqlite-bindings.js";
import { assertNotProductionDbUnderTest } from "../cli/production-db-guard.cjs";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

interface NativeStatement {
  sourceSQL: string;
  expandedSQL: string;
  get(...values: any[]): any;
  all(...values: any[]): any[];
  run(...values: any[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  iterate(...values: any[]): Iterable<any>;
  columns(): Array<{ name: string; column: string | null; table: string | null; database: string | null; type: string | null }>;
  setReadBigInts(enabled: boolean): void;
  setReturnArrays(enabled: boolean): void;
  setAllowBareNamedParameters(enabled: boolean): void;
  setAllowUnknownNamedParameters(enabled: boolean): void;
}
export type SqliteAuthorizer = (action: number, first: string | null, second: string | null, database: string | null, trigger: string | null) => number;
interface NativeDatabase {
  readonly isTransaction: boolean;
  readonly isOpen: boolean;
  prepare(sql: string): NativeStatement;
  exec(sql: string): void;
  close(): void;
  serialize(): Uint8Array;
  deserialize(bytes: Uint8Array): void;
  function(name: string, options: { deterministic?: boolean }, fn: (...values: any[]) => any): void;
  setAuthorizer(authorizer: SqliteAuthorizer | null): void;
}

export class SqliteError extends Error {
  readonly code: string;
  readonly primaryCode: number;
  constructor(readonly sqliteCode: number, error: Error) {
    super(error.message, { cause: error });
    this.name = "SqliteError";
    this.primaryCode = sqliteCode & 255;
    this.code = sqliteCode === 2067 ? "SQLITE_CONSTRAINT_UNIQUE"
      : sqliteCode === 1555 ? "SQLITE_CONSTRAINT_PRIMARYKEY"
      : sqliteCode === 787 ? "SQLITE_CONSTRAINT_FOREIGNKEY"
      : ({ 5: "SQLITE_BUSY", 6: "SQLITE_LOCKED", 19: "SQLITE_CONSTRAINT" } as Record<number, string>)[this.primaryCode] ?? "SQLITE_ERROR";
  }
}
export function isSqliteBusy(error: unknown): boolean {
  return error instanceof SqliteError && (error.primaryCode === 5 || error.primaryCode === 6);
}
export function isSqliteConstraint(error: unknown): boolean {
  return error instanceof SqliteError && error.primaryCode === 19;
}
function sqliteCall<T>(call: () => T): T {
  try { return call(); } catch (error) {
    if (error instanceof Error && "errcode" in error && typeof error.errcode === "number") throw new SqliteError(error.errcode, error);
    throw error;
  }
}
function valueForApplication(value: any): any {
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  if (typeof value === "bigint" && value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(Number.MIN_SAFE_INTEGER)) return Number(value);
  return value;
}
function rowForApplication(row: any): any {
  if (row === undefined) return undefined;
  if (Array.isArray(row)) return row.map(valueForApplication);
  const converted: Record<string, any> = {};
  for (const key in row) converted[key] = valueForApplication(row[key]);
  return converted;
}
export class SqliteStatement<Params = unknown> {
  declare readonly parameterType?: Params;
  private readonly bindings: SqliteBindings;
  constructor(private readonly native: NativeStatement) {
    this.bindings = new SqliteBindings(native.sourceSQL);
    native.setReadBigInts(true);
    native.setAllowBareNamedParameters(false);
    native.setAllowUnknownNamedParameters(false);
  }
  get(...values: any[]): any { return sqliteCall(() => rowForApplication(this.native.get(...this.bindings.resolve(values)))); }
  all(...values: any[]): any[] { return sqliteCall(() => this.native.all(...this.bindings.resolve(values)).map(rowForApplication)); }
  run(...values: any[]) {
    return sqliteCall(() => {
      const result = this.native.run(...this.bindings.resolve(values));
      return { changes: Number(result.changes), lastInsertRowid: valueForApplication(result.lastInsertRowid) as number | bigint };
    });
  }
  *iterate(...values: any[]): Iterable<any> {
    const iterator = sqliteCall(() => this.native.iterate(...this.bindings.resolve(values))[Symbol.iterator]());
    try {
      for (;;) {
        const item = sqliteCall(() => iterator.next());
        if (item.done) return;
        yield rowForApplication(item.value);
      }
    } finally { iterator.return?.(); }
  }
  get expandedSQL() { return this.native.expandedSQL; }
  columns() { return sqliteCall(() => this.native.columns()); }
  arrays(): this { this.native.setReturnArrays(true); return this; }
}

type Transaction<Args extends any[], Value> = ((...args: Args) => Value) & {
  deferred(...args: Args): Value;
  immediate(...args: Args): Value;
  exclusive(...args: Args): Value;
};
export interface SqliteOpenOptions { readonly?: boolean; fileMustExist?: boolean; timeout?: number }
let runtimeConfigured = false;

export default class SqliteDatabase {
  private readonly native: NativeDatabase;
  private savepoint = 0;
  private readonly commitCallbacks: Array<{ callbacks: Array<() => void>; managed: boolean }> = [];
  readonly name: string;
  readonly readonly: boolean;
  constructor(filename: string = ":memory:", options: SqliteOpenOptions = {}) {
    if (filename.startsWith("file:") || filename.includes("?")) throw new Error("SQLite requires a plain path, not a URI filename");
    if (filename !== ":memory:") assertNotProductionDbUnderTest(filename);
    if (options.fileMustExist && !fs.existsSync(filename)) throw new Error(`Database does not exist: ${filename}`);
    this.name = filename;
    this.readonly = options.readonly ?? false;
    if (!runtimeConfigured) {
      configureSqliteRuntime(DatabaseSync);
      runtimeConfigured = true;
    }
    this.native = sqliteCall(() => new DatabaseSync(filename, { readOnly: this.readonly, enableForeignKeyConstraints: true, allowExtension: false })) as unknown as NativeDatabase;
    try { this.exec(`PRAGMA busy_timeout = ${options.timeout ?? 5000}`); }
    catch (error) { this.native.close(); throw error; }
  }
  static fromSnapshot(bytes: Uint8Array): SqliteDatabase {
    const db = new SqliteDatabase();
    try { sqliteCall(() => db.native.deserialize(bytes)); return db; }
    catch (error) { db.close(); throw error; }
  }
  serialize(): Buffer { return sqliteCall(() => Buffer.from(this.native.serialize())); }
  get inTransaction() { return this.native.isTransaction; }
  get open() { return this.native.isOpen; }
  close() { return sqliteCall(() => this.native.close()); }
  exec(sql: string): this { sqliteCall(() => this.native.exec(sql)); return this; }
  prepare(sql: string): SqliteStatement { return new SqliteStatement(sqliteCall(() => this.native.prepare(sql))); }
  pragma(sql: string, options: { simple?: boolean } = {}): any {
    const statement = this.prepare(`PRAGMA ${sql}`);
    if (options.simple) { const row = statement.arrays().get(); return row?.[0]; }
    return statement.all();
  }
  function(name: string, options: { deterministic?: boolean }, fn: (...values: any[]) => any): this {
    sqliteCall(() => this.native.function(name, options, fn)); return this;
  }
  setAuthorizer(authorizer: SqliteAuthorizer | null) { sqliteCall(() => this.native.setAuthorizer(authorizer)); }
  prepareSingle(sql: string): SqliteStatement {
    const native = sqliteCall(() => this.native.prepare(sql));
    const tail = sql.slice(native.sourceSQL.length);
    if (tail.trim()) {
      const extra = sqliteCall(() => this.native.prepare(tail));
      try { extra.columns(); } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ERR_INVALID_STATE") return new SqliteStatement(native);
        throw error;
      }
      throw new Error("Only one SQL statement is accepted");
    }
    return new SqliteStatement(native);
  }
  /**
   * Calling the returned function directly takes the write lock at BEGIN on a writable connection.
   * A deferred transaction that reads before it writes fails at once with SQLITE_BUSY whenever
   * another connection holds or has just released the lock, because SQLite does not invoke the
   * busy handler for an upgrade. Use `.deferred()` only for read-only snapshots.
   */
  afterCommit(callback: () => void): void {
    const callbacks = this.commitCallbacks.at(-1);
    if (callbacks?.managed) callbacks.callbacks.push(callback);
    else if (callbacks) throw new Error("afterCommit requires a managed outer SQLite transaction");
    else if (this.inTransaction) throw new Error("afterCommit requires a managed SQLite transaction");
    else callback();
  }
  transaction<Args extends any[], Value>(callback: (...args: Args) => Value): Transaction<Args, Value> {
    const execute = (mode: string, args: Args): Value => {
      if (callback.constructor.name === "AsyncFunction") throw new Error("SQLite transactions require synchronous callbacks");
      const nested = this.inTransaction;
      const savepoint = `mandible_${++this.savepoint}`;
      this.exec(nested ? `SAVEPOINT ${savepoint}` : `BEGIN ${mode}`);
      const callbacks: Array<() => void> = [];
      this.commitCallbacks.push({ callbacks, managed: !nested || this.commitCallbacks.at(-1)?.managed === true });
      let value: Value;
      try {
        value = callback(...args);
        if (value && (typeof value === "object" || typeof value === "function") && "then" in value) throw new Error("SQLite transactions require synchronous callbacks");
        this.exec(nested ? `RELEASE ${savepoint}` : "COMMIT");
      } catch (error) {
        this.commitCallbacks.pop();
        try { this.exec(nested ? `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}` : "ROLLBACK"); }
        catch (rollbackError) { throw new AggregateError([error, rollbackError], "SQLite transaction and rollback failed"); }
        throw error;
      }
      this.commitCallbacks.pop();
      if (nested) this.commitCallbacks.at(-1)?.callbacks.push(...callbacks);
      else {
        const failures: unknown[] = [];
        for (const committed of callbacks) {
          try { committed(); } catch (error) { failures.push(error); }
        }
        if (failures.length === 1) throw failures[0];
        if (failures.length > 1) throw new AggregateError(failures, "SQLite post-commit effects failed");
      }
      return value;
    };
    const deferred = (...args: Args) => execute("DEFERRED", args);
    const immediate = (...args: Args) => execute("IMMEDIATE", args);
    const exclusive = (...args: Args) => execute("EXCLUSIVE", args);
    return Object.assign(this.readonly ? deferred : immediate, { deferred, immediate, exclusive });
  }
  backup(destination: string, options: { signal?: AbortSignal } = {}): Promise<void> {
    if (this.name === ":memory:") return Promise.reject(new Error("Online backup requires a file-backed database"));
    if (destination.startsWith("file:") || destination.includes("?")) return Promise.reject(new Error("SQLite backup requires a plain destination path"));
    return new Promise((resolve, reject) => {
      const directory = fs.mkdtempSync(path.join(path.dirname(path.resolve(destination)), ".mandible-snapshot-"));
      const staging = path.join(directory, "snapshot.db");
      const runtimeUrl = new URL(import.meta.url.endsWith(".ts") ? "./sqlite-runtime.ts" : "./sqlite-runtime.js", import.meta.url).href;
      const source = `import {configureSqliteRuntime} from ${JSON.stringify(runtimeUrl)}; import {DatabaseSync,backup} from "node:sqlite"; configureSqliteRuntime(DatabaseSync); const db=new DatabaseSync(process.argv[1],{readOnly:true}); try {await backup(db,process.argv[2]);} finally {db.close();} const snapshot=new DatabaseSync(process.argv[2]); try {snapshot.exec("PRAGMA journal_mode=DELETE");} finally {snapshot.close();}`;
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(process.execPath, ["--no-install", "--eval", source, this.name, staging], { stdio: ["ignore", "ignore", "pipe"], signal: options.signal });
      } catch (error) {
        fs.rmSync(directory, { recursive: true, force: true });
        reject(error);
        return;
      }
      let detail = "";
      let failure: Error | undefined;
      child.stderr?.setEncoding("utf8").on("data", text => { detail = (detail + text).slice(-8192); });
      child.once("error", error => { failure = error; });
      child.once("close", code => {
        try {
          if (failure) throw failure;
          if (code !== 0) throw new Error(`SQLite backup failed (${code}): ${detail}`);
          fs.linkSync(staging, destination);
          resolve();
        } catch (error) { reject(error); }
        finally { fs.rmSync(directory, { recursive: true, force: true }); }
      });
    });
  }
}
