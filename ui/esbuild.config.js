import { build, context } from 'esbuild';

const isWatch = process.argv.includes('--watch');

const buildOptions = {
  entryPoints: ['ui/src/app.tsx'],
  bundle: true,
  outdir: 'ui/dist',
  entryNames: 'app',
  assetNames: 'app',
  format: 'esm',
  sourcemap: true,
  target: 'es2020',
  jsx: 'automatic',
  jsxImportSource: 'preact',
  external: ['@tauri-apps/api/core', '@tauri-apps/api/webview'],
  loader: {
    '.css': 'css',
  },
  logLevel: 'info',
};

if (isWatch) {
  const ctx = await context(buildOptions);
  await ctx.watch();
} else {
  await build(buildOptions);
}
