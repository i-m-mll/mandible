import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

/**
 * Read-only access to the live ledger database (issue 78163ba).
 *
 * Agents auditing the ledger need arbitrary counts and joins that the
 * structured commands do not cover, so they open the database file directly.
 * The idiom a search returns for "read SQLite without disturbing the writer" is
 * `sqlite3 'file:...mandible.db?immutable=1'`, and Mandible's database is in
 * WAL mode: `immutable=1` skips the `-wal` file and answers from the main file
 * alone. Recently written rows are simply absent, with no error and no warning,
 * so the wrong answer is self-consistent and plausible.
 *
 * This module is the surface that removes that failure rather than warning
 * about it. Three properties make the stale read unreachable rather than
 * discouraged:
 *
 *  1. **No URI filenames.** better-sqlite3 hands the filename to SQLite without
 *     `SQLITE_OPEN_URI`, so `?immutable=1` is not a spelling this code path can
 *     accept at all. `assertPlainDatabasePath` turns an attempt into a loud
 *     error instead of a mysterious "directory does not exist".
 *  2. **Read-only in fact, not by intent.** The connection is opened
 *     `SQLITE_OPEN_READONLY` with `fileMustExist`, and `query_only` is set on
 *     top of it. Nothing here imports the migration runner, so no read path can
 *     drift into migrating the caller's live ledger.
 *  3. **Statement-level refusal.** Only statements SQLite itself classifies as
 *     read-only *and* row-returning are executed, so a write reaching this
 *     surface is refused before it is stepped rather than relying on the open
 *     mode to fail it later.
 *
 * A read-only WAL connection takes a read mark in the `-shm` file and releases
 * it when the implicit transaction ends. It never blocks the daemon's writes;
 * the only thing it defers is a WAL checkpoint overlapping the query itself.
 */

const require_ = createRequire(import.meta.url);

/**
 * `liveDbPath()` is the canonical resolver for tools that are not the daemon:
 * existence-based, and deliberately never creates a database. Duplicating it in
 * TypeScript would reintroduce exactly the class of bug this module exists to
 * remove — a tool confidently reading the wrong file.
 */
const { liveDbPath } = require_("../cli/mandible-paths.cjs") as {
  liveDbPath: () => string;
};

export interface ReadOnlyLedger {
  readonly db: Database.Database;
  readonly path: string;
  close(): void;
}

export interface QueryResult {
  columns: string[];
  rows: unknown[][];
  truncated: boolean;
}

export interface LedgerInfo {
  database: string;
  size_bytes: number;
  wal_bytes: number;
  shm_present: boolean;
  journal_mode: string;
  page_size: number;
  page_count: number;
  schema_version: number;
  user_version: number;
  object_count: number;
  sqlite_version: string;
  access: "read-only";
  reads_wal: boolean;
}

export interface LedgerObject {
  type: string;
  name: string;
}

export interface LedgerSchemaEntry extends LedgerObject {
  sql: string;
}

/**
 * The database a read-only tool should open, honoring `MANDIBLE_DB`.
 *
 * The override is checked before `liveDbPath()` resolves it, so a URI is
 * reported as the caller wrote it rather than as a nonsense absolute path.
 */
export function resolveLedgerDbPath(): string {
  const override = process.env.MANDIBLE_DB;
  if (override) assertPlainDatabasePath(override);
  return liveDbPath();
}

/**
 * SQLite URI filenames are how the stale-snapshot idiom is spelled. They are
 * not accepted anywhere on this path, and saying so plainly is the point: an
 * agent that reaches for `immutable=1` gets told what to run instead.
 */
export function assertPlainDatabasePath(dbPath: string): void {
  if (dbPath.startsWith("file:") || dbPath.includes("?")) {
    throw new Error(
      `Refusing a SQLite URI filename: ${dbPath}\n` +
        "This surface always reads the live database including its write-ahead log. " +
        "URI parameters exist mainly to spell 'immutable=1', which skips the -wal file " +
        "and silently returns a stale snapshot. Pass a plain path in MANDIBLE_DB.",
    );
  }
}

export function openReadOnlyLedger(dbPath: string = resolveLedgerDbPath()): ReadOnlyLedger {
  assertPlainDatabasePath(dbPath);
  const resolved = path.resolve(dbPath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`No Mandible database at ${resolved}`);
  }

  let db: Database.Database;
  try {
    db = new Database(resolved, { readonly: true, fileMustExist: true, timeout: 2000 });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not open ${resolved} read-only: ${detail}`);
  }
  db.pragma("query_only = 1");
  return { db, path: resolved, close: () => db.close() };
}

/** Everything before the first token that is not whitespace or a comment. */
function firstKeyword(sql: string): string {
  let rest = sql;
  for (;;) {
    const trimmed = rest.replace(/^\s+/, "");
    if (trimmed.startsWith("--")) {
      const newline = trimmed.indexOf("\n");
      if (newline === -1) return "";
      rest = trimmed.slice(newline + 1);
      continue;
    }
    if (trimmed.startsWith("/*")) {
      const end = trimmed.indexOf("*/");
      if (end === -1) return "";
      rest = trimmed.slice(end + 2);
      continue;
    }
    return (/^[a-zA-Z_]+/.exec(trimmed)?.[0] ?? "").toLowerCase();
  }
}

export const DEFAULT_ROW_LIMIT = 500;

/**
 * Run one row-returning, non-mutating statement.
 *
 * `limit` caps the rows read; 0 means no cap. Truncation is reported, never
 * silent — an audit tool that quietly drops rows fails the same way the stale
 * snapshot does.
 */
export function runReadOnlyQuery(
  ledger: ReadOnlyLedger,
  sql: string,
  limit: number = DEFAULT_ROW_LIMIT,
): QueryResult {
  if (sql.trim().length === 0) throw new Error("No SQL given.");

  if (firstKeyword(sql) === "pragma") {
    throw new Error(
      "PRAGMA is not accepted here: SQLite classifies every pragma as a potential write, " +
        "so this surface cannot tell a read pragma from one that rewrites the file. " +
        "Use `mandible db schema [table]` for table and index definitions, " +
        "`mandible db info` for page/journal facts, or query sqlite_master directly.",
    );
  }

  let statement: Database.Statement;
  try {
    statement = ledger.db.prepare(sql);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not prepare the statement: ${detail}`);
  }

  if (!statement.readonly) {
    throw new Error(
      "Refusing a statement that can modify the database. This surface is read-only; " +
        "use the `mandible` commands that own the record you want to change.",
    );
  }
  if (!statement.reader) {
    throw new Error(
      "Refusing a statement that returns no rows. Only queries are accepted here — " +
        "ATTACH, DETACH, and transaction control are not.",
    );
  }

  statement.raw(true);
  const columns = statement.columns().map((column) => column.name);
  const rows: unknown[][] = [];
  let truncated = false;
  const cap = limit > 0 ? limit : Number.POSITIVE_INFINITY;
  for (const row of statement.iterate() as Iterable<unknown[]>) {
    if (rows.length >= cap) {
      truncated = true;
      break;
    }
    rows.push(row.map(renderValue));
  }
  return { columns, rows, truncated };
}

/**
 * Blobs are summarized rather than emitted. Their bytes are not usefully
 * readable in a terminal or in JSON, and a multi-megabyte conversation payload
 * rendered as a byte array is a denial-of-service on the caller's attention.
 */
function renderValue(value: unknown): unknown {
  if (value instanceof Uint8Array) return `<blob ${value.byteLength} bytes>`;
  if (typeof value === "bigint") return value.toString();
  return value;
}

export function listLedgerObjects(ledger: ReadOnlyLedger): LedgerObject[] {
  return ledger.db
    .prepare(
      "select type, name from sqlite_master " +
        "where type in ('table','view') and name not like 'sqlite_%' order by type, name",
    )
    .all() as LedgerObject[];
}

export function ledgerSchema(ledger: ReadOnlyLedger, table?: string): LedgerSchemaEntry[] {
  const base =
    "select type, name, sql from sqlite_master where sql is not null and name not like 'sqlite_%'";
  const statement = table
    ? ledger.db.prepare(`${base} and tbl_name = ? order by type, name`)
    : ledger.db.prepare(`${base} order by type, name`);
  return (table ? statement.all(table) : statement.all()) as LedgerSchemaEntry[];
}

export function ledgerInfo(ledger: ReadOnlyLedger): LedgerInfo {
  const pragma = <T>(name: string): T => ledger.db.pragma(name, { simple: true }) as T;
  const journalMode = pragma<string>("journal_mode");
  const objectCount = (
    ledger.db
      .prepare("select count(*) as n from sqlite_master where type in ('table','view')")
      .get() as { n: number }
  ).n;
  return {
    database: ledger.path,
    size_bytes: sidecarBytes(ledger.path),
    wal_bytes: sidecarBytes(`${ledger.path}-wal`),
    shm_present: fs.existsSync(`${ledger.path}-shm`),
    journal_mode: journalMode,
    page_size: pragma<number>("page_size"),
    page_count: pragma<number>("page_count"),
    schema_version: pragma<number>("schema_version"),
    user_version: pragma<number>("user_version"),
    object_count: objectCount,
    sqlite_version: (
      ledger.db.prepare("select sqlite_version() as v").get() as { v: string }
    ).v,
    access: "read-only",
    // A read-only connection replays the WAL; only a URI `immutable=1` open
    // would not, and this path cannot open one.
    reads_wal: journalMode === "wal",
  };
}

function sidecarBytes(target: string): number {
  try {
    return fs.statSync(target).size;
  } catch {
    return 0;
  }
}
