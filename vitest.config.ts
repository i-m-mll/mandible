import { defineConfig } from 'vitest/config';

/**
 * One canonical Vitest configuration for every Mandible suite; the include
 * globs are the only thing a suite chooses.
 */
export function mandibleVitestConfig(include: string[]) {
  return defineConfig({
    test: {
      include,
      environment: 'jsdom',
      // Issue c4f456c: unconditional per-test reset of the src/db.ts singleton.
      setupFiles: ['./test/helpers/db-reset-backstop.ts'],
      fileParallelism: false,
      coverage: {
        provider: 'v8',
        thresholds: {
          lines: 45,
        },
      },
    },
    esbuild: {
      jsx: 'automatic',
      jsxImportSource: 'preact',
    },
    resolve: {
      alias: {
        react: 'preact/compat',
        'react-dom': 'preact/compat',
        'react/jsx-runtime': 'preact/jsx-runtime',
      },
    },
  });
}

// Single star on purpose: the default suite is exactly the flat `test/`
// directory. A `**` would keep subdirectories in the run, so moving a test out
// of `npm test` would not actually move it. With a single star, any suite that
// needs provisioning this runner cannot assume — a real browser, ImageMagick —
// is excluded simply by living in `test/<suite>/`. See test/browser/README.md.
export default mandibleVitestConfig(['test/*.test.{ts,tsx}']);
