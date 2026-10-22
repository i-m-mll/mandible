#!/usr/bin/env bun
// Import-graph reachability guard for the UI bundle.
//
// The UI ships from a single esbuild entry (`ui/src/app.tsx`). Modules that no
// longer sit on that import graph are dead weight: their JS is tree-shaken away
// but any CSS they `@import` (and any CSS file that is only referenced from
// them) still ships in the eager `app.css`. This walker follows static imports,
// re-exports and dynamic `import()` calls from the entry and reports every
// module under `ui/src/` that it never reaches.
//
// Used by `bun run check` (scripts/check.mjs); also runnable directly:
//   node scripts/ui-reachability.mjs [--json]

import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const CODE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs'];
const ASSET_EXTENSIONS = ['.css', '.svg', '.png', '.json'];
const RESOLVE_EXTENSIONS = [...CODE_EXTENSIONS, ...ASSET_EXTENSIONS];

// Files under ui/src/ that are knowingly off the entry graph. Every entry is a
// claim that the file earns its place some other way — add one only with a
// reason, and delete the file instead whenever the reason expires.
//
// Issue 048c7e2 deleted 24 unreachable modules and the CSS they dragged into
// the eager app.css. These are what deliberately stayed.
const ALLOWED_UNREACHABLE = new Set([
  // Not a module: prose documenting the per-component CSS ownership rule.
  'ui/src/views/spaces/README.md',
  // Shelved Spaces work-in-progress with no mount site yet, kept pending an
  // explicit product decision (issue 048c7e2). They still have live tests
  // (test/space-export-dialog.test.tsx, test/repo-file-register-dialog.test.tsx)
  // and their CSS is still imported by app.tsx.
  'ui/src/views/spaces/SpaceExportDialog.tsx',
  'ui/src/views/spaces/exportDialogState.ts',
  'ui/src/views/spaces/RepoFileRegisterDialog.tsx',
  // Documented exemplar of the per-component CSS ownership rule; referenced by
  // views/spaces/README.md and SpacesViewShell.css rather than imported.
  'ui/src/views/spaces/space-view.css',
]);

function isCode(absolutePath) {
  return CODE_EXTENSIONS.includes(path.extname(absolutePath));
}

function tryFile(candidate) {
  try {
    return statSync(candidate).isFile() ? candidate : null;
  } catch {
    return null;
  }
}

function resolveImport(fromFile, specifier) {
  // Bare specifiers are node_modules packages; not our concern.
  if (!specifier.startsWith('.') && !specifier.startsWith('/')) return null;
  const base = path.resolve(path.dirname(fromFile), specifier);

  const direct = tryFile(base);
  if (direct) return direct;

  for (const extension of RESOLVE_EXTENSIONS) {
    const withExtension = tryFile(base + extension);
    if (withExtension) return withExtension;
  }
  // `./foo.js` in TS source means `./foo.ts`/`./foo.tsx`.
  const parsed = path.parse(base);
  if (CODE_EXTENSIONS.includes(parsed.ext)) {
    const stripped = path.join(parsed.dir, parsed.name);
    for (const extension of CODE_EXTENSIONS) {
      const withExtension = tryFile(stripped + extension);
      if (withExtension) return withExtension;
    }
  }
  for (const extension of RESOLVE_EXTENSIONS) {
    const asIndex = tryFile(path.join(base, `index${extension}`));
    if (asIndex) return asIndex;
  }
  return null;
}

const CSS_IMPORT_PATTERN = /@import\s+["']([^"']+)["']/g;

function extractSpecifiers(source, fileName) {
  const found = new Set();
  if (path.extname(fileName) === '.css') {
    CSS_IMPORT_PATTERN.lastIndex = 0;
    let match;
    while ((match = CSS_IMPORT_PATTERN.exec(source)) !== null) found.add(match[1]);
  } else {
    const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
    const visit = (node) => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node))
          && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
        found.add(node.moduleSpecifier.text);
      }
      if (ts.isCallExpression(node)
          && (node.expression.kind === ts.SyntaxKind.ImportKeyword
            || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))
          && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])) {
        found.add(node.arguments[0].text);
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  return [...found];
}

export function computeReachability({ repoRoot = REPO_ROOT } = {}) {
  const uiSrc = path.join(repoRoot, 'ui', 'src');
  const entry = path.join(uiSrc, 'app.tsx');
  const toPosix = (absolutePath) => path.relative(repoRoot, absolutePath).split(path.sep).join('/');
  const reached = new Set();
  const queue = [entry];

  while (queue.length > 0) {
    const current = queue.pop();
    if (reached.has(current)) continue;
    reached.add(current);

    const extension = path.extname(current);
    const isCssFile = extension === '.css';
    if (!isCode(current) && !isCssFile) continue;

    let source;
    try {
      source = readFileSync(current, 'utf8');
    } catch {
      continue;
    }
    for (const specifier of extractSpecifiers(source, current)) {
      const resolved = resolveImport(current, specifier);
      if (resolved && !reached.has(resolved)) queue.push(resolved);
    }
  }

  const allFiles = [];
  (function walk(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(absolute);
      // Ambient declaration files are not modules: they emit no runtime bytes
      // and no stylesheet, so they cannot be the dead weight this walker looks
      // for. Their consumer is `ui/tsconfig.json`'s project include, which
      // `bun run typecheck` enforces.
      else if (!entry.name.endsWith('.d.ts')) allFiles.push(absolute);
    }
  })(uiSrc);

  const unreachable = allFiles
    .filter((file) => !reached.has(file))
    .map(toPosix)
    .filter((file) => !ALLOWED_UNREACHABLE.has(file))
    .sort();

  return {
    entry: toPosix(entry),
    reachedCount: [...reached].filter((file) => file.startsWith(uiSrc)).length,
    totalCount: allFiles.length,
    unreachable,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = computeReachability();
  if (process.argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(
      `entry=${report.entry} reached=${report.reachedCount}/${report.totalCount}\n`,
    );
    if (report.unreachable.length === 0) process.stdout.write('no unreachable modules\n');
    else {
      process.stdout.write(`${report.unreachable.length} unreachable:\n`);
      for (const file of report.unreachable) process.stdout.write(`  ${file}\n`);
    }
  }
  process.exit(report.unreachable.length === 0 ? 0 : 1);
}
