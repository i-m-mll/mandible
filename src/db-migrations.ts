import { BASELINE_SCHEMA_VERSION, createFreshSchemaBaseline } from "./db-baseline.js";
import type { Db } from "./db.js";

const SCHEMA_VERSION_KEY = "schema_version";

export interface Migration {
  version: number;
  name: string;
  statements: string[];
}

/**
 * The oldest schema version this build can open.
 *
 * `src/db-baseline.ts` IS the schema: it is the single representation of the
 * head shape, applied verbatim to a fresh database. `MIGRATIONS` carries only
 * what landed after the floor was last raised, and moves a database at or above
 * the floor to that same head shape. A database below the floor is refused
 * loudly rather than migrated, because this build no longer carries the
 * statements that would move it forward.
 */
export const MINIMUM_SUPPORTED_SCHEMA_VERSION = 158;

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 159,
    name: "drop_retired_git_bug_and_preset_tables",
    statements: [
      // Children before parents: convention_setting_links -> preset_nodes -> presets.
      // Nothing that survives references any of these tables.
      "DROP TABLE IF EXISTS convention_setting_links",
      "DROP TABLE IF EXISTS preset_nodes",
      "DROP TABLE IF EXISTS presets",
      "DROP TABLE IF EXISTS preset_diffs",
      "DROP TABLE IF EXISTS session_presets",
      "DROP TABLE IF EXISTS session_instruction_artifacts",
      "DROP TABLE IF EXISTS starred_chats",
      "DROP TABLE IF EXISTS ledger_outbox",
      "DROP TABLE IF EXISTS ledger_external_refs",
      "DROP TABLE IF EXISTS ledger_conflicts",
      "DROP TABLE IF EXISTS ledger_sync_jobs",
      "ALTER TABLE message_params DROP COLUMN preset_ids",
      // Completion markers for the retired v1-v158 post-DDL backfills.
      "DELETE FROM meta WHERE key LIKE 'post_migration.%'",
    ],
  },
];

/**
 * Migration versions must be unique and form a contiguous ascending run
 * starting immediately above the supported floor, so `CURRENT_SCHEMA_VERSION`
 * is the only head and no version can be skipped or reused.
 */
export function assertMigrationSequence(
  migrations: readonly Migration[] = MIGRATIONS,
  floor: number = MINIMUM_SUPPORTED_SCHEMA_VERSION,
): void {
  const seen = new Map<number, string>();
  for (const migration of migrations) {
    const previous = seen.get(migration.version);
    if (previous) {
      throw new Error(
        `Duplicate migration version ${migration.version}: ${previous}, ${migration.name}`,
      );
    }
    seen.set(migration.version, migration.name);
  }
  const sorted = [...migrations].map((migration) => migration.version).sort((a, b) => a - b);
  for (let index = 0; index < sorted.length; index += 1) {
    const expected = floor + index + 1;
    if (sorted[index] !== expected) {
      throw new Error(
        `Migration versions must be contiguous above v${floor}: expected ${expected}, got ${sorted[index]}`,
      );
    }
  }
}

assertMigrationSequence();

export const CURRENT_SCHEMA_VERSION =
  MIGRATIONS.at(-1)?.version ?? MINIMUM_SUPPORTED_SCHEMA_VERSION;

/**
 * Raised when a database records a schema version this build cannot serve. Both
 * directions are refusals, not repairs: an older database needs statements this
 * build no longer carries, and a newer one was written by a build that knows
 * columns and tables this one does not.
 */
export class UnsupportedSchemaVersionError extends Error {
  constructor(readonly found: number, message: string) {
    super(message);
    this.name = "UnsupportedSchemaVersionError";
  }
}

function belowFloorMessage(found: number, dbPath: string): string {
  return [
    `Database schema v${found} is older than the minimum supported v${MINIMUM_SUPPORTED_SCHEMA_VERSION}`,
    `(this build serves v${CURRENT_SCHEMA_VERSION}).`,
    `Mandible no longer carries the migrations that upgrade a pre-v${MINIMUM_SUPPORTED_SCHEMA_VERSION} database.`,
    `Open ${dbPath} once with a Mandible build from before the v${MINIMUM_SUPPORTED_SCHEMA_VERSION} floor`,
    "to bring it to that version, or move it aside and let this build create a fresh database.",
  ].join(" ");
}

function aboveHeadMessage(found: number, dbPath: string): string {
  return [
    `Database schema v${found} is newer than the v${CURRENT_SCHEMA_VERSION} this build serves.`,
    `${dbPath} was written by a newer Mandible; running this build against it would`,
    "read and write a schema it does not know.",
    "Upgrade Mandible, or point MANDIBLE_DB at a database this build can serve.",
  ].join(" ");
}

function databasePath(db: Db): string {
  return db.name || "the database";
}

function isFreshDatabase(db: Db): boolean {
  const row = db
    .prepare("SELECT 1 FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' LIMIT 1")
    .get();
  return !row;
}

function getSchemaVersion(db: Db): number {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(SCHEMA_VERSION_KEY) as
    | { value: string }
    | undefined;
  if (!row) return 0;
  const version = Number(row.value);
  return Number.isFinite(version) ? version : 0;
}

function applySchemaMigrations(db: Db, migrations: readonly Migration[]): void {
  if (migrations.length === 0) return;
  const setVersion = db.prepare(
    "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  );
  db.transaction(() => {
    for (const migration of migrations) {
      for (const statement of migration.statements) {
        db.exec(statement);
      }
      setVersion.run(SCHEMA_VERSION_KEY, String(migration.version));
    }
  })();
}

export function migrate(db: Db): void {
  assertMigrationSequence();
  if (BASELINE_SCHEMA_VERSION !== CURRENT_SCHEMA_VERSION) {
    throw new Error(
      `Fresh schema baseline v${BASELINE_SCHEMA_VERSION} does not match migration head v${CURRENT_SCHEMA_VERSION}`,
    );
  }

  if (isFreshDatabase(db)) {
    createFreshSchemaBaseline(db, CURRENT_SCHEMA_VERSION);
    return;
  }

  const found = getSchemaVersion(db);
  if (found < MINIMUM_SUPPORTED_SCHEMA_VERSION) {
    throw new UnsupportedSchemaVersionError(found, belowFloorMessage(found, databasePath(db)));
  }
  if (found > CURRENT_SCHEMA_VERSION) {
    throw new UnsupportedSchemaVersionError(found, aboveHeadMessage(found, databasePath(db)));
  }

  applySchemaMigrations(db, MIGRATIONS.filter((migration) => migration.version > found));
}
