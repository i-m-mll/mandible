import fs from 'node:fs/promises';
import path from 'node:path';
import { build, context } from 'esbuild';

const isWatch = process.argv.includes('--watch');
const outdir = outdirArgument(process.argv) ?? 'ui/dist';

function outdirArgument(argv) {
  const flag = argv.indexOf('--outdir');
  if (flag < 0) return null;
  const value = argv[flag + 1];
  if (!value || value.startsWith('--')) throw new Error('--outdir requires a directory');
  return value;
}
const routeEntryPoints = {
  auth: 'ui/src/views/auth.tsx',
  artifacts: 'ui/src/views/artifacts.tsx',
  inbox: 'ui/src/views/inbox.tsx',
  issues: 'ui/src/views/issues.tsx',
  console: 'ui/src/views/conversations.tsx',
  settings: 'ui/src/views/settings.tsx',
  work: 'ui/src/views/work.tsx',
  logs: 'ui/src/views/logs.tsx',
  graph: 'ui/src/views/graph.tsx',
  timeline: 'ui/src/views/timeline.tsx',
  spaces: 'ui/src/views/spaces/SpacesTab.tsx',
  briefing: 'ui/src/views/briefing.tsx',
};

function normalizePath(filePath) {
  return filePath.split(path.sep).join('/');
}

function outputUrl(outputPath) {
  const relative = normalizePath(path.relative(outdir, outputPath));
  return `/dist/${relative}`;
}

function collectStaticImports(outputs, outputPath, collected = new Set()) {
  const output = outputs[outputPath];
  if (!output) return collected;
  for (const dependency of output.imports) {
    if (dependency.external || dependency.kind !== 'import-statement') continue;
    const declaredPath = normalizePath(dependency.path);
    const dependencyPath = outputs[declaredPath]
      ? declaredPath
      : normalizePath(path.join(path.dirname(outputPath), dependency.path));
    if (collected.has(dependencyPath)) continue;
    collected.add(dependencyPath);
    collectStaticImports(outputs, dependencyPath, collected);
  }
  return collected;
}

const assetManifestPlugin = {
  name: 'mandible-asset-manifest',
  setup(buildApi) {
    buildApi.onEnd(async (result) => {
      if (result.errors.length > 0 || !result.metafile) return;
      const outputs = result.metafile.outputs;
      const entries = Object.entries(outputs);
      const appEntry = entries.find(([, output]) => output.entryPoint === 'ui/src/app.tsx')?.[0];
      if (!appEntry) throw new Error('UI build did not emit the app entry point');

      const routes = {};
      for (const [route, source] of Object.entries(routeEntryPoints)) {
        const routeOutput = entries.find(([, output]) => output.entryPoint === source)?.[0];
        if (!routeOutput) throw new Error(`UI build did not emit the ${route} route chunk`);
        routes[route] = outputUrl(routeOutput);
      }

      const entryPreloads = [...collectStaticImports(outputs, appEntry)]
        .filter((outputPath) => outputPath.endsWith('.js'))
        .map(outputUrl)
        .sort();
      const manifest = {
        version: 1,
        entry: outputUrl(appEntry),
        entryPreloads,
        routes,
      };
      const manifestPath = path.join(outdir, 'asset-manifest.json');
      const temporaryPath = `${manifestPath}.tmp`;
      await fs.writeFile(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
      await fs.rename(temporaryPath, manifestPath);
    });
  },
};

const buildOptions = {
  entryPoints: ['ui/src/app.tsx'],
  bundle: true,
  outdir,
  entryNames: 'app',
  chunkNames: 'chunks/[name]-[hash]',
  assetNames: 'app',
  format: 'esm',
  splitting: true,
  sourcemap: isWatch,
  target: 'es2020',
  jsx: 'automatic',
  jsxImportSource: 'preact',
  alias: {
    react: 'preact/compat',
    'react-dom': 'preact/compat',
    'react/jsx-runtime': 'preact/jsx-runtime',
  },
  loader: {
    '.css': 'css',
  },
  minify: !isWatch,
  logLevel: 'info',
  metafile: true,
  plugins: [assetManifestPlugin],
};

if (isWatch) {
  const ctx = await context(buildOptions);
  await ctx.watch();
} else {
  await fs.rm(buildOptions.outdir, { recursive: true, force: true });
  await build(buildOptions);
}
