import { build, context } from 'esbuild';

const isWatch = process.argv.includes('--watch');

const buildOptions = {
  entryPoints: ['ui/src/app.tsx'],
  bundle: true,
  outdir: 'ui/dist',
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
  external: ['@tauri-apps/api/core', '@tauri-apps/api/webview'],
  loader: {
    '.css': 'css',
  },
  minify: !isWatch,
  logLevel: 'info',
};

if (isWatch) {
  const ctx = await context(buildOptions);
  await ctx.watch();
} else {
  await build(buildOptions);
}
