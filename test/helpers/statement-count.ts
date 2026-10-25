import type { Db } from "../../src/db.js";

const EXECUTING = new Set<PropertyKey>(["all", "get", "run", "iterate"]);

/** The statements `fn` executes against `db`. */
export async function statementsRun(db: Db, fn: () => unknown): Promise<number> {
  let count = 0;
  const prepare = db.prepare.bind(db);
  db.prepare = ((sql: string) => new Proxy(prepare(sql), {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        if (EXECUTING.has(property)) count += 1;
        return value.apply(target, args);
      };
    },
  })) as typeof db.prepare;
  try {
    await fn();
  } finally {
    db.prepare = prepare;
  }
  return count;
}
