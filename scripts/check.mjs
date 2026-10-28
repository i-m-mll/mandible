#!/usr/bin/env bun
// `bun run check`: static checks over the source tree. Each check guards a
// property that tests cannot express as behaviour, reads files only, and
// reports every offending path or token.

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

import { computeReachability } from './ui-reachability.mjs';
import { stderrInheritanceSites } from './stderr-inheritance.mjs';

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

  // The daemon rotates its stderr log by copying and truncating it. A child
  // that inherits that stderr can append between the rotation's final size
  // check and its truncate, and those bytes reach neither the rotated segment
  // nor the live log (docs/runtime-handoff.md). Children pipe stderr and the
  // daemon logs it, so the rotating thread is the file's only writer.
  'daemon children never inherit its stderr'() {
    // Standalone CLI entrypoints forward their caller's streams.
    return walk('src', (file) => /\.tsx?$/.test(file) && !file.startsWith('src/cli/')).flatMap((file) => stderrInheritanceSites(file, read(file))
      .map(({ line, reason }) => `${file}:${line}: ${reason}; a daemon child must pipe its output and the daemon log it`));
  },

  // Chrome under a test HOME without --use-mock-keychain raises a modal
  // "Keychain not found" dialog on the operator's screen per launch, so every
  // launch in tests and scripts goes through the one launcher that passes it.
  'Chrome starts only through test/helpers/chromium.ts'() {
    const launcher = 'test/helpers/chromium.ts';
    const signs = /--headless|Google Chrome\.app|Chromium\.app|\/usr\/bin\/(?:google-chrome|chromium)|\bCHROME_BIN\b/;
    return ['test', 'scripts']
      .flatMap((root) => walk(root, (file) => /\.(?:[cm]?[jt]sx?|sh)$/.test(file)))
      .filter((file) => file !== launcher && file !== 'scripts/check.mjs')
      .flatMap((file) => read(file).split('\n').flatMap((line, index) =>
        signs.test(line) ? [`${file}:${index + 1}: launches Chrome directly; use ${launcher}`] : []));
  },

  // A local deadline encodes how fast a machine ought to be, so a loaded
  // machine turns it red (test/README.md). Gate tests await state through
  // test/helpers/wait-until.ts and Testing Library through test/helpers/dom.ts,
  // both bounded just under the vitest.config.ts hang guard.
  'gate tests wait for state, not a duration'() {
    const SUITE_CALLS = new Set(['it', 'test', 'describe', 'suite']);
    const HOOK_CALLS = new Set(['beforeAll', 'beforeEach', 'afterAll', 'afterEach']);
    const DOM_WAITS = /^(?:waitFor|waitForElementToBeRemoved|find(?:All)?By[A-Z]\w*)$/;
    const rootName = (expression) => {
      while (ts.isPropertyAccessExpression(expression) || ts.isCallExpression(expression)) expression = expression.expression;
      return ts.isIdentifier(expression) ? expression.text : null;
    };
    const calleeName = (expression) =>
      ts.isIdentifier(expression) ? expression.text : ts.isPropertyAccessExpression(expression) ? expression.name.text : null;
    const hasTimeout = (node) => ts.isObjectLiteralExpression(node)
      && node.properties.some((property) => property.name && ts.isIdentifier(property.name) && property.name.text === 'timeout');
    return readdirSync(path.join(REPO_ROOT, 'test'))
      .filter((name) => /\.test\.tsx?$/.test(name))
      .flatMap((name) => {
        const file = path.join('test', name);
        const source = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true);
        const problems = [];
        const report = (node, message) =>
          problems.push(`${file}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}: ${message}`);
        const visit = (node) => {
          if (ts.isImportDeclaration(node) && /^@testing-library\/(?:preact|dom)$/.test(node.moduleSpecifier.text)) {
            report(node, 'imports Testing Library directly; import it from ./helpers/dom.js');
          }
          if (ts.isCallExpression(node)) {
            const root = rootName(node.expression);
            const args = node.arguments;
            if (SUITE_CALLS.has(root) && (args.length >= 3 || (args.length >= 2 && hasTimeout(args[1])))) {
              report(node, `${root}() sets its own timeout; the config hang guard owns that`);
            } else if (HOOK_CALLS.has(root) && args.length >= 2) {
              report(node, `${root}() sets its own timeout; the config hang guard owns that`);
            }
            if (ts.isPropertyAccessExpression(node.expression) && root === 'vi' && /^wait(?:For|Until)$/.test(node.expression.name.text)) {
              report(node, `vi.${node.expression.name.text} gives up after 1 s; use waitUntil or waitUntilPasses from ./helpers/wait-until.js`);
            }
            if (DOM_WAITS.test(calleeName(node.expression) ?? '') && args.some(hasTimeout)) {
              report(node, 'passes its own timeout to a Testing Library wait');
            }
          }
          ts.forEachChild(node, visit);
        };
        visit(source);
        return problems;
      });
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
