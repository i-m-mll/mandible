import fs from "node:fs";
import SqliteDatabase from "../sqlite.js";
import { openDb, CURRENT_SCHEMA_VERSION, type Db } from "../db.js";
import { metadataBackupTables } from "../ledger/backup.js";
import { IngestionActor } from "../ingestion-actor.js";
import { ConversationSourceReader } from "./source-reader.js";
import { readConversationSourceReadiness } from "./source-readiness.js";

const quote = (value: string): string => `"${value.replaceAll('"', '""')}"`;

/** Restore a current metadata backup into a new ledger, without copying disposable indexes. */
export function restoreConversationMetadata(metadataSql: string, destination: string): Db {
  if (fs.existsSync(destination)) throw new Error("Recovery destination must not exist");
  const backup = new SqliteDatabase(":memory:");
  let destinationDb: Db | undefined;
  let claimed = false;
  try {
    backup.exec(metadataSql);
    const version = backup.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | undefined;
    if (Number(version?.value) !== CURRENT_SCHEMA_VERSION) throw new Error("Recovery requires a metadata backup from the current schema");
    const tables = metadataBackupTables(backup).filter(table => backup.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
    fs.closeSync(fs.openSync(destination, "wx", 0o600));
    claimed = true;
    destinationDb = openDb(destination);
    const db = destinationDb;
    const triggers = db.prepare("SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'trigger'").all() as Array<{ name: string; tbl_name: string; sql: string }>;
    db.pragma("foreign_keys = OFF");
    db.transaction(() => {
      for (const trigger of triggers) if (tables.includes(trigger.tbl_name)) db.exec(`DROP TRIGGER ${quote(trigger.name)}`);
      for (const table of tables) {
        if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table)) {
          const schema = backup.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as { sql: string };
          db.exec(schema.sql);
        }
      }
      for (const table of [...tables].reverse()) db.exec(`DELETE FROM ${quote(table)}`);
      for (const table of tables) {
        const columns = (backup.prepare(`PRAGMA table_info(${quote(table)})`).all() as Array<{ name: string }>).map(column => column.name);
        const insert = db.prepare(`INSERT INTO ${quote(table)} (${columns.map(quote).join(",")}) VALUES (${columns.map(() => "?").join(",")})`);
        for (const row of backup.prepare(`SELECT * FROM ${quote(table)}`).iterate() as Iterable<Record<string, unknown>>) insert.run(...columns.map(column => row[column]));
      }
      for (const trigger of triggers) if (tables.includes(trigger.tbl_name)) db.exec(trigger.sql);
      const violations = db.pragma("foreign_key_check") as unknown[];
      if (violations.length) throw new Error(`Restored metadata has ${violations.length} foreign-key violations`);
    }).immediate();
    db.pragma("foreign_keys = ON");
    return db;
  } catch (error) {
    destinationDb?.close();
    if (claimed) for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(`${destination}${suffix}`, { force: true });
    throw error;
  } finally { backup.close(); }
}

/** Recovery uses ordinary provider discovery, relocation and source indexing. */
export async function reconcileRecoveredConversations(dbPath: string): Promise<void> {
  const actor = new IngestionActor({ dbPath, logger: (level, event, details) => { if (level === "warn" || level === "error") console.error(JSON.stringify({ level, event, ...details })); }, publish: () => {} });
  try { await actor.reconcile(); }
  finally { await actor.close(); }
}

export async function inspectConversationRecovery(db: Db, options: { limit?: number; offset?: number } = {}) {
  const limit = Math.max(1, Math.min(500, options.limit ?? 50));
  const offset = Math.max(0, options.offset ?? 0);
  const total = (db.prepare("SELECT COUNT(*) AS count FROM conversations").get() as { count: number }).count;
  const rows = db.prepare("SELECT id FROM conversations ORDER BY id LIMIT ? OFFSET ?").all(limit, offset) as Array<{ id: string }>;
  const reader = new ConversationSourceReader(db);
  const conversations = [];
  for (const { id } of rows) {
    const readiness = readConversationSourceReadiness(db, id);
    const proof = readiness.status === "ready" ? await reader.verifyVersion(id, readiness.sourceVersionId!) : null;
    conversations.push({ conversation_id: id, readiness: readiness.status, status: proof?.status ?? "unavailable", reason: proof && proof.status !== "source" ? proof.reason : readiness.reason });
  }
  return { total, offset, limit, truncated: offset + rows.length < total, conversations };
}
