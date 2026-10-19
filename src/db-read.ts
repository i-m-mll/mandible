import SqliteDatabase from "./sqlite.js";
import { constants as nativeConstants } from "node:sqlite";

const constants = nativeConstants as typeof nativeConstants & Record<"SQLITE_READ" | "SQLITE_SELECT" | "SQLITE_RECURSIVE" | "SQLITE_FUNCTION" | "SQLITE_PRAGMA" | "SQLITE_OK" | "SQLITE_DENY", number>;
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

/** Read-only ledger access includes the live WAL and never runs migrations. */

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
  readonly db: SqliteDatabase;
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

  let db: SqliteDatabase;
  try {
    db = new SqliteDatabase(resolved, { readonly: true, fileMustExist: true, timeout: 2000 });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not open ${resolved} read-only: ${detail}`);
  }
  db.pragma("query_only = 1");
  return { db, path: resolved, close: () => db.close() };
}

const safeFunctions = new Set(`abs avg changes char coalesce concat concat_ws count date datetime format glob group_concat hex ifnull iif instr julianday last_insert_rowid length likelihood likely lower ltrim max min nullif octet_length printf quote random randomblob replace round rtrim sign soundex sqlite_compileoption_get sqlite_compileoption_used sqlite_source_id sqlite_version strftime string_agg substr substring sum time timediff total total_changes trim typeof unicode unixepoch unlikely upper zeroblob json json_array json_array_length json_error_position json_extract json_group_array json_group_object json_insert json_object json_patch json_pretty json_quote json_remove json_replace json_set json_type json_valid jsonb jsonb_array jsonb_extract jsonb_group_array jsonb_group_object jsonb_insert jsonb_object jsonb_patch jsonb_remove jsonb_replace jsonb_set match bm25 highlight snippet`.split(" "));

function readAuthorizer(action: number, _first: string | null, second: string | null): number {
  if (action === constants.SQLITE_READ || action === constants.SQLITE_SELECT || action === constants.SQLITE_RECURSIVE) return constants.SQLITE_OK;
  if (action === constants.SQLITE_FUNCTION && second && safeFunctions.has(second.toLowerCase())) return constants.SQLITE_OK;
  return constants.SQLITE_DENY;
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

  let executing = false;
  ledger.db.setAuthorizer((action, first, second) => {
    // FTS5 reads data_version while stepping; user PRAGMA is refused during preparation.
    if (executing && action === constants.SQLITE_PRAGMA && first === "data_version" && second === null) return constants.SQLITE_OK;
    return readAuthorizer(action, first, second);
  });
  try {
    const statement = ledger.db.prepareSingle(sql);
    const columns = statement.columns().map(column => column.name);
    if (columns.length === 0) throw new Error("Only row-returning queries are accepted");
    statement.arrays();
    const rows: unknown[][] = [];
    let truncated = false;
    const cap = limit > 0 ? limit : Number.POSITIVE_INFINITY;
    executing = true;
    for (const row of statement.iterate() as Iterable<unknown[]>) {
      if (rows.length >= cap) { truncated = true; break; }
      rows.push(row.map(renderValue));
    }
    return { columns, rows, truncated };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Read-only query refused: ${detail}${/function: like$/i.test(detail) ? "; use instr(lower(column), 'term') or GLOB instead of LIKE" : ""}`, { cause: error });
  } finally {
    ledger.db.setAuthorizer(null);
  }
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
