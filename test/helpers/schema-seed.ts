import SqliteDatabase from '../../src/sqlite.js';
import { CURRENT_SCHEMA_VERSION, migrate } from '../../src/db.js';
import { prepareRunFixture, readRunFixture } from './run-fixture-seed.js';

const SCHEMA_SEED = { file: 'schema-seed.sqlite', manifest: 'schema-seed.json', label: 'schema seed', identity: { schema: CURRENT_SCHEMA_VERSION } };

/** Prepare only inside the runner's fresh private root, never across runs. */
export function prepareSchemaSeed(root: string): void {
  const db = new SqliteDatabase();
  try {
    migrate(db);
    const bytes = db.serialize();
    prepareRunFixture(root, SCHEMA_SEED, bytes);
  } finally {
    db.close();
  }
}

/** A missing, corrupt, or foreign seed is a broken run, never a cache miss. */
export function readSchemaSeed(root = process.env.MANDIBLE_TEST_RUNTIME_ROOT): Buffer {
  return readRunFixture(root, SCHEMA_SEED);
}
