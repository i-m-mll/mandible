import fs from 'node:fs';
import path from 'node:path';
import { configureSqliteRuntime, sqliteRuntimePaths, verifySqliteArchive } from '../../src/sqlite-runtime.js';

// Provision the qualified library before returning paths. Catalog fixtures are
// metadata-only and deliberately do not prepare database dependencies.
export function qualifiedRuntimeFixtureEnv() {
  configureSqliteRuntime();
  const paths = sqliteRuntimePaths();
  return { MANDIBLE_SQLITE_LIBRARY: paths.library, MANDIBLE_SQLITE_LIBRARY_ARCHIVE: paths.archive };
}

// Deployment fixtures exercise the real selector with the qualified source
// and preserved stock library, without network acquisition per test.
export function copyRuntimeFixture(root: string) {
  for (const name of ['.bun-version', 'scripts/bun-runtime.sh', 'scripts/runtime-environment.mjs', 'scripts/runtime-environment-path.mjs', 'scripts/bun-runtime-lock.tsv', 'scripts/sqlite-runtime-install.mjs', 'scripts/installed-release.mjs', 'src/sqlite-runtime.ts']) {
    const target = path.join(root, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(process.cwd(), name), target);
  }
  if (process.platform !== 'darwin') return {};
  // The test runtime provisions before per-file HOME isolation. Preserve its
  // verified archive input instead of deriving a nonexistent later-home path.
  const archive = process.env.MANDIBLE_SQLITE_LIBRARY_ARCHIVE || sqliteRuntimePaths().archive;
  return { MANDIBLE_SQLITE_LIBRARY_ARCHIVE: verifySqliteArchive(archive) };
}
