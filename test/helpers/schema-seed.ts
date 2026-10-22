import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import SqliteDatabase from '../../src/sqlite.js';
import { CURRENT_SCHEMA_VERSION, migrate } from '../../src/db.js';

const SEED_FILE = 'schema-seed.sqlite';
const MANIFEST_FILE = 'schema-seed.json';

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Prepare only inside the runner's fresh private root, never across runs. */
export function prepareSchemaSeed(root: string): void {
  const db = new SqliteDatabase();
  try {
    migrate(db);
    const bytes = db.serialize();
    fs.writeFileSync(path.join(root, SEED_FILE), bytes, { flag: 'wx', mode: 0o400 });
    fs.writeFileSync(path.join(root, MANIFEST_FILE), JSON.stringify({
      root: fs.realpathSync(root),
      schema: CURRENT_SCHEMA_VERSION,
      sha256: digest(bytes),
    }), { flag: 'wx', mode: 0o400 });
  } finally {
    db.close();
  }
}

/** A missing, corrupt, or foreign seed is a broken run, never a cache miss. */
export function readSchemaSeed(root = process.env.MANDIBLE_TEST_RUNTIME_ROOT): Buffer {
  if (!root) throw new Error('Missing test run root; start Vitest through scripts/run-vitest.js.');
  const manifestPath = path.join(root, MANIFEST_FILE);
  const seedPath = path.join(root, SEED_FILE);
  if (!fs.existsSync(manifestPath) || !fs.existsSync(seedPath)) {
    throw new Error('Missing run-scoped schema seed; start Vitest through scripts/run-vitest.js.');
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const bytes = fs.readFileSync(seedPath);
  if (manifest.root !== fs.realpathSync(root) || manifest.schema !== CURRENT_SCHEMA_VERSION || manifest.sha256 !== digest(bytes)) {
    throw new Error('Run-scoped schema seed does not match this run, schema, or snapshot bytes.');
  }
  return bytes;
}
