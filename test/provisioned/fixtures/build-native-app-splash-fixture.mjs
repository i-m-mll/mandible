import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const outdir = path.resolve('ui/dist/proofs/3434b09');
await mkdir(outdir, { recursive: true });
await build({ entryPoints: ['test/provisioned/fixtures/native-app-splash-fixture.tsx'], outfile: path.join(outdir, 'splash.js'), bundle: true,
  format: 'iife', platform: 'browser', target: 'es2020', jsx: 'automatic', jsxImportSource: 'preact',
  alias: { react: 'preact/compat', 'react-dom': 'preact/compat', 'react/jsx-runtime': 'preact/jsx-runtime' }, minify: true });
await writeFile(path.join(outdir, 'splash.html'), '<!doctype html><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="splash.css"><div id="proof-root"></div><script src="splash.js"></script>');
process.stdout.write(JSON.stringify({ path: '/dist/proofs/3434b09/splash.html', directory: outdir, controlledReadiness: true }) + '\n');
