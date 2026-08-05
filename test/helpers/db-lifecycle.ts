/**
 * Test-only lifecycle helpers for the `src/db.ts` singleton (issue c4f456c).
 *
 * The module-global `_db` in `src/db.ts` is installed by many test files with
 * `setDb()` and, historically, reset by none of them. A binding therefore
 * survived the test that created it, so a later test could read a closed
 * handle, another test's fixture data, or — when nothing had been installed
 * yet — silently fall through to the real user database.
 *
 * These helpers give tests a scoped binding, and `installDbResetBackstop()`
 * (wired through `vitest.config.ts` `setupFiles`) guarantees the binding is
 * dropped after every test even when a test forgets or throws.
 */
import { inspectDbBinding, resetDb, setDb, type Db, type DbBinding } from "../../src/db.js";

export { inspectDbBinding, resetDb, setDb };
export type { Db, DbBinding };

const DEFAULT_REASON = "the test that installed it has finished";

/**
 * Drop a test-installed singleton binding and poison the slot so a later
 * `getDb()` throws instead of reopening the real database.
 *
 * A binding that `getDb()` opened itself (`source === "opened"`) is left alone:
 * reaching the production database from a test is a separate defect class
 * (issue 0ccc0f1) and clearing it here would change which database those code
 * paths see mid-suite.
 */
export function restoreDbSingleton(reason = DEFAULT_REASON): {
  reset: boolean;
  source: DbBinding["source"];
} {
  const binding = inspectDbBinding();
  if (binding.source !== "set") {
    return { reset: false, source: binding.source };
  }
  const result = resetDb({ reason });
  return { reset: result.cleared, source: result.source };
}

/**
 * Install `db` as the singleton for the duration of `fn`, then restore the
 * previous binding (or poison the slot when there was none). Works for both
 * synchronous and promise-returning callbacks. Never closes `db` — the caller
 * that opened it still owns it.
 */
export function withTestDb<T>(db: Db, fn: (db: Db) => T): T {
  const previous = inspectDbBinding();
  setDb(db);
  const restore = (): void => {
    if (previous.source === "set" && previous.db) {
      setDb(previous.db);
      return;
    }
    resetDb({ reason: "a withTestDb() scope ended" });
  };

  let result: T;
  try {
    result = fn(db);
  } catch (error) {
    restore();
    throw error;
  }

  if (result && typeof (result as { then?: unknown }).then === "function") {
    return (result as unknown as Promise<unknown>).then(
      (value) => {
        restore();
        return value;
      },
      (error) => {
        restore();
        throw error;
      },
    ) as unknown as T;
  }

  restore();
  return result;
}
