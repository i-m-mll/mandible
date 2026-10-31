import { parentPort } from "node:worker_threads";
import SqliteDatabase from "../../src/sqlite.js";

const prepare = SqliteDatabase.prototype.prepare;
let observed = false;
SqliteDatabase.prototype.prepare = function (sql: string) {
  const statement = prepare.call(this, sql);
  if (!/^\s*INSERT\s+(?:OR\s+\w+\s+)?INTO\s+(?:conversation_blocks|cache_blocks)\b/i.test(sql)) return statement;
  const run = statement.run.bind(statement);
  statement.run = (...values: unknown[]) => {
    const result = run(...values);
    if (!observed && this.inTransaction) {
      observed = true;
      const gate = new Int32Array(new SharedArrayBuffer(4));
      parentPort!.postMessage({ kind: "log", level: "debug", message: "derived_preparation_held", details: { gate: gate.buffer } });
      if (Atomics.wait(gate, 0, 0, 45_000) === "timed-out") throw new Error("Derived preparation gate was never released");
    }
    return result;
  };
  return statement;
};
await import("../../src/ingestion-worker.js");
