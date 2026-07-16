import type { Db } from "./db.js";

export function tableExists(db: Db, table: string): boolean {
  try {
    const row = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(table);
    return Boolean(row);
  } catch {
    return false;
  }
}

export function columnExists(db: Db, table: string, column: string): boolean {
  try {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    return columns.some((entry) => entry.name === column);
  } catch {
    return false;
  }
}
