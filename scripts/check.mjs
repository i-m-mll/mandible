#!/usr/bin/env bun
// `bun run check`: static checks over the source tree. Each check guards a
// property that tests cannot express as behaviour, reads files only, and
// reports every offending path or token.

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { computeReachability } from './ui-reachability.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const read = (relative) => readFileSync(path.join(REPO_ROOT, relative), 'utf8');

function walk(relativeDir, keep, found = []) {
  const skip = new Set(['node_modules', 'dist', '.git', 'coverage', '__snapshots__']);
  for (const entry of readdirSync(path.join(REPO_ROOT, relativeDir), { withFileTypes: true })) {
    const relative = path.join(relativeDir, entry.name);
    if (entry.isDirectory()) {
      if (!skip.has(entry.name)) walk(relative, keep, found);
    } else if (entry.isFile() && keep(relative)) {
      found.push(relative);
    }
  }
  return found;
}

const TEXT_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.json', '.sh', '.css', '.html', '.md', '.mdx', '.yml', '.yaml', '.sql', '.txt',
]);

const checks = {
  // grep treats a file with a NUL byte as binary and reports no match, so one
  // pasted separator silently blinds every grep-based audit (issue ee0055a).
  'source files contain no NUL bytes'() {
    const files = ['src', 'ui/src', 'cli', 'channel-server', 'scripts', 'test', 'docs'].flatMap((root) =>
      walk(root, (file) => TEXT_EXTENSIONS.has(path.extname(file))),
    );
    if (files.length < 200) return [`walked only ${files.length} files; the walk is broken`];
    return files
      .filter((file) => readFileSync(path.join(REPO_ROOT, file)).includes(0))
      .map((file) => `${file}: contains a NUL byte; write it as an escape sequence`);
  },

  // A module off the app.tsx import graph is tree-shaken, but its CSS still
  // ships in the eager app.css (issue 048c7e2).
  'every ui/src module is reachable from the app entry'() {
    const report = computeReachability();
    if (report.reachedCount < report.totalCount * 0.9) {
      return [`reached ${report.reachedCount} of ${report.totalCount} modules; the walker is broken`];
    }
    return report.unreachable.map(
      (file) => `${file}: unreachable from ${report.entry}; delete it or add it to ALLOWED_UNREACHABLE with a reason`,
    );
  },

  // The native build writes its bootstrap into src-tauri/dist; pointing Tauri
  // at the daemon's dist/ overwrote dist/index.js (bug 88a4472).
  'the desktop bootstrap stays out of the daemon dist tree'() {
    const config = JSON.parse(read('src-tauri/tauri.conf.json'));
    const problems = [];
    const frontend = path.resolve(REPO_ROOT, 'src-tauri', config.build.frontendDist);
    if (frontend !== path.join(REPO_ROOT, 'src-tauri', 'dist')) {
      problems.push(`src-tauri/tauri.conf.json: build.frontendDist resolves to ${path.relative(REPO_ROOT, frontend)}, not src-tauri/dist`);
    }
    for (const [index, window] of config.app.windows.entries()) {
      if ('url' in window) problems.push(`src-tauri/tauri.conf.json: app.windows[${index}].url bypasses the bootstrap`);
    }
    return problems;
  },

  // Schema changes go through src/db-migrations.ts; a service-local
  // `IF NOT EXISTS` never alters an existing database.
  'service modules carry no fallback schema DDL'() {
    const ddl = /CREATE\s+(?:UNIQUE\s+)?(?:TABLE|INDEX)\s+IF\s+NOT\s+EXISTS/i;
    return ['src/auth-hooks.ts', 'src/auth-auto-approve.ts', 'src/work-scanner.ts', 'src/auth-queue.ts']
      .filter((file) => ddl.test(read(file)))
      .map((file) => `${file}: CREATE ... IF NOT EXISTS; add a migration in src/db-migrations.ts instead`);
  },

  // A per-file chokidar watcher opened one fd per conversation file and
  // exhausted the daemon's fd limit (bug 4f7e45e). It is constructed in one
  // place, behind the platform guard tested in ingestion-watch-roots.
  'chokidar is constructed in exactly one place'() {
    const sites = walk('src', (file) => /\.tsx?$/.test(file)).flatMap((file) =>
      (read(file).match(/chokidar\.watch\(/g) ?? []).map(() => file),
    );
    return sites.length === 1 ? [] : [`chokidar.watch( appears ${sites.length} times (${sites.join(', ') || 'nowhere'}); expected once, in src/ingestion.ts`];
  },

  // Reminder predicates are evaluated against a database capability only, so
  // evaluation is deterministic and cannot reach the host.
  'the reminder evaluator imports no host capabilities'() {
    const file = 'src/managed-reminder-evaluator.ts';
    const source = read(file);
    const banned = source.match(/node:(?:child_process|cluster|dgram|dns|fs|http|https|net|tls|worker_threads)|\b(?:fetch|process|Bun|Deno)\b/g) ?? [];
    return [...new Set(banned)].map((token) => `${file}: uses ${token}`);
  },
};

let failed = 0;
for (const [name, check] of Object.entries(checks)) {
  const problems = check();
  if (problems.length === 0) {
    console.log(`ok   ${name}`);
    continue;
  }
  failed += 1;
  console.log(`FAIL ${name}`);
  for (const problem of problems) console.log(`     ${problem}`);
}
process.exitCode = failed === 0 ? 0 : 1;
