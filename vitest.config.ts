import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    setupFiles: [],
  },
  esbuild: {
    jsx: 'automatic',
    jsxImportSource: 'preact',
  },
});
