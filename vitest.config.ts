import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.{ts,tsx}'],
    environment: 'jsdom',
    // Issue c4f456c: unconditional per-test reset of the src/db.ts singleton.
    setupFiles: ["./test/helpers/db-reset-backstop.ts"],
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
