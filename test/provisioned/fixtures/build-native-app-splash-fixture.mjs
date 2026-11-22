import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { injectStartupFrame } from '../../../src/startup-frame.ts';

const outdir = path.resolve('ui/dist/proofs/3434b09');
await mkdir(outdir, { recursive: true });
await build({ entryPoints: ['test/provisioned/fixtures/native-app-splash-fixture.tsx'], outfile: path.join(outdir, 'splash.js'), bundle: true,
  format: 'iife', platform: 'browser', target: 'es2020', jsx: 'automatic', jsxImportSource: 'preact',
  alias: { react: 'preact/compat', 'react-dom': 'preact/compat', 'react/jsx-runtime': 'preact/jsx-runtime' }, minify: true });
await writeFile(path.join(outdir, 'splash.html'), injectStartupFrame(`<!doctype html><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<!-- mandible-startup-frame-style --><link rel="stylesheet" href="splash.css"></head>
<body><!-- mandible-startup-frame --><div id="proof-root"></div><script src="splash.js"></script></body>`));
process.stdout.write(JSON.stringify({ path: '/dist/proofs/3434b09/splash.html', directory: outdir, controlledReadiness: true }) + '\n');
