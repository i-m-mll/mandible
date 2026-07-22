// Minimal settings key/value helpers scoped to the client-auth module.
//
// The wave-1 `settings` table (see migration v107 / db-baseline) is a plain
// key/value store. Client authentication keeps its own small accessors here so
// the module never imports private helpers from the user store and so all
// client-auth settings live behind one typed surface. No new table or column is
// introduced — this reuses the existing `settings` KV table exclusively.

import type { Db } from "../db.js";

export function getSetting(db: Db, key: string): string | null {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row ? row.value : null;
}

export function setSetting(db: Db, key: string, value: string, now: number = Date.now()): void {
  db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, value, now);
}
