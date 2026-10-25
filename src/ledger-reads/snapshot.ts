import type { Db } from "../db.js";

/** Run one synchronous read phase without holding a transaction across an await. */
export function readSnapshot<T>(db: Db, read: () => T): T {
  return db.transaction(read).deferred();
}
