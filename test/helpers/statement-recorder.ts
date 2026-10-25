import type { Db } from "../../src/db.js";

export interface RecordedStatement {
  sql: string;
  args: unknown[];
}

/**
 * Run `body` with every statement executed on `db` recorded with its bindings,
 * so a test can count the statements a call runs or read their query plans.
 */
export async function recordStatements<T>(
  db: Db,
  body: () => T | Promise<T>,
): Promise<{ result: T; statements: RecordedStatement[] }> {
  const statements: RecordedStatement[] = [];
  const prepare = db.prepare;
  db.prepare = function recordingPrepare(this: Db, sql: string) {
    const statement = prepare.call(this, sql);
    return new Proxy(statement, {
      get(target, property) {
        const value = Reflect.get(target, property, target);
        if (property === "all" || property === "get" || property === "run") {
          return (...args: unknown[]) => {
            statements.push({ sql, args });
            return (value as (...values: unknown[]) => unknown).apply(target, args);
          };
        }
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  } as Db["prepare"];
  try {
    return { result: await body(), statements };
  } finally {
    db.prepare = prepare;
  }
}

/** The `EXPLAIN QUERY PLAN` detail lines of one recorded statement. */
export function queryPlan(db: Db, statement: RecordedStatement): string[] {
  return (db.prepare(`EXPLAIN QUERY PLAN ${statement.sql}`).all(...statement.args) as Array<{ detail: string }>)
    .map((row) => row.detail);
}
